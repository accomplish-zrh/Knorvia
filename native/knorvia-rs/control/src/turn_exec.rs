//! Knorvia Turn execution contract. Production uses a multiplexed Kernel
//! transport and independently supervised, per-Turn background runners.

use knorvia_kernel_adapter as ka;
use knorvia_protocol::{ErrorCategory, ProtocolError};
use knorvia_store::ProductStore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

mod runtime;
pub use runtime::{KERNEL_THREAD_MAP_FILE, KernelTurnExecutor};

/// Notification emitter for streamed turn events. `None` skips streaming;
/// persistence is not affected.
pub type EventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// How long the control plane waits for a Kernel turn to finish before
/// reporting a typed deadline error instead of blocking forever.
pub const TURN_WAIT_TIMEOUT: Duration = Duration::from_secs(90);

/// Thread-scoped Kernel settings selected by the product.  These are kept
/// outside the product `Thread` projection because the Kernel owns the
/// executable session configuration, while Knorvia owns the durable product
/// identity.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelTurnSettings {
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    /// An explicit reset remains distinguishable from an omitted preference
    /// while settings pass through multiple merge and persistence layers.
    #[serde(default)]
    pub reset_reasoning_effort: bool,
    pub service_tier: Option<String>,
    #[serde(default)]
    pub collaboration_mode: Option<String>,
}

impl KernelTurnSettings {
    pub fn is_empty(&self) -> bool {
        self.cwd.is_none()
            && self.model.is_none()
            && self.reasoning_effort.is_none()
            && !self.reset_reasoning_effort
            && self.service_tier.is_none()
            && self.collaboration_mode.is_none()
    }

    /// Apply fields explicitly supplied by the caller, retaining persisted
    /// values for fields that were not supplied.
    pub fn merge(&self, overrides: &Self) -> Self {
        let model_changed = overrides.model.is_some() && overrides.model != self.model;
        let reset_effort = overrides.reset_reasoning_effort
            || (overrides.reasoning_effort.is_none()
                && (model_changed || self.reset_reasoning_effort));
        Self {
            cwd: overrides.cwd.clone().or_else(|| self.cwd.clone()),
            model: overrides.model.clone().or_else(|| self.model.clone()),
            reasoning_effort: if reset_effort {
                None
            } else {
                overrides
                    .reasoning_effort
                    .clone()
                    .or_else(|| self.reasoning_effort.clone())
            },
            reset_reasoning_effort: reset_effort,
            service_tier: overrides
                .service_tier
                .clone()
                .or_else(|| self.service_tier.clone()),
            collaboration_mode: overrides
                .collaboration_mode
                .clone()
                .or_else(|| self.collaboration_mode.clone())
                // The pinned Kernel's turn effort field cannot clear a saved
                // value with null. Its collaboration settings can; retain an
                // existing plan mode, otherwise explicitly use default mode.
                .or_else(|| reset_effort.then(|| "default".to_string())),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnRequest {
    /// Product thread id owning the turn.
    pub thread_id: String,
    /// Product turn id (control-plane owned) for persistence.
    pub turn_id: String,
    pub prompt: String,
    pub read_only: bool,
    /// Explicit per-thread settings, merged with the persisted selection by
    /// the production executor before this turn reaches the Kernel.
    #[serde(default)]
    pub settings: KernelTurnSettings,
    /// Explicit continuous-advance policy for Goal execution batches. Absent
    /// (the default) means the batch stops after this turn.
    #[serde(default)]
    pub advance: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnItem {
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnOutcome {
    /// `completed` | `failed` | `cancelled`
    pub status: String,
    pub items: Vec<TurnItem>,
    pub error: Option<Value>,
}

/// What the control plane uses to learn about the first bridged approval.
pub struct WriteTurnStream {
    /// Product approval id of the first bridged approval (one-shot). The
    /// drainer creates the product approval record itself.
    pub first_approval: Receiver<String>,
}

/// Execution seam: production schedules background work; test executors may
/// complete synchronously. Only the executor finalizes its accepted turns.
pub trait TurnExecutor: Send {
    /// Persist product-selected session settings.  The default keeps test
    /// executors lightweight; production implementations must retain them.
    fn configure_thread(
        &mut self,
        _thread_id: &str,
        _settings: &KernelTurnSettings,
    ) -> Result<(), ProtocolError> {
        Ok(())
    }

    /// Return the persisted product-selected Kernel settings for a thread.
    fn thread_settings(
        &self,
        _thread_id: &str,
    ) -> Result<Option<KernelTurnSettings>, ProtocolError> {
        Ok(None)
    }

    /// Allocate the durable working directory for a thread that has no
    /// explicit cwd and whose workspace has none either. Returns `None` when
    /// the executor does not own filesystem placement (test executors). The
    /// production executor creates `<Home>/workspaces/<threadId>` so a
    /// projectless task never falls back to the Kernel's private state
    /// directory, and the allocation survives restarts via thread settings.
    fn allocate_projectless_cwd(
        &mut self,
        _thread_id: &str,
    ) -> Result<Option<String>, ProtocolError> {
        Ok(None)
    }

    /// Whether this product thread has a durable Kernel-thread mapping.
    fn has_kernel_thread(&self, _thread_id: &str) -> Result<bool, ProtocolError> {
        Ok(false)
    }

    /// Fork real Kernel history.  A product-only fork is deliberately not a
    /// fallback because it would appear to preserve context while losing it.
    fn fork_kernel_thread(
        &mut self,
        _source_thread_id: &str,
        _settings: &KernelTurnSettings,
    ) -> Result<String, ProtocolError> {
        Err(ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            "kernel history fork is unavailable",
        ))
    }

    /// Bind a newly-created product thread to a Kernel thread after both
    /// durable operations have succeeded.
    fn bind_kernel_thread(
        &mut self,
        _thread_id: &str,
        _kernel_thread_id: &str,
        _settings: &KernelTurnSettings,
    ) -> Result<(), ProtocolError> {
        Err(ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            "kernel thread binding is unavailable",
        ))
    }

    /// Archive an upstream child that could not be bound to a Product thread.
    /// Cleanup errors never replace the original fork failure, but production
    /// implementations must attempt this so a stale product revision cannot
    /// leak a continuable Kernel rollout.
    fn discard_kernel_thread(&mut self, _kernel_thread_id: &str) -> Result<(), ProtocolError> {
        Ok(())
    }

    /// Forward a same-turn user steer to the active Kernel turn.
    fn steer_turn(
        &mut self,
        _thread_id: &str,
        _turn_id: &str,
        _input: &str,
        _client_message_id: Option<&str>,
    ) -> Result<(), ProtocolError> {
        Err(ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            "turn/steer kernel delivery is unavailable",
        ))
    }

    /// Whether a live Kernel runner owns a user-input request item.
    fn has_user_input_owner(&self, _item_id: &str) -> bool {
        false
    }

    /// Forward one durable user-input answer to its awaiting Kernel request.
    fn respond_user_input(
        &mut self,
        _item_id: &str,
        _answers: Value,
    ) -> Result<bool, ProtocolError> {
        Ok(false)
    }

    /// Archive the actual Kernel rollout for a mapped product thread.
    fn archive_kernel_thread(&mut self, _thread_id: &str) -> Result<(), ProtocolError> {
        Ok(())
    }

    /// Restore the actual Kernel rollout for a mapped product thread.
    fn unarchive_kernel_thread(&mut self, _thread_id: &str) -> Result<(), ProtocolError> {
        Ok(())
    }

    /// Read the upstream Kernel model catalog without synthesizing entries.
    fn list_models(&mut self, _params: &Value) -> Result<Value, ProtocolError> {
        Err(ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            "Kernel model catalog is unavailable",
        ))
    }

    /// Discover skills through the Kernel's native endpoint.
    fn list_skills(&mut self, _params: &Value) -> Result<Value, ProtocolError> {
        Err(ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            "Kernel skill discovery is unavailable",
        ))
    }

    fn extension_kernel(&mut self, _method: &str, _params: &Value) -> Result<Value, ProtocolError> {
        Err(ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            "Kernel plugin management is unavailable",
        ))
    }

    fn interrupt_agent(
        &mut self,
        _thread_id: &str,
        _turn_id: &str,
        _kernel_thread: &str,
    ) -> Result<Value, ProtocolError> {
        Err(ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            "Subagent interruption is unavailable",
        ))
    }

    fn has_approval_owner(&self, _approval_id: &str) -> bool {
        false
    }

    fn interrupt_turn(&mut self, thread_id: &str, _turn_id: &str) -> Result<bool, ProtocolError> {
        self.interrupt(thread_id)
    }

    fn decline_turn_pending(
        &mut self,
        thread_id: &str,
        _turn_id: &str,
    ) -> Result<usize, ProtocolError> {
        self.decline_pending(thread_id)
    }

    fn start_turn(
        &mut self,
        req: &TurnRequest,
        store: Arc<ProductStore>,
    ) -> Result<(), ProtocolError> {
        if !req.read_only {
            self.start_write_turn(req, store, None)?;
            return Ok(());
        }
        // Same advancing loop contract as the production runner: an explicit
        // advance policy keeps the batch running across full, durable turns.
        let mut req = req.clone();
        loop {
            let outcome = self.run_turn(&req).unwrap_or_else(|error| TurnOutcome {
                status: "failed".into(),
                items: vec![],
                error: Some(json!({"category": error.category, "message": error.message})),
            });
            for item in outcome.items {
                store
                    .append_item(
                        &req.thread_id,
                        &req.turn_id,
                        &item.kind,
                        "completed",
                        item.payload,
                    )
                    .map_err(|e| e.into_protocol())?;
            }
            if let Some(error) = outcome.error {
                store
                    .append_item(&req.thread_id, &req.turn_id, "error", "failed", error)
                    .map_err(|e| e.into_protocol())?;
            }
            store
                .complete_turn(&req.turn_id, &outcome.status)
                .map_err(|e| e.into_protocol())?;
            // Reflect the terminal in any Goal execution batch (R02); read-time
            // reconciliation covers a failed close.
            let _ = store.close_goal_round(&req.turn_id, &outcome.status);
            let Some(next_req) = advance_decision(store.as_ref(), &req, &outcome.status, false)
            else {
                return Ok(());
            };
            store
                .append_item(
                    &next_req.thread_id,
                    &next_req.turn_id,
                    "userMessage",
                    "completed",
                    json!({"text": next_req.prompt}),
                )
                .map_err(|e| e.into_protocol())?;
            req = next_req;
        }
    }

    /// Execute one read-only turn on the real Agent Kernel.
    fn run_turn(&mut self, req: &TurnRequest) -> Result<TurnOutcome, ProtocolError>;

    /// Whether this executor currently owns a live runner executing
    /// `turn_id` on `thread_id`. Goal execution reconciliation uses this to
    /// avoid declaring an advancing batch interrupted while its runner is
    /// between rounds. The default (false) fits synchronous test executors.
    fn has_live_turn(&self, _thread_id: &str, _turn_id: &str) -> bool {
        false
    }

    /// Start a write turn. Every Kernel approval is bridged to a product
    /// approval record by the executor's drainer; the caller learns the first
    /// approval id through the stream and later decisions via
    /// [`TurnExecutor::respond_approval`]. The runner persists items and
    /// finalizes the product turn autonomously.
    fn start_write_turn(
        &mut self,
        req: &TurnRequest,
        store: Arc<ProductStore>,
        sink: Option<EventSink>,
    ) -> Result<WriteTurnStream, ProtocolError>;

    /// Forward an approval decision to a bridged Kernel approval. Returns
    /// false when no bridged approval matches the id.
    fn respond_approval(
        &mut self,
        approval_id: &str,
        decision: ka::TurnDecision,
    ) -> Result<bool, ProtocolError>;

    /// Decline every bridged approval pending for the product thread (used
    /// when cancelling: the Kernel defers interruption while approvals are
    /// pending). Returns how many were declined.
    fn decline_pending(&mut self, thread_id: &str) -> Result<usize, ProtocolError>;

    /// Cooperative interrupt of a running Kernel turn for the product thread.
    /// Returns false when no kernel turn is active (caller falls back to the
    /// product-only path).
    fn interrupt(&mut self, thread_id: &str) -> Result<bool, ProtocolError>;

    /// Wait until the thread's active Kernel turn reaches a terminal state.
    fn await_turn_done(&mut self, thread_id: &str, timeout: Duration) -> Result<(), ProtocolError>;

    /// Attach the notification sink for streamed turn events.
    fn set_sink(&mut self, sink: Option<EventSink>);
}

fn internal(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(ErrorCategory::Internal, message.into())
}

/// Shared advancing-batch decision used by the production runner and the
/// executor contract path. Strictly opt-in via `req.advance`; every stop
/// reason is a durable batch fact and never implies the Goal completed.
pub(crate) fn advance_decision(
    store: &ProductStore,
    req: &TurnRequest,
    terminal: &str,
    cancelled: bool,
) -> Option<TurnRequest> {
    let policy = req.advance.as_ref()?;
    if cancelled {
        return stop_batch(store, &req.turn_id, "cancelled", "cancelled");
    }
    if terminal != "completed" {
        return stop_batch(store, &req.turn_id, terminal, terminal);
    }
    // An undelivered user input in the finished round stops the batch for
    // the user instead of fabricating an answer and continuing.
    let undelivered = store
        .list_turn_items(&req.thread_id, &req.turn_id)
        .unwrap_or_default()
        .into_iter()
        .any(|item| {
            item.kind == "userInput"
                && item.payload.get("delivered").and_then(Value::as_bool) == Some(false)
        });
    if undelivered {
        return stop_batch(store, &req.turn_id, "waitingUser", "waitingUser");
    }
    let execution = match store
        .find_goal_execution_by_turn(&req.turn_id)
        .ok()
        .flatten()
    {
        Some(execution) if execution.terminal_at.is_none() => execution,
        // Already stopped externally (deadline raced, user stop) or not a
        // tracked batch: either way the executor must not continue.
        _ => return None,
    };
    if let Some(max_rounds) = policy.get("maxRounds").and_then(Value::as_u64)
        && execution.rounds.len() as u64 >= max_rounds
    {
        return stop_batch(store, &req.turn_id, "paused", "roundsExhausted");
    }
    if let Some(deadline_ms) = policy.get("deadlineMs").and_then(Value::as_u64) {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if now_ms >= deadline_ms {
            return stop_batch(store, &req.turn_id, "paused", "deadlineReached");
        }
    }
    // The continuation input is derived from the durable Goal record, so a
    // restart can produce the identical round from the same facts.
    let goal = store.read_goal(&execution.goal_id).ok()?;
    let prompt = format!(
        "Continue this Goal autonomously.\nGoal: {}\nAcceptance criteria: {}\nStanding constraints: {}\nPrevious round ended: completed.\nProceed with the next concrete step toward the acceptance criteria. If the acceptance criteria are already met, reply with a concise completion summary and make no further tool calls.",
        goal.title,
        goal.success_criteria.as_deref().unwrap_or(""),
        goal.constraints.as_deref().unwrap_or(""),
    );
    let (_execution, turn) = match store.begin_goal_execution_round(&execution.id) {
        Ok(next) => next,
        Err(_) => {
            // Nobody can admit the next round (a rejected replacement owns
            // the thread, or the store refused). Stop the batch durably
            // instead of leaving it running with no owner to advance it.
            let _ = store.stop_goal_execution(&execution.id, "interrupted", "nextRoundStartFailed");
            return None;
        }
    };
    Some(TurnRequest {
        thread_id: req.thread_id.clone(),
        turn_id: turn.id,
        prompt,
        read_only: req.read_only,
        settings: req.settings.clone(),
        advance: req.advance.clone(),
    })
}

fn stop_batch(
    store: &ProductStore,
    turn_id: &str,
    status: &str,
    reason: &str,
) -> Option<TurnRequest> {
    if let Ok(Some(execution)) = store.find_goal_execution_by_turn(turn_id) {
        let _ = store.stop_goal_execution(&execution.id, status, reason);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use knorvia_store::GoalUpdate;

    fn outcome(status: &str, text: &str) -> TurnOutcome {
        TurnOutcome {
            status: status.into(),
            items: vec![TurnItem {
                kind: "agentMessage".into(),
                payload: json!({"text": text}),
            }],
            error: None,
        }
    }

    pub(super) struct Scripted {
        pub(super) outcomes: Vec<Result<TurnOutcome, ProtocolError>>,
    }

    impl TurnExecutor for Scripted {
        fn run_turn(&mut self, _req: &TurnRequest) -> Result<TurnOutcome, ProtocolError> {
            self.outcomes
                .pop()
                .expect("scripted executor exhausted; test must push one outcome per turn")
        }

        fn start_write_turn(
            &mut self,
            req: &TurnRequest,
            store: Arc<ProductStore>,
            _sink: Option<EventSink>,
        ) -> Result<WriteTurnStream, ProtocolError> {
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
                .map_err(|e| internal(e.to_string()))?;
            let _ = store.append_item(
                &req.thread_id,
                &req.turn_id,
                "tool.write",
                "waiting_approval",
                json!({"approvalId": appr.id, "digest": digest, "action": action}),
            );
            let (tx, rx): (Sender<ka::TurnDecision>, Receiver<ka::TurnDecision>) = channel();
            let (first_tx, first_rx): (Sender<String>, Receiver<String>) = channel();
            let _ = first_tx.send(appr.id.clone());
            let turn_id = req.turn_id.clone();
            std::thread::spawn(move || {
                let _ = rx.recv();
                std::thread::sleep(Duration::from_millis(30));
                let _ = store.complete_turn(&turn_id, "completed");
                drop(tx);
            });
            Ok(WriteTurnStream {
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

    #[test]
    fn scripted_executor_records_status_and_items() {
        let mut ex = Scripted {
            outcomes: vec![Ok(outcome("completed", "from kernel"))],
        };
        let out = ex
            .run_turn(&TurnRequest {
                thread_id: "th_1".into(),
                turn_id: "turn_1".into(),
                prompt: "hi".into(),
                read_only: true,
                settings: KernelTurnSettings::default(),
                advance: None,
            })
            .unwrap();
        assert_eq!(out.status, "completed");
        assert_eq!(out.items[0].payload["text"], "from kernel");
    }

    fn goal_batch_fixture() -> (ProductStore, String, String) {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let paths = knorvia_platform_paths::layout(
            std::env::temp_dir().join(format!("knorvia-advance-{}-{unique}", std::process::id())),
        );
        let store = ProductStore::open(paths).unwrap();
        let workspace = store.create_workspace("test").unwrap();
        let goal = store
            .create_goal_with_context(
                &workspace.id,
                "advance fixture",
                GoalUpdate {
                    success_criteria: Some("done means done".into()),
                    ..GoalUpdate::default()
                },
            )
            .unwrap();
        let thread = store
            .create_thread(&workspace.id, "task", Some(&goal.id), None)
            .unwrap();
        (store, goal.id, thread.id)
    }

    fn advance_request(thread_id: &str, turn_id: &str) -> TurnRequest {
        TurnRequest {
            thread_id: thread_id.into(),
            turn_id: turn_id.into(),
            prompt: "round".into(),
            read_only: true,
            settings: KernelTurnSettings::default(),
            advance: Some(json!({"maxRounds": 5})),
        }
    }

    #[test]
    fn advance_continues_while_the_next_round_admits() {
        let (store, goal_id, thread_id) = goal_batch_fixture();
        let (execution, turn) = store
            .start_goal_execution_turn(
                &goal_id,
                &thread_id,
                "rk",
                "digest",
                "action",
                Some(json!({"maxRounds": 5})),
            )
            .unwrap();
        store.complete_turn(&turn.id, "completed").unwrap();
        store.close_goal_round(&turn.id, "completed").unwrap();
        let next = advance_decision(&store, &advance_request(&thread_id, &turn.id), "completed", false)
            .expect("a healthy advancing batch admits its next round");
        assert_eq!(next.thread_id, thread_id);
        assert_eq!(store.read_turn(&next.turn_id).unwrap().status, "running");
    }

    #[test]
    fn next_round_admission_failure_stops_the_batch_instead_of_silently_dropping() {
        let (store, goal_id, thread_id) = goal_batch_fixture();
        let (execution, turn) = store
            .start_goal_execution_turn(
                &goal_id,
                &thread_id,
                "rk",
                "digest",
                "action",
                Some(json!({"maxRounds": 5})),
            )
            .unwrap();
        store.complete_turn(&turn.id, "completed").unwrap();
        store.close_goal_round(&turn.id, "completed").unwrap();
        // A racing turn/start owns the thread, exactly like the registry
        // takeover this file's admission now prevents. The next round cannot
        // be admitted; the batch must stop durably instead of staying
        // running with no owner.
        let squatter = store.start_turn(&thread_id).unwrap();
        let decision =
            advance_decision(&store, &advance_request(&thread_id, &turn.id), "completed", false);
        assert!(decision.is_none(), "no round can be admitted");
        let stopped = store.read_goal_execution(&execution.id).unwrap();
        assert_eq!(stopped.status, "interrupted");
        assert_eq!(stopped.stop_reason.as_deref(), Some("nextRoundStartFailed"));
        assert!(stopped.terminal_at.is_some(), "the batch is terminal");
        let _ = store.complete_turn(&squatter.id, "cancelled");
    }
}
