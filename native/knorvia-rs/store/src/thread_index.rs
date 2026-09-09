//! Process-local workspace membership derived while replaying authoritative
//! Thread projections. It stores IDs only: page reads still validate the
//! durable documents. No on-disk format or migration is introduced.

use super::{ProductStore, StoreError, Thread, invalid, read_json};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io;
use std::ops::Bound::{Excluded, Unbounded};
use std::sync::MutexGuard;

#[derive(Debug, Default)]
pub(super) struct ThreadDirectoryIndex {
    workspace_by_id: HashMap<String, String>,
    by_workspace: HashMap<String, BTreeSet<String>>,
}

impl ThreadDirectoryIndex {
    fn record(&mut self, thread: &Thread) {
        if let Some(previous) = self
            .workspace_by_id
            .insert(thread.id.clone(), thread.workspace_id.clone())
            && previous != thread.workspace_id
            && let Some(ids) = self.by_workspace.get_mut(&previous)
        {
            ids.remove(&thread.id);
        }
        self.by_workspace
            .entry(thread.workspace_id.clone())
            .or_default()
            .insert(thread.id.clone());
    }
}

impl ProductStore {
    fn lock_thread_index(&self) -> Result<MutexGuard<'_, ThreadDirectoryIndex>, StoreError> {
        self.locks.thread_index.lock().map_err(|error| {
            StoreError::Io(io::Error::other(format!(
                "thread directory index lock poisoned: {error}"
            )))
        })
    }

    pub(super) fn reset_thread_index(&self) -> Result<(), StoreError> {
        *self.lock_thread_index()? = ThreadDirectoryIndex::default();
        Ok(())
    }

    pub(super) fn record_projected_thread(&self, thread: &Thread) -> Result<(), StoreError> {
        self.lock_thread_index()?.record(thread);
        Ok(())
    }

    /// Recovery already has the current WAL-backed documents in memory. Only
    /// legacy records without WAL need a second parse when opening a Home.
    pub(super) fn include_legacy_thread_index(&self) -> Result<(), StoreError> {
        let directory = self.product_dir().join("threads");
        if !directory.exists() {
            return Ok(());
        }
        let mut index = self.lock_thread_index()?;
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let id = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .ok_or_else(|| {
                    StoreError::Corrupt("thread projection has a non-UTF-8 name".into())
                })?;
            if index.workspace_by_id.contains_key(id) {
                continue;
            }
            let thread: Thread = read_json(&path)?;
            if thread.id != id {
                return Err(StoreError::Corrupt(format!(
                    "thread projection identity does not match {id}"
                )));
            }
            index.record(&thread);
        }
        Ok(())
    }

    /// Restart-safe exclusive ID cursor, compatible with the original global
    /// directory walk, with bounded per-project reads instead of foreign scans.
    pub fn list_threads_page(
        &self,
        workspace_id: &str,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<Thread>, Option<String>), StoreError> {
        if limit == 0 {
            return Err(invalid("thread page limit must be greater than zero"));
        }
        let _mutations = self.lock_mutations()?;
        {
            let _journal = self.lock_journal()?;
            self.recover_durable_state_locked()?;
        }
        let mut ids = {
            let index = self.lock_thread_index()?;
            let Some(workspace) = index.by_workspace.get(workspace_id) else {
                return Ok((Vec::new(), None));
            };
            let lower = after_id
                .map(|id| Excluded(id.to_owned()))
                .unwrap_or(Unbounded);
            workspace
                .range((lower, Unbounded))
                .take(limit.saturating_add(1))
                .cloned()
                .collect::<Vec<_>>()
        };
        let more = ids.len() > limit;
        ids.truncate(limit);
        let next = more.then(|| ids.last().cloned()).flatten();
        let threads = ids
            .into_iter()
            .map(|id| {
                let thread: Thread = read_json(&self.thread_path(&id))?;
                if thread.id != id || thread.workspace_id != workspace_id {
                    return Err(StoreError::Corrupt(format!(
                        "thread projection {id} disagrees with its recovered index"
                    )));
                }
                Ok(thread)
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        Ok((threads, next))
    }
}
