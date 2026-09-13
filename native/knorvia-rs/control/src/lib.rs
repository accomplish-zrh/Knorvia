//! Control plane: the shipped functions Desktop/Web/CLI talk to via Protocol.
//! Tests call `ControlPlane::handle` directly — this is the production path.

use knorvia_capability_host::PackHost;
use knorvia_kernel_adapter as ka;
use knorvia_migration::Migrator;
use knorvia_packs::{self, PackExecError};
use knorvia_platform_paths::KnorviaPaths;
use knorvia_protocol::{
    ErrorCategory, Handshake, InitializeParams, JSONRPC_VERSION, PRODUCT_NAME, ProtocolError,
    RpcFailure, RpcNotification, RpcRequest, RpcSuccess, SERVER_NAME, write_frame,
};
use knorvia_provider_gateway::{self, CanonicalRequest, ProviderKind};
use knorvia_store::{ArtifactCatalogQuery, GoalUpdate, ProductStore, WorkspaceCwdUpdate};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
#[cfg(test)]
use std::time::Duration;

mod automations;
mod message_queue;
mod bots;
#[cfg(test)]
mod bots_rpc_tests;
mod extensions;
mod goals;
mod project_context;
mod project_search;
mod restart;
mod room_dispatch;
mod room_mentions;
// C-001/C-002 wiring (A-integrated): memory + auth-link RPC surfaces.
mod auth_links_rpc;
mod memory_rpc;
#[cfg(test)]
mod room_dispatch_tests;
mod sessions;
mod pack_dispatch;
pub mod turn_exec;
mod turns;
mod usage_summary;
// B05 (night 2026-09-10): read-only delivery pre-checks for worktrees.
mod worktree_review;
pub use automations::{AutomationScheduler, serve_stdio_with_automations};

#[cfg(test)]
mod ownership_tests;
pub use turn_exec::{
    EventSink, KernelTurnExecutor, KernelTurnSettings, TurnExecutor, TurnItem, TurnOutcome,
    TurnRequest,
};

pub struct ControlPlane {
    handshake: Handshake,
    store: Arc<ProductStore>,
    packs: Arc<PackHost>,
    executor: Arc<Mutex<Box<dyn TurnExecutor>>>,
    admissions_paused: Arc<AtomicBool>,
    /// Serializes the scheduler's final pause check with state-transition
    /// quiescence. Once paused and synchronized through this barrier, no
    /// background scheduler code can touch the swappable state tree.
    state_writer_barrier: Arc<Mutex<()>>,
    /// Active room dispatches keyed by conversation id; the value cancels.
    /// Shared with the dispatch thread so it can deregister on completion.
    room_dispatches: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// Production: the supervised pack worker process. Tests may install an
    /// in-process runner via `open_with_pack_runner_factory`. Shared with
    /// background execution threads (A05), hence the mutex.
    pack_runner_factory: PackRunnerFactory,
    /// Live background pack invocations (A05) keyed by invocation id: the
    /// cancel handle reaches the registered worker; `done` lets a cancel
    /// wait for the reclaim instead of answering with a blind record flip.
    live_packs: Arc<Mutex<HashMap<String, LivePackHandle>>>,
    pack_requests: Arc<std::sync::atomic::AtomicUsize>,
    /// Live project-search sessions (P01). Sliced and resumed on the single
    /// control thread; cancellation simply removes the session.
    project_search: project_search::ProjectSearchRegistry,
    queue_driver: message_queue::QueueDriver,
    // Drop last, after executor shutdown. A second writer cannot recover a
    // live owner's turns; the lock file is never deleted as a locking scheme.
    _ownership: Option<Arc<std::fs::File>>,
}

/// The factory is called from background execution threads as well as the
/// control thread, so it is shared behind a mutex instead of a bare box.
type PackRunnerFactory = std::sync::Arc<std::sync::Mutex<
    Box<dyn Fn() -> Result<Box<dyn knorvia_packs::PackRunner + Send>, ProtocolError> + Send>,
>>;

/// One admitted, currently-executing background pack invocation.
struct LivePackHandle {
    cancel: knorvia_packs::InvocationCancel,
    job_id: String,
    pack_id: String,
    /// Set (with notify) when the execution thread finished — successfully
    /// or not — so a cancel can report a real reclaim instead of a guess.
    done: Arc<(Mutex<bool>, std::sync::Condvar)>,
}

impl LivePackHandle {
    /// Bounded wait for the execution thread to observe the cancel and exit.
    fn wait_reclaimed(&self, timeout: std::time::Duration) -> bool {
        let (lock, cvar) = &*self.done;
        let Ok(mut guard) = lock.lock() else {
            return false;
        };
        if *guard {
            return true;
        }
        let outcome = cvar.wait_timeout_while(guard, timeout, |finished| !*finished);
        match outcome {
            Ok((guard, _)) => *guard,
            Err(poisoned) => *poisoned.into_inner().0,
        }
    }
}

/// Production runner: renders in the supervised `knorvia-pack-worker`
/// process (one spawn per render; the worker holds no ambient authority).
/// Worker progress notifications become job checkpoints via the store. The
/// worker command routes by the pack manifest's runtime field: `native` →
/// the Rust worker binary; `python` → the Python media worker module.
struct WorkerPackRunner {
    store: Arc<ProductStore>,
    /// product pack id → worker runtime ("native" | "python"), read from the
    /// installed manifests at construction.
    pack_runtimes: HashMap<String, String>,
    /// A05: latched before the render starts so a cancel that lands during
    /// the spawn/handshake still reaches the worker once it exists.
    cancel: Option<knorvia_packs::InvocationCancel>,
}

impl WorkerPackRunner {
    fn new(
        store: Arc<ProductStore>,
        packs: &PackHost,
    ) -> Result<Self, knorvia_capability_host::worker::WorkerError> {
        // Resolve the native worker eagerly so a missing binary surfaces as a
        // typed error before the invocation record is created (python packs
        // resolve their interpreter lazily at render).
        knorvia_capability_host::worker::resolve_worker_bin()?;
        let mut pack_runtimes = HashMap::new();
        for id in knorvia_packs::OFFICIAL_PACKS.iter().map(|(id, ..)| *id) {
            if let Ok(record) = packs.read(id) {
                let runtime = record.manifest.runtime;
                pack_runtimes.insert(id.to_string(), runtime);
            }
        }
        Ok(Self {
            store,
            pack_runtimes,
            cancel: None,
        })
    }
}

impl knorvia_packs::PackRunner for WorkerPackRunner {
    fn bind_cancel(&mut self, cancel: knorvia_packs::InvocationCancel) {
        self.cancel = Some(cancel);
    }

    fn render(
        &mut self,
        ctx: &knorvia_packs::RenderContext,
        pack_id: &str,
        input: &Value,
    ) -> Result<knorvia_packs::RenderedPack, knorvia_packs::PackExecError> {
        let runtime = self
            .pack_runtimes
            .get(pack_id)
            .cloned()
            .unwrap_or_else(|| "native".into());
        let spec = knorvia_capability_host::worker::PackWorkerClient::spec_for_runtime(&runtime)
            .map_err(|e| knorvia_packs::PackExecError::Msg(format!("pack worker: {e}")))?;
        let mut client = knorvia_capability_host::worker::PackWorkerClient::spawn_spec(&spec)
            .map_err(|e| knorvia_packs::PackExecError::Msg(format!("pack worker: {e}")))?;
        // A05: a cancel that fired before the worker existed (latched) or
        // lands from now on reclaims this exact worker process tree.
        if let Some(cancel) = &self.cancel {
            let killer = client.kill_handle();
            cancel.register_reclaimer(Arc::new(move || killer.kill()));
        }
        // Worker progress notifications update the running job's checkpoint.
        let store = Arc::clone(&self.store);
        let job_id = ctx.job_id.clone();
        client.set_event_sink(Some(Arc::new(move |note: &Value| {
            if note.get("method").and_then(|m| m.as_str()) == Some("progress") {
                let step = note
                    .pointer("/params/step")
                    .and_then(|s| s.as_str())
                    .unwrap_or("progress")
                    .to_string();
                let _ = store.checkpoint_job_running(&job_id, json!({"step": step}));
            }
        })));
        client
            .initialize(&[pack_id])
            .map_err(|e| knorvia_packs::PackExecError::Msg(format!("pack worker: {e}")))?;
        let (mime, title, bytes) = client
            .render(pack_id, input)
            .map_err(|e| knorvia_packs::PackExecError::Msg(format!("pack worker: {e}")))?;
        Ok(knorvia_packs::RenderedPack { mime, title, bytes })
    }
}

fn worker_pack_runner_factory(
    store: Arc<ProductStore>,
    packs: &PackHost,
) -> Result<Box<dyn knorvia_packs::PackRunner + Send>, ProtocolError> {
    let runner = WorkerPackRunner::new(store, packs)
        .map_err(|e| ProtocolError::new(ErrorCategory::CapabilityUnavailable, e.to_string()))?;
    Ok(Box::new(runner))
}

/// An acquired OS Home lock bound to its paths. Transport may accept authenticated
/// clients while recovery runs, but no second control owner can open this Home.
pub struct HomeOwnership {
    paths: KnorviaPaths,
    lock: Arc<std::fs::File>,
}

impl ControlPlane {
    pub fn acquire_home(paths: KnorviaPaths) -> Result<HomeOwnership, ProtocolError> {
        paths
            .ensure_layout()
            .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
        let ownership = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            // The ownership credential must survive state-directory swaps.
            // `run/` is stable while migration rollback moves `state/`, so a
            // crash/recovery can never accidentally admit a second writer.
            .open(paths.run.join("daemon.lock"))
            .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
        ownership.try_lock().map_err(|error| match error {
            std::fs::TryLockError::WouldBlock => ProtocolError::new(ErrorCategory::Conflict, "Knorvia Home already has an active daemon; connect to its owner instead of opening another writer"),
            std::fs::TryLockError::Error(error) => ProtocolError::new(ErrorCategory::Internal, error.to_string()),
        })?;
        Ok(HomeOwnership {
            paths,
            lock: Arc::new(ownership),
        })
    }

    pub fn open(paths: KnorviaPaths) -> Result<Self, ProtocolError> {
        Self::open_with_ownership(Self::acquire_home(paths)?)
    }

    pub fn open_with_ownership(ownership: HomeOwnership) -> Result<Self, ProtocolError> {
        let HomeOwnership {
            paths,
            lock: ownership,
        } = ownership;
        // A crash between rollback renames is repaired while the stable Home
        // lock is held and before ProductStore can bootstrap or expose the
        // temporarily absent state path.
        Migrator::recover_pending_rollback(&paths)
            .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
        // The store is opened first so the production executor shares one
        // instance: Kernel bindings become durable product records written
        // through the same store the control plane uses.
        let store = Arc::new(ProductStore::open(paths.clone()).map_err(|e| e.into_protocol())?);
        let executor = KernelTurnExecutor::with_ownership_and_store(
            paths.clone(),
            Arc::clone(&ownership),
            Arc::clone(&store),
        );
        let mut plane = Self::open_with_executor_and_store(paths, Box::new(executor), store)?;
        plane._ownership = Some(ownership);
        plane
            .store
            .recover_incomplete_turns()
            .map_err(|e| e.into_protocol())?;
        // Same batch semantics for Pack/Job work: a restart must never leave
        // a forever-`running` Job or Invocation. Recovery only records the
        // terminal fact; resuming the recorded identity stays explicit.
        plane
            .store
            .recover_incomplete_jobs()
            .map_err(|e| e.into_protocol())?;
        plane
            .packs
            .recover_incomplete()
            .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
        // Bounded expiry sweep for Auth Connect: ops that expired while no
        // process owned this Home are closed with their temporary secrets
        // scrubbed, so a restart never re-advertises a dead login window.
        let _ = plane.auth_links().sweep_expired();
        Ok(plane)
    }

    pub fn open_with_executor(
        paths: KnorviaPaths,
        executor: Box<dyn TurnExecutor>,
    ) -> Result<Self, ProtocolError> {
        let store = Arc::new(ProductStore::open(paths.clone()).map_err(|e| e.into_protocol())?);
        Self::open_with_executor_and_store(paths, executor, store)
    }

    fn open_with_executor_and_store(
        paths: KnorviaPaths,
        executor: Box<dyn TurnExecutor>,
        store: Arc<ProductStore>,
    ) -> Result<Self, ProtocolError> {
        let packs = Arc::new(
            PackHost::open(&paths)
                .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?,
        );
        knorvia_packs::ensure_official(&packs)
            .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
        let packs_for_factory = Arc::clone(&packs);
        let store_for_factory = Arc::clone(&store);
        Ok(Self::from_initialized_parts(
            store,
            packs,
            executor,
            Arc::new(Mutex::new(Box::new(move || {
                worker_pack_runner_factory(Arc::clone(&store_for_factory), &packs_for_factory)
            }))),
        ))
    }

    /// Test seam: install a custom pack runner factory (e.g. in-process
    /// rendering without the worker binary).
    pub fn open_full(
        paths: KnorviaPaths,
        executor: Box<dyn TurnExecutor>,
        pack_runner_factory: PackRunnerFactory,
    ) -> Result<Self, ProtocolError> {
        let store = Arc::new(ProductStore::open(paths.clone()).map_err(|e| e.into_protocol())?);
        let packs = Arc::new(
            PackHost::open(&paths)
                .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?,
        );
        knorvia_packs::ensure_official(&packs)
            .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
        Ok(Self::from_initialized_parts(
            store,
            packs,
            executor,
            pack_runner_factory,
        ))
    }

    fn from_initialized_parts(
        store: Arc<ProductStore>,
        packs: Arc<PackHost>,
        executor: Box<dyn TurnExecutor>,
        pack_runner_factory: PackRunnerFactory,
    ) -> Self {
        Self {
            _ownership: None,
            handshake: Handshake::new(),
            store,
            packs,
            executor: Arc::new(Mutex::new(executor)),
            pack_runner_factory,
            live_packs: Arc::new(Mutex::new(HashMap::new())),
            pack_requests: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            admissions_paused: Arc::new(AtomicBool::new(false)),
            state_writer_barrier: Arc::new(Mutex::new(())),
            room_dispatches: Arc::new(Mutex::new(HashMap::new())),
            project_search: project_search::ProjectSearchRegistry::default(),
            queue_driver: message_queue::QueueDriver::default(),
        }
    }

    /// Serialize executor access for call sites that hold `&self`. The
    /// executor is internally synchronized; the mutex only protects its
    /// mutable façade, never across a blocking wait.
    fn executor_lock(&self) -> std::sync::MutexGuard<'_, Box<dyn TurnExecutor>> {
        self.executor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Attach the streamed-turn notification sink (serve_stdio installs this
    /// so write-turn runners can stream `turn/event` notifications).
    pub fn set_sink(&mut self, sink: Option<EventSink>) {
        self.executor_lock().set_sink(sink);
    }

    pub fn store(&self) -> &ProductStore {
        &self.store
    }

    pub fn is_ready(&self) -> bool {
        self.handshake.is_ready()
    }

    pub fn handle_json(&mut self, body: &str) -> Result<Option<String>, ProtocolError> {
        let v: Value = serde_json::from_str(body)
            .map_err(|e| ProtocolError::new(ErrorCategory::InvalidArgument, e.to_string()))?;
        if v.get("id").is_none() {
            let note: RpcNotification = serde_json::from_value(v)
                .map_err(|e| ProtocolError::new(ErrorCategory::InvalidArgument, e.to_string()))?;
            self.handle_notification(&note)?;
            return Ok(None);
        }
        let req: RpcRequest = serde_json::from_value(v)
            .map_err(|e| ProtocolError::new(ErrorCategory::InvalidArgument, e.to_string()))?;
        if serde_json::to_vec(&req.id).expect("request ID").len() > 128 {
            let fail = RpcFailure::from_category(req.id, ErrorCategory::InvalidArgument, "request ID exceeds 128 encoded bytes");
            let encoded = serde_json::to_string(&fail).expect("rpc");
            if encoded.len() > knorvia_protocol::MAX_FRAME_BYTES {
                return Err(ProtocolError::new(ErrorCategory::InvalidArgument, "request ID exceeds response frame budget"));
            }
            return Ok(Some(encoded));
        }
        if req.jsonrpc != JSONRPC_VERSION {
            let fail = RpcFailure::from_category(
                req.id,
                ErrorCategory::InvalidArgument,
                "jsonrpc must be \"2.0\"",
            );
            return Ok(Some(serde_json::to_string(&fail).expect("rpc")));
        }
        match self.handle_request(&req) {
            Ok(result) => {
                let ok = RpcSuccess::new(req.id, result);
                Ok(Some(serde_json::to_string(&ok).expect("rpc")))
            }
            Err(err) => {
                let fail = RpcFailure::from_protocol(req.id, err);
                Ok(Some(serde_json::to_string(&fail).expect("rpc")))
            }
        }
    }

    fn handle_notification(&mut self, note: &RpcNotification) -> Result<(), ProtocolError> {
        match note.method.as_str() {
            "initialized" => self.handshake.initialized(),
            other => Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                format!("unknown notification {other}"),
            )),
        }
    }

    fn handle_request(&mut self, req: &RpcRequest) -> Result<Value, ProtocolError> {
        if req.method != "initialize" && !self.queue_driver.admitting {
            self.handshake.require_ready()?;
        }
        let params = &req.params;
        let idem = params
            .get("idempotencyKey")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        // These operations own their durable, operation-specific receipts.
        // A generic marker would hide resumable work after admission and
        // would prevent room/send from restarting a queued worker.
        if matches!(req.method.as_str(), "memory/import" | "room/send") {
            return self.dispatch_request(req, params);
        }
        if let Some(key) = &idem {
            // The idempotency identity is (key, method, request fingerprint).
            // Marks the attempt pending (or returns the durable outcome of a
            // finished attempt). A crash between a method's side effects and
            // its completion therefore replays as a typed "outcome unknown"
            // instead of a silent duplicate execution; a recycled key with a
            // different payload is a typed conflict instead of a foreign hit.
            let fingerprint = idempotency_fingerprint(&req.method, params);
            if let Some(cached) = self
                .store
                .begin_idempotent(key, &req.method, &fingerprint)
                .map_err(|e| e.into_protocol())?
            {
                return Ok(cached);
            }
            let outcome = self.dispatch_request(req, params);
            match &outcome {
                Ok(result) => {
                    if let Err(e) =
                        self.store
                            .remember_idempotent(key, &req.method, &fingerprint, result)
                    {
                        return Err(e.into_protocol());
                    }
                }
                Err(error) => {
                    // Validation failures cannot have produced effects, so the
                    // key stays reusable; anything after admission keeps a
                    // failed marker that a replay must attribute.
                    let side_effect_free = matches!(
                        error.category,
                        ErrorCategory::InvalidArgument | ErrorCategory::NotInitialized
                    );
                    let _ = if side_effect_free {
                        self.store.clear_idempotent(key)
                    } else {
                        self.store
                            .fail_idempotent(
                                key,
                                &req.method,
                                &fingerprint,
                                &knorvia_protocol::sanitize_diagnostic(&error.message),
                            )
                    };
                }
            }
            return outcome;
        }
        self.dispatch_request(req, params)
    }

    fn dispatch_request(
        &mut self,
        req: &RpcRequest,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        if req.method != "initialize" && !self.queue_driver.admitting {
            self.handshake.require_ready()?;
        }
        let result = match req.method.as_str() {
            "initialize" => self.rpc_initialize(params),
            "system/health" => {
                Ok(json!({"ok": true, "product": PRODUCT_NAME, "server": SERVER_NAME}))
            }
            "system/prepareRestart" => self.prepare_restart(),
            "system/cancelRestart" => self.cancel_restart(),
            "system/version" => Ok(json!({
                "product": PRODUCT_NAME,
                "server": SERVER_NAME,
                "version": env!("CARGO_PKG_VERSION"),
                "protocol": {"major": 1, "minor": 0}
            })),
            // File-location facts for the settings page. Read-only and
            // Home-scoped: the client never guesses these paths and the
            // response contains nothing outside this Home.
            "system/paths" => Ok(json!({
                "home": self.store.paths().home,
                "defaultTaskLocation": self.store.paths().task_workspaces(),
                "state": self.store.paths().state,
                "artifacts": self.store.paths().artifacts,
            })),
            "event/replay" => self.rpc_event_replay(params),
            "workspace/create" => self.rpc_workspace_create(params),
            "workspace/read" => self.rpc_workspace_read(params),
            "workspace/list" => self.rpc_workspace_list(),
            "workspace/update" => self.rpc_workspace_update(params),
            "workspace/files/list" => self.rpc_workspace_files_list(params),
            "workspace/files/read" => self.rpc_workspace_files_read(params),
            "workspace/files/search" => self.rpc_workspace_files_search(params),
            "workspace/files/search/cancel" => self.rpc_workspace_files_search_cancel(params),
            "workspace/path/resolve" => self.rpc_workspace_path_resolve(params),
            "workspace/git/status" => self.rpc_workspace_git_status(params),
            "workspace/git/diff" => self.rpc_workspace_git_diff(params),
            "workspace/worktree/create" => self.rpc_workspace_worktree_create(params),
            "workspace/worktree/list" => self.rpc_workspace_worktree_list(params),
            // B05: read-only delivery review between frozen SHAs.
            "workspace/git/compare" => self.rpc_workspace_git_compare(params),
            "workspace/git/compare-diff" => self.rpc_workspace_git_compare_diff(params),
            "workspace/worktree/lock" => self.rpc_workspace_worktree_lock(params, true),
            "workspace/worktree/unlock" => self.rpc_workspace_worktree_lock(params, false),
            "workspace/worktree/remove" => self.rpc_workspace_worktree_remove(params),
            "automation/list" => self.rpc_automation_list(params),
            "automation/create" => self.rpc_automation_create(params),
            "automation/update" => self.rpc_automation_update(params),
            "automation/delete" => self.rpc_automation_delete(params),
            "automation/run" => self.rpc_automation_run(params),
            "automation/preview" => self.rpc_automation_preview(params),
            "goal/create" => self.rpc_goal_create(params),
            "goal/read" => self.rpc_goal_read(params),
            "goal/list" => self.rpc_goal_list(params),
            "goal/update" => self.rpc_goal_update(params),
            "goal/run" => self.rpc_goal_run(params),
            "goal/run/read" => self.rpc_goal_run_read(params),
            "goal/evidence/add" => self.rpc_goal_evidence(params),
            "task/create" => self.rpc_task_create(params),
            "task/read" => {
                let id = required_str(params, "id")?;
                serde_json::to_value(self.store.read_task(id).map_err(|e| e.into_protocol())?)
                    .map_err(json_err)
            }
            "task/list" => {
                let ws = required_str(params, "workspaceId")?;
                serde_json::to_value(self.store.list_tasks(ws).map_err(|e| e.into_protocol())?)
                    .map_err(json_err)
            }
            "usage/summary" => self.rpc_usage_summary(params),
            "bot/ensureDefault" => self.rpc_bot_ensure_default(),
            "bot/create" => self.rpc_bot_create(params),
            "bot/read" => self.rpc_bot_read(params),
            "bot/list" => self.rpc_bot_list(),
            "bot/updateSoul" => self.rpc_bot_update_soul(params),
            "bot/rename" => self.rpc_bot_rename(params),
            "room/create" => self.rpc_room_create(params),
            "room/ensureDm" => self.rpc_room_ensure_dm(params),
            "room/read" => self.rpc_room_read(params),
            "room/list" => self.rpc_room_list(),
            "room/rename" => self.rpc_room_rename(params),
            "room/addMember" => self.rpc_room_add_member(params),
            "room/removeMember" => self.rpc_room_remove_member(params),
            "room/send" => self.rpc_room_send(params),
            "room/send/status" => self.rpc_room_send_status(params, false),
            "room/send/resume" => self.rpc_room_send_status(params, true),
            "room/mentions" => self.rpc_room_mentions(params),
            "room/messages" => self.rpc_room_messages(params),
            "room/interrupt" => self.rpc_room_interrupt(params),
            "room/checkpoint" => self.rpc_room_checkpoint(params),
            "room/markRead" => self.rpc_room_mark_read(params),
            "room/attention/resolve" => self.rpc_room_attention_resolve(params),
            "cliDispatch/claim" => self.rpc_cli_dispatch_claim(params),
            "cliDispatch/complete" => self.rpc_cli_dispatch_complete(params),
            "sessionBinding/resolve" => self.rpc_session_binding_resolve(params),
            "sessionBinding/attach" => self.rpc_session_binding_attach(params),
            "sessionBinding/markLost" => self.rpc_session_binding_mark_lost(params),
            "sessionBinding/recordDelivery" => self.rpc_session_binding_record_delivery(params),
            "sessionBinding/read" => self.rpc_session_binding_read(params),
            "sessionBinding/list" => self.rpc_session_binding_list(params),
            "memory/record" => self.rpc_memory_record(params),
            "memory/update" => self.rpc_memory_update(params),
            "memory/get" => self.rpc_memory_get(params),
            "memory/list" => self.rpc_memory_list(params),
            "memory/search" => self.rpc_memory_search(params),
            "memory/forget" => self.rpc_memory_forget(params),
            "memory/restore" => self.rpc_memory_restore(params),
            "memory/merge" => self.rpc_memory_merge(params),
            "memory/share" => self.rpc_memory_share(params),
            "memory/pin" => self.rpc_memory_pin(params),
            "memory/timeline" => self.rpc_memory_timeline(params),
            "memory/graph" => self.rpc_memory_graph(params),
            "memory/recall-trace" => self.rpc_memory_recall_trace(params),
            "memory/export" => self.rpc_memory_export(params),
            "memory/import" => self.rpc_memory_import(params),
            "auth/link/list" => self.rpc_auth_link_list(params),
            "auth/link/refresh" => self.rpc_auth_link_refresh(params),
            "auth/link/refresh/read" => self.rpc_auth_link_refresh_read(params),
            "auth/link/refresh/cancel" => self.rpc_auth_link_refresh_cancel(params),
            "auth/link/connect-start" => self.rpc_auth_link_connect_start(params),
            "auth/link/connect-complete" => self.rpc_auth_link_connect_complete(params),
            "auth/link/connect-cancel" => self.rpc_auth_link_connect_cancel(params),
            "auth/link/disconnect" => self.rpc_auth_link_disconnect(params),
            "thread/start" => self.rpc_thread_start(params),
            "thread/read" => self.rpc_thread_read(params),
            "thread/list" => self.rpc_thread_list(params),
            "thread/resume" => self.rpc_thread_resume(params),
            "thread/fork" => self.rpc_thread_fork(params),
            "thread/update" => self.rpc_thread_update(params),
            "thread/archive" => self.rpc_thread_archive(params),
            "thread/unarchive" => self.rpc_thread_unarchive(params),
            "turn/start" => self.rpc_turn_start(params),
            "turnQueue/enqueue" | "turnQueue/read" | "turnQueue/cancel" | "turnQueue/pause" | "turnQueue/resume" => self.rpc_message_queue(req.method.as_str(), params),
            "turn/read" => self.rpc_turn_read(params),
            "turn/steer" => self.rpc_turn_steer(params),
            "turn/interrupt" => self.rpc_turn_interrupt(params),
            "approval/respond" => self.rpc_approval_respond(params),
            "userInput/respond" => self.rpc_user_input(params),
            "artifact/create" => self.rpc_artifact_create(params),
            "artifact/read" => {
                let id = required_str(params, "id")?;
                serde_json::to_value(
                    self.store
                        .read_artifact(id)
                        .map_err(|e| e.into_protocol())?,
                )
                .map_err(json_err)
            }
            "artifact/list" => {
                let ws = required_str(params, "workspaceId")?;
                serde_json::to_value(
                    self.store
                        .list_artifacts(ws)
                        .map_err(|e| e.into_protocol())?,
                )
                .map_err(json_err)
            }
            // P02: one paginated catalog query across every workspace. First
            // screen cost is independent of workspace count, corrupt metadata
            // is skipped-and-counted, and filters apply server-side.
            "artifact/catalog" => {
                let query = ArtifactCatalogQuery {
                    workspace_id: params.get("workspaceId").and_then(Value::as_str),
                    title_contains: params.get("query").and_then(Value::as_str),
                    artifact_type: params.get("type").and_then(Value::as_str),
                };
                let cursor = params.get("cursor").and_then(Value::as_str);
                let limit = params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(50)
                    .clamp(1, 500) as usize;
                let page = self
                    .store
                    .list_artifacts_catalog(query, cursor, limit)
                    .map_err(|e| e.into_protocol())?;
                serde_json::to_value(page).map_err(json_err)
            }
            "artifact/stage" => self.rpc_artifact_stage(params),
            "artifact/content" => self.rpc_artifact_content(params),
            "artifact/commit" => {
                let id = required_str(params, "id")?;
                // P03: with `stagedRevisionId` the commit publishes exactly
                // that staged revision in one durable transaction, or fails
                // with a typed conflict when another writer staged since.
                // Absent keeps the legacy verify→publish pair for old callers.
                let artifact = match params.get("stagedRevisionId") {
                    None | Some(Value::Null) => {
                        self.store
                            .verify_artifact(id)
                            .map_err(|e| e.into_protocol())?;
                        self.store
                            .publish_artifact(id)
                            .map_err(|e| e.into_protocol())?
                    }
                    Some(Value::String(staged_revision_id)) => self
                        .store
                        .commit_staged_artifact(id, staged_revision_id)
                        .map_err(|e| e.into_protocol())?,
                    Some(_) => {
                        return Err(ProtocolError::new(
                            ErrorCategory::InvalidArgument,
                            "stagedRevisionId must be a revision id",
                        ));
                    }
                };
                serde_json::to_value(artifact).map_err(json_err)
            }
            "artifact/diff" => {
                let id = required_str(params, "id")?;
                let art = self
                    .store
                    .read_artifact(id)
                    .map_err(|e| e.into_protocol())?;
                Ok(
                    json!({"id": art.id, "currentRevision": art.current_revision, "lifecycle": art.lifecycle}),
                )
            }
            "artifact/rollback" => {
                let id = required_str(params, "id")?;
                serde_json::to_value(
                    self.store
                        .rollback_artifact(id)
                        .map_err(|e| e.into_protocol())?,
                )
                .map_err(json_err)
            }
            "job/create" => self.rpc_job_create(params),
            "job/list" => {
                let jobs = self
                    .store
                    .list_jobs(
                        required_str(params, "workspaceId")?,
                        params
                            .get("typePrefix")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    )
                    .map_err(|e| e.into_protocol())?;
                let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
                let limit = params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(100)
                    .clamp(1, 200) as usize;
                Ok(
                    json!({"jobs": jobs.iter().skip(offset).take(limit).collect::<Vec<_>>(), "total": jobs.len()}),
                )
            }
            "job/checkpoint" => {
                let checkpoint = params.get("checkpoint").cloned().ok_or_else(|| {
                    ProtocolError::new(ErrorCategory::InvalidArgument, "checkpoint required")
                })?;
                let job = self
                    .store
                    .checkpoint_job(required_str(params, "jobId")?, checkpoint)
                    .map_err(|e| e.into_protocol())?;
                serde_json::to_value(job).map_err(json_err)
            }
            "job/finish" => {
                let job = self
                    .store
                    .finish_job(
                        required_str(params, "jobId")?,
                        required_str(params, "status")?,
                    )
                    .map_err(|e| e.into_protocol())?;
                serde_json::to_value(job).map_err(json_err)
            }
            "job/read" => {
                let id = required_str(params, "id")?;
                serde_json::to_value(self.store.read_job(id).map_err(|e| e.into_protocol())?)
                    .map_err(json_err)
            }
            "job/cancel" => {
                let id = required_str(params, "id")?;
                serde_json::to_value(self.store.cancel_job(id).map_err(|e| e.into_protocol())?)
                    .map_err(json_err)
            }
            "job/retry" => {
                let id = required_str(params, "id")?;
                serde_json::to_value(self.store.retry_job(id).map_err(|e| e.into_protocol())?)
                    .map_err(json_err)
            }
            "job/resume" => {
                let id = required_str(params, "id")?;
                serde_json::to_value(self.store.run_job(id).map_err(|e| e.into_protocol())?)
                    .map_err(json_err)
            }
            "activity/list" => self.rpc_activity(params),
            "policy/evaluate" => self.rpc_policy_evaluate(params),
            "capability/list" => self.rpc_capability_list(),
            "capability/invoke" => self.rpc_capability_invoke(params),
            "capability/invokeBackground" => self.rpc_capability_invoke_background(params),
            "capability/status" => self.rpc_capability_status(params),
            "capability/cancel" => self.rpc_capability_cancel(params),
            "capability/resume" => self.rpc_capability_resume(params),
            "provider/list" => self.rpc_provider_list(),
            "model/list" => self.rpc_model_list(params),
            "skills/list" => self.rpc_skill_list(params),
            "turn/agent/interrupt" => self.executor_lock().interrupt_agent(
                required_str(params, "threadId")?,
                required_str(params, "turnId")?,
                required_str(params, "kernelThreadId")?,
            ),
            "extension/kernel/install" => self.rpc_extension_kernel("plugin/install", params),
            "extension/kernel/uninstall" => self.rpc_extension_kernel("plugin/uninstall", params),
            "extension/kernel/read" => self.rpc_extension_kernel("plugin/read", params),
            "provider/negotiate" => self.rpc_provider_negotiate(params),
            "provider/translate" => self.rpc_provider_translate(params),
            "provider/execute" => self.rpc_provider_execute(params),
            "migration/discover" => self.rpc_migration_discover(params),
            "migration/preflight" => self.rpc_migration_preflight(params),
            "migration/run" => self.rpc_migration_run(params),
            "migration/read" => self.rpc_migration_read(params),
            "migration/rollback" => self.rpc_migration_rollback(params),
            other => Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                format!("unknown method {other}"),
            )),
        };
        result
    }

    fn rpc_initialize(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let p: InitializeParams = serde_json::from_value(params.clone())
            .map_err(|e| ProtocolError::new(ErrorCategory::InvalidArgument, e.to_string()))?;
        let result = self.handshake.initialize(p)?;
        serde_json::to_value(result).map_err(json_err)
    }

    fn workspace_value(
        &self,
        workspace: knorvia_protocol::Workspace,
    ) -> Result<Value, ProtocolError> {
        let cwd = self
            .store
            .read_workspace_cwd(&workspace.id)
            .map_err(|e| e.into_protocol())?;
        let removed = self.ensure_workspace_runnable(&workspace.id).is_err();
        let mut value = serde_json::to_value(workspace).map_err(json_err)?;
        value["cwd"] = json!(cwd);
        value["removed"] = json!(removed);
        value["availability"] = json!(if removed { "removed" } else { "available" });
        Ok(value)
    }

    fn rpc_workspace_create(&self, params: &Value) -> Result<Value, ProtocolError> {
        let title = required_str(params, "title")?;
        let cwd: Option<&str> = match params.get("cwd") {
            None | Some(Value::Null) => None,
            Some(Value::String(cwd)) if std::path::Path::new(cwd).is_absolute() => Some(cwd),
            Some(Value::String(_)) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "cwd must be an absolute path",
                ));
            }
            Some(_) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "cwd must be a string or null",
                ));
            }
        };
        let workspace = self
            .store
            .create_workspace_with_cwd(title, cwd)
            .map_err(|e| e.into_protocol())?;
        self.workspace_value(workspace)
    }

    fn rpc_workspace_update(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "id")?;
        let title = match params.get("title") {
            None | Some(Value::Null) => None,
            Some(Value::String(title)) if !title.trim().is_empty() => Some(title.as_str()),
            Some(Value::String(_)) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "title must not be empty",
                ));
            }
            Some(_) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "title must be a string",
                ));
            }
        };
        let cwd = match params.get("cwd") {
            None => WorkspaceCwdUpdate::Unchanged,
            Some(Value::Null) => WorkspaceCwdUpdate::Clear,
            Some(Value::String(cwd)) if std::path::Path::new(cwd).is_absolute() => {
                WorkspaceCwdUpdate::Set(cwd)
            }
            Some(Value::String(_)) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "cwd must be an absolute path",
                ));
            }
            Some(_) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "cwd must be a string or null",
                ));
            }
        };
        if title.is_none() && matches!(cwd, WorkspaceCwdUpdate::Unchanged) {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "workspace/update needs title or cwd",
            ));
        }
        let expected = match params.get("expectedRevision") {
            None | Some(Value::Null) => None,
            Some(value) => value.as_u64().map(Some).ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "expectedRevision must be an unsigned integer",
                )
            })?,
        };
        let workspace = self
            .store
            .update_workspace_with_cwd(id, title, cwd, expected)
            .map_err(|e| e.into_protocol())?;
        self.workspace_value(workspace)
    }

    fn rpc_workspace_read(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "id")?;
        let workspace = self
            .store
            .read_workspace(id)
            .map_err(|e| e.into_protocol())?;
        self.workspace_value(workspace)
    }

    fn rpc_workspace_list(&self) -> Result<Value, ProtocolError> {
        let workspaces = self
            .store
            .list_workspaces()
            .map_err(|e| e.into_protocol())?;
        let values: Result<Vec<_>, _> = workspaces
            .into_iter()
            .map(|workspace| self.workspace_value(workspace))
            .collect();
        Ok(json!(values?))
    }

    fn rpc_task_create(&self, params: &Value) -> Result<Value, ProtocolError> {
        let ws = required_str(params, "workspaceId")?;
        let title = required_str(params, "title")?;
        let goal = params.get("goalId").and_then(|v| v.as_str());
        let t = self
            .store
            .create_task(ws, goal, title)
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(t).map_err(json_err)
    }

    fn rpc_thread_start(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let ws = required_str(params, "workspaceId")?;
        self.ensure_workspace_runnable(ws)?;
        let title = params
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled thread");
        // Workspace cwd is inherited at turn execution time. Do not persist
        // that inherited value as a thread override, or a later workspace
        // update could never take effect for an otherwise-default thread.
        let mut settings = turns::settings_from_params(params, None)?;
        let thread = self
            .store
            .create_thread(
                ws,
                title,
                params.get("goalId").and_then(Value::as_str),
                params.get("taskId").and_then(Value::as_str),
            )
            .map_err(|e| e.into_protocol())?;
        // A thread with no explicit cwd in a cwd-less workspace would execute
        // in the Kernel process's private state directory. Allocate a durable
        // per-task directory instead and persist it as the thread cwd, so the
        // thread snapshot reports it and restarts return to the same folder.
        // Explicit project paths and workspace-inherited cwds are untouched.
        if settings.cwd.is_none()
            && self
                .store
                .read_workspace_cwd(ws)
                .map_err(|e| e.into_protocol())?
                .is_none()
        {
            if let Some(cwd) = self.executor_lock().allocate_projectless_cwd(&thread.id)? {
                settings.cwd = Some(cwd);
            }
        }
        self.executor_lock()
            .configure_thread(&thread.id, &settings)?;
        self.rpc_thread_read(&json!({"id": thread.id}))
    }

    /// Durable token-usage summary over the per-turn ledger. Aggregation adds
    /// the per-turn deltas only; thread-cumulative snapshots were never stored
    /// as facts and are never re-added here. Tokens the provider did not
    /// report stay out of the totals and are surfaced as unknown turns —
    /// never as zeros. Cost is intentionally absent: no price table exists,
    /// so any amount would be a fabrication.
    fn rpc_artifact_create(&self, params: &Value) -> Result<Value, ProtocolError> {
        let ws = required_str(params, "workspaceId")?;
        let title = required_str(params, "title")?;
        let ty = params
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("application/octet-stream");
        let art = self
            .store
            .create_artifact(ws, ty, title)
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(art).map_err(json_err)
    }

    fn rpc_artifact_stage(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "id")?;
        let text = required_str(params, "content")?;
        // P03: an explicit `expectedCurrentRevision` (string, or null for a
        // fresh artifact) binds staging to the base the client actually read;
        // absent keeps the legacy unchecked behavior for old callers.
        let expected_current = match params.get("expectedCurrentRevision") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::String(revision)) => Some(Some(revision.as_str())),
            Some(_) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "expectedCurrentRevision must be a revision id or null",
                ));
            }
        };
        let rev = self
            .store
            .stage_artifact_at_revision(id, text.as_bytes(), "user", expected_current)
            .map_err(|e| e.into_protocol())?;
        serde_json::to_value(rev).map_err(json_err)
    }

    fn rpc_artifact_content(&self, params: &Value) -> Result<Value, ProtocolError> {
        let artifact_id = required_str(params, "id")?;
        let artifact = self
            .store
            .read_artifact(artifact_id)
            .map_err(|e| e.into_protocol())?;
        let revision_id = match params.get("revisionId") {
            None | Some(Value::Null) => artifact.current_revision.clone().ok_or_else(|| {
                ProtocolError::new(ErrorCategory::NotFound, "artifact has no current revision")
            })?,
            Some(Value::String(revision_id)) if !revision_id.trim().is_empty() => {
                revision_id.clone()
            }
            Some(_) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "revisionId must be a non-empty string",
                ));
            }
        };
        let revision = self
            .store
            .read_artifact_revision(&revision_id)
            .map_err(|e| e.into_protocol())?;
        if revision.artifact_id != artifact.id {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "revision does not belong to artifact",
            ));
        }
        let bytes = self
            .store
            .read_revision_content(&revision_id)
            .map_err(|e| e.into_protocol())?;
        let content = String::from_utf8(bytes).map_err(|_| {
            ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "artifact content is binary; use its blob reference instead",
            )
        })?;
        Ok(json!({"artifact": artifact, "revision": revision, "content": content}))
    }

    fn rpc_job_create(&self, params: &Value) -> Result<Value, ProtocolError> {
        let ws = required_str(params, "workspaceId")?;
        let ty = required_str(params, "type")?;
        let mut job = self
            .store
            .create_job(ws, ty)
            .map_err(|e| e.into_protocol())?;
        job = self.store.run_job(&job.id).map_err(|e| e.into_protocol())?;
        serde_json::to_value(job).map_err(json_err)
    }

    /// Both replay methods are bounded even when called without paging options.
    fn rpc_event_replay(&self, params: &Value) -> Result<Value, ProtocolError> {
        let stream = required_str(params, "streamId")?;
        let number = |name: &str, default: u64| -> Result<u64, ProtocolError> {
            match params.get(name) {
                None => Ok(default),
                Some(value) => value.as_u64().ok_or_else(|| ProtocolError::new(ErrorCategory::InvalidArgument, format!("{name} must be an unsigned integer"))),
            }
        };
        let after = number("afterSeq", 0)?;
        let limit = number("limit", 100)?.min(500) as usize;
        let max_bytes = number("maxBytes", knorvia_store::DEFAULT_REPLAY_PAGE_BYTES as u64)?.min(knorvia_store::MAX_REPLAY_PAGE_BYTES as u64) as usize;
        let upper = params.get("upperSeq").map(|_| number("upperSeq", 0)).transpose()?;
        let cursor = match params.get("cursor") {
            None => None,
            Some(value) => Some(value.as_str().ok_or_else(|| ProtocolError::new(ErrorCategory::InvalidArgument, "cursor must be a string"))?),
        };
        let page = self.store.replay_page_snapshot(stream, after, limit, max_bytes, upper, cursor).map_err(|e| e.into_protocol())?;
        serde_json::to_value(page).map_err(json_err)
    }

    fn rpc_activity(&self, params: &Value) -> Result<Value, ProtocolError> {
        self.rpc_event_replay(params)
    }

    fn rpc_capability_list(&self) -> Result<Value, ProtocolError> {
        let list = knorvia_packs::list_installed(&self.packs).map_err(pack_err)?;
        serde_json::to_value(list).map_err(json_err)
    }

    /// Run a pack operation with the configured runner (production: the
    /// supervised worker process; tests: the injected factory).
    fn with_pack_runner(
        &self,
        op: impl FnOnce(
            &mut dyn knorvia_packs::PackRunner,
        ) -> Result<knorvia_packs::PackOutcome, knorvia_packs::PackExecError>,
    ) -> Result<Value, ProtocolError> {
        let mut runner = (self
            .pack_runner_factory
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()))()?;
        let out = op(runner.as_mut()).map_err(pack_err)?;
        serde_json::to_value(out).map_err(json_err)
    }

    fn rpc_capability_invoke(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let pack_id = required_str(params, "packId")?;
        let ws = required_str(params, "workspaceId")?;
        let input = params.get("input").cloned().unwrap_or_else(|| json!({}));
        let admitted = knorvia_packs::admit_invocation(&self.packs, &self.store, pack_id, ws, &input).map_err(pack_err)?;
        let cancel = knorvia_packs::InvocationCancel::default();
        let _live = self.register_pack(&admitted, cancel.clone())?;
        let result = self.with_pack_runner(|runner| knorvia_packs::execute_admitted(&self.packs, &self.store, &admitted, runner, cancel));
        if let Err(error) = &result {
            let _ = self.store.finish_job(&admitted.job_id, "failed");
            let _ = self.packs.fail(&admitted.invocation_id, &error.message);
        }
        result
    }

    /// A05: run a pack in the background. Admission (semantic validation,
    /// invocation record, Job, durable link) happens synchronously so the
    /// caller gets a stable invocation/job identity back immediately; the
    /// render then proceeds on a worker thread, so the control read loop
    /// keeps answering health/approval/cancel while a long pack runs.
    ///
    /// Validation failures are side-effect-free typed invalid-argument
    /// errors: the generic idempotency layer clears the key so the SAME key
    /// can legally retry. Failures after admission leave durable records and
    /// a failed marker (never a silent key clear), attributable via
    /// `capability/status` and resumable through `capability/resume`.
    fn rpc_capability_invoke_background(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let permit = self.pack_permit()?;
        let pack_id = required_str(params, "packId")?;
        let ws = required_str(params, "workspaceId")?;
        let input = params.get("input").cloned().unwrap_or_else(|| json!({}));
        let admitted = knorvia_packs::admit_invocation(&self.packs, &self.store, pack_id, ws, &input).map_err(pack_err)?;
        let cancel = knorvia_packs::InvocationCancel::default();
        let live = self.register_pack(&admitted, cancel.clone())?;
        let store = Arc::clone(&self.store);
        let packs = Arc::clone(&self.packs);
        let work = admitted.clone();
        let factory = Arc::clone(&self.pack_runner_factory);
        let spawned = std::thread::Builder::new().name(format!("pack-render-{}", admitted.invocation_id)).spawn(move || {
            let _permit = permit;
            let _live = live;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), ProtocolError> {
                let mut runner = (factory.lock().unwrap_or_else(|e| e.into_inner()))()?;
                knorvia_packs::execute_admitted(&packs, &store, &work, runner.as_mut(), cancel).map_err(pack_err)?;
                Ok(())
            }));
            let error = match result { Ok(Ok(())) => None, Ok(Err(error)) => Some(error.message), Err(_) => Some("pack execution panicked".into()) };
            if let Some(error) = error {
                let _ = store.finish_job(&work.job_id, "failed");
                let _ = packs.fail(&work.invocation_id, &error);
                let _ = store.append_event(&work.job_id, "pack.backgroundFailed", json!({"error":error}), None);
            }
        });
        if let Err(error) = spawned {
            let _ = self.store.finish_job(&admitted.job_id, "failed");
            let _ = self.packs.fail(&admitted.invocation_id, &error.to_string());
            return Err(ProtocolError::new(ErrorCategory::Internal, format!("pack thread could not start; invocation {} job {}: {error}", admitted.invocation_id, admitted.job_id)));
        }
        Ok(json!({"invocationId":admitted.invocation_id,"jobId":admitted.job_id,"packId":admitted.pack_id,"workspaceId":admitted.workspace_id,"status":"running"}))
    }

    /// A05: read the durable state of one invocation, including its job and
    /// publish outcome. Accepted-but-unfinished work stays visible here
    /// across restarts.
    fn rpc_capability_status(&self, params: &Value) -> Result<Value, ProtocolError> {
        let invocation_id = required_str(params, "invocationId")?;
        let inv = self.packs.read_invocation(invocation_id).map_err(|e| {
            ProtocolError::new(ErrorCategory::CapabilityUnavailable, e.to_string())
        })?;
        let job = inv
            .job_id
            .as_deref()
            .and_then(|job_id| self.store.read_job(job_id).ok());
        let live = self
            .live_packs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(invocation_id);
        Ok(json!({
            "invocationId": inv.id,
            "packId": inv.pack_id,
            "status": inv.status,
            "jobId": inv.job_id,
            "jobStatus": job.as_ref().map(|job| job.status.as_str()),
            "artifactId": inv.output.as_ref().and_then(|o| o.get("artifactId").cloned()),
            "checkpoint": inv.checkpoint,
            "receipt": inv.receipt,
            "live": live,
        }))
    }

    fn rpc_capability_cancel(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "invocationId")?;
        let job_id = params.get("jobId").and_then(|v| v.as_str());
        if let Some(job_id) = job_id {
            let invocation = self.packs.read_invocation(id).map_err(|e| pack_err(e.into()))?;
            if invocation.job_id.as_deref() != Some(job_id) { return Err(ProtocolError::new(ErrorCategory::InvalidArgument, "job does not belong to this invocation")); }
        }
        // Reach the LIVE worker first (A05): the cancel handle kills the
        // registered worker process tree; the durable cancel then records
        // the same fact for the invocation and its job. A worker racing its
        // own registration still sees the latched cancel at registration.
        let mut reclaimed = None;
        let live_handle = self
            .live_packs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .map(|handle| LivePackHandle {
                cancel: handle.cancel.clone(),
                job_id: handle.job_id.clone(),
                pack_id: handle.pack_id.clone(),
                done: Arc::clone(&handle.done),
            });
        if let Some(handle) = live_handle {
            handle.cancel.cancel();
            // Bounded wait: the render thread observes the killed worker and
            // finishes its cancelled-job bookkeeping. Answer honestly even
            // if it needs longer; the latch cannot be un-fired.
            reclaimed = Some(handle.wait_reclaimed(std::time::Duration::from_secs(2)) && handle.cancel.all_reclaimed());
        }
        let inv = knorvia_packs::cancel(&self.packs, &self.store, id, job_id).map_err(pack_err)?;
        let mut value = serde_json::to_value(&inv).map_err(json_err)?;
        if let Some(reclaimed) = reclaimed {
            if let Some(object) = value.as_object_mut() {
                object.insert("reclaimed".into(), json!(reclaimed));
                object.insert("live".into(), json!(!reclaimed));
            }
        }
        Ok(value)
    }


    fn rpc_capability_resume(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "invocationId")?;
        let ws = required_str(params, "workspaceId")?;
        let input = params.get("input").cloned().unwrap_or_else(|| json!({}));
        let inv = self.packs.read_invocation(id).map_err(|e| pack_err(e.into()))?;
        let admitted = knorvia_packs::AdmittedInvocation { invocation_id:id.into(), job_id:inv.job_id.clone().ok_or_else(|| ProtocolError::new(ErrorCategory::PreconditionFailed,"invocation has no job to resume"))?, pack_id:inv.pack_id, workspace_id:ws.into() };
        let cancel = knorvia_packs::InvocationCancel::default();
        let _live = self.register_pack(&admitted, cancel.clone())?;
        self.with_pack_runner(|runner| knorvia_packs::resume_with_cancel(&self.packs, &self.store, id, ws, &input, runner, cancel))
    }

    fn rpc_provider_execute(&self, params: &Value) -> Result<Value, ProtocolError> {
        let kind = ProviderKind::parse(required_str(params, "kind")?)
            .map_err(|e| ProtocolError::new(ErrorCategory::InvalidArgument, e))?;
        let request = params.get("request").cloned().ok_or_else(|| {
            ProtocolError::new(ErrorCategory::InvalidArgument, "missing request object")
        })?;
        let req: CanonicalRequest = serde_json::from_value(request).map_err(json_err)?;
        let tx = knorvia_provider_gateway::translate(kind, req)
            .map_err(|e| ProtocolError::new(ErrorCategory::InvalidArgument, e))?;
        let base_url = std::env::var(knorvia_provider_gateway::PROVIDER_BASE_URL_ENV)
            .ok()
            .filter(|s| !s.trim().is_empty());
        let Some(base_url) = base_url else {
            return Err(ProtocolError::new(
                ErrorCategory::CapabilityUnavailable,
                format!(
                    "no provider base URL configured; set {}",
                    knorvia_provider_gateway::PROVIDER_BASE_URL_ENV
                ),
            ));
        };
        let api_key = std::env::var(knorvia_provider_gateway::PROVIDER_KEY_ENV)
            .ok()
            .filter(|s| !s.trim().is_empty());
        let cfg = knorvia_provider_gateway::ExecuteConfig { base_url, api_key };
        let result = knorvia_provider_gateway::execute(&tx, &cfg).map_err(|e| {
            // Same classification contract the Kernel bridge path applies:
            // transport failures classify (timeout vs connection) instead of
            // collapsing into a generic Transient catch-all.
            match &e {
                knorvia_provider_gateway::ExecuteError::MissingKey => {
                    ProtocolError::new(ErrorCategory::ProviderAuth, e.to_string())
                }
                knorvia_provider_gateway::ExecuteError::MissingBaseUrl => {
                    ProtocolError::new(ErrorCategory::CapabilityUnavailable, e.to_string())
                }
                knorvia_provider_gateway::ExecuteError::Protocol(_) => {
                    ProtocolError::new(ErrorCategory::Transient, e.to_string())
                }
                knorvia_provider_gateway::ExecuteError::Transport(_) => {
                    let failure = knorvia_provider_gateway::classify_transport(&e.to_string());
                    typed_provider_error(
                        failure.category,
                        &failure.message,
                        failure.retryable,
                        failure.retry_after_secs,
                    )
                }
            }
        })?;
        // A classified provider failure (HTTP >= 400, in-band stream error,
        // or truncated stream) is a typed RPC failure, not an Ok payload —
        // clients branch on category / retryable / retryAfter.
        if let Some(message) = result.error.clone() {
            let category = result
                .error_category
                .as_deref()
                .and_then(category_from_name)
                .unwrap_or(ErrorCategory::Transient);
            return Err(typed_provider_error(
                category,
                &message,
                result.retryable.unwrap_or(false),
                result.retry_after,
            ));
        }
        serde_json::to_value(result).map_err(json_err)
    }

    fn migrator(&self) -> Result<Migrator, ProtocolError> {
        Migrator::open(self.store.paths().clone())
            .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))
    }

    fn rpc_migration_discover(&self, params: &Value) -> Result<Value, ProtocolError> {
        let source = required_str(params, "source")?;
        let found = self
            .migrator()?
            .discover(Path::new(source))
            .map_err(|e| ProtocolError::new(ErrorCategory::InvalidArgument, e.to_string()))?;
        Ok(json!({
            "paths": found.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>()
        }))
    }

    fn rpc_migration_preflight(&self, params: &Value) -> Result<Value, ProtocolError> {
        let source = required_str(params, "source")?;
        let pre = self
            .migrator()?
            .preflight(Path::new(source))
            .map_err(|e| ProtocolError::new(ErrorCategory::InvalidArgument, e.to_string()))?;
        serde_json::to_value(pre).map_err(json_err)
    }

    fn rpc_migration_run(&self, params: &Value) -> Result<Value, ProtocolError> {
        let source = required_str(params, "source")?;
        let run = self
            .migrator()?
            .run(Path::new(source))
            .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
        serde_json::to_value(run).map_err(json_err)
    }

    fn rpc_migration_read(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "id")?;
        let run = self
            .migrator()?
            .read_run(id)
            .map_err(|e| ProtocolError::new(ErrorCategory::InvalidArgument, e.to_string()))?;
        serde_json::to_value(run).map_err(json_err)
    }

    fn rpc_migration_rollback(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let id = required_str(params, "id")?;
        // A19 quiescence gate: a rollback swaps the live `state/` directory,
        // so it must not race a running Turn, a Goal runner between rounds,
        // a claimed automation, or a live dispatch path. Admission freezes
        // first; a refusal restores the previous admission state.
        self.prepare_state_transition("migration rollback")?;
        let outcome = self.migrator().and_then(|migrator| {
            migrator
                .rollback(id)
                .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))
        });
        // Success and every preflight/copy/verification failure release the
        // pause. A refused rollback must never wedge the daemon.
        self.cancel_restart()?;
        serde_json::to_value(outcome?).map_err(json_err)
    }

    fn rpc_provider_list(&self) -> Result<Value, ProtocolError> {
        Ok(json!({
            "kinds": ProviderKind::ALL.iter().map(|k| k.as_str()).collect::<Vec<_>>(),
            "trackedCapabilities": knorvia_provider_gateway::TRACKED_CAPABILITIES,
        }))
    }

    fn rpc_provider_negotiate(&self, params: &Value) -> Result<Value, ProtocolError> {
        let kind = ProviderKind::parse(required_str(params, "kind")?)
            .map_err(|e| ProtocolError::new(ErrorCategory::InvalidArgument, e))?;
        let model = required_str(params, "model")?;
        let execution_path = params.get("executionPath").and_then(Value::as_str).unwrap_or("direct");
        let capabilities = match execution_path {
            "direct" => knorvia_provider_gateway::negotiate(kind, model),
            "responsesBridge" => knorvia_provider_gateway::negotiate_bridge(kind, model),
            _ => return Err(ProtocolError::new(ErrorCategory::InvalidArgument, "unknown executionPath")),
        };
        knorvia_provider_gateway::require_not_silent(
            &capabilities,
            knorvia_provider_gateway::TRACKED_CAPABILITIES,
        )
        .map_err(|e| ProtocolError::new(ErrorCategory::InvalidArgument, e))?;
        Ok(json!({
            "kind": kind.as_str(),
            "model": model,
            "capabilities": capabilities,
        }))
    }

    fn rpc_provider_translate(&self, params: &Value) -> Result<Value, ProtocolError> {
        let kind = ProviderKind::parse(required_str(params, "kind")?)
            .map_err(|e| ProtocolError::new(ErrorCategory::InvalidArgument, e))?;
        let request = params.get("request").cloned().ok_or_else(|| {
            ProtocolError::new(ErrorCategory::InvalidArgument, "missing request object")
        })?;
        let req: CanonicalRequest = serde_json::from_value(request).map_err(json_err)?;
        let tx = knorvia_provider_gateway::translate(kind, req)
            .map_err(|e| ProtocolError::new(ErrorCategory::InvalidArgument, e))?;
        serde_json::to_value(tx).map_err(json_err)
    }

    fn rpc_policy_evaluate(&self, params: &Value) -> Result<Value, ProtocolError> {
        let action = required_str(params, "action")?;
        let digest = action_digest(
            action,
            params.get("input").and_then(|v| v.as_str()).unwrap_or(""),
        );
        let decision = if action.contains("write") || action.contains("exec") {
            "require_approval"
        } else {
            "allow"
        };
        Ok(json!({"action": action, "digest": digest, "decision": decision}))
    }
}

fn required_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, ProtocolError> {
    params.get(key).and_then(|v| v.as_str()).ok_or_else(|| {
        ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("missing string field {key}"),
        )
    })
}

/// Days-since-epoch to a UTC (year, month, day) civil date (Howard Hinnant's
/// algorithm). Usage day buckets use UTC; timezone-aware buckets are a
/// documented follow-up.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn json_err(e: serde_json::Error) -> ProtocolError {
    ProtocolError::new(ErrorCategory::Internal, e.to_string())
}

fn pack_err(e: PackExecError) -> ProtocolError {
    ProtocolError::new(
        ErrorCategory::CapabilityUnavailable,
        knorvia_protocol::sanitize_diagnostic(&e.to_string()),
    )
}

/// Build a provider-failure error carrying the full classification contract
/// (category, retryability, normalized Retry-After seconds) so workbench
/// clients can branch without parsing message text.
fn typed_provider_error(
    category: ErrorCategory,
    message: &str,
    retryable: bool,
    retry_after_secs: Option<u64>,
) -> ProtocolError {
    let mut error = ProtocolError::new(category, message);
    error.retryable = retryable;
    error.retry_after = retry_after_secs;
    error
}

/// Inverse of the gateway's category wire name (`PROVIDER_RATE_LIMIT`).
fn category_from_name(name: &str) -> Option<ErrorCategory> {
    serde_json::from_value(json!(name)).ok()
}

/// Hash a keyed request's identity: method + params with the idempotency key
/// itself removed. Stored alongside the key so recycling a key for a
/// different payload is detectable (typed conflict, never a foreign replay).
/// `serde_json` maps serialize with sorted keys, so the rendering is stable
/// for equal params regardless of client field order.
fn idempotency_fingerprint(method: &str, params: &Value) -> String {
    let mut canonical = params.clone();
    if let Some(obj) = canonical.as_object_mut() {
        obj.remove("idempotencyKey");
    }
    let mut h = Sha256::new();
    h.update(method.as_bytes());
    h.update([0]);
    h.update(canonical.to_string().as_bytes());
    hex::encode(h.finalize())
}

pub fn action_digest(action: &str, input: &str) -> String {
    let mut h = Sha256::new();
    h.update(action.as_bytes());
    h.update(b"\0");
    h.update(input.as_bytes());
    hex::encode(h.finalize())
}

/// Serve one connection: stdout is frames only. Logs must not be written here.
/// Streamed turn notifications share the same stdout under a lock.
pub fn serve_stdio<R, W>(
    plane: &mut ControlPlane,
    mut input: R,
    output: W,
) -> Result<(), ProtocolError>
where
    R: BufRead,
    W: Write + Send + Sync + 'static,
{
    let output = Arc::new(std::sync::Mutex::new(output));
    let sink_output = Arc::clone(&output);
    let sink: EventSink = Arc::new(move |method, params| {
        let note = json!({"jsonrpc": JSONRPC_VERSION, "method": method, "params": params});
        if let Ok(mut out) = sink_output.lock() {
            let body = serde_json::to_string(&note).unwrap_or_default();
            let _ = write_frame(&mut *out, &body);
        }
    });
    plane.set_sink(Some(sink));
    loop {
        let body = match knorvia_protocol::read_frame(&mut input) {
            Ok(b) => b,
            Err(knorvia_protocol::WireError::Io(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(e) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    e.to_string(),
                ));
            }
        };
        let pack_output = Arc::clone(&output);
        if plane.defer_pack_request(&plane.handshake, &body, Arc::new(move |response| {
            if let Ok(mut out) = pack_output.lock() { let _ = write_frame(&mut *out, &response); }
        }))? { continue; }
        if let Some(resp) = plane.handle_json(&body)? {
            let mut out = output
                .lock()
                .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
            write_frame(&mut *out, &resp)
                .map_err(|e| ProtocolError::new(ErrorCategory::Internal, e.to_string()))?;
        }
    }
    plane.wait_pack_replies();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use knorvia_platform_paths::layout;
    fn mk_a08(id: &str, method: &str, params: Value) -> String {
        json!({"jsonrpc":"2.0","id": id, "method": method, "params": params}).to_string()
    }

    fn parse_a08(s: String) -> Value {
        serde_json::from_str(&s).unwrap()
    }

    #[test]
    fn event_replay_and_activity_page_through_frozen_snapshots() {
        let mut p = plane();
        let init = json!({
            "jsonrpc": "2.0",
            "id": "init",
            "method": "initialize",
            "params": {
                "protocol": {"major": 1, "minor": 0},
                "client": {"name": "knorvia_test", "version": "0.0.1", "platform": "windows"},
                "capabilities": ["thread", "artifact", "job", "approval", "reconnect"]
            }
        });
        p.handle_json(&init.to_string()).unwrap().unwrap();
        p.handle_json(
            &json!({"jsonrpc":"2.0","method":"initialized"}).to_string(),
        )
        .unwrap();
        let ws = parse_a08(
            p.handle_json(&mk_a08("ws", "workspace/create", json!({"title": "replay"})))
                .unwrap()
                .unwrap(),
        )["result"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let thread = parse_a08(
            p.handle_json(&mk_a08(
                "th",
                "thread/start",
                json!({"workspaceId": ws, "title": "replay"}),
            ))
            .unwrap()
            .unwrap(),
        )["result"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        for i in 0..120 {
            p.store
                .append_event(
                    &thread,
                    "test.appended",
                    json!({"i": i, "filler": "y".repeat(3_000)}),
                    None,
                )
                .unwrap();
        }

        // Protocol-level fixture, not evidence of production UI consumption.
        let mut cursor = 0u64;
        let mut seen = 0usize;
        let mut final_upper = 0u64;
        for _round in 0..100 {
            let result = parse_a08(
                p.handle_json(&mk_a08(
                    "page",
                    "activity/list",
                    json!({
                        "streamId": thread,
                        "afterSeq": cursor,
                        "limit": 25,
                        "maxBytes": 262_144,
                    }),
                ))
                .unwrap()
                .unwrap(),
            )["result"]
                .clone();
            let events = result["events"].as_array().unwrap();
            assert!(events.len() <= 25);
            seen += events.len();
            cursor = result["nextSeq"].as_u64().unwrap();
            final_upper = result["upperSeq"].as_u64().unwrap();
            if !result["hasMore"].as_bool().unwrap() {
                break;
            }
        }
        assert_eq!(cursor, final_upper);

        // Legacy small-result fields remain; large omitted-limit calls paginate.
        let full = parse_a08(
            p.handle_json(&mk_a08(
                "full",
                "event/replay",
                json!({"streamId": thread}),
            ))
            .unwrap()
            .unwrap(),
        );
        let total = full["result"]["events"].as_array().unwrap().len();
        assert_eq!(total, 100, "omitted limit still has a bounded default");
        assert_eq!(full["result"]["hasMore"], true);
        assert_eq!(seen, p.store.replay(&thread, 0).unwrap().len());
    }

    fn mk_a08_unused() {}

    use knorvia_protocol::{encode_frame, read_frame};
    use std::io::Cursor;
    use std::sync::Mutex;

    /// Serializes provider env mutations across parallel tests.
    static PROVIDER_ENV_LOCK: Mutex<()> = Mutex::new(());

    pub(super) fn plane() -> ControlPlane {
        plane_with_runner_factory(Arc::new(Mutex::new(Box::new(|| {
            // Tests render in-process (deterministic, no worker binary
            // dependency). The worker path is covered by packs::tests::worker_rpc.
            // Both env-aware choices are unit variants, so the runner is
            // 'static+Send; the choice is evaluated at render time like the
            // worker does.
            let choice = if knorvia_packs::gateway::GatewayModel::from_env().is_some() {
                knorvia_packs::ModelChoice::GatewayFromEnv
            } else {
                knorvia_packs::ModelChoice::None
            };
            Ok(Box::new(knorvia_packs::InProcessRunner::<'static>::new(
                choice,
            )))
        }))))
    }

    fn plane_with_runner_factory(factory: PackRunnerFactory) -> ControlPlane {
        let base = std::env::temp_dir().join(format!(
            "knorvia-ctrl-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let executor = KernelTurnExecutor::new(layout(base.clone()));
        ControlPlane::open_full(layout(base), Box::new(executor), factory).unwrap()
    }

    fn init(p: &mut ControlPlane) -> Value {
        let req = json!({
            "jsonrpc": "2.0",
            "id": "req_01",
            "method": "initialize",
            "params": {
                "protocol": {"major": 1, "minor": 0},
                "client": {"name": "knorvia_test", "version": "0.0.1", "platform": "windows"},
                "capabilities": ["thread", "artifact", "job", "approval", "reconnect"]
            }
        });
        let resp: Value =
            serde_json::from_str(&p.handle_json(&req.to_string()).unwrap().unwrap()).unwrap();
        assert!(resp.get("error").is_none(), "{resp}");
        let result = resp["result"].clone();
        assert_eq!(result["server"]["name"], "knorvia-daemon");
        assert_eq!(result["server"]["product"], "Knorvia");
        let note = json!({"jsonrpc":"2.0","method":"initialized"});
        assert!(p.handle_json(&note.to_string()).unwrap().is_none());
        result
    }

    #[test]
    #[ignore = "full-fidelity kernel E2E: env-gated (KNORVIA_GOLDEN_E2E=1) and not yet hardened against sandbox/network variance on this machine; the stable evidence for the approval bridge lives in kernel-adapter's write_turn_approval test and the product golden slice"]
    fn golden_vertical_slice_workspace_thread_turn_approval_artifact_replay() {
        // Full-fidelity Kernel write-turn E2E. This spawns the real Kernel
        // process and runs its sandbox; it is env-gated because the in-process
        // control test binary shares environment/parallelism with other tests
        // (the stable evidence lives in kernel-adapter's write_turn_approval
        // test and the product golden slice, which drive the same stack
        // through the daemon). Run with KNORVIA_GOLDEN_E2E=1.
        if std::env::var_os("KNORVIA_GOLDEN_E2E").is_none() {
            eprintln!("skipping golden E2E: set KNORVIA_GOLDEN_E2E=1");
            return;
        }
        // This slice drives REAL Kernel write turns: workspace-write sandbox,
        // on-request approvals bridged to the product approval store, decisions
        // forwarded onto the Kernel wire, cooperative interrupt, and an
        // artifact lifecycle — against a scripted mock provider.
        let _lock = PROVIDER_ENV_LOCK.lock().unwrap();
        let probe = "Invoke-WebRequest -Uri https://example.invalid/knorvia-probe -UseBasicParsing";
        let bodies = vec![
            fn_call_sse(probe),
            message_sse("Understood: the network probe was declined."),
            fn_call_sse(probe),
            message_sse("Probe ran inside the sandbox and was blocked; noted."),
            fn_call_sse(probe),
            // Extra buffers in case the model retries.
            message_sse("still here"),
            message_sse("still here"),
            message_sse("still here"),
            message_sse("still here"),
        ];
        let (base_url, server, provider_hits) = mock_gateway_scripted(bodies);
        let guard = ProviderEnvGuard::set(&[
            ("KNORVIA_PROVIDER_MODEL", "gpt-5.2"),
            ("KNORVIA_PROVIDER_BASE_URL", base_url.as_str()),
            ("KNORVIA_PROVIDER_API_KEY", "sk-knorvia-test"),
        ]);
        let mut p = plane();
        let init_result = init(&mut p);
        assert!(init_result["resumeSupported"].as_bool().unwrap());

        let mk = |id: &str, method: &str, params: Value| {
            json!({"jsonrpc":"2.0","id": id, "method": method, "params": params}).to_string()
        };
        let parse = |s: String| -> Value { serde_json::from_str(&s).unwrap() };

        let ws = parse(
            p.handle_json(&mk(
                "2",
                "workspace/create",
                json!({"title": "Main", "idempotencyKey": "ws-1"}),
            ))
            .unwrap()
            .unwrap(),
        );
        let ws_id = ws["result"]["id"].as_str().unwrap().to_string();
        assert!(ws_id.starts_with("ws_"));

        let ws2 = parse(
            p.handle_json(&mk(
                "2b",
                "workspace/create",
                json!({"title": "Main", "idempotencyKey": "ws-1"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(ws2["result"]["id"], ws["result"]["id"]);

        let th = parse(
            p.handle_json(&mk(
                "3",
                "thread/start",
                json!({"workspaceId": ws_id, "title": "slice"}),
            ))
            .unwrap()
            .unwrap(),
        );
        let thread_id = th["result"]["id"].as_str().unwrap().to_string();

        // Turn 1: write turn; the Kernel surfaces an approval for the network
        // command; the user denies it; the turn completes on the Kernel.
        let turn = parse(
            p.handle_json(&mk(
                "4",
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": "probe the network then write",
                    "tools": {"readOnly": true, "write": true}
                }),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(turn["result"].is_object(), "turn/start RPC failed: {turn}");
        let approval_id = turn["result"]["pendingApprovalId"]
            .as_str()
            .unwrap_or_else(|| panic!("no pendingApprovalId: {turn}"))
            .to_string();
        let turn_id = turn["result"]["turn"]["id"].as_str().unwrap().to_string();
        assert_eq!(turn["result"]["turn"]["status"], "running");

        p.handle_json(&mk(
            "5",
            "turn/steer",
            json!({"threadId": thread_id, "turnId": turn_id, "input": "be careful"}),
        ))
        .unwrap();

        let denied = parse(
            p.handle_json(&mk(
                "6",
                "approval/respond",
                json!({"id": approval_id, "decision": "deny"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            denied["result"]["status"], "denied",
            "approval/respond failed: {denied}"
        );
        let done1 = wait_turn_terminal(&mut p, &thread_id, &turn_id, Duration::from_secs(120));
        assert_eq!(done1["status"], "completed", "{done1}");
        let kinds1: Vec<String> = done1["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["kind"].as_str().unwrap_or_default().to_string())
            .collect();
        assert!(
            kinds1.iter().any(|k| k == "agentMessage"),
            "provider_hits={} kinds={kinds1:?} full={done1}",
            provider_hits.load(std::sync::atomic::Ordering::SeqCst)
        );

        // Turn 2: the user allows the probe; the Kernel runs it inside the
        // sandbox (blocked network, harmless) and completes.
        let turn2 = parse(
            p.handle_json(&mk(
                "7",
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": "run the probe this time",
                    "tools": {"readOnly": true, "write": true}
                }),
            ))
            .unwrap()
            .unwrap(),
        );
        let approval2 = turn2["result"]["pendingApprovalId"]
            .as_str()
            .unwrap()
            .to_string();
        let allowed = parse(
            p.handle_json(&mk(
                "8",
                "approval/respond",
                json!({"id": approval2, "decision": "allow"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(allowed["result"]["status"], "allowed");
        let done2 = wait_turn_terminal(
            &mut p,
            &thread_id,
            &turn2["result"]["turn"]["id"].as_str().unwrap(),
            Duration::from_secs(120),
        );
        assert_eq!(done2["status"], "completed", "{done2}");

        let art = parse(
            p.handle_json(&mk(
                "9",
                "artifact/create",
                json!({"workspaceId": ws_id, "title": "notes.md", "type": "text/markdown"}),
            ))
            .unwrap()
            .unwrap(),
        );
        let art_id = art["result"]["id"].as_str().unwrap().to_string();
        p.handle_json(&mk(
            "10",
            "artifact/stage",
            json!({"id": art_id, "content": "# hello\n"}),
        ))
        .unwrap();
        let published = parse(
            p.handle_json(&mk("11", "artifact/commit", json!({"id": art_id})))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(published["result"]["lifecycle"], "published");

        p.handle_json(&mk(
            "11b",
            "artifact/stage",
            json!({"id": art_id, "content": "# hello v2\n"}),
        ))
        .unwrap();
        p.handle_json(&mk("11c", "artifact/commit", json!({"id": art_id})))
            .unwrap();
        let rolled = parse(
            p.handle_json(&mk("11d", "artifact/rollback", json!({"id": art_id})))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(rolled["result"]["lifecycle"], "published");

        p.handle_json(&mk(
            "11e",
            "userInput/respond",
            json!({"threadId": thread_id, "turnId": turn_id, "input": "more context"}),
        ))
        .unwrap();

        let waiting = parse(
            p.handle_json(&mk(
                "11f",
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": "write then cancel",
                    "tools": {"readOnly": true, "write": true}
                }),
            ))
            .unwrap()
            .unwrap(),
        );
        let waiting_id = waiting["result"]["turn"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(waiting["result"]["turn"]["status"], "running");
        assert!(waiting["result"]["pendingApprovalId"].is_string());
        // Cooperative interrupt bridges onto the Kernel wire; the response
        // waits (bounded) for the terminal cancelled state.
        let interrupted = parse(
            p.handle_json(&mk("11g", "turn/interrupt", json!({"turnId": waiting_id})))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(
            interrupted["result"]["status"], "cancelled",
            "{interrupted}"
        );

        let activity = parse(
            p.handle_json(&mk("11h", "activity/list", json!({"streamId": thread_id})))
                .unwrap()
                .unwrap(),
        );
        let kinds: Vec<String> = activity["result"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["kind"].as_str().unwrap_or("").to_string())
            .collect();
        assert!(
            kinds.iter().any(|k| k.contains("approval")
                || k.contains("tool")
                || k.contains("item")
                || k.contains("turn")
                || k.contains("thread")),
            "{kinds:?}"
        );

        let replay = parse(
            p.handle_json(&mk(
                "12",
                "event/replay",
                json!({"streamId": thread_id, "afterSeq": 0}),
            ))
            .unwrap()
            .unwrap(),
        );
        let events = replay["result"]["events"].as_array().unwrap();
        let mut seen = std::collections::HashSet::new();
        for e in events {
            assert!(seen.insert(e["eventId"].as_str().unwrap().to_string()));
        }
        let replay2 = parse(
            p.handle_json(&mk(
                "13",
                "event/replay",
                json!({"streamId": thread_id, "afterSeq": 0}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            replay["result"]["events"].as_array().unwrap().len(),
            replay2["result"]["events"].as_array().unwrap().len()
        );

        drop(guard);
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    #[test]
    fn serve_stdio_frames_only() {
        let mut p = plane();
        let init = json!({
            "jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"protocol":{"major":1,"minor":0},"client":{"name":"knorvia_cli","version":"0"}}
        });
        let initialized = json!({"jsonrpc":"2.0","method":"initialized"});
        let health = json!({"jsonrpc":"2.0","id":2,"method":"system/health"});
        let mut input = Vec::new();
        input.extend(encode_frame(&init.to_string()));
        input.extend(encode_frame(&initialized.to_string()));
        input.extend(encode_frame(&health.to_string()));
        // Shared writer so the frames are inspectable after serve returns.
        let output: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        struct SharedOut(Arc<Mutex<Vec<u8>>>);
        impl Write for SharedOut {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        serve_stdio(&mut p, Cursor::new(input), SharedOut(Arc::clone(&output))).unwrap();
        let bytes = output.lock().unwrap().clone();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("Content-Length:"), "{text}");
        assert!(!text.trim_start().starts_with('{'));
        let mut cur = Cursor::new(bytes);
        let first = read_frame(&mut cur).unwrap();
        let v: Value = serde_json::from_str(&first).unwrap();
        assert_eq!(v["result"]["server"]["name"], "knorvia-daemon");
        let second = read_frame(&mut cur).unwrap();
        let v2: Value = serde_json::from_str(&second).unwrap();
        assert_eq!(v2["result"]["ok"], true);
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    #[test]
    fn capability_invoke_research_pack_publishes_artifact() {
        // Pack invokes depend on provider env; serialize with gateway tests.
        let _lock = PROVIDER_ENV_LOCK.lock().unwrap();
        let mut p = plane();
        init(&mut p);
        let mk = |id: &str, method: &str, params: Value| {
            json!({"jsonrpc":"2.0","id": id, "method": method, "params": params}).to_string()
        };
        let parse = |s: String| -> Value { serde_json::from_str(&s).unwrap() };
        let ws = parse(
            p.handle_json(&mk("w", "workspace/create", json!({"title": "research"})))
                .unwrap()
                .unwrap(),
        );
        let ws_id = ws["result"]["id"].as_str().unwrap().to_string();
        let packs = parse(
            p.handle_json(&mk("p", "capability/list", json!({})))
                .unwrap()
                .unwrap(),
        );
        assert!(
            packs["result"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["id"] == "research.knowledge")
        );
        let inv = parse(
            p.handle_json(&mk(
                "i",
                "capability/invoke",
                json!({
                    "packId": "research.knowledge",
                    "workspaceId": ws_id,
                    "input": {
                        "query": "Fourier",
                        "corpus": [{"id":"d1","title":"FT","text":"Fourier transform of sine"}]
                    }
                }),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(inv["result"]["status"], "succeeded");
        let art_id = inv["result"]["artifactId"].as_str().unwrap();
        let art = parse(
            p.handle_json(&mk("a", "artifact/read", json!({"id": art_id})))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(art["result"]["lifecycle"], "published");
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    #[test]
    fn provider_gateway_negotiate_and_translate_five_kinds() {
        let mut p = plane();
        init(&mut p);
        let mk = |id: &str, method: &str, params: Value| {
            json!({"jsonrpc":"2.0","id": id, "method": method, "params": params}).to_string()
        };
        let parse = |s: String| -> Value { serde_json::from_str(&s).unwrap() };
        let kinds = parse(
            p.handle_json(&mk("pl", "provider/list", json!({})))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(kinds["result"]["kinds"].as_array().unwrap().len(), 5);
        let request = json!({
            "model": "marker",
            "messages": [
                {"role": "system", "text": "You are Knorvia."},
                {"role": "user", "text": "describe this", "images": [{"mediaType": "image/png", "data": "aaa"}]}
            ],
            "tools": [{"name": "lookup", "description": "lookup", "parameters": {"type": "object"}}],
            "parallelTools": true,
            "structuredOutput": {"type": "object", "properties": {"answer": {"type": "string"}}},
            "reasoning": true,
            "promptCache": true,
            "stream": true
        });
        for (kind, model) in [
            ("openai_responses", "gpt-5"),
            ("openai_compatible", "llama-3"),
            ("anthropic", "claude-sonnet-4"),
            ("gemini", "gemini-2.5-pro"),
            ("local", "ollama/llama3.1"),
        ] {
            let mut req = request.clone();
            req["model"] = json!(model);
            let neg = parse(
                p.handle_json(&mk(
                    &format!("n-{kind}"),
                    "provider/negotiate",
                    json!({"kind": kind, "model": model}),
                ))
                .unwrap()
                .unwrap(),
            );
            let caps = neg["result"]["capabilities"].as_array().unwrap();
            assert_eq!(caps.len(), 8, "{kind}");
            for cap in caps {
                if cap["status"] != "supported" {
                    assert!(
                        !cap["reason"].as_str().unwrap_or("").is_empty(),
                        "{kind} {} silent",
                        cap["name"]
                    );
                }
            }
            let tx = parse(
                p.handle_json(&mk(
                    &format!("t-{kind}"),
                    "provider/translate",
                    json!({"kind": kind, "request": req}),
                ))
                .unwrap()
                .unwrap(),
            );
            assert_eq!(tx["result"]["kind"], kind);
            assert_eq!(
                tx["result"]["applied"].as_array().unwrap().len(),
                8,
                "{kind}"
            );
            assert_eq!(tx["result"]["method"], "POST");
        }
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    #[test]
    fn remaining_domain_packs_and_migration_pipeline() {
        // Pack invokes depend on provider env; serialize with gateway tests.
        let _lock = PROVIDER_ENV_LOCK.lock().unwrap();
        let mut p = plane();
        init(&mut p);
        let mk = |id: &str, method: &str, params: Value| {
            json!({"jsonrpc":"2.0","id": id, "method": method, "params": params}).to_string()
        };
        let parse = |s: String| -> Value { serde_json::from_str(&s).unwrap() };
        let ws = parse(
            p.handle_json(&mk("w", "workspace/create", json!({"title": "domains"})))
                .unwrap()
                .unwrap(),
        );
        let ws_id = ws["result"]["id"].as_str().unwrap().to_string();
        for (pack, input) in [
            (
                "office.genoffice",
                json!({"title": "Brief", "body": "Hello office"}),
            ),
            ("developer.workspace", json!({"spec": "hello knorvia"})),
            ("data.notebook", json!({"rows": [{"n": 1}, {"n": 2}]})),
            (
                "media.studio",
                json!({"prompt": "sunset over water", "kind": "image"}),
            ),
            (
                "automations.cron",
                json!({"schedule": "0 9 * * *", "action": "digest"}),
            ),
        ] {
            let inv = parse(
                p.handle_json(&mk(
                    pack,
                    "capability/invoke",
                    json!({"packId": pack, "workspaceId": ws_id, "input": input}),
                ))
                .unwrap()
                .unwrap(),
            );
            assert_eq!(inv["result"]["status"], "succeeded", "{pack}");
            assert!(
                inv["result"]["artifactId"]
                    .as_str()
                    .unwrap()
                    .starts_with("art_"),
                "{pack}"
            );
            assert!(
                inv["result"]["jobId"].as_str().unwrap().starts_with("job_"),
                "{pack}"
            );
        }

        let src = std::env::temp_dir().join(format!(
            "knorvia-mig-src-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(src.join("sessions")).unwrap();
        std::fs::write(
            src.join("legacy.json"),
            serde_json::json!({
                "sessions": [{"id": "sess-a", "title": "Imported research"}],
                "artifacts": [{"id": "a1", "title": "note.md", "body": "# n\n", "session_id": "sess-a"}],
                "jobs": [{"id": "j1", "action": "digest", "session_id": "sess-a"}],
                "settings": {"language": "en"}
            })
            .to_string(),
        )
        .unwrap();
        let discovered = parse(
            p.handle_json(&mk(
                "md",
                "migration/discover",
                json!({"source": src.to_string_lossy()}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(!discovered["result"]["paths"].as_array().unwrap().is_empty());
        let run = parse(
            p.handle_json(&mk(
                "mr",
                "migration/run",
                json!({"source": src.to_string_lossy()}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(run["result"]["phase"], "activated");
        assert!(run["result"]["imported"].as_u64().unwrap() >= 3);
        let run_id = run["result"]["id"].as_str().unwrap().to_string();
        let rolled = parse(
            p.handle_json(&mk("mb", "migration/rollback", json!({"id": run_id})))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(rolled["result"]["phase"], "rolled_back");
        let _ = std::fs::remove_dir_all(src);
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    #[test]
    fn migration_preflight_rpc_inventories_blocked_and_unknown_categories() {
        let mut p = plane();
        init(&mut p);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let src = std::env::temp_dir().join(format!("knorvia-preflight-{stamp}"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("legacy.json"),
            serde_json::json!({
                "sessions": [{"id": "s1", "title": "S"}],
                "memory": [{"content": "likes tea"}],
                "automations": [{"id": "a1"}],
                "whatsit": [{"x": 1}, {"x": 2}]
            })
            .to_string(),
        )
        .unwrap();
        let mk = |id: &str, method: &str, params: Value| {
            json!({"jsonrpc":"2.0","id": id, "method": method, "params": params}).to_string()
        };
        let parse = |s: String| -> Value { serde_json::from_str(&s).unwrap() };
        let pre = parse(
            p.handle_json(&mk(
                "mp",
                "migration/preflight",
                json!({"source": src.to_string_lossy()}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(pre.get("error").is_none(), "{pre}");
        let inventory = pre["result"]["inventory"].as_array().unwrap();
        let entry = |name: &str| {
            inventory
                .iter()
                .find(|e| e["category"] == json!(name))
                .cloned()
                .unwrap_or_else(|| panic!("missing {name}: {inventory:?}"))
        };
        assert_eq!(entry("sessions")["mapping"], json!("imported"));
        assert_eq!(entry("memory")["mapping"], json!("imported"));
        assert_eq!(entry("automations")["mapping"], json!("blocked"));
        assert_eq!(entry("whatsit")["mapping"], json!("unknown"));
        assert_eq!(entry("whatsit")["count"], json!(2));
        let run = parse(
            p.handle_json(&mk(
                "mrp",
                "migration/run",
                json!({"source": src.to_string_lossy()}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            run["result"]["phase"],
            json!("verified"),
            "blocked run stays verified"
        );
        assert!(!run["result"]["blocked"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(src);
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    #[test]
    fn unknown_major_is_typed_error() {
        let mut p = plane();
        let req = json!({
            "jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"protocol":{"major":9,"minor":0},"client":{"name":"knorvia_cli","version":"0"}}
        });
        let resp: Value =
            serde_json::from_str(&p.handle_json(&req.to_string()).unwrap().unwrap()).unwrap();
        assert_eq!(resp["error"]["data"]["category"], "UNSUPPORTED_PROTOCOL");
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    /// Scripted executor: read-only outcomes from a stack; write turns emit
    /// one scripted approval bridge and, after the decision, finalize the
    /// product turn as completed (emulating the kernel runner contract).
    pub(super) struct Scripted {
        pub(super) outcomes: Vec<Result<TurnOutcome, ProtocolError>>,
    }

    impl TurnExecutor for Scripted {
        fn run_turn(&mut self, _req: &TurnRequest) -> Result<TurnOutcome, ProtocolError> {
            self.outcomes
                .pop()
                .expect("scripted executor exhausted; push one outcome per turn")
        }

        fn start_write_turn(
            &mut self,
            req: &TurnRequest,
            store: Arc<ProductStore>,
            _sink: Option<EventSink>,
        ) -> Result<turn_exec::WriteTurnStream, ProtocolError> {
            // Scripted bridge: create the product approval, expose the id on
            // the first-approval stream, and finalize the turn after the
            // decision (emulating the kernel runner contract).
            use sha2::{Digest, Sha256};
            let action = "kernel.commandExecution";
            let payload = json!({"command": "scripted probe", "cwd": "."});
            let mut h = Sha256::new();
            h.update(action.as_bytes());
            h.update(b"\0");
            h.update(payload.to_string().as_bytes());
            let digest = hex::encode(h.finalize());
            let appr = store
                .create_approval(&req.thread_id, &req.turn_id, action, &digest)
                .map_err(|e| e.into_protocol())?;
            let _ = store.append_item(
                &req.thread_id,
                &req.turn_id,
                "tool.write",
                "waiting_approval",
                json!({"approvalId": appr.id, "digest": digest, "action": action}),
            );
            let (decision_tx, decision_rx): (
                std::sync::mpsc::Sender<ka::TurnDecision>,
                std::sync::mpsc::Receiver<ka::TurnDecision>,
            ) = std::sync::mpsc::channel();
            let (first_tx, first_rx) = std::sync::mpsc::channel();
            let _ = first_tx.send(appr.id.clone());
            let turn_id = req.turn_id.clone();
            std::thread::spawn(move || {
                // The decision arrives via approval/respond; then the runner
                // owns the terminal state.
                let _ = decision_rx.recv();
                std::thread::sleep(std::time::Duration::from_millis(30));
                let _ = store.complete_turn(&turn_id, "completed");
                drop(decision_tx);
            });
            Ok(turn_exec::WriteTurnStream {
                first_approval: first_rx,
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
            _timeout: Duration,
        ) -> Result<(), ProtocolError> {
            Ok(())
        }

        fn set_sink(&mut self, _sink: Option<EventSink>) {}
    }

    fn scripted_item(kind: &str, payload: Value) -> TurnItem {
        TurnItem {
            kind: kind.into(),
            payload,
        }
    }

    fn plane_with_scripted(outcomes: Vec<Result<TurnOutcome, ProtocolError>>) -> ControlPlane {
        let base = std::env::temp_dir().join(format!(
            "knorvia-ctrl-exec-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        ControlPlane::open_with_executor(layout(base), Box::new(Scripted { outcomes })).unwrap()
    }

    #[test]
    fn readonly_turn_runs_on_kernel_executor_and_records_items() {
        let mut p = plane_with_scripted(vec![Ok(TurnOutcome {
            status: "completed".into(),
            items: vec![
                scripted_item("agentMessage", json!({"text": "read-only analysis done"})),
                scripted_item(
                    "commandExecution",
                    json!({"command": "git status", "status": "completed", "exitCode": 0}),
                ),
            ],
            error: None,
        })]);
        init(&mut p);
        let mk = |id: &str, method: &str, params: Value| {
            json!({"jsonrpc":"2.0","id": id, "method": method, "params": params}).to_string()
        };
        let parse = |s: String| -> Value { serde_json::from_str(&s).unwrap() };
        let ws = parse(
            p.handle_json(&mk("w", "workspace/create", json!({"title": "exec"})))
                .unwrap()
                .unwrap(),
        );
        let th = parse(
            p.handle_json(&mk(
                "t",
                "thread/start",
                json!({"workspaceId": ws["result"]["id"], "title": "kernel slice"}),
            ))
            .unwrap()
            .unwrap(),
        );
        let out = parse(
            p.handle_json(&mk(
                "tn",
                "turn/start",
                json!({
                    "threadId": th["result"]["id"],
                    "input": "analyze the workspace",
                    "tools": {"readOnly": true}
                }),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(out["result"]["turn"]["status"], "completed");
        let kinds: Vec<String> = out["result"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["kind"].as_str().unwrap().to_string())
            .collect();
        assert!(kinds.contains(&"userMessage".to_string()));
        assert!(kinds.contains(&"agentMessage".to_string()));
        assert!(kinds.contains(&"commandExecution".to_string()), "{kinds:?}");
        let agent = out["result"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["kind"] == "agentMessage")
            .unwrap();
        assert_eq!(agent["payload"]["text"], "read-only analysis done");
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    #[test]
    fn kernel_infrastructure_failure_yields_failed_turn_with_typed_error() {
        let mut p = plane_with_scripted(vec![Err(ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            "Kernel App Server binary unavailable: set KNORVIA_KERNEL_BIN",
        ))]);
        init(&mut p);
        let mk = |id: &str, method: &str, params: Value| {
            json!({"jsonrpc":"2.0","id": id, "method": method, "params": params}).to_string()
        };
        let parse = |s: String| -> Value { serde_json::from_str(&s).unwrap() };
        let ws = parse(
            p.handle_json(&mk("w", "workspace/create", json!({"title": "exec"})))
                .unwrap()
                .unwrap(),
        );
        let th = parse(
            p.handle_json(&mk(
                "t",
                "thread/start",
                json!({"workspaceId": ws["result"]["id"], "title": "kernel fail"}),
            ))
            .unwrap()
            .unwrap(),
        );
        let out = parse(
            p.handle_json(&mk(
                "tn",
                "turn/start",
                json!({
                    "threadId": th["result"]["id"],
                    "input": "hello",
                    "tools": {"readOnly": true}
                }),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(out["result"]["turn"]["status"], "failed");
        let kinds: Vec<String> = out["result"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["kind"].as_str().unwrap().to_string())
            .collect();
        assert!(kinds.contains(&"error".to_string()), "{kinds:?}");
        let err_item = out["result"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["kind"] == "error")
            .unwrap();
        assert_eq!(err_item["payload"]["category"], "CAPABILITY_UNAVAILABLE");
        // No fabricated ack agentMessage.
        assert!(!kinds.contains(&"agentMessage".to_string()));
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    struct ProviderEnvGuard {
        saved: Vec<(&'static str, Option<String>)>,
    }

    impl ProviderEnvGuard {
        fn set(vars: &[(&'static str, &str)]) -> Self {
            let saved = vars
                .iter()
                .map(|(k, _)| (*k, std::env::var(k).ok()))
                .collect();
            for (k, v) in vars {
                // SAFETY: tests serialize env mutations with PROVIDER_ENV_LOCK.
                unsafe { std::env::set_var(k, v) };
            }
            Self { saved }
        }
    }

    impl Drop for ProviderEnvGuard {
        fn drop(&mut self) {
            for (k, old) in &self.saved {
                // SAFETY: serialized by PROVIDER_ENV_LOCK.
                unsafe {
                    match old {
                        Some(v) => std::env::set_var(k, v),
                        None => std::env::remove_var(k),
                    }
                }
            }
        }
    }

    /// Minimal SSE/JSON mock provider for control-plane gateway tests.
    fn mock_gateway(body: &'static str) -> (String, std::thread::JoinHandle<()>) {
        use std::net::TcpListener;
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                serve_one(&mut stream, body);
            }
        });
        (format!("http://127.0.0.1:{port}/v1"), handle)
    }

    #[test]
    fn provider_execute_surfaces_typed_provider_failures() {
        use std::io::{Read as _, Write as _};
        let _lock = PROVIDER_ENV_LOCK.lock().unwrap();
        // Local HTTP fixture: HTTP 429 with a `Retry-After` seconds header
        // and a JSON error body. The RPC must surface category,
        // retryability and the normalized retry seconds — never the raw body.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if stream.read(&mut byte).unwrap_or(0) == 0 {
                    return;
                }
                head.push(byte[0]);
            }
            let head_str = String::from_utf8_lossy(&head).to_string();
            let mut length = 0usize;
            for line in head_str.lines() {
                let lower = line.to_ascii_lowercase();
                if let Some(rest) = lower.strip_prefix("content-length:") {
                    length = rest.trim().parse().unwrap_or(0);
                }
            }
            if length > 0 {
                let mut buf = vec![0u8; length];
                let _ = stream.read_exact(&mut buf);
            }
            let body = r#"{"error":{"message":"slow down and retry"}}"#;
            let response = format!(
                "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After: 21\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        });
        let guard = ProviderEnvGuard::set(&[
            ("KNORVIA_PROVIDER_MODEL", "llama-3"),
            (
                "KNORVIA_PROVIDER_BASE_URL",
                Box::leak(format!("http://127.0.0.1:{port}/v1").into_boxed_str()),
            ),
            ("KNORVIA_PROVIDER_API_KEY", "lk-test"),
        ]);
        let mut p = plane();
        init(&mut p);
        let req = json!({
            "model": "llama-3",
            "messages": [{"role": "user", "text": "hi"}],
            "stream": false,
            "maxTokens": 64
        });
        let resp: Value = serde_json::from_str(
            &p.handle_json(
                &json!({
                    "jsonrpc": "2.0",
                    "id": "pe1",
                    "method": "provider/execute",
                    "params": {"kind": "openai_compatible", "request": req}
                })
                .to_string(),
            )
            .unwrap()
            .unwrap(),
        )
        .unwrap();
        let error = &resp["error"];
        assert_eq!(error["data"]["category"], "PROVIDER_RATE_LIMIT", "{resp}");
        assert_eq!(error["data"]["retryable"], true);
        assert_eq!(error["data"]["retryAfter"], 21);
        assert_eq!(error["message"], "slow down and retry");
        drop(guard);
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    #[test]
    fn idempotency_key_recycled_for_a_different_request_is_a_typed_conflict() {
        let mut p = plane();
        init(&mut p);
        let mk = |id: &str, params: Value| {
            json!({"jsonrpc":"2.0","id": id, "method": "workspace/create", "params": params})
                .to_string()
        };
        let parse = |s: String| -> Value { serde_json::from_str(&s).unwrap() };
        let first = parse(
            p.handle_json(&mk(
                "w1",
                json!({"title": "One", "idempotencyKey": "recycled-1"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert!(first.get("error").is_none(), "{first}");
        let ws_a = first["result"]["id"].as_str().unwrap().to_string();

        // Genuine replay: same key, same payload -> the cached result.
        let replay = parse(
            p.handle_json(&mk(
                "w2",
                json!({"title": "One", "idempotencyKey": "recycled-1"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            replay["result"]["id"],
            json!(ws_a),
            "no duplicate workspace"
        );

        // Recycled key, different payload -> typed conflict, no execution.
        let conflict = parse(
            p.handle_json(&mk(
                "w3",
                json!({"title": "A different workspace", "idempotencyKey": "recycled-1"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            conflict["error"]["data"]["category"],
            json!("CONFLICT"),
            "{conflict}"
        );
        let count = parse(
            p.handle_json(
                &json!({"jsonrpc":"2.0","id":"w4","method":"workspace/list"}).to_string(),
            )
            .unwrap()
            .unwrap(),
        );
        let names: Vec<&str> = count["result"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|w| w["title"].as_str())
            .collect();
        assert!(
            !names.contains(&"A different workspace"),
            "conflicting replay must not execute: {names:?}"
        );
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    #[test]
    fn failed_idempotent_error_is_sanitized_before_rpc_and_persistence() {
        let mut p = plane();
        init(&mut p);
        let response = p
            .handle_json(
                &json!({
                    "jsonrpc": "2.0",
                    "id": "a15",
                    "method": "workspace/read",
                    "params": {"id": "sk-secret", "idempotencyKey": "a15-failed"}
                })
                .to_string(),
            )
            .unwrap()
            .unwrap();
        assert!(!response.contains("sk-secret"), "RPC leaked: {response}");
        assert!(response.contains("[redacted]"), "{response}");

        let records = p.store.paths().state.join("idempotency/records");
        let persisted = std::fs::read_dir(records)
            .unwrap()
            .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!persisted.contains("sk-secret"), "disk leaked: {persisted}");
        assert!(persisted.contains("[redacted]"), "{persisted}");
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    /// Scripted mock provider: each POST consumes the next queued SSE body.
    fn mock_gateway_scripted(
        bodies: Vec<String>,
    ) -> (
        String,
        std::thread::JoinHandle<()>,
        Arc<std::sync::atomic::AtomicUsize>,
    ) {
        use std::net::TcpListener;
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hits2 = Arc::clone(&hits);
        let handle = std::thread::spawn(move || {
            let queue = std::sync::Mutex::new(std::collections::VecDeque::from(bodies));
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let Some(body) = queue.lock().unwrap().pop_front() else {
                    break;
                };
                hits2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                serve_one(&mut stream, &body);
            }
        });
        (format!("http://127.0.0.1:{port}/v1"), handle, hits)
    }

    fn serve_one(stream: &mut std::net::TcpStream, body: &str) {
        use std::io::{Read, Write};
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).unwrap_or(0) == 0 {
                return;
            }
            head.push(byte[0]);
        }
        let head_str = String::from_utf8_lossy(&head).to_string();
        let mut length = 0usize;
        for line in head_str.lines() {
            let lower = line.to_ascii_lowercase();
            if let Some(rest) = lower.strip_prefix("content-length:") {
                length = rest.trim().parse().unwrap_or(0);
            }
        }
        if length > 0 {
            let mut buf = vec![0u8; length];
            let _ = stream.read_exact(&mut buf);
        }
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    }

    fn fn_call_sse(command: &str) -> String {
        let created = r#"{"type":"response.created","response":{"id":"r1"}}"#;
        // Responses wire: `arguments` is a JSON-encoded STRING.
        let args = serde_json::json!({"cmd": command}).to_string();
        let call = serde_json::json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "call_knorvia",
                "arguments": args
            }
        })
        .to_string();
        let completed = r#"{"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}"#;
        format!(
            "event: response.created\ndata: {created}\n\nevent: response.output_item.done\ndata: {call}\n\nevent: response.completed\ndata: {completed}\n\n"
        )
    }

    fn message_sse(text: &str) -> String {
        let created = r#"{"type":"response.created","response":{"id":"r2"}}"#;
        let msg = serde_json::json!({
            "type": "response.output_item.done",
            "item": {"type": "message", "role": "assistant", "content": [
                {"type": "output_text", "text": text}
            ]}
        })
        .to_string();
        let completed = r#"{"type":"response.completed","response":{"id":"r2","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}"#;
        format!(
            "event: response.created\ndata: {created}\n\nevent: response.output_item.done\ndata: {msg}\n\nevent: response.completed\ndata: {completed}\n\n"
        )
    }

    fn wait_turn_terminal(
        p: &mut ControlPlane,
        thread_id: &str,
        turn_id: &str,
        timeout: Duration,
    ) -> Value {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let resp = p
                .handle_json(
                    &json!({"jsonrpc":"2.0","id":"poll","method":"turn/read","params": {"id": turn_id}})
                        .to_string(),
                )
                .unwrap()
                .unwrap();
            let v: Value = serde_json::from_str(&resp).unwrap();
            if v["result"]["status"] != "running" {
                return v["result"].clone();
            }
            if std::time::Instant::now() >= deadline {
                panic!("turn {turn_id} on thread {thread_id} never reached a terminal state");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn pack_invoke_uses_live_gateway_model_with_labeled_mode() {
        let _lock = PROVIDER_ENV_LOCK.lock().unwrap();
        let sse_body: &'static str = Box::leak(
            concat!(
                "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\"}}\n\n",
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"1. What is the Fourier transform?\\n   Answer: a signal decomposed into sine/cosine basis.\"}]}}\n\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\"}}\n\n"
            )
            .to_string()
            .into_boxed_str(),
        );
        let (base_url, server) = mock_gateway(sse_body);
        let guard = ProviderEnvGuard::set(&[
            ("KNORVIA_PROVIDER_MODEL", "gpt-5.2"),
            ("KNORVIA_PROVIDER_BASE_URL", base_url.as_str()),
            ("KNORVIA_PROVIDER_API_KEY", "sk-knorvia-test"),
        ]);
        let mut p = plane();
        init(&mut p);
        let mk = |id: &str, method: &str, params: Value| {
            json!({"jsonrpc":"2.0","id": id, "method": method, "params": params}).to_string()
        };
        let parse = |s: String| -> Value { serde_json::from_str(&s).unwrap() };
        let ws = parse(
            p.handle_json(&mk("w", "workspace/create", json!({"title": "gateway"})))
                .unwrap()
                .unwrap(),
        );
        let inv = parse(
            p.handle_json(&mk(
                "inv",
                "capability/invoke",
                json!({
                    "packId": "learning.mastery",
                    "workspaceId": ws["result"]["id"],
                    "input": {"topic": "Fourier", "num_questions": 1}
                }),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(inv["result"]["status"], "succeeded");
        assert_eq!(inv["result"]["mode"], "model");
        let art = parse(
            p.handle_json(&mk(
                "art",
                "artifact/read",
                json!({"id": inv["result"]["artifactId"]}),
            ))
            .unwrap()
            .unwrap(),
        );
        let content = String::from_utf8(
            p.store
                .read_revision_content(art["result"]["currentRevision"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert!(content.starts_with("mode: model\n\n"), "{content}");
        assert!(content.contains("Fourier transform"), "{content}");
        drop(guard);
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    #[test]
    fn provider_execute_rpc_calls_gateway_and_typed_errors_without_base_url() {
        let _lock = PROVIDER_ENV_LOCK.lock().unwrap();
        // 1. Missing base URL → typed CapabilityUnavailable.
        let guard_clear = ProviderEnvGuard::set(&[("KNORVIA_PROVIDER_BASE_URL", "")]);
        let mut p = plane();
        init(&mut p);
        let mk = |id: &str, method: &str, params: Value| {
            json!({"jsonrpc":"2.0","id": id, "method": method, "params": params}).to_string()
        };
        let parse = |s: String| -> Value { serde_json::from_str(&s).unwrap() };
        let req = json!({
            "model": "gpt-5.2",
            "messages": [{"role": "user", "text": "hi"}],
            "maxTokens": 64
        });
        let err = parse(
            p.handle_json(&mk(
                "e1",
                "provider/execute",
                json!({"kind": "openai_responses", "request": req}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(err["error"]["data"]["category"], "CAPABILITY_UNAVAILABLE");
        drop(guard_clear);

        // 2. Live mock: compatible provider, non-stream JSON body.
        let json_body: &'static str = Box::leak(
            r#"{"choices":[{"message":{"role":"assistant","content":"gateway says hi"}}]}"#
                .to_string()
                .into_boxed_str(),
        );
        // Non-JSON content type would be parsed as JSON; use SSE with data to
        // reuse the mock: provider returns SSE delta stream.
        let sse_body: &'static str = Box::leak(
            "data: {\"choices\":[{\"delta\":{\"content\":\"gateway says hi\"}}]}\n\ndata: [DONE]\n\n"
                .to_string()
                .into_boxed_str(),
        );
        let _ = json_body;
        let (base_url, server) = mock_gateway(sse_body);
        let guard = ProviderEnvGuard::set(&[
            ("KNORVIA_PROVIDER_MODEL", "llama-3"),
            ("KNORVIA_PROVIDER_BASE_URL", base_url.as_str()),
            ("KNORVIA_PROVIDER_API_KEY", "lk-test"),
        ]);
        let req = json!({
            "model": "llama-3",
            "messages": [{"role": "user", "text": "hi"}],
            "stream": true,
            "maxTokens": 64
        });
        let ok = parse(
            p.handle_json(&mk(
                "e2",
                "provider/execute",
                json!({"kind": "openai_compatible", "request": req}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(ok["result"]["status"], 200);
        assert_eq!(ok["result"]["text"], "gateway says hi");
        assert!(ok["result"]["error"].is_null());
        drop(guard);
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    /// Durable Goal lifecycle over the real protocol: create, checkpoint,
    /// criteria-gated completion, terminal-state protection, revision guard
    /// and the task roll-up on goal/read.
    #[test]
    fn goal_lifecycle_checkpoints_and_completion_preconditions() {
        let mut p = plane();
        init(&mut p);
        let mk = |id: &str, method: &str, params: Value| {
            json!({"jsonrpc":"2.0","id": id, "method": method, "params": params}).to_string()
        };
        let parse = |s: String| -> Value { serde_json::from_str(&s).unwrap() };
        let ws = parse(
            p.handle_json(&mk("w", "workspace/create", json!({"title": "goal ws"})))
                .unwrap()
                .unwrap(),
        );
        let ws_id = ws["result"]["id"].as_str().unwrap().to_string();
        let goal = parse(
            p.handle_json(&mk(
                "g",
                "goal/create",
                json!({"workspaceId": ws_id, "title": "Ship workbench"}),
            ))
            .unwrap()
            .unwrap(),
        );
        let goal_id = goal["result"]["id"].as_str().unwrap().to_string();
        assert_eq!(goal["result"]["status"], "active");
        assert!(goal["result"]["successCriteria"].is_null());

        let list = parse(
            p.handle_json(&mk("gl", "goal/list", json!({"workspaceId": ws_id})))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(list["result"]["goals"].as_array().unwrap().len(), 1);
        parse(
            p.handle_json(&mk(
                "t1",
                "task/create",
                json!({"workspaceId": ws_id, "goalId": goal_id, "title": "first slice"}),
            ))
            .unwrap()
            .unwrap(),
        );

        // Completion without durable criteria is refused, loudly.
        let premature = parse(
            p.handle_json(&mk(
                "bad",
                "goal/update",
                json!({"id": goal_id, "status": "completed"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            premature["error"]["data"]["category"],
            json!(ErrorCategory::PreconditionFailed)
                .as_str()
                .unwrap_or("PRECONDITION_FAILED")
        );

        // A checkpoint updates the next action and the checkpoint stamp only.
        let checkpointed = parse(
            p.handle_json(&mk(
                "cp",
                "goal/update",
                json!({"id": goal_id, "checkpoint": true, "revision": 1,
                       "nextAction": "run the real-kernel fixture again"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(checkpointed["result"]["revision"], 2);
        assert_eq!(
            checkpointed["result"]["nextAction"],
            "run the real-kernel fixture again"
        );
        assert!(checkpointed["result"]["lastCheckpointAt"].is_string());

        // Stale revision guard.
        let stale = parse(
            p.handle_json(&mk(
                "stale",
                "goal/update",
                json!({"id": goal_id, "checkpoint": true, "revision": 1}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(stale["error"]["data"]["category"], "CONFLICT");

        // Criteria alone do not prove a completed execution.
        let done_criteria = parse(
            p.handle_json(&mk(
                "crit",
                "goal/update",
                json!({"id": goal_id, "successCriteria": "real-kernel fixture green; handoff written"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(done_criteria["result"]["revision"], 3);
        let refused = parse(
            p.handle_json(&mk(
                "still-premature",
                "goal/update",
                json!({"id":goal_id,"status":"completed"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(refused["error"]["data"]["category"], "PRECONDITION_FAILED");
        let task = p.store.list_tasks(&ws_id).unwrap().pop().unwrap();
        let thread = p
            .store
            .create_thread(&ws_id, "verified slice", Some(&goal_id), Some(&task.id))
            .unwrap();
        let turn = p.store.start_turn(&thread.id).unwrap();
        let item = p
            .store
            .append_item(
                &thread.id,
                &turn.id,
                "agentMessage",
                "completed",
                json!({"text":"acceptance evidence"}),
            )
            .unwrap();
        p.store.complete_turn(&turn.id, "completed").unwrap();
        let accepted = parse(p.handle_json(&mk("evidence", "goal/evidence/add", json!({
            "id":goal_id,"revision":3,"turnId":turn.id,"itemId":item.id,"summary":"all criteria checked"
        }))).unwrap().unwrap());
        assert_eq!(accepted["result"]["revision"], 4);
        let completed = parse(
            p.handle_json(&mk(
                "done",
                "goal/update",
                json!({"id": goal_id, "status": "completed"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(completed["result"]["status"], "completed");
        let reopen = parse(
            p.handle_json(&mk(
                "reopen",
                "goal/update",
                json!({"id": goal_id, "status": "active"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(reopen["error"]["data"]["category"], "PRECONDITION_FAILED");

        // goal/read carries the task roll-up so callers never guess progress.
        let read = parse(
            p.handle_json(&mk("gr", "goal/read", json!({"id": goal_id})))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(read["result"]["tasks"]["total"], 1);
        assert_eq!(read["result"]["tasks"]["closed"], 0);
        assert_eq!(read["result"]["execution"]["completed"], 1);
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    /// A projectless thread must execute in a durable per-task directory, not
    /// in the Kernel's private state directory. The allocation is persisted as
    /// the thread cwd so snapshots report it and restarts return to it, while
    /// explicit project paths stay untouched.
    #[test]
    fn projectless_thread_allocates_durable_task_directory() {
        let mut p = plane();
        init(&mut p);
        let mk = |id: &str, method: &str, params: Value| {
            json!({"jsonrpc":"2.0","id": id, "method": method, "params": params}).to_string()
        };
        let parse = |s: String| -> Value { serde_json::from_str(&s).unwrap() };
        let ws = parse(
            p.handle_json(&mk(
                "w",
                "workspace/create",
                json!({"title": "projectless"}),
            ))
            .unwrap()
            .unwrap(),
        );
        let th = parse(
            p.handle_json(&mk(
                "t",
                "thread/start",
                json!({"workspaceId": ws["result"]["id"], "title": "probe"}),
            ))
            .unwrap()
            .unwrap(),
        );
        let cwd = th["result"]["cwd"]
            .as_str()
            .expect("projectless cwd allocated")
            .to_string();
        let thread_id = th["result"]["id"].as_str().unwrap().to_string();
        assert!(
            std::path::Path::new(&cwd).is_dir(),
            "allocated cwd must exist: {cwd}"
        );
        assert!(
            cwd.replace('\\', "/")
                .ends_with(&format!("workspaces/{thread_id}")),
            "cwd must be the per-task workspace dir: {cwd}"
        );
        let read = parse(
            p.handle_json(&mk("r", "thread/read", json!({"id": thread_id})))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(read["result"]["cwd"].as_str(), Some(cwd.as_str()));

        // An explicit cwd is honored verbatim and never replaced.
        let explicit = p.store.paths().home.join("explicit-project");
        std::fs::create_dir_all(&explicit).unwrap();
        let th2 = parse(
            p.handle_json(&mk(
                "t2",
                "thread/start",
                json!({
                    "workspaceId": ws["result"]["id"],
                    "title": "explicit",
                    "cwd": explicit.to_string_lossy()
                }),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            th2["result"]["cwd"].as_str(),
            Some(explicit.to_string_lossy().as_ref())
        );
        let _ = std::fs::remove_dir_all(&p.store.paths().home);
    }

    /// P03 harness: a control plane over a known home so the test can reopen
    /// a second plane on the same durable state (daemon-restart semantics).
    fn reopenable_plane(prefix: &str) -> (ControlPlane, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let factory: PackRunnerFactory = Arc::new(Mutex::new(Box::new(|| {
            let choice = if knorvia_packs::gateway::GatewayModel::from_env().is_some() {
                knorvia_packs::ModelChoice::GatewayFromEnv
            } else {
                knorvia_packs::ModelChoice::None
            };
            Ok(Box::new(knorvia_packs::InProcessRunner::<'static>::new(
                choice,
            )))
        })));
        let executor = KernelTurnExecutor::new(layout(base.clone()));
        let plane =
            ControlPlane::open_full(layout(base.clone()), Box::new(executor), factory).unwrap();
        (plane, base)
    }

    #[test]
    fn artifact_bound_commit_replays_idempotently_and_rejects_stale_revision_after_restart() {
        let mk = |id: &str, method: &str, params: Value| {
            json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string()
        };
        let parse = |raw: String| -> Value { serde_json::from_str(&raw).unwrap() };
        let (mut p, home) = reopenable_plane("knorvia-artxn-replay");
        let init = |p: &mut ControlPlane| {
            let req = json!({
                "jsonrpc": "2.0",
                "id": "init",
                "method": "initialize",
                "params": {
                    "protocol": {"major": 1, "minor": 0},
                    "client": {"name": "knorvia_test", "version": "0.0.1", "platform": "windows"},
                    "capabilities": ["thread", "artifact"]
                }
            });
            let resp: Value =
                serde_json::from_str(&p.handle_json(&req.to_string()).unwrap().unwrap()).unwrap();
            assert!(resp.get("error").is_none(), "{resp}");
            p.handle_json(&json!({"jsonrpc":"2.0","method":"initialized"}).to_string())
                .unwrap();
        };
        init(&mut p);

        let ws = parse(
            p.handle_json(&mk("w", "workspace/create", json!({"title": "txn"})))
                .unwrap()
                .unwrap(),
        );
        let ws_id = ws["result"]["id"].as_str().unwrap().to_string();
        let art = parse(
            p.handle_json(&mk(
                "a",
                "artifact/create",
                json!({"workspaceId": ws_id, "title": "brief.md", "type": "text/markdown"}),
            ))
            .unwrap()
            .unwrap(),
        );
        let art_id = art["result"]["id"].as_str().unwrap().to_string();

        // Stage bound to the fresh base and commit bound to the staged
        // revision. Keys stay fixed so a transport retry replays, not repeats.
        let staged = parse(
            p.handle_json(&mk(
                "s1",
                "artifact/stage",
                json!({
                    "id": art_id,
                    "content": "# v1",
                    "expectedCurrentRevision": null,
                    "idempotencyKey": "stage-key-1"
                }),
            ))
            .unwrap()
            .unwrap(),
        );
        let staged_id = staged["result"]["id"].as_str().unwrap().to_string();
        let committed = parse(
            p.handle_json(&mk(
                "c1",
                "artifact/commit",
                json!({"id": art_id, "stagedRevisionId": staged_id, "idempotencyKey": "commit-key-1"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(committed["result"]["lifecycle"], "published");
        assert_eq!(
            committed["result"]["currentRevision"].as_str(),
            Some(staged_id.as_str())
        );

        // Response-lost retry with the same key replays the recorded outcome.
        let replay = parse(
            p.handle_json(&mk(
                "c2",
                "artifact/commit",
                json!({"id": art_id, "stagedRevisionId": staged_id, "idempotencyKey": "commit-key-1"}),
            ))
            .unwrap()
            .unwrap(),
        );
        assert_eq!(replay["result"], committed["result"]);

        // Daemon restart over the same home: the stale staged revision is a
        // typed conflict, the fresh base stages and commits cleanly.
        let mut restarted = {
            let factory: PackRunnerFactory = Arc::new(Mutex::new(Box::new(|| {
                let choice = if knorvia_packs::gateway::GatewayModel::from_env().is_some() {
                    knorvia_packs::ModelChoice::GatewayFromEnv
                } else {
                    knorvia_packs::ModelChoice::None
                };
                Ok(Box::new(knorvia_packs::InProcessRunner::<'static>::new(
                    choice,
                )))
            })));
            let executor = KernelTurnExecutor::new(layout(home.clone()));
            ControlPlane::open_full(layout(home.clone()), Box::new(executor), factory).unwrap()
        };
        init(&mut restarted);
        let stale = restarted
            .handle_json(&mk(
                "c3",
                "artifact/commit",
                json!({"id": art_id, "stagedRevisionId": "rev_does_not_exist"}),
            ))
            .unwrap()
            .unwrap();
        assert!(stale.contains("error"), "{stale}");
        assert!(
            stale.contains("CONFLICT") || stale.contains("conflict"),
            "{stale}"
        );

        let v2 = parse(
            restarted
                .handle_json(&mk(
                    "s2",
                    "artifact/stage",
                    json!({
                        "id": art_id,
                        "content": "# v2",
                        "expectedCurrentRevision": staged_id,
                        "idempotencyKey": "stage-key-2"
                    }),
                ))
                .unwrap()
                .unwrap(),
        );
        let v2_id = v2["result"]["id"].as_str().unwrap().to_string();
        let committed2 = parse(
            restarted
                .handle_json(&mk(
                    "c4",
                    "artifact/commit",
                    json!({"id": art_id, "stagedRevisionId": v2_id, "idempotencyKey": "commit-key-2"}),
                ))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(
            committed2["result"]["currentRevision"].as_str(),
            Some(v2_id.as_str())
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn artifact_catalog_rpc_paginates_globally_and_reports_skipped_metadata() {
        let mk = |id: &str, method: &str, params: Value| {
            json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string()
        };
        let parse = |raw: String| -> Value { serde_json::from_str(&raw).unwrap() };
        let mut p = plane();
        init(&mut p);
        // 3 workspaces x 40 artifacts: the first screen is one RPC, not one
        // per workspace.
        let mut ws_ids = Vec::new();
        for w in 0..3 {
            let ws = parse(
                p.handle_json(&mk(
                    "w",
                    "workspace/create",
                    json!({"title": format!("ws-{w}")}),
                ))
                .unwrap()
                .unwrap(),
            );
            ws_ids.push(ws["result"]["id"].as_str().unwrap().to_string());
        }
        for w in &ws_ids {
            for i in 0..40 {
                p.handle_json(&mk(
                    "a",
                    "artifact/create",
                    json!({
                        "workspaceId": w,
                        "title": format!("out {i:03}"),
                        "type": "text/markdown"
                    }),
                ))
                .unwrap()
                .unwrap();
            }
        }
        let page1 = parse(
            p.handle_json(&mk("c1", "artifact/catalog", json!({"limit": 50})))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(page1["result"]["artifacts"].as_array().unwrap().len(), 50);
        assert_eq!(page1["result"]["totalMatching"], 120);
        assert_eq!(page1["result"]["skippedUnreadable"], 0);
        let cursor = page1["result"]["nextCursor"].as_str().unwrap().to_string();

        let mut seen: Vec<String> = page1["result"]["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["id"].as_str().unwrap().to_string())
            .collect();
        let page2 = parse(
            p.handle_json(&mk(
                "c2",
                "artifact/catalog",
                json!({"limit": 50, "cursor": cursor}),
            ))
            .unwrap()
            .unwrap(),
        );
        for artifact in page2["result"]["artifacts"].as_array().unwrap() {
            let id = artifact["id"].as_str().unwrap().to_string();
            assert!(!seen.contains(&id), "cursor page repeated {id}");
            seen.push(id);
        }
        assert_eq!(seen.len(), 100);

        // Server-side filter narrows the same catalog.
        let filtered = parse(
            p.handle_json(&mk(
                "c3",
                "artifact/catalog",
                json!({"limit": 500, "workspaceId": ws_ids[0], "query": "out 00"}),
            ))
            .unwrap()
            .unwrap(),
        );
        let filtered_rows = filtered["result"]["artifacts"].as_array().unwrap();
        assert_eq!(
            filtered["result"]["totalMatching"], 10,
            "out 000..009 match"
        );
        assert!(
            filtered_rows
                .iter()
                .all(|a| a["workspaceId"] == ws_ids[0].as_str())
        );

        // Corrupt metadata is skipped and counted, not fatal.
        let bad_dir = p.store.paths().state.join("product/artifacts");
        std::fs::write(bad_dir.join("broken.json"), "{oops").unwrap();
        let resilient = parse(
            p.handle_json(&mk("c4", "artifact/catalog", json!({"limit": 500})))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(resilient["result"]["totalMatching"], 120);
        assert_eq!(resilient["result"]["skippedUnreadable"], 1);
    }
}
