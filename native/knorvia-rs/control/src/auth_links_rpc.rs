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
    AuthConnectOp, AuthDetectorFacts, AuthLinkStore, redact,
};
use sha2::{Digest, Sha256};
use std::hash::{BuildHasher, Hash, Hasher};
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

/// PKCE pair for the public-client flow. Entropy mixes several
/// `RandomState` hashers (OS-entropy seeds) with time, pid and a process
/// counter through SHA-256 — std-only, no new dependencies this shift.
fn make_pkce() -> (String, String) {
    let at = knorvia_store::auth_links::now_ms();
    let mut seed = Vec::new();
    for _ in 0..4 {
        let mut hasher_state = std::collections::hash_map::RandomState::new();
        let mut hasher = hasher_state.build_hasher();
        at.hash(&mut hasher);
        std::process::id().hash(&mut hasher);
        std::thread::current().id().hash(&mut hasher);
        seed.extend_from_slice(&hasher.finish().to_le_bytes());
    }
    let digest: [u8; 32] = Sha256::digest(&seed).into();
    let verifier = b64url(&digest);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
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

/// One CLI detection probe: argument arrays, no shell, bounded wait.
fn run_cli(args: &[&str], deadline_ms: u64) -> Result<Option<(bool, String)>, String> {
    use std::io::Read;
    use std::process::Command;
    let (program, rest) = args.split_first().ok_or("no command")?;
    let mut child = None;
    let mut attempted = String::new();
    for candidate in spawn_candidates(program) {
        match Command::new(&candidate)
            .args(rest)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(spawned) => {
                child = Some(spawned);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                attempted.push_str(&candidate);
                attempted.push(' ');
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let mut child = child.ok_or_else(|| format!("not found: {attempted}"))?;
    let started = knorvia_store::auth_links::now_ms();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                let mut text = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_string(&mut text);
                }
                if let Some(mut err) = child.stderr.take() {
                    let _ = err.read_to_string(&mut text);
                }
                return Ok(Some((status.success(), text)));
            }
            None => {
                if knorvia_store::auth_links::now_ms() - started > deadline_ms {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(None);
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
    }
}

/// Capability facts a detector reports. Only booleans actually observed
/// are set; absent facts stay absent so status stays honest.
pub trait AuthDetector: Send + Sync {
    fn detect(&self, link_id: &str) -> AuthDetectorFacts;
}

/// Real detection against CLIs already installed on this machine.
pub struct CliAuthDetector;

impl AuthDetector for CliAuthDetector {
    fn detect(&self, link_id: &str) -> AuthDetectorFacts {
        let mut facts = AuthDetectorFacts::default();
        match link_id {
            "codex" => {
                match run_cli(&["codex", "login", "status"], 4_000) {
                    Ok(Some((true, text))) => {
                        facts.installed = Some(true);
                        facts.authenticated = Some(text.contains("Logged in"));
                        facts.detail = Some(redact(text.lines().next().unwrap_or("")));
                    }
                    Ok(Some((false, text))) => {
                        facts.installed = Some(true);
                        facts.detail = Some(redact(text.lines().next().unwrap_or("codex login status failed")));
                    }
                    Ok(None) => facts.detail = Some("codex login status timed out".into()),
                    Err(_) => facts.installed = Some(false),
                }
            }
            "claude-cli" => {
                match run_cli(&["claude", "auth", "status"], 4_000) {
                    Ok(Some((true, text))) => {
                        facts.installed = Some(true);
                        facts.authenticated = Some(!text.to_lowercase().contains("not logged in"));
                        facts.detail = Some(redact(text.lines().next().unwrap_or("")));
                    }
                    Ok(Some((false, text))) => {
                        facts.installed = Some(true);
                        facts.detail = Some(redact(text.lines().next().unwrap_or("claude auth status failed")));
                    }
                    Ok(None) => facts.detail = Some("claude auth status timed out".into()),
                    Err(_) => facts.installed = Some(false),
                }
            }
            "grok-cli" => {
                match run_cli(&["grok", "--version"], 4_000) {
                    Ok(Some((true, text))) => {
                        facts.installed = Some(true);
                        facts.version = Some(redact(text.lines().next().unwrap_or("")).chars().take(64).collect());
                        // No public subscription->API bridge is documented:
                        // authentication stays unknown rather than assumed.
                    }
                    Ok(Some((false, _))) => facts.installed = Some(true),
                    Ok(None) | Err(_) => facts.installed = Some(false),
                }
            }
            _ => {}
        }
        facts
    }
}

static AUTH_DETECTOR: OnceLock<std::sync::RwLock<std::sync::Arc<dyn AuthDetector>>> = OnceLock::new();

/// Refresh single-flight (C12): detections spawn processes, so concurrent
/// refreshes serialize instead of racing the same CLI probes.
static REFRESH_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();

fn detector() -> std::sync::Arc<dyn AuthDetector> {
    AUTH_DETECTOR
        .get_or_init(|| std::sync::RwLock::new(std::sync::Arc::new(CliAuthDetector)))
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| std::sync::Arc::new(CliAuthDetector))
}

/// Tests install a fixture detector here; production keeps the CLI one.
pub fn set_auth_detector(detector: std::sync::Arc<dyn AuthDetector>) {
    let slot = AUTH_DETECTOR.get_or_init(|| std::sync::RwLock::new(std::sync::Arc::new(CliAuthDetector) as std::sync::Arc<dyn AuthDetector>));
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
        for record in store.list_links().map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))? {
            let live = store
                .live_op(&record.id)
                .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?
                .map(|op| op_public(&op));
            links.push(json!({ "link": record, "liveOp": live }));
        }
        Ok(json!({ "links": links }))
    }

    /// Re-detect one (or all) links. The caller decides what to do with
    /// the honest result — refresh never fabricates a login.
    pub(crate) fn rpc_auth_link_refresh(&self, params: &Value) -> Result<Value, ProtocolError> {
        let store = self.auth_links();
        ensure_catalog(&store)?;
        let only = params["id"].as_str();
        let _refresh_guard = REFRESH_LOCK
            .get_or_init(std::sync::Mutex::default)
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let mut refreshed = Vec::new();
        for record in store.list_links().map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))? {
            if only.is_some_and(|id| id != record.id) {
                continue;
            }
            let facts = detector().detect(&record.id);
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
            // Quota facts stay as configured by the catalog: a ChatGPT or
            // Claude CLI login is subscription-backed; unknown stays unknown.
            let updated = store
                .apply_detection(&record.id, None, capabilities, None, facts.detail.as_deref())
                .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
            refreshed.push(json!({ "link": updated }));
        }
        Ok(json!({ "refreshed": refreshed }))
    }

    /// Start the Codex public login: assemble the PKCE authorize URL and
    /// register a single-flight op. The user finishes the real login.
    pub(crate) fn rpc_auth_link_connect_start(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = params["id"].as_str().unwrap_or("codex");
        let store = self.auth_links();
        ensure_catalog(&store)?;
        let record = store
            .read_link(id)
            .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?
            .ok_or_else(|| ProtocolError::new(ErrorCategory::NotFound, format!("auth link {id} not found")))?;
        if record.kind != "oauth" {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                format!("auth link {id} is a CLI link: its login belongs to the installed CLI, not a browser flow"),
            ));
        }
        let (verifier, challenge) = make_pkce();
        let state = b64url(&Sha256::digest(format!("{verifier}|state").as_bytes()));
        let url = codex_authorize_url(&state, &challenge);
        let op = store
            .connect_start(id, &url, Some(CODEX_REDIRECT_PORT), Some(state), Some(verifier), LOGIN_TTL_MS)
            .map_err(|e| ProtocolError::new(ErrorCategory::Conflict, e.to_string()))?;
        Ok(json!({ "op": op_public(&op) }))
    }

    pub(crate) fn rpc_auth_link_connect_cancel(&self, params: &Value) -> Result<Value, ProtocolError> {
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

    /// Disconnect clears the local connection record. It cannot and does
    /// not log the user out of any independently installed CLI.
    pub(crate) fn rpc_auth_link_disconnect(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = params["id"].as_str().ok_or_else(|| invalid("auth link id is required"))?;
        let store = self.auth_links();
        let record = store
            .disconnect(id, params["expectedRevision"].as_u64())
            .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
        Ok(json!({ "link": record }))
    }
}

#[cfg(test)]
mod auth_links_rpc_tests {
    use super::*;
    use std::sync::Mutex;

    struct FixtureDetector {
        facts: Mutex<std::collections::HashMap<String, AuthDetectorFacts>>,
    }

    impl AuthDetector for FixtureDetector {
        fn detect(&self, link_id: &str) -> AuthDetectorFacts {
            self.facts.lock().unwrap().get(link_id).cloned().unwrap_or_default()
        }
    }

    fn install(facts: Vec<(&str, AuthDetectorFacts)>) {
        let map: std::collections::HashMap<String, AuthDetectorFacts> = facts
            .into_iter()
            .map(|(id, value)| (id.to_string(), value))
            .collect();
        set_auth_detector(std::sync::Arc::new(FixtureDetector { facts: Mutex::new(map) }));
    }

    #[test]
    fn catalog_lists_honest_defaults_with_quota_types() {
        let plane = crate::tests::plane();
        let result = plane.rpc_auth_link_list(&json!({})).unwrap();
        let links = result["links"].as_array().unwrap();
        assert_eq!(links.len(), 3);
        let codex = links.iter().find(|l| l["link"]["id"] == json!("codex")).unwrap();
        assert_eq!(codex["link"]["status"], json!("disconnected"));
        assert_eq!(codex["link"]["quotaType"], json!("subscription"));
        let grok = links.iter().find(|l| l["link"]["id"] == json!("grok-cli")).unwrap();
        assert_eq!(grok["link"]["quotaType"], json!("unknown"), "undocumented quota stays unknown");
    }

    #[test]
    fn refresh_reflects_detector_truth_not_wishes() {
        let plane = crate::tests::plane();
        let mut claude = AuthDetectorFacts::default();
        claude.installed = Some(false);
        let mut codex = AuthDetectorFacts::default();
        codex.installed = Some(true);
        codex.authenticated = Some(true);
        codex.detail = Some("Logged in using ChatGPT".into());
        install(vec![("claude-cli", claude), ("codex", codex)]);

        let result = plane.rpc_auth_link_refresh(&json!({ "id": "claude-cli" })).unwrap();
        assert_eq!(result["refreshed"][0]["link"]["status"], json!("error"));
        assert!(result["refreshed"][0]["link"]["detail"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("not installed"));

        plane.rpc_auth_link_refresh(&json!({ "id": "codex" })).unwrap();
        let list = plane.rpc_auth_link_list(&json!({})).unwrap();
        let codex = list["links"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["link"]["id"] == json!("codex"))
            .unwrap();
        assert_eq!(codex["link"]["status"], json!("connected"));
        assert_eq!(codex["link"]["quotaType"], json!("subscription"), "Codex login stays subscription-labeled");
    }

    #[test]
    fn connect_start_builds_public_pkce_url_and_is_single_flight() {
        let plane = crate::tests::plane();
        let result = plane.rpc_auth_link_connect_start(&json!({ "id": "codex" })).unwrap();
        let url = result["op"]["authorizeUrl"].as_str().unwrap();
        assert!(url.starts_with("https://auth.openai.com/oauth/authorize"));
        assert!(url.contains("client_id=app_EMoamEEZ73f0CkXaXp7hrann"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A1455"));
        assert_eq!(result["op"]["state"], json!("waiting"));
        assert!(result["op"].get("pkceVerifier").is_none(), "PKCE verifier never leaves the server");
        // single flight
        assert!(plane.rpc_auth_link_connect_start(&json!({ "id": "codex" })).is_err());
        // CLI links have no browser flow
        assert_eq!(
            plane.rpc_auth_link_connect_start(&json!({ "id": "claude-cli" })).unwrap_err().category,
            ErrorCategory::InvalidArgument
        );
        // cancel returns to a clear state
        let cancelled = plane.rpc_auth_link_connect_cancel(&json!({ "id": "codex" })).unwrap();
        assert_eq!(cancelled["cancelled"], json!(true));
        let list = plane.rpc_auth_link_list(&json!({})).unwrap();
        let codex = list["links"].as_array().unwrap().iter().find(|l| l["link"]["id"] == json!("codex")).unwrap();
        assert_eq!(codex["link"]["status"], json!("disconnected"));
        assert!(codex["liveOp"].is_null());
    }
}
