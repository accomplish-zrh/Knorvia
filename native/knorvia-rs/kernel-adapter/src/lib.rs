//! Talk to the in-tree Kernel App Server over JSONL.
//!
//! The binary is resolved from `KNORVIA_KERNEL_BIN`, a sibling of the current
//! executable, or the pinned repo checkout (`codex-rs/target/<profile>`).
//! PATH is never searched for `codex`.
//!
//! This adapter is the normalization boundary between the pinned upstream
//! App Server protocol and Knorvia Protocol items: `run_turn` returns typed
//! `KernelTurnItem`s and never fabricates a successful turn. Sandbox policy
//! and approval policy are per-turn; approval server requests are surfaced to
//! the caller through `TurnRunOptions.on_approval` and mapped to
//! accept/decline decisions on the Kernel wire.

use knorvia_platform_paths::KnorviaPaths;
use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod harness;
mod transport;

pub use transport::TaskLag;

#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    #[error("kernel request timed out")]
    RequestTimeout,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Msg(String),
}

pub const KERNEL_BIN_ENV: &str = "KNORVIA_KERNEL_BIN";
pub const PROVIDER_MODEL_ENV: &str = "KNORVIA_PROVIDER_MODEL";
pub const PROVIDER_BASE_URL_ENV: &str = "KNORVIA_PROVIDER_BASE_URL";
pub const PROVIDER_API_KEY_ENV: &str = "KNORVIA_PROVIDER_API_KEY";
/// Upstream wire protocol override. `responses` (default) points the Kernel
/// straight at the upstream; `chat` and `anthropic` start a loopback bridge
/// that speaks Responses to the Kernel and translates to the upstream.
pub const PROVIDER_PROTOCOL_ENV: &str = "KNORVIA_PROVIDER_PROTOCOL";
/// Environment variable the Kernel reads its bridge bearer token from when a
/// protocol bridge is active.
pub const BRIDGE_TOKEN_ENV: &str = "KNORVIA_BRIDGE_TOKEN";
pub const TURN_TIMEOUT_ENV: &str = "KNORVIA_KERNEL_TURN_TIMEOUT_SECS";
pub const DEFAULT_TURN_TIMEOUT_SECS: u64 = 600;

fn kernel_bin_name() -> &'static str {
    if cfg!(windows) {
        "codex-app-server.exe"
    } else {
        "codex-app-server"
    }
}

pub fn resolve_kernel_bin() -> Result<PathBuf, AdapterError> {
    if let Some(p) = std::env::var_os(KERNEL_BIN_ENV) {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Ok(path);
        }
        return Err(AdapterError::Msg(format!(
            "{KERNEL_BIN_ENV} not a file: {}",
            path.display()
        )));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in [
                "knorvia-kernel-appserver.exe",
                "codex-app-server.exe",
                "knorvia-kernel-appserver",
                "codex-app-server",
            ] {
                let cand = dir.join(name);
                if cand.is_file() {
                    return Ok(cand);
                }
            }
            // Repo-relative probe (dev checkout): walk up to the repo root and
            // look for the pinned upstream build outputs.
            let mut dir: Option<&Path> = exe.parent();
            for _ in 0..5 {
                let Some(d) = dir else { break };
                for profile in ["release", "debug"] {
                    let cand = d
                        .join("codex-rs")
                        .join("target")
                        .join(profile)
                        .join(kernel_bin_name());
                    if cand.is_file() {
                        return Ok(cand);
                    }
                }
                dir = d.parent();
            }
        }
    }
    Err(AdapterError::Msg(format!(
        "no in-tree kernel binary; set {KERNEL_BIN_ENV} (do not use PATH `codex`)"
    )))
}

/// Returns true if `bin` is the user-installed npm `codex` shim — forbidden.
pub fn is_user_codex_shim(bin: &Path) -> bool {
    let s = bin.to_string_lossy().to_lowercase();
    s.contains("node_modules") && s.contains("codex")
}

/// Provider settings the daemon forwards into the Kernel store config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderEnv {
    pub model: String,
    pub base_url: Option<String>,
    pub api_key_env: String,
}

/// The provider endpoint the Kernel should be configured against, after any
/// protocol bridge was started. `bridge` is held by the caller for the
/// lifetime of the daemon session.
pub struct PreparedProvider {
    pub model: String,
    pub kernel_base_url: String,
    pub kernel_api_key_env: String,
    pub bridge: Option<knorvia_provider_gateway::BridgeServer>,
    /// Value injected into the Kernel process environment for
    /// [`Self::kernel_api_key_env`] at spawn time (bridge bearer token).
    pub bridge_token: Option<String>,
}

/// Resolve the provider endpoint for the Kernel. A non-Responses upstream
/// protocol starts a loopback bridge (bearer-token protected, random port)
/// and points the Kernel at it; the Responses protocol keeps pointing the
/// Kernel straight at the upstream exactly as before.
pub fn prepare_provider(provider: &ProviderEnv) -> Result<PreparedProvider, AdapterError> {
    let raw = std::env::var(PROVIDER_PROTOCOL_ENV)
        .or_else(|_| std::env::var("KNORVIA_PROVIDER_UPSTREAM_PROTOCOL"))
        .unwrap_or_else(|_| "responses".into());
    let protocol = knorvia_provider_gateway::UpstreamProtocol::from_config(&raw)
        .ok_or_else(|| AdapterError::Msg("Unsupported provider protocol".into()))?;
    match protocol {
        knorvia_provider_gateway::UpstreamProtocol::Responses => {
            let base_url = provider
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
            Ok(PreparedProvider {
                model: provider.model.clone(),
                kernel_base_url: base_url,
                kernel_api_key_env: provider.api_key_env.clone(),
                bridge: None,
                bridge_token: None,
            })
        }
        protocol => {
            let upstream = provider.base_url.clone().ok_or_else(|| {
                AdapterError::Msg(
                    "a non-Responses upstream protocol requires KNORVIA_PROVIDER_BASE_URL".into(),
                )
            })?;
            let api_key = std::env::var(&provider.api_key_env).unwrap_or_default();
            let mut bridge = knorvia_provider_gateway::spawn_responses_bridge(
                protocol, upstream, api_key, None,
            )?;
            let token = bridge.auth_token.clone();
            let kernel_base_url = format!("http://{}/v1", bridge.address);
            Ok(PreparedProvider {
                model: provider.model.clone(),
                kernel_base_url,
                kernel_api_key_env: BRIDGE_TOKEN_ENV.into(),
                bridge: Some(bridge),
                bridge_token: Some(token),
            })
        }
    }
}

/// Read the Knorvia provider gateway settings from the environment.
/// `KNORVIA_PROVIDER_MODEL` must be set; base URL and key are optional
/// (a missing base URL keeps the Kernel's built-in default provider).
pub fn provider_from_env() -> Option<ProviderEnv> {
    let model = std::env::var(PROVIDER_MODEL_ENV).ok()?;
    let model = model.trim().to_string();
    if model.is_empty() {
        return None;
    }
    Some(ProviderEnv {
        model,
        base_url: std::env::var(PROVIDER_BASE_URL_ENV)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        api_key_env: PROVIDER_API_KEY_ENV.into(),
    })
}

/// Strictly parse a Studio MCP endpoint. Only
/// `http://127.0.0.1:<nonzero-numeric-port>/mcp` is accepted — no userinfo,
/// query, fragment, extra path segments or alternative hosts — so the scope
/// token can never be redirected to another origin.
pub fn parse_studio_mcp_url(raw: &str) -> Option<String> {
    let rest = raw.strip_prefix("http://")?;
    if rest.contains('@') || rest.contains('?') || rest.contains('#') {
        return None;
    }
    let (authority, path) = rest.split_once('/')?;
    if path != "mcp" {
        return None;
    }
    let (host, port) = authority.rsplit_once(':')?;
    if host != "127.0.0.1" {
        return None;
    }
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    if port == 0 {
        return None;
    }
    Some(raw.to_string())
}

/// Pure builder for the Knorvia Kernel store `config.toml`. `base_url` None
/// keeps the Kernel's built-in default provider (no provider section). The
/// API key itself is never serialized: the Kernel reads it from the
/// environment via `env_key`.
fn render_kernel_config(
    model: &str,
    base_url: Option<&str>,
    api_key_env: &str,
    mcp_url: Option<&str>,
) -> Result<String, AdapterError> {
    let mut toml = format!("model = \"{model}\"\n");
    if let Some(base_url) = base_url {
        toml.push_str(&format!(
            "model_provider = \"knorvia\"\n\n\
             [model_providers.knorvia]\n\
             name = \"Knorvia Provider Gateway\"\n\
             base_url = \"{base_url}\"\n\
             env_key = \"{api_key_env}\"\n\
             wire_api = \"responses\"\n"
        ));
    }
    // The Kernel's multi-agent collaboration tools are part of the Knorvia
    // product surface. The upstream default did not resolve to enabled in our
    // fixtures (managed feature config is disabled for the private Kernel),
    // so the product opts in explicitly here instead of relying on ambient
    // feature defaults.
    toml.push_str("\n[features]\nmulti_agent = true\n");
    // Optional native media worker, scoped to this Knorvia Home. The bearer
    // token is inherited by the Kernel and never serialized in configuration.
    if let Some(url) = mcp_url {
        let quoted = serde_json::to_string(url).map_err(|e| AdapterError::Msg(e.to_string()))?;
        toml.push_str(&format!("\n[mcp_servers.knorvia_media]\nurl = {quoted}\nbearer_token_env_var = \"KNORVIA_STUDIO_MCP_TOKEN\"\n"));
    }
    Ok(toml)
}

/// Remove the `[mcp_servers.knorvia_media]` section this adapter owns,
/// leaving every other section byte-identical.
fn strip_studio_mcp_section(content: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in content.lines() {
        if line.trim_start().starts_with('[') {
            skipping = line.trim_start().starts_with("[mcp_servers.knorvia_media]");
        }
        if !skipping {
            kept.push(line);
        }
    }
    let mut result = kept.join("\n");
    // Blank lines that only separated the removed section must not survive it.
    let result = result.trim_end_matches('\n');
    if !result.is_empty() {
        return format!("{result}\n");
    }
    result.to_string()
}

/// Idempotently add or remove only the `[mcp_servers.knorvia_media]` section,
/// preserving unrelated Kernel configuration.
fn ensure_studio_mcp_section(
    paths: &KnorviaPaths,
    mcp_url: Option<&str>,
) -> Result<(), AdapterError> {
    paths.ensure_layout()?;
    let path = paths.kernel_store.join("config.toml");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    if mcp_url.is_none() && !existing.contains("[mcp_servers.knorvia_media]") {
        return Ok(());
    }
    let section = match mcp_url {
        Some(url) => {
            let quoted =
                serde_json::to_string(url).map_err(|e| AdapterError::Msg(e.to_string()))?;
            format!(
                "\n[mcp_servers.knorvia_media]\nurl = {quoted}\nbearer_token_env_var = \"KNORVIA_STUDIO_MCP_TOKEN\"\n"
            )
        }
        None => String::new(),
    };
    let updated = format!("{}{}", strip_studio_mcp_section(&existing), section);
    if updated != existing {
        fs::write(&path, updated)?;
    }
    Ok(())
}

/// Write (idempotently) the Kernel store `config.toml` for a gateway provider.
/// The Studio MCP endpoint registers independently of the chat provider, so a
/// default-provider setup (no `base_url`) still exposes the media tools; in
/// that case unrelated configuration in the file is preserved.
/// Write the Kernel store config against an already-prepared provider
/// (bridge included). Non-Responses upstreams land here after
/// [`prepare_provider`] started their loopback bridge.
pub fn ensure_kernel_config_prepared(
    paths: &KnorviaPaths,
    prepared: &PreparedProvider,
) -> Result<(), AdapterError> {
    let mcp = std::env::var("KNORVIA_STUDIO_MCP_URL")
        .ok()
        .and_then(|raw| parse_studio_mcp_url(&raw));
    let toml = render_kernel_config(
        &prepared.model,
        Some(&prepared.kernel_base_url),
        &prepared.kernel_api_key_env,
        mcp.as_deref(),
    )?;
    paths.ensure_layout()?;
    let path = paths.kernel_store.join("config.toml");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    if existing != toml {
        fs::write(&path, toml)?;
    }
    Ok(())
}

pub fn ensure_kernel_config(
    paths: &KnorviaPaths,
    provider: &ProviderEnv,
) -> Result<(), AdapterError> {
    let mcp = std::env::var("KNORVIA_STUDIO_MCP_URL")
        .ok()
        .and_then(|raw| parse_studio_mcp_url(&raw));
    let Some(base_url) = &provider.base_url else {
        return ensure_studio_mcp_section(paths, mcp.as_deref());
    };
    let toml = render_kernel_config(
        &provider.model,
        Some(base_url),
        &provider.api_key_env,
        mcp.as_deref(),
    )?;
    paths.ensure_layout()?;
    let path = paths.kernel_store.join("config.toml");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    if existing != toml {
        fs::write(&path, toml)?;
    }
    Ok(())
}

/// One normalized Kernel item, ready for the product store.
#[derive(Debug, Clone, PartialEq)]
pub struct KernelTurnItem {
    pub kind: String,
    pub payload: Value,
}

/// Terminal result of one Kernel turn.
#[derive(Debug, Clone, PartialEq)]
#[derive(Default)]
pub struct KernelTurnResult {
    /// `completed` | `failed` | `interrupted`
    pub status: String,
    pub error: Option<Value>,
    pub items: Vec<KernelTurnItem>,
    /// Server requests (approvals/user input) that this adapter declined or
    /// resolved without a caller decision.
    pub declined_requests: u32,
    /// Approvals surfaced to the caller (accepted or declined).
    pub surfaced_approvals: u32,
    /// This turn's own deadline fired before the Kernel reported its
    /// terminal. A diagnostic fact only: it never rewrites the terminal
    /// the Kernel reported.
    pub deadline_exceeded: bool,
}

/// A Kernel approval server request, normalized for the product approval
/// bridge. `action` is a stable Knorvia action id (`kernel.commandExecution`,
/// `kernel.fileChange`, `kernel.permissions`); `payload` carries the
/// provider-normalized request fields the product store records.
#[derive(Debug, Clone, PartialEq)]
pub struct KernelApprovalRequest {
    pub kind: String,
    pub action: String,
    pub payload: Value,
}

/// A native `request_user_input` request from the Kernel. The response must
/// use the upstream `{ "answers": { questionId: { "answers": [...] } } }`
/// shape so it can be sent back without lossy translation.
#[derive(Debug, Clone, PartialEq)]
pub struct KernelUserInputRequest {
    pub payload: Value,
}

/// Product-selected settings that map directly to supported upstream
/// thread/turn parameters. The adapter forwards values unchanged instead of
/// maintaining a second model catalog.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KernelThreadSettings {
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub collaboration_mode: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnDecision {
    Accept,
    Decline,
}

impl TurnDecision {
    fn wire(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Decline => "decline",
        }
    }
}

/// Per-turn execution options. Sandbox and approval policy are per-turn:
/// read-only turns run `{"type":"readOnly"}` + `never`; write turns run
/// `{"type":"workspaceWrite"}` + `on-request` with approvals bridged to the
/// product approval store.
pub struct TurnRunOptions {
    pub sandbox: Value,
    pub approval_policy: &'static str,
    /// Explicit per-turn selection. All fields map to real App Server
    /// parameters; unsupported values are rejected by the Kernel.
    pub settings: KernelThreadSettings,
    /// Called for each Kernel approval server request. `None` declines every
    /// approval (safe read-only behavior).
    pub on_approval: Option<Box<dyn FnMut(&KernelApprovalRequest) -> TurnDecision + Send>>,
    /// Called for each completed item as it arrives (live streaming hook).
    pub on_item: Option<Box<dyn FnMut(&KernelTurnItem) + Send>>,
    /// Called for each streamed text delta (`item/agentMessage/delta`).
    /// Deltas are transient assembly state; the completed item is the record.
    pub on_delta: Option<Box<dyn FnMut(&str, &str) + Send>>,
    /// Provisional tool activity. Completed items remain the durable record.
    pub on_progress: Option<Box<dyn FnMut(&str, &Value) + Send>>,
    /// Called once with the Kernel turn id when the turn starts.
    pub on_turn_started: Option<Box<dyn FnMut(&str) + Send>>,
    /// Called for an upstream `item/tool/requestUserInput` request. The
    /// returned value is forwarded as that request's `result` object.
    pub on_user_input: Option<Box<dyn FnMut(&KernelUserInputRequest) -> Value + Send>>,
}

impl TurnRunOptions {
    pub fn read_only() -> Self {
        Self {
            sandbox: json!({"type": "readOnly"}),
            approval_policy: "never",
            settings: KernelThreadSettings::default(),
            on_approval: None,
            on_item: None,
            on_delta: None,
            on_progress: None,
            on_turn_started: None,
            on_user_input: None,
        }
    }

    pub fn workspace_write() -> Self {
        Self {
            sandbox: json!({"type": "workspaceWrite"}),
            approval_policy: "on-request",
            settings: KernelThreadSettings::default(),
            on_approval: None,
            on_item: None,
            on_delta: None,
            on_progress: None,
            on_turn_started: None,
            on_user_input: None,
        }
    }
}

/// Map a raw upstream `ThreadItem` JSON to a typed Knorvia item.
/// Unknown kinds are passed through with their full payload — never dropped.
pub fn normalize_item(item: &Value) -> KernelTurnItem {
    let kind = item
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let (kind, payload) = match kind {
        "agentMessage" => (
            "agentMessage",
            json!({
                "text": item.get("text").cloned().unwrap_or(Value::Null),
                "phase": item.get("phase").cloned().unwrap_or(Value::Null),
            }),
        ),
        "reasoning" => (
            "reasoning",
            json!({
                "summary": item.get("summary").cloned().unwrap_or(json!([])),
                "content": item.get("content").cloned().unwrap_or(json!([])),
            }),
        ),
        "commandExecution" => (
            "commandExecution",
            json!({
                "command": item.get("command").cloned().unwrap_or(Value::Null),
                "status": item.get("status").cloned().unwrap_or(Value::Null),
                "aggregatedOutput": item.get("aggregatedOutput").cloned().unwrap_or(Value::Null),
                "exitCode": item.get("exitCode").cloned().unwrap_or(Value::Null),
                "durationMs": item.get("durationMs").cloned().unwrap_or(Value::Null),
            }),
        ),
        "fileChange" => (
            "fileChange",
            json!({
                "changes": item.get("changes").cloned().unwrap_or(json!([])),
                "status": item.get("status").cloned().unwrap_or(Value::Null),
            }),
        ),
        "mcpToolCall" => (
            "mcpToolCall",
            json!({
                "server": item.get("server").cloned().unwrap_or(Value::Null),
                "tool": item.get("tool").cloned().unwrap_or(Value::Null),
                "status": item.get("status").cloned().unwrap_or(Value::Null),
            }),
        ),
        other => (other, item.clone()),
    };
    let mut payload = payload;
    if let (Some(object), Some(id)) = (payload.as_object_mut(), item.get("id")) {
        object.insert("kernelItemId".into(), id.clone());
    }
    KernelTurnItem {
        kind: kind.to_string(),
        payload,
    }
}

fn turn_timeout_secs() -> u64 {
    std::env::var(TURN_TIMEOUT_ENV)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_TURN_TIMEOUT_SECS)
}

fn denial_response(id: &Value, message: &str) -> Value {
    json!({
        "id": id,
        "error": {
            "code": -32601,
            "message": message,
        }
    })
}

fn approval_response(id: &Value, decision: TurnDecision) -> Value {
    json!({
        "id": id,
        "result": {
            "decision": decision.wire(),
        }
    })
}

fn approval_response_for(id: &Value, decision: TurnDecision, method: &str) -> Value {
    // MCP elicitation answers use the elicitation action/content shape; an
    // accept with no content is an approval of the tool call.
    if method == MCP_ELICITATION_METHOD {
        return json!({
            "id": id,
            "result": {
                "action": decision.wire(),
                "content": Value::Null,
            }
        });
    }
    approval_response(id, decision)
}

fn user_input_response(id: &Value, answers: Value) -> Value {
    json!({
        "id": id,
        "result": answers,
    })
}

fn is_server_request(line: &Value) -> bool {
    line.get("method").is_some() && line.get("id").is_some() && line.get("result").is_none()
}

const APPROVAL_METHODS: &[&str] = &[
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    // MCP tool calls (imagegen/videogen, …) arrive as form elicitations.
    "mcpServer/elicitation/request",
];

const MCP_ELICITATION_METHOD: &str = "mcpServer/elicitation/request";

const USER_INPUT_METHOD: &str = "item/tool/requestUserInput";

fn apply_thread_settings(params: &mut Value, settings: &KernelThreadSettings) {
    let Some(object) = params.as_object_mut() else {
        return;
    };
    if let Some(cwd) = &settings.cwd {
        object.insert("cwd".into(), json!(cwd));
    }
    if let Some(model) = &settings.model {
        object.insert("model".into(), json!(model));
    }
    if let Some(effort) = &settings.reasoning_effort {
        object.insert("effort".into(), json!(effort));
    }
    if let Some(service_tier) = &settings.service_tier {
        object.insert("serviceTierForTurn".into(), json!(service_tier));
    }
}

fn apply_thread_start_settings(params: &mut Value, settings: &KernelThreadSettings) {
    let Some(object) = params.as_object_mut() else {
        return;
    };
    // The upstream tool is deliberately gated off in Default collaboration
    // mode. Knorvia owns a durable answer bridge for this exact request, so
    // opt the thread into the documented capability when it is created or
    // resumed instead of accepting a model-emitted unknown function call as
    // a fake successful user-input flow.
    object.insert(
        "config".into(),
        json!({"features.default_mode_request_user_input": true}),
    );
    if let Some(cwd) = &settings.cwd {
        object.insert("cwd".into(), json!(cwd));
    }
    if let Some(model) = &settings.model {
        object.insert("model".into(), json!(model));
    }
    if let Some(service_tier) = &settings.service_tier {
        object.insert("serviceTier".into(), json!(service_tier));
    }
}

pub struct KernelSession {
    child: Arc<Mutex<Child>>,
    /// Shared so the control plane can write interrupt requests while the
    /// turn runner is blocked reading kernel stdout. Kernel stdin carries
    /// protocol only; concurrent writers serialize on the mutex.
    stdin: Arc<Mutex<ChildStdin>>,
    transport: transport::Transport,
    next_id: AtomicI64,
    pub initialize_result: Value,
}

impl KernelSession {
    pub fn spawn(paths: &KnorviaPaths, bin: &Path) -> Result<Self, AdapterError> {
        Self::spawn_with_session_env(paths, bin, &[])
    }

    /// Spawn with extra environment variables for this Kernel process only
    /// (for example the bridge bearer token). The parent process environment
    /// is never mutated.
    pub fn spawn_with_session_env(
        paths: &KnorviaPaths,
        bin: &Path,
        session_env: &[(&str, &str)],
    ) -> Result<Self, AdapterError> {
        if is_user_codex_shim(bin) {
            return Err(AdapterError::Msg(
                "refusing to spawn user-installed Codex CLI".into(),
            ));
        }
        paths.ensure_layout()?;
        let mut cmd = Command::new(bin);
        cmd.arg("--listen")
            .arg("stdio://")
            .arg("--strict-config")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Kernel stderr is logs only; inherit it so a verbose kernel can
            // never fill an unread pipe and deadlock. The daemon's stderr is
            // the log sink (never the protocol stdout).
            .stderr(Stdio::inherit())
            .current_dir(&paths.kernel_store)
            .env("CODEX_HOME", &paths.kernel_store)
            .env("CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG", "1")
            // Default to warn; an explicitly-set RUST_LOG wins for diagnostics.
            .env(
                "RUST_LOG",
                std::env::var("RUST_LOG").unwrap_or_else(|_| "warn".into()),
            )
            // Loopback provider endpoints must never traverse a system proxy.
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env("no_proxy", "127.0.0.1,localhost")
            .env_remove("KNORVIA_HOME");
        // Deterministic fixture runs must not perform background marketplace
        // sync. This opt-in belongs only to isolated test process environments.
        if std::env::var("KNORVIA_TEST_DISABLE_PLUGIN_SYNC").as_deref() == Ok("1") {
            cmd.arg("-c").arg("features.plugins=false");
        }
        for (key, value) in session_env {
            cmd.env(key, value);
        }
        // Highest-precedence runtime enablement: the Kernel's multi-agent
        // collaboration tools are a Knorvia product surface and must not
        // depend on ambient feature defaults resolving correctly.
        cmd.arg("-c").arg("features.multi_agent=true");
        let mut child = cmd.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AdapterError::Msg("no stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AdapterError::Msg("no stdout".into()))?;
        let child = Arc::new(Mutex::new(child));
        let stdin = Arc::new(Mutex::new(stdin));
        let transport = transport::Transport::new(stdout, Arc::clone(&stdin), Arc::clone(&child));
        let mut sess = Self {
            child,
            stdin,
            transport,
            next_id: AtomicI64::new(1),
            initialize_result: Value::Null,
        };
        sess.initialize_result = sess.initialize()?;
        Ok(sess)
    }

    /// Observable per-task event backlog: queued spill, dropped transient
    /// deltas, and whether the task was isolated for falling too far behind.
    pub fn task_lag(&self, thread_id: &str) -> TaskLag {
        self.transport.task_lag(thread_id)
    }

    pub fn is_alive(&self) -> bool {
        matches!(
            self.child.lock().ok().and_then(|mut c| c.try_wait().ok()),
            Some(None)
        )
    }

    /// Stop this private kernel when its owning daemon shuts down.
    pub fn terminate(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }

    /// Shared stdin handle for out-of-band writes (turn interrupts).
    pub fn stdin_handle(&self) -> Arc<Mutex<ChildStdin>> {
        Arc::clone(&self.stdin)
    }

    fn write_msg(&self, msg: &Value) -> Result<(), AdapterError> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|e| AdapterError::Msg(e.to_string()))?;
        writeln!(stdin, "{msg}")?;
        stdin.flush()?;
        Ok(())
    }

    fn initialize(&self) -> Result<Value, AdapterError> {
        let params = json!({
            "capabilities": {"experimentalApi": true},
            "clientInfo": {
                "name": "knorvia_daemon",
                "title": "Knorvia Daemon",
                "version": env!("CARGO_PKG_VERSION")
            }
        });
        let result = self.request("initialize", params)?;
        self.notify("initialized", json!({}))?;
        Ok(result)
    }

    /// Create a Kernel thread. Sandbox and approval policy are applied
    /// per-turn (see [`TurnRunOptions`]); thread creation pins nothing.
    pub fn create_thread(&self) -> Result<String, AdapterError> {
        self.create_thread_with_settings(&KernelThreadSettings::default())
    }

    /// Create a Kernel thread with product-selected cwd/model defaults. The
    /// Kernel validates every supplied setting, so this never invents a model
    /// selection locally.
    pub fn create_thread_with_settings(
        &self,
        settings: &KernelThreadSettings,
    ) -> Result<String, AdapterError> {
        let mut params = json!({});
        apply_thread_start_settings(&mut params, settings);
        let result = self.request("thread/start", params)?;
        let id = result
            .pointer("/thread/id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                AdapterError::Msg(format!("thread/start returned no thread id: {result}"))
            })?;
        Ok(id.to_string())
    }

    /// Resume a persisted Kernel thread (loads its rollout from the Kernel
    /// store). Used after a daemon restart so product threads keep their
    /// Kernel-side context.
    pub fn resume_thread(&self, thread_id: &str) -> Result<String, AdapterError> {
        self.resume_thread_with_settings(thread_id, &KernelThreadSettings::default())
    }

    /// Resume a Kernel thread and explicitly reapply the current product
    /// selection. This is needed after a daemon restart because a product
    /// thread may have a newer selected cwd/model than its old rollout.
    pub fn resume_thread_with_settings(
        &self,
        thread_id: &str,
        settings: &KernelThreadSettings,
    ) -> Result<String, AdapterError> {
        let mut params = json!({ "threadId": thread_id, "excludeTurns": true });
        apply_thread_start_settings(&mut params, settings);
        let result = self.request("thread/resume", params)?;
        let id = result
            .pointer("/thread/id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                AdapterError::Msg(format!("thread/resume returned no thread id: {result}"))
            })?;
        Ok(id.to_string())
    }

    /// Fork actual Kernel history. The caller receives the new Kernel thread
    /// identity only after the upstream operation succeeds.
    pub fn fork_thread(
        &self,
        thread_id: &str,
        settings: &KernelThreadSettings,
    ) -> Result<String, AdapterError> {
        let mut params = json!({ "threadId": thread_id, "excludeTurns": true });
        apply_thread_start_settings(&mut params, settings);
        let result = self.request("thread/fork", params)?;
        let id = result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AdapterError::Msg(format!("thread/fork returned no thread id: {result}"))
            })?;
        Ok(id.to_string())
    }

    /// Add text to a real in-flight Kernel turn. This is deliberately a
    /// request/response call so a product user message is recorded only when
    /// the Kernel accepts it.
    pub fn steer_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        text: &str,
        client_message_id: Option<&str>,
    ) -> Result<String, AdapterError> {
        let mut params = json!({
            "threadId": thread_id,
            "expectedTurnId": turn_id,
            "input": [{"type": "text", "text": text}],
        });
        if let Some(client_message_id) = client_message_id {
            params["clientUserMessageId"] = json!(client_message_id);
        }
        let result = self.request("turn/steer", params)?;
        let accepted = result
            .get("turnId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AdapterError::Msg(format!("turn/steer returned no turn id: {result}"))
            })?;
        if accepted != turn_id {
            return Err(AdapterError::Msg(format!(
                "turn/steer accepted unexpected turn {accepted}; expected {turn_id}"
            )));
        }
        Ok(accepted.to_string())
    }

    /// Archive a durable Kernel rollout.
    pub fn archive_thread(&self, thread_id: &str) -> Result<(), AdapterError> {
        self.request("thread/archive", json!({ "threadId": thread_id }))?;
        Ok(())
    }

    /// Restore an archived durable Kernel rollout.
    pub fn unarchive_thread(&self, thread_id: &str) -> Result<(), AdapterError> {
        self.request("thread/unarchive", json!({ "threadId": thread_id }))?;
        Ok(())
    }

    /// Return the exact upstream model catalog. No static fallback is used.
    pub fn list_models(&self, params: Value) -> Result<Value, AdapterError> {
        self.request("model/list", params)
    }

    /// Discover skills from the upstream native endpoint.
    pub fn list_skills(&self, params: Value) -> Result<Value, AdapterError> {
        self.request("skills/list", params)
    }

    /// Control validates local marketplace ownership before this allowlist.
    pub fn plugin_request(&self, method: &str, params: Value) -> Result<Value, AdapterError> {
        if !matches!(
            method,
            "plugin/install" | "plugin/uninstall" | "plugin/read"
        ) {
            return Err(AdapterError::Msg("unsupported plugin operation".into()));
        }
        self.request(method, params)
    }

    /// Run one turn on an isolated subscription. Requests and other threads
    /// continue to be dispatched by the shared transport reader.
    pub fn run_turn(
        &self,
        thread_id: &str,
        text: &str,
        mut opts: TurnRunOptions,
    ) -> Result<KernelTurnResult, AdapterError> {
        let events = self.transport.subscribe(thread_id)?;
        let mut params = json!({
            "threadId": thread_id,
            "input": [{"type": "text", "text": text}],
            "sandboxPolicy": opts.sandbox.clone(),
            "approvalPolicy": opts.approval_policy,
        });
        apply_thread_settings(&mut params, &opts.settings);
        if let Some(mode) = &opts.settings.collaboration_mode {
            let model = match &opts.settings.model {
                Some(model) => model.clone(),
                None => {
                    let config = self.request("config/read", json!({}))?;
                    match config.pointer("/config/model").and_then(Value::as_str) {
                        Some(model) => model.to_string(),
                        None => {
                            let models = self.list_models(json!({}))?;
                            models
                                .get("data")
                                .and_then(Value::as_array)
                                .and_then(|models| {
                                    models.iter().find(|model| model["isDefault"] == true)
                                })
                                .and_then(|model| model.get("model").or_else(|| model.get("id")))
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .ok_or_else(|| {
                                    AdapterError::Msg(
                                        "Choose a model before selecting a collaboration mode"
                                            .into(),
                                    )
                                })?
                        }
                    }
                }
            };
            params["collaborationMode"] = harness::collaboration_mode(
                mode,
                &model,
                opts.settings.reasoning_effort.as_deref(),
            )?;
        }
        let response = self.request("turn/start", params)?;
        let turn_id = response
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .ok_or_else(|| AdapterError::Msg("kernel returned no turn identity".into()))?;
        if let Some(callback) = opts.on_turn_started.as_mut() {
            callback(turn_id);
        }
        self.await_turn(thread_id, turn_id, &events, opts)
    }

    /// Request cooperative interruption of a running turn. Safe to call from
    /// another thread while the turn runner is reading kernel stdout: it only
    /// writes to the kernel stdin.
    pub fn send_turn_interrupt(&self, thread_id: &str, turn_id: &str) -> Result<(), AdapterError> {
        for (child_thread, child_turn) in self.transport.active_descendants(thread_id) {
            self.clean_thread_terminals(&child_thread)?;
            self.write_msg(&json!({
                "id": self.next_id.fetch_add(1, Ordering::SeqCst),
                "method": "turn/interrupt",
                "params": {"threadId": child_thread, "turnId": child_turn}
            }))?;
        }
        self.clean_thread_terminals(thread_id)?;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = json!({
            "id": id,
            "method": "turn/interrupt",
            "params": {"threadId": thread_id, "turnId": turn_id}
        });
        self.write_msg(&req)
    }

    fn clean_thread_terminals(&self, thread_id: &str) -> Result<(), AdapterError> {
        self.write_msg(&json!({"id":self.next_id.fetch_add(1, Ordering::SeqCst), "method":"thread/backgroundTerminals/clean", "params":{"threadId":thread_id}}))
    }

    pub fn interrupt_agent(&self, root: &str, child: &str) -> Result<Value, AdapterError> {
        let turn = self
            .transport
            .active_descendant(root, child)
            .ok_or_else(|| {
                AdapterError::Msg("Subagent is not an active descendant of this turn".into())
            })?;
        let mut cancelled: Vec<String> = self
            .transport
            .active_descendants(child)
            .into_iter()
            .map(|(thread, _)| thread)
            .collect();
        cancelled.push(child.to_owned());
        self.send_turn_interrupt(child, &turn)?;
        Ok(
            json!({"accepted":true,"kernelThreadId":child,"kernelTurnId":turn,"cancelledKernelThreadIds":cancelled}),
        )
    }

    fn await_turn(
        &self,
        thread_id: &str,
        expected_turn_id: &str,
        events: &transport::Subscription,
        mut opts: TurnRunOptions,
    ) -> Result<KernelTurnResult, AdapterError> {
        let mut result = KernelTurnResult {
            status: "failed".into(),
            ..KernelTurnResult::default()
        };
        let mut deadline = Instant::now() + Duration::from_secs(turn_timeout_secs());
        let mut deadline_interrupted = false;
        let mut seen_item_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let v = match events.receiver.recv_timeout(remaining) {
                Ok(Ok(message)) => message,
                Ok(Err(reason)) => return Err(AdapterError::Msg(reason)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) if !deadline_interrupted => {
                    // First cancel only this Turn. Other subscriptions remain
                    // live while the Kernel acknowledges cooperative stop.
                    self.send_turn_interrupt(thread_id, expected_turn_id)?;
                    deadline_interrupted = true;
                    result.deadline_exceeded = true;
                    deadline = Instant::now() + Duration::from_secs(5);
                    continue;
                }
                Err(_) => {
                    // An unresponsive kernel is stopped rather than leaving
                    // side effects running after we report a failed turn.
                    if let Ok(mut process) = self.child.lock() {
                        let _ = process.kill();
                    }
                    return Err(AdapterError::Msg(
                        "kernel turn timed out or disconnected".into(),
                    ));
                }
            };
            let outcome = handle_turn_message(
                &mut result,
                &mut seen_item_ids,
                &v,
                thread_id,
                expected_turn_id,
                &mut opts,
                deadline_interrupted,
                &mut |message| self.write_msg(message),
            )?;
            if let Some(outcome) = outcome {
                return Ok(outcome);
            }
        }
    }

    fn request(&self, method: &str, params: Value) -> Result<Value, AdapterError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let result = self.transport.request(
            id,
            &json!({"id": id, "method": method, "params": params}),
            Duration::from_secs(30),
        );
        // A timed-out start may have been accepted remotely. Closing this
        // private connection is safer than leaving unknown tools executing.
        if matches!(result, Err(AdapterError::RequestTimeout)) {
            self.terminate();
        }
        result
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), AdapterError> {
        let msg = json!({"method": method, "params": params});
        self.write_msg(&msg)
    }
}

impl Drop for KernelSession {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            // Reap the process so locks it holds (state sqlite, rollout
            // files) are released before a replacement session spawns.
            let _ = child.wait();
        }
    }
}


/// Process one transport message inside `await_turn`. Returns `Some` when
/// the message produced the turn's outcome. Split from the receive loop so
/// deadline fixtures can drive synthetic events without a kernel process.
#[allow(clippy::too_many_arguments)]
fn handle_turn_message(
    result: &mut KernelTurnResult,
    seen_item_ids: &mut std::collections::HashSet<String>,
    v: &Value,
    thread_id: &str,
    expected_turn_id: &str,
    opts: &mut TurnRunOptions,
    deadline_interrupted: bool,
    reply: &mut dyn FnMut(&Value) -> Result<(), AdapterError>,
) -> Result<Option<KernelTurnResult>, AdapterError> {
    let event_turn = v
        .pointer("/params/turnId")
        .or_else(|| v.pointer("/params/turn/id"))
        .and_then(Value::as_str);
    let event_thread = v.pointer("/params/threadId").and_then(Value::as_str);
    let child_event = event_thread.is_some_and(|id| id != thread_id);
    if !child_event && event_turn.is_some_and(|id| id != expected_turn_id) {
        return Ok(None);
    }
    // Server requests carry an id too; classify them BEFORE the response-id
    // check or they are swallowed as strays and the Kernel waits for our
    // answer forever.
    if is_server_request(v) {
        let id = v.get("id").cloned().unwrap_or(Value::Null);
        let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
        if APPROVAL_METHODS.contains(&method) {
            let kind = method.split('/').nth(1).unwrap_or("unknown").to_string();
            let params = v.get("params").cloned().unwrap_or(json!({}));
            let request = KernelApprovalRequest {
                kind: kind.clone(),
                action: format!("kernel.{kind}"),
                payload: params,
            };
            let decision = match opts.on_approval.as_mut() {
                Some(cb) => {
                    result.surfaced_approvals += 1;
                    cb(&request)
                }
                None => {
                    result.declined_requests += 1;
                    TurnDecision::Decline
                }
            };
            let response = approval_response_for(&id, decision, method);
            reply(&response)?;
            return Ok(None);
        }
        if method == USER_INPUT_METHOD {
            let request = KernelUserInputRequest {
                payload: v.get("params").cloned().unwrap_or_else(|| json!({})),
            };
            let answers = opts
                .on_user_input
                .as_mut()
                .map(|callback| callback(&request))
                .unwrap_or_else(|| json!({"answers": {}}));
            reply(&user_input_response(&id, answers))?;
            return Ok(None);
        }
        result.declined_requests += 1;
        let response = denial_response(
            &id,
            "knorvia-daemon: this server request is not supported by the kernel turn bridge",
        );
        reply(&response)?;
        return Ok(None);
    }
    let Some(method) = v.get("method").and_then(|m| m.as_str()) else {
        return Ok(None);
    };
    let params = v.get("params").cloned().unwrap_or(Value::Null);
    if child_event {
        let params = if method == "thread/tokenUsage/updated" {
            harness::annotate_kernel_usage(&params)
        } else {
            params
        };
        // The transport verified this descendant's parent chain.
        // Preserve its native identity and terminal state separately;
        // a child finishing must not finish its product parent, and
        // child usage must not masquerade as the parent's counter.
        let payload = json!({
            "kernelThreadId": event_thread,
            "kernelTurnId": event_turn,
            "event": method,
            "data": params,
        });
        if matches!(
            method,
            "turn/started"
                | "turn/completed"
                | "item/completed"
                | "thread/tokenUsage/updated"
                | "error"
        ) {
            let item = KernelTurnItem {
                kind: "subAgent".into(),
                payload,
            };
            if let Some(callback) = opts.on_item.as_mut() {
                callback(&item);
            }
            result.items.push(item);
        } else if let Some(callback) = opts.on_progress.as_mut() {
            callback("subAgent", &payload);
        }
        return Ok(None);
    }
    match method {
        "error" => {
            // Normalize the upstream error into a Knorvia shape. Raw
            // upstream error objects (provider internals, response
            // metadata) must never surface to clients.
            let inner = params.get("error").unwrap_or(&params);
            let message = inner
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("kernel turn error");
            result.error = Some(json!({
                "message": message,
                "willRetry": params.get("willRetry").cloned().unwrap_or(json!(false)),
            }));
        }
        "turn/completed" => {
            let n_tid = params
                .get("threadId")
                .and_then(|t| t.as_str())
                .unwrap_or("");
            if n_tid != thread_id {
                return Ok(None);
            }
            let status = params
                .pointer("/turn/status")
                .and_then(|s| s.as_str())
                .unwrap_or("failed");
            result.status = status.to_string();
            if deadline_interrupted && status != "completed" && result.error.is_none() {
                // The deadline interrupt raced a non-completed Kernel
                // terminal: keep the authoritative terminal and add the
                // deadline as diagnostics instead of rewriting the turn to
                // failed. A genuinely completed turn is not tainted.
                result.error = Some(
                    json!({"category": "DEADLINE_EXCEEDED", "message": "Kernel turn exceeded its deadline"}),
                );
            }
            // The final agent message can arrive either as a preceding
            // item/completed or inline in turn.items; merge without
            // duplicating either way.
            if let Some(items) = params.pointer("/turn/items").and_then(|v| v.as_array()) {
                for item in items {
                    let dup = item
                        .get("id")
                        .and_then(|i| i.as_str())
                        .map(|id| !seen_item_ids.insert(id.to_string()))
                        .unwrap_or(true);
                    if !dup {
                        let normalized = normalize_item(item);
                        if let Some(cb) = opts.on_item.as_mut() {
                            cb(&normalized);
                        }
                        result.items.push(normalized);
                    }
                }
            }
            return Ok(Some(std::mem::take(result)));
        }
        "item/completed" => {
            let n_tid = params
                .get("threadId")
                .and_then(|t| t.as_str())
                .unwrap_or("");
            if n_tid != thread_id {
                return Ok(None);
            }
            if let Some(item) = params.get("item") {
                if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                    seen_item_ids.insert(id.to_string());
                }
                let normalized = normalize_item(item);
                if let Some(cb) = opts.on_item.as_mut() {
                    cb(&normalized);
                }
                result.items.push(normalized);
            }
        }
        "item/agentMessage/delta" => {
            let n_tid = params
                .get("threadId")
                .and_then(|t| t.as_str())
                .unwrap_or("");
            if n_tid != thread_id {
                return Ok(None);
            }
            if let (Some(cb), Some(item_id)) = (
                opts.on_delta.as_mut(),
                params.get("itemId").and_then(|i| i.as_str()),
            ) {
                let delta = params.get("delta").and_then(|d| d.as_str()).unwrap_or("");
                cb(item_id, delta);
            }
        }
        _ => match harness::project_event(method, &params) {
            Some(harness::Event::Durable(item)) => {
                if let Some(callback) = opts.on_item.as_mut() {
                    callback(&item);
                }
                result.items.push(item);
            }
            Some(harness::Event::Progress(kind, payload)) => {
                if let Some(callback) = opts.on_progress.as_mut() {
                    callback(kind, &payload);
                }
            }
            None => {}
        },
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_node_modules_codex_shim() {
        let p = Path::new(r"D:\node-v26.3.0-win-x64\node_modules\@openai\codex\bin\codex.js");
        assert!(is_user_codex_shim(p));
        let in_tree =
            Path::new(r"D:\tools\knorvia-kernel\codex-rs\target\debug\codex-app-server.exe");
        assert!(!is_user_codex_shim(in_tree));
    }

    #[test]
    fn provider_env_requires_model() {
        // No env set here: must be None. (Guards against accidental panics.)
        // Individual env-dependent behavior is covered by the integration test.
        let _ = provider_from_env();
    }

    #[test]
    fn normalize_agent_message_and_unknown_kind() {
        let agent = normalize_item(&json!({
            "type": "agentMessage",
            "id": "item_1",
            "text": "hello world",
            "phase": "final"
        }));
        assert_eq!(agent.kind, "agentMessage");
        assert_eq!(agent.payload["text"], "hello world");

        let unknown = normalize_item(&json!({
            "type": "exoticItem",
            "id": "item_2",
            "custom": {"a": 1}
        }));
        assert_eq!(unknown.kind, "exoticItem");
        assert_eq!(unknown.payload["custom"]["a"], 1);
    }

    #[test]
    fn read_only_options_pin_read_only_sandbox_and_never_approvals() {
        let opts = TurnRunOptions::read_only();
        assert_eq!(opts.sandbox["type"], "readOnly");
        assert_eq!(opts.approval_policy, "never");
        let opts = TurnRunOptions::workspace_write();
        assert_eq!(opts.sandbox["type"], "workspaceWrite");
        assert_eq!(opts.approval_policy, "on-request");
    }

    #[test]
    fn selected_settings_use_the_upstream_thread_and_turn_fields() {
        let settings = KernelThreadSettings {
            cwd: Some(r"D:\work\knorvia".into()),
            model: Some("gpt-5.6-terra".into()),
            reasoning_effort: Some("max".into()),
            service_tier: Some("priority".into()),
            collaboration_mode: None,
        };
        let mut start = json!({});
        apply_thread_start_settings(&mut start, &settings);
        assert_eq!(
            start["config"]["features.default_mode_request_user_input"],
            true
        );
        assert_eq!(start["cwd"], r"D:\work\knorvia");
        assert_eq!(start["model"], "gpt-5.6-terra");
        assert_eq!(start["serviceTier"], "priority");
        assert!(start.get("effort").is_none());

        let mut turn = json!({});
        apply_thread_settings(&mut turn, &settings);
        assert_eq!(turn["cwd"], r"D:\work\knorvia");
        assert_eq!(turn["model"], "gpt-5.6-terra");
        assert_eq!(turn["effort"], "max");
        assert_eq!(turn["serviceTierForTurn"], "priority");
    }

    fn completed_message(status: &str) -> Value {
        json!({"method": "turn/completed",
            "params": {"threadId": "th", "turn": {"id": "tn", "status": status}}})
    }

    /// Drive one synthetic message through the extracted await_turn body.
    fn drive(
        result: &mut KernelTurnResult,
        v: &Value,
        deadline_interrupted: bool,
    ) -> Option<KernelTurnResult> {
        let mut seen = std::collections::HashSet::new();
        let mut opts = TurnRunOptions::read_only();
        handle_turn_message(
            result,
            &mut seen,
            v,
            "th",
            "tn",
            &mut opts,
            deadline_interrupted,
            &mut |_| Ok(()),
        )
        .unwrap()
    }

    #[test]
    fn deadline_then_kernel_completed_keeps_the_authoritative_terminal() {
        let mut result = KernelTurnResult::default();
        result.deadline_exceeded = true;
        let outcome = drive(&mut result, &completed_message("completed"), true)
            .expect("completed is a terminal outcome");
        assert_eq!(outcome.status, "completed");
        assert!(
            outcome.error.is_none(),
            "a completed terminal must not be rewritten to failed: {outcome:?}"
        );
        assert!(outcome.deadline_exceeded, "the deadline diagnostic stays");
    }

    #[test]
    fn deadline_then_kernel_interrupted_keeps_terminal_with_deadline_diagnostics() {
        let mut result = KernelTurnResult::default();
        result.deadline_exceeded = true;
        let outcome = drive(&mut result, &completed_message("interrupted"), true)
            .expect("interrupted is a terminal outcome");
        assert_eq!(outcome.status, "interrupted");
        assert_eq!(
            outcome.error.as_ref().expect("deadline diagnostics")["category"],
            "DEADLINE_EXCEEDED"
        );
    }

    #[test]
    fn late_delta_never_produces_an_outcome_or_touches_the_terminal() {
        let mut result = KernelTurnResult {
            status: "failed".into(),
            ..KernelTurnResult::default()
        };
        let outcome = drive(
            &mut result,
            &json!({"method": "item/agentMessage/delta",
                "params": {"threadId": "th", "itemId": "i", "delta": "late"}}),
            true,
        );
        assert!(outcome.is_none(), "deltas are not terminal");
        assert_eq!(result.status, "failed");
    }

    #[test]
    fn user_input_response_keeps_the_upstream_answers_envelope() {
        let response = user_input_response(
            &json!("request-7"),
            json!({"answers": {"mode": {"answers": ["custom"]}}}),
        );
        assert_eq!(response["id"], "request-7");
        assert_eq!(
            response["result"]["answers"]["mode"]["answers"][0],
            "custom"
        );
    }

    #[test]
    fn spawn_initialize_against_in_tree_binary_if_present() {
        let bin = resolve_kernel_bin().expect("resolve in-tree kernel binary");
        assert!(!is_user_codex_shim(&bin));
        let home = std::env::temp_dir().join(format!(
            "knorvia-kadapt-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let paths = knorvia_platform_paths::layout(home.clone());
        paths.ensure_layout().unwrap();
        let sess = KernelSession::spawn(&paths, &bin).expect("spawn kernel");
        let ua = sess.initialize_result["userAgent"].as_str().unwrap_or("");
        assert!(
            ua.contains("knorvia_daemon"),
            "kernel userAgent must identify Knorvia, got {ua}"
        );
        let reported = sess.initialize_result["codexHome"].as_str().unwrap_or("");
        assert!(
            reported.contains("knorvia-kadapt") || reported.contains("kernel"),
            "kernel store leaked off Knorvia home: {reported}"
        );
        assert!(!reported.to_lowercase().contains(".codex"));
        drop(sess);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn kernel_config_toml_matches_gateway_env() {
        let home = std::env::temp_dir().join(format!(
            "knorvia-kcfg-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let paths = knorvia_platform_paths::layout(home.clone());
        let provider = ProviderEnv {
            model: "gpt-5.2".into(),
            base_url: Some("http://127.0.0.1:9/v1".into()),
            api_key_env: PROVIDER_API_KEY_ENV.into(),
        };
        ensure_kernel_config(&paths, &provider).unwrap();
        let toml = fs::read_to_string(paths.kernel_store.join("config.toml")).unwrap();
        assert!(toml.contains("model = \"gpt-5.2\""));
        assert!(toml.contains("base_url = \"http://127.0.0.1:9/v1\""));
        assert!(toml.contains("env_key = \"KNORVIA_PROVIDER_API_KEY\""));
        assert!(toml.contains("wire_api = \"responses\""));
        // Idempotent rewrite.
        ensure_kernel_config(&paths, &provider).unwrap();
        // Without base_url the config is left untouched.
        let no_url = ProviderEnv {
            model: "gpt-5.2".into(),
            base_url: None,
            api_key_env: PROVIDER_API_KEY_ENV.into(),
        };
        ensure_kernel_config(&paths, &no_url).unwrap();
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn studio_mcp_url_requires_loopback_numeric_port_and_exact_path() {
        let ok = "http://127.0.0.1:9310/mcp";
        assert_eq!(parse_studio_mcp_url(ok).as_deref(), Some(ok));
        for bad in [
            "http://127.0.0.1:0/mcp",
            "http://127.0.0.1:99999/mcp",
            "http://127.0.0.1:+80/mcp",
            "http://127.0.0.1:/mcp",
            "http://127.0.0.1:9310/other/mcp",
            "http://127.0.0.1:9310/mcp/",
            "http://127.0.0.1:9310/mcp?x=1",
            "http://127.0.0.1:9310/mcp#f",
            "http://user:pw@127.0.0.1:9310/mcp",
            "https://127.0.0.1:9310/mcp",
            "http://localhost:9310/mcp",
            "http://10.0.0.5:9310/mcp",
            "http://127.0.0.1:9310",
            "",
        ] {
            assert!(parse_studio_mcp_url(bad).is_none(), "must reject {bad:?}");
        }
    }

    #[test]
    fn studio_mcp_section_registers_without_chat_base_url() {
        let home = std::env::temp_dir().join(format!(
            "knorvia-kmcp-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let paths = knorvia_platform_paths::layout(home.clone());
        // A default-provider setup (no chat base_url) still registers MCP.
        ensure_studio_mcp_section(&paths, Some("http://127.0.0.1:9310/mcp")).unwrap();
        let toml = fs::read_to_string(paths.kernel_store.join("config.toml")).unwrap();
        assert!(toml.contains("[mcp_servers.knorvia_media]"));
        assert!(toml.contains("url = \"http://127.0.0.1:9310/mcp\""));
        // Idempotent rewrite leaves the file byte-identical.
        ensure_studio_mcp_section(&paths, Some("http://127.0.0.1:9310/mcp")).unwrap();
        assert_eq!(
            fs::read_to_string(paths.kernel_store.join("config.toml")).unwrap(),
            toml
        );
        // Clearing the registration strips only the owned section.
        ensure_studio_mcp_section(&paths, None).unwrap();
        assert!(
            !fs::read_to_string(paths.kernel_store.join("config.toml"))
                .unwrap()
                .contains("knorvia_media")
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn studio_mcp_section_preserves_unrelated_config() {
        let home = std::env::temp_dir().join(format!(
            "knorvia-kmcp-keep-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let paths = knorvia_platform_paths::layout(home.clone());
        paths.ensure_layout().unwrap();
        let existing = "model = \"gpt-5.2\"\ntop_p = 1\n\n[profiles.nightly]\nmodel = \"x\"\n";
        fs::write(paths.kernel_store.join("config.toml"), existing).unwrap();
        ensure_studio_mcp_section(&paths, Some("http://127.0.0.1:9311/mcp")).unwrap();
        let toml = fs::read_to_string(paths.kernel_store.join("config.toml")).unwrap();
        assert!(toml.starts_with("model = \"gpt-5.2\"\ntop_p = 1\n"));
        assert!(toml.contains("[profiles.nightly]"));
        assert!(toml.contains("[mcp_servers.knorvia_media]"));
        ensure_studio_mcp_section(&paths, None).unwrap();
        assert_eq!(
            fs::read_to_string(paths.kernel_store.join("config.toml")).unwrap(),
            existing
        );
        let _ = fs::remove_dir_all(home);
    }
}
