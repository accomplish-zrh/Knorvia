use super::super::turn_exec::WriteTurnStream;
use super::*;
use knorvia_platform_paths::layout;
use knorvia_store::{AutomationRunState, AutomationSchedule, AutomationStatus, epoch_millis};
use std::io::{self, BufRead, Read, Write};
use std::sync::mpsc::{self, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Probe {
    requests: Mutex<Vec<TurnRequest>>,
    fail_admission: Mutex<bool>,
}

struct ScriptedExecutor {
    probe: Arc<Probe>,
}

/// Mimics the existing write-turn bridge at the point where a Kernel action
/// needs product approval. It deliberately leaves the Turn running until a
/// client responds; an automation dispatcher must not answer on its behalf.
struct ApprovalHoldingExecutor;

impl TurnExecutor for ScriptedExecutor {
    fn start_turn(
        &mut self,
        request: &TurnRequest,
        store: Arc<ProductStore>,
    ) -> Result<(), ProtocolError> {
        self.probe.requests.lock().unwrap().push(request.clone());
        if *self.probe.fail_admission.lock().unwrap() {
            return Err(ProtocolError::new(
                ErrorCategory::Transient,
                "scripted executor admission failed",
            ));
        }
        store
            .append_item(
                &request.thread_id,
                &request.turn_id,
                "agentMessage",
                "completed",
                json!({"text": "scripted automation result"}),
            )
            .map_err(StoreError::into_protocol)?;
        store
            .complete_turn(&request.turn_id, "completed")
            .map_err(StoreError::into_protocol)?;
        Ok(())
    }

    fn run_turn(&mut self, _request: &TurnRequest) -> Result<TurnOutcome, ProtocolError> {
        unreachable!("automation tests override start_turn")
    }

    fn start_write_turn(
        &mut self,
        _request: &TurnRequest,
        _store: Arc<ProductStore>,
        _sink: Option<EventSink>,
    ) -> Result<WriteTurnStream, ProtocolError> {
        let (_sender, receiver) = channel();
        Ok(WriteTurnStream {
            first_approval: receiver,
        })
    }

    fn respond_approval(
        &mut self,
        _approval_id: &str,
        _decision: ka::TurnDecision,
    ) -> Result<bool, ProtocolError> {
        Ok(false)
    }

    fn decline_pending(&mut self, _thread_id: &str) -> Result<usize, ProtocolError> {
        Ok(0)
    }

    fn interrupt(&mut self, _thread_id: &str) -> Result<bool, ProtocolError> {
        Ok(false)
    }

    fn await_turn_done(
        &mut self,
        _thread_id: &str,
        _timeout: std::time::Duration,
    ) -> Result<(), ProtocolError> {
        Ok(())
    }

    fn set_sink(&mut self, _sink: Option<EventSink>) {}
}

impl TurnExecutor for ApprovalHoldingExecutor {
    fn start_turn(
        &mut self,
        request: &TurnRequest,
        store: Arc<ProductStore>,
    ) -> Result<(), ProtocolError> {
        assert!(!request.read_only, "approval bridge requires allowWrites");
        let approval = store
            .create_approval(
                &request.thread_id,
                &request.turn_id,
                "kernel.commandExecution",
                "automation-test-digest",
            )
            .map_err(StoreError::into_protocol)?;
        store
            .append_item(
                &request.thread_id,
                &request.turn_id,
                "tool.write",
                "waiting_approval",
                json!({"approvalId": approval.id}),
            )
            .map_err(StoreError::into_protocol)?;
        Ok(())
    }

    fn run_turn(&mut self, _request: &TurnRequest) -> Result<TurnOutcome, ProtocolError> {
        unreachable!("approval test overrides start_turn")
    }

    fn start_write_turn(
        &mut self,
        _request: &TurnRequest,
        _store: Arc<ProductStore>,
        _sink: Option<EventSink>,
    ) -> Result<WriteTurnStream, ProtocolError> {
        let (_sender, receiver) = channel();
        Ok(WriteTurnStream {
            first_approval: receiver,
        })
    }

    fn respond_approval(
        &mut self,
        _approval_id: &str,
        _decision: ka::TurnDecision,
    ) -> Result<bool, ProtocolError> {
        panic!("automation dispatch must not auto-respond to approval")
    }

    fn decline_pending(&mut self, _thread_id: &str) -> Result<usize, ProtocolError> {
        Ok(0)
    }

    fn interrupt(&mut self, _thread_id: &str) -> Result<bool, ProtocolError> {
        Ok(false)
    }

    fn await_turn_done(
        &mut self,
        _thread_id: &str,
        _timeout: std::time::Duration,
    ) -> Result<(), ProtocolError> {
        Ok(())
    }

    fn set_sink(&mut self, _sink: Option<EventSink>) {}
}

fn plane() -> (ControlPlane, Arc<Probe>) {
    let base = std::env::temp_dir().join(format!(
        "knorvia-control-automation-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&base).unwrap();
    let probe = Arc::new(Probe::default());
    let plane = ControlPlane::open_with_executor(
        layout(base),
        Box::new(ScriptedExecutor {
            probe: Arc::clone(&probe),
        }),
    )
    .unwrap();
    (plane, probe)
}

fn approval_plane() -> ControlPlane {
    let base = std::env::temp_dir().join(format!(
        "knorvia-control-automation-approval-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&base).unwrap();
    ControlPlane::open_with_executor(layout(base), Box::new(ApprovalHoldingExecutor)).unwrap()
}

fn rpc(plane: &mut ControlPlane, id: &str, method: &str, params: Value) -> Value {
    let response = plane
        .handle_json(
            &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string(),
        )
        .unwrap()
        .unwrap();
    serde_json::from_str(&response).unwrap()
}

fn init(plane: &mut ControlPlane) {
    let response = rpc(
        plane,
        "init",
        "initialize",
        json!({
            "protocol": {"major": 1, "minor": 0},
            "client": {"name": "automation tests", "version": "1"},
            "capabilities": ["thread"]
        }),
    );
    assert!(response.get("error").is_none(), "{response}");
    plane
        .handle_json(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
        .unwrap();
}

/// A pipe-like empty input that stays open briefly before EOF. Its reader
/// thread blocks in framing while the owner loop must still wake and dispatch
/// a due automation.
struct DelayedEof {
    delay: Duration,
    waited: bool,
}

impl DelayedEof {
    fn new(delay: Duration) -> Self {
        Self {
            delay,
            waited: false,
        }
    }

    fn wait_once(&mut self) {
        if !self.waited {
            self.waited = true;
            std::thread::sleep(self.delay);
        }
    }
}

impl Read for DelayedEof {
    fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
        self.wait_once();
        Ok(0)
    }
}

impl BufRead for DelayedEof {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        self.wait_once();
        Ok(&[])
    }

    fn consume(&mut self, _amount: usize) {}
}

#[derive(Clone, Default)]
struct SharedWriter(Arc<Mutex<Vec<u8>>>);

impl Write for SharedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn rpc_schedule_dispatches_a_real_thread_and_turn_with_saved_execution_settings() {
    let (mut plane, probe) = plane();
    init(&mut plane);
    let workspace = rpc(
        &mut plane,
        "workspace",
        "workspace/create",
        json!({"title": "Native"}),
    );
    let workspace_id = workspace["result"]["id"].as_str().unwrap();
    let create = rpc(
        &mut plane,
        "create",
        "automation/create",
        json!({
            "title": "Daily summary",
            "prompt": "Summarize today",
            "workspaceId": workspace_id,
            "schedule": {"kind": "once", "at": 1},
            "allowWrites": true,
            "model": "gpt-5.6-terra",
            "reasoningEffort": "max"
        }),
    );
    assert!(create.get("error").is_none(), "{create}");
    let automation_id = create["result"]["automation"]["id"].as_str().unwrap();

    let dispatch = tick_automations(plane.store(), epoch_millis())
        .unwrap()
        .pop()
        .unwrap();
    let run = plane
        .dispatch_automation_run(&dispatch.run_id)
        .unwrap()
        .unwrap();
    assert_eq!(run.state, AutomationRunState::Succeeded);
    let thread_id = run.thread_id.as_deref().unwrap();
    let thread = plane.store().read_thread(thread_id).unwrap();
    let turn = plane
        .store()
        .read_turn(run.turn_id.as_deref().unwrap())
        .unwrap();
    assert_eq!(thread.workspace_id, workspace_id);
    assert_eq!(turn.thread_id, thread_id);
    let requests = probe.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(!requests[0].read_only);
    assert_eq!(requests[0].settings.model.as_deref(), Some("gpt-5.6-terra"));
    assert_eq!(
        requests[0].settings.reasoning_effort.as_deref(),
        Some("max")
    );
    drop(requests);

    let list = rpc(
        &mut plane,
        "list",
        "automation/list",
        json!({"workspaceId": workspace_id}),
    );
    let listed = &list["result"]["automations"][0];
    assert_eq!(listed["id"], automation_id);
    assert_eq!(listed["lastThreadId"], thread_id);
    assert_eq!(listed["recentRuns"][0]["threadId"], thread_id);
    assert_eq!(listed["recentRuns"][0]["status"], "succeeded");
}

#[test]
fn paused_plan_can_run_now_but_never_overlaps_and_records_failed_admission() {
    let (mut plane, probe) = plane();
    init(&mut plane);
    let workspace = rpc(
        &mut plane,
        "workspace",
        "workspace/create",
        json!({"title": "Native"}),
    );
    let workspace_id = workspace["result"]["id"].as_str().unwrap();
    let create = rpc(
        &mut plane,
        "create",
        "automation/create",
        json!({
            "title": "Paused",
            "prompt": "do it",
            "workspaceId": workspace_id,
            "schedule": {"kind": "interval", "minutes": 1},
            "status": "paused"
        }),
    );
    let automation_id = create["result"]["automation"]["id"].as_str().unwrap();
    *probe.fail_admission.lock().unwrap() = true;
    let first = rpc(
        &mut plane,
        "run-1",
        "automation/run",
        json!({"id": automation_id}),
    );
    assert!(first.get("error").is_none(), "{first}");
    assert!(first["result"]["threadId"].is_string());
    let first_run_id = first["result"]["runId"].as_str().unwrap();
    assert_eq!(
        plane
            .store()
            .read_automation_run(first_run_id)
            .unwrap()
            .state,
        AutomationRunState::Failed
    );
    let automation = plane.store().read_automation(automation_id).unwrap();
    assert!(automation.last_error.is_some());

    // A failed run is terminal, so a deliberate second Run now is allowed;
    // the same property blocks only overlapping work.
    let second = rpc(
        &mut plane,
        "run-2",
        "automation/run",
        json!({"id": automation_id}),
    );
    assert!(second.get("error").is_none(), "{second}");
    assert_eq!(probe.requests.lock().unwrap().len(), 2);
}

#[test]
fn rpc_edit_pause_resume_and_delete_use_the_persisted_revision() {
    let (mut plane, _probe) = plane();
    init(&mut plane);
    let workspace = rpc(
        &mut plane,
        "workspace",
        "workspace/create",
        json!({"title": "Automation edits"}),
    );
    let workspace_id = workspace["result"]["id"].as_str().unwrap();
    let created = rpc(
        &mut plane,
        "create",
        "automation/create",
        json!({
            "title": "Old title",
            "prompt": "old prompt",
            "workspaceId": workspace_id,
            "schedule": {"kind": "interval", "minutes": 5}
        }),
    );
    let automation = &created["result"]["automation"];
    let id = automation["id"].as_str().unwrap().to_string();
    assert_eq!(automation["status"], "active");
    assert_eq!(automation["allowWrites"], false);

    let paused = rpc(
        &mut plane,
        "pause",
        "automation/update",
        json!({
            "id": id,
            "revision": 1,
            "title": "New title",
            "prompt": "new prompt",
            "status": "paused",
            "allowWrites": true,
            "model": "gpt-5.6-terra",
            "reasoningEffort": "max"
        }),
    );
    let paused_automation = &paused["result"]["automation"];
    assert_eq!(paused_automation["revision"], 2);
    assert_eq!(paused_automation["status"], "paused");
    assert_eq!(paused_automation["title"], "New title");
    assert_eq!(paused_automation["allowWrites"], true);

    let stale = rpc(
        &mut plane,
        "stale",
        "automation/update",
        json!({"id": id, "revision": 1, "status": "active"}),
    );
    assert_eq!(stale["error"]["data"]["category"], "CONFLICT");

    let resumed = rpc(
        &mut plane,
        "resume",
        "automation/update",
        json!({
            "id": id,
            "expectedRevision": 2,
            "status": "active",
            "model": null,
            "reasoningEffort": null
        }),
    );
    assert_eq!(resumed["result"]["automation"]["revision"], 3);
    assert_eq!(resumed["result"]["automation"]["status"], "active");
    assert!(resumed["result"]["automation"]["model"].is_null());

    let deleted = rpc(
        &mut plane,
        "delete",
        "automation/delete",
        json!({"id": id, "revision": 3}),
    );
    assert_eq!(deleted["result"]["deleted"], true);
    let listed = rpc(
        &mut plane,
        "list",
        "automation/list",
        json!({"workspaceId": workspace_id}),
    );
    assert!(
        listed["result"]["automations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn writable_automation_keeps_native_approval_pending_without_an_automatic_answer() {
    let mut plane = approval_plane();
    init(&mut plane);
    let workspace = plane.store().create_workspace("Approval").unwrap();
    let automation = plane
        .store()
        .create_automation_with_settings_at(
            "Needs approval",
            "make a workspace change",
            &workspace.id,
            AutomationSchedule::Once { at: 1 },
            AutomationStatus::Active,
            true,
            None,
            None,
            1,
        )
        .unwrap();
    let claimed = plane
        .store()
        .claim_manual_automation_run_at(&automation.id, 2)
        .unwrap();
    let run = plane.dispatch_automation_run(&claimed.id).unwrap().unwrap();
    assert_eq!(run.state, AutomationRunState::Running);
    let turn = plane
        .store()
        .read_turn(run.turn_id.as_deref().unwrap())
        .unwrap();
    assert_eq!(turn.status, "running");
    let approvals = plane
        .store()
        .list_approvals(run.thread_id.as_deref().unwrap())
        .unwrap();
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals[0].status, "pending");
}

#[test]
fn idle_stdio_owner_dispatches_due_work_and_exits_cleanly_at_pipe_eof() {
    let (mut plane, probe) = plane();
    let workspace = plane.store().create_workspace("Idle daemon").unwrap();
    let automation = plane
        .store()
        .create_automation_at(
            "Idle run",
            "execute while stdin is quiet",
            &workspace.id,
            AutomationSchedule::Once { at: 1 },
            AutomationStatus::Active,
            1,
        )
        .unwrap();
    let scheduler = plane.start_automation_scheduler().unwrap();
    let start = Instant::now();
    serve_stdio_with_automations(
        &mut plane,
        DelayedEof::new(Duration::from_millis(900)),
        SharedWriter::default(),
        scheduler,
    )
    .unwrap();
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "owner did not return after pipe EOF"
    );
    assert_eq!(probe.requests.lock().unwrap().len(), 1);
    let runs = plane
        .store()
        .list_automation_runs(&automation.id, 10)
        .unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].state, AutomationRunState::Succeeded);
}

#[test]
fn bounded_dispatch_offers_only_what_the_reader_has_room_for() {
    let (sender, receiver) = mpsc::sync_channel(1);
    let in_flight: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    // The first dispatch fills the bounded channel; the second cannot fit and
    // must be released from tracking so the durable scan can re-offer it.
    offer_dispatches(
        &sender,
        &in_flight,
        vec![
            AutomationDispatch {
                run_id: "run-a".into(),
            },
            AutomationDispatch {
                run_id: "run-b".into(),
            },
        ],
    )
    .unwrap();
    assert_eq!(receiver.recv().unwrap().run_id, "run-a");
    assert_eq!(in_flight.lock().unwrap().len(), 1);
    assert!(in_flight.lock().unwrap().contains("run-a"));

    // A tracked run is never offered twice while its dispatch is pending.
    offer_dispatches(
        &sender,
        &in_flight,
        vec![AutomationDispatch {
            run_id: "run-a".into(),
        }],
    )
    .unwrap();
    assert!(receiver.try_recv().is_err(), "tracked run re-offered");

    // The released claim stays durable, so the next tick re-offers it and the
    // owner drains it once the reader has room again.
    offer_dispatches(
        &sender,
        &in_flight,
        vec![AutomationDispatch {
            run_id: "run-b".into(),
        }],
    )
    .unwrap();
    assert_eq!(receiver.recv().unwrap().run_id, "run-b");
}

/// The owner must release the in-flight slot after each dispatch attempt.
/// Without that release the bounded tracking set eventually refuses every new
/// dispatch and the scheduler starves for the rest of the daemon's life.
#[test]
fn dispatched_automations_release_their_in_flight_slot() {
    let (mut plane, _probe) = plane();
    let workspace = plane.store().create_workspace("Slot release").unwrap();
    let automation = plane
        .store()
        .create_automation_at(
            "Release slot",
            "prove in-flight bookkeeping",
            &workspace.id,
            AutomationSchedule::Once { at: 1 },
            AutomationStatus::Active,
            1,
        )
        .unwrap();
    // Deterministic scheduler without the background clock thread, so the
    // test alone claims and dispatches this occurrence.
    let (scheduler, dispatch_tx) = AutomationScheduler::new_for_test();
    let dispatch = tick_automations(plane.store(), epoch_millis())
        .unwrap()
        .into_iter()
        .next()
        .expect("due automation was not claimed");
    // The claimed occurrence really belongs to this automation plan.
    let runs = plane
        .store()
        .list_automation_runs(&automation.id, 10)
        .unwrap();
    assert_eq!(
        runs.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(),
        vec![dispatch.run_id.as_str()]
    );
    offer_dispatches(&dispatch_tx, &scheduler.in_flight, vec![dispatch.clone()]).unwrap();
    drop(dispatch_tx);

    assert_eq!(plane.dispatch_queued_automations(&scheduler), 1);
    assert!(
        scheduler.try_next().is_none(),
        "an unexpected extra dispatch reached the reader"
    );
    assert!(
        !scheduler
            .in_flight
            .lock()
            .unwrap()
            .contains(&dispatch.run_id),
        "dispatched run kept its in-flight slot"
    );
}
