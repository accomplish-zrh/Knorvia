use super::*;
use serde_json::json;
use std::sync::mpsc::sync_channel;

fn delta(item: &str, text: &str) -> Value {
    json!({"method": "item/agentMessage/delta", "params": {"threadId": "t", "itemId": item, "delta": text}})
}

fn notification(method: &str, marker: &str) -> Value {
    json!({"method": method, "params": {"threadId": "t", "marker": marker}})
}

/// A dispatcher with a tiny channel and no consumer attached yet.
fn blocked_dispatcher(capacity: usize) -> (Arc<Dispatcher>, Receiver<Message>) {
    let (tx, rx) = sync_channel(capacity);
    (Dispatcher::spawn(tx), rx)
}

fn non_delta(index: usize) -> Value {
    notification("item/completed", &index.to_string())
}

#[test]
fn notifications_and_out_of_order_responses_have_independent_owners() {
    let mut routing = Routing::default();
    let (a, response_a) = sync_channel(1);
    let (b, response_b) = sync_channel(1);
    let (thread_tx, events) = sync_channel(4);
    let dispatcher = Dispatcher::spawn(thread_tx);
    routing.pending.insert(1, a);
    routing.pending.insert(2, b);
    routing.threads.insert("thread-a".into(), Arc::clone(&dispatcher));
    let messages = [
        json!({"id": 1, "method": "approval/request", "params": {"threadId": "thread-a"}}),
        json!({"id": 2, "result": "second"}),
        json!({"method": "item/agentMessage/delta", "params": {"threadId": "thread-a", "delta": "live"}}),
        json!({"id": 1, "result": "first"}),
    ];
    for message in &messages {
        routing
            .recipient(message)
            .unwrap()
            .1
            .push(Ok(message.clone()));
        if message.get("method").is_some() {
            // Responses are drained by the reader inline; only notifications
            // go through the per-task dispatcher here.
        }
    }
    // The response channels are drained by `request()` callers, not the
    // dispatcher; responses with ids were popped from pending above.
    assert_eq!(events.recv().unwrap().unwrap(), messages[0]);
    assert_eq!(events.recv().unwrap().unwrap(), messages[2]);
    assert!(routing.pending.is_empty());
    drop(response_a);
    drop(response_b);
}

#[test]
fn thread_events_never_consume_other_threads_or_unknown_ids() {
    let mut routing = Routing::default();
    let (tx, receiver) = sync_channel(1);
    routing
        .threads
        .insert("a".into(), Dispatcher::spawn(tx));
    assert!(
        routing
            .recipient(&json!({"method": "item/completed", "params": {"threadId": "b"}}))
            .is_none()
    );
    assert!(
        routing
            .recipient(&json!({"id": 42, "result": "late"}))
            .is_none()
    );
    assert!(receiver.try_recv().is_err());
    let lag = routing.threads["a"].lag();
    assert_eq!(lag.queued, 0);
    assert_eq!(routing.threads.len(), 1);
}

#[test]
fn closing_transport_fails_all_pending_and_subscriptions() {
    let mut routing = Routing::default();
    let (request, reply) = sync_channel(1);
    let (thread_tx, events) = sync_channel(1);
    routing.pending.insert(1, request);
    routing
        .threads
        .insert("thread".into(), Dispatcher::spawn(thread_tx));
    let routing = Mutex::new(routing);
    close(&routing, "connection lost".into());
    assert_eq!(reply.recv().unwrap(), Err("connection lost".into()));
    assert_eq!(events.recv().unwrap(), Err("connection lost".into()));
    let routing = routing.lock().unwrap();
    assert!(routing.pending.is_empty());
    assert!(routing.threads.is_empty());
    assert_eq!(routing.closed.as_deref(), Some("connection lost"));
}

#[test]
fn descendant_approval_before_spawn_event_waits_for_verified_parent() {
    let mut routing = Routing::default();
    let (a, _) = sync_channel(8);
    let (b, _) = sync_channel(8);
    routing
        .threads
        .insert("parent-a".into(), Dispatcher::spawn(a));
    routing
        .threads
        .insert("parent-b".into(), Dispatcher::spawn(b));
    let approval = json!({"id":91,"method":"item/commandExecution/requestApproval","params":{"threadId":"child","turnId":"child-turn"}});
    let (deliveries, requests) = routing.route(approval.clone()).unwrap();
    assert!(deliveries.is_empty());
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["method"], "thread/read");
    let lookup = requests[0]["id"].clone();
    let (deliveries, _) = routing
        .route(json!({"id":lookup,"result":{"thread":{"id":"child","parentThreadId":"parent-a"}}}))
        .unwrap();
    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0].0, "child");
    assert_eq!(deliveries[0].2, approval);
    assert!(routing.descends_from("child", "parent-a"));
    assert!(!routing.descends_from("child", "parent-b"));
}

#[test]
fn unrelated_child_cannot_be_claimed_by_wait_or_metadata() {
    let mut routing = Routing::default();
    let (a, _) = sync_channel(8);
    routing
        .threads
        .insert("parent".into(), Dispatcher::spawn(a));
    routing.recipient(&json!({"method":"item/completed","params":{"threadId":"parent","item":{"type":"collabAgentToolCall","tool":"wait","receiverThreadIds":["foreign"]}}}));
    assert!(routing.owner("foreign").is_none());
    let (_, request) = routing
        .route(json!({"id":9,"method":"approval/request","params":{"threadId":"foreign"}}))
        .unwrap();
    let (delivery, denied) = routing.route(json!({"id":request[0]["id"],"result":{"thread":{"id":"foreign","parentThreadId":null}}})).unwrap();
    assert!(delivery.is_empty());
    assert_eq!(denied[0]["id"], 9);
    assert!(denied[0].get("error").is_some());
}

#[test]
fn child_turns_keep_their_own_cancellation_identity() {
    let mut routing = Routing::default();
    let (a, _) = sync_channel(8);
    routing
        .threads
        .insert("parent".into(), Dispatcher::spawn(a));
    routing.recipient(&json!({"method":"item/completed","params":{"threadId":"parent","item":{"type":"collabAgentToolCall","tool":"spawnAgent","receiverThreadIds":["child"]}}}));
    routing.recipient(
        &json!({"method":"turn/started","params":{"threadId":"child","turn":{"id":"child-turn"}}}),
    );
    assert_eq!(routing.active_turns["child"], "child-turn");
    routing.recipient(&json!({"method":"turn/completed","params":{"threadId":"child","turn":{"id":"child-turn"}}}));
    assert!(!routing.active_turns.contains_key("child"));
    assert!(routing.threads.contains_key("parent"));
}

#[test]
fn nested_agents_keep_verified_subtree_boundaries() {
    let mut routing = Routing::default();
    let (a, _) = sync_channel(8);
    routing
        .threads
        .insert("parent".into(), Dispatcher::spawn(a));
    routing.recipient(&json!({"method":"item/completed","params":{"threadId":"parent","item":{"type":"collabAgentToolCall","tool":"spawnAgent","receiverThreadIds":["child","peer"]}}}));
    routing.recipient(&json!({"method":"item/completed","params":{"threadId":"child","item":{"type":"collabAgentToolCall","tool":"spawnAgent","receiverThreadIds":["grandchild"]}}}));
    assert!(routing.descends_from("grandchild", "child"));
    assert!(routing.descends_from("grandchild", "parent"));
    assert!(!routing.descends_from("peer", "child"));
    assert!(!routing.descends_from("parent", "child"));
}

// --- R01: slow-consumer isolation ---

#[test]
fn slow_consumer_backlog_never_yields_an_error_and_recovers_in_order() {
    let (dispatcher, receiver) = blocked_dispatcher(2);
    // Far more than CHANNEL_CAPACITY + SPILL_CAPACITY would previously be
    // needed to fail the whole reader; here every durable event survives.
    for index in 0..(SPILL_CAPACITY + 300) {
        let outcome = dispatcher.push(Ok(non_delta(index)));
        assert!(matches!(outcome, Outcome::Queued | Outcome::Dropped));
        if let Outcome::Dropped = outcome {
            panic!("durable events must never be dropped while bounded");
        }
    }
    let mut received = 0;
    while let Ok(message) = receiver.recv_timeout(Duration::from_secs(5)) {
        match message {
            Ok(value) => {
                assert_eq!(value["method"], "item/completed");
                assert_eq!(value["params"]["marker"], received.to_string());
                received += 1;
            }
            Err(reason) => panic!("shared transport must stay alive: {reason}"),
        }
    }
    assert_eq!(received, SPILL_CAPACITY + 300);
    let lag = dispatcher.lag();
    assert_eq!(lag.queued, 0);
    assert_eq!(lag.isolated, None);
}

#[test]
fn transient_deltas_coalesce_or_drop_under_pressure_without_isolation() {
    let (dispatcher, receiver) = blocked_dispatcher(1);
    // Fill the spill completely with durable events.
    for index in 0..SPILL_CAPACITY {
        dispatcher.push(Ok(non_delta(index)));
    }
    // Deltas beyond the bound must coalesce into the queued tail or drop
    // with a counter; they never isolate the task.
    let mut last = delta("item-1", "tail-");
    for index in 0..(SPILL_CAPACITY * 2) {
        let outcome = dispatcher.push(Ok(delta("item-1", &index.to_string())));
        assert!(matches!(outcome, Outcome::Queued | Outcome::Dropped));
    }
    let lag = dispatcher.lag();
    assert_eq!(lag.isolated, None);
    assert!(
        lag.dropped_delta_events + lag.truncated_delta_bytes > 0,
        "pressure must be observable"
    );
    assert_eq!(lag.queued, SPILL_CAPACITY);
    // Drain everything: durable events in order, then at most one merged
    // delta, and no error.
    dispatcher.push(Ok(last));
    last = json!({"method": "turn/completed", "params": {"threadId": "t"}});
    dispatcher.push(Ok(last));
    drop(dispatcher);
    let mut saw_error = false;
    let mut completed = 0;
    while let Ok(message) = receiver.recv_timeout(Duration::from_secs(5)) {
        match message {
            Ok(value) => {
                if value["method"] == "item/completed" {
                    completed += 1;
                }
            }
            Err(_) => saw_error = true,
        }
    }
    assert!(!saw_error);
    assert_eq!(completed, SPILL_CAPACITY + 1);
}

#[test]
fn merged_delta_text_is_the_exact_concatenation_up_to_the_limit() {
    let (dispatcher, receiver) = blocked_dispatcher(0);
    // One durable event then deltas: the spill tail is a delta, so pressure
    // merges into it.
    dispatcher.push(Ok(non_delta(0)));
    for _ in 0..SPILL_CAPACITY - 1 {
        dispatcher.push(Ok(non_delta(0)));
    }
    dispatcher.push(Ok(delta("item-1", "")));
    let chunk = "x".repeat(64);
    for _ in 0..(DELTA_MERGE_LIMIT / 64) * 3 {
        dispatcher.push(Ok(delta("item-1", &chunk)));
    }
    let lag = dispatcher.lag();
    assert_eq!(lag.isolated, None);
    assert!(lag.truncated_delta_bytes > 0);
    drop(dispatcher);
    let mut merged_delta = String::new();
    while let Ok(message) = receiver.recv_timeout(Duration::from_secs(5)) {
        if let Ok(value) = message && value["method"] == DELTA_METHOD {
            merged_delta.push_str(value["params"]["delta"].as_str().unwrap_or(""));
        }
    }
    assert_eq!(merged_delta.len(), DELTA_MERGE_LIMIT);
}

#[test]
fn durable_overflow_isolates_only_that_task_and_keeps_the_reason() {
    let (slow, slow_receiver) = blocked_dispatcher(0);
    let (fast_tx, fast_receiver) = sync_channel(8);
    for index in 0..SPILL_CAPACITY {
        assert!(matches!(slow.push(Ok(non_delta(index))), Outcome::Queued));
    }
    // One more durable event exceeds the bound: isolate this task only.
    assert!(matches!(slow.push(Ok(non_delta(9999))), Outcome::Isolated));
    assert_eq!(slow.lag().isolated.as_deref().map(str::to_string).is_some(), true);
    // The isolated consumer still receives its preserved backlog, then the
    // typed isolation error — never a silent partial stream.
    let mut durable = 0;
    loop {
        match slow_receiver.recv_timeout(Duration::from_secs(5)).unwrap() {
            Ok(value) => {
                assert_eq!(value["method"], "item/completed");
                durable += 1;
            }
            Err(reason) => {
                assert!(reason.contains("isolated"), "reason: {reason}");
                break;
            }
        }
    }
    assert_eq!(durable, SPILL_CAPACITY);
    // A different task on the same transport is unaffected.
    let fast = Dispatcher::spawn(fast_tx);
    assert!(matches!(fast.push(Ok(non_delta(1))), Outcome::Queued));
    assert_eq!(
        fast_receiver.recv_timeout(Duration::from_secs(5)).unwrap().unwrap()["params"]["marker"],
        "1"
    );
    // Post-isolation events are counted, never resurrect the stream.
    let before = slow.lag().dropped_after_isolation;
    slow.push(Ok(non_delta(2)));
    assert_eq!(slow.lag().dropped_after_isolation, before + 1);
}

#[test]
fn isolation_interrupt_targets_the_active_turn_only() {
    let mut routing = Routing::default();
    let (tx, _) = sync_channel(1);
    routing
        .threads
        .insert("slow".into(), Dispatcher::spawn(tx));
    routing.active_turns.insert("slow".into(), "turn-1".into());
    let mut outbound = Vec::new();
    routing.isolation_interrupt("slow", &mut outbound);
    assert_eq!(outbound.len(), 1);
    assert_eq!(outbound[0]["method"], "turn/interrupt");
    assert_eq!(outbound[0]["params"]["threadId"], "slow");
    assert_eq!(outbound[0]["params"]["turnId"], "turn-1");
    outbound.clear();
    routing.isolation_interrupt("unknown-thread", &mut outbound);
    assert!(outbound.is_empty());
}
