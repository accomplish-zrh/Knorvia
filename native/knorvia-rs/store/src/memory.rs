//! Durable, versioned, scope-isolated memory records.
//!
//! Design contract (night-shift CONTRACTS.md §"记忆：事实、范围和证据"):
//! every record carries a four-axis scope `(owner, workspace, bot,
//! conversation)` and is only ever recalled through scope filtering before
//! ranking, so a secret noted in one group conversation can never surface
//! in another group or a DM unless the user explicitly shared it there.
//! Every mutation appends a revision snapshot (the audit trail) and keeps
//! forgotten/merged records out of recall without deleting them.
//!
//! The module is deliberately self-contained (only `serde`/`serde_json`
//! plus std) so the semantics can be exercised in isolation; the product
//! store re-exports it and the control plane wraps it in typed RPC.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

mod embedding;
mod import_ops;
mod index;
pub use embedding::MemoryEmbeddingQuery;
pub use import_ops::{MemoryImportPlan, MemoryImportReceipt};
use index::MemorySearchIndex;

/// Process-wide count of record-file reads, used by the recall benchmark to
/// report how many authoritative files each strategy actually touches.
pub static DISK_READS: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Four-axis isolation scope. `owner` is always a concrete account id.
/// The other axes may be `"*"` meaning "all of this lower axis" (e.g. a
/// workspace-wide note keeps `conversation: "*"`). Scope widening is a
/// deliberate revision (`memory/share`), never implicit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryScope {
    pub owner: String,
    pub workspace: String,
    pub bot: String,
    pub conversation: String,
}

/// Per-axis query. `None` means "no filter on this axis" (browse mode);
/// recall from a live conversation must pass concrete values on every axis
/// so records anchored to other conversations cannot match.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScopeQuery {
    pub owner: String,
    pub workspace: Option<String>,
    pub bot: Option<String>,
    pub conversation: Option<String>,
}

impl ScopeQuery {
    /// Browsing an owner's traces is allowed, but a concrete conversation
    /// cannot read a trace produced for another or an all-scope search.
    pub fn includes_trace_scope(&self, trace: &Self) -> bool {
        let axis = |viewer: &Option<String>, origin: &Option<String>| {
            viewer
                .as_deref()
                .is_none_or(|value| value == "*" || origin.as_deref() == Some(value))
        };
        self.owner == trace.owner
            && axis(&self.workspace, &trace.workspace)
            && axis(&self.bot, &trace.bot)
            && axis(&self.conversation, &trace.conversation)
    }
    /// One axis matches when the query does not filter it, the record side
    /// is wildcarded (shared to the whole upper axis), or both are equal.
    /// One axis matches when the query does not filter it, the query
    /// itself is the browse-all wildcard ("*"), the record side is
    /// wildcarded (shared to the whole upper axis), or both are equal.
    fn axis(record: &str, query: Option<&str>) -> bool {
        match query {
            None => true,
            Some(q) => q == "*" || record == "*" || record == q,
        }
    }

    fn matches_scope(&self, scope: &MemoryScope) -> bool {
        scope.owner == self.owner
            && Self::axis(&scope.workspace, self.workspace.as_deref())
            && Self::axis(&scope.bot, self.bot.as_deref())
            && Self::axis(&scope.conversation, self.conversation.as_deref())
    }

    /// A record is visible from this query through its own scope or through
    /// an explicit share scope. Private-by-default: no share, no cross view.
    pub fn visible_from(&self, record: &MemoryRecord) -> bool {
        self.matches_scope(&record.scope)
            || record.shared_scopes.iter().any(|s| self.matches_scope(s))
    }
}

/// Where a fact came from. `kind` is one of `turn`, `item`, `artifact`,
/// `document`, `external` — provenance shown in the evidence panel; the
/// store never invents refs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemorySourceRef {
    pub kind: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A directed relation to another record. `inferred: true` marks a
/// model-suggested link; only explicitly evidenced relations may be
/// presented as fact. Graph edges are derived exclusively from these.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRelation {
    pub target_id: String,
    pub relation_type: String,
    #[serde(default)]
    pub inferred: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub revision: u64,
    pub scope: MemoryScope,
    /// Explicit extra scopes this record was shared into (each widening is
    /// its own audited revision).
    #[serde(default)]
    pub shared_scopes: Vec<MemoryScope>,
    /// Open vocabulary: `fact`, `preference`, `event`, `relation`, `goal`,
    /// `skill`, `note`, … — validated for shape, not enumerated.
    pub kind: String,
    pub content: String,
    #[serde(default)]
    pub source_refs: Vec<MemorySourceRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation: Option<MemoryRelation>,
    pub created_at_ms: u64,
    /// Recall only returns records inside `[valid_from, valid_to]`
    /// (inclusive); `valid_to_ms: None` is unbounded. Pinned records stay
    /// recallable past expiry by explicit user choice.
    pub valid_from_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_to_ms: Option<u64>,
    /// `active` | `forgotten` | `merged`. Terminal-but-audited: history
    /// keeps every prior revision; nothing is physically deleted here.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_into: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    /// Durable "why did it come up" counter: bumped by real recall hits.
    pub use_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at_ms: Option<u64>,
    /// Caller-supplied idempotency key; a replayed create returns the
    /// original record instead of writing a duplicate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_token: Option<String>,
    /// Highest source revision already merged by an import; replaying an
    /// export bundle with an older-or-equal revision is a no-op kept,
    /// never a second write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_from_revision: Option<u64>,
    pub recorded_at_ms: u64,
}

/// One audit entry: the full record snapshot after `action`, who did it,
/// and when. History is append-only per record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRevision {
    pub record: MemoryRecord,
    pub action: String,
    pub actor: String,
    pub at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecallHit {
    pub record_id: String,
    pub revision: u64,
    pub score: u64,
    /// Query terms that literally matched this record's content.
    pub matched_terms: Vec<String>,
    /// Deterministic explanations: which fields contributed (keyword hit,
    /// pinned, recent use). No fabricated reasoning chains.
    pub reasons: Vec<String>,
}

/// Durable "why did I remember this" trace for one recall event.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecallTrace {
    pub id: String,
    pub at_ms: u64,
    pub query: String,
    pub scope: ScopeQuery,
    pub hits: Vec<RecallHit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consumed_by_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consumed_by_turn_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGraphEdge {
    pub from_id: String,
    pub to_id: String,
    pub relation_type: String,
    pub inferred: bool,
    pub evidence: Vec<MemorySourceRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGraphNode {
    pub id: String,
    pub kind: String,
    pub content_preview: String,
    pub pinned: bool,
    pub use_count: u64,
    pub status: String,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGraph {
    pub nodes: Vec<MemoryGraphNode>,
    pub edges: Vec<MemoryGraphEdge>,
    /// Nodes hidden because the page limit was reached — honest truncation
    /// instead of a silently partial picture.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryAction {
    Create,
    Update,
    Forget,
    Restore,
    Merge {
        into: String,
    },
    Share {
        add: Vec<MemoryScope>,
        remove: Vec<MemoryScope>,
    },
    Pin {
        pinned: bool,
    },
}

impl MemoryAction {
    fn as_str(&self) -> String {
        match self {
            MemoryAction::Create => "create".into(),
            MemoryAction::Update => "update".into(),
            MemoryAction::Forget => "forget".into(),
            MemoryAction::Restore => "restore".into(),
            MemoryAction::Merge { .. } => "merge".into(),
            MemoryAction::Share { .. } => "share".into(),
            MemoryAction::Pin { .. } => "pin".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryDraft {
    pub scope: MemoryScope,
    pub kind: String,
    pub content: String,
    pub source_refs: Vec<MemorySourceRef>,
    pub relation: Option<MemoryRelation>,
    pub valid_from_ms: Option<u64>,
    pub valid_to_ms: Option<u64>,
    pub pinned: bool,
    pub client_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryUpdate {
    pub content: Option<String>,
    pub kind: Option<String>,
    pub source_refs: Option<Vec<MemorySourceRef>>,
    pub relation: Option<MemoryRelation>,
    pub valid_from_ms: Option<u64>,
    /// None = no change, Some(None) = clear the expiry, Some(Some(t)) = set.
    pub valid_to_ms: Option<Option<u64>>,
}

impl MemoryUpdate {
    pub fn empty() -> Self {
        Self {
            content: None,
            kind: None,
            source_refs: None,
            relation: None,
            valid_from_ms: None,
            valid_to_ms: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryError {
    pub kind: MemoryErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryErrorKind {
    InvalidArgument,
    NotFound,
    Conflict,
    Corrupt,
    Io,
}

impl std::fmt::Display for MemoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}
impl std::error::Error for MemoryError {}

fn err<T>(kind: MemoryErrorKind, message: impl Into<String>) -> Result<T, MemoryError> {
    Err(MemoryError {
        kind,
        message: message.into(),
    })
}

const MAX_CONTENT_BYTES: usize = 32_768;
const MAX_SOURCE_REFS: usize = 32;
const MAX_SHARED_SCOPES: usize = 16;
const MAX_RECALL_TRACES: usize = 4_000;
const ACTIVE: &str = "active";
const FORGOTTEN: &str = "forgotten";
const MERGED: &str = "merged";

static MEMORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_memory_id(at_ms: u64) -> String {
    let seq = MEMORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("mem_{at_ms:013x}_{seq:04x}")
}

fn sanitize_id(id: &str) -> Result<(), MemoryError> {
    if id.len() > 128
        || id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return err(
            MemoryErrorKind::InvalidArgument,
            format!("unsafe memory id {id:?}"),
        );
    }
    Ok(())
}

fn sanitize_scope(scope: &MemoryScope, what: &str) -> Result<(), MemoryError> {
    for (label, value) in [
        ("owner", &scope.owner),
        ("workspace", &scope.workspace),
        ("bot", &scope.bot),
        ("conversation", &scope.conversation),
    ] {
        if value.len() > 128
            || value.is_empty()
            || !(value == "*"
                || value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == ':'))
        {
            return err(
                MemoryErrorKind::InvalidArgument,
                format!("unsafe {what} {label} {value:?}"),
            );
        }
    }
    if scope.owner == "*" {
        return err(
            MemoryErrorKind::InvalidArgument,
            "memory owner must be a concrete account, not *",
        );
    }
    Ok(())
}

fn sanitize_kind(kind: &str) -> Result<(), MemoryError> {
    if kind.len() > 32
        || kind.is_empty()
        || !kind
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return err(
            MemoryErrorKind::InvalidArgument,
            format!("unsafe memory kind {kind:?}"),
        );
    }
    Ok(())
}

fn validate(draft: &MemoryDraft) -> Result<(), MemoryError> {
    sanitize_scope(&draft.scope, "scope")?;
    sanitize_kind(&draft.kind)?;
    if draft.content.len() > MAX_CONTENT_BYTES {
        return err(
            MemoryErrorKind::InvalidArgument,
            format!("memory content exceeds {MAX_CONTENT_BYTES} bytes"),
        );
    }
    if draft.source_refs.len() > MAX_SOURCE_REFS {
        return err(
            MemoryErrorKind::InvalidArgument,
            format!("memory carries more than {MAX_SOURCE_REFS} source refs"),
        );
    }
    for r in &draft.source_refs {
        sanitize_kind(&r.kind)?;
        // Source refs may point at external systems, so only length is
        // enforced here; the target systems own their id formats.
        if r.id.is_empty() || r.id.len() > 256 {
            return err(
                MemoryErrorKind::InvalidArgument,
                "source ref id must be 1..=256 characters",
            );
        }
    }
    if let Some(rel) = &draft.relation {
        sanitize_id(&rel.target_id).map_err(|_| MemoryError {
            kind: MemoryErrorKind::InvalidArgument,
            message: format!("unsafe relation target {:?}", rel.target_id),
        })?;
        sanitize_kind(&rel.relation_type)?;
    }
    if let (Some(from), Some(to)) = (draft.valid_from_ms, draft.valid_to_ms) {
        if from > to {
            return err(
                MemoryErrorKind::InvalidArgument,
                "valid_from must precede valid_to",
            );
        }
    }
    if let Some(token) = &draft.client_token {
        if token.len() > 128 {
            return err(MemoryErrorKind::InvalidArgument, "client token too long");
        }
    }
    Ok(())
}

/// Deterministic keyword score. Terms are lowercased; CJK runs are also
/// indexed per character so Chinese queries match without whitespace.
fn terms_of(text: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut current = String::new();
    let push = |term: &mut String, terms: &mut Vec<String>| {
        if !term.is_empty() {
            terms.push(term.clone());
            term.clear();
        }
    };
    for ch in text.to_lowercase().chars() {
        if ch.is_alphanumeric() {
            // CJK and other non-ascii letters become single-char terms so
            // 中文 queries work without external tokenizers.
            if ch.is_ascii_alphanumeric() {
                current.push(ch);
            } else {
                push(&mut current, &mut terms);
                terms.push(ch.to_string());
            }
        } else {
            push(&mut current, &mut terms);
        }
    }
    push(&mut current, &mut terms);
    terms.sort();
    terms.dedup();
    terms
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/// Owns `<state>/product/memory/{records,history,recalls}` under a root
/// path. Single-writer like the rest of the product store; every write is
/// an atomic rename, records are first-write-wins on create and
/// compare-and-swap on revision.
pub struct MemoryStore {
    root: PathBuf,
    index: MemorySearchIndex,
    writes: std::sync::Arc<std::sync::Mutex<()>>,
}

impl MemoryStore {
    pub fn open(state_root: &Path) -> Self {
        let root = state_root.join("product").join("memory");
        let index = MemorySearchIndex::new(root.join("search-index.json"));
        let writes = import_ops::write_lock(&root);
        Self {
            root,
            index,
            writes,
        }
    }

    fn records_dir(&self) -> PathBuf {
        self.root.join("records")
    }
    fn history_dir(&self, id: &str) -> PathBuf {
        self.root.join("history").join(id)
    }
    fn recalls_dir(&self) -> PathBuf {
        self.root.join("recalls")
    }
    fn record_path(&self, id: &str) -> PathBuf {
        self.records_dir().join(format!("{id}.json"))
    }

    fn write_json(path: &Path, value: &impl Serialize) -> Result<(), MemoryError> {
        let bytes = serde_json::to_vec_pretty(value).map_err(|e| MemoryError {
            kind: MemoryErrorKind::Corrupt,
            message: e.to_string(),
        })?;
        crate::atomic_write(path, &bytes).map_err(|e| MemoryError {
            kind: MemoryErrorKind::Io,
            message: e.to_string(),
        })
    }

    fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, MemoryError> {
        let bytes = std::fs::read(path).map_err(|e| MemoryError {
            kind: MemoryErrorKind::Io,
            message: e.to_string(),
        })?;
        serde_json::from_slice(&bytes).map_err(|e| MemoryError {
            kind: MemoryErrorKind::Corrupt,
            message: format!("{}: {e}", path.display()),
        })
    }

    /// Load the current record or `None` when absent. Corrupt payloads are
    /// surfaced, not silently skipped.
    pub fn read_record(&self, id: &str) -> Result<Option<MemoryRecord>, MemoryError> {
        sanitize_id(id)?;
        let path = self.record_path(id);
        if !path.exists() {
            return Ok(None);
        }
        DISK_READS.fetch_add(1, Ordering::Relaxed);
        Ok(Some(Self::read_json(&path)?))
    }

    /// Full audit trail for one record, oldest revision first.
    pub fn read_history(&self, id: &str) -> Result<Vec<MemoryRevision>, MemoryError> {
        sanitize_id(id)?;
        let dir = self.history_dir(id);
        let mut revisions = Vec::new();
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(revisions),
            Err(e) => return err(MemoryErrorKind::Io, e.to_string()),
        };
        for entry in entries {
            let entry = entry.map_err(|e| MemoryError {
                kind: MemoryErrorKind::Io,
                message: e.to_string(),
            })?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            revisions.push(Self::read_json::<MemoryRevision>(&path)?);
        }
        revisions.sort_by_key(|r| (r.record.revision, r.at_ms));
        Ok(revisions)
    }

    fn commit(
        &self,
        mut record: MemoryRecord,
        action: &MemoryAction,
        actor: &str,
        at_ms: u64,
        note: Option<String>,
    ) -> Result<MemoryRecord, MemoryError> {
        record.revision += 1;
        record.recorded_at_ms = at_ms;
        let revision = MemoryRevision {
            record: record.clone(),
            action: action.as_str(),
            actor: if actor.is_empty() { "user" } else { actor }.to_string(),
            at_ms,
            note,
        };
        Self::write_json(
            &self
                .history_dir(&record.id)
                .join(format!("{:016}.json", record.revision)),
            &revision,
        )?;
        Self::write_json(&self.record_path(&record.id), &record)?;
        // R06: the keyword index updates incrementally from the same write
        // path, so edits/forgets/restores/unshares take effect immediately.
        self.index.upsert(&record);
        Ok(record)
    }

    /// Create a record. With `client_token` the write is idempotent: a
    /// replayed call returns the original record and writes nothing.
    pub fn create(
        &self,
        draft: MemoryDraft,
        actor: &str,
    ) -> Result<(MemoryRecord, bool), MemoryError> {
        let _write = self.writes.lock().unwrap_or_else(|e| e.into_inner());
        validate(&draft)?;
        let at_ms = now_ms();
        if let Some(token) = &draft.client_token {
            if let Some(existing) = self.find_by_client_token(token)? {
                return Ok((existing, false));
            }
        }
        let record = MemoryRecord {
            id: new_memory_id(at_ms),
            revision: 0,
            scope: draft.scope,
            shared_scopes: Vec::new(),
            kind: draft.kind,
            content: draft.content,
            source_refs: draft.source_refs,
            relation: draft.relation,
            created_at_ms: at_ms,
            valid_from_ms: draft.valid_from_ms.unwrap_or(at_ms),
            valid_to_ms: draft.valid_to_ms,
            status: ACTIVE.into(),
            merged_into: None,
            pinned: draft.pinned,
            use_count: 0,
            last_used_at_ms: None,
            client_token: draft.client_token,
            imported_from_revision: None,
            recorded_at_ms: at_ms,
        };
        Ok((
            self.commit(record, &MemoryAction::Create, actor, at_ms, None)?,
            true,
        ))
    }

    fn find_by_client_token(&self, token: &str) -> Result<Option<MemoryRecord>, MemoryError> {
        for record in self.all_records()? {
            if record.client_token.as_deref() == Some(token) {
                return Ok(Some(record));
            }
        }
        Ok(None)
    }

    fn all_records(&self) -> Result<Vec<MemoryRecord>, MemoryError> {
        let mut records = Vec::new();
        let entries = match std::fs::read_dir(self.records_dir()) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(records),
            Err(e) => return err(MemoryErrorKind::Io, e.to_string()),
        };
        for entry in entries {
            let entry = entry.map_err(|e| MemoryError {
                kind: MemoryErrorKind::Io,
                message: e.to_string(),
            })?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            DISK_READS.fetch_add(1, Ordering::Relaxed);
            records.push(Self::read_json::<MemoryRecord>(&path)?);
        }
        Ok(records)
    }

    /// Mutate one record under an optimistic revision check. `expected` is
    /// the revision the caller saw; `None` skips the check (the RPC layer
    /// always passes it).
    pub fn mutate(
        &self,
        id: &str,
        expected_revision: Option<u64>,
        actor: &str,
        note: Option<String>,
        action: &MemoryAction,
        apply: impl FnOnce(MemoryRecord) -> Result<MemoryRecord, MemoryError>,
    ) -> Result<MemoryRecord, MemoryError> {
        let _write = self.writes.lock().unwrap_or_else(|e| e.into_inner());
        sanitize_id(id)?;
        let record = self.read_record(id)?.ok_or_else(|| MemoryError {
            kind: MemoryErrorKind::NotFound,
            message: format!("memory record {id} not found"),
        })?;
        if let Some(expected) = expected_revision {
            if expected != record.revision {
                return err(
                    MemoryErrorKind::Conflict,
                    format!(
                        "memory record {id} is at revision {}, caller expected {expected}",
                        record.revision
                    ),
                );
            }
        }
        let at_ms = now_ms();
        let updated = apply(record)?;
        self.commit(updated, action, actor, at_ms, note)
    }

    /// Update content/kind/provenance/validity in place.
    pub fn update(
        &self,
        id: &str,
        expected_revision: Option<u64>,
        update: MemoryUpdate,
        actor: &str,
    ) -> Result<MemoryRecord, MemoryError> {
        if let Some(kind) = &update.kind {
            sanitize_kind(kind)?;
        }
        if let Some(content) = &update.content {
            if content.len() > MAX_CONTENT_BYTES {
                return err(
                    MemoryErrorKind::InvalidArgument,
                    format!("memory content exceeds {MAX_CONTENT_BYTES} bytes"),
                );
            }
        }
        self.mutate(
            id,
            expected_revision,
            actor,
            None,
            &MemoryAction::Update,
            |mut record| {
                if record.status != ACTIVE {
                    return err(
                        MemoryErrorKind::Conflict,
                        format!(
                            "memory record {id} is {}; only active records can be edited",
                            record.status
                        ),
                    );
                }
                if let Some(content) = update.content {
                    record.content = content;
                }
                if let Some(kind) = update.kind {
                    record.kind = kind;
                }
                if let Some(refs) = update.source_refs {
                    if refs.len() > MAX_SOURCE_REFS {
                        return err(
                            MemoryErrorKind::InvalidArgument,
                            format!("memory carries more than {MAX_SOURCE_REFS} source refs"),
                        );
                    }
                    record.source_refs = refs;
                }
                if update.relation.is_some() {
                    record.relation = update.relation;
                }
                if let Some(from) = update.valid_from_ms {
                    record.valid_from_ms = from;
                }
                if let Some(valid_to) = update.valid_to_ms {
                    record.valid_to_ms = valid_to;
                }
                if record.valid_from_ms > record.valid_to_ms.unwrap_or(u64::MAX) {
                    return err(
                        MemoryErrorKind::InvalidArgument,
                        "valid_from must precede valid_to",
                    );
                }
                Ok(record)
            },
        )
    }

    /// Forget (soft-delete): excluded from recall and browse-by-default,
    /// history and the record file remain for audit and restore.
    pub fn forget(
        &self,
        id: &str,
        expected_revision: Option<u64>,
        actor: &str,
    ) -> Result<MemoryRecord, MemoryError> {
        self.mutate(
            id,
            expected_revision,
            actor,
            None,
            &MemoryAction::Forget,
            |mut record| {
                if record.status != ACTIVE {
                    return err(
                        MemoryErrorKind::Conflict,
                        format!("memory record {id} is {}, not active", record.status),
                    );
                }
                record.status = FORGOTTEN.into();
                Ok(record)
            },
        )
    }

    /// Restore a forgotten record to active recall.
    pub fn restore(
        &self,
        id: &str,
        expected_revision: Option<u64>,
        actor: &str,
    ) -> Result<MemoryRecord, MemoryError> {
        self.mutate(
            id,
            expected_revision,
            actor,
            None,
            &MemoryAction::Restore,
            |mut record| {
                if record.status != FORGOTTEN && record.status != MERGED {
                    return err(
                        MemoryErrorKind::Conflict,
                        format!(
                            "memory record {id} is {}, not forgotten or merged",
                            record.status
                        ),
                    );
                }
                // Restoring a merged duplicate un-merges it: the pointer is
                // cleared so the record stands alone again, while the full
                // merge/restore history stays on the timeline.
                record.merged_into = None;
                record.status = ACTIVE.into();
                Ok(record)
            },
        )
    }

    /// Merge duplicates: the source record points at the survivor and
    /// leaves recall; the survivor absorbs nothing automatically — content
    /// edits stay explicit user decisions.
    pub fn merge(
        &self,
        source_id: &str,
        target_id: &str,
        expected_revision: Option<u64>,
        // B03 (night 2026-09-10): pins the survivor to the revision the UI
        // previewed. Control-plane RPC handling is serialized, so this check
        // plus the source CAS make preview-then-execute race-free without
        // pretending a stale read is still fresh.
        expected_target_revision: Option<u64>,
        actor: &str,
    ) -> Result<(MemoryRecord, MemoryRecord), MemoryError> {
        if source_id == target_id {
            return err(
                MemoryErrorKind::InvalidArgument,
                "cannot merge a record into itself",
            );
        }
        let target = self.read_record(target_id)?.ok_or_else(|| MemoryError {
            kind: MemoryErrorKind::NotFound,
            message: format!("merge target {target_id} not found"),
        })?;
        if target.status != ACTIVE {
            return err(
                MemoryErrorKind::Conflict,
                format!("merge target {target_id} is {}", target.status),
            );
        }
        if let Some(expected) = expected_target_revision
            && expected != target.revision
        {
            return err(
                MemoryErrorKind::Conflict,
                format!(
                    "merge target {target_id} is at revision {}, caller expected {expected}",
                    target.revision
                ),
            );
        }
        let source = self.mutate(
            source_id,
            expected_revision,
            actor,
            None,
            &MemoryAction::Merge {
                into: target_id.to_string(),
            },
            |mut record| {
                if record.status != ACTIVE {
                    return err(
                        MemoryErrorKind::Conflict,
                        format!("memory record {source_id} is {}, not active", record.status),
                    );
                }
                record.status = MERGED.into();
                record.merged_into = Some(target_id.to_string());
                Ok(record)
            },
        )?;
        Ok((source, target))
    }

    /// Explicit share widening/narrowing (C10). Every change is one
    /// revision so "who could see this, when" stays auditable.
    pub fn share(
        &self,
        id: &str,
        expected_revision: Option<u64>,
        add: Vec<MemoryScope>,
        remove: Vec<MemoryScope>,
        actor: &str,
    ) -> Result<MemoryRecord, MemoryError> {
        if add.len() + remove.len() > MAX_SHARED_SCOPES {
            return err(
                MemoryErrorKind::InvalidArgument,
                format!("share batch exceeds {MAX_SHARED_SCOPES} scopes"),
            );
        }
        for scope in add.iter().chain(remove.iter()) {
            sanitize_scope(scope, "share scope")?;
            if scope.conversation == "*" && scope.bot == "*" && scope.workspace == "*" {
                return err(
                    MemoryErrorKind::InvalidArgument,
                    "share scope must stay below account level; *.*.* would publish to every conversation",
                );
            }
        }
        let action = MemoryAction::Share {
            add: add.clone(),
            remove: remove.clone(),
        };
        self.mutate(id, expected_revision, actor, None, &action, |mut record| {
            if record.status != ACTIVE {
                return err(
                    MemoryErrorKind::Conflict,
                    format!("memory record {id} is {}", record.status),
                );
            }
            if record.shared_scopes.len() + add.len() > MAX_SHARED_SCOPES {
                return err(
                    MemoryErrorKind::InvalidArgument,
                    format!("record already shares to {MAX_SHARED_SCOPES} scopes"),
                );
            }
            for scope in add {
                if !record.shared_scopes.contains(&scope) {
                    record.shared_scopes.push(scope);
                }
            }
            for scope in remove {
                record.shared_scopes.retain(|s| s != &scope);
            }
            Ok(record)
        })
    }

    pub fn pin(
        &self,
        id: &str,
        expected_revision: Option<u64>,
        pinned: bool,
        actor: &str,
    ) -> Result<MemoryRecord, MemoryError> {
        self.mutate(
            id,
            expected_revision,
            actor,
            None,
            &MemoryAction::Pin { pinned },
            |mut record| {
                record.pinned = pinned;
                Ok(record)
            },
        )
    }

    /// Browse listing. Scope-filtered, newest first, paging after filters.
    /// `include_statuses` lets the UI ask for forgotten/merged explicitly;
    /// defaults to active only.
    pub fn list(
        &self,
        query: &ScopeQuery,
        include_statuses: Option<&[&str]>,
        offset: usize,
        limit: usize,
    ) -> Result<(Vec<MemoryRecord>, usize), MemoryError> {
        if query.owner.is_empty() {
            return err(
                MemoryErrorKind::InvalidArgument,
                "memory list requires an owner scope",
            );
        }
        let include: Option<HashSet<String>> =
            include_statuses.map(|s| s.iter().map(|v| v.to_string()).collect());
        let mut records: Vec<MemoryRecord> = self
            .all_records()?
            .into_iter()
            .filter(|r| query.visible_from(r))
            .filter(|r| {
                include
                    .as_ref()
                    .map_or(r.status == ACTIVE, |set| set.contains(&r.status))
            })
            .collect();
        records.sort_by(|a, b| {
            b.created_at_ms
                .cmp(&a.created_at_ms)
                .then_with(|| b.id.cmp(&a.id))
        });
        let total = records.len();
        let page = records
            .into_iter()
            .skip(offset)
            .take(limit.clamp(1, 500))
            .collect();
        Ok((page, total))
    }

    /// Scope-filtered, then ranked keyword recall. Records that are
    /// forgotten/merged, outside their validity window, or hidden from this
    /// scope are never returned; pinned records stay recallable past
    /// expiry. Every call writes a durable recall trace and bumps real
    /// use counters, so "为什么想起它" is answered from facts.
    pub fn recall(
        &self,
        query_text: &str,
        scope: &ScopeQuery,
        limit: usize,
        consumed_by: (Option<String>, Option<String>),
    ) -> Result<MemoryRecallTrace, MemoryError> {
        self.recall_with_embeddings(query_text, scope, limit, consumed_by, None)
    }

    pub fn recall_with_embeddings(
        &self,
        query_text: &str,
        scope: &ScopeQuery,
        limit: usize,
        consumed_by: (Option<String>, Option<String>),
        embeddings: Option<&MemoryEmbeddingQuery>,
    ) -> Result<MemoryRecallTrace, MemoryError> {
        self.recall_impl(query_text, scope, limit, consumed_by, embeddings, false)
    }

    /// R06 benchmark baseline: the original full-scan recall, kept for
    /// same-machine A/B measurement of the index.
    pub fn recall_full_scan(
        &self,
        query_text: &str,
        scope: &ScopeQuery,
        limit: usize,
        consumed_by: (Option<String>, Option<String>),
    ) -> Result<MemoryRecallTrace, MemoryError> {
        self.recall_impl(query_text, scope, limit, consumed_by, None, true)
    }

    fn recall_impl(
        &self,
        query_text: &str,
        scope: &ScopeQuery,
        limit: usize,
        consumed_by: (Option<String>, Option<String>),
        embeddings: Option<&MemoryEmbeddingQuery>,
        force_scan: bool,
    ) -> Result<MemoryRecallTrace, MemoryError> {
        if query_text.len() > 4096 {
            return err(
                MemoryErrorKind::InvalidArgument,
                "memory query exceeds 4096 bytes",
            );
        }
        if let Some(embeddings) = embeddings {
            embeddings.validate()?;
        }
        if scope.owner.is_empty() {
            return err(
                MemoryErrorKind::InvalidArgument,
                "memory recall requires an owner scope",
            );
        }
        let at_ms = now_ms();
        let query_terms = terms_of(query_text);
        let mut scored: Vec<(MemoryRecord, u64, Vec<String>, u64)> = Vec::new();
        // R06: keyword-only recall (the default; no vectors configured) is
        // served by the incremental inverted index. Candidates are ranked by
        // corpus-aware tf-idf, then re-read and re-validated against the
        // authoritative record (scope, status, validity, revision) before
        // they may become hits. The semantic path keeps the full scan: an
        // embedding score needs every record regardless of keywords.
        if !force_scan && embeddings.is_none() && !query_terms.is_empty() {
            self.index.ensure_built(|| self.all_records())?;
            let cap = limit.clamp(1, 100) * 12 + 64;
            let mut lowest_accepted: Option<u64> = None;
            for (id, base) in self.index.rank(&query_terms, cap, scope, at_ms) {
                if let Some(min_seen) = lowest_accepted {
                    // Candidates arrive best-first; once enough hits are in
                    // hand and a remaining base plus the maximum bonus cannot
                    // outrank the weakest accepted hit, stop reading records.
                    if scored.len() >= limit.clamp(1, 100) && base + 600 < min_seen {
                        break;
                    }
                }
                let Some(record) = self.read_record(&id)? else {
                    self.index.remove(&id);
                    continue;
                };
                if !scope.visible_from(&record) || record.status != ACTIVE {
                    // Heal the index from authoritative state; visibility and
                    // status are never trusted from the index.
                    self.index.upsert(&record);
                    continue;
                }
                let in_window = record.valid_from_ms <= at_ms
                    && record.valid_to_ms.map_or(true, |to| at_ms <= to);
                if !in_window && !record.pinned {
                    self.index.upsert(&record);
                    continue;
                }
                let record_terms = index::term_counts(&record.content);
                let matched: Vec<String> = query_terms
                    .iter()
                    .filter(|term| record_terms.contains_key(*term))
                    .cloned()
                    .collect();
                if matched.is_empty() {
                    // Content changed in ways the index had not caught up
                    // with; repair and drop this candidate.
                    self.index.upsert(&record);
                    continue;
                }
                let mut score = base;
                if record.pinned {
                    score += 500;
                }
                if let Some(used) = record.last_used_at_ms {
                    if at_ms.saturating_sub(used) < 86_400_000 {
                        score += 100;
                    }
                }
                lowest_accepted = Some(match lowest_accepted {
                    Some(min_seen) => min_seen.min(score),
                    None => score,
                });
                scored.push((record, score, matched, 0));
            }
        } else {
            for record in self.all_records()? {
                if !scope.visible_from(&record) || record.status != ACTIVE {
                    continue;
                }
                let in_window = record.valid_from_ms <= at_ms
                    && record.valid_to_ms.map_or(true, |to| at_ms <= to);
                if !in_window && !record.pinned {
                    continue;
                }
                if query_terms.is_empty() && embeddings.is_none() {
                    continue;
                }
                let record_terms: HashSet<String> = terms_of(&record.content).into_iter().collect();
                let mut matched = Vec::new();
                for term in &query_terms {
                    if record_terms.contains(term) {
                        matched.push(term.clone());
                    }
                }
                let semantic_score = embeddings.map_or(0, |query| query.score(&record));
                if matched.is_empty() && semantic_score == 0 {
                    continue;
                }
                let mut score = matched.len() as u64 * 10 + semantic_score;
                if record.pinned {
                    score += 5;
                }
                if let Some(used) = record.last_used_at_ms {
                    if at_ms.saturating_sub(used) < 86_400_000 {
                        score += 1;
                    }
                }
                scored.push((record, score, matched, semantic_score));
            }
        }
        scored.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| b.0.pinned.cmp(&a.0.pinned))
                .then_with(|| {
                    b.0.last_used_at_ms
                        .unwrap_or(0)
                        .cmp(&a.0.last_used_at_ms.unwrap_or(0))
                })
                .then_with(|| b.0.id.cmp(&a.0.id))
        });
        let taken = scored.len().min(limit.clamp(1, 100));
        let mut hits = Vec::with_capacity(taken);
        for (record, score, matched_terms, semantic_score) in scored.into_iter().take(taken) {
            let mut reasons = Vec::new();
            if !matched_terms.is_empty() {
                reasons.push(format!("keyword:{}", matched_terms.join("|")));
            }
            if semantic_score > 0 {
                reasons.push(format!("embedding:{}", embeddings.unwrap().model));
            }
            if record.pinned {
                reasons.push("pinned".into());
            }
            hits.push(RecallHit {
                record_id: record.id.clone(),
                revision: record.revision,
                score,
                matched_terms,
                reasons,
            });
            // Bump the durable use counter with its own CAS revision; a
            // concurrent share/forget between scoring and bumping is a
            // lost counter tick, never a corrupted record.
            let _write = self.writes.lock().unwrap_or_else(|e| e.into_inner());
            if let Ok(Some(mut used)) = self.read_record(&record.id) {
                if used.status == ACTIVE {
                    used.use_count += 1;
                    used.last_used_at_ms = Some(at_ms);
                    let _ = Self::write_json(&self.record_path(&record.id), &used);
                }
            }
        }
        let trace = MemoryRecallTrace {
            id: format!(
                "rec_{at_ms:013x}_{:04x}",
                MEMORY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ),
            at_ms,
            query: query_text.to_string(),
            scope: scope.clone(),
            hits,
            consumed_by_thread_id: consumed_by.0,
            consumed_by_turn_id: consumed_by.1,
        };
        self.write_recall_trace(&trace)?;
        Ok(trace)
    }

    fn write_recall_trace(&self, trace: &MemoryRecallTrace) -> Result<(), MemoryError> {
        sanitize_id(&trace.id).map_err(|_| MemoryError {
            kind: MemoryErrorKind::Corrupt,
            message: "generated recall id failed sanitization".into(),
        })?;
        // Bounded ring: prune oldest traces when the cap is exceeded so a
        // long-lived home cannot grow this forever.
        let dir = self.recalls_dir();
        let existing: Vec<PathBuf> = match std::fs::read_dir(&dir) {
            Ok(entries) => entries.flatten().map(|e| e.path()).collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return err(MemoryErrorKind::Io, e.to_string()),
        };
        let mut paths: Vec<PathBuf> = existing
            .into_iter()
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
            .collect();
        if paths.len() >= MAX_RECALL_TRACES {
            paths.sort();
            let excess = paths.len() + 1 - MAX_RECALL_TRACES;
            for path in paths.iter().take(excess) {
                let _ = std::fs::remove_file(path);
            }
        }
        Self::write_json(&dir.join(format!("{}.json", trace.id)), trace)
    }

    pub fn read_recall_trace(&self, id: &str) -> Result<Option<MemoryRecallTrace>, MemoryError> {
        sanitize_id(id)?;
        let path = self.recalls_dir().join(format!("{id}.json"));
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(Self::read_json(&path)?))
    }

    /// Newest recall traces, optionally restricted to one consuming thread.
    pub fn list_recall_traces(
        &self,
        thread_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<MemoryRecallTrace>, MemoryError> {
        let mut traces = Vec::new();
        let entries = match std::fs::read_dir(self.recalls_dir()) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(traces),
            Err(e) => return err(MemoryErrorKind::Io, e.to_string()),
        };
        for entry in entries {
            let entry = entry.map_err(|e| MemoryError {
                kind: MemoryErrorKind::Io,
                message: e.to_string(),
            })?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let trace: MemoryRecallTrace = Self::read_json(&path)?;
            if thread_id.is_none_or(|t| trace.consumed_by_thread_id.as_deref() == Some(t)) {
                traces.push(trace);
            }
        }
        traces.sort_by(|a, b| b.at_ms.cmp(&a.at_ms).then_with(|| b.id.cmp(&a.id)));
        traces.truncate(limit.clamp(1, 200));
        Ok(traces)
    }

    /// Cross-record time slice: every revision of every visible record in
    /// `[from, to]`, ordered oldest first — the timeline and its
    /// supersede/conflict view are facts from history, not reconstructions.
    pub fn timeline(
        &self,
        scope: &ScopeQuery,
        from_ms: Option<u64>,
        to_ms: Option<u64>,
        limit: usize,
    ) -> Result<Vec<MemoryRevision>, MemoryError> {
        let mut events = Vec::new();
        for record in self.all_records()? {
            if !scope.visible_from(&record) {
                continue;
            }
            for revision in self.read_history(&record.id)? {
                let at = revision.at_ms;
                if scope.visible_from(&revision.record)
                    && from_ms.is_none_or(|f| at >= f)
                    && to_ms.is_none_or(|t| at <= t)
                {
                    events.push(revision);
                }
            }
        }
        events.sort_by(|a, b| {
            a.at_ms
                .cmp(&b.at_ms)
                .then_with(|| a.record.id.cmp(&b.record.id))
        });
        let keep = limit.clamp(1, 2_000);
        if events.len() > keep {
            events.drain(..events.len() - keep);
        }
        Ok(events)
    }

    /// Relation graph over visible records. Nodes come only from real
    /// records; edges only from explicit `relation` fields; an edge whose
    /// target is not visible in this scope is dropped, not guessed.
    pub fn graph(
        &self,
        scope: &ScopeQuery,
        include_forgotten: bool,
        limit: usize,
    ) -> Result<MemoryGraph, MemoryError> {
        let limit = limit.clamp(1, 1_000);
        let mut records: Vec<MemoryRecord> = self
            .all_records()?
            .into_iter()
            .filter(|r| scope.visible_from(r))
            .filter(|r| include_forgotten || r.status == ACTIVE)
            .collect();
        records.sort_by(|a, b| {
            b.use_count
                .cmp(&a.use_count)
                .then_with(|| b.pinned.cmp(&a.pinned))
                .then_with(|| b.id.cmp(&a.id))
        });
        let truncated = records.len() > limit;
        records.truncate(limit);
        let visible: HashSet<String> = records.iter().map(|r| r.id.clone()).collect();
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        for record in &records {
            nodes.push(MemoryGraphNode {
                id: record.id.clone(),
                kind: record.kind.clone(),
                content_preview: record.content.chars().take(120).collect(),
                pinned: record.pinned,
                use_count: record.use_count,
                status: record.status.clone(),
                updated_at_ms: record.recorded_at_ms,
            });
            if let Some(rel) = &record.relation {
                if visible.contains(&rel.target_id) {
                    edges.push(MemoryGraphEdge {
                        from_id: record.id.clone(),
                        to_id: rel.target_id.clone(),
                        relation_type: rel.relation_type.clone(),
                        inferred: rel.inferred,
                        evidence: record.source_refs.clone(),
                    });
                }
            }
        }
        Ok(MemoryGraph {
            nodes,
            edges,
            truncated,
        })
    }

    /// Export every record visible in the scope (current state only; no
    /// history, no secrets beyond content the user already stores locally).
    pub fn export(&self, scope: &ScopeQuery) -> Result<serde_json::Value, MemoryError> {
        let mut records = self
            .all_records()?
            .into_iter()
            .filter(|r| scope.visible_from(r))
            .collect::<Vec<_>>();
        records.sort_by(|a, b| a.id.cmp(&b.id));
        let records = records
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| MemoryError {
                kind: MemoryErrorKind::Corrupt,
                message: e.to_string(),
            })?;
        Ok(json!({
            "format": "knorvia-memory-export",
            "version": 1,
            "exportedAtMs": now_ms(),
            "scope": scope,
            "records": records,
        }))
    }

    /// Compatibility entry point: validate the entire bundle before accepting
    /// an operation. The durable receipt is available through import_receipt.
    pub fn import(
        &self,
        bundle: &serde_json::Value,
        actor: &str,
    ) -> Result<(usize, usize, usize), MemoryError> {
        let operation_id = import_ops::bundle_operation_id(bundle);
        let receipt = if self.import_path(&operation_id).exists() {
            let previous = self.import_receipt(&operation_id)?;
            if previous.status == "completed" {
                return Ok((0, 0, previous.items.len()));
            }
            self.resume_import(&operation_id)?
        } else {
            let plan = self.plan_import(bundle)?;
            self.apply_import(bundle, &plan.plan_hash, &operation_id, actor)?
        };
        if receipt.status != "completed" {
            return err(
                MemoryErrorKind::Io,
                format!(
                    "import {} {}: created={}, applied={}, kept={}; read durable receipt and resume original operation: {}",
                    receipt.operation_id,
                    receipt.status,
                    receipt.created,
                    receipt.applied,
                    receipt.kept,
                    receipt.error.unwrap_or_default()
                ),
            );
        }
        Ok((receipt.created, receipt.applied, receipt.kept))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod index_tests;

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

    fn new_store(tag: &str) -> (MemoryStore, TempHome) {
        let base = std::env::temp_dir().join(format!(
            "knorvia-memory-test-{tag}-{}-{}",
            std::process::id(),
            MEMORY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&base).unwrap();
        let store = MemoryStore::open(&base);
        (store, TempHome(base))
    }

    fn scope(conv: &str) -> MemoryScope {
        MemoryScope {
            owner: "user-1".into(),
            workspace: "ws".into(),
            bot: "bot-a".into(),
            conversation: conv.into(),
        }
    }

    fn query(conv: &str) -> ScopeQuery {
        ScopeQuery {
            owner: "user-1".into(),
            workspace: Some("ws".into()),
            bot: Some("bot-a".into()),
            conversation: Some(conv.into()),
        }
    }

    fn draft(conv: &str, content: &str) -> MemoryDraft {
        MemoryDraft {
            scope: scope(conv),
            kind: "fact".into(),
            content: content.into(),
            source_refs: vec![MemorySourceRef {
                kind: "turn".into(),
                id: "turn_1".into(),
                note: None,
            }],
            relation: None,
            valid_from_ms: None,
            valid_to_ms: None,
            pinned: false,
            client_token: None,
        }
    }

    #[test]
    fn crash_between_history_and_record_write_converges() {
        let (store, _home) = new_store("crash");
        let (record, _) = store.create(draft("g1", "v1"), "user").unwrap();
        // Simulate a crash after the history file was written but before the
        // record file was replaced: history already holds revision 2 while
        // the record still says revision 1. A retried mutation recomputes
        // the same revision number and overwrites the same history file —
        // converging on exactly one revision-2 fact.
        let crashed_history = MemoryRevision {
            record: MemoryRecord {
                revision: 2,
                content: "torn".into(),
                ..record.clone()
            },
            action: "update".into(),
            actor: "crashed".into(),
            at_ms: record.created_at_ms,
            note: None,
        };
        MemoryStore::write_json(
            &store
                .history_dir(&record.id)
                .join(format!("{:016}.json", 2)),
            &crashed_history,
        )
        .unwrap();
        let updated = store
            .update(
                &record.id,
                Some(1),
                MemoryUpdate {
                    content: Some("v2".into()),
                    ..MemoryUpdate::empty()
                },
                "user",
            )
            .unwrap();
        assert_eq!(updated.revision, 2);
        assert_eq!(updated.content, "v2");
        let history = store.read_history(&record.id).unwrap();
        assert_eq!(
            history.len(),
            2,
            "torn history entry is replaced, not duplicated"
        );
        assert_eq!(history[1].record.content, "v2");
        assert_eq!(history[1].actor, "user");
    }

    #[test]
    fn graph_limit_batches_over_a_thousand_nodes_honestly() {
        let (store, _home) = new_store("scale");
        let owner = "user-1";
        for n in 0..1_100 {
            let mut d = draft("g1", &format!("scale note {n:04}"));
            d.scope.owner = owner.into();
            store.create(d, "user").unwrap();
        }
        let all = ScopeQuery {
            owner: owner.into(),
            workspace: Some("ws".into()),
            bot: Some("bot-a".into()),
            conversation: Some("g1".into()),
        };
        let graph = store.graph(&all, false, 300).unwrap();
        assert_eq!(graph.nodes.len(), 300, "hard cap per page");
        assert!(graph.truncated, "truncation is reported, not silent");
        // list pages through everything without the UI limit lie
        let (page, total) = store.list(&all, None, 0, 500).unwrap();
        assert_eq!(page.len(), 500);
        assert_eq!(total, 1_100);
        // recall stays bounded too
        let trace = store
            .recall("scale note 0001", &all, 5, (None, None))
            .unwrap();
        assert!(trace.hits.len() <= 5 && !trace.hits.is_empty());
    }

    #[test]
    fn browse_all_query_wildcard_sees_every_workspace_but_recall_stays_scoped() {
        let (store, _home) = new_store("browse");
        store.create(draft("g1", "alpha note"), "user").unwrap();
        let all = ScopeQuery {
            owner: "user-1".into(),
            workspace: Some("*".into()),
            bot: Some("*".into()),
            conversation: Some("*".into()),
        };
        assert_eq!(
            store.list(&all, None, 0, 10).unwrap().1,
            1,
            "query-side * is browse-all"
        );
        assert_eq!(
            store
                .recall("alpha", &all, 10, (None, None))
                .unwrap()
                .hits
                .len(),
            1
        );
    }

    #[test]
    fn create_updates_and_audits_every_revision() {
        let (store, _home) = new_store("audit");
        let (record, created) = store.create(draft("g1", "alpha"), "user").unwrap();
        assert!(created);
        assert_eq!(record.revision, 1);
        let updated = store
            .update(
                &record.id,
                Some(1),
                MemoryUpdate {
                    content: Some("beta".into()),
                    ..MemoryUpdate::empty()
                },
                "user",
            )
            .unwrap();
        assert_eq!(updated.revision, 2);
        assert_eq!(updated.content, "beta");
        // stale revision is a conflict, not a silent overwrite
        let stale = store.update(
            &record.id,
            Some(1),
            MemoryUpdate {
                content: Some("gamma".into()),
                ..MemoryUpdate::empty()
            },
            "user",
        );
        assert_eq!(stale.unwrap_err().kind, MemoryErrorKind::Conflict);
        let history = store.read_history(&record.id).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].action, "create");
        assert_eq!(history[1].action, "update");
        assert_eq!(
            history[0].record.content, "alpha",
            "history keeps the old content"
        );
    }

    #[test]
    fn cross_conversation_secrets_stay_isolated_until_explicitly_shared() {
        let (store, _home) = new_store("scope");
        store
            .create(draft("g1", "G1 密码是 lantern"), "user")
            .unwrap();
        store.create(draft("g2", "G2 likes chess"), "user").unwrap();
        // workspace-wide note ("*" conversation) is visible from both
        store
            .create(
                MemoryDraft {
                    scope: MemoryScope {
                        conversation: "*".into(),
                        ..scope("g1")
                    },
                    content: "user prefers concise answers".into(),
                    ..draft("g1", "")
                },
                "user",
            )
            .unwrap();

        let g1 = store
            .recall("密码", &query("g1"), 10, (None, None))
            .unwrap();
        assert!(
            g1.hits.iter().any(|h| !h.matched_terms.is_empty()),
            "CJK query matches via per-character terms"
        );
        let g2_secret = store
            .recall("密码 lantern", &query("g2"), 10, (None, None))
            .unwrap();
        assert!(
            g2_secret.hits.is_empty(),
            "G1 secret must never recall in G2"
        );

        // explicit share widens, and only widens, with an audit trail
        let records = store.list(&query("g1"), None, 0, 100).unwrap().0;
        let secret_id = records
            .iter()
            .find(|r| r.content.contains("lantern"))
            .unwrap()
            .id
            .clone();
        let revision = records.iter().find(|r| r.id == secret_id).unwrap().revision;
        let shared = store
            .share(
                &secret_id,
                Some(revision),
                vec![scope("g2")],
                vec![],
                "user",
            )
            .unwrap();
        assert_eq!(shared.shared_scopes, vec![scope("g2")]);
        let g2_now = store
            .recall("密码 lantern", &query("g2"), 10, (None, None))
            .unwrap();
        assert!(g2_now.hits.iter().any(|h| h.record_id == secret_id));

        // revoking the share hides it again; history still shows it was shared
        let revision = shared.revision;
        let revoked = store
            .share(
                &secret_id,
                Some(revision),
                vec![],
                vec![scope("g2")],
                "user",
            )
            .unwrap();
        assert!(revoked.shared_scopes.is_empty());
        let g2_after = store
            .recall("密码 lantern", &query("g2"), 10, (None, None))
            .unwrap();
        assert!(g2_after.hits.is_empty());
        let actions: Vec<_> = store
            .read_history(&secret_id)
            .unwrap()
            .into_iter()
            .map(|r| r.action)
            .collect();
        assert_eq!(actions, vec!["create", "share", "share"]);
    }

    #[test]
    fn forgotten_records_leave_recall_but_history_and_restore_survive() {
        let (store, _home) = new_store("forget");
        let (record, _) = store
            .create(draft("g1", "unique marmalade fact"), "user")
            .unwrap();
        let forgotten = store.forget(&record.id, Some(1), "user").unwrap();
        assert_eq!(forgotten.status, "forgotten");
        let hits = store
            .recall("marmalade", &query("g1"), 10, (None, None))
            .unwrap();
        assert!(hits.hits.is_empty(), "forgotten records do not come back");
        let listed = store.list(&query("g1"), None, 0, 10).unwrap();
        assert_eq!(listed.1, 0);
        let incl = store
            .list(&query("g1"), Some(&["forgotten"]), 0, 10)
            .unwrap();
        assert_eq!(incl.1, 1);
        let restored = store.restore(&record.id, Some(2), "user").unwrap();
        assert_eq!(restored.status, "active");
        let hits = store
            .recall("marmalade", &query("g1"), 10, (None, None))
            .unwrap();
        assert_eq!(hits.hits.len(), 1);
        let actions: Vec<_> = store
            .read_history(&record.id)
            .unwrap()
            .into_iter()
            .map(|r| r.action)
            .collect();
        assert_eq!(actions, vec!["create", "forget", "restore"]);
    }

    #[test]
    fn client_token_makes_create_idempotent() {
        let (store, _home) = new_store("idempotent");
        let mut d = draft("g1", "once only");
        d.client_token = Some("tool-call-42".into());
        let (first, created) = store.create(d.clone(), "user").unwrap();
        assert!(created);
        let (second, created_again) = store.create(d, "user").unwrap();
        assert!(!created_again);
        assert_eq!(first.id, second.id);
        assert_eq!(first.revision, second.revision);
        assert_eq!(store.list(&query("g1"), None, 0, 10).unwrap().1, 1);
    }

    #[test]
    fn recall_writes_durable_traces_and_real_use_counters() {
        let (store, _home) = new_store("recall");
        let (record, _) = store
            .create(draft("g1", "knorvia uses durable memory"), "user")
            .unwrap();
        let trace = store
            .recall(
                "durable memory",
                &query("g1"),
                10,
                (Some("thr_1".into()), Some("turn_9".into())),
            )
            .unwrap();
        assert_eq!(trace.hits.len(), 1);
        assert_eq!(trace.hits[0].record_id, record.id);
        assert!(trace.hits[0].reasons[0].starts_with("keyword:"));
        assert_eq!(trace.consumed_by_thread_id.as_deref(), Some("thr_1"));
        let stored = store.read_recall_trace(&trace.id).unwrap().unwrap();
        assert_eq!(stored.hits, trace.hits);
        let after = store.read_record(&record.id).unwrap().unwrap();
        assert_eq!(after.use_count, 1, "use counter is a real durable fact");
        assert!(after.last_used_at_ms.is_some());
        let recent = store.list_recall_traces(Some("thr_1"), 10).unwrap();
        assert_eq!(recent.len(), 1);
        let other = store.list_recall_traces(Some("thr_other"), 10).unwrap();
        assert!(other.is_empty());
    }

    #[test]
    fn validity_windows_and_pins_control_recall() {
        let (store, _home) = new_store("validity");
        let at = now_ms();
        let mut expired = draft("g1", "old promotional price");
        expired.valid_to_ms = Some(at.saturating_sub(1_000));
        let (expired_record, _) = store.create(expired, "user").unwrap();
        let mut pinned = draft("g1", "pinned corner stone");
        pinned.pinned = true;
        pinned.valid_to_ms = Some(at.saturating_sub(1_000));
        let (pinned_record, _) = store.create(pinned, "user").unwrap();
        let hits = store
            .recall(
                "promotional price corner stone",
                &query("g1"),
                10,
                (None, None),
            )
            .unwrap();
        let ids: Vec<_> = hits.hits.iter().map(|h| h.record_id.clone()).collect();
        assert!(
            !ids.contains(&expired_record.id),
            "expired records leave recall"
        );
        assert!(
            ids.contains(&pinned_record.id),
            "pinned records survive expiry"
        );
        // clearing the window with an update brings it back
        store
            .update(
                &expired_record.id,
                Some(1),
                MemoryUpdate {
                    valid_to_ms: Some(None),
                    ..MemoryUpdate::empty()
                },
                "user",
            )
            .unwrap();
        let hits = store
            .recall("promotional price", &query("g1"), 10, (None, None))
            .unwrap();
        assert_eq!(hits.hits.len(), 1);
    }

    #[test]
    fn merge_honors_target_revision_and_merged_records_restore() {
        let (store, _home) = new_store("merge-cas");
        let (keeper, _) = store.create(draft("g1", "keeper fact"), "user").unwrap();
        let (loser, _) = store
            .create(draft("g1", "loser duplicate"), "user")
            .unwrap();
        // A stale target revision is refused and neither record changes.
        let stale = store.merge(&loser.id, &keeper.id, Some(1), Some(99), "user");
        assert_eq!(stale.unwrap_err().kind, MemoryErrorKind::Conflict);
        assert_eq!(
            store.read_record(&loser.id).unwrap().unwrap().status,
            ACTIVE
        );
        // With both CAS values the merge succeeds; the survivor is untouched.
        let (source, target) = store
            .merge(&loser.id, &keeper.id, Some(1), Some(1), "user")
            .unwrap();
        assert_eq!(source.status, MERGED);
        assert_eq!(source.merged_into.as_deref(), Some(keeper.id.as_str()));
        assert_eq!(target.revision, 1, "merge never mutates the survivor");
        assert_eq!(target.content, "keeper fact");
        // The merged source restores as a standalone record; the timeline
        // keeps the audited merge + restore story.
        let restored = store
            .restore(&loser.id, Some(source.revision), "user")
            .unwrap();
        assert_eq!(restored.status, ACTIVE);
        assert_eq!(restored.merged_into, None);
        let timeline = store.timeline(&query("g1"), None, None, 100).unwrap();
        assert!(timeline.iter().any(|event| event.action == "merge"));
        assert!(timeline.iter().any(|event| event.action == "restore"));
    }

    #[test]
    fn merge_and_graph_use_only_real_records_and_visible_edges() {
        let (store, _home) = new_store("graph");
        let (a, _) = store
            .create(draft("g1", "alice likes chess"), "user")
            .unwrap();
        let (b, _) = store
            .create(draft("g1", "bob shares the chess hobby"), "user")
            .unwrap();
        let (dup, _) = store
            .create(draft("g1", "alice really likes chess"), "user")
            .unwrap();
        store.merge(&dup.id, &a.id, Some(1), None, "user").unwrap();
        // relation record b -> a, evidenced by a turn ref
        let mut rel = draft("g1", "bob and alice discuss chess");
        rel.kind = "relation".into();
        rel.relation = Some(MemoryRelation {
            target_id: a.id.clone(),
            relation_type: "discusses_with".into(),
            inferred: false,
        });
        let (rel_record, _) = store.create(rel, "user").unwrap();
        // invisible target (forgotten) drops the edge
        let (gone, _) = store.create(draft("g1", "gone node"), "user").unwrap();
        let mut dangling = draft("g1", "points at gone");
        dangling.relation = Some(MemoryRelation {
            target_id: gone.id.clone(),
            relation_type: "references".into(),
            inferred: true,
        });
        store.create(dangling, "user").unwrap();
        store.forget(&gone.id, Some(1), "user").unwrap();

        let graph = store.graph(&query("g1"), false, 100).unwrap();
        let ids: HashSet<_> = graph.nodes.iter().map(|n| n.id.clone()).collect();
        assert!(ids.contains(&a.id) && ids.contains(&b.id) && ids.contains(&rel_record.id));
        assert!(
            !ids.contains(&gone.id) && !ids.contains(&dup.id),
            "forgotten and merged are not graph nodes"
        );
        assert_eq!(
            graph.edges.len(),
            1,
            "edges to invisible targets are dropped"
        );
        assert_eq!(graph.edges[0].from_id, rel_record.id);
        assert_eq!(graph.edges[0].to_id, a.id);
        assert!(!graph.edges[0].inferred);
        assert_eq!(graph.edges[0].evidence.len(), 1);
        // other conversations see an empty graph — no fabricated data
        let empty = store.graph(&query("g2"), false, 100).unwrap();
        assert!(empty.nodes.is_empty() && empty.edges.is_empty() && !empty.truncated);
    }

    #[test]
    fn timeline_reports_history_slices_in_order() {
        let (store, _home) = new_store("timeline");
        let (record, _) = store.create(draft("g1", "v1"), "user").unwrap();
        store
            .update(
                &record.id,
                Some(1),
                MemoryUpdate {
                    content: Some("v2".into()),
                    ..MemoryUpdate::empty()
                },
                "user",
            )
            .unwrap();
        store.forget(&record.id, Some(2), "user").unwrap();
        let events = store.timeline(&query("g1"), None, None, 100).unwrap();
        let actions: Vec<_> = events.iter().map(|e| e.action.as_str()).collect();
        assert_eq!(actions, vec!["create", "update", "forget"]);
        assert_eq!(events[1].record.content, "v2");
        // scope-filtered: g2 sees nothing of g1's history
        let other = store.timeline(&query("g2"), None, None, 100).unwrap();
        assert!(other.is_empty());
    }

    #[test]
    fn newly_shared_memory_does_not_reveal_earlier_private_revisions() {
        let (store, _home) = new_store("sharing-history");
        let (record, _) = store
            .create(draft("g1", "private original secret"), "user")
            .unwrap();
        store
            .update(
                &record.id,
                Some(1),
                MemoryUpdate {
                    content: Some("shareable summary".into()),
                    ..MemoryUpdate::empty()
                },
                "user",
            )
            .unwrap();
        store
            .share(&record.id, Some(2), vec![scope("g2")], vec![], "user")
            .unwrap();
        let timeline = store.timeline(&query("g2"), None, None, 100).unwrap();
        assert_eq!(timeline.len(), 1);
        assert_eq!(timeline[0].record.content, "shareable summary");
        store
            .share(&record.id, Some(3), vec![], vec![scope("g2")], "user")
            .unwrap();
        assert!(
            store
                .timeline(&query("g2"), None, None, 100)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn optional_embeddings_respect_scope_revisions_and_forgotten_records() {
        let (store, _home) = new_store("embedding-scope");
        let (record, _) = store.create(draft("g1", "car repair"), "user").unwrap();
        let (private, _) = store
            .create(draft("g2", "other room secret"), "user")
            .unwrap();
        let embeddings: MemoryEmbeddingQuery = serde_json::from_value(
            json!({"model":"local-fixture", "queryVector":[1.0,0.0], "records":[
                {"recordId":record.id,"revision":1,"vector":[1.0,0.0]},
                {"recordId":private.id,"revision":1,"vector":[1.0,0.0]}
            ]}),
        )
        .unwrap();
        assert!(
            store
                .recall("automobile", &query("g1"), 10, (None, None))
                .unwrap()
                .hits
                .is_empty()
        );
        let trace = store
            .recall_with_embeddings(
                "automobile",
                &query("g1"),
                10,
                (None, None),
                Some(&embeddings),
            )
            .unwrap();
        assert_eq!(trace.hits.len(), 1);
        assert_eq!(trace.hits[0].record_id, record.id);
        assert_eq!(trace.hits[0].reasons, vec!["embedding:local-fixture"]);
        assert_eq!(store.read_record(&record.id).unwrap().unwrap().use_count, 1);
        store
            .update(
                &record.id,
                Some(1),
                MemoryUpdate {
                    content: Some("changed subject".into()),
                    ..MemoryUpdate::empty()
                },
                "user",
            )
            .unwrap();
        assert!(
            store
                .recall_with_embeddings(
                    "automobile",
                    &query("g1"),
                    10,
                    (None, None),
                    Some(&embeddings)
                )
                .unwrap()
                .hits
                .is_empty()
        );
        let invalid: MemoryEmbeddingQuery = serde_json::from_value(
            json!({"model":"local-fixture","queryVector":[0.0,0.0],"records":[]}),
        )
        .unwrap();
        assert!(
            store
                .recall_with_embeddings(
                    "automobile",
                    &query("g1"),
                    10,
                    (None, None),
                    Some(&invalid)
                )
                .is_err()
        );
    }

    #[test]
    fn thousand_node_graph_is_bounded_deterministic_and_scoped() {
        let (store, _home) = new_store("graph-1000");
        for n in 0..1001 {
            store
                .create(draft("g1", &format!("fixture node {n}")), "user")
                .unwrap();
        }
        store.create(draft("g2", "not in g1"), "user").unwrap();
        let graph = store.graph(&query("g1"), false, 1000).unwrap();
        assert_eq!(graph.nodes.len(), 1000);
        assert!(graph.truncated);
        let again = store.graph(&query("g1"), false, 1000).unwrap();
        assert_eq!(
            serde_json::to_value(graph).unwrap(),
            serde_json::to_value(again).unwrap()
        );
        assert_eq!(
            store.graph(&query("g2"), false, 1000).unwrap().nodes.len(),
            1
        );
    }

    #[test]
    fn export_import_roundtrip_preserves_and_reports_counts() {
        let (store, _home) = new_store("export");
        let mut d = draft("g1", "portable fact");
        d.client_token = Some("keep-token".into());
        let (record, _) = store.create(d, "user").unwrap();
        store.forget(&record.id, Some(1), "user").unwrap();
        let bundle = store.export(&query("g1")).unwrap();
        assert_eq!(bundle["format"], json!("knorvia-memory-export"));
        // fresh store imports the bundle, keeping ids and revision history continuity
        let (store2, _home2) = new_store("import");
        let (created, applied, kept) = store2.import(&bundle, "user").unwrap();
        assert_eq!((created, applied, kept), (1, 0, 0));
        let imported = store2.read_record(&record.id).unwrap().unwrap();
        assert_eq!(
            imported.status, "forgotten",
            "forgotten state is part of the record"
        );
        assert_eq!(imported.client_token.as_deref(), Some("keep-token"));
        // importing again keeps the local copy (revisions tie)
        let (created2, applied2, kept2) = store2.import(&bundle, "user").unwrap();
        assert_eq!((created2, applied2, kept2), (0, 0, 1));
        // and a non-bundle payload is rejected, not half-applied
        assert_eq!(
            store2
                .import(&json!({"records": []}), "user")
                .unwrap_err()
                .kind,
            MemoryErrorKind::InvalidArgument
        );
    }

    #[test]
    fn validation_rejects_unsafe_ids_scopes_and_oversized_content() {
        let (store, _home) = new_store("validate");
        let mut bad = draft("g1", "x");
        bad.scope.owner = "*".into();
        assert_eq!(
            store.create(bad, "user").unwrap_err().kind,
            MemoryErrorKind::InvalidArgument
        );
        let mut big = draft("g1", &"x".repeat(40_000));
        big.content = "y".repeat(40_000);
        assert_eq!(
            store.create(big, "user").unwrap_err().kind,
            MemoryErrorKind::InvalidArgument
        );
        let mut share_all = draft("g1", "x");
        share_all.pinned = false;
        let (record, _) = store.create(share_all, "user").unwrap();
        let everywhere = MemoryScope {
            owner: "user-1".into(),
            workspace: "*".into(),
            bot: "*".into(),
            conversation: "*".into(),
        };
        assert_eq!(
            store
                .share(&record.id, Some(1), vec![everywhere], vec![], "user")
                .unwrap_err()
                .kind,
            MemoryErrorKind::InvalidArgument,
            "account-level publishing is refused; sharing stays below account scope"
        );
    }

    #[test]
    fn keyword_terms_handle_cjk_and_english() {
        let terms = terms_of("Hello, 记忆世界");
        assert!(terms.contains(&"hello".into()));
        assert!(terms.contains(&"记".into()) && terms.contains(&"忆".into()));
        let (store, _home) = new_store("cjk");
        store
            .create(draft("g1", "用户偏好简洁回答"), "user")
            .unwrap();
        let hits = store
            .recall("简洁", &query("g1"), 10, (None, None))
            .unwrap();
        assert_eq!(hits.hits.len(), 1);
        assert!(hits.hits[0].matched_terms.contains(&"简".into()));
    }
}
