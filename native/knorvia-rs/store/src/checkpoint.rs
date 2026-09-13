//! Versioned durable checkpoints (R05). A checkpoint freezes one consistent
//! watermark of the WAL — transaction ids, per-stream sequences, journal
//! fingerprints, projection owners, and the projection file set — so the
//! next open can skip re-parsing the frozen prefix and replay only the tail.
//! It is a rebuildable accelerator and an audit pointer, never a deletion:
//! every WAL transaction file stays on disk. Any inconsistency (corrupt
//! body, hash mismatch, unknown schema, missing WAL file, missing
//! projection file) falls back to the complete replay path, which restores
//! lost projections from the WAL exactly as before.

use super::StoreError;
use super::durable::{JournalFingerprint, ProjectionKind};
use super::thread_index::ThreadDirectoryDto;
use super::timeline_index::EntryDto;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(super) const CHECKPOINT_SCHEMA_VERSION: u32 = 1;
const MANIFEST_NAME: &str = "MANIFEST.json";
/// A full replay from at least this many transactions earns an automatic
/// checkpoint, so the next open takes the fast path.
pub(super) const AUTO_CHECKPOINT_MIN_TRANSACTIONS: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct CheckpointDocument {
    pub schema_version: u32,
    pub checkpoint_id: String,
    pub created_at_ms: i64,
    /// WAL transaction ids covered by this checkpoint. Lengths (see
    /// included_lengths) let the fast path detect truncation or rewrites.
    pub included_transactions: Vec<String>,
    pub included_lengths: HashMap<String, u64>,
    pub last_sequence_by_stream: HashMap<String, u64>,
    pub journal_fingerprints: HashMap<String, Option<JournalFingerprintDto>>,
    /// Projection ownership at the watermark: (kind, id) -> owning stream.
    pub owners: Vec<OwnerEntry>,
    /// Projection file paths (relative to the state directory) that existed
    /// at the watermark, sorted and deduplicated.
    pub projection_files: Vec<String>,
    /// Thread directory snapshot (id -> workspace) at the watermark.
    pub thread_directory: Vec<ThreadDirectoryDto>,
    /// Timeline directory snapshot (turns/items/approvals entries) at the
    /// watermark, so the fast path serves full history pages without
    /// replaying the frozen prefix.
    pub timeline_entries: Vec<EntryDto>,
    /// SHA-256 over the canonical body above (everything but this field).
    pub content_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct OwnerEntry {
    pub kind: String,
    pub id: String,
    pub stream: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct JournalFingerprintDto {
    pub len: u64,
    pub modified_ms: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    live: String,
    sha256: String,
}

fn checkpoint_dir(store: &crate::ProductStore) -> std::path::PathBuf {
    store.paths().state.join("checkpoints")
}

fn system_time_to_ms(time: Option<SystemTime>) -> Option<i64> {
    time.and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
}

fn ms_to_system_time(ms: i64) -> Option<SystemTime> {
    if ms < 0 {
        return None;
    }
    UNIX_EPOCH.checked_add(Duration::from_millis(ms as u64))
}

impl From<&JournalFingerprint> for JournalFingerprintDto {
    fn from(value: &JournalFingerprint) -> Self {
        Self {
            len: value.len,
            modified_ms: system_time_to_ms(value.modified),
        }
    }
}

impl From<&JournalFingerprintDto> for JournalFingerprint {
    fn from(value: &JournalFingerprintDto) -> Self {
        Self {
            len: value.len,
            modified: value.modified_ms.and_then(ms_to_system_time),
        }
    }
}

fn canonical_body(document: &CheckpointDocument) -> Result<String, StoreError> {
    let mut body =
        serde_json::to_value(document).map_err(|e| StoreError::Corrupt(e.to_string()))?;
    body["contentSha256"]
        .take()
        .as_str()
        .ok_or_else(|| StoreError::Corrupt("checkpoint body lost its hash field".into()))?;
    // Deterministic field order for hashing: sort object keys.
    let mut sorted = String::new();
    write_sorted(&body, &mut sorted);
    Ok(sorted)
}

fn write_sorted(value: &serde_json::Value, out: &mut String) {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push(':');
                write_sorted(&map[*key], out);
            }
            out.push('}');
        }
        serde_json::Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_sorted(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

fn content_hash(document: &CheckpointDocument) -> Result<String, StoreError> {
    let mut digest = Sha256::new();
    digest.update(canonical_body(document)?.as_bytes());
    Ok(hex::encode(digest.finalize()))
}

impl crate::ProductStore {
    fn live_checkpoint_name(&self) -> Result<Option<(String, String)>, StoreError> {
        let path = checkpoint_dir(self).join(MANIFEST_NAME);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let manifest: Manifest = match serde_json::from_slice(&bytes) {
            Ok(manifest) => manifest,
            // A corrupt manifest is a broken accelerator, not lost data.
            Err(error) => {
                eprintln!("knorvia checkpoint manifest parse failed: {error}");
                return Ok(None);
            }
        };
        if !manifest
            .live
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
            || !manifest.live.ends_with(".json")
            || manifest.live.contains("..")
        {
            eprintln!(
                "knorvia checkpoint manifest name rejected: {:?}",
                manifest.live
            );
            return Ok(None);
        }
        Ok(Some((manifest.live, manifest.sha256)))
    }

    /// Load and fully verify the live checkpoint. Any problem returns None
    /// so the caller falls back to the complete replay.
    pub(super) fn load_live_checkpoint(&self) -> Result<Option<CheckpointDocument>, StoreError> {
        let Some((name, file_sha)) = self.live_checkpoint_name()? else {
            eprintln!("knorvia checkpoint manifest absent or unreadable");
            return Ok(None);
        };
        let bytes = match fs::read(checkpoint_dir(self).join(&name)) {
            Ok(bytes) => bytes,
            Err(_) => return Ok(None),
        };
        let mut digest = Sha256::new();
        digest.update(&bytes);
        let actual = hex::encode(digest.finalize());
        if actual != file_sha {
            eprintln!("knorvia checkpoint file hash mismatch: {actual} vs {file_sha}");
            return Ok(None);
        }
        let document: CheckpointDocument = match serde_json::from_slice(&bytes) {
            Ok(document) => document,
            Err(error) => {
                eprintln!("knorvia checkpoint parse failed: {error}");
                return Ok(None);
            }
        };
        if document.schema_version != CHECKPOINT_SCHEMA_VERSION {
            eprintln!("knorvia checkpoint schema mismatch");
            return Ok(None);
        }
        let body_hash = content_hash(&document)?;
        if body_hash != document.content_sha256 {
            eprintln!(
                "knorvia checkpoint body hash mismatch: computed {body_hash} stored {}",
                document.content_sha256
            );
            return Ok(None);
        }
        Ok(Some(document))
    }

    /// Freeze the current watermark into a verified checkpoint and switch
    /// the manifest atomically. Caller must hold mutation+journal (recovery
    /// done). Failure keeps the previous manifest (or none) intact.
    pub(super) fn write_checkpoint_locked(&self) -> Result<(), StoreError> {
        let state = self.locks.durable.lock().map_err(|e| {
            StoreError::Io(std::io::Error::other(format!(
                "durable state lock poisoned: {e}"
            )))
        })?;
        if !state.recovered {
            return Err(StoreError::Corrupt(
                "checkpoint requires recovered durable state".into(),
            ));
        }
        let (included_transactions, included_lengths) = {
            let wal_dir = self.wal_dir();
            let mut ids = Vec::new();
            let mut lengths = HashMap::new();
            if wal_dir.exists() {
                for entry in fs::read_dir(&wal_dir)? {
                    let path = entry?.path();
                    if path.extension().and_then(|e| e.to_str()) == Some("json") {
                        let id = path
                            .file_stem()
                            .and_then(|stem| stem.to_str())
                            .ok_or_else(|| {
                                StoreError::Corrupt("wal file name is not utf-8".into())
                            })?
                            .to_string();
                        lengths.insert(id.clone(), fs::metadata(&path)?.len());
                        ids.push(id);
                    }
                }
            }
            ids.sort();
            (ids, lengths)
        };
        let last_sequence_by_stream = state.last_sequence_by_stream.clone();
        let journal_fingerprints: HashMap<String, Option<JournalFingerprintDto>> = state
            .journal_fingerprints
            .iter()
            .map(|(stream, fingerprint)| {
                (
                    stream.clone(),
                    fingerprint.as_ref().map(JournalFingerprintDto::from),
                )
            })
            .collect();
        let owners: Vec<OwnerEntry> = state
            .projection_owners
            .iter()
            .map(|((kind, id), stream)| OwnerEntry {
                kind: kind_name(*kind).to_string(),
                id: id.clone(),
                stream: stream.clone(),
            })
            .collect();
        let projection_files = self.list_projection_files_locked()?;
        let thread_directory = self.snapshot_thread_directory()?;
        let timeline_entries = self.snapshot_timeline_entries()?;
        drop(state);

        let document = CheckpointDocument {
            schema_version: CHECKPOINT_SCHEMA_VERSION,
            checkpoint_id: knorvia_protocol::new_id("ckpt"),
            created_at_ms: Utc::now().timestamp_millis(),
            included_transactions,
            included_lengths,
            last_sequence_by_stream,
            journal_fingerprints,
            owners,
            projection_files,
            thread_directory,
            timeline_entries,
            content_sha256: String::new(),
        };
        let mut document = document;
        document.content_sha256 = content_hash(&document)?;
        let bytes =
            serde_json::to_vec_pretty(&document).map_err(|e| StoreError::Corrupt(e.to_string()))?;
        let mut digest = Sha256::new();
        digest.update(&bytes);
        let file_sha = hex::encode(digest.finalize());

        let dir = checkpoint_dir(self);
        fs::create_dir_all(&dir)?;
        let temp = dir.join(format!(
            ".{}.{}.tmp",
            document.checkpoint_id,
            std::process::id()
        ));
        fs::write(&temp, &bytes)?;
        let target = dir.join(format!("{}.json", document.checkpoint_id));
        // Replace-or-create is fine here: a checkpoint id is unique, and a
        // leftover from an identical id cannot exist.
        let _ = fs::remove_file(&target);
        fs::rename(&temp, &target)?;

        let manifest = Manifest {
            live: format!("{}.json", document.checkpoint_id),
            sha256: file_sha,
        };
        crate::atomic_write(
            &dir.join(MANIFEST_NAME),
            &serde_json::to_vec_pretty(&manifest)?,
        )
        .map_err(|e| StoreError::Io(e))
    }

    /// Every projection file currently on disk, relative to the state
    /// directory, sorted. Used both when freezing a checkpoint and when the
    /// fast path verifies that the frozen prefix is still restorable.
    pub(super) fn list_projection_files_locked(&self) -> Result<Vec<String>, StoreError> {
        let root = self.product_dir();
        let mut files = Vec::new();
        fn walk(
            dir: &std::path::Path,
            root: &std::path::Path,
            out: &mut Vec<String>,
        ) -> std::io::Result<()> {
            if !dir.exists() {
                return Ok(());
            }
            for entry in fs::read_dir(dir)? {
                let path = entry?.path();
                if path.is_dir() {
                    walk(&path, root, out)?;
                } else if path.extension().and_then(|e| e.to_str()) == Some("json") {
                    let relative = path
                        .strip_prefix(root)
                        .map_err(|e| std::io::Error::other(e.to_string()))?
                        .to_string_lossy()
                        .replace('\\', "/");
                    out.push(relative);
                }
            }
            Ok(())
        }
        walk(&root, &root, &mut files)?;
        files.sort();
        files.dedup();
        Ok(files)
    }

    /// The projection files that went missing since the checkpoint. Empty
    /// means the frozen prefix is still fully restorable-in-place.
    pub(super) fn missing_projection_files(
        &self,
        expected: &[String],
    ) -> Result<Vec<String>, StoreError> {
        let current: std::collections::HashSet<String> =
            self.list_projection_files_locked()?.into_iter().collect();
        Ok(expected
            .iter()
            .filter(|path| !current.contains(*path))
            .cloned()
            .collect())
    }

    /// Public maintenance entry point: freeze a verified checkpoint of the
    /// current watermark. Requires the OS Home lock in production.
    pub fn create_durable_checkpoint(&self) -> Result<(), StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.write_checkpoint_locked()
    }

    /// Process-local description of how the last recovery ran. Diagnostics
    /// only; never authoritative.
    pub fn last_recovery_mode(&self) -> String {
        self.locks
            .durable
            .lock()
            .map(|state| state.recovery_mode.clone())
            .unwrap_or_else(|_| "unknown".into())
    }
}

pub(super) fn kind_name(kind: ProjectionKind) -> &'static str {
    match kind {
        ProjectionKind::Workspace => "Workspace",
        ProjectionKind::WorkspaceCwd => "WorkspaceCwd",
        ProjectionKind::Goal => "Goal",
        ProjectionKind::GoalExecution => "GoalExecution",
        ProjectionKind::Task => "Task",
        ProjectionKind::Thread => "Thread",
        ProjectionKind::Artifact => "Artifact",
        ProjectionKind::Revision => "Revision",
        ProjectionKind::Job => "Job",
        ProjectionKind::Turn => "Turn",
        ProjectionKind::Item => "Item",
        ProjectionKind::Approval => "Approval",
        ProjectionKind::Automation => "Automation",
        ProjectionKind::AutomationRun => "AutomationRun",
        ProjectionKind::Bot => "Bot",
        ProjectionKind::Room => "Room",
        ProjectionKind::SessionBinding => "SessionBinding",
        ProjectionKind::BindingKey => "BindingKey",
        ProjectionKind::ChatMessage => "ChatMessage",
        ProjectionKind::KernelBinding => "KernelBinding",
        ProjectionKind::MessageQueue => "MessageQueue",
        ProjectionKind::RoomSend => "RoomSend",
    }
}

pub(super) fn kind_from_name(name: &str) -> Option<ProjectionKind> {
    Some(match name {
        "Workspace" => ProjectionKind::Workspace,
        "WorkspaceCwd" => ProjectionKind::WorkspaceCwd,
        "Goal" => ProjectionKind::Goal,
        "GoalExecution" => ProjectionKind::GoalExecution,
        "Task" => ProjectionKind::Task,
        "Thread" => ProjectionKind::Thread,
        "Artifact" => ProjectionKind::Artifact,
        "Revision" => ProjectionKind::Revision,
        "Job" => ProjectionKind::Job,
        "Turn" => ProjectionKind::Turn,
        "Item" => ProjectionKind::Item,
        "Approval" => ProjectionKind::Approval,
        "Automation" => ProjectionKind::Automation,
        "AutomationRun" => ProjectionKind::AutomationRun,
        "Bot" => ProjectionKind::Bot,
        "Room" => ProjectionKind::Room,
        "SessionBinding" => ProjectionKind::SessionBinding,
        "BindingKey" => ProjectionKind::BindingKey,
        "ChatMessage" => ProjectionKind::ChatMessage,
        "KernelBinding" => ProjectionKind::KernelBinding,
        "MessageQueue" => ProjectionKind::MessageQueue,
        "RoomSend" => ProjectionKind::RoomSend,
        _ => return None,
    })
}
