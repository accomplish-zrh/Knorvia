//! CLI dispatch intents live in the room journal, never in a volatile queue.
use super::*;
use serde_json::json;

fn job_status(message: &RoomMessage) -> &str {
    message.meta["cliDispatch"]["status"].as_str().unwrap_or("")
}

impl ProductStore {
    fn cli_messages_locked(&self, conversation_id: &str) -> Result<Vec<RoomMessage>, StoreError> {
        let mut messages = Vec::new();
        let dir = chat_dir(self, conversation_id);
        if !dir.exists() {
            return Ok(messages);
        }
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let message: RoomMessage = super::super::read_json(&path)?;
            if message.conversation_id != conversation_id {
                return Err(StoreError::Corrupt(
                    "CLI message scope mismatch".to_string(),
                ));
            }
            if message.meta.get("cliDispatch").is_some() {
                messages.push(message);
            }
        }
        messages.sort_by_key(|message| message.seq);
        Ok(messages)
    }

    fn write_cli_message_locked(&self, message: &RoomMessage) -> Result<(), StoreError> {
        let write = self.projection_write(ProjectionKind::ChatMessage, &message.id, message)?;
        self.commit_transaction_locked(
            &chat_stream(&message.conversation_id),
            "chat.cliDispatchUpdated",
            serde_json::to_value(message)?,
            None,
            vec![write],
        )?;
        Ok(())
    }

    pub fn room_cli_dispatches(
        &self,
        conversation_id: &str,
        binding_id: &str,
    ) -> Result<Vec<RoomMessage>, StoreError> {
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.read_room_locked(conversation_id)?;
        Ok(self
            .cli_messages_locked(conversation_id)?
            .into_iter()
            .filter(|message| message.meta["bindingId"].as_str() == Some(binding_id))
            .collect())
    }

    pub fn claim_cli_dispatches(
        &self,
        host_id: &str,
        backend_ids: &[String],
    ) -> Result<Value, StoreError> {
        if host_id.trim().is_empty() {
            return Err(invalid("hostId required"));
        }
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut jobs = Vec::new();
        let mut cancels = Vec::new();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        for room in self.list_rooms_locked()? {
            for mut message in self.cli_messages_locked(&room.id)? {
                let status = job_status(&message).to_string();
                if status == "canceled"
                    && message.meta["cliDispatch"]["hostId"].as_str() == Some(host_id)
                {
                    cancels.push(message.meta["cliDispatch"]["runId"].clone());
                }
                if !matches!(status.as_str(), "queued" | "claimed") {
                    continue;
                }
                let turn_id = message.meta["turnId"]
                    .as_str()
                    .ok_or_else(|| invalid("CLI job has no owning turn"))?;
                let owning_turn: crate::Turn = super::super::read_json(&self.turn_path(turn_id))?;
                if owning_turn.status != "running"
                    || message.meta["cliDispatch"]["deadlineMs"]
                        .as_u64()
                        .is_some_and(|deadline| now >= deadline)
                {
                    message.meta["cliDispatch"]["status"] = json!("canceled");
                    message.meta["needsUser"] = json!(true);
                    message.content =
                        "CLI 调用已停止或经过恢复；结果未知，不会自动重试。".to_string();
                    if message.meta["cliDispatch"]["hostId"].as_str() == Some(host_id) {
                        cancels.push(message.meta["cliDispatch"]["runId"].clone());
                    }
                    self.write_cli_message_locked(&message)?;
                    continue;
                }
                if status != "queued" || !jobs.is_empty() {
                    continue;
                }
                let backend = message.meta["cliDispatch"]["backendId"]
                    .as_str()
                    .unwrap_or("");
                if !backend_ids.iter().any(|id| id == backend) {
                    continue;
                }
                message.meta["cliDispatch"]["status"] = json!("claimed");
                message.meta["cliDispatch"]["hostId"] = json!(host_id);
                message.meta["cliDispatch"]["claimedAt"] = json!(now_rfc3339());
                self.write_cli_message_locked(&message)?;
                let mut job = message.meta["cliDispatch"].clone();
                job["conversationId"] = json!(message.conversation_id);
                job["bindingId"] = message.meta["bindingId"].clone();
                jobs.push(job);
            }
        }
        Ok(json!({"jobs": jobs, "cancels": cancels}))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn complete_cli_dispatch(
        &self,
        conversation_id: &str,
        request_id: &str,
        run_id: &str,
        host_id: &str,
        text: Option<&str>,
        session_id: Option<&str>,
        error: Option<&str>,
    ) -> Result<Value, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.read_room_locked(conversation_id)?;
        let mut message = self
            .cli_messages_locked(conversation_id)?
            .into_iter()
            .find(|message| message.meta["cliDispatch"]["requestId"].as_str() == Some(request_id))
            .ok_or_else(|| not_found("CLI dispatch", request_id))?;
        if message.meta["cliDispatch"]["runId"].as_str() != Some(run_id)
            || message.meta["cliDispatch"]["hostId"].as_str() != Some(host_id)
        {
            return Err(conflict("CLI dispatch claim owner does not match"));
        }
        let status = job_status(&message).to_string();
        if matches!(status.as_str(), "completed" | "failed" | "canceled") {
            return Ok(json!({"accepted": true, "status": status}));
        }
        if status != "claimed" {
            return Err(conflict("CLI dispatch was not claimed"));
        }
        let turn_id = message.meta["turnId"]
            .as_str()
            .ok_or_else(|| invalid("CLI job has no owning turn"))?;
        let owning_turn: crate::Turn = super::super::read_json(&self.turn_path(turn_id))?;
        if owning_turn.status != "running" {
            message.meta["cliDispatch"]["status"] = json!("canceled");
            message.meta["needsUser"] = json!(true);
            message.content = "原调用已终止或经过恢复；迟到回执不会覆盖终态。".to_string();
            self.write_cli_message_locked(&message)?;
            return Ok(json!({"accepted": true, "status": "canceled"}));
        }
        let expected_session = message.meta["cliDispatch"]["sessionId"].as_str();
        let failure = error
            .filter(|error| !error.is_empty())
            .map(str::to_string)
            .or_else(|| {
                if text.is_none_or(|text| text.trim().is_empty())
                    || session_id.is_none_or(|id| id.trim().is_empty())
                {
                    Some("CLI 未返回有效回答与会话标识；结果未知，不自动重跑。".to_string())
                } else if expected_session.is_some() && expected_session != session_id {
                    Some("CLI 返回了不同的会话；原锚点保持不变。".to_string())
                } else {
                    None
                }
            });
        let status = if failure.is_some() {
            "failed"
        } else {
            "completed"
        };
        message.meta["cliDispatch"]["status"] = json!(status);
        message.meta["cliDispatch"]["resultSessionId"] = json!(session_id);
        message.meta["cliDispatch"]["completedAt"] = json!(now_rfc3339());
        // Output stays durable even if the daemon dies before acknowledging it.
        if let Some(failure) = failure {
            message.content = failure.chars().take(4000).collect();
            message.meta["needsUser"] = json!(true);
        } else {
            let text = text.unwrap();
            if text.len() > 4 * 1024 * 1024 {
                return Err(invalid("CLI output exceeds 4 MiB"));
            }
            message.sender = "bot".to_string();
            message.bot_id = message.meta["cliDispatch"]["botId"]
                .as_str()
                .map(str::to_string);
            message.content = text.to_string();
        }
        let mut writes =
            vec![self.projection_write(ProjectionKind::ChatMessage, &message.id, &message)?];
        if status == "completed" {
            let answer = RoomMessage {
                id: new_id("msg"),
                conversation_id: conversation_id.to_string(),
                seq: self.next_event_sequence_locked(&chat_stream(conversation_id))?,
                sender: "bot".to_string(),
                bot_id: message.bot_id.clone(),
                content: message.content.clone(),
                created_at: now_rfc3339(),
                message_id: None,
                correlation_id: None,
                reply_to_message_id: None,
                source_room_id: None,
                target_bot_id: None,
                artifact_refs: Vec::new(),
                hop_count: 0,
                status: "appended".to_string(),
                meta: json!({"bindingId":message.meta["bindingId"],"upToSeq":message.meta["upToSeq"],"turnId":message.meta["turnId"],"soulRevision":message.meta["soulRevision"],"cliResultFor":request_id}),
            };
            writes.push(self.projection_write(ProjectionKind::ChatMessage, &answer.id, &answer)?);
        }
        self.commit_transaction_locked(
            &chat_stream(conversation_id),
            "chat.cliDispatchCompleted",
            serde_json::to_value(&message)?,
            None,
            writes,
        )?;
        Ok(json!({"accepted": true, "status": status}))
    }

    pub fn cancel_cli_dispatch(
        &self,
        conversation_id: &str,
        request_id: &str,
    ) -> Result<(), StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.read_room_locked(conversation_id)?;
        let mut message = self
            .cli_messages_locked(conversation_id)?
            .into_iter()
            .find(|message| message.meta["cliDispatch"]["requestId"].as_str() == Some(request_id))
            .ok_or_else(|| not_found("CLI dispatch", request_id))?;
        if !matches!(job_status(&message), "queued" | "claimed") {
            return Ok(());
        }
        message.meta["cliDispatch"]["status"] = json!("canceled");
        message.meta["needsUser"] = json!(true);
        message.content = "CLI 调用已停止；不自动重发，请确认执行结果。".to_string();
        self.write_cli_message_locked(&message)
    }
}
