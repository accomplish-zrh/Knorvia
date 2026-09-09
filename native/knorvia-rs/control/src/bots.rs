//! RPC surface for the social domain: bots, rooms and session bindings.
//!
//! These handlers are thin translations between the JSON-RPC envelope and the
//! durable store facts in `knorvia_store::bots`. The Kernel stays the sole
//! execution owner: a binding only pins which product thread a conversation
//! resumes, and every turn still flows through the single Agent loop.

use super::{ControlPlane, json_err, required_str};
use knorvia_protocol::{ErrorCategory, ProtocolError};
use knorvia_store::{BindingIdentity, SessionBinding};
use serde_json::{Value, json};

pub(super) fn opt_str(params: &Value, key: &str) -> Result<Option<String>, ProtocolError> {
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

fn opt_u64(params: &Value, key: &str) -> Result<Option<u64>, ProtocolError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or_else(|| {
            ProtocolError::new(
                ErrorCategory::InvalidArgument,
                format!("{key} must be a non-negative integer"),
            )
        }),
        Some(_) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must be a non-negative integer"),
        )),
    }
}

fn bot_list(bot_ids: &Value) -> Result<Vec<String>, ProtocolError> {
    let Some(list) = bot_ids.as_array() else {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "botIds must be an array of bot ids",
        ));
    };
    list.iter()
        .map(|v| {
            v.as_str().map(str::to_string).ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "botIds must be an array of bot ids",
                )
            })
        })
        .collect()
}

fn binding_value(binding: SessionBinding) -> Result<Value, ProtocolError> {
    serde_json::to_value(binding).map_err(json_err)
}

impl ControlPlane {
    pub(super) fn rpc_cli_dispatch_claim(&self, params: &Value) -> Result<Value, ProtocolError> {
        let ids = bot_list(params.get("backendIds").ok_or_else(|| {
            ProtocolError::new(ErrorCategory::InvalidArgument, "backendIds required")
        })?)?;
        self.store
            .claim_cli_dispatches(required_str(params, "hostId")?, &ids)
            .map_err(|e| e.into_protocol())
    }

    pub(super) fn rpc_cli_dispatch_complete(&self, params: &Value) -> Result<Value, ProtocolError> {
        self.store
            .complete_cli_dispatch(
                required_str(params, "conversationId")?,
                required_str(params, "requestId")?,
                required_str(params, "runId")?,
                required_str(params, "hostId")?,
                params.get("text").and_then(Value::as_str),
                params.get("sessionId").and_then(Value::as_str),
                params.get("error").and_then(Value::as_str),
            )
            .map_err(|e| e.into_protocol())
    }

    pub(super) fn rpc_bot_ensure_default(&self) -> Result<Value, ProtocolError> {
        let bot = self
            .store
            .ensure_default_bot()
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(bot).map_err(json_err)
    }

    pub(super) fn rpc_bot_create(&self, params: &Value) -> Result<Value, ProtocolError> {
        let name = required_str(params, "name")?;
        let soul = params
            .get("soul")
            .and_then(Value::as_str)
            .unwrap_or(knorvia_store::DEFAULT_KNORVIA_SOUL);
        let backend_kind = params
            .get("backendKind")
            .and_then(Value::as_str)
            .unwrap_or("kernel");
        let bot = self
            .store
            .create_bot(
                name,
                soul,
                backend_kind,
                params.get("backendBindingId").and_then(Value::as_str),
            )
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(bot).map_err(json_err)
    }

    pub(super) fn rpc_bot_read(&self, params: &Value) -> Result<Value, ProtocolError> {
        let bot = self
            .store
            .read_bot(required_str(params, "botId")?)
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(bot).map_err(json_err)
    }

    pub(super) fn rpc_bot_list(&self) -> Result<Value, ProtocolError> {
        let bots = self.store.list_bots().map_err(|e| e.into_protocol())?;
        serde_json::to_value(bots).map_err(json_err)
    }

    pub(super) fn rpc_bot_update_soul(&self, params: &Value) -> Result<Value, ProtocolError> {
        let bot = self
            .store
            .update_bot_soul(
                required_str(params, "botId")?,
                required_str(params, "soul")?,
                opt_u64(params, "expectedRevision")?,
            )
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(bot).map_err(json_err)
    }

    pub(super) fn rpc_bot_rename(&self, params: &Value) -> Result<Value, ProtocolError> {
        let bot = self
            .store
            .rename_bot(
                required_str(params, "botId")?,
                required_str(params, "name")?,
                opt_u64(params, "expectedRevision")?,
            )
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(bot).map_err(json_err)
    }

    pub(super) fn rpc_room_create(&self, params: &Value) -> Result<Value, ProtocolError> {
        let bot_ids = bot_list(params.get("botIds").ok_or_else(|| {
            ProtocolError::new(ErrorCategory::InvalidArgument, "botIds required")
        })?)?;
        let room = self
            .store
            .create_room(
                params
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("group"),
                required_str(params, "title")?,
                &bot_ids,
            )
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(room).map_err(json_err)
    }

    pub(super) fn rpc_room_ensure_dm(&self, params: &Value) -> Result<Value, ProtocolError> {
        let room = self
            .store
            .ensure_dm(required_str(params, "botId")?)
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(room).map_err(json_err)
    }

    pub(super) fn rpc_room_read(&self, params: &Value) -> Result<Value, ProtocolError> {
        let room = self
            .store
            .read_room(required_str(params, "conversationId")?)
            .map_err(|e| e.into_protocol())?;
        self.room_with_attention(room)
    }

    pub(super) fn rpc_room_list(&self) -> Result<Value, ProtocolError> {
        let rooms = self.store.list_rooms().map_err(|e| e.into_protocol())?;
        let rooms = rooms
            .into_iter()
            .map(|room| self.room_with_attention(room))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!(rooms))
    }

    fn room_with_attention(&self, room: knorvia_store::Room) -> Result<Value, ProtocolError> {
        let (unread, pending) = self
            .store
            .room_attention(&room.id)
            .map_err(|e| e.into_protocol())?;
        let latest = self
            .store
            .latest_room_messages(&room.id, 1)
            .map_err(|e| e.into_protocol())?
            .pop();
        let mut value = serde_json::to_value(room).map_err(json_err)?;
        value["unreadCount"] = json!(unread);
        value["pendingAttention"] = json!(pending.len());
        value["lastMessage"] = latest.map(|message| json!({"content":message.content.chars().take(180).collect::<String>(),"createdAt":message.created_at,"status":message.meta["cliDispatch"]["status"].as_str().unwrap_or(&message.status),"sender":message.sender,"botId":message.bot_id})).unwrap_or(Value::Null);
        Ok(value)
    }

    pub(super) fn rpc_room_checkpoint(&self, params: &Value) -> Result<Value, ProtocolError> {
        let required_seq = |key| {
            opt_u64(params, key)?.ok_or_else(|| {
                ProtocolError::new(ErrorCategory::InvalidArgument, format!("{key} required"))
            })
        };
        let room = self
            .store
            .checkpoint_room(
                required_str(params, "conversationId")?,
                required_str(params, "summary")?,
                required_seq("throughSeq")?,
                required_seq("expectedRevision")?,
            )
            .map_err(|e| e.into_protocol())?;
        self.room_with_attention(room)
    }

    pub(super) fn rpc_room_mark_read(&self, params: &Value) -> Result<Value, ProtocolError> {
        let seq = opt_u64(params, "seq")?
            .ok_or_else(|| ProtocolError::new(ErrorCategory::InvalidArgument, "seq required"))?;
        let room = self
            .store
            .mark_room_read(required_str(params, "conversationId")?, seq)
            .map_err(|e| e.into_protocol())?;
        self.room_with_attention(room)
    }

    pub(super) fn rpc_room_attention_resolve(
        &self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let message = self
            .store
            .resolve_room_attention(
                required_str(params, "conversationId")?,
                required_str(params, "messageId")?,
            )
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(message).map_err(json_err)
    }

    pub(super) fn rpc_room_rename(&self, params: &Value) -> Result<Value, ProtocolError> {
        let room = self
            .store
            .rename_room(
                required_str(params, "conversationId")?,
                required_str(params, "title")?,
                opt_u64(params, "expectedRevision")?,
            )
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(room).map_err(json_err)
    }

    pub(super) fn rpc_room_add_member(&self, params: &Value) -> Result<Value, ProtocolError> {
        let room = self
            .store
            .add_room_member(
                required_str(params, "conversationId")?,
                required_str(params, "botId")?,
                opt_u64(params, "expectedRevision")?,
            )
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(room).map_err(json_err)
    }

    pub(super) fn rpc_room_remove_member(&self, params: &Value) -> Result<Value, ProtocolError> {
        let room = self
            .store
            .remove_room_member(
                required_str(params, "conversationId")?,
                required_str(params, "botId")?,
                opt_u64(params, "expectedRevision")?,
            )
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(room).map_err(json_err)
    }

    /// Resolve (and if needed regenerate) the durable session anchor for one
    /// (bot, conversation, backend). The response states the action taken so
    /// the caller can tell "same session" from "fresh session" and surface a
    /// re-anchor to the user instead of pretending the old chat continues.
    pub(super) fn rpc_session_binding_resolve(
        &self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let host_id = opt_str(params, "hostId")?;
        let account_fingerprint = opt_str(params, "accountFingerprint")?;
        let canonical_cwd = opt_str(params, "canonicalCwd")?;
        let backend_version = opt_str(params, "backendVersion")?;
        let identity = BindingIdentity {
            host_id: host_id.as_deref(),
            account_fingerprint: account_fingerprint.as_deref(),
            canonical_cwd: canonical_cwd.as_deref(),
            backend_version: backend_version.as_deref(),
        };
        let resolved = self
            .store
            .resolve_session_binding(
                required_str(params, "botId")?,
                required_str(params, "conversationId")?,
                required_str(params, "backendBindingId")?,
                identity,
            )
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(resolved).map_err(json_err)
    }

    /// Anchor a resolved binding to an execution session. With
    /// `createThread: true` and a `workspaceId`, the daemon also creates the
    /// fresh product thread in one call — the "re-anchor" path that replaces
    /// any recent-session fallback.
    pub(super) fn rpc_session_binding_attach(
        &mut self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let binding_id = required_str(params, "bindingId")?;
        let create_thread = params
            .get("createThread")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let knorvia_thread_id = if create_thread {
            let workspace_id = required_str(params, "workspaceId")?;
            self.ensure_workspace_runnable(workspace_id)?;
            let title = params
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Bot session");
            let thread = self
                .store
                .create_thread(workspace_id, title, None, None)
                .map_err(|e| e.into_protocol())?;
            let mut settings = super::turns::settings_from_params(params, None)?;
            if settings.cwd.is_none() {
                // Anchor cwd-less bot threads to the workspace cwd the same
                // way plain threads are, so a CLI/kernel session executes in
                // a durable, user-visible location.
                if let Some(cwd) = self
                    .store
                    .read_workspace_cwd(workspace_id)
                    .map_err(|e| e.into_protocol())?
                {
                    settings.cwd = Some(cwd);
                }
            }
            self.executor_lock()
                .configure_thread(&thread.id, &settings)?;
            thread.id
        } else {
            required_str(params, "knorviaThreadId")?.to_string()
        };
        let binding = self
            .store
            .attach_binding_session(
                binding_id,
                &knorvia_thread_id,
                params.get("externalSessionId").and_then(Value::as_str),
                opt_u64(params, "expectedRevision")?,
            )
            .map_err(|e| e.into_protocol())?;
        let mut value = binding_value(binding)?;
        if let Some(object) = value.as_object_mut() {
            object.insert("threadId".to_string(), json!(knorvia_thread_id));
        }
        Ok(value)
    }

    pub(super) fn rpc_session_binding_mark_lost(
        &self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let binding = self
            .store
            .mark_binding_lost(
                required_str(params, "bindingId")?,
                required_str(params, "reason")?,
                opt_u64(params, "expectedRevision")?,
            )
            .map_err(|e| e.into_protocol())?;
        binding_value(binding)
    }

    pub(super) fn rpc_session_binding_record_delivery(
        &self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let seq = opt_u64(params, "seq")?
            .ok_or_else(|| ProtocolError::new(ErrorCategory::InvalidArgument, "seq required"))?;
        let binding = self
            .store
            .record_binding_delivery(
                required_str(params, "bindingId")?,
                seq,
                opt_u64(params, "expectedRevision")?,
            )
            .map_err(|e| e.into_protocol())?;
        binding_value(binding)
    }

    pub(super) fn rpc_session_binding_read(&self, params: &Value) -> Result<Value, ProtocolError> {
        let binding = self
            .store
            .read_binding(required_str(params, "bindingId")?)
            .map_err(|e| e.into_protocol())?;
        binding_value(binding)
    }

    pub(super) fn rpc_session_binding_list(&self, params: &Value) -> Result<Value, ProtocolError> {
        let bindings = self
            .store
            .list_bindings(
                opt_str(params, "botId")?.as_deref(),
                opt_str(params, "conversationId")?.as_deref(),
            )
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(bindings).map_err(json_err)
    }
}
