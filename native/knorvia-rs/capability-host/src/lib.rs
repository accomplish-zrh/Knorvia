//! Capability Pack host: install, invoke, cancel, resume, uninstall.
//! History remains readable after uninstall.

pub mod worker;

use knorvia_platform_paths::KnorviaPaths;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io;
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
}

pub struct PackHost {
    root: PathBuf,
}

impl PackHost {
    pub fn open(paths: &KnorviaPaths) -> Result<Self, PackError> {
        paths.ensure_layout()?;
        fs::create_dir_all(&paths.packs)?;
        fs::create_dir_all(paths.packs.join("history"))?;
        fs::create_dir_all(paths.packs.join("invocations"))?;
        Ok(Self {
            root: paths.packs.clone(),
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
        };
        self.write_inv(&inv)?;
        Ok(inv)
    }

    pub fn checkpoint(&self, id: &str, checkpoint: Value) -> Result<Invocation, PackError> {
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

    pub fn cancel(&self, id: &str) -> Result<Invocation, PackError> {
        let mut inv = self.read_inv(id)?;
        inv.status = "cancelled".into();
        self.write_inv(&inv)?;
        Ok(inv)
    }

    pub fn resume(&self, id: &str) -> Result<Invocation, PackError> {
        let mut inv = self.read_inv(id)?;
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

    pub fn complete(&self, id: &str, output: Value) -> Result<Invocation, PackError> {
        let mut inv = self.read_inv(id)?;
        inv.status = "succeeded".into();
        inv.output = Some(output);
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
        fs::write(self.inv_path(&inv.id), serde_json::to_vec_pretty(inv)?)?;
        Ok(())
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
