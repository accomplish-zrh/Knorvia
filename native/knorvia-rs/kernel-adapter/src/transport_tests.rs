use super::*;
use serde_json::json;

#[test]
fn notifications_and_out_of_order_responses_have_independent_owners() {
    let mut routing = Routing::default();
    let (a, response_a) = sync_channel(1);
    let (b, response_b) = sync_channel(1);
    let (thread, events) = sync_channel(4);
    routing.pending.insert(1, a);
    routing.pending.insert(2, b);
    routing.threads.insert("thread-a".into(), thread);
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
            .send(Ok(message.clone()))
            .unwrap();
    }
    assert_eq!(response_a.recv().unwrap().unwrap(), messages[3]);
    assert_eq!(response_b.recv().unwrap().unwrap(), messages[1]);
    assert_eq!(events.recv().unwrap().unwrap(), messages[0]);
    assert_eq!(events.recv().unwrap().unwrap(), messages[2]);
    assert!(routing.pending.is_empty());
}

#[test]
fn thread_events_never_consume_other_threads_or_unknown_ids() {
    let mut routing = Routing::default();
    let (a, receiver) = sync_channel(1);
    routing.threads.insert("a".into(), a);
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
    assert_eq!(routing.threads.len(), 1);
}

#[test]
fn closing_transport_fails_all_pending_and_subscriptions() {
    let mut routing = Routing::default();
    let (request, reply) = sync_channel(1);
    let (thread, events) = sync_channel(1);
    routing.pending.insert(1, request);
    routing.threads.insert("thread".into(), thread);
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
    routing.threads.insert("parent-a".into(), a);
    routing.threads.insert("parent-b".into(), b);
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
    assert_eq!(deliveries[0].1, approval);
    assert!(routing.descends_from("child", "parent-a"));
    assert!(!routing.descends_from("child", "parent-b"));
}

#[test]
fn unrelated_child_cannot_be_claimed_by_wait_or_metadata() {
    let mut routing = Routing::default();
    let (a, _) = sync_channel(8);
    routing.threads.insert("parent".into(), a);
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
    routing.threads.insert("parent".into(), a);
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
    routing.threads.insert("parent".into(), a);
    routing.recipient(&json!({"method":"item/completed","params":{"threadId":"parent","item":{"type":"collabAgentToolCall","tool":"spawnAgent","receiverThreadIds":["child","peer"]}}}));
    routing.recipient(&json!({"method":"item/completed","params":{"threadId":"child","item":{"type":"collabAgentToolCall","tool":"spawnAgent","receiverThreadIds":["grandchild"]}}}));
    assert!(routing.descends_from("grandchild", "child"));
    assert!(routing.descends_from("grandchild", "parent"));
    assert!(!routing.descends_from("peer", "child"));
    assert!(!routing.descends_from("parent", "child"));
}
