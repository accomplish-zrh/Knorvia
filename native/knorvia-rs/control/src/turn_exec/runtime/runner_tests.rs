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
    };

    persist_terminal(&executor.runtime, &request, &store, "failed", None).unwrap();

    let corrected = store.read_item(&pending.id).unwrap();
    assert_eq!(corrected.status, "delivery_failed");
    assert_eq!(corrected.payload["request"]["questions"][0]["id"], "mode");
    assert_eq!(store.read_turn(&turn.id).unwrap().status, "failed");
}
