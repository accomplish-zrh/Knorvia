//! Deferred legacy PackOutcome replies, sharing the one store and executor.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

const MAX_PACK_REQUESTS: usize = 16;

pub(super) struct PackPermit(Arc<AtomicUsize>);
impl Drop for PackPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(super) struct LivePackGuard {
    registry: Arc<Mutex<HashMap<String, LivePackHandle>>>,
    id: String,
    done: Arc<(Mutex<bool>, std::sync::Condvar)>,
}
impl Drop for LivePackGuard {
    fn drop(&mut self) {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
        let (lock, ready) = &*self.done;
        *lock.lock().unwrap_or_else(|e| e.into_inner()) = true;
        ready.notify_all();
    }
}

impl ControlPlane {
    pub(super) fn pack_permit(&self) -> Result<PackPermit, ProtocolError> {
        self.ensure_accepting_work()?;
        self.pack_requests
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_PACK_REQUESTS).then_some(n + 1)
            })
            .map_err(|_| {
                ProtocolError::new(
                    ErrorCategory::ResourceExhausted,
                    "pack execution queue is full",
                )
            })?;
        Ok(PackPermit(Arc::clone(&self.pack_requests)))
    }

    pub fn has_active_pack_requests(&self) -> bool {
        self.pack_requests.load(Ordering::Acquire) != 0
            || !self
                .live_packs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
    }

    pub(super) fn wait_pack_replies(&self) {
        // EOF cannot introduce another request. Existing legacy callers still
        // receive their original terminal reply before their transport exits.
        while self.has_active_pack_requests() {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    pub(super) fn register_pack(
        &self,
        admitted: &knorvia_packs::AdmittedInvocation,
        cancel: knorvia_packs::InvocationCancel,
    ) -> Result<LivePackGuard, ProtocolError> {
        let done = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let mut registry = self.live_packs.lock().unwrap_or_else(|e| e.into_inner());
        if registry.contains_key(&admitted.invocation_id) {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "invocation already has a live worker",
            ));
        }
        registry.insert(
            admitted.invocation_id.clone(),
            LivePackHandle {
                cancel,
                job_id: admitted.job_id.clone(),
                pack_id: admitted.pack_id.clone(),
                done: Arc::clone(&done),
            },
        );
        Ok(LivePackGuard {
            registry: Arc::clone(&self.live_packs),
            id: admitted.invocation_id.clone(),
            done,
        })
    }

    fn pack_dispatch_copy(&self, session: &Handshake) -> Self {
        Self {
            handshake: session.clone(),
            store: Arc::clone(&self.store),
            packs: Arc::clone(&self.packs),
            executor: Arc::clone(&self.executor),
            admissions_paused: Arc::clone(&self.admissions_paused),
            state_writer_barrier: Arc::clone(&self.state_writer_barrier),
            room_dispatches: Arc::clone(&self.room_dispatches),
            pack_runner_factory: Arc::clone(&self.pack_runner_factory),
            live_packs: Arc::clone(&self.live_packs),
            pack_requests: Arc::clone(&self.pack_requests),
            project_search: Default::default(),
            queue_driver: Default::default(),
            _ownership: self._ownership.clone(),
        }
    }

    /// Only the two legacy pack methods defer their final response. All other
    /// methods continue on the existing control reader. No new executor opens.
    pub fn defer_pack_request(
        &self,
        session: &Handshake,
        body: &str,
        reply: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<bool, ProtocolError> {
        let Ok(request) = serde_json::from_str::<RpcRequest>(body) else {
            return Ok(false);
        };
        if !session.is_ready()
            || !matches!(
                request.method.as_str(),
                "capability/invoke" | "capability/resume"
            )
            || request.jsonrpc != JSONRPC_VERSION
            || serde_json::to_vec(&request.id).map_err(json_err)?.len() > 128
        {
            return Ok(false);
        }
        let permit = match self.pack_permit() {
            Ok(permit) => permit,
            Err(error) => {
                reply(
                    serde_json::to_string(&RpcFailure::from_protocol(request.id, error))
                        .map_err(json_err)?,
                );
                return Ok(true);
            }
        };
        let mut worker = self.pack_dispatch_copy(session);
        let body = body.to_owned();
        let response_id = request.id.clone();
        let deliver = Arc::clone(&reply);
        let spawned = std::thread::Builder::new()
            .name("pack-legacy-reply".into())
            .spawn(move || {
                let _permit = permit;
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    worker.handle_json(&body)
                }));
                let response = match result {
                    Ok(Ok(Some(response))) => response,
                    Ok(Err(error)) => {
                        serde_json::to_string(&RpcFailure::from_protocol(response_id, error))
                            .expect("rpc")
                    }
                    _ => serde_json::to_string(&RpcFailure::from_category(
                        response_id,
                        ErrorCategory::Internal,
                        "pack execution interrupted; inspect its durable receipt",
                    ))
                    .expect("rpc"),
                };
                deliver(response);
            });
        if let Err(error) = spawned {
            reply(
                serde_json::to_string(&RpcFailure::from_category(
                    request.id,
                    ErrorCategory::Internal,
                    format!("pack thread could not start: {error}"),
                ))
                .map_err(json_err)?,
            );
        }
        Ok(true)
    }
}
