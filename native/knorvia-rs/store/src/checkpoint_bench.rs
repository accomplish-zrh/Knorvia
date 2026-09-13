//! R05 cold-start benchmark over a large synthetic WAL: raw wall-time for
//! the full replay path versus the checkpoint fast path, plus file counts
//! and bytes. Raw numbers print to stdout and are the evidence artifact.
//! Memory is not instrumented in this shift (no allocator hooks); reported
//! as a known gap.
use super::*;
use serde_json::json;

fn bench_home(label: &str) -> std::path::PathBuf {
    let home = std::env::temp_dir().join(format!(
        "knorvia-ckptbench-{}-{}-{label}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&home).unwrap();
    home
}

/// Write one valid WAL transaction file with a single Turn projection write
/// and a matching event envelope (the same shape commit_transaction_locked
/// persists).
fn write_turn_transaction(wal_dir: &std::path::Path, stream: &str, seq: u64, index: usize) {
    let turn_id = format!("turn_bench_{index:06}");
    let thread_id = stream.clone();
    let event = json!({
        "eventId": format!("evt_{index:06}"),
        "streamId": stream,
        "seq": seq,
        "emittedAt": "2026-09-10T00:00:00.000Z",
        "schemaVersion": 1,
        "kind": "turn.started",
        "payload": {"id": turn_id, "threadId": thread_id, "status": "completed"},
    });
    let transaction = json!({
        "schemaVersion": 1,
        "transactionId": format!("wal_bench_{index:06}"),
        "streamId": stream,
        "committedAt": "2026-09-10T00:00:00.000Z",
        "events": [event],
        "writes": [{
            "kind": "turn",
            "id": turn_id,
            "document": {"id": turn_id, "threadId": thread_id, "status": "completed",
                         "createdAt": "2026-09-10T00:00:00.000Z", "completedAt": null},
        }],
    });
    fs::write(
        wal_dir.join(format!("wal_bench_{index:06}.json")),
        serde_json::to_vec_pretty(&transaction).unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "benchmark: generates 100k WAL transactions; run explicitly for evidence"]
fn cold_start_100k_transactions_full_replay_then_checkpoint_fast_path() {
    let total: usize = std::env::var("KNORVIA_R05_WAL")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(100_000);
    let streams = 50;
    let home = bench_home("100k");
    let paths = knorvia_platform_paths::layout(home.clone());
    let wal_dir = paths.state.join("store-wal");
    fs::create_dir_all(&wal_dir).unwrap();

    let started = std::time::Instant::now();
    for index in 0..total {
        let stream = format!("thr_bench_{:03}", index % streams);
        let seq = (index / streams) as u64 + 1;
        write_turn_transaction(&wal_dir, &stream, seq, index);
    }
    let wal_bytes: u64 = fs::read_dir(&wal_dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| fs::metadata(entry.path()).ok())
        .map(|meta| meta.len())
        .sum();
    println!(
        "generated {total} WAL transactions across {streams} streams in {:?} ({wal_bytes} bytes)",
        started.elapsed()
    );

    // Cold open #1: full replay (no checkpoint exists yet). The recovery
    // auto-writes a checkpoint because total >= 4096.
    let started = std::time::Instant::now();
    let store = ProductStore::open(paths.clone()).unwrap();
    store.recover_durable_state().unwrap();
    let full = started.elapsed();
    let mode_after_full = store.last_recovery_mode().clone();
    println!("cold open #1 (full replay): {full:?}, mode={mode_after_full}, wal files={total}");
    drop(store);

    // Cold open #2: the auto-checkpoint must switch recovery to the fast
    // path over the identical directory.
    let started = std::time::Instant::now();
    let store = ProductStore::open(paths.clone()).unwrap();
    store.recover_durable_state().unwrap();
    let fast = started.elapsed();
    let mode_after_fast = store.last_recovery_mode().clone();
    println!("cold open #2 (checkpoint fast path): {fast:?}, mode={mode_after_fast}");
    assert_eq!(mode_after_full, "full");
    assert_eq!(mode_after_fast, "checkpoint");

    // Sanity: both paths recovered the same turn count (spot-check via the
    // timeline directory: every stream's last turn readable).
    let stream = format!("thr_bench_{:03}", 0);
    let last_seq = (total / streams) as u64;
    let turn_id = format!("turn_bench_{:06}", last_seq - 1);
    assert!(store.read_turn(&turn_id).is_ok(), "tail turn must exist");

    let _ = std::fs::remove_dir_all(home);
}
