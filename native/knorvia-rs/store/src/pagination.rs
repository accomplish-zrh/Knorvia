//! Bounded, sequence-based reads for long thread and activity histories.

use super::{EventEnvelope, Item, ProductStore, ProtocolError, StoreError, invalid};

#[cfg(test)]
#[path = "pagination_tests.rs"]
mod pagination_tests;
use knorvia_protocol::ErrorCategory;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::Ordering;

const MAX_PAGE_SIZE: usize = 500;

/// Default byte budget for one replay page. Consumers may lower it; raising
/// it is capped so a single response always fits the daemon frame limit.
pub const DEFAULT_REPLAY_PAGE_BYTES: usize = 1024 * 1024;
pub const MAX_REPLAY_PAGE_BYTES: usize = 6 * 1024 * 1024;
/// Headroom for the JSON-RPC response wrapper around the page data.
const PAGE_ENVELOPE_RESERVE: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPage {
    pub data: Vec<Item>,
    pub next_cursor: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub data: Vec<EventEnvelope>,
    pub next_cursor: Option<u64>,
}

/// One bounded replay page (A08). `upper_seq` is the frozen stream head
/// observed when the page was opened: concurrent appends never change it,
/// so `has_more == false` means the consumer has caught up with the exact
/// snapshot this page started from, and missing data is never mistaken for
/// "no events happened".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventReplayPage {
    pub events: Vec<EventEnvelope>,
    pub next_seq: u64,
    pub has_more: bool,
    pub upper_seq: u64,
    pub next_cursor: String,
}

fn page_limit(limit: usize) -> Result<usize, StoreError> {
    if limit == 0 {
        return Err(invalid("page limit must be greater than zero"));
    }
    Ok(limit.min(MAX_PAGE_SIZE))
}

fn replay_cursor(stream: &str, upper: u64, next: u64) -> String {
    format!("v2:{}:{upper}:{next}", hex::encode(stream.as_bytes()))
}

impl ProductStore {
    pub fn replay_page_bounded(
        &self,
        stream_id: &str,
        after_seq: u64,
        limit: usize,
        max_bytes: usize,
    ) -> Result<EventReplayPage, StoreError> {
        self.replay_page_snapshot(stream_id, after_seq, limit, max_bytes, None, None)
    }

    /// A cursor binds stream identity, frozen head and the last delivered event.
    /// Rebuild errors are retryable and do not acknowledge or skip any event.
    pub fn replay_page_snapshot(
        &self,
        stream_id: &str,
        after_seq: u64,
        limit: usize,
        max_bytes: usize,
        upper_seq: Option<u64>,
        cursor: Option<&str>,
    ) -> Result<EventReplayPage, StoreError> {
        let limit = page_limit(limit)?;
        if max_bytes < 512 {
            return Err(invalid("replay maxBytes must be at least 512"));
        }
        let max_bytes = max_bytes.min(MAX_REPLAY_PAGE_BYTES);
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.locks.page_bytes_read.store(0, Ordering::Relaxed);
        self.locks.page_lines_parsed.store(0, Ordering::Relaxed);
        self.recover_durable_state_locked()?;
        self.ensure_stream_journal_is_current(stream_id)?;
        let head = self
            .locks
            .durable
            .lock()
            .map_err(|_| StoreError::Corrupt("durable state lock poisoned".into()))?
            .last_sequence_by_stream
            .get(stream_id)
            .copied()
            .unwrap_or(0);
        let upper = upper_seq.unwrap_or(head);
        if after_seq > upper || upper > head {
            return Err(invalid(
                "stale replay cursor: afterSeq/upperSeq exceed the recovered stream head",
            ));
        }
        if let Some(cursor) = cursor {
            if upper_seq.is_none() || cursor != replay_cursor(stream_id, upper, after_seq) {
                return Err(invalid(
                    "replay cursor does not belong to this stream, sequence and snapshot",
                ));
            }
        }
        let mut page = EventReplayPage {
            events: Vec::new(),
            next_seq: after_seq,
            has_more: after_seq < upper,
            upper_seq: upper,
            next_cursor: replay_cursor(stream_id, upper, after_seq),
        };
        // Bound the actual normalized page JSON, not the bytes in legacy JSONL.
        // Include worst-case metadata digits and an explicit RPC envelope reserve.
        let mut sizing = page.clone();
        sizing.next_seq = u64::MAX;
        sizing.next_cursor = replay_cursor(stream_id, upper, u64::MAX);
        let mut used = serde_json::to_vec(&sizing)?.len() + PAGE_ENVELOPE_RESERVE;
        if used > max_bytes {
            return Err(invalid("replay budget cannot contain cursor metadata"));
        }
        if after_seq == upper {
            return Ok(page);
        }
        self.prepare_replay_index(stream_id, upper)?;
        let mut journal = File::open(self.events_path(stream_id))?;
        let mut previous_end = if after_seq == 0 {
            0
        } else {
            let (offset, length) = self.replay_offset(stream_id, after_seq)?;
            offset
                .checked_add(length)
                .ok_or_else(|| StoreError::Corrupt("replay offset overflow".into()))?
        };
        for seq in after_seq + 1..=upper {
            let (offset, length) = self.replay_offset(stream_id, seq)?;
            if offset != previous_end {
                return Err(StoreError::Corrupt("replay index contains a gap".into()));
            }
            // Read limits are checked BEFORE allocating/deserializing a payload.
            if length > max_bytes as u64 {
                break;
            }
            journal.seek(SeekFrom::Start(offset))?;
            let mut line = vec![0; length as usize];
            journal.read_exact(&mut line)?;
            self.locks
                .page_bytes_read
                .fetch_add(length, Ordering::Relaxed);
            self.locks.page_lines_parsed.fetch_add(1, Ordering::Relaxed);
            if line.last() != Some(&b'\n') || line[..line.len() - 1].contains(&b'\n') {
                return Err(StoreError::Corrupt(
                    "replay index line boundary mismatch".into(),
                ));
            }
            let event: EventEnvelope = serde_json::from_slice(&line)?;
            if event.stream_id != stream_id || event.seq != seq {
                return Err(StoreError::Corrupt(
                    "replay index stream/sequence anchor mismatch".into(),
                ));
            }
            let bytes = serde_json::to_vec(&event)?.len() + usize::from(!page.events.is_empty());
            if used + bytes > max_bytes {
                break;
            }
            used += bytes;
            previous_end = offset
                .checked_add(length)
                .ok_or_else(|| StoreError::Corrupt("replay offset overflow".into()))?;
            page.events.push(event);
            page.next_seq = seq;
            if page.events.len() == limit {
                break;
            }
        }
        if page.next_seq == after_seq {
            return Err(ProtocolError::new(ErrorCategory::ResourceExhausted,
                format!("event_exceeds_page_budget: event seq {} cannot fit maxBytes={max_bytes}; no events were skipped", after_seq + 1)).into());
        }
        page.has_more = page.next_seq < upper;
        page.next_cursor = replay_cursor(stream_id, upper, page.next_seq);
        Ok(page)
    }

    /// Total bytes read by the last page, including index rebuild and sidecar reads.
    pub fn page_bytes_read(&self) -> u64 {
        self.locks.page_bytes_read.load(Ordering::Relaxed)
    }

    /// Read items strictly after `after_seq`. The returned cursor is the last
    /// included item sequence and remains valid after process restart.
    ///
    /// The bound is pushed into the projection walk: directory enumeration
    /// selects the page before any file is parsed, so latency tracks the page
    /// size rather than the history length.
    pub fn list_items_page(
        &self,
        thread_id: &str,
        after_seq: Option<u64>,
        limit: usize,
    ) -> Result<ItemPage, StoreError> {
        let limit = page_limit(limit)?;
        let _mutations = self.lock_mutations()?;
        self.collect_items_locked(thread_id, after_seq, Some(limit))
    }

    /// Read durable activity events strictly after `after_seq`, bounded by
    /// the page limit and the page byte budget. The cursor is an event
    /// sequence rather than an in-memory offset, so reconnects and process
    /// restarts do not duplicate or skip a committed event.
    pub fn replay_page(
        &self,
        stream_id: &str,
        after_seq: Option<u64>,
        limit: usize,
    ) -> Result<EventPage, StoreError> {
        let limit = page_limit(limit)?;
        let page = self.replay_page_bounded(
            stream_id,
            after_seq.unwrap_or(0),
            limit,
            DEFAULT_REPLAY_PAGE_BYTES,
        )?;
        Ok(EventPage {
            next_cursor: page.has_more.then_some(page.next_seq),
            data: page.events,
        })
    }

    /// How many journal lines the most recent bounded page deserialized.
    /// A late page must stay proportional to the page budget, not the
    /// history length; tests assert against this counter instead of
    /// guessing from elapsed time.
    pub fn page_lines_parsed(&self) -> u64 {
        self.locks.page_lines_parsed.load(Ordering::Relaxed)
    }
}
