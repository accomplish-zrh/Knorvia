//! Short control-plane operations. Model execution never runs on the reader.

use super::*;

fn optional_string(params: &Value, key: &str) -> Result<Option<String>, ProtocolError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.clone())),
        Some(Value::String(_)) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must not be empty"),
        )),
        Some(_) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must be a string"),
        )),
    }
}

fn expected_revision(params: &Value) -> Result<Option<u64>, ProtocolError> {
    match params.get("expectedRevision") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or_else(|| {
            ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "expectedRevision must be an unsigned integer",
            )
        }),
    }
}

const DEFAULT_TIMELINE_ITEM_LIMIT: usize = 100;
const DEFAULT_TIMELINE_TURN_LIMIT: usize = 100;
const MAX_TIMELINE_PAGE_LIMIT: usize = 500;
const OWNER_READY_WAIT: std::time::Duration = std::time::Duration::from_millis(750);
const OWNER_READY_POLL: std::time::Duration = std::time::Duration::from_millis(10);

fn page_limit(params: &Value, key: &str, default: usize) -> Result<usize, ProtocolError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => {
            let limit = value.as_u64().ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    format!("{key} must be an unsigned integer"),
                )
            })?;
            if limit == 0 || limit > MAX_TIMELINE_PAGE_LIMIT as u64 {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    format!("{key} must be between 1 and {MAX_TIMELINE_PAGE_LIMIT}"),
                ));
            }
            Ok(limit as usize)
        }
    }
}

fn optional_u64(params: &Value, key: &str) -> Result<Option<u64>, ProtocolError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or_else(|| {
            ProtocolError::new(
                ErrorCategory::InvalidArgument,
                format!("{key} must be an unsigned integer"),
            )
        }),
    }
}

pub(super) fn settings_from_params(
    params: &Value,
    fallback_cwd: Option<String>,
) -> Result<KernelTurnSettings, ProtocolError> {
    let cwd = optional_string(params, "cwd")?.or(fallback_cwd);
    if let Some(cwd) = &cwd
        && !std::path::Path::new(cwd).is_absolute()
    {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "cwd must be an absolute path",
        ));
    }
    let collaboration_mode = optional_string(params, "collaborationMode")?;
    if collaboration_mode
        .as_deref()
        .is_some_and(|mode| !matches!(mode, "default" | "plan"))
    {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "collaborationMode must be default or plan",
        ));
    }
    Ok(KernelTurnSettings {
        cwd,
        model: optional_string(params, "model")?,
        reasoning_effort: optional_string(params, "reasoningEffort")?,
        reset_reasoning_effort: params.get("reasoningEffort") == Some(&Value::Null),
        service_tier: optional_string(params, "serviceTier")?,
        collaboration_mode,
    })
}

impl ControlPlane {
    /// The product projection is committed before the runner can register a
    /// channel owner. A concurrent snapshot may therefore see a fresh pending
    /// approval/input in the few instructions before registration. Bridge that
    /// handoff here instead of forcing clients to retry a valid response.
    fn wait_for_approval_owner(&self, id: &str) -> bool {
        let deadline = std::time::Instant::now() + OWNER_READY_WAIT;
        loop {
            if self.executor_lock().has_approval_owner(id) {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(OWNER_READY_POLL);
        }
    }

    fn wait_for_user_input_owner(&self, id: &str) -> bool {
        let deadline = std::time::Instant::now() + OWNER_READY_WAIT;
        loop {
            if self.executor_lock().has_user_input_owner(id) {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(OWNER_READY_POLL);
        }
    }

    /// A lightweight summary intended for a periodically refreshed thread
    /// list. Timeline records deliberately stay out of this response: large
    /// histories must not make the task index grow without bound.
    fn thread_index(&self, thread: knorvia_protocol::Thread) -> Result<Value, ProtocolError> {
        let activity = self
            .store
            .read_thread_activity(&thread.id)
            .map_err(|e| e.into_protocol())?;
        let settings = self
            .executor_lock()
            .thread_settings(&thread.id)?
            .unwrap_or_default();
        let workspace_cwd = self
            .store
            .read_workspace_cwd(&thread.workspace_id)
            .map_err(|e| e.into_protocol())?;
        let mut snapshot = serde_json::to_value(thread).map_err(json_err)?;
        snapshot["pendingApprovals"] = json!(activity.pending_approvals);
        snapshot["pendingUserInputs"] = json!(activity.pending_user_inputs);
        snapshot["activeTurn"] = json!(activity.active_turn);
        snapshot["lastTurn"] = json!(activity.last_turn);
        snapshot["cwd"] = json!(settings.cwd.clone().or(workspace_cwd));
        snapshot["model"] = json!(settings.model);
        snapshot["reasoningEffort"] = json!(settings.reasoning_effort);
        snapshot["serviceTier"] = json!(settings.service_tier);
        snapshot["collaborationMode"] = json!(settings.collaboration_mode);
        Ok(snapshot)
    }

    /// Read a bounded tail page of a task timeline. `beforeItemSeq` and
    /// `beforeTurnId` are exclusive cursors: pass a returned next cursor to
    /// load an older page. New records continue to arrive through `turn/event`
    /// notifications, so polling never needs to fetch a complete timeline.
    fn thread_snapshot(
        &self,
        thread: knorvia_protocol::Thread,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let item_limit = page_limit(params, "itemLimit", DEFAULT_TIMELINE_ITEM_LIMIT)?;
        let before_item = optional_u64(params, "beforeItemSeq")?;
        let turn_limit = page_limit(params, "turnLimit", DEFAULT_TIMELINE_TURN_LIMIT)?;
        let before_turn = optional_string(params, "beforeTurnId")?;
        let history = self
            .store
            .read_thread_history(
                &thread.id,
                before_item,
                item_limit,
                before_turn.as_deref(),
                turn_limit,
            )
            .map_err(|error| error.into_protocol())?;

        let settings = self
            .executor_lock()
            .thread_settings(&thread.id)?
            .unwrap_or_default();
        let workspace_cwd = self
            .store
            .read_workspace_cwd(&thread.workspace_id)
            .map_err(|e| e.into_protocol())?;
        let mut snapshot = serde_json::to_value(thread).map_err(json_err)?;
        snapshot["turns"] = json!(history.turns);
        snapshot["items"] = json!(history.items);
        snapshot["pendingApprovals"] = json!(history.activity.pending_approvals);
        snapshot["pendingUserInputs"] = json!(history.activity.pending_user_inputs);
        snapshot["activeTurn"] = json!(history.activity.active_turn);
        snapshot["lastTurn"] = json!(history.activity.last_turn);
        snapshot["itemsNextCursor"] = json!(history.items_next_cursor);
        snapshot["hasMoreItems"] = json!(history.items_next_cursor.is_some());
        snapshot["turnsNextCursor"] = json!(history.turns_next_cursor);
        snapshot["hasMoreTurns"] = json!(history.turns_next_cursor.is_some());
        snapshot["cwd"] = json!(settings.cwd.clone().or(workspace_cwd));
        snapshot["model"] = json!(settings.model);
        snapshot["reasoningEffort"] = json!(settings.reasoning_effort);
        snapshot["serviceTier"] = json!(settings.service_tier);
        snapshot["collaborationMode"] = json!(settings.collaboration_mode);
        Ok(snapshot)
    }

    pub(super) fn rpc_thread_read(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "id")?;
        let thread = self.store.read_thread(id).map_err(|e| e.into_protocol())?;
        self.thread_snapshot(thread, params)
    }

    pub(super) fn rpc_thread_list(&self, params: &Value) -> Result<Value, ProtocolError> {
        let workspace_id = required_str(params, "workspaceId")?;
        // Optional cursor paging for large workspaces. Omitting both keeps
        // the original array shape; supplying them switches to the paged
        // envelope so a client can opt in without a protocol break.
        let limit = params.get("limit").and_then(Value::as_u64);
        let after_id = params.get("afterId").and_then(Value::as_str);
        match (limit, after_id) {
            (None, None) => {
                let threads = self
                    .store
                    .list_threads(workspace_id)
                    .map_err(|e| e.into_protocol())?;
                let snapshots: Result<Vec<_>, _> = threads
                    .into_iter()
                    .map(|thread| self.thread_index(thread))
                    .collect();
                Ok(json!(snapshots?))
            }
            _ => {
                let limit = limit.ok_or_else(|| {
                    ProtocolError::new(
                        ErrorCategory::InvalidArgument,
                        "thread/list paging requires a positive limit",
                    )
                })?;
                if limit == 0 || limit > 500 {
                    return Err(ProtocolError::new(
                        ErrorCategory::InvalidArgument,
                        "thread/list limit must be between 1 and 500",
                    ));
                }
                let (threads, next_cursor) = self
                    .store
                    .list_threads_page(workspace_id, after_id, limit as usize)
                    .map_err(|e| e.into_protocol())?;
                let snapshots: Result<Vec<_>, _> = threads
                    .into_iter()
                    .map(|thread| self.thread_index(thread))
                    .collect();
                Ok(json!({
                    "threads": snapshots?,
                    "nextCursor": next_cursor,
                }))
            }
        }
    }

    pub(super) fn rpc_thread_resume(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "id")?;
        let thread = self.store.read_thread(id).map_err(|e| e.into_protocol())?;
        if thread.status == "archived" {
            return Err(ProtocolError::new(
                ErrorCategory::PreconditionFailed,
                "unarchive the thread before resuming it",
            ));
        }
        self.thread_snapshot(thread, params)
    }

    pub(super) fn rpc_thread_fork(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let source_id = required_str(params, "threadId")?;
        let source = self
            .store
            .read_thread(source_id)
            .map_err(|e| e.into_protocol())?;
        if source.status == "archived" {
            return Err(ProtocolError::new(
                ErrorCategory::PreconditionFailed,
                "unarchive the source thread before forking it",
            ));
        }
        let expected = expected_revision(params)?;
        if expected.is_some_and(|revision| revision != source.revision) {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "thread revision does not match expectedRevision",
            ));
        }
        if self
            .store
            .list_turns(source_id)
            .map_err(|e| e.into_protocol())?
            .iter()
            .any(|turn| turn.status == "running")
        {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "cannot fork a thread with a running turn",
            ));
        }
        let source_settings = self
            .executor_lock()
            .thread_settings(source_id)?
            .unwrap_or_default();
        let settings = source_settings.merge(&settings_from_params(params, None)?);
        let kernel_thread = self
            .executor_lock()
            .fork_kernel_thread(source_id, &settings)?;
        let title =
            optional_string(params, "title")?.unwrap_or_else(|| format!("{} (fork)", source.title));
        let fork = self
            .store
            .fork_thread(source_id, &title, expected)
            .map_err(|error| {
                // The real Kernel child must not remain usable when its
                // matching product snapshot was rejected (for example by a
                // concurrent revision change).
                let _ = self.executor_lock().discard_kernel_thread(&kernel_thread);
                error.into_protocol()
            })?;
        if let Err(error) =
            self.executor_lock()
                .bind_kernel_thread(&fork.id, &kernel_thread, &settings)
        {
            // The real Kernel fork exists, but a product child without its
            // mapping would falsely look ready to continue. Hide the durable
            // snapshot until an operator can repair its binding, and archive
            // the unmatched Kernel child as well.
            let _ = self.executor_lock().discard_kernel_thread(&kernel_thread);
            let _ = self.store.archive_thread(&fork.id, None);
            return Err(error);
        }
        self.thread_snapshot(fork, params)
    }

    pub(super) fn rpc_thread_update(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "id")?;
        let before = self.store.read_thread(id).map_err(|e| e.into_protocol())?;
        let title = optional_string(params, "title")?;
        let updated = match title {
            Some(title) => self
                .store
                .update_thread(id, &title, expected_revision(params)?)
                .map_err(|e| e.into_protocol())?,
            None => before,
        };
        let settings = settings_from_params(params, None)?;
        if !settings.is_empty() {
            self.executor_lock().configure_thread(id, &settings)?;
        }
        self.thread_snapshot(updated, params)
    }

    pub(super) fn rpc_thread_archive(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "id")?;
        if self
            .store
            .list_turns(id)
            .map_err(|e| e.into_protocol())?
            .iter()
            .any(|turn| turn.status == "running")
        {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "cannot archive a thread with a running turn",
            ));
        }
        let has_kernel = self.executor_lock().has_kernel_thread(id)?;
        if has_kernel {
            self.executor_lock().archive_kernel_thread(id)?;
        }
        let archived = match self.store.archive_thread(id, expected_revision(params)?) {
            Ok(thread) => thread,
            Err(error) => {
                if has_kernel {
                    let _ = self.executor_lock().unarchive_kernel_thread(id);
                }
                return Err(error.into_protocol());
            }
        };
        self.thread_snapshot(archived, params)
    }

    pub(super) fn rpc_thread_unarchive(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "id")?;
        let has_kernel = self.executor_lock().has_kernel_thread(id)?;
        if has_kernel {
            self.executor_lock().unarchive_kernel_thread(id)?;
        }
        let restored = match self.store.unarchive_thread(id, expected_revision(params)?) {
            Ok(thread) => thread,
            Err(error) => {
                if has_kernel {
                    let _ = self.executor_lock().archive_kernel_thread(id);
                }
                return Err(error.into_protocol());
            }
        };
        self.thread_snapshot(restored, params)
    }

    pub(super) fn rpc_model_list(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let cursor = match params.get("cursor") {
            None | Some(Value::Null) => Value::Null,
            Some(Value::String(cursor)) => json!(cursor),
            Some(_) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "cursor must be a string or null",
                ));
            }
        };
        let limit = match params.get("limit") {
            None | Some(Value::Null) => Value::Null,
            Some(value) if value.as_u64().is_some() => value.clone(),
            Some(_) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "limit must be an unsigned integer or null",
                ));
            }
        };
        let include_hidden = match params.get("includeHidden") {
            None | Some(Value::Null) => Value::Null,
            Some(Value::Bool(value)) => json!(value),
            Some(_) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "includeHidden must be a boolean or null",
                ));
            }
        };
        self.executor_lock().list_models(&json!({
            "cursor": cursor,
            "limit": limit,
            "includeHidden": include_hidden,
        }))
    }

    pub(super) fn rpc_skill_list(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let cwds = match params.get("cwds") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(cwds)) if cwds.iter().all(Value::is_string) => cwds.clone(),
            Some(_) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "cwds must be an array of absolute paths",
                ));
            }
        };
        for cwd in &cwds {
            let cwd = cwd.as_str().expect("validated above");
            if !std::path::Path::new(cwd).is_absolute() {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "every skills/list cwd must be absolute",
                ));
            }
        }
        let force_reload = match params.get("forceReload") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(value)) => *value,
            Some(_) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "forceReload must be a boolean",
                ));
            }
        };
        self.executor_lock()
            .list_skills(&json!({"cwds": cwds, "forceReload": force_reload}))
    }

    pub(super) fn rpc_turn_start(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        self.ensure_accepting_work()?;
        let thread_id = required_str(params, "threadId")?;
        self.ensure_message_queue_order(thread_id)?;
        let input = required_str(params, "input")?;
        let (settings, write) = self.prepare_turn_execution(&thread_id, params)?;
        let turn = self
            .store
            .start_turn(thread_id)
            .map_err(|e| e.into_protocol())?;
        self.execute_admitted_turn(thread_id, turn, input.to_string(), settings, write, None)
    }

    /// Shared pre-admission work for every turn start path: workspace and
    /// archived checks plus the merged, persisted per-thread settings.
    pub(super) fn prepare_turn_execution(
        &mut self,
        thread_id: &str,
        params: &Value,
    ) -> Result<(KernelTurnSettings, bool), ProtocolError> {
        let thread = self
            .store
            .read_thread(thread_id)
            .map_err(|e| e.into_protocol())?;
        self.ensure_workspace_runnable(&thread.workspace_id)?;
        if thread.status == "archived" {
            return Err(ProtocolError::new(
                ErrorCategory::PreconditionFailed,
                "unarchive the thread before starting a turn",
            ));
        }
        let workspace_cwd = self
            .store
            .read_workspace_cwd(&thread.workspace_id)
            .map_err(|e| e.into_protocol())?;
        let selected = self
            .executor_lock()
            .thread_settings(thread_id)?
            .unwrap_or_default();
        // Persist only explicit per-thread selections. The workspace cwd is
        // an execution-time fallback so workspace/update changes the default
        // for threads that did not choose their own cwd.
        let selected_settings = selected.merge(&settings_from_params(params, None)?);
        self.executor_lock()
            .configure_thread(thread_id, &selected_settings)?;
        let mut settings = selected_settings;
        if settings.cwd.is_none() {
            settings.cwd = workspace_cwd;
        }
        let write = params
            .pointer("/tools/write")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok((settings, write))
    }

    /// Shared post-admission work: the user input Item, the runner, and the
    /// durable failure projections when the runner cannot be started. A Goal
    /// execution batch owning the Turn is closed best-effort in every
    /// failure path; read-time reconciliation covers a failed close.
    pub(super) fn execute_admitted_turn(
        &mut self,
        thread_id: &str,
        turn: knorvia_protocol::Turn,
        input: String,
        settings: KernelTurnSettings,
        write: bool,
        advance_for_request: Option<Value>,
    ) -> Result<Value, ProtocolError> {
        if let Err(error) = self.store.append_item(
            thread_id,
            &turn.id,
            "userMessage",
            "completed",
            json!({"text": input, "collaborationMode": settings.collaboration_mode}),
        ) {
            // Failure is surfaced, never represented as a completed response.
            self.store
                .complete_turn_idempotent(&turn.id, "failed")
                .map_err(|e| e.into_protocol())?;
            let _ = self.store.close_goal_round(&turn.id, "failed");
            return Err(error.into_protocol());
        }
        let request = TurnRequest {
            thread_id: thread_id.to_string(),
            turn_id: turn.id.clone(),
            prompt: input,
            read_only: !write,
            settings,
            advance: advance_for_request,
        };
        if let Err(error) = self
            .executor_lock()
            .start_turn(&request, Arc::clone(&self.store))
        {
            let recorded = self.store.append_item(
                thread_id,
                &turn.id,
                "error",
                "failed",
                json!({"category": error.category, "message": error.message}),
            );
            // Admission failed: no runner can finish this Turn for us. Even
            // if the diagnostic Item fails, attempt the terminal projection.
            let finalized = self.store.complete_turn_idempotent(&turn.id, "failed");
            recorded.map_err(|e| e.into_protocol())?;
            finalized.map_err(|e| e.into_protocol())?;
        }
        let snapshot = self.rpc_turn_read(&json!({"id": turn.id}))?;
        let pending = snapshot["pendingApprovals"]
            .as_array()
            .and_then(|items| items.first())
            .map(|approval| approval["id"].clone());
        Ok(
            json!({"turn": self.store.read_turn(&turn.id).map_err(|e| e.into_protocol())?,
            "items": snapshot["items"], "pendingApprovalId": pending}),
        )
    }

    pub(super) fn rpc_turn_read(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "id")?;
        let history = self
            .store
            .read_turn_history(id)
            .map_err(|e| e.into_protocol())?;
        let mut snapshot = serde_json::to_value(history.turn).map_err(json_err)?;
        snapshot["items"] = json!(history.items);
        snapshot["pendingApprovals"] = json!(history.pending_approvals);
        snapshot["pendingUserInputs"] = json!(history.pending_user_inputs);
        Ok(snapshot)
    }

    pub(super) fn rpc_turn_interrupt(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let turn_id = required_str(params, "turnId")?;
        let turn = self
            .store
            .read_turn(turn_id)
            .map_err(|e| e.into_protocol())?;
        self.pause_message_queue_for_stop(&turn.thread_id)?;
        if turn.status != "running" {
            return serde_json::to_value(turn).map_err(json_err);
        }
        let handled = self
            .executor_lock()
            .interrupt_turn(&turn.thread_id, turn_id)?;
        if handled {
            self.executor_lock()
                .decline_turn_pending(&turn.thread_id, turn_id)?;
        }
        if !handled
            && self
                .store
                .read_turn(turn_id)
                .map_err(|e| e.into_protocol())?
                .status
                == "running"
        {
            // No owner may execute this orphan. Recovery is not cancellation
            // evidence from a live kernel, so label it interrupted explicitly.
            self.store
                .complete_turn_idempotent(turn_id, "interrupted")
                .map_err(|e| e.into_protocol())?;
        }
        // Acknowledgement is not terminal confirmation. The runner owns that.
        serde_json::to_value(
            self.store
                .read_turn(turn_id)
                .map_err(|e| e.into_protocol())?,
        )
        .map_err(json_err)
    }

    pub(super) fn rpc_approval_respond(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "id")?;
        let decision = required_str(params, "decision")?;
        let pending = self
            .store
            .read_approval(id)
            .map_err(|e| e.into_protocol())?;
        if pending.status != "pending" {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "approval is no longer pending",
            ));
        }
        if !self.executor_lock().has_approval_owner(id) && !self.wait_for_approval_owner(id) {
            let mut error = ProtocolError::new(
                ErrorCategory::Conflict,
                "approval has no ready live owner; refresh before deciding",
            );
            error.retryable = true;
            return Err(error);
        }
        let approval = self
            .store
            .respond_approval(id, decision)
            .map_err(|e| e.into_protocol())?;
        // Persist the decision Item before releasing the Kernel runner; it
        // could finish immediately after receiving the approval response.
        if let Err(error) = self.store.append_item(
            &approval.thread_id,
            &approval.turn_id,
            "approvalDecision",
            "recorded",
            json!({"approvalId": id, "decision": approval.status}),
        ) {
            // User consent is not execution. A failed audit append must never
            // release the tool. Record the failed delivery before unblocking
            // the owner with a fail-closed decline, so an "allowed" projection
            // can never outlive an execution that received a different value.
            self.store
                .mark_approval_delivery_failed(id)
                .map_err(|e| e.into_protocol())?;
            let _ = self
                .executor_lock()
                .respond_approval(id, ka::TurnDecision::Decline);
            return Err(error.into_protocol());
        }
        let forwarded = self.executor_lock().respond_approval(
            id,
            if approval.status == "allowed" {
                ka::TurnDecision::Accept
            } else {
                ka::TurnDecision::Decline
            },
        );
        match forwarded {
            Ok(true) => {}
            Ok(false) | Err(_) => {
                // The durable user decision exists, but no live Kernel owner
                // received it. Rewrite the approval projection to an explicit
                // delivery failure so the product never claims a tool action
                // was authorized when it was not.
                let failed = self
                    .store
                    .mark_approval_delivery_failed(id)
                    .map_err(|e| e.into_protocol())?;
                let _ = self.store.append_item(
                    &failed.thread_id,
                    &failed.turn_id,
                    "approvalDelivery",
                    "failed",
                    json!({"approvalId": id, "decision": approval.status, "delivered": false}),
                );
                return Err(ProtocolError::new(
                    ErrorCategory::Conflict,
                    "approval decision could not be delivered to a live Kernel owner; the action was not authorized",
                ));
            }
        }
        if approval.status == "delivery_failed" {
            // Defensive only: Store's successful `respond_approval` currently
            // returns allowed/denied, but never turn a future status extension
            // into an affirmative action on the Kernel wire.
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "approval is not deliverable to the Kernel",
            ));
        }
        serde_json::to_value(approval).map_err(json_err)
    }

    pub(super) fn rpc_turn_steer(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let thread_id = required_str(params, "threadId")?;
        let turn_id = required_str(params, "turnId")?;
        let input = required_str(params, "input")?;
        let turn = self
            .store
            .read_turn(turn_id)
            .map_err(|e| e.into_protocol())?;
        if turn.thread_id != thread_id {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "turn does not belong to threadId",
            ));
        }
        if turn.status != "running" {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "turn is no longer running",
            ));
        }
        let client_message_id = optional_string(params, "clientMessageId")?;
        let upstream_client_message_id = optional_string(params, "clientUserMessageId")?;
        if client_message_id.is_some()
            && upstream_client_message_id.is_some()
            && client_message_id != upstream_client_message_id
        {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "clientMessageId and clientUserMessageId must match when both are supplied",
            ));
        }
        let client_message_id = client_message_id.or(upstream_client_message_id);
        let payload = json!({"text": input, "clientId": client_message_id});
        let item = self
            .store
            .append_item(
                thread_id,
                turn_id,
                "userMessage",
                "pending",
                payload.clone(),
            )
            .map_err(|e| e.into_protocol())?;
        if let Err(error) =
            self.executor_lock()
                .steer_turn(thread_id, turn_id, input, client_message_id.as_deref())
        {
            let _ = self.store.resolve_item(
                &item.id,
                "failed",
                json!({"text": input, "clientId": client_message_id, "error": error.message.clone()}),
            );
            return Err(error);
        }
        let resolved = match self.store.resolve_item(&item.id, "completed", payload) {
            Ok(item) => item,
            Err(error) => {
                // Kernel accepted the steer, but the matching product item
                // could not be durably committed. Stop the turn rather than
                // continuing with un-auditable user input.
                let _ = self.executor_lock().interrupt_turn(thread_id, turn_id);
                let _ = self
                    .executor_lock()
                    .decline_turn_pending(thread_id, turn_id);
                return Err(error.into_protocol());
            }
        };
        Ok(json!({"turnId": turn_id, "item": resolved}))
    }

    pub(super) fn rpc_user_input(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "id")?;
        let answers = params.get("answers").cloned().ok_or_else(|| {
            ProtocolError::new(ErrorCategory::InvalidArgument, "answers is required")
        })?;
        if !answers.is_object() {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "answers must be an object keyed by question id",
            ));
        }
        if answers.as_object().is_some_and(|entries| {
            entries.values().any(|answer| {
                !answer
                    .get("answers")
                    .and_then(Value::as_array)
                    .is_some_and(|values| values.iter().all(Value::is_string))
            })
        }) {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "each user-input answer must be {answers: string[]}",
            ));
        }
        let pending = self.store.read_item(id).map_err(|e| e.into_protocol())?;
        if pending.kind != "userInput" || pending.status != "waiting_input" {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "user-input request is no longer pending",
            ));
        }
        // A product timeline and its WAL are intentionally durable and
        // inspectable. Until a separate encrypted secret-input channel
        // exists, never accept a value for a Kernel prompt marked secret: it
        // would otherwise be persisted in the resolved Item payload.
        if pending
            .payload
            .pointer("/request/questions")
            .and_then(Value::as_array)
            .is_some_and(|questions| {
                questions.iter().any(|question| {
                    question
                        .get("isSecret")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
            })
        {
            return Err(ProtocolError::new(
                ErrorCategory::CapabilityUnavailable,
                "secret user input is unavailable in a durable task timeline; configure the value through a secure connection setting",
            ));
        }
        if !self.executor_lock().has_user_input_owner(id) && !self.wait_for_user_input_owner(id) {
            let mut error = ProtocolError::new(
                ErrorCategory::Conflict,
                "user-input request has no ready live owner; refresh before responding",
            );
            error.retryable = true;
            return Err(error);
        }
        let request = pending
            .payload
            .get("request")
            .cloned()
            .unwrap_or(Value::Null);
        let resolved = self
            .store
            .resolve_item(
                id,
                "answered",
                json!({"request": request, "answers": answers}),
            )
            .map_err(|e| e.into_protocol())?;
        let delivery_error = match self
            .executor_lock()
            .respond_user_input(id, json!({"answers": answers}))
        {
            Ok(true) => None,
            Ok(false) => Some("user-input request has no live Kernel owner".to_string()),
            Err(error) => Some(error.message),
        };
        if let Some(error) = delivery_error {
            let failed = self
                .store
                .mark_item_delivery_failed(
                    id,
                    json!({
                        "request": pending.payload["request"],
                        "answers": answers,
                        "delivered": false,
                        "error": error,
                    }),
                )
                .map_err(|e| e.into_protocol())?;
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                format!(
                    "user-input answer was not delivered to a live Kernel owner (item {})",
                    failed.id
                ),
            ));
        }
        Ok(json!({"item": resolved}))
    }
}

#[cfg(test)]
#[path = "turns_tests.rs"]
mod tests;
