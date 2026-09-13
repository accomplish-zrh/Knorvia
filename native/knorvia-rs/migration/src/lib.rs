//! Legacy Knorvia data migration.
//! Source is never overwritten. Runs are idempotent by persistent legacy-id map.
//!
//! Migration inventory (A05): every top-level category in a legacy dump is
//! inventoried before anything imports — recognized-and-mapped categories
//! (sessions, artifacts, jobs, memory, goals, settings), recognized-but-
//! unmapped categories (automations, bots, rooms) and unrecognized
//! categories are all reported. Anything that cannot be safely imported
//! explicitly withholds full activation: a run stops at `verified` with a
//! readable report instead of pretending `activated`. Entries are parsed
//! individually, so one corrupt record counts against activation rather
//! than being silently dropped by serde defaults.

use knorvia_platform_paths::KnorviaPaths;
use knorvia_store::ProductStore;
use knorvia_store::memory::{MemoryDraft, MemoryScope, MemoryStore};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static MIGRATION_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn sync_parent(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    let _ = path;
    Ok(())
}

fn durable_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_file_name(format!(
        ".migration-{}-{}.tmp",
        std::process::id(),
        MIGRATION_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new().create_new(true).write(true).open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        sync_parent(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

fn durable_remove(path: &Path) -> io::Result<()> {
    fs::remove_file(path)?;
    sync_parent(path)
}

fn durable_rename(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)?;
    sync_parent(from)?;
    if from.parent() != to.parent() {
        sync_parent(to)?;
    }
    Ok(())
}

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
    /// Terminal success with a live activation pointer. Withheld when the
    /// inventory contains blocked/unknown/corrupt records — those runs end
    /// at `verified` instead.
    Activated,
    RolledBack,
    Failed,
}

/// One legacy category as counted by the preflight inventory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InventoryEntry {
    pub category: String,
    pub count: u64,
    /// `imported` (mapped to the current product) | `blocked` (recognized
    /// legacy domain, no safe mapping this shift) | `unknown` (not a
    /// category the migrator knows at all).
    pub mapping: String,
}

/// Preflight result: human-readable warnings plus the full inventory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigratePreflight {
    pub warnings: Vec<String>,
    pub inventory: Vec<InventoryEntry>,
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
    /// Categories/entries that explicitly prevent full activation. Empty
    /// means every recognized record was imported and activation proceeded.
    #[serde(default)]
    pub blocked: Vec<String>,
    pub imported: u64,
    pub mapping: Vec<IdMap>,
    #[serde(default)]
    pub inventory: Vec<InventoryEntry>,
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
    sessions: Vec<LegacySession>,
    artifacts: Vec<LegacyArtifact>,
    jobs: Vec<LegacyJob>,
    #[serde(default)]
    settings: Value,
    memory: Vec<Value>,
    goals: Vec<Value>,
    automations: Vec<Value>,
    bots: Vec<Value>,
    rooms: Vec<Value>,
    #[serde(default)]
    unknown: Vec<UnknownCategory>,
    /// Entries of recognized categories that failed to parse: counted and
    /// reported, never silently dropped by serde defaults.
    #[serde(default)]
    corrupt: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnknownCategory {
    name: String,
    count: u64,
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

/// Categories recognized this shift with a safe import mapping.
const MAPPED_CATEGORIES: &[&str] = &[
    "sessions",
    "artifacts",
    "jobs",
    "memory",
    "goals",
    "settings",
];
/// Recognized legacy domains with no safe mapping yet: their records are
/// counted, reported, and explicitly block full activation.
const BLOCKED_CATEGORIES: &[&str] = &["automations", "bots", "rooms"];

impl LegacyDump {
    fn is_empty(&self) -> bool {
        self.sessions.is_empty()
            && self.artifacts.is_empty()
            && self.jobs.is_empty()
            && self.memory.is_empty()
            && self.goals.is_empty()
            && self.automations.is_empty()
            && self.bots.is_empty()
            && self.rooms.is_empty()
            && self.unknown.is_empty()
            && self.corrupt.is_empty()
            && (self.settings.is_null() || self.settings == json!({}))
    }

    fn category_count(&self, name: &str) -> usize {
        match name {
            "sessions" => self.sessions.len(),
            "artifacts" => self.artifacts.len(),
            "jobs" => self.jobs.len(),
            "memory" => self.memory.len(),
            "goals" => self.goals.len(),
            "automations" => self.automations.len(),
            "bots" => self.bots.len(),
            "rooms" => self.rooms.len(),
            _ => 0,
        }
    }

    fn inventory(&self) -> Vec<InventoryEntry> {
        let mut entries: Vec<InventoryEntry> = MAPPED_CATEGORIES
            .iter()
            .filter(|name| **name != "settings")
            .map(|name| InventoryEntry {
                category: (*name).to_string(),
                count: self.category_count(name) as u64,
                mapping: "imported".into(),
            })
            .collect();
        entries.extend(BLOCKED_CATEGORIES.iter().map(|name| InventoryEntry {
            category: (*name).to_string(),
            count: self.category_count(name) as u64,
            mapping: "blocked".into(),
        }));
        entries.push(InventoryEntry {
            category: "settings".into(),
            count: u64::from(!self.settings.is_null() && self.settings != json!({})),
            mapping: "imported".into(),
        });
        for u in &self.unknown {
            entries.push(InventoryEntry {
                category: u.name.clone(),
                count: u.count,
                mapping: "unknown".into(),
            });
        }
        entries.retain(|e| e.count > 0);
        entries
    }
}

/// Parse a legacy dump with per-entry error capture. Unlike a plain serde
/// derive over the whole file, one malformed record cannot silently vanish:
/// it lands in `corrupt` and later withholds activation.
fn parse_legacy_dump(source: &Path) -> Result<LegacyDump, MigrateError> {
    let file = if source.is_file() {
        source.to_path_buf()
    } else {
        source.join("legacy.json")
    };
    if !file.exists() {
        return Ok(LegacyDump::default());
    }
    let raw: Value = serde_json::from_slice(&fs::read(file)?)?;
    let Some(map) = raw.as_object() else {
        return Err(MigrateError::Msg(
            "legacy dump must be a JSON object of categories".into(),
        ));
    };
    let mut dump = LegacyDump::default();
    for (key, value) in map {
        match key.as_str() {
            "sessions" | "artifacts" | "jobs" | "memory" | "goals" | "automations" | "bots"
            | "rooms" => {
                let Some(entries) = value.as_array() else {
                    dump.corrupt
                        .push(format!("{key}: expected an array of records"));
                    continue;
                };
                for (i, entry) in entries.iter().enumerate() {
                    if !entry.is_object() {
                        dump.corrupt.push(format!("{key}[{i}]: not an object"));
                        continue;
                    }
                    match key.as_str() {
                        "sessions" => {
                            match serde_json::from_value::<LegacySession>(entry.clone()) {
                                Ok(s) => dump.sessions.push(s),
                                Err(e) => dump.corrupt.push(format!("{key}[{i}]: {e}")),
                            }
                        }
                        "artifacts" => {
                            match serde_json::from_value::<LegacyArtifact>(entry.clone()) {
                                Ok(a) => dump.artifacts.push(a),
                                Err(e) => dump.corrupt.push(format!("{key}[{i}]: {e}")),
                            }
                        }
                        "jobs" => match serde_json::from_value::<LegacyJob>(entry.clone()) {
                            Ok(j) => dump.jobs.push(j),
                            Err(e) => dump.corrupt.push(format!("{key}[{i}]: {e}")),
                        },
                        "memory" => dump.memory.push(entry.clone()),
                        "goals" => dump.goals.push(entry.clone()),
                        "automations" => dump.automations.push(entry.clone()),
                        "bots" => dump.bots.push(entry.clone()),
                        _ => dump.rooms.push(entry.clone()),
                    }
                }
            }
            "settings" => dump.settings = value.clone(),
            other => dump.unknown.push(UnknownCategory {
                name: other.to_string(),
                count: value.as_array().map_or(1, |a| a.len() as u64),
            }),
        }
    }
    Ok(dump)
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

    /// Complete an already-approved rollback before any runtime writer opens
    /// the state tree.  The Home owner calls this while holding the stable
    /// lock in `run/`, which prevents a crash between the two directory
    /// renames from exposing an empty/bootstrap state to a new daemon.
    pub fn recover_pending_rollback(paths: &KnorviaPaths) -> Result<Option<String>, MigrateError> {
        let pointer = paths.backups.join("active-migration.json");
        let intent = paths.backups.join("rollback-intent.json");
        if !pointer.exists() {
            if intent.exists() {
                return Err(MigrateError::Msg(
                    "rollback intent exists without its active migration pointer; refusing startup"
                        .into(),
                ));
            }
            return Ok(None);
        }
        let pointer_run: MigrateRun =
            serde_json::from_slice(&fs::read(&pointer)?).map_err(|e| {
                MigrateError::Msg(format!(
                    "active migration pointer is unreadable during rollback recovery: {e}"
                ))
            })?;
        let run_id = pointer_run.id.clone();
        let completion = paths.backups.join(format!("swap-complete-{run_id}"));
        if !intent.exists() && !completion.exists() {
            return Ok(None);
        }
        let mut run: MigrateRun = serde_json::from_slice(&fs::read(
            paths
                .backups
                .join("migrate-runs")
                .join(format!("{run_id}.json")),
        )?)?;
        if run.id != run_id || run.dest_snapshot != pointer_run.dest_snapshot {
            return Err(MigrateError::Msg(
                "rollback recovery records disagree about snapshot identity; refusing startup"
                    .into(),
            ));
        }
        let dest_snapshot = run.dest_snapshot.clone().ok_or_else(|| {
            MigrateError::Msg("rollback recovery run has no destination snapshot".into())
        })?;
        let manifest =
            load_snapshot_manifest(&dest_snapshot.join("snapshot-manifest.json"), &run_id)?;
        verify_against_manifest(&dest_snapshot.join("state"), &manifest.entries)?;
        if intent.exists() {
            recover_rollback_intent(&paths.state, &dest_snapshot, &paths.backups, &run_id)?;
        }
        verify_against_manifest(&paths.state, &manifest.entries)?;
        run.phase = MigratePhase::RolledBack;
        durable_write(
            &paths
                .backups
                .join("migrate-runs")
                .join(format!("{run_id}.json")),
            &serde_json::to_vec_pretty(&run)?,
        )?;
        durable_remove(&pointer)?;
        Ok(Some(run_id))
    }

    pub fn discover(&self, source: &Path) -> Result<Vec<PathBuf>, MigrateError> {
        let mut found = Vec::new();
        if source.is_dir() {
            for name in [
                "sessions",
                "data",
                "user",
                "settings",
                "jobs",
                "artifacts",
                "memory",
                "goals",
                "automations",
                "bots",
                "rooms",
            ] {
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

    /// Full inventory/preflight: counts every category present in the dump —
    /// mapped, blocked, and unknown — plus corrupt-entry and emptiness
    /// warnings. No state is mutated.
    pub fn preflight(&self, source: &Path) -> Result<MigratePreflight, MigrateError> {
        let mut warnings = Vec::new();
        if !source.exists() {
            return Err(MigrateError::Msg("source missing".into()));
        }
        let dump = parse_legacy_dump(source)?;
        let inventory = dump.inventory();
        if dump.is_empty() {
            warnings.push("no sessions, artifacts, or jobs in dump".into());
        }
        for c in &dump.corrupt {
            warnings.push(format!("corrupt entry (blocks activation): {c}"));
        }
        for u in &dump.unknown {
            warnings.push(format!(
                "unknown category '{}': {} record(s) cannot be mapped",
                u.name, u.count
            ));
        }
        for name in BLOCKED_CATEGORIES {
            let count = dump.category_count(name);
            if count > 0 {
                warnings.push(format!(
                    "{name}: {count} record(s) recognized but not mapped yet; \
                     they block full activation"
                ));
            }
        }
        Ok(MigratePreflight {
            warnings,
            inventory,
        })
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
            blocked: Vec::new(),
            imported: 0,
            mapping: Vec::new(),
            inventory: Vec::new(),
        };
        self.save(&run)?;

        match self.preflight(source) {
            Ok(p) => {
                run.inventory = p.inventory;
                run.warnings.extend(p.warnings);
            }
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
        snapshot_dest(&self.dest, &dest_snap, &id)?;
        run.dest_snapshot = Some(dest_snap);
        self.save(&run)?;

        let dump = parse_legacy_dump(source)?;
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

        // Memory imports into the live scoped-memory store; the legacy id
        // becomes the client token so retries map to the same record.
        let memory_store = MemoryStore::open(&self.dest.paths().state);
        let mut memory_imported = 0usize;
        for (i, mem) in dump.memory.iter().enumerate() {
            let key = format!("memory:legacy-{i}");
            let token = format!("legacy-memory-{i}");
            if let Some(existing) = map.get(&key) {
                if memory_store.read_record(existing).ok().flatten().is_some() {
                    run.mapping.push(IdMap {
                        legacy_source: "memory".into(),
                        legacy_id: token.clone(),
                        new_id: existing.clone(),
                    });
                    run.imported += 1;
                    memory_imported += 1;
                    continue;
                }
            }
            match import_memory(&memory_store, mem, &token) {
                Ok(record_id) => {
                    map.insert(key.clone(), record_id.clone());
                    run.mapping.push(IdMap {
                        legacy_source: "memory".into(),
                        legacy_id: token,
                        new_id: record_id,
                    });
                    run.imported += 1;
                    memory_imported += 1;
                }
                Err(e) => run.blocked.push(format!("memory[{i}]: {e}")),
            }
        }

        // Goals import per imported workspace (session-linked when known).
        let mut goals_imported = 0usize;
        for (i, goal) in dump.goals.iter().enumerate() {
            let key = format!("goal:legacy-{i}");
            if let Some(existing) = map.get(&key) {
                if self.dest.read_goal(existing).is_ok() {
                    run.mapping.push(IdMap {
                        legacy_source: "goal".into(),
                        legacy_id: format!("legacy-goal-{i}"),
                        new_id: existing.clone(),
                    });
                    run.imported += 1;
                    goals_imported += 1;
                    continue;
                }
            }
            let title = goal["title"]
                .as_str()
                .or_else(|| goal["name"].as_str())
                .map(str::trim)
                .filter(|t| !t.is_empty());
            let Some(title) = title else {
                run.blocked
                    .push(format!("goals[{i}]: no usable title/name field"));
                continue;
            };
            match self
                .dest
                .create_goal(&default_ws, &title)
                .map_err(|e| MigrateError::Msg(e.to_string()))
            {
                Ok(g) => {
                    map.insert(key.clone(), g.id.clone());
                    run.mapping.push(IdMap {
                        legacy_source: "goal".into(),
                        legacy_id: format!("legacy-goal-{i}"),
                        new_id: g.id,
                    });
                    run.imported += 1;
                    goals_imported += 1;
                }
                Err(e) => run.blocked.push(format!("goals[{i}]: {e}")),
            }
        }

        // Recognized legacy domains without a safe mapping block activation
        // explicitly — their records are counted, never silently dropped.
        for name in BLOCKED_CATEGORIES {
            let count = dump.category_count(name);
            if count > 0 {
                run.blocked.push(format!(
                    "{name}: {count} record(s) recognized but no safe mapping exists; \
                     NOT imported"
                ));
            }
        }
        for u in &dump.unknown {
            run.blocked.push(format!(
                "unknown category '{}': {} record(s) not recognized; NOT imported",
                u.name, u.count
            ));
        }
        for c in &dump.corrupt {
            run.blocked.push(format!("corrupt entry: {c}"));
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
            + memory_imported
            + goals_imported
            + usize::from(settings_present);
        if run.imported as usize != expected {
            run.warnings.push(format!(
                "count mismatch imported={} expected={}",
                run.imported, expected
            ));
            run.phase = MigratePhase::Failed;
            self.save(&run)?;
            self.write_report(&run)?;
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
                "goal" => {
                    self.dest
                        .read_goal(&m.new_id)
                        .map_err(|e| MigrateError::Msg(e.to_string()))?;
                }
                "memory" => {
                    let store = MemoryStore::open(&self.dest.paths().state);
                    if store
                        .read_record(&m.new_id)
                        .map_err(|e| MigrateError::Msg(e.to_string()))?
                        .is_none()
                    {
                        return Err(MigrateError::Msg(format!(
                            "imported memory {} not readable",
                            m.new_id
                        )));
                    }
                }
                _ => {}
            }
        }
        run.phase = MigratePhase::Verified;
        self.save(&run)?;

        // Full activation only when nothing was blocked. Blocked runs stay
        // `verified` with a readable report; they never fake success.
        if run.blocked.is_empty() {
            // Record the activation baseline: the product facts the user
            // had at activation. A later rollback refuses when the state
            // contains documents beyond this baseline.
            let baseline = state_manifest(&self.dest.paths().state, true)?;
            save_manifest(
                &self
                    .backup_dir
                    .join(format!("activation-baseline-{id}.json")),
                &baseline,
            )?;
            let pointer = self.backup_dir.join("active-migration.json");
            durable_write(&pointer, &serde_json::to_vec_pretty(&run)?)?;
            run.phase = MigratePhase::Activated;
            self.save(&run)?;
        } else {
            run.warnings.push(format!(
                "full activation withheld: {} blocked bucket(s); see the run report",
                run.blocked.len()
            ));
            self.save(&run)?;
        }
        self.write_report(&run)?;
        Ok(run)
    }

    pub fn rollback(&self, run_id: &str) -> Result<MigrateRun, MigrateError> {
        let mut run = self.load(run_id)?;
        let pointer = self.backup_dir.join("active-migration.json");
        // Pointer ownership first: the pointer names exactly one run, and
        // this rollback may only act on its own.
        let pointer_mine = if pointer.exists() {
            let owned = fs::read_to_string(&pointer)
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                .and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_owned));
            match owned {
                Some(id) if id == run_id => true,
                Some(other) => {
                    return Err(MigrateError::Msg(format!(
                        "the active migration pointer belongs to run {other}, not {run_id}; refusing to act on another run's rollback"
                    )));
                }
                None => {
                    return Err(MigrateError::Msg(
                        "the active migration pointer is unreadable; refusing to guess".into(),
                    ));
                }
            }
        } else {
            false
        };
        if run.phase == MigratePhase::RolledBack {
            // Idempotent completion: a crash between saving the RolledBack
            // phase and withdrawing the pointer leaves a stale pointer. A
            // retry withdraws our own pointer and never touches the
            // restored state a second time.
            if pointer_mine {
                durable_remove(&pointer)?;
            }
            return Ok(run);
        }
        if !pointer_mine {
            return Err(MigrateError::Msg(
                "no active migration pointer for this run; there is nothing to roll back (fail closed instead of guessing)".into(),
            ));
        }
        // Preflight 1: the dest snapshot must verify before the live state
        // is touched at all.
        let dest_snap = run.dest_snapshot.clone().ok_or_else(|| {
            MigrateError::Msg("run has no dest snapshot; refusing to guess a restore source".into())
        })?;
        let manifest = load_snapshot_manifest(&dest_snap.join("snapshot-manifest.json"), run_id)?;
        verify_against_manifest(&dest_snap.join("state"), &manifest.entries)?;
        // Swap-complete bookkeeping: a crash after the swap (intent
        // cleaned, marker present) only left the phase save and pointer
        // withdrawal unfinished. Finish them without re-entering the drift
        // gate — the restored state legitimately differs from the
        // activation baseline because the rollback already happened.
        if backups_marker_exists(&self.backup_dir, run_id) {
            let completion = self.backup_dir.join(format!("swap-complete-{run_id}"));
            verify_completion_marker(&completion, run_id)?;
            // The marker claims the swap completed; verify the live state
            // is exactly the snapshot before finishing bookkeeping.
            let dest_snap = run
                .dest_snapshot
                .clone()
                .ok_or_else(|| MigrateError::Msg("run has no dest snapshot".into()))?;
            let snapshot_manifest =
                load_snapshot_manifest(&dest_snap.join("snapshot-manifest.json"), run_id)?;
            verify_against_manifest(&state_dir_of(&self.dest), &snapshot_manifest.entries)?;
            if self.backup_dir.join("rollback-intent.json").exists() {
                recover_rollback_intent(
                    &self.dest.paths().state,
                    &dest_snap,
                    &self.backup_dir,
                    run_id,
                )?;
            }
            run.phase = MigratePhase::RolledBack;
            self.save(&run)?;
            durable_remove(&pointer)?;
            return Ok(run);
        }
        // Intent recovery comes BEFORE the drift gate: the gate approved
        // this run before the intent was written, and after a mid-swap
        // crash the live state is prev/staged fragments, so comparing it
        // against the baseline would misread the swap as user deletions.
        if recover_rollback_intent(
            &self.dest.paths().state,
            &dest_snap,
            &self.backup_dir,
            run_id,
        )? {
            self.dest.invalidate_recovered_cache();
            run.phase = MigratePhase::RolledBack;
            self.save(&run)?;
            durable_remove(&pointer)?;
            return Ok(run);
        }
        // Preflight 2: refuse when user facts newer than the activation
        // exist — added, modified or deleted documents. A rollback must
        // never overwrite the user's newer work.
        let new_facts = post_activation_facts(&self.dest, &self.backup_dir, run_id)?;
        if !new_facts.is_empty() {
            return Err(MigrateError::Msg(format!(
                "post-activation user facts present ({} drifted state document(s), e.g. {}); rollback refused — resolve or migrate them first",
                new_facts.len(),
                new_facts[0]
            )));
        }
        // Staged swap: stage → intent → recoverable switch → pointer last.
        restore_dest(&self.dest, &dest_snap, &self.backup_dir, run_id)?;
        run.phase = MigratePhase::RolledBack;
        self.save(&run)?;
        // The pointer is withdrawn only after the restore is complete and
        // verified: a crash at any earlier point leaves the activation
        // decision recoverable.
        durable_remove(&pointer)?;
        if !run.source.exists() {
            run.warnings.push(
                "source disappeared; rollback cannot restore it because we never overwrite sources, and snapshot is the recovery artifact".into(),
            );
            self.save(&run)?;
        }
        Ok(run)
    }

    pub fn read_run(&self, run_id: &str) -> Result<MigrateRun, MigrateError> {
        self.load(run_id)
    }

    /// Human-readable migration report beside the machine-readable run
    /// record: inventory, mapping, blocked buckets, warnings.
    fn write_report(&self, run: &MigrateRun) -> Result<(), MigrateError> {
        let mut md = String::new();
        md.push_str(&format!("# Migration report {}\n\n", run.id));
        md.push_str(&format!("- phase: {:?}\n", run.phase));
        md.push_str(&format!("- source: {}\n", run.source.display()));
        md.push_str(&format!("- imported: {}\n", run.imported));
        md.push_str("\n## Inventory\n\n");
        md.push_str("| category | count | mapping |\n|---|---|---|\n");
        for e in &run.inventory {
            md.push_str(&format!(
                "| {} | {} | {} |\n",
                e.category, e.count, e.mapping
            ));
        }
        md.push_str("\n## Blocked (activation withheld)\n\n");
        if run.blocked.is_empty() {
            md.push_str("none — full activation granted\n");
        } else {
            for b in &run.blocked {
                md.push_str(&format!("- {b}\n"));
            }
        }
        md.push_str("\n## Warnings\n\n");
        if run.warnings.is_empty() {
            md.push_str("none\n");
        } else {
            for w in &run.warnings {
                md.push_str(&format!("- {w}\n"));
            }
        }
        md.push_str("\n## Mapping\n\n");
        for m in &run.mapping {
            md.push_str(&format!(
                "- {} `{}` → `{}`\n",
                m.legacy_source, m.legacy_id, m.new_id
            ));
        }
        fs::write(self.runs_dir.join(format!("{}.report.md", run.id)), md)?;
        Ok(())
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
        durable_write(
            &self.runs_dir.join(format!("{}.json", run.id)),
            &serde_json::to_vec_pretty(run)?,
        )?;
        Ok(())
    }

    fn load(&self, id: &str) -> Result<MigrateRun, MigrateError> {
        Ok(serde_json::from_slice(&fs::read(
            self.runs_dir.join(format!("{id}.json")),
        )?)?)
    }
}

/// Import one legacy memory record. The scope is deliberately pinned to the
/// migration owner so imported facts can never surface inside another
/// conversation's recall until the user explicitly shares them.
fn import_memory(store: &MemoryStore, entry: &Value, client_token: &str) -> Result<String, String> {
    let content = entry["content"]
        .as_str()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .ok_or_else(|| "no usable content field".to_string())?;
    let kind = entry["kind"]
        .as_str()
        .unwrap_or("fact")
        .trim()
        .to_ascii_lowercase();
    let draft = MemoryDraft {
        scope: MemoryScope {
            owner: "legacy-import".into(),
            workspace: "*".into(),
            bot: "*".into(),
            conversation: "*".into(),
        },
        kind,
        content: content.to_string(),
        source_refs: Vec::new(),
        relation: None,
        valid_from_ms: None,
        valid_to_ms: None,
        pinned: false,
        client_token: Some(client_token.to_string()),
    };
    store
        .create(draft, "migration")
        .map(|(record, _created)| record.id)
        .map_err(|e| e.to_string())
}

/// One verified entry of a state-tree manifest: relative path, length and
/// SHA-256. Lock files and temporary staging files are never recorded.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ManifestEntry {
    path: String,
    len: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifest {
    version: u32,
    run_id: String,
    kind: String,
    entries_sha256: String,
    entries: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RollbackIntent {
    version: u32,
    run: String,
    state: PathBuf,
    prev: PathBuf,
    staged: PathBuf,
    live_state_sha256: String,
    snapshot_entries_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SwapCompletion {
    run: String,
}

const MANIFEST_SKIP: [&str; 2] = ["daemon.lock", "tmp"];

fn manifest_skip(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if MANIFEST_SKIP.contains(&name) {
        return true;
    }
    name.ends_with(".tmp") || name.ends_with(".lock")
}

fn sha256_file(path: &Path) -> Result<String, MigrateError> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

fn metadata_is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other directory reparse points are not guaranteed
        // to report as ordinary symlinks. Never traverse any reparse point
        // while collecting or restoring migration evidence.
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

fn reject_link(path: &Path, role: &str) -> Result<fs::Metadata, MigrateError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata_is_link(&metadata) {
        return Err(MigrateError::Msg(format!(
            "{role} {} is a symlink, junction, or reparse point; refusing to follow it",
            path.display()
        )));
    }
    Ok(metadata)
}

fn reject_link_if_present(path: &Path, role: &str) -> Result<(), MigrateError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata_is_link(&metadata) {
                return Err(MigrateError::Msg(format!(
                    "{role} {} is a symlink, junction, or reparse point; refusing to follow it",
                    path.display()
                )));
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Walk one state tree and record every durable file. Only the `product`
/// subtree is recorded when `facts_only` is set: product documents are the
/// user-visible facts, while WAL/journal/recovery files change on every
/// open and would make any comparison meaningless.
fn state_manifest(state: &Path, facts_only: bool) -> Result<Vec<ManifestEntry>, MigrateError> {
    let mut entries = Vec::new();
    let root_metadata = match fs::symlink_metadata(state) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // A crash mid-swap may leave the live state moved already; there
            // are then no facts to protect and the swap resumes from evidence.
            return Ok(entries);
        }
        Err(error) => return Err(error.into()),
    };
    if metadata_is_link(&root_metadata) {
        return Err(MigrateError::Msg(format!(
            "state root {} is a symlink, junction, or reparse point; refusing to follow it",
            state.display()
        )));
    }
    if !root_metadata.is_dir() {
        return Err(MigrateError::Msg(format!(
            "state root {} is not a directory",
            state.display()
        )));
    }
    let mut stack = vec![state.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let rel = path
                .strip_prefix(state)
                .map_err(|e| MigrateError::Msg(e.to_string()))?
                .to_string_lossy()
                .replace('\\', "/");
            let metadata = reject_link(&path, "state entry")?;
            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            if !metadata.is_file() {
                return Err(MigrateError::Msg(format!(
                    "state entry {} is not a regular file; refusing to snapshot it",
                    path.display()
                )));
            }
            if manifest_skip(&rel) {
                continue;
            }
            if facts_only && !rel.starts_with("product/") {
                continue;
            }
            entries.push(ManifestEntry {
                len: metadata.len(),
                sha256: sha256_file(&path)?,
                path: rel,
            });
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

fn save_manifest(path: &Path, entries: &[ManifestEntry]) -> Result<(), MigrateError> {
    durable_write(path, &serde_json::to_vec_pretty(entries)?)?;
    Ok(())
}

fn load_manifest(path: &Path) -> Result<Vec<ManifestEntry>, MigrateError> {
    let bytes = fs::read(path).map_err(|e| {
        MigrateError::Msg(format!(
            "snapshot manifest {} is missing or unreadable ({}); refusing to restore from an unverifiable snapshot",
            path.display(),
            e
        ))
    })?;
    serde_json::from_slice(&bytes)
        .map_err(|e| MigrateError::Msg(format!("snapshot manifest is corrupt: {e}")))
}

fn entries_sha256(entries: &[ManifestEntry]) -> Result<String, MigrateError> {
    use sha2::{Digest, Sha256};
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(entries)?)))
}

fn tree_sha256(state: &Path) -> Result<String, MigrateError> {
    entries_sha256(&state_manifest(state, false)?)
}

fn save_snapshot_manifest(
    path: &Path,
    run_id: &str,
    entries: Vec<ManifestEntry>,
) -> Result<(), MigrateError> {
    let manifest = SnapshotManifest {
        version: 1,
        run_id: run_id.to_string(),
        kind: "pre-migration-state".into(),
        entries_sha256: entries_sha256(&entries)?,
        entries,
    };
    durable_write(path, &serde_json::to_vec_pretty(&manifest)?)?;
    Ok(())
}

fn load_snapshot_manifest(
    path: &Path,
    expected_run_id: &str,
) -> Result<SnapshotManifest, MigrateError> {
    if let Some(snapshot_dir) = path.parent() {
        reject_link(snapshot_dir, "snapshot root")?;
    }
    reject_link_if_present(path, "snapshot manifest")?;
    let bytes = fs::read(path).map_err(|error| {
        MigrateError::Msg(format!(
            "snapshot manifest {} is missing or unreadable ({error}); refusing to restore from an unverifiable snapshot",
            path.display()
        ))
    })?;
    let manifest: SnapshotManifest = serde_json::from_slice(&bytes)
        .map_err(|error| MigrateError::Msg(format!("snapshot manifest is corrupt: {error}")))?;
    if manifest.version != 1
        || manifest.run_id != expected_run_id
        || manifest.kind != "pre-migration-state"
        || entries_sha256(&manifest.entries)? != manifest.entries_sha256
    {
        return Err(MigrateError::Msg(format!(
            "snapshot identity/checksum does not belong to migration run {expected_run_id}"
        )));
    }
    let mut previous: Option<&str> = None;
    for entry in &manifest.entries {
        let parts: Vec<_> = entry.path.split('/').collect();
        let safe = !entry.path.is_empty()
            && !entry.path.contains('\\')
            && !entry.path.contains(':')
            && parts
                .iter()
                .all(|part| !part.is_empty() && *part != "." && *part != "..");
        if !safe
            || entry.sha256.len() != 64
            || !entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || previous.is_some_and(|value| value >= entry.path.as_str())
        {
            return Err(MigrateError::Msg(
                "snapshot manifest contains an unsafe, duplicate, or malformed entry".into(),
            ));
        }
        previous = Some(&entry.path);
    }
    Ok(manifest)
}

/// Verify a restored/copied state tree against the snapshot manifest.
fn verify_against_manifest(state: &Path, expected: &[ManifestEntry]) -> Result<(), MigrateError> {
    if !state.is_dir() {
        return Err(MigrateError::Msg(format!(
            "snapshot verification failed: state root {} is missing",
            state.display()
        )));
    }
    let actual = state_manifest(state, false)?;
    if actual != expected {
        let first_expected = expected
            .iter()
            .zip(actual.iter())
            .find(|(left, right)| left != right)
            .map(|(left, _)| left.path.as_str())
            .or_else(|| expected.get(actual.len()).map(|entry| entry.path.as_str()))
            .or_else(|| actual.get(expected.len()).map(|entry| entry.path.as_str()))
            .unwrap_or("state tree");
        return Err(MigrateError::Msg(format!(
            "snapshot verification failed: exact state tree differs at {first_expected}"
        )));
    }
    Ok(())
}

fn snapshot_dest(store: &ProductStore, dest_snap: &Path, run_id: &str) -> Result<(), MigrateError> {
    reject_link_if_present(dest_snap, "snapshot root")?;
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
    // Record what the snapshot contains so a later rollback can verify it
    // BEFORE the live state is touched.
    let entries = state_manifest(&dest_snap.join("state"), false)?;
    save_snapshot_manifest(&dest_snap.join("snapshot-manifest.json"), run_id, entries)?;
    Ok(())
}

/// A rollback restores through an independently staged copy and a
/// recoverable swap; the pre-rollback state is preserved as evidence and
/// every stage is idempotent.
/// Recover a mid-swap crash from the persisted rollback intent. Returns
/// true when an intent for this run existed and the swap is now complete.
/// The original pre-rollback evidence in `prev` is never deleted here.
fn state_dir_of(store: &ProductStore) -> std::path::PathBuf {
    store.paths().state.clone()
}

fn backups_marker_exists(backup_dir: &Path, name: &str) -> bool {
    backup_dir.join(format!("swap-complete-{name}")).exists()
}

fn verify_completion_marker(path: &Path, run_id: &str) -> Result<(), MigrateError> {
    reject_link(path, "swap completion marker")?;
    let marker: SwapCompletion = serde_json::from_slice(&fs::read(path)?).map_err(|error| {
        MigrateError::Msg(format!("swap completion marker is corrupt: {error}"))
    })?;
    if marker.run != run_id {
        return Err(MigrateError::Msg(format!(
            "swap completion marker belongs to run {}, not {run_id}",
            marker.run
        )));
    }
    Ok(())
}

fn recover_rollback_intent(
    state: &Path,
    dest_snap: &Path,
    backup_dir: &Path,
    run_id: &str,
) -> Result<bool, MigrateError> {
    let completion = backup_dir.join(format!("swap-complete-{run_id}"));
    let intent = backup_dir.join("rollback-intent.json");
    // A crash can land after the completion credential is durable but
    // before the intent is withdrawn. The pair must be reconciled, rather
    // than treating the marker as permission to forget an unverified
    // intent that would block the following startup.
    if completion.exists() {
        verify_completion_marker(&completion, run_id)?;
        if !intent.exists() {
            return Ok(true);
        }
        reject_link(&intent, "rollback intent")?;
        let saved: RollbackIntent = serde_json::from_slice(&fs::read(&intent)?)
            .map_err(|e| MigrateError::Msg(format!("rollback intent is corrupt: {e}")))?;
        let state = state.to_path_buf();
        let staged = backup_dir.join(format!("rollback-staged-{run_id}"));
        let prev = backup_dir.join(format!("rollback-prev-{run_id}"));
        let manifest = load_snapshot_manifest(&dest_snap.join("snapshot-manifest.json"), run_id)?;
        if saved.version != 1
            || saved.run != run_id
            || saved.state != state
            || saved.prev != prev
            || saved.staged != staged
            || saved.snapshot_entries_sha256 != manifest.entries_sha256
        {
            return Err(MigrateError::Msg(
                "rollback intent identity does not match this Home and snapshot; refusing recovery"
                    .into(),
            ));
        }
        verify_against_manifest(&dest_snap.join("state"), &manifest.entries)?;
        verify_against_manifest(&state, &manifest.entries)?;
        if !prev.exists() || tree_sha256(&prev)? != saved.live_state_sha256 {
            return Err(MigrateError::Msg(
                "pre-rollback evidence does not match the completed rollback intent; refusing recovery"
                    .into(),
            ));
        }
        if staged.exists() {
            return Err(MigrateError::Msg(
                "completed rollback still has a staged directory; refusing ambiguous recovery"
                    .into(),
            ));
        }
        durable_remove(&intent)?;
        return Ok(true);
    }
    if !intent.exists() {
        return Ok(false);
    }
    reject_link(&intent, "rollback intent")?;
    let saved: RollbackIntent = serde_json::from_slice(&fs::read(&intent)?)
        .map_err(|e| MigrateError::Msg(format!("rollback intent is corrupt: {e}")))?;
    if saved.version != 1 || saved.run != run_id {
        return Err(MigrateError::Msg(
            "a rollback intent for another run is present; refusing to mix recoveries".into(),
        ));
    }
    let state = state.to_path_buf();
    let staged = backup_dir.join(format!("rollback-staged-{run_id}"));
    let prev = backup_dir.join(format!("rollback-prev-{run_id}"));
    let manifest = load_snapshot_manifest(&dest_snap.join("snapshot-manifest.json"), run_id)?;
    let snapshot_state = dest_snap.join("state");
    if saved.state != state
        || saved.prev != prev
        || saved.staged != staged
        || saved.snapshot_entries_sha256 != manifest.entries_sha256
    {
        return Err(MigrateError::Msg(
            "rollback intent identity does not match this Home and snapshot; refusing recovery"
                .into(),
        ));
    }
    if prev.exists() {
        if tree_sha256(&prev)? != saved.live_state_sha256 {
            return Err(MigrateError::Msg(
                "pre-rollback evidence changed after the swap intent; refusing recovery".into(),
            ));
        }
    } else if state.exists() && tree_sha256(&state)? != saved.live_state_sha256 {
        return Err(MigrateError::Msg(
            "live state changed after the rollback intent; refusing recovery".into(),
        ));
    }

    // The intent means the swap was approved. The live state tells which
    // stage the crash happened in:
    // - state == snapshot exactly → the swap completed; only bookkeeping
    //   (marker, phase save, pointer withdrawal) was lost.
    // - otherwise → the swap did not complete: finish it from the staged
    //   copy (re-staged deterministically if lost).
    let live_is_snapshot = state.exists() && {
        let live = state_manifest(&state, false)?;
        let snapshot_entries: std::collections::HashSet<&str> =
            manifest.entries.iter().map(|e| e.path.as_str()).collect();
        let live_set: std::collections::HashSet<&str> =
            live.iter().map(|e| e.path.as_str()).collect();
        live_set == snapshot_entries
            && live.iter().all(|entry| {
                manifest
                    .entries
                    .iter()
                    .find(|m| m.path == entry.path)
                    .map(|m| m.len == entry.len && m.sha256 == entry.sha256)
                    .unwrap_or(false)
            })
    };
    if !live_is_snapshot {
        let staged_state = staged.join("state");
        let staged_verified = staged_state.exists()
            && verify_against_manifest(&staged_state, &manifest.entries).is_ok();
        if !staged_verified {
            if staged.exists() {
                fs::remove_dir_all(&staged)?;
            }
            fs::create_dir_all(&staged)?;
            copy_tree(&snapshot_state, &staged.join("state"))?;
            verify_against_manifest(&staged.join("state"), &manifest.entries)?;
        }
        if state.exists() {
            if prev.exists() {
                // The persisted intent proves the crash happened while the
                // live state was absent (between the swap renames). Any
                // state present now was therefore created after the intent
                // by a process opening the store. With no durable facts it
                // is only that open's bootstrap shell: quarantine it under
                // the backup dir — never onto the real prev evidence — and
                // finish the swap. Facts mean the store was really used
                // after the crash: still refuse and keep every original.
                if state_manifest(&state, true)?.is_empty() {
                    let shell = backup_dir.join(format!("rollback-open-shell-{run_id}"));
                    if shell.exists() {
                        if !state_manifest(&shell, true)?.is_empty() {
                            return Err(MigrateError::Msg(
                                "an earlier rollback quarantine holds real state; refusing to replace it".into(),
                            ));
                        }
                        fs::remove_dir_all(&shell)?;
                    }
                    durable_rename(&state, &shell)?;
                } else {
                    return Err(MigrateError::Msg(
                        "rollback recovery is ambiguous: the live state, prior evidence and a staged copy all exist; refusing to overwrite unknown evidence".into(),
                    ));
                }
            } else {
                durable_rename(&state, &prev)?;
            }
        }
        durable_rename(&staged.join("state"), &state)?;
        // The restored live state must now be exactly the snapshot.
        verify_against_manifest(&state, &manifest.entries)?;
    }
    if staged.exists() {
        fs::remove_dir_all(&staged)?;
    }
    // The completion credential is written BEFORE the intent is withdrawn,
    // so no crash point can leave the rollback without either credential.
    durable_write(
        &completion,
        &serde_json::to_vec_pretty(&serde_json::json!({"run": run_id}))?,
    )?;
    durable_remove(&intent)?;
    Ok(true)
}

/// Fresh staged swap: stage, persist the intent, then switch. Callers must
/// have run the drift gate first.
fn restore_dest(
    store: &ProductStore,
    dest_snap: &Path,
    backup_dir: &Path,
    run_id: &str,
) -> Result<(), MigrateError> {
    let state = store.paths().state.clone();
    let snapshot_state = dest_snap.join("state");
    let manifest = load_snapshot_manifest(&dest_snap.join("snapshot-manifest.json"), run_id)?;

    // Preflight: the snapshot must fully verify BEFORE the live state is
    // touched. Disk exhaustion or a truncated snapshot aborts here and the
    // current state keeps standing.
    verify_against_manifest(&snapshot_state, &manifest.entries)?;

    // Staging: copy the snapshot into an independent target and verify the
    // copy. The live state is still untouched.
    let staged = backup_dir.join(format!("rollback-staged-{run_id}"));
    let prev = backup_dir.join(format!("rollback-prev-{run_id}"));
    let intent = backup_dir.join("rollback-intent.json");
    let live_state_sha256 = tree_sha256(&state)?;
    if staged.exists() {
        fs::remove_dir_all(&staged)?;
    }
    fs::create_dir_all(&staged)?;
    copy_tree(&snapshot_state, &staged.join("state"))?;
    verify_against_manifest(&staged.join("state"), &manifest.entries)?;
    // The intent is persisted BEFORE the swap so every crash point is
    // recoverable by `recover_rollback_intent`.
    durable_write(
        &intent,
        &serde_json::to_vec_pretty(&RollbackIntent {
            version: 1,
            run: run_id.to_string(),
            state: state.clone(),
            prev: prev.clone(),
            staged: staged.clone(),
            live_state_sha256,
            snapshot_entries_sha256: manifest.entries_sha256.clone(),
        })?,
    )?;
    if state.exists() {
        if prev.exists() {
            // Ambiguous crash site — UNLESS the live state already IS the
            // verified snapshot, which proves the swap completed and only
            // the marker/intent bookkeeping was lost (crash between the
            // final rename and the bookkeeping writes). Then finish the
            // bookkeeping without re-restoring.
            if verify_against_manifest(&state, &manifest.entries).is_ok() {
                durable_write(
                    &backup_dir.join(format!("swap-complete-{run_id}")),
                    &serde_json::to_vec_pretty(&serde_json::json!({"run": run_id}))?,
                )?;
                durable_remove(&intent)?;
                if staged.exists() {
                    fs::remove_dir_all(&staged)?;
                }
                store.invalidate_recovered_cache();
                return Ok(());
            }
            // Not the snapshot: unknown evidence. Fail closed.
            return Err(MigrateError::Msg(
                "previous rollback evidence exists without a persisted intent; refusing to overwrite possible recovery evidence".into(),
            ));
        }
        durable_rename(&state, &prev)?;
    }
    durable_rename(&staged.join("state"), &state)?;
    // Do not publish completion until the directory now reachable as live
    // state is still the exact verified snapshot. A filesystem/filter race
    // cannot turn a successfully staged copy into an accepted partial tree.
    verify_against_manifest(&state, &manifest.entries)?;
    if staged.exists() {
        fs::remove_dir_all(&staged)?;
    }
    // Swap-complete marker is written BEFORE the intent is withdrawn so
    // every crash point between the two is covered by an explicit stage.
    durable_write(
        &backup_dir.join(format!("swap-complete-{run_id}")),
        &serde_json::to_vec_pretty(&serde_json::json!({"run": run_id}))?,
    )?;
    durable_remove(&intent)?;
    // Filesystem state moved underneath this handle; force a full recovery
    // on its next operation instead of trusting stale sequence/fingerprint
    // state.
    store.invalidate_recovered_cache();
    Ok(())
}

/// Post-activation user facts: any product document that is not part of the
/// activation baseline. A rollback refuses to delete user data.
fn post_activation_facts(
    store: &ProductStore,
    backup_dir: &Path,
    run_id: &str,
) -> Result<Vec<String>, MigrateError> {
    let baseline_path = backup_dir.join(format!("activation-baseline-{run_id}.json"));
    if !baseline_path.exists() {
        // Older runs have no baseline: without evidence about what the user
        // had at activation, deletion is not justifiable — fail closed.
        return Err(MigrateError::Msg(
            "no activation baseline recorded for this run; refusing to roll back without evidence of what the user had".into(),
        ));
    }
    let baseline: Vec<ManifestEntry> = load_manifest(&baseline_path)?;
    let baseline_by_path: std::collections::HashMap<&str, &ManifestEntry> =
        baseline.iter().map(|e| (e.path.as_str(), e)).collect();
    let current = state_manifest(&store.paths().state, true)?;
    let mut facts = Vec::new();
    let mut current_paths: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for entry in &current {
        current_paths.insert(entry.path.as_str());
        match baseline_by_path.get(entry.path.as_str()) {
            None => facts.push(format!("added: {}", entry.path)),
            // Same path with different bytes is exactly how an edited
            // Workspace title or Goal content shows up: it is a user fact
            // and a rollback must not silently overwrite it.
            Some(base) if base.len != entry.len || base.sha256 != entry.sha256 => {
                facts.push(format!("modified: {}", entry.path))
            }
            _ => {}
        }
    }
    for base in &baseline {
        if !current_paths.contains(base.path.as_str()) {
            facts.push(format!("deleted: {}", base.path));
        }
    }
    facts.sort();
    Ok(facts)
}

fn copy_tree(src: &Path, dst: &Path) -> io::Result<()> {
    let source_metadata = fs::symlink_metadata(src)?;
    if metadata_is_link(&source_metadata) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "migration source {} is a symlink, junction, or reparse point",
                src.display()
            ),
        ));
    }
    if let Ok(destination_metadata) = fs::symlink_metadata(dst) {
        if metadata_is_link(&destination_metadata) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "migration destination {} is a symlink, junction, or reparse point",
                    dst.display()
                ),
            ));
        }
    }
    if source_metadata.is_file() {
        fs::create_dir_all(dst)?;
        fs::copy(src, dst.join(src.file_name().unwrap()))?;
        return Ok(());
    }
    if !source_metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "migration source {} is not a regular file or directory",
                src.display()
            ),
        ));
    }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata_is_link(&metadata) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "migration source entry {} is a symlink, junction, or reparse point",
                    entry.path().display()
                ),
            ));
        }
        if metadata.is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else if metadata.is_file() {
            fs::copy(entry.path(), to)?;
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "migration source entry {} is not a regular file or directory",
                    entry.path().display()
                ),
            ));
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

    /// Run a clean migration to full activation on an isolated home and
    /// return (migrator, run_id, dest home path, backup dir path).
    #[allow(clippy::type_complexity)]
    fn migrate_to_activation(tag: &str) -> (Migrator, String, PathBuf, PathBuf, String) {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("knorvia-mig-{tag}-{stamp}"));
        let source = root.join("legacy-src");
        let dest = root.join("knorvia-home");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dest).unwrap();
        write_fixture(&source);
        // Pre-migration user data: the dest snapshot must carry it and a
        // rollback must restore it.
        let pre = ProductStore::open(layout(dest.clone())).unwrap();
        let pre_ws = pre.create_workspace("pre-migration-user-data").unwrap();
        drop(pre);
        let m = Migrator::open(layout(dest.clone())).unwrap();
        let run = m.run(&source).unwrap();
        assert_eq!(run.phase, MigratePhase::Activated);
        let backups = layout(dest.clone()).backups;
        (m, run.id, dest, backups, pre_ws.id)
    }

    fn write_rollback_intent_fixture(
        backups: &Path,
        run_id: &str,
        state: &Path,
        prev: &Path,
        staged: &Path,
    ) {
        let snapshot = load_snapshot_manifest(
            &backups
                .join(format!("dest-before-{run_id}"))
                .join("snapshot-manifest.json"),
            run_id,
        )
        .unwrap();
        let evidence = if prev.exists() { prev } else { state };
        let intent = RollbackIntent {
            version: 1,
            run: run_id.to_string(),
            state: state.to_path_buf(),
            prev: prev.to_path_buf(),
            staged: staged.to_path_buf(),
            live_state_sha256: tree_sha256(evidence).unwrap(),
            snapshot_entries_sha256: snapshot.entries_sha256,
        };
        fs::write(
            backups.join("rollback-intent.json"),
            serde_json::to_vec_pretty(&intent).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn rollback_refuses_when_post_activation_content_is_modified_in_place() {
        // The review trigger: editing an EXISTING document keeps its path,
        // so a path-only comparison called it "no new facts" and the
        // rollback overwrote the user's edit. Content must count.
        let (m, run_id, dest, backups, pre_ws_id) = migrate_to_activation("modified-facts");
        let store = ProductStore::open(layout(dest.clone())).unwrap();
        // The migration imported workspaces; edit one EXISTING title in
        // place (same document path, new bytes).
        let imported = store
            .list_workspaces()
            .unwrap()
            .into_iter()
            .find(|w| w.id != pre_ws_id)
            .expect("an imported workspace exists");
        store
            .update_workspace(&imported.id, "user edited this title", None)
            .unwrap();

        let error = m.rollback(&run_id).unwrap_err();
        assert!(
            format!("{error}").contains("modified:"),
            "the in-place edit is reported: {error}"
        );
        // Full state unchanged: the user's edit survives byte for byte.
        let after = ProductStore::open(layout(dest.clone())).unwrap();
        assert_eq!(
            after.read_workspace(&imported.id).unwrap().title,
            "user edited this title",
            "the rollback must not overwrite the user's modification"
        );
        assert!(backups.join("active-migration.json").exists());
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn rollback_refuses_when_a_baseline_document_is_deleted() {
        let (m, run_id, dest, backups, _pre_ws) = migrate_to_activation("deleted-facts");
        // A user (or a bug) removed a product document that existed at
        // activation: restoring would resurrect it against the store's
        // current facts. Deletion is a user fact too.
        let product = layout(dest.clone()).state.join("product");
        let victim = product.join("workspaces");
        let file = fs::read_dir(&victim)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::remove_file(&file).unwrap();

        let error = m.rollback(&run_id).unwrap_err();
        assert!(
            format!("{error}").contains("deleted:"),
            "the deletion is reported: {error}"
        );
        assert!(backups.join("active-migration.json").exists());
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn rollback_with_stale_pointer_after_phase_save_completes_idempotently() {
        // Crash window: the RolledBack phase was saved but the pointer was
        // not yet withdrawn. The retry must withdraw OUR pointer and touch
        // nothing else.
        let (m, run_id, dest, backups, pre_ws_id) = migrate_to_activation("stale-pointer");
        let rolled = m.rollback(&run_id).unwrap();
        assert_eq!(rolled.phase, MigratePhase::RolledBack);
        assert!(!backups.join("active-migration.json").exists());

        // Simulate the crash: the pointer file is still on disk.
        let run_record = serde_json::to_value(m.read_run(&run_id).unwrap()).unwrap();
        fs::write(
            backups.join("active-migration.json"),
            serde_json::to_vec_pretty(&run_record).unwrap(),
        )
        .unwrap();

        let again = m.rollback(&run_id).unwrap();
        assert_eq!(again.phase, MigratePhase::RolledBack);
        assert!(
            !backups.join("active-migration.json").exists(),
            "the stale pointer is withdrawn by the retry"
        );
        // The restored state is untouched by the retry.
        let after = ProductStore::open(layout(dest.clone())).unwrap();
        assert!(after.read_workspace(&pre_ws_id).is_ok());
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn rollback_refuses_a_pointer_that_belongs_to_another_run() {
        let (m, run_id, dest, backups, _pre_ws) = migrate_to_activation("foreign-pointer");
        let mut record = serde_json::to_value(m.read_run(&run_id).unwrap()).unwrap();
        record["id"] = json!("mig_someone_else");
        fs::write(
            backups.join("active-migration.json"),
            serde_json::to_vec_pretty(&record).unwrap(),
        )
        .unwrap();
        let error = m.rollback(&run_id).unwrap_err();
        assert!(
            format!("{error}").contains("belongs to run"),
            "pointer ownership is enforced: {error}"
        );
        assert!(backups.join("active-migration.json").exists());
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn rollback_resumes_by_intent_and_preserves_original_evidence() {
        // Crash right after the live state was moved to prev and before
        // the staged copy replaced it — with the intent persisted, as the
        // implementation now always does before the swap.
        let (m, run_id, dest, backups, pre_ws_id) = migrate_to_activation("intent-crash");
        let state = layout(dest.clone()).state;
        let prev = backups.join(format!("rollback-prev-{run_id}"));
        let staged = backups.join(format!("rollback-staged-{run_id}"));
        fs::rename(&state, &prev).unwrap();
        fs::create_dir_all(&staged).unwrap();
        let snapshot_state = backups.join(format!("dest-before-{run_id}")).join("state");
        copy_tree(&snapshot_state, &staged.join("state")).unwrap();
        write_rollback_intent_fixture(&backups, &run_id, &state, &prev, &staged);

        let rolled = m.rollback(&run_id).unwrap();
        assert_eq!(rolled.phase, MigratePhase::RolledBack);
        // The swap completed from the staged copy.
        assert!(state.exists());
        let after = ProductStore::open(layout(dest.clone())).unwrap();
        assert!(after.read_workspace(&pre_ws_id).is_ok());
        // The ORIGINAL pre-rollback evidence survived untouched: the
        // pre-migration user workspace lives in prev, and only there.
        let evidence_ws = prev
            .join("product")
            .join("workspaces")
            .join(format!("{pre_ws_id}.json"));
        assert!(
            evidence_ws.exists(),
            "the original recovery evidence must survive the retry"
        );
        assert!(!backups.join("rollback-intent.json").exists());
        assert!(!backups.join("active-migration.json").exists());
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn rollback_intent_without_swap_crash_still_restores_cleanly() {
        // Boundary: the intent was written but the crash happened BEFORE
        // the first rename (live state still in place). Recovery must
        // restore from the staged/snapshot copy and withdraw the pointer.
        let (m, run_id, dest, backups, pre_ws) = migrate_to_activation("intent-no-swap");
        let intent = backups.join("rollback-intent.json");
        let state = layout(dest.clone()).state;
        let prev = backups.join(format!("rollback-prev-{run_id}"));
        let staged = backups.join(format!("rollback-staged-{run_id}"));
        write_rollback_intent_fixture(&backups, &run_id, &state, &prev, &staged);

        let rolled = m.rollback(&run_id).unwrap();
        assert_eq!(rolled.phase, MigratePhase::RolledBack);
        let after = ProductStore::open(layout(dest.clone())).unwrap();
        assert!(after.read_workspace(&pre_ws).is_ok());
        assert!(!backups.join("active-migration.json").exists());
        assert!(!intent.exists());
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn rollback_after_intent_cleanup_before_phase_save_completes() {
        // Boundary: the swap finished and the intent was deleted, but the
        // process crashed before saving the RolledBack phase. The pointer
        // still stands; the retry must finish the bookkeeping without a
        // second restore.
        let (m, run_id, dest, backups, pre_ws) = migrate_to_activation("intent-saved");
        // Perform a full rollback, then reconstruct the crash window: the
        // phase is back to Activated (not saved) while the pointer remains.
        let _ = m.rollback(&run_id).unwrap();
        {
            let mut run = m.read_run(&run_id).unwrap();
            run.phase = MigratePhase::Activated;
            m.save(&run).unwrap();
        }
        fs::write(
            backups.join("active-migration.json"),
            serde_json::to_vec_pretty(&serde_json::to_value(m.read_run(&run_id).unwrap()).unwrap())
                .unwrap(),
        )
        .unwrap();

        let rolled = m.rollback(&run_id).unwrap();
        assert_eq!(rolled.phase, MigratePhase::RolledBack);
        assert!(!backups.join("active-migration.json").exists());
        // The restored state was not restored a second time: content intact.
        let after = ProductStore::open(layout(dest.clone())).unwrap();
        assert!(after.read_workspace(&pre_ws).is_ok());
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn rollback_refuses_and_preserves_everything_when_the_snapshot_is_corrupt() {
        let (m, run_id, dest, backups, pre_ws_id) = migrate_to_activation("corrupt-snap");
        // Corrupt one recorded document inside the dest snapshot.
        let victim = backups
            .join(format!("dest-before-{run_id}"))
            .join("state")
            .join("product")
            .join("workspaces")
            .join(format!("{pre_ws_id}.json"));
        assert!(
            victim.exists(),
            "the snapshot carries the pre-migration doc"
        );
        fs::write(&victim, b"corrupted bytes").unwrap();

        let error = m.rollback(&run_id).unwrap_err();
        assert!(
            format!("{error}").contains("verification failed"),
            "the corruption is reported: {error}"
        );
        // The live state and the activation pointer are fully preserved.
        assert!(backups.join("active-migration.json").exists());
        let store = ProductStore::open(layout(dest.clone())).unwrap();
        assert_eq!(
            store.list_workspaces().unwrap().len(),
            3,
            "2 imported + the pre-migration workspace all survive"
        );
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn rollback_refuses_missing_manifest_and_unmanifested_snapshot_content() {
        let (m, run_id, dest, backups, _pre_ws) = migrate_to_activation("missing-manifest");
        let snapshot = backups.join(format!("dest-before-{run_id}"));
        let manifest = snapshot.join("snapshot-manifest.json");
        let manifest_bytes = fs::read(&manifest).unwrap();
        fs::remove_file(&manifest).unwrap();
        let missing = m.rollback(&run_id).unwrap_err();
        assert!(format!("{missing}").contains("manifest"));
        assert!(backups.join("active-migration.json").exists());

        fs::write(&manifest, manifest_bytes).unwrap();
        fs::write(snapshot.join("state/unmanifested-user-data.json"), b"{}").unwrap();
        let extra = m.rollback(&run_id).unwrap_err();
        assert!(format!("{extra}").contains("exact state tree"));
        // Both preflight failures leave the current migrated state and pointer
        // standing; no staged/previous swap evidence was created.
        assert_eq!(
            ProductStore::open(layout(dest.clone()))
                .unwrap()
                .list_workspaces()
                .unwrap()
                .len(),
            3
        );
        assert!(!backups.join(format!("rollback-prev-{run_id}")).exists());
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn rollback_refuses_snapshot_manifest_from_another_run() {
        let (m, run_id, dest, backups, _pre_ws) = migrate_to_activation("wrong-identity");
        let manifest_path = backups
            .join(format!("dest-before-{run_id}"))
            .join("snapshot-manifest.json");
        let mut manifest: SnapshotManifest =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest.run_id = "mig_another_run".into();
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let error = m.rollback(&run_id).unwrap_err();
        assert!(format!("{error}").contains("identity"));
        assert!(backups.join("active-migration.json").exists());
        assert_eq!(
            ProductStore::open(layout(dest.clone()))
                .unwrap()
                .list_workspaces()
                .unwrap()
                .len(),
            3
        );
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn rollback_refuses_when_post_activation_user_facts_exist() {
        let (m, run_id, dest, backups, _pre_ws) = migrate_to_activation("user-facts");
        // The user works with the migrated product AFTER activation.
        let store = ProductStore::open(layout(dest.clone())).unwrap();
        let fresh = store.create_workspace("user-new-work").unwrap();

        let error = m.rollback(&run_id).unwrap_err();
        assert!(
            format!("{error}").contains("user facts"),
            "the newer user data is reported: {error}"
        );
        assert!(backups.join("active-migration.json").exists());
        let reopened = ProductStore::open(layout(dest.clone())).unwrap();
        assert!(
            reopened.read_workspace(&fresh.id).is_ok(),
            "the user's newer workspace survives the refused rollback"
        );
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn rollback_is_idempotent_and_never_deletes_twice() {
        let (m, run_id, dest, _backups, pre_ws_id) = migrate_to_activation("idempotent");
        let first = m.rollback(&run_id).unwrap();
        assert_eq!(first.phase, MigratePhase::RolledBack);
        let after_first = ProductStore::open(layout(dest.clone())).unwrap();
        assert_eq!(
            after_first.list_workspaces().unwrap().len(),
            1,
            "the pre-migration user data is restored"
        );
        assert!(after_first.read_workspace(&pre_ws_id).is_ok());

        // A repeated rollback is a no-op, never a second restore or delete.
        let again = m.rollback(&run_id).unwrap();
        assert_eq!(again.phase, MigratePhase::RolledBack);
        let after_again = ProductStore::open(layout(dest.clone())).unwrap();
        assert_eq!(
            after_again.list_workspaces().unwrap().len(),
            1,
            "the repeated rollback never deletes the restored state"
        );
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn retry_discards_an_interrupted_staging_copy_before_touching_live_state() {
        let (m, run_id, dest, backups, pre_ws_id) = migrate_to_activation("partial-stage");
        let staged = backups.join(format!("rollback-staged-{run_id}"));
        fs::create_dir_all(staged.join("state/product/workspaces")).unwrap();
        fs::write(staged.join("state/partial-copy"), b"truncated").unwrap();

        let rolled = m.rollback(&run_id).unwrap();
        assert_eq!(rolled.phase, MigratePhase::RolledBack);
        let after = ProductStore::open(layout(dest.clone())).unwrap();
        assert!(after.read_workspace(&pre_ws_id).is_ok());
        assert_eq!(after.list_workspaces().unwrap().len(), 1);
        assert!(!staged.exists());
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn rollback_completes_after_a_crash_between_the_swap_renames() {
        let (m, run_id, dest, backups, _pre_ws) = migrate_to_activation("crash-swap");
        // Simulate a crash right after the live state was moved to its
        // evidence location and before the staged copy replaced it. The
        // implementation persists the intent BEFORE the swap, so the crash
        // site carries it.
        let state = layout(dest.clone()).state;
        let prev = backups.join(format!("rollback-prev-{run_id}"));
        let staged = backups.join(format!("rollback-staged-{run_id}"));
        fs::rename(&state, &prev).unwrap();
        fs::create_dir_all(&staged).unwrap();
        let snapshot_state = backups.join(format!("dest-before-{run_id}")).join("state");
        copy_tree(&snapshot_state, &staged.join("state")).unwrap();
        write_rollback_intent_fixture(&backups, &run_id, &state, &prev, &staged);
        assert!(!state.exists());

        // A real crash here means the process is gone. Startup recovery runs
        // under the stable Home lock BEFORE ProductStore opens, so no empty
        // bootstrap state is ever exposed to a daemon or client.
        drop(m);
        let paths = layout(dest.clone());
        assert_eq!(
            Migrator::recover_pending_rollback(&paths).unwrap(),
            Some(run_id.clone())
        );
        assert!(state.exists(), "the swap completed from the staged copy");
        let after = ProductStore::open(paths.clone()).unwrap();
        assert_eq!(
            after.list_workspaces().unwrap().len(),
            1,
            "the restored snapshot content is live"
        );
        assert!(
            !backups.join("active-migration.json").exists(),
            "the pointer is withdrawn only after the swap"
        );
        assert_eq!(
            Migrator::open(paths)
                .unwrap()
                .read_run(&run_id)
                .unwrap()
                .phase,
            MigratePhase::RolledBack
        );
        let _ = fs::remove_dir_all(dest.parent().unwrap());
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
        assert!(run.blocked.is_empty(), "a clean dump activates fully");
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

        // Rolling back the FIRST run after the second activation is
        // refused: the pointer names the latest run.
        let stale_error = m.rollback(&run.id).unwrap_err();
        assert!(format!("{stale_error}").contains("belongs to run"));

        let rolled = m.rollback(&again.id).unwrap();
        assert_eq!(rolled.phase, MigratePhase::RolledBack);
        assert_eq!(
            fs::read_to_string(source.join("legacy.json")).unwrap(),
            src_before
        );
        let after = ProductStore::open(layout(dest.clone())).unwrap();
        // Rolling back the latest run restores ITS pre-import state: the
        // first run's imported workspaces (the re-import changed nothing,
        // so this equals the state at the second activation).
        assert_eq!(after.list_workspaces().unwrap().len(), 2);
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

    /// A05 core: memory and goals really import and stay readable, while
    /// automations/bots/rooms are recognized but explicitly blocked — the
    /// run completes verified with a readable report and never claims
    /// activation.
    #[test]
    fn memory_and_goals_import_while_blocked_categories_withhold_activation() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("knorvia-mig-a05-{stamp}"));
        let source = root.join("legacy-src");
        let dest = root.join("knorvia-home");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dest).unwrap();
        let dump = serde_json::json!({
            "sessions": [{"id": "sess-m", "title": "Memory carrier"}],
            "memory": [
                {"content": "prefers dark mode", "kind": "preference"},
                {"content": "allergy: peanuts", "kind": "fact"}
            ],
            "goals": [{"title": "Finish thesis draft"}],
            "automations": [{"id": "a1", "schedule": "0 9 * * *"}, {"id": "a2"}],
            "bots": [{"id": "b1", "name": "ops"}],
            "rooms": [{"id": "r1"}],
            "customwidgets": [{"w": 1}]
        });
        fs::write(source.join("legacy.json"), dump.to_string()).unwrap();

        let m = Migrator::open(layout(dest.clone())).unwrap();
        let pre = m.preflight(&source).unwrap();
        let entry = |name: &str| {
            pre.inventory
                .iter()
                .find(|e| e.category == name)
                .cloned()
                .unwrap_or_else(|| panic!("no {name} in inventory: {:?}", pre.inventory))
        };
        assert_eq!(entry("memory"), {
            InventoryEntry {
                category: "memory".into(),
                count: 2,
                mapping: "imported".into(),
            }
        });
        assert_eq!(entry("goals").mapping, "imported");
        assert_eq!(entry("automations").mapping, "blocked");
        assert_eq!(entry("customwidgets").mapping, "unknown");

        let run = m.run(&source).unwrap();
        // 1 session + 2 memory + 1 goal imported.
        assert_eq!(run.imported, 4);
        assert_eq!(
            run.phase,
            MigratePhase::Verified,
            "blocked run never activates"
        );
        assert!(
            run.blocked.iter().any(|b| b.starts_with("automations:")),
            "automations explicitly blocked: {:?}",
            run.blocked
        );
        assert!(run.blocked.iter().any(|b| b.starts_with("bots:")));
        assert!(run.blocked.iter().any(|b| b.starts_with("rooms:")));
        assert!(
            run.blocked
                .iter()
                .any(|b| b.starts_with("unknown category 'customwidgets'"))
        );
        // No activation pointer: downstream cannot mistake this for a full cut-over.
        assert!(
            !layout(dest.clone())
                .backups
                .join("active-migration.json")
                .exists()
        );
        // Readable report on disk.
        let report = fs::read_to_string(
            layout(dest.clone())
                .backups
                .join("migrate-runs")
                .join(format!("{}.report.md", run.id)),
        )
        .unwrap();
        assert!(report.contains("customwidgets"), "{report}");
        assert!(report.contains("activation withheld"), "{report}");

        // Memory records are readable in the destination store.
        let memory = MemoryStore::open(&layout(dest.clone()).state);
        let mem_ids: Vec<&IdMap> = run
            .mapping
            .iter()
            .filter(|m| m.legacy_source == "memory")
            .collect();
        assert_eq!(mem_ids.len(), 2);
        for m in mem_ids {
            let record = memory.read_record(&m.new_id).unwrap();
            assert!(record.is_some(), "imported memory {} readable", m.new_id);
        }

        // Retry consistency: a second run maps to the same records.
        let again = m.run(&source).unwrap();
        assert_eq!(again.imported, run.imported);
        for key in ["memory", "goal"] {
            let first: Vec<_> = run
                .mapping
                .iter()
                .filter(|m| m.legacy_source.starts_with(key))
                .map(|m| m.new_id.clone())
                .collect();
            let second: Vec<_> = again
                .mapping
                .iter()
                .filter(|m| m.legacy_source.starts_with(key))
                .map(|m| m.new_id.clone())
                .collect();
            assert_eq!(first, second, "{key} mapping stable across retries");
        }
        let _ = fs::remove_dir_all(root);
    }

    /// A partially corrupt dump imports its valid records but must not claim
    /// a successful full migration.
    #[test]
    fn corrupt_entries_import_valid_records_but_block_activation() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("knorvia-mig-corrupt-{stamp}"));
        let source = root.join("legacy-src");
        let dest = root.join("knorvia-home");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dest).unwrap();
        // One valid session; one missing its id; one memory without content.
        let raw = r#"{
            "sessions": [
                {"id": "sess-ok", "title": "Fine"},
                {"title": "no id here"}
            ],
            "memory": [
                {"content": "good memory"},
                {"kind": "fact"}
            ]
        }"#;
        fs::write(source.join("legacy.json"), raw).unwrap();

        let m = Migrator::open(layout(dest.clone())).unwrap();
        let pre = m.preflight(&source).unwrap();
        assert_eq!(
            pre.warnings.len(),
            1,
            "the corrupt session is counted: {:?}",
            pre.warnings
        );
        assert!(pre.warnings[0].contains("sessions[1]"));

        let run = m.run(&source).unwrap();
        assert_eq!(run.imported, 2, "valid session + valid memory import");
        assert_eq!(run.phase, MigratePhase::Verified);
        assert!(
            run.blocked.iter().any(|b| b.contains("sessions[1]")),
            "corrupt session counted: {:?}",
            run.blocked
        );
        assert!(
            run.blocked.iter().any(|b| b.contains("memory[1]")),
            "content-less memory counted: {:?}",
            run.blocked
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rollback_intent_before_first_rename_still_restores_snapshot_exactly() {
        // Boundary: the intent is persisted and the crash happened BEFORE
        // the first rename — the live state still holds the MIGRATED
        // content. Recovery must replace it with the pre-migration
        // snapshot; imported documents must not survive in the live state.
        let (m, run_id, dest, backups, pre_ws) = migrate_to_activation("intent-first-rename");
        let imported_ids: Vec<String> = {
            let s = ProductStore::open(layout(dest.clone())).unwrap();
            s.list_workspaces()
                .unwrap()
                .into_iter()
                .map(|w| w.id)
                .filter(|id| *id != pre_ws)
                .collect()
        };
        assert!(!imported_ids.is_empty());

        // Construct the crash boundary explicitly: the intent is written,
        // the crash happened before the first rename — the live state is
        // the migrated one, prev and staged do not exist.
        let intent = backups.join("rollback-intent.json");
        let state = layout(dest.clone()).state;
        let prev = backups.join(format!("rollback-prev-{run_id}"));
        let staged = backups.join(format!("rollback-staged-{run_id}"));
        write_rollback_intent_fixture(&backups, &run_id, &state, &prev, &staged);

        // Real process restart: drop the old Migrator and reopen.
        drop(m);
        let m = Migrator::open(layout(dest.clone())).unwrap();

        let rolled = m.rollback(&run_id).unwrap();
        assert_eq!(rolled.phase, MigratePhase::RolledBack);
        let after = ProductStore::open(layout(dest.clone())).unwrap();
        let live_ids: Vec<String> = after
            .list_workspaces()
            .unwrap()
            .into_iter()
            .map(|w| w.id)
            .collect();
        // The snapshot is restored exactly: the pre-migration user
        // workspace is back; every migrated document is gone.
        assert_eq!(live_ids, vec![pre_ws.clone()]);
        assert!(after.read_workspace(&pre_ws).is_ok());
        for id in &imported_ids {
            assert!(
                after.read_workspace(id).is_err(),
                "an imported document survived the rollback: {id}"
            );
        }
        assert!(!backups.join("active-migration.json").exists());
        assert!(!intent.exists());
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn startup_recovery_refuses_state_changed_after_swap_intent() {
        let (m, run_id, dest, backups, _pre_ws) = migrate_to_activation("intent-new-fact");
        let state = layout(dest.clone()).state;
        let prev = backups.join(format!("rollback-prev-{run_id}"));
        let staged = backups.join(format!("rollback-staged-{run_id}"));
        write_rollback_intent_fixture(&backups, &run_id, &state, &prev, &staged);
        let late = ProductStore::open(layout(dest.clone()))
            .unwrap()
            .create_workspace("must survive")
            .unwrap();
        drop(m);

        let error = Migrator::recover_pending_rollback(&layout(dest.clone())).unwrap_err();
        assert!(format!("{error}").contains("changed after"));
        let unchanged = ProductStore::open(layout(dest.clone())).unwrap();
        assert!(unchanged.read_workspace(&late.id).is_ok());
        assert!(backups.join("active-migration.json").exists());
        assert!(!prev.exists());
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn rollback_crash_between_marker_and_phase_save_recovers_by_marker() {
        // Boundary: the swap completed, the swap-complete marker was
        // written, but the phase save and pointer withdrawal never ran.
        // The retry must finish bookkeeping via the marker — WITHOUT
        // re-restoring or re-entering the drift gate.
        let (m, run_id, dest, backups, pre_ws) = migrate_to_activation("marker-phase");
        // Reconstruct: rollback ran once to completion, then the phase was
        // reset to Activated and the pointer restored — the exact state a
        // crash between the marker write and the bookkeeping would leave.
        let _ = m.rollback(&run_id).unwrap();
        {
            let mut run = m.read_run(&run_id).unwrap();
            run.phase = MigratePhase::Activated;
            m.save(&run).unwrap();
        }
        fs::write(
            backups.join("active-migration.json"),
            serde_json::to_vec_pretty(&serde_json::to_value(m.read_run(&run_id).unwrap()).unwrap())
                .unwrap(),
        )
        .unwrap();

        let rolled = m.rollback(&run_id).unwrap();
        assert_eq!(rolled.phase, MigratePhase::RolledBack);
        assert!(!backups.join("active-migration.json").exists());
        let after = ProductStore::open(layout(dest.clone())).unwrap();
        assert!(after.read_workspace(&pre_ws).is_ok());
        assert_eq!(after.list_workspaces().unwrap().len(), 1);
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn startup_recovery_reconciles_marker_and_intent_then_is_clean() {
        // Exact crash boundary: the restored state and completion marker
        // are durable, but the intent deletion, phase save and pointer
        // withdrawal have not happened yet.
        let (m, run_id, dest, backups, pre_ws) = migrate_to_activation("marker-plus-intent");
        let _ = m.rollback(&run_id).unwrap();
        let state = layout(dest.clone()).state;
        let prev = backups.join(format!("rollback-prev-{run_id}"));
        let staged = backups.join(format!("rollback-staged-{run_id}"));
        {
            let mut run = m.read_run(&run_id).unwrap();
            run.phase = MigratePhase::Activated;
            m.save(&run).unwrap();
            fs::write(
                backups.join("active-migration.json"),
                serde_json::to_vec_pretty(&run).unwrap(),
            )
            .unwrap();
        }
        write_rollback_intent_fixture(&backups, &run_id, &state, &prev, &staged);
        let intent = backups.join("rollback-intent.json");
        assert!(backups.join(format!("swap-complete-{run_id}")).exists());
        assert!(intent.exists());
        drop(m);

        let paths = layout(dest.clone());
        assert_eq!(
            Migrator::recover_pending_rollback(&paths).unwrap(),
            Some(run_id.clone())
        );
        assert!(
            !intent.exists(),
            "the reconciled intent is withdrawn durably"
        );
        assert!(!backups.join("active-migration.json").exists());
        let restored = ProductStore::open(paths.clone()).unwrap();
        assert!(restored.read_workspace(&pre_ws).is_ok());
        assert_eq!(restored.list_workspaces().unwrap().len(), 1);
        drop(restored);

        // A second real startup sees no orphan credential and is a no-op.
        assert_eq!(Migrator::recover_pending_rollback(&paths).unwrap(), None);
        assert_eq!(
            Migrator::open(paths)
                .unwrap()
                .read_run(&run_id)
                .unwrap()
                .phase,
            MigratePhase::RolledBack
        );
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn rollback_refuses_to_follow_a_snapshot_file_link() {
        let (m, run_id, dest, backups, pre_ws) = migrate_to_activation("snapshot-link");
        let victim = backups
            .join(format!("dest-before-{run_id}"))
            .join("state")
            .join("product")
            .join("workspaces")
            .join(format!("{pre_ws}.json"));
        let outside = dest.parent().unwrap().join("outside-snapshot.json");
        fs::copy(&victim, &outside).unwrap();
        fs::remove_file(&victim).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &victim).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside, &victim).unwrap();

        let error = m.rollback(&run_id).unwrap_err();
        let message = format!("{error}");
        assert!(
            message.contains("symlink") || message.contains("reparse point"),
            "link traversal is rejected explicitly: {message}"
        );
        assert!(backups.join("active-migration.json").exists());
        assert_eq!(
            ProductStore::open(layout(dest.clone()))
                .unwrap()
                .list_workspaces()
                .unwrap()
                .len(),
            3,
            "the live state remains untouched"
        );
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }
}
