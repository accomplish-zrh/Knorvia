//! Shared kernel connection and bounded, independent Turn lifecycles.

use super::*;
use knorvia_platform_paths::KnorviaPaths;
use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

mod runner;

pub const KERNEL_THREAD_MAP_FILE: &str = "kernel-threads.json";
pub const KERNEL_THREAD_SETTINGS_FILE: &str = "kernel-thread-settings.json";

struct ActiveTurn {
    turn_id: String,
    cancelled: AtomicBool,
    done: AtomicBool,
    kernel: Mutex<Option<(Arc<ka::KernelSession>, String, String)>>,
    cancelled_agents: Mutex<std::collections::HashSet<String>>,
}

impl ActiveTurn {
    fn request_cancelled(&self, payload: &Value) -> bool {
        self.cancelled.load(Ordering::SeqCst)
            || payload
                .get("threadId")
                .and_then(Value::as_str)
                .is_some_and(|thread| {
                    self.cancelled_agents
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .contains(thread)
                })
    }
}

struct ApprovalOwner {
    thread_id: String,
    turn_id: String,
    reply: Sender<ka::TurnDecision>,
}

struct UserInputOwner {
    thread_id: String,
    turn_id: String,
    reply: Sender<Value>,
}

struct Runtime {
    paths: KnorviaPaths,
    session: Mutex<Option<Arc<ka::KernelSession>>>,
    threads: Mutex<HashMap<String, String>>,
    active: Mutex<HashMap<String, Arc<ActiveTurn>>>,
    decisions: Mutex<HashMap<String, ApprovalOwner>>,
    user_inputs: Mutex<HashMap<String, UserInputOwner>>,
    sink: Mutex<Option<EventSink>>,
    /// Provider model id from the gateway environment, used as the usage
    /// attribution fallback when the thread selected no explicit model.
    provider_model: String,
    provider_id: String,
    /// Active protocol bridge (non-Responses upstream). Held so the loopback
    /// listener lives as long as the session that uses it.
    bridge: Mutex<Option<ka::PreparedProvider>>,
    // A slow runner can outlive executor shutdown's bounded grace period.
    // Its Runtime reference must keep the Home locked until its last write.
    _ownership: Option<Arc<fs::File>>,
}

impl Runtime {
    fn emit(&self, method: &str, params: Value) {
        let sink = self.sink.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(sink) = sink {
            sink(method, params);
        }
    }

    fn thread_map_path(&self) -> std::path::PathBuf {
        self.paths
            .state
            .join("product")
            .join(KERNEL_THREAD_MAP_FILE)
    }

    fn thread_settings_path(&self) -> std::path::PathBuf {
        self.paths
            .state
            .join("product")
            .join(KERNEL_THREAD_SETTINGS_FILE)
    }

    fn read_json_map<T: serde::de::DeserializeOwned>(
        &self,
        path: &std::path::Path,
    ) -> Result<HashMap<String, T>, ProtocolError> {
        if !path.exists() {
            return Ok(HashMap::new());
        }
        serde_json::from_slice(&fs::read(path).map_err(|e| internal(e.to_string()))?)
            .map_err(|e| internal(e.to_string()))
    }

    fn write_json_map<T: serde::Serialize>(
        &self,
        path: &std::path::Path,
        value: &HashMap<String, T>,
    ) -> Result<(), ProtocolError> {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| internal(e.to_string()))?
            .as_nanos();
        let tmp = path.with_extension(format!("{}.{nonce}.tmp", std::process::id()));
        {
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&tmp)
                .map_err(|e| internal(e.to_string()))?;
            file.write_all(&serde_json::to_vec_pretty(value).map_err(|e| internal(e.to_string()))?)
                .map_err(|e| internal(e.to_string()))?;
            file.sync_all().map_err(|e| internal(e.to_string()))?;
        }
        fs::rename(&tmp, path).map_err(|e| internal(e.to_string()))?;
        #[cfg(unix)]
        fs::File::open(path.parent().expect("product directory"))
            .and_then(|dir| dir.sync_all())
            .map_err(|e| internal(e.to_string()))?;
        Ok(())
    }

    fn thread_map(&self) -> Result<HashMap<String, String>, ProtocolError> {
        self.read_json_map(&self.thread_map_path())
    }

    fn settings_map(&self) -> Result<HashMap<String, KernelTurnSettings>, ProtocolError> {
        self.read_json_map(&self.thread_settings_path())
    }

    fn persisted_settings(&self, thread_id: &str) -> Result<KernelTurnSettings, ProtocolError> {
        Ok(self.settings_map()?.remove(thread_id).unwrap_or_default())
    }

    fn persist_settings(
        &self,
        thread_id: &str,
        settings: &KernelTurnSettings,
    ) -> Result<(), ProtocolError> {
        let path = self.thread_settings_path();
        let mut all = self.settings_map()?;
        if settings.is_empty() {
            all.remove(thread_id);
        } else {
            all.insert(thread_id.to_string(), settings.clone());
        }
        self.write_json_map(&path, &all)
    }

    fn effective_settings(
        &self,
        thread_id: &str,
        overrides: &KernelTurnSettings,
    ) -> Result<KernelTurnSettings, ProtocolError> {
        let current = self.persisted_settings(thread_id)?;
        // `TurnRequest` carries the fully effective settings for this one
        // execution, including an inherited workspace cwd. Persisting it here
        // would turn that inherited fallback into a permanent thread override
        // and make a later workspace/update ineffective. Control persists an
        // explicit selection through `configure_thread` before scheduling.
        Ok(current.merge(overrides))
    }

    fn adapter_settings(settings: &KernelTurnSettings) -> ka::KernelThreadSettings {
        ka::KernelThreadSettings {
            cwd: settings.cwd.clone(),
            model: settings.model.clone(),
            reasoning_effort: settings.reasoning_effort.clone(),
            service_tier: settings.service_tier.clone(),
            collaboration_mode: settings.collaboration_mode.clone(),
        }
    }

    fn saved_threads(
        &self,
        req: &TurnRequest,
        store: &ProductStore,
    ) -> Result<HashMap<String, String>, ProtocolError> {
        let saved = self.thread_map()?;
        if !saved.contains_key(&req.thread_id) {
            if store
                .has_items_outside_turn(&req.thread_id, &req.turn_id)
                .map_err(|e| e.into_protocol())?
            {
                return Err(ProtocolError::new(
                    ErrorCategory::Conflict,
                    "Thread has prior history but no Kernel mapping; restore its mapping or start an explicit new Thread",
                ));
            }
        }
        Ok(saved)
    }

    fn session(&self) -> Result<Arc<ka::KernelSession>, ProtocolError> {
        // Setup locks are never held by a running model call. The transport
        // itself multiplexes requests and per-thread event subscriptions.
        let mut slot = self.session.lock().map_err(|e| internal(e.to_string()))?;
        if !slot.as_ref().is_some_and(|session| session.is_alive()) {
            let provider = ka::provider_from_env().ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::NotInitialized,
                    "No provider is configured: set KNORVIA_PROVIDER_MODEL",
                )
            })?;
            let mut prepared =
                ka::prepare_provider(&provider).map_err(|e| internal(e.to_string()))?;
            ka::ensure_kernel_config_prepared(&self.paths, &prepared)
                .map_err(|e| internal(e.to_string()))?;
            let mut session_env: Vec<(&str, String)> = Vec::new();
            if let Some(token) = prepared.bridge_token.take() {
                session_env.push((ka::BRIDGE_TOKEN_ENV, token));
            }
            let bin = ka::resolve_kernel_bin().map_err(|e| internal(e.to_string()))?;
            let env_refs: Vec<(&str, &str)> = session_env
                .iter()
                .map(|(key, value)| (*key, value.as_str()))
                .collect();
            *slot = Some(Arc::new(
                ka::KernelSession::spawn_with_session_env(&self.paths, &bin, &env_refs)
                    .map_err(|e| internal(e.to_string()))?,
            ));
            let mut bridge_slot = self.bridge.lock().map_err(|e| internal(e.to_string()))?;
            *bridge_slot = Some(prepared);
            self.threads
                .lock()
                .map_err(|e| internal(e.to_string()))?
                .clear();
        }
        Ok(Arc::clone(slot.as_ref().expect("initialized above")))
    }

    fn connection(
        &self,
        req: &TurnRequest,
        store: &ProductStore,
    ) -> Result<(Arc<ka::KernelSession>, String, KernelTurnSettings), ProtocolError> {
        let thread = &req.thread_id;
        let settings = self.effective_settings(thread, &req.settings)?;
        let adapter_settings = Self::adapter_settings(&settings);
        let session = self.session()?;
        let mut live = self.threads.lock().map_err(|e| internal(e.to_string()))?;
        if let Some(id) = live.get(thread) {
            return Ok((session, id.clone(), settings));
        }
        let mut saved = self.saved_threads(req, store)?;
        // Losing a rollout is an error, never permission to silently create
        // an empty replacement conversation with the old product identity.
        let id = match saved.get(thread) {
            Some(previous) => session.resume_thread_with_settings(previous, &adapter_settings),
            None => session.create_thread_with_settings(&adapter_settings),
        }
        .map_err(|e| internal(e.to_string()))?;
        saved.insert(thread.clone(), id.clone());
        self.write_json_map(&self.thread_map_path(), &saved)?;
        live.insert(thread.clone(), id.clone());
        Ok((session, id, settings))
    }

    fn mapped_connection(
        &self,
        thread_id: &str,
        overrides: &KernelTurnSettings,
    ) -> Result<(Arc<ka::KernelSession>, String, KernelTurnSettings), ProtocolError> {
        let settings = self.effective_settings(thread_id, overrides)?;
        let session = self.session()?;
        let mut live = self.threads.lock().map_err(|e| internal(e.to_string()))?;
        if let Some(kernel_thread) = live.get(thread_id) {
            return Ok((session, kernel_thread.clone(), settings));
        }
        let kernel_thread = self.thread_map()?.get(thread_id).cloned().ok_or_else(|| {
            ProtocolError::new(
                ErrorCategory::CapabilityUnavailable,
                "thread has no Kernel history mapping",
            )
        })?;
        let resumed = session
            .resume_thread_with_settings(&kernel_thread, &Self::adapter_settings(&settings))
            .map_err(|e| internal(e.to_string()))?;
        live.insert(thread_id.to_string(), resumed.clone());
        Ok((session, resumed, settings))
    }
}

pub struct KernelTurnExecutor {
    runtime: Arc<Runtime>,
}

impl std::fmt::Debug for KernelTurnExecutor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KernelTurnExecutor")
            .field("home", &self.runtime.paths.home)
            .finish()
    }
}

impl KernelTurnExecutor {
    pub fn new(paths: KnorviaPaths) -> Self {
        Self {
            runtime: Arc::new(Runtime {
                provider_id: std::env::var("KNORVIA_PROVIDER_PROFILE_ID")
                    .ok()
                    .filter(|id| !id.trim().is_empty())
                    .unwrap_or_else(|| "knorvia".into()),
                provider_model: std::env::var(ka::PROVIDER_MODEL_ENV).unwrap_or_default(),
                bridge: Mutex::new(None),
                paths,
                session: Mutex::new(None),
                threads: Mutex::new(HashMap::new()),
                active: Mutex::new(HashMap::new()),
                decisions: Mutex::new(HashMap::new()),
                user_inputs: Mutex::new(HashMap::new()),
                sink: Mutex::new(None),
                _ownership: None,
            }),
        }
    }

    pub(crate) fn with_ownership(paths: KnorviaPaths, ownership: Arc<fs::File>) -> Self {
        let mut executor = Self::new(paths);
        Arc::get_mut(&mut executor.runtime)
            .expect("new executor is exclusively owned")
            ._ownership = Some(ownership);
        executor
    }

    fn schedule(
        &mut self,
        req: &TurnRequest,
        store: Arc<ProductStore>,
    ) -> Result<WriteTurnStream, ProtocolError> {
        let active = Arc::new(ActiveTurn {
            turn_id: req.turn_id.clone(),
            cancelled: AtomicBool::new(false),
            done: AtomicBool::new(false),
            kernel: Mutex::new(None),
            cancelled_agents: Mutex::new(std::collections::HashSet::new()),
        });
        {
            let mut registry = self
                .runtime
                .active
                .lock()
                .map_err(|e| internal(e.to_string()))?;
            if let Some(previous) = registry.get(&req.thread_id)
                && !previous.done.load(Ordering::SeqCst)
                && store
                    .read_turn(&previous.turn_id)
                    .map_err(|e| e.into_protocol())?
                    .status
                    == "running"
            {
                return Err(ProtocolError::new(
                    ErrorCategory::Conflict,
                    "thread already has an active turn",
                ));
            }
            if registry.len() >= 32 {
                return Err(ProtocolError::new(
                    ErrorCategory::ResourceExhausted,
                    "maximum concurrent turns reached",
                ));
            }
            registry.insert(req.thread_id.clone(), Arc::clone(&active));
        }
        let runtime = Arc::clone(&self.runtime);
        let request = req.clone();
        let (first_tx, first_rx) = channel();
        if let Err(error) = std::thread::Builder::new()
            .name(format!("turn-{}", req.turn_id))
            .spawn(move || runner::run(runtime, request, store, active, first_tx))
        {
            self.runtime
                .active
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&req.thread_id);
            return Err(internal(error.to_string()));
        }
        Ok(WriteTurnStream {
            first_approval: first_rx,
        })
    }
}

impl TurnExecutor for KernelTurnExecutor {
    fn configure_thread(
        &mut self,
        thread_id: &str,
        settings: &KernelTurnSettings,
    ) -> Result<(), ProtocolError> {
        let current = self.runtime.persisted_settings(thread_id)?;
        self.runtime
            .persist_settings(thread_id, &current.merge(settings))
    }

    fn thread_settings(
        &self,
        thread_id: &str,
    ) -> Result<Option<KernelTurnSettings>, ProtocolError> {
        let settings = self.runtime.persisted_settings(thread_id)?;
        Ok((!settings.is_empty()).then_some(settings))
    }

    fn allocate_projectless_cwd(
        &mut self,
        thread_id: &str,
    ) -> Result<Option<String>, ProtocolError> {
        if thread_id.is_empty()
            || !thread_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "thread id is not a safe directory name",
            ));
        }
        let dir = self.runtime.paths.task_workspaces().join(thread_id);
        fs::create_dir_all(&dir).map_err(|e| internal(e.to_string()))?;
        Ok(Some(dir.to_string_lossy().into_owned()))
    }

    fn has_kernel_thread(&self, thread_id: &str) -> Result<bool, ProtocolError> {
        Ok(self.runtime.thread_map()?.contains_key(thread_id))
    }

    fn fork_kernel_thread(
        &mut self,
        source_thread_id: &str,
        settings: &KernelTurnSettings,
    ) -> Result<String, ProtocolError> {
        let (session, source, _) = self
            .runtime
            .mapped_connection(source_thread_id, &KernelTurnSettings::default())?;
        session
            .fork_thread(&source, &Runtime::adapter_settings(settings))
            .map_err(|e| internal(e.to_string()))
    }

    fn bind_kernel_thread(
        &mut self,
        thread_id: &str,
        kernel_thread_id: &str,
        settings: &KernelTurnSettings,
    ) -> Result<(), ProtocolError> {
        let mut threads = self.runtime.thread_map()?;
        if threads.contains_key(thread_id) {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "product thread already has a Kernel mapping",
            ));
        }
        // Save settings before exposing the new mapping. A failed settings
        // write leaves no product route to the successfully forked rollout.
        self.runtime.persist_settings(thread_id, settings)?;
        threads.insert(thread_id.to_string(), kernel_thread_id.to_string());
        self.runtime
            .write_json_map(&self.runtime.thread_map_path(), &threads)?;
        self.runtime
            .threads
            .lock()
            .map_err(|e| internal(e.to_string()))?
            .insert(thread_id.to_string(), kernel_thread_id.to_string());
        Ok(())
    }

    fn discard_kernel_thread(&mut self, kernel_thread_id: &str) -> Result<(), ProtocolError> {
        self.runtime
            .session()?
            .archive_thread(kernel_thread_id)
            .map_err(|e| internal(e.to_string()))
    }

    fn steer_turn(
        &mut self,
        thread_id: &str,
        turn_id: &str,
        input: &str,
        client_message_id: Option<&str>,
    ) -> Result<(), ProtocolError> {
        let active = self
            .runtime
            .active
            .lock()
            .map_err(|e| internal(e.to_string()))?
            .get(thread_id)
            .cloned()
            .ok_or_else(|| {
                ProtocolError::new(ErrorCategory::Conflict, "thread has no active Kernel turn")
            })?;
        if active.turn_id != turn_id || active.done.load(Ordering::SeqCst) {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "turn is no longer active",
            ));
        }
        let (session, kernel_thread, kernel_turn) = active
            .kernel
            .lock()
            .map_err(|e| internal(e.to_string()))?
            .clone()
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::Conflict,
                    "Kernel turn has not started; retry after turn/start returns running",
                )
            })?;
        session
            .steer_turn(&kernel_thread, &kernel_turn, input, client_message_id)
            .map_err(|e| internal(e.to_string()))?;
        Ok(())
    }

    fn has_user_input_owner(&self, item_id: &str) -> bool {
        self.runtime
            .user_inputs
            .lock()
            .map(|pending| pending.contains_key(item_id))
            .unwrap_or(false)
    }

    fn respond_user_input(&mut self, item_id: &str, answers: Value) -> Result<bool, ProtocolError> {
        let reply = self
            .runtime
            .user_inputs
            .lock()
            .map_err(|e| internal(e.to_string()))?
            .get(item_id)
            .map(|owner| owner.reply.clone());
        match reply {
            Some(reply) => reply.send(answers).map(|_| true).map_err(|_| {
                ProtocolError::new(ErrorCategory::Conflict, "user-input owner has stopped")
            }),
            None => Ok(false),
        }
    }

    fn archive_kernel_thread(&mut self, thread_id: &str) -> Result<(), ProtocolError> {
        if self
            .runtime
            .active
            .lock()
            .map_err(|e| internal(e.to_string()))?
            .get(thread_id)
            .is_some_and(|active| !active.done.load(Ordering::SeqCst))
        {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "cannot archive a thread with an active Kernel turn",
            ));
        }
        if !self.has_kernel_thread(thread_id)? {
            return Ok(());
        }
        let (session, kernel_thread, _) = self
            .runtime
            .mapped_connection(thread_id, &KernelTurnSettings::default())?;
        session
            .archive_thread(&kernel_thread)
            .map_err(|e| internal(e.to_string()))?;
        self.runtime
            .threads
            .lock()
            .map_err(|e| internal(e.to_string()))?
            .remove(thread_id);
        Ok(())
    }

    fn unarchive_kernel_thread(&mut self, thread_id: &str) -> Result<(), ProtocolError> {
        let kernel_thread = match self.runtime.thread_map()?.get(thread_id) {
            Some(kernel_thread) => kernel_thread.clone(),
            None => return Ok(()),
        };
        let session = self.runtime.session()?;
        session
            .unarchive_thread(&kernel_thread)
            .map_err(|e| internal(e.to_string()))?;
        self.runtime
            .threads
            .lock()
            .map_err(|e| internal(e.to_string()))?
            .remove(thread_id);
        Ok(())
    }

    fn list_models(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        self.runtime
            .session()?
            .list_models(params.clone())
            .map_err(|e| internal(e.to_string()))
    }

    fn list_skills(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        self.runtime
            .session()?
            .list_skills(params.clone())
            .map_err(|e| internal(e.to_string()))
    }

    fn extension_kernel(&mut self, method: &str, params: &Value) -> Result<Value, ProtocolError> {
        self.runtime
            .session()?
            .plugin_request(method, params.clone())
            .map_err(|e| internal(e.to_string()))
    }

    fn interrupt_agent(
        &mut self,
        thread_id: &str,
        turn_id: &str,
        kernel_thread: &str,
    ) -> Result<Value, ProtocolError> {
        let active = self
            .runtime
            .active
            .lock()
            .map_err(|e| internal(e.to_string()))?
            .get(thread_id)
            .cloned()
            .filter(|active| {
                active.turn_id == turn_id
                    && !active.done.load(Ordering::SeqCst)
                    && !active.cancelled.load(Ordering::SeqCst)
            })
            .ok_or_else(|| {
                ProtocolError::new(ErrorCategory::Conflict, "Parent turn is not active")
            })?;
        let owner = active
            .kernel
            .lock()
            .map_err(|e| internal(e.to_string()))?
            .clone()
            .ok_or_else(|| {
                ProtocolError::new(ErrorCategory::Conflict, "Parent Kernel is not ready")
            })?;
        let response = owner
            .0
            .interrupt_agent(&owner.1, kernel_thread)
            .map_err(|_| {
                ProtocolError::new(
                    ErrorCategory::Conflict,
                    "Subagent is not an active descendant of this turn",
                )
            })?;
        let mut cancelled = active
            .cancelled_agents
            .lock()
            .map_err(|e| internal(e.to_string()))?;
        cancelled.insert(kernel_thread.into());
        if let Some(descendants) = response
            .get("cancelledKernelThreadIds")
            .and_then(Value::as_array)
        {
            cancelled.extend(
                descendants
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned),
            );
        }
        Ok(response)
    }

    fn has_approval_owner(&self, approval_id: &str) -> bool {
        self.runtime
            .decisions
            .lock()
            .map(|pending| pending.contains_key(approval_id))
            .unwrap_or(false)
    }
    fn start_turn(
        &mut self,
        req: &TurnRequest,
        store: Arc<ProductStore>,
    ) -> Result<(), ProtocolError> {
        self.schedule(req, store).map(|_| ())
    }

    fn run_turn(&mut self, req: &TurnRequest) -> Result<TurnOutcome, ProtocolError> {
        if !req.read_only {
            return Err(internal("write turn requires asynchronous scheduling"));
        }
        // This compatibility entry has no store argument. Production scheduling
        // passes the existing owner store through the asynchronous runner.
        let store =
            ProductStore::open(self.runtime.paths.clone()).map_err(|e| e.into_protocol())?;
        let (session, thread, settings) = self.runtime.connection(req, &store)?;
        let mut options = ka::TurnRunOptions::read_only();
        options.settings = Runtime::adapter_settings(&settings);
        let result = session
            .run_turn(&thread, &req.prompt, options)
            .map_err(|e| internal(e.to_string()))?;
        Ok(TurnOutcome {
            status: runner::status(&result.status).into(),
            error: result.error,
            items: result
                .items
                .into_iter()
                .map(|item| TurnItem {
                    kind: item.kind,
                    payload: item.payload,
                })
                .collect(),
        })
    }

    fn start_write_turn(
        &mut self,
        req: &TurnRequest,
        store: Arc<ProductStore>,
        sink: Option<EventSink>,
    ) -> Result<WriteTurnStream, ProtocolError> {
        if sink.is_some() {
            self.set_sink(sink);
        }
        self.schedule(req, store)
    }

    fn respond_approval(
        &mut self,
        approval_id: &str,
        decision: ka::TurnDecision,
    ) -> Result<bool, ProtocolError> {
        let pending = self
            .runtime
            .decisions
            .lock()
            .map_err(|e| internal(e.to_string()))?
            .remove(approval_id);
        match pending {
            Some(owner) => owner.reply.send(decision).map(|_| true).map_err(|_| {
                ProtocolError::new(ErrorCategory::Conflict, "approval owner has stopped")
            }),
            None => Ok(false),
        }
    }

    fn decline_pending(&mut self, thread_id: &str) -> Result<usize, ProtocolError> {
        let mut pending = self
            .runtime
            .decisions
            .lock()
            .map_err(|e| internal(e.to_string()))?;
        let ids: Vec<_> = pending
            .iter()
            .filter(|(_, owner)| owner.thread_id == thread_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            if let Some(owner) = pending.remove(id) {
                let _ = owner.reply.send(ka::TurnDecision::Decline);
            }
        }
        let mut user_inputs = self
            .runtime
            .user_inputs
            .lock()
            .map_err(|e| internal(e.to_string()))?;
        let input_ids: Vec<_> = user_inputs
            .iter()
            .filter(|(_, owner)| owner.thread_id == thread_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &input_ids {
            if let Some(owner) = user_inputs.remove(id) {
                let _ = owner.reply.send(json!({"answers": {}}));
            }
        }
        Ok(ids.len() + input_ids.len())
    }

    fn interrupt(&mut self, thread_id: &str) -> Result<bool, ProtocolError> {
        let turn_id = self
            .runtime
            .active
            .lock()
            .map_err(|e| internal(e.to_string()))?
            .get(thread_id)
            .map(|turn| turn.turn_id.clone());
        match turn_id {
            Some(turn_id) => self.interrupt_turn(thread_id, &turn_id),
            None => Ok(false),
        }
    }

    fn decline_turn_pending(
        &mut self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<usize, ProtocolError> {
        let mut pending = self
            .runtime
            .decisions
            .lock()
            .map_err(|e| internal(e.to_string()))?;
        let ids: Vec<_> = pending
            .iter()
            .filter(|(_, owner)| owner.thread_id == thread_id && owner.turn_id == turn_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            if let Some(owner) = pending.remove(id) {
                let _ = owner.reply.send(ka::TurnDecision::Decline);
            }
        }
        let mut user_inputs = self
            .runtime
            .user_inputs
            .lock()
            .map_err(|e| internal(e.to_string()))?;
        let input_ids: Vec<_> = user_inputs
            .iter()
            .filter(|(_, owner)| owner.thread_id == thread_id && owner.turn_id == turn_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &input_ids {
            if let Some(owner) = user_inputs.remove(id) {
                let _ = owner.reply.send(json!({"answers": {}}));
            }
        }
        Ok(ids.len() + input_ids.len())
    }

    fn interrupt_turn(&mut self, thread_id: &str, turn_id: &str) -> Result<bool, ProtocolError> {
        let active = self
            .runtime
            .active
            .lock()
            .map_err(|e| internal(e.to_string()))?
            .get(thread_id)
            .cloned();
        let Some(active) = active else {
            return Ok(false);
        };
        if active.turn_id != turn_id || active.done.load(Ordering::SeqCst) {
            return Ok(false);
        }
        // Latch even before startup or the Kernel turn ID exists. The runner
        // observes this flag before execution and again in on_turn_started.
        active.cancelled.store(true, Ordering::SeqCst);
        let kernel = active
            .kernel
            .lock()
            .map_err(|e| internal(e.to_string()))?
            .clone();
        if let Some((session, thread, turn)) = kernel {
            session
                .send_turn_interrupt(&thread, &turn)
                .map_err(|e| internal(e.to_string()))?;
        }
        Ok(true)
    }

    fn await_turn_done(&mut self, thread_id: &str, timeout: Duration) -> Result<(), ProtocolError> {
        let deadline = Instant::now() + timeout;
        loop {
            let active = self
                .runtime
                .active
                .lock()
                .map_err(|e| internal(e.to_string()))?
                .get(thread_id)
                .cloned();
            if active.is_none_or(|turn| turn.done.load(Ordering::SeqCst)) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(ProtocolError::new(
                    ErrorCategory::DeadlineExceeded,
                    "turn is still running",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn set_sink(&mut self, sink: Option<EventSink>) {
        *self.runtime.sink.lock().unwrap_or_else(|e| e.into_inner()) = sink;
    }
}

impl Drop for KernelTurnExecutor {
    fn drop(&mut self) {
        for turn in self
            .runtime
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            turn.cancelled.store(true, Ordering::SeqCst);
        }
        if let Some(session) = self
            .runtime
            .session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            session.terminate();
        }
        // Give runners time to persist their final records. If one remains
        // blocked after this grace, its Runtime Arc retains the OS Home lock;
        // another owner still cannot recover or mutate its live state.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self
            .runtime
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
