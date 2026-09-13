//! Product store: one writer for Workspace/Goal/Task/Thread projection,
//! Artifact/Revision, Job, Approval, and the append-only event journal.
//!
//! Kernel Thread/Turn/Item truth is not owned here; this store holds product
//! objects and projections. Durable transactions are the source of truth;
//! JSON files and JSONL streams are atomically rebuilt projections.

mod media_jobs;
mod message_queue;
pub use message_queue::{MessageQueue, QueuedMessage};

use std::collections::HashMap;
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

use knorvia_platform_paths::KnorviaPaths;
use knorvia_protocol::{
    Approval, Artifact, ArtifactRevision, ErrorCategory, EventEnvelope, Goal, Item, Job,
    ProtocolError, Task, Thread, Turn, Workspace, artifact_id, event_id, item_id, job_id, new_id,
    revision_id, thread_id, turn_id, workspace_id,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

mod artifact_catalog;
mod automation_calendar;
mod automation_index;
mod automations;
mod bots;
pub mod checkpoint;
mod durable;
mod kernel_bindings;
pub use artifact_catalog::{ArtifactCatalogPage, ArtifactCatalogQuery};
#[cfg(test)]
mod automation_index_tests;
#[cfg(test)]
mod checkpoint_bench;
#[cfg(test)]
mod checkpoint_tests;
mod goal_execution;
mod goal_runs;
#[cfg(test)]
mod goal_runs_tests;
#[cfg(test)]
mod goal_tests;
mod goals;
mod pagination;
mod replay_index;
mod recovery;
mod room_chat;
mod room_send;
mod usage_index;
pub use usage_index::UsageSnapshot;
pub use room_send::{RoomSendReceipt,RoomSendWork};
mod thread_index;
mod timeline_index;
pub mod usage;
// C-001/C-002 wiring (A-integrated): durable memory records and auth-link
// registry. The modules own their semantics; this is the crate entry only.
pub mod auth_links;
pub mod memory;
#[cfg(test)]
mod timeline_index_tests;
pub use timeline_index::{ThreadActivity, ThreadHistory, TurnHistory};
#[cfg(test)]
mod thread_index_tests;
mod turn_lifecycle;

pub use automations::{
    Automation, AutomationRun, AutomationRunState, AutomationSchedule, AutomationStatus,
    AutomationTrigger, AutomationUpdate, MAX_AUTOMATIONS_PER_HOME, MisfirePolicy, epoch_millis,
};
pub use bots::{
    BindingAction, BindingIdentity, BotProfile, DEFAULT_BOT_ID, DEFAULT_KNORVIA_SOUL,
    MAX_GROUP_BOTS, ResolvedBinding, Room, RoomMember, SessionBinding, SoulRevisionEntry,
};
pub use durable::WorkspaceCwdUpdate;
use durable::{EventDraft, ProjectionKind};
pub use pagination::{
    DEFAULT_REPLAY_PAGE_BYTES, EventPage, EventReplayPage, ItemPage, MAX_REPLAY_PAGE_BYTES,
};
pub use room_chat::{
    MAX_MESSAGES_RETURNED, MAX_TRANSFER_HOPS, MAX_TRANSFERS_PER_CORRELATION, RoomMessage,
    RoomMessageInput,
};
use turn_lifecycle::system_resolution_item;
pub use usage::UsageRecord;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Protocol(#[from] StoreProtocolError),
    #[error("durable store corruption: {0}")]
    Corrupt(String),
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct StoreProtocolError(pub ProtocolError);

impl From<ProtocolError> for StoreError {
    fn from(value: ProtocolError) -> Self {
        Self::Protocol(StoreProtocolError(value))
    }
}

impl StoreError {
    pub fn into_protocol(self) -> ProtocolError {
        match self {
            StoreError::Protocol(StoreProtocolError(e)) => e,
            StoreError::Io(e) => ProtocolError::new(ErrorCategory::Internal, e.to_string()),
            StoreError::Json(e) => ProtocolError::new(ErrorCategory::Internal, e.to_string()),
            StoreError::Corrupt(message) => ProtocolError::new(ErrorCategory::Internal, message),
        }
    }
}

fn now_rfc3339() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{ms}ms")
}

fn not_found(kind: &str, id: &str) -> StoreError {
    ProtocolError::new(ErrorCategory::NotFound, format!("{kind} {id} not found")).into()
}

fn conflict(msg: impl Into<String>) -> StoreError {
    ProtocolError::new(ErrorCategory::Conflict, msg).into()
}

fn invalid(msg: impl Into<String>) -> StoreError {
    ProtocolError::new(ErrorCategory::InvalidArgument, msg).into()
}

fn invalid_or_precondition(category: ErrorCategory, msg: impl Into<String>) -> StoreError {
    ProtocolError::new(category, msg).into()
}

/// Goal lifecycle vocabulary (GOA-03). Pausing, blocking and resuming are
/// working states; `completed` and `cancelled` are terminal for this Goal id.
fn normalize_goal_status(status: &str) -> Result<String, StoreError> {
    match status {
        "active" | "paused" | "blocked" | "completed" | "cancelled" => Ok(status.to_string()),
        other => Err(invalid(format!(
            "goal status must be active, paused, blocked, completed or cancelled, not {other:?}"
        ))),
    }
}

/// One durable Goal edit or checkpoint. `None` fields leave the stored value
/// unchanged; `checkpoint` refreshes `lastCheckpointAt` without touching
/// anything else, which is how long-running work proves progress.
#[derive(Debug, Clone, Default)]
pub struct GoalUpdate {
    pub title: Option<String>,
    pub status: Option<String>,
    pub success_criteria: Option<String>,
    pub constraints: Option<String>,
    pub next_action: Option<String>,
    pub checkpoint: bool,
}

fn workspace_event_payload(
    workspace: &Workspace,
    cwd: Option<String>,
) -> Result<Value, StoreError> {
    let mut payload = serde_json::to_value(workspace)?;
    let Value::Object(object) = &mut payload else {
        return Err(StoreError::Corrupt(
            "workspace did not serialize to an object".into(),
        ));
    };
    object.insert("cwd".to_string(), cwd.map_or(Value::Null, Value::String));
    Ok(payload)
}

fn reserve_event_sequence(next: &mut u64, stream_id: &str) -> Result<u64, StoreError> {
    let sequence = *next;
    *next = next
        .checked_add(1)
        .ok_or_else(|| StoreError::Corrupt(format!("event sequence exhausted for {stream_id}")))?;
    Ok(sequence)
}

static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Default)]
struct StoreLocks {
    mutation: Mutex<()>,
    journal: Mutex<()>,
    /// Lines deserialized by bounded replay page reads (A08). Test and
    /// operations code reads it to prove a late page stops parsing the
    /// prefix instead of trusting elapsed time.
    page_lines_parsed: AtomicU64,
    page_bytes_read: AtomicU64,
    replay_indexes: Mutex<replay_index::ReplayIndexes>,
    usage_index: Mutex<usage_index::UsageIndex>,
    durable: Mutex<durable::DurableState>,
    thread_index: Mutex<thread_index::ThreadDirectoryIndex>,
    timeline_index: Mutex<timeline_index::TimelineDirectoryIndex>,
    automation_index: Mutex<automation_index::AutomationRunIndex>,
}

static STORE_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<StoreLocks>>>> = OnceLock::new();

fn shared_store_locks(state: &Path) -> Result<Arc<StoreLocks>, StoreError> {
    let state = fs::canonicalize(state).unwrap_or_else(|_| state.to_path_buf());
    let registry = STORE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut registry = registry.lock().map_err(|e| {
        StoreError::Io(io::Error::other(format!(
            "store lock registry poisoned: {e}"
        )))
    })?;
    registry.retain(|_, locks| locks.strong_count() > 0);
    if let Some(locks) = registry.get(&state).and_then(Weak::upgrade) {
        return Ok(locks);
    }
    let locks = Arc::new(StoreLocks::default());
    registry.insert(state, Arc::downgrade(&locks));
    Ok(locks)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // A fixed `*.tmp` name lets unrelated writers overwrite one another's
    // staging file. Keep the staging file adjacent to the destination so the
    // rename remains atomic, but make its name unique per write.
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("state");
    let nonce = NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), nonce));
    let write_result = (|| {
        let mut f = OpenOptions::new().create_new(true).write(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        Ok::<_, io::Error>(())
    })();
    if let Err(err) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    sync_parent_dir(path)?;
    Ok(())
}

#[cfg(unix)]
fn sync_parent_dir(path: &Path) -> io::Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_dir(_path: &Path) -> io::Result<()> {
    // Windows does not expose a portable directory fsync through std. The
    // transaction record is still file-synced before either projection moves.
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, StoreError> {
    let bytes = fs::read(path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct IdempotencyRecord {
    key: String,
    method: String,
    /// `pending` while the request runs, `completed` once the durable result
    /// is stored, `failed` when the attempt ended in an error that may have
    /// produced effects. Absent on records written by older builds, which
    /// were always completed results — hence the default.
    #[serde(default)]
    state: IdempotencyState,
    result: Value,
    /// Present on `failed` records so the client can attribute the prior
    /// attempt instead of discovering it by replaying.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Hash of the request payload (method params minus the key itself).
    /// Recycling a key for a different payload is a typed conflict, never a
    /// silent replay of the old result. Absent on pre-fingerprint records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
}

/// Bounded keys: empty or oversized keys are a client bug, rejected before
/// they reach the filesystem at all (the record path is hashed either way).
const IDEMPOTENCY_KEY_MAX_CHARS: usize = 256;

fn validate_idempotency_key(key: &str) -> Result<(), StoreError> {
    if key.is_empty() {
        return Err(invalid("idempotency key must not be empty"));
    }
    if key.chars().count() > IDEMPOTENCY_KEY_MAX_CHARS {
        return Err(invalid(
            "idempotency key exceeds 256 characters; use a shorter key",
        ));
    }
    Ok(())
}

/// Empty string means "caller does not fingerprint" (legacy tests); records
/// then carry None and any replay of the same key/method stays compatible.
fn fingerprint_field(fingerprint: &str) -> Option<String> {
    (!fingerprint.is_empty()).then(|| fingerprint.to_string())
}

/// Which keys can have LEGACY records in the pre-hash layout? The old build
/// wrote `{key}.json` verbatim, so any key that formed a legal, safely
/// locatable single filename there keeps its compat read — including dotted
/// names like `client.request.1`. Everything that could escape the directory
/// or hit a Windows special name is excluded (those keys cannot have a
/// readable legacy record anyway; their data was never durably addressable).
fn is_safe_legacy_idempotency_name(key: &str) -> bool {
    if key.is_empty() || key.len() > 200 {
        return false;
    }
    if key.starts_with('.') || key.ends_with('.') || key.ends_with(' ') {
        return false;
    }
    if key.contains("..") {
        return false;
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return false;
    }
    !is_windows_device_name(key)
}

fn is_windows_device_name(key: &str) -> bool {
    let up = key.to_ascii_uppercase();
    if matches!(up.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    for prefix in ["COM", "LPT"] {
        if let Some(rest) = up.strip_prefix(prefix) {
            if rest.len() == 1 && matches!(rest.as_bytes()[0], b'1'..=b'9') {
                return true;
            }
        }
    }
    false
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum IdempotencyState {
    Pending,
    Failed,
    #[default]
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCwdRecord {
    workspace_id: String,
    cwd: Option<String>,
}

#[derive(Debug)]
pub struct ProductStore {
    paths: KnorviaPaths,
    /// Shared by every `ProductStore` opened on this state directory. Lock
    /// ordering is always `mutation` then `journal`; journal-only operations
    /// never acquire `mutation`.
    locks: Arc<StoreLocks>,
}

impl ProductStore {
    pub fn open(paths: KnorviaPaths) -> Result<Self, StoreError> {
        paths.ensure_layout()?;
        fs::create_dir_all(paths.state.join("product"))?;
        fs::create_dir_all(paths.state.join("events"))?;
        fs::create_dir_all(paths.state.join("blobs"))?;
        fs::create_dir_all(paths.state.join("idempotency"))?;
        fs::create_dir_all(paths.state.join("idempotency").join("records"))?;
        fs::create_dir_all(paths.state.join("product").join("automations"))?;
        fs::create_dir_all(paths.state.join("product").join("automation-runs"))?;
        fs::create_dir_all(paths.state.join("product").join("bots"))?;
        fs::create_dir_all(paths.state.join("product").join("rooms"))?;
        fs::create_dir_all(paths.state.join("product").join("session-bindings"))?;
        fs::create_dir_all(paths.state.join("product").join("bot-binding-keys"))?;
        fs::create_dir_all(paths.state.join("store-wal"))?;
        fs::create_dir_all(paths.state.join("store-recovery"))?;
        let locks = shared_store_locks(&paths.state)?;
        let store = Self { paths, locks };
        store.invalidate_durable_state()?;
        store.recover_durable_state()?;
        Ok(store)
    }

    pub fn paths(&self) -> &KnorviaPaths {
        &self.paths
    }

    /// Drop the recovered durable-state cache after the state tree was moved
    /// by an external process such as a migration rollback. The next store
    /// operation replays journals and WAL intents from the restored files.
    pub fn invalidate_recovered_cache(&self) {
        self.invalidate_durable_state()
            .expect("durable state lock must not be poisoned");
    }

    fn product_dir(&self) -> PathBuf {
        self.paths.state.join("product")
    }

    fn ws_path(&self, id: &str) -> PathBuf {
        self.product_dir()
            .join("workspaces")
            .join(format!("{id}.json"))
    }
    fn thread_path(&self, id: &str) -> PathBuf {
        self.product_dir()
            .join("threads")
            .join(format!("{id}.json"))
    }
    fn goal_path(&self, id: &str) -> PathBuf {
        self.product_dir().join("goals").join(format!("{id}.json"))
    }
    fn goal_execution_path(&self, id: &str) -> PathBuf {
        self.product_dir()
            .join("goal-executions")
            .join(format!("{id}.json"))
    }
    fn task_path(&self, id: &str) -> PathBuf {
        self.product_dir().join("tasks").join(format!("{id}.json"))
    }
    fn artifact_path(&self, id: &str) -> PathBuf {
        self.product_dir()
            .join("artifacts")
            .join(format!("{id}.json"))
    }
    fn revision_path(&self, id: &str) -> PathBuf {
        self.product_dir()
            .join("revisions")
            .join(format!("{id}.json"))
    }
    fn job_path(&self, id: &str) -> PathBuf {
        self.product_dir().join("jobs").join(format!("{id}.json"))
    }
    fn turn_path(&self, id: &str) -> PathBuf {
        self.product_dir().join("turns").join(format!("{id}.json"))
    }
    fn item_path(&self, id: &str) -> PathBuf {
        self.product_dir().join("items").join(format!("{id}.json"))
    }

    /// Directory holding one thread's sharded item projections. File names
    /// carry the item's stable sequence so paging reads a bounded, ordered
    /// slice of directory entries instead of every item in the store.
    fn item_shard_dir(&self, thread_id: &str) -> PathBuf {
        self.product_dir()
            .join("items")
            .join("threads")
            .join(thread_id)
    }

    fn sharded_item_path(&self, thread_id: &str, seq: Option<u64>, id: &str) -> PathBuf {
        let name = match seq {
            Some(seq) => format!("{seq:020}-{id}.json"),
            None => format!("{id}.json"),
        };
        self.item_shard_dir(thread_id).join(name)
    }

    /// O(1) locator from an item id to its sharded document. Rebuilt on the
    /// fly whenever it is missing, so recovery and legacy layouts still work.
    fn item_locator_path(&self, id: &str) -> PathBuf {
        self.product_dir()
            .join("items")
            .join("by-id")
            .join(format!("{id}.json"))
    }

    fn approval_path(&self, id: &str) -> PathBuf {
        self.product_dir()
            .join("approvals")
            .join(format!("{id}.json"))
    }
    fn automation_path(&self, id: &str) -> PathBuf {
        self.product_dir()
            .join("automations")
            .join(format!("{id}.json"))
    }
    fn automation_run_path(&self, id: &str) -> PathBuf {
        self.product_dir()
            .join("automation-runs")
            .join(format!("{id}.json"))
    }
    fn workspace_cwd_path(&self, id: &str) -> PathBuf {
        self.product_dir()
            .join("workspace-cwd")
            .join(format!("{id}.json"))
    }
    fn events_path(&self, stream_id: &str) -> PathBuf {
        self.paths
            .state
            .join("events")
            .join(format!("{stream_id}.jsonl"))
    }

    fn wal_dir(&self) -> PathBuf {
        self.paths.state.join("store-wal")
    }

    fn recovery_dir(&self) -> PathBuf {
        self.paths.state.join("store-recovery")
    }

    fn lock_mutations(&self) -> Result<MutexGuard<'_, ()>, StoreError> {
        self.locks.mutation.lock().map_err(|e| {
            StoreError::Io(io::Error::other(format!(
                "store mutation lock poisoned: {e}"
            )))
        })
    }

    fn lock_journal(&self) -> Result<MutexGuard<'_, ()>, StoreError> {
        self.locks
            .journal
            .lock()
            .map_err(|e| StoreError::Io(io::Error::other(format!("journal lock poisoned: {e}"))))
    }

    /// Recall the cached result of a write request. The idempotency identity
    /// is (key, method, request fingerprint): replaying the same key for a
    /// different method or a different payload is a client bug that must be
    /// attributed, not silently served a foreign result (or worse, a repeated
    /// execution of the new request). A `pending` record means an earlier
    /// attempt never reached a durable outcome — the client must query state
    /// instead of replaying a possibly-executed write.
    pub fn recall_idempotent(
        &self,
        key: &str,
        expected_method: &str,
        fingerprint: &str,
    ) -> Result<Option<Value>, StoreError> {
        validate_idempotency_key(key)?;
        let _mutations = self.lock_mutations()?;
        Ok(self
            .checked_idempotent_record(key, expected_method, fingerprint)?
            .map(|rec| rec.result))
    }

    /// Mark a keyed request as running before execution. Returns the cached
    /// result when a completed record exists; a live pending record from the
    /// same owner cannot happen (single control-plane reader), so one found
    /// here survived a crash and must stay attributable.
    pub fn begin_idempotent(
        &self,
        key: &str,
        expected_method: &str,
        fingerprint: &str,
    ) -> Result<Option<Value>, StoreError> {
        validate_idempotency_key(key)?;
        let _mutations = self.lock_mutations()?;
        if let Some(cached) = self.checked_idempotent_record(key, expected_method, fingerprint)? {
            return Ok(Some(cached.result));
        }
        let rec = IdempotencyRecord {
            key: key.to_string(),
            method: expected_method.to_string(),
            state: IdempotencyState::Pending,
            result: Value::Null,
            error: None,
            fingerprint: fingerprint_field(fingerprint),
        };
        atomic_write(
            &self.idempotency_path(key),
            &serde_json::to_vec_pretty(&rec)?,
        )?;
        Ok(None)
    }

    /// Persist the durable outcome of a keyed request.
    pub fn remember_idempotent(
        &self,
        key: &str,
        method: &str,
        fingerprint: &str,
        result: &Value,
    ) -> Result<(), StoreError> {
        validate_idempotency_key(key)?;
        let _mutations = self.lock_mutations()?;
        let rec = IdempotencyRecord {
            key: key.to_string(),
            method: method.to_string(),
            state: IdempotencyState::Completed,
            result: result.clone(),
            error: None,
            fingerprint: fingerprint_field(fingerprint),
        };
        atomic_write(
            &self.idempotency_path(key),
            &serde_json::to_vec_pretty(&rec)?,
        )?;
        Ok(())
    }

    /// Record that a keyed attempt ended in an error that may have produced
    /// effects. Side-effect-free validation failures should instead call
    /// [`Self::clear_idempotent`] so the client can simply retry.
    pub fn fail_idempotent(
        &self,
        key: &str,
        method: &str,
        fingerprint: &str,
        error: &str,
    ) -> Result<(), StoreError> {
        validate_idempotency_key(key)?;
        let _mutations = self.lock_mutations()?;
        let rec = IdempotencyRecord {
            key: key.to_string(),
            method: method.to_string(),
            state: IdempotencyState::Failed,
            result: Value::Null,
            error: Some(error.to_string()),
            fingerprint: fingerprint_field(fingerprint),
        };
        atomic_write(
            &self.idempotency_path(key),
            &serde_json::to_vec_pretty(&rec)?,
        )?;
        Ok(())
    }

    /// Remove a pending marker after a side-effect-free failure, so honest
    /// retries with the same key stay possible. Clears both the hashed record
    /// and a not-yet-migrated legacy record.
    pub fn clear_idempotent(&self, key: &str) -> Result<(), StoreError> {
        validate_idempotency_key(key)?;
        let _mutations = self.lock_mutations()?;
        let path = self.idempotency_path(key);
        if path.exists() {
            fs::remove_file(&path)?;
        }
        if let Some(legacy) = self.idempotency_legacy_path(key) {
            if legacy.exists() {
                fs::remove_file(&legacy)?;
            }
        }
        Ok(())
    }

    /// Current records live in their OWN namespace subdirectory, disjoint
    /// from the legacy `{key}.json` files the pre-hash build wrote into the
    /// same parent: a key that happens to be a 64-hex string can otherwise
    /// make its legacy lookup land on another key's hashed record (and vice
    /// versa). The file name is a SHA-256 of the key, never the key itself:
    /// keys are client-supplied, so key-derived paths could traverse the
    /// Home (`../`), collide with Windows device names, or explode in length.
    fn idempotency_path(&self, key: &str) -> PathBuf {
        self.paths
            .state
            .join("idempotency")
            .join("records")
            .join(format!(
                "{}.json",
                hex::encode(Sha256::digest(key.as_bytes()))
            ))
    }

    /// Pre-hash layout wrote `{key}.json` straight into the idempotency
    /// directory, so only keys that were a legal single filename there can
    /// have legacy records — dotted names like `client.request.1` were legal
    /// and stay readable. Old Homes migrate lazily: the legacy file is read
    /// when the namespaced record is missing, and the next write records the
    /// outcome under the namespaced path.
    fn idempotency_legacy_path(&self, key: &str) -> Option<PathBuf> {
        if !is_safe_legacy_idempotency_name(key) {
            return None;
        }
        Some(
            self.paths
                .state
                .join("idempotency")
                .join(format!("{key}.json")),
        )
    }

    /// Locking caller: reads namespaced-then-legacy and enforces the full
    /// identity contract — record key, method scope, request fingerprint,
    /// and record state. Returns the record only when a completed cached
    /// result exists; pending/failed states and identity mismatches are
    /// typed conflicts.
    fn checked_idempotent_record(
        &self,
        key: &str,
        expected_method: &str,
        fingerprint: &str,
    ) -> Result<Option<IdempotencyRecord>, StoreError> {
        let read_owned = |path: &Path| -> Result<Option<IdempotencyRecord>, StoreError> {
            if !path.exists() {
                return Ok(None);
            }
            let rec: IdempotencyRecord = read_json(path)?;
            // A record file belongs to this key only if it says so. A crafted
            // or collided file carrying a different key is treated as absent
            // — another key's result is never leaked or replayed.
            if rec.key == key {
                Ok(Some(rec))
            } else {
                Ok(None)
            }
        };
        let record: Option<IdempotencyRecord> = match read_owned(&self.idempotency_path(key))? {
            Some(rec) => Some(rec),
            None => match self.idempotency_legacy_path(key) {
                Some(legacy) => read_owned(&legacy)?,
                None => None,
            },
        };
        let Some(rec) = record else {
            return Ok(None);
        };
        if rec.method != expected_method {
            return Err(StoreError::Protocol(StoreProtocolError(
                ProtocolError::new(
                    knorvia_protocol::ErrorCategory::Conflict,
                    format!(
                        "idempotency key {key} was recorded for method {}, not {expected_method}",
                        rec.method
                    ),
                ),
            )));
        }
        // Same key + same method but a different request payload is a
        // recycled key: the old result must never be served to it. Records
        // written before fingerprints existed carry None and stay replayable.
        if let (Some(recorded), Some(expected)) = (&rec.fingerprint, fingerprint_field(fingerprint))
        {
            if recorded != &expected {
                return Err(StoreError::Protocol(StoreProtocolError(
                    ProtocolError::new(
                        knorvia_protocol::ErrorCategory::Conflict,
                        format!(
                            "idempotency key {key} was recorded for a different request payload; \
                             use a fresh key instead of recycling this one"
                        ),
                    ),
                )));
            }
        }
        if rec.state == IdempotencyState::Pending {
            return Err(StoreError::Protocol(StoreProtocolError(
                ProtocolError::new(
                    knorvia_protocol::ErrorCategory::Conflict,
                    format!(
                        "idempotency key {key} has no durable outcome yet: the previous attempt \
                         was interrupted; query the result instead of replaying this request"
                    ),
                ),
            )));
        }
        if rec.state == IdempotencyState::Failed {
            return Err(StoreError::Protocol(StoreProtocolError(
                ProtocolError::new(
                    knorvia_protocol::ErrorCategory::Conflict,
                    format!(
                        "idempotency key {key} already ended in an error: {}; use a fresh key to retry",
                        rec.error.unwrap_or_else(|| "unknown failure".into())
                    ),
                ),
            )));
        }
        Ok(Some(rec))
    }

    pub fn append_event(
        &self,
        stream_id: &str,
        kind: &str,
        payload: Value,
        correlation_id: Option<String>,
    ) -> Result<EventEnvelope, StoreError> {
        // A standalone activity event still receives a transaction record, so
        // its JSONL projection can be reconstructed after a crash.
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.append_event_locked(stream_id, kind, payload, correlation_id)
    }

    /// Append without taking the journal lock; callers must already hold it
    /// (or be inside a locked critical section).
    fn append_event_locked(
        &self,
        stream_id: &str,
        kind: &str,
        payload: Value,
        correlation_id: Option<String>,
    ) -> Result<EventEnvelope, StoreError> {
        self.commit_transaction_locked(stream_id, kind, payload, correlation_id, Vec::new())
    }

    pub fn replay(
        &self,
        stream_id: &str,
        after_seq: u64,
    ) -> Result<Vec<EventEnvelope>, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.ensure_stream_journal_is_current(stream_id)?;
        self.replay_clean_journal_locked(stream_id, after_seq)
    }

    pub fn create_workspace(&self, title: &str) -> Result<Workspace, StoreError> {
        self.create_workspace_with_cwd(title, None)
    }

    /// Create a workspace and its optional execution directory in one
    /// recoverable transaction.
    pub fn create_workspace_with_cwd(
        &self,
        title: &str,
        cwd: Option<&str>,
    ) -> Result<Workspace, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let now = now_rfc3339();
        let ws = Workspace {
            id: workspace_id(),
            title: title.to_string(),
            revision: 1,
            created_at: now.clone(),
            updated_at: now,
        };
        let cwd_record = WorkspaceCwdRecord {
            workspace_id: ws.id.clone(),
            cwd: cwd.map(str::to_string),
        };
        let writes = vec![
            self.projection_write(ProjectionKind::Workspace, &ws.id, &ws)?,
            self.projection_write(ProjectionKind::WorkspaceCwd, &ws.id, &cwd_record)?,
        ];
        self.commit_transaction_locked(
            &ws.id,
            "workspace.created",
            workspace_event_payload(&ws, cwd_record.cwd)?,
            None,
            writes,
        )?;
        Ok(ws)
    }

    pub fn read_workspace(&self, id: &str) -> Result<Workspace, StoreError> {
        let path = self.ws_path(id);
        if !path.exists() {
            return Err(not_found("workspace", id));
        }
        read_json(&path)
    }

    pub fn list_workspaces(&self) -> Result<Vec<Workspace>, StoreError> {
        let dir = self.product_dir().join("workspaces");
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if entry.path().extension().and_then(|s| s.to_str()) == Some("json") {
                out.push(read_json(&entry.path())?);
            }
        }
        out.sort_by(|a: &Workspace, b| a.created_at.cmp(&b.created_at));
        Ok(out)
    }

    pub fn update_workspace(
        &self,
        id: &str,
        title: &str,
        expected: Option<u64>,
    ) -> Result<Workspace, StoreError> {
        self.update_workspace_with_cwd(id, Some(title), WorkspaceCwdUpdate::Unchanged, expected)
    }

    /// Atomically update a workspace title and/or cwd. The revision advances
    /// once for the whole change, allowing one optimistic-concurrency check
    /// to protect both fields.
    pub fn update_workspace_with_cwd(
        &self,
        id: &str,
        title: Option<&str>,
        cwd: WorkspaceCwdUpdate<'_>,
        expected: Option<u64>,
    ) -> Result<Workspace, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let mut ws = self.read_workspace(id)?;
        if let Some(exp) = expected {
            if ws.revision != exp {
                return Err(conflict(format!(
                    "workspace revision {} != expected {exp}",
                    ws.revision
                )));
            }
        }
        let current_cwd = self.read_workspace_cwd_record(id)?.cwd;
        let next_cwd = match cwd {
            WorkspaceCwdUpdate::Unchanged => current_cwd.clone(),
            WorkspaceCwdUpdate::Set(cwd) => Some(cwd.to_string()),
            WorkspaceCwdUpdate::Clear => None,
        };
        let title_changed = title.is_some_and(|title| title != ws.title);
        if !title_changed && next_cwd == current_cwd {
            return Ok(ws);
        }
        if let Some(title) = title {
            ws.title = title.to_string();
        }
        ws.revision += 1;
        ws.updated_at = now_rfc3339();
        let cwd_record = WorkspaceCwdRecord {
            workspace_id: ws.id.clone(),
            cwd: next_cwd.clone(),
        };
        let writes = vec![
            self.projection_write(ProjectionKind::Workspace, &ws.id, &ws)?,
            self.projection_write(ProjectionKind::WorkspaceCwd, &ws.id, &cwd_record)?,
        ];
        self.commit_transaction_locked(
            id,
            "workspace.updated",
            workspace_event_payload(&ws, next_cwd)?,
            None,
            writes,
        )?;
        Ok(ws)
    }

    pub fn set_workspace_cwd(
        &self,
        id: &str,
        cwd: Option<&str>,
        expected: Option<u64>,
    ) -> Result<Workspace, StoreError> {
        let update = match cwd {
            Some(cwd) => WorkspaceCwdUpdate::Set(cwd),
            None => WorkspaceCwdUpdate::Clear,
        };
        self.update_workspace_with_cwd(id, None, update, expected)
    }

    pub fn read_workspace_cwd(&self, id: &str) -> Result<Option<String>, StoreError> {
        let _ = self.read_workspace(id)?;
        Ok(self.read_workspace_cwd_record(id)?.cwd)
    }

    fn read_workspace_cwd_record(&self, id: &str) -> Result<WorkspaceCwdRecord, StoreError> {
        let path = self.workspace_cwd_path(id);
        if !path.exists() {
            return Ok(WorkspaceCwdRecord {
                workspace_id: id.to_string(),
                cwd: None,
            });
        }
        let record: WorkspaceCwdRecord = read_json(&path)?;
        if record.workspace_id != id {
            return Err(StoreError::Corrupt(format!(
                "workspace cwd projection {path:?} belongs to {}",
                record.workspace_id
            )));
        }
        Ok(record)
    }

    pub fn create_task(
        &self,
        workspace_id: &str,
        goal_id: Option<&str>,
        title: &str,
    ) -> Result<Task, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let _ = self.read_workspace(workspace_id)?;
        if let Some(gid) = goal_id {
            self.require_active_goal(gid, workspace_id)?;
        }
        let now = now_rfc3339();
        let t = Task {
            id: knorvia_protocol::task_id(),
            workspace_id: workspace_id.to_string(),
            goal_id: goal_id.map(str::to_string),
            title: title.to_string(),
            status: "open".into(),
            revision: 1,
            created_at: now.clone(),
            updated_at: now,
        };
        let write = self.projection_write(ProjectionKind::Task, &t.id, &t)?;
        self.commit_transaction_locked(
            workspace_id,
            "task.created",
            serde_json::to_value(&t)?,
            None,
            vec![write],
        )?;
        Ok(t)
    }

    pub fn read_task(&self, id: &str) -> Result<Task, StoreError> {
        let path = self.task_path(id);
        if !path.exists() {
            return Err(not_found("task", id));
        }
        read_json(&path)
    }

    pub fn list_tasks(&self, workspace_id: &str) -> Result<Vec<Task>, StoreError> {
        let dir = self.product_dir().join("tasks");
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let t: Task = read_json(&entry.path())?;
            if t.workspace_id == workspace_id {
                out.push(t);
            }
        }
        Ok(out)
    }

    pub fn create_thread(
        &self,
        workspace_id: &str,
        title: &str,
        goal_id: Option<&str>,
        task_id: Option<&str>,
    ) -> Result<Thread, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let _ = self.read_workspace(workspace_id)?;
        let task = task_id.map(|id| self.read_task(id)).transpose()?;
        if task
            .as_ref()
            .is_some_and(|task| task.workspace_id != workspace_id)
        {
            return Err(invalid("Task belongs to a different workspace"));
        }
        let resolved_goal =
            goal_id.or_else(|| task.as_ref().and_then(|task| task.goal_id.as_deref()));
        if let Some(id) = resolved_goal {
            self.require_active_goal(id, workspace_id)?;
        }
        if task
            .as_ref()
            .is_some_and(|task| task.goal_id.as_deref() != resolved_goal)
        {
            return Err(invalid("Task and Thread must belong to the same Goal"));
        }
        let now = now_rfc3339();
        let th = Thread {
            id: thread_id(),
            workspace_id: workspace_id.to_string(),
            goal_id: resolved_goal.map(str::to_string),
            task_id: task_id.map(str::to_string),
            title: title.to_string(),
            status: "active".into(),
            revision: 1,
            created_at: now.clone(),
            updated_at: now,
        };
        let write = self.projection_write(ProjectionKind::Thread, &th.id, &th)?;
        self.commit_transaction_locked(
            &th.id,
            "thread.created",
            serde_json::to_value(&th)?,
            None,
            vec![write],
        )?;
        Ok(th)
    }

    /// Create a durable snapshot fork of a thread's product history.
    ///
    /// The child receives fresh IDs and a new event stream. Historical Item
    /// order is preserved by assigning each copied Item the sequence of its
    /// corresponding copied `item.appended` event. A source Turn that is still
    /// running becomes `interrupted` in the child: the fork never copies a
    /// live Kernel owner or a pending approval/user-input obligation.
    pub fn fork_thread(
        &self,
        source_id: &str,
        title: &str,
        expected_source_revision: Option<u64>,
    ) -> Result<Thread, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;

        let source = self.read_thread(source_id)?;
        if source.status == "archived" {
            return Err(conflict("cannot fork an archived thread"));
        }
        if let Some(expected) = expected_source_revision
            && source.revision != expected
        {
            return Err(conflict(format!(
                "thread revision {} != expected {expected}",
                source.revision
            )));
        }

        let source_turns = self
            .list_turns_locked()?
            .into_iter()
            .filter(|turn| turn.thread_id == source_id)
            .collect::<Vec<_>>();
        let source_items = self.list_items_locked(source_id)?;
        let source_approvals = self.list_approvals_locked(source_id)?;
        let source_turn_ids = source_turns
            .iter()
            .map(|turn| turn.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        if source_items
            .iter()
            .any(|item| !source_turn_ids.contains(item.turn_id.as_str()))
        {
            return Err(StoreError::Corrupt(format!(
                "thread {source_id} has an item whose turn is missing"
            )));
        }
        if source_approvals
            .iter()
            .any(|approval| !source_turn_ids.contains(approval.turn_id.as_str()))
        {
            return Err(StoreError::Corrupt(format!(
                "thread {source_id} has an approval whose turn is missing"
            )));
        }

        let now = now_rfc3339();
        let child = Thread {
            id: thread_id(),
            workspace_id: source.workspace_id.clone(),
            goal_id: source.goal_id.clone(),
            task_id: source.task_id.clone(),
            title: title.to_string(),
            status: "active".into(),
            revision: 1,
            created_at: now.clone(),
            updated_at: now.clone(),
        };

        let mut writes = vec![self.projection_write(ProjectionKind::Thread, &child.id, &child)?];
        let mut drafts = Vec::new();
        let mut next_event_seq = self.next_event_sequence_locked(&child.id)?;
        let _ = reserve_event_sequence(&mut next_event_seq, &child.id)?;
        drafts.push(EventDraft::new(
            "thread.created",
            serde_json::to_value(&child)?,
        ));
        let _ = reserve_event_sequence(&mut next_event_seq, &child.id)?;
        drafts.push(EventDraft::new(
            "thread.forked",
            serde_json::json!({
                "id": child.id,
                "sourceThreadId": source.id,
                "snapshotAt": now,
            }),
        ));

        let mut items_by_turn = HashMap::<String, Vec<Item>>::new();
        for item in source_items {
            items_by_turn
                .entry(item.turn_id.clone())
                .or_default()
                .push(item);
        }
        let mut approvals_by_turn = HashMap::<String, Vec<Approval>>::new();
        for approval in source_approvals {
            approvals_by_turn
                .entry(approval.turn_id.clone())
                .or_default()
                .push(approval);
        }

        for source_turn in source_turns {
            let source_was_running = source_turn.status == "running";
            let child_turn = Turn {
                id: turn_id(),
                thread_id: child.id.clone(),
                status: if source_was_running {
                    "interrupted".into()
                } else {
                    source_turn.status.clone()
                },
                created_at: source_turn.created_at.clone(),
                completed_at: if source_was_running {
                    Some(now_rfc3339())
                } else {
                    source_turn.completed_at.clone()
                },
            };
            let initial_turn = Turn {
                id: child_turn.id.clone(),
                thread_id: child_turn.thread_id.clone(),
                status: "running".into(),
                created_at: child_turn.created_at.clone(),
                completed_at: None,
            };
            writes.push(self.projection_write(
                ProjectionKind::Turn,
                &child_turn.id,
                &child_turn,
            )?);
            let _ = reserve_event_sequence(&mut next_event_seq, &child.id)?;
            drafts.push(EventDraft::new(
                "turn.started",
                serde_json::to_value(initial_turn)?,
            ));

            for source_item in items_by_turn.remove(&source_turn.id).unwrap_or_default() {
                let sequence = reserve_event_sequence(&mut next_event_seq, &child.id)?;
                let child_item = Item {
                    id: item_id(),
                    thread_id: child.id.clone(),
                    turn_id: child_turn.id.clone(),
                    kind: source_item.kind,
                    status: if source_was_running
                        && matches!(source_item.status.as_str(), "pending" | "waiting_input")
                    {
                        "interrupted".into()
                    } else {
                        source_item.status
                    },
                    seq: sequence,
                    payload: source_item.payload,
                };
                writes.push(self.projection_write(
                    ProjectionKind::Item,
                    &child_item.id,
                    &child_item,
                )?);
                drafts.push(EventDraft::new(
                    "item.appended",
                    serde_json::to_value(child_item)?,
                ));
            }

            // A pending approval has no child owner after a fork. Terminal
            // approvals on a terminal source Turn remain useful audit facts.
            if !source_was_running {
                for source_approval in approvals_by_turn
                    .remove(&source_turn.id)
                    .unwrap_or_default()
                {
                    if source_approval.status == "pending" {
                        continue;
                    }
                    let child_approval = Approval {
                        id: new_id("appr"),
                        thread_id: child.id.clone(),
                        turn_id: child_turn.id.clone(),
                        action: source_approval.action,
                        digest: source_approval.digest,
                        status: source_approval.status,
                        created_at: source_approval.created_at,
                    };
                    let mut requested = child_approval.clone();
                    requested.status = "pending".into();
                    let _ = reserve_event_sequence(&mut next_event_seq, &child.id)?;
                    drafts.push(EventDraft::new(
                        "approval.requested",
                        serde_json::to_value(requested)?,
                    ));
                    let _ = reserve_event_sequence(&mut next_event_seq, &child.id)?;
                    drafts.push(EventDraft::new(
                        "approval.responded",
                        serde_json::to_value(&child_approval)?,
                    ));
                    writes.push(self.projection_write(
                        ProjectionKind::Approval,
                        &child_approval.id,
                        &child_approval,
                    )?);
                }
            }

            if child_turn.status != "running" {
                let _ = reserve_event_sequence(&mut next_event_seq, &child.id)?;
                drafts.push(EventDraft::new(
                    "turn.completed",
                    serde_json::to_value(child_turn)?,
                ));
            }
        }

        self.commit_transaction_batch_locked(&child.id, drafts, writes)?;
        Ok(child)
    }

    pub fn read_thread(&self, id: &str) -> Result<Thread, StoreError> {
        let path = self.thread_path(id);
        if !path.exists() {
            return Err(not_found("thread", id));
        }
        read_json(&path)
    }

    pub fn list_threads(&self, workspace_id: &str) -> Result<Vec<Thread>, StoreError> {
        let _mutations = self.lock_mutations()?;
        self.list_threads_locked(workspace_id)
    }

    fn list_threads_locked(&self, workspace_id: &str) -> Result<Vec<Thread>, StoreError> {
        let dir = self.product_dir().join("threads");
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let t: Thread = read_json(&entry.path())?;
            if t.workspace_id == workspace_id {
                out.push(t);
            }
        }
        Ok(out)
    }

    pub fn update_thread(
        &self,
        id: &str,
        title: &str,
        expected: Option<u64>,
    ) -> Result<Thread, StoreError> {
        self.update_thread_state(id, Some(title), None, expected, "thread.updated")
    }

    pub fn archive_thread(&self, id: &str, expected: Option<u64>) -> Result<Thread, StoreError> {
        self.update_thread_state(id, None, Some("archived"), expected, "thread.archived")
    }

    pub fn unarchive_thread(&self, id: &str, expected: Option<u64>) -> Result<Thread, StoreError> {
        self.update_thread_state(id, None, Some("active"), expected, "thread.unarchived")
    }

    fn update_thread_state(
        &self,
        id: &str,
        title: Option<&str>,
        status: Option<&str>,
        expected: Option<u64>,
        event_kind: &str,
    ) -> Result<Thread, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let mut thread = self.read_thread(id)?;
        if let Some(expected) = expected
            && thread.revision != expected
        {
            return Err(conflict(format!(
                "thread revision {} != expected {expected}",
                thread.revision
            )));
        }
        let title_changed = title.is_some_and(|title| title != thread.title);
        let status_changed = status.is_some_and(|status| status != thread.status);
        if !title_changed && !status_changed {
            return Ok(thread);
        }
        if let Some(title) = title {
            thread.title = title.to_string();
        }
        if let Some(status) = status {
            thread.status = status.to_string();
        }
        thread.revision += 1;
        thread.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Thread, &thread.id, &thread)?;
        self.commit_transaction_locked(
            &thread.id,
            event_kind,
            serde_json::to_value(&thread)?,
            None,
            vec![write],
        )?;
        Ok(thread)
    }

    pub fn list_items(&self, thread_id: &str) -> Result<Vec<Item>, StoreError> {
        let _mutations = self.lock_mutations()?;
        self.list_items_locked(thread_id)
    }

    pub(crate) fn list_items_locked(&self, thread_id: &str) -> Result<Vec<Item>, StoreError> {
        self.collect_items_locked(thread_id, None, None)
            .map(|page| page.data)
    }

    /// Collect one thread's items, optionally bounded to `after_seq` with at
    /// most `limit` entries, from the sharded layout plus any legacy flat
    /// projections. The sharded copy wins when an id exists in both, because
    /// every write after this layout's introduction lands in the shard.
    /// Directory enumeration drives the bound: only the selected files are
    /// parsed, so paging cost tracks the page, not the history length.
    pub(crate) fn collect_items_locked(
        &self,
        thread_id: &str,
        after_seq: Option<u64>,
        limit: Option<usize>,
    ) -> Result<ItemPage, StoreError> {
        let after_seq = after_seq.unwrap_or(0);
        let mut entries: Vec<(u64, bool, std::path::PathBuf)> = Vec::new();
        let shard_dir = self.item_shard_dir(thread_id);
        if shard_dir.exists() {
            for entry in fs::read_dir(&shard_dir)? {
                let entry = entry?;
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let seq = name
                    .split('-')
                    .next()
                    .and_then(|prefix| prefix.parse::<u64>().ok());
                match seq {
                    Some(seq) if seq > after_seq => entries.push((seq, true, path)),
                    Some(_) => {}
                    None => {
                        // Legacy-shaped file inside the shard: parse to learn
                        // its sequence instead of guessing from the name.
                        let item: Item = read_json(&path)?;
                        if item.seq > after_seq {
                            entries.push((item.seq, true, path));
                        }
                    }
                }
            }
        }
        // Legacy flat projections for this thread remain readable until they
        // are rewritten by the next transaction replay. The sharded copy is
        // newer, so it sorts after the flat one and wins the dedup below.
        let flat_dir = self.product_dir().join("items");
        if flat_dir.exists() {
            for entry in fs::read_dir(&flat_dir)? {
                let entry = entry?;
                let path = entry.path();
                if path.is_dir() || path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let item: Item = read_json(&path)?;
                if item.thread_id == thread_id && item.seq > after_seq {
                    entries.push((item.seq, false, path));
                }
            }
        }
        entries.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| right.1.cmp(&left.1)));
        entries.dedup_by(|left, right| left.0 == right.0);
        let has_more = limit.is_some_and(|limit| entries.len() > limit);
        if let Some(limit) = limit {
            entries.truncate(limit);
        }
        let mut data = Vec::with_capacity(entries.len());
        let mut seen = HashMap::new();
        for (_, _, path) in entries {
            let item: Item = read_json(&path)?;
            if seen.insert(item.id.clone(), true).is_none() {
                data.push(item);
            }
        }
        let next_cursor = has_more.then(|| data.last().expect("nonempty page").seq);
        Ok(ItemPage { data, next_cursor })
    }

    /// A legal content digest: exactly 64 lowercase hex digits. Anything
    /// else (wrong length, uppercase, separators, `..`) can never name a
    /// blob file, which is what keeps path traversal out of the blob store.
    fn valid_blob_digest(digest: &str) -> bool {
        digest.len() == 64
            && digest
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    }

    /// Verify one blob file's real SHA-256 against its digest with bounded
    /// memory (fixed-size streaming buffer). A symlinked blob path is
    /// refused: the blob store is content-addressed, never name-addressed.
    fn verify_blob_file(&self, digest: &str, path: &std::path::Path) -> Result<(), StoreError> {
        let meta = fs::symlink_metadata(path)
            .map_err(|e| StoreError::Io(io::Error::other(e.to_string())))?;
        if meta.file_type().is_symlink() {
            return Err(StoreError::Corrupt(format!(
                "blob {digest} is a symlink; the blob store refuses name-addressed escapes"
            )));
        }
        let file =
            fs::File::open(path).map_err(|e| StoreError::Io(io::Error::other(e.to_string())))?;
        let mut reader = io::BufReader::new(file);
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        let actual = hex::encode(hasher.finalize());
        if actual != digest {
            return Err(StoreError::Corrupt(format!(
                "blob {digest} content hash mismatch (file hashes to {actual}); the stored file was modified or corrupted and is preserved as evidence at {}",
                path.display()
            )));
        }
        Ok(())
    }

    /// The blob directory and every state ancestor on its path must be
    /// real directories inside this state root, never reparse points: a
    /// Windows junction at `state/blobs` — or anywhere between the state
    /// root and it — would redirect every blob read, reuse, write, verify
    /// and publish outside the isolated Home even while each leaf file is
    /// an ordinary, correctly hashed file that the leaf-level symlink
    /// check accepts. Every blob boundary goes through this guard, not
    /// just open time, because the directory can be re-pointed while the
    /// store is running.
    fn blobs_dir(&self) -> Result<std::path::PathBuf, StoreError> {
        let dir = self.paths.state.join("blobs");
        for candidate in [self.paths.state.clone(), dir.clone()] {
            let meta = fs::symlink_metadata(&candidate)
                .map_err(|e| StoreError::Io(io::Error::other(e.to_string())))?;
            let name = candidate
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| candidate.display().to_string());
            if meta.file_type().is_symlink() {
                return Err(StoreError::Corrupt(format!(
                    "the {name} path is a symlink or junction; the blob store refuses to follow it outside the state root"
                )));
            }
            if !meta.is_dir() {
                return Err(StoreError::Corrupt(format!(
                    "the {name} path is not a real directory inside the state root"
                )));
            }
        }
        Ok(dir)
    }

    pub fn put_blob(&self, bytes: &[u8]) -> Result<String, StoreError> {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let digest = hex::encode(hasher.finalize());
        let rel = format!("sha256:{digest}");
        let path = self.blobs_dir()?.join(&digest);
        if path.exists() {
            // Content-addressed reuse is only honest when the existing file
            // really hashes to its name; a corrupted file is never silently
            // presented as the caller's content.
            self.verify_blob_file(&digest, &path)?;
        } else {
            atomic_write(&path, bytes)?;
        }
        Ok(rel)
    }

    pub fn get_blob(&self, content_ref: &str) -> Result<Vec<u8>, StoreError> {
        let digest = content_ref
            .strip_prefix("sha256:")
            .filter(|digest| Self::valid_blob_digest(digest))
            .ok_or_else(|| invalid("content_ref must be sha256:<64 lowercase hex>"))?;
        let path = self.blobs_dir()?.join(digest);
        if !path.exists() {
            return Err(not_found("blob", content_ref));
        }
        // The read boundary verifies the real content hash: a modified
        // same-name blob is a typed corruption, never the returned bytes.
        self.verify_blob_file(digest, &path)?;
        Ok(fs::read(path)?)
    }

    pub fn create_artifact(
        &self,
        workspace_id: &str,
        r#type: &str,
        title: &str,
    ) -> Result<Artifact, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let _ = self.read_workspace(workspace_id)?;
        let now = now_rfc3339();
        let art = Artifact {
            id: artifact_id(),
            workspace_id: workspace_id.to_string(),
            r#type: r#type.to_string(),
            title: title.to_string(),
            lifecycle: "staging".into(),
            current_revision: None,
            revision: 1,
            created_at: now.clone(),
            updated_at: now,
        };
        let write = self.projection_write(ProjectionKind::Artifact, &art.id, &art)?;
        self.commit_transaction_locked(
            workspace_id,
            "artifact.created",
            serde_json::to_value(&art)?,
            None,
            vec![write],
        )?;
        Ok(art)
    }

    pub fn read_artifact(&self, id: &str) -> Result<Artifact, StoreError> {
        let path = self.artifact_path(id);
        if !path.exists() {
            return Err(not_found("artifact", id));
        }
        read_json(&path)
    }

    pub fn read_artifact_revision(
        &self,
        revision_id: &str,
    ) -> Result<ArtifactRevision, StoreError> {
        let path = self.revision_path(revision_id);
        if !path.exists() {
            return Err(not_found("artifact revision", revision_id));
        }
        read_json(&path)
    }

    /// Bytes of a published/staged revision's content (verification helper
    /// for clients that need to audit what was committed).
    pub fn read_revision_content(&self, revision_id: &str) -> Result<Vec<u8>, StoreError> {
        let rev = self.read_artifact_revision(revision_id)?;
        self.get_blob(&rev.content_ref)
    }

    pub fn list_artifacts(&self, workspace_id: &str) -> Result<Vec<Artifact>, StoreError> {
        let dir = self.product_dir().join("artifacts");
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let a: Artifact = read_json(&entry.path())?;
            if a.workspace_id == workspace_id {
                out.push(a);
            }
        }
        Ok(out)
    }

    pub fn stage_artifact(
        &self,
        artifact_id: &str,
        bytes: &[u8],
        author: &str,
    ) -> Result<ArtifactRevision, StoreError> {
        self.stage_artifact_at_revision(artifact_id, bytes, author, None)
    }

    /// Stage a new revision only if the artifact still sits at the base the
    /// caller read. `expected_current_revision` mirrors what the client saw:
    /// `Some(None)` expects no current revision, `Some(Some(id))` expects that
    /// exact revision, and `None` keeps the legacy unchecked behavior. A stale
    /// base is a typed conflict, so two editors can never interleave stages
    /// unnoticed.
    pub fn stage_artifact_at_revision(
        &self,
        artifact_id: &str,
        bytes: &[u8],
        author: &str,
        expected_current_revision: Option<Option<&str>>,
    ) -> Result<ArtifactRevision, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let mut art = self.read_artifact(artifact_id)?;
        if let Some(expected) = expected_current_revision {
            if art.current_revision.as_deref() != expected {
                return Err(conflict(format!(
                    "artifact {artifact_id} changed since it was read: expected current revision {:?}, found {:?}; reload before staging",
                    expected, art.current_revision
                )));
            }
        }
        let content_ref = self.put_blob(bytes)?;
        let parent = art.current_revision.clone().into_iter().collect();
        let rev = ArtifactRevision {
            id: revision_id(),
            artifact_id: artifact_id.to_string(),
            parent_ids: parent,
            content_ref,
            created_at: now_rfc3339(),
            author: author.to_string(),
        };
        art.lifecycle = "staged".into();
        art.current_revision = Some(rev.id.clone());
        art.revision += 1;
        art.updated_at = now_rfc3339();
        let writes = vec![
            self.projection_write(ProjectionKind::Revision, &rev.id, &rev)?,
            self.projection_write(ProjectionKind::Artifact, &art.id, &art)?,
        ];
        self.commit_transaction_locked(
            &art.workspace_id,
            "artifact.staged",
            serde_json::to_value(&rev)?,
            None,
            writes,
        )?;
        Ok(rev)
    }

    /// Commit exactly the staged revision the caller produced. Unlike the
    /// legacy verify→publish pair, the conflict check, content verification
    /// and publish happen under one lock in a single durable transaction, so
    /// there is no window where another editor's stage can slip between them.
    /// A stale `staged_revision_id` is a typed conflict: the caller's draft
    /// (its staged revision) stays readable and the newer content is never
    /// overwritten or misattributed. Committing the already-current staged
    /// revision again is idempotent — no extra revision is minted.
    pub fn commit_staged_artifact(
        &self,
        artifact_id: &str,
        staged_revision_id: &str,
    ) -> Result<Artifact, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let mut art = self.read_artifact(artifact_id)?;
        if art.current_revision.as_deref() != Some(staged_revision_id) {
            return Err(conflict(format!(
                "artifact {artifact_id} staged revision {staged_revision_id} is no longer current (current: {:?}); reload and re-apply the draft",
                art.current_revision
            )));
        }
        let rev = self.read_artifact_revision(staged_revision_id)?;
        if rev.artifact_id != artifact_id {
            return Err(invalid(format!(
                "revision {staged_revision_id} does not belong to artifact {artifact_id}"
            )));
        }
        let bytes = self.get_blob(&rev.content_ref)?;
        if bytes.is_empty() {
            return Err(invalid("staged revision is empty"));
        }
        art.lifecycle = "published".into();
        art.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Artifact, &art.id, &art)?;
        self.commit_transaction_locked(
            &art.workspace_id,
            "artifact.published",
            serde_json::to_value(&art)?,
            None,
            vec![write],
        )?;
        Ok(art)
    }

    pub fn verify_artifact(&self, artifact_id: &str) -> Result<Artifact, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let mut art = self.read_artifact(artifact_id)?;
        let Some(rev_id) = art.current_revision.clone() else {
            return Err(invalid("artifact has no staged revision"));
        };
        let rev: ArtifactRevision = read_json(&self.revision_path(&rev_id))?;
        let bytes = self.get_blob(&rev.content_ref)?;
        if bytes.is_empty() {
            return Err(invalid("staged revision is empty"));
        }
        // The verify boundary checks the content against its content_ref:
        // a tampered or corrupted blob can never be marked verified.
        let digest = rev
            .content_ref
            .strip_prefix("sha256:")
            .filter(|digest| Self::valid_blob_digest(digest))
            .ok_or_else(|| invalid("staged revision content_ref is not a legal sha256 digest"))?;
        self.verify_blob_file(digest, &self.blobs_dir()?.join(digest))?;
        art.lifecycle = "verified".into();
        art.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Artifact, &art.id, &art)?;
        self.commit_transaction_locked(
            &art.workspace_id,
            "artifact.verified",
            serde_json::to_value(&art)?,
            None,
            vec![write],
        )?;
        Ok(art)
    }

    pub fn publish_artifact(&self, artifact_id: &str) -> Result<Artifact, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let mut art = self.read_artifact(artifact_id)?;
        if art.lifecycle != "verified" && art.lifecycle != "published" {
            return Err(invalid(format!(
                "artifact {} must be verified before publish (was {})",
                artifact_id, art.lifecycle
            )));
        }
        // The publish boundary re-verifies the content hash: what goes out
        // published is what its revision references, byte for byte.
        if let Some(rev_id) = art.current_revision.clone() {
            let rev: ArtifactRevision = read_json(&self.revision_path(&rev_id))?;
            let digest = rev
                .content_ref
                .strip_prefix("sha256:")
                .filter(|digest| Self::valid_blob_digest(digest))
                .ok_or_else(|| invalid("revision content_ref is not a legal sha256 digest"))?;
            self.verify_blob_file(digest, &self.blobs_dir()?.join(digest))?;
        }
        art.lifecycle = "published".into();
        art.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Artifact, &art.id, &art)?;
        self.commit_transaction_locked(
            &art.workspace_id,
            "artifact.published",
            serde_json::to_value(&art)?,
            None,
            vec![write],
        )?;
        Ok(art)
    }

    pub fn rollback_artifact(&self, artifact_id: &str) -> Result<Artifact, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let mut art = self.read_artifact(artifact_id)?;
        let Some(cur) = art.current_revision.clone() else {
            return Err(invalid("no revision to roll back"));
        };
        let rev: ArtifactRevision = read_json(&self.revision_path(&cur))?;
        let parent = rev.parent_ids.first().cloned();
        art.current_revision = parent;
        art.lifecycle = if art.current_revision.is_some() {
            "published"
        } else {
            "staging"
        }
        .into();
        art.revision += 1;
        art.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Artifact, &art.id, &art)?;
        self.commit_transaction_locked(
            &art.workspace_id,
            "artifact.rolled_back",
            serde_json::to_value(&art)?,
            None,
            vec![write],
        )?;
        Ok(art)
    }

    pub fn create_job(&self, workspace_id: &str, r#type: &str) -> Result<Job, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let _ = self.read_workspace(workspace_id)?;
        let now = now_rfc3339();
        let job = Job {
            id: job_id(),
            workspace_id: workspace_id.to_string(),
            r#type: r#type.to_string(),
            status: "queued".into(),
            attempt: 0,
            checkpoint: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let write = self.projection_write(ProjectionKind::Job, &job.id, &job)?;
        self.commit_transaction_locked(
            workspace_id,
            "job.created",
            serde_json::to_value(&job)?,
            None,
            vec![write],
        )?;
        Ok(job)
    }

    pub fn read_job(&self, id: &str) -> Result<Job, StoreError> {
        let path = self.job_path(id);
        if !path.exists() {
            return Err(not_found("job", id));
        }
        read_json(&path)
    }

    pub fn run_job(&self, id: &str) -> Result<Job, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let mut job = self.read_job(id)?;
        if job.status == "running" {
            return Ok(job);
        }
        if job.status != "queued" {
            return Err(ProtocolError::new(
                ErrorCategory::PreconditionFailed,
                "job must be queued before running",
            )
            .into());
        }
        job.status = "running".into();
        job.attempt += 1;
        job.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Job, &job.id, &job)?;
        self.commit_transaction_locked(
            &job.workspace_id,
            "job.running",
            serde_json::to_value(&job)?,
            None,
            vec![write],
        )?;
        Ok(job)
    }

    pub fn checkpoint_job(&self, id: &str, checkpoint: Value) -> Result<Job, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let mut job = self.read_job(id)?;
        if job.status != "running" {
            return Err(invalid("checkpoint requires running job"));
        }
        job.checkpoint = Some(checkpoint);
        job.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Job, &job.id, &job)?;
        self.commit_transaction_locked(
            &job.workspace_id,
            "job.checkpoint",
            serde_json::to_value(&job)?,
            None,
            vec![write],
        )?;
        Ok(job)
    }

    /// Checkpoint a RUNNING job by id, tolerating a non-running job (worker
    /// progress events may arrive after a cancel landed; they are dropped,
    /// never resurrect the job).
    pub fn checkpoint_job_running(&self, id: &str, checkpoint: Value) -> Result<(), StoreError> {
        match self.checkpoint_job(id, checkpoint) {
            Ok(_) => Ok(()),
            Err(StoreError::Protocol(StoreProtocolError(p)))
                if p.category == ErrorCategory::InvalidArgument =>
            {
                Ok(())
            }
            Err(other) => Err(other),
        }
    }

    pub fn finish_job(&self, id: &str, status: &str) -> Result<Job, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let mut job = self.read_job(id)?;
        if !matches!(status, "succeeded" | "failed" | "cancelled") {
            return Err(invalid("invalid terminal job status"));
        }
        if matches!(job.status.as_str(), "succeeded" | "failed" | "cancelled") {
            if status == job.status {
                return Ok(job);
            }
            return Err(
                ProtocolError::new(ErrorCategory::Cancelled, "job already finished").into(),
            );
        }
        job.status = status.to_string();
        job.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Job, &job.id, &job)?;
        self.commit_transaction_locked(
            &job.workspace_id,
            "job.finished",
            serde_json::to_value(&job)?,
            None,
            vec![write],
        )?;
        Ok(job)
    }

    pub fn cancel_job(&self, id: &str) -> Result<Job, StoreError> {
        self.finish_job(id, "cancelled")
    }

    /// Convert durable `running` jobs left by a previous process into the
    /// explicit `failed` terminal state, preserving each job's checkpoint and
    /// identity. Like [`Self::recover_incomplete_turns`], this never infers
    /// success and never re-runs work: unknown external side effects are not
    /// redone automatically — an explicit retry/resume continues the recorded
    /// identity. Call once at startup after establishing that no runner from
    /// the old process can own the store. Unparsable job files are left
    /// untouched: recovery only asserts about records it can actually read.
    pub fn recover_incomplete_jobs(&self) -> Result<Vec<Job>, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut recovered = Vec::new();
        let dir = self.product_dir().join("jobs");
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(recovered),
            Err(e) => return Err(e.into()),
        };
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(mut job) = serde_json::from_slice::<Job>(&fs::read(&path)?) else {
                continue;
            };
            if job.status != "running" {
                continue;
            }
            job.status = "failed".into();
            job.updated_at = now_rfc3339();
            let write = self.projection_write(ProjectionKind::Job, &job.id, &job)?;
            self.commit_transaction_locked(
                &job.workspace_id,
                "job.recovered",
                serde_json::to_value(&job)?,
                None,
                vec![write],
            )?;
            recovered.push(job);
        }
        Ok(recovered)
    }

    pub fn retry_job(&self, id: &str) -> Result<Job, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        let mut job = self.read_job(id)?;
        if job.status != "failed" && job.status != "cancelled" {
            return Err(invalid("retry requires failed or cancelled job"));
        }
        job.status = "queued".into();
        job.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Job, &job.id, &job)?;
        self.commit_transaction_locked(
            &job.workspace_id,
            "job.retried",
            serde_json::to_value(&job)?,
            None,
            vec![write],
        )?;
        Ok(job)
    }

    pub fn create_approval(
        &self,
        thread_id: &str,
        turn_id: &str,
        action: &str,
        digest: &str,
    ) -> Result<Approval, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let _ = self.require_running_turn_locked(thread_id, turn_id)?;
        let now = now_rfc3339();
        let a = Approval {
            id: new_id("appr"),
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            action: action.to_string(),
            digest: digest.to_string(),
            status: "pending".into(),
            created_at: now,
        };
        let write = self.projection_write(ProjectionKind::Approval, &a.id, &a)?;
        self.commit_transaction_locked(
            thread_id,
            "approval.requested",
            serde_json::to_value(&a)?,
            None,
            vec![write],
        )?;
        Ok(a)
    }

    pub fn read_approval(&self, id: &str) -> Result<Approval, StoreError> {
        let path = self.approval_path(id);
        if !path.exists() {
            return Err(not_found("approval", id));
        }
        read_json(&path)
    }

    /// Return approvals recorded for a thread. Pending approvals are those
    /// whose `status` is exactly `pending`; callers that need a turn snapshot
    /// should additionally filter by `turn_id`.
    pub fn list_approvals(&self, thread_id: &str) -> Result<Vec<Approval>, StoreError> {
        let _mutations = self.lock_mutations()?;
        self.recover_before_indexed_read()?;
        self.list_approvals_locked(thread_id)
    }

    pub(crate) fn list_approvals_locked(
        &self,
        thread_id: &str,
    ) -> Result<Vec<Approval>, StoreError> {
        self.indexed_thread_approvals_locked(thread_id)
    }

    pub fn respond_approval(&self, id: &str, decision: &str) -> Result<Approval, StoreError> {
        if !matches!(decision, "allow" | "deny") {
            return Err(invalid("decision must be allow or deny"));
        }
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        // A previous call may have synced its WAL intent before returning an
        // I/O error. Recover that decision before inspecting the projection.
        self.recover_durable_state_locked()?;
        let mut a = self.read_approval(id)?;
        if a.status != "pending" {
            return Err(conflict("approval already resolved"));
        }
        let _ = self.require_running_turn_locked(&a.thread_id, &a.turn_id)?;
        a.status = if decision == "allow" {
            "allowed"
        } else {
            "denied"
        }
        .into();
        let write = self.projection_write(ProjectionKind::Approval, &a.id, &a)?;
        self.commit_transaction_locked(
            &a.thread_id,
            "approval.responded",
            serde_json::to_value(&a)?,
            None,
            vec![write],
        )?;
        Ok(a)
    }

    /// Record a SYSTEM resolution for one pending approval: the approval
    /// deadline expired ("timed_out"), the turn was cancelled
    /// ("cancelled"), or the runner owner disappeared ("owner_lost"). This
    /// is deliberately distinct from a user's "denied" so the timeline can
    /// tell a user decision from a system close-out. The transition is an
    /// atomic pending→terminal CAS and idempotent per status; a decision
    /// already recorded for the user is never overwritten. The Kernel side
    /// of these paths still receives a Decline.
    ///
    /// The same transaction also appends one durable `approvalResolution`
    /// timeline Item (A03) so a timeline stays explainable after the
    /// pending card disappears; the recovery path in
    /// `recover_incomplete_turns` writes the same shape.
    pub fn resolve_approval_system(&self, id: &str, reason: &str) -> Result<Approval, StoreError> {
        if !matches!(reason, "timed_out" | "cancelled" | "owner_lost") {
            return Err(invalid(
                "system resolution must be timed_out, cancelled or owner_lost",
            ));
        }
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        // Recovery precedes both the pending CAS and the idempotent return:
        // an earlier intent may already own this approval and its Item.
        self.recover_durable_state_locked()?;
        let mut a = self.read_approval(id)?;
        if a.status == reason {
            return Ok(a);
        }
        if a.status != "pending" {
            return Err(conflict("approval already resolved"));
        }
        a.status = reason.into();
        let first_seq = self.next_event_sequence_locked(&a.thread_id)?;
        let item = system_resolution_item(&a, reason, first_seq + 1);
        let writes = vec![
            self.projection_write(ProjectionKind::Approval, &a.id, &a)?,
            self.projection_write(ProjectionKind::Item, &item.id, &item)?,
        ];
        self.commit_transaction_batch_locked(
            &a.thread_id,
            vec![
                EventDraft::new(
                    "approval.systemResolved",
                    serde_json::json!({"approval": a, "reason": reason}),
                ),
                EventDraft::new("item.appended", serde_json::to_value(&item)?),
            ],
            writes,
        )?;
        Ok(a)
    }

    /// Record that a previously persisted user decision could not be delivered
    /// to a live Kernel owner. The decision remains in the event history, but
    /// the projection no longer claims that the action was authorized for
    /// execution. Repeating the transition is idempotent for recovery paths.
    pub fn mark_approval_delivery_failed(&self, id: &str) -> Result<Approval, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut approval = self.read_approval(id)?;
        if approval.status == "delivery_failed" {
            return Ok(approval);
        }
        if !matches!(approval.status.as_str(), "allowed" | "denied") {
            return Err(conflict(format!(
                "approval {id} cannot record delivery failure from {}",
                approval.status
            )));
        }
        let prior_decision = approval.status.clone();
        approval.status = "delivery_failed".into();
        let write = self.projection_write(ProjectionKind::Approval, &approval.id, &approval)?;
        self.commit_transaction_locked(
            &approval.thread_id,
            "approval.delivery_failed",
            serde_json::json!({
                "approval": approval,
                "priorDecision": prior_decision,
            }),
            None,
            vec![write],
        )?;
        Ok(self.read_approval(id)?)
    }

    pub fn activity(&self, stream_id: &str) -> Result<Vec<EventEnvelope>, StoreError> {
        self.replay(stream_id, 0)
    }
}

#[cfg(test)]
#[path = "turn_tests.rs"]
mod turn_tests;

#[cfg(test)]
#[path = "durable_tests.rs"]
mod durable_tests;

#[cfg(test)]
#[path = "artifact_txn_tests.rs"]
mod artifact_txn_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use knorvia_platform_paths::layout;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_store() -> ProductStore {
        let base = std::env::temp_dir().join(format!(
            "knorvia-store-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&base).unwrap();
        ProductStore::open(layout(base)).unwrap()
    }

    #[test]
    fn workspace_thread_artifact_job_roundtrip() {
        let store = tmp_store();
        let ws = store.create_workspace("Research").unwrap();
        let th = store
            .create_thread(&ws.id, "first thread", None, None)
            .unwrap();
        let turn = store.start_turn(&th.id).unwrap();
        let item = store
            .append_item(
                &th.id,
                &turn.id,
                "agentMessage",
                "completed",
                serde_json::json!({"text": "hello"}),
            )
            .unwrap();
        assert!(item.id.starts_with("item_"));

        let art = store
            .create_artifact(&ws.id, "text/markdown", "notes")
            .unwrap();
        let rev = store
            .stage_artifact(&art.id, b"# notes\n", "agent")
            .unwrap();
        assert!(rev.content_ref.starts_with("sha256:"));
        store.verify_artifact(&art.id).unwrap();
        let published = store.publish_artifact(&art.id).unwrap();
        assert_eq!(published.lifecycle, "published");
        let rolled = store.rollback_artifact(&art.id).unwrap();
        assert_ne!(rolled.current_revision, published.current_revision);

        let job = store.create_job(&ws.id, "office.render").unwrap();
        store.run_job(&job.id).unwrap();
        store
            .checkpoint_job(&job.id, serde_json::json!({"step": 1}))
            .unwrap();
        store.finish_job(&job.id, "failed").unwrap();
        store.retry_job(&job.id).unwrap();
        store.run_job(&job.id).unwrap();
        store.cancel_job(&job.id).unwrap();

        let events = store.replay(&ws.id, 0).unwrap();
        let mut ids = std::collections::HashSet::new();
        for e in &events {
            assert!(
                ids.insert(e.event_id.clone()),
                "duplicate eventId {}",
                e.event_id
            );
        }
        assert!(!events.is_empty());

        let again = store.replay(&ws.id, 0).unwrap();
        assert_eq!(events.len(), again.len());
        let _ = fs::remove_dir_all(&store.paths.home);
    }

    /// ART-01: re-publishing an already-published artifact must not mint a
    /// new revision; published versions stay immutable and revisions are only
    /// created by an explicit stage or rollback.
    #[test]
    fn republished_artifact_keeps_one_revision_and_rollback_grows_exactly_one() {
        let store = tmp_store();
        let ws = store.create_workspace("artifacts").unwrap();
        let art = store
            .create_artifact(&ws.id, "text/markdown", "brief")
            .unwrap();
        store.stage_artifact(&art.id, b"v1 body", "agent").unwrap();
        store.verify_artifact(&art.id).unwrap();
        let published = store.publish_artifact(&art.id).unwrap();
        let revision_before = store.list_artifacts(&ws.id).unwrap()[0]
            .current_revision
            .clone()
            .expect("published artifact has a current revision");

        let republished = store.publish_artifact(&art.id).unwrap();
        assert_eq!(republished.lifecycle, "published");
        assert_eq!(
            store.list_artifacts(&ws.id).unwrap()[0]
                .current_revision
                .as_deref(),
            Some(revision_before.as_str()),
            "a repeated publish must not mint a pseudo-version"
        );

        store.rollback_artifact(&published.id).unwrap();
        let after = store.read_artifact(&published.id).unwrap();
        assert_ne!(
            after.current_revision.as_deref(),
            Some(revision_before.as_str()),
            "rollback records a new revision instead of mutating the old one"
        );
        let old_revision = store.read_artifact_revision(&revision_before).unwrap();
        assert_eq!(
            store.get_blob(&old_revision.content_ref).unwrap(),
            b"v1 body".to_vec(),
            "the rolled-over revision's content stays intact and immutable"
        );
        let _ = fs::remove_dir_all(&store.paths.home);
    }

    #[test]
    fn turn_terminal_once() {
        let store = tmp_store();
        let ws = store.create_workspace("w").unwrap();
        let th = store.create_thread(&ws.id, "t", None, None).unwrap();
        let turn = store.start_turn(&th.id).unwrap();
        store.complete_turn(&turn.id, "completed").unwrap();
        let err = store.complete_turn(&turn.id, "failed").unwrap_err();
        match err {
            StoreError::Protocol(StoreProtocolError(p)) => {
                assert_eq!(p.category, ErrorCategory::Conflict);
            }
            other => panic!("{other:?}"),
        }
        let _ = fs::remove_dir_all(&store.paths.home);
    }

    /// The guard seals the boundary without degrading the honest path: an
    /// ordinary blob round-trips, and a same-content put reuses the existing
    /// file through the verified content-addressed reuse branch.
    #[test]
    fn ordinary_blob_read_and_reuse_still_work_inside_the_state_root() {
        let store = tmp_store();
        let first = store.put_blob(b"ordinary local content").unwrap();
        let second = store.put_blob(b"ordinary local content").unwrap();
        assert_eq!(first, second, "same bytes must reuse the same digest");
        assert_eq!(
            store.get_blob(&first).unwrap(),
            b"ordinary local content",
            "the honest read path still returns the local blob"
        );
        let _ = fs::remove_dir_all(&store.paths.home);
    }

    /// A junction at `state/blobs` must never redirect the blob store
    /// outside the state root. Every boundary — read, reuse, write, verify
    /// and publish — refuses the reparse point itself instead of following
    /// it, even when the outside directory holds an ordinary file whose
    /// bytes hash exactly to its name, because leaf-level checks cannot see
    /// the parent escape. Real Windows junction (`mklink /J`, no admin
    /// rights needed); all fixtures live in this test's own temp
    /// directories and the outside sentinel is self-built.
    #[cfg(windows)]
    #[test]
    fn blob_boundaries_refuse_a_junctioned_blobs_directory() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let pid = std::process::id();
        let home = std::env::temp_dir().join(format!("knorvia-junction-home-{pid}-{unique}"));
        let outside = std::env::temp_dir().join(format!("knorvia-junction-out-{pid}-{unique}"));
        let store = ProductStore::open(layout(home.clone())).unwrap();
        fs::create_dir_all(&outside).unwrap();

        // The sentinel outside the isolated Home is a correctly hashed
        // ordinary file, so only the parent boundary can reject it.
        let sentinel = b"outside the isolated home";
        let mut hasher = Sha256::new();
        hasher.update(sentinel);
        let digest = hex::encode(hasher.finalize());
        fs::write(outside.join(&digest), sentinel).unwrap();

        let blobs = home.join("state").join("blobs");
        fs::remove_dir(&blobs).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&blobs)
            .arg(&outside)
            .status()
            .unwrap();
        assert!(
            status.success(),
            "mklink /J must be able to create a real junction in the test environment"
        );
        assert!(
            fs::symlink_metadata(&blobs)
                .unwrap()
                .file_type()
                .is_symlink(),
            "a junction must report as a reparse point via symlink_metadata"
        );
        // The junction is live, not dangling: the sentinel genuinely
        // resolves through it, so a refusal can only come from the parent
        // boundary — never from a broken link.
        let through = fs::read(blobs.join(&digest)).unwrap();
        assert_eq!(
            through, sentinel,
            "the junction must really resolve to the sentinel before the boundary is exercised"
        );

        // Read boundary: refused as corruption, never resolved through the
        // junction to the sentinel bytes.
        let read_err = store.get_blob(&format!("sha256:{digest}")).unwrap_err();
        assert!(
            read_err.to_string().contains("junction"),
            "get must refuse the junction itself, got: {read_err}"
        );

        // Write boundary: refused; nothing may appear in the outside
        // directory (the lone sentinel file stays the only entry).
        let write_err = store.put_blob(b"captured content").unwrap_err();
        assert!(
            write_err.to_string().contains("junction"),
            "put must refuse the junction itself, got: {write_err}"
        );

        // Reuse boundary: the caller's bytes hash exactly to the existing
        // outside file, so without the guard put would verify-and-reuse it
        // through the junction.
        let reuse_err = store.put_blob(sentinel).unwrap_err();
        assert!(
            reuse_err.to_string().contains("junction"),
            "put must refuse reusing outside content, got: {reuse_err}"
        );

        // Verify and publish boundaries: reach them with a durable revision
        // whose content_ref names the sentinel, then require the same
        // parent refusal from both. Publish is exercised with a verified
        // lifecycle, modeling a junction re-pointed after verification.
        let ws = store.create_workspace("j").unwrap();
        let art = store
            .create_artifact(&ws.id, "text/plain", "junction fixture")
            .unwrap();
        let rev_id = format!("rev_junction_{unique}");
        let rev = ArtifactRevision {
            id: rev_id.clone(),
            artifact_id: art.id.clone(),
            parent_ids: vec![],
            content_ref: format!("sha256:{digest}"),
            created_at: now_rfc3339(),
            author: "junction-fixture".into(),
        };
        let revisions = store.product_dir().join("revisions");
        fs::create_dir_all(&revisions).unwrap();
        fs::write(
            revisions.join(format!("{rev_id}.json")),
            serde_json::to_vec_pretty(&rev).unwrap(),
        )
        .unwrap();
        let mut art_doc: Artifact = read_json(&store.artifact_path(&art.id)).unwrap();
        art_doc.current_revision = Some(rev_id);
        art_doc.lifecycle = "staged".into();
        fs::write(
            store.artifact_path(&art.id),
            serde_json::to_vec_pretty(&art_doc).unwrap(),
        )
        .unwrap();

        let verify_err = store.verify_artifact(&art.id).unwrap_err();
        assert!(
            verify_err.to_string().contains("junction"),
            "verify must refuse the junction itself, got: {verify_err}"
        );
        art_doc.lifecycle = "verified".into();
        fs::write(
            store.artifact_path(&art.id),
            serde_json::to_vec_pretty(&art_doc).unwrap(),
        )
        .unwrap();
        let publish_err = store.publish_artifact(&art.id).unwrap_err();
        assert!(
            publish_err.to_string().contains("junction"),
            "publish must refuse the junction itself, got: {publish_err}"
        );

        // The outside directory and its sentinel stayed byte-identical:
        // every refusal happened before any I/O through the junction.
        assert_eq!(
            fs::read_dir(&outside).unwrap().count(),
            1,
            "the outside sentinel directory must stay untouched by every boundary"
        );
        assert_eq!(
            fs::read(outside.join(&digest)).unwrap(),
            sentinel,
            "the sentinel file must stay byte-identical"
        );

        fs::remove_dir(&blobs).unwrap();
        let _ = fs::remove_dir_all(&store.paths.home);
        let _ = fs::remove_dir_all(&outside);
    }
}
