use super::*;
use serde_json::json;

fn setup() -> (ProductStore, Workspace, Goal) {
    let home = std::env::temp_dir().join(format!("knorvia-goal-{}", thread_id()));
    let store = ProductStore::open(knorvia_platform_paths::layout(home)).unwrap();
    let workspace = store.create_workspace("acceptance").unwrap();
    let goal = store
        .create_goal_with_context(
            &workspace.id,
            "deliver an answer",
            GoalUpdate {
                success_criteria: Some("verified answer persists".into()),
                next_action: Some("write the answer".into()),
                constraints: Some("isolated data only".into()),
                ..GoalUpdate::default()
            },
        )
        .unwrap();
    (store, workspace, goal)
}

fn output(store: &ProductStore, workspace: &Workspace, goal: &Goal) -> (Thread, Turn, Item) {
    let thread = store
        .create_thread(&workspace.id, "execution", Some(&goal.id), None)
        .unwrap();
    let turn = store.start_turn(&thread.id).unwrap();
    let item = store
        .append_item(
            &thread.id,
            &turn.id,
            "agentMessage",
            "completed",
            json!({"text":"verified answer"}),
        )
        .unwrap();
    (thread, turn, item)
}

#[test]
fn creation_commits_all_context_in_one_event_and_invalid_titles_leave_nothing() {
    let (store, workspace, goal) = setup();
    assert_eq!(goal.revision, 1);
    let events = store.replay(&workspace.id, 0).unwrap();
    let created: Vec<_> = events
        .iter()
        .filter(|event| event.kind == "goal.created")
        .collect();
    assert_eq!(created.len(), 1);
    assert_eq!(
        created[0].payload["successCriteria"],
        "verified answer persists"
    );
    assert_eq!(created[0].payload["constraints"], "isolated data only");
    assert!(store.create_goal(&workspace.id, "  ").is_err());
    assert_eq!(store.list_goals(&workspace.id).unwrap().len(), 1);
}

#[test]
fn completion_requires_linked_completed_output_and_no_unfinished_tasks() {
    let (store, workspace, goal) = setup();
    let finish = || GoalUpdate {
        status: Some("completed".into()),
        ..GoalUpdate::default()
    };
    assert!(store.update_goal(&goal.id, finish(), None).is_err());
    let (thread, turn, item) = output(&store, &workspace, &goal);
    assert!(
        store
            .record_goal_evidence(&goal.id, 1, &turn.id, &item.id, "checked")
            .is_err()
    );
    let prompt = store
        .append_item(
            &thread.id,
            &turn.id,
            "userMessage",
            "completed",
            json!({"text":"do work"}),
        )
        .unwrap();
    store.complete_turn(&turn.id, "completed").unwrap();
    assert!(
        store
            .record_goal_evidence(&goal.id, 1, &turn.id, &prompt.id, "checked")
            .is_err()
    );
    let recorded = store
        .record_goal_evidence(&goal.id, 1, &turn.id, &item.id, "checked all criteria")
        .unwrap();
    assert_eq!(recorded.revision, 2);
    let next = store.start_turn(&thread.id).unwrap();
    assert!(store.update_goal(&goal.id, finish(), Some(2)).is_err());
    store.complete_turn(&next.id, "completed").unwrap();
    let completed = store.update_goal(&goal.id, finish(), Some(2)).unwrap();
    assert_eq!(completed.status, "completed");
    assert!(store.start_turn(&thread.id).is_err());
    assert!(
        store
            .update_goal(
                &goal.id,
                GoalUpdate {
                    title: Some("rewrite acceptance".into()),
                    ..GoalUpdate::default()
                },
                None
            )
            .is_err()
    );
}

#[test]
fn changed_criteria_invalidate_acceptance_and_cross_workspace_links_are_rejected() {
    let (store, workspace, goal) = setup();
    let (_, turn, item) = output(&store, &workspace, &goal);
    store.complete_turn(&turn.id, "completed").unwrap();
    store
        .record_goal_evidence(&goal.id, 1, &turn.id, &item.id, "checked")
        .unwrap();
    let changed = store
        .update_goal(
            &goal.id,
            GoalUpdate {
                success_criteria: Some("a different deliverable".into()),
                ..GoalUpdate::default()
            },
            Some(2),
        )
        .unwrap();
    assert!(changed.completion_evidence.is_none());
    let other = store.create_workspace("other").unwrap();
    assert!(
        store
            .create_thread(&other.id, "wrong", Some(&goal.id), None)
            .is_err()
    );
    assert!(
        store
            .create_task(&other.id, Some(&goal.id), "wrong")
            .is_err()
    );
    let other_goal = store
        .create_goal_with_context(
            &workspace.id,
            "other goal",
            GoalUpdate {
                success_criteria: Some("other".into()),
                ..GoalUpdate::default()
            },
        )
        .unwrap();
    assert!(
        store
            .record_goal_evidence(&other_goal.id, 1, &turn.id, &item.id, "stolen evidence")
            .is_err()
    );
}

#[test]
fn paused_goals_stop_new_admission_and_one_goal_cannot_run_twice() {
    let (store, workspace, goal) = setup();
    let (thread, turn, _) = output(&store, &workspace, &goal);
    let second = store
        .create_thread(&workspace.id, "second", Some(&goal.id), None)
        .unwrap();
    assert!(store.start_turn(&second.id).is_err());
    store.complete_turn(&turn.id, "completed").unwrap();
    store
        .update_goal(
            &goal.id,
            GoalUpdate {
                status: Some("paused".into()),
                ..GoalUpdate::default()
            },
            None,
        )
        .unwrap();
    assert!(store.start_turn(&thread.id).is_err());
    assert_eq!(store.read_turn(&turn.id).unwrap().status, "completed");
}
