//! Persistent room chat: per-conversation message sequences, delivery
//! envelopes for bot-to-bot transfers, and consumption bookkeeping.
//!
//! Every conversation owns an event stream `chat-<conversationId>`; a
//! message's stable `seq` is that stream's sequence. Session bindings store
//! `lastDeliveredSeq`, so the scheduler can always recompute the exact
//! un-delivered suffix after a crash — never re-delivering finished messages,
//! never silently re-sending ones whose outcome is unknown.

use super::durable::{EventDraft, ProjectionKind};
use super::{ProductStore, StoreError, conflict, invalid, new_id, not_found, now_rfc3339};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;

#[path = "room_cli_jobs.rs"]
mod room_cli_jobs;

/// Per-room limits. A mention round dispatches at most this many bots, and a
/// transfer chain stops after this many hops / per-correlation transfers.
pub const MAX_MESSAGES_RETURNED: usize = 200;
pub const MAX_TRANSFER_HOPS: u32 = 3;
pub const MAX_TRANSFERS_PER_CORRELATION: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoomMessage {
    pub id: String,
    pub conversation_id: String,
    /// Stable, dense-per-conversation sequence from the chat event stream.
    pub seq: u64,
    /// "user" | "bot" | "system".
    pub sender: String,
    pub bot_id: Option<String>,
    pub content: String,
    pub created_at: String,
    // ---- transfer envelope (A07). Present on inter-bot transfers only. ----
    /// Stable cross-conversation identity; duplicate ids are idempotent no-ops.
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub correlation_id: Option<String>,
    #[serde(default)]
    pub reply_to_message_id: Option<String>,
    /// Where the envelope came from, so a reply lands in the source room.
    #[serde(default)]
    pub source_room_id: Option<String>,
    #[serde(default)]
    pub target_bot_id: Option<String>,
    #[serde(default)]
    pub artifact_refs: Vec<String>,
    #[serde(default)]
    pub hop_count: u32,
    /// "appended" | "delivered" | "acked" | "failed".
    pub status: String,
    /// Scheduler bookkeeping: pinned soulRevision, turnId, bindingId.
    #[serde(default)]
    pub meta: Value,
}

fn chat_stream(conversation_id: &str) -> String {
    format!("chat-{conversation_id}")
}

pub(super) fn chat_dir(store: &ProductStore, conversation_id: &str) -> std::path::PathBuf {
    store.product_dir().join("room-chat").join(conversation_id)
}

fn chat_message_path(
    store: &ProductStore,
    conversation_id: &str,
    seq: u64,
    id: &str,
) -> std::path::PathBuf {
    chat_dir(store, conversation_id).join(format!("{seq:020}-{id}.json"))
}

#[derive(Debug, Clone)]
pub struct RoomMessageInput<'a> {
    pub sender: &'a str,
    pub bot_id: Option<&'a str>,
    pub content: &'a str,
    pub reply_to_message_id: Option<&'a str>,
    pub correlation_id: Option<&'a str>,
    pub source_room_id: Option<&'a str>,
    pub target_bot_id: Option<&'a str>,
    pub artifact_refs: Vec<String>,
    pub hop_count: u32,
    pub transfer_message_id: Option<&'a str>,
    pub meta: Value,
}

impl<'a> RoomMessageInput<'a> {
    pub fn user_message(content: &'a str) -> Self {
        Self {
            sender: "user",
            bot_id: None,
            content,
            reply_to_message_id: None,
            correlation_id: None,
            source_room_id: None,
            target_bot_id: None,
            artifact_refs: Vec::new(),
            hop_count: 0,
            transfer_message_id: None,
            meta: Value::Null,
        }
    }
}

fn validate_sender(sender: &str) -> Result<(), StoreError> {
    match sender {
        "user" | "bot" | "system" => Ok(()),
        other => Err(invalid(format!(
            "sender must be user, bot or system, not {other:?}"
        ))),
    }
}

impl ProductStore {
    pub fn mark_room_read(
        &self,
        conversation_id: &str,
        seq: u64,
    ) -> Result<super::Room, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut room = self.read_room_locked(conversation_id)?;
        if seq > self.room_chat_head_locked(conversation_id)? {
            return Err(invalid(
                "read sequence is beyond this conversation's transcript",
            ));
        }
        if seq <= room.read_seq {
            return Ok(room);
        }
        room.read_seq = seq;
        // Reading is not a metadata edit: it must not invalidate an open editor.
        let write = self.projection_write(ProjectionKind::Room, &room.id, &room)?;
        self.commit_transaction_locked(
            super::bots::SOCIAL_STREAM,
            "room.read",
            serde_json::to_value(&room)?,
            None,
            vec![write],
        )?;
        Ok(room)
    }

    pub fn checkpoint_room(
        &self,
        conversation_id: &str,
        summary: &str,
        through_seq: u64,
        expected_revision: u64,
    ) -> Result<super::Room, StoreError> {
        if summary.trim().is_empty() || summary.len() > 16_000 {
            return Err(invalid(
                "checkpoint summary must contain 1–16000 UTF-8 bytes",
            ));
        }
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut room = self.read_room_locked(conversation_id)?;
        if room.revision != expected_revision {
            return Err(conflict(
                "room revision changed; reload before saving a checkpoint",
            ));
        }
        if through_seq == 0 || through_seq > self.room_chat_head_locked(conversation_id)? {
            return Err(invalid(
                "checkpoint must cover existing messages in this conversation",
            ));
        }
        if room
            .checkpoints
            .last()
            .is_some_and(|last| through_seq < last.through_seq)
        {
            return Err(conflict("checkpoint coverage cannot move backwards"));
        }
        let version = room.checkpoints.last().map_or(1, |last| last.version + 1);
        room.checkpoints.push(super::bots::RoomCheckpoint {
            version,
            through_seq,
            summary: summary.trim().to_string(),
            created_at: now_rfc3339(),
        });
        if room.checkpoints.len() > 20 {
            room.checkpoints.remove(0);
        }
        room.revision += 1;
        room.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Room, &room.id, &room)?;
        self.commit_transaction_locked(
            super::bots::SOCIAL_STREAM,
            "room.checkpointed",
            serde_json::to_value(&room)?,
            None,
            vec![write],
        )?;
        Ok(room)
    }

    /// Durable pending items remain until explicitly acknowledged. Reading a
    /// room never clears an interrupted/failed attempt on the user's behalf.
    pub fn room_attention(
        &self,
        conversation_id: &str,
    ) -> Result<(u64, Vec<RoomMessage>), StoreError> {
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let room = self.read_room_locked(conversation_id)?;
        let dir = chat_dir(self, conversation_id);
        let mut unread = 0;
        let mut pending = Vec::new();
        if dir.exists() {
            for entry in fs::read_dir(dir)? {
                let path = entry?.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let message: RoomMessage = super::read_json(&path)?;
                if message.conversation_id != conversation_id {
                    return Err(StoreError::Corrupt(
                        "room message scope mismatch".to_string(),
                    ));
                }
                if message.seq > room.read_seq
                    && message.sender != "user"
                    && message.meta["hidden"] != true
                {
                    unread += 1;
                }
                if message.meta.get("needsUser").and_then(Value::as_bool) == Some(true)
                    && message.meta.get("attentionResolvedAt").is_none()
                {
                    pending.push(message);
                }
            }
        }
        pending.sort_by_key(|message| message.seq);
        Ok((unread, pending))
    }

    pub fn resolve_room_attention(
        &self,
        conversation_id: &str,
        message_id: &str,
    ) -> Result<RoomMessage, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.read_room_locked(conversation_id)?;
        let dir = chat_dir(self, conversation_id);
        if dir.exists() {
            for entry in fs::read_dir(dir)? {
                let path = entry?.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let mut message: RoomMessage = super::read_json(&path)?;
                if message.id != message_id {
                    continue;
                }
                if message.conversation_id != conversation_id {
                    return Err(StoreError::Corrupt(
                        "room message scope mismatch".to_string(),
                    ));
                }
                if message.meta.get("needsUser").and_then(Value::as_bool) != Some(true) {
                    return Err(invalid("message does not need user attention"));
                }
                if message.meta.get("attentionResolvedAt").is_some() {
                    return Ok(message);
                }
                message.meta["attentionResolvedAt"] = Value::String(now_rfc3339());
                let write =
                    self.projection_write(ProjectionKind::ChatMessage, &message.id, &message)?;
                self.commit_transaction_locked(
                    &chat_stream(conversation_id),
                    "chat.attentionResolved",
                    serde_json::to_value(&message)?,
                    None,
                    vec![write],
                )?;
                return Ok(message);
            }
        }
        Err(not_found("pending room message", message_id))
    }

    /// Append one message to a conversation. The message's `seq` is taken
    /// from the conversation's chat stream inside the same transaction that
    /// writes the projection, so a crash can never skip or reuse a number.
    pub fn append_room_message(
        &self,
        conversation_id: &str,
        input: RoomMessageInput<'_>,
    ) -> Result<RoomMessage, StoreError> {
        validate_sender(input.sender)?;
        if input.content.trim().is_empty() {
            return Err(invalid("message content must not be empty"));
        }
        if input.sender == "bot" && input.bot_id.is_none() {
            return Err(invalid("bot messages must name their bot"));
        }
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.read_room_locked(conversation_id)?;
        if let Some(bot_id) = input.bot_id {
            self.read_bot_locked(bot_id)?;
        }

        let stream_id = chat_stream(conversation_id);
        let seq = self.next_event_sequence_locked(&stream_id)?;
        let message = RoomMessage {
            id: new_id("msg"),
            conversation_id: conversation_id.to_string(),
            seq,
            sender: input.sender.to_string(),
            bot_id: input.bot_id.map(str::to_string),
            content: input.content.to_string(),
            created_at: now_rfc3339(),
            message_id: input.transfer_message_id.map(str::to_string),
            correlation_id: input.correlation_id.map(str::to_string),
            reply_to_message_id: input.reply_to_message_id.map(str::to_string),
            source_room_id: input.source_room_id.map(str::to_string),
            target_bot_id: input.target_bot_id.map(str::to_string),
            artifact_refs: input.artifact_refs,
            hop_count: input.hop_count,
            status: "appended".to_string(),
            meta: input.meta,
        };
        let write = self.projection_write(ProjectionKind::ChatMessage, &message.id, &message)?;
        self.commit_transaction_locked(
            &stream_id,
            "chat.appended",
            serde_json::to_value(&message)?,
            None,
            vec![write],
        )?;
        Ok(message)
    }

    /// Read a window of the transcript. `fromSeq` is inclusive so callers
    /// can resume exactly at their watermark.
    pub fn list_room_messages(
        &self,
        conversation_id: &str,
        from_seq: u64,
        limit: usize,
    ) -> Result<Vec<RoomMessage>, StoreError> {
        self.room_message_window(conversation_id, from_seq, limit, false)
    }

    pub fn latest_room_messages(
        &self,
        conversation_id: &str,
        limit: usize,
    ) -> Result<Vec<RoomMessage>, StoreError> {
        self.room_message_window(conversation_id, 0, limit, true)
    }

    fn room_message_window(
        &self,
        conversation_id: &str,
        from_seq: u64,
        limit: usize,
        latest: bool,
    ) -> Result<Vec<RoomMessage>, StoreError> {
        let limit = limit.clamp(1, MAX_MESSAGES_RETURNED);
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.read_room_locked(conversation_id)?;
        let dir = chat_dir(self, conversation_id);
        let mut messages = Vec::new();
        if !dir.exists() {
            return Ok(messages);
        }
        let mut paths = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let seq = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.split('-').next())
                .and_then(|seq| seq.parse::<u64>().ok());
            if seq.is_some_and(|seq| seq >= from_seq) {
                paths.push(path);
            }
        }
        paths.sort();
        if latest {
            paths.reverse();
        }
        for path in paths.into_iter().take(limit) {
            let message: RoomMessage = super::read_json(&path)?;
            if message.conversation_id != conversation_id {
                return Err(StoreError::Corrupt(format!(
                    "chat message {} claims conversation {} but lives in {conversation_id}",
                    message.id, message.conversation_id
                )));
            }
            if message.seq >= from_seq {
                messages.push(message);
            }
        }
        messages.sort_by_key(|message| message.seq);
        if messages.len() > limit {
            messages.truncate(limit);
        }
        Ok(messages)
    }

    /// Latest message sequence for a conversation, or 0 for an empty one.
    /// Bindings watermark against this number.
    pub fn room_chat_head(&self, conversation_id: &str) -> Result<u64, StoreError> {
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.read_room_locked(conversation_id)?;
        self.room_chat_head_locked(conversation_id)
    }

    fn room_chat_head_locked(&self, conversation_id: &str) -> Result<u64, StoreError> {
        let dir = chat_dir(self, conversation_id);
        if !dir.exists() {
            return Ok(0);
        }
        let mut head = 0u64;
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !name.ends_with(".json") {
                continue;
            }
            if let Some(seq) = name.split('-').next().and_then(|s| s.parse::<u64>().ok()) {
                head = head.max(seq);
            }
        }
        Ok(head)
    }

    /// Update the delivery lifecycle of a transfer envelope. Status only
    /// moves forward: appended → delivered → acked, or appended → failed.
    pub fn mark_room_message_status(
        &self,
        conversation_id: &str,
        message_id: &str,
        status: &str,
    ) -> Result<RoomMessage, StoreError> {
        match status {
            "delivered" | "acked" | "failed" => {}
            other => {
                return Err(invalid(format!(
                    "status must be delivered, acked or failed, not {other:?}"
                )));
            }
        }
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut message = self
            .find_room_message_by_message_id(conversation_id, message_id)?
            .ok_or_else(|| not_found("chat message", message_id))?;
        let rank = |status: &str| match status {
            "appended" => 0u8,
            "delivered" => 1,
            "acked" => 2,
            _ => 3,
        };
        if rank(status) <= rank(&message.status) && message.status != "failed" {
            return Ok(message);
        }
        if message.status == "acked" && status != "acked" {
            return Err(conflict("an acked transfer envelope is terminal"));
        }
        message.status = status.to_string();
        let write = self.projection_write(ProjectionKind::ChatMessage, &message.id, &message)?;
        self.commit_transaction_locked(
            &chat_stream(conversation_id),
            "chat.statusUpdated",
            serde_json::to_value(&message)?,
            None,
            vec![write],
        )?;
        Ok(message)
    }

    /// Delivery-window idempotency gate (A09): did a previous dispatch of
    /// this exact binding already produce an outcome for messages up to
    /// `up_to_seq`? A crash after the answer landed but before the watermark
    /// advanced must not run a second turn for the same suffix — the first
    /// outcome stays the only outcome, and the caller only re-watermarks.
    pub fn find_dispatch_outcome(
        &self,
        conversation_id: &str,
        binding_id: &str,
        up_to_seq: u64,
    ) -> Result<Option<RoomMessage>, StoreError> {
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let dir = chat_dir(self, conversation_id);
        if !dir.exists() {
            return Ok(None);
        }
        let mut found: Option<RoomMessage> = None;
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let message: RoomMessage = super::read_json(&path)?;
            let matches_binding =
                message.meta.get("bindingId").and_then(Value::as_str) == Some(binding_id);
            let matches_window =
                message.meta.get("upToSeq").and_then(Value::as_u64) == Some(up_to_seq);
            if matches_binding && matches_window {
                found = Some(message);
                break;
            }
        }
        Ok(found)
    }

    fn find_room_message_by_message_id(
        &self,
        conversation_id: &str,
        message_id: &str,
    ) -> Result<Option<RoomMessage>, StoreError> {
        let dir = chat_dir(self, conversation_id);
        if !dir.exists() {
            return Ok(None);
        }
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let message: RoomMessage = super::read_json(&path)?;
            if message.message_id.as_deref() == Some(message_id) {
                return Ok(Some(message));
            }
        }
        Ok(None)
    }

    fn count_transfers_for_correlation(&self, correlation_id: &str) -> Result<usize, StoreError> {
        // Transfers may land in any target conversation, so the budget scan
        // walks every conversation's chat directory. Correlations are capped
        // tiny and rooms are few; this stays a bounded, local scan.
        let root = self.product_dir().join("room-chat");
        if !root.exists() {
            return Ok(0);
        }
        let mut count = 0usize;
        for room_entry in fs::read_dir(&root)? {
            let room_entry = room_entry?;
            if !room_entry.path().is_dir() {
                continue;
            }
            for entry in fs::read_dir(room_entry.path())? {
                let entry = entry?;
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let message: RoomMessage = super::read_json(&path)?;
                if message.correlation_id.as_deref() == Some(correlation_id)
                    && message.message_id.is_some()
                {
                    count += 1;
                }
            }
        }
        Ok(count)
    }

    /// Bot-to-bot transfer (A07): append an envelope addressed to a target
    /// bot. The envelope lands in the target bot's DM conversation so its
    /// scheduler picks it up there, the reply path records the source room,
    /// duplicate `messageId`s are idempotent no-ops, and the hop/correlation
    /// budgets stop mutual-awakening loops before they start.
    #[allow(clippy::too_many_arguments)]
    pub fn send_room_transfer(
        &self,
        target_bot_id: &str,
        sender: &str,
        sender_bot_id: Option<&str>,
        content: &str,
        correlation_id: &str,
        reply_to_message_id: Option<&str>,
        source_room_id: &str,
        artifact_refs: Vec<String>,
        hop_count: u32,
        transfer_message_id: &str,
    ) -> Result<(RoomMessage, bool), StoreError> {
        if content.trim().is_empty() {
            return Err(invalid("transfer content must not be empty"));
        }
        validate_sender(sender)?;
        if sender == "bot" && sender_bot_id.is_none() {
            return Err(invalid(
                "bot-originated transfers must name the sending bot",
            ));
        }
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.read_bot_locked(target_bot_id)?;
        if let Some(sender_bot_id) = sender_bot_id {
            self.read_bot_locked(sender_bot_id)?;
        }
        self.read_room_locked(source_room_id)?;
        // Loop budget: a transfer chain may not deepen past MAX_TRANSFER_HOPS
        // and one correlation may not spawn unbounded deliveries.
        if hop_count > MAX_TRANSFER_HOPS {
            return Err(conflict(format!(
                "transfer hop budget exhausted: {hop_count} > {MAX_TRANSFER_HOPS}"
            )));
        }
        let correlation_transfers = self.count_transfers_for_correlation(correlation_id)?;
        if correlation_transfers >= MAX_TRANSFERS_PER_CORRELATION {
            return Err(conflict(format!(
                "transfer correlation budget exhausted: {correlation_transfers} >= {MAX_TRANSFERS_PER_CORRELATION}"
            )));
        }
        // Idempotency by messageId: the same envelope (crash retry, duplicate
        // wake) must not produce a second side effect.
        if let Some(existing) = self.find_room_message_by_message_id(
            &self.ensure_dm_locked(target_bot_id)?.id,
            transfer_message_id,
        )? {
            return Ok((existing, false));
        }

        let dm = self.ensure_dm_locked(target_bot_id)?;
        let stream_id = chat_stream(&dm.id);
        let seq = self.next_event_sequence_locked(&stream_id)?;
        let message = RoomMessage {
            id: new_id("msg"),
            conversation_id: dm.id,
            seq,
            sender: sender.to_string(),
            bot_id: sender_bot_id.map(str::to_string),
            content: content.to_string(),
            created_at: now_rfc3339(),
            message_id: Some(transfer_message_id.to_string()),
            correlation_id: Some(correlation_id.to_string()),
            reply_to_message_id: reply_to_message_id.map(str::to_string),
            source_room_id: Some(source_room_id.to_string()),
            target_bot_id: Some(target_bot_id.to_string()),
            artifact_refs,
            hop_count,
            status: "appended".to_string(),
            meta: Value::Null,
        };
        let write = self.projection_write(ProjectionKind::ChatMessage, &message.id, &message)?;
        self.commit_transaction_batch_locked(
            &stream_id,
            vec![EventDraft::new(
                "chat.appended",
                serde_json::to_value(&message)?,
            )],
            vec![write],
        )?;
        Ok((message, true))
    }

    /// `ensure_dm` without re-acquiring the mutation lock (callers above
    /// already hold it).
    fn ensure_dm_locked(&self, bot_id: &str) -> Result<super::Room, StoreError> {
        for room in self.list_rooms_locked()? {
            if room.kind == "dm" && room.members.len() == 1 && room.members[0].bot_id == bot_id {
                return Ok(room);
            }
        }
        let bot = self.read_bot_locked(bot_id)?;
        let now = now_rfc3339();
        let room = super::Room {
            id: new_id("room"),
            read_seq: 0,
            checkpoints: Vec::new(),
            kind: "dm".to_string(),
            title: format!("DM · {}", bot.name),
            members: vec![super::RoomMember {
                bot_id: bot_id.to_string(),
                role: "member".to_string(),
                added_at: now.clone(),
            }],
            created_at: now.clone(),
            updated_at: now,
            revision: 1,
        };
        let write = self.projection_write(ProjectionKind::Room, &room.id, &room)?;
        self.commit_transaction_locked(
            super::bots::SOCIAL_STREAM,
            "room.created",
            serde_json::to_value(&room)?,
            None,
            vec![write],
        )?;
        Ok(room)
    }
}

#[cfg(test)]
#[path = "room_chat_tests.rs"]
mod room_chat_tests;

#[cfg(test)]
#[path = "room_chat_crash_tests.rs"]
mod room_chat_crash_tests;
