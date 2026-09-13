use super::*;

#[test]
fn subtree_cancellation_unblocks_descendant_requests_and_preserves_peers() {
    let active = ActiveTurn {
        turn_id: Mutex::new("parent-turn".into()),
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
    let lock_path = paths.run.join("daemon.lock");
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
fn admission_rejects_a_live_runner_even_when_its_current_turn_is_terminal() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let paths = knorvia_platform_paths::layout(std::env::temp_dir().join(format!(
        "knorvia-admission-gap-{}-{unique}",
        std::process::id()
    )));
    let store = Arc::new(ProductStore::open(paths.clone()).unwrap());
    let workspace = store.create_workspace("test").unwrap();
    let thread = store
        .create_thread(&workspace.id, "task", None, None)
        .unwrap();
    let first = store.start_turn(&thread.id).unwrap();
    store.complete_turn(&first.id, "completed").unwrap();
    let mut executor = KernelTurnExecutor::new(paths);
    let previous = Arc::new(ActiveTurn {
        turn_id: Mutex::new(first.id.clone()),
        cancelled: AtomicBool::new(false),
        done: AtomicBool::new(false),
        kernel: Mutex::new(None),
        cancelled_agents: Mutex::new(std::collections::HashSet::new()),
    });
    executor
        .runtime
        .active
        .lock()
        .unwrap()
        .insert(thread.id.clone(), Arc::clone(&previous));
    let mut request = TurnRequest {
        thread_id: thread.id.clone(),
        turn_id: store.start_turn(&thread.id).unwrap().id,
        prompt: "next".into(),
        read_only: true,
        settings: KernelTurnSettings::default(),
        // An explicit advance policy makes this exact window the runner's
        // between-rounds state: the finished Turn is terminal while the
        // runner decides whether to admit the next one.
        advance: Some(json!({"maxRounds": 5})),
    };
    // The live runner (done=false) must keep thread ownership between
    // rounds; a new start replaces nothing and must not spawn a second
    // Kernel round on this thread.
    assert!(matches!(
        TurnExecutor::start_turn(&mut executor, &request, Arc::clone(&store)),
        Err(ProtocolError {
            category: ErrorCategory::Conflict,
            ..
        })
    ));
    assert!(
        Arc::ptr_eq(
            &executor.runtime.active.lock().unwrap()[&thread.id],
            &previous
        ),
        "the between-rounds runner keeps registry ownership"
    );
    // Ownership ends only with the runner: after done, admission proceeds
    // (this runner then fails on the missing provider fixture and leaves a
    // durable failed Turn instead of a silent replacement).
    previous.done.store(true, Ordering::SeqCst);
    let mut other_thread_request = request.clone();
    other_thread_request.thread_id = store
        .create_thread(&workspace.id, "task", None, None)
        .unwrap()
        .id;
    TurnExecutor::start_turn(&mut executor, &other_thread_request, Arc::clone(&store))
        .expect("another thread is never blocked by this thread's runner");
    executor
        .await_turn_done(&other_thread_request.thread_id, Duration::from_secs(10))
        .expect("the fixture runner finishes without a provider");
    let deadline = Instant::now() + Duration::from_secs(5);
    while executor
        .runtime
        .active
        .lock()
        .unwrap()
        .contains_key(&other_thread_request.thread_id)
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        !executor
            .runtime
            .active
            .lock()
            .unwrap()
            .contains_key(&other_thread_request.thread_id),
        "the admitted runner removes its own registry entry on exit"
    );
}

#[test]
fn legacy_sidecar_bindings_are_imported_idempotently_and_preserved() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let paths = knorvia_platform_paths::layout(std::env::temp_dir().join(format!(
        "knorvia-binding-migration-{}-{unique}",
        std::process::id()
    )));
    paths.ensure_layout().unwrap();
    let product = paths.state.join("product");
    fs::create_dir_all(&product).unwrap();
    let sidecar = product.join(KERNEL_THREAD_MAP_FILE);
    fs::write(
        &sidecar,
        serde_json::to_vec_pretty(&json!({"thr_legacy": "kernel-legacy"})).unwrap(),
    )
    .unwrap();
    let executor = KernelTurnExecutor::new(paths.clone());
    let (_, map) = executor.runtime.durable_bindings().unwrap();
    assert_eq!(
        map.get("thr_legacy").map(String::as_str),
        Some("kernel-legacy"),
        "the legacy sidecar entry is visible through durable bindings"
    );
    assert!(
        product.join("kernel-bindings").join("thr_legacy.json").exists(),
        "the binding is now a durable projection document"
    );
    assert!(sidecar.exists(), "the old sidecar is retained, never deleted");
    // A second pass (e.g. after restart) neither duplicates nor rebinds.
    let (_, again) = executor.runtime.durable_bindings().unwrap();
    assert_eq!(again.len(), 1);
    assert_eq!(
        again.get("thr_legacy").map(String::as_str),
        Some("kernel-legacy")
    );
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
        advance: None,
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
