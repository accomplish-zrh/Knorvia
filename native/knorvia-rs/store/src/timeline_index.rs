//! Derived timeline membership and order. Only selected durable documents are
//! read for task summaries and history pages; JSON/WAL remain authoritative.

use super::durable::ProjectionKind;
use super::{ProductStore, StoreError, invalid, read_json};
use knorvia_protocol::{Approval, Item, Turn};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io;
use std::ops::Bound::{Excluded, Unbounded};
use std::path::{Path, PathBuf};
use std::sync::MutexGuard;

type OrderKey = (String, String);

#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    thread_id: String,
    turn_id: String,
    key: OrderKey,
    status: String,
    kind: String,
    pending: bool,
    path: PathBuf,
}

pub(super) enum TimelineProjection {
    Turn(Turn),
    Item(Item),
    Approval(Approval),
}

impl TimelineProjection {
    pub(super) fn parse(
        kind: ProjectionKind,
        id: &str,
        document: &Value,
    ) -> Result<Option<Self>, StoreError> {
        let projection = match kind {
            ProjectionKind::Turn => Self::Turn(serde_json::from_value(document.clone())?),
            ProjectionKind::Item => Self::Item(serde_json::from_value(document.clone())?),
            ProjectionKind::Approval => Self::Approval(serde_json::from_value(document.clone())?),
            _ => return Ok(None),
        };
        if projection.entry(Path::new("")).key.1 != id {
            return Err(StoreError::Corrupt(format!(
                "{kind:?} transaction document identity does not match {id}"
            )));
        }
        Ok(Some(projection))
    }

    fn entry(&self, path: &Path) -> Entry {
        let (thread_id, key, status, kind, pending) = match self {
            Self::Turn(turn) => (
                &turn.thread_id,
                (turn.created_at.clone(), turn.id.clone()),
                &turn.status,
                "",
                turn.status == "running",
            ),
            Self::Item(item) => (
                &item.thread_id,
                (format!("{:020}", item.seq), item.id.clone()),
                &item.status,
                item.kind.as_str(),
                item.kind == "userInput" && item.status == "waiting_input",
            ),
            Self::Approval(approval) => (
                &approval.thread_id,
                (approval.created_at.clone(), approval.id.clone()),
                &approval.status,
                "",
                approval.status == "pending",
            ),
        };
        Entry {
            thread_id: thread_id.clone(),
            turn_id: match self {
                Self::Turn(turn) => turn.id.clone(),
                Self::Item(item) => item.turn_id.clone(),
                Self::Approval(approval) => approval.turn_id.clone(),
            },
            key,
            status: status.clone(),
            kind: kind.to_owned(),
            pending,
            path: path.to_owned(),
        }
    }
}

#[derive(Debug, Default)]
struct DirectoryIndex {
    entries: HashMap<String, Entry>,
    by_thread: HashMap<String, BTreeSet<OrderKey>>,
    by_turn: HashMap<String, BTreeSet<OrderKey>>,
    pending_by_thread: HashMap<String, BTreeSet<OrderKey>>,
    pending: BTreeSet<OrderKey>,
}

impl DirectoryIndex {
    fn record(&mut self, entry: Entry) {
        let id = entry.key.1.clone();
        if let Some(previous) = self.entries.remove(&id) {
            if let Some(keys) = self.by_turn.get_mut(&previous.turn_id) {
                keys.remove(&previous.key);
            }
            if let Some(keys) = self.by_thread.get_mut(&previous.thread_id) {
                keys.remove(&previous.key);
            }
            if let Some(keys) = self.pending_by_thread.get_mut(&previous.thread_id) {
                keys.remove(&previous.key);
            }
            self.pending.remove(&previous.key);
        }
        self.by_thread
            .entry(entry.thread_id.clone())
            .or_default()
            .insert(entry.key.clone());
        self.by_turn
            .entry(entry.turn_id.clone())
            .or_default()
            .insert(entry.key.clone());
        if entry.pending {
            self.pending_by_thread
                .entry(entry.thread_id.clone())
                .or_default()
                .insert(entry.key.clone());
            self.pending.insert(entry.key.clone());
        }
        self.entries.insert(id, entry);
    }

    fn keys(&self, thread_id: &str, pending: bool) -> impl DoubleEndedIterator<Item = &OrderKey> {
        let map = if pending {
            &self.pending_by_thread
        } else {
            &self.by_thread
        };
        map.get(thread_id).into_iter().flat_map(|keys| keys.iter())
    }

    fn read(&self, key: &OrderKey, kind: ProjectionKind) -> Result<TimelineProjection, StoreError> {
        let entry = self
            .entries
            .get(&key.1)
            .ok_or_else(|| StoreError::Corrupt("timeline index lost its entry".into()))?;
        let document: Value = read_json(&entry.path)?;
        let projection = TimelineProjection::parse(kind, &key.1, &document)?
            .ok_or_else(|| StoreError::Corrupt("invalid timeline index kind".into()))?;
        if projection.entry(&entry.path) != *entry {
            return Err(StoreError::Corrupt(format!(
                "timeline projection {} disagrees with its recovered index",
                key.1
            )));
        }
        Ok(projection)
    }

    fn turns<'a>(&self, keys: impl Iterator<Item = &'a OrderKey>) -> Result<Vec<Turn>, StoreError> {
        keys.map(|key| match self.read(key, ProjectionKind::Turn)? {
            TimelineProjection::Turn(turn) => Ok(turn),
            _ => unreachable!(),
        })
        .collect()
    }

    fn items<'a>(&self, keys: impl Iterator<Item = &'a OrderKey>) -> Result<Vec<Item>, StoreError> {
        keys.map(|key| match self.read(key, ProjectionKind::Item)? {
            TimelineProjection::Item(item) => Ok(item),
            _ => unreachable!(),
        })
        .collect()
    }

    fn approvals<'a>(
        &self,
        keys: impl Iterator<Item = &'a OrderKey>,
    ) -> Result<Vec<Approval>, StoreError> {
        keys.map(|key| match self.read(key, ProjectionKind::Approval)? {
            TimelineProjection::Approval(approval) => Ok(approval),
            _ => unreachable!(),
        })
        .collect()
    }

    fn tail(
        &self,
        thread_id: &str,
        before: Option<OrderKey>,
        limit: usize,
    ) -> (Vec<OrderKey>, bool) {
        let Some(keys) = self.by_thread.get(thread_id) else {
            return (Vec::new(), false);
        };
        let upper = before.map(Excluded).unwrap_or(Unbounded);
        let mut selected: Vec<_> = keys
            .range((Unbounded, upper))
            .rev()
            .take(limit.saturating_add(1))
            .cloned()
            .collect();
        let more = selected.len() > limit;
        selected.truncate(limit);
        selected.reverse();
        (selected, more)
    }
}

#[derive(Debug, Default)]
pub(super) struct TimelineDirectoryIndex {
    turns: DirectoryIndex,
    items: DirectoryIndex,
    approvals: DirectoryIndex,
}

impl TimelineDirectoryIndex {
    fn record(&mut self, projection: &TimelineProjection, path: &Path) {
        let directory = match projection {
            TimelineProjection::Turn(_) => &mut self.turns,
            TimelineProjection::Item(_) => &mut self.items,
            TimelineProjection::Approval(_) => &mut self.approvals,
        };
        directory.record(projection.entry(path));
    }

    fn activity(&self, thread_id: &str) -> Result<ThreadActivity, StoreError> {
        Ok(ThreadActivity {
            active_turn: self
                .turns
                .turns(self.turns.keys(thread_id, true).take(1))?
                .pop(),
            last_turn: self
                .turns
                .turns(self.turns.keys(thread_id, false).rev().take(1))?
                .pop(),
            pending_approvals: self
                .approvals
                .approvals(self.approvals.keys(thread_id, true))?,
            pending_user_inputs: self.items.items(self.items.keys(thread_id, true))?,
        })
    }
}

pub struct ThreadActivity {
    pub active_turn: Option<Turn>,
    pub last_turn: Option<Turn>,
    pub pending_approvals: Vec<Approval>,
    pub pending_user_inputs: Vec<Item>,
}

pub struct ThreadHistory {
    pub activity: ThreadActivity,
    pub items: Vec<Item>,
    pub turns: Vec<Turn>,
    pub items_next_cursor: Option<u64>,
    pub turns_next_cursor: Option<String>,
}

pub struct TurnHistory {
    pub turn: Turn,
    pub items: Vec<Item>,
    pub pending_approvals: Vec<Approval>,
    pub pending_user_inputs: Vec<Item>,
}

impl ProductStore {
    fn lock_timeline_index(&self) -> Result<MutexGuard<'_, TimelineDirectoryIndex>, StoreError> {
        self.locks.timeline_index.lock().map_err(|error| {
            StoreError::Io(io::Error::other(format!(
                "timeline directory index lock poisoned: {error}"
            )))
        })
    }

    pub(super) fn reset_timeline_index(&self) -> Result<(), StoreError> {
        *self.lock_timeline_index()? = TimelineDirectoryIndex::default();
        Ok(())
    }

    pub(super) fn record_projected_timeline(
        &self,
        projection: &TimelineProjection,
        path: &Path,
    ) -> Result<(), StoreError> {
        self.lock_timeline_index()?.record(projection, path);
        Ok(())
    }

    /// WAL-backed rows were parsed during recovery. Discover only legacy rows;
    /// a sharded legacy Item wins over its obsolete flat copy, and WAL wins both.
    pub(super) fn include_legacy_timeline_index(&self) -> Result<(), StoreError> {
        let mut index = self.lock_timeline_index()?;
        for (name, kind) in [
            ("turns", ProjectionKind::Turn),
            ("approvals", ProjectionKind::Approval),
        ] {
            for path in json_files(&self.product_dir().join(name))? {
                let id = file_id(&path)?;
                let exists = match kind {
                    ProjectionKind::Turn => index.turns.entries.contains_key(&id),
                    _ => index.approvals.entries.contains_key(&id),
                };
                if !exists {
                    let projection =
                        TimelineProjection::parse(kind, &id, &read_json(&path)?)?.unwrap();
                    index.record(&projection, &path);
                }
            }
        }
        let wal_ids: HashSet<_> = index.items.entries.keys().cloned().collect();
        let items_dir = self.product_dir().join("items");
        for path in json_files(&items_dir)? {
            let id = file_id(&path)?;
            if !wal_ids.contains(&id) {
                let projection =
                    TimelineProjection::parse(ProjectionKind::Item, &id, &read_json(&path)?)?
                        .unwrap();
                index.record(&projection, &path);
            }
        }
        let shards = items_dir.join("threads");
        if shards.exists() {
            for directory in fs::read_dir(shards)? {
                let directory = directory?;
                if !directory.file_type()?.is_dir() {
                    continue;
                }
                for path in json_files(&directory.path())? {
                    let name = file_id(&path)?;
                    let (sequence, id) = match name.split_once('-') {
                        Some((seq, id)) if seq.parse::<u64>().is_ok() => {
                            (seq.parse::<u64>().ok(), id)
                        }
                        _ => (None, name.as_str()),
                    };
                    if wal_ids.contains(id) {
                        continue;
                    }
                    let projection =
                        TimelineProjection::parse(ProjectionKind::Item, id, &read_json(&path)?)?
                            .unwrap();
                    if let TimelineProjection::Item(item) = &projection
                        && (Some(item.thread_id.as_str()) != directory.file_name().to_str()
                            || sequence.is_some_and(|seq| seq != item.seq))
                    {
                        return Err(StoreError::Corrupt(format!(
                            "legacy item {id} disagrees with its shard"
                        )));
                    }
                    index.record(&projection, &path);
                }
            }
        }
        Ok(())
    }

    pub(super) fn recover_before_indexed_read(&self) -> Result<(), StoreError> {
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()
    }

    pub(super) fn indexed_thread_turns_locked(
        &self,
        thread_id: &str,
    ) -> Result<Vec<Turn>, StoreError> {
        let index = self.lock_timeline_index()?;
        index.turns.turns(index.turns.keys(thread_id, false))
    }

    pub(super) fn indexed_running_turns_locked(&self) -> Result<Vec<Turn>, StoreError> {
        let index = self.lock_timeline_index()?;
        index.turns.turns(index.turns.pending.iter())
    }

    pub(super) fn indexed_thread_approvals_locked(
        &self,
        thread_id: &str,
    ) -> Result<Vec<Approval>, StoreError> {
        let index = self.lock_timeline_index()?;
        index
            .approvals
            .approvals(index.approvals.keys(thread_id, false))
    }

    pub fn read_thread_activity(&self, thread_id: &str) -> Result<ThreadActivity, StoreError> {
        let _mutations = self.lock_mutations()?;
        self.recover_before_indexed_read()?;
        self.lock_timeline_index()?.activity(thread_id)
    }

    pub fn list_turn_items(&self, thread_id: &str, turn_id: &str) -> Result<Vec<Item>, StoreError> {
        let _mutations = self.lock_mutations()?;
        self.recover_before_indexed_read()?;
        let index = self.lock_timeline_index()?;
        let keys = index
            .items
            .by_turn
            .get(turn_id)
            .into_iter()
            .flat_map(|keys| keys.iter())
            .filter(|key| index.items.entries[&key.1].thread_id == thread_id);
        index.items.items(keys)
    }

    pub fn has_items_outside_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<bool, StoreError> {
        let _mutations = self.lock_mutations()?;
        self.recover_before_indexed_read()?;
        let index = self.lock_timeline_index()?;
        let prior = index
            .items
            .keys(thread_id, false)
            .find(|key| index.items.entries[&key.1].turn_id != turn_id);
        if let Some(key) = prior {
            index.items.read(key, ProjectionKind::Item)?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn read_turn_history(&self, turn_id: &str) -> Result<TurnHistory, StoreError> {
        let _mutations = self.lock_mutations()?;
        self.recover_before_indexed_read()?;
        let turn = self.read_turn(turn_id)?;
        let index = self.lock_timeline_index()?;
        let item_keys = index
            .items
            .by_turn
            .get(turn_id)
            .into_iter()
            .flat_map(|keys| keys.iter())
            .filter(|key| index.items.entries[&key.1].thread_id == turn.thread_id);
        let items = index.items.items(item_keys)?;
        let approval_keys = index
            .approvals
            .by_turn
            .get(turn_id)
            .into_iter()
            .flat_map(|keys| keys.iter())
            .filter(|key| {
                let entry = &index.approvals.entries[&key.1];
                entry.thread_id == turn.thread_id && entry.pending
            });
        let pending_approvals = index.approvals.approvals(approval_keys)?;
        Ok(TurnHistory {
            turn,
            pending_approvals,
            pending_user_inputs: items
                .iter()
                .filter(|item| item.kind == "userInput" && item.status == "waiting_input")
                .cloned()
                .collect(),
            items,
        })
    }

    /// Summary and pages share the mutation lock, so an approval resolution or
    /// terminal transition cannot split a single response into different states.
    pub fn read_thread_history(
        &self,
        thread_id: &str,
        before_item: Option<u64>,
        item_limit: usize,
        before_turn: Option<&str>,
        turn_limit: usize,
    ) -> Result<ThreadHistory, StoreError> {
        if item_limit == 0 || item_limit > 500 || turn_limit == 0 || turn_limit > 500 {
            return Err(invalid("history page limits must be between 1 and 500"));
        }
        let _mutations = self.lock_mutations()?;
        self.recover_before_indexed_read()?;
        let index = self.lock_timeline_index()?;
        let before_turn = before_turn
            .map(|id| {
                index
                    .turns
                    .entries
                    .get(id)
                    .filter(|entry| entry.thread_id == thread_id)
                    .map(|entry| entry.key.clone())
                    .ok_or_else(|| invalid("beforeTurnId is not a turn in this thread"))
            })
            .transpose()?;
        let before_item = before_item.map(|seq| (format!("{seq:020}"), String::new()));
        let (item_keys, more_items) = index.items.tail(thread_id, before_item, item_limit);
        let (turn_keys, more_turns) = index.turns.tail(thread_id, before_turn, turn_limit);
        let items = index.items.items(item_keys.iter())?;
        let turns = index.turns.turns(turn_keys.iter())?;
        Ok(ThreadHistory {
            activity: index.activity(thread_id)?,
            items_next_cursor: more_items.then(|| items.first().expect("nonempty page").seq),
            turns_next_cursor: more_turns.then(|| turns.first().expect("nonempty page").id.clone()),
            items,
            turns,
        })
    }
}

fn json_files(directory: &Path) -> Result<Vec<PathBuf>, StoreError> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_file()
            && entry.path().extension().and_then(|s| s.to_str()) == Some("json")
        {
            paths.push(entry.path());
        }
    }
    Ok(paths)
}

fn file_id(path: &Path) -> Result<String, StoreError> {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_owned)
        .ok_or_else(|| StoreError::Corrupt("timeline projection has a non-UTF-8 name".into()))
}
