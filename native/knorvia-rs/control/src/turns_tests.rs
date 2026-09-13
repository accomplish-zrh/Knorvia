use super::*;
use knorvia_kernel_adapter as ka;
use knorvia_platform_paths::layout;
use knorvia_store::ProductStore;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Probe {
    requests: Mutex<Vec<TurnRequest>>,
    steers: Mutex<Vec<(String, String, String, Option<String>)>>,
    user_input_answers: Mutex<Vec<(String, Value)>>,
    bindings: Mutex<Vec<(String, String, KernelTurnSettings)>>,
    fork_calls: Mutex<usize>,
    discarded_kernel_threads: Mutex<Vec<String>>,
    decline_calls: Mutex<usize>,
    settings: Mutex<HashMap<String, KernelTurnSettings>>,
}

struct RecordingExecutor {
    probe: Arc<Probe>,
    leave_turn_running: bool,
    approval_owner: bool,
    approval_forwarded: bool,
    user_input_owner: bool,
    user_input_forwarded: bool,
    interrupt_handled: bool,
}

impl RecordingExecutor {
    fn new(probe: Arc<Probe>) -> Self {
        Self {
            probe,
            leave_turn_running: false,
            approval_owner: false,
            approval_forwarded: false,
            user_input_owner: true,
            user_input_forwarded: true,
            interrupt_handled: false,
        }
    }
}

impl TurnExecutor for RecordingExecutor {
    fn configure_thread(
        &mut self,
        thread_id: &str,
        settings: &KernelTurnSettings,
    ) -> Result<(), ProtocolError> {
        let mut all = self.probe.settings.lock().unwrap();
        let current = all.get(thread_id).cloned().unwrap_or_default();
        all.insert(thread_id.to_string(), current.merge(settings));
        Ok(())
    }

    fn thread_settings(
        &self,
        thread_id: &str,
    ) -> Result<Option<KernelTurnSettings>, ProtocolError> {
        Ok(self.probe.settings.lock().unwrap().get(thread_id).cloned())
    }

    fn has_kernel_thread(&self, thread_id: &str) -> Result<bool, ProtocolError> {
        Ok(self
            .probe
            .bindings
            .lock()
            .unwrap()
            .iter()
            .any(|(product, _, _)| product == thread_id))
    }

    fn fork_kernel_thread(
        &mut self,
        _source_thread_id: &str,
        _settings: &KernelTurnSettings,
    ) -> Result<String, ProtocolError> {
        *self.probe.fork_calls.lock().unwrap() += 1;
        Ok("kernel_fork_1".into())
    }

    fn bind_kernel_thread(
        &mut self,
        thread_id: &str,
        kernel_thread_id: &str,
        settings: &KernelTurnSettings,
    ) -> Result<(), ProtocolError> {
        self.probe.bindings.lock().unwrap().push((
            thread_id.to_string(),
            kernel_thread_id.to_string(),
            settings.clone(),
        ));
        self.configure_thread(thread_id, settings)
    }

    fn discard_kernel_thread(&mut self, kernel_thread_id: &str) -> Result<(), ProtocolError> {
        self.probe
            .discarded_kernel_threads
            .lock()
            .unwrap()
            .push(kernel_thread_id.to_string());
        Ok(())
    }

    fn steer_turn(
        &mut self,
        thread_id: &str,
        turn_id: &str,
        input: &str,
        client_message_id: Option<&str>,
    ) -> Result<(), ProtocolError> {
        self.probe.steers.lock().unwrap().push((
            thread_id.to_string(),
            turn_id.to_string(),
            input.to_string(),
            client_message_id.map(str::to_string),
        ));
        Ok(())
    }

    fn has_user_input_owner(&self, _item_id: &str) -> bool {
        self.user_input_owner
    }

    fn respond_user_input(&mut self, item_id: &str, answers: Value) -> Result<bool, ProtocolError> {
        if !self.user_input_forwarded {
            return Ok(false);
        }
        self.probe
            .user_input_answers
            .lock()
            .unwrap()
            .push((item_id.to_string(), answers));
        Ok(true)
    }

    fn start_turn(
        &mut self,
        req: &TurnRequest,
        store: Arc<ProductStore>,
    ) -> Result<(), ProtocolError> {
        self.probe.requests.lock().unwrap().push(req.clone());
        if self.leave_turn_running {
            return Ok(());
        }
        store
            .append_item(
                &req.thread_id,
                &req.turn_id,
                "agentMessage",
                "completed",
                json!({"text": "scripted result"}),
            )
            .map_err(|e| e.into_protocol())?;
        store
            .complete_turn(&req.turn_id, "completed")
            .map_err(|e| e.into_protocol())?;
        Ok(())
    }

    fn run_turn(&mut self, _req: &TurnRequest) -> Result<TurnOutcome, ProtocolError> {
        unreachable!("start_turn is overridden by this deterministic test executor")
    }

    fn start_write_turn(
        &mut self,
        _req: &TurnRequest,
        _store: Arc<ProductStore>,
        _sink: Option<EventSink>,
    ) -> Result<turn_exec::WriteTurnStream, ProtocolError> {
        unreachable!("start_turn is overridden by this deterministic test executor")
    }

    fn respond_approval(
        &mut self,
        _approval_id: &str,
        _decision: ka::TurnDecision,
    ) -> Result<bool, ProtocolError> {
        Ok(self.approval_forwarded)
    }

    fn has_approval_owner(&self, _approval_id: &str) -> bool {
        self.approval_owner
    }

    fn decline_pending(&mut self, _thread_id: &str) -> Result<usize, ProtocolError> {
        *self.probe.decline_calls.lock().unwrap() += 1;
        Ok(0)
    }

    fn interrupt(&mut self, _thread_id: &str) -> Result<bool, ProtocolError> {
        Ok(self.interrupt_handled)
    }

    fn await_turn_done(
        &mut self,
        _thread_id: &str,
        _timeout: std::time::Duration,
    ) -> Result<(), ProtocolError> {
        Ok(())
    }

    fn set_sink(&mut self, _sink: Option<EventSink>) {}

    fn list_models(&mut self, _params: &Value) -> Result<Value, ProtocolError> {
        Ok(json!({
            "data": [{
                "id": "gpt-5.6-terra",
                "model": "gpt-5.6-terra",
                "supportedReasoningEfforts": ["low", "medium", "high", "xhigh", "max"],
                "defaultReasoningEffort": "max"
            }],
            "nextCursor": null
        }))
    }

    fn list_skills(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        Ok(json!({"data": [{"cwd": params["cwds"][0], "skills": []}]}))
    }
}

fn plane(executor: RecordingExecutor) -> ControlPlane {
    let base = std::env::temp_dir().join(format!(
        "knorvia-control-turns-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&base).unwrap();
    ControlPlane::open_with_executor(layout(base), Box::new(executor)).unwrap()
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

fn init(plane: &mut ControlPlane) {
    let response = rpc(
        plane,
        "initialize",
        "initialize",
        json!({
            "protocol": {"major": 1, "minor": 0},
            "client": {"name": "knorvia_control_tests", "version": "1"},
            "capabilities": ["thread", "model", "skills"]
        }),
    );
    assert!(response.get("error").is_none(), "{response}");
    plane
        .handle_json(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
        .unwrap();
}

#[test]
fn snapshot_includes_durable_timeline_and_selected_kernel_settings() {
    let probe = Arc::new(Probe::default());
    let mut plane = plane(RecordingExecutor::new(Arc::clone(&probe)));
    init(&mut plane);
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let workspace = rpc(
        &mut plane,
        "workspace",
        "workspace/create",
        json!({"title": "Native", "cwd": cwd.clone()}),
    );
    assert_eq!(workspace["result"]["cwd"], json!(cwd));
    let thread = rpc(
        &mut plane,
        "thread",
        "thread/start",
        json!({
            "workspaceId": workspace["result"]["id"],
            "title": "Kernel task",
            "model": "gpt-5.6-terra",
            "reasoningEffort": "max"
        }),
    );
    let thread_id = thread["result"]["id"].as_str().unwrap().to_string();
    assert_eq!(thread["result"]["cwd"], json!(cwd));
    assert_eq!(thread["result"]["model"], "gpt-5.6-terra");
    assert_eq!(thread["result"]["reasoningEffort"], "max");

    let updated_cwd = std::env::temp_dir()
        .join(format!("knorvia-updated-cwd-{}", std::process::id()))
        .to_string_lossy()
        .to_string();
    std::fs::create_dir_all(&updated_cwd).unwrap();
    let updated_workspace = rpc(
        &mut plane,
        "workspace-update",
        "workspace/update",
        json!({"id": workspace["result"]["id"], "cwd": updated_cwd}),
    );
    assert_eq!(updated_workspace["result"]["cwd"], json!(updated_cwd));
    let turn = rpc(
        &mut plane,
        "turn",
        "turn/start",
        json!({"threadId": thread_id, "input": "Inspect this workspace", "tools": {"readOnly": true}}),
    );
    assert_eq!(turn["result"]["turn"]["status"], "completed");
    let requests = probe.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let request = requests[0].clone();
    drop(requests);
    assert_eq!(request.settings.cwd.as_deref(), Some(updated_cwd.as_str()));
    assert_eq!(request.settings.model.as_deref(), Some("gpt-5.6-terra"));
    assert_eq!(request.settings.reasoning_effort.as_deref(), Some("max"));

    let snapshot = rpc(&mut plane, "read", "thread/read", json!({"id": thread_id}));
    assert!(snapshot["result"]["turns"].as_array().unwrap().len() == 1);
    assert!(
        snapshot["result"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "agentMessage")
    );
    assert!(snapshot["result"]["activeTurn"].is_null());
    assert_eq!(snapshot["result"]["lastTurn"]["status"], "completed");
}

#[test]
fn explicit_default_and_model_switch_clear_saved_reasoning_settings() {
    let probe = Arc::new(Probe::default());
    let mut plane = plane(RecordingExecutor::new(Arc::clone(&probe)));
    init(&mut plane);
    let workspace = rpc(
        &mut plane,
        "w",
        "workspace/create",
        json!({"title":"Effort"}),
    );
    let started = rpc(
        &mut plane,
        "t",
        "thread/start",
        json!({
            "workspaceId":workspace["result"]["id"], "model":"reasoning-model", "reasoningEffort":"high"
        }),
    );
    let id = started["result"]["id"].as_str().unwrap();
    let clear = rpc(
        &mut plane,
        "clear",
        "thread/update",
        json!({"id":id,"reasoningEffort":null}),
    );
    assert!(clear["error"].is_null(), "{clear}");
    assert!(clear["result"]["reasoningEffort"].is_null());
    let sent = rpc(
        &mut plane,
        "send",
        "turn/start",
        json!({"threadId":id,"input":"Use default effort"}),
    );
    assert!(sent["error"].is_null(), "{sent}");
    let first = probe.requests.lock().unwrap()[0].settings.clone();
    assert!(first.reasoning_effort.is_none());
    assert_eq!(first.collaboration_mode.as_deref(), Some("default"));
    rpc(
        &mut plane,
        "high",
        "thread/update",
        json!({"id":id,"reasoningEffort":"high"}),
    );
    let changed = rpc(
        &mut plane,
        "switch",
        "thread/update",
        json!({"id":id,"model":"fast-model"}),
    );
    assert!(changed["result"]["reasoningEffort"].is_null());
    let read = rpc(&mut plane, "read", "thread/read", json!({"id":id}));
    assert!(read["result"]["reasoningEffort"].is_null());
    // Changing a model with an explicit new effort preserves that selection.
    let chosen = rpc(
        &mut plane,
        "chosen",
        "thread/update",
        json!({"id":id,"model":"reasoning-model","reasoningEffort":"low"}),
    );
    assert_eq!(chosen["result"]["reasoningEffort"], "low");
}

#[test]
fn thread_list_stays_small_and_read_pages_timeline_backwards() {
    let probe = Arc::new(Probe::default());
    let mut executor = RecordingExecutor::new(Arc::clone(&probe));
    executor.leave_turn_running = true;
    let mut plane = plane(executor);
    init(&mut plane);
    let workspace = rpc(
        &mut plane,
        "workspace",
        "workspace/create",
        json!({"title": "Paged"}),
    );
    let thread = rpc(
        &mut plane,
        "thread",
        "thread/start",
        json!({"workspaceId": workspace["result"]["id"], "title": "Paged"}),
    );
    let thread_id = thread["result"]["id"].as_str().unwrap().to_string();
    let started = rpc(
        &mut plane,
        "turn",
        "turn/start",
        json!({"threadId": thread_id, "input": "Start", "tools": {"write": true}}),
    );
    let turn_id = started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    for index in 0..105 {
        plane
            .store
            .append_item(
                &thread_id,
                &turn_id,
                "agentMessage",
                "completed",
                json!({"text": format!("result {index}")}),
            )
            .unwrap();
    }

    let index = rpc(
        &mut plane,
        "list",
        "thread/list",
        json!({"workspaceId": workspace["result"]["id"]}),
    );
    assert!(index["result"][0].get("items").is_none());
    assert!(index["result"][0].get("turns").is_none());
    assert_eq!(index["result"][0]["activeTurn"]["id"], turn_id);

    let newest = rpc(
        &mut plane,
        "newest",
        "thread/read",
        json!({"id": thread_id, "itemLimit": 10}),
    );
    assert_eq!(newest["result"]["items"].as_array().unwrap().len(), 10);
    assert_eq!(newest["result"]["hasMoreItems"], true);
    let cursor = newest["result"]["itemsNextCursor"].as_u64().unwrap();
    let older = rpc(
        &mut plane,
        "older",
        "thread/read",
        json!({"id": thread_id, "itemLimit": 10, "beforeItemSeq": cursor}),
    );
    assert_eq!(older["result"]["items"].as_array().unwrap().len(), 10);
    assert!(older["result"]["items"][9]["seq"].as_u64().unwrap() < cursor);
}

#[test]
fn user_input_answers_are_durable_once_and_secret_requests_are_rejected() {
    let probe = Arc::new(Probe::default());
    let mut executor = RecordingExecutor::new(Arc::clone(&probe));
    executor.leave_turn_running = true;
    let mut plane = plane(executor);
    init(&mut plane);
    let workspace = rpc(
        &mut plane,
        "workspace",
        "workspace/create",
        json!({"title": "Input"}),
    );
    let thread = rpc(
        &mut plane,
        "thread",
        "thread/start",
        json!({"workspaceId": workspace["result"]["id"], "title": "Input"}),
    );
    let thread_id = thread["result"]["id"].as_str().unwrap().to_string();
    let started = rpc(
        &mut plane,
        "turn",
        "turn/start",
        json!({"threadId": thread_id, "input": "Start", "tools": {"write": true}}),
    );
    let turn_id = started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let normal = plane
        .store
        .append_item(
            &thread_id,
            &turn_id,
            "userInput",
            "waiting_input",
            json!({"request": {"questions": [{"id": "mode", "header": "Mode", "question": "Pick one", "isOther": true, "isSecret": false}]}}),
        )
        .unwrap();
    let accepted = rpc(
        &mut plane,
        "answer",
        "userInput/respond",
        json!({"id": normal.id, "answers": {"mode": {"answers": ["custom value"]}}}),
    );
    assert_eq!(accepted["result"]["item"]["id"], normal.id);
    assert_eq!(accepted["result"]["item"]["status"], "answered");
    assert_eq!(probe.user_input_answers.lock().unwrap().len(), 1);

    let secret = plane
        .store
        .append_item(
            &thread_id,
            &turn_id,
            "userInput",
            "waiting_input",
            json!({"request": {"questions": [{"id": "token", "header": "Token", "question": "Enter token", "isSecret": true}]}}),
        )
        .unwrap();
    let rejected = rpc(
        &mut plane,
        "secret",
        "userInput/respond",
        json!({"id": secret.id, "answers": {"token": {"answers": ["do-not-persist"]}}}),
    );
    assert_eq!(
        rejected["error"]["data"]["category"],
        "CAPABILITY_UNAVAILABLE"
    );
    assert_eq!(
        plane.store.read_item(&secret.id).unwrap().status,
        "waiting_input"
    );
    assert_eq!(probe.user_input_answers.lock().unwrap().len(), 1);
}

#[test]
fn undelivered_user_input_is_corrected_in_the_same_timeline_item() {
    let probe = Arc::new(Probe::default());
    let mut executor = RecordingExecutor::new(Arc::clone(&probe));
    executor.leave_turn_running = true;
    executor.user_input_forwarded = false;
    let mut plane = plane(executor);
    init(&mut plane);
    let workspace = rpc(
        &mut plane,
        "workspace",
        "workspace/create",
        json!({"title": "Input delivery"}),
    );
    let thread = rpc(
        &mut plane,
        "thread",
        "thread/start",
        json!({"workspaceId": workspace["result"]["id"], "title": "Input delivery"}),
    );
    let thread_id = thread["result"]["id"].as_str().unwrap().to_string();
    let started = rpc(
        &mut plane,
        "turn",
        "turn/start",
        json!({"threadId": thread_id, "input": "Start", "tools": {"write": true}}),
    );
    let turn_id = started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let input = plane
        .store
        .append_item(
            &thread_id,
            &turn_id,
            "userInput",
            "waiting_input",
            json!({"request": {"questions": [{"id": "mode", "isSecret": false}]}}),
        )
        .unwrap();

    let response = rpc(
        &mut plane,
        "answer",
        "userInput/respond",
        json!({"id": input.id, "answers": {"mode": {"answers": ["safe"]}}}),
    );
    assert_eq!(response["error"]["data"]["category"], "CONFLICT");
    let corrected = plane.store.read_item(&input.id).unwrap();
    assert_eq!(corrected.status, "delivery_failed");
    assert_eq!(corrected.payload["answers"]["mode"]["answers"][0], "safe");
    assert_eq!(probe.user_input_answers.lock().unwrap().len(), 0);
}

#[test]
fn approval_lost_after_its_durable_decision_is_marked_delivery_failed() {
    let probe = Arc::new(Probe::default());
    let mut executor = RecordingExecutor::new(Arc::clone(&probe));
    executor.leave_turn_running = true;
    executor.approval_owner = true;
    // Simulate the runner disappearing after ownership was observed but before
    // the decision channel could receive its persisted value.
    executor.approval_forwarded = false;
    let mut plane = plane(executor);
    init(&mut plane);
    let workspace = rpc(
        &mut plane,
        "workspace",
        "workspace/create",
        json!({"title": "Approval"}),
    );
    let thread = rpc(
        &mut plane,
        "thread",
        "thread/start",
        json!({"workspaceId": workspace["result"]["id"], "title": "Approval"}),
    );
    let thread_id = thread["result"]["id"].as_str().unwrap().to_string();
    let started = rpc(
        &mut plane,
        "turn",
        "turn/start",
        json!({"threadId": thread_id, "input": "Start", "tools": {"write": true}}),
    );
    let turn_id = started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let approval = plane
        .store
        .create_approval(&thread_id, &turn_id, "kernel.fileChange", "digest")
        .unwrap();
    let response = rpc(
        &mut plane,
        "decision",
        "approval/respond",
        json!({"id": approval.id, "decision": "allow"}),
    );
    assert_eq!(response["error"]["data"]["category"], "CONFLICT");
    assert_eq!(
        plane.store.read_approval(&approval.id).unwrap().status,
        "delivery_failed"
    );
}

#[test]
fn fork_archive_and_model_catalog_use_real_control_contracts() {
    let probe = Arc::new(Probe::default());
    let mut plane = plane(RecordingExecutor::new(Arc::clone(&probe)));
    init(&mut plane);
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let workspace = rpc(
        &mut plane,
        "workspace",
        "workspace/create",
        json!({"title": "Native", "cwd": cwd.clone()}),
    );
    let source = rpc(
        &mut plane,
        "source",
        "thread/start",
        json!({"workspaceId": workspace["result"]["id"], "title": "Source"}),
    );
    let source_id = source["result"]["id"].as_str().unwrap().to_string();
    let source_turn = rpc(
        &mut plane,
        "source-turn",
        "turn/start",
        json!({"threadId": source_id, "input": "Keep this context", "tools": {"readOnly": true}}),
    );
    assert_eq!(source_turn["result"]["turn"]["status"], "completed");
    let fork = rpc(
        &mut plane,
        "fork",
        "thread/fork",
        json!({"threadId": source_id, "title": "Fork"}),
    );
    assert_eq!(fork["result"]["title"], "Fork");
    assert_eq!(fork["result"]["turns"].as_array().unwrap().len(), 1);
    assert!(
        fork["result"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "agentMessage")
    );
    let bindings = probe.bindings.lock().unwrap();
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].1, "kernel_fork_1");
    drop(bindings);

    let archived = rpc(
        &mut plane,
        "archive",
        "thread/archive",
        json!({"id": fork["result"]["id"]}),
    );
    assert_eq!(archived["result"]["status"], "archived");
    let restored = rpc(
        &mut plane,
        "unarchive",
        "thread/unarchive",
        json!({"id": fork["result"]["id"]}),
    );
    assert_eq!(restored["result"]["status"], "active");

    let models = rpc(&mut plane, "models", "model/list", json!({}));
    assert_eq!(models["result"]["data"][0]["model"], "gpt-5.6-terra");
    let skills = rpc(&mut plane, "skills", "skills/list", json!({"cwds": [cwd]}));
    assert!(skills["result"]["data"].is_array());
}

#[test]
fn stale_fork_revision_does_not_create_a_kernel_child() {
    let probe = Arc::new(Probe::default());
    let mut plane = plane(RecordingExecutor::new(Arc::clone(&probe)));
    init(&mut plane);
    let workspace = rpc(
        &mut plane,
        "workspace",
        "workspace/create",
        json!({"title": "Fork revision"}),
    );
    let source = rpc(
        &mut plane,
        "source",
        "thread/start",
        json!({"workspaceId": workspace["result"]["id"], "title": "Source"}),
    );
    let source_id = source["result"]["id"].as_str().unwrap().to_string();
    let stale = rpc(
        &mut plane,
        "fork",
        "thread/fork",
        json!({"threadId": source_id, "expectedRevision": 999_999}),
    );
    assert_eq!(stale["error"]["data"]["category"], "CONFLICT");
    assert_eq!(*probe.fork_calls.lock().unwrap(), 0);
    assert!(probe.discarded_kernel_threads.lock().unwrap().is_empty());
}

#[test]
fn steer_records_one_product_user_message_after_kernel_accepts() {
    let probe = Arc::new(Probe::default());
    let mut executor = RecordingExecutor::new(Arc::clone(&probe));
    executor.leave_turn_running = true;
    let mut plane = plane(executor);
    init(&mut plane);
    let workspace = rpc(
        &mut plane,
        "workspace",
        "workspace/create",
        json!({"title": "Native"}),
    );
    let thread = rpc(
        &mut plane,
        "thread",
        "thread/start",
        json!({"workspaceId": workspace["result"]["id"], "title": "Steer"}),
    );
    let thread_id = thread["result"]["id"].as_str().unwrap().to_string();
    let started = rpc(
        &mut plane,
        "start",
        "turn/start",
        json!({"threadId": thread_id, "input": "Start", "tools": {"write": true}}),
    );
    let turn_id = started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let steered = rpc(
        &mut plane,
        "steer",
        "turn/steer",
        json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "input": "Focus on failures",
            "clientMessageId": "native-message-1"
        }),
    );
    assert_eq!(steered["result"]["item"]["status"], "completed");
    let steers = probe.steers.lock().unwrap();
    assert_eq!(
        steers.as_slice(),
        &[(
            thread_id.clone(),
            turn_id.clone(),
            "Focus on failures".to_string(),
            Some("native-message-1".to_string()),
        )]
    );
    drop(steers);
    let snapshot = rpc(&mut plane, "read", "thread/read", json!({"id": thread_id}));
    let steered_items: Vec<_> = snapshot["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| {
            item["kind"] == "userMessage" && item["payload"]["text"] == "Focus on failures"
        })
        .collect();
    assert_eq!(steered_items.len(), 1);
}

/// thread/list keeps its array shape by default and opts into the paged
/// envelope only when limit/afterId are supplied.
#[test]
fn thread_list_supports_optional_cursor_paging() {
    let probe = Arc::new(Probe::default());
    let mut plane = plane(RecordingExecutor::new(Arc::clone(&probe)));
    init(&mut plane);
    let ws = plane.store.create_workspace("paging").unwrap();
    for index in 0..5 {
        plane
            .store
            .create_thread(&ws.id, &format!("t{index}"), None, None)
            .unwrap();
    }
    let default_shape = rpc(
        &mut plane,
        "l1",
        "thread/list",
        json!({"workspaceId": ws.id}),
    );
    assert!(default_shape["result"].is_array());
    assert_eq!(default_shape["result"].as_array().unwrap().len(), 5);

    let page1 = rpc(
        &mut plane,
        "l2",
        "thread/list",
        json!({"workspaceId": ws.id, "limit": 2}),
    );
    let threads1 = page1["result"]["threads"].as_array().unwrap();
    assert_eq!(threads1.len(), 2);
    let cursor = page1["result"]["nextCursor"].as_str().unwrap().to_string();
    let page2 = rpc(
        &mut plane,
        "l3",
        "thread/list",
        json!({"workspaceId": ws.id, "limit": 2, "afterId": cursor}),
    );
    let threads2 = page2["result"]["threads"].as_array().unwrap();
    assert_eq!(threads2.len(), 2);
    let ids: Vec<_> = threads1
        .iter()
        .chain(threads2.iter())
        .map(|t| t["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        ids.iter().collect::<std::collections::HashSet<_>>().len(),
        4
    );

    let bad = rpc(
        &mut plane,
        "l4",
        "thread/list",
        json!({"workspaceId": ws.id, "afterId": cursor}),
    );
    assert_eq!(bad["error"]["data"]["category"], "INVALID_ARGUMENT");
}

/// A late turn/interrupt for an already-terminal turn must return the durable
/// state untouched instead of pretending the cancel happened.
#[test]
fn late_interrupt_of_terminal_turn_reports_durable_state_without_rewriting_it() {
    let probe = Arc::new(Probe::default());
    let mut plane = plane(RecordingExecutor::new(Arc::clone(&probe)));
    init(&mut plane);
    let workspace = plane.store.create_workspace("cancel").unwrap();
    let thread = plane
        .store
        .create_thread(&workspace.id, "t", None, None)
        .unwrap();
    let turn = plane.store.start_turn(&thread.id).unwrap();
    plane.store.complete_turn(&turn.id, "completed").unwrap();

    let response = rpc(
        &mut plane,
        "cancel-late",
        "turn/interrupt",
        json!({"threadId": thread.id, "turnId": turn.id}),
    );
    assert_eq!(response["result"]["status"], "completed");
    assert_eq!(
        plane.store.read_turn(&turn.id).unwrap().status,
        "completed",
        "a terminal turn must never be rewritten by a late cancel"
    );
    assert_eq!(*probe.decline_calls.lock().unwrap(), 0);
}

/// An orphan running turn (no live owner answered the interrupt) must be
/// closed as interrupted so no later process can adopt it, and the close is
/// idempotent under repeated cancel attempts.
#[test]
fn orphan_running_turn_is_interrupted_idempotently() {
    let probe = Arc::new(Probe::default());
    let mut plane = plane(RecordingExecutor::new(Arc::clone(&probe)));
    init(&mut plane);
    let workspace = plane.store.create_workspace("cancel").unwrap();
    let thread = plane
        .store
        .create_thread(&workspace.id, "t", None, None)
        .unwrap();
    let turn = plane.store.start_turn(&thread.id).unwrap();

    let first = rpc(
        &mut plane,
        "cancel-1",
        "turn/interrupt",
        json!({"threadId": thread.id, "turnId": turn.id}),
    );
    assert_eq!(first["result"]["status"], "interrupted");
    let second = rpc(
        &mut plane,
        "cancel-2",
        "turn/interrupt",
        json!({"threadId": thread.id, "turnId": turn.id}),
    );
    assert_eq!(second["result"]["status"], "interrupted");
    assert_eq!(
        plane.store.read_turn(&turn.id).unwrap().status,
        "interrupted"
    );
}

/// When a live runner owns the turn, cancel acknowledgement must NOT fabricate
/// a terminal state: the turn stays running and only the runner may close it.
#[test]
fn live_owner_cancel_keeps_terminal_authority_with_the_runner() {
    let probe = Arc::new(Probe::default());
    let mut executor = RecordingExecutor::new(Arc::clone(&probe));
    executor.interrupt_handled = true;
    let mut plane = plane(executor);
    init(&mut plane);
    let workspace = plane.store.create_workspace("cancel").unwrap();
    let thread = plane
        .store
        .create_thread(&workspace.id, "t", None, None)
        .unwrap();
    let turn = plane.store.start_turn(&thread.id).unwrap();

    let response = rpc(
        &mut plane,
        "cancel-live",
        "turn/interrupt",
        json!({"threadId": thread.id, "turnId": turn.id}),
    );
    assert_eq!(
        response["result"]["status"], "running",
        "acknowledgement is not terminal confirmation"
    );
    assert_eq!(plane.store.read_turn(&turn.id).unwrap().status, "running");
    assert_eq!(
        *probe.decline_calls.lock().unwrap(),
        1,
        "a handled cancel must decline pending approvals/inputs for the turn"
    );
}
