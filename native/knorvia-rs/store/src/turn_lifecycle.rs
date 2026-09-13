//! Durable turn lifecycle transitions and per-turn item writes.

use super::durable::{EventDraft, ProjectionKind, ProjectionWrite};
use super::{
    ProductStore, StoreError, atomic_write, conflict, invalid, not_found, now_rfc3339, read_json,
};
use knorvia_protocol::{Item, Turn};
use serde_json::{Value, json};
use std::fs;

fn is_terminal_turn_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "interrupted")
}

/// Build the durable timeline Item that explains one system approval
/// close-out (A03). `seq` must be the Item's own `item.appended` event
/// sequence so the timeline order matches the event order.
pub(crate) fn system_resolution_item(approval: &super::Approval, reason: &str, seq: u64) -> Item {
    Item {
        id: knorvia_protocol::item_id(),
        thread_id: approval.thread_id.clone(),
        turn_id: approval.turn_id.clone(),
        kind: "approvalResolution".to_string(),
        status: "completed".to_string(),
        seq,
        payload: json!({
            "approvalId": approval.id,
            "turnId": approval.turn_id,
            "resolution": reason,
            "source": "system",
        }),
    }
}

fn validate_terminal_turn_status(status: &str) -> Result<(), StoreError> {
    if is_terminal_turn_status(status) {
        Ok(())
    } else {
        Err(invalid(format!("invalid terminal turn status {status}")))
    }
}

fn interrupted_item_payload(payload: Value) -> Value {
    match payload {
        Value::Object(mut object) => {
            object.insert("delivered".into(), Value::Bool(false));
            object.insert(
                "recovery".into(),
                json!({"reason": "turn interrupted after the owning process stopped"}),
            );
            Value::Object(object)
        }
        original => json!({
            "originalPayload": original,
            "delivered": false,
            "recovery": {"reason": "turn interrupted after the owning process stopped"},
        }),
    }
}

impl ProductStore {
    /// Inspect all turn projections once, including archived threads, before
    /// the control owner admits an idle runtime restart.
    pub fn running_turn_count(&self) -> Result<usize, StoreError> {
        let _mutations = self.lock_mutations()?;
        self.recover_before_indexed_read()?;
        Ok(self.indexed_running_turns_locked()?.len())
    }

    pub(super) fn list_turns_locked(&self) -> Result<Vec<Turn>, StoreError> {
        let dir = self.product_dir().join("turns");
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut turns = Vec::new();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                == Some("json")
            {
                turns.push(read_json(&entry.path())?);
            }
        }
        turns.sort_by(|left: &Turn, right: &Turn| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(turns)
    }

    /// Return every turn for a thread in stable creation order.
    pub fn list_turns(&self, thread_id: &str) -> Result<Vec<Turn>, StoreError> {
        let _mutations = self.lock_mutations()?;
        self.recover_before_indexed_read()?;
        self.indexed_thread_turns_locked(thread_id)
    }

    /// Validate an item or approval belongs to the requested active turn.
    /// Callers hold `mutation`, so a terminal transition cannot race this
    /// check and add data after the turn is finalized.
    pub(super) fn require_running_turn_locked(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<Turn, StoreError> {
        let turn = self.read_turn(turn_id)?;
        if turn.thread_id != thread_id {
            return Err(conflict(format!(
                "turn {turn_id} belongs to thread {}, not {thread_id}",
                turn.thread_id
            )));
        }
        if turn.status != "running" {
            return Err(conflict(format!(
                "turn {turn_id} is terminal ({})",
                turn.status
            )));
        }
        Ok(turn)
    }

    /// Append only still-pending approvals to the caller's terminal WAL
    /// batch. Both locks are held and recovery has run before this snapshot.
    fn append_pending_approval_resolutions_locked(
        &self,
        turn: &Turn,
        reason: &str,
        drafts: &mut Vec<EventDraft>,
        writes: &mut Vec<ProjectionWrite>,
    ) -> Result<(), StoreError> {
        let approvals = self.indexed_turn_pending_approvals_locked(&turn.thread_id, &turn.id)?;
        if approvals.is_empty() {
            return Ok(());
        }
        let first_seq = self.next_event_sequence_locked(&turn.thread_id)?;
        for mut approval in approvals {
            approval.status = reason.into();
            writes.push(self.projection_write(
                ProjectionKind::Approval,
                &approval.id,
                &approval,
            )?);
            drafts.push(EventDraft::new(
                "approval.systemResolved",
                json!({"approval": approval, "reason": reason}),
            ));
            let offset = u64::try_from(drafts.len())
                .map_err(|_| invalid("approval resolution batch is too large"))?;
            let seq = first_seq
                .checked_add(offset)
                .ok_or_else(|| invalid("approval resolution sequence exhausted"))?;
            let item = system_resolution_item(&approval, reason, seq);
            writes.push(self.projection_write(ProjectionKind::Item, &item.id, &item)?);
            drafts.push(EventDraft::new(
                "item.appended",
                serde_json::to_value(&item)?,
            ));
        }
        Ok(())
    }

    /// Complete a turn while both the mutation and journal locks are held.
    /// Its pending approvals cannot outlive the owner: their results and
    /// explanatory Items commit with the terminal turn, even if the runner's
    /// best-effort per-approval cleanup failed. A same-terminal retry also
    /// repairs approvals left by older versions without rewriting the turn.
    fn complete_turn_locked(&self, turn_id: &str, status: &str) -> Result<Turn, StoreError> {
        validate_terminal_turn_status(status)?;
        let path = self.turn_path(turn_id);
        if !path.exists() {
            return Err(not_found("turn", turn_id));
        }
        let mut turn: Turn = read_json(&path)?;
        let was_running = turn.status == "running";
        if !was_running && turn.status != status {
            return Err(conflict(format!(
                "turn {turn_id} already terminal ({})",
                turn.status
            )));
        }
        let reason = if status == "cancelled" {
            "cancelled"
        } else {
            "owner_lost"
        };
        let mut drafts = Vec::new();
        let mut writes = Vec::new();
        self.append_pending_approval_resolutions_locked(&turn, reason, &mut drafts, &mut writes)?;
        for mut item in self
            .indexed_turn_items_locked(&turn.thread_id, &turn.id)?
            .into_iter()
            .filter(|item| item.status == "waiting_approval")
        {
            item.status = "interrupted".into();
            // Preserve the tool request, while making its obsolete waiting
            // state non-actionable. The approval's own result remains the
            // authoritative distinction between human and system decisions.
            writes.push(self.projection_write(ProjectionKind::Item, &item.id, &item)?);
            drafts.push(EventDraft::new(
                "item.interrupted",
                serde_json::to_value(&item)?,
            ));
        }
        if was_running {
            turn.status = status.to_string();
            turn.completed_at = Some(now_rfc3339());
            writes.push(self.projection_write(ProjectionKind::Turn, &turn.id, &turn)?);
            drafts.push(EventDraft::new(
                "turn.completed",
                serde_json::to_value(&turn)?,
            ));
        }
        if !drafts.is_empty() {
            self.commit_transaction_batch_locked(&turn.thread_id, drafts, writes)?;
        }
        Ok(turn)
    }

    pub fn start_turn(&self, thread_id: &str) -> Result<Turn, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let thread = self.read_thread(thread_id)?;
        let turns = self.indexed_running_turns_locked()?;
        if let Some(goal_id) = thread.goal_id.as_deref() {
            self.require_active_goal(goal_id, &thread.workspace_id)?;
            for turn in turns.iter().filter(|turn| turn.status == "running") {
                if self.read_thread(&turn.thread_id)?.goal_id.as_deref() == Some(goal_id) {
                    return Err(conflict("this Goal already has an active Turn"));
                }
            }
        }
        if let Some(active) = turns
            .iter()
            .find(|turn| turn.thread_id == thread_id && turn.status == "running")
        {
            return Err(conflict(format!(
                "thread {thread_id} already has running turn {}",
                active.id
            )));
        }
        let turn = Turn {
            id: knorvia_protocol::turn_id(),
            thread_id: thread_id.to_string(),
            status: "running".into(),
            created_at: now_rfc3339(),
            completed_at: None,
        };
        let write = self.projection_write(ProjectionKind::Turn, &turn.id, &turn)?;
        self.commit_transaction_locked(
            thread_id,
            "turn.started",
            serde_json::to_value(&turn)?,
            None,
            vec![write],
        )?;
        Ok(turn)
    }

    pub fn complete_turn(&self, turn_id: &str, status: &str) -> Result<Turn, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.complete_turn_locked(turn_id, status)
    }

    /// Finish a turn exactly once from the perspective of its terminal
    /// outcome. Repeating the same terminal outcome returns the persisted
    /// turn; attempting a different outcome is a conflict and never rewrites
    /// the recorded fact.
    pub fn complete_turn_idempotent(
        &self,
        turn_id: &str,
        status: &str,
    ) -> Result<Turn, StoreError> {
        self.complete_turn(turn_id, status)
    }

    /// Convert durable `running` turns left by a previous process into the
    /// explicit `interrupted` terminal state. Any pending approval or input
    /// owned by that Turn is made non-actionable in the *same* WAL batch, so
    /// a restart never exposes an interactive card with no live owner. This
    /// does not infer successful completion; callers should invoke it once
    /// after establishing that no runner from the old process can own the
    /// store.
    pub fn recover_incomplete_turns(&self) -> Result<Vec<Turn>, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let running_turns = self.indexed_running_turns_locked()?;
        let mut recovered = Vec::with_capacity(running_turns.len());
        for mut turn in running_turns {
            let mut drafts = Vec::new();
            let mut writes = Vec::new();
            self.append_pending_approval_resolutions_locked(
                &turn,
                "owner_lost",
                &mut drafts,
                &mut writes,
            )?;

            for mut item in self
                .indexed_turn_items_locked(&turn.thread_id, &turn.id)?
                .into_iter()
                .filter(|item| {
                    matches!(
                        item.status.as_str(),
                        "pending" | "waiting_input" | "waiting_approval"
                    )
                })
            {
                item.status = "interrupted".into();
                item.payload = interrupted_item_payload(item.payload);
                writes.push(self.projection_write(ProjectionKind::Item, &item.id, &item)?);
                drafts.push(EventDraft::new(
                    "item.interrupted",
                    serde_json::to_value(&item)?,
                ));
            }

            turn.status = "interrupted".into();
            turn.completed_at = Some(now_rfc3339());
            writes.push(self.projection_write(ProjectionKind::Turn, &turn.id, &turn)?);
            drafts.push(EventDraft::new(
                "turn.completed",
                serde_json::to_value(&turn)?,
            ));
            self.commit_transaction_batch_locked(&turn.thread_id, drafts, writes)?;
            recovered.push(turn);
        }
        // Older terminal transitions could leave pending approvals behind.
        // Discover only their owners, including archived threads, rather
        // than scanning every historical turn and all of its timeline Items.
        // The public return value still describes formerly-running turns.
        for turn_id in self.indexed_pending_approval_turn_ids_locked()? {
            let turn = self.read_turn(&turn_id)?;
            if is_terminal_turn_status(&turn.status) {
                self.complete_turn_locked(&turn.id, &turn.status)?;
            }
        }
        Ok(recovered)
    }

    pub fn read_turn(&self, id: &str) -> Result<Turn, StoreError> {
        let path = self.turn_path(id);
        if !path.exists() {
            return Err(not_found("turn", id));
        }
        read_json(&path)
    }

    pub fn append_item(
        &self,
        thread_id: &str,
        turn_id: &str,
        kind: &str,
        status: &str,
        payload: Value,
    ) -> Result<Item, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let _ = self.require_running_turn_locked(thread_id, turn_id)?;
        let item = Item {
            id: knorvia_protocol::item_id(),
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            kind: kind.to_string(),
            status: status.to_string(),
            seq: self.next_event_sequence_locked(thread_id)?,
            payload,
        };
        let write = self.projection_write(ProjectionKind::Item, &item.id, &item)?;
        self.commit_transaction_locked(
            thread_id,
            "item.appended",
            serde_json::to_value(&item)?,
            None,
            vec![write],
        )?;
        Ok(item)
    }

    pub fn read_item(&self, id: &str) -> Result<Item, StoreError> {
        if let Some(item) = self.locate_item(id)? {
            return Ok(item);
        }
        Err(not_found("item", id))
    }

    /// Find one item by id through the locator, then the sharded layout, then
    /// the legacy flat projection. Losing the locator is recoverable by
    /// design: the fallback scan restores it.
    pub(crate) fn locate_item(&self, id: &str) -> Result<Option<Item>, StoreError> {
        let locator_path = self.item_locator_path(id);
        if locator_path.exists() {
            let locator: serde_json::Value = read_json(&locator_path)?;
            if let Some(thread_id) = locator.get("threadId").and_then(|v| v.as_str()) {
                if let Some(item) = self.read_sharded_item(thread_id, id)? {
                    return Ok(Some(item));
                }
            }
        }
        let legacy = self.item_path(id);
        if legacy.exists() {
            return Ok(Some(read_json(&legacy)?));
        }
        let threads_root = self.product_dir().join("items").join("threads");
        if threads_root.exists() {
            for entry in fs::read_dir(&threads_root)? {
                let entry = entry?;
                if !entry.path().is_dir() {
                    continue;
                }
                if let Some(item) =
                    self.read_sharded_item(entry.file_name().to_string_lossy().as_ref(), id)?
                {
                    let locator = serde_json::json!({ "id": id, "threadId": item.thread_id });
                    atomic_write(&locator_path, &serde_json::to_vec_pretty(&locator)?)?;
                    return Ok(Some(item));
                }
            }
        }
        Ok(None)
    }

    /// Read one item from a thread's shard directory by matching the id
    /// suffix, regardless of the sequence prefix in the file name.
    fn read_sharded_item(&self, thread_id: &str, id: &str) -> Result<Option<Item>, StoreError> {
        let shard_dir = self.item_shard_dir(thread_id);
        if !shard_dir.exists() {
            return Ok(None);
        }
        let suffix = format!("-{id}.json");
        for entry in fs::read_dir(&shard_dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(&suffix) || name == format!("{id}.json") {
                return Ok(Some(read_json(&entry.path())?));
            }
        }
        Ok(None)
    }

    /// Resolve a pending product Item without adding a second user-input
    /// fact. Its identity and original ordering sequence remain stable.
    pub fn resolve_item(&self, id: &str, status: &str, payload: Value) -> Result<Item, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut item = self.read_item(id)?;
        let _ = self.require_running_turn_locked(&item.thread_id, &item.turn_id)?;
        item.status = status.to_string();
        item.payload = payload;
        let write = self.projection_write(ProjectionKind::Item, &item.id, &item)?;
        self.commit_transaction_locked(
            &item.thread_id,
            "item.resolved",
            serde_json::to_value(&item)?,
            None,
            vec![write],
        )?;
        Ok(item)
    }

    /// Correct a user-input audit fact when the answer was persisted before a
    /// volatile Kernel owner disappeared. Unlike ordinary resolution this may
    /// run after the Turn reaches a terminal state: the corrective event is
    /// more truthful than leaving an undelivered answer marked `answered`.
    pub fn mark_item_delivery_failed(&self, id: &str, payload: Value) -> Result<Item, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut item = self.read_item(id)?;
        if item.status == "delivery_failed" {
            return Ok(item);
        }
        if !matches!(
            item.status.as_str(),
            "pending" | "waiting_input" | "answered"
        ) {
            return Err(conflict(format!(
                "item {id} cannot record delivery failure from {}",
                item.status
            )));
        }
        item.status = "delivery_failed".into();
        item.payload = payload;
        let write = self.projection_write(ProjectionKind::Item, &item.id, &item)?;
        self.commit_transaction_locked(
            &item.thread_id,
            "item.delivery_failed",
            serde_json::to_value(&item)?,
            None,
            vec![write],
        )?;
        Ok(item)
    }
}
