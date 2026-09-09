use super::*;

#[test]
fn subtree_cancellation_unblocks_descendant_requests_and_preserves_peers() {
    let active = ActiveTurn {
        turn_id: "parent-turn".into(),
        cancelled: AtomicBool::new(false),
        done: AtomicBool::new(false),
        kernel: Mutex::new(None),
        cancelled_agents: Mutex::new(std::collections::HashSet::from([
            "child".into(),
            "grandchild".into(),
        ])),
    };
    assert!(active.request_cancelled(&json!({"threadId":"child"})));
    assert!(active.request_cancelled(&json!({"threadId":"grandchild"})));
    assert!(!active.request_cancelled(&json!({"threadId":"peer"})));
    assert!(!active.request_cancelled(&json!({"threadId":"parent"})));
    active.cancelled.store(true, Ordering::SeqCst);
    assert!(active.request_cancelled(&json!({"threadId":"peer"})));
}

#[test]
fn runner_reference_retains_home_lock_after_executor_drop() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let paths = knorvia_platform_paths::layout(std::env::temp_dir().join(format!(
        "knorvia-runner-owner-{}-{unique}",
        std::process::id()
    )));
    paths.ensure_layout().unwrap();
    let lock_path = paths.state.join("daemon.lock");
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .unwrap();
    file.try_lock().unwrap();
    let executor = KernelTurnExecutor::with_ownership(paths, Arc::new(file));
    let runner = Arc::clone(&executor.runtime);
    drop(executor);
    let contender = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock_path)
        .unwrap();
    assert!(matches!(
        contender.try_lock(),
        Err(fs::TryLockError::WouldBlock)
    ));
    drop(runner);
    assert!(contender.try_lock().is_ok());
}

#[test]
fn missing_mapping_cannot_reset_a_thread_with_prior_items() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let paths = knorvia_platform_paths::layout(std::env::temp_dir().join(format!(
        "knorvia-missing-map-{}-{unique}",
        std::process::id()
    )));
    let store = ProductStore::open(paths.clone()).unwrap();
    let workspace = store.create_workspace("test").unwrap();
    let thread = store
        .create_thread(&workspace.id, "history", None, None)
        .unwrap();
    let first = store.start_turn(&thread.id).unwrap();
    store
        .append_item(
            &thread.id,
            &first.id,
            "userMessage",
            "completed",
            json!({"text": "first"}),
        )
        .unwrap();
    let executor = KernelTurnExecutor::new(paths);
    let mut request = TurnRequest {
        thread_id: thread.id.clone(),
        turn_id: first.id.clone(),
        prompt: "first".into(),
        read_only: true,
        settings: KernelTurnSettings::default(),
    };
    assert!(
        executor
            .runtime
            .saved_threads(&request, &store)
            .unwrap()
            .is_empty()
    );
    store.complete_turn(&first.id, "completed").unwrap();
    request.turn_id = store.start_turn(&thread.id).unwrap().id;
    assert!(matches!(
        executor.runtime.saved_threads(&request, &store),
        Err(ProtocolError {
            category: ErrorCategory::Conflict,
            ..
        })
    ));
}
