use super::*;
use knorvia_platform_paths::layout;
use std::fs;

const T0: i64 = 1_700_000_000_000;

fn store() -> (ProductStore, std::path::PathBuf) {
    let base = std::env::temp_dir().join(format!(
        "knorvia-automation-store-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&base).unwrap();
    (ProductStore::open(layout(base.clone())).unwrap(), base)
}

fn workspace(store: &ProductStore) -> String {
    store.create_workspace("Automation tests").unwrap().id
}

#[test]
fn interval_and_once_schedules_use_utc_epoch_and_coalesce_missed_ticks() {
    let (store, home) = store();
    let workspace_id = workspace(&store);
    let interval = store
        .create_automation_at(
            "Interval",
            "report",
            &workspace_id,
            AutomationSchedule::Interval { minutes: 1 },
            AutomationStatus::Active,
            T0,
        )
        .unwrap();
    let once = store
        .create_automation_at(
            "Once",
            "remind",
            &workspace_id,
            AutomationSchedule::Once { at: T0 + 90_000 },
            AutomationStatus::Active,
            T0,
        )
        .unwrap();
    assert_eq!(interval.next_run_at, Some(T0 + 60_000));
    assert_eq!(once.next_run_at, Some(T0 + 90_000));

    let claimed = store.claim_due_automations_at(T0 + 300_000).unwrap();
    assert_eq!(claimed.len(), 2);
    let interval_after = store.read_automation(&interval.id).unwrap();
    let once_after = store.read_automation(&once.id).unwrap();
    assert_eq!(interval_after.next_run_at, Some(T0 + 360_000));
    assert_eq!(once_after.next_run_at, None);
    assert_eq!(
        claimed
            .iter()
            .find(|run| run.automation_id == interval.id)
            .unwrap()
            .scheduled_for,
        Some(T0 + 60_000)
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn paused_and_edited_automation_cannot_start_a_queued_old_prompt() {
    let (store, home) = store();
    let workspace_id = workspace(&store);
    let automation = store
        .create_automation_at(
            "Paused",
            "old prompt",
            &workspace_id,
            AutomationSchedule::Once { at: T0 },
            AutomationStatus::Paused,
            T0,
        )
        .unwrap();
    assert!(store.claim_due_automations_at(T0 + 1).unwrap().is_empty());

    let resumed = store
        .update_automation_at(
            &automation.id,
            AutomationUpdate {
                status: Some(AutomationStatus::Active),
                ..Default::default()
            },
            Some(automation.revision),
            T0 + 2,
        )
        .unwrap();
    let run = store
        .claim_due_automations_at(T0 + 3)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(run.prompt, "old prompt");
    let updated = store
        .update_automation_at(
            &automation.id,
            AutomationUpdate {
                prompt: Some("new prompt".into()),
                ..Default::default()
            },
            Some(resumed.revision + 1), // claim advances revision once
            T0 + 4,
        )
        .unwrap();
    assert_eq!(updated.prompt, "new prompt");
    assert_eq!(
        store.list_automation_runs(&automation.id, 10).unwrap()[0].state,
        AutomationRunState::Skipped
    );
    assert!(
        store
            .materialize_automation_run(&run.id, T0 + 5)
            .unwrap()
            .is_none()
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn stale_claim_is_recorded_as_interrupted_and_never_replayed_after_restart() {
    let (store, home) = store();
    let workspace_id = workspace(&store);
    let automation = store
        .create_automation_at(
            "One shot",
            "only once",
            &workspace_id,
            AutomationSchedule::Once { at: T0 },
            AutomationStatus::Active,
            T0,
        )
        .unwrap();
    let claimed = store.claim_due_automations_at(T0).unwrap();
    assert_eq!(claimed.len(), 1);
    drop(store);

    let restarted = ProductStore::open(layout(home.clone())).unwrap();
    restarted
        .recover_automation_runs_after_restart(T0 + 10)
        .unwrap();
    let runs = restarted.list_automation_runs(&automation.id, 10).unwrap();
    assert_eq!(runs[0].state, AutomationRunState::Interrupted);
    assert!(runs[0].error.as_deref().unwrap().contains("not retried"));
    assert!(
        restarted
            .claim_due_automations_at(T0 + 20)
            .unwrap()
            .is_empty()
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn one_plan_never_has_overlapping_runs_and_manual_run_can_bypass_pause() {
    let (store, home) = store();
    let workspace_id = workspace(&store);
    let automation = store
        .create_automation_at(
            "Manual",
            "run now",
            &workspace_id,
            AutomationSchedule::Interval { minutes: 5 },
            AutomationStatus::Paused,
            T0,
        )
        .unwrap();
    let run = store
        .claim_manual_automation_run_at(&automation.id, T0 + 1)
        .unwrap();
    assert_eq!(run.trigger, AutomationTrigger::Manual);
    assert!(matches!(
        store.claim_manual_automation_run_at(&automation.id, T0 + 2),
        Err(StoreError::Protocol(_))
    ));
    assert!(
        store
            .claim_due_automations_at(T0 + 600_000)
            .unwrap()
            .is_empty()
    );
    store
        .fail_automation_run(&run.id, "scripted admission failure", T0 + 3)
        .unwrap();
    assert!(
        store
            .claim_manual_automation_run_at(&automation.id, T0 + 4)
            .is_ok()
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn materialized_run_keeps_a_traceable_real_product_thread() {
    let (store, home) = store();
    let workspace_id = workspace(&store);
    let automation = store
        .create_automation_with_settings_at(
            "Writable only by opt in",
            "do work",
            &workspace_id,
            AutomationSchedule::Interval { minutes: 1 },
            AutomationStatus::Active,
            true,
            Some("gpt-5.6-terra".into()),
            Some("max".into()),
            T0,
        )
        .unwrap();
    let claimed = store
        .claim_manual_automation_run_at(&automation.id, T0 + 1)
        .unwrap();
    let run = store
        .materialize_automation_run(&claimed.id, T0 + 2)
        .unwrap()
        .unwrap();
    let thread_id = run.thread_id.clone().unwrap();
    let thread = store.read_thread(&thread_id).unwrap();
    assert_eq!(thread.workspace_id, workspace_id);
    assert!(thread.title.contains("Writable only by opt in"));
    assert!(run.allow_writes);
    assert_eq!(run.model.as_deref(), Some("gpt-5.6-terra"));
    assert_eq!(run.reasoning_effort.as_deref(), Some("max"));
    let _ = fs::remove_dir_all(home);
}

/// A crash after materialization (real Thread exists, executor admission next)
/// must leave a traceable Thread, mark the run Interrupted on restart, and
/// never replay the occurrence automatically.
#[test]
fn crash_after_materialization_interrupts_the_run_and_keeps_the_thread_traceable() {
    let (store, home) = store();
    let workspace_id = workspace(&store);
    let automation = store
        .create_automation_at(
            "Crash point",
            "materialize then die",
            &workspace_id,
            AutomationSchedule::Once { at: T0 },
            AutomationStatus::Active,
            T0,
        )
        .unwrap();
    let claimed = store.claim_due_automations_at(T0).unwrap();
    assert_eq!(claimed.len(), 1);
    let run = store
        .materialize_automation_run(&claimed[0].id, T0 + 1)
        .unwrap()
        .unwrap();
    let thread_id = run
        .thread_id
        .clone()
        .expect("materialized run has a thread");
    drop(store);

    let restarted = ProductStore::open(layout(home.clone())).unwrap();
    restarted
        .recover_automation_runs_after_restart(T0 + 10)
        .unwrap();
    let runs = restarted.list_automation_runs(&automation.id, 10).unwrap();
    assert_eq!(runs[0].state, AutomationRunState::Interrupted);
    assert_eq!(
        runs[0].thread_id.as_deref(),
        Some(thread_id.as_str()),
        "the real product Thread stays traceable for review"
    );
    assert!(
        restarted
            .claim_due_automations_at(T0 + 20)
            .unwrap()
            .is_empty(),
        "the once-scheduled occurrence must not be re-claimed after restart"
    );
    let _ = fs::remove_dir_all(home);
}
