//! Legacy Knorvia data migration.
//! Source is never overwritten. Runs are idempotent by persistent legacy-id map.

use knorvia_platform_paths::KnorviaPaths;
use knorvia_store::ProductStore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum MigrateError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Msg(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MigratePhase {
    Discovered,
    Preflighted,
    Snapshotted,
    Imported,
    Verified,
    Activated,
    RolledBack,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateRun {
    pub id: String,
    pub phase: MigratePhase,
    pub source: PathBuf,
    pub snapshot: Option<PathBuf>,
    #[serde(default)]
    pub dest_snapshot: Option<PathBuf>,
    pub warnings: Vec<String>,
    pub imported: u64,
    pub mapping: Vec<IdMap>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdMap {
    pub legacy_source: String,
    pub legacy_id: String,
    pub new_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LegacyDump {
    #[serde(default)]
    sessions: Vec<LegacySession>,
    #[serde(default)]
    artifacts: Vec<LegacyArtifact>,
    #[serde(default)]
    jobs: Vec<LegacyJob>,
    #[serde(default)]
    settings: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LegacySession {
    id: String,
    #[serde(default)]
    title: String,
    /// Legacy chat messages (role + content + optional metadata), in
    /// conversation order. Imported as turn events so the history survives
    /// the cutover.
    #[serde(default)]
    messages: Vec<LegacyMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LegacyMessage {
    #[serde(default)]
    role: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LegacyArtifact {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LegacyJob {
    id: String,
    #[serde(default)]
    action: String,
    #[serde(default)]
    session_id: String,
}

pub struct Migrator {
    dest: ProductStore,
    runs_dir: PathBuf,
    backup_dir: PathBuf,
}

impl Migrator {
    pub fn open(paths: KnorviaPaths) -> Result<Self, MigrateError> {
        let dest =
            ProductStore::open(paths.clone()).map_err(|e| MigrateError::Msg(e.to_string()))?;
        fs::create_dir_all(&paths.backups)?;
        let runs = paths.backups.join("migrate-runs");
        fs::create_dir_all(&runs)?;
        Ok(Self {
            dest,
            runs_dir: runs,
            backup_dir: paths.backups,
        })
    }

    pub fn discover(&self, source: &Path) -> Result<Vec<PathBuf>, MigrateError> {
        let mut found = Vec::new();
        if source.is_dir() {
            for name in ["sessions", "data", "user", "settings", "jobs", "artifacts"] {
                let p = source.join(name);
                if p.exists() {
                    found.push(p);
                }
            }
            let dump = source.join("legacy.json");
            if dump.exists() {
                found.push(dump);
            }
        }
        if found.is_empty() && source.is_file() {
            found.push(source.to_path_buf());
        }
        Ok(found)
    }

    pub fn preflight(&self, source: &Path) -> Result<Vec<String>, MigrateError> {
        let mut warnings = Vec::new();
        if !source.exists() {
            return Err(MigrateError::Msg("source missing".into()));
        }
        let dump = load_dump(source)?;
        if dump.sessions.is_empty() && dump.artifacts.is_empty() && dump.jobs.is_empty() {
            warnings.push("no sessions, artifacts, or jobs in dump".into());
        }
        Ok(warnings)
    }

    pub fn run(&self, source: &Path) -> Result<MigrateRun, MigrateError> {
        let id = knorvia_protocol::new_id("mig");
        let mut run = MigrateRun {
            id: id.clone(),
            phase: MigratePhase::Discovered,
            source: source.to_path_buf(),
            snapshot: None,
            dest_snapshot: None,
            warnings: Vec::new(),
            imported: 0,
            mapping: Vec::new(),
        };
        self.save(&run)?;

        match self.preflight(source) {
            Ok(w) => run.warnings.extend(w),
            Err(e) => {
                run.phase = MigratePhase::Failed;
                run.warnings.push(e.to_string());
                self.save(&run)?;
                return Err(e);
            }
        }
        run.phase = MigratePhase::Preflighted;
        self.save(&run)?;

        let snap = self.backup_dir.join(format!("snapshot-{id}"));
        copy_tree(source, &snap)?;
        run.snapshot = Some(snap);
        run.phase = MigratePhase::Snapshotted;
        self.save(&run)?;

        let dest_snap = self.backup_dir.join(format!("dest-before-{id}"));
        snapshot_dest(&self.dest, &dest_snap)?;
        run.dest_snapshot = Some(dest_snap);
        self.save(&run)?;

        let dump = load_dump(source)?;
        let mut map = self.load_id_map()?;
        let mut session_ws: HashMap<String, String> = HashMap::new();

        for sess in &dump.sessions {
            let key = format!("session:{}", sess.id);
            let ws_id = if let Some(existing) = map.get(&key) {
                if self.dest.read_workspace(existing).is_ok() {
                    existing.clone()
                } else {
                    self.import_session(sess, &mut map, &key)?
                }
            } else {
                self.import_session(sess, &mut map, &key)?
            };
            session_ws.insert(sess.id.clone(), ws_id.clone());
            run.mapping.push(IdMap {
                legacy_source: "session".into(),
                legacy_id: sess.id.clone(),
                new_id: ws_id,
            });
            run.imported += 1;
        }

        let default_ws = if let Some(id) = session_ws.values().next() {
            id.clone()
        } else {
            let ws = self
                .dest
                .create_workspace("imported")
                .map_err(|e| MigrateError::Msg(e.to_string()))?;
            ws.id
        };

        for art in &dump.artifacts {
            let key = format!("artifact:{}", art.id);
            let ws = session_ws
                .get(&art.session_id)
                .cloned()
                .unwrap_or_else(|| default_ws.clone());
            let new_id = if let Some(existing) = map.get(&key) {
                if self.dest.read_artifact(existing).is_ok() {
                    existing.clone()
                } else {
                    self.import_artifact(art, &ws, &mut map, &key)?
                }
            } else {
                self.import_artifact(art, &ws, &mut map, &key)?
            };
            run.mapping.push(IdMap {
                legacy_source: "artifact".into(),
                legacy_id: art.id.clone(),
                new_id,
            });
            run.imported += 1;
        }

        for job in &dump.jobs {
            let key = format!("job:{}", job.id);
            let ws = session_ws
                .get(&job.session_id)
                .cloned()
                .unwrap_or_else(|| default_ws.clone());
            let new_id = if let Some(existing) = map.get(&key) {
                if self.dest.read_job(existing).is_ok() {
                    existing.clone()
                } else {
                    self.import_job(job, &ws, &mut map, &key)?
                }
            } else {
                self.import_job(job, &ws, &mut map, &key)?
            };
            run.mapping.push(IdMap {
                legacy_source: "job".into(),
                legacy_id: job.id.clone(),
                new_id,
            });
            run.imported += 1;
        }

        let settings_present = !dump.settings.is_null() && dump.settings != json!({});
        if settings_present {
            let key = "settings:root".to_string();
            let settings_id = match map.get(&key) {
                Some(id) if self.dest.read_artifact(id).is_ok() => id.clone(),
                _ => {
                    let bytes = serde_json::to_vec_pretty(&dump.settings)?;
                    let art = self
                        .dest
                        .create_artifact(&default_ws, "application/json", "imported-settings")
                        .map_err(|e| MigrateError::Msg(e.to_string()))?;
                    self.dest
                        .stage_artifact(&art.id, &bytes, "migration")
                        .map_err(|e| MigrateError::Msg(e.to_string()))?;
                    self.dest
                        .verify_artifact(&art.id)
                        .map_err(|e| MigrateError::Msg(e.to_string()))?;
                    let published = self
                        .dest
                        .publish_artifact(&art.id)
                        .map_err(|e| MigrateError::Msg(e.to_string()))?;
                    map.insert(key.clone(), published.id.clone());
                    published.id
                }
            };
            // Reused settings still count: idempotency means same mapping,
            // not a shorter report.
            run.mapping.push(IdMap {
                legacy_source: "settings".into(),
                legacy_id: "root".into(),
                new_id: settings_id,
            });
            run.imported += 1;
        }

        self.save_id_map(&map)?;
        run.phase = MigratePhase::Imported;
        self.save(&run)?;

        let expected = dump.sessions.len()
            + dump.artifacts.len()
            + dump.jobs.len()
            + usize::from(settings_present);
        if run.imported as usize != expected {
            run.warnings.push(format!(
                "count mismatch imported={} expected={}",
                run.imported, expected
            ));
            run.phase = MigratePhase::Failed;
            self.save(&run)?;
            return Err(MigrateError::Msg("verify failed".into()));
        }
        for m in &run.mapping {
            match m.legacy_source.as_str() {
                "session" => {
                    self.dest
                        .read_workspace(&m.new_id)
                        .map_err(|e| MigrateError::Msg(e.to_string()))?;
                }
                "artifact" | "settings" => {
                    self.dest
                        .read_artifact(&m.new_id)
                        .map_err(|e| MigrateError::Msg(e.to_string()))?;
                }
                "job" => {
                    self.dest
                        .read_job(&m.new_id)
                        .map_err(|e| MigrateError::Msg(e.to_string()))?;
                }
                _ => {}
            }
        }
        run.phase = MigratePhase::Verified;
        self.save(&run)?;

        let pointer = self.backup_dir.join("active-migration.json");
        fs::write(&pointer, serde_json::to_vec_pretty(&run)?)?;
        run.phase = MigratePhase::Activated;
        self.save(&run)?;
        Ok(run)
    }

    pub fn rollback(&self, run_id: &str) -> Result<MigrateRun, MigrateError> {
        let mut run = self.load(run_id)?;
        let pointer = self.backup_dir.join("active-migration.json");
        if pointer.exists() {
            fs::remove_file(&pointer)?;
        }
        if let Some(dest_snap) = &run.dest_snapshot {
            restore_dest(&self.dest, dest_snap)?;
        }
        run.phase = MigratePhase::RolledBack;
        self.save(&run)?;
        if !run.source.exists() {
            return Err(MigrateError::Msg(
                "source disappeared; rollback cannot restore it because we never overwrite sources, and snapshot is the recovery artifact".into(),
            ));
        }
        Ok(run)
    }

    pub fn read_run(&self, run_id: &str) -> Result<MigrateRun, MigrateError> {
        self.load(run_id)
    }

    fn import_session(
        &self,
        sess: &LegacySession,
        map: &mut HashMap<String, String>,
        key: &str,
    ) -> Result<String, MigrateError> {
        let title = if sess.title.is_empty() {
            format!("imported {}", sess.id)
        } else {
            sess.title.clone()
        };
        let ws = self
            .dest
            .create_workspace(&title)
            .map_err(|e| MigrateError::Msg(e.to_string()))?;
        let th = self
            .dest
            .create_thread(&ws.id, &title, None, None)
            .map_err(|e| MigrateError::Msg(e.to_string()))?;
        // Import the legacy conversation as turn events on the thread stream:
        // one `message` event per legacy message, preserving role/content and
        // the metadata the web UI renders (call ids, attachments, …).
        for msg in &sess.messages {
            let role = if msg.role.is_empty() {
                "assistant".to_string()
            } else {
                msg.role.clone()
            };
            self.dest
                .append_event(
                    &th.id,
                    "message",
                    json!({
                        "role": role,
                        "content": msg.content,
                        "metadata": msg.metadata,
                        "imported": true,
                    }),
                    Some(sess.id.clone()),
                )
                .map_err(|e| MigrateError::Msg(e.to_string()))?;
        }
        map.insert(key.to_string(), ws.id.clone());
        Ok(ws.id)
    }

    fn import_artifact(
        &self,
        art: &LegacyArtifact,
        workspace_id: &str,
        map: &mut HashMap<String, String>,
        key: &str,
    ) -> Result<String, MigrateError> {
        let title = if art.title.is_empty() {
            format!("imported-{}", art.id)
        } else {
            art.title.clone()
        };
        let created = self
            .dest
            .create_artifact(workspace_id, "text/markdown", &title)
            .map_err(|e| MigrateError::Msg(e.to_string()))?;
        let body = if art.body.is_empty() {
            format!("# {title}\n")
        } else {
            art.body.clone()
        };
        self.dest
            .stage_artifact(&created.id, body.as_bytes(), "migration")
            .map_err(|e| MigrateError::Msg(e.to_string()))?;
        self.dest
            .verify_artifact(&created.id)
            .map_err(|e| MigrateError::Msg(e.to_string()))?;
        let published = self
            .dest
            .publish_artifact(&created.id)
            .map_err(|e| MigrateError::Msg(e.to_string()))?;
        map.insert(key.to_string(), published.id.clone());
        Ok(published.id)
    }

    fn import_job(
        &self,
        job: &LegacyJob,
        workspace_id: &str,
        map: &mut HashMap<String, String>,
        key: &str,
    ) -> Result<String, MigrateError> {
        let kind = if job.action.is_empty() {
            "imported"
        } else {
            job.action.as_str()
        };
        let created = self
            .dest
            .create_job(workspace_id, kind)
            .map_err(|e| MigrateError::Msg(e.to_string()))?;
        map.insert(key.to_string(), created.id.clone());
        Ok(created.id)
    }

    fn id_map_path(&self) -> PathBuf {
        self.backup_dir.join("legacy-id-map.json")
    }

    fn load_id_map(&self) -> Result<HashMap<String, String>, MigrateError> {
        let path = self.id_map_path();
        if !path.exists() {
            return Ok(HashMap::new());
        }
        Ok(serde_json::from_slice(&fs::read(path)?)?)
    }

    fn save_id_map(&self, map: &HashMap<String, String>) -> Result<(), MigrateError> {
        fs::write(self.id_map_path(), serde_json::to_vec_pretty(map)?)?;
        Ok(())
    }

    fn save(&self, run: &MigrateRun) -> Result<(), MigrateError> {
        fs::write(
            self.runs_dir.join(format!("{}.json", run.id)),
            serde_json::to_vec_pretty(run)?,
        )?;
        Ok(())
    }

    fn load(&self, id: &str) -> Result<MigrateRun, MigrateError> {
        Ok(serde_json::from_slice(&fs::read(
            self.runs_dir.join(format!("{id}.json")),
        )?)?)
    }
}

fn snapshot_dest(store: &ProductStore, dest_snap: &Path) -> Result<(), MigrateError> {
    fs::create_dir_all(dest_snap)?;
    // Snapshot the whole durable state tree, not just product+events. The
    // store keeps write-ahead transaction intents in state/store-wal and
    // recovery evidence in state/store-recovery; a partial snapshot let a
    // later rollback "resurrect" already-imported workspaces by replaying
    // those intents on the next store open.
    let state = store.paths().state.clone();
    if state.exists() {
        copy_tree(&state, &dest_snap.join("state"))?;
    }
    Ok(())
}

fn restore_dest(store: &ProductStore, dest_snap: &Path) -> Result<(), MigrateError> {
    let state = store.paths().state.clone();
    if state.exists() {
        fs::remove_dir_all(&state)?;
    }
    if dest_snap.join("state").exists() {
        copy_tree(&dest_snap.join("state"), &state)?;
    } else {
        fs::create_dir_all(&state)?;
    }
    // Filesystem state moved underneath this handle; force a full recovery on
    // its next operation instead of trusting stale sequence/fingerprint state.
    store.invalidate_recovered_cache();
    Ok(())
}

fn load_dump(source: &Path) -> Result<LegacyDump, MigrateError> {
    let file = if source.is_file() {
        source.to_path_buf()
    } else {
        source.join("legacy.json")
    };
    if !file.exists() {
        return Ok(LegacyDump::default());
    }
    Ok(serde_json::from_slice(&fs::read(file)?)?)
}

fn copy_tree(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    if src.is_file() {
        fs::copy(src, dst.join(src.file_name().unwrap()))?;
        return Ok(());
    }
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use knorvia_platform_paths::layout;

    fn write_fixture(source: &Path) {
        fs::create_dir_all(source.join("sessions")).unwrap();
        fs::create_dir_all(source.join("artifacts")).unwrap();
        fs::create_dir_all(source.join("jobs")).unwrap();
        let dump = serde_json::json!({
            "sessions": [
                {"id": "sess-a", "title": "Old research"},
                {"id": "sess-b", "title": "Old office"}
            ],
            "artifacts": [
                {"id": "art-1", "title": "brief.md", "body": "# Brief\n", "session_id": "sess-a"}
            ],
            "jobs": [
                {"id": "job-1", "action": "digest", "session_id": "sess-b"}
            ],
            "settings": {"language": "zh"}
        });
        fs::write(source.join("legacy.json"), dump.to_string()).unwrap();
    }

    #[test]
    fn discover_preflight_snapshot_import_verify_activate_rollback() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("knorvia-mig-{stamp}"));
        let source = root.join("legacy-src");
        let dest = root.join("knorvia-home");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dest).unwrap();
        write_fixture(&source);
        let src_before = fs::read_to_string(source.join("legacy.json")).unwrap();

        let m = Migrator::open(layout(dest.clone())).unwrap();
        let found = m.discover(&source).unwrap();
        assert!(found.iter().any(|p| p.ends_with("legacy.json")));
        assert!(found.iter().any(|p| p.ends_with("sessions")));

        let run = m.run(&source).unwrap();
        assert_eq!(run.phase, MigratePhase::Activated);
        assert_eq!(run.imported, 5);
        assert_eq!(run.mapping.len(), 5);
        let store = ProductStore::open(layout(dest.clone())).unwrap();
        assert_eq!(store.list_workspaces().unwrap().len(), 2);
        let arts: usize = store
            .list_workspaces()
            .unwrap()
            .iter()
            .map(|w| store.list_artifacts(&w.id).unwrap().len())
            .sum();
        assert!(arts >= 2);

        let first_ids: Vec<String> = run
            .mapping
            .iter()
            .filter(|m| m.legacy_source == "session")
            .map(|m| m.new_id.clone())
            .collect();
        let again = m.run(&source).unwrap();
        assert_eq!(again.imported, 5);
        let again_ids: Vec<String> = again
            .mapping
            .iter()
            .filter(|m| m.legacy_source == "session")
            .map(|m| m.new_id.clone())
            .collect();
        assert_eq!(first_ids, again_ids);
        assert_eq!(store.list_workspaces().unwrap().len(), 2);
        assert_eq!(
            fs::read_to_string(source.join("legacy.json")).unwrap(),
            src_before
        );

        let rolled = m.rollback(&run.id).unwrap();
        assert_eq!(rolled.phase, MigratePhase::RolledBack);
        assert_eq!(
            fs::read_to_string(source.join("legacy.json")).unwrap(),
            src_before
        );
        let after = ProductStore::open(layout(dest.clone())).unwrap();
        assert!(after.list_workspaces().unwrap().is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_messages_import_as_turn_events() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("knorvia-mig-msg-{stamp}"));
        let source = root.join("legacy-src");
        let dest = root.join("knorvia-home");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dest).unwrap();
        let dump = serde_json::json!({
            "sessions": [
                {
                    "id": "sess-chat",
                    "title": "Old chat",
                    "messages": [
                        {"role": "user", "content": "What is 2+2?"},
                        {
                            "role": "assistant",
                            "content": "It is 4.",
                            "metadata": {"call_id": "c1", "call_kind": "llm_final_response"},
                        }
                    ]
                }
            ]
        });
        fs::write(source.join("legacy.json"), dump.to_string()).unwrap();

        let m = Migrator::open(layout(dest.clone())).unwrap();
        let run = m.run(&source).unwrap();
        assert_eq!(run.phase, MigratePhase::Activated);
        assert_eq!(run.imported, 1);

        let store = ProductStore::open(layout(dest.clone())).unwrap();
        let ws = &store.list_workspaces().unwrap()[0];
        let threads = store.list_threads(&ws.id).unwrap();
        assert_eq!(threads.len(), 1);
        let events = store.replay(&threads[0].id, 0).unwrap();
        let message_events: Vec<_> = events.iter().filter(|e| e.kind == "message").collect();
        assert_eq!(message_events.len(), 2);
        assert_eq!(message_events[0].payload["role"], serde_json::json!("user"));
        assert_eq!(
            message_events[0].payload["content"],
            serde_json::json!("What is 2+2?")
        );
        assert_eq!(
            message_events[1].payload["content"],
            serde_json::json!("It is 4.")
        );
        assert_eq!(
            message_events[1].payload["metadata"]["call_id"],
            serde_json::json!("c1")
        );
        // Idempotent: a second run maps to the same workspace, no dupes.
        let again = m.run(&source).unwrap();
        let again_ws = &again
            .mapping
            .iter()
            .find(|m| m.legacy_source == "session")
            .unwrap()
            .new_id;
        assert_eq!(again_ws, &ws.id);
        let _ = fs::remove_dir_all(root);
    }
}
