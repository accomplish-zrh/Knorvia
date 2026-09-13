//! Durable, single-owner automation projections.
//!
//! The scheduler deliberately claims an occurrence before it asks the
//! control plane to start a Thread. The state machine distinguishes that
//! pre-model boundary from a persisted product Turn: claims with no Turn can
//! be resumed after a restart, while a run that reached a real Turn is only
//! reconciled and is never replayed into the model.

use super::atomic_write;
use super::{
    ProductStore, ProjectionKind, StoreError, conflict, invalid, new_id, now_rfc3339, read_json,
};
use knorvia_protocol::{ErrorCategory, ProtocolError, Thread, Turn, thread_id};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::time::Instant;

/// Tick lateness beyond this window counts as a missed calendar occurrence
/// rather than an on-time claim.
const MISSED_OCCURRENCE_GRACE_MS: i64 = 120_000;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_INTERVAL_MINUTES: u64 = 52_560_000; // one century; keeps ms arithmetic bounded.
/// A Home has a finite scheduler dispatch backlog. This cap bounds both the
/// number of due plans a crashed/idle control reader can have waiting and the
/// amount of persistent schedule scan work on each tick.
pub const MAX_AUTOMATIONS_PER_HOME: usize = 512;

/// UTC epoch milliseconds. The protocol uses this rather than local dates so
/// one-off schedules have no ambiguous daylight-saving interpretation.
pub fn epoch_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AutomationSchedule {
    Interval {
        minutes: u64,
    },
    Once {
        at: i64,
    },
    /// Wall-clock occurrences in an explicit IANA time zone (R03). All
    /// lists are empty = every value; weekday 0 = Sunday. The zone name,
    /// not the ambient system zone, decides every occurrence.
    Calendar {
        timezone: String,
        weekdays: Vec<u8>,
        hour: u8,
        minute: u8,
        days_of_month: Vec<u8>,
        last_day_of_month: bool,
        months: Vec<u8>,
        misfire: MisfirePolicy,
    },
}

/// What to do with occurrences the scheduler missed while asleep or
/// restarting. RunLast executes once for the most recent missed occurrence;
/// Skip records it and continues at the next future occurrence.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MisfirePolicy {
    #[default]
    Skip,
    RunLast,
}

impl AutomationSchedule {
    fn validate(&self) -> Result<(), StoreError> {
        match self {
            Self::Interval { minutes } if *minutes == 0 => Err(invalid(
                "automation interval minutes must be greater than zero",
            )),
            Self::Interval { minutes } if *minutes > MAX_INTERVAL_MINUTES => Err(invalid(format!(
                "automation interval minutes must be at most {MAX_INTERVAL_MINUTES}"
            ))),
            Self::Interval { .. } => Ok(()),
            Self::Once { at } if *at < 0 => Err(invalid(
                "automation once.at must be a UTC epoch millisecond",
            )),
            Self::Once { .. } => Ok(()),
            Self::Calendar {
                timezone,
                weekdays,
                hour,
                minute,
                days_of_month,
                last_day_of_month,
                months,
                misfire,
            } => {
                let _ = misfire;
                let _ = misfire;
                crate::automation_calendar::CalendarSpec {
                    timezone,
                    weekdays,
                    hour: *hour,
                    minute: *minute,
                    days_of_month,
                    last_day_of_month: *last_day_of_month,
                    months,
                    misfire: *misfire,
                }
                .validate()
            }
        }
    }

    fn interval_millis(&self) -> Result<i64, StoreError> {
        match self {
            Self::Interval { minutes } => minutes
                .checked_mul(60_000)
                .and_then(|millis| i64::try_from(millis).ok())
                .ok_or_else(|| invalid("automation interval is out of range")),
            Self::Once { .. } | Self::Calendar { .. } => {
                Err(invalid("one-off and calendar schedules have no interval"))
            }
        }
    }

    /// The first occurrence after a create/update or a just-claimed interval.
    /// Advancing from `now` intentionally coalesces any missed intervals into
    /// one occurrence instead of attempting to catch up with a burst.
    fn next_after(&self, now: i64) -> Result<Option<i64>, StoreError> {
        match self {
            Self::Interval { .. } => now
                .checked_add(self.interval_millis()?)
                .map(Some)
                .ok_or_else(|| invalid("automation next run is out of range")),
            Self::Once { at } => Ok(Some(*at)),
            Self::Calendar {
                timezone,
                weekdays,
                hour,
                minute,
                days_of_month,
                last_day_of_month,
                months,
                misfire,
            } => {
                let spec = crate::automation_calendar::CalendarSpec {
                    timezone,
                    weekdays,
                    hour: *hour,
                    minute: *minute,
                    days_of_month,
                    last_day_of_month: *last_day_of_month,
                    months,
                    misfire: *misfire,
                };
                crate::automation_calendar::calendar_next_after(&spec, now)
            }
        }
    }

    fn next_after_claim(&self, now: i64) -> Result<Option<i64>, StoreError> {
        match self {
            // Calendar occurrences anchor to the wall clock: advancing after
            // a claim never accumulates drift or missed-occurrence bursts.
            Self::Calendar { .. } => self.next_after(now),
            Self::Interval { .. } => self.next_after(now),
            Self::Once { .. } => Ok(None),
        }
    }

    /// Future-only occurrences for previews (Once in the past yields none).
    pub fn next_occurrences_after(&self, from: i64, count: usize) -> Result<Vec<i64>, StoreError> {
        let mut out = Vec::new();
        let mut cursor = from;
        for _ in 0..count.max(1) {
            let next = match self {
                Self::Once { at } => {
                    if *at > cursor {
                        Some(*at)
                    } else {
                        None
                    }
                }
                _ => self.next_after(cursor)?,
            };
            match next {
                Some(at) => {
                    out.push(at);
                    cursor = at;
                }
                None => break,
            }
        }
        Ok(out)
    }

    /// Future occurrences inside the half-open plan lifetime. The underlying
    /// schedule keeps its existing timezone/DST and interval cadence; the
    /// lifetime only filters which occurrences may be admitted.
    pub fn next_occurrences_in_window_after(
        &self,
        from: i64,
        count: usize,
        valid_from: Option<i64>,
        valid_until: Option<i64>,
    ) -> Result<Vec<i64>, StoreError> {
        validate_window(valid_from, valid_until)?;
        let floor = valid_from.unwrap_or(i64::MIN);
        let mut out = Vec::new();
        let mut next = match self {
            Self::Interval { .. } => {
                let step = self.interval_millis()?;
                let mut candidate = from
                    .checked_add(step)
                    .ok_or_else(|| invalid("automation next run is out of range"))?;
                if candidate < floor {
                    let distance = floor.saturating_sub(candidate);
                    let jumps = distance.saturating_add(step - 1) / step;
                    candidate = candidate
                        .checked_add(jumps.saturating_mul(step))
                        .ok_or_else(|| invalid("automation validity window is out of range"))?;
                }
                Some(candidate)
            }
            Self::Once { at } if *at > from && *at >= floor => Some(*at),
            Self::Once { .. } => None,
            Self::Calendar { .. } => self.next_after(from.max(floor.saturating_sub(1)))?,
        };
        while out.len() < count.max(1) {
            let Some(at) = next else { break };
            if valid_until.is_some_and(|end| at >= end) {
                break;
            }
            if at >= floor {
                out.push(at);
            }
            next = self.next_after_claim(at)?;
        }
        Ok(out)
    }
}

fn validate_window(valid_from: Option<i64>, valid_until: Option<i64>) -> Result<(), StoreError> {
    if valid_from.is_some_and(|value| value < 0) || valid_until.is_some_and(|value| value < 0) {
        return Err(invalid(
            "automation validFrom and validUntil must be UTC epoch milliseconds",
        ));
    }
    if let (Some(start), Some(end)) = (valid_from, valid_until)
        && start >= end
    {
        return Err(invalid(
            "automation validFrom must be earlier than validUntil",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutomationStatus {
    Active,
    Paused,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutomationTrigger {
    Scheduled,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutomationRunState {
    /// The scheduler has durably reserved an occurrence, but the control
    /// plane has not yet materialized its Thread.
    Claimed,
    /// A Thread id has been reserved and persisted. No executor admission can
    /// happen from this state, so it is safe to finish materialization after a
    /// crash using the same reserved id.
    Materializing,
    /// A real product Thread exists and the control-plane admission is next.
    Starting,
    /// The existing turn executor owns the Turn.
    Running,
    Succeeded,
    Failed,
    Interrupted,
    Skipped,
}

impl AutomationRunState {
    pub(super) fn is_active(self) -> bool {
        matches!(
            self,
            Self::Claimed | Self::Materializing | Self::Starting | Self::Running
        )
    }

    pub(super) fn is_terminal(self) -> bool {
        !self.is_active()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub workspace_id: String,
    pub schedule: AutomationSchedule,
    pub status: AutomationStatus,
    /// Write authority is opt-in per automation. Kernel approvals still apply
    /// to individual privileged actions after this admission setting.
    #[serde(default)]
    pub allow_writes: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Half-open scheduler lifetime: validFrom <= admission < validUntil.
    /// Missing fields on old records retain the original unbounded behavior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub trigger: AutomationTrigger,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_for: Option<i64>,
    pub claimed_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    /// Public run status. Rust keeps the field name `state` to distinguish it
    /// from an Automation's active/paused status, while the wire contract and
    /// existing workbench view use `status`.
    #[serde(rename = "status", alias = "state")]
    pub state: AutomationRunState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// A run snapshots execution input so editing an automation can safely
    /// affect only later occurrences.
    pub title: String,
    pub prompt: String,
    pub workspace_id: String,
    pub allow_writes: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Snapshot of the plan lifetime at claim. This lets a queued run make an
    /// honest final admission decision even if the plan later changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AutomationUpdate {
    pub title: Option<String>,
    pub prompt: Option<String>,
    pub workspace_id: Option<String>,
    pub schedule: Option<AutomationSchedule>,
    pub status: Option<AutomationStatus>,
    pub allow_writes: Option<bool>,
    /// `Some(None)` explicitly clears the saved selection; `None` leaves it
    /// unchanged, so the UI can use null to return to the connection default.
    pub model: Option<Option<String>>,
    pub reasoning_effort: Option<Option<String>>,
    /// Outer None leaves the field unchanged; Some(None) clears it.
    pub valid_from: Option<Option<i64>>,
    pub valid_until: Option<Option<i64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationRecord {
    #[serde(flatten)]
    automation: Automation,
    /// Tombstones keep deletion recoverable through the existing append-only
    /// WAL scheme. Public reads intentionally report them as not found.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deleted_at: Option<i64>,
}

fn require_text(name: &str, value: &str) -> Result<(), StoreError> {
    if value.trim().is_empty() {
        return Err(invalid(format!("automation {name} must not be empty")));
    }
    Ok(())
}

fn run_payload(automation: &Automation, run: &AutomationRun) -> Value {
    json!({"automation": automation, "run": run})
}

impl ProductStore {
    pub fn create_automation(
        &self,
        title: &str,
        prompt: &str,
        workspace_id: &str,
        schedule: AutomationSchedule,
        status: AutomationStatus,
    ) -> Result<Automation, StoreError> {
        self.create_automation_with_settings_at(
            title,
            prompt,
            workspace_id,
            schedule,
            status,
            false,
            None,
            None,
            epoch_millis(),
        )
    }

    pub fn create_automation_at(
        &self,
        title: &str,
        prompt: &str,
        workspace_id: &str,
        schedule: AutomationSchedule,
        status: AutomationStatus,
        now: i64,
    ) -> Result<Automation, StoreError> {
        self.create_automation_with_settings_at(
            title,
            prompt,
            workspace_id,
            schedule,
            status,
            false,
            None,
            None,
            now,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_automation_with_settings(
        &self,
        title: &str,
        prompt: &str,
        workspace_id: &str,
        schedule: AutomationSchedule,
        status: AutomationStatus,
        allow_writes: bool,
        model: Option<String>,
        reasoning_effort: Option<String>,
    ) -> Result<Automation, StoreError> {
        self.create_automation_with_settings_at(
            title,
            prompt,
            workspace_id,
            schedule,
            status,
            allow_writes,
            model,
            reasoning_effort,
            epoch_millis(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_automation_with_settings_at(
        &self,
        title: &str,
        prompt: &str,
        workspace_id: &str,
        schedule: AutomationSchedule,
        status: AutomationStatus,
        allow_writes: bool,
        model: Option<String>,
        reasoning_effort: Option<String>,
        now: i64,
    ) -> Result<Automation, StoreError> {
        self.create_automation_with_window_at(
            title,
            prompt,
            workspace_id,
            schedule,
            status,
            allow_writes,
            model,
            reasoning_effort,
            None,
            None,
            now,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_automation_with_window_at(
        &self,
        title: &str,
        prompt: &str,
        workspace_id: &str,
        schedule: AutomationSchedule,
        status: AutomationStatus,
        allow_writes: bool,
        model: Option<String>,
        reasoning_effort: Option<String>,
        valid_from: Option<i64>,
        valid_until: Option<i64>,
        now: i64,
    ) -> Result<Automation, StoreError> {
        require_text("title", title)?;
        require_text("prompt", prompt)?;
        if let Some(model) = &model {
            require_text("model", model)?;
        }
        if let Some(reasoning_effort) = &reasoning_effort {
            require_text("reasoningEffort", reasoning_effort)?;
        }
        schedule.validate()?;
        validate_window(valid_from, valid_until)?;
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        if self
            .list_automation_records_locked()?
            .into_iter()
            .filter(|record| record.deleted_at.is_none())
            .count()
            >= MAX_AUTOMATIONS_PER_HOME
        {
            return Err(ProtocolError::new(
                ErrorCategory::ResourceExhausted,
                format!(
                    "a Knorvia Home supports at most {MAX_AUTOMATIONS_PER_HOME} active automations"
                ),
            )
            .into());
        }
        let _ = self.read_workspace(workspace_id)?;
        let next_run_at = match &schedule {
            // Preserve the established due-now semantics for a one-shot plan;
            // previews remain future-only.
            AutomationSchedule::Once { at }
                if valid_from.is_none_or(|start| *at >= start)
                    && valid_until.is_none_or(|end| *at < end) =>
            {
                Some(*at)
            }
            _ => schedule
                .next_occurrences_in_window_after(now, 1, valid_from, valid_until)?
                .into_iter()
                .next(),
        };
        let automation = Automation {
            id: new_id("auto"),
            title: title.to_string(),
            prompt: prompt.to_string(),
            workspace_id: workspace_id.to_string(),
            next_run_at,
            schedule,
            status,
            allow_writes,
            model,
            reasoning_effort,
            valid_from,
            valid_until,
            last_thread_id: None,
            last_run_at: None,
            last_error: None,
            revision: 1,
            created_at: now,
            updated_at: now,
        };
        let record = AutomationRecord {
            automation: automation.clone(),
            deleted_at: None,
        };
        let write = self.projection_write(ProjectionKind::Automation, &automation.id, &record)?;
        self.commit_transaction_locked(
            &automation.id,
            "automation.created",
            serde_json::to_value(&automation)?,
            None,
            vec![write],
        )?;
        Ok(automation)
    }

    pub fn read_automation(&self, id: &str) -> Result<Automation, StoreError> {
        let record = self.read_automation_record(id)?;
        if record.deleted_at.is_some() {
            return Err(super::not_found("automation", id));
        }
        Ok(record.automation)
    }

    pub fn list_automations(
        &self,
        workspace_id: Option<&str>,
    ) -> Result<Vec<Automation>, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut automations = self
            .list_automation_records_locked()?
            .into_iter()
            .filter(|record| record.deleted_at.is_none())
            .map(|record| record.automation)
            .filter(|automation| workspace_id.is_none_or(|id| automation.workspace_id == id))
            .collect::<Vec<_>>();
        automations.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(automations)
    }

    pub fn list_automation_runs(
        &self,
        automation_id: &str,
        limit: usize,
    ) -> Result<Vec<AutomationRun>, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut runs = self.list_automation_runs_locked(automation_id)?;
        runs.sort_by(|left, right| {
            right
                .claimed_at
                .cmp(&left.claimed_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        runs.truncate(limit);
        Ok(runs)
    }

    /// Whether any automation run is still active (A19 quiescence): a run
    /// that reached a durable claim boundary (Claimed, Materializing,
    /// Starting) or owns a live Turn (Running). Reads the durable run
    /// records directly so the answer reflects facts, not index drift.
    pub fn has_active_automation_run(&self) -> Result<bool, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        Ok(self
            .all_automation_runs_locked()?
            .iter()
            .any(|run| run.state.is_active()))
    }

    #[cfg(test)]
    pub fn insert_automation_run_fixture(&self, state: &str) -> Result<(), StoreError> {
        let run = AutomationRun {
            id: knorvia_protocol::new_id("run"),
            automation_id: knorvia_protocol::new_id("auto"),
            trigger: AutomationTrigger::Scheduled,
            scheduled_for: None,
            claimed_at: epoch_millis(),
            started_at: None,
            finished_at: None,
            state: serde_json::from_value(serde_json::Value::String(state.to_string()))
                .map_err(|_| invalid(format!("unknown automation run state {state}")))?,
            thread_id: None,
            turn_id: None,
            error: None,
            title: "fixture".into(),
            prompt: "fixture".into(),
            workspace_id: knorvia_protocol::new_id("ws"),
            allow_writes: false,
            model: None,
            reasoning_effort: None,
            valid_from: None,
            valid_until: None,
        };
        let path = self.automation_run_path(&run.id);
        atomic_write(&path, &serde_json::to_vec_pretty(&run)?)?;
        Ok(())
    }

    pub fn update_automation(
        &self,
        id: &str,
        update: AutomationUpdate,
        expected_revision: Option<u64>,
    ) -> Result<Automation, StoreError> {
        self.update_automation_at(id, update, expected_revision, epoch_millis())
    }

    pub fn update_automation_at(
        &self,
        id: &str,
        update: AutomationUpdate,
        expected_revision: Option<u64>,
        now: i64,
    ) -> Result<Automation, StoreError> {
        if let Some(title) = &update.title {
            require_text("title", title)?;
        }
        if let Some(prompt) = &update.prompt {
            require_text("prompt", prompt)?;
        }
        if let Some(schedule) = &update.schedule {
            schedule.validate()?;
        }
        if let Some(Some(model)) = &update.model {
            require_text("model", model)?;
        }
        if let Some(Some(reasoning_effort)) = &update.reasoning_effort {
            require_text("reasoningEffort", reasoning_effort)?;
        }
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut record = self.read_automation_record(id)?;
        if record.deleted_at.is_some() {
            return Err(super::not_found("automation", id));
        }
        if let Some(expected) = expected_revision
            && record.automation.revision != expected
        {
            return Err(conflict(format!(
                "automation revision {} != expected {expected}",
                record.automation.revision
            )));
        }
        if let Some(workspace_id) = &update.workspace_id {
            let _ = self.read_workspace(workspace_id)?;
        }

        let prior = record.automation.clone();
        let requested_valid_from = update.valid_from.unwrap_or(record.automation.valid_from);
        let requested_valid_until = update.valid_until.unwrap_or(record.automation.valid_until);
        validate_window(requested_valid_from, requested_valid_until)?;
        if let Some(title) = update.title {
            record.automation.title = title;
        }
        if let Some(prompt) = update.prompt {
            record.automation.prompt = prompt;
        }
        if let Some(workspace_id) = update.workspace_id {
            record.automation.workspace_id = workspace_id;
        }
        if let Some(schedule) = update.schedule {
            record.automation.schedule = schedule;
        }
        if let Some(valid_from) = update.valid_from {
            record.automation.valid_from = valid_from;
        }
        if let Some(valid_until) = update.valid_until {
            record.automation.valid_until = valid_until;
        }
        if record.automation.schedule != prior.schedule
            || record.automation.valid_from != prior.valid_from
            || record.automation.valid_until != prior.valid_until
        {
            record.automation.next_run_at = record
                .automation
                .schedule
                .next_occurrences_in_window_after(
                    now,
                    1,
                    record.automation.valid_from,
                    record.automation.valid_until,
                )?
                .into_iter()
                .next();
        }
        if let Some(status) = update.status {
            let resumed =
                prior.status == AutomationStatus::Paused && status == AutomationStatus::Active;
            record.automation.status = status;
            // A resumed interval begins a fresh cadence from the moment it is
            // resumed. A one-off retains its original absolute UTC instant.
            if resumed
                && matches!(
                    record.automation.schedule,
                    AutomationSchedule::Interval { .. }
                )
            {
                record.automation.next_run_at = record
                    .automation
                    .schedule
                    .next_occurrences_in_window_after(
                        now,
                        1,
                        record.automation.valid_from,
                        record.automation.valid_until,
                    )?
                    .into_iter()
                    .next();
            }
        }
        if let Some(allow_writes) = update.allow_writes {
            record.automation.allow_writes = allow_writes;
        }
        if let Some(model) = update.model {
            record.automation.model = model;
        }
        if let Some(reasoning_effort) = update.reasoning_effort {
            record.automation.reasoning_effort = reasoning_effort;
        }
        if record.automation == prior {
            return Ok(record.automation);
        }

        record.automation.revision =
            record.automation.revision.checked_add(1).ok_or_else(|| {
                StoreError::Corrupt(format!("automation {id} revision exhausted"))
            })?;
        record.automation.updated_at = now;
        let mut writes = vec![self.projection_write(ProjectionKind::Automation, id, &record)?];

        // A pre-model occurrence can safely be superseded by an edit. Once a
        // product Turn exists, it is treated as admitted work and is never
        // represented as a cancellation.
        let turn_count_by_thread = self.turn_count_by_thread_locked()?;
        for mut run in self.list_automation_runs_locked(id)? {
            if !is_pre_model_run(&run, &turn_count_by_thread) {
                continue;
            }
            run.state = AutomationRunState::Skipped;
            run.finished_at = Some(now);
            run.error = Some("automation changed before the queued run started".into());
            writes.push(self.projection_write(ProjectionKind::AutomationRun, &run.id, &run)?);
        }
        self.commit_transaction_locked(
            id,
            "automation.updated",
            serde_json::to_value(&record.automation)?,
            None,
            writes,
        )?;
        Ok(record.automation)
    }

    pub fn delete_automation(
        &self,
        id: &str,
        expected_revision: Option<u64>,
    ) -> Result<(), StoreError> {
        self.delete_automation_at(id, expected_revision, epoch_millis())
    }

    pub fn delete_automation_at(
        &self,
        id: &str,
        expected_revision: Option<u64>,
        now: i64,
    ) -> Result<(), StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut record = self.read_automation_record(id)?;
        if record.deleted_at.is_some() {
            return Err(super::not_found("automation", id));
        }
        if let Some(expected) = expected_revision
            && record.automation.revision != expected
        {
            return Err(conflict(format!(
                "automation revision {} != expected {expected}",
                record.automation.revision
            )));
        }
        record.deleted_at = Some(now);
        record.automation.revision =
            record.automation.revision.checked_add(1).ok_or_else(|| {
                StoreError::Corrupt(format!("automation {id} revision exhausted"))
            })?;
        record.automation.updated_at = now;
        let mut writes = vec![self.projection_write(ProjectionKind::Automation, id, &record)?];
        let turn_count_by_thread = self.turn_count_by_thread_locked()?;
        for mut run in self.list_automation_runs_locked(id)? {
            if !is_pre_model_run(&run, &turn_count_by_thread) {
                continue;
            }
            run.state = AutomationRunState::Skipped;
            run.finished_at = Some(now);
            run.error = Some("automation deleted before the queued run started".into());
            writes.push(self.projection_write(ProjectionKind::AutomationRun, &run.id, &run)?);
        }
        self.commit_transaction_locked(
            id,
            "automation.deleted",
            json!({"id": id, "deletedAt": now}),
            None,
            writes,
        )?;
        Ok(())
    }

    /// Reconcile durable admission and terminal Turn state without ever
    /// running a model call. It is safe for the scheduler's background
    /// thread to call this.
    pub fn reconcile_automation_runs(&self, now: i64) -> Result<(), StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.reconcile_automation_runs_locked(now)
    }

    fn reconcile_automation_runs_locked(&self, now: i64) -> Result<(), StoreError> {
        // Only active runs are reconciled: terminal history stays on disk.
        // The index's low-frequency full scan keeps this honest against any
        // drift between the index and the durable facts.
        let runs = self.all_active_automation_runs_locked(Instant::now())?;
        for run in runs {
            match run.state {
                AutomationRunState::Materializing => {
                    self.reconcile_materializing_automation_run_locked(&run, now)?;
                }
                AutomationRunState::Starting => {
                    self.reconcile_starting_automation_run_locked(&run, now)?;
                }
                AutomationRunState::Running => {
                    self.reconcile_running_automation_run_locked(&run, now)?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// `Materializing` cannot itself reach the executor. A Turn on its
    /// reserved Thread therefore proves outside interference or a corrupted
    /// checkpoint; record the ambiguity instead of trying to use that Thread.
    fn reconcile_materializing_automation_run_locked(
        &self,
        run: &AutomationRun,
        now: i64,
    ) -> Result<(), StoreError> {
        let Some(thread_id) = run.thread_id.as_deref() else {
            return Ok(());
        };
        if self.indexed_turn_count_locked(thread_id)? > 0 {
            self.finish_automation_run_locked(
                run,
                AutomationRunState::Interrupted,
                now,
                Some(
                    "automation materialization found a product turn before its admission checkpoint; it was not replayed"
                        .into(),
                ),
            )?;
        }
        Ok(())
    }

    /// A `Starting` run has a materialized product Thread but does not yet
    /// have its durable Turn correlation. A real model can only begin after
    /// `rpc_turn_start` has persisted a Turn, so an empty Thread remains safe
    /// to resume. A single real Turn is linked without another model call.
    /// Multiple Turns are ambiguous (for example external interference), so
    /// the automation becomes interrupted rather than guessing or replaying.
    fn reconcile_starting_automation_run_locked(
        &self,
        run: &AutomationRun,
        now: i64,
    ) -> Result<(), StoreError> {
        let Some(thread_id) = run.thread_id.as_deref() else {
            self.finish_automation_run_locked(
                run,
                AutomationRunState::Interrupted,
                now,
                Some("automation run was starting without a materialized thread".into()),
            )?;
            return Ok(());
        };
        let turns = self.indexed_turns_for_thread_locked(thread_id)?;
        match turns.as_slice() {
            // The owner may be between durable Thread materialization and
            // turn/start. Do not terminalize or replay from this background
            // reconciler; the scheduler can safely offer this run later if
            // its owner returns an admission error.
            [] => Ok(()),
            [turn] => {
                let linked = self.mark_automation_run_started_locked(&run.id, &turn.id)?;
                if is_terminal_turn(&turn.status) {
                    let (state, error) = self.terminal_turn_state_locked(turn)?;
                    self.finish_automation_run_locked(&linked, state, now, error)?;
                }
                Ok(())
            }
            _ => {
                self.finish_automation_run_locked(
                    run,
                    AutomationRunState::Interrupted,
                    now,
                    Some(
                        "automation admission found multiple turns on its materialized thread; it was not replayed"
                            .into(),
                    ),
                )?;
                Ok(())
            }
        }
    }

    fn reconcile_running_automation_run_locked(
        &self,
        run: &AutomationRun,
        now: i64,
    ) -> Result<(), StoreError> {
        let Some(turn_id) = run.turn_id.as_deref() else {
            self.finish_automation_run_locked(
                run,
                AutomationRunState::Failed,
                now,
                Some("automation run was marked running without a product turn".into()),
            )?;
            return Ok(());
        };
        match self.read_turn(turn_id) {
            Ok(turn) if is_terminal_turn(&turn.status) => {
                let (state, error) = self.terminal_turn_state_locked(&turn)?;
                self.finish_automation_run_locked(run, state, now, error)?;
            }
            Ok(_) => {}
            Err(error) => {
                self.finish_automation_run_locked(
                    run,
                    AutomationRunState::Failed,
                    now,
                    Some(format!(
                        "automation turn {turn_id} could not be read: {error}"
                    )),
                )?;
            }
        }
        Ok(())
    }

    /// Resolve stale in-flight claims after the owner has restarted. This is
    /// intentionally separate from the normal scheduler tick: a live daemon
    /// must not mistake its own queued dispatch for a crash.
    pub fn recover_automation_runs_after_restart(&self, now: i64) -> Result<(), StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.reconcile_automation_runs_locked(now)?;
        for run in self.all_automation_runs_locked()? {
            // Reconciliation resolves runs whose durable Turn evidence decides
            // their outcome. Whatever is still active after it (Claimed,
            // Materializing, Starting without proof, Running) had reached a
            // durable claim boundary before the restart, so it must never be
            // silently replayed: the scheduler's pre-model rescan only serves
            // a live owner that dropped a wake-up, never a fresh process.
            if run.state.is_active() {
                self.finish_automation_run_locked(
                    &run,
                    AutomationRunState::Interrupted,
                    now,
                    Some(
                        "automation dispatch had reached a durable claim boundary before restart; it was not retried automatically"
                            .into(),
                    ),
                )?;
            }
        }
        Ok(())
    }

    /// Claim all currently due schedules. Each interval advances from `now`,
    /// so a machine waking after a long sleep creates at most one run per
    /// automation on that tick.
    pub fn claim_due_automations_at(&self, now: i64) -> Result<Vec<AutomationRun>, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let records = self.list_automation_records_locked()?;
        let mut claimed = Vec::new();
        for record in records {
            if record.deleted_at.is_some()
                || record.automation.status != AutomationStatus::Active
                || record.automation.next_run_at.is_none_or(|at| at > now)
                || self.has_active_automation_run_locked(&record.automation.id)?
            {
                continue;
            }
            if record
                .automation
                .valid_from
                .is_some_and(|start| now < start)
            {
                continue;
            }
            if record.automation.valid_until.is_some_and(|end| now >= end) {
                let expired = self.claim_automation_run_locked(
                    record,
                    AutomationTrigger::Scheduled,
                    now,
                    true,
                )?;
                self.finish_automation_run_locked(
                    &expired,
                    AutomationRunState::Skipped,
                    now,
                    Some("automation occurrence expired before scheduler claim".into()),
                )?;
                continue;
            }
            // A calendar plan found far past its due occurrence was missed
            // while the scheduler was asleep. Skip policy records the latest
            // missed occurrence durably and continues at the next future
            // occurrence; RunLast falls through and runs it once.
            if let AutomationSchedule::Calendar { misfire, .. } = &record.automation.schedule
                && *misfire == MisfirePolicy::Skip
                && record
                    .automation
                    .next_run_at
                    .is_some_and(|due_at| now.saturating_sub(due_at) > MISSED_OCCURRENCE_GRACE_MS)
            {
                let claimed = self.claim_automation_run_locked(
                    record,
                    AutomationTrigger::Scheduled,
                    now,
                    true,
                )?;
                self.finish_automation_run_locked(
                    &claimed,
                    AutomationRunState::Skipped,
                    now,
                    Some(
                        "calendar occurrence missed while the scheduler was asleep; misfire policy skip"
                            .into(),
                    ),
                )?;
                continue;
            }
            claimed.push(self.claim_automation_run_locked(
                record,
                AutomationTrigger::Scheduled,
                now,
                true,
            )?);
        }
        Ok(claimed)
    }

    /// Return only occurrences whose durable state proves that no model call
    /// has begun. The bounded in-memory scheduler queue may drop a wake-up
    /// under backpressure; this persistent scan is its lossless source of
    /// truth on the next tick.
    pub fn list_resumable_automation_runs(
        &self,
        limit: usize,
    ) -> Result<Vec<AutomationRun>, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let now = epoch_millis();
        self.reconcile_automation_runs_locked(now)?;
        self.skip_unadmittable_resumable_runs_locked(now)?;
        let records = self
            .list_automation_records_locked()?
            .into_iter()
            .map(|record| (record.automation.id.clone(), record))
            .collect::<HashMap<_, _>>();
        let runs = self.all_active_automation_runs_locked(Instant::now())?;
        let mut resumable = runs
            .into_iter()
            .filter(|run| {
                let Some(record) = records.get(&run.automation_id) else {
                    return false;
                };
                record.deleted_at.is_none()
                    && !(run.trigger == AutomationTrigger::Scheduled
                        && record.automation.status != AutomationStatus::Active)
                    && self.is_pre_model_run_locked(run).unwrap_or(false)
            })
            .collect::<Vec<_>>();
        resumable.sort_by(|left, right| {
            left.claimed_at
                .cmp(&right.claimed_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        resumable.truncate(limit.min(MAX_AUTOMATIONS_PER_HOME));
        Ok(resumable)
    }

    /// Mark pre-model occurrences that can no longer execute because their
    /// schedule was deleted or paused. This deliberately excludes manual runs
    /// on a paused plan: Run now remains explicit user intent.
    fn skip_unadmittable_resumable_runs_locked(&self, now: i64) -> Result<(), StoreError> {
        let records = self
            .list_automation_records_locked()?
            .into_iter()
            .map(|record| (record.automation.id.clone(), record))
            .collect::<HashMap<_, _>>();
        for run in self.all_active_automation_runs_locked(Instant::now())? {
            if !self.is_pre_model_run_locked(&run)? {
                continue;
            }
            let Some(record) = records.get(&run.automation_id) else {
                continue;
            };
            let reason = if record.deleted_at.is_some() {
                Some("automation was deleted before the queued run started")
            } else if run.trigger == AutomationTrigger::Scheduled
                && record.automation.status != AutomationStatus::Active
            {
                Some("automation was paused before the queued run started")
            } else if run.valid_from.is_some_and(|start| now < start) {
                Some("automation occurrence is before its validity window")
            } else if run.valid_until.is_some_and(|end| now >= end) {
                Some("automation occurrence expired before the queued run started")
            } else {
                None
            };
            if let Some(reason) = reason {
                self.finish_automation_run_locked(
                    &run,
                    AutomationRunState::Skipped,
                    now,
                    Some(reason.into()),
                )?;
            }
        }
        Ok(())
    }

    pub fn claim_manual_automation_run(&self, id: &str) -> Result<AutomationRun, StoreError> {
        self.claim_manual_automation_run_at(id, epoch_millis())
    }

    /// Manual runs are deliberately permitted while a plan is paused: pause
    /// controls the clock, whereas an explicit Run now is user intent.
    pub fn claim_manual_automation_run_at(
        &self,
        id: &str,
        now: i64,
    ) -> Result<AutomationRun, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let record = self.read_automation_record(id)?;
        if record.deleted_at.is_some() {
            return Err(super::not_found("automation", id));
        }
        if self.has_active_automation_run_locked(id)? {
            return Err(conflict("automation already has a running or queued run"));
        }
        if record
            .automation
            .valid_from
            .is_some_and(|start| now < start)
            || record.automation.valid_until.is_some_and(|end| now >= end)
        {
            return Err(ProtocolError::new(
                ErrorCategory::PreconditionFailed,
                "automation is outside its validity window",
            )
            .into());
        }
        self.claim_automation_run_locked(record, AutomationTrigger::Manual, now, false)
    }

    /// Reserve and create a real product Thread for a claimed run. This does
    /// not execute the model. The control plane subsequently passes the
    /// returned Thread to its existing `turn/start` lifecycle.
    pub fn materialize_automation_run(
        &self,
        run_id: &str,
        now: i64,
    ) -> Result<Option<AutomationRun>, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut run = self.read_automation_run(run_id)?;
        if matches!(
            run.state,
            AutomationRunState::Claimed
                | AutomationRunState::Materializing
                | AutomationRunState::Starting
        ) && (run.valid_from.is_some_and(|start| now < start)
            || run.valid_until.is_some_and(|end| now >= end))
        {
            self.finish_automation_run_locked(
                &run,
                AutomationRunState::Skipped,
                now,
                Some("automation occurrence expired outside its validity window".into()),
            )?;
            return Ok(None);
        }
        match run.state {
            AutomationRunState::Claimed | AutomationRunState::Materializing => {
                self.materialize_pre_model_automation_run_locked(&mut run, now)
            }
            AutomationRunState::Starting => {
                let Some(thread_id) = run.thread_id.as_deref() else {
                    self.finish_automation_run_locked(
                        &run,
                        AutomationRunState::Interrupted,
                        now,
                        Some("automation run was starting without a materialized thread".into()),
                    )?;
                    return Ok(None);
                };
                let turns = self
                    .list_turns_locked()?
                    .into_iter()
                    .filter(|turn| turn.thread_id == thread_id)
                    .collect::<Vec<_>>();
                match turns.as_slice() {
                    [] => {
                        let record = self.read_automation_record(&run.automation_id)?;
                        if record.deleted_at.is_some()
                            || (run.trigger == AutomationTrigger::Scheduled
                                && record.automation.status != AutomationStatus::Active)
                        {
                            self.finish_automation_run_locked(
                                &run,
                                AutomationRunState::Skipped,
                                now,
                                Some(
                                    "automation was paused or deleted before the queued run started"
                                        .into(),
                                ),
                            )?;
                            return Ok(None);
                        }
                        // A product Thread exists, but no product Turn has
                        // been persisted. Reuse the same Thread rather than
                        // creating a second one and let the normal turn/start
                        // path make the first model admission.
                        Ok(Some(run))
                    }
                    [turn] => {
                        let linked = self.mark_automation_run_started_locked(&run.id, &turn.id)?;
                        if is_terminal_turn(&turn.status) {
                            let (state, error) = self.terminal_turn_state_locked(turn)?;
                            self.finish_automation_run_locked(&linked, state, now, error)?;
                        }
                        Ok(None)
                    }
                    _ => {
                        self.finish_automation_run_locked(
                            &run,
                            AutomationRunState::Interrupted,
                            now,
                            Some(
                                "automation admission found multiple turns on its materialized thread; it was not replayed"
                                    .into(),
                            ),
                        )?;
                        Ok(None)
                    }
                }
            }
            AutomationRunState::Running
            | AutomationRunState::Succeeded
            | AutomationRunState::Failed
            | AutomationRunState::Interrupted
            | AutomationRunState::Skipped => Ok(None),
        }
    }

    /// Finish durable Thread materialization for a pre-model run. Every retry
    /// retains the same reserved Thread id, so a WAL or filesystem failure can
    /// never fan one occurrence out into multiple product Threads.
    fn materialize_pre_model_automation_run_locked(
        &self,
        run: &mut AutomationRun,
        now: i64,
    ) -> Result<Option<AutomationRun>, StoreError> {
        let record = self.read_automation_record(&run.automation_id)?;
        if run.valid_from.is_some_and(|start| now < start)
            || run.valid_until.is_some_and(|end| now >= end)
        {
            self.finish_automation_run_locked(
                run,
                AutomationRunState::Skipped,
                now,
                Some("automation occurrence expired outside its validity window".into()),
            )?;
            return Ok(None);
        }
        if record.deleted_at.is_some()
            || (run.trigger == AutomationTrigger::Scheduled
                && record.automation.status != AutomationStatus::Active)
        {
            self.finish_automation_run_locked(
                run,
                AutomationRunState::Skipped,
                now,
                Some("automation was paused or deleted before the queued run started".into()),
            )?;
            return Ok(None);
        }

        let reserved_thread_id = match run.state {
            AutomationRunState::Claimed => {
                let reserved_thread_id = thread_id();
                run.thread_id = Some(reserved_thread_id.clone());
                run.state = AutomationRunState::Materializing;
                let reservation_write =
                    self.projection_write(ProjectionKind::AutomationRun, &run.id, run)?;
                self.commit_transaction_locked(
                    &run.automation_id,
                    "automation.run.thread_reserved",
                    run_payload(&record.automation, run),
                    None,
                    vec![reservation_write],
                )?;
                self.record_projected_automation_run(run);
                reserved_thread_id
            }
            AutomationRunState::Materializing => match run.thread_id.clone() {
                Some(thread_id) => thread_id,
                None => {
                    self.finish_automation_run_locked(
                        run,
                        AutomationRunState::Interrupted,
                        now,
                        Some("automation materialization lost its reserved thread id".into()),
                    )?;
                    return Ok(None);
                }
            },
            _ => return Ok(None),
        };

        if self.thread_path(&reserved_thread_id).exists() {
            let thread = self.read_thread(&reserved_thread_id)?;
            if thread.workspace_id != run.workspace_id {
                return Err(StoreError::Corrupt(format!(
                    "automation run {} reserved thread {} for workspace {}, found {}",
                    run.id, reserved_thread_id, run.workspace_id, thread.workspace_id
                )));
            }
        } else {
            let thread = Thread {
                id: reserved_thread_id.clone(),
                workspace_id: run.workspace_id.clone(),
                goal_id: None,
                task_id: None,
                title: format!("Automation: {}", run.title),
                status: "active".into(),
                revision: 1,
                created_at: now_rfc3339(),
                updated_at: now_rfc3339(),
            };
            // This projection belongs to the Thread stream, exactly like a
            // normal `thread/start`; it must not be written under the
            // automation stream. Keep Materializing on an error so recovery
            // can inspect the WAL and continue with this exact id.
            let thread_write =
                self.projection_write(ProjectionKind::Thread, &thread.id, &thread)?;
            self.commit_transaction_locked(
                &thread.id,
                "thread.created",
                serde_json::to_value(&thread)?,
                None,
                vec![thread_write],
            )?;
        }

        if self
            .list_turns_locked()?
            .iter()
            .any(|turn| turn.thread_id == reserved_thread_id)
        {
            self.finish_automation_run_locked(
                run,
                AutomationRunState::Interrupted,
                now,
                Some(
                    "automation materialization found a product turn before its admission checkpoint; it was not replayed"
                        .into(),
                ),
            )?;
            return Ok(None);
        }

        let mut current = self.read_automation_record(&run.automation_id)?;
        run.state = AutomationRunState::Starting;
        run.started_at = Some(now);
        current.automation.last_thread_id = Some(reserved_thread_id);
        current.automation.last_run_at = Some(now);
        current.automation.last_error = None;
        current.automation.revision = current
            .automation
            .revision
            .checked_add(1)
            .ok_or_else(|| StoreError::Corrupt("automation revision exhausted".into()))?;
        current.automation.updated_at = now;
        let writes = vec![
            self.projection_write(ProjectionKind::Automation, &current.automation.id, &current)?,
            self.projection_write(ProjectionKind::AutomationRun, &run.id, run)?,
        ];
        self.commit_transaction_locked(
            &run.automation_id,
            "automation.run.thread_created",
            run_payload(&current.automation, run),
            None,
            writes,
        )?;
        self.record_projected_automation_run(run);
        Ok(Some(run.clone()))
    }

    pub fn mark_automation_run_started(
        &self,
        run_id: &str,
        turn_id: &str,
        _now: i64,
    ) -> Result<AutomationRun, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.mark_automation_run_started_locked(run_id, turn_id)
    }

    /// Link the unique durable product Turn that passed the existing
    /// `turn/start` lifecycle. This is idempotent for the same Turn because a
    /// background reconciliation can win the tiny race before the owner gets
    /// back from `rpc_turn_start`.
    fn mark_automation_run_started_locked(
        &self,
        run_id: &str,
        turn_id: &str,
    ) -> Result<AutomationRun, StoreError> {
        let mut run = self.read_automation_run(run_id)?;
        if run.turn_id.as_deref() == Some(turn_id)
            && (run.state == AutomationRunState::Running || run.state.is_terminal())
        {
            return Ok(run);
        }
        if run.state != AutomationRunState::Starting {
            return Err(conflict("automation run is not ready to start its turn"));
        }
        let thread_id = run.thread_id.as_deref().ok_or_else(|| {
            StoreError::Corrupt(format!(
                "automation run {run_id} is starting without a thread"
            ))
        })?;
        let turn = self.read_turn(turn_id)?;
        if turn.thread_id != thread_id {
            return Err(conflict(
                "automation turn does not belong to the run's materialized thread",
            ));
        }
        run.state = AutomationRunState::Running;
        run.turn_id = Some(turn_id.to_string());
        let record = self.read_automation_record(&run.automation_id)?;
        let write = self.projection_write(ProjectionKind::AutomationRun, &run.id, &run)?;
        self.commit_transaction_locked(
            &run.automation_id,
            "automation.run.started",
            run_payload(&record.automation, &run),
            Some(turn_id.to_string()),
            vec![write],
        )?;
        self.record_projected_automation_run(&run);
        Ok(run)
    }

    pub fn fail_automation_run(
        &self,
        run_id: &str,
        error: impl Into<String>,
        now: i64,
    ) -> Result<AutomationRun, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let run = self.read_automation_run(run_id)?;
        if run.state.is_terminal() {
            return Ok(run);
        }
        self.finish_automation_run_locked(&run, AutomationRunState::Failed, now, Some(error.into()))
    }

    fn claim_automation_run_locked(
        &self,
        mut record: AutomationRecord,
        trigger: AutomationTrigger,
        now: i64,
        advance_schedule: bool,
    ) -> Result<AutomationRun, StoreError> {
        if self.has_active_automation_run_locked(&record.automation.id)? {
            return Err(conflict("automation already has a running or queued run"));
        }
        let scheduled_for = if trigger == AutomationTrigger::Scheduled {
            record.automation.next_run_at
        } else {
            Some(now)
        };
        if advance_schedule {
            record.automation.next_run_at = record
                .automation
                .schedule
                .next_after_claim(now)?
                .filter(|at| {
                    record
                        .automation
                        .valid_from
                        .is_none_or(|start| *at >= start)
                        && record.automation.valid_until.is_none_or(|end| *at < end)
                });
        }
        record.automation.revision = record
            .automation
            .revision
            .checked_add(1)
            .ok_or_else(|| StoreError::Corrupt("automation revision exhausted".into()))?;
        record.automation.updated_at = now;
        let run = AutomationRun {
            id: new_id("autorun"),
            automation_id: record.automation.id.clone(),
            trigger,
            scheduled_for,
            claimed_at: now,
            started_at: None,
            finished_at: None,
            state: AutomationRunState::Claimed,
            thread_id: None,
            turn_id: None,
            error: None,
            title: record.automation.title.clone(),
            prompt: record.automation.prompt.clone(),
            workspace_id: record.automation.workspace_id.clone(),
            allow_writes: record.automation.allow_writes,
            model: record.automation.model.clone(),
            reasoning_effort: record.automation.reasoning_effort.clone(),
            valid_from: record.automation.valid_from,
            valid_until: record.automation.valid_until,
        };
        let writes = vec![
            self.projection_write(ProjectionKind::Automation, &record.automation.id, &record)?,
            self.projection_write(ProjectionKind::AutomationRun, &run.id, &run)?,
        ];
        self.commit_transaction_locked(
            &record.automation.id,
            "automation.run.claimed",
            run_payload(&record.automation, &run),
            None,
            writes,
        )?;
        self.record_projected_automation_run(&run);
        Ok(run)
    }

    fn finish_automation_run_locked(
        &self,
        existing: &AutomationRun,
        state: AutomationRunState,
        now: i64,
        error: Option<String>,
    ) -> Result<AutomationRun, StoreError> {
        if !state.is_terminal() {
            return Err(StoreError::Corrupt(
                "automation terminal update used a live state".into(),
            ));
        }
        let mut run = existing.clone();
        if run.state.is_terminal() {
            return Ok(run);
        }
        run.state = state;
        run.finished_at = Some(now);
        run.error = error.clone();
        let mut record = self.read_automation_record(&run.automation_id)?;
        record.automation.last_error = error;
        if run.thread_id.is_some() {
            record.automation.last_thread_id = run.thread_id.clone();
        }
        record.automation.last_run_at = run.started_at.or(Some(run.claimed_at));
        record.automation.revision = record
            .automation
            .revision
            .checked_add(1)
            .ok_or_else(|| StoreError::Corrupt("automation revision exhausted".into()))?;
        record.automation.updated_at = now;
        let writes = vec![
            self.projection_write(ProjectionKind::Automation, &record.automation.id, &record)?,
            self.projection_write(ProjectionKind::AutomationRun, &run.id, &run)?,
        ];
        self.commit_transaction_locked(
            &run.automation_id,
            "automation.run.finished",
            run_payload(&record.automation, &run),
            run.turn_id.clone(),
            writes,
        )?;
        self.record_projected_automation_run(&run);
        Ok(run)
    }

    fn read_automation_record(&self, id: &str) -> Result<AutomationRecord, StoreError> {
        let path = self.automation_path(id);
        if !path.exists() {
            return Err(super::not_found("automation", id));
        }
        let record: AutomationRecord = read_json(&path)?;
        if record.automation.id != id {
            return Err(StoreError::Corrupt(format!(
                "automation projection {path:?} belongs to {}",
                record.automation.id
            )));
        }
        Ok(record)
    }

    pub fn read_automation_run(&self, id: &str) -> Result<AutomationRun, StoreError> {
        let path = self.automation_run_path(id);
        if !path.exists() {
            return Err(super::not_found("automation run", id));
        }
        let run: AutomationRun = read_json(&path)?;
        if run.id != id {
            return Err(StoreError::Corrupt(format!(
                "automation run projection {path:?} belongs to {}",
                run.id
            )));
        }
        Ok(run)
    }

    fn list_automation_records_locked(&self) -> Result<Vec<AutomationRecord>, StoreError> {
        let directory = self.product_dir().join("automations");
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut records = Vec::new();
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            if entry.path().extension().and_then(|value| value.to_str()) == Some("json") {
                records.push(read_json(&entry.path())?);
            }
        }
        Ok(records)
    }

    pub(super) fn all_automation_runs_locked(&self) -> Result<Vec<AutomationRun>, StoreError> {
        let directory = self.product_dir().join("automation-runs");
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut runs = Vec::new();
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            if entry.path().extension().and_then(|value| value.to_str()) == Some("json") {
                runs.push(read_json(&entry.path())?);
            }
        }
        Ok(runs)
    }

    fn turn_count_by_thread_locked(&self) -> Result<HashMap<String, usize>, StoreError> {
        let mut counts = HashMap::new();
        for turn in self.list_turns_locked()? {
            *counts.entry(turn.thread_id).or_default() += 1;
        }
        Ok(counts)
    }

    fn list_automation_runs_locked(
        &self,
        automation_id: &str,
    ) -> Result<Vec<AutomationRun>, StoreError> {
        Ok(self
            .all_automation_runs_locked()?
            .into_iter()
            .filter(|run| run.automation_id == automation_id)
            .collect())
    }

    fn has_active_automation_run_locked(&self, automation_id: &str) -> Result<bool, StoreError> {
        // Index lookup: O(active) memory, no history IO on scheduler ticks.
        let index_now = Instant::now();
        let runs = self.active_automation_runs_for_locked(automation_id, index_now)?;
        Ok(runs.iter().any(|run| run.state.is_active()))
    }

    /// Pre-model check against the in-memory turn index for the one thread
    /// this run reserved, instead of counting every Turn in the Home.
    fn is_pre_model_run_locked(&self, run: &AutomationRun) -> Result<bool, StoreError> {
        match run.state {
            AutomationRunState::Claimed => Ok(true),
            AutomationRunState::Materializing | AutomationRunState::Starting => {
                match run.thread_id.as_deref() {
                    None => Ok(true),
                    Some(thread_id) => Ok(self.indexed_turn_count_locked(thread_id)? == 0),
                }
            }
            AutomationRunState::Running
            | AutomationRunState::Succeeded
            | AutomationRunState::Failed
            | AutomationRunState::Interrupted
            | AutomationRunState::Skipped => Ok(false),
        }
    }

    /// Surface the durable executor diagnostic when one exists. It remains
    /// bounded so a provider error cannot make automation/list responses grow
    /// without limit.
    fn terminal_turn_state_locked(
        &self,
        turn: &knorvia_protocol::Turn,
    ) -> Result<(AutomationRunState, Option<String>), StoreError> {
        let (state, fallback) = terminal_turn_state(&turn.status);
        if state != AutomationRunState::Failed {
            return Ok((state, fallback));
        }
        let detail = self
            .list_items_locked(&turn.thread_id)?
            .into_iter()
            .rev()
            .filter(|item| item.turn_id == turn.id && item.kind == "error")
            .find_map(|item| {
                item.payload
                    .get("message")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        item.payload
                            .pointer("/error/message")
                            .and_then(Value::as_str)
                    })
                    .map(|message| message.chars().take(1_000).collect::<String>())
            });
        Ok((state, detail.or(fallback)))
    }
}

fn is_terminal_turn(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "interrupted")
}

/// A durable product Turn is the point at which a retry might duplicate model
/// work. Before that point, a run can be offered again with its original id.
#[allow(dead_code)]
fn is_pre_model_run(run: &AutomationRun, turn_count_by_thread: &HashMap<String, usize>) -> bool {
    match run.state {
        AutomationRunState::Claimed => true,
        AutomationRunState::Materializing | AutomationRunState::Starting => run
            .thread_id
            .as_deref()
            .is_none_or(|thread_id| !turn_count_by_thread.contains_key(thread_id)),
        AutomationRunState::Running
        | AutomationRunState::Succeeded
        | AutomationRunState::Failed
        | AutomationRunState::Interrupted
        | AutomationRunState::Skipped => false,
    }
}

fn terminal_turn_state(status: &str) -> (AutomationRunState, Option<String>) {
    match status {
        "completed" => (AutomationRunState::Succeeded, None),
        "interrupted" => (
            AutomationRunState::Interrupted,
            Some("automation turn was interrupted".into()),
        ),
        "cancelled" => (
            AutomationRunState::Interrupted,
            Some("automation turn was cancelled".into()),
        ),
        other => (
            AutomationRunState::Failed,
            Some(format!("automation turn finished with status {other}")),
        ),
    }
}

#[cfg(test)]
#[path = "automations_tests.rs"]
mod automations_tests;
