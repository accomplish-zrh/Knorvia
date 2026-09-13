//! Durable Goal execution batches (R02). A batch is admitted atomically with
//! its Turn projection, so a retried `request_key` can only ever observe the
//! batch it named — never re-execute its tools. Reconciliation reflects only
//! durable Turn facts; it never invents outcomes.
use super::*;
use knorvia_protocol::{GoalExecution, GoalRound};
use serde_json::json;

#[cfg(test)]
impl ProductStore {
    /// Test seam: persist a Goal execution batch in exactly the shape the
    /// durable writer would, with the caller-chosen batch status. Used by
    /// quiescence-gate tests to construct real crash states.
    pub fn insert_goal_execution_fixture(&self, status: &str) -> Result<(), StoreError> {
        let now = now_rfc3339();
        let execution = GoalExecution {
            id: new_id("gex"),
            goal_id: new_id("goal"),
            workspace_id: new_id("ws"),
            thread_id: new_id("thread"),
            request_key: new_id("key"),
            input_digest: "digest".into(),
            input_preview: "fixture".into(),
            status: status.to_string(),
            stop_reason: None,
            attempt: 1,
            rounds: Vec::new(),
            advance: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            terminal_at: None,
        };
        let path = self.goal_execution_path(&execution.id);
        atomic_write(&path, &serde_json::to_vec_pretty(&execution)?)?;
        Ok(())
    }
}

impl ProductStore {
    fn goal_executions_dir(&self) -> std::path::PathBuf {
        self.product_dir().join("goal-executions")
    }

    pub fn read_goal_execution(&self, id: &str) -> Result<GoalExecution, StoreError> {
        let path = self.goal_execution_path(id);
        if !path.exists() {
            return Err(not_found("goal execution", id));
        }
        read_json(&path)
    }

    pub fn find_goal_execution_by_key(
        &self,
        goal_id: &str,
        request_key: &str,
    ) -> Result<Option<GoalExecution>, StoreError> {
        let _mutations = self.lock_mutations()?;
        self.find_execution_locked(|execution| {
            execution.goal_id == goal_id && execution.request_key == request_key
        })
    }

    pub fn find_goal_execution_by_turn(
        &self,
        turn_id: &str,
    ) -> Result<Option<GoalExecution>, StoreError> {
        let _mutations = self.lock_mutations()?;
        self.find_execution_locked(|execution| {
            execution
                .rounds
                .iter()
                .any(|round| round.turn_id == turn_id)
        })
    }

    fn find_execution_locked(
        &self,
        predicate: impl Fn(&GoalExecution) -> bool,
    ) -> Result<Option<GoalExecution>, StoreError> {
        let dir = self.goal_executions_dir();
        if !dir.exists() {
            return Ok(None);
        }
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let execution: GoalExecution = read_json(&path)?;
            if predicate(&execution) {
                return Ok(Some(execution));
            }
        }
        Ok(None)
    }

    /// Whether any Goal batch is still advancing (`status: "running"`),
    /// including a runner sitting between rounds with no live Turn. State
    /// transitions that replace the `state/` directory must treat this as
    /// work in flight (A19 quiescence).
    pub fn has_running_goal_execution(&self) -> Result<bool, StoreError> {
        let _mutations = self.lock_mutations()?;
        self.recover_before_indexed_read()?;
        let dir = self.goal_executions_dir();
        if !dir.exists() {
            return Ok(false);
        }
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let execution: GoalExecution = read_json(&path)?;
            if execution.status == "running" {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Admit one execution batch and its first durable Turn as a single
    /// recoverable unit. There is no window where the Turn exists without
    /// the batch or vice versa.
    #[allow(clippy::too_many_arguments)]
    pub fn start_goal_execution_turn(
        &self,
        goal_id: &str,
        thread_id: &str,
        request_key: &str,
        input_digest: &str,
        input_preview: &str,
        advance: Option<Value>,
    ) -> Result<(GoalExecution, Turn), StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let thread = self.read_thread(thread_id)?;
        if thread.goal_id.as_deref() != Some(goal_id) {
            return Err(invalid("task belongs to another Goal"));
        }
        self.require_active_goal(goal_id, &thread.workspace_id)?;
        let turns = self.indexed_running_turns_locked()?;
        if let Some(goal_id) = thread.goal_id.as_deref() {
            for turn in turns.iter().filter(|turn| turn.status == "running") {
                if self.read_thread(&turn.thread_id)?.goal_id.as_deref() == Some(goal_id) {
                    return Err(conflict("this Goal already has an active Turn"));
                }
            }
        }
        if turns
            .iter()
            .any(|turn| turn.thread_id == thread_id && turn.status == "running")
        {
            return Err(conflict(format!(
                "thread {thread_id} already has a running turn"
            )));
        }
        let turn = Turn {
            id: knorvia_protocol::turn_id(),
            thread_id: thread_id.to_string(),
            status: "running".into(),
            created_at: now_rfc3339(),
            completed_at: None,
        };
        let now = now_rfc3339();
        let execution = GoalExecution {
            id: knorvia_protocol::goal_execution_id(),
            goal_id: goal_id.to_string(),
            workspace_id: thread.workspace_id.clone(),
            thread_id: thread_id.to_string(),
            request_key: request_key.to_string(),
            input_digest: input_digest.to_string(),
            input_preview: input_preview.chars().take(200).collect(),
            status: "running".into(),
            stop_reason: None,
            attempt: 1,
            rounds: vec![GoalRound {
                index: 0,
                turn_id: turn.id.clone(),
                status: "running".into(),
                completed_at: None,
            }],
            advance,
            created_at: now.clone(),
            updated_at: now,
            terminal_at: None,
        };
        let writes = vec![
            self.projection_write(ProjectionKind::Turn, &turn.id, &turn)?,
            self.projection_write(ProjectionKind::GoalExecution, &execution.id, &execution)?,
        ];
        self.commit_transaction_locked(
            thread_id,
            "goalExecution.started",
            json!({"execution": serde_json::to_value(&execution)?, "turn": serde_json::to_value(&turn)?}),
            None,
            writes,
        )?;
        Ok((execution, turn))
    }

    /// Begin the next round of an advancing batch atomically with its Turn.
    /// Caller validates the advance policy; the store enforces turn
    /// exclusivity exactly like admission.
    pub fn begin_goal_execution_round(
        &self,
        execution_id: &str,
    ) -> Result<(GoalExecution, Turn), StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut execution = self.read_goal_execution(execution_id)?;
        if execution.terminal_at.is_some() {
            return Err(conflict("execution batch is already terminal"));
        }
        let thread_id = execution.thread_id.clone();
        let turns = self.indexed_running_turns_locked()?;
        if turns
            .iter()
            .any(|turn| turn.thread_id == thread_id && turn.status == "running")
        {
            return Err(conflict("thread already has a running turn"));
        }
        let turn = Turn {
            id: knorvia_protocol::turn_id(),
            thread_id: thread_id.clone(),
            status: "running".into(),
            created_at: now_rfc3339(),
            completed_at: None,
        };
        let index = execution
            .rounds
            .iter()
            .map(|round| round.index + 1)
            .max()
            .unwrap_or(0);
        execution.rounds.push(GoalRound {
            index,
            turn_id: turn.id.clone(),
            status: "running".into(),
            completed_at: None,
        });
        execution.attempt += 1;
        execution.status = "running".into();
        execution.stop_reason = None;
        execution.updated_at = now_rfc3339();
        let writes = vec![
            self.projection_write(ProjectionKind::Turn, &turn.id, &turn)?,
            self.projection_write(ProjectionKind::GoalExecution, &execution.id, &execution)?,
        ];
        self.commit_transaction_locked(
            &thread_id,
            "goalExecution.roundStarted",
            json!({"execution": serde_json::to_value(&execution)?, "turn": serde_json::to_value(&turn)?}),
            None,
            writes,
        )?;
        Ok((execution, turn))
    }

    /// Runner completion hook: close the round owned by `turn_id` from the
    /// durable Turn terminal. No-op for turns outside any batch.
    pub fn close_goal_round(&self, turn_id: &str, status: &str) -> Result<(), StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let Some(mut execution) = self.find_execution_locked(|execution| {
            execution
                .rounds
                .iter()
                .any(|round| round.turn_id == turn_id)
        })?
        else {
            return Ok(());
        };
        if execution.terminal_at.is_some() {
            return Ok(());
        }
        let policy_advance = execution.advance.is_some();
        if let Some(round) = execution
            .rounds
            .iter_mut()
            .find(|round| round.turn_id == turn_id)
        {
            if round.status == "running" {
                round.status = status.to_string();
                round.completed_at = Some(now_rfc3339());
            }
        }
        // With an advance policy the runner decides whether another round
        // starts; the batch stays running until the policy stops it.
        if !policy_advance {
            execution.status = status.to_string();
            execution.stop_reason = Some(match status {
                "completed" => "completed".to_string(),
                other => other.to_string(),
            });
            execution.terminal_at = Some(now_rfc3339());
        }
        execution.updated_at = now_rfc3339();
        self.persist_goal_execution_locked(&execution, "goalExecution.roundClosed")?;
        Ok(())
    }

    /// Explicitly stop a batch from the control plane (budget, deadline,
    /// waiting-for-user, cancellation). The reason is recorded verbatim.
    pub fn stop_goal_execution(
        &self,
        execution_id: &str,
        status: &str,
        stop_reason: &str,
    ) -> Result<GoalExecution, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut execution = self.read_goal_execution(execution_id)?;
        if execution.terminal_at.is_some() {
            return Ok(execution);
        }
        execution.status = status.to_string();
        execution.stop_reason = Some(stop_reason.to_string());
        execution.terminal_at = Some(now_rfc3339());
        execution.updated_at = now_rfc3339();
        self.persist_goal_execution_locked(&execution, "goalExecution.stopped")?;
        Ok(execution)
    }

    /// Reconcile a batch from durable Turn facts. Only a crash between the
    /// Turn terminal and the runner's round close lands here; recovery
    /// already turned orphan `running` Turns into `interrupted`.
    pub fn reconcile_goal_execution(
        &self,
        execution: GoalExecution,
        runner_alive: bool,
    ) -> Result<GoalExecution, StoreError> {
        if execution.terminal_at.is_some() || runner_alive {
            // A live runner closes its own rounds; reconciliation must not
            // declare an advancing batch lost while it is between rounds.
            return Ok(execution);
        }
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut execution = execution;
        let mut closed_by_reconcile = false;
        for round in execution.rounds.iter_mut() {
            if round.status != "running" {
                continue;
            }
            let turn = match self.read_turn(&round.turn_id) {
                Ok(turn) => turn,
                Err(_) => {
                    // The Turn projection is the durable fact; without it we
                    // fail closed instead of inventing an outcome.
                    execution.status = "failed".into();
                    execution.stop_reason = Some("turnRecordMissing".into());
                    execution.terminal_at = Some(now_rfc3339());
                    execution.updated_at = now_rfc3339();
                    return self
                        .persist_goal_execution_locked(&execution, "goalExecution.reconciled");
                }
            };
            if turn.status == "running" {
                continue;
            }
            round.status = turn.status.clone();
            round.completed_at = turn.completed_at.clone();
            closed_by_reconcile = true;
        }
        if !closed_by_reconcile {
            // Every round already carries its durable terminal while the
            // batch is still open and no runner owns it: the owner exited
            // between rounds (or crashed after closing the last one).
            // Reconciliation only maps rounds that never reached their
            // terminal, so without this close the batch stays running
            // forever. A round whose Turn is still running is genuine
            // in-flight work and must not be closed here.
            if execution.rounds.iter().any(|round| round.status == "running") {
                return Ok(execution);
            }
            let last = execution.rounds.last().cloned();
            let policy_advance = execution.advance.is_some();
            match last.map(|round| round.status) {
                Some(round_status) if !policy_advance => {
                    execution.status = round_status.clone();
                    execution.stop_reason = Some(round_status);
                }
                // The advance policy still had work left and nobody owns the
                // batch anymore: interrupted, never completed.
                _ => {
                    execution.status = "interrupted".into();
                    execution.stop_reason = Some("runnerLost".into());
                }
            }
            execution.terminal_at = Some(now_rfc3339());
            execution.updated_at = now_rfc3339();
            return self.persist_goal_execution_locked(&execution, "goalExecution.reconciled");
        }
        let last = execution.rounds.last().cloned();
        let policy_advance = execution.advance.is_some();
        match last.map(|round| round.status) {
            Some(round_status) if !policy_advance => {
                execution.status = round_status.clone();
                execution.stop_reason = Some(round_status);
            }
            // The advance policy still had work left and nobody owns the
            // batch anymore: interrupted, never completed.
            _ => {
                execution.status = "interrupted".into();
                execution.stop_reason = Some("runnerLost".into());
            }
        }
        execution.terminal_at = Some(now_rfc3339());
        execution.updated_at = now_rfc3339();
        self.persist_goal_execution_locked(&execution, "goalExecution.reconciled")
    }

    fn persist_goal_execution_locked(
        &self,
        execution: &GoalExecution,
        event_kind: &str,
    ) -> Result<GoalExecution, StoreError> {
        let write =
            self.projection_write(ProjectionKind::GoalExecution, &execution.id, execution)?;
        self.commit_transaction_locked(
            &execution.thread_id,
            event_kind,
            serde_json::to_value(execution)?,
            None,
            vec![write],
        )?;
        Ok(execution.clone())
    }
}

#[cfg(test)]
mod quiescence_tests {
    use super::*;
    use knorvia_platform_paths::layout;

    fn tmp_store() -> (ProductStore, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "knorvia-goal-quiescence-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&base).unwrap();
        (ProductStore::open(layout(base.clone())).unwrap(), base)
    }

    #[test]
    fn quiescence_query_detects_a_running_goal_batch() {
        let (store, home) = tmp_store();
        assert!(!store.has_running_goal_execution().unwrap());
        store.insert_goal_execution_fixture("running").unwrap();
        assert!(
            store.has_running_goal_execution().unwrap(),
            "a running batch may have a runner between rounds; state swaps must refuse"
        );
        store.insert_goal_execution_fixture("completed").unwrap();
        assert!(
            store.has_running_goal_execution().unwrap(),
            "terminal batches do not clear an active one"
        );
        let _ = fs::remove_dir_all(home);
    }
}
