//! Native persistent automation RPCs and the small scheduler-to-control queue.
//!
//! The scheduler owns only durable claims. It never talks to the Kernel or
//! holds the control-plane reader. The single reader later drains its queue
//! and calls the same `rpc_turn_start` path used by an interactive task.

use super::*;
use knorvia_store::{
    Automation, AutomationRun, AutomationSchedule, AutomationStatus, AutomationUpdate,
    ProductStore, StoreError, epoch_millis,
};
use serde_json::Map;
use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{
    self, Receiver, RecvTimeoutError, Sender, SyncSender, TryRecvError, TrySendError,
};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const AUTOMATION_TICK: Duration = Duration::from_millis(250);
const RECENT_RUN_LIMIT: usize = 12;
/// Bounds frames read from stdio but not yet handled by the sole control-plane
/// owner. A noisy client applies backpressure to its reader instead of growing
/// daemon memory without limit.
const MAX_PENDING_PROTOCOL_FRAMES: usize = 64;
/// A run id is held in this bounded channel or being synchronously dispatched
/// by the sole owner. Durable state remains the source of truth for any work
/// that cannot fit here.
const MAX_PENDING_AUTOMATION_DISPATCHES: usize = 64;
/// Keep the reader responsive when many plans become due together. More
/// claims remain durably queued and are admitted on the next owner wake.
const MAX_DISPATCHES_PER_OWNER_WAKE: usize = 4;

/// A durable run id waiting for the sole `ControlPlane` reader. It contains no
/// prompt or executor handle, preventing a background ticker from becoming a
/// second model loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationDispatch {
    pub run_id: String,
}

/// Background durable-clock worker. Construct it only after production
/// `ControlPlane::open` has acquired the Knorvia Home lock. Test seams can
/// call [`tick_automations`] directly with an isolated store instead.
pub struct AutomationScheduler {
    dispatches: Receiver<AutomationDispatch>,
    /// Includes both channel entries and an entry currently held by the
    /// owner. Keeping it until completion prevents a slow `turn/start` call
    /// from being re-offered by the next scheduler tick.
    in_flight: Arc<Mutex<HashSet<String>>>,
    stop: Sender<()>,
    worker: Option<JoinHandle<()>>,
}

impl AutomationScheduler {
    pub fn start(
        store: Arc<ProductStore>,
        admissions_paused: Arc<AtomicBool>,
    ) -> Result<Self, ProtocolError> {
        store
            .recover_automation_runs_after_restart(epoch_millis())
            .map_err(StoreError::into_protocol)?;
        let (dispatch_tx, dispatches) = mpsc::sync_channel(MAX_PENDING_AUTOMATION_DISPATCHES);
        let (stop, stop_rx) = mpsc::channel();
        let in_flight = Arc::new(Mutex::new(HashSet::new()));
        let worker_in_flight = Arc::clone(&in_flight);
        let worker = thread::Builder::new()
            .name("knorvia-automation-clock".into())
            .spawn(move || {
                loop {
                    let accepting_admissions = !admissions_paused.load(Ordering::Acquire);
                    match tick_automations_with_admissions(
                        &store,
                        epoch_millis(),
                        accepting_admissions,
                    ) {
                        Ok(runs) => {
                            if offer_dispatches(&dispatch_tx, &worker_in_flight, runs).is_err() {
                                return;
                            }
                        }
                        // This is a scheduler infrastructure failure, not a
                        // model result. It is retried on the next bounded tick;
                        // stdout remains protocol-only.
                        Err(error) => {
                            eprintln!("knorvia automation scheduler: {}", error.message)
                        }
                    }
                    match stop_rx.recv_timeout(AUTOMATION_TICK) {
                        Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
                        Err(RecvTimeoutError::Timeout) => {}
                    }
                }
            })
            .map_err(|error| ProtocolError::new(ErrorCategory::Internal, error.to_string()))?;
        Ok(Self {
            dispatches,
            in_flight,
            stop,
            worker: Some(worker),
        })
    }

    /// Nonblocking so notification handling and cancellation keep moving.
    pub fn try_next(&self) -> Option<AutomationDispatch> {
        match self.dispatches.try_recv() {
            Ok(dispatch) => Some(dispatch),
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => None,
        }
    }

    /// Acknowledge that the owner has finished looking at this durable run.
    /// The run itself is deliberately not acknowledged: the next tick scans
    /// its persisted state and re-offers it only when no product Turn exists.
    pub fn complete_dispatch(&self, run_id: &str) {
        match self.in_flight.lock() {
            Ok(mut in_flight) => {
                in_flight.remove(run_id);
            }
            Err(error) => eprintln!("knorvia automation dispatch tracker: {error}"),
        }
    }

    /// Test-only scheduler without the background clock thread. The returned
    /// sender feeds the same bounded channel the production worker fills, so
    /// owner-side dispatch behavior is exercisable deterministically.
    #[cfg(test)]
    pub(crate) fn new_for_test() -> (Self, SyncSender<AutomationDispatch>) {
        let (dispatch_tx, dispatches) = mpsc::sync_channel(MAX_PENDING_AUTOMATION_DISPATCHES);
        (
            Self {
                dispatches,
                in_flight: Arc::new(Mutex::new(HashSet::new())),
                stop: mpsc::channel().0,
                worker: None,
            },
            dispatch_tx,
        )
    }
}

/// Offer only the fixed number of durable run ids the owner can currently
/// track. A full channel does not need a local spill queue: the next tick
/// re-scans persisted pre-model runs. This makes delete/recreate churn bounded
/// even when channel entries become stale.
fn offer_dispatches(
    sender: &SyncSender<AutomationDispatch>,
    in_flight: &Arc<Mutex<HashSet<String>>>,
    candidates: Vec<AutomationDispatch>,
) -> Result<(), ()> {
    for dispatch in candidates {
        let run_id = dispatch.run_id.clone();
        let inserted = match in_flight.lock() {
            Ok(mut tracked) => {
                if tracked.contains(&run_id) {
                    false
                } else if tracked.len() >= MAX_PENDING_AUTOMATION_DISPATCHES {
                    return Ok(());
                } else {
                    tracked.insert(run_id.clone());
                    true
                }
            }
            Err(error) => {
                eprintln!("knorvia automation dispatch tracker: {error}");
                return Err(());
            }
        };
        if !inserted {
            continue;
        }
        match sender.try_send(dispatch) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                if let Ok(mut tracked) = in_flight.lock() {
                    tracked.remove(&run_id);
                }
                return Ok(());
            }
            Err(TrySendError::Disconnected(_)) => {
                if let Ok(mut tracked) = in_flight.lock() {
                    tracked.remove(&run_id);
                }
                return Err(());
            }
        }
    }
    Ok(())
}

impl Drop for AutomationScheduler {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// One durable scheduler tick. It reconciles already-terminal real Turns and
/// reserves at most one due occurrence for each plan. The caller decides when
/// the returned commands enter the control-plane reader. Test seam: the
/// production scheduler thread drives [`tick_automations_with_admissions`].
#[cfg(test)]
pub fn tick_automations(
    store: &ProductStore,
    now: i64,
) -> Result<Vec<AutomationDispatch>, ProtocolError> {
    tick_automations_with_admissions(store, now, true)
}

/// Reconcile regardless of restart preparation, but only advance schedules or
/// queue work while the sole ControlPlane owner accepts new admissions.
fn tick_automations_with_admissions(
    store: &ProductStore,
    now: i64,
    accepting_admissions: bool,
) -> Result<Vec<AutomationDispatch>, ProtocolError> {
    store
        .reconcile_automation_runs(now)
        .map_err(StoreError::into_protocol)?;
    if !accepting_admissions {
        return Ok(Vec::new());
    }
    store
        .claim_due_automations_at(now)
        .map_err(StoreError::into_protocol)?;
    store
        .list_resumable_automation_runs(MAX_PENDING_AUTOMATION_DISPATCHES)
        .map_err(StoreError::into_protocol)
        .map(|runs| {
            runs.into_iter()
                .map(|run| AutomationDispatch { run_id: run.id })
                .collect()
        })
}

enum IncomingFrame {
    Frame(String),
    End,
    Error(ProtocolError),
}

/// Stdio owner loop for a daemon that has native automations enabled.
///
/// Framing is read on a small dedicated reader thread, while the calling
/// thread remains the *only* owner of `ControlPlane`. That owner wakes at a
/// bounded cadence to admit already-claimed automation runs, so an idle
/// stdin connection cannot prevent scheduled work. The model itself still
/// runs in the existing per-Turn executor and notifications keep sharing the
/// synchronized stdout sink.
pub fn serve_stdio_with_automations<R, W>(
    plane: &mut ControlPlane,
    input: R,
    output: W,
    scheduler: AutomationScheduler,
) -> Result<(), ProtocolError>
where
    R: BufRead + Send + 'static,
    W: Write + Send + Sync + 'static,
{
    let output = Arc::new(Mutex::new(output));
    let sink_output = Arc::clone(&output);
    let sink: EventSink = Arc::new(move |method, params| {
        let notification = json!({
            "jsonrpc": JSONRPC_VERSION,
            "method": method,
            "params": params,
        });
        if let Ok(mut output) = sink_output.lock() {
            let body = serde_json::to_string(&notification).unwrap_or_default();
            let _ = write_frame(&mut *output, &body);
        }
    });
    plane.set_sink(Some(sink));

    let (frames_tx, frames_rx) = mpsc::sync_channel(MAX_PENDING_PROTOCOL_FRAMES);
    thread::Builder::new()
        .name("knorvia-protocol-reader".into())
        .spawn(move || {
            let mut input = input;
            loop {
                match knorvia_protocol::read_frame(&mut input) {
                    Ok(frame) => {
                        if frames_tx.send(IncomingFrame::Frame(frame)).is_err() {
                            return;
                        }
                    }
                    Err(knorvia_protocol::WireError::Io(error))
                        if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                    {
                        let _ = frames_tx.send(IncomingFrame::End);
                        return;
                    }
                    Err(error) => {
                        let _ = frames_tx.send(IncomingFrame::Error(ProtocolError::new(
                            ErrorCategory::InvalidArgument,
                            error.to_string(),
                        )));
                        return;
                    }
                }
            }
        })
        .map_err(|error| ProtocolError::new(ErrorCategory::Internal, error.to_string()))?;

    loop {
        plane.dispatch_queued_automations(&scheduler);
        match frames_rx.recv_timeout(AUTOMATION_TICK) {
            Ok(IncomingFrame::Frame(frame)) => {
                if let Some(response) = plane.handle_json(&frame)? {
                    let mut output = output.lock().map_err(|error| {
                        ProtocolError::new(ErrorCategory::Internal, error.to_string())
                    })?;
                    write_frame(&mut *output, &response).map_err(|error| {
                        ProtocolError::new(ErrorCategory::Internal, error.to_string())
                    })?;
                }
                // A manual automation/run may have queued an immediate
                // follow-up while processing its request; drain it before
                // waiting on more stdin.
                plane.dispatch_queued_automations(&scheduler);
            }
            Ok(IncomingFrame::End) | Err(RecvTimeoutError::Disconnected) => return Ok(()),
            Ok(IncomingFrame::Error(error)) => return Err(error),
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

fn required_object<'a>(
    params: &'a Value,
    key: &str,
) -> Result<&'a Map<String, Value>, ProtocolError> {
    params.get(key).and_then(Value::as_object).ok_or_else(|| {
        ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("missing object field {key}"),
        )
    })
}

fn required_text(params: &Value, key: &str) -> Result<String, ProtocolError> {
    let value = required_str(params, key)?;
    if value.trim().is_empty() {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must not be empty"),
        ));
    }
    Ok(value.to_string())
}

fn optional_text(params: &Value, key: &str) -> Result<Option<String>, ProtocolError> {
    match params.get(key) {
        None => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.clone())),
        Some(Value::String(_)) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must not be empty"),
        )),
        Some(Value::Null) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must be a string, not null"),
        )),
        Some(_) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must be a string"),
        )),
    }
}

/// Preserve the distinction between omitted and explicit null for persisted
/// model settings.
fn optional_nullable_text(
    params: &Value,
    key: &str,
) -> Result<Option<Option<String>>, ProtocolError> {
    match params.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(Some(value.clone()))),
        Some(Value::String(_)) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must not be empty"),
        )),
        Some(_) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must be a string or null"),
        )),
    }
}

fn optional_bool(params: &Value, key: &str) -> Result<Option<bool>, ProtocolError> {
    match params.get(key) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must be a boolean"),
        )),
    }
}

fn automation_status(value: &str) -> Result<AutomationStatus, ProtocolError> {
    match value {
        "active" => Ok(AutomationStatus::Active),
        "paused" => Ok(AutomationStatus::Paused),
        _ => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "automation status must be active or paused",
        )),
    }
}

fn create_status(params: &Value) -> Result<AutomationStatus, ProtocolError> {
    match params.get("status") {
        None => Ok(AutomationStatus::Active),
        Some(Value::String(status)) => automation_status(status),
        Some(_) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "status must be active or paused",
        )),
    }
}

fn update_status(params: &Value) -> Result<Option<AutomationStatus>, ProtocolError> {
    match params.get("status") {
        None => Ok(None),
        Some(Value::String(status)) => automation_status(status).map(Some),
        Some(_) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "status must be active or paused",
        )),
    }
}

fn schedule(params: &Value) -> Result<AutomationSchedule, ProtocolError> {
    let schedule = required_object(params, "schedule")?;
    let kind = schedule
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "schedule.kind must be a string",
            )
        })?;
    match kind {
        "interval" => {
            let minutes = schedule
                .get("minutes")
                .and_then(Value::as_u64)
                .ok_or_else(|| {
                    ProtocolError::new(
                        ErrorCategory::InvalidArgument,
                        "schedule.minutes must be an unsigned integer",
                    )
                })?;
            Ok(AutomationSchedule::Interval { minutes })
        }
        "once" => {
            let at = schedule.get("at").and_then(Value::as_i64).ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "schedule.at must be a UTC epoch millisecond integer",
                )
            })?;
            Ok(AutomationSchedule::Once { at })
        }
        _ => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "schedule.kind must be interval or once",
        )),
    }
}

fn optional_schedule(params: &Value) -> Result<Option<AutomationSchedule>, ProtocolError> {
    if params.get("schedule").is_none() {
        return Ok(None);
    }
    schedule(params).map(Some)
}

/// Accept the original `revision` spelling and the rest of the control
/// plane's `expectedRevision` spelling. Supplying both with different values
/// is rejected rather than guessing the caller's intent.
fn expected_revision(params: &Value) -> Result<Option<u64>, ProtocolError> {
    fn read(params: &Value, key: &str) -> Result<Option<u64>, ProtocolError> {
        match params.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value.as_u64().map(Some).ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    format!("{key} must be an unsigned integer"),
                )
            }),
        }
    }
    let revision = read(params, "revision")?;
    let expected = read(params, "expectedRevision")?;
    if let (Some(revision), Some(expected)) = (revision, expected)
        && revision != expected
    {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "revision and expectedRevision disagree",
        ));
    }
    Ok(expected.or(revision))
}

impl ControlPlane {
    /// Start only after `ControlPlane::open` has acquired the Home lock. The
    /// scheduler has no executor access; callers must drain it through
    /// [`Self::dispatch_queued_automations`] on the reader-owning thread.
    pub fn start_automation_scheduler(&self) -> Result<AutomationScheduler, ProtocolError> {
        AutomationScheduler::start(Arc::clone(&self.store), Arc::clone(&self.admissions_paused))
    }

    /// Run every currently queued durable dispatch. The per-run error is
    /// persisted on the Automation and does not take down the daemon.
    pub fn dispatch_queued_automations(&mut self, scheduler: &AutomationScheduler) -> usize {
        let mut dispatched = 0;
        while dispatched < MAX_DISPATCHES_PER_OWNER_WAKE {
            let Some(dispatch) = scheduler.try_next() else {
                break;
            };
            dispatched += 1;
            if let Err(error) = self.dispatch_automation_run(&dispatch.run_id) {
                eprintln!(
                    "knorvia automation dispatch {}: {}",
                    dispatch.run_id, error.message
                );
            }
            // Release the in-flight slot in every outcome. Durable state stays
            // authoritative: a run whose model call already started is no
            // longer resumable, so only genuinely undispatched work is
            // re-offered by the next tick. Without this release the bounded
            // in-flight set would eventually reject all new dispatches.
            scheduler.complete_dispatch(&dispatch.run_id);
        }
        dispatched
    }

    /// Materialize a real durable Thread then delegate to the normal
    /// `turn/start` admission and existing executor. There is no separate
    /// automation model loop.
    pub fn dispatch_automation_run(
        &mut self,
        run_id: &str,
    ) -> Result<Option<AutomationRun>, ProtocolError> {
        let Some(run) = self
            .store
            .materialize_automation_run(run_id, epoch_millis())
            .map_err(StoreError::into_protocol)?
        else {
            return Ok(None);
        };
        let thread_id = run.thread_id.clone().ok_or_else(|| {
            ProtocolError::new(
                ErrorCategory::Internal,
                "materialized automation run has no product thread id",
            )
        })?;
        let turn_params = json!({
            "threadId": thread_id,
            "input": run.prompt,
            "tools": {"write": run.allow_writes},
            "model": run.model,
            "reasoningEffort": run.reasoning_effort,
        });
        let response = match self.rpc_turn_start(&turn_params) {
            Ok(response) => response,
            Err(error) => {
                let message = error.message.clone();
                self.store
                    .fail_automation_run(run_id, message, epoch_millis())
                    .map_err(StoreError::into_protocol)?;
                return Err(error);
            }
        };
        let turn_id = response
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::Internal,
                    "turn/start accepted automation work without a turn id",
                )
            })?;
        self.store
            .mark_automation_run_started(run_id, turn_id, epoch_millis())
            .map_err(StoreError::into_protocol)?;
        // Deterministic local executors can complete synchronously. Production
        // returns immediately for the runner; this only observes a terminal
        // durable state and never blocks on the model.
        self.store
            .reconcile_automation_runs(epoch_millis())
            .map_err(StoreError::into_protocol)?;
        self.store
            .read_automation_run(run_id)
            .map(Some)
            .map_err(StoreError::into_protocol)
    }

    pub(super) fn rpc_automation_list(&self, params: &Value) -> Result<Value, ProtocolError> {
        let workspace_id = match params.get("workspaceId") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) if !value.trim().is_empty() => Some(value.as_str()),
            Some(_) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "workspaceId must be a non-empty string or null",
                ));
            }
        };
        let automations = self
            .store
            .list_automations(workspace_id)
            .map_err(StoreError::into_protocol)?;
        let values = automations
            .iter()
            .map(|automation| self.automation_value(automation))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({"automations": values}))
    }

    pub(super) fn rpc_automation_create(&self, params: &Value) -> Result<Value, ProtocolError> {
        let title = required_text(params, "title")?;
        let prompt = required_text(params, "prompt")?;
        let workspace_id = required_text(params, "workspaceId")?;
        let automation = self
            .store
            .create_automation_with_settings(
                &title,
                &prompt,
                &workspace_id,
                schedule(params)?,
                create_status(params)?,
                optional_bool(params, "allowWrites")?.unwrap_or(false),
                optional_nullable_text(params, "model")?.flatten(),
                optional_nullable_text(params, "reasoningEffort")?.flatten(),
            )
            .map_err(StoreError::into_protocol)?;
        Ok(json!({"automation": self.automation_value(&automation)?}))
    }

    pub(super) fn rpc_automation_update(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_text(params, "id")?;
        let update = AutomationUpdate {
            title: optional_text(params, "title")?,
            prompt: optional_text(params, "prompt")?,
            workspace_id: optional_text(params, "workspaceId")?,
            schedule: optional_schedule(params)?,
            status: update_status(params)?,
            allow_writes: optional_bool(params, "allowWrites")?,
            model: optional_nullable_text(params, "model")?,
            reasoning_effort: optional_nullable_text(params, "reasoningEffort")?,
        };
        let automation = self
            .store
            .update_automation(&id, update, expected_revision(params)?)
            .map_err(StoreError::into_protocol)?;
        Ok(json!({"automation": self.automation_value(&automation)?}))
    }

    pub(super) fn rpc_automation_delete(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_text(params, "id")?;
        self.store
            .delete_automation(&id, expected_revision(params)?)
            .map_err(StoreError::into_protocol)?;
        Ok(json!({"deleted": true}))
    }

    pub(super) fn rpc_automation_run(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_text(params, "id")?;
        let claimed = self
            .store
            .claim_manual_automation_run(&id)
            .map_err(StoreError::into_protocol)?;
        let run = self
            .dispatch_automation_run(&claimed.id)?
            .unwrap_or_else(|| claimed.clone());
        let automation = self
            .store
            .read_automation(&id)
            .map_err(StoreError::into_protocol)?;
        Ok(json!({
            "automation": self.automation_value(&automation)?,
            "runId": run.id,
            "threadId": run.thread_id,
        }))
    }

    fn automation_value(&self, automation: &Automation) -> Result<Value, ProtocolError> {
        let mut value = serde_json::to_value(automation)
            .map_err(|error| ProtocolError::new(ErrorCategory::Internal, error.to_string()))?;
        let recent_runs = self
            .store
            .list_automation_runs(&automation.id, RECENT_RUN_LIMIT)
            .map_err(StoreError::into_protocol)?;
        let object = value.as_object_mut().ok_or_else(|| {
            ProtocolError::new(
                ErrorCategory::Internal,
                "automation did not serialize to an object",
            )
        })?;
        object.insert("recentRuns".into(), json!(recent_runs));
        Ok(value)
    }
}

#[cfg(test)]
#[path = "automations_tests.rs"]
mod automations_tests;
