//! R02 store-level tests: atomic admission, idempotent key lookup, and
//! reconciliation that reflects only durable Turn facts.
use super::*;
use knorvia_protocol::GoalExecution;
use serde_json::json;

fn setup() -> (ProductStore, Workspace, Goal, Thread) {
    let home = std::env::temp_dir().join(format!(
        "knorvia-goalrun-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let store = ProductStore::open(knorvia_platform_paths::layout(home)).unwrap();
    let workspace = store.create_workspace("night").unwrap();
    let goal = store
        .create_goal_with_context(
            &workspace.id,
            "night goal",
            GoalUpdate {
                success_criteria: Some("done means done".into()),
                next_action: Some("first action".into()),
                ..GoalUpdate::default()
            },
        )
        .unwrap();
    let thread = store
        .create_thread(&workspace.id, "task", Some(&goal.id), None)
        .unwrap();
    (store, workspace, goal, thread)
}

fn admit(
    store: &ProductStore,
    goal: &Goal,
    thread: &Thread,
    key: &str,
    advance: Option<Value>,
) -> (GoalExecution, Turn) {
    store
        .start_goal_execution_turn(
            &goal.id,
            &thread.id,
            key,
            "digest-1",
            "first action",
            advance,
        )
        .unwrap()
}

#[test]
fn admission_is_atomic_and_key_lookup_finds_the_batch() {
    let (store, _ws, goal, thread) = setup();
    let (execution, turn) = admit(&store, &goal, &thread, "rk-1", None);
    assert_eq!(execution.status, "running");
    assert_eq!(execution.rounds.len(), 1);
    assert_eq!(execution.rounds[0].turn_id, turn.id);
    assert_eq!(turn.status, "running");
    let found = store
        .find_goal_execution_by_key(&goal.id, "rk-1")
        .unwrap()
        .expect("same key resolves to the same batch");
    assert_eq!(found.id, execution.id);
    assert!(
        store
            .find_goal_execution_by_key(&goal.id, "other")
            .unwrap()
            .is_none()
    );
    // Admission-before failure: a stale goal revision is refused by control;
    // at store level a non-goal thread must not admit.
    let stray = store
        .create_thread(&execution.workspace_id, "stray", None, None)
        .unwrap();
    assert!(
        store
            .start_goal_execution_turn(&goal.id, &stray.id, "rk-x", "d", "p", None)
            .is_err()
    );
}

#[test]
fn goal_turn_exclusivity_is_enforced_across_keys() {
    let (store, _ws, goal, thread) = setup();
    let _first = admit(&store, &goal, &thread, "rk-a", None);
    let error = store
        .start_goal_execution_turn(&goal.id, &thread.id, "rk-b", "digest-2", "p", None)
        .unwrap_err();
    assert!(format!("{error}").contains("active Turn") || format!("{error}").contains("running"));
}

#[test]
fn close_goal_round_maps_the_durable_terminal() {
    for (turn_status, expected) in [
        ("completed", "completed"),
        ("failed", "failed"),
        ("interrupted", "interrupted"),
        ("cancelled", "cancelled"),
    ] {
        let (store, _ws, goal, thread) = setup();
        let (execution, turn) = admit(&store, &goal, &thread, "rk", None);
        store.complete_turn(&turn.id, turn_status).unwrap();
        store.close_goal_round(&turn.id, turn_status).unwrap();
        let closed = store.read_goal_execution(&execution.id).unwrap();
        assert_eq!(closed.status, expected);
        assert_eq!(closed.stop_reason.as_deref(), Some(expected));
        assert!(closed.terminal_at.is_some());
        assert_eq!(closed.rounds[0].status, turn_status);
    }
}

#[test]
fn reconcile_closes_a_round_the_runner_never_closed() {
    // Crash simulation: the Turn reached a terminal fact but the process
    // died before the round close. Reconciliation must reflect the durable
    // Turn, never invent completion.
    let (store, _ws, goal, thread) = setup();
    let (execution, turn) = admit(&store, &goal, &thread, "rk", None);
    store.complete_turn(&turn.id, "interrupted").unwrap();
    let stale = store.read_goal_execution(&execution.id).unwrap();
    assert_eq!(stale.status, "running");
    let reconciled = store.reconcile_goal_execution(stale, false).unwrap();
    assert_eq!(reconciled.status, "interrupted");
    assert_eq!(reconciled.rounds[0].status, "interrupted");
    assert!(reconciled.terminal_at.is_some());
    // Terminal batches reconcile to themselves.
    let again = store
        .reconcile_goal_execution(reconciled.clone(), false)
        .unwrap();
    assert_eq!(again, reconciled);
}

#[test]
fn advance_batches_pause_as_interrupted_when_reconciled_mid_policy() {
    let (store, _ws, goal, thread) = setup();
    let advance = json!({"maxRounds": 3});
    let (execution, turn) = admit(&store, &goal, &thread, "rk", Some(advance.clone()));
    assert_eq!(execution.advance, Some(advance));
    store.complete_turn(&turn.id, "completed").unwrap();
    let reconciled = store
        .reconcile_goal_execution(store.read_goal_execution(&execution.id).unwrap(), false)
        .unwrap();
    // The policy still had rounds left; nobody owns the batch: interrupted,
    // never completed and never "goal done".
    assert_eq!(reconciled.status, "interrupted");
    assert_eq!(reconciled.stop_reason.as_deref(), Some("runnerLost"));
}

#[test]
fn reconcile_closes_a_batch_abandoned_between_policy_rounds() {
    let (store, _ws, goal, thread) = setup();
    let advance = json!({"maxRounds": 3});
    let (execution, turn) = admit(&store, &goal, &thread, "rk", Some(advance));
    store.complete_turn(&turn.id, "completed").unwrap();
    store.close_goal_round(&turn.id, "completed").unwrap();
    // The runner closed round 0 but died before round 1 was admitted:
    // every round is terminal while the batch still reports running. Reads
    // and restarts must not leave that state permanent.
    let stale = store.read_goal_execution(&execution.id).unwrap();
    assert_eq!(stale.status, "running");
    assert!(stale.terminal_at.is_none());
    let reconciled = store.reconcile_goal_execution(stale, false).unwrap();
    assert_eq!(reconciled.status, "interrupted");
    assert_eq!(reconciled.stop_reason.as_deref(), Some("runnerLost"));
    assert!(reconciled.terminal_at.is_some());
    // Once closed, the abandoned batch admits no further round.
    assert!(store.begin_goal_execution_round(&execution.id).is_err());
}

#[test]
fn reconcile_leaves_an_open_batch_with_a_running_round_untouched() {
    let (store, _ws, goal, thread) = setup();
    let advance = json!({"maxRounds": 3});
    let (execution, turn) = admit(&store, &goal, &thread, "rk", Some(advance));
    store.complete_turn(&turn.id, "completed").unwrap();
    store.close_goal_round(&turn.id, "completed").unwrap();
    let (running, next_turn) = store.begin_goal_execution_round(&execution.id).unwrap();
    assert_eq!(running.rounds.len(), 2);
    let before = store.read_goal_execution(&execution.id).unwrap();
    let reconciled = store.reconcile_goal_execution(before, false).unwrap();
    assert!(reconciled.terminal_at.is_none());
    assert_eq!(reconciled.rounds[1].turn_id, next_turn.id);
    assert_eq!(reconciled.rounds[1].status, "running");
    let _ = store.complete_turn(&next_turn.id, "completed");
}

#[test]
fn rounds_advance_atomically_and_guard_exclusivity() {
    let (store, _ws, goal, thread) = setup();
    let (execution, turn) = admit(&store, &goal, &thread, "rk", Some(json!({"maxRounds": 2})));
    // Round 0's turn is still running: no next round can start.
    assert!(store.begin_goal_execution_round(&execution.id).is_err());
    store.complete_turn(&turn.id, "completed").unwrap();
    store.close_goal_round(&turn.id, "completed").unwrap();
    let open = store.read_goal_execution(&execution.id).unwrap();
    assert_eq!(open.status, "running", "policy keeps the batch open");
    let (next, next_turn) = store.begin_goal_execution_round(&execution.id).unwrap();
    assert_eq!(next.rounds.len(), 2);
    assert_eq!(next.attempt, 2);
    assert_eq!(next_turn.status, "running");
    store.complete_turn(&next_turn.id, "completed").unwrap();
    // Batch stop with a policy reason: budget/deadline/cancel land here.
    let stopped = store
        .stop_goal_execution(&execution.id, "paused", "roundsExhausted")
        .unwrap();
    assert_eq!(stopped.status, "paused");
    assert_eq!(stopped.stop_reason.as_deref(), Some("roundsExhausted"));
    let restopped = store
        .stop_goal_execution(&execution.id, "failed", "whatever")
        .unwrap();
    assert_eq!(restopped.status, "paused", "terminal batches are immutable");
}

#[test]
fn batches_survive_reopen_through_durable_facts() {
    let home = std::env::temp_dir().join(format!(
        "knorvia-goalrun-reopen-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let goal_id;
    let thread_id;
    let execution_id;
    {
        let store = ProductStore::open(knorvia_platform_paths::layout(home.clone())).unwrap();
        let workspace = store.create_workspace("night").unwrap();
        let goal = store
            .create_goal_with_context(
                &workspace.id,
                "reopen",
                GoalUpdate {
                    success_criteria: Some("c".into()),
                    ..GoalUpdate::default()
                },
            )
            .unwrap();
        let thread = store
            .create_thread(&workspace.id, "t", Some(&goal.id), None)
            .unwrap();
        let (execution, turn) = store
            .start_goal_execution_turn(&goal.id, &thread.id, "rk", "d", "p", None)
            .unwrap();
        store.complete_turn(&turn.id, "completed").unwrap();
        goal_id = goal.id;
        thread_id = thread.id;
        execution_id = execution.id;
    }
    let reopened = ProductStore::open(knorvia_platform_paths::layout(home)).unwrap();
    let execution = reopened.read_goal_execution(&execution_id).unwrap();
    assert_eq!(execution.goal_id, goal_id);
    assert_eq!(execution.thread_id, thread_id);
    // The turn reached its terminal fact before the close: reconcile maps it.
    let reconciled = reopened.reconcile_goal_execution(execution, false).unwrap();
    assert_eq!(reconciled.status, "completed");
}
