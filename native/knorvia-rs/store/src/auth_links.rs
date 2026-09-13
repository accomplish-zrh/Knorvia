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
use std::io::Write;
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
    /// Machine-readable probe terminal (`completed`, `timed_out`,
    /// `cancelled`, `unavailable`). Authentication stays absent when the
    /// probe did not establish it.
    pub probe_status: Option<String>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
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

/// Recoverable after-images for the two records that make up an auth
/// transition.  The intent is persisted before either projection and is
/// removed only after both projections are durable.  Replaying an intent is
/// idempotent, so a crash can leave the old pair or the new pair temporarily,
/// but the first subsequent read repairs it to the complete new pair.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AuthPairIntent {
    version: u32,
    id: String,
    link_id: String,
    op_id: String,
    link: AuthLinkRecord,
    op: AuthConnectOp,
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
    Err(AuthLinkError {
        kind,
        message: message.into(),
    })
}

static AUTH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
thread_local! {
    static AUTH_FAIL_STAGE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn set_auth_fail_stage(stage: u64) {
    AUTH_FAIL_STAGE.with(|slot| slot.set(stage));
}

fn auth_failpoint(stage: u64) -> Result<(), AuthLinkError> {
    #[cfg(test)]
    if AUTH_FAIL_STAGE.with(|slot| {
        if slot.get() == stage {
            slot.set(0);
            true
        } else {
            false
        }
    }) {
        return err(
            AuthLinkErrorKind::Io,
            format!("injected auth transaction failure after stage {stage}"),
        );
    }
    let _ = stage;
    Ok(())
}

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
    knorvia_protocol::sanitize_diagnostic(text)
}

fn sanitize_link_record(record: &mut AuthLinkRecord) {
    record.account_alias = record.account_alias.as_deref().map(redact);
    record.detail = record.detail.as_deref().map(redact);
    record.capabilities = record
        .capabilities
        .as_ref()
        .map(knorvia_protocol::sanitize_diagnostic_value);
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
    fn intents_dir(&self) -> PathBuf {
        self.root.join("intents")
    }
    fn link_path(&self, id: &str) -> PathBuf {
        self.links_dir().join(format!("{id}.json"))
    }

    fn write_json(path: &Path, value: &impl Serialize) -> Result<(), AuthLinkError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AuthLinkError {
                kind: AuthLinkErrorKind::Io,
                message: e.to_string(),
            })?;
        }
        let bytes = serde_json::to_vec_pretty(value).map_err(|e| AuthLinkError {
            kind: AuthLinkErrorKind::Corrupt,
            message: e.to_string(),
        })?;
        let tmp = path.with_file_name(format!(
            ".{}.{}.tmp",
            std::process::id(),
            AUTH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        // Auth records carry temporary OAuth secrets (PKCE verifier,
        // state, authorize URL): staging file and final record are both
        // created owner-only, and the atomic rename keeps the ACL.
        let mut file = open_private_new(&tmp)?;
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = std::fs::remove_file(&tmp);
            return err(AuthLinkErrorKind::Io, error.to_string());
        }
        drop(file);
        if let Err(error) = std::fs::rename(&tmp, path) {
            let _ = std::fs::remove_file(&tmp);
            return err(AuthLinkErrorKind::Io, error.to_string());
        }
        super::sync_parent_dir(path).map_err(|error| AuthLinkError {
            kind: AuthLinkErrorKind::Io,
            message: error.to_string(),
        })?;
        Ok(())
    }

    fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, AuthLinkError> {
        let bytes = std::fs::read(path).map_err(|e| AuthLinkError {
            kind: AuthLinkErrorKind::Io,
            message: e.to_string(),
        })?;
        serde_json::from_slice(&bytes).map_err(|e| AuthLinkError {
            kind: AuthLinkErrorKind::Corrupt,
            message: format!("{}: {e}", path.display()),
        })
    }

    fn read_link_raw(&self, id: &str) -> Result<Option<AuthLinkRecord>, AuthLinkError> {
        let path = self.link_path(id);
        if !path.exists() {
            return Ok(None);
        }
        let mut record = Self::read_json(&path)?;
        // Old Homes may predate the unified sanitizer. Never echo their raw
        // diagnostic fields through read/list even before a new mutation has
        // rewritten the record.
        sanitize_link_record(&mut record);
        Ok(Some(record))
    }

    fn op_path(&self, id: &str) -> PathBuf {
        self.ops_dir().join(format!("{id}.json"))
    }

    fn intent_path(&self, id: &str) -> PathBuf {
        self.intents_dir().join(format!("{id}.json"))
    }

    fn list_ops_raw(&self) -> Result<Vec<AuthConnectOp>, AuthLinkError> {
        let entries = match std::fs::read_dir(self.ops_dir()) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return err(AuthLinkErrorKind::Io, e.to_string()),
        };
        let mut ops = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| AuthLinkError {
                kind: AuthLinkErrorKind::Io,
                message: e.to_string(),
            })?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                ops.push(Self::read_json(&path)?);
            }
        }
        ops.sort_by(|a: &AuthConnectOp, b: &AuthConnectOp| {
            a.created_at_ms.cmp(&b.created_at_ms).then(a.id.cmp(&b.id))
        });
        Ok(ops)
    }

    fn validate_intent(intent: &AuthPairIntent) -> Result<(), AuthLinkError> {
        if intent.version != 1
            || intent.id.is_empty()
            || intent.link_id != intent.link.id
            || intent.link_id != intent.op.link_id
            || intent.op_id != intent.op.id
        {
            return err(
                AuthLinkErrorKind::Corrupt,
                format!("invalid auth transaction intent {:?}", intent.id),
            );
        }
        sanitize_link_id(&intent.link_id)?;
        if matches!(
            intent.op.state.as_str(),
            "completed" | "cancelled" | "expired" | "failed"
        ) && (intent.op.oauth_state.is_some()
            || intent.op.pkce_verifier.is_some()
            || intent.op.authorize_url.is_some()
            || intent.op.redirect_port.is_some())
        {
            return err(
                AuthLinkErrorKind::Corrupt,
                format!(
                    "terminal auth transaction {} retains temporary secrets",
                    intent.id
                ),
            );
        }
        if intent.op.state == "waiting"
            && (intent.link.status != "needs-user"
                || intent.link.login_url != intent.op.authorize_url
                || intent.link.login_expires_at_ms != Some(intent.op.expires_at_ms))
        {
            return err(
                AuthLinkErrorKind::Corrupt,
                format!(
                    "auth transaction {} has inconsistent waiting projections",
                    intent.id
                ),
            );
        }
        if intent.op.state == "exchanging" && intent.link.status != "connecting" {
            return err(
                AuthLinkErrorKind::Corrupt,
                format!(
                    "auth transaction {} has inconsistent exchange projections",
                    intent.id
                ),
            );
        }
        Ok(())
    }

    /// Repair any transaction which was interrupted between the op and link
    /// writes.  Corrupt or overlapping intents are ambiguous and therefore
    /// fail closed instead of guessing that a login succeeded.
    fn recover_transactions(&self) -> Result<(), AuthLinkError> {
        let entries = match std::fs::read_dir(self.intents_dir()) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return err(AuthLinkErrorKind::Io, e.to_string()),
        };
        let mut intents = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| AuthLinkError {
                kind: AuthLinkErrorKind::Io,
                message: e.to_string(),
            })?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let intent: AuthPairIntent = Self::read_json(&path)?;
            Self::validate_intent(&intent)?;
            intents.push((path, intent));
        }
        intents.sort_by(|a, b| a.1.id.cmp(&b.1.id));
        let mut seen = std::collections::HashSet::new();
        for (_, intent) in &intents {
            if !seen.insert(intent.link_id.clone()) {
                return err(
                    AuthLinkErrorKind::Corrupt,
                    format!(
                        "multiple unfinished auth transactions for link {}",
                        intent.link_id
                    ),
                );
            }
        }
        for (path, mut intent) in intents {
            sanitize_link_record(&mut intent.link);
            // Operation first is deliberate: a repaired `needs-user` link can
            // never be visible without the matching operation and its state.
            Self::write_json(&self.op_path(&intent.op_id), &intent.op)?;
            Self::write_json(&self.link_path(&intent.link_id), &intent.link)?;
            std::fs::remove_file(&path).map_err(|e| AuthLinkError {
                kind: AuthLinkErrorKind::Io,
                message: e.to_string(),
            })?;
            super::sync_parent_dir(&path).map_err(|e| AuthLinkError {
                kind: AuthLinkErrorKind::Io,
                message: e.to_string(),
            })?;
        }
        Ok(())
    }

    fn commit_pair(&self, mut link: AuthLinkRecord, op: AuthConnectOp) -> Result<(), AuthLinkError> {
        self.recover_transactions()?;
        sanitize_link_record(&mut link);
        let id = format!(
            "authtxn_{:013x}_{:04x}",
            now_ms(),
            AUTH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let intent = AuthPairIntent {
            version: 1,
            id: id.clone(),
            link_id: link.id.clone(),
            op_id: op.id.clone(),
            link,
            op,
        };
        Self::validate_intent(&intent)?;
        let intent_path = self.intent_path(&id);
        Self::write_json(&intent_path, &intent)?;
        auth_failpoint(1)?;
        Self::write_json(&self.op_path(&intent.op_id), &intent.op)?;
        auth_failpoint(2)?;
        Self::write_json(&self.link_path(&intent.link_id), &intent.link)?;
        auth_failpoint(3)?;
        std::fs::remove_file(&intent_path).map_err(|e| AuthLinkError {
            kind: AuthLinkErrorKind::Io,
            message: e.to_string(),
        })?;
        super::sync_parent_dir(&intent_path).map_err(|e| AuthLinkError {
            kind: AuthLinkErrorKind::Io,
            message: e.to_string(),
        })?;
        Ok(())
    }

    fn reconcile_link_projection(&self, id: &str) -> Result<Option<AuthLinkRecord>, AuthLinkError> {
        let Some(mut link) = self.read_link_raw(id)? else {
            return Ok(None);
        };
        let at = now_ms();
        let active: Vec<_> = self
            .list_ops_raw()?
            .into_iter()
            .filter(|op| {
                op.link_id == id
                    && matches!(op.state.as_str(), "waiting" | "exchanging")
                    && op.expires_at_ms >= at
            })
            .collect();
        if active.len() > 1 {
            return err(
                AuthLinkErrorKind::Corrupt,
                format!("auth link {id} has multiple live connect operations"),
            );
        }
        let mut changed = false;
        if let Some(op) = active.first() {
            let desired = if op.state == "waiting" {
                "needs-user"
            } else {
                "connecting"
            };
            if link.status != desired
                || link.login_url != op.authorize_url
                || link.login_expires_at_ms != Some(op.expires_at_ms)
            {
                link.status = desired.into();
                link.login_url = op.authorize_url.clone();
                link.login_expires_at_ms = Some(op.expires_at_ms);
                link.detail = None;
                changed = true;
            }
        } else if matches!(link.status.as_str(), "needs-user" | "connecting") {
            // No transaction intent and no live operation is evidence only of
            // an incomplete/legacy write.  Success is unknown, so fail closed
            // and free the link for a direct reconnect.
            link.status = "error".into();
            link.login_url = None;
            link.login_expires_at_ms = None;
            link.detail = Some("incomplete login state recovered; start login again".into());
            changed = true;
        }
        if changed {
            link.revision += 1;
            link.updated_at_ms = at;
            Self::write_json(&self.link_path(id), &link)?;
        }
        Ok(Some(link))
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
            return err(
                AuthLinkErrorKind::InvalidArgument,
                format!("unknown auth link kind {kind:?}"),
            );
        }
        if !QUOTA_TYPES.contains(&quota_type) {
            return err(
                AuthLinkErrorKind::InvalidArgument,
                format!("unknown quota type {quota_type:?}"),
            );
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
        self.recover_transactions()?;
        self.reconcile_link_projection(id)
    }

    pub fn list_links(&self) -> Result<Vec<AuthLinkRecord>, AuthLinkError> {
        self.recover_transactions()?;
        self.sweep_expired()?;
        let mut links = Vec::new();
        let entries = match std::fs::read_dir(self.links_dir()) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(links),
            Err(e) => return err(AuthLinkErrorKind::Io, e.to_string()),
        };
        for entry in entries {
            let entry = entry.map_err(|e| AuthLinkError {
                kind: AuthLinkErrorKind::Io,
                message: e.to_string(),
            })?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                let record: AuthLinkRecord = Self::read_json(&path)?;
                if let Some(reconciled) = self.reconcile_link_projection(&record.id)? {
                    links.push(reconciled);
                }
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
        let record = self.read_link(id)?.ok_or_else(|| AuthLinkError {
            kind: AuthLinkErrorKind::NotFound,
            message: format!("auth link {id} not found"),
        })?;
        if let Some(expected) = expected_revision {
            if expected != record.revision {
                return err(
                    AuthLinkErrorKind::Conflict,
                    format!(
                        "auth link {id} is at revision {}, caller expected {expected}",
                        record.revision
                    ),
                );
            }
        }
        let mut updated = apply(record)?;
        sanitize_link_record(&mut updated);
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
        sanitize_link_id(link_id)?;
        if self.live_op(link_id)?.is_some() {
            return err(
                AuthLinkErrorKind::Conflict,
                format!("auth link {link_id} already has a live connect operation"),
            );
        }
        // `live_op` also closes an expired predecessor, so reconnect works
        // directly after a timeout without requiring a list/read side effect.
        let mut record = self.read_link_raw(link_id)?.ok_or_else(|| AuthLinkError {
            kind: AuthLinkErrorKind::NotFound,
            message: format!("auth link {link_id} not found"),
        })?;
        let op = AuthConnectOp {
            id: format!(
                "authop_{at:013x}_{:04x}",
                AUTH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ),
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
        record.revision += 1;
        record.status = "needs-user".into();
        record.login_url = Some(authorize_url.to_string());
        record.login_expires_at_ms = Some(op.expires_at_ms);
        record.detail = None;
        record.updated_at_ms = at;
        self.commit_pair(record, op.clone())?;
        Ok(op)
    }

    /// Drop every temporary sensitive field from a terminal op: the
    /// verifier, the state, and the state-bearing authorize URL have no
    /// value once the op is finished and must not sit in the Home.
    fn scrub_op(op: &mut AuthConnectOp) {
        op.oauth_state = None;
        op.pkce_verifier = None;
        op.authorize_url = None;
        op.redirect_port = None;
    }

    /// Expire one live op in place: typed `expired` state with its
    /// temporary secrets scrubbed, and the link returned to a clear
    /// non-fake state.
    fn expire_op(&self, mut op: AuthConnectOp) -> Result<(), AuthLinkError> {
        let link_id = op.link_id.clone();
        let at = now_ms();
        op.state = "expired".into();
        op.updated_at_ms = at;
        Self::scrub_op(&mut op);
        let mut record = self.read_link_raw(&link_id)?.ok_or_else(|| AuthLinkError {
            kind: AuthLinkErrorKind::Corrupt,
            message: format!("auth op {} refers to missing link {link_id}", op.id),
        })?;
        record.revision += 1;
        record.updated_at_ms = at;
        // A legacy/bad state may contain an older expired op next to a newer
        // live one. Expiring the old op must not close or rewrite the newer
        // operation's login window.
        let other_live = self.list_ops_raw()?.into_iter().rev().find(|candidate| {
            candidate.id != op.id
                && candidate.link_id == link_id
                && matches!(candidate.state.as_str(), "waiting" | "exchanging")
                && candidate.expires_at_ms >= at
        });
        if let Some(active) = other_live {
            record.status = if active.state == "waiting" {
                "needs-user".into()
            } else {
                "connecting".into()
            };
            record.login_url = active.authorize_url.clone();
            record.login_expires_at_ms = Some(active.expires_at_ms);
        } else {
            record.status = "expired".into();
            record.login_url = None;
            record.login_expires_at_ms = None;
        }
        self.commit_pair(record, op)
    }
    /// The live op for a link, resolving expiry first: an op past its
    /// deadline becomes `expired` and the link returns to `disconnected`
    /// — a stale login window never pretends to still be open.
    pub fn live_op(&self, link_id: &str) -> Result<Option<AuthConnectOp>, AuthLinkError> {
        sanitize_link_id(link_id)?;
        self.recover_transactions()?;
        let mut live: Option<AuthConnectOp> = None;
        for op in self.list_ops_raw()? {
            if op.link_id != link_id {
                continue;
            }
            if op.state == "waiting" || op.state == "exchanging" {
                if now_ms() > op.expires_at_ms {
                    self.expire_op(op)?;
                    continue;
                }
                if live.is_some() {
                    return err(
                        AuthLinkErrorKind::Corrupt,
                        format!("auth link {link_id} has multiple live connect operations"),
                    );
                }
                live = Some(op);
            }
        }
        Ok(live)
    }

    /// Bounded expiry sweep for startup and list surfaces: every live op
    /// past its deadline becomes `expired` with temporary secrets
    /// scrubbed, and stuck links return to a clear state. Scans the ops
    /// directory once; never touches terminal ops.
    pub fn sweep_expired(&self) -> Result<(usize, Vec<String>), AuthLinkError> {
        self.recover_transactions()?;
        let mut swept = 0usize;
        let mut link_ids: Vec<String> = Vec::new();
        for op in self.list_ops_raw()? {
            if (op.state == "waiting" || op.state == "exchanging") && now_ms() > op.expires_at_ms {
                link_ids.push(op.link_id.clone());
                self.expire_op(op)?;
                swept += 1;
            }
        }
        Ok((swept, link_ids))
    }
    /// Progress a live op (`exchanging` after the callback arrived).
    pub fn op_exchanging(&self, op_id: &str) -> Result<AuthConnectOp, AuthLinkError> {
        self.recover_transactions()?;
        let path = self.op_path(op_id);
        if !path.exists() {
            return err(
                AuthLinkErrorKind::NotFound,
                format!("auth op {op_id} not found"),
            );
        }
        let mut op: AuthConnectOp = Self::read_json(&path)?;
        if op.state != "waiting" {
            return err(
                AuthLinkErrorKind::Conflict,
                format!("auth op {op_id} is {}, not waiting", op.state),
            );
        }
        let at = now_ms();
        op.state = "exchanging".into();
        op.updated_at_ms = at;
        let mut link = self
            .read_link_raw(&op.link_id)?
            .ok_or_else(|| AuthLinkError {
                kind: AuthLinkErrorKind::Corrupt,
                message: format!("auth op {op_id} refers to missing link {}", op.link_id),
            })?;
        link.revision += 1;
        link.updated_at_ms = at;
        link.status = "connecting".into();
        link.login_url = None;
        link.login_expires_at_ms = Some(op.expires_at_ms);
        self.commit_pair(link, op.clone())?;
        Ok(op)
    }

    /// Validate a redirect's OAuth `state` against the live op and
    /// progress it waiting → exchanging. A wrong state is rejected
    /// before any progress; a replayed callback on a progressed or
    /// finished op is a typed conflict. No token exchange happens here —
    /// this validation is for the local loopback flow only.
    pub fn connect_callback(
        &self,
        link_id: &str,
        state: &str,
    ) -> Result<AuthConnectOp, AuthLinkError> {
        sanitize_link_id(link_id)?;
        let op = self.live_op(link_id)?.ok_or_else(|| AuthLinkError {
            kind: AuthLinkErrorKind::NotFound,
            message: format!("auth link {link_id} has no live connect operation"),
        })?;
        if op.state != "waiting" {
            return err(
                AuthLinkErrorKind::Conflict,
                format!("auth op {} is {}, not waiting", op.id, op.state),
            );
        }
        let Some(recorded) = op.oauth_state.as_deref() else {
            return err(
                AuthLinkErrorKind::Corrupt,
                format!("auth op {} has no recorded oauth state", op.id),
            );
        };
        if recorded != state {
            return err(
                AuthLinkErrorKind::InvalidArgument,
                "oauth state does not match the connect operation",
            );
        }
        self.op_exchanging(&op.id)
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
        self.recover_transactions()?;
        let path = self.op_path(op_id);
        if !path.exists() {
            return err(
                AuthLinkErrorKind::NotFound,
                format!("auth op {op_id} not found"),
            );
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
                return err(
                    AuthLinkErrorKind::InvalidArgument,
                    format!("unknown quota type {quota:?}"),
                );
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
                return err(
                    AuthLinkErrorKind::InvalidArgument,
                    format!("unknown outcome {other:?}"),
                );
            }
        };
        // Terminal op states are frozen: a replayed finish is a conflict,
        // not a second write (duplicate terminal events must not re-count).
        // The frozen record also drops the temporary secrets: a finished
        // op must not leave a PKCE verifier, state or authorize URL in
        // the Home.
        let mut frozen = op.clone();
        frozen.state = terminal.to_string();
        let at = now_ms();
        frozen.updated_at_ms = at;
        Self::scrub_op(&mut frozen);
        let mut record = self.read_link_raw(&link_id)?.ok_or_else(|| AuthLinkError {
            kind: AuthLinkErrorKind::Corrupt,
            message: format!("auth op {op_id} refers to missing link {link_id}"),
        })?;
        record.revision += 1;
        record.updated_at_ms = at;
        record.login_url = None;
        record.login_expires_at_ms = None;
        match terminal {
            "completed" => {
                record.status = "connected".into();
                record.account_alias = account_alias.map(redact);
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
        self.commit_pair(record, frozen.clone())?;
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
                return err(
                    AuthLinkErrorKind::InvalidArgument,
                    format!("unknown quota type {quota:?}"),
                );
            }
        }
        self.mutate(link_id, expected_revision, |mut record| {
            let authenticated = capabilities["authenticated"].as_bool();
            let installed = capabilities["installed"].as_bool();
            record.capabilities = Some(knorvia_protocol::sanitize_diagnostic_value(&capabilities));
            record.detail = detail.map(redact);
            if authenticated == Some(true) {
                record.status = "connected".into();
                if let Some(alias) = record
                    .capabilities
                    .as_ref()
                    .and_then(|c| c["accountAlias"].as_str())
                {
                    record.account_alias = Some(redact(alias));
                }
                if let Some(quota) = quota_type {
                    record.quota_type = quota.to_string();
                }
            } else if record.status != "needs-user" && record.status != "connecting" {
                record.status = if installed == Some(true) && authenticated == Some(false) {
                    "disconnected".into()
                } else {
                    // Missing/unusable/timed-out probes and installed CLIs
                    // with no explicit authentication fact stay unknown.
                    // `error` is the existing honest non-connected product
                    // state; capabilities carry the exact probe terminal.
                    "error".into()
                };
                if installed == Some(false) {
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
    pub fn disconnect(
        &self,
        link_id: &str,
        expected_revision: Option<u64>,
    ) -> Result<AuthLinkRecord, AuthLinkError> {
        // An in-flight op is cancelled first so the single-flight slot frees.
        if let Some(op) = self.live_op(link_id)? {
            let at = now_ms();
            let mut cancelled = op.clone();
            cancelled.state = "cancelled".into();
            cancelled.updated_at_ms = at;
            Self::scrub_op(&mut cancelled);
            let mut record = self.read_link_raw(link_id)?.ok_or_else(|| AuthLinkError {
                kind: AuthLinkErrorKind::NotFound,
                message: format!("auth link {link_id} not found"),
            })?;
            if expected_revision.is_some_and(|expected| expected != record.revision) {
                return err(
                    AuthLinkErrorKind::Conflict,
                    format!(
                        "auth link {link_id} is at revision {}, caller expected {}",
                        record.revision,
                        expected_revision.unwrap()
                    ),
                );
            }
            record.revision += 1;
            record.updated_at_ms = at;
            record.status = "disconnected".into();
            record.account_alias = None;
            record.login_url = None;
            record.login_expires_at_ms = None;
            record.detail = None;
            self.commit_pair(record.clone(), cancelled)?;
            return Ok(record);
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
    pub fn mark_expired(
        &self,
        link_id: &str,
        detail: Option<&str>,
    ) -> Result<AuthLinkRecord, AuthLinkError> {
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
        let first = store
            .ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription")
            .unwrap();
        assert_eq!(first.status, "disconnected");
        assert_eq!(first.quota_type, "subscription");
        let again = store
            .ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription")
            .unwrap();
        assert_eq!(
            again.revision, first.revision,
            "bootstrap twice keeps one link"
        );
        assert_eq!(store.list_links().unwrap().len(), 1);
        assert_eq!(
            store
                .ensure_link("bogus", "widget", "x", "unknown")
                .unwrap_err()
                .kind,
            AuthLinkErrorKind::InvalidArgument
        );
    }

    #[test]
    fn connect_flow_walks_needs_user_to_connected_and_is_single_flight() {
        let (store, _home) = store("flow");
        store
            .ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription")
            .unwrap();
        let op = store
            .connect_start(
                "codex",
                URL,
                Some(1455),
                Some("state-abc".into()),
                None,
                600_000,
            )
            .unwrap();
        assert_eq!(op.state, "waiting");
        let link = store.read_link("codex").unwrap().unwrap();
        assert_eq!(link.status, "needs-user");
        assert_eq!(link.login_url.as_deref(), Some(URL));
        // single flight: a second start is refused while this op is live
        assert_eq!(
            store
                .connect_start("codex", URL, None, None, None, 60_000)
                .unwrap_err()
                .kind,
            AuthLinkErrorKind::Conflict
        );
        // callback arrived → exchanging → completed with facts
        store.op_exchanging(&op.id).unwrap();
        let done = store
            .connect_finish(
                &op.id,
                "connected",
                Some("user@example.com (Pro)"),
                Some("subscription"),
                None,
            )
            .unwrap();
        assert_eq!(done.state, "completed");
        let link = store.read_link("codex").unwrap().unwrap();
        assert_eq!(link.status, "connected");
        assert_eq!(
            link.account_alias.as_deref(),
            Some("user@example.com (Pro)")
        );
        assert_eq!(
            link.quota_type, "subscription",
            "subscription stays labeled as subscription"
        );
        assert!(link.login_url.is_none());
        // finished op frees the slot
        let next = store
            .connect_start("codex", URL, None, None, None, 60_000)
            .unwrap();
        assert_ne!(next.id, op.id);
    }

    #[test]
    fn cancel_expire_and_failure_land_in_clear_states() {
        let (store, _home) = store("outcomes");
        for link in ["a", "b", "c"] {
            store.ensure_link(link, "oauth", link, "unknown").unwrap();
        }
        let cancelled = store
            .connect_start("a", URL, None, None, None, 60_000)
            .unwrap();
        store
            .connect_finish(
                &cancelled.id,
                "cancelled",
                None,
                None,
                Some("user closed the window"),
            )
            .unwrap();
        assert_eq!(
            store.read_link("a").unwrap().unwrap().status,
            "disconnected"
        );

        let failed = store
            .connect_start("b", URL, None, None, None, 60_000)
            .unwrap();
        store
            .connect_finish(
                &failed.id,
                "failed",
                None,
                None,
                Some("token endpoint returned error=access_denied sk-abcdefghijklmnopq"),
            )
            .unwrap();
        let link = store.read_link("b").unwrap().unwrap();
        assert_eq!(link.status, "error");
        assert!(
            link.detail.as_deref().unwrap().contains("[redacted]"),
            "credentials are masked before storage"
        );

        let expiring = store
            .connect_start("c", URL, None, None, None, 60_000)
            .unwrap();
        store
            .connect_finish(&expiring.id, "connected", Some("late login"), None, None)
            .unwrap();
        // a replayed finish hits the frozen terminal state, not a second write
        assert_eq!(
            store
                .connect_finish(&expiring.id, "cancelled", None, None, None)
                .unwrap_err()
                .kind,
            AuthLinkErrorKind::Conflict
        );
    }

    #[test]
    fn op_expiry_closes_the_window_and_frees_the_link() {
        let (store, _home) = store("expiry");
        store
            .ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription")
            .unwrap();
        store
            .connect_start("codex", URL, None, None, None, 1)
            .unwrap();
        // The op deadline (1ms) has passed by the time we look again.
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert!(
            store.live_op("codex").unwrap().is_none(),
            "expired ops never come back live"
        );
        let link = store.read_link("codex").unwrap().unwrap();
        assert_eq!(
            link.status, "expired",
            "the window is visibly closed, not silently kept open"
        );
        // and the slot is free again
        store
            .connect_start("codex", URL, None, None, None, 60_000)
            .unwrap();
    }

    #[test]
    fn detection_drives_status_and_missing_cli_is_never_connected() {
        let (store, _home) = store("detect");
        store
            .ensure_link("claude-cli", "cli", "Claude Code CLI", "subscription")
            .unwrap();
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
        assert!(
            link.detail
                .as_deref()
                .unwrap()
                .to_lowercase()
                .contains("not installed")
        );
        // detector does not report authentication → not connected
        let link = store
            .apply_detection(
                "claude-cli",
                None,
                json!({"installed": true, "authenticated": false}),
                None,
                None,
            )
            .unwrap();
        assert_eq!(link.status, "disconnected");
        // A launched-but-timed-out CLI proves installation only. It does
        // not prove logged-out, so the public status remains an honest error
        // with the exact machine-readable probe terminal.
        let link = store
            .apply_detection(
                "claude-cli",
                None,
                json!({"installed": true, "probeStatus": "timed_out"}),
                None,
                Some("claude account probe timed out"),
            )
            .unwrap();
        assert_eq!(link.status, "error");
        assert_eq!(
            link.capabilities.as_ref().unwrap()["probeStatus"],
            json!("timed_out")
        );
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
        let link = store
            .mark_expired("claude-cli", Some("refresh rejected"))
            .unwrap();
        assert_eq!(link.status, "expired");
    }

    #[test]
    fn disconnect_clears_local_state_without_touching_external_cli() {
        let (store, _home) = store("disconnect");
        store
            .ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription")
            .unwrap();
        let op = store
            .connect_start("codex", URL, None, Some("s".into()), None, 60_000)
            .unwrap();
        let link = store.disconnect("codex", None).unwrap();
        assert_eq!(link.status, "disconnected");
        assert!(link.account_alias.is_none() && link.login_url.is_none());
        assert!(
            store.live_op("codex").unwrap().is_none(),
            "disconnect cancels the live op"
        );
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

/// Create a new file that only the owning user can read. Auth ops carry
/// temporary OAuth secrets, so broad workspace/workspace-parent ACLs
/// must not inherit onto them.
#[cfg(unix)]
fn open_private_new(path: &Path) -> Result<std::fs::File, AuthLinkError> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| AuthLinkError {
            kind: AuthLinkErrorKind::Io,
            message: e.to_string(),
        })
}

#[cfg(windows)]
fn open_private_new(path: &Path) -> Result<std::fs::File, AuthLinkError> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{GENERIC_WRITE, INVALID_HANDLE_VALUE, LocalFree};
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL};
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // Protected DACL: only the file owner (same policy as the daemon
    // endpoint publication file). No inheritance from broader ACLs.
    let sddl: Vec<u16> = "D:P(A;;FA;;;OW)\0".encode_utf16().collect();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: terminated UTF-16 inputs; descriptor is freed after CreateFileW.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(AuthLinkError {
                kind: AuthLinkErrorKind::Io,
                message: std::io::Error::last_os_error().to_string(),
            });
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let handle = CreateFileW(
            name.as_ptr(),
            GENERIC_WRITE,
            0,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        );
        let error = std::io::Error::last_os_error();
        LocalFree(descriptor);
        if handle == INVALID_HANDLE_VALUE {
            return Err(AuthLinkError {
                kind: AuthLinkErrorKind::Io,
                message: error.to_string(),
            });
        }
        Ok(std::fs::File::from_raw_handle(handle))
    }
}

#[cfg(test)]
#[path = "auth_links_tests.rs"]
mod auth_links_tests;
