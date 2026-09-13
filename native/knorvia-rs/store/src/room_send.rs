//! Admission receipt, user message and pending queue commit in one existing WAL transaction.
use super::*;
use crate::durable::ProjectionKind;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSendWork {
    pub bot_id: String,
    pub conversation_id: String,
    pub reservation_key: String,
    pub via_transfer: bool,
    pub status: String,
    pub error: Option<String>,
    pub up_to_seq: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSendReceipt {
    pub id: String,
    pub fingerprint: String,
    pub user_message: RoomMessage,
    pub workspace_id: String,
    pub account_fingerprint: Option<String>,
    pub timeout_secs: u64,
    pub work: Vec<RoomSendWork>,
    pub status: String,
}
impl ProductStore {
    pub(super) fn room_send_path(&self, id: &str) -> PathBuf {
        self.product_dir()
            .join("room-sends")
            .join(format!("{id}.json"))
    }
    pub fn read_room_send(&self, id: &str) -> Result<Option<RoomSendReceipt>, StoreError> {
        if !id.starts_with("send_") || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(invalid("invalid send receipt id"));
        }
        self.recover_durable_state()?;
        let path = self.room_send_path(id);
        if !path.exists() {
            return Ok(None);
        }
        let receipt: RoomSendReceipt = read_json(&path)?;
        if receipt.id != id {
            return Err(StoreError::Corrupt("send receipt identity mismatch".into()));
        }
        Ok(Some(receipt))
    }
    fn pending_room_send_count(&self) -> Result<usize, StoreError> {
        let directory = self.product_dir().join("room-sends");
        if !directory.exists() {
            return Ok(0);
        }
        let mut count = 0;
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let receipt: RoomSendReceipt = read_json(&entry.path())?;
            if receipt
                .work
                .iter()
                .any(|w| matches!(w.status.as_str(), "queued" | "running"))
            {
                count += 1;
            }
            if count >= 128 {
                break;
            }
        }
        Ok(count)
    }
    pub fn accept_room_send(
        &self,
        id: &str,
        fingerprint: &str,
        conversation_id: &str,
        content: &str,
        workspace_id: &str,
        account_fingerprint: Option<String>,
        timeout_secs: u64,
        work: Vec<RoomSendWork>,
    ) -> Result<RoomSendReceipt, StoreError> {
        self.accept_room_send_with_meta(
            id,
            fingerprint,
            conversation_id,
            content,
            workspace_id,
            account_fingerprint,
            timeout_secs,
            work,
            serde_json::json!({}),
        )
    }

    pub fn accept_room_send_with_meta(
        &self,
        id: &str,
        fingerprint: &str,
        conversation_id: &str,
        content: &str,
        workspace_id: &str,
        account_fingerprint: Option<String>,
        timeout_secs: u64,
        mut work: Vec<RoomSendWork>,
        mut message_meta: serde_json::Value,
    ) -> Result<RoomSendReceipt, StoreError> {
        if !id.starts_with("send_") || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(invalid("invalid send receipt id"));
        }
        if content.trim().is_empty() || content.len() > 16_000 || work.len() > 5 {
            return Err(invalid(
                "send requires 1..16000 content bytes and at most 5 planned bots",
            ));
        }
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let path = self.room_send_path(id);
        if path.exists() {
            let receipt: RoomSendReceipt = read_json(&path)?;
            if receipt.fingerprint != fingerprint {
                return Err(conflict("send key already belongs to different request"));
            }
            return Ok(receipt);
        }
        self.read_room_locked(conversation_id)?;
        self.read_workspace(workspace_id)?;
        for item in &work {
            self.read_bot_locked(&item.bot_id)?;
            if !item.via_transfer {
                self.read_room_locked(&item.conversation_id)?;
            }
        }
        if self.pending_room_send_count()? >= 128 {
            return Err(conflict("room send queue is full (128 pending receipts)"));
        }
        let Some(meta) = message_meta.as_object_mut() else {
            return Err(invalid("room send message metadata must be an object"));
        };
        meta.insert("sendReceiptId".into(), serde_json::Value::String(id.into()));
        let stream = format!("chat-{conversation_id}");
        let seq = self.next_event_sequence_locked(&stream)?;
        let message = RoomMessage {
            id: new_id("msg"),
            conversation_id: conversation_id.into(),
            seq,
            sender: "user".into(),
            bot_id: None,
            content: content.into(),
            created_at: now_rfc3339(),
            message_id: None,
            correlation_id: None,
            reply_to_message_id: None,
            source_room_id: None,
            target_bot_id: None,
            artifact_refs: vec![],
            hop_count: 0,
            status: "appended".into(),
            meta: message_meta,
        };
        for item in &mut work {
            if !item.via_transfer {
                item.up_to_seq = seq;
            }
        }
        let pending = !work.is_empty();
        let receipt = RoomSendReceipt {
            id: id.into(),
            fingerprint: fingerprint.into(),
            user_message: message.clone(),
            workspace_id: workspace_id.into(),
            account_fingerprint,
            timeout_secs,
            work,
            status: if pending { "queued" } else { "completed" }.into(),
        };
        let writes = vec![
            self.projection_write(ProjectionKind::ChatMessage, &message.id, &message)?,
            self.projection_write(ProjectionKind::RoomSend, id, &receipt)?,
        ];
        self.commit_transaction_locked(
            &stream,
            "chat.appended",
            serde_json::to_value(&message)?,
            None,
            writes,
        )?;
        Ok(receipt)
    }
    pub fn update_room_send(
        &self,
        id: &str,
        change: impl FnOnce(&mut RoomSendReceipt),
    ) -> Result<RoomSendReceipt, StoreError> {
        if !id.starts_with("send_") || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(invalid("invalid send receipt id"));
        }
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut receipt: RoomSendReceipt = read_json(&self.room_send_path(id))?;
        change(&mut receipt);
        receipt.status = if receipt.work.iter().any(|w| w.status == "running") {
            "running"
        } else if receipt
            .work
            .iter()
            .any(|w| w.status == "needs_check" || w.status == "failed")
        {
            "partial"
        } else if receipt.work.iter().any(|w| w.status == "queued") {
            "queued"
        } else {
            "completed"
        }
        .into();
        self.commit_transaction_locked(
            &format!("chat-{}", receipt.user_message.conversation_id),
            "room.send.updated",
            serde_json::to_value(&receipt)?,
            None,
            vec![self.projection_write(ProjectionKind::RoomSend, id, &receipt)?],
        )?;
        Ok(receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn message_receipt_and_queue_recover_together_from_wal_boundaries() {
        for point in [
            durable::DurableFailpoint::AfterIntentPersisted,
            durable::DurableFailpoint::AfterProjectionApplied,
        ] {
            let root = std::env::temp_dir().join(format!(
                "room-send-atomic-{}-{}",
                std::process::id(),
                new_id("test")
            ));
            let paths = knorvia_platform_paths::layout(root);
            let store = ProductStore::open(paths.clone()).unwrap();
            let ws = store.create_workspace("fixture").unwrap();
            let bot = store.ensure_default_bot().unwrap();
            let room = store.ensure_dm(&bot.id).unwrap();
            durable::inject_failure(point);
            assert!(
                store
                    .accept_room_send(
                        "send_atomic",
                        "hash",
                        &room.id,
                        "hello",
                        &ws.id,
                        None,
                        5,
                        vec![]
                    )
                    .is_err()
            );
            drop(store);
            let store = ProductStore::open(paths).unwrap();
            let receipt = store.read_room_send("send_atomic").unwrap().unwrap();
            assert_eq!(receipt.user_message.content, "hello");
            assert_eq!(store.list_room_messages(&room.id, 0, 200).unwrap().len(), 1);
            let again = store
                .accept_room_send(
                    "send_atomic",
                    "hash",
                    &room.id,
                    "hello",
                    &ws.id,
                    None,
                    5,
                    vec![],
                )
                .unwrap();
            assert_eq!(again.user_message.id, receipt.user_message.id);
            assert_eq!(store.list_room_messages(&room.id, 0, 200).unwrap().len(), 1);
        }
    }
}
