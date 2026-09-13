//! Chat FIFO projections share the product WAL, mutation lock and Home owner.
//! Queued text is never a Kernel message until normal turn admission succeeds.
use super::*;
use serde_json::json;

pub const MESSAGE_QUEUE_MAX_ITEMS: usize = 32;
pub const MESSAGE_QUEUE_MAX_BYTES: usize = 512 * 1024;
pub const MESSAGE_QUEUE_ITEM_BYTES: usize = 128 * 1024;
pub const MESSAGE_QUEUE_MAX_THREADS: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub id: String,
    pub sequence: u64,
    pub request_fingerprint: String,
    pub input: String,
    pub options: Value,
    /// An opaque digest of the server's configured account/provider, never a credential.
    pub provider_stamp: String,
    pub status: String,
    pub created_at: String,
    pub turn_id: Option<String>,
    pub execution_id: Option<String>,
    pub dispatch_method: Option<String>,
    pub dispatch_params: Option<Value>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageQueue {
    pub thread_id: String,
    pub workspace_id: String,
    pub revision: u64,
    pub next_sequence: u64,
    pub paused: bool,
    pub reason: Option<String>,
    pub after_turn_id: Option<String>,
    pub after_execution_id: Option<String>,
    #[serde(default)]
    pub acknowledged_turn_id: Option<String>,
    pub items: Vec<QueuedMessage>,
}

impl MessageQueue {
    pub fn has_pending(&self) -> bool {
        self.items.iter().any(|item| matches!(item.status.as_str(), "queued" | "dispatching" | "needs_check"))
    }
}

impl ProductStore {
    pub(super) fn message_queue_path(&self, thread_id: &str) -> PathBuf {
        self.product_dir().join("message-queues").join(format!("{thread_id}.json"))
    }

    pub fn read_message_queue(&self, thread_id: &str) -> Result<MessageQueue, StoreError> {
        let thread = self.read_thread(thread_id)?;
        match read_json::<MessageQueue>(&self.message_queue_path(&thread.id)) {
            Ok(queue) if queue.thread_id == thread.id && queue.workspace_id == thread.workspace_id => Ok(queue),
            Ok(_) => Err(StoreError::Corrupt("message queue identity does not match its thread".into())),
            Err(StoreError::Io(error)) if error.kind() == io::ErrorKind::NotFound => Ok(MessageQueue {
                thread_id: thread.id, workspace_id: thread.workspace_id, revision: 0,
                next_sequence: 1, paused: false, reason: None,
                after_turn_id: None, after_execution_id: None, acknowledged_turn_id: None, items: Vec::new(),
            }),
            Err(error) => Err(error),
        }
    }

    /// Enumeration has a hard admission bound; callers read one small batch.
    pub fn message_queue_thread_ids(&self) -> Result<Vec<String>, StoreError> {
        let dir = self.product_dir().join("message-queues");
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut ids = Vec::new();
        for entry in entries {
            let entry = entry?;
            if entry.file_type()?.is_symlink() { return Err(StoreError::Corrupt("linked message queue".into())); }
            if entry.path().extension().and_then(|ext| ext.to_str()) != Some("json") { continue; }
            if ids.len() >= MESSAGE_QUEUE_MAX_THREADS { return Err(StoreError::Corrupt("message queue directory exceeds its bound".into())); }
            ids.push(entry.path().file_stem().and_then(|id| id.to_str()).ok_or_else(|| invalid("invalid queue filename"))?.to_string());
        }
        ids.sort();
        Ok(ids)
    }

    /// The sole control owner uses this same atomic CAS for cancel, pause and
    /// admission claims. A failed write cannot become an acknowledged enqueue.
    pub fn update_message_queue<F>(&self, thread_id: &str, expected: Option<u64>, change: F) -> Result<MessageQueue, StoreError>
    where F: FnOnce(&mut MessageQueue) -> Result<(), StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut queue = self.read_message_queue(thread_id)?;
        if expected.is_some_and(|revision| revision != queue.revision) { return Err(conflict("message queue changed; refresh before this operation")); }
        let before = queue.clone();
        change(&mut queue)?;
        // Finished receipts retain identity, never another full copy of the
        // prompt. Otherwise 64 control-character-heavy receipts could exceed
        // the daemon's frame budget even though pending input is bounded.
        for item in &mut queue.items {
            if matches!(item.status.as_str(), "delivered" | "cancelled" | "failed") {
                item.input.clear();
                item.options = json!({});
                item.dispatch_params = None;
            }
        }
        if before == queue { return Ok(queue); }
        if before.revision == 0 && self.message_queue_thread_ids()?.len() >= MESSAGE_QUEUE_MAX_THREADS {
            return Err(invalid("too many chat queues in this Home"));
        }
        queue.revision = queue.revision.checked_add(1).ok_or_else(|| invalid("message queue revision exhausted"))?;
        let write = self.projection_write(ProjectionKind::MessageQueue, thread_id, &queue)?;
        // Only state/identity enters the event stream; submitted text remains
        // in its durable queue projection and later its single userMessage.
        self.commit_transaction_locked(thread_id, "messageQueue.changed", json!({"threadId":thread_id,"revision":queue.revision,"paused":queue.paused}), None, vec![write])?;
        Ok(queue)
    }

    pub fn enqueue_message(&self, thread_id: &str, mut item: QueuedMessage, after_turn_id: Option<String>, after_execution_id: Option<String>) -> Result<MessageQueue, StoreError> {
        if item.id.is_empty() || item.id.len() > 128 || !item.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err(invalid("message requestId must contain 1–128 letters, digits, underscores or hyphens"));
        }
        if item.input.trim().is_empty() || item.input.len() > MESSAGE_QUEUE_ITEM_BYTES || serde_json::to_vec(&item.options)?.len() > 8192 {
            return Err(invalid("queued message is empty or exceeds its byte limit"));
        }
        self.update_message_queue(thread_id, None, |queue| {
            if let Some(prior) = queue.items.iter().find(|prior| prior.id == item.id) {
                if prior.request_fingerprint != item.request_fingerprint { return Err(conflict("message requestId belongs to different input")); }
                return Ok(());
            }
            let pending: Vec<_> = queue.items.iter().filter(|row| matches!(row.status.as_str(), "queued" | "dispatching" | "needs_check")).collect();
            if pending.len() >= MESSAGE_QUEUE_MAX_ITEMS || pending.iter().map(|row| row.input.len()).sum::<usize>() + item.input.len() > MESSAGE_QUEUE_MAX_BYTES {
                return Err(invalid("chat queue is full; the submitted draft has not been accepted"));
            }
            if !queue.has_pending() {
                queue.after_turn_id = after_turn_id;
                queue.after_execution_id = after_execution_id;
            }
            // Keep a bounded receipt display. The global admission idempotency
            // ledger still retains older request identities after UI pruning.
            while queue.items.len() >= MESSAGE_QUEUE_MAX_ITEMS * 2 {
                let Some(index) = queue.items.iter().position(|row| matches!(row.status.as_str(), "delivered" | "cancelled" | "failed")) else { break; };
                queue.items.remove(index);
            }
            item.sequence = queue.next_sequence;
            queue.next_sequence = queue.next_sequence.checked_add(1).ok_or_else(|| invalid("message queue sequence exhausted"))?;
            queue.items.push(item);
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (ProductStore, Thread, PathBuf) {
        let home = std::env::temp_dir().join(knorvia_protocol::thread_id());
        let store = ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
        let workspace = store.create_workspace("queue tests").unwrap();
        let thread = store.create_thread(&workspace.id, "chat", None, None).unwrap();
        (store, thread, home)
    }
    fn item(id: &str) -> QueuedMessage { QueuedMessage { id:id.into(),sequence:0,request_fingerprint:id.into(),input:format!("text {id}"),options:json!({"write":false}),provider_stamp:"fixture".into(),status:"queued".into(),created_at:now_rfc3339(),turn_id:None,execution_id:None,dispatch_method:None,dispatch_params:None,error:None } }
    #[test]
    fn fifo_duplicate_cas_and_restart_are_durable() {
        let (store, thread, home) = fixture();
        for id in ["first", "second", "third", "second"] { store.enqueue_message(&thread.id,item(id),None,None).unwrap(); }
        let queue = store.read_message_queue(&thread.id).unwrap();
        assert_eq!(queue.items.iter().map(|i|i.id.as_str()).collect::<Vec<_>>(),vec!["first","second","third"]);
        let cancelled=store.update_message_queue(&thread.id,Some(queue.revision),|q|{q.items[1].status="cancelled".into();Ok(())}).unwrap();
        assert!(store.update_message_queue(&thread.id,Some(queue.revision),|_|Ok(())).is_err());
        drop(store);
        let reopened=ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
        assert_eq!(reopened.read_message_queue(&thread.id).unwrap(),cancelled);
        drop(reopened);fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn rejection_does_not_remove_an_accepted_item() {
        let (store,thread,home)=fixture();store.enqueue_message(&thread.id,item("one"),None,None).unwrap();
        let mut changed=item("one");changed.request_fingerprint="different".into();assert!(store.enqueue_message(&thread.id,changed,None,None).is_err());
        let mut large=item("large");large.input="x".repeat(MESSAGE_QUEUE_ITEM_BYTES+1);assert!(store.enqueue_message(&thread.id,large,None,None).is_err());
        assert_eq!(store.read_message_queue(&thread.id).unwrap().items.len(),1);
        drop(store);fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn completed_receipts_cannot_accumulate_unbounded_prompt_bytes() {
        let (store, thread, home) = fixture();
        for n in 0..70 {
            let mut message = item(&format!("receipt-{n}"));
            message.input = format!("x{}", "\u{1}".repeat(MESSAGE_QUEUE_ITEM_BYTES - 1));
            store.enqueue_message(&thread.id, message, None, None).unwrap();
            store.update_message_queue(&thread.id, None, |queue| {
                let row = queue.items.last_mut().unwrap();
                row.dispatch_params = Some(json!({"input":row.input}));
                row.status = "delivered".into();
                Ok(())
            }).unwrap();
        }
        let queue = store.read_message_queue(&thread.id).unwrap();
        assert_eq!(queue.items.len(), MESSAGE_QUEUE_MAX_ITEMS * 2);
        assert!(queue.items.iter().all(|row| row.input.is_empty() && row.dispatch_params.is_none()));
        assert!(serde_json::to_vec(&queue).unwrap().len() < 128 * 1024);
        drop(store); fs::remove_dir_all(home).unwrap();
    }
}
