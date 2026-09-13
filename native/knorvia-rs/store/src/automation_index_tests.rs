//! R04: index correctness against durable facts, and the tick-cost
//! benchmark over a large synthetic history (100k runs / 512 plans).
use super::*;
use serde_json::json;

fn bench_home(label: &str) -> std::path::PathBuf {
    let home = std::env::temp_dir().join(format!(
        "knorvia-autoidx-{}-{}-{label}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&home).unwrap();
    home
}

fn terminal_run_file(dir: &std::path::Path, automation_id: &str, index: usize) {
    let id = format!("autorun_hist_{index:06}");
    let document = json!({
        "id": id, "automationId": automation_id,
        "trigger": "scheduled", "scheduledFor": 1, "claimedAt": 1,
        "startedAt": 2, "finishedAt": 3, "state": "succeeded",
        "threadId": format!("thr_hist_{index:06}"),
        "turnId": format!("turn_hist_{index:06}"),
        "title": "history", "prompt": "p", "workspaceId": "ws_bench",
        "allowWrites": false,
    });
    fs::write(
        dir.join(format!("{id}.json")),
        serde_json::to_vec_pretty(&document).unwrap(),
    )
    .unwrap();
}

/// A process that starts against an existing Home with a large history and
/// live runs must discover them through the index build, not silently skip.
#[test]
fn index_build_from_existing_history_sees_active_runs() {
    let home = bench_home("rebuild");
    let store = ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
    let workspace = store.create_workspace("night").unwrap();
    let automation = store
        .create_automation(
            "plan",
            "prompt",
            &workspace.id,
            AutomationSchedule::Interval { minutes: 1440 },
            AutomationStatus::Active,
        )
        .unwrap();
    let dir = store.paths().home.join("state/product/automation-runs");
    fs::create_dir_all(&dir).unwrap();
    // History the index has never seen.
    for index in 0..250 {
        terminal_run_file(&dir, &automation.id, index);
    }
    // An orphan active run file (a crashed owner left it behind).
    let orphan = json!({
        "id": "autorun_orphan0001", "automationId": automation.id,
        "trigger": "scheduled", "scheduledFor": 1, "claimedAt": 1,
        "state": "claimed", "title": "orphan", "prompt": "p",
        "workspaceId": workspace.id, "allowWrites": false,
    });
    fs::write(
        dir.join("autorun_orphan0001.json"),
        serde_json::to_vec_pretty(&orphan).unwrap(),
    )
    .unwrap();

    // The resumable scan must discover the orphan through the index build
    // and offer it (claimed = pre-model), instead of missing it.
    let resumable = store.list_resumable_automation_runs(64).unwrap();
    assert!(
        resumable.iter().any(|run| run.id == "autorun_orphan0001"),
        "index build must discover active runs from disk: {resumable:?}"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// Deterministic tick-cost benchmark over a large synthetic history.
/// Raw numbers go to stdout; the run log is the evidence.
#[test]
#[ignore = "benchmark: generates 100k run files; run explicitly for evidence"]
fn tick_cost_with_large_history_and_few_active_runs() {
    let history: usize = std::env::var("KNORVIA_R04_HISTORY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(100_000);
    let home = bench_home("bench");
    let store = ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
    let workspace = store.create_workspace("night").unwrap();
    let dir = store.paths().home.join("state/product/automation-runs");
    fs::create_dir_all(&dir).unwrap();

    // Synthetic terminal history, written directly (durable shape identical
    // to the store's own writes).
    let started = std::time::Instant::now();
    let automation_id = "autorun_hist_owner".to_string();
    for index in 0..history {
        terminal_run_file(&dir, &automation_id, index);
    }
    println!(
        "generated {history} terminal run files in {:?}",
        started.elapsed()
    );

    // 512 bounded plans, none due right after creation.
    let mut plans = Vec::new();
    for index in 0..512 {
        let plan = store
            .create_automation(
                &format!("plan-{index}"),
                "prompt",
                &workspace.id,
                AutomationSchedule::Interval { minutes: 1440 },
                AutomationStatus::Active,
            )
            .unwrap();
        plans.push(plan);
    }
    // One real active run through the durable claim path.
    let now = crate::epoch_millis();
    let _active = store
        .claim_manual_automation_run_at(&plans[0].id, now)
        .unwrap();

    // "Baseline": the pre-R04 tick read the entire history through
    // all_automation_runs. Measure that cost directly.
    let started = std::time::Instant::now();
    let all = {
        let _mutations = store.lock_mutations();
        let _journal = store.lock_journal();
        store.all_automation_runs_locked().unwrap()
    };
    let baseline = started.elapsed();
    println!(
        "baseline full-history read: {:?} for {} runs (this was every tick pre-R04)",
        baseline,
        all.len()
    );

    // Indexed tick: reconcile + claim + resumable, the 250ms loop body.
    let started = std::time::Instant::now();
    store.reconcile_automation_runs(now).unwrap();
    let _claimed = store.claim_due_automations_at(now).unwrap();
    let resumable = store.list_resumable_automation_runs(64).unwrap();
    let indexed = started.elapsed();
    println!(
        "indexed tick (reconcile+claim+resumable): {:?}, resumable={} (active-run reads only)",
        indexed,
        resumable.len()
    );
    // Second tick: the index is warm (no full scan inside).
    let started = std::time::Instant::now();
    store.reconcile_automation_runs(now).unwrap();
    let _ = store.claim_due_automations_at(now).unwrap();
    let _ = store.list_resumable_automation_runs(64).unwrap();
    println!("indexed warm tick: {:?}", started.elapsed());

    // Cancellation-path responsiveness: reading one active run and finishing
    // it must not touch history.
    let started = std::time::Instant::now();
    let resumable = store.list_resumable_automation_runs(64).unwrap();
    assert!(!resumable.is_empty());
    println!("resumable lookup: {:?}", started.elapsed());

    let _ = std::fs::remove_dir_all(&home);
}
