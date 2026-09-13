use super::durable::{DurableFailpoint, inject_failure};
use super::*;
use knorvia_platform_paths::layout;
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static FAILPOINT_TEST_LOCK: Mutex<()> = Mutex::new(());

fn temp_paths() -> (KnorviaPaths, PathBuf) {
    let home = std::env::temp_dir().join(format!(
        "knorvia-store-durable-tests-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&home).unwrap();
    (layout(home.clone()), home)
}

fn thread_for(store: &ProductStore) -> Thread {
    let workspace = store.create_workspace("durable tests").unwrap();
    store
        .create_thread(&workspace.id, "thread", None, None)
        .unwrap()
}

fn assert_contiguous(events: &[EventEnvelope]) {
    let sequences = events.iter().map(|event| event.seq).collect::<Vec<_>>();
    let expected = (1..=u64::try_from(events.len()).unwrap()).collect::<Vec<_>>();
    assert_eq!(sequences, expected);
    let ids = events
        .iter()
        .map(|event| event.event_id.clone())
        .collect::<HashSet<_>>();
    assert_eq!(ids.len(), events.len());
}

fn recovery_evidence_exists(paths: &KnorviaPaths) -> bool {
    fs::read_dir(paths.state.join("store-recovery"))
        .unwrap()
        .any(|entry| entry.is_ok())
}

#[test]
fn restart_recovers_intent_written_before_projection() {
    let _failpoint = FAILPOINT_TEST_LOCK.lock().unwrap();
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths.clone()).unwrap();
    let thread = thread_for(&store);

    inject_failure(DurableFailpoint::AfterIntentPersisted);
    let error = store.start_turn(&thread.id).unwrap_err();
    assert!(matches!(error, StoreError::Io(_)));
    assert!(matches!(
        store.read_turn("missing"),
        Err(StoreError::Protocol(_))
    ));
    drop(store);

    let restarted = ProductStore::open(paths).unwrap();
    let turns = restarted.list_turns(&thread.id).unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].status, "running");
    let item = restarted
        .append_item(
            &thread.id,
            &turns[0].id,
            "agentMessage",
            "completed",
            serde_json::json!({"text": "after restart"}),
        )
        .unwrap();
    let events = restarted.replay(&thread.id, 0).unwrap();
    assert_contiguous(&events);
    assert!(events.iter().any(|event| {
        event.kind == "turn.started"
            && event.payload.get("id").and_then(Value::as_str) == Some(turns[0].id.as_str())
    }));
    assert_eq!(item.seq, events.last().unwrap().seq);
    drop(restarted);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn restart_rebuilds_event_after_projection_only_crash() {
    let _failpoint = FAILPOINT_TEST_LOCK.lock().unwrap();
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths.clone()).unwrap();
    let thread = thread_for(&store);
    let turn = store.start_turn(&thread.id).unwrap();

    inject_failure(DurableFailpoint::AfterProjectionApplied);
    let error = store
        .append_item(
            &thread.id,
            &turn.id,
            "agentMessage",
            "completed",
            serde_json::json!({"text": "projection first"}),
        )
        .unwrap_err();
    assert!(matches!(error, StoreError::Io(_)));
    let persisted = store.list_items(&thread.id).unwrap();
    assert_eq!(persisted.len(), 1);
    let journal = fs::read(store.events_path(&thread.id)).unwrap();
    assert!(!String::from_utf8_lossy(&journal).contains(&persisted[0].id));
    drop(store);

    let restarted = ProductStore::open(paths).unwrap();
    let recovered_items = restarted.list_items(&thread.id).unwrap();
    assert_eq!(
        serde_json::to_value(recovered_items).unwrap(),
        serde_json::to_value(persisted).unwrap()
    );
    let events = restarted.replay(&thread.id, 0).unwrap();
    assert_contiguous(&events);
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "item.appended")
            .count(),
        1
    );
    drop(restarted);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn trailing_half_line_is_preserved_then_rebuilt_without_reusing_sequence() {
    let _failpoint = FAILPOINT_TEST_LOCK.lock().unwrap();
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths.clone()).unwrap();
    let thread = thread_for(&store);
    let turn = store.start_turn(&thread.id).unwrap();

    inject_failure(DurableFailpoint::AfterProjectionApplied);
    let _ = store.append_item(
        &thread.id,
        &turn.id,
        "agentMessage",
        "completed",
        serde_json::json!({"text": "torn journal"}),
    );
    let journal_path = store.events_path(&thread.id);
    let mut journal = OpenOptions::new().append(true).open(&journal_path).unwrap();
    journal.write_all(b"{\"eventId\":\"torn").unwrap();
    journal.sync_all().unwrap();
    drop(journal);
    drop(store);

    let restarted = ProductStore::open(paths.clone()).unwrap();
    assert!(recovery_evidence_exists(&paths));
    let existing = restarted.list_items(&thread.id).unwrap();
    assert_eq!(existing.len(), 1);
    let next = restarted
        .append_item(
            &thread.id,
            &turn.id,
            "agentMessage",
            "completed",
            serde_json::json!({"text": "next"}),
        )
        .unwrap();
    assert!(next.seq > existing[0].seq);
    let events = restarted.replay(&thread.id, 0).unwrap();
    assert_contiguous(&events);
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "item.appended")
            .count(),
        2
    );
    drop(restarted);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn middle_journal_corruption_fails_closed_and_keeps_evidence() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths.clone()).unwrap();
    let thread = thread_for(&store);
    let _ = store.start_turn(&thread.id).unwrap();
    let journal_path = store.events_path(&thread.id);
    let raw = fs::read(&journal_path).unwrap();
    let first_line_end = raw.iter().position(|byte| *byte == b'\n').unwrap() + 1;
    let mut corrupted = raw[..first_line_end].to_vec();
    corrupted.extend_from_slice(b"{this is not valid JSON}\n");
    corrupted.extend_from_slice(&raw[first_line_end..]);
    fs::write(&journal_path, &corrupted).unwrap();
    drop(store);

    let error = ProductStore::open(paths.clone()).unwrap_err();
    assert!(matches!(error, StoreError::Corrupt(_)));
    assert_eq!(fs::read(&journal_path).unwrap(), corrupted);
    assert!(recovery_evidence_exists(&paths));
    let _ = fs::remove_dir_all(home);
}

#[test]
fn item_pages_use_durable_sequence_cursors() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths).unwrap();
    let thread = thread_for(&store);
    let turn = store.start_turn(&thread.id).unwrap();
    for text in ["one", "two", "three"] {
        store
            .append_item(
                &thread.id,
                &turn.id,
                "agentMessage",
                "completed",
                serde_json::json!({"text": text}),
            )
            .unwrap();
    }
    let first = store.list_items_page(&thread.id, None, 2).unwrap();
    assert_eq!(first.data.len(), 2);
    assert_eq!(first.next_cursor, Some(first.data[1].seq));
    let second = store
        .list_items_page(&thread.id, first.next_cursor, 2)
        .unwrap();
    assert_eq!(second.data.len(), 1);
    assert_eq!(second.next_cursor, None);
    assert!(second.data[0].seq > first.data[1].seq);
    let _ = fs::remove_dir_all(home);
}

/// A client paging through history while the turn keeps producing items must
/// observe every item exactly once. The durable sequence cursor, not the page
/// count, decides the boundary, so inserts between pages land in exactly one
/// page and never reorder or duplicate.
#[test]
fn items_appended_between_pages_appear_exactly_once() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths).unwrap();
    let thread = thread_for(&store);
    let turn = store.start_turn(&thread.id).unwrap();
    for text in ["a", "b", "c"] {
        store
            .append_item(
                &thread.id,
                &turn.id,
                "agentMessage",
                "completed",
                serde_json::json!({"text": text}),
            )
            .unwrap();
    }
    let first = store.list_items_page(&thread.id, None, 2).unwrap();
    assert_eq!(
        first
            .data
            .iter()
            .map(|item| item.payload["text"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );

    // New history lands while the client is between pages.
    for text in ["d", "e"] {
        store
            .append_item(
                &thread.id,
                &turn.id,
                "agentMessage",
                "completed",
                serde_json::json!({"text": text}),
            )
            .unwrap();
    }

    let mut seen = Vec::new();
    let mut cursor = first.next_cursor;
    loop {
        let page = store.list_items_page(&thread.id, cursor, 2).unwrap();
        seen.extend(
            page.data
                .iter()
                .map(|item| item.payload["text"].as_str().unwrap().to_string()),
        );
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(
        seen,
        ["c", "d", "e"]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>(),
        "paged replay after mid-page inserts must have no gaps or duplicates"
    );
    let _ = fs::remove_dir_all(home);
}

/// Idempotency keys are scoped to one method. A key recorded for one method
/// must never serve a cached result to a different method, and the conflict
/// must be a typed error the client can attribute.
#[test]
fn idempotency_keys_are_scoped_to_their_method() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths).unwrap();
    let result = serde_json::json!({"workspace": {"id": "ws_1"}});
    store
        .remember_idempotent("client-op-1", "workspace/create", "fp-op-1", &result)
        .unwrap();
    let recalled = store
        .recall_idempotent("client-op-1", "workspace/create", "fp-op-1")
        .unwrap();
    assert_eq!(recalled, Some(result));

    let conflict = store
        .recall_idempotent("client-op-1", "turn/start", "fp-turn")
        .err()
        .expect("a foreign method must not reuse another method's key");
    let protocol = conflict.into_protocol();
    assert_eq!(
        protocol.category,
        knorvia_protocol::ErrorCategory::Conflict,
        "typed conflict, not a silent cache hit"
    );

    assert_eq!(
        store
            .recall_idempotent("never-seen", "turn/start", "fp-any")
            .unwrap(),
        None,
        "an unseen key must not fake a cached result"
    );
    let _ = fs::remove_dir_all(home);
}

/// A crash between a method's side effects and its result store leaves a
/// pending idempotency record. Replaying that key must return a typed
/// "outcome unknown" instead of silently re-executing the write.
#[test]
fn pending_idempotent_record_demands_a_query_instead_of_a_replay() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths).unwrap();
    assert_eq!(
        store
            .begin_idempotent("crash-key", "workspace/create", "fp-crash")
            .unwrap(),
        None,
        "a fresh key starts pending with no cached result"
    );
    let conflict = store
        .recall_idempotent("crash-key", "workspace/create", "fp-crash")
        .err()
        .expect("a pending record must not look like a missing one");
    assert_eq!(
        conflict.into_protocol().category,
        knorvia_protocol::ErrorCategory::Conflict
    );

    // Completing the attempt serves the durable result from now on.
    store
        .remember_idempotent(
            "crash-key",
            "workspace/create",
            "fp-crash",
            &serde_json::json!({"ok": true}),
        )
        .unwrap();
    assert_eq!(
        store
            .recall_idempotent("crash-key", "workspace/create", "fp-crash")
            .unwrap(),
        Some(serde_json::json!({"ok": true}))
    );
    let _ = fs::remove_dir_all(home);
}

/// A failed attempt that may have produced effects keeps an attributable
/// marker; a side-effect-free validation failure clears the key so honest
/// retries stay possible.
#[test]
fn failed_idempotent_attempts_are_attributable_and_clean_failures_stay_retryable() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths).unwrap();
    store
        .begin_idempotent("dirty-key", "turn/start", "fp-dirty")
        .unwrap();
    store
        .fail_idempotent(
            "dirty-key",
            "turn/start",
            "fp-dirty",
            "provider exploded mid-turn",
        )
        .unwrap();
    let replay = store
        .recall_idempotent("dirty-key", "turn/start", "fp-dirty")
        .err()
        .expect("a failed attempt must not be silently replayed");
    assert_eq!(
        replay.into_protocol().category,
        knorvia_protocol::ErrorCategory::Conflict
    );

    store
        .begin_idempotent("clean-key", "workspace/create", "fp-clean")
        .unwrap();
    store.clear_idempotent("clean-key").unwrap();
    assert_eq!(
        store
            .recall_idempotent("clean-key", "workspace/create", "fp-clean")
            .unwrap(),
        None,
        "a cleared key is honestly retryable"
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn workspace_title_and_cwd_share_one_revision() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths).unwrap();
    let workspace = store
        .create_workspace_with_cwd("draft", Some("D:/work"))
        .unwrap();
    let updated = store
        .update_workspace_with_cwd(
            &workspace.id,
            Some("final"),
            WorkspaceCwdUpdate::Set("D:/final"),
            Some(workspace.revision),
        )
        .unwrap();
    assert_eq!(updated.revision, workspace.revision + 1);
    assert_eq!(updated.title, "final");
    assert_eq!(
        store.read_workspace_cwd(&workspace.id).unwrap(),
        Some("D:/final".to_string())
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn fork_snapshots_history_without_copying_a_live_owner() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths.clone()).unwrap();
    let source = thread_for(&store);

    let completed = store.start_turn(&source.id).unwrap();
    let original_item = store
        .append_item(
            &source.id,
            &completed.id,
            "agentMessage",
            "completed",
            serde_json::json!({"text": "history"}),
        )
        .unwrap();
    let approval = store
        .create_approval(&source.id, &completed.id, "write", "digest")
        .unwrap();
    store.respond_approval(&approval.id, "allow").unwrap();
    store.complete_turn(&completed.id, "completed").unwrap();

    let active = store.start_turn(&source.id).unwrap();
    let waiting = store
        .append_item(
            &source.id,
            &active.id,
            "userInput",
            "waiting_input",
            serde_json::json!({"request": {"questions": [{"id": "q"}]}}),
        )
        .unwrap();

    let child = store
        .fork_thread(&source.id, "fork", Some(source.revision))
        .unwrap();
    assert_ne!(child.id, source.id);
    let child_turns = store.list_turns(&child.id).unwrap();
    assert_eq!(child_turns.len(), 2);
    assert!(
        child_turns
            .iter()
            .all(|turn| turn.id != completed.id && turn.id != active.id)
    );
    assert!(child_turns.iter().any(|turn| turn.status == "completed"));
    assert!(child_turns.iter().any(|turn| turn.status == "interrupted"));
    assert!(child_turns.iter().all(|turn| turn.status != "running"));

    let child_items = store.list_items(&child.id).unwrap();
    assert_eq!(child_items.len(), 2);
    assert!(
        child_items
            .iter()
            .all(|item| item.id != original_item.id && item.id != waiting.id)
    );
    assert!(
        child_items
            .iter()
            .any(|item| item.payload == original_item.payload)
    );
    assert!(
        child_items
            .iter()
            .any(|item| item.kind == "userInput" && item.status == "interrupted")
    );
    let child_approvals = store.list_approvals(&child.id).unwrap();
    assert_eq!(child_approvals.len(), 1);
    assert_ne!(child_approvals[0].id, approval.id);
    assert_eq!(child_approvals[0].status, "allowed");

    let events = store.replay(&child.id, 0).unwrap();
    assert_contiguous(&events);
    assert!(events.iter().any(|event| event.kind == "thread.forked"));
    for item in &child_items {
        let event = events
            .iter()
            .find(|event| {
                event.kind == "item.appended"
                    && event.payload.get("id").and_then(Value::as_str) == Some(item.id.as_str())
            })
            .unwrap();
        assert_eq!(event.seq, item.seq);
    }
    assert!(store.start_turn(&child.id).is_ok());

    drop(store);
    let reopened = ProductStore::open(paths).unwrap();
    assert_eq!(reopened.list_turns(&child.id).unwrap().len(), 3);
    assert_eq!(reopened.list_items(&child.id).unwrap().len(), 2);
    assert_eq!(reopened.list_approvals(&child.id).unwrap().len(), 1);
    drop(reopened);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn fork_intent_recovers_the_entire_snapshot_after_restart() {
    let _failpoint = FAILPOINT_TEST_LOCK.lock().unwrap();
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths.clone()).unwrap();
    let source = thread_for(&store);
    let turn = store.start_turn(&source.id).unwrap();
    store
        .append_item(
            &source.id,
            &turn.id,
            "agentMessage",
            "completed",
            serde_json::json!({"text": "snapshot"}),
        )
        .unwrap();
    store.complete_turn(&turn.id, "completed").unwrap();

    inject_failure(DurableFailpoint::AfterIntentPersisted);
    assert!(matches!(
        store.fork_thread(&source.id, "fork", None),
        Err(StoreError::Io(_))
    ));
    drop(store);

    let reopened = ProductStore::open(paths.clone()).unwrap();
    let children = reopened
        .list_threads(&source.workspace_id)
        .unwrap()
        .into_iter()
        .filter(|thread| thread.id != source.id)
        .collect::<Vec<_>>();
    assert_eq!(children.len(), 1);
    let child = &children[0];
    assert_eq!(reopened.list_turns(&child.id).unwrap().len(), 1);
    assert_eq!(reopened.list_items(&child.id).unwrap().len(), 1);
    assert_contiguous(&reopened.replay(&child.id, 0).unwrap());
    drop(reopened);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn deterministic_projection_path_failure_leaves_no_pending_item_transaction() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths.clone()).unwrap();
    let thread = thread_for(&store);
    let turn = store.start_turn(&thread.id).unwrap();
    let wal_before = fs::read_dir(paths.state.join("store-wal")).unwrap().count();
    let items_dir = paths.state.join("product").join("items");
    fs::write(&items_dir, b"not a directory").unwrap();

    assert!(matches!(
        store.append_item(
            &thread.id,
            &turn.id,
            "error",
            "failed",
            serde_json::json!({"message": "cannot persist"}),
        ),
        Err(StoreError::Io(_))
    ));
    assert_eq!(
        fs::read_dir(paths.state.join("store-wal")).unwrap().count(),
        wal_before
    );
    assert_eq!(
        store
            .complete_turn_idempotent(&turn.id, "failed")
            .unwrap()
            .status,
        "failed"
    );
    drop(store);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn projection_cannot_change_owning_stream() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths).unwrap();
    let thread = thread_for(&store);
    let write = store
        .projection_write(ProjectionKind::Thread, &thread.id, &thread)
        .unwrap();
    let _mutations = store.lock_mutations().unwrap();
    let _journal = store.lock_journal().unwrap();
    let error = store
        .commit_transaction_locked(
            "foreign-stream",
            "thread.invalid",
            serde_json::to_value(&thread).unwrap(),
            None,
            vec![write],
        )
        .unwrap_err();
    assert!(matches!(error, StoreError::Corrupt(_)));
    drop(_journal);
    drop(_mutations);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn delivery_failure_corrects_an_item_even_after_its_turn_is_terminal() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths).unwrap();
    let thread = thread_for(&store);
    let turn = store.start_turn(&thread.id).unwrap();
    let item = store
        .append_item(
            &thread.id,
            &turn.id,
            "userInput",
            "waiting_input",
            serde_json::json!({"request": {"questions": []}}),
        )
        .unwrap();
    store
        .resolve_item(
            &item.id,
            "answered",
            serde_json::json!({"request": {"questions": []}, "answers": {}}),
        )
        .unwrap();
    store.complete_turn(&turn.id, "completed").unwrap();
    let corrected = store
        .mark_item_delivery_failed(
            &item.id,
            serde_json::json!({"request": {"questions": []}, "answers": {}, "error": "owner stopped"}),
        )
        .unwrap();
    assert_eq!(corrected.status, "delivery_failed");
    assert!(
        store
            .replay(&thread.id, 0)
            .unwrap()
            .iter()
            .any(|event| event.kind == "item.delivery_failed")
    );
    drop(store);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn crash_recovery_atomically_closes_pending_input_and_approval() {
    let _failpoint = FAILPOINT_TEST_LOCK.lock().unwrap();
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths.clone()).unwrap();
    let thread = thread_for(&store);
    let turn = store.start_turn(&thread.id).unwrap();
    let input = store
        .append_item(
            &thread.id,
            &turn.id,
            "userInput",
            "waiting_input",
            serde_json::json!({"request": {"questions": [{"id": "q"}]}}),
        )
        .unwrap();
    let approval = store
        .create_approval(&thread.id, &turn.id, "kernel.commandExecution", "digest")
        .unwrap();
    let approval_item = store
        .append_item(
            &thread.id,
            &turn.id,
            "tool.write",
            "waiting_approval",
            serde_json::json!({"approvalId": approval.id}),
        )
        .unwrap();

    inject_failure(DurableFailpoint::AfterIntentPersisted);
    assert!(matches!(
        store.recover_incomplete_turns(),
        Err(StoreError::Io(_))
    ));
    drop(store);

    let reopened = ProductStore::open(paths).unwrap();
    assert_eq!(reopened.read_turn(&turn.id).unwrap().status, "interrupted");
    let recovered_input = reopened.read_item(&input.id).unwrap();
    assert_eq!(recovered_input.status, "interrupted");
    assert_eq!(
        recovered_input.payload["request"]["questions"][0]["id"],
        "q"
    );
    assert_eq!(
        reopened.read_item(&approval_item.id).unwrap().status,
        "interrupted"
    );
    // A restart proves the owner is gone, not that the user denied: the
    // recovery records the owner_lost system resolution (A03).
    assert_eq!(
        reopened.read_approval(&approval.id).unwrap().status,
        "owner_lost"
    );
    assert!(reopened.recover_incomplete_turns().unwrap().is_empty());
    let events = reopened.replay(&thread.id, 0).unwrap();
    assert_contiguous(&events);
    assert!(
        events
            .iter()
            .any(|event| event.kind == "approval.systemResolved")
    );
    assert!(events.iter().any(|event| event.kind == "item.interrupted"));
    assert!(events.iter().any(|event| {
        event.kind == "turn.completed"
            && event.payload.get("status").and_then(Value::as_str) == Some("interrupted")
    }));
    drop(reopened);
    let _ = fs::remove_dir_all(home);
}

/// Manual evidence probe for the workspace thread index at acceptance scale.
/// Run with `KNORVIA_STORE_BENCH_THREADS=10000 cargo test -p knorvia-store
/// thread_index_benchmark -- --ignored --nocapture`.
#[test]
#[ignore = "manual index performance evidence"]
fn thread_index_benchmark() {
    let thread_count = std::env::var("KNORVIA_STORE_BENCH_THREADS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1_000);
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths).unwrap();
    let workspace = store.create_workspace("index benchmark").unwrap();
    for index in 0..thread_count {
        store
            .create_thread(&workspace.id, &format!("thread {index}"), None, None)
            .unwrap();
    }
    let started = Instant::now();
    let threads = store.list_threads(&workspace.id).unwrap();
    let elapsed = started.elapsed();
    eprintln!(
        "store benchmark: threads={thread_count}, list_threads_ms={} (target <= 1000ms)",
        elapsed.as_millis()
    );
    assert_eq!(threads.len(), thread_count);
    let _ = fs::remove_dir_all(home);
}

/// Cursor paging over the thread index must walk every thread exactly once
/// with a stable restart-safe cursor, regardless of page size.
#[test]
fn thread_index_paging_walks_every_thread_exactly_once() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths).unwrap();
    let workspace = store.create_workspace("paged index").unwrap();
    let other = store.create_workspace("other").unwrap();
    for index in 0..25 {
        store
            .create_thread(&workspace.id, &format!("t{index}"), None, None)
            .unwrap();
    }
    // A thread from another workspace shares the Home; the cursor must walk
    // past it without losing or duplicating workspace threads.
    store
        .create_thread(&other.id, "foreign", None, None)
        .unwrap();

    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let (page, next) = store
            .list_threads_page(&workspace.id, cursor.as_deref(), 7)
            .unwrap();
        seen.extend(page.iter().map(|t| t.id.clone()));
        match next {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(seen.len(), 25, "every thread paged exactly once");
    assert_eq!(
        seen.iter().collect::<std::collections::HashSet<_>>().len(),
        25,
        "no duplicate ids across pages"
    );
    let _ = fs::remove_dir_all(home);
}

/// A manual evidence probe for the long-history path.
#[test]
#[ignore = "manual durability performance evidence"]
fn append_history_benchmark() {
    let item_count = std::env::var("KNORVIA_STORE_BENCH_ITEMS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1_000);
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths.clone()).unwrap();
    let workspace = store.create_workspace("history benchmark").unwrap();
    let mut threads = Vec::new();
    for index in 0..4 {
        let thread = store
            .create_thread(&workspace.id, &format!("thread {index}"), None, None)
            .unwrap();
        let turn = store.start_turn(&thread.id).unwrap();
        threads.push((thread, turn));
    }

    let append_started = Instant::now();
    for index in 0..item_count {
        let (thread, turn) = &threads[index % threads.len()];
        store
            .append_item(
                &thread.id,
                &turn.id,
                "agentMessage",
                "completed",
                serde_json::json!({"text": format!("item {index}")}),
            )
            .unwrap();
    }
    let append_elapsed = append_started.elapsed();
    let replay_started = Instant::now();
    let replayed = threads
        .iter()
        .map(|(thread, _)| store.replay(&thread.id, 0).unwrap().len())
        .sum::<usize>();
    let replay_elapsed = replay_started.elapsed();
    let journal_bytes = fs::read_dir(paths.state.join("events"))
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.metadata().unwrap().len())
        .sum::<u64>();
    eprintln!(
        "store benchmark: items={item_count}, threads=4, append_ms={}, replay_ms={}, replayed_events={replayed}, journal_bytes={journal_bytes}",
        append_elapsed.as_millis(),
        replay_elapsed.as_millis(),
    );
    assert!(replayed >= item_count);

    // PERF-02 evidence: paged reads over the deep history and the workspace
    // index must stay far below the 1 s first-screen/paging target even at
    // six-figure item counts.
    let mut page_samples: Vec<(std::string::String, u128)> = Vec::new();
    for (thread, _) in &threads {
        let first_started = Instant::now();
        let first_page = store.list_items_page(&thread.id, None, 50).unwrap();
        page_samples.push(("first_page".into(), first_started.elapsed().as_millis()));
        assert_eq!(first_page.data.len(), 50);
        if let Some(cursor) = first_page.next_cursor {
            let middle_started = Instant::now();
            let middle_page = store.list_items_page(&thread.id, Some(cursor), 50).unwrap();
            page_samples.push(("middle_page".into(), middle_started.elapsed().as_millis()));
            assert_eq!(middle_page.data.len(), 50);
            assert!(middle_page.data[0].seq > cursor);
        }
        let last_started = Instant::now();
        let last_page = store.list_items_page(&thread.id, None, 50_000).unwrap();
        page_samples.push(("full_scan_last".into(), last_started.elapsed().as_millis()));
        assert!(!last_page.data.is_empty());
    }
    let index_started = Instant::now();
    let workspaces = store.list_workspaces().unwrap();
    page_samples.push((
        "workspace_index".into(),
        index_started.elapsed().as_millis(),
    ));
    assert!(!workspaces.is_empty());
    for (name, millis) in &page_samples {
        eprintln!("store benchmark page: {name}={millis}ms");
    }

    drop(store);
    let _ = fs::remove_dir_all(home);
}

/// A03 contract: the idempotency identity includes a request fingerprint.
/// Same key + same method + a different payload is a recycled key - a typed
/// conflict, never a foreign replayed result.
#[test]
fn idempotency_key_recycled_for_a_different_payload_is_a_conflict() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths).unwrap();
    store
        .remember_idempotent(
            "shared-key",
            "workspace/create",
            "fp-for-title-a",
            &serde_json::json!({"id": "ws_a"}),
        )
        .unwrap();
    let err = store
        .recall_idempotent("shared-key", "workspace/create", "fp-for-title-b")
        .err()
        .expect("recycled key must not serve the old result");
    assert_eq!(
        err.into_protocol().category,
        knorvia_protocol::ErrorCategory::Conflict
    );
    // The genuine replay still hits the cached result.
    assert_eq!(
        store
            .recall_idempotent("shared-key", "workspace/create", "fp-for-title-a")
            .unwrap()
            .unwrap()["id"],
        serde_json::json!("ws_a")
    );
    let _ = fs::remove_dir_all(home);
}

/// A03 contract: record file names are a hash of the key, so hostile or
/// pathological keys (traversal, separators, Windows device names) can never
/// escape the idempotency directory or create illegal files, and bounded
/// empty/oversize keys are typed rejections.
#[test]
fn hostile_and_pathological_keys_stay_bounded_and_safe() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths).unwrap();
    let idem_dir = home.join("state").join("idempotency");

    // Empty and oversize keys are rejected before touching the disk.
    for bad in ["", "x".repeat(257).as_str()] {
        let err = store
            .begin_idempotent(bad, "workspace/create", "fp")
            .err()
            .expect("bounded keys are enforced");
        assert_eq!(
            err.into_protocol().category,
            knorvia_protocol::ErrorCategory::InvalidArgument
        );
    }

    // Hostile but in-bounds keys are made safe by the hashed layout.
    for hostile in ["../escape", r"back\slash", "CON", "a/b/c"] {
        store
            .remember_idempotent(
                hostile,
                "workspace/create",
                "fp",
                &serde_json::json!({"ok": true}),
            )
            .unwrap();
        assert_eq!(
            store
                .recall_idempotent(hostile, "workspace/create", "fp")
                .unwrap()
                .unwrap()["ok"],
            serde_json::json!(true)
        );
    }
    let records_dir = idem_dir.join("records");
    let entries: Vec<_> = std::fs::read_dir(&records_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(
        entries.len(),
        4,
        "one hashed file per hostile key, in the records namespace: {entries:?}"
    );
    for name in &entries {
        assert_eq!(
            name.len(),
            64 + 5,
            "hex sha256 stem + .json, never a key-derived name: {name}"
        );
    }
    // The hostile keys must not have produced anything in the legacy
    // namespace either (no traversal artifacts, no device files).
    let legacy: Vec<_> = std::fs::read_dir(&idem_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".json"))
        .collect();
    assert!(
        legacy.is_empty(),
        "hostile keys never write legacy-named records: {legacy:?}"
    );
    let _ = fs::remove_dir_all(home);
}

/// A03 contract: pre-fingerprint records written by older builds (stored as
/// `{key}.json` for safe keys) stay replayable and migrate to the hashed
/// layout on the next write instead of being lost or duplicated.
#[test]
fn legacy_idempotency_records_remain_replayable_and_migrate() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths).unwrap();
    let idem_dir = home.join("state").join("idempotency");
    let legacy = serde_json::json!({
        "key": "old-key",
        "method": "workspace/create",
        "state": "completed",
        "result": {"id": "ws_old"}
    });
    std::fs::write(
        idem_dir.join("old-key.json"),
        serde_json::to_vec_pretty(&legacy).unwrap(),
    )
    .unwrap();
    assert_eq!(
        store
            .recall_idempotent("old-key", "workspace/create", "any-fingerprint")
            .unwrap()
            .unwrap()["id"],
        serde_json::json!("ws_old"),
        "legacy record replays regardless of fingerprint (compat)"
    );
    // The next write migrates the outcome to the hashed name.
    store
        .remember_idempotent(
            "old-key",
            "workspace/create",
            "fp-new",
            &serde_json::json!({"id": "ws_new"}),
        )
        .unwrap();
    assert_eq!(
        store
            .recall_idempotent("old-key", "workspace/create", "fp-new")
            .unwrap()
            .unwrap()["id"],
        serde_json::json!("ws_new")
    );
    let _ = fs::remove_dir_all(home);
}

/// A03 contract: concurrent replays of one COMPLETED key serialize on
/// the store mutation lock - every racer is served the durable result
/// instead of re-executing, records stay coherent under concurrent
/// remember, and a pending record from an interrupted attempt is never
/// blindly replayed (typed conflict demands a state query instead).
#[test]
fn concurrent_replays_of_one_key_converge_to_one_outcome() {
    let (paths, home) = temp_paths();
    let store = std::sync::Arc::new(ProductStore::open(paths).unwrap());
    store
        .remember_idempotent(
            "race-key",
            "workspace/create",
            "fp-race",
            &serde_json::json!({"round": 0}),
        )
        .unwrap();
    let mut handles = Vec::new();
    for t in 0..8u32 {
        let store = std::sync::Arc::clone(&store);
        handles.push(std::thread::spawn(move || {
            for round in 0..8u32 {
                let cached = store
                    .begin_idempotent("race-key", "workspace/create", "fp-race")
                    .unwrap();
                assert!(
                    cached.is_some(),
                    "a completed key serves its durable result, never re-executes"
                );
                store
                    .remember_idempotent(
                        "race-key",
                        "workspace/create",
                        "fp-race",
                        &serde_json::json!({"winner": t, "round": round}),
                    )
                    .unwrap();
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    let value = store
        .recall_idempotent("race-key", "workspace/create", "fp-race")
        .unwrap()
        .expect("a durable outcome exists");
    assert!(value["round"].is_u64(), "one coherent record, got {value}");

    // A pending record left by an interrupted attempt must not be
    // blindly replayed by a racing thread: typed conflict only.
    store
        .begin_idempotent("interrupted-key", "workspace/create", "fp-i")
        .unwrap();
    let err = store
        .begin_idempotent("interrupted-key", "workspace/create", "fp-i")
        .err()
        .expect("pending record must not look replayable");
    assert_eq!(
        err.into_protocol().category,
        knorvia_protocol::ErrorCategory::Conflict
    );
    let _ = fs::remove_dir_all(home);
}

/// CODEX-0030-A #2: a key whose text equals another key's hashed file name
/// (k2 = hex(sha256(k1))) must not read k1's record through the legacy
/// fallback, and a legacy record named as a 64-hex key must not shadow k1's
/// namespaced record. Namespaces are disjoint and records carry their key.
#[test]
fn hash_and_legacy_namespaces_cannot_shadow_each_other() {
    use sha2::{Digest, Sha256};
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths).unwrap();
    let idem_dir = home.join("state").join("idempotency");
    let k1 = "review-original";
    let k2 = hex::encode(Sha256::digest(k1.as_bytes()));
    assert_eq!(
        k2.len(),
        64,
        "k2 is a 64-hex string, exactly the legacy-safe shape"
    );

    // k1 records normally (namespaced file records/<sha256(k1)>.json).
    store
        .remember_idempotent(
            k1,
            "workspace/create",
            "fp-k1",
            &serde_json::json!({"id": "ws_k1"}),
        )
        .unwrap();

    // k2 has NO record: it must not hit k1's record via the legacy lookup
    // (old code read idempotency/<k2>.json = k1's hashed file).
    assert_eq!(
        store
            .recall_idempotent(&k2, "workspace/create", "fp-k1")
            .unwrap(),
        None,
        "k2 must not replay k1's record through the legacy fallback"
    );

    // Reverse shadow: a legacy-format record whose file name IS k2 must not
    // hide k1's namespaced record from k1.
    let legacy_of_k2 = serde_json::json!({
        "key": k2,
        "method": "workspace/create",
        "state": "completed",
        "result": {"id": "ws_k2"}
    });
    std::fs::write(
        idem_dir.join(format!("{k2}.json")),
        serde_json::to_vec_pretty(&legacy_of_k2).unwrap(),
    )
    .unwrap();
    assert_eq!(
        store
            .recall_idempotent(k1, "workspace/create", "fp-k1")
            .unwrap()
            .unwrap()["id"],
        serde_json::json!("ws_k1"),
        "k1 still reads its own namespaced record"
    );
    // And k2's own legacy record still works for k2 (compat preserved).
    assert_eq!(
        store
            .recall_idempotent(&k2, "workspace/create", "any-fp")
            .unwrap()
            .unwrap()["id"],
        serde_json::json!("ws_k2"),
    );
    let _ = fs::remove_dir_all(home);
}

/// CODEX-0030-A #2: a record file that does not declare the requested key
/// is absent for that key — never leaked, never replayed.
#[test]
fn record_key_is_verified_before_any_replay() {
    let (paths, home) = temp_paths();
    let store = ProductStore::open(paths).unwrap();
    store
        .remember_idempotent(
            "key-a",
            "workspace/create",
            "fp-a",
            &serde_json::json!({"id": "ws_a"}),
        )
        .unwrap();

    // A key whose hashed file exists but whose record claims another key.
    let forged = serde_json::json!({
        "key": "key-b",
        "method": "workspace/create",
        "state": "completed",
        "result": {"id": "ws_b"}
    });
    let hashed_for_a = store_key_file(&home, "key-a");
    std::fs::write(&hashed_for_a, serde_json::to_vec_pretty(&forged).unwrap()).unwrap();
    assert_eq!(
        store
            .recall_idempotent("key-a", "workspace/create", "fp-a")
            .unwrap(),
        None,
        "a record claiming another key is absent for this key"
    );

    // Same verification on the legacy namespace: the record must declare
    // the requested key, including for dotted legal legacy names.
    let dotted = "client.request.1";
    let mut dotted_record = forged.clone();
    dotted_record["key"] = serde_json::json!(dotted);
    dotted_record["result"] = serde_json::json!({"id": "ws_dotted"});
    std::fs::write(
        home.join("state")
            .join("idempotency")
            .join(format!("{dotted}.json")),
        serde_json::to_vec_pretty(&dotted_record).unwrap(),
    )
    .unwrap();
    assert_eq!(
        store
            .recall_idempotent(dotted, "workspace/create", "any-fp")
            .unwrap()
            .unwrap()["id"],
        serde_json::json!("ws_dotted"),
        "dotted legal legacy keys stay compatibly readable"
    );
    // And a dotted legacy file claiming a different key is not served.
    let mut lying = dotted_record.clone();
    lying["key"] = serde_json::json!("someone-else");
    std::fs::write(
        home.join("state")
            .join("idempotency")
            .join("other.request.2.json"),
        serde_json::to_vec_pretty(&lying).unwrap(),
    )
    .unwrap();
    assert_eq!(
        store
            .recall_idempotent("other.request.2", "workspace/create", "any-fp")
            .unwrap(),
        None,
    );
    let _ = fs::remove_dir_all(home);
}

/// Helper: the namespaced record file path for a key (mirrors the store).
fn store_key_file(home: &std::path::Path, key: &str) -> std::path::PathBuf {
    home.join("state")
        .join("idempotency")
        .join("records")
        .join(format!(
            "{}.json",
            hex::encode(Sha256::digest(key.as_bytes()))
        ))
}
