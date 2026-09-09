use super::durable::{DurableFailpoint, inject_failure};
use super::*;
use knorvia_platform_paths::layout;
use serde_json::json;

fn setup() -> (ProductStore, Thread) {
    let store = ProductStore::open(layout(
        std::env::temp_dir().join(new_id("knorvia-timeline-index")),
    ))
    .unwrap();
    let workspace = store.create_workspace("timeline").unwrap();
    let thread = store
        .create_thread(&workspace.id, "history", None, None)
        .unwrap();
    (store, thread)
}

#[test]
fn summaries_and_tail_pages_skip_old_payloads_but_retain_interactions_outside_the_page() {
    let (store, thread) = setup();
    let old_turn = store.start_turn(&thread.id).unwrap();
    let old_item = store
        .append_item(
            &thread.id,
            &old_turn.id,
            "agentMessage",
            "completed",
            json!({"text":"old"}),
        )
        .unwrap();
    store.complete_turn(&old_turn.id, "completed").unwrap();
    let turn = store.start_turn(&thread.id).unwrap();
    let input = store
        .append_item(
            &thread.id,
            &turn.id,
            "userInput",
            "waiting_input",
            json!({"question":"retain me"}),
        )
        .unwrap();
    let approval = store
        .create_approval(&thread.id, &turn.id, "write", "digest")
        .unwrap();
    let latest = store
        .append_item(
            &thread.id,
            &turn.id,
            "agentMessage",
            "completed",
            json!({"text":"new"}),
        )
        .unwrap();

    let old_path = store.sharded_item_path(&thread.id, Some(old_item.seq), &old_item.id);
    fs::write(&old_path, b"corrupt old payload").unwrap();
    fs::write(store.turn_path(&old_turn.id), b"corrupt old turn").unwrap();
    let page = store
        .read_thread_history(&thread.id, None, 1, None, 1)
        .unwrap();
    assert_eq!(page.items[0].id, latest.id);
    assert_eq!(page.turns[0].id, turn.id);
    assert_eq!(page.activity.pending_user_inputs[0].id, input.id);
    assert_eq!(page.activity.pending_approvals[0].id, approval.id);
    assert_eq!(page.activity.active_turn.unwrap().id, turn.id);
    let current = store.read_turn_history(&turn.id).unwrap();
    assert_eq!(current.items.len(), 2);
    assert_eq!(current.pending_user_inputs[0].id, input.id);
    assert_eq!(current.pending_approvals[0].id, approval.id);
    assert_eq!(
        store.list_turn_items(&thread.id, &turn.id).unwrap().len(),
        2
    );
    assert_eq!(page.items_next_cursor, Some(latest.seq));
    assert_eq!(page.turns_next_cursor.as_deref(), Some(turn.id.as_str()));
    assert!(store.list_items(&thread.id).is_err());
    assert!(store.list_turns(&thread.id).is_err());
    assert!(
        store
            .read_thread_history(&thread.id, Some(input.seq), 1, None, 1)
            .is_err()
    );
    assert_eq!(fs::read(&old_path).unwrap(), b"corrupt old payload");
    store.respond_approval(&approval.id, "deny").unwrap();
    store
        .resolve_item(&input.id, "answered", json!({"answer":"ok"}))
        .unwrap();
    let activity = store.read_thread_activity(&thread.id).unwrap();
    assert!(activity.pending_approvals.is_empty());
    assert!(activity.pending_user_inputs.is_empty());
}

#[test]
fn backward_pages_remain_exclusive_across_appends_and_process_reopen() {
    let (store, thread) = setup();
    let first = store.start_turn(&thread.id).unwrap();
    let mut expected = Vec::new();
    for text in ["a", "b", "c", "d", "e"] {
        expected.push(
            store
                .append_item(
                    &thread.id,
                    &first.id,
                    "agentMessage",
                    "completed",
                    json!({"text":text}),
                )
                .unwrap(),
        );
    }
    let page = store
        .read_thread_history(&thread.id, None, 2, None, 1)
        .unwrap();
    assert_eq!(
        page.items.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
        expected[3..]
            .iter()
            .map(|i| i.id.clone())
            .collect::<Vec<_>>()
    );
    let new = store
        .append_item(
            &thread.id,
            &first.id,
            "agentMessage",
            "completed",
            json!({"text":"f"}),
        )
        .unwrap();
    store.complete_turn(&first.id, "completed").unwrap();
    let paths = store.paths.clone();
    drop(store);
    let reopened = ProductStore::open(paths).unwrap();
    let older = reopened
        .read_thread_history(&thread.id, page.items_next_cursor, 2, None, 1)
        .unwrap();
    assert_eq!(
        older.items.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
        expected[1..3]
            .iter()
            .map(|i| i.id.clone())
            .collect::<Vec<_>>()
    );
    let oldest = reopened
        .read_thread_history(&thread.id, older.items_next_cursor, 2, None, 1)
        .unwrap();
    assert_eq!(oldest.items.len(), 1);
    assert_eq!(oldest.items[0].id, expected[0].id);
    assert!(oldest.items_next_cursor.is_none());
    assert_eq!(
        reopened
            .read_thread_history(&thread.id, None, 1, None, 1)
            .unwrap()
            .items[0]
            .id,
        new.id
    );
    assert!(
        reopened
            .read_thread_history(&thread.id, Some(0), 1, None, 1)
            .unwrap()
            .items
            .is_empty()
    );
    assert!(
        reopened
            .read_thread_history(&thread.id, None, 1, Some("foreign-turn"), 1)
            .is_err()
    );
}

#[test]
fn uncertain_interactions_are_recovered_before_read_and_shutdown_clears_pending_membership() {
    let (store, thread) = setup();
    let turn = store.start_turn(&thread.id).unwrap();
    inject_failure(DurableFailpoint::AfterIntentPersisted);
    assert!(
        store
            .append_item(
                &thread.id,
                &turn.id,
                "userInput",
                "waiting_input",
                json!({"question":"recovered"})
            )
            .is_err()
    );
    let input = store
        .read_thread_activity(&thread.id)
        .unwrap()
        .pending_user_inputs
        .pop()
        .unwrap();
    inject_failure(DurableFailpoint::AfterIntentPersisted);
    assert!(
        store
            .create_approval(&thread.id, &turn.id, "write", "digest")
            .is_err()
    );
    assert_eq!(
        store
            .read_thread_activity(&thread.id)
            .unwrap()
            .pending_approvals
            .len(),
        1
    );
    assert_eq!(store.recover_incomplete_turns().unwrap().len(), 1);
    let activity = store.read_thread_activity(&thread.id).unwrap();
    assert!(activity.pending_approvals.is_empty());
    assert!(activity.pending_user_inputs.is_empty());
    assert!(activity.active_turn.is_none());
    assert_eq!(activity.last_turn.unwrap().status, "interrupted");
    assert_eq!(store.read_item(&input.id).unwrap().status, "interrupted");
    assert_eq!(store.running_turn_count().unwrap(), 0);
}

#[test]
fn unrelated_corrupt_histories_do_not_block_another_thread_and_own_corruption_is_reported() {
    let (store, thread) = setup();
    let foreign = store
        .create_thread(&thread.workspace_id, "foreign", None, None)
        .unwrap();
    let other = store.start_turn(&foreign.id).unwrap();
    let approval = store
        .create_approval(&foreign.id, &other.id, "write", "digest")
        .unwrap();
    store.complete_turn(&other.id, "completed").unwrap();
    fs::write(store.turn_path(&other.id), b"bad foreign turn").unwrap();
    fs::write(store.approval_path(&approval.id), b"bad foreign approval").unwrap();
    assert!(store.list_turns(&thread.id).unwrap().is_empty());
    assert!(store.list_approvals(&thread.id).unwrap().is_empty());
    assert!(
        store
            .read_thread_activity(&thread.id)
            .unwrap()
            .last_turn
            .is_none()
    );
    assert!(store.list_turns(&foreign.id).is_err());
    assert!(store.list_approvals(&foreign.id).is_err());
    // A new admission checks running turns, not every terminal record in the Home.
    assert!(store.start_turn(&thread.id).is_ok());
}

#[test]
fn legacy_shard_wins_flat_copy_and_invalidation_drops_removed_legacy_records() {
    let (store, thread) = setup();
    let turn = store.start_turn(&thread.id).unwrap();
    let mut legacy = Item {
        id: new_id("item"),
        thread_id: thread.id.clone(),
        turn_id: turn.id.clone(),
        kind: "userInput".into(),
        status: "waiting_input".into(),
        seq: 900,
        payload: json!({"text":"flat"}),
    };
    fs::create_dir_all(store.item_path(&legacy.id).parent().unwrap()).unwrap();
    fs::write(
        store.item_path(&legacy.id),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    legacy.payload = json!({"text":"shard"});
    let shard = store.sharded_item_path(&thread.id, Some(legacy.seq), &legacy.id);
    fs::create_dir_all(shard.parent().unwrap()).unwrap();
    fs::write(&shard, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let reopened = ProductStore::open(store.paths.clone()).unwrap();
    let history = reopened
        .read_thread_history(&thread.id, None, 100, None, 100)
        .unwrap();
    assert_eq!(history.items.len(), 1);
    assert_eq!(history.items[0].payload["text"], "shard");
    assert_eq!(history.activity.pending_user_inputs.len(), 1);
    fs::remove_file(&shard).unwrap();
    fs::remove_file(store.item_path(&legacy.id)).unwrap();
    reopened.invalidate_recovered_cache();
    assert!(
        reopened
            .read_thread_history(&thread.id, None, 100, None, 100)
            .unwrap()
            .items
            .is_empty()
    );
}

#[test]
fn mismatched_wal_timeline_identity_fails_before_replacing_the_valid_projection() {
    let (store, thread) = setup();
    let turn = store.start_turn(&thread.id).unwrap();
    let original = fs::read(store.turn_path(&turn.id)).unwrap();
    let mut changed = false;
    for entry in fs::read_dir(store.wal_dir()).unwrap() {
        let path = entry.unwrap().path();
        let mut transaction: Value = read_json(&path).unwrap();
        for write in transaction["writes"].as_array_mut().unwrap() {
            if write["kind"] == "turn" && write["id"] == turn.id {
                write["document"]["id"] = json!("turn_wrong_identity");
                changed = true;
            }
        }
        if changed {
            fs::write(path, serde_json::to_vec(&transaction).unwrap()).unwrap();
            break;
        }
    }
    assert!(changed);
    assert!(matches!(
        ProductStore::open(store.paths.clone()),
        Err(StoreError::Corrupt(_))
    ));
    assert_eq!(fs::read(store.turn_path(&turn.id)).unwrap(), original);
}

/// Generates durable synthetic histories for the real daemon/Web paging probe.
/// No model-execution claim is made by this explicitly requested manual test.
#[test]
#[ignore = "manual durable mixed-history performance evidence"]
fn mixed_history_daemon_fixture() {
    let home = std::path::PathBuf::from(
        std::env::var_os("KNORVIA_TIMELINE_BENCH_HOME")
            .expect("explicit isolated fixture Home required"),
    );
    assert!(
        !home.exists(),
        "fixture generator must never reuse an existing Home"
    );
    let store = ProductStore::open(layout(home.clone())).unwrap();
    let first = store.create_workspace("mixed history").unwrap();
    let second = store.create_workspace("other project").unwrap();
    let empty = store.create_workspace("empty project").unwrap();
    let started = std::time::Instant::now();
    let mut threads = Vec::new();
    for number in 0..2500 {
        let workspace = if number % 7 == 0 { &second } else { &first };
        let thread = store
            .create_thread(&workspace.id, &format!("history task {number}"), None, None)
            .unwrap();
        let turn = store.start_turn(&thread.id).unwrap();
        for item in 0..3 {
            store
                .append_item(
                    &thread.id,
                    &turn.id,
                    "agentMessage",
                    "completed",
                    json!({"text":format!("synthetic {number}/{item}")}),
                )
                .unwrap();
        }
        store.complete_turn(&turn.id, "completed").unwrap();
        threads.push(thread);
        if number % 500 == 499 {
            eprintln!(
                "mixed history generated threads={} elapsed_ms={}",
                number + 1,
                started.elapsed().as_millis()
            );
        }
    }
    let deep = &threads[0];
    let turn = store.start_turn(&deep.id).unwrap();
    for number in 0..10000 {
        store
            .append_item(
                &deep.id,
                &turn.id,
                "agentMessage",
                "completed",
                json!({"text":format!("synthetic deep item {number}")}),
            )
            .unwrap();
    }
    store.complete_turn(&turn.id, "completed").unwrap();
    let summary = json!({
        "scope":"Synthetic histories committed through the real ProductStore; no model execution",
        "home":home, "projects":[first.id, second.id, empty.id],
        "threadIds":threads.iter().map(|thread| &thread.id).collect::<Vec<_>>(),
        "deepThreadId":deep.id, "threads":2500, "turns":2501, "items":17500,
        "deepItems":10003, "generationMs":started.elapsed().as_millis(),
    });
    fs::write(
        home.join("fixture-summary.json"),
        serde_json::to_vec_pretty(&summary).unwrap(),
    )
    .unwrap();
    eprintln!(
        "mixed history fixture complete elapsed_ms={}",
        started.elapsed().as_millis()
    );
}
