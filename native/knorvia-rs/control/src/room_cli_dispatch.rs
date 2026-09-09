//! External CLIs execute only on the attached desktop host. The daemon owns
//! the room intent, product turn, anchor and terminal facts throughout.
use super::*;

pub(super) fn run(args: super::run_bot_dispatch::Args) -> Result<(), ProtocolError> {
    let store = &args.store;
    let bot = store
        .read_bot(&args.bot_id)
        .map_err(|e| e.into_protocol())?;
    let backend_id = bot
        .backend_binding_id
        .as_deref()
        .ok_or_else(|| invalid("CLI Bot has no backend binding"))?;
    let cwd = match store
        .read_workspace_cwd(&args.workspace_id)
        .map_err(|e| e.into_protocol())?
    {
        Some(cwd) => Some(cwd),
        None => {
            let dir = store
                .paths()
                .task_workspaces()
                .join("bots")
                .join(&args.conversation_id)
                .join(&bot.id);
            std::fs::create_dir_all(&dir).map_err(|error| internal(error.to_string()))?;
            Some(dir.to_string_lossy().into_owned())
        }
    };
    let mut binding = store
        .resolve_session_binding(
            &bot.id,
            &args.conversation_id,
            backend_id,
            BindingIdentity {
                host_id: Some(&args.host_id),
                account_fingerprint: args.account_fingerprint.as_deref(),
                canonical_cwd: cwd.as_deref(),
                backend_version: None,
            },
        )
        .map_err(|e| e.into_protocol())?
        .binding;
    if binding.knorvia_thread_id.is_none() {
        let thread = store
            .create_thread(
                &args.workspace_id,
                &format!("{} · {}", bot.name, args.room_title),
                None,
                None,
            )
            .map_err(|e| e.into_protocol())?;
        binding = store
            .attach_binding_session(&binding.id, &thread.id, None, Some(binding.revision))
            .map_err(|e| e.into_protocol())?;
    }
    let thread_id = binding.knorvia_thread_id.clone().unwrap();
    args.executor
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .configure_thread(
            &thread_id,
            &super::super::KernelTurnSettings {
                cwd: cwd.clone(),
                ..Default::default()
            },
        )?;
    // A prior completed host response can be recovered without invoking the
    // CLI a second time. Claimed requests have unknown side effects after a
    // daemon restart: mark the old anchor lost and require a new user action.
    for job in store
        .room_cli_dispatches(&args.conversation_id, &binding.id)
        .map_err(|e| e.into_protocol())?
    {
        let status = job.meta["cliDispatch"]["status"].as_str().unwrap_or("");
        if matches!(status, "queued" | "claimed") {
            store
                .cancel_cli_dispatch(
                    &args.conversation_id,
                    job.meta["cliDispatch"]["requestId"].as_str().unwrap(),
                )
                .map_err(|e| e.into_protocol())?;
            store.mark_binding_lost(&binding.id, "Previous CLI dispatch outcome was unknown after restart; explicit fresh conversation required", None).map_err(|e| e.into_protocol())?;
            return Ok(());
        }
        let seq = job.meta["upToSeq"].as_u64().unwrap_or(0);
        if status == "completed" && seq > binding.last_delivered_seq {
            binding = store
                .attach_binding_session(
                    &binding.id,
                    &thread_id,
                    job.meta["cliDispatch"]["resultSessionId"].as_str(),
                    None,
                )
                .map_err(|e| e.into_protocol())?;
            binding = store
                .record_binding_delivery(&binding.id, seq, Some(binding.revision))
                .map_err(|e| e.into_protocol())?;
        }
    }
    let room = store
        .read_room(&args.conversation_id)
        .map_err(|e| e.into_protocol())?;
    let checkpoint = room.checkpoints.last().filter(|checkpoint| {
        checkpoint.through_seq <= args.up_to_seq
            && checkpoint.through_seq > binding.last_delivered_seq
    });
    let mut through_seq = checkpoint.map_or(binding.last_delivered_seq, |checkpoint| {
        checkpoint.through_seq
    });
    let mut transcript = String::new();
    let suffix = store
        .list_room_messages(
            &args.conversation_id,
            through_seq + 1,
            knorvia_store::MAX_MESSAGES_RETURNED,
        )
        .map_err(|e| e.into_protocol())?;
    for message in suffix
        .iter()
        .filter(|message| message.seq <= args.up_to_seq)
    {
        if message.meta["hidden"] == true {
            through_seq = message.seq;
            continue;
        }
        let line = format!(
            "[seq {}] {}: {}\n",
            message.seq,
            message.bot_id.as_deref().unwrap_or(&message.sender),
            message.content
        );
        if transcript.len() + line.len() > 24_000 {
            break;
        }
        transcript.push_str(&line);
        through_seq = message.seq;
    }
    if transcript.is_empty() && checkpoint.is_none() {
        store
            .append_room_message(
                &args.conversation_id,
                RoomMessageInput {
                    sender: "system",
                    content: "未投递消息超出上下文预算，请保存群摘要后继续。",
                    meta: json!({"needsUser":true}),
                    ..RoomMessageInput::user_message("")
                },
            )
            .map_err(|e| e.into_protocol())?;
        return Ok(());
    }
    let summary = checkpoint
        .map(|entry| {
            format!(
                "User-authored checkpoint v{} through seq {}:\n{}\n",
                entry.version, entry.through_seq, entry.summary
            )
        })
        .unwrap_or_default();
    let prompt = format!(
        "You are {} in conversation {}.\nSoul revision {}:\n{}\n\n{}Undelivered room messages:\n{}",
        bot.name, args.room_title, bot.soul_revision, bot.soul, summary, transcript
    );
    let turn = store
        .start_turn(&thread_id)
        .map_err(|e| e.into_protocol())?;
    store.append_item(&thread_id, &turn.id, "userMessage", "completed", json!({"text":prompt,"roomDispatch":{"conversationId":args.conversation_id,"soulRevision":bot.soul_revision}})).map_err(|e| e.into_protocol())?;
    let request_id = format!("cli_{}", turn.id);
    let run_id = format!("clirun_{}", turn.id);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let timeout_ms = args.timeout.as_millis().min(660_000) as u64;
    store.append_room_message(&args.conversation_id, RoomMessageInput {
        sender: "system", content: "等待本机 CLI 执行…",
        meta: json!({"hidden":true,"bindingId":binding.id,"upToSeq":through_seq,"turnId":turn.id,"soulRevision":bot.soul_revision,
            "cliDispatch":{"requestId":request_id,"runId":run_id,"backendId":backend_id,"botId":bot.id,"status":"queued","prompt":prompt,"cwd":cwd,"sessionId":binding.external_session_id,"resume":binding.external_session_id.is_some(),"timeoutMs":timeout_ms,"deadlineMs":now_ms+timeout_ms}}),
        ..RoomMessageInput::user_message("")
    }).map_err(|e| e.into_protocol())?;
    let deadline = Instant::now() + args.timeout;
    let result = loop {
        if args.cancel.load(Ordering::SeqCst) || Instant::now() >= deadline {
            store
                .cancel_cli_dispatch(&args.conversation_id, &request_id)
                .map_err(|e| e.into_protocol())?;
        }
        let job = store
            .room_cli_dispatches(&args.conversation_id, &binding.id)
            .map_err(|e| e.into_protocol())?
            .into_iter()
            .find(|message| message.meta["cliDispatch"]["requestId"].as_str() == Some(&request_id))
            .ok_or_else(|| internal("CLI dispatch disappeared"))?;
        if !matches!(
            job.meta["cliDispatch"]["status"].as_str(),
            Some("queued" | "claimed")
        ) {
            break job;
        }
        std::thread::sleep(TURN_POLL_INTERVAL);
    };
    let completed = result.meta["cliDispatch"]["status"] == "completed";
    if completed {
        binding = store
            .attach_binding_session(
                &binding.id,
                &thread_id,
                result.meta["cliDispatch"]["resultSessionId"].as_str(),
                None,
            )
            .map_err(|e| e.into_protocol())?;
        store
            .append_item(
                &thread_id,
                &turn.id,
                "agentMessage",
                "completed",
                json!({"text":result.content,"backendId":backend_id}),
            )
            .map_err(|e| e.into_protocol())?;
    } else {
        store
            .append_item(
                &thread_id,
                &turn.id,
                "error",
                "failed",
                json!({"message":result.content,"backendId":backend_id}),
            )
            .map_err(|e| e.into_protocol())?;
    }
    store
        .complete_turn_idempotent(&turn.id, if completed { "completed" } else { "failed" })
        .map_err(|e| e.into_protocol())?;
    store
        .record_usage(&knorvia_store::UsageRecord {
            thread_id: thread_id.clone(),
            turn_id: turn.id.clone(),
            parent_turn_id: None,
            kernel_thread_id: None,
            turn_status: if completed { "completed" } else { "failed" }.to_string(),
            model: "unknown".to_string(),
            provider_id: backend_id.to_string(),
            input_tokens: 0,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 0,
            model_context_window: None,
            completeness: "unknown".to_string(),
            cache_fields_reported: None,
            recorded_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        })
        .map_err(|e| e.into_protocol())?;
    store
        .record_binding_delivery(&binding.id, through_seq, Some(binding.revision))
        .map_err(|e| e.into_protocol())?;
    if !completed {
        store.mark_binding_lost(&binding.id, "CLI execution failed or was canceled; external side effects/session outcome may be unknown. A new user turn will explicitly start a new generation.", None).map_err(|e| e.into_protocol())?;
    }
    Ok(())
}
