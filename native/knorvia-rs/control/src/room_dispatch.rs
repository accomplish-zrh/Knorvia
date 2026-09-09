//! Room dispatch: the minimal durable group-chat scheduler.
//!
//! One dispatch per conversation runs on a background thread owned by the
//! daemon (so closing the UI never owns the coordination state). The thread
//! walks the mentioned bots in member order, resolves each bot's session
//! binding, runs exactly one Kernel turn per bot through the single Agent
//! loop, appends the transcript answer to the room, and advances the
//! binding's delivery watermark. `pass` answers and errors are both visible
//! facts, never silently swallowed.

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

fn mentions_of(
    content: &str,
    members: &[knorvia_store::RoomMember],
    bots: &[knorvia_store::BotProfile],
) -> Vec<String> {
    let lowered = content.to_lowercase();
    let mut mentioned = Vec::new();
    for member in members {
        let Some(bot) = bots.iter().find(|bot| bot.id == member.bot_id) else {
            continue;
        };
        let handle = format!("@{}", bot.name.trim().to_lowercase());
        if lowered.contains(&handle) && !mentioned.contains(&member.bot_id) {
            mentioned.push(member.bot_id.clone());
        }
    }
    mentioned
}

impl ControlPlane {
    pub(super) fn rpc_room_send(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let conversation_id = super::required_str(params, "conversationId")?;
        let content = super::required_str(params, "content")?;
        let room = self
            .store
            .read_room(conversation_id)
            .map_err(|e| e.into_protocol())?;

        if self
            .room_dispatches
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(conversation_id)
        {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "conversation has an active dispatch; interrupt or wait before sending",
            ));
        }

        let user_message = self
            .store
            .append_room_message(conversation_id, RoomMessageInput::user_message(content))
            .map_err(|e| e.into_protocol())?;

        // Mention resolution. A DM always dispatches its single member; a
        // group dispatches only @-mentioned members (≤ MAX_MENTION_ROUNDS).
        let bots = self.store.list_bots().map_err(|e| e.into_protocol())?;
        let mentioned = if room.kind == "dm" {
            room.members.iter().map(|m| m.bot_id.clone()).collect()
        } else {
            mentions_of(content, &room.members, &bots)
                .into_iter()
                .take(MAX_MENTION_ROUNDS)
                .collect::<Vec<_>>()
        };

        let workspace_id = match super::bots::opt_str(params, "workspaceId")? {
            Some(id) => id,
            None => self
                .store
                .list_workspaces()
                .map_err(|e| e.into_protocol())?
                .first()
                .map(|workspace| workspace.id.clone())
                .ok_or_else(|| {
                    invalid("no workspace exists; create one before dispatching bots")
                })?,
        };
        let account_fingerprint = super::bots::opt_str(params, "accountFingerprint")?;
        let host_id = host_fingerprint();
        let timeout_secs = params
            .get("timeoutSecs")
            .and_then(Value::as_u64)
            .map(|secs| Duration::from_secs(secs.clamp(5, 3_600)))
            .unwrap_or(DEFAULT_DISPATCH_TIMEOUT);

        // Cross-room invocation (A07): a bot that is NOT a member can still
        // be @-mentioned. The message is transferred into that bot's DM with
        // the source room recorded, and the bot's reply is routed back to
        // this room by the dispatch. Store budgets (hop/correlation) and
        // messageId idempotency apply to these transfers.
        let mentioned_non_members: Vec<String> = {
            let member_set: std::collections::HashSet<&str> =
                room.members.iter().map(|m| m.bot_id.as_str()).collect();
            bots.iter()
                .filter(|bot| !member_set.contains(bot.id.as_str()))
                .filter(|bot| {
                    content
                        .to_lowercase()
                        .contains(&format!("@{}", bot.name.trim().to_lowercase()))
                })
                .take(2)
                .map(|bot| bot.id.clone())
                .collect()
        };
        let mut transfers = Vec::new();
        for target_bot_id in &mentioned_non_members {
            let transfer_message_id = format!("xfer_{}", user_message.id);
            match self.store.send_room_transfer(
                target_bot_id,
                "user",
                None,
                content,
                &user_message.id,
                None,
                conversation_id,
                Vec::new(),
                1,
                &transfer_message_id,
            ) {
                Ok((_envelope, true)) => transfers.push(target_bot_id.clone()),
                Ok((_envelope, false)) => {
                    // Duplicate messageId: the transfer already exists from a
                    // retry; dispatch it once more only if nothing is active.
                    transfers.push(target_bot_id.clone());
                }
                Err(error) => {
                    let _ = self.store.append_room_message(
                        conversation_id,
                        RoomMessageInput {
                            sender: "system",
                            bot_id: None,
                            content: &format!("互传未送达 {target_bot_id}：{}", error),
                            reply_to_message_id: None,
                            correlation_id: None,
                            source_room_id: None,
                            target_bot_id: None,
                            artifact_refs: Vec::new(),
                            hop_count: 0,
                            transfer_message_id: None,
                            meta: Value::Null,
                        },
                    );
                }
            }
        }

        let mut scheduled = Vec::new();
        if !mentioned.is_empty() {
            // One active dispatch per conversation. A second send while one
            // is running returns busy instead of interleaving turns.
            let mut registry = self
                .room_dispatches
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if registry.contains_key(conversation_id) {
                return Err(ProtocolError::new(
                    ErrorCategory::Conflict,
                    format!("conversation {conversation_id} already has an active dispatch"),
                ));
            }
            if registry.len() >= MAX_CONCURRENT_DISPATCHES {
                return Err(ProtocolError::new(
                    ErrorCategory::Conflict,
                    format!(
                        "backend concurrency cap reached ({MAX_CONCURRENT_DISPATCHES} active dispatches); try again shortly"
                    ),
                ));
            }
            let cancel = Arc::new(AtomicBool::new(false));
            registry.insert(conversation_id.to_string(), Arc::clone(&cancel));
            drop(registry);

            let store = Arc::clone(&self.store);
            let executor = Arc::clone(&self.executor);
            let registry_for_thread = Arc::clone(&self.room_dispatches);
            let conversation = conversation_id.to_string();
            let conversation_for_cleanup = conversation.clone();
            let bot_ids = mentioned.clone();
            let workspace = workspace_id.clone();
            let room_title = room.title.clone();
            let host = host_id.clone();
            let fingerprint = account_fingerprint.clone();
            let cancel_for_thread = Arc::clone(&cancel);
            std::thread::Builder::new()
                .name(format!("room-dispatch-{conversation_id}"))
                .spawn(move || {
                    for bot_id in bot_ids {
                        if cancel_for_thread.load(Ordering::SeqCst) {
                            break;
                        }
                        run_bot_dispatch::run(run_bot_dispatch::Args {
                            store: Arc::clone(&store),
                            executor: Arc::clone(&executor),
                            cancel: Arc::clone(&cancel_for_thread),
                            conversation_id: conversation.clone(),
                            bot_id,
                            room_title: room_title.clone(),
                            workspace_id: workspace.clone(),
                            host_id: host.clone(),
                            account_fingerprint: fingerprint.clone(),
                            up_to_seq: user_message.seq,
                            timeout: timeout_secs,
                        });
                    }
                    let mut registry = registry_for_thread
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    registry.remove(&conversation_for_cleanup);
                })
                .map_err(|e| internal(format!("failed to start dispatch thread: {e}")))?;
            scheduled.extend(mentioned.iter().map(|bot_id| json!({"botId": bot_id})));
        }

        for target_bot_id in &transfers {
            let dm_room = match self.store.ensure_dm(target_bot_id) {
                Ok(room) => room,
                Err(error) => return Err(error.into_protocol()),
            };
            let mut registry = self
                .room_dispatches
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if registry.contains_key(&dm_room.id) {
                continue; // the DM is busy; the envelope is durable and the
                // next send in that DM consumes it.
            }
            registry.insert(dm_room.id.clone(), Arc::new(AtomicBool::new(false)));
            let cancel = Arc::clone(registry.get(&dm_room.id).unwrap());
            drop(registry);

            let store = Arc::clone(&self.store);
            let executor = Arc::clone(&self.executor);
            let registry_for_thread = Arc::clone(&self.room_dispatches);
            let conversation = dm_room.id.clone();
            let conversation_for_cleanup = dm_room.id.clone();
            let bot_id_for_thread = target_bot_id.clone();
            let workspace = workspace_id.clone();
            let host = host_id.clone();
            let fingerprint = account_fingerprint.clone();
            // The DM's own stream sequence space governs its watermark and
            // the delivery-window idempotency gate — never the source room's.
            let dm_head = self
                .store
                .room_chat_head(&dm_room.id)
                .map_err(|e| e.into_protocol())?;
            std::thread::Builder::new()
                .name(format!("room-dispatch-{conversation}"))
                .spawn(move || {
                    run_bot_dispatch::run(run_bot_dispatch::Args {
                        store,
                        executor,
                        cancel,
                        conversation_id: conversation,
                        bot_id: bot_id_for_thread,
                        room_title: dm_room.title,
                        workspace_id: workspace,
                        host_id: host,
                        account_fingerprint: fingerprint,
                        up_to_seq: dm_head,
                        timeout: timeout_secs,
                    });
                    let mut registry = registry_for_thread
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    registry.remove(&conversation_for_cleanup);
                })
                .map_err(|e| internal(format!("failed to start transfer dispatch thread: {e}")))?;
            scheduled.push(
                json!({"botId": target_bot_id, "viaTransfer": true, "conversationId": dm_room.id}),
            );
        }

        Ok(json!({
            "userMessage": user_message,
            "dispatched": scheduled,
        }))
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
            registry.get(conversation_id).cloned()
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
                registry.contains_key(conversation_id)
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

    pub fn run(args: Args) {
        let cli = args
            .store
            .read_bot(&args.bot_id)
            .is_ok_and(|bot| bot.backend_kind == "cli");
        let outcome = if cli {
            super::room_cli_dispatch::run(args)
        } else {
            drive_dispatch(args)
        };
        if let Err(error) = outcome {
            eprintln!("knorvia room dispatch error: {error}");
        }
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
        for _ in 0..2 {
            let Some(thread_id) = binding.knorvia_thread_id.clone() else {
                binding = attach_fresh(&binding)?;
                break;
            };
            let mapped = executor_lock(&executor).has_kernel_thread(&thread_id)?;
            let has_history = !store
                .list_turns(&thread_id)
                .map_err(|e| e.into_protocol())?
                .is_empty();
            if mapped || !has_history {
                break; // anchor is intact, or the session never really started
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
            break;
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
