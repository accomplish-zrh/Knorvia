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
        let action = optional_string(params, "input")?
            .or_else(|| goal.next_action.clone())
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "record a nextAction or supply input before running a Goal",
                )
            })?;
        let execution = self
            .store
            .goal_execution(id)
            .map_err(|error| error.into_protocol())?;
        if execution["running"].as_u64().unwrap_or(0) > 0 {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "this Goal already has an active Turn",
            ));
        }
        let mut settings = params.clone();
        settings["workspaceId"] = json!(goal.workspace_id);
        settings["goalId"] = json!(goal.id);
        settings["title"] = json!(action);
        let thread_id = if let Some(thread_id) = optional_string(params, "threadId")? {
            let thread = self
                .store
                .read_thread(&thread_id)
                .map_err(|error| error.into_protocol())?;
            if thread.goal_id.as_deref() != Some(id) {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "task belongs to another Goal",
                ));
            }
            thread_id
        } else {
            self.rpc_thread_start(&settings)?["id"]
                .as_str()
                .ok_or_else(|| {
                    ProtocolError::new(ErrorCategory::Internal, "created task has no id")
                })?
                .to_string()
        };
        settings["threadId"] = json!(thread_id);
        settings["input"] = json!(format!(
            "Goal: {}\nAcceptance criteria: {}\nStanding constraints: {}\n\nNext action: {}",
            goal.title,
            goal.success_criteria.as_deref().unwrap_or(""),
            goal.constraints.as_deref().unwrap_or(""),
            action
        ));
        let admitted = self.rpc_turn_start(&settings)?;
        let checkpoint = self
            .store
            .update_goal(
                id,
                GoalUpdate {
                    checkpoint: true,
                    ..GoalUpdate::default()
                },
                Some(goal.revision),
            )
            .map_err(|error| error.into_protocol())?;
        Ok(
            json!({"goalId":id,"goalRevision":checkpoint.revision,"threadId":thread_id,"turn":admitted.get("turn").unwrap_or(&admitted)}),
        )
    }
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
