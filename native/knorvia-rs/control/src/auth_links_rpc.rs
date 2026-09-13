//! Account-connection RPC (route C, GOAL-C C04/C11/C12).
//!
//! Bridges public login flows (ChatGPT/Codex first) and installed-CLI
//! auth status into the durable auth-link registry. Ground rules:
//! - the authorize URL is assembled only from public Codex client
//!   parameters (same values as the audited legacy constants module) —
//!   the user completes the real login in their browser;
//! - detection shells out ONLY to CLIs already on the machine, with
//!   argument arrays, a short deadline and no shell;
//! - a CLI that is missing or cannot answer is recorded as such — never
//!   faked into `connected`; quota stays `subscription` vs `api` vs
//!   `unknown` explicitly;
//! - disconnecting clears local state only and can never log the user
//!   out of their independent CLI accounts.
//! Wiring (mod + route arms) is A's; see mailbox to-A/C-001/C-002.

use super::*;
use knorvia_store::auth_links::{
    AuthConnectOp, AuthDetectorFacts, AuthLinkErrorKind, AuthLinkStore, redact,
};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

/// Public Codex CLI OAuth client parameters (audited legacy constants;
/// public values, not secrets).
const CODEX_ISSUER: &str = "https://auth.openai.com";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_SCOPE: &str = "openid profile email offline_access";
const CODEX_REDIRECT_PORT: u16 = 1455;
const CODEX_REDIRECT_PATH: &str = "/auth/callback";
const LOGIN_TTL_MS: u64 = 300_000;

fn invalid(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(ErrorCategory::InvalidArgument, message.into())
}

fn auth_error(error: knorvia_store::auth_links::AuthLinkError) -> ProtocolError {
    let category = match error.kind {
        AuthLinkErrorKind::InvalidArgument => ErrorCategory::InvalidArgument,
        AuthLinkErrorKind::NotFound => ErrorCategory::NotFound,
        AuthLinkErrorKind::Conflict => ErrorCategory::Conflict,
        AuthLinkErrorKind::Corrupt | AuthLinkErrorKind::Io => ErrorCategory::Internal,
    };
    ProtocolError::new(category, error.to_string())
}

fn b64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        }
    }
    out
}

/// PKCE pair for the public-client flow (RFC 7636). The verifier is 32
/// bytes from the OS CSPRNG (`getrandom` — the same source as the daemon
/// endpoint token), base64url to 43 unreserved characters; the challenge
/// is S256(verifier). Time, pid and hasher states are never mixed in:
/// nothing observable about this process reconstructs a verifier.
fn make_pkce() -> Result<(String, String), String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    let verifier = b64url(&bytes);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    Ok((verifier, challenge))
}

/// A fresh 128-bit OAuth `state`, independent of the verifier: one leaked
/// value never derives the other.
fn make_oauth_state() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(b64url(&bytes))
}

fn codex_authorize_url(state: &str, code_challenge: &str) -> String {
    format!(
        "{CODEX_ISSUER}/oauth/authorize?response_type=code&client_id={CODEX_CLIENT_ID}\
&redirect_uri=http%3A%2F%2Flocalhost%3A{CODEX_REDIRECT_PORT}{CODEX_REDIRECT_PATH}\
&scope={CODEX_SCOPE}&state={state}&code_challenge={code_challenge}&code_challenge_method=S256"
    )
}

/// On Windows, npm-installed CLIs are `.cmd` shims: spawning the bare name
/// fails with ENOENT even when the CLI is on PATH. Probe the shim/executable
/// candidates explicitly; argument arrays and no shell are preserved.
fn spawn_candidates(program: &str) -> Vec<String> {
    let mut candidates = vec![program.to_string()];
    if cfg!(windows) {
        for ext in [".cmd", ".exe", ".bat"] {
            candidates.push(format!("{program}{ext}"));
        }
    }
    candidates
}

const PROBE_OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Debug)]
struct ProbeOutput {
    success: bool,
    stdout: String,
    stderr: String,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

#[derive(Debug)]
enum ProbeResult {
    Completed(ProbeOutput),
    TimedOut(ProbeOutput),
    Cancelled,
    Missing(String),
}

fn bounded_reader(
    mut pipe: impl std::io::Read + Send + 'static,
) -> std::sync::mpsc::Receiver<(Vec<u8>, bool)> {
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut truncated = false;
        let mut chunk = [0_u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let room = PROBE_OUTPUT_LIMIT.saturating_sub(kept.len());
                    kept.extend_from_slice(&chunk[..read.min(room)]);
                    truncated |= read > room;
                }
            }
        }
        let _ = send.send((kept, truncated));
    });
    receive
}

#[cfg(windows)]
struct ProbeProcessGroup {
    job: isize,
}

#[cfg(windows)]
impl ProbeProcessGroup {
    fn spawn(
        command: &mut std::process::Command,
    ) -> std::io::Result<(Self, std::process::Child)> {
        use std::os::windows::io::AsRawHandle;
        use std::os::windows::process::CommandExt;
        use std::ffi::c_void;

        #[repr(C)]
        struct ThreadEntry32 {
            size: u32,
            usage: u32,
            thread_id: u32,
            owner_process_id: u32,
            base_priority: i32,
            delta_priority: i32,
            flags: u32,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
            fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
            fn CloseHandle(handle: *mut c_void) -> i32;
            fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut c_void;
            fn Thread32First(snapshot: *mut c_void, entry: *mut ThreadEntry32) -> i32;
            fn Thread32Next(snapshot: *mut c_void, entry: *mut ThreadEntry32) -> i32;
            fn OpenThread(access: u32, inherit: i32, thread_id: u32) -> *mut c_void;
            fn ResumeThread(thread: *mut c_void) -> u32;
        }

        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const TH32CS_SNAPTHREAD: u32 = 0x0000_0004;
        const THREAD_SUSPEND_RESUME: u32 = 0x0002;
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(std::io::Error::other(format!(
                "could not create probe job: {}",
                std::io::Error::last_os_error()
            )));
        }
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                unsafe { CloseHandle(job) };
                return Err(error);
            }
        };
        let group = Self { job: job as isize };
        if unsafe { AssignProcessToJobObject(job, child.as_raw_handle()) } == 0 {
            let error = std::io::Error::last_os_error();
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::other(format!(
                "could not register probe process tree: {error}"
            )));
        }

        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot as isize == -1 {
            let error = std::io::Error::last_os_error();
            group.terminate();
            let _ = child.wait();
            return Err(std::io::Error::other(format!(
                "could not enumerate probe thread: {error}"
            )));
        }
        let mut entry = ThreadEntry32 {
            size: std::mem::size_of::<ThreadEntry32>() as u32,
            usage: 0,
            thread_id: 0,
            owner_process_id: 0,
            base_priority: 0,
            delta_priority: 0,
            flags: 0,
        };
        let mut found = unsafe { Thread32First(snapshot, &mut entry) };
        let mut resumed = false;
        while found != 0 {
            if entry.owner_process_id == child.id() {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.thread_id) };
                if !thread.is_null() {
                    resumed |= unsafe { ResumeThread(thread) } != u32::MAX;
                    unsafe { CloseHandle(thread) };
                }
            }
            found = unsafe { Thread32Next(snapshot, &mut entry) };
        }
        unsafe { CloseHandle(snapshot) };
        if !resumed {
            group.terminate();
            let _ = child.wait();
            return Err(std::io::Error::other(
                "could not resume registered probe process",
            ));
        }
        Ok((group, child))
    }

    fn terminate(&self) {
        use std::ffi::c_void;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn TerminateJobObject(job: *mut c_void, code: u32) -> i32;
        }
        if self.job != 0 {
            unsafe { TerminateJobObject(self.job as *mut c_void, 1) };
        }
    }
}

#[cfg(windows)]
impl Drop for ProbeProcessGroup {
    fn drop(&mut self) {
        use std::ffi::c_void;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn TerminateJobObject(job: *mut c_void, code: u32) -> i32;
            fn CloseHandle(handle: *mut c_void) -> i32;
        }
        if self.job != 0 {
            unsafe {
                TerminateJobObject(self.job as *mut c_void, 1);
                CloseHandle(self.job as *mut c_void);
            }
            self.job = 0;
        }
    }
}

#[cfg(not(windows))]
struct ProbeProcessGroup {
    process_group: u32,
}

#[cfg(not(windows))]
impl ProbeProcessGroup {
    fn spawn(
        command: &mut std::process::Command,
    ) -> std::io::Result<(Self, std::process::Child)> {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        let child = command.spawn()?;
        Ok((Self { process_group: child.id() }, child))
    }

    fn terminate(&self) {
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &format!("-{}", self.process_group)])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

#[cfg(not(windows))]
impl Drop for ProbeProcessGroup {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn empty_probe_output(success: bool) -> ProbeOutput {
    ProbeOutput {
        success,
        stdout: String::new(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }
}

/// One CLI detection probe: argument arrays, no shell, concurrent bounded
/// drains, one monotonic end-to-end deadline, and an owned process tree.
fn run_cli(
    args: &[&str],
    deadline_ms: u64,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<ProbeResult, String> {
    run_cli_with_env(args, deadline_ms, cancelled, &[])
}

fn run_cli_with_env(
    args: &[&str],
    deadline_ms: u64,
    cancelled: &std::sync::atomic::AtomicBool,
    environment: &[(&str, &str)],
) -> Result<ProbeResult, String> {
    use std::process::{Command, Stdio};
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    let (program, rest) = args.split_first().ok_or("no command")?;
    let deadline = Instant::now() + Duration::from_millis(deadline_ms);
    let mut launched = None;
    let mut attempted = String::new();
    for candidate in spawn_candidates(program) {
        if cancelled.load(Ordering::Acquire) {
            return Ok(ProbeResult::Cancelled);
        }
        if Instant::now() >= deadline {
            return Ok(ProbeResult::TimedOut(empty_probe_output(false)));
        }
        let mut command = Command::new(&candidate);
        command
            .args(rest)
            .envs(environment.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        match ProbeProcessGroup::spawn(&mut command) {
            Ok(spawned) => {
                launched = Some(spawned);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                attempted.push_str(&candidate);
                attempted.push(' ');
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let Some((group, mut child)) = launched else {
        return Ok(ProbeResult::Missing(attempted.trim().to_string()));
    };
    let stdout = child.stdout.take().ok_or("probe stdout pipe missing")?;
    let stderr = child.stderr.take().ok_or("probe stderr pipe missing")?;
    let stdout_rx = bounded_reader(stdout);
    let stderr_rx = bounded_reader(stderr);
    let mut status = None;
    let mut timed_out = false;
    let mut was_cancelled = false;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(exit_status) => {
                status = Some(exit_status);
                break;
            }
            None => {
                if cancelled.load(Ordering::Acquire) {
                    was_cancelled = true;
                    break;
                }
                if Instant::now() >= deadline {
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
    let mut stdout_result = None;
    let mut stderr_result = None;
    while status.is_some()
        && (stdout_result.is_none() || stderr_result.is_none())
        && Instant::now() < deadline
        && !cancelled.load(Ordering::Acquire)
    {
        if stdout_result.is_none() {
            stdout_result = stdout_rx.try_recv().ok();
        }
        if stderr_result.is_none() {
            stderr_result = stderr_rx.try_recv().ok();
        }
        if stdout_result.is_none() || stderr_result.is_none() {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    if status.is_some() && (stdout_result.is_none() || stderr_result.is_none()) {
        timed_out = !cancelled.load(Ordering::Acquire);
        was_cancelled = cancelled.load(Ordering::Acquire);
    }
    // This exact job/process group contains only the probe. Terminating it
    // also closes pipes inherited by a descendant; unrelated user CLIs are
    // never enumerated or addressed.
    group.terminate();
    let _ = child.kill();
    let _ = child.wait();
    if stdout_result.is_none() {
        stdout_result = stdout_rx.recv_timeout(Duration::from_millis(100)).ok();
    }
    if stderr_result.is_none() {
        stderr_result = stderr_rx.recv_timeout(Duration::from_millis(100)).ok();
    }
    if was_cancelled {
        return Ok(ProbeResult::Cancelled);
    }
    let (stdout, stdout_truncated) = stdout_result.unwrap_or_default();
    let (stderr, stderr_truncated) = stderr_result.unwrap_or_default();
    let output = ProbeOutput {
        success: status.is_some_and(|status| status.success()),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        stdout_truncated,
        stderr_truncated,
    };
    if timed_out {
        Ok(ProbeResult::TimedOut(output))
    } else {
        Ok(ProbeResult::Completed(output))
    }
}

/// Capability facts a detector reports. Only booleans actually observed
/// are set; absent facts stay absent so status stays honest.
pub trait AuthDetector: Send + Sync {
    fn detect(&self, link_id: &str) -> AuthDetectorFacts;

    fn detect_cancelable(
        &self,
        link_id: &str,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> AuthDetectorFacts {
        if cancelled.load(std::sync::atomic::Ordering::Acquire) {
            let mut facts = AuthDetectorFacts::default();
            facts.probe_status = Some("cancelled".into());
            facts.detail = Some("account probe cancelled".into());
            facts
        } else {
            self.detect(link_id)
        }
    }
}

/// Real detection against CLIs already installed on this machine.
pub struct CliAuthDetector;

fn first_json_auth_fact(value: &Value) -> Option<bool> {
    match value {
        Value::Object(map) => {
            for key in ["authenticated", "loggedIn", "logged_in", "isAuthenticated"] {
                if let Some(value) = map.get(key).and_then(Value::as_bool) {
                    return Some(value);
                }
            }
            map.values().find_map(first_json_auth_fact)
        }
        Value::Array(values) => values.iter().find_map(first_json_auth_fact),
        _ => None,
    }
}

fn explicit_auth_fact(output: &ProbeOutput) -> Option<bool> {
    for source in [&output.stdout, &output.stderr] {
        if let Ok(value) = serde_json::from_str::<Value>(source.trim()) {
            if let Some(authenticated) = first_json_auth_fact(&value) {
                return Some(authenticated);
            }
        }
        for line in source.lines() {
            if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                if let Some(authenticated) = first_json_auth_fact(&value) {
                    return Some(authenticated);
                }
            }
        }
    }
    let text = format!("{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
    // Negative evidence is checked first because phrases such as "not logged
    // in" also contain the positive substring.
    if [
        "not logged in",
        "logged out",
        "not authenticated",
        "unauthenticated",
        "authenticated: false",
        "authenticated=false",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        Some(false)
    } else if [
        "logged in",
        "authenticated: true",
        "authenticated=true",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        Some(true)
    } else {
        None
    }
}

fn probe_detail(output: &ProbeOutput, fallback: &str) -> String {
    let first = output
        .stdout
        .lines()
        .chain(output.stderr.lines())
        .find(|line| !line.trim().is_empty())
        .unwrap_or(fallback);
    let mut detail = redact(first);
    if output.stdout_truncated {
        detail.push_str(" [stdout truncated]");
    }
    if output.stderr_truncated {
        detail.push_str(" [stderr truncated]");
    }
    detail
}

fn auth_probe_facts(name: &str, result: Result<ProbeResult, String>) -> AuthDetectorFacts {
    let mut facts = AuthDetectorFacts::default();
    match result {
        Ok(ProbeResult::Completed(output)) => {
            facts.installed = Some(true);
            facts.authenticated = explicit_auth_fact(&output);
            facts.probe_status = Some("completed".into());
            facts.stdout_truncated = output.stdout_truncated;
            facts.stderr_truncated = output.stderr_truncated;
            facts.detail = Some(probe_detail(
                &output,
                if output.success {
                    "probe completed without an explicit authentication fact"
                } else {
                    "account probe failed"
                },
            ));
        }
        Ok(ProbeResult::TimedOut(output)) => {
            facts.installed = Some(true);
            facts.probe_status = Some("timed_out".into());
            facts.stdout_truncated = output.stdout_truncated;
            facts.stderr_truncated = output.stderr_truncated;
            facts.detail = Some(probe_detail(&output, &format!("{name} account probe timed out")));
        }
        Ok(ProbeResult::Cancelled) => {
            facts.probe_status = Some("cancelled".into());
            facts.detail = Some(format!("{name} account probe cancelled"));
        }
        Ok(ProbeResult::Missing(_attempted)) => {
            facts.installed = Some(false);
            facts.probe_status = Some("unavailable".into());
            facts.detail = Some(format!("{name} CLI is not installed"));
        }
        Err(error) => {
            facts.probe_status = Some("failed".into());
            facts.detail = Some(redact(&format!("{name} account probe failed: {error}")));
        }
    }
    facts
}

impl AuthDetector for CliAuthDetector {
    fn detect(&self, link_id: &str) -> AuthDetectorFacts {
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        self.detect_cancelable(link_id, &cancelled)
    }

    fn detect_cancelable(
        &self,
        link_id: &str,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> AuthDetectorFacts {
        match link_id {
            "codex" => auth_probe_facts(
                "codex",
                run_cli(&["codex", "login", "status"], 4_000, cancelled),
            ),
            "claude-cli" => auth_probe_facts(
                "claude",
                run_cli(&["claude", "auth", "status"], 4_000, cancelled),
            ),
            "grok-cli" => {
                let mut facts = AuthDetectorFacts::default();
                match run_cli(&["grok", "--version"], 4_000, cancelled) {
                    Ok(ProbeResult::Completed(output)) => {
                        facts.installed = Some(true);
                        facts.probe_status = Some("completed".into());
                        facts.stdout_truncated = output.stdout_truncated;
                        facts.stderr_truncated = output.stderr_truncated;
                        facts.version = Some(
                            redact(output.stdout.lines().next().unwrap_or(""))
                                .chars()
                                .take(64)
                                .collect(),
                        );
                        // No public subscription->API bridge is documented:
                        // authentication stays unknown rather than assumed.
                    }
                    Ok(ProbeResult::TimedOut(output)) => {
                        facts.installed = Some(true);
                        facts.probe_status = Some("timed_out".into());
                        facts.stdout_truncated = output.stdout_truncated;
                        facts.stderr_truncated = output.stderr_truncated;
                        facts.detail = Some("grok version probe timed out".into());
                    }
                    Ok(ProbeResult::Cancelled) => {
                        facts.probe_status = Some("cancelled".into());
                        facts.detail = Some("grok version probe cancelled".into());
                    }
                    Ok(ProbeResult::Missing(_)) => {
                        facts.installed = Some(false);
                        facts.probe_status = Some("unavailable".into());
                    }
                    Err(error) => {
                        facts.probe_status = Some("failed".into());
                        facts.detail = Some(redact(&error));
                    }
                }
                facts
            }
            _ => AuthDetectorFacts::default(),
        }
    }
}

static AUTH_DETECTOR: OnceLock<std::sync::RwLock<std::sync::Arc<dyn AuthDetector>>> =
    OnceLock::new();

fn detector() -> std::sync::Arc<dyn AuthDetector> {
    AUTH_DETECTOR
        .get_or_init(|| std::sync::RwLock::new(std::sync::Arc::new(CliAuthDetector)))
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| std::sync::Arc::new(CliAuthDetector))
}

/// Tests install a fixture detector here; production keeps the CLI one.
pub fn set_auth_detector(detector: std::sync::Arc<dyn AuthDetector>) {
    let slot = AUTH_DETECTOR.get_or_init(|| {
        std::sync::RwLock::new(
            std::sync::Arc::new(CliAuthDetector) as std::sync::Arc<dyn AuthDetector>
        )
    });
    if let Ok(mut guard) = slot.write() {
        *guard = detector;
    }
}

fn ensure_catalog(store: &AuthLinkStore) -> Result<(), ProtocolError> {
    store
        .ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription")
        .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
    store
        .ensure_link("claude-cli", "cli", "Claude Code CLI", "subscription")
        .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
    store
        .ensure_link("grok-cli", "cli", "Grok CLI", "unknown")
        .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
    Ok(())
}

fn refresh_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Default)]
pub(crate) struct AuthRefreshRegistry {
    operations: std::sync::Arc<
        std::sync::Mutex<
            std::collections::HashMap<String, std::sync::Arc<AuthRefreshOperation>>,
        >,
    >,
}

struct AuthRefreshOperation {
    id: String,
    requested_link_id: Option<String>,
    created_at_ms: u64,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    state: std::sync::Mutex<AuthRefreshState>,
}

struct AuthRefreshState {
    status: &'static str,
    completed_at_ms: Option<u64>,
    refreshed: Vec<Value>,
    error: Option<String>,
}

impl AuthRefreshOperation {
    fn snapshot(&self) -> Value {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        json!({
            "id": self.id,
            "requestedLinkId": self.requested_link_id,
            "status": state.status,
            "createdAtMs": self.created_at_ms,
            "completedAtMs": state.completed_at_ms,
            "cancelRequested": self.cancelled.load(std::sync::atomic::Ordering::Acquire),
            "refreshed": state.refreshed,
            "error": state.error,
        })
    }

    fn finish(&self, status: &'static str, refreshed: Vec<Value>, error: Option<String>) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.status = status;
        state.completed_at_ms = Some(refresh_now_ms());
        state.refreshed = refreshed;
        state.error = error.map(|message| redact(&message));
    }
}

static AUTH_REFRESH_SEQUENCE: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(1);

impl AuthRefreshRegistry {
    fn start(
        &self,
        requested_link_id: Option<String>,
    ) -> Result<std::sync::Arc<AuthRefreshOperation>, ProtocolError> {
        let mut operations = self
            .operations
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if operations.values().any(|operation| {
            operation
                .state
                .lock()
                .map(|state| state.status == "running")
                .unwrap_or(true)
        }) {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "an account refresh is already running",
            ));
        }
        // Retain a bounded query history while never removing the live op.
        if operations.len() >= 64 {
            let oldest_terminal = operations
                .iter()
                .filter(|(_, operation)| {
                    operation
                        .state
                        .lock()
                        .map(|state| state.status != "running")
                        .unwrap_or(false)
                })
                .min_by_key(|(_, operation)| operation.created_at_ms)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest_terminal {
                operations.remove(&id);
            }
        }
        let created_at_ms = refresh_now_ms();
        let id = format!(
            "authrefresh_{created_at_ms:013x}_{:04x}",
            AUTH_REFRESH_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let operation = std::sync::Arc::new(AuthRefreshOperation {
            id: id.clone(),
            requested_link_id,
            created_at_ms,
            cancelled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            state: std::sync::Mutex::new(AuthRefreshState {
                status: "running",
                completed_at_ms: None,
                refreshed: Vec::new(),
                error: None,
            }),
        });
        operations.insert(id, operation.clone());
        Ok(operation)
    }

    fn get(&self, id: &str) -> Result<std::sync::Arc<AuthRefreshOperation>, ProtocolError> {
        self.operations
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| {
                ProtocolError::new(ErrorCategory::NotFound, "account refresh operation not found")
            })
    }
}

static AUTH_REFRESHES: OnceLock<AuthRefreshRegistry> = OnceLock::new();

fn refresh_registry() -> &'static AuthRefreshRegistry {
    AUTH_REFRESHES.get_or_init(AuthRefreshRegistry::default)
}

fn op_public(op: &AuthConnectOp) -> Value {
    // oauth_state / pkce_verifier deliberately omitted: server-side only.
    json!({
        "id": op.id,
        "linkId": op.link_id,
        "state": op.state,
        "authorizeUrl": op.authorize_url,
        "redirectPort": op.redirect_port,
        "createdAtMs": op.created_at_ms,
        "expiresAtMs": op.expires_at_ms,
    })
}

impl ControlPlane {
    pub(crate) fn auth_links(&self) -> AuthLinkStore {
        AuthLinkStore::open(&self.store.paths().state)
    }

    pub(crate) fn rpc_auth_link_list(&self, _params: &Value) -> Result<Value, ProtocolError> {
        let store = self.auth_links();
        ensure_catalog(&store)?;
        let mut links = Vec::new();
        for record in store
            .list_links()
            .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?
        {
            let live = store
                .live_op(&record.id)
                .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?
                .map(|op| op_public(&op));
            links.push(json!({ "link": record, "liveOp": live }));
        }
        Ok(json!({ "links": links }))
    }

    /// Re-detect one (or all) links. The caller decides what to do with
    /// the honest result. Detection runs off the control request loop so
    /// health, reads and cancellation remain responsive.
    pub(crate) fn rpc_auth_link_refresh(&self, params: &Value) -> Result<Value, ProtocolError> {
        let store = self.auth_links();
        ensure_catalog(&store)?;
        let only = params["id"].as_str().map(str::to_string);
        let records = store
            .list_links()
            .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
        let link_ids: Vec<String> = records
            .into_iter()
            .filter(|record| only.as_ref().is_none_or(|id| id == &record.id))
            .map(|record| record.id)
            .collect();
        if only.is_some() && link_ids.is_empty() {
            return Err(ProtocolError::new(
                ErrorCategory::NotFound,
                "auth link not found",
            ));
        }
        let operation = refresh_registry().start(only)?;
        let state_path = self.store.paths().state.clone();
        let worker_operation = operation.clone();
        let auth_detector = detector();
        std::thread::spawn(move || {
            let store = AuthLinkStore::open(&state_path);
            let mut refreshed = Vec::new();
            for link_id in link_ids {
                if worker_operation
                    .cancelled
                    .load(std::sync::atomic::Ordering::Acquire)
                {
                    worker_operation.finish("cancelled", refreshed, None);
                    return;
                }
                let facts = auth_detector
                    .detect_cancelable(&link_id, worker_operation.cancelled.as_ref());
                if worker_operation
                    .cancelled
                    .load(std::sync::atomic::Ordering::Acquire)
                    || facts.probe_status.as_deref() == Some("cancelled")
                {
                    worker_operation.finish("cancelled", refreshed, None);
                    return;
                }
                let mut capabilities = json!({});
                if let Some(installed) = facts.installed {
                    capabilities["installed"] = json!(installed);
                }
                if let Some(authenticated) = facts.authenticated {
                    capabilities["authenticated"] = json!(authenticated);
                }
                if let Some(version) = &facts.version {
                    capabilities["version"] = json!(version);
                }
                if let Some(probe_status) = &facts.probe_status {
                    capabilities["probeStatus"] = json!(probe_status);
                }
                if facts.stdout_truncated {
                    capabilities["stdoutTruncated"] = json!(true);
                }
                if facts.stderr_truncated {
                    capabilities["stderrTruncated"] = json!(true);
                }
                match store.apply_detection(
                    &link_id,
                    None,
                    capabilities,
                    None,
                    facts.detail.as_deref(),
                ) {
                    Ok(updated) => refreshed.push(json!({ "link": updated })),
                    Err(error) => {
                        worker_operation.finish("failed", refreshed, Some(error.to_string()));
                        return;
                    }
                }
            }
            worker_operation.finish("completed", refreshed, None);
        });
        Ok(json!({ "operation": operation.snapshot() }))
    }

    pub(crate) fn rpc_auth_link_refresh_read(
        &self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let id = params["id"]
            .as_str()
            .ok_or_else(|| invalid("id is required"))?;
        Ok(json!({ "operation": refresh_registry().get(id)?.snapshot() }))
    }

    pub(crate) fn rpc_auth_link_refresh_cancel(
        &self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let id = params["id"]
            .as_str()
            .ok_or_else(|| invalid("id is required"))?;
        let operation = refresh_registry().get(id)?;
        let status = operation
            .state
            .lock()
            .map(|state| state.status)
            .unwrap_or("failed");
        if status == "running" {
            operation
                .cancelled
                .store(true, std::sync::atomic::Ordering::Release);
        }
        Ok(json!({ "operation": operation.snapshot() }))
    }

    /// Start the Codex public login: assemble the PKCE authorize URL and
    /// register a single-flight op. The user finishes the real login.
    pub(crate) fn rpc_auth_link_connect_start(
        &self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let id = params["id"].as_str().unwrap_or("codex");
        let store = self.auth_links();
        ensure_catalog(&store)?;
        let record = store
            .read_link(id)
            .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?
            .ok_or_else(|| {
                ProtocolError::new(ErrorCategory::NotFound, format!("auth link {id} not found"))
            })?;
        if record.kind != "oauth" {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                format!(
                    "auth link {id} is a CLI link: its login belongs to the installed CLI, not a browser flow"
                ),
            ));
        }
        let (verifier, challenge) =
            make_pkce().map_err(|e| ProtocolError::new(ErrorCategory::Internal, e))?;
        let state =
            make_oauth_state().map_err(|e| ProtocolError::new(ErrorCategory::Internal, e))?;
        let url = codex_authorize_url(&state, &challenge);
        let op = store
            .connect_start(
                id,
                &url,
                Some(CODEX_REDIRECT_PORT),
                Some(state),
                Some(verifier),
                LOGIN_TTL_MS,
            )
            .map_err(auth_error)?;
        Ok(json!({ "op": op_public(&op) }))
    }

    pub(crate) fn rpc_auth_link_connect_cancel(
        &self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let id = params["id"].as_str().unwrap_or("codex");
        let store = self.auth_links();
        if let Some(op) = store
            .live_op(id)
            .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?
        {
            store
                .connect_finish(&op.id, "cancelled", None, None, Some("cancelled by user"))
                .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
            return Ok(json!({ "cancelled": true, "op": op.id }));
        }
        Ok(json!({ "cancelled": false }))
    }

    /// Validate the redirect's OAuth `state` (local loopback flow only:
    /// no real identity-provider exchange happens in this product path).
    /// Wrong state is a typed rejection; a correct one progresses the
    /// live op waiting → exchanging exactly once.
    pub(crate) fn rpc_auth_link_connect_complete(
        &self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let id = params["id"].as_str().unwrap_or("codex");
        let state = params["state"]
            .as_str()
            .ok_or_else(|| invalid("state is required"))?;
        let store = self.auth_links();
        let op = store.connect_callback(id, state).map_err(auth_error)?;
        Ok(json!({ "op": op_public(&op) }))
    }
    /// Disconnect clears the local connection record. It cannot and does
    /// not log the user out of any independently installed CLI.
    pub(crate) fn rpc_auth_link_disconnect(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = params["id"]
            .as_str()
            .ok_or_else(|| invalid("auth link id is required"))?;
        let store = self.auth_links();
        let record = store
            .disconnect(id, params["expectedRevision"].as_u64())
            .map_err(auth_error)?;
        Ok(json!({ "link": record }))
    }
}

#[cfg(test)]
mod auth_links_rpc_tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    struct FixtureDetector {
        facts: Mutex<std::collections::HashMap<String, AuthDetectorFacts>>,
    }

    impl AuthDetector for FixtureDetector {
        fn detect(&self, link_id: &str) -> AuthDetectorFacts {
            self.facts
                .lock()
                .unwrap()
                .get(link_id)
                .cloned()
                .unwrap_or_default()
        }
    }

    fn install(facts: Vec<(&str, AuthDetectorFacts)>) {
        let map: std::collections::HashMap<String, AuthDetectorFacts> = facts
            .into_iter()
            .map(|(id, value)| (id.to_string(), value))
            .collect();
        set_auth_detector(std::sync::Arc::new(FixtureDetector {
            facts: Mutex::new(map),
        }));
    }

    fn wait_refresh(plane: &ControlPlane, id: &str) -> Value {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let operation = plane
                .rpc_auth_link_refresh_read(&json!({ "id": id }))
                .unwrap()["operation"]
                .clone();
            if operation["status"] != json!("running") {
                return operation;
            }
            assert!(std::time::Instant::now() < deadline, "refresh stayed running");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    fn fixture_command(mode: &str, deadline_ms: u64) -> ProbeResult {
        let executable = std::env::current_exe().unwrap();
        let executable = executable.to_str().unwrap();
        let args = [
            executable,
            "--exact",
            "auth_links_rpc::auth_links_rpc_tests::probe_fixture_process",
            "--nocapture",
        ];
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        run_cli_with_env(
            &args,
            deadline_ms,
            &cancelled,
            &[("KNORVIA_A14_PROBE_FIXTURE", mode)],
        )
        .unwrap()
    }

    #[test]
    fn probe_fixture_process() {
        use std::io::Write;
        match std::env::var("KNORVIA_A14_PROBE_FIXTURE").as_deref() {
            Ok("large") => {
                let mut stdout = std::io::stdout().lock();
                let mut stderr = std::io::stderr().lock();
                for _ in 0..160 {
                    stdout.write_all(&[b'o'; 1024]).unwrap();
                    stderr.write_all(&[b'e'; 1024]).unwrap();
                }
                stdout.flush().unwrap();
                stderr.flush().unwrap();
            }
            Ok("sleep") | Ok("hold") => loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
            },
            Ok("descendant") => {
                let executable = std::env::current_exe().unwrap();
                std::process::Command::new(executable)
                    .args([
                        "--exact",
                        "auth_links_rpc::auth_links_rpc_tests::probe_fixture_process",
                        "--nocapture",
                    ])
                    .env("KNORVIA_A14_PROBE_FIXTURE", "hold")
                    .spawn()
                    .unwrap();
                // Return with the descendant still owning inherited pipes.
            }
            _ => {}
        }
    }

    #[test]
    fn probe_drains_large_streams_concurrently_and_marks_truncation() {
        let ProbeResult::Completed(output) = fixture_command("large", 5_000) else {
            panic!("large-output probe did not complete")
        };
        assert!(output.success);
        assert!(output.stdout_truncated);
        assert!(output.stderr_truncated);
        assert_eq!(output.stdout.len(), PROBE_OUTPUT_LIMIT);
        assert_eq!(output.stderr.len(), PROBE_OUTPUT_LIMIT);
        let detail = probe_detail(&output, "fixture");
        assert!(detail.contains("[stdout truncated]"), "{detail}");
        assert!(detail.contains("[stderr truncated]"), "{detail}");
    }

    #[test]
    fn monotonic_deadline_reclaims_permanent_and_pipe_holding_trees() {
        for mode in ["sleep", "descendant"] {
            let started = std::time::Instant::now();
            assert!(matches!(fixture_command(mode, 700), ProbeResult::TimedOut(_)));
            assert!(
                started.elapsed() < std::time::Duration::from_secs(2),
                "{mode} exceeded the monotonic total budget by too much: {:?}",
                started.elapsed()
            );
        }
    }

    #[test]
    fn timeout_kills_only_the_registered_probe_tree() {
        let executable = std::env::current_exe().unwrap();
        let mut unrelated = std::process::Command::new(executable)
            .args([
                "--exact",
                "auth_links_rpc::auth_links_rpc_tests::probe_fixture_process",
                "--nocapture",
            ])
            .env("KNORVIA_A14_PROBE_FIXTURE", "hold")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        assert!(matches!(fixture_command("sleep", 500), ProbeResult::TimedOut(_)));
        assert!(
            unrelated.try_wait().unwrap().is_none(),
            "an unrelated process must not be reclaimed with the probe job"
        );
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
    }

    #[test]
    fn cancellation_reclaims_the_registered_process_tree_promptly() {
        let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let worker_cancelled = cancelled.clone();
        let worker = std::thread::spawn(move || {
            let executable = std::env::current_exe().unwrap();
            let executable = executable.to_str().unwrap();
            let args = [
                executable,
                "--exact",
                "auth_links_rpc::auth_links_rpc_tests::probe_fixture_process",
                "--nocapture",
            ];
            run_cli_with_env(
                &args,
                10_000,
                worker_cancelled.as_ref(),
                &[("KNORVIA_A14_PROBE_FIXTURE", "descendant")],
            )
            .unwrap()
        });
        std::thread::sleep(std::time::Duration::from_millis(200));
        let started = std::time::Instant::now();
        cancelled.store(true, std::sync::atomic::Ordering::Release);
        assert!(matches!(worker.join().unwrap(), ProbeResult::Cancelled));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn probe_truth_requires_explicit_authentication_evidence() {
        let output = |stdout: &str| ProbeOutput {
            success: true,
            stdout: stdout.into(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        assert_eq!(explicit_auth_fact(&output("command succeeded")), None);
        assert_eq!(
            explicit_auth_fact(&output(r#"{"authenticated":false}"#)),
            Some(false)
        );
        assert_eq!(explicit_auth_fact(&output("Not logged in")), Some(false));
        assert_eq!(explicit_auth_fact(&output("Logged in using ChatGPT")), Some(true));

        let missing = std::sync::atomic::AtomicBool::new(false);
        let result = run_cli(
            &["knorvia-a14-command-that-does-not-exist-81c87f"],
            500,
            &missing,
        )
        .unwrap();
        let facts = auth_probe_facts("fixture", Ok(result));
        assert_eq!(facts.installed, Some(false));
        assert_eq!(facts.authenticated, None);
        assert_eq!(facts.probe_status.as_deref(), Some("unavailable"));

        let facts = auth_probe_facts("fixture", Ok(fixture_command("sleep", 400)));
        assert_eq!(facts.installed, Some(true));
        assert_eq!(facts.authenticated, None);
        assert_eq!(facts.probe_status.as_deref(), Some("timed_out"));
    }

    #[test]
    fn catalog_lists_honest_defaults_with_quota_types() {
        let plane = crate::tests::plane();
        let result = plane.rpc_auth_link_list(&json!({})).unwrap();
        let links = result["links"].as_array().unwrap();
        assert_eq!(links.len(), 3);
        let codex = links
            .iter()
            .find(|l| l["link"]["id"] == json!("codex"))
            .unwrap();
        assert_eq!(codex["link"]["status"], json!("disconnected"));
        assert_eq!(codex["link"]["quotaType"], json!("subscription"));
        let grok = links
            .iter()
            .find(|l| l["link"]["id"] == json!("grok-cli"))
            .unwrap();
        assert_eq!(
            grok["link"]["quotaType"],
            json!("unknown"),
            "undocumented quota stays unknown"
        );
    }

    #[test]
    fn refresh_reflects_detector_truth_not_wishes() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
        let plane = crate::tests::plane();
        let mut claude = AuthDetectorFacts::default();
        claude.installed = Some(false);
        let mut codex = AuthDetectorFacts::default();
        codex.installed = Some(true);
        codex.authenticated = Some(true);
        codex.detail = Some("Logged in using ChatGPT".into());
        install(vec![("claude-cli", claude), ("codex", codex)]);

        let result = plane
            .rpc_auth_link_refresh(&json!({ "id": "claude-cli" }))
            .unwrap();
        let operation = wait_refresh(&plane, result["operation"]["id"].as_str().unwrap());
        assert_eq!(operation["status"], json!("completed"));
        assert_eq!(operation["refreshed"][0]["link"]["status"], json!("error"));
        assert!(
            operation["refreshed"][0]["link"]["detail"]
                .as_str()
                .unwrap()
                .to_lowercase()
                .contains("not installed")
        );

        let result = plane
            .rpc_auth_link_refresh(&json!({ "id": "codex" }))
            .unwrap();
        assert_eq!(
            wait_refresh(&plane, result["operation"]["id"].as_str().unwrap())["status"],
            json!("completed")
        );
        let list = plane.rpc_auth_link_list(&json!({})).unwrap();
        let codex = list["links"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["link"]["id"] == json!("codex"))
            .unwrap();
        assert_eq!(codex["link"]["status"], json!("connected"));
        assert_eq!(
            codex["link"]["quotaType"],
            json!("subscription"),
            "Codex login stays subscription-labeled"
        );
    }

    #[test]
    fn refresh_list_and_disk_never_expose_detector_credentials() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
        let plane = crate::tests::plane();
        let mut facts = AuthDetectorFacts::default();
        facts.installed = Some(true);
        facts.authenticated = Some(false);
        facts.version = Some("sk-refresh-secret".into());
        facts.detail = Some(
            "Authorization: Bearer tiny refresh https://api.example/cb?state=oauth-secret 中文诊断 status 401"
                .into(),
        );
        facts.probe_status = Some("completed".into());
        install(vec![("codex", facts)]);

        let started = plane
            .rpc_auth_link_refresh(&json!({ "id": "codex" }))
            .unwrap();
        let operation = wait_refresh(
            &plane,
            started["operation"]["id"].as_str().unwrap(),
        );
        let list = plane.rpc_auth_link_list(&json!({})).unwrap();
        let disk = std::fs::read_to_string(
            plane
                .store
                .paths()
                .state
                .join("product/auth/links/codex.json"),
        )
        .unwrap();
        for projection in [operation.to_string(), list.to_string(), disk] {
            for secret in ["sk-refresh-secret", "tiny", "oauth-secret"] {
                assert!(!projection.contains(secret), "{secret} leaked: {projection}");
            }
            assert!(projection.contains("401"), "{projection}");
            assert!(projection.contains("api.example"), "{projection}");
        }
    }

    struct CancelAwareDetector {
        started: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl AuthDetector for CancelAwareDetector {
        fn detect(&self, _link_id: &str) -> AuthDetectorFacts {
            unreachable!("async refresh uses cancel-aware detection")
        }

        fn detect_cancelable(
            &self,
            _link_id: &str,
            cancelled: &std::sync::atomic::AtomicBool,
        ) -> AuthDetectorFacts {
            self.started
                .store(true, std::sync::atomic::Ordering::Release);
            while !cancelled.load(std::sync::atomic::Ordering::Acquire) {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            let mut facts = AuthDetectorFacts::default();
            facts.probe_status = Some("cancelled".into());
            facts
        }
    }

    #[test]
    fn async_refresh_keeps_health_read_and_cancel_responsive() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
        let mut plane = crate::tests::plane();
        plane
            .handle_json(
                r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocol":{"major":1,"minor":0},"client":{"name":"a14-test","version":"0"}}}"#,
            )
            .unwrap();
        plane
            .handle_json(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
            .unwrap();
        let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        set_auth_detector(std::sync::Arc::new(CancelAwareDetector {
            started: started.clone(),
        }));
        let before = std::time::Instant::now();
        let result = plane
            .rpc_auth_link_refresh(&json!({ "id": "codex" }))
            .unwrap();
        assert!(before.elapsed() < std::time::Duration::from_millis(250));
        let id = result["operation"]["id"].as_str().unwrap();
        while !started.load(std::sync::atomic::Ordering::Acquire) {
            std::thread::yield_now();
        }

        let health_started = std::time::Instant::now();
        let health = plane
            .handle_json(r#"{"jsonrpc":"2.0","id":1,"method":"system/health"}"#)
            .unwrap()
            .unwrap();
        assert!(health.contains(r#""ok":true"#), "{health}");
        assert!(health_started.elapsed() < std::time::Duration::from_millis(250));
        assert_eq!(
            plane.rpc_auth_link_refresh_read(&json!({ "id": id })).unwrap()["operation"]
                ["status"],
            json!("running")
        );
        let cancel_started = std::time::Instant::now();
        plane
            .rpc_auth_link_refresh_cancel(&json!({ "id": id }))
            .unwrap();
        assert!(cancel_started.elapsed() < std::time::Duration::from_millis(250));
        assert_eq!(wait_refresh(&plane, id)["status"], json!("cancelled"));
    }

    #[test]
    fn connect_start_builds_public_pkce_url_and_is_single_flight() {
        let plane = crate::tests::plane();
        let result = plane
            .rpc_auth_link_connect_start(&json!({ "id": "codex" }))
            .unwrap();
        let url = result["op"]["authorizeUrl"].as_str().unwrap();
        assert!(url.starts_with("https://auth.openai.com/oauth/authorize"));
        assert!(url.contains("client_id=app_EMoamEEZ73f0CkXaXp7hrann"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A1455"));
        assert_eq!(result["op"]["state"], json!("waiting"));
        assert!(
            result["op"].get("pkceVerifier").is_none(),
            "PKCE verifier never leaves the server"
        );
        // single flight
        assert!(
            plane
                .rpc_auth_link_connect_start(&json!({ "id": "codex" }))
                .is_err()
        );
        // CLI links have no browser flow
        assert_eq!(
            plane
                .rpc_auth_link_connect_start(&json!({ "id": "claude-cli" }))
                .unwrap_err()
                .category,
            ErrorCategory::InvalidArgument
        );
        // cancel returns to a clear state
        let cancelled = plane
            .rpc_auth_link_connect_cancel(&json!({ "id": "codex" }))
            .unwrap();
        assert_eq!(cancelled["cancelled"], json!(true));
        let list = plane.rpc_auth_link_list(&json!({})).unwrap();
        let codex = list["links"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["link"]["id"] == json!("codex"))
            .unwrap();
        assert_eq!(codex["link"]["status"], json!("disconnected"));
        assert!(codex["liveOp"].is_null());
    }
    #[test]
    fn pkce_verifier_comes_from_the_os_csprng_and_state_is_independent() {
        // Two consecutive pairs share no process-derivable prefix: the
        // verifier is getrandom bytes, not a hash of time+pid.
        let (v1, c1) = make_pkce().unwrap();
        let (v2, c2) = make_pkce().unwrap();
        assert_ne!(v1, v2, "verifier must not be reproducible");
        assert_ne!(c1, c2);
        for v in [&v1, &v2] {
            assert_eq!(v.len(), 43, "32 bytes base64url = 43 chars");
            assert!(
                v.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
                "verifier alphabet must be URL-safe unreserved: {v}"
            );
        }
        // challenge = S256(verifier), verifiable by any OAuth peer.
        assert_eq!(c1, b64url(&Sha256::digest(v1.as_bytes())));
        // The state is not derived from the verifier.
        let s1 = make_oauth_state().unwrap();
        let s2 = make_oauth_state().unwrap();
        assert_ne!(s1, s2);
        assert_ne!(
            s1,
            b64url(&Sha256::digest(format!("{v1}|state").as_bytes())),
            "state must be independent random, not verifier-derived"
        );
    }

    #[test]
    fn connect_complete_validates_state_and_terminal_ops_scrub_secrets() {
        let plane = crate::tests::plane();
        let result = plane
            .rpc_auth_link_connect_start(&json!({ "id": "codex" }))
            .unwrap();
        let op = &result["op"];
        assert!(
            op.get("pkceVerifier").is_none(),
            "verifier never leaves the server"
        );
        assert!(
            op.get("oauthState").is_none(),
            "state never leaves the server"
        );
        let url = op["authorizeUrl"].as_str().unwrap();
        let state_in_url = url
            .split("state=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap();

        // Wrong state: typed rejection.
        let err = plane
            .rpc_auth_link_connect_complete(&json!({ "id": "codex", "state": "forged" }))
            .unwrap_err();
        assert_eq!(err.category, ErrorCategory::InvalidArgument, "{err}");

        // Correct state: progresses once; a replay is a conflict.
        let ok = plane
            .rpc_auth_link_connect_complete(&json!({ "id": "codex", "state": state_in_url }))
            .unwrap();
        assert_eq!(ok["op"]["state"], json!("exchanging"));
        let replay =
            plane.rpc_auth_link_connect_complete(&json!({ "id": "codex", "state": state_in_url }));
        assert!(replay.is_err(), "replayed callback is a conflict");

        // Terminal outcome scrubs the durable op record on disk: no
        // verifier, state or state-bearing URL remains in the Home.
        let store = plane.auth_links();
        let op_id = ok["op"]["id"].as_str().unwrap().to_string();
        store
            .connect_finish(&op_id, "failed", None, None, Some("fixture"))
            .unwrap();
        let state_dir = plane.store.paths().state.clone();
        let bytes = std::fs::read(
            state_dir
                .join("product")
                .join("auth")
                .join("ops")
                .join(format!("{op_id}.json")),
        )
        .unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains("pkceVerifier"), "{text}");
        assert!(!text.contains("oauthState"), "{text}");
        assert!(!text.contains("authorizeUrl"), "{text}");
        let _ = std::fs::remove_dir_all(&plane.store.paths().home);
    }
}
