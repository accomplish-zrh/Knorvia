//! P03 artifact edit transactions: base-revision-bound staging, commits
//! bound to an exact staged revision, and conflict/draft-preservation
//! guarantees when two editors interleave.

use super::*;
use knorvia_platform_paths::layout;
use knorvia_protocol::ErrorCategory;
use std::time::{SystemTime, UNIX_EPOCH};

fn tmp_store() -> ProductStore {
    let base = std::env::temp_dir().join(format!(
        "knorvia-arttxn-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&base).unwrap();
    ProductStore::open(layout(base)).unwrap()
}

fn error_category(err: StoreError) -> ErrorCategory {
    err.into_protocol().category
}

#[test]
fn stage_rejects_stale_base_revision_with_typed_conflict() {
    let store = tmp_store();
    let ws = store.create_workspace("txn").unwrap();
    let art = store
        .create_artifact(&ws.id, "text/markdown", "brief")
        .unwrap();

    // Editor A reads the fresh artifact: base is "no current revision".
    let a = store
        .stage_artifact_at_revision(&art.id, b"alpha", "a", Some(None))
        .unwrap();
    // Editor B still believes the base is "no current revision" — rejected.
    let err = store
        .stage_artifact_at_revision(&art.id, b"beta", "b", Some(None))
        .unwrap_err();
    assert_eq!(error_category(err), ErrorCategory::Conflict);
    // B re-reads and stages on top of A's revision — accepted.
    let current = store.read_artifact(&art.id).unwrap().current_revision;
    assert_eq!(current.as_deref(), Some(a.id.as_str()));
    store
        .stage_artifact_at_revision(&art.id, b"beta", "b", Some(current.as_deref()))
        .unwrap();
}

#[test]
fn bound_commit_refuses_to_publish_another_editors_staged_content() {
    let store = tmp_store();
    let ws = store.create_workspace("txn").unwrap();
    let art = store
        .create_artifact(&ws.id, "text/markdown", "brief")
        .unwrap();

    // Interleaving under test: A stages, B stages, A commits.
    let a_stage = store
        .stage_artifact(&art.id, b"from editor A", "a")
        .unwrap();
    let b_stage = store
        .stage_artifact(&art.id, b"from editor B", "b")
        .unwrap();

    let err = store
        .commit_staged_artifact(&art.id, &a_stage.id)
        .unwrap_err();
    assert_eq!(error_category(err), ErrorCategory::Conflict);

    // B's exact staged revision publishes; A's draft is not silently lost.
    let published = store.commit_staged_artifact(&art.id, &b_stage.id).unwrap();
    assert_eq!(
        published.current_revision.as_deref(),
        Some(b_stage.id.as_str())
    );
    assert_eq!(published.lifecycle, "published");
    let bytes = store
        .read_revision_content(published.current_revision.as_deref().unwrap())
        .unwrap();
    assert_eq!(bytes, b"from editor B");

    // A's rejected draft stays readable for rebase / save-as-copy.
    let draft = store.read_artifact_revision(&a_stage.id).unwrap();
    assert_eq!(
        store.read_revision_content(&draft.id).unwrap(),
        b"from editor A"
    );
    // Parent chain ties B's revision to A's staged revision.
    assert_eq!(draft.parent_ids, Vec::<String>::new());
    let b_rev = store.read_artifact_revision(&b_stage.id).unwrap();
    assert_eq!(b_rev.parent_ids, vec![a_stage.id]);
}

#[test]
fn repeated_bound_commit_is_idempotent_no_extra_revision() {
    let store = tmp_store();
    let ws = store.create_workspace("txn").unwrap();
    let art = store
        .create_artifact(&ws.id, "text/markdown", "brief")
        .unwrap();
    let staged = store
        .stage_artifact_at_revision(&art.id, b"v1", "a", Some(None))
        .unwrap();
    let first = store.commit_staged_artifact(&art.id, &staged.id).unwrap();
    let second = store.commit_staged_artifact(&art.id, &staged.id).unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(first.revision, second.revision);
    assert_eq!(
        first.current_revision.as_deref(),
        second.current_revision.as_deref()
    );
    // Retrying after a later stage is still a conflict, never a republish of
    // old content on top of newer work.
    store.stage_artifact(&art.id, b"v2", "b").unwrap();
    let err = store
        .commit_staged_artifact(&art.id, &staged.id)
        .unwrap_err();
    assert_eq!(error_category(err), ErrorCategory::Conflict);
}

#[test]
fn expected_base_survives_rollback_counter_moves() {
    let store = tmp_store();
    let ws = store.create_workspace("txn").unwrap();
    let art = store
        .create_artifact(&ws.id, "text/markdown", "brief")
        .unwrap();
    let v1 = store
        .stage_artifact_at_revision(&art.id, b"v1", "a", Some(None))
        .unwrap();
    store.commit_staged_artifact(&art.id, &v1.id).unwrap();
    // A client read v1 as current; a rollback moves current back to nothing
    // but the counter still advanced — the stale base must be rejected by id.
    let rolled = store.rollback_artifact(&art.id).unwrap();
    assert_eq!(rolled.current_revision, None);
    let err = store
        .stage_artifact_at_revision(&art.id, b"stale", "a", Some(Some(&v1.id)))
        .unwrap_err();
    assert_eq!(error_category(err), ErrorCategory::Conflict);
}

#[test]
fn empty_staged_revision_stages_but_never_commits_and_read_shows_staged() {
    // CODEX-0215-P03-PROOF (daemon-observed): stage with empty content
    // succeeds and moves current_revision, but commit must fail and the
    // durable state must remain "staged" - never reported as published.
    let store = tmp_store();
    let ws = store.create_workspace("txn").unwrap();
    let art = store
        .create_artifact(&ws.id, "text/markdown", "brief")
        .unwrap();
    let staged = store
        .stage_artifact_at_revision(&art.id, b"", "a", Some(None))
        .unwrap();
    let err = store
        .commit_staged_artifact(&art.id, &staged.id)
        .unwrap_err();
    assert_eq!(
        error_category(err),
        ErrorCategory::InvalidArgument,
        "empty content is a typed invalid argument"
    );
    let after = store.read_artifact(&art.id).unwrap();
    assert_eq!(
        after.lifecycle, "staged",
        "lifecycle stays staged after a failed commit"
    );
    assert_eq!(after.current_revision.as_deref(), Some(staged.id.as_str()));
    assert_eq!(after.revision, 2);
}

/// One store with an artifact holding one staged revision.
fn staged_fixture() -> (ProductStore, String, String) {
    let store = tmp_store();
    let ws = store.create_workspace("artifact-fixture").unwrap();
    let art = store.create_artifact(&ws.id, "text", "fixture").unwrap();
    let rev = store.stage_artifact(&art.id, b"staged body", "tester").unwrap();
    (store, art.id, rev.id)
}

#[test]
fn tampered_blob_is_rejected_at_every_boundary() {
    let (store, _art, _rev) = staged_fixture();
    let rev = store.read_artifact_revision(&_rev).unwrap();
    let digest = rev
        .content_ref
        .strip_prefix("sha256:")
        .unwrap()
        .to_string();
    // Tamper with the stored bytes: the content no longer hashes to its
    // name.
    let blob_path = store
        .paths
        .state
        .join("blobs")
        .join(&digest);
    let original = fs::read(&blob_path).unwrap();
    let mut tampered = original.clone();
    let mid = original.len() / 2;
    tampered[mid] = tampered[mid].wrapping_add(1);
    fs::write(&blob_path, &tampered).unwrap();

    // Read boundary.
    assert!(
        store.get_blob(&rev.content_ref).is_err(),
        "a tampered blob must not be returned as content"
    );
    // Verify boundary: no hash match, no verified lifecycle.
    assert!(store.verify_artifact(&_art).is_err());
    assert_eq!(store.read_artifact(&_art).unwrap().lifecycle, "staged");
    // Publish boundary: never published on mismatching content.
    assert!(store.publish_artifact(&_art).is_err());
    assert_ne!(store.read_artifact(&_art).unwrap().lifecycle, "published");
    // Reuse boundary: putting identical bytes refuses to bless the
    // corrupted file (the content-addressed contract is enforced).
    assert!(store.put_blob(&original).is_err());

    // Restoring the exact bytes makes every boundary pass again, and the
    // original revisions stay readable.
    fs::write(&blob_path, &original).unwrap();
    store.get_blob(&rev.content_ref).unwrap();
    store.verify_artifact(&_art).unwrap();
    assert_eq!(store.read_artifact(&_art).unwrap().lifecycle, "verified");
}

#[test]
fn illegal_content_refs_and_symlink_escapes_are_refused() {
    let (store, _art, _rev) = staged_fixture();
    // Digest format: length, charset and separators are all rejected
    // before any file access.
    for bad in [
        "sha256:",
        "sha256:abcd",
        "sha256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
        "sha256:../secret.txt",
        "sha256:0000000000000000000000000000000000000000000000000000000000000000/../../x",
        "md5:00000000000000000000000000000000",
    ] {
        assert!(
            store.get_blob(bad).is_err(),
            "an illegal content ref must be refused: {bad}"
        );
    }
    // A symlinked blob file is a name-addressed escape: refused.
    let digest = "a".repeat(64);
    let blobs = store.paths.state.join("blobs");
    let external = store.paths.state.join("outside-secret.txt");
    fs::write(&external, b"external").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&external, blobs.join(&digest)).unwrap();
    #[cfg(windows)]
    {
        // Directory junctions/symlinks need privileges on Windows; instead
        // prove the hash boundary itself: a same-name file whose content
        // does not match is refused even when the path exists.
        fs::write(blobs.join(&digest), b"external").unwrap();
    }
    assert!(store.get_blob(&format!("sha256:{digest}")).is_err());
}

#[test]
fn identical_content_is_reused_and_hash_is_exact() {
    let (store, _art, _rev) = staged_fixture();
    let bytes = b"deterministic content";
    let first = store.put_blob(bytes).unwrap();
    let second = store.put_blob(bytes).unwrap();
    assert_eq!(first, second, "content addressing is the identity");
    let got = store.get_blob(&first).unwrap();
    assert_eq!(got, bytes);
}
