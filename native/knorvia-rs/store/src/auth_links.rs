//! Durable auth-link registry: account connections (ChatGPT/Codex login,
//! installed CLIs) with real, auditable state — never fake availability.
//!
//! Contract (CONTRACTS.md §"CLI Backend 与登录", GOAL-C C04/C11/C12):
//! status is one of `disconnected|connecting|needs-user|connected|
//! expired|error`; credentials never enter this store (aliases and
//! capability facts only); a connect operation is single-flight per link
//! and expires; "disconnect" clears local state and never logs the user
//! out of their independently installed CLI. All transitions are
//! revisioned (audit) and any free-text detail is redacted before it is
//! written, so tokens leaked into messages cannot reach disk or UI.
//!
//! The store is pure state: detection/exchange happen outside (control
//! layer with a real impl plus fixtures in tests), which keeps every
//! transition deterministically testable.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const AUTH_STATUSES: [&str; 6] = [
    "disconnected",
    "connecting",
    "needs-user",
    "connected",
    "expired",
    "error",
];

/// Quota vocabulary kept explicit: a ChatGPT/Claude login is a
/// *subscription* benefit carried by its own client, never a generic API
/// credit; `unknown` means we do not know and must say so.
pub const QUOTA_TYPES: [&str; 3] = ["subscription", "api", "unknown"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthLinkRecord {
    /// Stable provider key, e.g. `codex`, `claude-cli`, `grok-cli`.
    pub id: String,
    pub revision: u64,
    /// `oauth` (browser login via a public flow) or `cli` (installed CLI
    /// account status).
    pub kind: String,
    pub display_name: String,
    pub status: String,
    pub quota_type: String,
    /// Display-only account hint (e.g. "user@…" or plan name). Never a
    /// token, key, or cookie.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_alias: Option<String>,
    /// Detected capability facts (installed, version, resume, streaming…).
    /// Facts the detector did not report are absent — never defaulted to true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Pending authorize URL shown to the user while `needs-user`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_expires_at_ms: Option<u64>,
    pub updated_at_ms: u64,
    pub recorded_at_ms: u64,
}

/// Capability facts a detector observed. Every field is Option on
/// purpose: an unobserved fact is absent, never defaulted to true.
#[derive(Debug, Clone, Default)]
pub struct AuthDetectorFacts {
    pub installed: Option<bool>,
    pub authenticated: Option<bool>,
    pub version: Option<String>,
    pub detail: Option<String>,
}

/// One single-flight connect operation. At most one live op per link.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthConnectOp {
    pub id: String,
    pub link_id: String,
    /// `waiting` (user has the URL) | `exchanging` | `completed` |
    /// `cancelled` | `expired` | `failed`.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorize_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redirect_port: Option<u16>,
    /// Opaque OAuth state parameter; kept server-side only and never
    /// echoed through list APIs in the control layer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_state: Option<String>,
    /// PKCE verifier for public-client flows; server-side only, never
    /// serialized to the UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pkce_verifier: Option<String>,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthLinkError {
    pub kind: AuthLinkErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthLinkErrorKind {
    InvalidArgument,
    NotFound,
    Conflict,
    Corrupt,
    Io,
}

impl std::fmt::Display for AuthLinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}
impl std::error::Error for AuthLinkError {}

fn err<T>(kind: AuthLinkErrorKind, message: impl Into<String>) -> Result<T, AuthLinkError> {
    Err(AuthLinkError { kind, message: message.into() })
}

static AUTH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Mask anything that looks like a credential inside free text before it
/// is stored: long token-ish runs and `sk-`/bearer prefixes never reach
/// disk or the UI through `detail`.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut token = String::new();
    let flush = |token: &mut String, out: &mut String| {
        if token.is_empty() {
            return;
        }
        let looks_secret = token.len() >= 20
            && (token.to_ascii_lowercase().starts_with("sk-")
                || token.to_ascii_lowercase().starts_with("bearer")
                || token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        if looks_secret {
            out.push_str("[redacted]");
        } else {
            out.push_str(token);
        }
        token.clear();
    };
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            token.push(ch);
        } else {
            flush(&mut token, &mut out);
            out.push(ch);
        }
    }
    flush(&mut token, &mut out);
    out
}

fn sanitize_link_id(id: &str) -> Result<(), AuthLinkError> {
    if id.len() > 64
        || id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return err(
            AuthLinkErrorKind::InvalidArgument,
            format!("unsafe auth link id {id:?}"),
        );
    }
    Ok(())
}

pub struct AuthLinkStore {
    root: PathBuf,
}

impl AuthLinkStore {
    pub fn open(state_root: &Path) -> Self {
        Self {
            root: state_root.join("product").join("auth"),
        }
    }

    fn links_dir(&self) -> PathBuf {
        self.root.join("links")
    }
    fn ops_dir(&self) -> PathBuf {
        self.root.join("ops")
    }
    fn link_path(&self, id: &str) -> PathBuf {
        self.links_dir().join(format!("{id}.json"))
    }

    fn write_json(path: &Path, value: &impl Serialize) -> Result<(), AuthLinkError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AuthLinkError { kind: AuthLinkErrorKind::Io, message: e.to_string() })?;
        }
        let bytes = serde_json::to_vec_pretty(value)
            .map_err(|e| AuthLinkError { kind: AuthLinkErrorKind::Corrupt, message: e.to_string() })?;
        let tmp = path.with_file_name(format!(
            ".{}.{}.tmp",
            std::process::id(),
            AUTH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&tmp, &bytes)
            .map_err(|e| AuthLinkError { kind: AuthLinkErrorKind::Io, message: e.to_string() })?;
        std::fs::rename(&tmp, path)
            .map_err(|e| AuthLinkError { kind: AuthLinkErrorKind::Io, message: e.to_string() })?;
        Ok(())
    }

    fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, AuthLinkError> {
        let bytes = std::fs::read(path)
            .map_err(|e| AuthLinkError { kind: AuthLinkErrorKind::Io, message: e.to_string() })?;
        serde_json::from_slice(&bytes).map_err(|e| AuthLinkError {
            kind: AuthLinkErrorKind::Corrupt,
            message: format!("{}: {e}", path.display()),
        })
    }

    /// Create-or-reset a link definition (idempotent bootstrap for the
    /// built-in catalog: creating twice keeps one link).
    pub fn ensure_link(
        &self,
        id: &str,
        kind: &str,
        display_name: &str,
        quota_type: &str,
    ) -> Result<AuthLinkRecord, AuthLinkError> {
        sanitize_link_id(id)?;
        if !["oauth", "cli"].contains(&kind) {
            return err(AuthLinkErrorKind::InvalidArgument, format!("unknown auth link kind {kind:?}"));
        }
        if !QUOTA_TYPES.contains(&quota_type) {
            return err(AuthLinkErrorKind::InvalidArgument, format!("unknown quota type {quota_type:?}"));
        }
        if let Some(existing) = self.read_link(id)? {
            return Ok(existing);
        }
        let at = now_ms();
        let record = AuthLinkRecord {
            id: id.to_string(),
            revision: 1,
            kind: kind.to_string(),
            display_name: display_name.to_string(),
            status: "disconnected".into(),
            quota_type: quota_type.to_string(),
            account_alias: None,
            capabilities: None,
            detail: None,
            login_url: None,
            login_expires_at_ms: None,
            updated_at_ms: at,
            recorded_at_ms: at,
        };
        Self::write_json(&self.link_path(id), &record)?;
        Ok(record)
    }

    pub fn read_link(&self, id: &str) -> Result<Option<AuthLinkRecord>, AuthLinkError> {
        sanitize_link_id(id)?;
        let path = self.link_path(id);
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(Self::read_json(&path)?))
    }

    pub fn list_links(&self) -> Result<Vec<AuthLinkRecord>, AuthLinkError> {
        let mut links = Vec::new();
        let entries = match std::fs::read_dir(self.links_dir()) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(links),
            Err(e) => return err(AuthLinkErrorKind::Io, e.to_string()),
        };
        for entry in entries {
            let entry = entry.map_err(|e| AuthLinkError { kind: AuthLinkErrorKind::Io, message: e.to_string() })?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                links.push(Self::read_json::<AuthLinkRecord>(&path)?);
            }
        }
        links.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(links)
    }

    fn mutate(
        &self,
        id: &str,
        expected_revision: Option<u64>,
        apply: impl FnOnce(AuthLinkRecord) -> Result<AuthLinkRecord, AuthLinkError>,
    ) -> Result<AuthLinkRecord, AuthLinkError> {
        sanitize_link_id(id)?;
        let record = self
            .read_link(id)?
            .ok_or_else(|| AuthLinkError {
                kind: AuthLinkErrorKind::NotFound,
                message: format!("auth link {id} not found"),
            })?;
        if let Some(expected) = expected_revision {
            if expected != record.revision {
                return err(
                    AuthLinkErrorKind::Conflict,
                    format!("auth link {id} is at revision {}, caller expected {expected}", record.revision),
                );
            }
        }
        let mut updated = apply(record)?;
        updated.revision += 1;
        updated.updated_at_ms = now_ms();
        Self::write_json(&self.link_path(id), &updated)?;
        Ok(updated)
    }

    /// Start a connect operation. Single-flight: a second start while an
    /// op is live (waiting/exchanging, unexpired) is a conflict. Returns
    /// the created op; the caller hands `authorize_url` to the user.
    pub fn connect_start(
        &self,
        link_id: &str,
        authorize_url: &str,
        redirect_port: Option<u16>,
        oauth_state: Option<String>,
        pkce_verifier: Option<String>,
        expires_in_ms: u64,
    ) -> Result<AuthConnectOp, AuthLinkError> {
        let at = now_ms();
        if authorize_url.len() > 2048 || !authorize_url.starts_with("https://") {
            return err(
                AuthLinkErrorKind::InvalidArgument,
                "authorize URL must be an https URL from the provider's public flow",
            );
        }
        self.mutate(link_id, None, |mut record| {
            if record.status == "connecting" || record.status == "needs-user" {
                return err(
                    AuthLinkErrorKind::Conflict,
                    format!("auth link {link_id} already has a live connect operation"),
                );
            }
            record.status = "needs-user".into();
            record.login_url = Some(authorize_url.to_string());
            record.login_expires_at_ms = Some(at.saturating_add(expires_in_ms));
            record.detail = None;
            Ok(record)
        })?;
        let op = AuthConnectOp {
            id: format!("authop_{at:013x}_{:04x}", AUTH_SEQUENCE.fetch_add(1, Ordering::Relaxed)),
            link_id: link_id.to_string(),
            state: "waiting".into(),
            authorize_url: Some(authorize_url.to_string()),
            redirect_port,
            oauth_state,
            pkce_verifier,
            created_at_ms: at,
            expires_at_ms: at.saturating_add(expires_in_ms),
            updated_at_ms: at,
        };
        Self::write_json(&self.ops_dir().join(format!("{}.json", op.id)), &op)?;
        Ok(op)
    }

    /// The live op for a link, resolving expiry first: an op past its
    /// deadline becomes `expired` and the link returns to `disconnected`
    /// — a stale login window never pretends to still be open.
    pub fn live_op(&self, link_id: &str) -> Result<Option<AuthConnectOp>, AuthLinkError> {
        sanitize_link_id(link_id)?;
        let mut live: Option<AuthConnectOp> = None;
        let entries = match std::fs::read_dir(self.ops_dir()) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return err(AuthLinkErrorKind::Io, e.to_string()),
        };
        let mut ops = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| AuthLinkError { kind: AuthLinkErrorKind::Io, message: e.to_string() })?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                ops.push(Self::read_json::<AuthConnectOp>(&path)?);
            }
        }
        ops.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms));
        for mut op in ops {
            if op.link_id != link_id {
                continue;
            }
            if op.state == "waiting" || op.state == "exchanging" {
                if now_ms() > op.expires_at_ms {
                    op.state = "expired".into();
                    op.updated_at_ms = now_ms();
                    Self::write_json(&self.ops_dir().join(format!("{}.json", op.id)), &op)?;
                    self.mutate(link_id, None, |mut record| {
                        if record.status == "needs-user" || record.status == "connecting" {
                            record.status = "expired".into();
                            record.login_url = None;
                            record.login_expires_at_ms = None;
                        }
                        Ok(record)
                    })?;
                    continue;
                }
                live = Some(op);
            }
        }
        Ok(live)
    }

    /// Progress a live op (`exchanging` after the callback arrived).
    pub fn op_exchanging(&self, op_id: &str) -> Result<AuthConnectOp, AuthLinkError> {
        self.mutate_op(op_id, "waiting", "exchanging")
    }

    fn mutate_op(&self, op_id: &str, from: &str, to: &str) -> Result<AuthConnectOp, AuthLinkError> {
        let path = self.ops_dir().join(format!("{op_id}.json"));
        if !path.exists() {
            return err(AuthLinkErrorKind::NotFound, format!("auth op {op_id} not found"));
        }
        let mut op: AuthConnectOp = Self::read_json(&path)?;
        if op.state != from {
            return err(
                AuthLinkErrorKind::Conflict,
                format!("auth op {op_id} is {}, not {from}", op.state),
            );
        }
        op.state = to.to_string();
        op.updated_at_ms = now_ms();
        Self::write_json(&path, &op)?;
        Ok(op)
    }

    /// Finish a connect op with an outcome. `connected` carries the
    /// account alias and capability facts; anything else rolls the link
    /// back to a clear non-fake state (`disconnected`/`expired`/`error`).
    pub fn connect_finish(
        &self,
        op_id: &str,
        outcome: &str,
        account_alias: Option<&str>,
        quota_type: Option<&str>,
        detail: Option<&str>,
    ) -> Result<AuthConnectOp, AuthLinkError> {
        let path = self.ops_dir().join(format!("{op_id}.json"));
        if !path.exists() {
            return err(AuthLinkErrorKind::NotFound, format!("auth op {op_id} not found"));
        }
        let op: AuthConnectOp = Self::read_json(&path)?;
        if matches!(
            op.state.as_str(),
            "completed" | "cancelled" | "expired" | "failed"
        ) {
            return err(
                AuthLinkErrorKind::Conflict,
                format!("auth op {op_id} already finished as {}", op.state),
            );
        }
        let link_id = op.link_id.clone();
        if let Some(alias) = account_alias {
            if alias.len() > 256 {
                return err(AuthLinkErrorKind::InvalidArgument, "account alias too long");
            }
        }
        if let Some(quota) = quota_type {
            if !QUOTA_TYPES.contains(&quota) {
                return err(AuthLinkErrorKind::InvalidArgument, format!("unknown quota type {quota:?}"));
            }
        }
        let terminal = match outcome {
            "connected" => {
                if now_ms() > op.expires_at_ms {
                    "expired"
                } else {
                    "completed"
                }
            }
            "cancelled" => "cancelled",
            "failed" => "failed",
            other => {
                return err(AuthLinkErrorKind::InvalidArgument, format!("unknown outcome {other:?}"));
            }
        };
        // Terminal op states are frozen: a replayed finish is a conflict,
        // not a second write (duplicate terminal events must not re-count).
        let mut frozen = op.clone();
        frozen.state = terminal.to_string();
        frozen.updated_at_ms = now_ms();
        Self::write_json(&self.ops_dir().join(format!("{op_id}.json")), &frozen)?;
        self.mutate(&link_id, None, |mut record| {
            record.login_url = None;
            record.login_expires_at_ms = None;
            match terminal {
                "completed" => {
                    record.status = "connected".into();
                    record.account_alias = account_alias.map(str::to_string);
                    if let Some(quota) = quota_type {
                        record.quota_type = quota.to_string();
                    }
                    record.detail = detail.map(redact);
                }
                "cancelled" => {
                    record.status = "disconnected".into();
                    record.detail = detail.map(redact);
                }
                "failed" => {
                    record.status = "error".into();
                    record.detail = detail.map(redact);
                }
                "expired" => {
                    record.status = "expired".into();
                    record.detail = detail.map(redact);
                }
                _ => unreachable!("terminal vocabulary is closed above"),
            }
            Ok(record)
        })?;
        Ok(frozen)
    }

    /// Update detected capability facts and derive status honestly:
    /// `authenticated: true` means connected; a detector that did not run
    /// (CLI missing) must not be recorded as connected.
    pub fn apply_detection(
        &self,
        link_id: &str,
        expected_revision: Option<u64>,
        capabilities: serde_json::Value,
        quota_type: Option<&str>,
        detail: Option<&str>,
    ) -> Result<AuthLinkRecord, AuthLinkError> {
        if let Some(quota) = quota_type {
            if !QUOTA_TYPES.contains(&quota) {
                return err(AuthLinkErrorKind::InvalidArgument, format!("unknown quota type {quota:?}"));
            }
        }
        self.mutate(link_id, expected_revision, |mut record| {
            let authenticated = capabilities["authenticated"].as_bool() == Some(true);
            let installed = capabilities["installed"].as_bool() == Some(true);
            record.capabilities = Some(capabilities);
            record.detail = detail.map(redact);
            if authenticated {
                record.status = "connected".into();
                if let Some(alias) = record.capabilities.as_ref().and_then(|c| c["accountAlias"].as_str()) {
                    record.account_alias = Some(alias.to_string());
                }
                if let Some(quota) = quota_type {
                    record.quota_type = quota.to_string();
                }
            } else if record.status != "needs-user" && record.status != "connecting" {
                record.status = if installed { "disconnected".into() } else { "error".into() };
                if !installed {
                    record.detail = Some(redact(
                        detail.unwrap_or("provider CLI not installed on this machine"),
                    ));
                }
            }
            Ok(record)
        })
    }

    /// Disconnect: clears every local connection fact. It deliberately has
    /// no ability to log the user out of an independently installed CLI —
    /// that is not this product's account to revoke.
    pub fn disconnect(&self, link_id: &str, expected_revision: Option<u64>) -> Result<AuthLinkRecord, AuthLinkError> {
        // An in-flight op is cancelled first so the single-flight slot frees.
        if let Some(op) = self.live_op(link_id)? {
            let mut cancelled = op.clone();
            cancelled.state = "cancelled".into();
            cancelled.updated_at_ms = now_ms();
            Self::write_json(&self.ops_dir().join(format!("{}.json", op.id)), &cancelled)?;
        }
        self.mutate(link_id, expected_revision, |mut record| {
            record.status = "disconnected".into();
            record.account_alias = None;
            record.login_url = None;
            record.login_expires_at_ms = None;
            record.detail = None;
            Ok(record)
        })
    }

    /// Mark `expired` when a previously connected session is found stale
    /// by a detector (e.g. token refresh rejected). Facts, not guesses.
    pub fn mark_expired(&self, link_id: &str, detail: Option<&str>) -> Result<AuthLinkRecord, AuthLinkError> {
        self.mutate(link_id, None, |mut record| {
            if record.status != "connected" {
                return err(
                    AuthLinkErrorKind::Conflict,
                    format!("auth link {link_id} is {}, not connected", record.status),
                );
            }
            record.status = "expired".into();
            record.detail = detail.map(redact);
            Ok(record)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TempHome(PathBuf);
    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn store(tag: &str) -> (AuthLinkStore, TempHome) {
        let base = std::env::temp_dir().join(format!(
            "knorvia-auth-test-{tag}-{}-{}",
            std::process::id(),
            AUTH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&base).unwrap();
        (AuthLinkStore::open(&base), TempHome(base))
    }

    const URL: &str = "https://auth.openai.com/authorize?response_type=code&client_id=app";

    #[test]
    fn bootstrap_is_idempotent_and_catalog_honest() {
        let (store, _home) = store("bootstrap");
        let first = store.ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription").unwrap();
        assert_eq!(first.status, "disconnected");
        assert_eq!(first.quota_type, "subscription");
        let again = store.ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription").unwrap();
        assert_eq!(again.revision, first.revision, "bootstrap twice keeps one link");
        assert_eq!(store.list_links().unwrap().len(), 1);
        assert_eq!(
            store.ensure_link("bogus", "widget", "x", "unknown").unwrap_err().kind,
            AuthLinkErrorKind::InvalidArgument
        );
    }

    #[test]
    fn connect_flow_walks_needs_user_to_connected_and_is_single_flight() {
        let (store, _home) = store("flow");
        store.ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription").unwrap();
        let op = store.connect_start("codex", URL, Some(1455), Some("state-abc".into()), None, 600_000).unwrap();
        assert_eq!(op.state, "waiting");
        let link = store.read_link("codex").unwrap().unwrap();
        assert_eq!(link.status, "needs-user");
        assert_eq!(link.login_url.as_deref(), Some(URL));
        // single flight: a second start is refused while this op is live
        assert_eq!(
            store.connect_start("codex", URL, None, None, None, 60_000).unwrap_err().kind,
            AuthLinkErrorKind::Conflict
        );
        // callback arrived → exchanging → completed with facts
        store.op_exchanging(&op.id).unwrap();
        let done = store
            .connect_finish(&op.id, "connected", Some("user@example.com (Pro)", ), Some("subscription"), None)
            .unwrap();
        assert_eq!(done.state, "completed");
        let link = store.read_link("codex").unwrap().unwrap();
        assert_eq!(link.status, "connected");
        assert_eq!(link.account_alias.as_deref(), Some("user@example.com (Pro)"));
        assert_eq!(link.quota_type, "subscription", "subscription stays labeled as subscription");
        assert!(link.login_url.is_none());
        // finished op frees the slot
        let next = store.connect_start("codex", URL, None, None, None, 60_000).unwrap();
        assert_ne!(next.id, op.id);
    }

    #[test]
    fn cancel_expire_and_failure_land_in_clear_states() {
        let (store, _home) = store("outcomes");
        for link in ["a", "b", "c"] {
            store.ensure_link(link, "oauth", link, "unknown").unwrap();
        }
        let cancelled = store.connect_start("a", URL, None, None, None, 60_000).unwrap();
        store.connect_finish(&cancelled.id, "cancelled", None, None, Some("user closed the window")).unwrap();
        assert_eq!(store.read_link("a").unwrap().unwrap().status, "disconnected");

        let failed = store.connect_start("b", URL, None, None, None, 60_000).unwrap();
        store
            .connect_finish(&failed.id, "failed", None, None, Some("token endpoint returned error=access_denied sk-abcdefghijklmnopq"))
            .unwrap();
        let link = store.read_link("b").unwrap().unwrap();
        assert_eq!(link.status, "error");
        assert!(link.detail.as_deref().unwrap().contains("[redacted]"), "credentials are masked before storage");

        let expiring = store.connect_start("c", URL, None, None, None, 60_000).unwrap();
        store.connect_finish(&expiring.id, "connected", Some("late login"), None, None).unwrap();
        // a replayed finish hits the frozen terminal state, not a second write
        assert_eq!(
            store.connect_finish(&expiring.id, "cancelled", None, None, None).unwrap_err().kind,
            AuthLinkErrorKind::Conflict
        );
    }

    #[test]
    fn op_expiry_closes_the_window_and_frees_the_link() {
        let (store, _home) = store("expiry");
        store.ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription").unwrap();
        store.connect_start("codex", URL, None, None, None, 1).unwrap();
        // The op deadline (1ms) has passed by the time we look again.
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert!(store.live_op("codex").unwrap().is_none(), "expired ops never come back live");
        let link = store.read_link("codex").unwrap().unwrap();
        assert_eq!(link.status, "expired", "the window is visibly closed, not silently kept open");
        // and the slot is free again
        store.connect_start("codex", URL, None, None, None, 60_000).unwrap();
    }

    #[test]
    fn detection_drives_status_and_missing_cli_is_never_connected() {
        let (store, _home) = store("detect");
        store.ensure_link("claude-cli", "cli", "Claude Code CLI", "subscription").unwrap();
        // CLI missing: status error-ish honesty, detail explains.
        let link = store
            .apply_detection(
                "claude-cli",
                Some(1),
                json!({"installed": false, "version": null}),
                None,
                None,
            )
            .unwrap();
        assert_eq!(link.status, "error");
        assert!(link.detail.as_deref().unwrap().to_lowercase().contains("not installed"));
        // detector does not report authentication → not connected
        let link = store
            .apply_detection("claude-cli", None, json!({"installed": true, "authenticated": false}), None, None)
            .unwrap();
        assert_eq!(link.status, "disconnected");
        // authenticated with quota fact
        let link = store
            .apply_detection(
                "claude-cli",
                None,
                json!({"installed": true, "authenticated": true, "accountAlias": "dev@team"}),
                Some("subscription"),
                None,
            )
            .unwrap();
        assert_eq!(link.status, "connected");
        assert_eq!(link.quota_type, "subscription");
        // stale session: expired, never a silent reconnect
        let link = store.mark_expired("claude-cli", Some("refresh rejected")).unwrap();
        assert_eq!(link.status, "expired");
    }

    #[test]
    fn disconnect_clears_local_state_without_touching_external_cli() {
        let (store, _home) = store("disconnect");
        store.ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription").unwrap();
        let op = store.connect_start("codex", URL, None, Some("s".into()), None, 60_000).unwrap();
        let link = store.disconnect("codex", None).unwrap();
        assert_eq!(link.status, "disconnected");
        assert!(link.account_alias.is_none() && link.login_url.is_none());
        assert!(store.live_op("codex").unwrap().is_none(), "disconnect cancels the live op");
        let op_after: AuthConnectOp =
            AuthLinkStore::read_json(&store.ops_dir().join(format!("{}.json", op.id))).unwrap();
        assert_eq!(op_after.state, "cancelled");
    }

    #[test]
    fn redaction_masks_secret_shaped_text_and_keeps_normal_writing() {
        assert_eq!(redact("login ok"), "login ok");
        assert_eq!(redact("bearer 0123456789abcdefghij"), "bearer [redacted]");
        assert!(redact("see sk-123456789012345678 below").contains("[redacted]"));
        assert_eq!(redact("v1.2.3"), "v1.2.3", "versions survive");
    }
}
