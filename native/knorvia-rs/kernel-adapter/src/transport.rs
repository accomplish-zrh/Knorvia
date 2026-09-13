//! One reader owns JSONL stdout. Response IDs and per-thread subscriptions
//! keep slow turn consumers and approval callbacks off the transport reader.
//! Each subscription owns a bounded spill dispatcher, so a consumer that
//! falls behind only ever isolates its own task; the shared kernel reader and
//! every other task keep running. Protocol corruption remains fail-closed.

use super::{AdapterError, denial_response, is_server_request};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

type Message = Result<Value, String>;
type PendingDelivery = (SyncSender<Message>, Value);
type TaskDelivery = (String, Arc<Dispatcher>, Value);
type Routed = Result<(Vec<PendingDelivery>, Vec<TaskDelivery>, Vec<Value>), String>;

/// Event queue depth each turn consumer drains directly.
const CHANNEL_CAPACITY: usize = 256;
/// Bounded per-task spill absorbing bursts while a consumer is behind.
const SPILL_CAPACITY: usize = 1024;
/// Merged provisional delta text is capped; the completed item stays the
/// durable record.
const DELTA_MERGE_LIMIT: usize = 1024 * 1024;

const DELTA_METHOD: &str = "item/agentMessage/delta";

/// Observable per-task backlog state.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TaskLag {
    /// Events waiting in the spill for the consumer to drain.
    pub queued: usize,
    /// Transient delta notifications dropped because the spill was full.
    pub dropped_delta_events: u64,
    /// Provisional delta bytes cut from a merged delta to stay bounded.
    pub truncated_delta_bytes: u64,
    /// Events discarded after this task was isolated for falling behind.
    pub dropped_after_isolation: u64,
    /// Set when this task was isolated: its backlog exceeded the spill bound.
    pub isolated: Option<String>,
}

enum Outcome {
    Queued,
    /// Transient-only drop (a delta) or a post-isolation discard.
    Dropped,
    /// The task exceeded its bound and was isolated.
    Isolated,
}

struct Spill {
    queue: VecDeque<Message>,
    lag: TaskLag,
    finished: bool,
}

/// Delivers routed events to one subscription without ever blocking the
/// transport reader. A full channel applies backpressure here; the bounded
/// spill absorbs the burst. Approval, item, and terminal events are always
/// preserved in order — a spill overflow isolates only this one task.
struct Dispatcher {
    sender: SyncSender<Message>,
    state: Mutex<Spill>,
    signal: Condvar,
}

fn is_delta(message: &Value) -> bool {
    message.get("method").and_then(Value::as_str) == Some(DELTA_METHOD)
}

impl Dispatcher {
    fn spawn(sender: SyncSender<Message>) -> Arc<Self> {
        let dispatcher = Arc::new(Self {
            sender,
            state: Mutex::new(Spill {
                queue: VecDeque::new(),
                lag: TaskLag::default(),
                finished: false,
            }),
            signal: Condvar::new(),
        });
        let background = Arc::clone(&dispatcher);
        let _ = std::thread::Builder::new()
            .name("kernel-event-dispatch".into())
            .spawn(move || background.drain_loop());
        dispatcher
    }

    fn drain_loop(&self) {
        loop {
            let message = {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                loop {
                    if let Some(message) = state.queue.pop_front() {
                        state.lag.queued = state.queue.len();
                        break Some(message);
                    }
                    if state.finished {
                        break None;
                    }
                    state = self.signal.wait(state).unwrap_or_else(|e| e.into_inner());
                }
            };
            let Some(message) = message else { return };
            // Blocking send applies per-task backpressure here instead of
            // stalling the shared reader. A dropped receiver ends delivery.
            if self.sender.send(message).is_err() {
                return;
            }
        }
    }

    fn push(&self, message: Message) -> Outcome {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.finished {
            state.lag.dropped_after_isolation += 1;
            return Outcome::Dropped;
        }
        if state.queue.len() < SPILL_CAPACITY {
            state.queue.push_back(message);
            state.lag.queued = state.queue.len();
            self.signal.notify_one();
            return Outcome::Queued;
        }
        if let Ok(value) = &message
            && is_delta(value)
        {
            if Self::merge_delta(&mut state, value) {
                return Outcome::Queued;
            }
            state.lag.dropped_delta_events += 1;
            return Outcome::Dropped;
        }
        // Durable-bound events never shrink: exceeding the bound interrupts
        // this one task instead of dropping approvals or terminals.
        let reason = format!(
            "kernel event backlog exceeded its per-task bound ({SPILL_CAPACITY}); this task was isolated"
        );
        state.lag.isolated = Some(reason.clone());
        state.finished = true;
        state.queue.push_back(Err(reason));
        state.lag.queued = state.queue.len();
        self.signal.notify_one();
        Outcome::Isolated
    }

    /// Coalesce a transient delta into a queued tail delta for the same item.
    /// Concatenation preserves the assembled provisional text exactly; bytes
    /// beyond [`DELTA_MERGE_LIMIT`] are counted and dropped.
    fn merge_delta(state: &mut Spill, incoming: &Value) -> bool {
        let Some(Ok(tail)) = state.queue.back_mut() else {
            return false;
        };
        if !is_delta(tail) || tail.pointer("/params/itemId") != incoming.pointer("/params/itemId") {
            return false;
        }
        let addition = incoming
            .pointer("/params/delta")
            .and_then(Value::as_str)
            .unwrap_or("");
        let existing = tail
            .pointer("/params/delta")
            .and_then(Value::as_str)
            .unwrap_or("")
            .len();
        let kept = addition
            .char_indices()
            .take_while(|(index, _)| existing + index < DELTA_MERGE_LIMIT)
            .last()
            .map(|(index, ch)| index + ch.len_utf8())
            .unwrap_or(0);
        state.lag.truncated_delta_bytes += (addition.len() - kept) as u64;
        if kept > 0
            && let Some(params) = tail.get_mut("params").and_then(Value::as_object_mut)
        {
            let merged = format!(
                "{}{}",
                params.get("delta").and_then(Value::as_str).unwrap_or(""),
                &addition[..kept]
            );
            params.insert("delta".into(), Value::String(merged));
        }
        true
    }

    fn close(&self, reason: &str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.finished {
            state.finished = true;
            state.queue.push_back(Err(reason.to_string()));
            state.lag.queued = state.queue.len();
        }
        self.signal.notify_all();
    }

    fn lag(&self) -> TaskLag {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .lag
            .clone()
    }
}

#[derive(Default)]
struct Routing {
    pending: HashMap<i64, SyncSender<Message>>,
    threads: HashMap<String, Arc<Dispatcher>>,
    parents: HashMap<String, String>,
    active_turns: HashMap<String, String>,
    lookups: HashMap<i64, String>,
    buffered: HashMap<String, Vec<Value>>,
    next_lookup: i64,
    closed: Option<String>,
}

impl Routing {
    fn owner(&self, thread: &str) -> Option<Arc<Dispatcher>> {
        let mut current = thread;
        for _ in 0..64 {
            if let Some(dispatcher) = self.threads.get(current) {
                return Some(Arc::clone(dispatcher));
            }
            current = self.parents.get(current)?;
        }
        None
    }

    fn descends_from(&self, thread: &str, root: &str) -> bool {
        let mut current = thread;
        for _ in 0..64 {
            if current == root {
                return true;
            }
            let Some(parent) = self.parents.get(current) else {
                return false;
            };
            current = parent;
        }
        false
    }

    fn recipient(&mut self, message: &Value) -> Option<(String, Arc<Dispatcher>)> {
        if message.get("method").is_some() {
            let method = message["method"].as_str().unwrap_or("");
            if let Some(thread) = message.pointer("/params/threadId").and_then(Value::as_str) {
                if method == "turn/started" {
                    if let Some(turn) = message.pointer("/params/turn/id").and_then(Value::as_str) {
                        self.active_turns.insert(thread.into(), turn.into());
                    }
                } else if method == "turn/completed" {
                    self.active_turns.remove(thread);
                }
                // Only a successful spawn establishes ownership. A wait/send
                // naming an unrelated thread must never steal its approvals.
                if matches!(method, "item/started" | "item/completed")
                    && message.pointer("/params/item/type").and_then(Value::as_str)
                        == Some("collabAgentToolCall")
                    && message.pointer("/params/item/tool").and_then(Value::as_str)
                        == Some("spawnAgent")
                    && self.owner(thread).is_some()
                    && let Some(children) = message
                        .pointer("/params/item/receiverThreadIds")
                        .and_then(Value::as_array)
                {
                    for child in children.iter().filter_map(Value::as_str) {
                        if child != thread && !self.threads.contains_key(child) {
                            self.parents
                                .entry(child.into())
                                .or_insert_with(|| thread.into());
                        }
                    }
                }
            }
            message
                .pointer("/params/threadId")
                .and_then(Value::as_str)
                .and_then(|thread| self.owner(thread).map(|owner| (thread.to_string(), owner)))
        } else {
            None
        }
    }

    fn lookup(&mut self, thread: &str, outbound: &mut Vec<Value>) {
        if self.lookups.values().any(|id| id == thread) {
            return;
        }
        self.next_lookup -= 1;
        let id = self.next_lookup;
        self.lookups.insert(id, thread.into());
        outbound.push(serde_json::json!({"id": id, "method": "thread/read", "params": {"threadId": thread, "includeTurns": false}}));
    }

    fn route(&mut self, message: Value) -> Routed {
        let mut responses = Vec::new();
        let mut deliveries = Vec::new();
        let mut outbound = Vec::new();
        let lookup_thread = if message.get("method").is_none() {
            message["id"]
                .as_i64()
                .and_then(|id| self.lookups.remove(&id))
        } else {
            None
        };
        if let Some(thread) = lookup_thread {
            let summary = &message["result"]["thread"];
            let parent = summary
                .get("parentThreadId")
                .and_then(Value::as_str)
                .or_else(|| {
                    summary
                        .pointer("/source/subAgent/thread_spawn/parent_thread_id")
                        .and_then(Value::as_str)
                });
            if let Some(parent) = parent.filter(|parent| *parent != thread) {
                self.parents
                    .entry(thread.clone())
                    .or_insert_with(|| parent.into());
                if self.owner(parent).is_none() && !self.parents.contains_key(parent) {
                    self.lookup(parent, &mut outbound);
                }
            } else {
                // Unknown/unrelated threads get an explicit denial. No
                // approval is ever routed merely because one parent is live.
                if let Some(buffered) = self.buffered.remove(&thread) {
                    for event in buffered.into_iter().filter(is_server_request) {
                        outbound.push(denial_response(
                            &event["id"],
                            "Thread has no verified Knorvia parent",
                        ));
                    }
                }
            }
        } else if message.get("method").is_none() {
            // A response always belongs to its waiting requester, delivered
            // directly: requesters block on their own channel immediately.
            if let Some(id) = message.get("id").and_then(Value::as_i64)
                && let Some(tx) = self.pending.remove(&id)
            {
                responses.push((tx, message));
            }
        } else if let Some((thread, target)) = self.recipient(&message) {
            deliveries.push((thread, target, message));
        } else if let Some(thread) = message
            .pointer("/params/threadId")
            .and_then(Value::as_str)
            .filter(|_| !self.threads.is_empty())
        {
            let thread = thread.to_string();
            // Unowned threads have no task to isolate; the shared buffer keeps
            // its global fail-closed bound.
            if self.buffered.len() >= 64
                || self.buffered.values().map(Vec::len).sum::<usize>() >= 256
            {
                return Err("kernel unowned event buffer overflow".into());
            }
            self.buffered
                .entry(thread.clone())
                .or_default()
                .push(message);
            self.lookup(&thread, &mut outbound);
        } else if is_server_request(&message) {
            outbound.push(denial_response(
                &message["id"],
                "Knorvia has no active consumer for this request",
            ));
        }
        let ready: Vec<_> = self
            .buffered
            .keys()
            .filter_map(|thread| self.owner(thread).map(|owner| (thread.clone(), owner)))
            .collect();
        for (thread, owner) in ready {
            if let Some(messages) = self.buffered.remove(&thread) {
                deliveries.extend(
                    messages
                        .into_iter()
                        .map(|message| (thread.clone(), Arc::clone(&owner), message)),
                );
            }
        }
        Ok((responses, deliveries, outbound))
    }

    /// Interrupt request for the one active turn of an isolated task, so the
    /// kernel stops producing events nobody will consume.
    fn isolation_interrupt(&mut self, thread: &str, outbound: &mut Vec<Value>) {
        if let Some(turn) = self.active_turns.get(thread).cloned() {
            self.next_lookup -= 1;
            let id = self.next_lookup;
            outbound.push(serde_json::json!({
                "id": id,
                "method": "turn/interrupt",
                "params": {"threadId": thread, "turnId": turn}
            }));
        }
    }
}

pub(super) struct Transport {
    routing: Arc<Mutex<Routing>>,
    stdin: Arc<Mutex<ChildStdin>>,
}

pub(super) struct Subscription {
    pub receiver: Receiver<Message>,
    thread: String,
    routing: Arc<Mutex<Routing>>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Ok(mut routing) = self.routing.lock() {
            routing.threads.remove(&self.thread);
        }
    }
}

fn close(routing: &Mutex<Routing>, reason: String) {
    let mut state = routing.lock().unwrap_or_else(|e| e.into_inner());
    state.closed = Some(reason.clone());
    for (_, tx) in state.pending.drain() {
        let _ = tx.try_send(Err(reason.clone()));
    }
    let dispatchers: Vec<_> = state.threads.values().cloned().collect();
    drop(state);
    for dispatcher in dispatchers {
        dispatcher.close(&reason);
    }
}

impl Transport {
    pub fn new(
        stdout: ChildStdout,
        stdin: Arc<Mutex<ChildStdin>>,
        child: Arc<Mutex<Child>>,
    ) -> Self {
        let routing = Arc::new(Mutex::new(Routing::default()));
        let state = Arc::clone(&routing);
        let writer = Arc::clone(&stdin);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let reason = 'frames: loop {
                // A malformed/misbehaving kernel cannot grow an unlimited line.
                let mut line = Vec::new();
                match reader
                    .by_ref()
                    .take(8 * 1024 * 1024 + 1)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) => break "kernel closed stdout".to_string(),
                    Ok(_) if line.len() > 8 * 1024 * 1024 => {
                        break "kernel frame too large".to_string();
                    }
                    Ok(_) => {}
                    Err(error) => break error.to_string(),
                }
                let message: Value = match serde_json::from_slice(&line) {
                    Ok(message) => message,
                    Err(_) => break "invalid kernel JSONL frame".to_string(),
                };
                let routed = {
                    let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
                    state.route(message)
                };
                let (responses, deliveries, mut outbound) = match routed {
                    Ok(value) => value,
                    Err(error) => break error,
                };
                // Responses go straight to their waiting requester: that
                // caller is blocked on its own 1-slot channel, so a full slot
                // cannot stall the reader.
                for (tx, message) in responses {
                    let mut overflow = false;
                    match tx.try_send(Ok(message)) {
                        Ok(()) => {}
                        Err(std::sync::mpsc::TrySendError::Full(_)) => overflow = true,
                        Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {}
                    }
                    if overflow {
                        break 'frames "kernel event consumer overflow".to_string();
                    }
                }
                let mut isolated = Vec::new();
                for (thread, dispatcher, message) in deliveries {
                    if let Outcome::Isolated = dispatcher.push(Ok(message)) {
                        isolated.push(thread);
                    }
                }
                if !isolated.is_empty() {
                    let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
                    for thread in isolated {
                        state.isolation_interrupt(&thread, &mut outbound);
                    }
                }
                for reply in outbound {
                    let mut pipe = match writer.lock() {
                        Ok(pipe) => pipe,
                        Err(_) => break 'frames "kernel writer lock poisoned".to_string(),
                    };
                    if writeln!(pipe, "{reply}")
                        .and_then(|_| pipe.flush())
                        .is_err()
                    {
                        break 'frames "kernel stdin closed".to_string();
                    }
                }
            };
            close(&state, reason);
            // A corrupt stream is unusable. Stop the private kernel so remote
            // tools cannot outlive a failed control connection. A merely slow
            // consumer never reaches this path anymore.
            if let Ok(mut process) = child.lock() {
                let _ = process.kill();
            }
        });
        Self { routing, stdin }
    }

    pub fn active_descendants(&self, root: &str) -> Vec<(String, String)> {
        let routing = self.routing.lock().unwrap_or_else(|e| e.into_inner());
        routing
            .active_turns
            .iter()
            .filter(|(thread, _)| thread.as_str() != root && routing.descends_from(thread, root))
            .map(|(thread, turn)| (thread.clone(), turn.clone()))
            .collect()
    }

    pub fn active_descendant(&self, root: &str, child: &str) -> Option<String> {
        let routing = self.routing.lock().unwrap_or_else(|e| e.into_inner());
        if child == root || !routing.descends_from(child, root) {
            return None;
        }
        routing.active_turns.get(child).cloned()
    }

    pub fn task_lag(&self, thread: &str) -> TaskLag {
        self.routing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .threads
            .get(thread)
            .map(|dispatcher| dispatcher.lag())
            .unwrap_or_default()
    }

    pub fn subscribe(&self, thread: &str) -> Result<Subscription, AdapterError> {
        let mut state = self
            .routing
            .lock()
            .map_err(|e| AdapterError::Msg(e.to_string()))?;
        if let Some(error) = &state.closed {
            return Err(AdapterError::Msg(error.clone()));
        }
        if state.threads.contains_key(thread) {
            return Err(AdapterError::Msg(
                "kernel thread already has an active turn".into(),
            ));
        }
        let (tx, receiver) = sync_channel(CHANNEL_CAPACITY);
        state
            .threads
            .insert(thread.to_string(), Dispatcher::spawn(tx));
        Ok(Subscription {
            receiver,
            thread: thread.into(),
            routing: Arc::clone(&self.routing),
        })
    }

    pub fn request(
        &self,
        id: i64,
        message: &Value,
        timeout: Duration,
    ) -> Result<Value, AdapterError> {
        let (tx, rx) = sync_channel(1);
        {
            let mut state = self
                .routing
                .lock()
                .map_err(|e| AdapterError::Msg(e.to_string()))?;
            if let Some(error) = &state.closed {
                return Err(AdapterError::Msg(error.clone()));
            }
            state.pending.insert(id, tx);
        }
        let sent = self
            .stdin
            .lock()
            .map_err(|e| AdapterError::Msg(e.to_string()))
            .and_then(|mut pipe| {
                writeln!(pipe, "{message}")?;
                pipe.flush()?;
                Ok(())
            });
        let result = sent.and_then(|_| {
            rx.recv_timeout(timeout)
                .map_err(|error| match error {
                    std::sync::mpsc::RecvTimeoutError::Timeout => AdapterError::RequestTimeout,
                    std::sync::mpsc::RecvTimeoutError::Disconnected => {
                        AdapterError::Msg("kernel disconnected".into())
                    }
                })?
                .map_err(AdapterError::Msg)
        });
        self.routing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending
            .remove(&id);
        let response = result?;
        if let Some(error) = response.get("error") {
            return Err(AdapterError::Msg(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("kernel request failed")
                    .into(),
            ));
        }
        response
            .get("result")
            .cloned()
            .ok_or_else(|| AdapterError::Msg("kernel response has no result".into()))
    }
}
