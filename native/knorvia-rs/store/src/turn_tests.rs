use super::durable::{DurableFailpoint, inject_failure};
use super::*;
use serde_json::json;
use knorvia_platform_paths::layout;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};
use std::time::{SystemTime, UNIX_EPOCH};

fn tmp_store() -> (ProductStore, PathBuf) {
    let base = std::env::temp_dir().join(format!(
        "knorvia-store-turn-tests-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&base).unwrap();
    let store = ProductStore::open(layout(base.clone())).unwrap();
    (store, base)
}

fn thread_for(store: &ProductStore) -> Thread {
    let workspace = store.create_workspace("turn tests").unwrap();
    store
        .create_thread(&workspace.id, "thread", None, None)
        .unwrap()
}

fn assert_conflict(error: StoreError) {
    match error {
        StoreError::Protocol(StoreProtocolError(protocol)) => {
            assert_eq!(protocol.category, ErrorCategory::Conflict);
        }
        other => panic!("expected conflict, got {other:?}"),
    }
}

fn assert_invalid(error: StoreError) {
    match error {
        StoreError::Protocol(StoreProtocolError(protocol)) => {
            assert_eq!(protocol.category, ErrorCategory::InvalidArgument);
        }
        other => panic!("expected invalid argument, got {other:?}"),
    }
}

fn json_file_count(directory: &Path) -> usize {
    if !directory.exists() {
        return 0;
    }
    fs::read_dir(directory)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("json"))
        .count()
}

#[test]
fn concurrent_turn_starts_leave_exactly_one_running_turn() {
    let (store, home) = tmp_store();
    let store = Arc::new(store);
    let thread = thread_for(&store);
    let second_store = Arc::new(ProductStore::open(layout(home.clone())).unwrap());
    let stores = [Arc::clone(&store), second_store];
    let barrier = Arc::new(Barrier::new(12));
    let handles = (0..12)
        .map(|index| {
            let barrier = Arc::clone(&barrier);
            let store = Arc::clone(&stores[index % stores.len()]);
            let thread_id = thread.id.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.start_turn(&thread_id)
            })
        })
        .collect::<Vec<_>>();

    let mut started = Vec::new();
    for handle in handles {
        match handle.join().unwrap() {
            Ok(turn) => started.push(turn),
            Err(error) => assert_conflict(error),
        }
    }

    assert_eq!(started.len(), 1);
    assert_eq!(store.read_turn(&started[0].id).unwrap().status, "running");
    let start_events = store
        .replay(&thread.id, 0)
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "turn.started")
        .count();
    assert_eq!(start_events, 1);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn item_projection_and_journal_event_share_one_monotonic_sequence() {
    let (store, home) = tmp_store();
    let thread = thread_for(&store);
    let turn = store.start_turn(&thread.id).unwrap();
    let item = store
        .append_item(
            &thread.id,
            &turn.id,
            "agentMessage",
            "completed",
            serde_json::json!({"text": "persisted first"}),
        )
        .unwrap();

    let event = store
        .replay(&thread.id, 0)
        .unwrap()
        .into_iter()
        .find(|event| {
            event.kind == "item.appended"
                && event.payload.get("id").and_then(Value::as_str) == Some(item.id.as_str())
        })
        .unwrap();
    assert_eq!(event.seq, item.seq);
    assert_eq!(event.payload["seq"].as_u64(), Some(item.seq));
    let _ = fs::remove_dir_all(home);
}

#[test]
fn system_approval_resolutions_are_distinct_atomic_and_idempotent() {
    let (store, home) = tmp_store();
    let thread = thread_for(&store);
    let turn = store.start_turn(&thread.id).unwrap();
    let timed_out = store
        .create_approval(&thread.id, &turn.id, "kernel.commandExecution", "d1")
        .unwrap();
    let denied = store
        .create_approval(&thread.id, &turn.id, "kernel.commandExecution", "d2")
        .unwrap();

    // Short-timeout fixture: the system close-out is its own terminal.
    let resolved = store
        .resolve_approval_system(&timed_out.id, "timed_out")
        .unwrap();
    assert_eq!(resolved.status, "timed_out");
    // Idempotent repeat.
    let again = store
        .resolve_approval_system(&timed_out.id, "timed_out")
        .unwrap();
    assert_eq!(again.status, "timed_out");
    // No double terminal, no privilege escalation: a late user allow is a
    // conflict and never overwrites the system resolution.
    assert!(store.respond_approval(&timed_out.id, "allow").is_err());
    assert!(
        store
            .resolve_approval_system(&timed_out.id, "cancelled")
            .is_err()
    );
    assert_eq!(
        store.read_approval(&timed_out.id).unwrap().status,
        "timed_out"
    );

    // The user's own rejection keeps its distinct, human meaning.
    let user_denied = store.respond_approval(&denied.id, "deny").unwrap();
    assert_eq!(user_denied.status, "denied");
    assert!(
        store
            .resolve_approval_system(&denied.id, "owner_lost")
            .is_err()
    );

    // Unknown system reasons are rejected, not silently recorded.
    let third = store
        .create_approval(&thread.id, &turn.id, "kernel.commandExecution", "d3")
        .unwrap();
    assert!(store.resolve_approval_system(&third.id, "allow").is_err());
    assert_eq!(store.read_approval(&third.id).unwrap().status, "pending");
    let _ = fs::remove_dir_all(home);
}

fn resolution_items(store: &ProductStore, thread_id: &str) -> Vec<Item> {
    let mut items: Vec<Item> = store
        .list_items(thread_id)
        .unwrap()
        .into_iter()
        .filter(|item| item.kind == "approvalResolution")
        .collect();
    items.sort_by_key(|item| item.seq);
    items
}

#[test]
fn system_resolutions_leave_durable_timeline_items_distinct_from_user_deny() {
    let (store, home) = tmp_store();
    let thread = thread_for(&store);
    let turn = store.start_turn(&thread.id).unwrap();
    let timed_out = store
        .create_approval(&thread.id, &turn.id, "kernel.commandExecution", "d1")
        .unwrap();
    let denied = store
        .create_approval(&thread.id, &turn.id, "kernel.commandExecution", "d2")
        .unwrap();

    store
        .resolve_approval_system(&timed_out.id, "timed_out")
        .unwrap();
    let items = resolution_items(&store, &thread.id);
    assert_eq!(items.len(), 1, "exactly one resolution item");
    assert_eq!(items[0].turn_id, turn.id);
    assert_eq!(items[0].status, "completed");
    assert_eq!(items[0].payload["approvalId"], timed_out.id);
    assert_eq!(items[0].payload["resolution"], "timed_out");
    assert_eq!(items[0].payload["source"], "system");
    // The Item rides the same WAL transaction: its event is in history and
    // its seq matches the event order.
    let event_seq = store
        .replay(&thread.id, 0)
        .unwrap()
        .into_iter()
        .find(|event| {
            event.kind == "item.appended"
                && event.payload.get("id").and_then(Value::as_str) == Some(items[0].id.as_str())
        })
        .unwrap()
        .seq;
    assert_eq!(event_seq, items[0].seq);

    // Idempotent repeat: no duplicate item for the same resolution.
    store
        .resolve_approval_system(&timed_out.id, "timed_out")
        .unwrap();
    assert_eq!(resolution_items(&store, &thread.id).len(), 1);

    // A user denial records no approvalResolution item.
    store.respond_approval(&denied.id, "deny").unwrap();
    assert_eq!(resolution_items(&store, &thread.id).len(), 1);

    // Reopen: the reason survives the restart and stays readable.
    drop(store);
    let reopened = ProductStore::open(layout(home.clone())).unwrap();
    let items = resolution_items(&reopened, &thread.id);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].payload["resolution"], "timed_out");
    assert_eq!(
        reopened.read_approval(&timed_out.id).unwrap().status,
        "timed_out"
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn restart_recovery_closes_pending_approvals_with_owner_lost_timeline_items() {
    let (store, home) = tmp_store();
    let thread = thread_for(&store);
    let turn = store.start_turn(&thread.id).unwrap();
    let pending = store
        .create_approval(&thread.id, &turn.id, "kernel.commandExecution", "d1")
        .unwrap();
    // Simulate the crash: the store is dropped with the turn still running.
    drop(store);

    let reopened = ProductStore::open(layout(home.clone())).unwrap();
    let recovered = reopened.recover_incomplete_turns().unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].status, "interrupted");
    assert_eq!(
        reopened.read_approval(&pending.id).unwrap().status,
        "owner_lost"
    );
    let items = resolution_items(&reopened, &thread.id);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].payload["approvalId"], pending.id);
    assert_eq!(items[0].payload["resolution"], "owner_lost");
    assert_eq!(items[0].payload["source"], "system");

    // Recovery is idempotent: a second pass adds no duplicate items.
    assert!(reopened.recover_incomplete_turns().unwrap().is_empty());
    assert_eq!(resolution_items(&reopened, &thread.id).len(), 1);
    // The terminal approval cannot be re-resolved into a second item.
    assert_eq!(
        reopened
            .resolve_approval_system(&pending.id, "owner_lost")
            .unwrap()
            .status,
        "owner_lost"
    );
    assert_eq!(resolution_items(&reopened, &thread.id).len(), 1);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn terminal_turns_are_idempotent_but_never_rewritten_or_extended() {
    let (store, home) = tmp_store();
    let thread = thread_for(&store);
    let turn = store.start_turn(&thread.id).unwrap();

    let completed = store.complete_turn(&turn.id, "completed").unwrap();
    let repeated = store
        .complete_turn_idempotent(&turn.id, "completed")
        .unwrap();
    assert_eq!(
        serde_json::to_value(completed).unwrap(),
        serde_json::to_value(repeated).unwrap()
    );
    assert_conflict(store.complete_turn(&turn.id, "failed").unwrap_err());
    assert_invalid(store.complete_turn(&turn.id, "running").unwrap_err());
    assert_conflict(
        store
            .append_item(
                &thread.id,
                &turn.id,
                "agentMessage",
                "completed",
                serde_json::json!({"text": "late"}),
            )
            .unwrap_err(),
    );
    assert_eq!(store.read_turn(&turn.id).unwrap().status, "completed");
    assert!(store.list_items(&thread.id).unwrap().is_empty());
    let terminal_events = store
        .replay(&thread.id, 0)
        .unwrap()
        .into_iter()
        .filter(|event| {
            event.kind == "turn.completed"
                && event.payload.get("id").and_then(Value::as_str) == Some(turn.id.as_str())
        })
        .count();
    assert_eq!(terminal_events, 1);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn recovery_marks_orphaned_running_turns_interrupted() {
    let (store, home) = tmp_store();
    let thread = thread_for(&store);
    let turn = store.start_turn(&thread.id).unwrap();

    let recovered = store.recover_incomplete_turns().unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].id, turn.id);
    assert_eq!(recovered[0].status, "interrupted");
    assert!(recovered[0].completed_at.is_some());
    assert!(store.recover_incomplete_turns().unwrap().is_empty());
    assert_conflict(
        store
            .append_item(
                &thread.id,
                &turn.id,
                "agentMessage",
                "completed",
                serde_json::json!({"text": "late"}),
            )
            .unwrap_err(),
    );
    let terminal_event = store
        .replay(&thread.id, 0)
        .unwrap()
        .into_iter()
        .find(|event| {
            event.kind == "turn.completed"
                && event.payload.get("id").and_then(Value::as_str) == Some(turn.id.as_str())
        })
        .unwrap();
    assert_eq!(terminal_event.payload["status"], "interrupted");
    let _ = fs::remove_dir_all(home);
}

#[test]
fn journal_path_failure_does_not_report_or_project_a_started_turn() {
    let (store, home) = tmp_store();
    let thread = thread_for(&store);
    let journal = store
        .paths()
        .state
        .join("events")
        .join(format!("{}.jsonl", thread.id));
    fs::remove_file(&journal).unwrap();
    fs::create_dir(&journal).unwrap();

    let error = store.start_turn(&thread.id).unwrap_err();
    assert!(
        matches!(error, StoreError::Io(_)),
        "unexpected error: {error:?}"
    );
    assert_eq!(
        json_file_count(&store.paths().state.join("product").join("turns")),
        0
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn item_journal_failure_does_not_report_or_project_an_item() {
    let (store, home) = tmp_store();
    let thread = thread_for(&store);
    let turn = store.start_turn(&thread.id).unwrap();
    let journal = store
        .paths()
        .state
        .join("events")
        .join(format!("{}.jsonl", thread.id));
    fs::remove_file(&journal).unwrap();
    fs::create_dir(&journal).unwrap();

    let error = store
        .append_item(
            &thread.id,
            &turn.id,
            "agentMessage",
            "completed",
            serde_json::json!({"text": "durability probe"}),
        )
        .unwrap_err();
    assert!(
        matches!(error, StoreError::Io(_)),
        "unexpected error: {error:?}"
    );
    assert_eq!(
        json_file_count(&store.paths().state.join("product").join("items")),
        0
    );
    assert_eq!(store.read_turn(&turn.id).unwrap().status, "running");
    let _ = fs::remove_dir_all(home);
}

#[test]
fn a03_same_process_system_retry_recovers_before_idempotency_check() {
    for point in [
        DurableFailpoint::AfterIntentPersisted,
        DurableFailpoint::AfterProjectionApplied,
    ] {
        for reason in ["timed_out", "cancelled", "owner_lost"] {
            let (store, home) = tmp_store();
            let thread = thread_for(&store);
            let turn = store.start_turn(&thread.id).unwrap();
            let approval = store
                .create_approval(&thread.id, &turn.id, "kernel.commandExecution", "retry")
                .unwrap();
            inject_failure(point);
            assert!(matches!(
                store.resolve_approval_system(&approval.id, reason),
                Err(StoreError::Io(_))
            ));
            // Deliberately no reopen or indexed read between the failed
            // write and retry: either would mask the stale projection bug.
            assert_eq!(
                store
                    .resolve_approval_system(&approval.id, reason)
                    .unwrap()
                    .status,
                reason
            );
            let items = resolution_items(&store, &thread.id);
            assert_eq!(items.len(), 1, "{point:?}, {reason}");
            let events = store.replay(&thread.id, 0).unwrap();
            assert_eq!(
                events
                    .iter()
                    .filter(|e| e.kind == "approval.systemResolved")
                    .count(),
                1
            );
            let event = events
                .iter()
                .find(|e| e.kind == "item.appended" && e.payload["id"] == items[0].id)
                .unwrap();
            assert_eq!(event.seq, items[0].seq);
            drop(store);
            let reopened = ProductStore::open(layout(home.clone())).unwrap();
            assert_eq!(resolution_items(&reopened, &thread.id).len(), 1);
            assert_eq!(reopened.read_approval(&approval.id).unwrap().status, reason);
            drop(reopened);
            let _ = fs::remove_dir_all(home);
        }
    }
}

#[test]
fn a03_durable_user_decision_survives_failed_write_then_system_resolution() {
    for point in [
        DurableFailpoint::AfterIntentPersisted,
        DurableFailpoint::AfterProjectionApplied,
    ] {
        for (decision, status, opposite) in
            [("deny", "denied", "allow"), ("allow", "allowed", "deny")]
        {
            let (store, home) = tmp_store();
            let thread = thread_for(&store);
            let turn = store.start_turn(&thread.id).unwrap();
            let approval = store
                .create_approval(&thread.id, &turn.id, "kernel.commandExecution", "user")
                .unwrap();
            inject_failure(point);
            assert!(matches!(
                store.respond_approval(&approval.id, decision),
                Err(StoreError::Io(_))
            ));
            assert_conflict(
                store
                    .resolve_approval_system(&approval.id, "timed_out")
                    .unwrap_err(),
            );
            assert_conflict(store.respond_approval(&approval.id, opposite).unwrap_err());
            store.complete_turn(&turn.id, "cancelled").unwrap();
            assert_eq!(store.read_approval(&approval.id).unwrap().status, status);
            assert!(resolution_items(&store, &thread.id).is_empty());
            let events = store.replay(&thread.id, 0).unwrap();
            assert_eq!(
                events
                    .iter()
                    .filter(|e| e.kind == "approval.responded")
                    .count(),
                1
            );
            drop(store);
            let reopened = ProductStore::open(layout(home.clone())).unwrap();
            reopened.recover_incomplete_turns().unwrap();
            assert_eq!(reopened.read_approval(&approval.id).unwrap().status, status);
            assert!(resolution_items(&reopened, &thread.id).is_empty());
            drop(reopened);
            let _ = fs::remove_dir_all(home);
        }
    }
}

#[test]
fn a03_durable_system_resolution_prevents_late_user_decision_after_io_error() {
    for point in [
        DurableFailpoint::AfterIntentPersisted,
        DurableFailpoint::AfterProjectionApplied,
    ] {
        for reason in ["timed_out", "cancelled", "owner_lost"] {
            for decision in ["allow", "deny"] {
                let (store, home) = tmp_store();
                let thread = thread_for(&store);
                let turn = store.start_turn(&thread.id).unwrap();
                let approval = store
                    .create_approval(&thread.id, &turn.id, "kernel.commandExecution", "late")
                    .unwrap();
                inject_failure(point);
                assert!(matches!(
                    store.resolve_approval_system(&approval.id, reason),
                    Err(StoreError::Io(_))
                ));
                assert_conflict(store.respond_approval(&approval.id, decision).unwrap_err());
                assert_eq!(store.read_approval(&approval.id).unwrap().status, reason);
                assert_eq!(resolution_items(&store, &thread.id).len(), 1);
                assert!(
                    !store
                        .replay(&thread.id, 0)
                        .unwrap()
                        .iter()
                        .any(|e| e.kind == "approval.responded")
                );
                drop(store);
                let _ = fs::remove_dir_all(home);
            }
        }
    }
}

#[test]
fn a03_terminal_turn_and_pending_approvals_share_one_wal_transaction() {
    for status in ["completed", "failed", "cancelled", "interrupted"] {
        let (store, home) = tmp_store();
        let thread = thread_for(&store);
        let turn = store.start_turn(&thread.id).unwrap();
        let mut pending = Vec::new();
        for digest in ["first", "second"] {
            pending.push(
                store
                    .create_approval(&thread.id, &turn.id, "kernel.commandExecution", digest)
                    .unwrap(),
            );
        }
        let denied = store
            .create_approval(&thread.id, &turn.id, "kernel.commandExecution", "deny")
            .unwrap();
        store.respond_approval(&denied.id, "deny").unwrap();
        let timed_out = store
            .create_approval(&thread.id, &turn.id, "kernel.commandExecution", "timeout")
            .unwrap();
        store
            .resolve_approval_system(&timed_out.id, "timed_out")
            .unwrap();
        let tool = store
            .append_item(
                &thread.id,
                &turn.id,
                "tool.write",
                "waiting_approval",
                json!({"approvalId": pending[0].id}),
            )
            .unwrap();
        let completed = store.complete_turn(&turn.id, status).unwrap();
        let expected_reason = if status == "cancelled" {
            "cancelled"
        } else {
            "owner_lost"
        };
        for approval in &pending {
            assert_eq!(
                store.read_approval(&approval.id).unwrap().status,
                expected_reason
            );
        }
        assert_eq!(store.read_approval(&denied.id).unwrap().status, "denied");
        assert_eq!(
            store.read_approval(&timed_out.id).unwrap().status,
            "timed_out"
        );
        assert_eq!(store.read_item(&tool.id).unwrap().status, "interrupted");
        let items = resolution_items(&store, &thread.id);
        assert_eq!(items.len(), 3);
        let transactions = store.load_transactions().unwrap();
        let terminal =
            transactions
                .iter()
                .find(|transaction| {
                    transaction.events().unwrap().iter().any(|event| {
                        event.kind == "turn.completed" && event.payload["id"] == turn.id
                    })
                })
                .unwrap();
        let events = terminal.events().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|e| e.kind == "approval.systemResolved")
                .count(),
            2
        );
        assert_eq!(
            events.iter().filter(|e| e.kind == "item.appended").count(),
            2
        );
        assert!(
            events
                .iter()
                .any(|e| e.kind == "item.interrupted" && e.payload["id"] == tool.id)
        );
        for approval in &pending {
            let item = items
                .iter()
                .find(|item| item.payload["approvalId"] == approval.id)
                .unwrap();
            assert_eq!(item.payload["resolution"], expected_reason);
            assert!(events.iter().any(|e| e.kind == "item.appended"
                && e.payload["id"] == item.id
                && e.seq == item.seq));
            let writes = serde_json::to_value(&terminal.writes).unwrap();
            assert!(
                writes
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|write| write["kind"] == "approval"
                        && write["document"]["id"] == approval.id
                        && write["document"]["status"] == expected_reason)
            );
            assert!(
                writes
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|write| write["kind"] == "item" && write["document"]["id"] == item.id)
            );
        }
        assert_eq!(
            serde_json::to_value(store.complete_turn(&turn.id, status).unwrap()).unwrap(),
            serde_json::to_value(&completed).unwrap()
        );
        assert!(store.recover_incomplete_turns().unwrap().is_empty());
        assert_eq!(store.load_transactions().unwrap().len(), transactions.len());
        drop(store);
        let _ = fs::remove_dir_all(home);
    }
}

#[test]
fn a03_terminal_retry_recovers_whole_closeout_without_duplicate_items() {
    for point in [
        DurableFailpoint::AfterIntentPersisted,
        DurableFailpoint::AfterProjectionApplied,
    ] {
        for status in ["completed", "failed", "cancelled", "interrupted"] {
            let (store, home) = tmp_store();
            let thread = thread_for(&store);
            let turn = store.start_turn(&thread.id).unwrap();
            let approval = store
                .create_approval(
                    &thread.id,
                    &turn.id,
                    "kernel.commandExecution",
                    "terminal-retry",
                )
                .unwrap();
            inject_failure(point);
            assert!(matches!(
                store.complete_turn(&turn.id, status),
                Err(StoreError::Io(_))
            ));
            let completed = store.complete_turn_idempotent(&turn.id, status).unwrap();
            assert_eq!(completed.status, status);
            assert_ne!(store.read_approval(&approval.id).unwrap().status, "pending");
            assert_eq!(resolution_items(&store, &thread.id).len(), 1);
            assert_eq!(
                store
                    .replay(&thread.id, 0)
                    .unwrap()
                    .iter()
                    .filter(|e| e.kind == "turn.completed")
                    .count(),
                1
            );
            drop(store);
            let reopened = ProductStore::open(layout(home.clone())).unwrap();
            assert!(reopened.recover_incomplete_turns().unwrap().is_empty());
            assert_eq!(resolution_items(&reopened, &thread.id).len(), 1);
            assert_eq!(
                serde_json::to_value(reopened.read_turn(&turn.id).unwrap()).unwrap(),
                serde_json::to_value(completed).unwrap()
            );
            drop(reopened);
            let _ = fs::remove_dir_all(home);
        }
    }
}

// Persist the former implementation's legitimate turn-only WAL record;
// directly editing a projection would be undone by recovery and would not
// exercise a real pre-upgrade terminal/pending state.
fn a03_legacy_complete_turn(store: &ProductStore, turn: &Turn, status: &str) -> Turn {
    let _mutations = store.lock_mutations().unwrap();
    let _journal = store.lock_journal().unwrap();
    store.recover_durable_state_locked().unwrap();
    let mut terminal = turn.clone();
    terminal.status = status.into();
    terminal.completed_at = Some(now_rfc3339());
    let write = store
        .projection_write(ProjectionKind::Turn, &turn.id, &terminal)
        .unwrap();
    store
        .commit_transaction_locked(
            &turn.thread_id,
            "turn.completed",
            serde_json::to_value(&terminal).unwrap(),
            None,
            vec![write],
        )
        .unwrap();
    terminal
}

#[test]
fn a03_legacy_terminal_pending_repairs_preserve_terminal_and_user_decisions() {
    for via_recovery in [true, false] {
        for status in ["completed", "failed", "cancelled", "interrupted"] {
            let (store, home) = tmp_store();
            let thread = thread_for(&store);
            let turn = store.start_turn(&thread.id).unwrap();
            let pending = store
                .create_approval(&thread.id, &turn.id, "kernel.commandExecution", "legacy")
                .unwrap();
            let denied = store
                .create_approval(&thread.id, &turn.id, "kernel.commandExecution", "deny")
                .unwrap();
            store.respond_approval(&denied.id, "deny").unwrap();
            let tool = store
                .append_item(
                    &thread.id,
                    &turn.id,
                    "tool.write",
                    "waiting_approval",
                    json!({"approvalId": pending.id}),
                )
                .unwrap();
            let terminal = a03_legacy_complete_turn(&store, &turn, status);
            assert_eq!(store.read_approval(&pending.id).unwrap().status, "pending");
            drop(store);
            let reopened = ProductStore::open(layout(home.clone())).unwrap();
            if via_recovery {
                assert!(reopened.recover_incomplete_turns().unwrap().is_empty());
            } else {
                reopened.complete_turn_idempotent(&turn.id, status).unwrap();
            }
            assert_eq!(
                serde_json::to_value(reopened.read_turn(&turn.id).unwrap()).unwrap(),
                serde_json::to_value(&terminal).unwrap()
            );
            let expected_reason = if status == "cancelled" {
                "cancelled"
            } else {
                "owner_lost"
            };
            assert_eq!(
                reopened.read_approval(&pending.id).unwrap().status,
                expected_reason
            );
            assert_eq!(reopened.read_approval(&denied.id).unwrap().status, "denied");
            assert_eq!(reopened.read_item(&tool.id).unwrap().status, "interrupted");
            let items = resolution_items(&reopened, &thread.id);
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].payload["approvalId"], pending.id);
            assert_eq!(items[0].payload["resolution"], expected_reason);
            let transactions = reopened.load_transactions().unwrap();
            let repair = transactions
                .iter()
                .find(|transaction| {
                    transaction.events().unwrap().iter().any(|e| {
                        e.kind == "approval.systemResolved"
                            && e.payload["approval"]["id"] == pending.id
                    })
                })
                .unwrap();
            assert!(
                repair
                    .events()
                    .unwrap()
                    .iter()
                    .any(|e| e.kind == "item.appended" && e.payload["id"] == items[0].id)
            );
            assert!(
                !repair
                    .events()
                    .unwrap()
                    .iter()
                    .any(|e| e.kind == "turn.completed")
            );
            assert_eq!(
                reopened
                    .replay(&thread.id, 0)
                    .unwrap()
                    .iter()
                    .filter(|e| e.kind == "turn.completed")
                    .count(),
                1
            );
            assert!(reopened.recover_incomplete_turns().unwrap().is_empty());
            reopened.complete_turn_idempotent(&turn.id, status).unwrap();
            assert_eq!(
                reopened.load_transactions().unwrap().len(),
                transactions.len()
            );
            drop(reopened);
            let _ = fs::remove_dir_all(home);
        }
    }
}

#[test]
fn a03_timeout_and_user_allow_race_has_one_authoritative_winner() {
    for _ in 0..8 {
        let (store, home) = tmp_store();
        let store = Arc::new(store);
        let thread = thread_for(&store);
        let turn = store.start_turn(&thread.id).unwrap();
        let approval = store
            .create_approval(&thread.id, &turn.id, "kernel.commandExecution", "race")
            .unwrap();
        let other_store = Arc::new(ProductStore::open(layout(home.clone())).unwrap());
        let barrier = Arc::new(Barrier::new(2));
        let workers = [false, true]
            .into_iter()
            .map(|user| {
                let store = if user {
                    Arc::clone(&other_store)
                } else {
                    Arc::clone(&store)
                };
                let barrier = Arc::clone(&barrier);
                let id = approval.id.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    if user {
                        store.respond_approval(&id, "allow")
                    } else {
                        store.resolve_approval_system(&id, "timed_out")
                    }
                })
            })
            .collect::<Vec<_>>();
        let mut winners = Vec::new();
        for worker in workers {
            match worker.join().unwrap() {
                Ok(approval) => winners.push(approval.status),
                Err(error) => assert_conflict(error),
            }
        }
        assert_eq!(winners.len(), 1);
        let events = store.replay(&thread.id, 0).unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(
                    e.kind.as_str(),
                    "approval.responded" | "approval.systemResolved"
                ))
                .count(),
            1
        );
        assert_eq!(
            store.read_approval(&approval.id).unwrap().status,
            winners[0]
        );
        assert_eq!(
            resolution_items(&store, &thread.id).len(),
            usize::from(winners[0] == "timed_out")
        );
        drop(other_store);
        drop(store);
        let _ = fs::remove_dir_all(home);
    }
}

#[test]
fn a03_warm_closeout_and_legacy_repair_do_not_read_unrelated_history() {
    for via_recovery in [false, true] {
        let (store, home) = tmp_store();
        let thread = thread_for(&store);
        let old_turn = store.start_turn(&thread.id).unwrap();
        let old_approval = store
            .create_approval(&thread.id, &old_turn.id, "kernel.commandExecution", "old")
            .unwrap();
        store.respond_approval(&old_approval.id, "deny").unwrap();
        let old_item = store
            .append_item(
                &thread.id,
                &old_turn.id,
                "agentMessage",
                "completed",
                json!({"text": "old history"}),
            )
            .unwrap();
        store.complete_turn(&old_turn.id, "completed").unwrap();
        let current = store.start_turn(&thread.id).unwrap();
        let pending = store
            .create_approval(
                &thread.id,
                &current.id,
                "kernel.commandExecution",
                "current",
            )
            .unwrap();
        if via_recovery {
            a03_legacy_complete_turn(&store, &current, "interrupted");
        }
        // Warm the real index first. Poisoning only unrelated historical
        // documents makes any accidental full-history parse fail, without
        // relying on timing or an implementation-shaped mock/counter.
        store.list_turn_items(&thread.id, &current.id).unwrap();
        let old_item_path = store.sharded_item_path(&thread.id, Some(old_item.seq), &old_item.id);
        let old_approval_path = store.approval_path(&old_approval.id);
        fs::write(&old_item_path, b"unread unrelated item").unwrap();
        fs::write(&old_approval_path, b"unread resolved approval").unwrap();
        if via_recovery {
            assert!(store.recover_incomplete_turns().unwrap().is_empty());
        } else {
            store.complete_turn(&current.id, "interrupted").unwrap();
        }
        assert_eq!(
            store.read_approval(&pending.id).unwrap().status,
            "owner_lost"
        );
        assert_eq!(store.read_turn(&current.id).unwrap().status, "interrupted");
        assert_eq!(fs::read(&old_item_path).unwrap(), b"unread unrelated item");
        assert_eq!(
            fs::read(&old_approval_path).unwrap(),
            b"unread resolved approval"
        );
        // This assertion also proves the fixture was not silently rebuilt.
        assert!(store.read_approval(&old_approval.id).is_err());
        drop(store);
        let _ = fs::remove_dir_all(home);
    }
}
