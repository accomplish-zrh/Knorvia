//! End-to-end dispatch tests: room/send → binding resolve → scripted turn →
//! transcript append → watermark advance, all through the RPC surface.

use super::turn_exec::WriteTurnStream;
use super::*;
use knorvia_platform_paths::layout;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

/// Emulates the production runner contract: `start_write_turn` finishes the
/// turn autonomously in a background thread, persisting the agent answer.
/// `mapped` mirrors the production executor's durable kernel-thread map:
/// true once a kernel session was bound to the product thread.
struct RunnerExecutor {
    answer: std::sync::Mutex<Option<String>>,
    mapped: std::sync::atomic::AtomicBool,
    /// Number of initial start_write_turn calls refused at admission,
    /// mirroring the crashed boot where no provider/kernel was available.
    refuse_next_turns: std::sync::Mutex<usize>,
    /// Production persists cwd settings even for external CLI threads.
    /// Most scripted tests don't, so explicitly cover the Some branch.
    report_settings: bool,
}

impl RunnerExecutor {
    fn new(answer: &str) -> Self {
        Self {
            answer: std::sync::Mutex::new(Some(answer.to_string())),
            mapped: std::sync::atomic::AtomicBool::new(true),
            refuse_next_turns: std::sync::Mutex::new(0),
            report_settings: false,
        }
    }

    fn unmapped(answer: &str) -> Self {
        Self {
            mapped: std::sync::atomic::AtomicBool::new(false),
            refuse_next_turns: std::sync::Mutex::new(1),
            ..Self::new(answer)
        }
    }
}

impl TurnExecutor for RunnerExecutor {
    fn thread_settings(
        &self,
        _thread_id: &str,
    ) -> Result<Option<KernelTurnSettings>, ProtocolError> {
        Ok(self.report_settings.then(KernelTurnSettings::default))
    }
    fn has_kernel_thread(&self, _thread_id: &str) -> Result<bool, ProtocolError> {
        Ok(self.mapped.load(std::sync::atomic::Ordering::SeqCst))
    }

    fn start_write_turn(
        &mut self,
        req: &TurnRequest,
        store: Arc<ProductStore>,
        _sink: Option<EventSink>,
    ) -> Result<WriteTurnStream, ProtocolError> {
        let answer = self
            .answer
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "[PASS]".to_string());
        {
            let mut refuse = self.refuse_next_turns.lock().unwrap();
            if *refuse > 0 {
                *refuse -= 1;
                return Err(ProtocolError::new(
                    ErrorCategory::NotInitialized,
                    "no provider is configured (scripted refusal)",
                ));
            }
        }
        let thread_id = req.thread_id.clone();
        let turn_id = req.turn_id.clone();
        self.mapped.store(true, std::sync::atomic::Ordering::SeqCst);
        std::thread::spawn(move || {
            store
                .append_item(
                    &thread_id,
                    &turn_id,
                    "agentMessage",
                    "completed",
                    json!({"text": answer}),
                )
                .unwrap();
            store.complete_turn(&turn_id, "completed").unwrap();
        });
        let (_sender, receiver) = std::sync::mpsc::channel();
        Ok(WriteTurnStream {
            first_approval: receiver,
        })
    }

    fn run_turn(&mut self, _req: &TurnRequest) -> Result<TurnOutcome, ProtocolError> {
        Err(ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            "runner executor only supports write turns",
        ))
    }

    fn respond_approval(
        &mut self,
        _approval_id: &str,
        _decision: knorvia_kernel_adapter::TurnDecision,
    ) -> Result<bool, ProtocolError> {
        Ok(false)
    }

    fn decline_pending(&mut self, _thread_id: &str) -> Result<usize, ProtocolError> {
        Ok(0)
    }

    fn interrupt(&mut self, _thread_id: &str) -> Result<bool, ProtocolError> {
        Ok(true)
    }

    fn await_turn_done(
        &mut self,
        _thread_id: &str,
        _timeout: Duration,
    ) -> Result<(), ProtocolError> {
        Ok(())
    }

    fn set_sink(&mut self, _sink: Option<EventSink>) {}
}

static SEQ: AtomicU64 = AtomicU64::new(0);

#[test]
fn interrupt_rpc_returns_promptly_with_persisted_thread_settings() {
    let base = std::env::temp_dir().join(format!(
        "knorvia-cli-interrupt-rpc-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let executor = RunnerExecutor {
        report_settings: true,
        ..RunnerExecutor::new("unused")
    };
    let mut plane = ControlPlane::open_with_executor(layout(base), Box::new(executor)).unwrap();
    init(&mut plane);
    let bot = plane
        .store
        .create_bot("CLI", "soul", "cli", Some("cli:codex"))
        .unwrap();
    let workspace = result_of(&rpc(
        &mut plane,
        "w",
        "workspace/create",
        json!({"title":"cli-rpc-deadline"}),
    ));
    let room = plane.store.ensure_dm(&bot.id).unwrap();
    result_of(&rpc(
        &mut plane,
        "send",
        "room/send",
        json!({"conversationId":room.id,"content":"go", "workspaceId":workspace["id"]}),
    ));
    let job = claim_cli_job(&plane);
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let reply = rpc(
            &mut plane,
            "cancel",
            "room/interrupt",
            json!({"conversationId":room.id}),
        );
        let _ = sender.send((reply, plane, room, job));
    });
    let (reply, plane, room, job) = receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("room/interrupt must return without reacquiring a live executor guard");
    assert_eq!(result_of(&reply)["interrupted"], true);
    assert!(plane.wait_room_dispatches(&room.id, Duration::from_secs(10)));
    let claims = plane
        .rpc_cli_dispatch_claim(&json!({"hostId":"fixture-host","backendIds":["cli:codex"]}))
        .unwrap();
    assert!(
        claims["cancels"]
            .as_array()
            .unwrap()
            .contains(&job["runId"])
    );
}

fn claim_cli_job(plane: &ControlPlane) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let response = plane
            .rpc_cli_dispatch_claim(&json!({"hostId":"fixture-host","backendIds":["cli:codex"]}))
            .unwrap();
        if let Some(job) = response["jobs"].as_array().unwrap().first() {
            return job.clone();
        }
        assert!(Instant::now() < deadline, "CLI job was never queued");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn cli_room_bridge_persists_sessions_and_isolates_groups() {
    let (mut plane, _) = plane("KERNEL_MUST_NOT_EXECUTE_CLI");
    init(&mut plane);
    let bot = plane
        .store
        .create_bot("CLI teammate", "fixed soul", "cli", Some("cli:codex"))
        .unwrap();
    let workspace = result_of(&rpc(
        &mut plane,
        "w",
        "workspace/create",
        json!({"title":"cli"}),
    ));
    let room = plane
        .store
        .create_room("group", "CLI first", &[bot.id.clone()])
        .unwrap();
    let other = plane
        .store
        .create_room("group", "CLI second", &[bot.id.clone()])
        .unwrap();
    for (index, conversation) in [&room.id, &room.id, &other.id].into_iter().enumerate() {
        result_of(&rpc(
            &mut plane,
            "send",
            "room/send",
            json!({"conversationId":conversation,"content":"@CLI teammate do work", "workspaceId":workspace["id"]}),
        ));
        let job = claim_cli_job(&plane);
        assert_eq!(job["conversationId"], *conversation);
        assert_eq!(job["resume"], index == 1);
        if index == 1 {
            assert_eq!(job["sessionId"], "session-first");
        }
        if index == 2 {
            assert!(job["sessionId"].is_null());
        }
        assert!(job["prompt"].as_str().unwrap().contains("fixed soul"));
        assert!(
            plane
                .rpc_cli_dispatch_claim(
                    &json!({"hostId":"another-host","backendIds":["cli:codex"]})
                )
                .unwrap()["jobs"]
                .as_array()
                .unwrap()
                .is_empty(),
            "claims cannot execute twice"
        );
        let completion = json!({"hostId":"fixture-host","conversationId":conversation,"requestId":job["requestId"],"runId":job["runId"],"text":"real CLI fixture answer","sessionId":if index == 2 {"session-second"} else {"session-first"}});
        assert_eq!(
            plane.rpc_cli_dispatch_complete(&completion).unwrap()["status"],
            "completed"
        );
        assert_eq!(
            plane.rpc_cli_dispatch_complete(&completion).unwrap()["status"],
            "completed"
        );
        assert!(plane.wait_room_dispatches(conversation, Duration::from_secs(10)));
        let messages = plane.store.latest_room_messages(conversation, 200).unwrap();
        assert!(
            !messages
                .iter()
                .any(|message| message.content.contains("KERNEL_MUST_NOT_EXECUTE_CLI"))
        );
        assert_eq!(
            messages
                .iter()
                .filter(|message| message.sender == "bot" && message.meta["hidden"] != true)
                .count(),
            if index == 1 { 2 } else { 1 }
        );
    }
    let first = plane
        .store
        .list_bindings(Some(&bot.id), Some(&room.id))
        .unwrap()
        .remove(0);
    let second = plane
        .store
        .list_bindings(Some(&bot.id), Some(&other.id))
        .unwrap()
        .remove(0);
    assert_eq!(first.external_session_id.as_deref(), Some("session-first"));
    assert_eq!(
        second.external_session_id.as_deref(),
        Some("session-second")
    );
    assert_ne!(first.knorvia_thread_id, second.knorvia_thread_id);
    let (usage, total) = plane.store.list_usage(0, 100).unwrap();
    assert_eq!(total, 3);
    assert!(usage.iter().all(|record| record.provider_id == "cli:codex"
        && record.completeness == "unknown"
        && record.model == "unknown"));
}

#[test]
fn cli_interrupt_exposes_cancel_and_late_completion_cannot_overwrite_it() {
    let (mut plane, _) = plane("unused");
    init(&mut plane);
    let bot = plane
        .store
        .create_bot("CLI", "soul", "cli", Some("cli:codex"))
        .unwrap();
    let workspace = result_of(&rpc(
        &mut plane,
        "w",
        "workspace/create",
        json!({"title":"cli-cancel"}),
    ));
    let room = plane.store.ensure_dm(&bot.id).unwrap();
    result_of(&rpc(
        &mut plane,
        "send",
        "room/send",
        json!({"conversationId":room.id,"content":"go", "workspaceId":workspace["id"]}),
    ));
    let job = claim_cli_job(&plane);
    result_of(&rpc(
        &mut plane,
        "cancel",
        "room/interrupt",
        json!({"conversationId":room.id}),
    ));
    assert!(plane.wait_room_dispatches(&room.id, Duration::from_secs(10)));
    let polling = plane
        .rpc_cli_dispatch_claim(&json!({"hostId":"fixture-host","backendIds":["cli:codex"]}))
        .unwrap();
    assert!(
        polling["cancels"]
            .as_array()
            .unwrap()
            .contains(&job["runId"])
    );
    let late = plane.rpc_cli_dispatch_complete(&json!({"hostId":"fixture-host","conversationId":room.id,"requestId":job["requestId"],"runId":job["runId"],"text":"late answer","sessionId":"late-session"})).unwrap();
    assert_eq!(late["status"], "canceled");
    assert_eq!(plane.store.room_attention(&room.id).unwrap().1.len(), 1);
    assert_eq!(
        plane
            .store
            .list_bindings(Some(&bot.id), Some(&room.id))
            .unwrap()[0]
            .status,
        "orphaned"
    );
    assert!(
        !plane
            .store
            .latest_room_messages(&room.id, 200)
            .unwrap()
            .iter()
            .any(|message| message.content == "late answer")
    );
}

#[test]
fn all_mentioned_members_share_one_room_dispatch_lease() {
    let (mut plane, _) = plane("both can answer");
    init(&mut plane);
    let alice = plane
        .store
        .create_bot("Alice", "soul", "kernel", None)
        .unwrap();
    let bob = plane
        .store
        .create_bot("Bob", "soul", "kernel", None)
        .unwrap();
    let workspace = result_of(&rpc(
        &mut plane,
        "w",
        "workspace/create",
        json!({"title":"both"}),
    ));
    let room = plane
        .store
        .create_room("group", "both", &[alice.id.clone(), bob.id.clone()])
        .unwrap();
    let result = result_of(&rpc(
        &mut plane,
        "send",
        "room/send",
        json!({"conversationId":room.id,"content":"@Alice @Bob collaborate", "workspaceId":workspace["id"]}),
    ));
    assert_eq!(result["dispatched"].as_array().unwrap().len(), 2);
    assert!(plane.wait_room_dispatches(&room.id, Duration::from_secs(10)));
    let messages = plane.store.latest_room_messages(&room.id, 200).unwrap();
    assert_eq!(
        messages
            .iter()
            .filter(|message| message.sender == "bot")
            .count(),
        2
    );
}

#[test]
fn recovered_cli_turn_is_not_claimed_again() {
    let (mut plane, _) = plane("unused");
    init(&mut plane);
    let bot = plane
        .store
        .create_bot("CLI", "soul", "cli", Some("cli:codex"))
        .unwrap();
    let workspace = result_of(&rpc(
        &mut plane,
        "w",
        "workspace/create",
        json!({"title":"cli-recovery"}),
    ));
    let room = plane.store.ensure_dm(&bot.id).unwrap();
    result_of(&rpc(
        &mut plane,
        "send",
        "room/send",
        json!({"conversationId":room.id,"content":"go", "workspaceId":workspace["id"]}),
    ));
    let job = claim_cli_job(&plane);
    let binding = plane
        .store
        .list_bindings(Some(&bot.id), Some(&room.id))
        .unwrap()
        .remove(0);
    let persisted = plane
        .store
        .room_cli_dispatches(&room.id, &binding.id)
        .unwrap()
        .remove(0);
    plane
        .store
        .complete_turn_idempotent(persisted.meta["turnId"].as_str().unwrap(), "interrupted")
        .unwrap();
    let after = plane
        .rpc_cli_dispatch_claim(&json!({"hostId":"fixture-host","backendIds":["cli:codex"]}))
        .unwrap();
    assert!(after["jobs"].as_array().unwrap().is_empty());
    assert!(after["cancels"].as_array().unwrap().contains(&job["runId"]));
    assert!(plane.wait_room_dispatches(&room.id, Duration::from_secs(10)));
    assert_eq!(plane.store.room_attention(&room.id).unwrap().1.len(), 1);
}

#[test]
fn long_room_preserves_unconsumed_suffix_and_does_not_watermark_new_arrivals() {
    let (mut plane, _) = plane("bounded answer");
    init(&mut plane);
    let bot = plane.store.ensure_default_bot().unwrap();
    let workspace = result_of(&rpc(
        &mut plane,
        "w",
        "workspace/create",
        json!({"title":"bounded"}),
    ));
    let room = plane
        .store
        .create_room("group", "bounded", &[bot.id.clone()])
        .unwrap();
    for index in 0..205 {
        plane
            .store
            .append_room_message(
                &room.id,
                knorvia_store::RoomMessageInput::user_message(&format!("m{index}")),
            )
            .unwrap();
    }
    result_of(&rpc(
        &mut plane,
        "send",
        "room/send",
        json!({"conversationId":room.id,"content":"@Knorvia continue", "workspaceId":workspace["id"]}),
    ));
    let arrival = plane
        .store
        .append_room_message(
            &room.id,
            knorvia_store::RoomMessageInput::user_message("arrived during execution"),
        )
        .unwrap();
    assert!(plane.wait_room_dispatches(&room.id, Duration::from_secs(30)));
    let binding = plane
        .store
        .list_bindings(Some(&bot.id), Some(&room.id))
        .unwrap()
        .remove(0);
    assert_eq!(
        binding.last_delivered_seq, 200,
        "the first bounded prefix, never the latest head"
    );
    let suffix = plane
        .store
        .list_room_messages(&room.id, binding.last_delivered_seq + 1, 200)
        .unwrap();
    assert_eq!(suffix[0].content, "m200");
    assert!(suffix.iter().any(|message| message.id == arrival.id));
}

#[test]
fn explicit_checkpoint_replaces_only_covered_context_and_pins_its_version() {
    let (mut plane, _) = plane("checkpoint answer");
    init(&mut plane);
    let bot = plane.store.ensure_default_bot().unwrap();
    let workspace = result_of(&rpc(
        &mut plane,
        "w",
        "workspace/create",
        json!({"title":"checkpoint"}),
    ));
    let room = plane
        .store
        .create_room("group", "checkpoint", &[bot.id.clone()])
        .unwrap();
    let old = plane
        .store
        .append_room_message(
            &room.id,
            knorvia_store::RoomMessageInput::user_message("OLD_RAW_CONTEXT_CANARY"),
        )
        .unwrap();
    plane
        .store
        .checkpoint_room(&room.id, "User confirmed summary", old.seq, room.revision)
        .unwrap();
    result_of(&rpc(
        &mut plane,
        "send",
        "room/send",
        json!({"conversationId":room.id,"content":"@Knorvia NEW_UNREAD_CANARY", "workspaceId":workspace["id"]}),
    ));
    assert!(plane.wait_room_dispatches(&room.id, Duration::from_secs(30)));
    let answer = plane
        .store
        .latest_room_messages(&room.id, 1)
        .unwrap()
        .remove(0);
    let history = plane
        .store
        .read_turn_history(answer.meta["turnId"].as_str().unwrap())
        .unwrap();
    let prompt = history
        .items
        .iter()
        .find(|item| item.kind == "userMessage")
        .unwrap()
        .payload["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(prompt.contains("checkpoint v1"));
    assert!(prompt.contains("User confirmed summary"));
    assert!(prompt.contains("NEW_UNREAD_CANARY"));
    assert!(!prompt.contains("OLD_RAW_CONTEXT_CANARY"));
}

fn plane(answer: &str) -> (ControlPlane, std::path::PathBuf) {
    let base = std::env::temp_dir().join(format!(
        "knorvia-dispatch-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&base).unwrap();
    let plane = ControlPlane::open_with_executor(
        layout(base.clone()),
        Box::new(RunnerExecutor::new(answer)),
    )
    .unwrap();
    (plane, base)
}

fn rpc(plane: &mut ControlPlane, id: &str, method: &str, params: Value) -> Value {
    let response = plane
        .handle_json(
            &json!({"jsonrpc":"2.0", "id": id, "method": method, "params": params}).to_string(),
        )
        .unwrap()
        .unwrap();
    serde_json::from_str(&response).unwrap()
}

fn result_of(response: &Value) -> Value {
    response
        .get("result")
        .cloned()
        .unwrap_or_else(|| panic!("expected result, got {response}"))
}

fn init(plane: &mut ControlPlane) {
    let response = rpc(
        plane,
        "initialize",
        "initialize",
        json!({
            "protocol": {"major": 1, "minor": 0},
            "client": {"name": "knorvia_dispatch_tests", "version": "1"},
            "capabilities": ["thread"]
        }),
    );
    assert!(response.get("error").is_none(), "{response}");
    plane
        .handle_json(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
        .unwrap();
}

#[test]
fn group_dispatch_pins_soul_revision_reuses_binding_and_watermarks() {
    let (mut plane, _home) = plane("the coordinated answer");
    init(&mut plane);

    let bot = result_of(&rpc(&mut plane, "b", "bot/ensureDefault", json!({})));
    let bot_id = bot["id"].as_str().unwrap().to_string();
    let workspace = result_of(&rpc(
        &mut plane,
        "w",
        "workspace/create",
        json!({"title": "dispatch"}),
    ));
    let workspace_id = workspace["id"].as_str().unwrap().to_string();
    let room = result_of(&rpc(
        &mut plane,
        "r",
        "room/create",
        json!({"kind": "group", "title": "war room", "botIds": [bot_id]}),
    ));
    let conversation_id = room["id"].as_str().unwrap().to_string();

    let send = result_of(&rpc(
        &mut plane,
        "s1",
        "room/send",
        json!({"conversationId": conversation_id, "content": format!("@Knorvia please plan"), "workspaceId": workspace_id}),
    ));
    assert_eq!(send["dispatched"].as_array().unwrap().len(), 1);
    assert!(plane.wait_room_dispatches(&conversation_id, Duration::from_secs(30)));

    let transcript = result_of(&rpc(
        &mut plane,
        "m",
        "room/messages",
        json!({"conversationId": conversation_id}),
    ));
    let messages = transcript["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2, "user message + bot answer");
    assert_eq!(messages[0]["sender"], "user");
    assert_eq!(messages[1]["sender"], "bot");
    assert_eq!(messages[1]["content"], "the coordinated answer");
    assert_eq!(messages[1]["meta"]["soulRevision"], 1);
    let turn_id = messages[1]["meta"]["turnId"].as_str().unwrap().to_string();
    assert!(turn_id.starts_with("turn_"));
    let binding_id = messages[1]["meta"]["bindingId"]
        .as_str()
        .unwrap()
        .to_string();

    // The watermark covers everything the bot consumed.
    let binding = result_of(&rpc(
        &mut plane,
        "bind",
        "sessionBinding/read",
        json!({"bindingId": binding_id}),
    ));
    assert_eq!(binding["lastDeliveredSeq"], messages[0]["seq"]);

    // Second dispatch reuses the same binding (same session) and pins the
    // then-current soul revision.
    let updated = result_of(&rpc(
        &mut plane,
        "soul",
        "bot/updateSoul",
        json!({"botId": bot_id, "soul": "revised soul"}),
    ));
    assert_eq!(updated["soulRevision"], 2);

    let send2 = result_of(&rpc(
        &mut plane,
        "s2",
        "room/send",
        json!({"conversationId": conversation_id, "content": "@Knorvia again", "workspaceId": workspace_id}),
    ));
    assert_eq!(send2["dispatched"].as_array().unwrap().len(), 1);
    assert!(plane.wait_room_dispatches(&conversation_id, Duration::from_secs(30)));

    let transcript = result_of(&rpc(
        &mut plane,
        "m2",
        "room/messages",
        json!({"conversationId": conversation_id}),
    ));
    let messages = transcript["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 4);
    assert_eq!(
        messages[3]["meta"]["soulRevision"], 2,
        "new turn pins the new revision"
    );
    assert_eq!(
        messages[3]["meta"]["bindingId"].as_str().unwrap(),
        binding_id
    );
}

#[test]
fn pass_answers_have_a_durable_outcome_and_advance_the_watermark() {
    let (mut plane, _home) = plane("[PASS]");
    init(&mut plane);
    let bot = result_of(&rpc(&mut plane, "b", "bot/ensureDefault", json!({})));
    let bot_id = bot["id"].as_str().unwrap().to_string();
    let workspace = result_of(&rpc(
        &mut plane,
        "w",
        "workspace/create",
        json!({"title": "pass"}),
    ));
    let room = result_of(&rpc(
        &mut plane,
        "r",
        "room/create",
        json!({"kind": "dm", "title": "dm", "botIds": [bot_id]}),
    ));
    let conversation_id = room["id"].as_str().unwrap().to_string();
    let send = result_of(&rpc(
        &mut plane,
        "s",
        "room/send",
        json!({"conversationId": conversation_id, "content": "anything", "workspaceId": workspace["id"]}),
    ));
    assert_eq!(
        send["dispatched"].as_array().unwrap().len(),
        1,
        "a DM dispatches its member"
    );
    assert!(plane.wait_room_dispatches(&conversation_id, Duration::from_secs(30)));

    let transcript = result_of(&rpc(
        &mut plane,
        "m",
        "room/messages",
        json!({"conversationId": conversation_id}),
    ));
    let messages = transcript["messages"].as_array().unwrap();
    assert_eq!(
        messages.len(),
        2,
        "a pass retains one durable non-bot outcome"
    );
    assert_eq!(messages[1]["meta"]["dispatchStatus"], "pass");
    // The watermark still moved: the pass consumed the message.
    let bindings = result_of(&rpc(
        &mut plane,
        "bl",
        "sessionBinding/list",
        json!({"conversationId": conversation_id}),
    ));
    assert_eq!(bindings[0]["lastDeliveredSeq"], messages[0]["seq"]);
}

#[test]
fn unmapped_thread_with_history_is_re_anchored_not_reused() {
    // Simulates the A09 crash window: the first dispatch wrote product facts
    // (turn items) but died before the kernel session was ever bound. The
    // executor therefore reports no mapping; the next dispatch must mark the
    // old generation lost and start a fresh session instead of failing forever.
    let (mut plane, _home) = plane("fresh answer");
    init(&mut plane);
    // Swap in an unmapped executor: start_write_turn binds on success, but
    // this executor's map starts false and the FIRST turn is refused at
    // admission, mirroring "no provider configured" on the crashed boot.
    let base = std::env::temp_dir().join(format!(
        "knorvia-dispatch-unmapped-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&base).unwrap();
    let mut plane = ControlPlane::open_with_executor(
        layout(base.clone()),
        Box::new(RunnerExecutor::unmapped("recovered answer")),
    )
    .unwrap();
    init(&mut plane);

    let bot = result_of(&rpc(&mut plane, "b", "bot/ensureDefault", json!({})));
    let bot_id = bot["id"].as_str().unwrap().to_string();
    let workspace = result_of(&rpc(
        &mut plane,
        "w",
        "workspace/create",
        json!({"title": "reanchor"}),
    ));
    let room = result_of(&rpc(
        &mut plane,
        "r",
        "room/create",
        json!({"kind": "group", "title": "reanchor room", "botIds": [bot_id]}),
    ));
    let conversation_id = room["id"].as_str().unwrap().to_string();

    // First dispatch: admission fails (executor refuses to bind), leaving a
    // system fact and product history but no kernel mapping.
    let send = result_of(&rpc(
        &mut plane,
        "s1",
        "room/send",
        json!({"conversationId": conversation_id, "content": "@Knorvia one", "workspaceId": workspace["id"]}),
    ));
    assert_eq!(send["dispatched"].as_array().unwrap().len(), 1);
    assert!(plane.wait_room_dispatches(&conversation_id, Duration::from_secs(30)));

    // Second dispatch: detects history-without-mapping and re-anchors. The
    // re-anchored session binds on its first successful turn, so the answer
    // lands and the binding generation moved forward.
    result_of(&rpc(
        &mut plane,
        "s2",
        "room/send",
        json!({"conversationId": conversation_id, "content": "@Knorvia two", "workspaceId": workspace["id"]}),
    ));
    assert!(plane.wait_room_dispatches(&conversation_id, Duration::from_secs(30)));
    let bindings = result_of(&rpc(
        &mut plane,
        "bl",
        "sessionBinding/list",
        json!({"conversationId": conversation_id}),
    ));
    let lost = bindings
        .as_array()
        .unwrap()
        .iter()
        .find(|binding| binding["status"] == "orphaned" || binding["status"] == "superseded")
        .expect("the pre-crash generation must be retired with a visible reason");
    assert!(
        lost["lostReason"]
            .as_str()
            .unwrap()
            .contains("kernel session mapping missing")
    );
    let active = bindings[0]
        .as_object()
        .map(|_| bindings[0].clone())
        .unwrap();
    assert_eq!(active["status"], "active");
    assert!(active["bindingGeneration"].as_u64().unwrap() >= 2);
    let transcript = result_of(&rpc(
        &mut plane,
        "m",
        "room/messages",
        json!({"conversationId": conversation_id}),
    ));
    let messages = transcript["messages"].as_array().unwrap();
    assert!(
        messages
            .iter()
            .any(|m| m["sender"] == "bot" && m["content"] == "recovered answer"),
        "the re-anchored session must answer"
    );
}

#[test]
fn group_without_mention_dispatches_nothing_and_double_send_is_busy_or_queued() {
    let (mut plane, _home) = plane("unused");
    init(&mut plane);
    let bot = result_of(&rpc(&mut plane, "b", "bot/ensureDefault", json!({})));
    let bot_id = bot["id"].as_str().unwrap().to_string();
    let workspace = result_of(&rpc(
        &mut plane,
        "w",
        "workspace/create",
        json!({"title": "quiet"}),
    ));
    let room = result_of(&rpc(
        &mut plane,
        "r",
        "room/create",
        json!({"kind": "group", "title": "quiet room", "botIds": [bot_id]}),
    ));
    let conversation_id = room["id"].as_str().unwrap().to_string();
    let send = result_of(&rpc(
        &mut plane,
        "s",
        "room/send",
        json!({"conversationId": conversation_id, "content": "no mention here", "workspaceId": workspace["id"]}),
    ));
    assert_eq!(send["dispatched"].as_array().unwrap().len(), 0);
    assert!(plane.wait_room_dispatches(&conversation_id, Duration::from_secs(5)));
    let transcript = result_of(&rpc(
        &mut plane,
        "m",
        "room/messages",
        json!({"conversationId": conversation_id}),
    ));
    assert_eq!(transcript["messages"].as_array().unwrap().len(), 1);
}

#[test]
fn non_member_mention_transfers_to_dm_and_routes_reply_to_source_room() {
    let (mut plane, _home) = plane("transfer answer");
    init(&mut plane);
    let insider = result_of(&rpc(&mut plane, "b0", "bot/ensureDefault", json!({})));
    let outsider = result_of(&rpc(
        &mut plane,
        "b1",
        "bot/create",
        json!({"name": "Outsider", "soul": "outside soul"}),
    ));
    let outsider_id = outsider["id"].as_str().unwrap().to_string();
    let workspace = result_of(&rpc(
        &mut plane,
        "w",
        "workspace/create",
        json!({"title": "transfer"}),
    ));
    let room = result_of(&rpc(
        &mut plane,
        "r",
        "room/create",
        json!({"kind": "group", "title": "source room", "botIds": [insider["id"]]}),
    ));
    let conversation_id = room["id"].as_str().unwrap().to_string();

    let send = result_of(&rpc(
        &mut plane,
        "s",
        "room/send",
        json!({"conversationId": conversation_id, "content": "@Outsider please help from afar", "workspaceId": workspace["id"]}),
    ));
    let dispatched = send["dispatched"].as_array().unwrap();
    assert_eq!(dispatched.len(), 1, "only the non-member is mentioned");
    assert_eq!(dispatched[0]["viaTransfer"], true);
    let dm_conversation = dispatched[0]["conversationId"]
        .as_str()
        .unwrap()
        .to_string();

    assert!(plane.wait_room_dispatches(&conversation_id, Duration::from_secs(30)));
    assert!(plane.wait_room_dispatches(&dm_conversation, Duration::from_secs(30)));

    // The reply landed in the SOURCE room, correlated to the envelope.
    let transcript = result_of(&rpc(
        &mut plane,
        "m",
        "room/messages",
        json!({"conversationId": conversation_id}),
    ));
    let messages = transcript["messages"].as_array().unwrap();
    let reply = messages
        .iter()
        .find(|m| m["sender"] == "bot" && m["botId"] == outsider["id"])
        .unwrap_or_else(|| panic!("outsider reply missing from source room"));
    assert_eq!(reply["content"], "transfer answer");
    assert!(
        reply["replyToMessageId"]
            .as_str()
            .unwrap()
            .starts_with("xfer_")
    );
    assert_eq!(reply["correlationId"], send["userMessage"]["id"]);

    // The DM holds the envelope, and the envelope is acked.
    let dm = result_of(&rpc(
        &mut plane,
        "dm",
        "room/messages",
        json!({"conversationId": dm_conversation}),
    ));
    let dm_messages = dm["messages"].as_array().unwrap();
    let envelope = dm_messages
        .iter()
        .find(|m| m["messageId"].is_string())
        .unwrap_or_else(|| panic!("envelope missing in DM"));
    assert_eq!(envelope["status"], "acked");
    assert_eq!(envelope["targetBotId"], outsider["id"]);
    assert_eq!(envelope["sourceRoomId"], room["id"]);
}
