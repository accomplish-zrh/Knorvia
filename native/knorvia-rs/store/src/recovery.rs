//! Recovery and validation for durable transactions and JSONL projections.

use super::durable::DurableTransaction;
use super::{
    Approval, EventEnvelope, Item, ProductStore, StoreError, Thread, atomic_write, event_id,
    now_rfc3339, read_json, sync_parent_dir,
};
use knorvia_protocol::Turn;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

#[derive(Debug)]
struct JournalRead {
    events: Vec<EventEnvelope>,
    raw: Vec<u8>,
    tail_error: Option<String>,
}

impl ProductStore {
    /// Serve activity from the healthy JSONL projection. The full WAL merge is
    /// reserved for open/recovery and an observed dirty journal, so paging a
    /// long history does not parse every retained WAL record on each read.
    pub(super) fn replay_clean_journal_locked(
        &self,
        stream_id: &str,
        after_seq: u64,
    ) -> Result<Vec<EventEnvelope>, StoreError> {
        let journal = match self.read_journal(stream_id) {
            Ok(journal) => journal,
            Err(error) => {
                let _ = self.invalidate_durable_state();
                return Err(error);
            }
        };
        if journal.tail_error.is_some() {
            self.invalidate_durable_state()?;
            self.recover_durable_state_locked()?;
            return self.replay_clean_journal_locked(stream_id, after_seq);
        }
        if let Err(error) = self.validate_event_sequence(stream_id, &journal.events) {
            let _ = self.invalidate_durable_state();
            return Err(error);
        }
        Ok(journal
            .events
            .into_iter()
            .filter(|event| event.seq > after_seq)
            .collect())
    }

    pub(super) fn recover_stream_journal_locked(
        &self,
        stream_id: &str,
        transactions: &[DurableTransaction],
    ) -> Result<u64, StoreError> {
        let journal = self.read_journal(stream_id)?;
        let had_tail = journal.tail_error.is_some();
        if let Some(error) = &journal.tail_error {
            self.preserve_recovery_evidence(
                &self.events_path(stream_id),
                &journal.raw,
                &format!("trailing JSONL fragment: {error}"),
            )?;
        }
        let valid_count = journal.events.len();
        let mut merged = self.merge_events(stream_id, journal.events, transactions)?;
        if had_tail && merged.len() == valid_count {
            let recovered = self.recover_legacy_tail_event(stream_id, &merged)?;
            merged.push(recovered);
            merged.sort_by_key(|event| event.seq);
            self.validate_event_sequence(stream_id, &merged)?;
        }
        if had_tail || merged.len() != valid_count {
            self.write_journal(stream_id, &merged)?;
        }
        Ok(merged.last().map(|event| event.seq).unwrap_or(0))
    }

    /// Append fully formed JSONL records after their WAL transaction and all
    /// projection files are synced. A power loss can leave a tail fragment,
    /// but the intent record is already durable, so the next recovery rebuilds
    /// this projection canonically instead of losing or reusing a sequence.
    pub(super) fn append_stream_journal_events_locked(
        &self,
        stream_id: &str,
        events: &[EventEnvelope],
    ) -> Result<(), StoreError> {
        if events.is_empty() {
            return Ok(());
        }
        let path = self.events_path(stream_id);
        let mut bytes = Vec::new();
        for event in events {
            serde_json::to_writer(&mut bytes, event)?;
            bytes.push(b'\n');
        }
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        sync_parent_dir(&path)?;
        Ok(())
    }

    fn read_journal(&self, stream_id: &str) -> Result<JournalRead, StoreError> {
        let path = self.events_path(stream_id);
        if !path.exists() {
            return Ok(JournalRead {
                events: Vec::new(),
                raw: Vec::new(),
                tail_error: None,
            });
        }
        let raw = fs::read(&path)?;
        let mut events = Vec::new();
        let mut start = 0;
        let mut line = 1;
        while start < raw.len() {
            let Some(relative_end) = raw[start..].iter().position(|byte| *byte == b'\n') else {
                let fragment = &raw[start..];
                if fragment.iter().all(u8::is_ascii_whitespace) {
                    break;
                }
                return Ok(JournalRead {
                    events,
                    raw,
                    tail_error: Some(format!("line {line} is incomplete or invalid JSON")),
                });
            };
            let end = start + relative_end;
            let contents = trim_line(&raw[start..end]);
            if !contents.is_empty() {
                let event = match serde_json::from_slice::<EventEnvelope>(contents) {
                    Ok(event) => event,
                    Err(error) => {
                        self.preserve_recovery_evidence(
                            &path,
                            &raw,
                            &format!("invalid JSONL at line {line}: {error}"),
                        )?;
                        return Err(StoreError::Corrupt(format!(
                            "invalid JSONL in {path:?} at line {line}: {error}"
                        )));
                    }
                };
                if event.stream_id != stream_id {
                    self.preserve_recovery_evidence(
                        &path,
                        &raw,
                        &format!("stream id mismatch at line {line}"),
                    )?;
                    return Err(StoreError::Corrupt(format!(
                        "event stream mismatch in {path:?} at line {line}"
                    )));
                }
                if let Some(previous) = events.last()
                    && event.seq <= previous.seq
                {
                    self.preserve_recovery_evidence(
                        &path,
                        &raw,
                        &format!("non-monotonic sequence at line {line}"),
                    )?;
                    return Err(StoreError::Corrupt(format!(
                        "non-monotonic event sequence in {path:?} at line {line}"
                    )));
                }
                events.push(event);
            }
            start = end + 1;
            line += 1;
        }
        Ok(JournalRead {
            events,
            raw,
            tail_error: None,
        })
    }

    fn merge_events(
        &self,
        stream_id: &str,
        journal_events: Vec<EventEnvelope>,
        transactions: &[DurableTransaction],
    ) -> Result<Vec<EventEnvelope>, StoreError> {
        let mut by_seq = BTreeMap::new();
        let mut ids = HashMap::new();
        for event in journal_events {
            self.insert_event(stream_id, &mut by_seq, &mut ids, event)?;
        }
        for transaction in transactions
            .iter()
            .filter(|transaction| transaction.stream_id == stream_id)
        {
            for event in transaction.events()? {
                self.insert_event(stream_id, &mut by_seq, &mut ids, event.clone())?;
            }
        }
        let events = by_seq.into_values().collect::<Vec<_>>();
        self.validate_event_sequence(stream_id, &events)?;
        Ok(events)
    }

    fn insert_event(
        &self,
        stream_id: &str,
        by_seq: &mut BTreeMap<u64, EventEnvelope>,
        ids: &mut HashMap<String, u64>,
        event: EventEnvelope,
    ) -> Result<(), StoreError> {
        if event.stream_id != stream_id || event.seq == 0 || event.event_id.is_empty() {
            return Err(StoreError::Corrupt(format!(
                "invalid event in stream {stream_id}"
            )));
        }
        if let Some(existing_seq) = ids.get(&event.event_id) {
            if *existing_seq != event.seq {
                return Err(StoreError::Corrupt(format!(
                    "event id {} has conflicting sequence in stream {stream_id}",
                    event.event_id
                )));
            }
            let existing = by_seq
                .get(existing_seq)
                .expect("event id map references event");
            if !same_event(existing, &event)? {
                return Err(StoreError::Corrupt(format!(
                    "event id {} has conflicting contents in stream {stream_id}",
                    event.event_id
                )));
            }
            return Ok(());
        }
        if let Some(existing) = by_seq.get(&event.seq) {
            if !same_event(existing, &event)? {
                return Err(StoreError::Corrupt(format!(
                    "event sequence {} has conflicting facts in stream {stream_id}",
                    event.seq
                )));
            }
            ids.insert(event.event_id, event.seq);
            return Ok(());
        }
        ids.insert(event.event_id.clone(), event.seq);
        by_seq.insert(event.seq, event);
        Ok(())
    }

    fn validate_event_sequence(
        &self,
        stream_id: &str,
        events: &[EventEnvelope],
    ) -> Result<(), StoreError> {
        for (index, event) in events.iter().enumerate() {
            let expected = u64::try_from(index)
                .ok()
                .and_then(|value| value.checked_add(1))
                .ok_or_else(|| {
                    StoreError::Corrupt(format!("event count overflow for {stream_id}"))
                })?;
            if event.seq != expected {
                return Err(StoreError::Corrupt(format!(
                    "event stream {stream_id} has a sequence gap at {}, expected {expected}",
                    event.seq
                )));
            }
        }
        Ok(())
    }

    fn write_journal(&self, stream_id: &str, events: &[EventEnvelope]) -> Result<(), StoreError> {
        self.validate_event_sequence(stream_id, events)?;
        let mut bytes = Vec::new();
        for event in events {
            serde_json::to_writer(&mut bytes, event)?;
            bytes.push(b'\n');
        }
        atomic_write(&self.events_path(stream_id), &bytes)?;
        Ok(())
    }

    fn recover_legacy_tail_event(
        &self,
        stream_id: &str,
        events: &[EventEnvelope],
    ) -> Result<EventEnvelope, StoreError> {
        let seq = events
            .last()
            .map(|event| event.seq)
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| {
                StoreError::Corrupt(format!("event sequence exhausted for {stream_id}"))
            })?;
        let mut candidates = Vec::new();

        for item in self.projection_documents::<Item>("items")? {
            if item.thread_id == stream_id
                && item.seq == seq
                && !has_event(events, "item.appended", &item.id)
            {
                candidates.push(("item.appended", serde_json::to_value(item)?));
            }
        }
        for turn in self.projection_documents::<Turn>("turns")? {
            if turn.thread_id != stream_id {
                continue;
            }
            if !has_event(events, "turn.started", &turn.id) {
                let started = Turn {
                    id: turn.id.clone(),
                    thread_id: turn.thread_id.clone(),
                    status: "running".to_string(),
                    created_at: turn.created_at.clone(),
                    completed_at: None,
                };
                candidates.push(("turn.started", serde_json::to_value(started)?));
            }
            if is_terminal_turn(&turn.status) && !has_event(events, "turn.completed", &turn.id) {
                candidates.push(("turn.completed", serde_json::to_value(turn)?));
            }
        }
        for approval in self.projection_documents::<Approval>("approvals")? {
            if approval.thread_id != stream_id {
                continue;
            }
            if !has_event(events, "approval.requested", &approval.id) {
                let mut requested = approval.clone();
                requested.status = "pending".to_string();
                candidates.push(("approval.requested", serde_json::to_value(requested)?));
            }
            if approval.status != "pending"
                && !has_event(events, "approval.responded", &approval.id)
            {
                candidates.push(("approval.responded", serde_json::to_value(approval)?));
            }
        }
        let thread_path = self.thread_path(stream_id);
        if thread_path.exists() {
            let thread: Thread = read_json(&thread_path)?;
            if !has_event(events, "thread.created", &thread.id) {
                candidates.push(("thread.created", serde_json::to_value(thread)?));
            }
        }
        if candidates.len() != 1 {
            return Err(StoreError::Corrupt(format!(
                "trailing journal fragment for {stream_id} cannot be safely reconciled; found {} candidate facts",
                candidates.len()
            )));
        }
        let (kind, payload) = candidates.pop().expect("exactly one candidate");
        Ok(EventEnvelope {
            event_id: event_id(),
            stream_id: stream_id.to_string(),
            seq,
            emitted_at: now_rfc3339(),
            causation_id: None,
            correlation_id: None,
            schema_version: 1,
            kind: kind.to_string(),
            payload,
        })
    }

    fn projection_documents<T: DeserializeOwned>(
        &self,
        directory: &str,
    ) -> Result<Vec<T>, StoreError> {
        let directory = self.product_dir().join(directory);
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut documents = Vec::new();
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            if entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                == Some("json")
            {
                documents.push(read_json(&entry.path())?);
            }
        }
        Ok(documents)
    }

    pub(super) fn preserve_recovery_evidence(
        &self,
        source: &Path,
        bytes: &[u8],
        reason: &str,
    ) -> Result<(), StoreError> {
        let evidence = self
            .recovery_dir()
            .join(format!("{}-{}", now_rfc3339(), event_id()));
        fs::create_dir_all(&evidence)?;
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("corrupt-data");
        atomic_write(&evidence.join(name), bytes)?;
        let report = serde_json::json!({
            "source": source.display().to_string(),
            "reason": reason,
            "preservedAt": now_rfc3339(),
        });
        atomic_write(
            &evidence.join("recovery-report.json"),
            &serde_json::to_vec_pretty(&report)?,
        )?;
        Ok(())
    }
}

fn trim_line(bytes: &[u8]) -> &[u8] {
    let bytes = if bytes.last() == Some(&b'\r') {
        &bytes[..bytes.len() - 1]
    } else {
        bytes
    };
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map_or(start, |position| position + 1);
    &bytes[start..end]
}

fn same_event(left: &EventEnvelope, right: &EventEnvelope) -> Result<bool, StoreError> {
    Ok(serde_json::to_value(left)? == serde_json::to_value(right)?)
}

fn has_event(events: &[EventEnvelope], kind: &str, id: &str) -> bool {
    events.iter().any(|event| {
        event.kind == kind && event.payload.get("id").and_then(Value::as_str) == Some(id)
    })
}

fn is_terminal_turn(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "interrupted")
}
