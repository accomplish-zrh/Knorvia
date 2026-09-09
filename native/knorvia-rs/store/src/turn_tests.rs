use super::*;
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
