//! Evidence references are checked under the same mutation lock as completion.
use super::*;
use knorvia_protocol::GoalCompletionEvidence;
use serde_json::json;

impl ProductStore {
    pub(crate) fn require_active_goal(
        &self,
        id: &str,
        workspace_id: &str,
    ) -> Result<Goal, StoreError> {
        let goal = self.read_goal(id)?;
        if goal.workspace_id != workspace_id {
            return Err(invalid("Goal belongs to a different workspace"));
        }
        if goal.status != "active" {
            return Err(invalid_or_precondition(
                ErrorCategory::PreconditionFailed,
                "resume an active Goal before starting work",
            ));
        }
        Ok(goal)
    }

    fn goal_threads_locked(&self, goal: &Goal) -> Result<Vec<(Thread, Option<Turn>)>, StoreError> {
        let turns = self.list_turns_locked()?;
        Ok(self
            .list_threads_locked(&goal.workspace_id)?
            .into_iter()
            .filter(|thread| thread.goal_id.as_deref() == Some(&goal.id))
            .map(|thread| {
                let latest = turns
                    .iter()
                    .rev()
                    .find(|turn| turn.thread_id == thread.id)
                    .cloned();
                (thread, latest)
            })
            .collect())
    }

    fn validate_evidence_locked(
        &self,
        goal: &Goal,
        turn_id: &str,
        item_id: &str,
    ) -> Result<(), StoreError> {
        let turn = self.read_turn(turn_id)?;
        let thread = self.read_thread(&turn.thread_id)?;
        if thread.goal_id.as_deref() != Some(&goal.id) || thread.workspace_id != goal.workspace_id {
            return Err(invalid(
                "acceptance evidence must come from this Goal's linked task",
            ));
        }
        if turn.status != "completed" {
            return Err(invalid_or_precondition(
                ErrorCategory::PreconditionFailed,
                "acceptance needs a durably completed Turn",
            ));
        }
        let found = self.list_items_locked(&thread.id)?.into_iter().any(|item| {
            item.id == item_id
                && item.turn_id == turn.id
                && item.status == "completed"
                && matches!(
                    item.kind.as_str(),
                    "agentMessage" | "commandExecution" | "toolResult" | "artifact"
                )
        });
        if !found {
            return Err(invalid(
                "acceptance must reference a completed output Item, not a prompt or approval",
            ));
        }
        Ok(())
    }

    pub fn record_goal_evidence(
        &self,
        id: &str,
        expected: u64,
        turn_id: &str,
        item_id: &str,
        summary: &str,
    ) -> Result<Goal, StoreError> {
        if summary.trim().is_empty() {
            return Err(invalid("acceptance summary is required"));
        }
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut goal = self.read_goal(id)?;
        if goal.revision != expected {
            return Err(conflict(
                "Goal changed; refresh before recording acceptance",
            ));
        }
        if matches!(goal.status.as_str(), "completed" | "cancelled") {
            return Err(invalid_or_precondition(
                ErrorCategory::PreconditionFailed,
                "terminal Goal records are immutable",
            ));
        }
        let criteria = goal
            .success_criteria
            .as_ref()
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| invalid("record successCriteria before acceptance"))?
            .clone();
        self.validate_evidence_locked(&goal, turn_id, item_id)?;
        goal.completion_evidence = Some(GoalCompletionEvidence {
            criteria,
            summary: summary.trim().to_string(),
            turn_id: turn_id.into(),
            item_id: item_id.into(),
            recorded_at: now_rfc3339(),
        });
        goal.revision += 1;
        goal.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Goal, id, &goal)?;
        self.commit_transaction_locked(
            &goal.workspace_id,
            "goal.acceptanceRecorded",
            serde_json::to_value(&goal)?,
            None,
            vec![write],
        )?;
        Ok(goal)
    }

    pub(crate) fn validate_goal_completion_locked(&self, goal: &Goal) -> Result<(), StoreError> {
        let evidence = goal.completion_evidence.as_ref().ok_or_else(|| {
            invalid_or_precondition(
                ErrorCategory::PreconditionFailed,
                "record acceptance with a completed task output before marking the Goal done",
            )
        })?;
        if goal.success_criteria.as_deref() != Some(evidence.criteria.as_str()) {
            return Err(invalid_or_precondition(
                ErrorCategory::PreconditionFailed,
                "acceptance refers to outdated criteria",
            ));
        }
        self.validate_evidence_locked(goal, &evidence.turn_id, &evidence.item_id)?;
        let threads = self.goal_threads_locked(goal)?;
        if threads.is_empty()
            || threads.iter().any(|(_, latest)| {
                latest
                    .as_ref()
                    .is_none_or(|turn| turn.status != "completed")
            })
        {
            return Err(invalid_or_precondition(
                ErrorCategory::PreconditionFailed,
                "all linked tasks must have a completed latest Turn",
            ));
        }
        for task in self
            .list_tasks(&goal.workspace_id)?
            .into_iter()
            .filter(|task| task.goal_id.as_deref() == Some(&goal.id))
        {
            if !matches!(task.status.as_str(), "done" | "cancelled")
                && !threads
                    .iter()
                    .any(|(thread, _)| thread.task_id.as_deref() == Some(&task.id))
            {
                return Err(invalid_or_precondition(
                    ErrorCategory::PreconditionFailed,
                    "a planned task still has no completed execution",
                ));
            }
        }
        Ok(())
    }

    pub fn goal_execution(&self, id: &str) -> Result<Value, StoreError> {
        let _mutations = self.lock_mutations()?;
        let goal = self.read_goal(id)?;
        let threads = self.goal_threads_locked(&goal)?;
        let completed = threads
            .iter()
            .filter(|(_, turn)| turn.as_ref().is_some_and(|turn| turn.status == "completed"))
            .count();
        let running = threads
            .iter()
            .filter(|(_, turn)| turn.as_ref().is_some_and(|turn| turn.status == "running"))
            .count();
        let blocked = self
            .validate_goal_completion_locked(&goal)
            .err()
            .map(|error| error.into_protocol().message);
        Ok(json!({
            "total":threads.len(), "completed":completed, "running":running,
            "readyToComplete":blocked.is_none(), "completionBlockedReason":blocked,
            "threads":threads.into_iter().map(|(thread, last_turn)| json!({"thread":thread,"lastTurn":last_turn})).collect::<Vec<_>>(),
        }))
    }
}
