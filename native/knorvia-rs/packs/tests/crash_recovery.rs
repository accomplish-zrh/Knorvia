//! A01 acceptance: real process interruption + restart + resume of the SAME
//! business identity, against an isolated local Home.
//!
//! Stage 1 runs the `crash-helper` binary as a separate OS process; it exits
//! with durable `running` Job/Invocation records (an interruption). Stage 2
//! reopens the same Home in this process, applies the recovery contract, and
//! resumes the recorded identity — the original job id is reused, the job
//! reaches a queryable terminal state, and the invocation output is readable.

use knorvia_capability_host::PackHost;
use knorvia_packs::{InProcessRunner, ModelChoice, PackOutcome};
use knorvia_platform_paths::layout;
use knorvia_store::ProductStore;
use serde_json::{Value, json};
use std::process::Command;

fn unique_home(tag: &str) -> std::path::PathBuf {
    let base = std::env::temp_dir().join(format!(
        "knorvia-a01-{}-{}-{}",
        tag,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&base).unwrap();
    base
}

fn run_crash_helper(home: &std::path::Path) -> Value {
    let out = Command::new(env!("CARGO_BIN_EXE_crash-helper"))
        .arg(home)
        .output()
        .expect("spawn crash-helper process");
    assert!(
        out.status.success(),
        "crash-helper failed: {} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.lines().last().expect("helper prints identity json");
    serde_json::from_str(line).expect("identity json")
}

#[test]
fn interrupted_process_leaves_running_state_that_recovery_and_resume_continue() {
    let root = unique_home("process");
    let home = root.join("home");
    let identity = run_crash_helper(&home);

    // --- The interruption left durable running records on disk. ---
    let paths = layout(home.clone());
    let store = ProductStore::open(paths.clone()).unwrap();
    let packs = PackHost::open(&paths).unwrap();
    let job_before = store.read_job(identity["jobId"].as_str().unwrap()).unwrap();
    assert_eq!(job_before.status, "running", "crash leaves the job running");
    let inv_before = packs
        .read_invocation(identity["invocationId"].as_str().unwrap())
        .unwrap();
    assert_eq!(inv_before.status, "running");
    assert_eq!(inv_before.job_id.as_deref(), identity["jobId"].as_str());
    assert!(inv_before.checkpoint.is_some(), "checkpoint survived");
    // The same home also holds an invocation from the completed invoke; that
    // one must NOT be touched by recovery (it is already terminal).
    let completed = packs
        .read_invocation(identity["completedInvocationId"].as_str().unwrap())
        .unwrap();
    assert_eq!(completed.status, "succeeded");

    // --- Restart recovery: running → failed, identity + checkpoint kept. ---
    let recovered_jobs = store.recover_incomplete_jobs().unwrap();
    assert_eq!(recovered_jobs.len(), 1, "exactly the interrupted job");
    assert_eq!(recovered_jobs[0].id, job_before.id);
    assert_eq!(recovered_jobs[0].checkpoint, job_before.checkpoint);
    let recovered_invs = packs.recover_incomplete().unwrap();
    assert_eq!(recovered_invs.len(), 1);
    assert_eq!(recovered_invs[0].id, inv_before.id);

    let job_after = store.read_job(identity["jobId"].as_str().unwrap()).unwrap();
    assert_eq!(job_after.status, "failed");
    let inv_after = packs
        .read_invocation(identity["invocationId"].as_str().unwrap())
        .unwrap();
    assert_eq!(inv_after.status, "failed");
    // Recovery is idempotent: a second pass recovers nothing.
    assert!(store.recover_incomplete_jobs().unwrap().is_empty());
    assert!(packs.recover_incomplete().unwrap().is_empty());

    // --- Resume continues the SAME business identity. ---
    let outcome = knorvia_packs::resume(
        &packs,
        &store,
        inv_after.id.as_str(),
        identity["workspaceId"].as_str().unwrap(),
        &json!({"prompt": "interrupted", "kind": "image"}),
        &mut InProcessRunner::new(ModelChoice::None),
    )
    .unwrap();
    let PackOutcome { job_id, status, .. } = &outcome;
    assert_eq!(status, "succeeded");
    assert_eq!(
        job_id,
        identity["jobId"].as_str().unwrap(),
        "resume reuses the original job id, never a new one"
    );
    let job_final = store.read_job(job_id).unwrap();
    assert_eq!(job_final.status, "succeeded");
    let inv_final = packs.read_invocation(inv_after.id.as_str()).unwrap();
    assert_eq!(inv_final.status, "succeeded");
    assert_eq!(
        inv_final.output.as_ref().unwrap()["artifactId"],
        outcome.artifact_id.as_ref().unwrap().clone()
    );

    // Atomic writes: no staging temp files left in the invocations directory.
    let stale: Vec<_> = std::fs::read_dir(paths.packs.join("invocations"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".tmp"))
        .collect();
    assert!(stale.is_empty(), "stale staging files: {stale:?}");

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn resume_without_durable_job_identity_is_refused_not_silently_recreated() {
    let root = unique_home("legacy");
    let paths = layout(root.join("home"));
    let store = ProductStore::open(paths.clone()).unwrap();
    let packs = PackHost::open(&paths).unwrap();
    knorvia_packs::ensure_official(&packs).unwrap();
    let ws = store.create_workspace("legacy").unwrap();
    // Hand-write a pre-recovery-format invocation: no job link at all.
    let inv = json!({
        "id": "inv_legacy_identity",
        "packId": "media.studio",
        "status": "failed",
        "input": {"prompt": "old", "kind": "image"},
    });
    std::fs::write(
        paths
            .packs
            .join("invocations")
            .join("inv_legacy_identity.json"),
        serde_json::to_vec_pretty(&inv).unwrap(),
    )
    .unwrap();

    let err = knorvia_packs::resume(
        &packs,
        &store,
        "inv_legacy_identity",
        &ws.id,
        &json!({"prompt": "old", "kind": "image"}),
        &mut InProcessRunner::new(ModelChoice::None),
    )
    .unwrap_err();
    let message = err.to_string();
    assert!(
        message.contains("no durable job identity"),
        "typed refusal, got: {message}"
    );
    // Refusal never created a replacement job.
    assert_eq!(store.list_jobs(&ws.id, "").unwrap().len(), 0);

    // Wrong-workspace resume is also a typed conflict, not a new job.
    let outcome = knorvia_packs::invoke(
        &packs,
        &store,
        "media.studio",
        &ws.id,
        &json!({"prompt": "x", "kind": "image", "cancelBeforeWork": true}),
        &mut InProcessRunner::new(ModelChoice::None),
    )
    .unwrap();
    let other_ws = store.create_workspace("other").unwrap();
    let err = knorvia_packs::resume(
        &packs,
        &store,
        &outcome.invocation_id,
        &other_ws.id,
        &json!({"prompt": "x", "kind": "image"}),
        &mut InProcessRunner::new(ModelChoice::None),
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("belongs to workspace"),
        "workspace mismatch is typed: {err}"
    );
    let _ = std::fs::remove_dir_all(root);
}

/// CODEX-0030-A #1: a rejected resume must never flip the durable
/// invocation to `running`. Wrong workspace first, then the correct one
/// succeeds with the SAME job identity.
#[test]
fn wrong_workspace_rejection_leaves_invocation_resumable() {
    let root = unique_home("wrong-ws");
    let paths = layout(root.join("home"));
    let store = ProductStore::open(paths.clone()).unwrap();
    let packs = PackHost::open(&paths).unwrap();
    knorvia_packs::ensure_official(&packs).unwrap();
    let ws = store.create_workspace("right").unwrap();
    let other = store.create_workspace("wrong").unwrap();
    let outcome = knorvia_packs::invoke(
        &packs,
        &store,
        "media.studio",
        &ws.id,
        &json!({"prompt": "p", "kind": "image", "cancelBeforeWork": true}),
        &mut InProcessRunner::new(ModelChoice::None),
    )
    .unwrap();
    assert_eq!(outcome.status, "cancelled");

    // Rejection against the wrong workspace: typed, and no durable change.
    let err = knorvia_packs::resume(
        &packs,
        &store,
        &outcome.invocation_id,
        &other.id,
        &json!({"prompt": "p", "kind": "image"}),
        &mut InProcessRunner::new(ModelChoice::None),
    )
    .unwrap_err();
    assert!(err.to_string().contains("belongs to workspace"), "{err}");
    let inv_after_reject = packs.read_invocation(&outcome.invocation_id).unwrap();
    assert_eq!(
        inv_after_reject.status, "cancelled",
        "rejected resume must not leave the invocation running"
    );

    // The correct workspace then resumes the SAME job to success.
    let resumed = knorvia_packs::resume(
        &packs,
        &store,
        &outcome.invocation_id,
        &ws.id,
        &json!({"prompt": "p", "kind": "image"}),
        &mut InProcessRunner::new(ModelChoice::None),
    )
    .unwrap();
    assert_eq!(resumed.status, "succeeded");
    assert_eq!(resumed.job_id, outcome.job_id, "same job identity");
    let _ = std::fs::remove_dir_all(root);
}

/// CODEX-0030-A #1: a legacy invocation without a job link is refused
/// twice, and neither refusal pollutes its durable state.
#[test]
fn legacy_no_job_id_double_rejection_keeps_state_clean() {
    let root = unique_home("legacy-twice");
    let paths = layout(root.join("home"));
    let store = ProductStore::open(paths.clone()).unwrap();
    let packs = PackHost::open(&paths).unwrap();
    knorvia_packs::ensure_official(&packs).unwrap();
    let ws = store.create_workspace("legacy").unwrap();
    let inv = json!({
        "id": "inv_legacy_twice",
        "packId": "media.studio",
        "status": "failed",
        "input": {"prompt": "old", "kind": "image"},
    });
    std::fs::write(
        paths
            .packs
            .join("invocations")
            .join("inv_legacy_twice.json"),
        serde_json::to_vec_pretty(&inv).unwrap(),
    )
    .unwrap();

    for attempt in 1..=2 {
        let err = knorvia_packs::resume(
            &packs,
            &store,
            "inv_legacy_twice",
            &ws.id,
            &json!({"prompt": "old", "kind": "image"}),
            &mut InProcessRunner::new(ModelChoice::None),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("no durable job identity"),
            "attempt {attempt}: {err}"
        );
        let after = packs.read_invocation("inv_legacy_twice").unwrap();
        assert_eq!(
            after.status, "failed",
            "attempt {attempt} must leave the record retryable, got {}",
            after.status
        );
    }
    let _ = std::fs::remove_dir_all(root);
}

/// CODEX-0030-A #1 crash window: the job durably succeeded but the
/// invocation never recorded its output. Resume must refuse and reconcile-
/// flag — never re-render and publish a second artifact.
#[test]
fn succeeded_job_with_incomplete_invocation_is_refused_not_republished() {
    let root = unique_home("succeeded-window");
    let paths = layout(root.join("home"));
    let store = ProductStore::open(paths.clone()).unwrap();
    let packs = PackHost::open(&paths).unwrap();
    knorvia_packs::ensure_official(&packs).unwrap();
    let ws = store.create_workspace("window").unwrap();
    let outcome = knorvia_packs::invoke(
        &packs,
        &store,
        "media.studio",
        &ws.id,
        &json!({"prompt": "done", "kind": "image"}),
        &mut InProcessRunner::new(ModelChoice::None),
    )
    .unwrap();
    assert_eq!(outcome.status, "succeeded");
    let artifacts_before = store.list_artifacts(&ws.id).unwrap().len();

    // Craft the crash window: the invocation record as recovery would have
    // left it when the process died between finish_job and host.complete.
    let inv_path = paths
        .packs
        .join("invocations")
        .join(format!("{}.json", outcome.invocation_id));
    let mut inv = packs.read_invocation(&outcome.invocation_id).unwrap();
    inv.status = "failed".into();
    inv.output = None;
    std::fs::write(&inv_path, serde_json::to_vec_pretty(&inv).unwrap()).unwrap();

    let err = knorvia_packs::resume(
        &packs,
        &store,
        &outcome.invocation_id,
        &ws.id,
        &json!({"prompt": "done", "kind": "image"}),
        &mut InProcessRunner::new(ModelChoice::None),
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("already succeeded")
            && err.to_string().contains("reconcile manually"),
        "typed reconciliation refusal: {err}"
    );
    // The succeeded job was NOT retried and no duplicate artifact shipped.
    let job = store.read_job(&outcome.job_id).unwrap();
    assert_eq!(job.status, "succeeded", "succeeded job is never re-run");
    assert_eq!(
        store.list_artifacts(&ws.id).unwrap().len(),
        artifacts_before,
        "no duplicate publish"
    );
    assert_eq!(
        packs
            .read_invocation(&outcome.invocation_id)
            .unwrap()
            .status,
        "failed",
        "invocation stays in its failed state for reconciliation"
    );
    let _ = std::fs::remove_dir_all(root);
}

/// CODEX-0415-A01-CRASH-WINDOW: assemble a live invocation all the way to
/// a verified artifact, inject the crash inside the publish tail, recover,
/// and prove resume reconciles the SAME artifact without re-rendering.
fn assemble_to_receipt(
    paths: &knorvia_platform_paths::KnorviaPaths,
    store: &ProductStore,
    packs: &PackHost,
    ws: &str,
    do_publish: bool,
) -> (String, String, String) {
    let inv = packs
        .invoke(
            "media.studio",
            json!({"prompt": "receipt", "kind": "image"}),
        )
        .unwrap();
    let job = store.create_job(ws, "media.studio").unwrap();
    let job = store.run_job(&job.id).unwrap();
    packs.link_job(&inv.id, &job.id).unwrap();
    packs
        .checkpoint(&inv.id, json!({"phase": "indexed"}))
        .unwrap();
    store
        .checkpoint_job(&job.id, json!({"phase": "indexed"}))
        .unwrap();
    let art = store
        .create_artifact(ws, "application/json", "media-image")
        .unwrap();
    store
        .stage_artifact(
            &art.id,
            br#"{"kind":"image","status":"specified"}"#,
            "media.studio",
        )
        .unwrap();
    store.verify_artifact(&art.id).unwrap();
    packs
        .set_receipt(
            &inv.id,
            Some(json!({"pendingPublish": art.id, "stage": "verified"})),
        )
        .unwrap();
    if do_publish {
        store.publish_artifact(&art.id).unwrap();
    }
    (inv.id, job.id, art.id)
}

/// Window b: the crash landed AFTER publish but BEFORE finish_job. The
/// recovered state is job=failed + invocation=failed + published artifact,
/// and resume must complete the bookkeeping WITHOUT creating or publishing
/// anything new.
#[test]
fn crash_after_publish_reconciles_the_same_artifact_without_republish() {
    let root = unique_home("receipt-published");
    let paths = layout(root.join("home"));
    let store = ProductStore::open(paths.clone()).unwrap();
    let packs = PackHost::open(&paths).unwrap();
    knorvia_packs::ensure_official(&packs).unwrap();
    let ws = store.create_workspace("receipt").unwrap();
    let (inv_id, job_id, art_id) = assemble_to_receipt(&paths, &store, &packs, &ws.id, true);
    let artifacts_before = store.list_artifacts(&ws.id).unwrap().len();

    // Fault injection: the owning process dies here. Recovery runs.
    store.recover_incomplete_jobs().unwrap();
    packs.recover_incomplete().unwrap();
    assert_eq!(store.read_job(&job_id).unwrap().status, "failed");

    let outcome = knorvia_packs::resume(
        &packs,
        &store,
        &inv_id,
        &ws.id,
        &json!({"prompt": "receipt", "kind": "image"}),
        &mut InProcessRunner::new(ModelChoice::None),
    )
    .unwrap();
    assert_eq!(outcome.status, "succeeded");
    assert_eq!(
        outcome.artifact_id.as_deref(),
        Some(art_id.as_str()),
        "the receipt artifact is reused, never a duplicate"
    );
    assert_eq!(
        store.list_artifacts(&ws.id).unwrap().len(),
        artifacts_before,
        "no second artifact was published"
    );
    assert_eq!(store.read_job(&job_id).unwrap().status, "succeeded");
    let inv = packs.read_invocation(&inv_id).unwrap();
    assert_eq!(inv.status, "succeeded");
    assert_eq!(inv.output.as_ref().unwrap()["artifactId"], json!(art_id));
    assert!(inv.receipt.is_none(), "receipt is spent on completion");
    let _ = std::fs::remove_dir_all(root);
}

/// Window a: the crash landed AFTER the receipt but BEFORE publish. Resume
/// publishes THAT verified artifact (recorded intent, same id) instead of
/// re-rendering a new one.
#[test]
fn crash_before_publish_completes_the_recorded_publish_not_a_rerender() {
    let root = unique_home("receipt-verified");
    let paths = layout(root.join("home"));
    let store = ProductStore::open(paths.clone()).unwrap();
    let packs = PackHost::open(&paths).unwrap();
    knorvia_packs::ensure_official(&packs).unwrap();
    let ws = store.create_workspace("receipt").unwrap();
    let (inv_id, job_id, art_id) = assemble_to_receipt(&paths, &store, &packs, &ws.id, false);

    store.recover_incomplete_jobs().unwrap();
    packs.recover_incomplete().unwrap();

    let outcome = knorvia_packs::resume(
        &packs,
        &store,
        &inv_id,
        &ws.id,
        &json!({"prompt": "receipt", "kind": "image"}),
        &mut InProcessRunner::new(ModelChoice::None),
    )
    .unwrap();
    assert_eq!(outcome.status, "succeeded");
    assert_eq!(outcome.artifact_id.as_deref(), Some(art_id.as_str()));
    let art = store.read_artifact(&art_id).unwrap();
    assert_eq!(art.lifecycle, "published");
    assert_eq!(store.list_artifacts(&ws.id).unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(root);
}

/// A receipt pointing at an unreadable artifact is an unconfirmable side
/// effect: resume refuses for manual reconciliation instead of re-running.
#[test]
fn unreconcilable_publish_receipt_is_refused_not_rerun() {
    let root = unique_home("receipt-missing");
    let paths = layout(root.join("home"));
    let store = ProductStore::open(paths.clone()).unwrap();
    let packs = PackHost::open(&paths).unwrap();
    knorvia_packs::ensure_official(&packs).unwrap();
    let ws = store.create_workspace("receipt").unwrap();
    let (inv_id, job_id, _art) = assemble_to_receipt(&paths, &store, &packs, &ws.id, false);
    // Corrupt the receipt so it points at an artifact that does not exist.
    let mut inv = packs.read_invocation(&inv_id).unwrap();
    inv.receipt = Some(json!({"pendingPublish": "art_does_not_exist", "stage": "verified"}));
    let inv_path = paths
        .packs
        .join("invocations")
        .join(format!("{inv_id}.json"));
    std::fs::write(&inv_path, serde_json::to_vec_pretty(&inv).unwrap()).unwrap();

    store.recover_incomplete_jobs().unwrap();
    packs.recover_incomplete().unwrap();

    let err = knorvia_packs::resume(
        &packs,
        &store,
        &inv_id,
        &ws.id,
        &json!({"prompt": "receipt", "kind": "image"}),
        &mut InProcessRunner::new(ModelChoice::None),
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("reconcile manually"),
        "typed reconciliation refusal: {err}"
    );
    assert_eq!(store.read_job(&job_id).unwrap().status, "failed");
    assert_eq!(
        packs.read_invocation(&inv_id).unwrap().status,
        "failed",
        "state stays retryable for the human reconciliation"
    );
    let _ = std::fs::remove_dir_all(root);
}
