use super::*;

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
