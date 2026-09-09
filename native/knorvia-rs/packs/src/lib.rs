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

#[derive(Debug, thiserror::Error)]
pub enum PackExecError {
    #[error(transparent)]
    Host(#[from] knorvia_capability_host::PackError),
    #[error(transparent)]
    Store(#[from] StoreError),
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

/// Executes one pack render. Production: the supervised `knorvia-pack-worker`
/// process (see `capability-host::worker`). Tests: in-process rendering.
pub trait PackRunner {
    fn render(
        &mut self,
        ctx: &RenderContext,
        pack_id: &str,
        input: &Value,
    ) -> Result<RenderedPack, PackExecError>;
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

pub fn invoke(
    host: &PackHost,
    store: &ProductStore,
    pack_id: &str,
    workspace_id: &str,
    input: &Value,
    runner: &mut dyn PackRunner,
) -> Result<PackOutcome, PackExecError> {
    let rec = host.read(pack_id)?;
    if rec.state != PackState::Installed {
        return Err(PackExecError::Msg(format!(
            "pack {pack_id} is not installed"
        )));
    }
    // Manifest permission gate: the pack declares the capability it may run;
    // an invocation without a declared capability is a policy violation, not
    // a render error.
    if rec.manifest.capabilities.is_empty() {
        return Err(PackExecError::Msg(format!(
            "pack {pack_id} declares no capabilities; refusing to invoke"
        )));
    }
    let _ = store.read_workspace(workspace_id)?;
    let inv = host.invoke(pack_id, input.clone())?;
    let mut job = store.create_job(workspace_id, pack_id)?;
    job = store.run_job(&job.id)?;

    if input.get("cancelBeforeWork").and_then(|v| v.as_bool()) == Some(true) {
        host.cancel(&inv.id)?;
        store.cancel_job(&job.id)?;
        return Ok(PackOutcome {
            pack_id: pack_id.into(),
            invocation_id: inv.id,
            job_id: job.id,
            artifact_id: None,
            status: "cancelled".into(),
            checkpoint: None,
            mode: "template".into(),
        });
    }

    let checkpoint = json!({"phase": "indexed", "packId": pack_id});
    store.checkpoint_job(&job.id, checkpoint.clone())?;
    host.checkpoint(&inv.id, checkpoint.clone())?;

    if input.get("cancelAfterCheckpoint").and_then(|v| v.as_bool()) == Some(true) {
        host.cancel(&inv.id)?;
        store.cancel_job(&job.id)?;
        return Ok(PackOutcome {
            pack_id: pack_id.into(),
            invocation_id: inv.id,
            job_id: job.id,
            artifact_id: None,
            status: "cancelled".into(),
            checkpoint: Some(checkpoint),
            mode: "template".into(),
        });
    }

    let ctx = RenderContext {
        job_id: job.id.clone(),
        invocation_id: inv.id.clone(),
    };
    let rendered = match runner.render(&ctx, pack_id, input) {
        Ok(v) => v,
        Err(e) => {
            let _ = store.finish_job(&job.id, "failed");
            return Err(e);
        }
    };
    // A cancel that landed during the render must not publish: the artifact
    // is discarded and the job stays cancelled.
    if store.read_job(&job.id)?.status == "cancelled" {
        host.cancel(&inv.id)?;
        return Ok(PackOutcome {
            pack_id: pack_id.into(),
            invocation_id: inv.id,
            job_id: job.id,
            artifact_id: None,
            status: "cancelled".into(),
            checkpoint: Some(checkpoint),
            mode: "template".into(),
        });
    }
    let art = store.create_artifact(workspace_id, &rendered.mime, &rendered.title)?;
    store.stage_artifact(&art.id, &rendered.bytes, pack_id)?;
    store.verify_artifact(&art.id)?;
    let published = store.publish_artifact(&art.id)?;
    store.finish_job(&job.id, "succeeded")?;
    host.complete(
        &inv.id,
        json!({"artifactId": published.id, "jobId": job.id}),
    )?;
    Ok(PackOutcome {
        pack_id: pack_id.into(),
        invocation_id: inv.id,
        job_id: job.id,
        artifact_id: Some(published.id),
        status: "succeeded".into(),
        checkpoint: Some(checkpoint),
        mode: outcome_mode(&rendered.bytes).into(),
    })
}

pub fn resume(
    host: &PackHost,
    store: &ProductStore,
    invocation_id: &str,
    workspace_id: &str,
    input: &Value,
    runner: &mut dyn PackRunner,
) -> Result<PackOutcome, PackExecError> {
    let inv = host.resume(invocation_id)?;
    let mut job = store.create_job(workspace_id, &inv.pack_id)?;
    job = store.run_job(&job.id)?;
    let ctx = RenderContext {
        job_id: job.id.clone(),
        invocation_id: inv.id.clone(),
    };
    let rendered = runner.render(&ctx, &inv.pack_id, input)?;
    let art = store.create_artifact(workspace_id, &rendered.mime, &rendered.title)?;
    store.stage_artifact(&art.id, &rendered.bytes, &inv.pack_id)?;
    store.verify_artifact(&art.id)?;
    let published = store.publish_artifact(&art.id)?;
    store.finish_job(&job.id, "succeeded")?;
    host.complete(
        &inv.id,
        json!({"artifactId": published.id, "resumed": true}),
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

pub fn cancel(
    host: &PackHost,
    store: &ProductStore,
    invocation_id: &str,
    job_id: Option<&str>,
) -> Result<Invocation, PackExecError> {
    let inv = host.cancel(invocation_id)?;
    if let Some(jid) = job_id {
        let _ = store.cancel_job(jid);
    }
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
}
