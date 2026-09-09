//! One reader owns JSONL stdout. Response IDs and per-thread subscriptions
//! keep slow turn consumers and approval callbacks off the transport reader.

use super::{AdapterError, denial_response, is_server_request};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Message = Result<Value, String>;

#[derive(Default)]
struct Routing {
    pending: HashMap<i64, SyncSender<Message>>,
    threads: HashMap<String, SyncSender<Message>>,
    parents: HashMap<String, String>,
    active_turns: HashMap<String, String>,
    lookups: HashMap<i64, String>,
    buffered: HashMap<String, Vec<Value>>,
    next_lookup: i64,
    closed: Option<String>,
}

impl Routing {
    fn owner(&self, thread: &str) -> Option<SyncSender<Message>> {
        let mut current = thread;
        for _ in 0..64 {
            if let Some(sender) = self.threads.get(current) {
                return Some(sender.clone());
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

    fn recipient(&mut self, message: &Value) -> Option<SyncSender<Message>> {
        if message.get("method").is_none() {
            message
                .get("id")
                .and_then(Value::as_i64)
                .and_then(|id| self.pending.remove(&id))
        } else {
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
                {
                    if let Some(children) = message
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
            }
            message
                .pointer("/params/threadId")
                .and_then(Value::as_str)
                .and_then(|thread| self.owner(thread))
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

    fn route(
        &mut self,
        message: Value,
    ) -> Result<(Vec<(SyncSender<Message>, Value)>, Vec<Value>), String> {
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
        } else if let Some(target) = self.recipient(&message) {
            deliveries.push((target, message));
        } else if let Some(thread) = message
            .pointer("/params/threadId")
            .and_then(Value::as_str)
            .filter(|_| !self.threads.is_empty())
        {
            let thread = thread.to_string();
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
                deliveries.extend(messages.into_iter().map(|message| (owner.clone(), message)));
            }
        }
        Ok((deliveries, outbound))
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
    for (_, tx) in state.threads.drain() {
        let _ = tx.try_send(Err(reason.clone()));
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
                let (deliveries, outbound) = match routed {
                    Ok(value) => value,
                    Err(error) => break error,
                };
                let mut overflow = false;
                for (tx, message) in deliveries {
                    match tx.try_send(Ok(message)) {
                        Ok(()) => {}
                        Err(TrySendError::Full(_)) => {
                            overflow = true;
                            break;
                        }
                        Err(TrySendError::Disconnected(_)) => {}
                    }
                }
                if overflow {
                    break "kernel event consumer overflow".to_string();
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
                        overflow = true;
                        break;
                    }
                }
                if overflow {
                    break "kernel stdin closed".to_string();
                }
            };
            close(&state, reason);
            // A corrupt/overflowed stream is unusable. Stop the private kernel
            // so remote tools cannot outlive a failed control connection.
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
        let (tx, receiver) = sync_channel(256);
        state.threads.insert(thread.to_string(), tx);
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

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;
