//! Official domain packs. Each invoke creates a Job, optional checkpoint,
//! a versioned Artifact, and an invocation record. Cancel leaves history
//! readable and does not publish. Resume continues from the checkpoint.
//!
//! Production pack rendering runs in the supervised `knorvia-pack-worker`
//! process (see `capability-host::worker`); this crate also exposes `render`
//! for the worker binary and for tests.

pub mod gateway;

use knorvia_capability_host::{Invocation, PackHost, PackManifest, PackState};
use knorvia_store::{ProductStore, StoreError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum PackExecError {
    #[error(transparent)]
    Host(#[from] knorvia_capability_host::PackError),
    #[error(transparent)]
    Store(#[from] StoreError),
    /// A request-side validation failure: bad pack id, uninstalled pack,
    /// missing capability, unknown workspace. Zero durable writes happened,
    /// so a caller's idempotency key stays cleanly retryable (A05).
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Msg(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackOutcome {
    pub pack_id: String,
    pub invocation_id: String,
    pub job_id: String,
    pub artifact_id: Option<String>,
    pub status: String,
    pub checkpoint: Option<Value>,
    /// How the artifact content was produced: `model` (live provider gateway)
    /// or `template` (deterministic fallback, never pretending to be model
    /// output). Template mode is a migration-window compatibility path and is
    /// always labeled.
    pub mode: String,
}

/// Model access a pack may use. `None` means no provider is configured: packs
/// that need the model fall back to their deterministic template and the
/// outcome is labeled `template` — never silently presented as model output.
pub enum ModelAccess<'a> {
    None,
    Provided(&'a mut dyn PackModel),
}

/// Model backend handed to packs by the daemon (Provider Gateway execution).
pub trait PackModel: Send {
    /// One completion request; returns the model's text output.
    fn complete(&mut self, prompt: &str) -> Result<String, PackExecError>;
}

pub const OFFICIAL_PACKS: &[(&str, &str, &str, &str)] = &[
    (
        "research.knowledge",
        "Knowledge & Research",
        "artifact.research",
        "native",
    ),
    (
        "memory.layered",
        "Layered Memory",
        "artifact.memory",
        "native",
    ),
    (
        "office.genoffice",
        "Office & GenOffice",
        "artifact.office",
        "native",
    ),
    ("media.studio", "Media Studio", "artifact.media", "native"),
    (
        "learning.mastery",
        "Learning",
        "artifact.learning",
        "native",
    ),
    (
        "partners.connection",
        "Partners",
        "artifact.connection",
        "native",
    ),
    (
        "automations.cron",
        "Automations",
        "job.automation",
        "native",
    ),
    (
        "developer.workspace",
        "Developer",
        "artifact.code",
        "native",
    ),
    ("data.notebook", "Data", "artifact.dataset", "native"),
    // Media packs hosted by the Python media worker (domain pipelines with
    // LLM agents + Manim subprocess live in Python, per the ADR worker map).
    ("media.visualize", "Visualize", "artifact.media", "python"),
    ("media.manim", "Math Animator", "artifact.media", "python"),
];

pub fn official_manifests() -> Vec<PackManifest> {
    OFFICIAL_PACKS
        .iter()
        .map(|(id, _title, cap, runtime)| PackManifest {
            id: (*id).into(),
            version: "1.0.0".into(),
            publisher: "knorvia".into(),
            capabilities: vec![(*cap).into()],
            permissions: vec!["artifact.write".into(), "job.run".into()],
            runtime: (*runtime).into(),
        })
        .collect()
}

pub fn ensure_official(host: &PackHost) -> Result<(), PackExecError> {
    for m in official_manifests() {
        match host.read(&m.id) {
            Ok(rec) if rec.state == PackState::Installed => {}
            _ => {
                host.install(m)?;
            }
        }
    }
    Ok(())
}

pub fn list_installed(host: &PackHost) -> Result<Vec<PackManifest>, PackExecError> {
    Ok(official_manifests()
        .into_iter()
        .filter(|m| {
            host.read(&m.id)
                .map(|r| r.state == PackState::Installed)
                .unwrap_or(false)
        })
        .collect())
}

/// Rank corpus docs by query term overlap. This is the shipped retrieval
/// function tests call — not a reimplementation inside the test.
pub fn retrieve(
    query: &str,
    corpus: &[(String, String, String)],
) -> Vec<(String, String, f64, String)> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| t.to_ascii_lowercase())
        .filter(|t| t.len() > 1)
        .collect();
    let mut scored: Vec<(String, String, f64, String)> = corpus
        .iter()
        .map(|(id, title, text)| {
            let hay = format!("{title} {text}").to_ascii_lowercase();
            let hits = terms.iter().filter(|t| hay.contains(t.as_str())).count();
            let score = if terms.is_empty() {
                0.0
            } else {
                hits as f64 / terms.len() as f64
            };
            let snippet: String = text.chars().take(240).collect();
            (id.clone(), title.clone(), score, snippet)
        })
        .filter(|(_, _, score, _)| *score > 0.0)
        .collect();
    scored.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    scored
}

/// Context handed to the runner for each render (job identity for progress
/// checkpoints; the worker never receives store paths).
pub struct RenderContext {
    pub job_id: String,
    pub invocation_id: String,
}

/// Shared cancellation for one in-flight invocation. The control plane
/// holds one per admitted invocation so a cancel reaches the actual
/// registered worker, not just the durable record; the runner registers its
/// live process-tree killer through [`PackRunner::bind_cancel`].
#[derive(Clone, Default)]
pub struct InvocationCancel(Arc<CancelInner>);

#[derive(Default)]
struct CancelInner {
    cancelled: std::sync::atomic::AtomicBool,
    publication: std::sync::Mutex<()>,
    reclaim_failed: std::sync::atomic::AtomicBool,
    killers: std::sync::Mutex<Vec<Arc<dyn Fn() + Send + Sync>>>,
}

impl InvocationCancel {
    /// Cancel the invocation: latch the flag and run every registered
    /// killer (ending the worker process tree). Each killer runs exactly
    /// once — a repeated cancel is a no-op, and a killer registered after
    /// the latch runs at registration so a worker racing its own
    /// registration cannot survive a cancel.
    pub fn cancel(&self) {
        let publication = self.0.publication.lock().unwrap_or_else(|e| e.into_inner());
        if self.0.cancelled.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
        drop(publication);
        let killers = std::mem::take(&mut *self.0.killers.lock().unwrap_or_else(|e| e.into_inner()));
        for kill in killers { kill(); }
    }

    pub fn is_cancelled(&self) -> bool { self.0.cancelled.load(std::sync::atomic::Ordering::SeqCst) }
    pub fn all_reclaimed(&self) -> bool { !self.0.reclaim_failed.load(std::sync::atomic::Ordering::SeqCst) }
    fn publication_guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.0.publication.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn register_killer(&self, kill: Arc<dyn Fn() + Send + Sync>) {
        let mut killers = self.0.killers.lock().unwrap_or_else(|e| e.into_inner());
        if self.is_cancelled() { drop(killers); kill(); } else { killers.push(kill); }
    }
    pub fn register_reclaimer(&self, kill: Arc<dyn Fn() -> bool + Send + Sync>) {
        let state = Arc::downgrade(&self.0);
        self.register_killer(Arc::new(move || {
            if !kill() { if let Some(state) = state.upgrade() { state.reclaim_failed.store(true, std::sync::atomic::Ordering::SeqCst); } }
        }));
    }

}

/// Executes one pack render. Production: the supervised `knorvia-pack-worker`
/// process (see `capability-host::worker`). Tests: in-process rendering.
pub trait PackRunner {
    fn render(
        &mut self,
        ctx: &RenderContext,
        pack_id: &str,
        input: &Value,
    ) -> Result<RenderedPack, PackExecError>;

    /// Bind this runner's in-flight work to a shared cancellation handle so
    /// a control-plane cancel reaches the live worker process. Default:
    /// nothing to bind (in-process runners cancel cooperatively at the
    /// post-render cancelled-job checkpoint).
    fn bind_cancel(&mut self, _cancel: InvocationCancel) {}
}

#[derive(Debug, Clone)]
pub struct RenderedPack {
    pub mime: String,
    pub title: String,
    pub bytes: Vec<u8>,
}

/// Model source for the in-process runner. `GatewayFromEnv` constructs the
/// owned gateway model at render time (worker/production semantics).
pub enum ModelChoice<'a> {
    None,
    GatewayFromEnv,
    Provided(&'a mut dyn PackModel),
}

/// In-process runner (tests and the worker binary itself).
pub struct InProcessRunner<'a> {
    choice: ModelChoice<'a>,
    owned_gateway: Option<gateway::GatewayModel>,
}

impl<'a> InProcessRunner<'a> {
    pub fn new(choice: ModelChoice<'a>) -> Self {
        Self {
            choice,
            owned_gateway: None,
        }
    }

    fn model(&mut self) -> Result<ModelAccess<'_>, PackExecError> {
        match &mut self.choice {
            ModelChoice::None => Ok(ModelAccess::None),
            ModelChoice::Provided(d) => Ok(ModelAccess::Provided(&mut **d)),
            ModelChoice::GatewayFromEnv => {
                if self.owned_gateway.is_none() {
                    self.owned_gateway = Some(gateway::GatewayModel::from_env().ok_or_else(
                        || {
                            PackExecError::Msg(
                                "pack model access requires KNORVIA_PROVIDER_MODEL and KNORVIA_PROVIDER_BASE_URL"
                                    .into(),
                            )
                        },
                    )?);
                }
                match self.owned_gateway.as_mut() {
                    Some(g) => Ok(ModelAccess::Provided(g)),
                    None => unreachable!("gateway was just inserted"),
                }
            }
        }
    }
}

impl<'a> PackRunner for InProcessRunner<'a> {
    fn render(
        &mut self,
        _ctx: &RenderContext,
        pack_id: &str,
        input: &Value,
    ) -> Result<RenderedPack, PackExecError> {
        let model = self.model()?;
        let (mime, title, bytes) = render_pack(pack_id, input, model)?;
        Ok(RenderedPack {
            mime: mime.to_string(),
            title,
            bytes,
        })
    }
}

/// Durable identity admitted for one invocation. Created before any work
/// starts so the control plane (and a later cancel) can name the same
/// business record while the render is still running in the background.
#[derive(Debug, Clone)]
pub struct AdmittedInvocation {
    pub invocation_id: String,
    pub job_id: String,
    pub pack_id: String,
    pub workspace_id: String,
}

/// Read-only semantic prevalidation (A05): bad pack id, uninstalled pack,
/// missing declared capability or unknown workspace fail here with zero
/// durable writes, so the caller's idempotency key never gets wedged by an
/// invocation that was never legal.
pub fn validate_invocation(
    host: &PackHost,
    store: &ProductStore,
    pack_id: &str,
    workspace_id: &str,
) -> Result<(), PackExecError> {
    let rec = host.read(pack_id)?;
    if rec.state != PackState::Installed {
        return Err(PackExecError::Invalid(format!(
            "pack {pack_id} is not installed"
        )));
    }
    // Manifest permission gate: the pack declares the capability it may run;
    // an invocation without a declared capability is a policy violation, not
    // a render error.
    if rec.manifest.capabilities.is_empty() {
        return Err(PackExecError::Invalid(format!(
            "pack {pack_id} declares no capabilities; refusing to invoke"
        )));
    }
    store
        .read_workspace(workspace_id)
        .map_err(|e| PackExecError::Invalid(format!("unknown workspace {workspace_id}: {e}")))?;
    Ok(())
}

/// Admit one invocation: validate semantics, create the invocation record
/// and its running Job, and durably link them. No render happens here, so
/// this is cheap enough to run on the control thread before background
/// execution starts. A crash between these writes leaves a `running`
/// invocation without a job link; [`PackHost::recover_incomplete`] fails
/// such records at the next open and the idempotency layer reports the
/// outcome as unknown instead of replaying a half admission.
pub fn admit_invocation(
    host: &PackHost,
    store: &ProductStore,
    pack_id: &str,
    workspace_id: &str,
    input: &Value,
) -> Result<AdmittedInvocation, PackExecError> {
    validate_invocation(host, store, pack_id, workspace_id)?;
    let inv = host.invoke(pack_id, input.clone())?;
    let job = store.create_job(workspace_id, pack_id)?;
    let job = store.run_job(&job.id)?;
    // Durably link the invocation to this job so a restart can resume the
    // same business identity instead of silently opening a new one.
    host.link_job(&inv.id, &job.id)?;
    Ok(AdmittedInvocation {
        invocation_id: inv.id,
        job_id: job.id,
        pack_id: pack_id.to_string(),
        workspace_id: workspace_id.to_string(),
    })
}

/// Run one admitted invocation to its outcome under a shared cancel handle.
/// This is the execution half of [`invoke`]: checkpoints, render, the
/// cancel-after-render guard, publish receipt and completion. Nothing here
/// re-validates semantics; admission owns that.
pub fn execute_admitted(
    host: &PackHost,
    store: &ProductStore,
    admitted: &AdmittedInvocation,
    runner: &mut dyn PackRunner,
    cancel: InvocationCancel,
) -> Result<PackOutcome, PackExecError> {
    let AdmittedInvocation {
        invocation_id: inv_id,
        job_id,
        pack_id,
        workspace_id,
    } = admitted;
    let inv_id = inv_id.clone();
    let job_id = job_id.clone();
    let pack_id = pack_id.clone();
    let inv = host.read_invocation(&inv_id)?;
    let job = store.read_job(&job_id)?;
    let _ = workspace_id;
    runner.bind_cancel(cancel.clone());

    if cancel.is_cancelled() || inv.input.get("cancelBeforeWork").and_then(|v| v.as_bool()) == Some(true) {
        host.cancel(&inv_id)?;
        store.cancel_job(&job_id)?;
        return Ok(PackOutcome {
            pack_id,
            invocation_id: inv_id,
            job_id,
            artifact_id: None,
            status: "cancelled".into(),
            checkpoint: None,
            mode: "template".into(),
        });
    }

    let checkpoint = json!({"phase": "indexed", "packId": pack_id});
    store.checkpoint_job(&job_id, checkpoint.clone())?;
    host.checkpoint(&inv_id, checkpoint.clone())?;

    if inv.input.get("cancelAfterCheckpoint").and_then(|v| v.as_bool()) == Some(true) {
        host.cancel(&inv_id)?;
        store.cancel_job(&job_id)?;
        return Ok(PackOutcome {
            pack_id,
            invocation_id: inv_id,
            job_id,
            artifact_id: None,
            status: "cancelled".into(),
            checkpoint: Some(checkpoint),
            mode: "template".into(),
        });
    }

    let ctx = RenderContext {
        job_id: job_id.clone(),
        invocation_id: inv_id.clone(),
    };
    let rendered = match runner.render(&ctx, &pack_id, &inv.input) {
        Ok(v) => v,
        Err(e) => {
            // A cancel that killed the render must leave a cancelled job,
            // never a failed one and never a published artifact.
            let cancelled_now = cancel.is_cancelled()
                || store
                    .read_job(&job_id)
                    .map(|job| job.status == "cancelled")
                    .unwrap_or(false);
            if cancelled_now {
                host.cancel(&inv_id)?;
                store.cancel_job(&job_id)?;
                return Ok(PackOutcome {
                    pack_id,
                    invocation_id: inv_id,
                    job_id,
                    artifact_id: None,
                    status: "cancelled".into(),
                    checkpoint: Some(checkpoint),
                    mode: "template".into(),
                });
            }
            let _ = store.finish_job(&job_id, "failed");
            return Err(e);
        }
    };
    // A cancel that landed during the render must not publish: the artifact
    // is discarded and the job stays cancelled.
    let _publication = cancel.publication_guard();
    if cancel.is_cancelled() || store.read_job(&job_id)?.status == "cancelled" {
        host.cancel(&inv_id)?;
        store.cancel_job(&job_id)?;
        return Ok(PackOutcome {
            pack_id,
            invocation_id: inv_id,
            job_id,
            artifact_id: None,
            status: "cancelled".into(),
            checkpoint: Some(checkpoint),
            mode: "template".into(),
        });
    }
    let art = store.create_artifact(&job.workspace_id, &rendered.mime, &rendered.title)?;
    store.stage_artifact(&art.id, &rendered.bytes, &pack_id)?;
    store.verify_artifact(&art.id)?;
    // Publish receipt: durable evidence of the artifact in flight, written
    // before the one true side effect (publish). A crash in the publish →
    // completion tail leaves this receipt so resume can reconcile that
    // exact artifact instead of re-rendering and publishing a duplicate.
    host.set_receipt(
        &inv_id,
        Some(json!({"pendingPublish": art.id, "stage": "verified"})),
    )?;
    let published = store.publish_artifact(&art.id)?;
    store.finish_job(&job_id, "succeeded")?;
    host.complete(
        &inv_id,
        json!({"artifactId": published.id, "jobId": job_id}),
    )?;
    Ok(PackOutcome {
        pack_id,
        invocation_id: inv_id,
        job_id,
        artifact_id: Some(published.id),
        status: "succeeded".into(),
        checkpoint: Some(checkpoint),
        mode: outcome_mode(&rendered.bytes).into(),
    })
}

pub fn invoke(
    host: &PackHost,
    store: &ProductStore,
    pack_id: &str,
    workspace_id: &str,
    input: &Value,
    runner: &mut dyn PackRunner,
) -> Result<PackOutcome, PackExecError> {
    let admitted = admit_invocation(host, store, pack_id, workspace_id, input)?;
    execute_admitted(host, store, &admitted, runner, InvocationCancel::default())
}

/// Resume an interrupted/cancelled invocation, continuing its ORIGINAL job
/// identity. The invocation's durable job link decides which Job is retried:
/// resume never silently opens a new Job — that would lose the checkpoint
/// chain and fork the business identity. Invocations recorded before the job
/// link existed have no recoverable identity and are refused explicitly.
///
/// Validation is strictly read-only FIRST; the durable invocation only
/// transitions to `running` after every check passed, so a rejected resume
/// (wrong workspace, missing job link, already-succeeded job) never leaves
/// the record poisoned in `running` — the caller can retry correctly.
pub fn resume(
    host: &PackHost,
    store: &ProductStore,
    invocation_id: &str,
    workspace_id: &str,
    input: &Value,
    runner: &mut dyn PackRunner,
) -> Result<PackOutcome, PackExecError> {
    resume_with_cancel(host, store, invocation_id, workspace_id, input, runner, InvocationCancel::default())
}

pub fn resume_with_cancel(
    host: &PackHost, store: &ProductStore, invocation_id: &str, workspace_id: &str,
    input: &Value, runner: &mut dyn PackRunner, cancel: InvocationCancel,
) -> Result<PackOutcome, PackExecError> {
    runner.bind_cancel(cancel.clone());
    // ---- Read-only validation (no durable writes below this line) ----
    let inv = host.read_invocation(invocation_id)?;
    if inv.status != "cancelled" && inv.status != "failed" {
        return Err(PackExecError::Msg(format!(
            "invocation {invocation_id} is {}, not cancelled or failed; \
             nothing to resume",
            inv.status
        )));
    }
    let pack_record = host.read(&inv.pack_id)?;
    if pack_record.state != PackState::Installed {
        return Err(PackExecError::Msg(format!(
            "cannot resume: pack {} uninstalled",
            inv.pack_id
        )));
    }
    let Some(job_id) = inv.job_id.clone() else {
        return Err(PackExecError::Msg(format!(
            "invocation {invocation_id} has no durable job identity to continue \
             (pre-recovery-format record); invoke the pack again with a fresh idempotency key"
        )));
    };
    let existing = store.read_job(&job_id)?;
    if existing.r#type != inv.pack_id {
        return Err(PackExecError::Msg(format!(
            "job {job_id} belongs to pack {}, not resumed pack {}",
            existing.r#type, inv.pack_id
        )));
    }
    if existing.workspace_id != workspace_id {
        return Err(PackExecError::Msg(format!(
            "job {job_id} belongs to workspace {}, not {workspace_id}",
            existing.workspace_id
        )));
    }
    // Publish-receipt reconciliation (CODEX-0415): a crash inside the
    // publish tail left a durable receipt identifying the ONE artifact in
    // flight. Reconcile that exact artifact — never re-render, never create
    // or publish a second one. This covers both sides of the publish:
    // verified-but-unpublished (complete the recorded intent) and already
    // published (finish the bookkeeping only).
    if let Some(receipt) = inv.receipt.clone() {
        return reconcile_publish_receipt(host, store, &inv, &job_id, receipt);
    }
    // Crash window WITHOUT a receipt (pre-receipt-format records): the job
    // reached `succeeded` but the invocation never got its output recorded.
    // With no checkable artifact identity, re-running could publish a
    // duplicate — refuse for manual reconciliation instead.
    if existing.status == "succeeded" {
        return Err(PackExecError::Msg(format!(
            "job {job_id} already succeeded but invocation {invocation_id} has no \
             recorded output and no publish receipt (interrupted between job \
             completion and invocation completion); reconcile manually instead of \
             re-running — refusing to duplicate the published side effects"
        )));
    }
    // ---- Transitions (only after every check passed) ----
    let inv = host.resume(&inv.id)?;
    // A crashed job recovered to `failed` (or was cancelled earlier) is
    // retried in place: same id, same checkpoint chain, attempt count kept.
    let job = if existing.status == "failed" || existing.status == "cancelled" {
        store.retry_job(&job_id)?
    } else {
        existing
    };
    let job = store.run_job(&job.id)?;
    let ctx = RenderContext {
        job_id: job.id.clone(),
        invocation_id: inv.id.clone(),
    };
    let cancelled = || -> Result<PackOutcome, PackExecError> {
        host.cancel(&inv.id)?; store.cancel_job(&job.id)?;
        Ok(PackOutcome { pack_id:inv.pack_id.clone(), invocation_id:inv.id.clone(), job_id:job.id.clone(), artifact_id:None,
            status:"cancelled".into(), checkpoint:inv.checkpoint.clone(), mode:"template".into() })
    };
    if cancel.is_cancelled() { return cancelled(); }
    let rendered = match runner.render(&ctx, &inv.pack_id, input) {
        Ok(rendered) => rendered,
        Err(_) if cancel.is_cancelled() => return cancelled(),
        Err(error) => { let _ = host.fail(&inv.id, &error.to_string()); let _ = store.finish_job(&job.id, "failed"); return Err(error); }
    };
    let _publication = cancel.publication_guard();
    if cancel.is_cancelled() || store.read_job(&job.id)?.status == "cancelled" { return cancelled(); }

    let art = store.create_artifact(workspace_id, &rendered.mime, &rendered.title)?;
    store.stage_artifact(&art.id, &rendered.bytes, &inv.pack_id)?;
    store.verify_artifact(&art.id)?;
    // Same publish receipt as the initial invoke (see above).
    host.set_receipt(
        &inv.id,
        Some(json!({"pendingPublish": art.id, "stage": "verified"})),
    )?;
    let published = store.publish_artifact(&art.id)?;
    store.finish_job(&job.id, "succeeded")?;
    host.complete(
        &inv.id,
        json!({"artifactId": published.id, "resumed": true, "jobId": job.id}),
    )?;
    Ok(PackOutcome {
        pack_id: inv.pack_id,
        invocation_id: inv.id,
        job_id: job.id,
        artifact_id: Some(published.id),
        status: "succeeded".into(),
        checkpoint: inv.checkpoint,
        mode: outcome_mode(&rendered.bytes).into(),
    })
}

/// Reconcile an interrupted publish tail from the invocation's durable
/// receipt. Exactly one artifact was in flight; depending on how far the
/// publish got we either complete it or finish the bookkeeping — the render
/// is NEVER re-run and no second artifact is created:
/// - artifact `published`: the side effect already happened; finish the job
///   and record the invocation output against it.
/// - artifact `verified` (receipt written, crash before publish): complete
///   the recorded intent by publishing THAT artifact.
/// - anything else (missing/corrupt/unexpected lifecycle): refuse with a
///   typed reconciliation error — an unconfirmable side effect is never
///   redone blindly.
fn reconcile_publish_receipt(
    host: &PackHost,
    store: &ProductStore,
    inv: &Invocation,
    job_id: &str,
    receipt: Value,
) -> Result<PackOutcome, PackExecError> {
    let art_id = receipt
        .get("pendingPublish")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            PackExecError::Msg(format!(
                "invocation {} has a malformed publish receipt {receipt}; reconcile manually",
                inv.id
            ))
        })?
        .to_string();
    let art = store.read_artifact(&art_id).map_err(|e| {
        PackExecError::Msg(format!(
            "publish receipt of invocation {} points at artifact {art_id} which \
             cannot be read ({e}); reconcile manually — refusing to re-run",
            inv.id
        ))
    })?;
    let published = match art.lifecycle.as_str() {
        // The publish landed before the crash: only bookkeeping is missing.
        "published" => art,
        // The receipt was written but the publish itself was interrupted:
        // publish the already staged+verified artifact now (recorded intent,
        // same id — not a redo of unknown work).
        "verified" => store.publish_artifact(&art_id)?,
        other => {
            return Err(PackExecError::Msg(format!(
                "artifact {art_id} from the publish receipt of invocation {} is in \
                 lifecycle {other:?}; reconcile manually — refusing to re-run",
                inv.id
            )));
        }
    };
    // Walk the job to `succeeded` WITHOUT executing any work: pure status
    // bookkeeping for the already-produced artifact.
    let job = store.read_job(job_id)?;
    let job = match job.status.as_str() {
        "succeeded" | "running" => job,
        "queued" => store.run_job(&job.id)?,
        "failed" | "cancelled" => {
            let retried = store.retry_job(&job.id)?;
            store.run_job(&retried.id)?
        }
        other => {
            return Err(PackExecError::Msg(format!(
                "job {job_id} is in unexpected status {other:?} during publish \
                 reconciliation; reconcile manually"
            )));
        }
    };
    store.finish_job(&job.id, "succeeded")?;
    host.complete(
        &inv.id,
        json!({
            "artifactId": published.id,
            "jobId": job.id,
            "resumed": true,
            "reconciled": true,
        }),
    )?;
    let content = store
        .read_revision_content(published.current_revision.as_deref().unwrap_or(""))
        .unwrap_or_default();
    Ok(PackOutcome {
        pack_id: inv.pack_id.clone(),
        invocation_id: inv.id.clone(),
        job_id: job.id,
        artifact_id: Some(published.id),
        status: "succeeded".into(),
        checkpoint: inv.checkpoint.clone(),
        mode: outcome_mode(&content).into(),
    })
}

pub fn cancel(
    host: &PackHost,
    store: &ProductStore,
    invocation_id: &str,
    job_id: Option<&str>,
) -> Result<Invocation, PackExecError> {
    let before = host.read_invocation(invocation_id)?;
    if job_id.is_some_and(|job| Some(job) != before.job_id.as_deref()) {
        return Err(PackExecError::Invalid("job does not belong to this invocation".into()));
    }
    if before.status == "succeeded" { return Ok(before); }
    let inv = host.cancel(invocation_id)?;
    if let Some(jid) = inv.job_id.as_deref() { store.cancel_job(jid)?; }

    Ok(inv)
}

/// The rendered artifact carries a `Mode:` header; parse it back for the
/// outcome so the mode is always consistent with the published content.
fn outcome_mode(bytes: &[u8]) -> &'static str {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]);
    if head.contains("mode: model") {
        "model"
    } else {
        "template"
    }
}

/// Render one pack artifact. Public: the `knorvia-pack-worker` binary calls
/// this; the in-process runner and tests use it too.
pub fn render_pack(
    pack_id: &str,
    input: &Value,
    model: ModelAccess<'_>,
) -> Result<(&'static str, String, Vec<u8>), PackExecError> {
    match pack_id {
        "research.knowledge" => {
            let query = input
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if query.is_empty() {
                return Err(PackExecError::Msg(
                    "research.knowledge requires query".into(),
                ));
            }
            let mut corpus = Vec::new();
            if let Some(docs) = input.get("corpus").and_then(|v| v.as_array()) {
                for (i, d) in docs.iter().enumerate() {
                    let id = d
                        .get("id")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("doc-{i}"));
                    let title = d
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    let text = d
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    corpus.push((id, title, text));
                }
            }
            if corpus.is_empty() {
                corpus.push(("query".into(), "User query".into(), query.to_string()));
            }
            let hits = retrieve(query, &corpus);
            let mut md = format!("# Research: {query}\n\n");
            if hits.is_empty() {
                md.push_str("No matching sources.\n");
            }
            for (id, title, score, snippet) in &hits {
                md.push_str(&format!(
                    "## {title} ({id})\nscore: {score:.3}\n\n{snippet}\n\n"
                ));
            }
            let mode = match model {
                ModelAccess::None => "template",
                ModelAccess::Provided(backend) => {
                    let mut sources = String::new();
                    for (id, title, _score, snippet) in &hits {
                        sources.push_str(&format!("- [{title}#{id}] {snippet}\n"));
                    }
                    let prompt = format!(
                        "You are Knorvia's research assistant. Write a grounded research briefing \
                         for: \"{query}\". Use ONLY the sources below and cite them as [title#id].\n\n\
                         Sources:\n{sources}\nBriefing:"
                    );
                    let synthesis = backend.complete(&prompt)?;
                    md.push_str(&format!("## Synthesis\n\n{synthesis}\n\n"));
                    "model"
                }
            };
            md.insert_str(0, &format!("mode: {mode}\n\n"));
            Ok((
                "text/markdown",
                format!("research-{query}"),
                md.into_bytes(),
            ))
        }
        "memory.layered" => {
            let layer = input
                .get("layer")
                .and_then(|v| v.as_str())
                .unwrap_or("working");
            let text = input.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if text.trim().is_empty() {
                return Err(PackExecError::Msg("memory.layered requires text".into()));
            }
            let md = format!("# Memory ({layer})\n\n{text}\n");
            Ok(("text/markdown", format!("memory-{layer}"), md.into_bytes()))
        }
        "office.genoffice" => {
            let title = input
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled");
            let body = input.get("body").and_then(|v| v.as_str()).unwrap_or("");
            if body.trim().is_empty() {
                return Err(PackExecError::Msg("office.genoffice requires body".into()));
            }
            // Artifact runtime only — does not touch knorvia/services/office_artifacts.
            let md = format!("# {title}\n\n{body}\n");
            Ok((
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document+markdown",
                title.to_string(),
                md.into_bytes(),
            ))
        }
        "media.studio" => {
            let kind = input
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("image");
            let prompt = input.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
            if prompt.trim().is_empty() {
                return Err(PackExecError::Msg("media.studio requires prompt".into()));
            }
            let spec = json!({
                "kind": kind,
                "prompt": prompt,
                "status": "specified",
                "runtime": "knorvia-packs"
            });
            Ok((
                "application/json",
                format!("media-{kind}"),
                serde_json::to_vec_pretty(&spec).unwrap(),
            ))
        }
        "learning.mastery" => {
            let topic = input.get("topic").and_then(|v| v.as_str()).unwrap_or("");
            if topic.trim().is_empty() {
                return Err(PackExecError::Msg("learning.mastery requires topic".into()));
            }
            let n = input
                .get("num_questions")
                .and_then(|v| v.as_u64())
                .unwrap_or(2)
                .clamp(1, 20);
            let mut md = format!("# Quiz: {topic}\n\n");
            if let Some(follow) = input.get("followup") {
                md.push_str(&format!("## Follow-up\n\n{follow}\n\n"));
            }
            let mode = match model {
                ModelAccess::None => "template",
                ModelAccess::Provided(backend) => {
                    let prompt = format!(
                        "You are Knorvia's tutor. Write {n} exam-style practice questions \
                         about \"{topic}\". Number them and include a one-line answer key \
                         under each question.\n\nQuestions:"
                    );
                    let questions = backend.complete(&prompt)?;
                    md.push_str(&questions);
                    md.push('\n');
                    "model"
                }
            };
            if mode == "template" {
                for i in 1..=n {
                    md.push_str(&format!("{i}. What is {topic} (item {i})?\n"));
                }
            }
            md.insert_str(0, &format!("mode: {mode}\n\n"));
            Ok(("text/markdown", format!("quiz-{topic}"), md.into_bytes()))
        }
        "partners.connection" => {
            let name = input.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let channel = input
                .get("channel")
                .and_then(|v| v.as_str())
                .unwrap_or("cli");
            if name.trim().is_empty() {
                return Err(PackExecError::Msg(
                    "partners.connection requires name".into(),
                ));
            }
            let spec = json!({"name": name, "channel": channel, "kind": "connection"});
            Ok((
                "application/json",
                format!("partner-{name}"),
                serde_json::to_vec_pretty(&spec).unwrap(),
            ))
        }
        "automations.cron" => {
            let action = input.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let schedule = input
                .get("schedule")
                .and_then(|v| v.as_str())
                .unwrap_or("manual");
            if action.trim().is_empty() {
                return Err(PackExecError::Msg(
                    "automations.cron requires action".into(),
                ));
            }
            let spec = json!({"schedule": schedule, "action": action, "kind": "automation"});
            Ok((
                "application/json",
                format!("automation-{action}"),
                serde_json::to_vec_pretty(&spec).unwrap(),
            ))
        }
        "developer.workspace" => {
            let spec = input.get("spec").and_then(|v| v.as_str()).unwrap_or("");
            if spec.trim().is_empty() {
                return Err(PackExecError::Msg(
                    "developer.workspace requires spec".into(),
                ));
            }
            let code = format!("// {spec}\nfn main() {{ println!({spec:?}); }}\n");
            Ok(("text/x-rust", "main.rs".into(), code.into_bytes()))
        }
        "data.notebook" => {
            let rows = input.get("rows").cloned().unwrap_or_else(|| json!([]));
            if !rows.is_array() {
                return Err(PackExecError::Msg(
                    "data.notebook rows must be an array".into(),
                ));
            }
            Ok((
                "application/json",
                "dataset.json".into(),
                serde_json::to_vec_pretty(&json!({"rows": rows})).unwrap(),
            ))
        }
        other => Err(PackExecError::Msg(format!("unknown pack {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use knorvia_platform_paths::layout;
    use knorvia_store::ProductStore;

    fn tmp() -> (std::path::PathBuf, PackHost, ProductStore, String) {
        let base = std::env::temp_dir().join(format!(
            "knorvia-packs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let paths = layout(base.clone());
        let host = PackHost::open(&paths).unwrap();
        let store = ProductStore::open(paths).unwrap();
        ensure_official(&host).unwrap();
        let ws = store.create_workspace("packs").unwrap();
        (base, host, store, ws.id)
    }

    #[test]
    fn retrieve_ranks_real_corpus_by_query_terms() {
        let corpus = vec![
            (
                "a".into(),
                "Optics".into(),
                "Newton on refraction and colour".into(),
            ),
            (
                "b".into(),
                "Fourier".into(),
                "Fourier transform of a sine wave".into(),
            ),
            ("c".into(), "Cooking".into(), "boil water".into()),
        ];
        let hits = retrieve("Fourier sine", &corpus);
        assert_eq!(hits[0].0, "b");
        assert!(hits[0].2 > hits.iter().find(|h| h.0 == "a").map(|h| h.2).unwrap_or(0.0));
        assert!(!hits.iter().any(|h| h.0 == "c"));
    }

    #[test]
    fn all_official_packs_publish_artifacts_and_support_cancel_resume() {
        let (base, host, store, ws) = tmp();
        let research = invoke(
            &host,
            &store,
            "research.knowledge",
            &ws,
            &json!({
                "query": "Fourier sine",
                "corpus": [
                    {"id": "d1", "title": "Fourier", "text": "The Fourier transform of a sine"},
                    {"id": "d2", "title": "Unrelated", "text": "gardening tips"}
                ]
            }),
            &mut InProcessRunner::new(ModelChoice::None),
        )
        .unwrap();
        assert_eq!(research.status, "succeeded");
        assert_eq!(research.mode, "template");
        let art = store
            .read_artifact(research.artifact_id.as_deref().unwrap())
            .unwrap();
        assert_eq!(art.lifecycle, "published");
        assert!(art.title.contains("Fourier") || art.title.contains("research"));
        let rev_id = art.current_revision.clone().unwrap();
        assert!(rev_id.starts_with("rev_"));

        let cancelled = invoke(
            &host,
            &store,
            "media.studio",
            &ws,
            &json!({"prompt": "sunset", "kind": "image", "cancelAfterCheckpoint": true}),
            &mut InProcessRunner::new(ModelChoice::None),
        )
        .unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert!(cancelled.artifact_id.is_none());
        let job = store.read_job(&cancelled.job_id).unwrap();
        assert_eq!(job.status, "cancelled");

        let resumed = resume(
            &host,
            &store,
            &cancelled.invocation_id,
            &ws,
            &json!({"prompt": "sunset", "kind": "image"}),
            &mut InProcessRunner::new(ModelChoice::None),
        )
        .unwrap();
        assert_eq!(resumed.status, "succeeded");
        assert!(resumed.artifact_id.is_some());

        for (id, input) in [
            (
                "memory.layered",
                json!({"layer": "profile", "text": "prefers zh"}),
            ),
            (
                "office.genoffice",
                json!({"title": "Brief", "body": "Hello office"}),
            ),
            ("learning.mastery", json!({"topic": "Bayes"})),
            (
                "partners.connection",
                json!({"name": "ops-bot", "channel": "cli"}),
            ),
            (
                "automations.cron",
                json!({"schedule": "0 9 * * *", "action": "digest"}),
            ),
            ("developer.workspace", json!({"spec": "hello"})),
            ("data.notebook", json!({"rows": [{"n": 1}]})),
        ] {
            let out = invoke(
                &host,
                &store,
                id,
                &ws,
                &input,
                &mut InProcessRunner::new(ModelChoice::None),
            )
            .unwrap();
            assert_eq!(out.status, "succeeded", "{id}");
            assert_eq!(out.mode, "template", "{id}");
            let a = store
                .read_artifact(out.artifact_id.as_deref().unwrap())
                .unwrap();
            assert_eq!(a.lifecycle, "published", "{id}");
        }
        let arts = store.list_artifacts(&ws).unwrap();
        assert!(arts.len() >= 8);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn model_backed_pack_produces_labeled_model_artifact() {
        let (base, host, store, ws) = tmp();
        struct Scripted(String);
        impl PackModel for Scripted {
            fn complete(&mut self, _prompt: &str) -> Result<String, PackExecError> {
                Ok(self.0.clone())
            }
        }
        let mut model = Scripted("1. Define the Fourier transform and give one signal example.\n   Answer: decomposition of a signal into sine/cosine basis.".into());
        let mut runner = InProcessRunner::new(ModelChoice::Provided(&mut model));
        let out = invoke(
            &host,
            &store,
            "learning.mastery",
            &ws,
            &json!({"topic": "Fourier", "num_questions": 1}),
            &mut runner,
        )
        .unwrap();
        assert_eq!(out.status, "succeeded");
        assert_eq!(out.mode, "model");
        let art = store
            .read_artifact(out.artifact_id.as_deref().unwrap())
            .unwrap();
        let content = String::from_utf8(
            store
                .read_revision_content(art.current_revision.as_deref().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert!(content.starts_with("mode: model\n\n"), "{content}");
        assert!(content.contains("Fourier transform"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn missing_required_fields_do_not_publish() {
        let (base, host, store, ws) = tmp();
        let err = invoke(
            &host,
            &store,
            "research.knowledge",
            &ws,
            &json!({"query": ""}),
            &mut InProcessRunner::new(ModelChoice::None),
        )
        .unwrap_err();
        assert!(err.to_string().contains("query"));
        let _ = std::fs::remove_dir_all(base);
    }
    #[test]
    fn cancellation_latch_arbitrates_render_and_resume_publication() {
        struct CancellingRunner(Option<InvocationCancel>);
        impl PackRunner for CancellingRunner {
            fn bind_cancel(&mut self, cancel: InvocationCancel) { self.0 = Some(cancel); }
            fn render(&mut self, _: &RenderContext, _: &str, _: &Value) -> Result<RenderedPack, PackExecError> {
                self.0.as_ref().unwrap().cancel();
                Ok(RenderedPack { mime:"text/plain".into(), title:"must not publish".into(), bytes:b"late result".to_vec() })
            }
        }
        let (_base, host, store, ws) = tmp();
        let admitted = admit_invocation(&host, &store, "research.knowledge", &ws, &json!({"query":"cancel"})).unwrap();
        let out = execute_admitted(&host, &store, &admitted, &mut CancellingRunner(None), InvocationCancel::default()).unwrap();
        assert_eq!(out.status, "cancelled"); assert!(out.artifact_id.is_none());
        let resumed = resume_with_cancel(&host, &store, &admitted.invocation_id, &ws, &json!({"query":"cancel again"}), &mut CancellingRunner(None), InvocationCancel::default()).unwrap();
        assert_eq!(resumed.job_id, admitted.job_id);
        assert_eq!(resumed.status, "cancelled"); assert!(resumed.artifact_id.is_none());
        assert!(host.checkpoint(&admitted.invocation_id, json!({"late":true})).is_err());
        assert_eq!(host.read_invocation(&admitted.invocation_id).unwrap().status, "cancelled");
    }

    #[test]
    fn concurrent_cancel_registration_runs_killer_once_and_reports_failed_reclaim() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for _ in 0..50 {
            let token = InvocationCancel::default();
            let count = Arc::new(AtomicUsize::new(0));
            let other = token.clone(); let killed = Arc::clone(&count);
            let registration = std::thread::spawn(move || other.register_reclaimer(Arc::new(move || { killed.fetch_add(1, Ordering::SeqCst); false })));
            token.cancel(); registration.join().unwrap(); token.cancel();
            assert_eq!(count.load(Ordering::SeqCst), 1);
            assert!(!token.all_reclaimed());
        }
    }

}
