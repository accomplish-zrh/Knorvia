//! Write-ahead transaction records for product projections and event streams.
//!
//! A transaction record is synced before any projection is changed. Records
//! are deliberately retained: they let recovery rebuild a lost or truncated
//! JSONL projection without guessing at a sequence number or event payload.

use super::{ProductStore, StoreError, atomic_write, event_id, new_id, now_rfc3339};
use knorvia_protocol::EventEnvelope;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::SystemTime;

const WAL_SCHEMA_VERSION: u32 = 1;

/// Process-local acceleration metadata. It is rebuilt from WAL plus JSONL on
/// every open and after any uncertain write. Nothing here is authoritative;
/// the durable transaction files remain the recovery source of truth.
#[derive(Debug, Default)]
pub(super) struct DurableState {
    pub(super) recovered: bool,
    pub(super) last_sequence_by_stream: HashMap<String, u64>,
    pub(super) projection_owners: HashMap<(ProjectionKind, String), String>,
    pub(super) journal_fingerprints: HashMap<String, Option<JournalFingerprint>>,
    /// How the most recent recovery ran: "full", "checkpoint", or "none".
    pub(super) recovery_mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct JournalFingerprint {
    pub(super) len: u64,
    pub(super) modified: Option<SystemTime>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ProjectionKind {
    Workspace,
    WorkspaceCwd,
    Goal,
    GoalExecution,
    Task,
    Thread,
    Artifact,
    Revision,
    Job,
    Turn,
    Item,
    Approval,
    Automation,
    AutomationRun,
    Bot,
    Room,
    SessionBinding,
    BindingKey,
    ChatMessage,
    KernelBinding,
    MessageQueue,
    RoomSend,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectionWrite {
    kind: ProjectionKind,
    id: String,
    document: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DurableTransaction {
    pub(super) schema_version: u32,
    pub(super) transaction_id: String,
    pub(super) stream_id: String,
    pub(super) committed_at: String,
    // `event` is the original on-disk WAL shape. Keep accepting it so an
    // existing user state can be reopened after this version adds atomic
    // snapshot transactions such as thread forks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) event: Option<EventEnvelope>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) events: Vec<EventEnvelope>,
    pub(super) writes: Vec<ProjectionWrite>,
    #[serde(default)]
    pub(super) state: DurableTransactionState,
}

impl DurableTransaction {
    pub(super) fn events(&self) -> Result<&[EventEnvelope], StoreError> {
        match (self.event.as_ref(), self.events.is_empty()) {
            (Some(event), true) => Ok(std::slice::from_ref(event)),
            (None, false) => Ok(&self.events),
            (Some(_), false) => Err(StoreError::Corrupt(format!(
                "durable transaction {} has both legacy event and event batch",
                self.transaction_id
            ))),
            (None, true) => Err(StoreError::Corrupt(format!(
                "durable transaction {} has no events",
                self.transaction_id
            ))),
        }
    }

    fn first_event(&self) -> Result<&EventEnvelope, StoreError> {
        self.events()?.first().ok_or_else(|| {
            StoreError::Corrupt(format!(
                "durable transaction {} has no first event",
                self.transaction_id
            ))
        })
    }
}

#[derive(Debug)]
pub(super) struct EventDraft {
    pub(super) kind: String,
    pub(super) payload: Value,
    pub(super) correlation_id: Option<String>,
}

impl EventDraft {
    pub(super) fn new(kind: impl Into<String>, payload: Value) -> Self {
        Self {
            kind: kind.into(),
            payload,
            correlation_id: None,
        }
    }

    pub(super) fn with_correlation(
        kind: impl Into<String>,
        payload: Value,
        correlation_id: Option<String>,
    ) -> Self {
        Self {
            kind: kind.into(),
            payload,
            correlation_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", tag = "state")]
pub(super) enum DurableTransactionState {
    #[default]
    Intent,
    Aborted {
        aborted_at: String,
        reason: String,
    },
}

/// Distinguishes a workspace cwd that should remain unchanged from one that
/// should be explicitly cleared. The workspace's revision covers either a
/// title or cwd change, so callers can use one optimistic-concurrency check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceCwdUpdate<'a> {
    Unchanged,
    Set(&'a str),
    Clear,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DurableFailpoint {
    AfterIntentPersisted,
    AfterProjectionApplied,
}

#[cfg(test)]
thread_local! {
    static FAILPOINT: std::cell::RefCell<Option<DurableFailpoint>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(super) fn inject_failure(point: DurableFailpoint) {
    FAILPOINT.with(|failpoint| *failpoint.borrow_mut() = Some(point));
}

fn validate_component(value: &str, kind: &str) -> Result<(), StoreError> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains(['/', '\\'])
        || value.contains('\0')
    {
        return Err(StoreError::Corrupt(format!(
            "invalid {kind} component in durable transaction"
        )));
    }
    Ok(())
}

impl ProjectionKind {
    /// Projection file location for `document`. Item projections are sharded
    /// per thread and prefixed with their stable sequence, so paging a long
    /// history reads one bounded directory slice instead of every item ever
    /// stored. Older WAL records replay through the same document-driven
    /// path, which migrates them into the sharded layout on recovery.
    fn path(self, store: &ProductStore, id: &str, document: &Value) -> PathBuf {
        match self {
            Self::Workspace => store.ws_path(id),
            Self::WorkspaceCwd => store.workspace_cwd_path(id),
            Self::Goal => store.goal_path(id),
            Self::GoalExecution => store.goal_execution_path(id),
            Self::Task => store.task_path(id),
            Self::Thread => store.thread_path(id),
            Self::Artifact => store.artifact_path(id),
            Self::Revision => store.revision_path(id),
            Self::Job => store.job_path(id),
            Self::Turn => store.turn_path(id),
            Self::Item => {
                let thread_id = document
                    .get("threadId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let seq = document.get("seq").and_then(Value::as_u64);
                store.sharded_item_path(thread_id, seq, id)
            }
            Self::Approval => store.approval_path(id),
            Self::Automation => store.automation_path(id),
            Self::AutomationRun => store.automation_run_path(id),
            Self::Bot => store.bot_path(id),
            Self::Room => store.room_path(id),
            Self::SessionBinding => store.binding_path(id),
            Self::KernelBinding => store.kernel_binding_path(id),
            Self::MessageQueue => store.message_queue_path(id),
            Self::RoomSend => store.room_send_path(id),
            Self::BindingKey => store.binding_key_path(id),
            Self::ChatMessage => {
                let conversation_id = document
                    .get("conversationId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let seq = document.get("seq").and_then(Value::as_u64);
                store.chat_message_path(conversation_id, seq, id)
            }
        }
    }
}

impl ProductStore {
    pub(super) fn invalidate_durable_state(&self) -> Result<(), StoreError> {
        let mut state = self.locks.durable.lock().map_err(|e| {
            StoreError::Io(io::Error::other(format!(
                "durable state lock poisoned: {e}"
            )))
        })?;
        state.recovered = false;
        Ok(())
    }

    fn durable_state_is_recovered(&self) -> Result<bool, StoreError> {
        let state = self.locks.durable.lock().map_err(|e| {
            StoreError::Io(io::Error::other(format!(
                "durable state lock poisoned: {e}"
            )))
        })?;
        Ok(state.recovered)
    }

    fn cached_next_sequence(&self, stream_id: &str) -> Result<u64, StoreError> {
        let state = self.locks.durable.lock().map_err(|e| {
            StoreError::Io(io::Error::other(format!(
                "durable state lock poisoned: {e}"
            )))
        })?;
        if !state.recovered {
            return Err(StoreError::Corrupt(
                "durable state was read before recovery".into(),
            ));
        }
        state
            .last_sequence_by_stream
            .get(stream_id)
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| StoreError::Corrupt(format!("event sequence exhausted for {stream_id}")))
    }

    fn journal_fingerprint(
        &self,
        stream_id: &str,
    ) -> Result<Option<JournalFingerprint>, StoreError> {
        let path = self.events_path(stream_id);
        match fs::metadata(path) {
            Ok(metadata) => Ok(Some(JournalFingerprint {
                len: metadata.len(),
                modified: metadata.modified().ok(),
            })),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Detect an out-of-band JSONL replacement before trusting the in-memory
    /// index. The follow-up recovery is intentionally full: a changed file is
    /// either an older user state to merge or corruption to preserve/fail on.
    pub(super) fn ensure_stream_journal_is_current(
        &self,
        stream_id: &str,
    ) -> Result<(), StoreError> {
        validate_component(stream_id, "stream id")?;
        let expected = {
            let state = self.locks.durable.lock().map_err(|e| {
                StoreError::Io(io::Error::other(format!(
                    "durable state lock poisoned: {e}"
                )))
            })?;
            if !state.recovered {
                return Err(StoreError::Corrupt(
                    "journal fingerprint was read before recovery".into(),
                ));
            }
            state
                .journal_fingerprints
                .get(stream_id)
                .cloned()
                .unwrap_or(None)
        };
        if self.journal_fingerprint(stream_id)? != expected {
            self.invalidate_durable_state()?;
            self.recover_durable_state_locked()?;
        }
        Ok(())
    }

    fn validate_cached_projection_owners(
        &self,
        stream_id: &str,
        writes: &[ProjectionWrite],
    ) -> Result<(), StoreError> {
        let state = self.locks.durable.lock().map_err(|e| {
            StoreError::Io(io::Error::other(format!(
                "durable state lock poisoned: {e}"
            )))
        })?;
        if !state.recovered {
            return Err(StoreError::Corrupt(
                "projection owner state was read before recovery".into(),
            ));
        }
        for write in writes {
            let key = (write.kind, write.id.clone());
            if let Some(owner) = state.projection_owners.get(&key)
                && owner != stream_id
            {
                return Err(StoreError::Corrupt(format!(
                    "projection {:?}/{} is owned by stream {owner}, not {stream_id}",
                    write.kind, write.id
                )));
            }
        }
        Ok(())
    }

    fn record_committed_transaction(
        &self,
        transaction: &DurableTransaction,
    ) -> Result<(), StoreError> {
        let mut state = self.locks.durable.lock().map_err(|e| {
            StoreError::Io(io::Error::other(format!(
                "durable state lock poisoned: {e}"
            )))
        })?;
        let last = transaction
            .events()?
            .last()
            .expect("validated transaction contains an event")
            .seq;
        state
            .last_sequence_by_stream
            .insert(transaction.stream_id.clone(), last);
        state.journal_fingerprints.insert(
            transaction.stream_id.clone(),
            self.journal_fingerprint(&transaction.stream_id)?,
        );
        for write in &transaction.writes {
            state.projection_owners.insert(
                (write.kind, write.id.clone()),
                transaction.stream_id.clone(),
            );
        }
        state.recovered = true;
        Ok(())
    }

    fn record_recovered_state(
        &self,
        last_sequence_by_stream: HashMap<String, u64>,
        projection_owners: HashMap<(ProjectionKind, String), String>,
        journal_fingerprints: HashMap<String, Option<JournalFingerprint>>,
    ) -> Result<(), StoreError> {
        let mut state = self.locks.durable.lock().map_err(|e| {
            StoreError::Io(io::Error::other(format!(
                "durable state lock poisoned: {e}"
            )))
        })?;
        state.last_sequence_by_stream = last_sequence_by_stream;
        state.projection_owners = projection_owners;
        state.journal_fingerprints = journal_fingerprints;
        state.recovered = true;
        Ok(())
    }

    pub(super) fn next_event_sequence_locked(&self, stream_id: &str) -> Result<u64, StoreError> {
        validate_component(stream_id, "stream id")?;
        self.recover_durable_state_locked()?;
        self.ensure_stream_journal_is_current(stream_id)?;
        self.cached_next_sequence(stream_id)
    }

    pub(super) fn projection_write<T: Serialize>(
        &self,
        kind: ProjectionKind,
        id: &str,
        document: &T,
    ) -> Result<ProjectionWrite, StoreError> {
        validate_component(id, "projection id")?;
        Ok(ProjectionWrite {
            kind,
            id: id.to_string(),
            document: serde_json::to_value(document)?,
        })
    }

    /// Commit an event and every matching JSON projection as one recoverable
    /// unit. The caller holds `mutation` and `journal`, in that order.
    pub(super) fn commit_transaction_locked(
        &self,
        stream_id: &str,
        kind: &str,
        payload: Value,
        correlation_id: Option<String>,
        writes: Vec<ProjectionWrite>,
    ) -> Result<EventEnvelope, StoreError> {
        let mut events = self.commit_transaction_batch_locked(
            stream_id,
            vec![EventDraft::with_correlation(kind, payload, correlation_id)],
            writes,
        )?;
        Ok(events
            .pop()
            .expect("a one-event transaction returns one event"))
    }

    /// Commit a batch of consecutive events and their complete projection
    /// snapshot in one WAL record. A restart either recovers the entire batch
    /// or sees none of it; this is used when one user action creates a thread
    /// together with its historical turns, items, and approvals.
    pub(super) fn commit_transaction_batch_locked(
        &self,
        stream_id: &str,
        drafts: Vec<EventDraft>,
        writes: Vec<ProjectionWrite>,
    ) -> Result<Vec<EventEnvelope>, StoreError> {
        validate_component(stream_id, "stream id")?;
        if drafts.is_empty() {
            return Err(StoreError::Corrupt(
                "durable transaction needs at least one event".into(),
            ));
        }
        self.recover_durable_state_locked()?;
        self.ensure_stream_journal_is_current(stream_id)?;
        let first_seq = self.cached_next_sequence(stream_id)?;
        let events = drafts
            .into_iter()
            .enumerate()
            .map(|(index, draft)| {
                let offset = u64::try_from(index).map_err(|_| {
                    StoreError::Corrupt(format!("event batch is too large for stream {stream_id}"))
                })?;
                let seq = first_seq.checked_add(offset).ok_or_else(|| {
                    StoreError::Corrupt(format!("event sequence exhausted for {stream_id}"))
                })?;
                Ok(EventEnvelope {
                    event_id: event_id(),
                    stream_id: stream_id.to_string(),
                    seq,
                    emitted_at: now_rfc3339(),
                    causation_id: None,
                    correlation_id: draft.correlation_id,
                    schema_version: 1,
                    kind: draft.kind,
                    payload: draft.payload,
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        let transaction = DurableTransaction {
            schema_version: WAL_SCHEMA_VERSION,
            transaction_id: new_id("txn"),
            stream_id: stream_id.to_string(),
            committed_at: now_rfc3339(),
            event: None,
            events: events.clone(),
            writes,
            state: DurableTransactionState::Intent,
        };
        // Reject deterministic projection-path failures before the WAL record
        // becomes durable. Once the record is synced it is an authoritative
        // committed fact: a later I/O error is ambiguous (a rename may already
        // have happened), so recovery must finish it instead of marking it
        // aborted and leaving one of a multi-projection write behind.
        self.validate_transaction(
            &transaction,
            &self.transaction_path(&transaction.transaction_id),
        )?;
        self.validate_cached_projection_owners(stream_id, &transaction.writes)?;
        self.ensure_projection_writes_ready(&transaction.writes)?;
        self.ensure_stream_journal_ready(stream_id)?;
        self.persist_transaction(&transaction)?;
        self.invalidate_durable_state()?;
        self.fail_if_requested(DurableFailpointName::AfterIntentPersisted)?;

        // Do not convert a durable intent to `Aborted` here. A projection
        // write can fail after another projection in the same transaction has
        // already been atomically replaced. Keeping the intent lets the next
        // open recover every projection and its matching event together.
        self.apply_projection_writes_locked(std::slice::from_ref(&transaction), false)?;
        self.fail_if_requested(DurableFailpointName::AfterProjectionApplied)?;

        self.append_stream_journal_events_locked(stream_id, &events)?;
        self.record_committed_transaction(&transaction)?;
        Ok(events)
    }

    pub(super) fn recover_durable_state(&self) -> Result<(), StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()
    }

    pub(super) fn recover_durable_state_locked(&self) -> Result<(), StoreError> {
        if self.durable_state_is_recovered()? {
            return Ok(());
        }
        self.invalidate_usage_index()?;
        self.locks.replay_indexes.lock().map_err(|_| StoreError::Corrupt("replay index lock poisoned".into()))?.0.clear();
        let started = std::time::Instant::now();
        let trace = std::env::var_os("KNORVIA_RECOVERY_TRACE").is_some();
        if let Some(transactions) = self.recover_from_checkpoint_locked(&started, trace)? {
            let _ = transactions;
            return Ok(());
        }
        let transactions = self.load_transactions()?;
        if trace {
            eprintln!(
                "knorvia recovery stage=transactions count={} elapsed_ms={}",
                transactions.len(),
                started.elapsed().as_millis()
            );
        }
        self.reset_thread_index()?;
        self.reset_timeline_index()?;
        self.reset_automation_index()?;
        self.apply_projection_writes_locked(&transactions, true)?;
        self.include_legacy_thread_index()?;
        self.include_legacy_timeline_index()?;
        if trace {
            eprintln!(
                "knorvia recovery stage=projections elapsed_ms={}",
                started.elapsed().as_millis()
            );
        }

        let mut streams = self.event_stream_ids()?;
        streams.extend(
            transactions
                .iter()
                .map(|transaction| transaction.stream_id.clone()),
        );
        streams.sort();
        streams.dedup();
        let stream_count = streams.len();
        let mut last_sequence_by_stream = HashMap::new();
        let mut journal_fingerprints = HashMap::new();
        for stream_id in streams {
            // load_transactions sorts by stream and sequence. Restrict each
            // merge to its own slice instead of rescanning every transaction
            // for each of thousands of unrelated task streams.
            let start =
                transactions.partition_point(|transaction| transaction.stream_id < stream_id);
            let length = transactions[start..]
                .partition_point(|transaction| transaction.stream_id == stream_id);
            let last = self
                .recover_stream_journal_locked(&stream_id, &transactions[start..start + length])?;
            journal_fingerprints.insert(stream_id.clone(), self.journal_fingerprint(&stream_id)?);
            last_sequence_by_stream.insert(stream_id, last);
        }
        let projection_owners = self.projection_owners(&transactions, None)?;
        self.record_recovered_state(
            last_sequence_by_stream,
            projection_owners,
            journal_fingerprints,
        )?;
        {
            let mut state = self.locks.durable.lock().map_err(|e| {
                StoreError::Io(io::Error::other(format!(
                    "durable state lock poisoned: {e}"
                )))
            })?;
            state.recovery_mode = "full".into();
        }
        if trace {
            eprintln!(
                "knorvia recovery stage=complete streams={stream_count} elapsed_ms={}",
                started.elapsed().as_millis()
            );
        }
        // A big replay earns an automatic checkpoint so the next open takes
        // the fast path. The checkpoint is an accelerator: a failure here is
        // logged and ignored, never surfaced as store corruption.
        if transactions.len() >= crate::checkpoint::AUTO_CHECKPOINT_MIN_TRANSACTIONS
            && let Err(error) = self.write_checkpoint_locked()
        {
            eprintln!("knorvia checkpoint write skipped: {error}");
        }
        Ok(())
    }

    /// Checkpoint fast path: verify the live checkpoint, replay only the
    /// WAL tail, and refuse (falling back to full replay) on any mismatch.
    /// Missing projection files since the checkpoint also fall back, which
    /// restores them from the WAL exactly like the legacy path.
    fn recover_from_checkpoint_locked(
        &self,
        started: &std::time::Instant,
        trace: bool,
    ) -> Result<Option<Vec<DurableTransaction>>, StoreError> {
        let Some(checkpoint) = self.load_live_checkpoint()? else {
            return Ok(None);
        };
        // Every checkpointed WAL file must still exist; a missing one means
        // the frozen prefix is no longer what the checkpoint described.
        let mut tail_ids = std::collections::HashSet::new();
        let wal_dir = self.wal_dir();
        let mut present = std::collections::HashSet::new();
        if wal_dir.exists() {
            for entry in fs::read_dir(&wal_dir)? {
                let path = entry?.path();
                if path.extension().and_then(|e| e.to_str()) == Some("json") {
                    if let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) {
                        present.insert(id.to_string());
                    }
                }
            }
        }
        for id in &checkpoint.included_transactions {
            if !present.contains(id) {
                return Ok(None);
            }
        }
        // A changed size means the frozen file was truncated or rewritten:
        // reject the accelerator so full replay re-validates the bytes and
        // fails closed on unreadable history.
        for (id, expected_len) in &checkpoint.included_lengths {
            match fs::metadata(wal_dir.join(format!("{id}.json"))) {
                Ok(metadata) => {
                    if metadata.len() != *expected_len {
                        if trace {
                            eprintln!(
                                "knorvia recovery checkpoint rejected: wal file {id} changed size"
                            );
                        }
                        return Ok(None);
                    }
                }
                Err(_) => return Ok(None),
            }
        }
        for id in &present {
            if !checkpoint.included_transactions.contains(id) {
                tail_ids.insert(id.clone());
            }
        }
        // The prefix's projections must all still be on disk. A missing one
        // is restored by the full replay fallback, preserving the guarantee
        // that projections are rebuildable from the WAL.
        let missing = self.missing_projection_files(&checkpoint.projection_files)?;
        if !missing.is_empty() {
            if trace {
                eprintln!(
                    "knorvia recovery checkpoint rejected: {} projection files missing",
                    missing.len()
                );
            }
            return Ok(None);
        }
        let transactions = self.load_transactions_from_ids(&tail_ids)?;
        if trace {
            eprintln!(
                "knorvia recovery stage=checkpoint tail={} included={} elapsed_ms={}",
                transactions.len(),
                checkpoint.included_transactions.len(),
                started.elapsed().as_millis()
            );
        }
        self.reset_thread_index()?;
        self.reset_timeline_index()?;
        self.reset_automation_index()?;
        // The frozen prefix's projections were verified present; rebuild the
        // directory indexes from the checkpoint so history pages cover the
        // prefix without replaying it.
        self.restore_thread_directory(
            checkpoint
                .thread_directory
                .iter()
                .map(|dto| crate::thread_index::ThreadDirectoryDto {
                    id: dto.id.clone(),
                    workspace_id: dto.workspace_id.clone(),
                })
                .collect(),
        )?;
        self.restore_timeline_entries(
            checkpoint
                .timeline_entries
                .iter()
                .map(|dto| crate::timeline_index::EntryDto {
                    thread_id: dto.thread_id.clone(),
                    id: dto.id.clone(),
                    turn_id: dto.turn_id.clone(),
                    key0: dto.key0.clone(),
                    key1: dto.key1.clone(),
                    status: dto.status.clone(),
                    kind: dto.kind.clone(),
                    dir: dto.dir.clone(),
                    pending: dto.pending,
                    path: dto.path.clone(),
                })
                .collect(),
        )?;
        self.apply_projection_writes_locked(&transactions, true)?;
        self.include_legacy_thread_index()?;
        self.include_legacy_timeline_index()?;
        if trace {
            let restored = self.snapshot_timeline_entries()?.len();
            eprintln!("knorvia recovery stage=index-restore entries={restored}");
        }

        let mut streams = self.event_stream_ids()?;
        streams.extend(
            transactions
                .iter()
                .map(|transaction| transaction.stream_id.clone()),
        );
        streams.extend(checkpoint.last_sequence_by_stream.keys().cloned());
        streams.extend(checkpoint.journal_fingerprints.keys().cloned());
        streams.sort();
        streams.dedup();
        let mut last_sequence_by_stream = HashMap::new();
        let mut journal_fingerprints = HashMap::new();
        for stream_id in streams {
            let start =
                transactions.partition_point(|transaction| transaction.stream_id < stream_id);
            let length = transactions[start..]
                .partition_point(|transaction| transaction.stream_id == stream_id);
            let prefix_last = checkpoint.last_sequence_by_stream.get(&stream_id).copied();
            let tail_last = self
                .recover_stream_journal_locked(&stream_id, &transactions[start..start + length])?;
            last_sequence_by_stream
                .insert(stream_id.clone(), prefix_last.unwrap_or(0).max(tail_last));
            journal_fingerprints.insert(stream_id.clone(), self.journal_fingerprint(&stream_id)?);
        }
        // Owners: start from the checkpoint watermark, then fold the tail in
        // with the same cross-stream ownership corruption check.
        let mut projection_owners = HashMap::new();
        for owner in &checkpoint.owners {
            let Some(kind) = crate::checkpoint::kind_from_name(&owner.kind) else {
                return Ok(None);
            };
            projection_owners.insert((kind, owner.id.clone()), owner.stream.clone());
        }
        for transaction in &transactions {
            for write in &transaction.writes {
                let key = (write.kind, write.id.clone());
                if let Some(owner) = projection_owners.get(&key) {
                    if owner != &transaction.stream_id {
                        return Err(StoreError::Corrupt(format!(
                            "projection {:?}/{} is owned by stream {owner}, not {}",
                            write.kind, write.id, transaction.stream_id
                        )));
                    }
                } else {
                    projection_owners.insert(key, transaction.stream_id.clone());
                }
            }
        }
        self.record_recovered_state(
            last_sequence_by_stream,
            projection_owners,
            journal_fingerprints,
        )?;
        {
            let mut state = self.locks.durable.lock().map_err(|e| {
                StoreError::Io(io::Error::other(format!(
                    "durable state lock poisoned: {e}"
                )))
            })?;
            state.recovery_mode = "checkpoint".into();
        }
        Ok(Some(transactions))
    }

    fn event_stream_ids(&self) -> Result<Vec<String>, StoreError> {
        let events = self.paths.state.join("events");
        if !events.exists() {
            return Ok(Vec::new());
        }
        let mut streams = Vec::new();
        for entry in fs::read_dir(events)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                return Err(StoreError::Corrupt(format!(
                    "event journal has a non-UTF-8 file name: {path:?}"
                )));
            };
            validate_component(stem, "event stream")?;
            streams.push(stem.to_string());
        }
        Ok(streams)
    }

    fn transaction_path(&self, transaction_id: &str) -> PathBuf {
        self.wal_dir().join(format!("{transaction_id}.json"))
    }

    fn persist_transaction(&self, transaction: &DurableTransaction) -> Result<(), StoreError> {
        validate_component(&transaction.transaction_id, "transaction id")?;
        atomic_write(
            &self.transaction_path(&transaction.transaction_id),
            &serde_json::to_vec_pretty(transaction)?,
        )?;
        Ok(())
    }

    /// Make deterministic filesystem problems visible before creating a WAL
    /// intent. This is intentionally conservative: permissions and storage
    /// health can still change after the check, and those post-intent errors
    /// must be recovered by replaying the durable fact.
    fn ensure_projection_writes_ready(&self, writes: &[ProjectionWrite]) -> Result<(), StoreError> {
        for write in writes {
            let path = write.kind.path(self, &write.id, &write.document);
            let parent = path.parent().ok_or_else(|| {
                StoreError::Corrupt(format!("projection path has no parent: {path:?}"))
            })?;
            fs::create_dir_all(parent)?;
            if !fs::metadata(parent)?.is_dir() {
                return Err(StoreError::Io(io::Error::other(format!(
                    "projection parent is not a directory: {parent:?}"
                ))));
            }
            if path.exists() && fs::metadata(&path)?.is_dir() {
                return Err(StoreError::Io(io::Error::other(format!(
                    "projection path is a directory: {path:?}"
                ))));
            }
        }
        Ok(())
    }

    fn ensure_stream_journal_ready(&self, stream_id: &str) -> Result<(), StoreError> {
        let path = self.events_path(stream_id);
        let parent = path.parent().ok_or_else(|| {
            StoreError::Corrupt(format!("event journal path has no parent: {path:?}"))
        })?;
        fs::create_dir_all(parent)?;
        if path.exists() && fs::metadata(&path)?.is_dir() {
            return Err(StoreError::Io(io::Error::other(format!(
                "event journal path is a directory: {path:?}"
            ))));
        }
        Ok(())
    }

    pub(super) fn load_transactions(&self) -> Result<Vec<DurableTransaction>, StoreError> {
        self.load_transactions_filtered(None)
    }

    /// Parse only the WAL files whose ids pass the optional filter (the
    /// checkpoint fast path replays just the tail). Validation semantics
    /// are identical to the full scan.
    pub(super) fn load_transactions_filtered(
        &self,
        ids: Option<&std::collections::HashSet<String>>,
    ) -> Result<Vec<DurableTransaction>, StoreError> {
        let wal_dir = self.wal_dir();
        if !wal_dir.exists() {
            return Ok(Vec::new());
        }
        let mut transactions = Vec::new();
        for entry in fs::read_dir(&wal_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            if let Some(ids) = ids {
                let stem_ok = path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .is_some_and(|stem| ids.contains(stem));
                if !stem_ok {
                    continue;
                }
            }
            let bytes = fs::read(&path)?;
            let transaction = match serde_json::from_slice::<DurableTransaction>(&bytes) {
                Ok(transaction) => transaction,
                Err(error) => {
                    self.preserve_recovery_evidence(&path, &bytes, "invalid durable transaction")?;
                    return Err(StoreError::Corrupt(format!(
                        "invalid durable transaction {path:?}: {error}"
                    )));
                }
            };
            if let Err(error) = self.validate_transaction(&transaction, &path) {
                self.preserve_recovery_evidence(
                    &path,
                    &bytes,
                    &format!("invalid durable transaction: {error}"),
                )?;
                return Err(error);
            }
            if matches!(transaction.state, DurableTransactionState::Intent) {
                transactions.push(transaction);
            }
        }
        transactions.sort_by(|left, right| {
            left.stream_id
                .cmp(&right.stream_id)
                .then_with(|| {
                    left.first_event()
                        .expect("transactions were validated before sorting")
                        .seq
                        .cmp(
                            &right
                                .first_event()
                                .expect("transactions were validated before sorting")
                                .seq,
                        )
                })
                .then_with(|| left.transaction_id.cmp(&right.transaction_id))
        });
        let mut sequences = HashSet::new();
        let mut event_ids = HashSet::new();
        for transaction in &transactions {
            for event in transaction.events()? {
                if !sequences.insert((transaction.stream_id.clone(), event.seq)) {
                    return Err(StoreError::Corrupt(format!(
                        "duplicate WAL sequence {} for stream {}",
                        event.seq, transaction.stream_id
                    )));
                }
                if !event_ids.insert(event.event_id.clone()) {
                    return Err(StoreError::Corrupt(format!(
                        "duplicate WAL event id {}",
                        event.event_id
                    )));
                }
            }
        }
        self.validate_projection_stream_ownership(&transactions, None)?;
        Ok(transactions)
    }

    fn load_transactions_from_ids(
        &self,
        ids: &std::collections::HashSet<String>,
    ) -> Result<Vec<DurableTransaction>, StoreError> {
        self.load_transactions_filtered(Some(ids))
    }

    fn validate_transaction(
        &self,
        transaction: &DurableTransaction,
        path: &std::path::Path,
    ) -> Result<(), StoreError> {
        if transaction.schema_version != WAL_SCHEMA_VERSION {
            return Err(StoreError::Corrupt(format!(
                "unsupported WAL schema {} in {path:?}",
                transaction.schema_version
            )));
        }
        validate_component(&transaction.transaction_id, "transaction id")?;
        validate_component(&transaction.stream_id, "stream id")?;
        let events = transaction.events()?;
        let mut previous_seq: Option<u64> = None;
        for event in events {
            if event.stream_id != transaction.stream_id
                || event.seq == 0
                || event.event_id.is_empty()
            {
                return Err(StoreError::Corrupt(format!(
                    "invalid event metadata in durable transaction {path:?}"
                )));
            }
            if let Some(previous_seq) = previous_seq
                && event.seq
                    != previous_seq.checked_add(1).ok_or_else(|| {
                        StoreError::Corrupt(format!(
                            "event sequence exhausted in durable transaction {path:?}"
                        ))
                    })?
            {
                return Err(StoreError::Corrupt(format!(
                    "non-consecutive event batch in durable transaction {path:?}"
                )));
            }
            previous_seq = Some(event.seq);
        }
        let mut paths = HashSet::new();
        for write in &transaction.writes {
            validate_component(&write.id, "projection id")?;
            if !paths.insert((write.kind, write.id.clone())) {
                return Err(StoreError::Corrupt(format!(
                    "duplicate projection write in durable transaction {path:?}"
                )));
            }
        }
        Ok(())
    }

    /// A projection has exactly one owning event stream for its lifetime.
    /// Recovery selects the newest write within that stream; allowing two
    /// unrelated streams to write the same projection would make a global
    /// lexical WAL scan pick an arbitrary winner after restart.
    fn validate_projection_stream_ownership(
        &self,
        transactions: &[DurableTransaction],
        candidate: Option<&DurableTransaction>,
    ) -> Result<(), StoreError> {
        self.projection_owners(transactions, candidate).map(|_| ())
    }

    fn projection_owners(
        &self,
        transactions: &[DurableTransaction],
        candidate: Option<&DurableTransaction>,
    ) -> Result<HashMap<(ProjectionKind, String), String>, StoreError> {
        let mut owners = HashMap::<(ProjectionKind, String), String>::new();
        for transaction in transactions.iter().chain(candidate.into_iter()) {
            for write in &transaction.writes {
                let key = (write.kind, write.id.clone());
                if let Some(owner) = owners.get(&key) {
                    if owner != &transaction.stream_id {
                        return Err(StoreError::Corrupt(format!(
                            "projection {:?}/{} is owned by stream {owner}, not {}",
                            write.kind, write.id, transaction.stream_id
                        )));
                    }
                } else {
                    owners.insert(key, transaction.stream_id.clone());
                }
            }
        }
        Ok(owners)
    }

    fn apply_projection_writes_locked(
        &self,
        transactions: &[DurableTransaction],
        preserve_replaced: bool,
    ) -> Result<(), StoreError> {
        let mut latest = BTreeMap::new();
        for transaction in transactions {
            for write in &transaction.writes {
                latest.insert(
                    write.kind.path(self, &write.id, &write.document),
                    (write.kind, write.id.clone(), write.document.clone()),
                );
            }
        }
        for (path, (kind, id, document)) in latest {
            let expected = serde_json::to_vec_pretty(&document)?;
            let projected_timeline =
                super::timeline_index::TimelineProjection::parse(kind, &id, &document)?;
            let projected_thread = if kind == ProjectionKind::Thread {
                let thread: knorvia_protocol::Thread = serde_json::from_slice(&expected)?;
                if thread.id != id {
                    return Err(StoreError::Corrupt(format!(
                        "thread transaction document identity does not match {id}"
                    )));
                }
                Some(thread)
            } else {
                None
            };
            if kind == ProjectionKind::Item {
                // Maintain the O(1) id → document locator on every recovery
                // pass, even when the sharded document itself already
                // matches. Losing the locator is otherwise recoverable only
                // through the legacy id scan.
                if let Some(thread_id) = document.get("threadId").and_then(Value::as_str)
                    && !thread_id.is_empty()
                {
                    let locator_path = self.item_locator_path(&id);
                    let locator = serde_json::json!({ "id": id, "threadId": thread_id });
                    let current_locator = fs::read(&locator_path);
                    let locator_matches = match current_locator.as_ref() {
                        Ok(bytes) => serde_json::from_slice::<Value>(bytes)
                            .map(|actual| actual == locator)
                            .unwrap_or(false),
                        Err(_) => false,
                    };
                    if !locator_matches {
                        atomic_write(&locator_path, &serde_json::to_vec_pretty(&locator)?)?;
                    }
                }
            }
            let current = fs::read(&path);
            let matches = match current.as_ref() {
                Ok(bytes) => serde_json::from_slice::<Value>(bytes)
                    .map(|actual| actual == document)
                    .unwrap_or(false),
                Err(error) if error.kind() == io::ErrorKind::NotFound => false,
                Err(error) => {
                    return Err(StoreError::Io(io::Error::new(
                        error.kind(),
                        error.to_string(),
                    )));
                }
            };
            if matches {
                if let Some(thread) = &projected_thread {
                    self.record_projected_thread(thread)?;
                }
                if let Some(projection) = &projected_timeline {
                    self.record_projected_timeline(projection, &path)?;
                }
                continue;
            }
            if preserve_replaced && let Ok(bytes) = current {
                self.preserve_recovery_evidence(
                    &path,
                    &bytes,
                    "projection replaced from durable transaction",
                )?;
            }
            atomic_write(&path, &expected)?;
            if self.note_usage_projection(kind,&document,&path).is_err() { let _ = self.invalidate_usage_index(); }
            if let Some(thread) = &projected_thread {
                self.record_projected_thread(thread)?;
            }
            if let Some(projection) = &projected_timeline {
                self.record_projected_timeline(projection, &path)?;
            }
        }
        Ok(())
    }

    fn fail_if_requested(&self, _point: DurableFailpointName) -> Result<(), StoreError> {
        #[cfg(test)]
        {
            let expected = match _point {
                DurableFailpointName::AfterIntentPersisted => {
                    DurableFailpoint::AfterIntentPersisted
                }
                DurableFailpointName::AfterProjectionApplied => {
                    DurableFailpoint::AfterProjectionApplied
                }
            };
            let should_fail = FAILPOINT.with(|failpoint| {
                let mut configured = failpoint.borrow_mut();
                if configured.as_ref() == Some(&expected) {
                    *configured = None;
                    true
                } else {
                    false
                }
            });
            if should_fail {
                return Err(StoreError::Io(io::Error::other(format!(
                    "injected durable store failure at {_point:?}"
                ))));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
enum DurableFailpointName {
    AfterIntentPersisted,
    AfterProjectionApplied,
}
