//! Supervised pack worker RPC (CAP-001).
//!
//! The daemon spawns the `knorvia-pack-worker` binary with an explicit
//! environment allowlist (never the full parent environment), performs the
//! framed initialize/render handshake over stdio, and enforces deadlines by
//! killing the worker (a killed worker cannot publish anything: the daemon
//! owns the artifact runtime). A worker crash or protocol violation yields a
//! typed failure — never a fabricated success.

use knorvia_protocol::{ProtocolError, read_frame, write_frame};
use serde_json::{Value, json};
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const WORKER_BIN_ENV: &str = "KNORVIA_PACK_WORKER_BIN";
/// Hard deadline for one render call (the watchdog kills the worker).
pub const RENDER_TIMEOUT_SECS: u64 = 180;

#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error("pack worker binary unavailable: {0}; set KNORVIA_PACK_WORKER_BIN")]
    BinaryMissing(String),
    #[error("pack worker transport failure: {0}")]
    Transport(String),
    #[error("pack worker failed: {0}")]
    Failed(String),
    #[error("pack worker render exceeded {0}s deadline; worker killed")]
    Deadline(u64),
}

/// The subset of the parent environment the worker may receive.
pub fn worker_env() -> Vec<(String, String)> {
    let mut vars = Vec::new();
    // Keep in sync with knorvia_packs::gateway (the provider variables the
    // pack model backend may consume).
    const ALLOWLIST: &[&str] = &[
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "SYSTEMROOT",
        "windir",
        "WINDIR",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "KNORVIA_PROVIDER_KIND",
        "KNORVIA_PROVIDER_MODEL",
        "KNORVIA_PROVIDER_BASE_URL",
        "KNORVIA_PROVIDER_API_KEY",
        "KNORVIA_WORKER_FIXTURE_DELAY_MS",
        "KNORVIA_WORKER_FIXTURE_PID_DIR",
    ];
    for key in ALLOWLIST {
        if let Ok(value) = std::env::var(key) {
            vars.push(((*key).to_string(), value));
        }
    }
    vars
}

fn worker_bin_name() -> &'static str {
    if cfg!(windows) {
        "knorvia-pack-worker.exe"
    } else {
        "knorvia-pack-worker"
    }
}

/// Resolve the worker binary: explicit env override, then a sibling of the
/// current executable. Never PATH.
pub fn resolve_worker_bin() -> Result<PathBuf, WorkerError> {
    if let Some(p) = std::env::var_os(WORKER_BIN_ENV) {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Ok(path);
        }
        return Err(WorkerError::BinaryMissing(format!(
            "{WORKER_BIN_ENV} not a file: {}",
            path.display()
        )));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let cand = dir.join(worker_bin_name());
            if cand.is_file() {
                return Ok(cand);
            }
        }
    }
    Err(WorkerError::BinaryMissing(
        "no sibling knorvia-pack-worker binary next to the daemon".into(),
    ))
}

/// Owns every process spawned for one worker: on Windows the worker is
/// assigned to a dedicated Job Object with KILL_ON_JOB_CLOSE, so a cancel
/// reclaims the worker AND any descendant it spawned (a grandchild holding
/// the inherited stdout pipe cannot survive its parent's cancellation).
/// Closing the job handle on drop is itself a kill switch.
struct ProcessGroup {
    child: Arc<Mutex<Child>>,
    termination: Mutex<()>,
    reclaimed: AtomicBool,
    #[cfg(windows)]
    job: std::sync::atomic::AtomicIsize,
}

#[cfg(windows)]
impl ProcessGroup {
    /// Spawn the worker into its own killable job and take the stdio pipes.
    fn spawn(
        cmd: &mut Command,
    ) -> Result<(Arc<Self>, ChildStdin, BufReader<ChildStdout>), WorkerError> {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject,
        };
        cmd.creation_flags(0x00000004 | 0x08000000); // suspended + no visible window
        let mut child = cmd
            .spawn()
            .map_err(|e| WorkerError::Transport(e.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| WorkerError::Transport("worker stdin missing".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| WorkerError::Transport("worker stdout missing".into()))?;
        let group = Arc::new(Self {
            child: Arc::new(Mutex::new(child)),
            termination: Mutex::new(()),
            reclaimed: AtomicBool::new(false),
            job: std::sync::atomic::AtomicIsize::new(0),
        });
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(WorkerError::Transport(
                    "worker job object could not be created".into(),
                ));
            }
            let mut limit = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limit as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let assigned = if configured != 0 {
                use std::os::windows::io::AsRawHandle;
                let handle = group
                    .child
                    .lock()
                    .ok()
                    .map(|mut child| child.as_raw_handle());
                match handle {
                    Some(handle) => AssignProcessToJobObject(job, handle),
                    None => 0,
                }
            } else {
                0
            };
            if configured == 0 || assigned == 0 {
                // Fail closed: the worker must never outlive its job.
                TerminateJobObject(job, 1);
                let _ = CloseHandle(job);
                group.kill();
                return Err(WorkerError::Transport(
                    "worker could not be placed under its killable job".into(),
                ));
            }
            group
                .job
                .store(job as isize, std::sync::atomic::Ordering::SeqCst);
        }
        // No worker instruction can run before Job Object assignment, closing
        // the escape window for children created immediately at process start.
        if let Err(error) = resume_worker(&group) {
            group.kill();
            return Err(error);
        }
        Ok((group, stdin, BufReader::new(stdout)))
    }

    /// Kill the whole tree: terminate the job (worker + descendants), then
    /// reap the direct child so no zombie or file lock outlives the cancel.
    fn kill(&self) -> bool {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JobObjectBasicAccountingInformation,
            QueryInformationJobObject, TerminateJobObject,
        };
        let _termination = self.termination.lock().unwrap_or_else(|e| e.into_inner());
        if self.reclaimed.load(Ordering::Acquire) {
            return true;
        }
        let job = self.job.swap(0, Ordering::SeqCst);
        let mut tree_gone = job == 0;
        if job != 0 {
            unsafe {
                TerminateJobObject(job as _, 1);
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                loop {
                    let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
                    let read = QueryInformationJobObject(
                        job as _,
                        JobObjectBasicAccountingInformation,
                        &mut accounting as *mut _ as _,
                        std::mem::size_of_val(&accounting) as u32,
                        std::ptr::null_mut(),
                    );
                    if read != 0 && accounting.ActiveProcesses == 0 {
                        tree_gone = true;
                        break;
                    }
                    if std::time::Instant::now() >= deadline {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                CloseHandle(job as _);
            }
        }
        let child_gone = if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            child.wait().is_ok()
        } else {
            false
        };
        self.reclaimed
            .store(tree_gone && child_gone, Ordering::Release);
        tree_gone && child_gone
    }
}

#[cfg(windows)]
fn resume_worker(group: &ProcessGroup) -> Result<(), WorkerError> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    let pid = group.child.lock().unwrap_or_else(|e| e.into_inner()).id();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(WorkerError::Transport(
                "cannot enumerate suspended worker thread".into(),
            ));
        }
        let mut entry = THREADENTRY32::default();
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut found = Thread32First(snapshot, &mut entry);
        let mut resumed = false;
        while found != 0 {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if !thread.is_null() {
                    resumed = ResumeThread(thread) != u32::MAX;
                    CloseHandle(thread);
                }
                break;
            }
            found = Thread32Next(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        if resumed {
            Ok(())
        } else {
            Err(WorkerError::Transport(
                "cannot resume managed worker thread".into(),
            ))
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(not(windows))]
impl ProcessGroup {
    fn spawn(
        cmd: &mut Command,
    ) -> Result<(Arc<Self>, ChildStdin, BufReader<ChildStdout>), WorkerError> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| WorkerError::Transport(e.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| WorkerError::Transport("worker stdin missing".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| WorkerError::Transport("worker stdout missing".into()))?;
        let group = Arc::new(Self {
            child: Arc::new(Mutex::new(child)),
            termination: Mutex::new(()),
            reclaimed: AtomicBool::new(false),
        });
        Ok((group, stdin, BufReader::new(stdout)))
    }

    fn kill(&self) -> bool {
        let _termination = self.termination.lock().unwrap_or_else(|e| e.into_inner());
        if self.reclaimed.load(Ordering::Acquire) {
            return true;
        }
        if let Ok(mut child) = self.child.lock() {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let gone = child.wait().is_ok();
            self.reclaimed.store(gone, Ordering::Release);
            return gone;
        }
        false
    }
}

#[cfg(not(windows))]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Cancellation-safe handle to one worker's process tree. Clone it into the
/// cancel registry before handing the client to a render thread.
pub struct ProcessGroupKill {
    group: Arc<ProcessGroup>,
}

impl ProcessGroupKill {
    pub fn kill(&self) -> bool {
        self.group.kill()
    }
}

pub struct PackWorkerClient {
    group: Arc<ProcessGroup>,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
    event_sink: Option<Arc<dyn Fn(&Value) + Send + Sync>>,
}

/// Command spec for spawning a worker process (program + args). The
/// allowlisted environment applies to every spec.
#[derive(Debug, Clone)]
pub struct WorkerSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl PackWorkerClient {
    /// Spawn the worker with the allowlisted environment only.
    pub fn spawn(bin: &Path) -> Result<Self, WorkerError> {
        Self::spawn_spec(&WorkerSpec {
            program: bin.to_path_buf(),
            args: Vec::new(),
        })
    }

    /// Spawn the worker from an explicit command spec (e.g. the Python media
    /// worker: `[python, "-m", "knorvia.workers.media_worker]`). The
    /// allowlisted environment applies to every spec.
    pub fn spawn_spec(spec: &WorkerSpec) -> Result<Self, WorkerError> {
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Worker stderr is logs only; inherit so verbose workers cannot
            // deadlock on an unread pipe.
            .stderr(Stdio::inherit());
        // Explicit environment: NOTHING is inherited by default.
        cmd.env_clear();
        for (key, value) in worker_env() {
            cmd.env(key, value);
        }
        let (group, stdin, stdout) = ProcessGroup::spawn(&mut cmd)?;
        Ok(Self {
            group,
            stdin,
            stdout,
            next_id: 1,
            event_sink: None,
        })
    }

    /// Resolve the command spec for a pack runtime: `native` → the Rust
    /// worker binary; `python` → the Python media worker module.
    pub fn spec_for_runtime(runtime: &str) -> Result<WorkerSpec, WorkerError> {
        match runtime {
            "python" => {
                let python = std::env::var("KNORVIA_PYTHON").unwrap_or_else(|_| "python".into());
                Ok(WorkerSpec {
                    program: PathBuf::from(python),
                    args: vec!["-m".into(), "knorvia.workers.media_worker".into()],
                })
            }
            _ => Ok(WorkerSpec {
                program: resolve_worker_bin()?,
                args: Vec::new(),
            }),
        }
    }

    pub fn is_alive(&self) -> bool {
        matches!(
            self.group
                .child
                .lock()
                .ok()
                .and_then(|mut c| c.try_wait().ok()),
            Some(None)
        )
    }

    /// Kill the worker's whole process tree (cancel/crash path) and reap the
    /// direct child so no pipe holder or file lock outlives the cancel.
    pub fn kill(&mut self) {
        self.group.kill();
    }

    /// Shared kill handle for cancellation paths that do not own the client
    /// (a render is in flight on another thread). Killing is idempotent.
    pub fn kill_handle(&self) -> ProcessGroupKill {
        ProcessGroupKill {
            group: Arc::clone(&self.group),
        }
    }

    fn write_msg(&mut self, msg: &Value) -> Result<(), WorkerError> {
        let body = serde_json::to_string(msg).map_err(|e| WorkerError::Transport(e.to_string()))?;
        write_frame(&mut self.stdin, &body).map_err(|e| WorkerError::Transport(e.to_string()))?;
        self.stdin
            .flush()
            .map_err(|e| WorkerError::Transport(e.to_string()))?;
        Ok(())
    }

    fn read_response(&mut self, request_id: i64) -> Result<Value, WorkerError> {
        loop {
            let body =
                read_frame(&mut self.stdout).map_err(|e| WorkerError::Transport(e.to_string()))?;
            let v: Value = serde_json::from_str(&body)
                .map_err(|e| WorkerError::Transport(format!("worker sent non-JSON frame: {e}")))?;
            if v.get("id").is_none() {
                // Worker notification (progress/cancelled-ack): surface it.
                if let Some(sink) = self.event_sink.as_ref() {
                    sink(&v);
                }
                continue;
            }
            if v.get("id").and_then(|i| i.as_i64()) != Some(request_id) {
                continue;
            }
            if let Some(err) = v.get("error") {
                return Err(WorkerError::Failed(
                    err.get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("worker error")
                        .to_string(),
                ));
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    /// Surface worker notifications (progress events) to the caller.
    pub fn set_event_sink(&mut self, sink: Option<Arc<dyn Fn(&Value) + Send + Sync>>) {
        self.event_sink = sink;
    }

    /// Cooperative cancel: notify the worker to stop at its next checkpoint.
    /// A render already in flight finishes its current stage; combined with
    /// the watchdog kill this bounds worst-case cancellation latency.
    pub fn cancel(&mut self) -> Result<(), WorkerError> {
        let msg = json!({"method": "cancel", "params": {}});
        self.write_msg(&msg)
    }

    /// Request with a watchdog: on deadline the worker is killed and the
    /// read fails typed. The worker can never outlive its deadline while
    /// holding the caller.
    fn request(&mut self, method: &str, params: Value) -> Result<Value, WorkerError> {
        let request_id = self.next_id;
        self.next_id += 1;
        let msg = json!({"id": request_id, "method": method, "params": params});
        self.write_msg(&msg)?;

        let watchdog_fired = Arc::new(AtomicBool::new(false));
        let child = Arc::clone(&self.group.child);
        let secs = RENDER_TIMEOUT_SECS;
        let watchdog_flag = Arc::clone(&watchdog_fired);
        std::thread::spawn(move || {
            for _ in 0..secs {
                if watchdog_flag.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            watchdog_flag.store(true, Ordering::Relaxed);
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
            }
        });
        let result = self.read_response(request_id);
        // Retire the watchdog: without this, a completed request still kept
        // its watchdog thread sleeping until the full deadline. The flag is
        // also what classifies a transport failure after a kill as deadline.
        watchdog_fired.store(true, Ordering::Relaxed);
        // Detach the watchdog: it exits on its own flag once the response
        // arrives; joining here would block fast callers for the full
        // deadline. The deadline classification uses the watchdog flag, not
        // the join.
        match result {
            Ok(v) => Ok(v),
            Err(WorkerError::Transport(_)) if watchdog_fired.load(Ordering::Relaxed) => {
                Err(WorkerError::Deadline(RENDER_TIMEOUT_SECS))
            }
            Err(other) => Err(other),
        }
    }

    /// Handshake: identify the daemon and confirm the installed pack list.
    pub fn initialize(&mut self, packs: &[&str]) -> Result<(), WorkerError> {
        let result = self.request(
            "initialize",
            json!({
                "client": {"name": "knorvia-daemon", "version": env!("CARGO_PKG_VERSION")},
                "packs": packs,
            }),
        )?;
        if result.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Err(WorkerError::Failed(format!(
                "worker initialize rejected: {result}"
            )));
        }
        Ok(())
    }

    /// Render one pack artifact. Returns (mime, title, bytes).
    pub fn render(
        &mut self,
        pack_id: &str,
        input: &Value,
    ) -> Result<(String, String, Vec<u8>), WorkerError> {
        let result = self.request("render", json!({"packId": pack_id, "input": input}))?;
        let mime = result
            .get("mime")
            .and_then(|m| m.as_str())
            .ok_or_else(|| WorkerError::Failed("worker response missing mime".into()))?
            .to_string();
        let title = result
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or("artifact")
            .to_string();
        let content_b64 = result
            .get("contentBase64")
            .and_then(|c| c.as_str())
            .ok_or_else(|| WorkerError::Failed("worker response missing contentBase64".into()))?;
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(content_b64)
            .map_err(|e| WorkerError::Failed(format!("worker contentBase64 invalid: {e}")))?;
        Ok((mime, title, bytes))
    }
}

impl Drop for PackWorkerClient {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Convenience: one render per client lifecycle (the daemon's invoke path).
pub fn render_via_worker(
    pack_id: &str,
    input: &Value,
) -> Result<(String, String, Vec<u8>), WorkerError> {
    let bin = resolve_worker_bin()?;
    let mut client = PackWorkerClient::spawn(&bin)?;
    client.initialize(&[pack_id])?;
    client.render(pack_id, input)
}

/// Worker-side request loop (used by the `knorvia-pack-worker` binary).
pub fn serve_worker<W: Write>(
    render: impl Fn(&str, &Value) -> Result<(String, String, Vec<u8>), String>,
    mut input: impl std::io::BufRead,
    mut output: W,
) -> Result<(), ProtocolError> {
    let cancelled = Arc::new(AtomicBool::new(false));
    loop {
        let body = match read_frame(&mut input) {
            Ok(b) => b,
            Err(knorvia_protocol::WireError::Io(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(e) => {
                return Err(ProtocolError::new(
                    knorvia_protocol::ErrorCategory::InvalidArgument,
                    e.to_string(),
                ));
            }
        };
        let cancelled = Arc::clone(&cancelled);
        let v: Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Notifications (no id): cancel sets the cooperative flag; anything
        // else is ignored by the worker loop.
        let Some(id) = v.get("id") else {
            if v.get("method").and_then(|m| m.as_str()) == Some("cancel") {
                cancelled.store(true, Ordering::SeqCst);
            }
            continue;
        };
        let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let response = match method {
            "initialize" => json!({"id": id, "result": {"ok": true}}),
            "render" => {
                let pack_id = v
                    .pointer("/params/packId")
                    .and_then(|p| p.as_str())
                    .unwrap_or("");
                let input = v.pointer("/params/input").cloned().unwrap_or(json!({}));
                let mut emit = |step: &str| {
                    let note = json!({
                        "method": "progress",
                        "params": {"packId": pack_id, "step": step},
                    });
                    let _ = write_frame(&mut output, &serde_json::to_string(&note).expect("json"));
                    let _ = output.flush();
                };
                emit("render.start");
                // Cooperative cancel: answer the render with the typed
                // cancelled error and stop the loop (nothing was rendered, so
                // no side effects exist to clean up).
                if cancelled.load(Ordering::SeqCst) {
                    let out = json!({
                        "id": id,
                        "error": {"code": -32030, "message": "cancelled by user"},
                    });
                    write_frame(&mut output, &serde_json::to_string(&out).expect("json")).map_err(
                        |e| {
                            ProtocolError::new(
                                knorvia_protocol::ErrorCategory::Internal,
                                e.to_string(),
                            )
                        },
                    )?;
                    return Ok(());
                }
                let outcome = render(pack_id, &input);
                if cancelled.load(Ordering::SeqCst) {
                    let out = json!({
                        "id": id,
                        "error": {"code": -32030, "message": "cancelled by user"},
                    });
                    write_frame(&mut output, &serde_json::to_string(&out).expect("json")).map_err(
                        |e| {
                            ProtocolError::new(
                                knorvia_protocol::ErrorCategory::Internal,
                                e.to_string(),
                            )
                        },
                    )?;
                    return Ok(());
                }
                emit("render.done");
                match outcome {
                    Ok((mime, title, bytes)) => {
                        use base64::Engine as _;
                        json!({
                            "id": id,
                            "result": {
                                "mime": mime,
                                "title": title,
                                "contentBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
                            }
                        })
                    }
                    Err(message) => json!({
                        "id": id,
                        "error": {"code": -32000, "message": message},
                    }),
                }
            }
            "shutdown" => {
                let out = json!({"id": id, "result": {"ok": true}});
                write_frame(&mut output, &serde_json::to_string(&out).expect("json")).map_err(
                    |e| {
                        ProtocolError::new(knorvia_protocol::ErrorCategory::Internal, e.to_string())
                    },
                )?;
                return Ok(());
            }
            other => json!({
                "id": id,
                "error": {"code": -32601, "message": format!("unknown worker method {other}")},
            }),
        };
        write_frame(
            &mut output,
            &serde_json::to_string(&response).expect("json"),
        )
        .map_err(|e| {
            ProtocolError::new(knorvia_protocol::ErrorCategory::Internal, e.to_string())
        })?;
    }
    Ok(())
}

/// Sentinel error for a cooperatively cancelled render.
#[derive(Debug, thiserror::Error)]
#[error("cancelled by user")]
pub struct WorkerCancelled;

impl From<WorkerCancelled> for ProtocolError {
    fn from(value: WorkerCancelled) -> Self {
        ProtocolError::new(
            knorvia_protocol::ErrorCategory::Cancelled,
            value.to_string(),
        )
    }
}
