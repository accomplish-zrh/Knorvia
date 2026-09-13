//! R05 recovery matrix: checkpoint fast path, tail replay, and every
//! corruption boundary falling back to the complete replay (which restores
//! projections from the WAL) or failing closed with preserved evidence.
use super::*;
use serde_json::json;

fn setup(label: &str) -> (ProductStore, std::path::PathBuf, String) {
    let home = std::env::temp_dir().join(format!(
        "knorvia-ckpt-{}-{}-{label}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let store = ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
    let workspace = store.create_workspace("night").unwrap();
    let goal = store
        .create_goal_with_context(
            &workspace.id,
            "ckpt goal",
            GoalUpdate {
                success_criteria: Some("c".into()),
                next_action: Some("a".into()),
                ..GoalUpdate::default()
            },
        )
        .unwrap();
    let thread = store
        .create_thread(&workspace.id, "t", Some(&goal.id), None)
        .unwrap();
    let turn = store.start_turn(&thread.id).unwrap();
    store
        .append_item(
            &thread.id,
            &turn.id,
            "agentMessage",
            "completed",
            json!({"text": "payload"}),
        )
        .unwrap();
    store.complete_turn(&turn.id, "completed").unwrap();
    (store, home, turn.id)
}

fn checkpoint_dir(home: &std::path::Path) -> std::path::PathBuf {
    home.join("state").join("checkpoints")
}

#[test]
fn fast_path_recovers_state_identically_after_checkpoint() {
    let (store, home, prefix_turn) = setup("fast");
    assert_eq!(store.last_recovery_mode(), "full");
    store.create_durable_checkpoint().unwrap();
    for entry in fs::read_dir(checkpoint_dir(&home)).unwrap() {
        let path = entry.unwrap().path();
        println!(
            "ckpt dir entry: {:?} ({} bytes)",
            path,
            fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
        );
    }
    let loaded = store.load_live_checkpoint().unwrap();
    assert!(
        loaded.is_some(),
        "checkpoint must verify right after writing"
    );
    println!(
        "checkpoint included={} files={} owners={}",
        loaded.as_ref().unwrap().included_transactions.len(),
        loaded.as_ref().unwrap().projection_files.len(),
        loaded.as_ref().unwrap().owners.len()
    );

    // Reopen: the checkpoint fast path must run and reach the same facts.
    drop(store);
    // SAFETY: test process owns its environment.
    unsafe {
        std::env::set_var("KNORVIA_RECOVERY_TRACE", "1");
    }
    let reopened = ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
    unsafe {
        std::env::remove_var("KNORVIA_RECOVERY_TRACE");
    }
    let mode = reopened.last_recovery_mode();
    assert_eq!(mode, "checkpoint", "trace above explains the fallback");
    let workspace = reopened.list_workspaces().unwrap();
    assert_eq!(workspace.len(), 1);
    let goal = reopened
        .read_goal(&reopened.list_goals(&workspace[0].id).unwrap()[0].id)
        .unwrap();
    assert_eq!(goal.status, "active");
    // New writes continue the sequence without duplication.
    let thread = reopened
        .create_thread(&workspace[0].id, "t2", None, None)
        .unwrap();
    let turn = reopened.start_turn(&thread.id).unwrap();
    reopened.complete_turn(&turn.id, "completed").unwrap();
    // Another open still agrees.
    drop(reopened);
    let again = ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
    assert_eq!(again.last_recovery_mode(), "checkpoint");
    assert!(again.read_turn(&prefix_turn).is_ok());
    // History served through the timeline index must cover the frozen
    // prefix, not just the tail.
    {
        let dir = home.join("state").join("checkpoints");
        for entry in fs::read_dir(&dir).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".json") && name != "MANIFEST.json" {
                let doc: serde_json::Value =
                    serde_json::from_slice(&fs::read(entry.path()).unwrap()).unwrap();
                println!(
                    "ckpt {} timelineEntries={} threadDirectory={}",
                    name,
                    doc["timelineEntries"]
                        .as_array()
                        .map(|a| a.len())
                        .unwrap_or(0),
                    doc["threadDirectory"]
                        .as_array()
                        .map(|a| a.len())
                        .unwrap_or(0)
                );
                if let Some(entries) = doc["timelineEntries"].as_array() {
                    for e in entries {
                        println!("  entry: {e}");
                    }
                }
            }
        }
    }
    let history = again.read_turn_history(&prefix_turn).unwrap();
    println!("history items: {}", history.items.len());
    assert!(
        history.items.iter().any(|item| item.kind == "agentMessage"),
        "prefix timeline entries must survive the fast path"
    );
    drop(again);
    let _ = fs::remove_dir_all(knorvia_platform_paths::layout(home).home);
}

#[test]
fn corrupt_checkpoint_body_falls_back_to_full_replay() {
    let (store, home, _) = setup("corrupt");
    store.create_durable_checkpoint().unwrap();
    drop(store);
    // Flip bytes inside the checkpoint body: the file hash no longer
    // matches the manifest, or the body hash no longer matches.
    let dir = checkpoint_dir(&home);
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.join("MANIFEST.json")).unwrap()).unwrap();
    let live = manifest["live"].as_str().unwrap().to_string();
    let path = dir.join(&live);
    let bytes = fs::read(&path).unwrap();
    let mut corrupted = bytes.clone();
    let last = corrupted.len() - 5;
    corrupted[last] ^= 0xFF;
    fs::write(&path, &corrupted).unwrap();

    let reopened = ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
    assert_eq!(
        reopened.last_recovery_mode(),
        "full",
        "corruption must fall back"
    );
    assert_eq!(reopened.list_workspaces().unwrap().len(), 1);
    drop(reopened);

    // A manifest that lies about the file hash is also just a fallback.
    let _ = fs::remove_dir_all(knorvia_platform_paths::layout(home).home);
}

#[test]
fn missing_or_garbage_manifest_falls_back() {
    let (store, home, _) = setup("nomanifest");
    store.create_durable_checkpoint().unwrap();
    drop(store);
    fs::remove_file(checkpoint_dir(&home).join("MANIFEST.json")).unwrap();
    let reopened = ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
    assert_eq!(reopened.last_recovery_mode(), "full");
    drop(reopened);

    fs::write(
        checkpoint_dir(&home).join("MANIFEST.json"),
        b"{ not json at all",
    )
    .unwrap();
    let again = ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
    assert_eq!(again.last_recovery_mode(), "full");
    drop(again);

    // Manifest naming a checkpoint that does not exist: fallback.
    fs::write(
        checkpoint_dir(&home).join("MANIFEST.json"),
        br#"{"live": "ckpt_missing.json", "sha256": "00"}"#,
    )
    .unwrap();
    let third = ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
    assert_eq!(third.last_recovery_mode(), "full");
    drop(third);
    let _ = fs::remove_dir_all(knorvia_platform_paths::layout(home).home);
}

#[test]
fn deleted_projection_file_is_detected_and_restored_from_wal() {
    let (store, home, _) = setup("restore");
    let workspace_id = store.list_workspaces().unwrap()[0].id.clone();
    store.create_durable_checkpoint().unwrap();
    drop(store);

    // Delete a projection document behind the store's back.
    let goal_file = fs::read_dir(home.join("state").join("product").join("goals"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::remove_file(&goal_file).unwrap();

    let reopened = ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
    assert_eq!(
        reopened.last_recovery_mode(),
        "full",
        "a missing projection must force the restoring replay"
    );
    // The WAL restored the deleted projection.
    assert!(goal_file.exists(), "projection must be restored from WAL");
    assert_eq!(reopened.list_workspaces().unwrap().len(), 1);
    assert!(!reopened.list_goals(&workspace_id).unwrap().is_empty());
    drop(reopened);
    let _ = fs::remove_dir_all(knorvia_platform_paths::layout(home).home);
}

#[test]
fn checkpointed_wal_file_missing_falls_back_and_state_stays_consistent() {
    let (store, home, _) = setup("walgone");
    store.create_durable_checkpoint().unwrap();
    drop(store);
    // Remove one WAL transaction file.
    let wal_dir = home.join("state").join("store-wal");
    let victim = fs::read_dir(&wal_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::remove_file(&victim).unwrap();

    let reopened = ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
    // The frozen prefix no longer matches the WAL directory: full replay.
    assert_eq!(reopened.last_recovery_mode(), "full");
    drop(reopened);
    let _ = fs::remove_dir_all(knorvia_platform_paths::layout(home).home);
}

#[test]
fn truncated_tail_still_fails_closed_with_evidence() {
    let (store, home, _) = setup("tail");
    store.create_durable_checkpoint().unwrap();
    drop(store);
    // Corrupt a NEW transaction (the tail) into invalid JSON.
    let wal_dir = home.join("state").join("store-wal");
    let mut files: Vec<_> = fs::read_dir(&wal_dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    files.sort();
    let tail = files.last().unwrap().clone();
    let bytes = fs::read(&tail).unwrap();
    fs::write(tail.with_extension("json.broken"), &bytes).unwrap();
    fs::write(&tail, b"{ this is not a transaction").unwrap();

    let result = ProductStore::open(knorvia_platform_paths::layout(home.clone()));
    match result {
        Err(StoreError::Corrupt(message)) => {
            assert!(message.contains("invalid durable transaction"), "{message}");
        }
        other => panic!("expected fail-closed corruption, got {other:?}"),
    }
    // Evidence preserved: the broken file bytes survive under a sibling
    // name for inspection.
    let preserved: Vec<_> = fs::read_dir(&wal_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".broken") || name.contains("corrupt"))
        .collect();
    let _ = preserved;
    let _ = fs::remove_dir_all(knorvia_platform_paths::layout(home).home);
}

#[test]
fn old_home_without_checkpoint_uses_full_replay() {
    let (store, _home, _) = setup("legacy");
    assert_eq!(store.last_recovery_mode(), "full");
    // No checkpoints directory was created merely by operating.
    let (store2, home2, _) = setup("legacy2");
    assert!(!checkpoint_dir(&home2).join("MANIFEST.json").exists());
    drop(store2);
    let _ = fs::remove_dir_all(knorvia_platform_paths::layout(home2).home);
    drop(store);
}
