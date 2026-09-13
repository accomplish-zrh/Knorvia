//! Durable Goal lifecycle and execution evidence.
use super::*;

impl ControlPlane {
    pub(crate) fn rpc_goal_create(&self, params: &Value) -> Result<Value, ProtocolError> {
        let ws = required_str(params, "workspaceId")?;
        let title = required_str(params, "title")?;
        let initial = GoalUpdate {
            success_criteria: optional_string(params, "successCriteria")?,
            constraints: optional_string(params, "constraints")?,
            next_action: optional_string(params, "nextAction")?,
            ..GoalUpdate::default()
        };
        let goal = self
            .store
            .create_goal_with_context(ws, title, initial)
            .map_err(|error| error.into_protocol())?;
        serde_json::to_value(goal).map_err(json_err)
    }

    /// `goal/read` returns the durable Goal plus its task roll-up, so callers
    /// reconcile progress from persisted objects instead of the last reply.
    pub(crate) fn rpc_goal_read(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "id")?;
        let goal = self.store.read_goal(id).map_err(|e| e.into_protocol())?;
        let execution = self
            .store
            .goal_execution(id)
            .map_err(|error| error.into_protocol())?;
        let tasks: Vec<_> = self
            .store
            .list_tasks(&goal.workspace_id)
            .map_err(|e| e.into_protocol())?
            .into_iter()
            .filter(|task| task.goal_id.as_deref() == Some(id))
            .collect();
        let total = tasks.len();
        let closed = tasks
            .iter()
            .filter(|task| matches!(task.status.as_str(), "done" | "cancelled"))
            .count();
        serde_json::to_value(goal)
            .map_err(json_err)
            .map(|mut value| {
                if let Some(object) = value.as_object_mut() {
                    object.insert("execution".into(), execution);
                    object.insert(
                        "tasks".into(),
                        json!({
                            "total": total,
                            "closed": closed,
                            "items": tasks,
                        }),
                    );
                }
                value
            })
    }

    pub(crate) fn rpc_goal_list(&self, params: &Value) -> Result<Value, ProtocolError> {
        let ws = required_str(params, "workspaceId")?;
        let goals = self.store.list_goals(ws).map_err(|e| e.into_protocol())?;
        Ok(json!({ "goals": goals }))
    }

    /// Durable Goal edit/checkpoint. `revision`/`expectedRevision` guards
    /// concurrent edits the same way workspace/update does.
    pub(crate) fn rpc_goal_update(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "id")?;
        let update = GoalUpdate {
            title: optional_string(params, "title")?,
            status: optional_string(params, "status")?,
            success_criteria: optional_string(params, "successCriteria")?,
            constraints: optional_string(params, "constraints")?,
            next_action: optional_string(params, "nextAction")?,
            checkpoint: params
                .get("checkpoint")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        let expected = expected_revision(params)?;
        let goal = self
            .store
            .update_goal(&id, update, expected)
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(goal).map_err(json_err)
    }

    pub(crate) fn rpc_goal_evidence(&self, params: &Value) -> Result<Value, ProtocolError> {
        let goal = self
            .store
            .record_goal_evidence(
                required_str(params, "id")?,
                required_revision(params)?,
                required_str(params, "turnId")?,
                required_str(params, "itemId")?,
                required_str(params, "summary")?,
            )
            .map_err(|error| error.into_protocol())?;
        serde_json::to_value(goal).map_err(json_err)
    }

    pub(crate) fn rpc_goal_run(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        self.ensure_accepting_work()?;
        let id = required_str(params, "id")?;
        let goal = self
            .store
            .read_goal(id)
            .map_err(|error| error.into_protocol())?;
        // The request identity covers only caller-visible fields. An omitted
        // input stays "omitted" forever: the Goal's (mutable) nextAction must
        // never turn a faithful replay into a different request, and the
        // replay lookup below must not depend on any mutable Goal state.
        let explicit_input = optional_string(params, "input")?;
        // Idempotent admission: a caller-supplied requestKey names exactly one
        // execution batch. Unkeyed calls keep the legacy one-call-one-turn
        // behavior with an auto-generated, non-retryable key.
        let request_key = match optional_string(params, "requestKey")? {
            Some(key) => key,
            None => knorvia_protocol::goal_execution_id(),
        };
        let thread_override = optional_string(params, "threadId")?;
        let advance = validate_advance_policy(params.get("advance"))?;
        let write = params
            .pointer("/tools/write")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let digest = execution_input_digest(
            explicit_input.as_deref(),
            &thread_override,
            advance.as_ref(),
            write,
            params,
        );

        // Keyed replay comes BEFORE any revision/status admission check: the
        // caller may only have the original request (original revision) after
        // a lost reply, and a checkpointed or paused Goal must still answer
        // "here is the batch you already admitted" without side effects.
        if let Some(existing) = self
            .store
            .find_goal_execution_by_key(&goal.id, &request_key)
            .map_err(|error| error.into_protocol())?
        {
            if existing.input_digest != digest {
                return Err(ProtocolError::new(
                    ErrorCategory::Conflict,
                    "requestKey was already admitted with different parameters",
                ));
            }
            let runner_alive = existing.rounds.last().is_some_and(|round| {
                self.executor_lock()
                    .has_live_turn(&existing.thread_id, &round.turn_id)
            });
            let execution = self
                .store
                .reconcile_goal_execution(existing, runner_alive)
                .map_err(|error| error.into_protocol())?;
            return self.goal_batch_snapshot(&goal, execution, true, None);
        }

        // Fresh admission only. The action resolves here - after the keyed
        // replay returned - so a known key never depends on the mutable
        // nextAction (cleared, changed, or whitespace) to answer its batch.
        let action = explicit_input
            .clone()
            .or_else(|| goal.next_action.clone())
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "record a nextAction or supply input before running a Goal",
                )
            })?;
        // Revision and status guards apply from here. A policy whose deadline
        // already passed must admit zero rounds and take zero side effects.
        if let Some(policy) = &advance {
            let now_ms = knorvia_store::epoch_millis();
            if let Some(deadline_ms) = policy.get("deadlineMs").and_then(Value::as_u64)
                && now_ms >= i64::try_from(deadline_ms).unwrap_or(i64::MAX)
            {
                return Err(ProtocolError::new(
                    ErrorCategory::DeadlineExceeded,
                    "advance.deadlineMs already passed; no round was admitted",
                ));
            }
        }
        if goal.revision != required_revision(params)? {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "Goal changed; refresh before starting its next action",
            ));
        }
        if goal.status != "active"
            || goal
                .success_criteria
                .as_deref()
                .is_none_or(|text| text.trim().is_empty())
        {
            return Err(ProtocolError::new(
                ErrorCategory::PreconditionFailed,
                "an active Goal with successCriteria is required",
            ));
        }

        let mut settings = params.clone();
        settings["workspaceId"] = json!(goal.workspace_id);
        settings["goalId"] = json!(goal.id);
        settings["title"] = json!(action);
        let thread_id = if let Some(thread_id) = &thread_override {
            let thread = self
                .store
                .read_thread(thread_id)
                .map_err(|error| error.into_protocol())?;
            if thread.goal_id.as_deref() != Some(id) {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "task belongs to another Goal",
                ));
            }
            thread_id.clone()
        } else {
            self.rpc_thread_start(&settings)?["id"]
                .as_str()
                .ok_or_else(|| {
                    ProtocolError::new(ErrorCategory::Internal, "created task has no id")
                })?
                .to_string()
        };
        settings["threadId"] = json!(thread_id);
        self.ensure_message_queue_order(&thread_id)?;
        settings["input"] = json!(format!(
            "Goal: {}\nAcceptance criteria: {}\nStanding constraints: {}\n\nNext action: {}",
            goal.title,
            goal.success_criteria.as_deref().unwrap_or(""),
            goal.constraints.as_deref().unwrap_or(""),
            action
        ));
        let input_text = settings["input"].as_str().unwrap_or_default().to_string();
        let (settings, write) = self.prepare_turn_execution(&thread_id, &settings)?;
        let (execution, turn) = self
            .store
            .start_goal_execution_turn(
                &goal.id,
                &thread_id,
                &request_key,
                &digest,
                &action,
                advance.clone(),
            )
            .map_err(|error| error.into_protocol())?;
        self.execute_admitted_turn(&thread_id, turn, input_text, settings, write, advance)?;
        // The checkpoint write is no longer the admission record — the batch
        // is. A checkpoint failure is reported instead of silently losing the
        // caller's only reference to a running Turn.
        let mut checkpoint_error = None;
        let goal_now = match self.store.update_goal(
            id,
            GoalUpdate {
                checkpoint: true,
                ..GoalUpdate::default()
            },
            Some(goal.revision),
        ) {
            Ok(updated) => updated,
            Err(error) => {
                checkpoint_error = Some(error.into_protocol().message);
                goal
            }
        };
        self.goal_batch_snapshot(&goal_now, execution, false, checkpoint_error)
    }

    /// Idempotent batch query: reconnecting callers reconcile progress from
    /// durable facts instead of the (possibly lost) admission reply.
    pub(crate) fn rpc_goal_run_read(&self, params: &Value) -> Result<Value, ProtocolError> {
        let execution = if let Some(execution_id) = optional_string(params, "executionId")? {
            self.store
                .read_goal_execution(&execution_id)
                .map_err(|error| error.into_protocol())?
        } else {
            let goal_id = required_str(params, "goalId")?;
            let request_key = required_str(params, "requestKey")?;
            self.store
                .find_goal_execution_by_key(&goal_id, &request_key)
                .map_err(|error| error.into_protocol())?
                .ok_or_else(|| {
                    ProtocolError::new(
                        ErrorCategory::NotFound,
                        "no execution batch for this requestKey",
                    )
                })?
        };
        let runner_alive = execution.rounds.last().is_some_and(|round| {
            self.executor_lock()
                .has_live_turn(&execution.thread_id, &round.turn_id)
        });
        let execution = self
            .store
            .reconcile_goal_execution(execution, runner_alive)
            .map_err(|error| error.into_protocol())?;
        let goal = self
            .store
            .read_goal(&execution.goal_id)
            .map_err(|error| error.into_protocol())?;
        self.goal_batch_snapshot(&goal, execution, true, None)
    }

    /// Snapshot of one execution batch with its latest durable Turn state.
    fn goal_batch_snapshot(
        &self,
        goal: &knorvia_protocol::Goal,
        execution: knorvia_protocol::GoalExecution,
        resumed: bool,
        checkpoint_error: Option<String>,
    ) -> Result<Value, ProtocolError> {
        // The batch may have reached its terminal fact while the turn ran
        // (synchronous executors, fast failures): reflect durable state.
        let execution = self
            .store
            .read_goal_execution(&execution.id)
            .map_err(|error| error.into_protocol())
            .and_then(|fresh| {
                let runner_alive = fresh.rounds.last().is_some_and(|round| {
                    self.executor_lock()
                        .has_live_turn(&fresh.thread_id, &round.turn_id)
                });
                self.store
                    .reconcile_goal_execution(fresh, runner_alive)
                    .map_err(|e| e.into_protocol())
            })?;
        let latest_turn = execution.rounds.last().map(|round| round.turn_id.clone());
        let turn = match latest_turn {
            Some(turn_id) => self.rpc_turn_read(&json!({"id": turn_id}))?,
            None => Value::Null,
        };
        let pending = turn
            .get("pendingApprovals")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .map(|approval| approval["id"].clone());
        let mut snapshot = json!({
            "goalId": goal.id,
            "goalRevision": goal.revision,
            "threadId": execution.thread_id,
            "execution": execution,
            "turn": turn,
            "pendingApprovalId": pending,
            "resumed": resumed,
        });
        if let Some(error) = checkpoint_error {
            snapshot["checkpointError"] = json!(error);
        }
        Ok(snapshot)
    }
}

/// Canonical digest of the caller-visible request fields. `input` is the
/// raw parameter (null = omitted), never the nextAction-derived action: a
/// replay of the original request must stay the same request even after the
/// Goal's mutable checkpoint text moved on. The resolved action is recorded
/// on the batch (input preview / turn input) as admission-time fact.
fn execution_input_digest(
    input: Option<&str>,
    thread_override: &Option<String>,
    advance: Option<&Value>,
    write: bool,
    params: &Value,
) -> String {
    // Every raw caller field that prepare_turn_execution would apply to the
    // Kernel request participates in the identity. Present-vs-absent is
    // preserved (absent keys stay absent; an explicit null reset stays null).
    let mut execution = serde_json::Map::new();
    for key in [
        "cwd",
        "model",
        "reasoningEffort",
        "serviceTier",
        "collaborationMode",
    ] {
        if let Some(value) = params.get(key) {
            execution.insert(key.to_string(), value.clone());
        }
    }
    let payload = json!({
        "input": input,
        "threadId": thread_override,
        "advance": advance,
        "write": write,
        "execution": execution,
    });
    let mut digest = Sha256::new();
    digest.update(payload.to_string().as_bytes());
    hex::encode(digest.finalize())
}

/// Structured continuous-advance policy. Explicitly opt-in; absent means the
/// batch stops after its first round. Unknown fields are rejected so a
/// caller can never assume a policy this build does not enforce.
fn validate_advance_policy(value: Option<&Value>) -> Result<Option<Value>, ProtocolError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Some(object) = value.as_object() else {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "advance must be an object policy",
        ));
    };
    for key in object.keys() {
        if !matches!(key.as_str(), "maxRounds" | "deadlineMs") {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                format!("unknown advance policy field: {key}"),
            ));
        }
    }
    if let Some(max_rounds) = object.get("maxRounds")
        && !max_rounds.is_u64()
    {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "advance.maxRounds must be a positive integer",
        ));
    }
    if let Some(deadline) = object.get("deadlineMs")
        && !deadline.is_u64()
    {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "advance.deadlineMs must be a UTC epoch millisecond integer",
        ));
    }
    Ok(Some(value.clone()))
}

fn optional_string(params: &Value, key: &str) -> Result<Option<String>, ProtocolError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must be a string"),
        )),
    }
}

fn expected_revision(params: &Value) -> Result<Option<u64>, ProtocolError> {
    let parse = |key: &str| match params.get(key) {
        None => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|revision| *revision > 0)
            .map(Some)
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    format!("{key} must be a positive revision"),
                )
            }),
    };
    let first = parse("revision")?;
    let second = parse("expectedRevision")?;
    if first.is_some() && second.is_some() && first != second {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "revision aliases disagree",
        ));
    }
    Ok(first.or(second))
}

fn required_revision(params: &Value) -> Result<u64, ProtocolError> {
    expected_revision(params)?
        .ok_or_else(|| ProtocolError::new(ErrorCategory::InvalidArgument, "revision is required"))
}

#[cfg(test)]
mod goal_run_tests {
    use super::*;

    fn init(p: &mut ControlPlane) {
        let req = json!({
            "jsonrpc": "2.0",
            "id": "req_01",
            "method": "initialize",
            "params": {
                "protocol": {"major": 1, "minor": 0},
                "client": {"name": "knorvia_test", "version": "0.0.1", "platform": "windows"},
                "capabilities": ["thread", "artifact", "job", "approval", "reconnect"]
            }
        });
        let resp: Value =
            serde_json::from_str(&p.handle_json(&req.to_string()).unwrap().unwrap()).unwrap();
        assert!(resp.get("error").is_none(), "{resp}");
        let note = json!({"jsonrpc":"2.0","method":"initialized"});
        assert!(p.handle_json(&note.to_string()).unwrap().is_none());
    }

    fn plane_with_one_completed_turn() -> ControlPlane {
        // Mirrors the harness in control/src/lib.rs tests: one scripted
        // read-only outcome completes synchronously through the executor
        // contract (items + durable terminal).
        let base = std::env::temp_dir().join(format!(
            "knorvia-goalctl-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let outcomes = vec![Ok(TurnOutcome {
            status: "completed".into(),
            items: vec![TurnItem {
                kind: "agentMessage".into(),
                payload: json!({"text": "goal output"}),
            }],
            error: None,
        })];
        ControlPlane::open_with_executor(
            knorvia_platform_paths::layout(base),
            Box::new(crate::tests::Scripted { outcomes }),
        )
        .unwrap()
    }

    fn mk(id: &str, method: &str, params: Value) -> String {
        json!({"jsonrpc":"2.0","id": id, "method": method, "params": params}).to_string()
    }

    fn parse(s: String) -> Value {
        serde_json::from_str(&s).unwrap()
    }

    fn setup_goal(p: &mut ControlPlane) -> String {
        init(p);
        let ws = parse(
            p.handle_json(&mk("w", "workspace/create", json!({"title": "goal ws"})))
                .unwrap()
                .unwrap(),
        );
        assert!(ws.get("error").is_none(), "workspace/create failed: {ws}");
        let ws_id = ws["result"]["id"].as_str().unwrap().to_string();
        let goal = parse(
            p.handle_json(&mk(
                "g",
                "goal/create",
                json!({
                    "workspaceId": ws_id,
                    "title": "night goal",
                    "successCriteria": "output exists"
                }),
            ))
            .unwrap()
            .unwrap(),
        );
        goal["result"]["id"].as_str().unwrap().to_string()
    }

    #[test]
    fn retry_with_same_key_returns_the_same_batch_without_reexecution() {
        let mut p = plane_with_one_completed_turn();
        let goal_id = setup_goal(&mut p);
        let first = parse(
            p.handle_json(&mk(
                "r1",
                "goal/run",
                json!({"id": goal_id, "revision": 1, "requestKey": "rk-1", "input": "do it"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(first.get("error").is_none(), "{first}");
        let execution = first["result"]["execution"].clone();
        assert_eq!(execution["status"], "completed");
        assert_eq!(first["result"]["turn"]["status"], "completed");
        assert_eq!(first["result"]["resumed"], false);
        let revision = first["result"]["goalRevision"].as_u64().unwrap();

        // The reply is "lost"; the caller replays the same key with the
        // current goal revision. The same batch comes back — one turn, no
        // re-executed tools.
        let retry = parse(
            p.handle_json(&mk(
                "r2",
                "goal/run",
                json!({"id": goal_id, "revision": revision, "requestKey": "rk-1", "input": "do it"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(retry.get("error").is_none(), "{retry}");
        assert_eq!(retry["result"]["resumed"], true);
        assert_eq!(retry["result"]["execution"]["id"], execution["id"]);
        assert_eq!(
            retry["result"]["execution"]["rounds"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(retry["result"]["execution"]["status"], "completed");
    }

    #[test]
    fn original_request_with_original_revision_replays_the_batch() {
        let mut p = plane_with_one_completed_turn();
        let goal_id = setup_goal(&mut p);
        let first = parse(
            p.handle_json(&mk(
                "r1",
                "goal/run",
                json!({"id": goal_id, "revision": 1, "requestKey": "rk-o", "input": "do it"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(first.get("error").is_none(), "{first}");
        let execution_id = first["result"]["execution"]["id"].clone();
        // The caller lost the first reply and replays the ORIGINAL request,
        // original revision included. The checkpoint bumped the Goal
        // revision meanwhile - that must not turn a retry into a conflict.
        let replay = parse(
            p.handle_json(&mk(
                "r2",
                "goal/run",
                json!({"id": goal_id, "revision": 1, "requestKey": "rk-o", "input": "do it"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(
            replay.get("error").is_none(),
            "stale-revision replay: {replay}"
        );
        assert_eq!(replay["result"]["resumed"], true);
        assert_eq!(replay["result"]["execution"]["id"], execution_id);
        assert_eq!(
            replay["result"]["execution"]["rounds"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        // A Goal paused (or otherwise updated) after admission changes no
        // replay answer either: the batch query is side-effect free.
        let pause = parse(
            p.handle_json(&mk(
                "u",
                "goal/update",
                json!({"id": goal_id, "status": "paused",
                       "revision": replay["result"]["goalRevision"].as_u64().unwrap()}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(pause.get("error").is_none(), "{pause}");
        let replay_paused = parse(
            p.handle_json(&mk(
                "r3",
                "goal/run",
                json!({"id": goal_id, "revision": 1, "requestKey": "rk-o", "input": "do it"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(replay_paused.get("error").is_none(), "{replay_paused}");
        assert_eq!(replay_paused["result"]["execution"]["id"], execution_id);
        // A NEW admission on the paused Goal is still refused.
        let fresh = parse(
            p.handle_json(&mk(
                "r4",
                "goal/run",
                json!({"id": goal_id,
                       "revision": replay["result"]["goalRevision"].as_u64().unwrap() + 1,
                       "requestKey": "rk-fresh", "input": "do it again"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            fresh["error"]["data"]["category"],
            json!(ErrorCategory::PreconditionFailed)
                .as_str()
                .unwrap_or("PRECONDITION_FAILED")
        );
    }

    #[test]
    fn replay_with_omitted_input_survives_next_action_change() {
        let mut p = plane_with_one_completed_turn();
        init(&mut p);
        let ws = parse(
            p.handle_json(&mk("w", "workspace/create", json!({"title": "goal ws"})))
                .unwrap()
                .unwrap(),
        );
        let ws_id = ws["result"]["id"].as_str().unwrap().to_string();
        // nextAction only: the request omits input, so the effective action
        // is whatever nextAction holds at call time.
        let goal = parse(
            p.handle_json(&mk(
                "g",
                "goal/create",
                json!({
                    "workspaceId": ws_id,
                    "title": "advancing goal",
                    "successCriteria": "done means done",
                    "nextAction": "first action"
                }),
            ))
            .unwrap()
            .unwrap(),
        );
        let goal_id = goal["result"]["id"].as_str().unwrap().to_string();
        let first = parse(
            p.handle_json(&mk(
                "r1",
                "goal/run",
                json!({"id": goal_id, "revision": 1, "requestKey": "rk-n"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(first.get("error").is_none(), "{first}");
        let revision = first["result"]["goalRevision"].as_u64().unwrap();
        // The Goal's nextAction moves on after the lost reply.
        let updated = parse(
            p.handle_json(&mk(
                "u",
                "goal/update",
                json!({"id": goal_id, "revision": revision, "checkpoint": true,
                       "nextAction": "a completely different action"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(updated.get("error").is_none(), "{updated}");
        // The same original request (input omitted) is still the same
        // request: it returns the original batch instead of re-deriving a
        // different action from the moved nextAction.
        let replay = parse(
            p.handle_json(&mk(
                "r2",
                "goal/run",
                json!({"id": goal_id, "revision": revision + 1, "requestKey": "rk-n"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(replay.get("error").is_none(), "{replay}");
        assert_eq!(replay["result"]["resumed"], true);
        assert_eq!(
            replay["result"]["execution"]["id"],
            first["result"]["execution"]["id"]
        );
        // Making the input explicit IS a caller-visible change: typed
        // conflict, never a silent new admission under the same key.
        let explicit = parse(
            p.handle_json(&mk(
                "r3",
                "goal/run",
                json!({"id": goal_id, "revision": revision + 1, "requestKey": "rk-n",
                       "input": "first action"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            explicit["error"]["data"]["category"],
            json!(ErrorCategory::Conflict)
                .as_str()
                .unwrap_or("CONFLICT")
        );
    }

    #[test]
    fn known_key_replays_even_after_its_deadline_has_passed() {
        let mut p = plane_with_one_completed_turn();
        let goal_id = setup_goal(&mut p);
        let deadline = knorvia_store::epoch_millis() + 2000;
        let first = parse(
            p.handle_json(&mk(
                "r1",
                "goal/run",
                json!({"id": goal_id, "revision": 1, "requestKey": "rk-exp",
                       "input": "do it", "advance": {"maxRounds": 1, "deadlineMs": deadline}}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(first.get("error").is_none(), "{first}");
        // Let the budget expire before the replay arrives.
        std::thread::sleep(Duration::from_millis(2100));
        let replay = parse(
            p.handle_json(&mk(
                "r2",
                "goal/run",
                json!({"id": goal_id, "revision": first["result"]["goalRevision"].as_u64().unwrap(),
                       "requestKey": "rk-exp", "input": "do it",
                       "advance": {"maxRounds": 1, "deadlineMs": deadline}}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(
            replay.get("error").is_none(),
            "expired deadline must not refuse a replay: {replay}"
        );
        assert_eq!(replay["result"]["resumed"], true);
    }

    #[test]
    fn execution_parameter_changes_are_typed_conflicts() {
        let mut p = plane_with_one_completed_turn();
        let goal_id = setup_goal(&mut p);
        let first = parse(
            p.handle_json(&mk(
                "r1",
                "goal/run",
                json!({"id": goal_id, "revision": 1, "requestKey": "rk-exec",
                       "input": "do it", "model": "GPT-5.6-Terra"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(first.get("error").is_none(), "{first}");
        let revision = first["result"]["goalRevision"].as_u64().unwrap();
        // Changing any execution-affecting caller field under the same key is
        // a conflict: model...
        let model = parse(
            p.handle_json(&mk(
                "m",
                "goal/run",
                json!({"id": goal_id, "revision": revision, "requestKey": "rk-exec",
                       "input": "do it", "model": "GPT-5.5"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            model["error"]["data"]["category"],
            json!(ErrorCategory::Conflict)
                .as_str()
                .unwrap_or("CONFLICT")
        );
        // ...cwd...
        let cwd = parse(
            p.handle_json(&mk(
                "c",
                "goal/run",
                json!({"id": goal_id, "revision": revision, "requestKey": "rk-exec",
                       "input": "do it", "cwd": "D:/elsewhere"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            cwd["error"]["data"]["category"],
            json!(ErrorCategory::Conflict)
                .as_str()
                .unwrap_or("CONFLICT")
        );
        // ...and an explicit null reset where the original had a value.
        let reset = parse(
            p.handle_json(&mk(
                "n",
                "goal/run",
                json!({"id": goal_id, "revision": revision, "requestKey": "rk-exec",
                       "input": "do it", "model": null}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            reset["error"]["data"]["category"],
            json!(ErrorCategory::Conflict)
                .as_str()
                .unwrap_or("CONFLICT")
        );
        // A faithful replay (identical fields, model included) still
        // resolves to the original batch.
        let faithful = parse(
            p.handle_json(&mk(
                "f",
                "goal/run",
                json!({"id": goal_id, "revision": revision, "requestKey": "rk-exec",
                       "input": "do it", "model": "GPT-5.6-Terra"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(faithful["result"]["resumed"], true);
    }

    #[test]
    fn replay_survives_cleared_next_action() {
        let mut p = plane_with_one_completed_turn();
        init(&mut p);
        let ws = parse(
            p.handle_json(&mk("w", "workspace/create", json!({"title": "goal ws"})))
                .unwrap()
                .unwrap(),
        );
        let ws_id = ws["result"]["id"].as_str().unwrap().to_string();
        let goal = parse(
            p.handle_json(&mk(
                "g",
                "goal/create",
                json!({
                    "workspaceId": ws_id,
                    "title": "clear next action",
                    "successCriteria": "criteria",
                    "nextAction": "original action"
                }),
            ))
            .unwrap()
            .unwrap(),
        );
        let goal_id = goal["result"]["id"].as_str().unwrap().to_string();
        let first = parse(
            p.handle_json(&mk(
                "r1",
                "goal/run",
                json!({"id": goal_id, "revision": 1, "requestKey": "rk-clear"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(first.get("error").is_none(), "{first}");
        let revision = first["result"]["goalRevision"].as_u64().unwrap();
        let cleared = parse(
            p.handle_json(&mk(
                "u",
                "goal/update",
                json!({"id": goal_id, "revision": revision, "checkpoint": true,
                       "nextAction": ""}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(cleared.get("error").is_none(), "{cleared}");
        // With nextAction cleared, a fresh unkeyed run is refused - but the
        // known key still replays its batch without touching nextAction.
        let replay = parse(
            p.handle_json(&mk(
                "r2",
                "goal/run",
                json!({"id": goal_id, "revision": revision + 1, "requestKey": "rk-clear"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(replay.get("error").is_none(), "{replay}");
        assert_eq!(replay["result"]["resumed"], true);
    }

    #[test]
    fn same_key_with_different_parameters_is_a_typed_conflict() {
        let mut p = plane_with_one_completed_turn();
        let goal_id = setup_goal(&mut p);
        let first = parse(
            p.handle_json(&mk(
                "r1",
                "goal/run",
                json!({"id": goal_id, "revision": 1, "requestKey": "rk-1", "input": "do it"}),
            ))
            .unwrap()
            .unwrap(),
        );
        let revision = first["result"]["goalRevision"].as_u64().unwrap();
        let conflict = parse(
            p.handle_json(&mk(
                "r2",
                "goal/run",
                json!({"id": goal_id, "revision": revision, "requestKey": "rk-1", "input": "do something else"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            conflict["error"]["data"]["category"],
            json!(ErrorCategory::Conflict)
                .as_str()
                .unwrap_or("CONFLICT")
        );
    }

    #[test]
    fn run_read_returns_the_batch_by_key_and_by_id() {
        let mut p = plane_with_one_completed_turn();
        let goal_id = setup_goal(&mut p);
        let run = parse(
            p.handle_json(&mk(
                "r1",
                "goal/run",
                json!({"id": goal_id, "revision": 1, "requestKey": "rk-9", "input": "do it"}),
            ))
            .unwrap()
            .unwrap(),
        );
        let execution_id = run["result"]["execution"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let by_key = parse(
            p.handle_json(&mk(
                "q1",
                "goal/run/read",
                json!({"goalId": goal_id, "requestKey": "rk-9"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(by_key["result"]["execution"]["id"], execution_id);
        let by_id = parse(
            p.handle_json(&mk(
                "q2",
                "goal/run/read",
                json!({"executionId": execution_id}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(by_id["result"]["execution"]["id"], execution_id);
        assert_eq!(by_id["result"]["turn"]["status"], "completed");
        let missing = parse(
            p.handle_json(&mk(
                "q3",
                "goal/run/read",
                json!({"goalId": goal_id, "requestKey": "no-such-key"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            missing["error"]["data"]["category"],
            json!(ErrorCategory::NotFound)
                .as_str()
                .unwrap_or("NOT_FOUND")
        );
    }

    #[test]
    fn refused_admission_leaves_no_batch_and_policy_structure_is_validated() {
        let mut p = plane_with_one_completed_turn();
        let goal_id = setup_goal(&mut p);
        // Admission refused before any durable effect: stale revision.
        let stale = parse(
            p.handle_json(&mk(
                "bad",
                "goal/run",
                json!({"id": goal_id, "revision": 99, "requestKey": "rk-stale", "input": "x"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            stale["error"]["data"]["category"],
            json!(ErrorCategory::Conflict)
                .as_str()
                .unwrap_or("CONFLICT")
        );
        let none = parse(
            p.handle_json(&mk(
                "q",
                "goal/run/read",
                json!({"goalId": goal_id, "requestKey": "rk-stale"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            none["error"]["data"]["category"],
            json!(ErrorCategory::NotFound)
                .as_str()
                .unwrap_or("NOT_FOUND")
        );
        // Advance policy structure: unknown fields and bad types are refused.
        for bad in [json!({"bogus": 1}), json!({"maxRounds": "many"})] {
            let resp = parse(
                p.handle_json(&mk(
                    "adv",
                    "goal/run",
                    json!({"id": goal_id, "revision": 1, "requestKey": "rk-adv", "input": "x", "advance": bad}),
                ))
                .unwrap()
                .unwrap(),
            );
            assert_eq!(
                resp["error"]["data"]["category"],
                json!(ErrorCategory::InvalidArgument)
                    .as_str()
                    .unwrap_or("INVALID_ARGUMENT")
            );
        }
    }
}

// R02b: explicit continuous-advance control-plane tests.
#[cfg(test)]
mod goal_advance_tests {
    use super::*;
    use crate::tests::Scripted;
    use std::time::Duration;

    fn init(p: &mut ControlPlane) {
        let req = json!({
            "jsonrpc": "2.0",
            "id": "req_01",
            "method": "initialize",
            "params": {
                "protocol": {"major": 1, "minor": 0},
                "client": {"name": "knorvia_test", "version": "0.0.1", "platform": "windows"},
                "capabilities": ["thread", "artifact", "job", "approval", "reconnect"]
            }
        });
        let resp: Value =
            serde_json::from_str(&p.handle_json(&req.to_string()).unwrap().unwrap()).unwrap();
        assert!(resp.get("error").is_none(), "{resp}");
        let note = json!({"jsonrpc":"2.0","method":"initialized"});
        assert!(p.handle_json(&note.to_string()).unwrap().is_none());
    }

    fn plane_with(outcomes: Vec<Result<TurnOutcome, ProtocolError>>) -> ControlPlane {
        let base = std::env::temp_dir().join(format!(
            "knorvia-goaladv-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        ControlPlane::open_with_executor(
            knorvia_platform_paths::layout(base),
            Box::new(Scripted { outcomes }),
        )
        .unwrap()
    }

    /// A scripted executor that pauses inside every round, so deadline
    /// arithmetic can be exercised deterministically at the control plane.
    struct SleepingScripted {
        remaining: std::sync::Mutex<Vec<Result<TurnOutcome, ProtocolError>>>,
        round_pause: Duration,
    }

    impl TurnExecutor for SleepingScripted {
        fn run_turn(&mut self, _req: &TurnRequest) -> Result<TurnOutcome, ProtocolError> {
            std::thread::sleep(self.round_pause);
            self.remaining
                .lock()
                .unwrap()
                .pop()
                .expect("scripted outcome exhausted")
        }

        fn start_write_turn(
            &mut self,
            _req: &TurnRequest,
            _store: Arc<ProductStore>,
            _sink: Option<EventSink>,
        ) -> Result<turn_exec::WriteTurnStream, ProtocolError> {
            Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "write turns are not part of this test",
            ))
        }

        fn respond_approval(
            &mut self,
            _approval_id: &str,
            _decision: ka::TurnDecision,
        ) -> Result<bool, ProtocolError> {
            Ok(false)
        }

        fn decline_pending(&mut self, _thread_id: &str) -> Result<usize, ProtocolError> {
            Ok(0)
        }

        fn interrupt(&mut self, _thread_id: &str) -> Result<bool, ProtocolError> {
            Ok(false)
        }

        fn await_turn_done(
            &mut self,
            _thread_id: &str,
            _timeout: Duration,
        ) -> Result<(), ProtocolError> {
            Ok(())
        }

        fn set_sink(&mut self, _sink: Option<EventSink>) {}
    }

    fn completed(text: &str) -> Result<TurnOutcome, ProtocolError> {
        Ok(TurnOutcome {
            status: "completed".into(),
            items: vec![TurnItem {
                kind: "agentMessage".into(),
                payload: json!({"text": text}),
            }],
            error: None,
        })
    }

    fn mk(id: &str, method: &str, params: Value) -> String {
        json!({"jsonrpc":"2.0","id": id, "method": method, "params": params}).to_string()
    }

    fn parse(s: String) -> Value {
        serde_json::from_str(&s).unwrap()
    }

    fn setup_goal(p: &mut ControlPlane) -> String {
        init(p);
        let ws = parse(
            p.handle_json(&mk("w", "workspace/create", json!({"title": "adv ws"})))
                .unwrap()
                .unwrap(),
        );
        let ws_id = ws["result"]["id"].as_str().unwrap().to_string();
        let goal = parse(
            p.handle_json(&mk(
                "g",
                "goal/create",
                json!({
                    "workspaceId": ws_id,
                    "title": "advancing goal",
                    "successCriteria": "done means done"
                }),
            ))
            .unwrap()
            .unwrap(),
        );
        goal["result"]["id"].as_str().unwrap().to_string()
    }

    #[test]
    fn three_rounds_run_then_budget_pause_never_completes_the_goal() {
        let mut p = plane_with(vec![completed("r3"), completed("r2"), completed("r1")]);
        let goal_id = setup_goal(&mut p);
        let run = parse(
            p.handle_json(&mk(
                "r",
                "goal/run",
                json!({"id": goal_id, "revision": 1, "requestKey": "rk-adv",
                       "input": "start", "advance": {"maxRounds": 3}}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(run.get("error").is_none(), "{run}");
        let execution = &run["result"]["execution"];
        assert_eq!(
            execution["rounds"].as_array().unwrap().len(),
            3,
            "all three rounds must run for real"
        );
        assert_eq!(execution["status"], "paused");
        assert_eq!(execution["stopReason"], "roundsExhausted");
        // Budget exhaustion must not mark the Goal completed.
        let goal = parse(
            p.handle_json(&mk("gr", "goal/read", json!({"id": goal_id})))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(goal["result"]["status"], "active");
        // Replaying the key returns the same finished batch.
        let retry = parse(
            p.handle_json(&mk(
                "r2",
                "goal/run",
                json!({"id": goal_id, "revision": 2, "requestKey": "rk-adv",
                       "input": "start", "advance": {"maxRounds": 3}}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(retry["result"]["resumed"], true);
        assert_eq!(
            retry["result"]["execution"]["rounds"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn undelivered_user_input_stops_the_batch_for_the_user() {
        let outcome = Ok(TurnOutcome {
            status: "completed".into(),
            items: vec![
                TurnItem {
                    kind: "userInput".into(),
                    payload: json!({"request": {"question": "mode?"}, "delivered": false}),
                },
                TurnItem {
                    kind: "agentMessage".into(),
                    payload: json!({"text": "partial"}),
                },
            ],
            error: None,
        });
        let mut p = plane_with(vec![completed("never"), outcome]);
        let goal_id = setup_goal(&mut p);
        let run = parse(
            p.handle_json(&mk(
                "r",
                "goal/run",
                json!({"id": goal_id, "revision": 1, "requestKey": "rk-u",
                       "input": "start", "advance": {"maxRounds": 2}}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(run.get("error").is_none(), "{run}");
        assert_eq!(run["result"]["execution"]["status"], "waitingUser");
        assert_eq!(run["result"]["execution"]["stopReason"], "waitingUser");
        assert_eq!(
            run["result"]["execution"]["rounds"]
                .as_array()
                .unwrap()
                .len(),
            1,
            "the batch must stop for the user instead of continuing"
        );
    }

    #[test]
    fn expired_deadline_admits_zero_rounds_with_zero_side_effects() {
        let mut p = plane_with(vec![completed("never-runs")]);
        let goal_id = setup_goal(&mut p);
        // The deadline is already gone at admission time: no batch, no turn,
        // no tool side effect may happen.
        let run = parse(
            p.handle_json(&mk(
                "r",
                "goal/run",
                json!({"id": goal_id, "revision": 1, "requestKey": "rk-d",
                       "input": "start",
                       "advance": {"maxRounds": 5, "deadlineMs": 1}}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            run["error"]["data"]["category"],
            json!(ErrorCategory::DeadlineExceeded)
                .as_str()
                .unwrap_or("DEADLINE_EXCEEDED")
        );
        let query = parse(
            p.handle_json(&mk(
                "q",
                "goal/run/read",
                json!({"goalId": goal_id, "requestKey": "rk-d"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            query["error"]["data"]["category"],
            json!(ErrorCategory::NotFound)
                .as_str()
                .unwrap_or("NOT_FOUND"),
            "no batch may exist for a refused admission"
        );
    }

    #[test]
    fn deadline_reached_between_rounds_never_starts_the_next_round() {
        // Each scripted round sleeps well past half the budget: the first
        // round settles inside the deadline; once the deadline has passed,
        // the next round is refused. In-flight rounds are never interrupted
        // by the deadline - they settle with their durable terminal and the
        // batch then stops (cancellation goes through turn/interrupt).
        let base = std::env::temp_dir().join(format!(
            "knorvia-goaladv-slow-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let outcomes = vec![
            Ok(TurnOutcome {
                status: "completed".into(),
                items: vec![TurnItem {
                    kind: "agentMessage".into(),
                    payload: json!({"text": "round"}),
                }],
                error: None,
            });
            3
        ];
        let mut p = ControlPlane::open_with_executor(
            knorvia_platform_paths::layout(base),
            Box::new(SleepingScripted {
                remaining: std::sync::Mutex::new(outcomes),
                round_pause: Duration::from_millis(300),
            }),
        )
        .unwrap();
        let goal_id = setup_goal(&mut p);
        let deadline_ms = knorvia_store::epoch_millis() + 400;
        let run = parse(
            p.handle_json(&mk(
                "r",
                "goal/run",
                json!({"id": goal_id, "revision": 1, "requestKey": "rk-dl",
                       "input": "start",
                       "advance": {"maxRounds": 9, "deadlineMs": deadline_ms}}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(run.get("error").is_none(), "{run}");
        let execution = &run["result"]["execution"];
        let rounds = execution["rounds"].as_array().unwrap().len();
        assert!(rounds >= 1, "at least one round must run: {run}");
        assert!(
            rounds <= 2,
            "a 400ms budget with 300ms rounds must not fit three rounds: {rounds}"
        );
        assert_eq!(execution["status"], "paused");
        assert_eq!(execution["stopReason"], "deadlineReached");
        for round in execution["rounds"].as_array().unwrap() {
            assert_eq!(
                round["status"], "completed",
                "rounds settle, never fabricate"
            );
        }
    }

    #[test]
    fn a_non_completed_round_stops_the_batch_without_completing_the_goal() {
        let outcome = Ok(TurnOutcome {
            status: "interrupted".into(),
            items: vec![],
            error: None,
        });
        let mut p = plane_with(vec![outcome]);
        let goal_id = setup_goal(&mut p);
        let run = parse(
            p.handle_json(&mk(
                "r",
                "goal/run",
                json!({"id": goal_id, "revision": 1, "requestKey": "rk-i",
                       "input": "start", "advance": {"maxRounds": 4}}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(run.get("error").is_none(), "{run}");
        assert_eq!(run["result"]["execution"]["status"], "interrupted");
        assert_eq!(run["result"]["execution"]["stopReason"], "interrupted");
        let goal = parse(
            p.handle_json(&mk("gr", "goal/read", json!({"id": goal_id})))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(goal["result"]["status"], "active");
    }
}
