//! Durable Goal lifecycle and execution evidence.
use super::*;

impl ProductStore {
    pub fn create_goal(&self, workspace_id: &str, title: &str) -> Result<Goal, StoreError> {
        self.create_goal_with_context(workspace_id, title, GoalUpdate::default())
    }

    pub fn create_goal_with_context(
        &self,
        workspace_id: &str,
        title: &str,
        context: GoalUpdate,
    ) -> Result<Goal, StoreError> {
        if title.trim().is_empty() {
            return Err(invalid("goal title must not be empty"));
        }
        if context.title.is_some() || context.status.is_some() || context.checkpoint {
            return Err(invalid("invalid initial Goal context"));
        }
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let _ = self.read_workspace(workspace_id)?;
        let now = now_rfc3339();
        let g = Goal {
            id: knorvia_protocol::goal_id(),
            workspace_id: workspace_id.to_string(),
            title: title.to_string(),
            status: "active".into(),
            revision: 1,
            created_at: now.clone(),
            updated_at: now,
            success_criteria: context
                .success_criteria
                .filter(|value| !value.trim().is_empty())
                .map(|value| value.trim().to_string()),
            constraints: context.constraints,
            next_action: context.next_action,
            last_checkpoint_at: None,
            completion_evidence: None,
        };
        let write = self.projection_write(ProjectionKind::Goal, &g.id, &g)?;
        self.commit_transaction_locked(
            workspace_id,
            "goal.created",
            serde_json::to_value(&g)?,
            None,
            vec![write],
        )?;
        Ok(g)
    }

    pub fn read_goal(&self, id: &str) -> Result<Goal, StoreError> {
        let path = self.goal_path(id);
        if !path.exists() {
            return Err(not_found("goal", id));
        }
        read_json(&path)
    }

    pub fn list_goals(&self, workspace_id: &str) -> Result<Vec<Goal>, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let _ = self.read_workspace(workspace_id)?;
        let dir = self.product_dir().join("goals");
        let mut goals = Vec::new();
        if dir.exists() {
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let goal: Goal = read_json(&path)?;
                if goal.workspace_id == workspace_id {
                    goals.push(goal);
                }
            }
        }
        goals.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(goals)
    }

    /// Persist one Goal checkpoint or edit. State transitions carry
    /// preconditions (GOA-03): `completed` demands durable success criteria so
    /// a stopped or out-of-budget Goal can never be dressed up as finished,
    /// and terminal states stay terminal for this Goal identity.
    pub fn update_goal(
        &self,
        id: &str,
        update: GoalUpdate,
        expected: Option<u64>,
    ) -> Result<Goal, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut goal = self.read_goal(id)?;
        if matches!(goal.status.as_str(), "completed" | "cancelled") {
            return Err(invalid_or_precondition(
                ErrorCategory::PreconditionFailed,
                "terminal Goal records are immutable",
            ));
        }
        if let Some(exp) = expected {
            if goal.revision != exp {
                return Err(conflict(format!(
                    "goal revision {} != expected {exp}",
                    goal.revision
                )));
            }
        }
        let GoalUpdate {
            title,
            status,
            success_criteria,
            constraints,
            next_action,
            checkpoint,
        } = update;
        if let Some(title) = title {
            goal.title = title;
        }
        if let Some(criteria) = success_criteria {
            let trimmed = criteria.trim();
            if trimmed.is_empty() {
                if goal.status == "completed" {
                    return Err(invalid_or_precondition(
                        ErrorCategory::PreconditionFailed,
                        "a completed goal keeps its recorded successCriteria",
                    ));
                }
                // Blank criteria on a non-terminal goal are a no-op, not a
                // silent erase of what "done" was supposed to mean.
            } else {
                if goal.success_criteria.as_deref() != Some(trimmed) {
                    goal.completion_evidence = None;
                }
                goal.success_criteria = Some(trimmed.to_string());
            }
        }
        if let Some(constraints) = constraints {
            if goal.constraints.as_deref() != Some(&constraints) {
                goal.completion_evidence = None;
            }
            goal.constraints = Some(constraints);
        }
        if let Some(next_action) = next_action {
            goal.next_action = Some(next_action);
        }
        if checkpoint {
            goal.last_checkpoint_at = Some(now_rfc3339());
        }
        if let Some(status) = status {
            let next = normalize_goal_status(&status)?;
            if matches!(goal.status.as_str(), "completed" | "cancelled") {
                return Err(invalid_or_precondition(
                    ErrorCategory::PreconditionFailed,
                    format!(
                        "goal {} is terminal ({}) and cannot move to {next}; open a new goal to continue the work",
                        goal.id, goal.status
                    ),
                ));
            }
            if next == "completed"
                && goal
                    .success_criteria
                    .as_deref()
                    .is_none_or(|c| c.trim().is_empty())
            {
                return Err(invalid_or_precondition(
                    ErrorCategory::PreconditionFailed,
                    "a goal cannot be completed without durable successCriteria",
                ));
            }
            if next == "completed" {
                self.validate_goal_completion_locked(&goal)?;
            }
            goal.status = next;
        }
        if goal.title.trim().is_empty() {
            return Err(invalid("goal title must not be empty"));
        }
        goal.revision += 1;
        goal.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Goal, &goal.id, &goal)?;
        self.commit_transaction_locked(
            &goal.workspace_id,
            "goal.updated",
            serde_json::to_value(&goal)?,
            None,
            vec![write],
        )?;
        Ok(goal)
    }
}
