use super::*;

#[test]
fn home_ownership_survives_a_state_directory_swap() {
    let home = std::env::temp_dir().join(knorvia_protocol::new_id("stable-owner"));
    let paths = knorvia_platform_paths::layout(home.clone());
    let lease = ControlPlane::acquire_home(paths.clone()).unwrap();
    let moved = paths.backups.join("state-before-swap");
    std::fs::rename(&paths.state, &moved).unwrap();
    std::fs::create_dir_all(&paths.state).unwrap();
    assert!(matches!(
        ControlPlane::acquire_home(paths.clone()),
        Err(ProtocolError {
            category: ErrorCategory::Conflict,
            ..
        })
    ));
    assert!(paths.run.join("daemon.lock").exists());
    drop(lease);
    assert!(ControlPlane::acquire_home(paths.clone()).is_ok());
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn a_second_owner_cannot_recover_a_live_turn() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let home = std::env::temp_dir().join(format!(
        "knorvia-owner-test-{}-{unique}",
        std::process::id()
    ));
    let paths = knorvia_platform_paths::layout(home);
    let owner = ControlPlane::open(paths.clone()).unwrap();
    let workspace = owner.store.create_workspace("test").unwrap();
    let thread = owner
        .store
        .create_thread(&workspace.id, "active", None, None)
        .unwrap();
    let turn = owner.store.start_turn(&thread.id).unwrap();
    let contender = ControlPlane::open(paths.clone());
    assert!(matches!(
        contender,
        Err(ProtocolError {
            category: ErrorCategory::Conflict,
            ..
        })
    ));
    assert_eq!(owner.store.read_turn(&turn.id).unwrap().status, "running");
    drop(owner);
    let recovered = ControlPlane::open(paths).unwrap();
    assert_eq!(
        recovered.store.read_turn(&turn.id).unwrap().status,
        "interrupted"
    );
}

#[test]
fn transport_ownership_can_be_acquired_without_prematurely_recovering_a_turn() {
    let home = std::env::temp_dir().join(knorvia_protocol::new_id("knorvia-startup-owner"));
    let paths = knorvia_platform_paths::layout(home);
    let owner = ControlPlane::open(paths.clone()).unwrap();
    let workspace = owner.store.create_workspace("startup").unwrap();
    let thread = owner
        .store
        .create_thread(&workspace.id, "unfinished", None, None)
        .unwrap();
    let turn = owner.store.start_turn(&thread.id).unwrap();
    drop(owner);
    let lease = ControlPlane::acquire_home(paths.clone()).unwrap();
    assert!(matches!(
        ControlPlane::acquire_home(paths.clone()),
        Err(ProtocolError {
            category: ErrorCategory::Conflict,
            ..
        })
    ));
    let bytes = std::fs::read(
        paths
            .state
            .join("product/turns")
            .join(format!("{}.json", turn.id)),
    )
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["status"],
        "running"
    );
    let recovered = ControlPlane::open_with_ownership(lease).unwrap();
    assert_eq!(
        recovered.store.read_turn(&turn.id).unwrap().status,
        "interrupted"
    );
}

#[test]
fn restart_recovery_also_closes_running_jobs_and_invocations() {
    // A01: the ownership-gated open must recover Pack/Job work with the same
    // batch semantics as Turns — a restart never leaves forever-`running`.
    let home = std::env::temp_dir().join(knorvia_protocol::new_id("knorvia-job-recovery"));
    let paths = knorvia_platform_paths::layout(home);
    let owner = ControlPlane::open(paths.clone()).unwrap();
    let ws = owner.store.create_workspace("jobs").unwrap();
    // Leave a running job + linked invocation behind, the way an interrupted
    // process would (no cancel, no finish).
    let inv = owner
        .packs
        .invoke("media.studio", json!({"prompt": "p"}))
        .unwrap();
    let job = owner.store.create_job(&ws.id, "media.studio").unwrap();
    let job = owner.store.run_job(&job.id).unwrap();
    owner.packs.link_job(&inv.id, &job.id).unwrap();
    owner
        .store
        .checkpoint_job(&job.id, json!({"step": 1}))
        .unwrap();
    drop(owner);

    let reopened = ControlPlane::open(paths.clone()).unwrap();
    let job_after = reopened.store.read_job(&job.id).unwrap();
    assert_eq!(job_after.status, "failed");
    assert_eq!(job_after.checkpoint, Some(json!({"step": 1})));
    let inv_after = reopened.packs.read_invocation(&inv.id).unwrap();
    assert_eq!(inv_after.status, "failed");
    assert_eq!(inv_after.job_id.as_deref(), Some(job.id.as_str()));
    let _ = std::fs::remove_dir_all(paths.home);
}
