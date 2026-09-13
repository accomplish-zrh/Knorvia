//! Capability Pack host: install, invoke, cancel, resume, uninstall.
//! History remains readable after uninstall.

pub mod worker;

use knorvia_platform_paths::KnorviaPaths;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io;
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum PackError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Msg(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PackState {
    Installed,
    Disabled,
    Uninstalled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackManifest {
    pub id: String,
    pub version: String,
    pub publisher: String,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Worker runtime hosting this pack: `native` (Rust worker binary,
    /// default) or `python` (the Python media worker module).
    #[serde(default)]
    pub runtime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRecord {
    pub manifest: PackManifest,
    pub state: PackState,
    pub installed_at: String,
    #[serde(default)]
    pub uninstalled_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invocation {
    pub id: String,
    pub pack_id: String,
    pub status: String,
    pub input: Value,
    #[serde(default)]
    pub output: Option<Value>,
    #[serde(default)]
    pub checkpoint: Option<Value>,
    /// Durable link to the product Job carrying this invocation's business
    /// identity. Set right after the job is created so a restart can resume
    /// the SAME job instead of silently opening a new one. Older records
    /// written before this field existed deserialize as `None`.
    #[serde(default)]
    pub job_id: Option<String>,
    /// Durable publish receipt, written BEFORE the artifact is published and
    /// cleared on completion: `{"pendingPublish": "<artifactId>",
    /// "stage": "verified"}`. A crash between publish and job completion
    /// leaves checkable evidence of exactly which artifact was in flight, so
    /// resume can reconcile (complete or publish that one artifact) instead
    /// of re-rendering and publishing a duplicate. Older records deserialize
    /// as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Value>,
}

/// Process-wide nonce so concurrent atomic writes never share a staging file.
static WRITE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Crash-atomic invocation persistence: staged temp file + rename, so a
/// process interruption never leaves a half-written JSON in the Home.
fn atomic_write_json(path: &std::path::Path, value: &impl Serialize) -> Result<(), PackError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(value)?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("record");
    let nonce = WRITE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), nonce));
    let write = (|| {
        let mut f = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        Ok::<(), PackError>(())
    })();
    match write {
        Ok(()) => {}
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
    }
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e.into())
        }
    }
}

pub struct PackHost {
    root: PathBuf,
    invocation_writes: std::sync::Mutex<()>,
}

impl PackHost {
    pub fn open(paths: &KnorviaPaths) -> Result<Self, PackError> {
        paths.ensure_layout()?;
        fs::create_dir_all(&paths.packs)?;
        fs::create_dir_all(paths.packs.join("history"))?;
        fs::create_dir_all(paths.packs.join("invocations"))?;
        Ok(Self {
            root: paths.packs.clone(),
            invocation_writes: std::sync::Mutex::new(()),
        })
    }

    fn rec_path(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }
    fn hist_path(&self, id: &str) -> PathBuf {
        self.root.join("history").join(format!("{id}.json"))
    }
    fn inv_path(&self, id: &str) -> PathBuf {
        self.root.join("invocations").join(format!("{id}.json"))
    }

    pub fn install(&self, manifest: PackManifest) -> Result<PackRecord, PackError> {
        let rec = PackRecord {
            manifest,
            state: PackState::Installed,
            installed_at: now(),
            uninstalled_at: None,
        };
        let bytes = serde_json::to_vec_pretty(&rec)?;
        fs::write(self.rec_path(&rec.manifest.id), &bytes)?;
        fs::write(self.hist_path(&rec.manifest.id), &bytes)?;
        Ok(rec)
    }

    pub fn uninstall(&self, id: &str) -> Result<PackRecord, PackError> {
        let mut rec = self.read(id)?;
        rec.state = PackState::Uninstalled;
        rec.uninstalled_at = Some(now());
        let bytes = serde_json::to_vec_pretty(&rec)?;
        fs::write(self.rec_path(id), &bytes)?;
        fs::write(self.hist_path(id), &bytes)?;
        Ok(rec)
    }

    pub fn read(&self, id: &str) -> Result<PackRecord, PackError> {
        let path = self.rec_path(id);
        if !path.exists() {
            return Err(PackError::Msg(format!("pack {id} not found")));
        }
        Ok(serde_json::from_slice(&fs::read(path)?)?)
    }

    pub fn history(&self, id: &str) -> Result<PackRecord, PackError> {
        let path = self.hist_path(id);
        if !path.exists() {
            return Err(PackError::Msg(format!("pack history {id} not found")));
        }
        Ok(serde_json::from_slice(&fs::read(path)?)?)
    }

    /// Read one durable invocation record (job identity, checkpoint, status).
    pub fn read_invocation(&self, id: &str) -> Result<Invocation, PackError> {
        self.read_inv(id)
    }

    pub fn invoke(&self, pack_id: &str, input: Value) -> Result<Invocation, PackError> {
        let rec = self.read(pack_id)?;
        if rec.state != PackState::Installed {
            return Err(PackError::Msg(format!("pack {pack_id} is not installed")));
        }
        let inv = Invocation {
            id: knorvia_protocol::new_id("inv"),
            pack_id: pack_id.to_string(),
            status: "running".into(),
            input,
            output: None,
            checkpoint: None,
            job_id: None,
            receipt: None,
        };
        self.write_inv(&inv)?;
        Ok(inv)
    }

    /// Durably record (or clear) the publish receipt. Only valid while the
    /// invocation is `running`: the receipt is written after the artifact is
    /// staged+verified and BEFORE it is published, and `complete` clears it.
    pub fn set_receipt(&self, id: &str, receipt: Option<Value>) -> Result<Invocation, PackError> {
        let _writes = self
            .invocation_writes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut inv = self.read_inv(id)?;
        if inv.status != "running" {
            return Err(PackError::Msg(
                "publish receipt requires running invocation".into(),
            ));
        }
        inv.receipt = receipt;
        self.write_inv(&inv)?;
        Ok(inv)
    }

    /// Durably link an invocation to the product Job that owns its business
    /// identity (created by `knorvia_packs::invoke` right after the job is
    /// opened). Resume reads this link to continue the SAME job.
    pub fn link_job(&self, id: &str, job_id: &str) -> Result<Invocation, PackError> {
        let _writes = self
            .invocation_writes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut inv = self.read_inv(id)?;
        if inv.status != "running" {
            return Err(PackError::Msg(
                "job link requires running invocation".into(),
            ));
        }
        inv.job_id = Some(job_id.to_string());
        self.write_inv(&inv)?;
        Ok(inv)
    }

    pub fn checkpoint(&self, id: &str, checkpoint: Value) -> Result<Invocation, PackError> {
        let _writes = self
            .invocation_writes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut inv = self.read_inv(id)?;
        if inv.status != "running" {
            return Err(PackError::Msg(
                "checkpoint requires running invocation".into(),
            ));
        }
        inv.checkpoint = Some(checkpoint);
        self.write_inv(&inv)?;
        Ok(inv)
    }

    pub fn fail(&self, id: &str, message: &str) -> Result<Invocation, PackError> {
        let _writes = self
            .invocation_writes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut inv = self.read_inv(id)?;
        if inv.status == "running" {
            inv.status = "failed".into();
            inv.output = Some(serde_json::json!({"error":message}));
            self.write_inv(&inv)?;
        }
        Ok(inv)
    }

    pub fn cancel(&self, id: &str) -> Result<Invocation, PackError> {
        let _writes = self
            .invocation_writes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut inv = self.read_inv(id)?;
        if inv.status == "succeeded" {
            return Ok(inv);
        }
        inv.status = "cancelled".into();
        self.write_inv(&inv)?;
        Ok(inv)
    }

    pub fn resume(&self, id: &str) -> Result<Invocation, PackError> {
        let _writes = self
            .invocation_writes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut inv = self.read_inv(id)?;
        // A crash-surviving invocation was turned `failed` by
        // [`Self::recover_incomplete`] at startup; resume continues THAT
        // business identity instead of refusing a forever-`running` record.
        if inv.status != "cancelled" && inv.status != "failed" {
            return Err(PackError::Msg("resume requires cancelled or failed".into()));
        }
        let rec = self.read(&inv.pack_id)?;
        if rec.state != PackState::Installed {
            return Err(PackError::Msg("cannot resume: pack uninstalled".into()));
        }
        inv.status = "running".into();
        self.write_inv(&inv)?;
        Ok(inv)
    }

    /// Convert durable `running` invocations left by a previous process into
    /// the explicit `failed` terminal state, keeping their checkpoint and job
    /// link intact. Recovery never re-runs work: unknown external side effects
    /// are not redone automatically — an explicit `resume` continues the
    /// recorded business identity. Call once at startup, after establishing
    /// that no runner from the old process can still own this Home.
    pub fn recover_incomplete(&self) -> Result<Vec<Invocation>, PackError> {
        let mut recovered = Vec::new();
        let dir = self.root.join("invocations");
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(recovered),
            Err(e) => return Err(e.into()),
        };
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            // An unparsable invocation file is left untouched: recovery only
            // asserts about records it can actually read.
            let Ok(mut inv) = serde_json::from_slice::<Invocation>(&fs::read(path)?) else {
                continue;
            };
            if inv.status != "running" {
                continue;
            }
            inv.status = "failed".into();
            self.write_inv(&inv)?;
            recovered.push(inv);
        }
        Ok(recovered)
    }

    pub fn complete(&self, id: &str, output: Value) -> Result<Invocation, PackError> {
        let _writes = self
            .invocation_writes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut inv = self.read_inv(id)?;
        if inv.status == "cancelled" {
            return Err(PackError::Msg(
                "cancelled invocation cannot complete".into(),
            ));
        }
        inv.status = "succeeded".into();
        inv.output = Some(output);
        // The publish journey is over: the in-flight receipt is spent.
        inv.receipt = None;
        self.write_inv(&inv)?;
        Ok(inv)
    }

    fn read_inv(&self, id: &str) -> Result<Invocation, PackError> {
        let path = self.inv_path(id);
        if !path.exists() {
            return Err(PackError::Msg(format!("invocation {id} not found")));
        }
        Ok(serde_json::from_slice(&fs::read(path)?)?)
    }

    fn write_inv(&self, inv: &Invocation) -> Result<(), PackError> {
        atomic_write_json(&self.inv_path(&inv.id), inv)
    }
}

fn now() -> String {
    format!(
        "{}ms",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use knorvia_platform_paths::layout;

    #[test]
    fn install_invoke_cancel_resume_uninstall_keeps_history() {
        let base =
            std::env::temp_dir().join(format!("knorvia-pack-{}-{}", std::process::id(), now()));
        fs::create_dir_all(&base).unwrap();
        let paths = layout(base.clone());
        let host = PackHost::open(&paths).unwrap();
        let rec = host
            .install(PackManifest {
                id: "office.genoffice".into(),
                version: "1.0.0".into(),
                publisher: "knorvia".into(),
                capabilities: vec!["artifact.office".into()],
                permissions: vec!["fs.write".into()],
                runtime: "native".into(),
            })
            .unwrap();
        assert_eq!(rec.state, PackState::Installed);
        let inv = host
            .invoke("office.genoffice", serde_json::json!({"op": "draft"}))
            .unwrap();
        host.checkpoint(&inv.id, serde_json::json!({"step": 1}))
            .unwrap();
        host.cancel(&inv.id).unwrap();
        host.resume(&inv.id).unwrap();
        host.complete(&inv.id, serde_json::json!({"artifact": "art_1"}))
            .unwrap();
        host.uninstall("office.genoffice").unwrap();
        let hist = host.history("office.genoffice").unwrap();
        assert_eq!(hist.state, PackState::Uninstalled);
        assert!(hist.uninstalled_at.is_some());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn official_domain_packs_produce_versioned_artifacts() {
        use knorvia_store::ProductStore;
        let base = std::env::temp_dir().join(format!("knorvia-domains-{}", now()));
        fs::create_dir_all(&base).unwrap();
        let paths = layout(base.clone());
        let host = PackHost::open(&paths).unwrap();
        let store = ProductStore::open(paths.clone()).unwrap();
        let ws = store.create_workspace("domains").unwrap();
        let domains = [
            ("research.knowledge", "text/markdown", "# sources\n"),
            (
                "office.genoffice",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "PK\x03\x04office",
            ),
            ("developer.workspace", "text/x-rust", "fn main() {}\n"),
            ("data.notebook", "application/json", "{\"rows\":[]}\n"),
            ("media.studio", "text/plain", "job:render\n"),
            ("learning.mastery", "text/markdown", "# quiz\n"),
        ];
        for (pack, ty, body) in domains {
            host.install(PackManifest {
                id: pack.into(),
                version: "1.0.0".into(),
                publisher: "knorvia".into(),
                capabilities: vec![pack.into()],
                permissions: vec![],
                runtime: "native".into(),
            })
            .unwrap();
            let inv = host
                .invoke(pack, serde_json::json!({"workspaceId": ws.id}))
                .unwrap();
            let art = store.create_artifact(&ws.id, ty, pack).unwrap();
            store
                .stage_artifact(&art.id, body.as_bytes(), pack)
                .unwrap();
            store.verify_artifact(&art.id).unwrap();
            let published = store.publish_artifact(&art.id).unwrap();
            assert_eq!(published.lifecycle, "published");
            host.complete(&inv.id, serde_json::json!({"artifactId": published.id}))
                .unwrap();
        }
        let arts = store.list_artifacts(&ws.id).unwrap();
        assert_eq!(arts.len(), 6);
        let _ = fs::remove_dir_all(base);
    }
}
