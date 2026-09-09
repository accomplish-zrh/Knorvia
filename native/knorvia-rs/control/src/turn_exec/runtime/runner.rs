//! A runner owns one Turn, including approvals and terminal persistence.

use super::*;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub(super) fn status(kernel: &str) -> &'static str {
    match kernel {
        "completed" => "completed",
        "interrupted" => "cancelled",
        _ => "failed",
    }
}

fn append(
    runtime: &Runtime,
    req: &TurnRequest,
    store: &ProductStore,
    kind: &str,
    payload: Value,
) -> Result<(), ProtocolError> {
    let item = store
        .append_item(
            &req.thread_id,
            &req.turn_id,
            kind,
            if kind == "error" {
                "failed"
            } else {
                "completed"
            },
            payload,
        )
        .map_err(|e| e.into_protocol())?;
    runtime.emit(
        "turn/event",
        json!({"threadId": req.thread_id, "turnId": req.turn_id,
        "kind": item.kind, "payload": item.payload, "item": item}),
    );
    Ok(())
}

fn key(item: &ka::KernelTurnItem) -> String {
    item.payload
        .get("kernelItemId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| json!([item.kind, item.payload]).to_string())
}

pub(super) fn run(
    runtime: Arc<Runtime>,
    req: TurnRequest,
    store: Arc<ProductStore>,
    active: Arc<ActiveTurn>,
    first: Sender<String>,
) {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        execute(&runtime, &req, &store, &active, first)
    }))
    .unwrap_or_else(|_| Err(internal("kernel runner panicked")));
    let (terminal, error) = match outcome {
        Ok(value) => value,
        Err(error) => (
            "failed".to_string(),
            Some(json!({"category": error.category, "message": error.message})),
        ),
    };
    let persisted = persist_terminal(&runtime, &req, &store, &terminal, error.as_ref());
    active.done.store(true, Ordering::SeqCst);
    {
        let mut registry = runtime.active.lock().unwrap_or_else(|e| e.into_inner());
        if registry
            .get(&req.thread_id)
            .is_some_and(|entry| Arc::ptr_eq(entry, &active))
        {
            registry.remove(&req.thread_id);
        }
    }
    runtime
        .decisions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|_, owner| owner.turn_id != req.turn_id);
    runtime
        .user_inputs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|_, owner| owner.turn_id != req.turn_id);
    match persisted {
        Ok(()) => runtime.emit("turn/event", json!({"threadId": req.thread_id, "turnId": req.turn_id, "status": terminal, "error": error})),
        Err(error) => {
            eprintln!("Knorvia turn persistence failed: {error}");
            // No terminal notification without a durable terminal record.
            runtime.emit("turn/persistenceError", json!({"threadId": req.thread_id, "turnId": req.turn_id,
                "message": "Turn state could not be saved; reconnect and inspect recovery state"}));
        }
    }
}

fn persist_terminal(
    runtime: &Runtime,
    req: &TurnRequest,
    store: &ProductStore,
    terminal: &str,
    error: Option<&Value>,
) -> Result<(), ProtocolError> {
    // A diagnostic/approval write failure must not prevent a still-writable
    // Turn record from leaving running. Preserve the first persistence error
    // and emit only persistenceError unless every required write succeeded.
    let mut failure = None;
    match store.list_approvals(&req.thread_id) {
        Ok(approvals) => {
            for approval in approvals {
                if approval.turn_id == req.turn_id
                    && approval.status == "pending"
                    && let Err(error) = store.respond_approval(&approval.id, "deny")
                {
                    failure.get_or_insert_with(|| error.into_protocol());
                }
            }
        }
        Err(error) => {
            failure = Some(error.into_protocol());
        }
    }
    // A terminal turn cannot retain an actionable input card. Most normal
    // cancellation and timeout paths resolve it inside `on_user_input`, but
    // this covers runner failures between durable append and callback cleanup.
    // Preserve the request as one corrected product fact rather than leaving
    // a UI-visible pending input whose Kernel owner is gone.
    match store.list_turn_items(&req.thread_id, &req.turn_id) {
        Ok(items) => {
            for item in items.into_iter().filter(|item| {
                item.turn_id == req.turn_id
                    && item.kind == "userInput"
                    && item.status == "waiting_input"
            }) {
                let request = item.payload.get("request").cloned().unwrap_or(Value::Null);
                let corrected = if terminal == "cancelled" {
                    store.resolve_item(
                        &item.id,
                        "interrupted",
                        json!({
                            "request": request,
                            "answers": {},
                            "delivered": false,
                            "reason": "turn interrupted before an answer could be delivered",
                        }),
                    )
                } else {
                    store.mark_item_delivery_failed(
                        &item.id,
                        json!({
                            "request": request,
                            "answers": {},
                            "delivered": false,
                            "reason": "turn ended before an answer could be delivered",
                        }),
                    )
                };
                match corrected {
                    Ok(item) => runtime.emit(
                        "turn/event",
                        json!({
                            "threadId": req.thread_id,
                            "turnId": req.turn_id,
                            "kind": item.kind,
                            "payload": item.payload,
                            "item": item,
                        }),
                    ),
                    Err(error) => {
                        failure.get_or_insert_with(|| error.into_protocol());
                    }
                };
            }
        }
        Err(error) => {
            failure.get_or_insert_with(|| error.into_protocol());
        }
    }
    if let Some(error) = error
        && let Err(error) = append(runtime, req, store, "error", error.clone())
    {
        failure.get_or_insert(error);
    }
    if let Err(error) = store.complete_turn_idempotent(&req.turn_id, terminal) {
        failure.get_or_insert_with(|| error.into_protocol());
    }
    // Durable usage ledger: exactly one record per Turn, derived from the
    // Turn's final tokenUsage item. First write wins, so recovery replays
    // never duplicate consumption facts. A ledger write failure is a
    // diagnostic failure: it must not flip the Turn terminal state.
    match store.list_turn_items(&req.thread_id, &req.turn_id) {
        Ok(items) => {
            let model = runtime
                .persisted_settings(&req.thread_id)
                .ok()
                .and_then(|settings| settings.model)
                .filter(|model| !model.is_empty())
                .or_else(|| {
                    (!runtime.provider_model.is_empty()).then(|| runtime.provider_model.clone())
                })
                .unwrap_or_else(|| "unknown".into());
            let recorded_at_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if let Some(record) = knorvia_store::ProductStore::build_usage_record(
                &items,
                &req.thread_id,
                &req.turn_id,
                terminal,
                &model,
                &runtime.provider_id,
                recorded_at_ms,
            ) {
                if let Err(error) = store.record_usage(&record) {
                    failure.get_or_insert_with(|| error.into_protocol());
                }
            }
            if let Err(error) = record_child_usage(
                store,
                &items,
                req,
                &model,
                &runtime.provider_id,
                recorded_at_ms,
            ) {
                failure.get_or_insert(error);
            }
        }
        Err(error) => {
            failure = Some(error.into_protocol());
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn record_child_usage(
    store: &ProductStore,
    items: &[knorvia_protocol::Item],
    req: &TurnRequest,
    default_model: &str,
    provider: &str,
    recorded_at_ms: u64,
) -> Result<(), ProtocolError> {
    let mut models = HashMap::new();
    let mut groups: HashMap<(String, String), (Vec<knorvia_protocol::Item>, String)> =
        HashMap::new();
    for item in items {
        if item.kind == "collabAgentToolCall" {
            if let Some(model) = item.payload["model"].as_str() {
                for child in item.payload["receiverThreadIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    models.insert(child.to_string(), model.to_string());
                }
            }
        }
        if item.kind != "subAgent" {
            continue;
        }
        let (Some(thread), Some(turn)) = (
            item.payload["kernelThreadId"].as_str(),
            item.payload["kernelTurnId"].as_str(),
        ) else {
            continue;
        };
        let group = groups
            .entry((thread.into(), turn.into()))
            .or_insert_with(|| (Vec::new(), "interrupted".into()));
        if item.payload["event"] == "thread/tokenUsage/updated" {
            let mut usage = item.clone();
            usage.kind = "tokenUsage".into();
            usage.payload = item.payload["data"].clone();
            group.0.push(usage);
        } else if item.payload["event"] == "turn/completed" {
            group.1 = item.payload["data"]["turn"]["status"]
                .as_str()
                .unwrap_or("failed")
                .into();
        }
    }
    for ((kernel_thread, kernel_turn), (usage, status)) in groups {
        let model = models
            .get(&kernel_thread)
            .map(String::as_str)
            .unwrap_or(default_model);
        let digest = hex::encode(Sha256::digest(
            format!("{}\0{}\0{}", req.turn_id, kernel_thread, kernel_turn).as_bytes(),
        ));
        let identity = format!("agent_{}", &digest[..24]);
        if let Some(mut record) = ProductStore::build_usage_record(
            &usage,
            &req.thread_id,
            &identity,
            &status,
            model,
            provider,
            recorded_at_ms,
        ) {
            record.parent_turn_id = Some(req.turn_id.clone());
            record.kernel_thread_id = Some(kernel_thread);
            store
                .record_usage(&record)
                .map_err(|error| error.into_protocol())?;
        }
    }
    Ok(())
}

fn execute(
    runtime: &Arc<Runtime>,
    req: &TurnRequest,
    store: &Arc<ProductStore>,
    active: &Arc<ActiveTurn>,
    first: Sender<String>,
) -> Result<(String, Option<Value>), ProtocolError> {
    if active.cancelled.load(Ordering::SeqCst) {
        return Ok(("cancelled".into(), None));
    }
    let (session, thread, settings) = runtime.connection(req, store)?;
    if active.cancelled.load(Ordering::SeqCst) {
        return Ok(("cancelled".into(), None));
    }
    let seen = Arc::new(Mutex::new(HashSet::new()));
    let failure: Arc<Mutex<Option<ProtocolError>>> = Arc::new(Mutex::new(None));
    let on_item = {
        let runtime = Arc::clone(runtime);
        let req = req.clone();
        let store = Arc::clone(store);
        let seen = Arc::clone(&seen);
        let failure = Arc::clone(&failure);
        let session = Arc::clone(&session);
        move |item: &ka::KernelTurnItem| {
            // The control plane owns the single initial user input Item.
            if item.kind == "userMessage" {
                return;
            }
            let mut seen = seen.lock().unwrap_or_else(|e| e.into_inner());
            if seen.contains(&key(item)) {
                return;
            }
            match append(&runtime, &req, &store, &item.kind, item.payload.clone()) {
                Ok(()) => {
                    seen.insert(key(item));
                }
                Err(error) => {
                    *failure.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
                    session.terminate();
                }
            }
        }
    };
    let on_delta = {
        let runtime = Arc::clone(runtime);
        let req = req.clone();
        move |item_id: &str, delta: &str| {
            runtime.emit(
                "turn/event",
                json!({
            "threadId": req.thread_id, "turnId": req.turn_id, "kind": "agentMessage.delta",
            "payload": {"itemId": item_id, "text": delta}}),
            )
        }
    };
    let on_progress = {
        let runtime = Arc::clone(runtime);
        let req = req.clone();
        move |kind: &str, payload: &Value| {
            runtime.emit("turn/progress", json!({"threadId": req.thread_id, "turnId": req.turn_id, "kind": kind, "payload": payload}));
        }
    };
    let on_started = {
        let session = Arc::clone(&session);
        let thread = thread.clone();
        let active = Arc::clone(active);
        move |turn: &str| {
            *active.kernel.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((Arc::clone(&session), thread.clone(), turn.into()));
            if active.cancelled.load(Ordering::SeqCst)
                && session.send_turn_interrupt(&thread, turn).is_err()
            {
                session.terminate();
            }
        }
    };
    let on_approval = {
        let runtime = Arc::clone(runtime);
        let req = req.clone();
        let store = Arc::clone(store);
        let active = Arc::clone(active);
        let failure = Arc::clone(&failure);
        move |request: &ka::KernelApprovalRequest| {
            let decision = (|| {
                if active.request_cancelled(&request.payload) {
                    return Ok(ka::TurnDecision::Decline);
                }
                let mut digest = Sha256::new();
                digest.update(request.action.as_bytes());
                digest.update(b"\0");
                digest.update(request.payload.to_string());
                let digest = hex::encode(digest.finalize());
                let approval = store
                    .create_approval(&req.thread_id, &req.turn_id, &request.action, &digest)
                    .map_err(|e| e.into_protocol())?;
                let item = store.append_item(&req.thread_id, &req.turn_id, "tool.write", "waiting_approval",
                    json!({"approvalId": approval.id, "action": request.action, "digest": digest, "target": request.payload})).map_err(|e| e.into_protocol())?;
                let (tx, rx) = channel();
                runtime
                    .decisions
                    .lock()
                    .map_err(|e| internal(e.to_string()))?
                    .insert(
                        approval.id.clone(),
                        ApprovalOwner {
                            thread_id: req.thread_id.clone(),
                            turn_id: req.turn_id.clone(),
                            reply: tx,
                        },
                    );
                let _ = first.send(approval.id.clone());
                runtime.emit("approval/request", json!({"approvalId": approval.id, "threadId": req.thread_id, "turnId": req.turn_id,
                    "action": request.action, "digest": digest, "target": request.payload, "item": item}));
                let deadline = Instant::now() + Duration::from_secs(300);
                let decision = loop {
                    if active.request_cancelled(&request.payload) || Instant::now() >= deadline {
                        break ka::TurnDecision::Decline;
                    }
                    match rx.recv_timeout(Duration::from_millis(25)) {
                        Ok(decision) => break decision,
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(_) => break ka::TurnDecision::Decline,
                    }
                };
                runtime
                    .decisions
                    .lock()
                    .map_err(|e| internal(e.to_string()))?
                    .remove(&approval.id);
                if store
                    .read_approval(&approval.id)
                    .map_err(|e| e.into_protocol())?
                    .status
                    == "pending"
                {
                    store
                        .respond_approval(&approval.id, "deny")
                        .map_err(|e| e.into_protocol())?;
                }
                // Cancellation always wins over a simultaneously delivered allow.
                Ok::<_, ProtocolError>(if active.request_cancelled(&request.payload) {
                    ka::TurnDecision::Decline
                } else {
                    decision
                })
            })();
            match decision {
                Ok(decision) => decision,
                Err(error) => {
                    *failure.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
                    ka::TurnDecision::Decline
                }
            }
        }
    };
    let on_user_input = {
        let runtime = Arc::clone(runtime);
        let req = req.clone();
        let store = Arc::clone(store);
        let active = Arc::clone(active);
        let failure = Arc::clone(&failure);
        move |request: &ka::KernelUserInputRequest| {
            let response = (|| {
                if active.request_cancelled(&request.payload) {
                    return Ok(json!({"answers": {}}));
                }
                let item = store
                    .append_item(
                        &req.thread_id,
                        &req.turn_id,
                        "userInput",
                        "waiting_input",
                        json!({"request": request.payload}),
                    )
                    .map_err(|e| e.into_protocol())?;
                let (tx, rx) = channel();
                runtime
                    .user_inputs
                    .lock()
                    .map_err(|e| internal(e.to_string()))?
                    .insert(
                        item.id.clone(),
                        UserInputOwner {
                            thread_id: req.thread_id.clone(),
                            turn_id: req.turn_id.clone(),
                            reply: tx,
                        },
                    );
                runtime.emit(
                    "userInput/request",
                    json!({
                        "id": item.id,
                        "threadId": req.thread_id,
                        "turnId": req.turn_id,
                        "request": request.payload,
                        "item": item,
                    }),
                );
                let deadline = Instant::now() + Duration::from_secs(300);
                // The empty response is only a transport necessity for the
                // upstream request. Keep its product state truthful: a
                // timeout, cancellation, or lost responder is not a user
                // answer merely because the Kernel needs a reply to unblock.
                let (answers, resolution_status) = loop {
                    if active.request_cancelled(&request.payload) {
                        break (json!({"answers": {}}), "interrupted");
                    }
                    if Instant::now() >= deadline {
                        break (json!({"answers": {}}), "timed_out");
                    }
                    match rx.recv_timeout(Duration::from_millis(25)) {
                        Ok(answers) => {
                            if active.request_cancelled(&request.payload) {
                                break (json!({"answers": {}}), "interrupted");
                            }
                            break (answers, "answered");
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            break (json!({"answers": {}}), "interrupted");
                        }
                    }
                };
                runtime
                    .user_inputs
                    .lock()
                    .map_err(|e| internal(e.to_string()))?
                    .remove(&item.id);
                let current = store.read_item(&item.id).map_err(|e| e.into_protocol())?;
                let resolved = if current.status == "waiting_input" {
                    store
                        .resolve_item(
                            &item.id,
                            resolution_status,
                            json!({
                                "request": request.payload,
                                "answers": answers["answers"],
                                "delivered": resolution_status == "answered",
                            }),
                        )
                        .map_err(|e| e.into_protocol())?
                } else {
                    current
                };
                runtime.emit(
                    "turn/event",
                    json!({
                        "threadId": req.thread_id,
                        "turnId": req.turn_id,
                        "kind": resolved.kind,
                        "payload": resolved.payload,
                        "item": resolved,
                    }),
                );
                Ok::<_, ProtocolError>(answers)
            })();
            match response {
                Ok(response) => response,
                Err(error) => {
                    *failure.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
                    json!({"answers": {}})
                }
            }
        }
    };
    let options = ka::TurnRunOptions {
        sandbox: json!({"type": if req.read_only { "readOnly" } else { "workspaceWrite" }}),
        approval_policy: if req.read_only { "never" } else { "on-request" },
        settings: Runtime::adapter_settings(&settings),
        on_approval: if req.read_only {
            None
        } else {
            Some(Box::new(on_approval))
        },
        on_item: Some(Box::new(on_item)),
        on_delta: Some(Box::new(on_delta)),
        on_progress: Some(Box::new(on_progress)),
        on_turn_started: Some(Box::new(on_started)),
        on_user_input: Some(Box::new(on_user_input)),
    };
    let result = session
        .run_turn(&thread, &req.prompt, options)
        .map_err(|e| internal(e.to_string()));
    if let Some(error) = failure.lock().unwrap_or_else(|e| e.into_inner()).take() {
        return Err(error);
    }
    let result = result?;
    for item in &result.items {
        if item.kind == "userMessage" {
            continue;
        }
        if seen
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key(item))
        {
            append(runtime, req, store, &item.kind, item.payload.clone())?;
        }
    }
    Ok((status(&result.status).into(), result.error))
}

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;
