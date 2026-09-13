use super::*;

#[test]
fn failed_error_item_does_not_leave_a_writable_turn_running() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let paths = knorvia_platform_paths::layout(std::env::temp_dir().join(format!(
        "knorvia-error-item-test-{}-{unique}",
        std::process::id()
    )));
    let store = ProductStore::open(paths.clone()).unwrap();
    let workspace = store.create_workspace("test").unwrap();
    let thread = store
        .create_thread(&workspace.id, "turn", None, None)
        .unwrap();
    let turn = store.start_turn(&thread.id).unwrap();
    // This isolated fixture has no Item directory yet. A file at that path
    // makes only the error Item write fail; the Turn and journal remain usable.
    fs::write(
        paths.state.join("product").join("items"),
        b"blocked fixture",
    )
    .unwrap();
    let executor = KernelTurnExecutor::new(paths);
    let request = TurnRequest {
        thread_id: thread.id,
        turn_id: turn.id.clone(),
        prompt: "test".into(),
        read_only: true,
        settings: KernelTurnSettings::default(),
        advance: None,
    };
    let result = persist_terminal(
        &executor.runtime,
        &request,
        &store,
        "failed",
        Some(&json!({"message": "kernel failed"})),
    );
    assert!(result.is_err());
    assert_eq!(store.read_turn(&turn.id).unwrap().status, "failed");
}

#[test]
fn terminal_failure_corrects_a_waiting_user_input_item() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let paths = knorvia_platform_paths::layout(std::env::temp_dir().join(format!(
        "knorvia-pending-input-terminal-test-{}-{unique}",
        std::process::id()
    )));
    let store = ProductStore::open(paths.clone()).unwrap();
    let workspace = store.create_workspace("test").unwrap();
    let thread = store
        .create_thread(&workspace.id, "turn", None, None)
        .unwrap();
    let turn = store.start_turn(&thread.id).unwrap();
    let pending = store
        .append_item(
            &thread.id,
            &turn.id,
            "userInput",
            "waiting_input",
            json!({"request": {"questions": [{"id": "mode"}]}}),
        )
        .unwrap();
    let executor = KernelTurnExecutor::new(paths);
    let request = TurnRequest {
        thread_id: thread.id,
        turn_id: turn.id.clone(),
        prompt: "test".into(),
        read_only: true,
        settings: KernelTurnSettings::default(),
        advance: None,
    };

    persist_terminal(&executor.runtime, &request, &store, "failed", None).unwrap();

    let corrected = store.read_item(&pending.id).unwrap();
    assert_eq!(corrected.status, "delivery_failed");
    assert_eq!(corrected.payload["request"]["questions"][0]["id"], "mode");
    assert_eq!(store.read_turn(&turn.id).unwrap().status, "failed");
}

fn waiting_active() -> ActiveTurn {
    ActiveTurn {
        turn_id: Mutex::new("turn".into()),
        cancelled: AtomicBool::new(false),
        done: AtomicBool::new(false),
        kernel: Mutex::new(None),
        cancelled_agents: Mutex::new(std::collections::HashSet::new()),
    }
}

#[test]
fn approval_deadline_resolves_as_timed_out_not_denied() {
    let (tx, rx) = channel();
    let active = waiting_active();
    let past = Instant::now() - Duration::from_secs(1);
    let (decision, resolution) = await_approval_decision(&rx, &active, &json!({}), past);
    assert!(matches!(decision, ka::TurnDecision::Decline));
    assert_eq!(resolution, "timed_out");
    drop(tx);
}

#[test]
fn approval_cancellation_wins_over_a_queued_decision() {
    let (tx, rx) = channel();
    let active = waiting_active();
    tx.send(ka::TurnDecision::Accept).unwrap();
    active.cancelled.store(true, Ordering::SeqCst);
    let (decision, resolution) =
        await_approval_decision(&rx, &active, &json!({}), Instant::now() + Duration::from_secs(5));
    assert!(matches!(decision, ka::TurnDecision::Decline));
    assert_eq!(resolution, "cancelled");
}

#[test]
fn approval_owner_loss_resolves_as_owner_lost() {
    let (tx, rx) = channel();
    let active = waiting_active();
    drop(tx);
    let (decision, resolution) =
        await_approval_decision(&rx, &active, &json!({}), Instant::now() + Duration::from_secs(5));
    assert!(matches!(decision, ka::TurnDecision::Decline));
    assert_eq!(resolution, "owner_lost");
}

#[test]
fn approval_user_decision_is_recorded_as_the_users() {
    let (tx, rx) = channel();
    let active = waiting_active();
    tx.send(ka::TurnDecision::Accept).unwrap();
    let (decision, resolution) =
        await_approval_decision(&rx, &active, &json!({}), Instant::now() + Duration::from_secs(5));
    assert!(matches!(decision, ka::TurnDecision::Accept));
    assert_eq!(resolution, "user");
}
