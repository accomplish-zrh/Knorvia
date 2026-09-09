//! Bounded, sequence-based reads for long thread and activity histories.

use super::{EventEnvelope, Item, ProductStore, StoreError, invalid};
use serde::{Deserialize, Serialize};

const MAX_PAGE_SIZE: usize = 500;

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

fn page_limit(limit: usize) -> Result<usize, StoreError> {
    if limit == 0 {
        return Err(invalid("page limit must be greater than zero"));
    }
    Ok(limit.min(MAX_PAGE_SIZE))
}

impl ProductStore {
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

    /// Read durable activity events strictly after `after_seq`. The cursor is
    /// an event sequence rather than an in-memory offset, so reconnects and
    /// process restarts do not duplicate or skip a committed event.
    pub fn replay_page(
        &self,
        stream_id: &str,
        after_seq: Option<u64>,
        limit: usize,
    ) -> Result<EventPage, StoreError> {
        let limit = page_limit(limit)?;
        let mut candidates = self.replay(stream_id, after_seq.unwrap_or(0))?;
        let has_more = candidates.len() > limit;
        candidates.truncate(limit);
        Ok(EventPage {
            next_cursor: has_more.then(|| candidates.last().expect("nonempty page").seq),
            data: candidates,
        })
    }
}
