//! Room dispatch: the minimal durable group-chat scheduler.
//!
//! One dispatch per conversation runs on a background thread owned by the
//! daemon (so closing the UI never owns the coordination state). The thread
//! walks the mentioned bots in member order, resolves each bot's session
//! binding, runs exactly one Kernel turn per bot through the single Agent
//! loop, appends the transcript answer to the room, and advances the
//! binding's delivery watermark. `pass` answers and errors are both visible
//! facts, never silently swallowed.

use super::room_mentions::resolve_mentions;
use super::{ControlPlane, TurnExecutor, TurnRequest};
use knorvia_protocol::{ErrorCategory, ProtocolError};
use knorvia_store::{BindingIdentity, RoomMessageInput, SessionBinding};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[path = "room_cli_dispatch.rs"]
mod room_cli_dispatch;

const MAX_MENTION_ROUNDS: usize = 3;
const MAX_CROSS_ROOM_TARGETS: usize = 2;
/// Global cap on concurrently running dispatch threads. Serial per
/// conversation (the registry) plus a bounded total keeps the backend and
/// the Kernel process pool stable even if many rooms light up at once.
const MAX_CONCURRENT_DISPATCHES: usize = 4;
const TURN_POLL_INTERVAL: Duration = Duration::from_millis(300);
const DEFAULT_DISPATCH_TIMEOUT: Duration = Duration::from_secs(600);
const PASS_MARKERS: [&str; 3] = ["[pass]", "pass", "[pass]"];

fn invalid(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(ErrorCategory::InvalidArgument, message)
}

fn internal(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(ErrorCategory::Internal, message)
}

const MAX_RECEIPT_ENTRIES: usize = 32;

fn mention_receipt(plan: &knorvia_protocol::MentionPlan) -> Value {
    let mut bounded = plan.clone();
    let mut truncated = bounded.mentions.len() > MAX_RECEIPT_ENTRIES
        || bounded.ambiguous.len() > MAX_RECEIPT_ENTRIES
        || bounded.unresolved.len() > MAX_RECEIPT_ENTRIES;
    bounded.mentions.truncate(MAX_RECEIPT_ENTRIES);
    bounded.ambiguous.truncate(MAX_RECEIPT_ENTRIES);
    bounded.unresolved.truncate(MAX_RECEIPT_ENTRIES);
    for mention in bounded
        .mentions
        .iter_mut()
        .chain(bounded.ambiguous.iter_mut())
        .chain(bounded.unresolved.iter_mut())
    {
        truncated |= mention.candidates.len() > MAX_RECEIPT_ENTRIES;
        mention.candidates.truncate(MAX_RECEIPT_ENTRIES);
    }
    bounded.truncated |= truncated;
    let mut value = json!(bounded);
    if let Some(object) = value.as_object_mut() {
        object.insert("memberBotIds".into(), json!(bounded.resolved_member_bot_ids));
        object.insert("externalBotIds".into(), json!(bounded.resolved_external_bot_ids));
    }
    value
}

#[cfg(test)]
thread_local! { pub(super) static FAIL_ROOM_SPAWN:std::cell::Cell<bool>=const{std::cell::Cell::new(false)}; }
fn reservation_key(room: &knorvia_store::Room) -> String {
    if room.kind == "dm" && room.members.len() == 1 {
        format!("dm:{}", room.members[0].bot_id)
    } else {
        room.id.clone()
    }
}
fn work_keys(work: &[knorvia_store::RoomSendWork], source: &str) -> Vec<String> {
    if work.is_empty() {
        return vec![];
    }
    let mut keys = vec![source.into()];
    keys.extend(work.iter().map(|w| w.reservation_key.clone()));
    keys.sort();
    keys.dedup();
    keys
}
fn receipt_response(receipt: &knorvia_store::RoomSendReceipt) -> Value {
    json!({"userMessage":receipt.user_message,"dispatched":receipt.work.iter().map(|w|json!({"botId":w.bot_id,"viaTransfer":w.via_transfer,"conversationId":w.conversation_id})).collect::<Vec<_>>(),"mentions":receipt.user_message.meta.get("mentions").cloned().unwrap_or(Value::Null),"receiptId":receipt.id,"receipt":receipt})
}
type RoomRegistry = Arc<std::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>;
fn release_rooms(registry: &RoomRegistry, keys: &[String]) {
    let mut registry = registry.lock().unwrap_or_else(|e| e.into_inner());
    for key in keys {
        registry.remove(key);
    }
}
struct RoomLease {
    registry: RoomRegistry,
    keys: Vec<String>,
}
impl Drop for RoomLease {
    fn drop(&mut self) {
        release_rooms(&self.registry, &self.keys);
    }
}

impl ControlPlane {
    pub(super) fn rpc_room_send(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        use sha2::{Digest, Sha256};
        let conversation_id = super::required_str(params, "conversationId")?;
        let content = super::required_str(params, "content")?;
        if content.trim().is_empty() || content.len() > 16_000 {
            return Err(invalid("send content must contain 1..16000 UTF-8 bytes"));
        }
        let fingerprint = super::idempotency_fingerprint("room/send", params);
        let id = if let Some(key) = params["idempotencyKey"].as_str() {
            if key.is_empty() || key.len() > 256 {
                return Err(invalid("idempotencyKey must contain 1..256 bytes"));
            }
            format!("send_{:x}", Sha256::digest(key.as_bytes()))
        } else {
            static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            format!(
                "send_{}_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            )
        };
        if let Some(receipt) = self
            .store
            .read_room_send(&id)
            .map_err(|e| e.into_protocol())?
        {
            if receipt.fingerprint != fingerprint {
                return Err(ProtocolError::new(
                    ErrorCategory::Conflict,
                    "send key belongs to different request",
                ));
            }
            return self.resume_room_receipt(receipt);
        }
        let room = self
            .store
            .read_room(conversation_id)
            .map_err(|e| e.into_protocol())?;
        let bots = self.store.list_bots().map_err(|e| e.into_protocol())?;
        let workspace = super::bots::opt_str(params, "workspaceId")?
            .or(self
                .store
                .list_workspaces()
                .map_err(|e| e.into_protocol())?
                .first()
                .map(|w| w.id.clone()))
            .ok_or_else(|| invalid("no workspace exists"))?;
        self.store
            .read_workspace(&workspace)
            .map_err(|e| e.into_protocol())?;
        let account = super::bots::opt_str(params, "accountFingerprint")?;
        let timeout = params["timeoutSecs"]
            .as_u64()
            .unwrap_or(DEFAULT_DISPATCH_TIMEOUT.as_secs())
            .clamp(5, 3600);
        let plan = resolve_mentions(
            content,
            &room.members,
            &bots,
            MAX_MENTION_ROUNDS,
            MAX_CROSS_ROOM_TARGETS,
        );
        let mentioned: Vec<_> = if room.kind == "dm" {
            room.members.iter().map(|m| m.bot_id.clone()).collect()
        } else {
            plan.resolved_member_bot_ids.clone()
        };
        let mut work = Vec::new();
        let source_key = reservation_key(&room);
        for bot in mentioned {
            self.store.read_bot(&bot).map_err(|e| e.into_protocol())?;
            work.push(knorvia_store::RoomSendWork {
                bot_id: bot,
                conversation_id: room.id.clone(),
                reservation_key: source_key.clone(),
                via_transfer: false,
                status: "queued".into(),
                error: None,
                up_to_seq: 0,
            });
        }
        for bot_id in &plan.resolved_external_bot_ids {
            work.push(knorvia_store::RoomSendWork {
                bot_id: bot_id.clone(),
                conversation_id: String::new(),
                reservation_key: format!("dm:{bot_id}"),
                via_transfer: true,
                status: "queued".into(),
                error: None,
                up_to_seq: 0,
            });
        }
        // Capacity is reserved before the first durable message or DM transfer.
        // All work in this bounded receipt queue uses this one admission path.
        let keys = work_keys(&work, &source_key);
        let cancel = Arc::new(AtomicBool::new(false));
        self.reserve_rooms(&keys, &cancel)?;
        let accepted = self.store.accept_room_send_with_meta(
            &id,
            &fingerprint,
            &room.id,
            content,
            &workspace,
            account,
            timeout,
            work,
            json!({"mentions":mention_receipt(&plan)}),
        );
        let receipt = match accepted {
            Ok(receipt) => receipt,
            Err(error) => {
                release_rooms(&self.room_dispatches, &keys);
                return Err(error.into_protocol());
            }
        };
        let receipt = self.prepare_receipt_destinations(receipt);
        self.spawn_room_receipt(receipt.clone(), keys, cancel);
        Ok(receipt_response(&receipt))
    }
    fn prepare_receipt_destinations(
        &self,
        mut receipt: knorvia_store::RoomSendReceipt,
    ) -> knorvia_store::RoomSendReceipt {
        for index in 0..receipt.work.len() {
            if !receipt.work[index].via_transfer || !receipt.work[index].conversation_id.is_empty()
            {
                continue;
            }
            match self.store.ensure_dm(&receipt.work[index].bot_id) {
                Ok(room) => receipt.work[index].conversation_id = room.id,
                Err(error) => {
                    receipt.work[index].status = "failed".into();
                    receipt.work[index].error = Some(error.to_string());
                }
            }
        }
        self.store
            .update_room_send(&receipt.id, |r| r.work = receipt.work.clone())
            .unwrap_or(receipt)
    }
    fn reserve_rooms(
        &self,
        keys: &[String],
        cancel: &Arc<AtomicBool>,
    ) -> Result<(), ProtocolError> {
        let mut registry = self
            .room_dispatches
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if keys.iter().any(|key| registry.contains_key(key)) {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "conversation has an active dispatch",
            ));
        }
        if registry.len() + keys.len() > MAX_CONCURRENT_DISPATCHES {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "room dispatch capacity is full",
            ));
        }
        for key in keys {
            registry.insert(key.clone(), Arc::clone(cancel));
        }
        Ok(())
    }
    pub(super) fn rpc_room_send_status(
        &mut self,
        params: &Value,
        resume: bool,
    ) -> Result<Value, ProtocolError> {
        let id = super::required_str(params, "receiptId")?;
        let receipt = self
            .store
            .read_room_send(id)
            .map_err(|e| e.into_protocol())?
            .ok_or_else(|| ProtocolError::new(ErrorCategory::NotFound, "send receipt not found"))?;
        if resume {
            return self.resume_room_receipt(receipt);
        }
        let receipt = self.reconcile_room_receipt(receipt)?;
        Ok(receipt_response(&receipt))
    }
    fn reconcile_room_receipt(
        &self,
        receipt: knorvia_store::RoomSendReceipt,
    ) -> Result<knorvia_store::RoomSendReceipt, ProtocolError> {
        let registry = self
            .room_dispatches
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if receipt
            .work
            .iter()
            .any(|work| work.status == "running" && !registry.contains_key(&work.reservation_key))
        {
            return self.store.update_room_send(&receipt.id,|receipt|for work in &mut receipt.work {if work.status=="running"&&!registry.contains_key(&work.reservation_key){work.status="needs_check".into();work.error=Some("Previous process stopped after dispatch started; this attempt will not be replayed".into());}}).map_err(|e|e.into_protocol());
        }
        Ok(receipt)
    }
    fn resume_room_receipt(
        &self,
        receipt: knorvia_store::RoomSendReceipt,
    ) -> Result<Value, ProtocolError> {
        let receipt = self.reconcile_room_receipt(receipt)?;
        let room = self
            .store
            .read_room(&receipt.user_message.conversation_id)
            .map_err(|e| e.into_protocol())?;
        let pending: Vec<_> = receipt
            .work
            .iter()
            .filter(|w| w.status == "queued")
            .cloned()
            .collect();
        if !pending.is_empty() {
            let keys = work_keys(&pending, &reservation_key(&room));
            let cancel = Arc::new(AtomicBool::new(false));
            // Busy retries return the accepted receipt. No duplicate worker.
            if self.reserve_rooms(&keys, &cancel).is_ok() {
                self.spawn_room_receipt(receipt.clone(), keys, cancel);
            }
        }
        Ok(receipt_response(&receipt))
    }
    fn spawn_room_receipt(
        &self,
        receipt: knorvia_store::RoomSendReceipt,
        keys: Vec<String>,
        cancel: Arc<AtomicBool>,
    ) {
        if keys.is_empty() {
            return;
        }
        let registry = Arc::clone(&self.room_dispatches);
        let store = Arc::clone(&self.store);
        let executor = Arc::clone(&self.executor);
        let cleanup_keys = keys.clone();
        let cleanup_registry = Arc::clone(&registry);
        let id = receipt.id.clone();
        #[cfg(test)]
        let should_fail = FAIL_ROOM_SPAWN.with(|flag| flag.replace(false));
        #[cfg(not(test))]
        let should_fail = false;
        let spawned = if should_fail {
            Err(std::io::Error::other("injected thread spawn failure"))
        } else {
            std::thread::Builder::new()
                .name(format!("room-send-{}", receipt.id))
                .spawn(move || {
                    let _lease = RoomLease { registry, keys };
                    for (index, item) in receipt.work.iter().enumerate() {
                        if item.status != "queued" {
                            continue;
                        }
                        if cancel.load(Ordering::SeqCst) {
                            let _ = store.update_room_send(&receipt.id, |r| {
                                r.work[index].status = "cancelled".into();
                            });
                            continue;
                        }
                        // Durable claim BEFORE transfer side effects or Kernel admission.
                        if store
                            .update_room_send(&receipt.id, |r| {
                                r.work[index].status = "running".into();
                                r.work[index].error = None;
                            })
                            .is_err()
                        {
                            break;
                        }
                        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                            || -> Result<(), ProtocolError> {
                                let (conversation, up_to_seq) = if item.via_transfer {
                                    let (message, _) = store
                                        .send_room_transfer(
                                            &item.bot_id,
                                            "user",
                                            None,
                                            &receipt.user_message.content,
                                            &receipt.user_message.id,
                                            None,
                                            &receipt.user_message.conversation_id,
                                            vec![],
                                            1,
                                            &format!(
                                                "xfer_{}_{}",
                                                receipt.user_message.id, item.bot_id
                                            ),
                                        )
                                        .map_err(|e| e.into_protocol())?;
                                    store
                                        .update_room_send(&receipt.id, |r| {
                                            r.work[index].conversation_id =
                                                message.conversation_id.clone();
                                            r.work[index].up_to_seq = message.seq;
                                        })
                                        .map_err(|e| e.into_protocol())?;
                                    (message.conversation_id, message.seq)
                                } else {
                                    (item.conversation_id.clone(), item.up_to_seq)
                                };
                                let room = store
                                    .read_room(&conversation)
                                    .map_err(|e| e.into_protocol())?;
                                run_bot_dispatch::run(run_bot_dispatch::Args {
                                    store: Arc::clone(&store),
                                    executor: Arc::clone(&executor),
                                    cancel: Arc::clone(&cancel),
                                    conversation_id: conversation,
                                    bot_id: item.bot_id.clone(),
                                    room_title: room.title,
                                    workspace_id: receipt.workspace_id.clone(),
                                    host_id: host_fingerprint(),
                                    account_fingerprint: receipt.account_fingerprint.clone(),
                                    up_to_seq,
                                    timeout: Duration::from_secs(receipt.timeout_secs),
                                })
                            },
                        ))
                        .unwrap_or_else(|_| Err(internal("room dispatch thread panicked")));
                        let _ = store.update_room_send(&receipt.id, |r| {
                            r.work[index].status = if cancel.load(Ordering::SeqCst) {
                                "cancelled"
                            } else if outcome.is_ok() {
                                "finished"
                            } else {
                                "failed"
                            }
                            .into();
                            r.work[index].error = outcome.err().map(|e| e.message);
                        });
                    }
                })
        };
        if let Err(error) = spawned {
            release_rooms(&cleanup_registry, &cleanup_keys);
            let _ = self.store.update_room_send(&id, |r| {
                for work in &mut r.work {
                    if work.status == "queued" {
                        work.error =
                            Some(format!("Thread not started: {error}; resume this receipt"));
                    }
                }
            });
        }
    }

    pub(super) fn rpc_room_mentions(&self, params: &Value) -> Result<Value, ProtocolError> {
        let conversation_id = super::required_str(params, "conversationId")?;
        let content = super::required_str(params, "content")?;
        let room = self.store.read_room(conversation_id).map_err(|e| e.into_protocol())?;
        let bots = self.store.list_bots().map_err(|e| e.into_protocol())?;
        let plan = resolve_mentions(content, &room.members, &bots, MAX_MENTION_ROUNDS, MAX_CROSS_ROOM_TARGETS);
        Ok(json!({"conversationId":room.id,"roomKind":room.kind,"mentions":mention_receipt(&plan)}))
    }

    pub(super) fn rpc_room_messages(&self, params: &Value) -> Result<Value, ProtocolError> {
        let conversation_id = super::required_str(params, "conversationId")?;
        let from_seq = params.get("fromSeq").and_then(Value::as_u64).unwrap_or(0);
        let limit = params
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(knorvia_store::MAX_MESSAGES_RETURNED as u64) as usize;
        let messages = if params.get("latest").and_then(Value::as_bool) == Some(true) {
            self.store.latest_room_messages(conversation_id, limit)
        } else {
            self.store
                .list_room_messages(conversation_id, from_seq, limit)
        }
        .map_err(|e| e.into_protocol())?;
        let head = self
            .store
            .room_chat_head(conversation_id)
            .map_err(|e| e.into_protocol())?;
        let (_, attention) = self
            .store
            .room_attention(conversation_id)
            .map_err(|e| e.into_protocol())?;
        Ok(json!({"messages": messages, "head": head, "attention": attention}))
    }

    pub(super) fn rpc_room_interrupt(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let conversation_id = super::required_str(params, "conversationId")?;
        let cancel = {
            let registry = self
                .room_dispatches
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let key = self
                .store
                .read_room(conversation_id)
                .map(|r| reservation_key(&r))
                .unwrap_or_else(|_| conversation_id.into());
            registry
                .get(&key)
                .or_else(|| registry.get(conversation_id))
                .cloned()
        };
        let Some(cancel) = cancel else {
            return Ok(json!({"interrupted": false, "reason": "no active dispatch"}));
        };
        cancel.store(true, Ordering::SeqCst);
        // Forward a cooperative interrupt into any running Kernel turn of
        // this conversation's bindings so the wait loop notices promptly.
        let bindings = self
            .store
            .list_bindings(None, Some(conversation_id))
            .map_err(|e| e.into_protocol())?;
        for binding in bindings.iter().filter(|binding| binding.status == "active") {
            if let Some(thread_id) = binding.knorvia_thread_id.as_deref() {
                // An if-let scrutinee retains temporary guards through its
                // body. Keep one named guard instead of trying to acquire
                // the same non-reentrant executor mutex a second time.
                let mut executor = self.executor_lock();
                if let Ok(Some(_)) = executor.thread_settings(thread_id) {
                    let _ = executor.interrupt_turn(thread_id, "");
                }
            }
        }
        Ok(json!({"interrupted": true}))
    }

    /// Test seam: wait for every dispatch of this conversation to settle.
    pub fn wait_room_dispatches(&self, conversation_id: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let active = {
                let registry = self
                    .room_dispatches
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let key = self
                    .store
                    .read_room(conversation_id)
                    .map(|r| reservation_key(&r))
                    .unwrap_or_else(|_| conversation_id.into());
                registry.contains_key(&key) || registry.contains_key(conversation_id)
            };
            if !active {
                return true;
            }
            std::thread::sleep(TURN_POLL_INTERVAL);
        }
        false
    }
}

mod run_bot_dispatch {
    use super::*;

    pub struct Args {
        pub store: Arc<knorvia_store::ProductStore>,
        pub executor: Arc<std::sync::Mutex<Box<dyn TurnExecutor>>>,
        pub cancel: Arc<AtomicBool>,
        pub conversation_id: String,
        pub bot_id: String,
        pub room_title: String,
        pub workspace_id: String,
        pub host_id: String,
        pub account_fingerprint: Option<String>,
        pub up_to_seq: u64,
        pub timeout: Duration,
    }

    pub fn run(args: Args) -> Result<(), ProtocolError> {
        let cli = args
            .store
            .read_bot(&args.bot_id)
            .is_ok_and(|bot| bot.backend_kind == "cli");
        let outcome = if cli {
            super::room_cli_dispatch::run(args)
        } else {
            drive_dispatch(args)
        };
        outcome
    }

    fn executor_lock(
        executor: &std::sync::Mutex<Box<dyn TurnExecutor>>,
    ) -> std::sync::MutexGuard<'_, Box<dyn TurnExecutor>> {
        executor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn drive_dispatch(args: Args) -> Result<(), ProtocolError> {
        let Args {
            store,
            executor,
            cancel,
            conversation_id,
            bot_id,
            room_title,
            workspace_id,
            host_id,
            account_fingerprint,
            up_to_seq,
            timeout,
        } = args;

        let bot = store.read_bot(&bot_id).map_err(|e| e.into_protocol())?;
        let backend_binding_id = bot
            .backend_binding_id
            .clone()
            .unwrap_or_else(|| "kernel".to_string());
        let backend_version = Some(executor_version());

        // Resolve (or regenerate) the durable anchor. Identity mismatches
        // start a fresh generation; the reply always says which happened.
        let resolve = || -> Result<SessionBinding, ProtocolError> {
            Ok(store
                .resolve_session_binding(
                    &bot_id,
                    &conversation_id,
                    &backend_binding_id,
                    BindingIdentity {
                        host_id: Some(&host_id),
                        account_fingerprint: account_fingerprint.as_deref(),
                        canonical_cwd: None,
                        backend_version: backend_version.as_deref(),
                    },
                )
                .map_err(|e| e.into_protocol())?
                .binding)
        };

        // A binding without an attached thread means a fresh session: create
        // the product thread and anchor it. There is no recent-session
        // fallback — that is the contract.
        let mut attach_fresh = |binding: &SessionBinding| -> Result<SessionBinding, ProtocolError> {
            let thread = store
                .create_thread(
                    &workspace_id,
                    &format!("{} · {}", bot.name, room_title),
                    None,
                    None,
                )
                .map_err(|e| e.into_protocol())?;
            let mut settings = super::super::turns::settings_from_params(&json!({}), None)?;
            if settings.cwd.is_none() {
                if let Some(cwd) = store
                    .read_workspace_cwd(&workspace_id)
                    .map_err(|e| e.into_protocol())?
                {
                    settings.cwd = Some(cwd);
                }
            }
            executor_lock(&executor).configure_thread(&thread.id, &settings)?;
            store
                .attach_binding_session(&binding.id, &thread.id, None, Some(binding.revision))
                .map_err(|e| e.into_protocol())
        };

        // A reused binding whose product thread lost its Kernel mapping (a
        // crash between the first product write and the first successful
        // kernel bind, or a lost mapping file) can never be resumed: the
        // executor refuses a thread with history and no mapping. Rather than
        // failing every future dispatch, re-anchor explicitly: mark the old
        // generation lost with the reason visible, then start a fresh one.
        let mut binding: SessionBinding = resolve()?;
        'resolve_binding: {
            let Some(thread_id) = binding.knorvia_thread_id.clone() else {
                binding = attach_fresh(&binding)?;
                break 'resolve_binding;
            };
            let mapped = executor_lock(&executor).has_kernel_thread(&thread_id)?;
            let has_history = !store
                .list_turns(&thread_id)
                .map_err(|e| e.into_protocol())?
                .is_empty();
            if mapped || !has_history {
                break 'resolve_binding; // anchor is intact, or the session never really started
            }
            store
                .mark_binding_lost(
                    &binding.id,
                    "kernel session mapping missing after restart; re-anchoring to a fresh session",
                    Some(binding.revision),
                )
                .map_err(|e| e.into_protocol())?;
            binding = resolve()?;
            if binding.knorvia_thread_id.is_none() {
                binding = attach_fresh(&binding)?;
            }
        }
        let thread_id = binding
            .knorvia_thread_id
            .clone()
            .ok_or_else(|| internal("binding has no thread after attach"))?;

        // Compose the prompt from the un-delivered suffix (this bot's
        // watermark) plus the just-appended user message. The Soul revision
        // is pinned at dispatch start for the whole turn (A12).
        let room = store
            .read_room(&conversation_id)
            .map_err(|e| e.into_protocol())?;
        let checkpoint = room.checkpoints.last().filter(|checkpoint| {
            checkpoint.through_seq <= up_to_seq
                && checkpoint.through_seq > binding.last_delivered_seq
        });
        let watermark = checkpoint.map_or(binding.last_delivered_seq, |checkpoint| {
            checkpoint.through_seq
        });
        let suffix = store
            .list_room_messages(
                &conversation_id,
                watermark + 1,
                knorvia_store::MAX_MESSAGES_RETURNED,
            )
            .map_err(|e| e.into_protocol())?;
        let bots = store.list_bots().map_err(|e| e.into_protocol())?;
        let name_of = |bot_id: &Option<String>| -> String {
            bot_id
                .as_deref()
                .and_then(|id| bots.iter().find(|bot| bot.id == id))
                .map(|bot| bot.name.clone())
                .unwrap_or_else(|| "user".to_string())
        };
        // Consume a contiguous oldest-first prefix. Never advance over an
        // omitted message or one that arrived while this turn was running.
        const MAX_TRANSCRIPT_CHARS: usize = 24_000;
        let mut transcript = String::new();
        let mut budget = MAX_TRANSCRIPT_CHARS;
        let mut consumed_seq = watermark;
        for message in suffix.iter().filter(|message| message.seq <= up_to_seq) {
            if message.meta["hidden"] == true {
                consumed_seq = message.seq;
                continue;
            }
            let sender = if message.sender == "user" {
                "user".to_string()
            } else {
                name_of(&message.bot_id)
            };
            let line = format!("[seq {}] {}: {}\n", message.seq, sender, message.content);
            if line.len() > budget {
                break;
            }
            budget -= line.len();
            transcript.push_str(&line);
            consumed_seq = message.seq;
        }
        if consumed_seq == watermark && checkpoint.is_none() {
            store.append_room_message(&conversation_id, RoomMessageInput {
                sender: "system", bot_id: None,
                content: "下一条未投递消息超出上下文预算。请先保存明确覆盖该消息的群摘要；未消费水位保持不变。",
                meta: json!({"needsUser": true, "bindingId": binding.id, "reason": "contextBudget"}),
                ..RoomMessageInput::user_message("")
            }).map_err(|e| e.into_protocol())?;
            return Ok(());
        }
        let up_to_seq = consumed_seq;
        if store
            .find_dispatch_outcome(&conversation_id, &binding.id, up_to_seq)
            .map_err(|e| e.into_protocol())?
            .is_some()
        {
            store
                .record_binding_delivery(&binding.id, up_to_seq, Some(binding.revision))
                .map_err(|e| e.into_protocol())?;
            return Ok(());
        }
        let checkpoint_text = checkpoint
            .map(|checkpoint| {
                format!(
                    "User-authored checkpoint v{} covering through seq {}:\n{}\n\n",
                    checkpoint.version, checkpoint.through_seq, checkpoint.summary
                )
            })
            .unwrap_or_default();
        let prompt = format!(
            "You are {name}, speaking in the conversation \"{title}\".\n\
             Your soul (revision {soul_revision}):\n{soul}\n\n\
             {checkpoint_text}Recent messages:\n{transcript}\n\
             Reply to the newest messages in character. Reply with exactly [PASS] \
             if you have nothing useful to add.",
            name = bot.name,
            title = room_title,
            soul_revision = bot.soul_revision,
            soul = bot.soul,
        );

        // One turn, one binding. Start it through the executor's durable
        // path, then poll the store until the runner finalizes.
        let turn = store
            .start_turn(&thread_id)
            .map_err(|e| e.into_protocol())?;
        if let Err(error) = store.append_item(&thread_id, &turn.id, "userMessage", "completed", json!({
            "text": prompt,
            "roomDispatch": {"conversationId": conversation_id, "soulRevision": bot.soul_revision},
        })) {
            let _ = store.complete_turn_idempotent(&turn.id, "failed");
            return Err(error.into_protocol());
        }
        let request = TurnRequest {
            thread_id: thread_id.clone(),
            turn_id: turn.id.clone(),
            prompt,
            read_only: false,
            settings: Default::default(),
            advance: None,
        };
        if let Err(error) = executor_lock(&executor).start_turn(&request, Arc::clone(&store)) {
            let _ = store.append_item(
                &thread_id,
                &turn.id,
                "error",
                "failed",
                json!({"category": error.category, "message": error.message}),
            );
            let _ = store.complete_turn_idempotent(&turn.id, "failed");
        }

        let deadline = Instant::now() + timeout;
        let mut status = "running".to_string();
        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = executor_lock(&executor).interrupt_turn(&thread_id, &turn.id);
            }
            let current = store
                .read_turn(&turn.id)
                .map(|turn| turn.status)
                .unwrap_or_else(|_| "running".to_string());
            if current != "running" {
                status = current;
                break;
            }
            if Instant::now() >= deadline {
                let _ = executor_lock(&executor).interrupt_turn(&thread_id, &turn.id);
                status = "timeout".to_string();
                break;
            }
            std::thread::sleep(TURN_POLL_INTERVAL);
        }

        // Delivery-window idempotency: if a previous dispatch of this
        // binding already produced an outcome for this exact suffix (crash
        // between answer-append and watermark-advance), keep that outcome —
        // completed deliveries are never replayed.
        let already = store
            .find_dispatch_outcome(&conversation_id, &binding.id, up_to_seq)
            .map_err(|e| e.into_protocol())?;
        // Extract the answer only from a durably completed turn; failed,
        // cancelled and timed-out turns surface as system facts instead.
        let answer = if status == "completed" {
            store.read_turn_history(&turn.id).ok().and_then(|history| {
                history
                    .items
                    .iter()
                    .filter(|item| item.kind == "agentMessage" && item.status == "completed")
                    .next_back()
                    .and_then(|item| item.payload.get("text").and_then(Value::as_str))
                    .map(str::to_string)
            })
        } else {
            None
        };

        // The watermark covers the whole transcript head (including this
        // dispatch's own answer), so the bot never re-consumes its output.
        let watermark = up_to_seq;
        if already.is_some() {
            let _ = store.record_binding_delivery(&binding.id, watermark, Some(binding.revision));
            return Ok(());
        }
        // Transfer reply routing (A07): if this dispatch consumed an
        // envelope addressed to this bot, the answer (never a pass) also
        // lands in the source room with the correlation preserved, and the
        // envelope is acked. Skipped on the `already` path so a crash between
        // routing and watermarking cannot double-deliver the reply.
        let envelope = suffix
            .iter()
            .filter(|message| message.seq <= up_to_seq)
            .find(|message| {
                message.message_id.is_some()
                    && message.target_bot_id.as_deref() == Some(bot_id.as_str())
            });
        if let (Some(envelope), Some(text)) = (envelope, answer.as_deref()) {
            if let (Some(source_room_id), Some(message_id)) =
                (envelope.source_room_id.clone(), envelope.message_id.clone())
            {
                let _ = store.append_room_message(
                    &source_room_id,
                    RoomMessageInput {
                        sender: "bot",
                        bot_id: Some(&bot_id),
                        content: text,
                        reply_to_message_id: Some(&message_id),
                        correlation_id: envelope.correlation_id.as_deref(),
                        source_room_id: Some(&conversation_id),
                        target_bot_id: None,
                        artifact_refs: envelope.artifact_refs.clone(),
                        hop_count: envelope.hop_count,
                        transfer_message_id: None,
                        meta: json!({
                            "soulRevision": bot.soul_revision,
                            "turnId": turn.id,
                            "bindingId": binding.id,
                            "upToSeq": up_to_seq,
                        }),
                    },
                );
                let _ = store.mark_room_message_status(&conversation_id, &message_id, "acked");
            }
        }
        let answer_missing = answer.is_none();
        match answer {
            Some(text) if is_pass(&text) => {
                store.append_room_message(&conversation_id, RoomMessageInput {
                    sender: "system", bot_id: None, content: &format!("{} 跳过了本轮。", bot.name),
                    meta: json!({"bindingId": binding.id, "upToSeq": up_to_seq, "turnId": turn.id, "dispatchStatus": "pass"}),
                    ..RoomMessageInput::user_message("")
                }).map_err(|e| e.into_protocol())?;
            }
            Some(text) => {
                store
                    .append_room_message(
                        &conversation_id,
                        RoomMessageInput {
                            sender: "bot",
                            bot_id: Some(&bot_id),
                            content: &text,
                            reply_to_message_id: None,
                            correlation_id: None,
                            source_room_id: None,
                            target_bot_id: None,
                            artifact_refs: Vec::new(),
                            hop_count: 0,
                            transfer_message_id: None,
                            meta: json!({
                                "soulRevision": bot.soul_revision,
                                "turnId": turn.id,
                                "bindingId": binding.id,
                                "upToSeq": up_to_seq,
                            }),
                        },
                    )
                    .map_err(|e| e.into_protocol())?;
            }
            None => {
                store.append_room_message(
                    &conversation_id,
                    RoomMessageInput {
                        sender: "system",
                        bot_id: None,
                        content: &format!(
                            "Bot {name} 本轮未完成（状态：{status}）。本次尝试不会自动重放，请检查后决定下一步。turn {turn}。",
                            name = bot.name,
                            status = status,
                            turn = turn.id,
                        ),
                        reply_to_message_id: None,
                        correlation_id: None,
                        source_room_id: None,
                        target_bot_id: None,
                        artifact_refs: Vec::new(),
                        hop_count: 0,
                        transfer_message_id: None,
                        meta: json!({"turnId": turn.id, "bindingId": binding.id, "upToSeq": up_to_seq, "needsUser": true}),
                    },
                ).map_err(|e| e.into_protocol())?;
            }
        }

        // Advance the watermark to everything consumed this dispatch. This
        // is the crash-recovery boundary: a crash before this point replays
        // the suffix on the next dispatch, never skipping content.
        store
            .record_binding_delivery(&binding.id, watermark, Some(binding.revision))
            .map_err(|e| e.into_protocol())?;
        if status != "completed" || answer_missing {
            return Err(internal(format!(
                "Bot dispatch did not produce a completed answer: {status}"
            )));
        }
        Ok(())
    }

    fn is_pass(text: &str) -> bool {
        let trimmed = text.trim().to_lowercase();
        PASS_MARKERS.contains(&trimmed.as_str()) || trimmed == "[pass]" || trimmed == "pass"
    }

    fn executor_version() -> String {
        format!("kernel-{}", env!("CARGO_PKG_VERSION"))
    }
}

fn host_fingerprint() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "local".to_string())
}
