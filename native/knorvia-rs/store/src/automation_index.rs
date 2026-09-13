//! In-memory automation run index (R04). Bounded by ACTIVE runs: terminal
//! history stays on disk and is never re-read by scheduler ticks. JSON/WAL
//! remain authoritative — the index is a rebuildable accelerator with a
//! low-frequency full-scan correction, so a lost or stale index self-heals
//! without missing or double-claiming occurrences.

use super::{AutomationRun, ProductStore, StoreError, read_json};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::MutexGuard;
use std::time::{Duration, Instant};

/// How often a reconcile re-checks the index against the full run directory.
/// Durable facts are the authority; this only bounds a hypothetical drift.
/// The scan itself is one O(history) read (a single pre-R04 tick), so the
/// interval keeps that cost rare: at most one extra history read every
/// ten minutes instead of every 250ms tick.
const FULL_SCAN_INTERVAL: Duration = Duration::from_secs(600);

#[derive(Debug, Default)]
pub(super) struct AutomationRunIndex {
    /// A full directory scan has populated the active map at least once.
    loaded: bool,
    last_full_scan: Option<Instant>,
    /// automation id -> ids of its active (non-terminal) runs.
    active_by_automation: HashMap<String, HashSet<String>>,
}

impl AutomationRunIndex {
    fn record(&mut self, run: &AutomationRun) {
        if run.state.is_terminal() {
            let empty = {
                let Some(active) = self.active_by_automation.get_mut(&run.automation_id) else {
                    return;
                };
                active.remove(&run.id);
                active.is_empty()
            };
            if empty {
                self.active_by_automation.remove(&run.automation_id);
            }
        } else {
            self.active_by_automation
                .entry(run.automation_id.clone())
                .or_default()
                .insert(run.id.clone());
        }
    }

    fn rebuild(&mut self, runs: &[AutomationRun], now: Instant) {
        self.active_by_automation.clear();
        for run in runs {
            self.record(run);
        }
        self.loaded = true;
        self.last_full_scan = Some(now);
    }

    fn needs_full_scan(&self, now: Instant) -> bool {
        !self.loaded
            || self
                .last_full_scan
                .is_none_or(|last| now.duration_since(last) >= FULL_SCAN_INTERVAL)
    }

    fn active(&self, automation_id: &str) -> Vec<String> {
        self.active_by_automation
            .get(automation_id)
            .map(|active| active.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn all_active(&self) -> Vec<String> {
        self.active_by_automation
            .values()
            .flatten()
            .cloned()
            .collect()
    }
}

impl ProductStore {
    pub(super) fn lock_automation_index(
        &self,
    ) -> Result<MutexGuard<'_, AutomationRunIndex>, StoreError> {
        self.locks.automation_index.lock().map_err(|error| {
            StoreError::Io(std::io::Error::other(format!(
                "automation run index lock poisoned: {error}"
            )))
        })
    }

    pub(super) fn reset_automation_index(&self) -> Result<(), StoreError> {
        let mut index = self.lock_automation_index()?;
        *index = AutomationRunIndex::default();
        Ok(())
    }

    /// Fold one run projection into the index. Called after every durable
    /// run write, so a live store never needs IO to answer "is it active".
    pub(super) fn record_projected_automation_run(&self, run: &AutomationRun) {
        if let Ok(mut index) = self.lock_automation_index() {
            index.record(run);
        }
    }

    /// One-time build per process, plus the low-frequency correction scan.
    /// Runs in the caller's mutation+journal lock scope.
    fn ensure_automation_run_index_locked(&self, now: Instant) -> Result<(), StoreError> {
        let rebuild = {
            let index = self.lock_automation_index()?;
            index.needs_full_scan(now)
        };
        if rebuild {
            let runs = self.all_automation_runs_locked()?;
            let mut index = self.lock_automation_index()?;
            index.rebuild(&runs, now);
        }
        Ok(())
    }

    /// The active run documents for one automation, straight from the index.
    pub(super) fn active_automation_runs_for_locked(
        &self,
        automation_id: &str,
        now: Instant,
    ) -> Result<Vec<AutomationRun>, StoreError> {
        self.ensure_automation_run_index_locked(now)?;
        let ids = self.lock_automation_index()?.active(automation_id);
        let mut runs = Vec::with_capacity(ids.len());
        for id in ids {
            if let Ok(run) = self.read_automation_run(&id) {
                runs.push(run);
            }
        }
        Ok(runs)
    }

    pub(super) fn all_active_automation_runs_locked(
        &self,
        now: Instant,
    ) -> Result<Vec<AutomationRun>, StoreError> {
        self.ensure_automation_run_index_locked(now)?;
        let ids = self.lock_automation_index()?.all_active();
        let mut runs = Vec::with_capacity(ids.len());
        for id in ids {
            match self.read_automation_run(&id) {
                Ok(run) => runs.push(run),
                // The index says active but the document is gone: that is a
                // corrupted durable fact, not an empty answer.
                Err(StoreError::Corrupt(error)) => return Err(StoreError::Corrupt(error)),
                Err(_) => {}
            }
        }
        Ok(runs)
    }
}
