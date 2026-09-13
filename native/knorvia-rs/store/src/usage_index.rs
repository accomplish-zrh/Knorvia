//! Rebuildable date/owner index. Authoritative usage and job facts are never rewritten.
use super::*;
use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::fs::File;
use std::io::Read;
use std::time::{Duration, Instant, SystemTime};
type Key = (u64, String, String);
#[derive(Debug, Clone, PartialEq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}
fn stamp(path: &Path) -> Result<Stamp, StoreError> {
    let m = fs::metadata(path)?;
    Ok(Stamp {
        len: m.len(),
        modified: m.modified().ok(),
    })
}
fn read_source(path: &Path) -> Result<Vec<u8>, StoreError> {
    if stamp(path)?.len > 1024 * 1024 {
        return Err(exhausted("usage source record exceeds 1 MiB"));
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err(exhausted("usage source grew beyond 1 MiB"));
    }
    Ok(bytes)
}
fn exhausted(message: impl Into<String>) -> StoreError {
    ProtocolError::new(ErrorCategory::ResourceExhausted, message).into()
}
#[derive(Debug)]
struct UsageEntry {
    record: UsageRecord,
    path: PathBuf,
    stamp: Stamp,
}
#[derive(Debug)]
struct JobEntry {
    job: Job,
    path: PathBuf,
    stamp: Stamp,
}
#[derive(Debug)]
struct PendingFile {
    path: PathBuf,
    file: File,
    bytes: Vec<u8>,
    stamp: Stamp,
    job: bool,
}
#[derive(Debug)]
struct Builder {
    directories: Vec<(fs::ReadDir, bool)>,
    pending: Option<PendingFile>,
    files: usize,
    bytes: u64,
}
#[derive(Debug)]
struct Summary {
    token: String,
    query: String,
    generation: String,
    value: Value,
    records: Vec<Value>,
    bytes: usize,
}
#[derive(Debug, Default)]
pub(super) struct UsageIndex {
    built: bool,
    version: u64,
    nonce: String,
    marker: Vec<u8>,
    builder: Option<Builder>,
    rows: BTreeMap<Key, UsageEntry>,
    owners: HashMap<String, BTreeSet<Key>>,
    jobs: HashMap<String, JobEntry>,
    job_dates: BTreeMap<(u64, String), ()>,
    summaries: VecDeque<Summary>,
    source_bytes: u64,
    selected_rows: u64,
    indexed_bytes: u64,
}
pub struct UsageSnapshot {
    pub generation: String,
    pub records: Vec<UsageRecord>,
    pub jobs: Vec<Job>,
}
impl UsageIndex {
    fn generation(&mut self) -> String {
        if self.nonce.is_empty() {
            self.nonce = new_id("usage");
        }
        format!("{}:{}", self.nonce, self.version)
    }
    fn clear_index(&mut self) {
        self.built = false;
        self.builder = None;
        self.rows.clear();
        self.owners.clear();
        self.jobs.clear();
        self.job_dates.clear();
        self.marker.clear();
        self.indexed_bytes = 0;
        self.version += 1;
    }
    fn put_usage(&mut self, record: UsageRecord, path: PathBuf) -> Result<(), StoreError> {
        for id in [&record.thread_id, &record.turn_id] {
            if id.is_empty()
                || !id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                return Err(StoreError::Corrupt("unsafe usage record identity".into()));
            }
        }
        let key = (
            record.recorded_at_ms,
            record.thread_id.clone(),
            record.turn_id.clone(),
        );
        if self.rows.contains_key(&key) {
            return Err(StoreError::Corrupt("duplicate usage fact in index".into()));
        }
        self.indexed_bytes += stamp(&path)?.len;
        if self.indexed_bytes > 128 * 1024 * 1024 || self.rows.len() + self.jobs.len() >= 250_000 {
            return Err(exhausted(
                "usage index exceeds 128 MiB of source facts or 250000 records",
            ));
        }
        self.owners
            .entry(record.thread_id.clone())
            .or_default()
            .insert(key.clone());
        self.rows.insert(
            key,
            UsageEntry {
                record,
                stamp: stamp(&path)?,
                path,
            },
        );
        Ok(())
    }
    fn put_job(&mut self, job: Job, path: PathBuf) -> Result<(), StoreError> {
        self.job_dates.retain(|(_, id), _| id != &job.id);
        if let Some(old) = self.jobs.remove(&job.id) {
            self.indexed_bytes = self.indexed_bytes.saturating_sub(old.stamp.len);
        }
        if !job.r#type.starts_with("media.") && !job.r#type.starts_with("studio.") {
            return Ok(());
        }
        let fallback = job
            .updated_at
            .trim_end_matches("ms")
            .parse::<u64>()
            .unwrap_or(0);
        if let Some(attempts) = job
            .checkpoint
            .as_ref()
            .and_then(|v| v["usage"]["attempts"].as_array())
            .filter(|a| !a.is_empty())
        {
            for attempt in attempts {
                self.job_dates.insert(
                    (
                        attempt["recordedAtMs"].as_u64().unwrap_or(fallback),
                        job.id.clone(),
                    ),
                    (),
                );
            }
        } else {
            self.job_dates.insert((fallback, job.id.clone()), ());
        }
        self.indexed_bytes += stamp(&path)?.len;
        if self.indexed_bytes > 128 * 1024 * 1024 || self.rows.len() + self.jobs.len() >= 250_000 {
            return Err(exhausted(
                "usage index exceeds 128 MiB of source facts or 250000 records",
            ));
        }
        self.jobs.insert(
            job.id.clone(),
            JobEntry {
                job,
                stamp: stamp(&path)?,
                path,
            },
        );
        Ok(())
    }
}
impl ProductStore {
    fn usage_marker_path(&self) -> PathBuf {
        self.product_dir().join("usage-index").join("generation")
    }
    fn persist_usage_marker(&self, index: &mut UsageIndex) -> Result<(), StoreError> {
        index.marker = format!("usage-index-v1:{}", index.generation()).into_bytes();
        atomic_write(&self.usage_marker_path(), &index.marker)?;
        Ok(())
    }
    /// Call after an explicit historical ledger repair. A real WAL recovery
    /// also invalidates this accelerator, never the authoritative usage facts.
    pub fn invalidate_usage_index(&self) -> Result<(), StoreError> {
        self.locks
            .usage_index
            .lock()
            .map_err(|_| StoreError::Corrupt("usage lock".into()))?
            .clear_index();
        Ok(())
    }
    pub(super) fn note_usage_record(
        &self,
        record: &UsageRecord,
        first_ledger: bool,
    ) -> Result<(), StoreError> {
        let mut index = self
            .locks
            .usage_index
            .lock()
            .map_err(|_| StoreError::Corrupt("usage lock".into()))?;
        if first_ledger && !self.product_dir().join("jobs").exists() {
            index.built = true;
        }
        index.version += 1;
        if index.built {
            index.put_usage(
                record.clone(),
                self.product_dir()
                    .join("usage")
                    .join(&record.thread_id)
                    .join(format!("{}.json", record.turn_id)),
            )?;
            self.persist_usage_marker(&mut index)?;
        } else {
            index.builder = None;
            index.rows.clear();
            index.owners.clear();
            index.jobs.clear();
            index.job_dates.clear();
            index.indexed_bytes = 0;
        }
        Ok(())
    }
    pub(super) fn note_usage_projection(
        &self,
        kind: durable::ProjectionKind,
        document: &Value,
        path: &Path,
    ) -> Result<(), StoreError> {
        use durable::ProjectionKind::*;
        if !matches!(kind, Job | Thread | SessionBinding | Bot | Room) {
            return Ok(());
        }
        let mut index = self
            .locks
            .usage_index
            .lock()
            .map_err(|_| StoreError::Corrupt("usage lock".into()))?;
        index.version += 1;
        if kind == Job {
            if index.built {
                index.put_job(
                    serde_json::from_value(document.clone())?,
                    path.to_path_buf(),
                )?;
            } else {
                index.builder = None;
                index.rows.clear();
                index.owners.clear();
                index.jobs.clear();
                index.job_dates.clear();
                index.indexed_bytes = 0;
            }
        }
        if index.built {
            self.persist_usage_marker(&mut index)?;
        }
        Ok(())
    }
    fn ensure_usage_index_locked(&self, index: &mut UsageIndex) -> Result<(), StoreError> {
        if index.built {
            let mut bytes = Vec::new();
            if let Ok(file) = File::open(self.usage_marker_path()) {
                file.take(256).read_to_end(&mut bytes)?;
            }
            if bytes == index.marker {
                return Ok(());
            }
            index.clear_index();
        }
        if index.builder.is_none() {
            let mut directories = Vec::new();
            for (dir, jobs) in [
                (self.product_dir().join("usage"), false),
                (self.product_dir().join("jobs"), true),
            ] {
                match fs::read_dir(dir) {
                    Ok(entries) => directories.push((entries, jobs)),
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
            index.builder = Some(Builder {
                directories,
                pending: None,
                files: 0,
                bytes: 0,
            });
        }
        let start = Instant::now();
        let mut builder = index.builder.take().unwrap();
        let mut entries = 0;
        let mut read_bytes = 0;
        let outcome = (|| -> Result<bool, StoreError> {
            loop {
                if entries >= 256
                    || read_bytes >= 1024 * 1024
                    || start.elapsed() >= Duration::from_millis(25)
                {
                    return Ok(false);
                }
                if let Some(mut pending) = builder.pending.take() {
                    let mut chunk = [0u8; 32 * 1024];
                    let n = pending.file.read(&mut chunk)?;
                    read_bytes += n;
                    builder.bytes += n as u64;
                    index.source_bytes += n as u64;
                    pending.bytes.extend_from_slice(&chunk[..n]);
                    if pending.bytes.len() > 1024 * 1024 {
                        return Err(exhausted(
                            "usage source record exceeds 1 MiB; no usage was discarded",
                        ));
                    }
                    if n > 0 {
                        builder.pending = Some(pending);
                        continue;
                    }
                    if stamp(&pending.path)? != pending.stamp {
                        return Err(conflict(
                            "usage source changed while indexing; retry rebuild",
                        ));
                    }
                    if pending.job {
                        index.put_job(serde_json::from_slice(&pending.bytes)?, pending.path)?;
                    } else {
                        let record: UsageRecord = serde_json::from_slice(&pending.bytes)?;
                        if pending.path.file_stem().and_then(|s| s.to_str())
                            != Some(&record.turn_id)
                            || pending
                                .path
                                .parent()
                                .and_then(|p| p.file_name())
                                .and_then(|s| s.to_str())
                                != Some(&record.thread_id)
                        {
                            return Err(StoreError::Corrupt(
                                "usage identity differs from authoritative path".into(),
                            ));
                        }
                        index.put_usage(record, pending.path)?;
                    }
                    builder.files += 1;
                    if index.rows.len() + index.jobs.len() > 250_000 {
                        return Err(exhausted("usage index exceeds 250000 source records"));
                    }
                    continue;
                }
                let Some((directory, jobs)) = builder.directories.last_mut() else {
                    return Ok(true);
                };
                let Some(entry) = directory.next() else {
                    builder.directories.pop();
                    continue;
                };
                let entry = entry?;
                let jobs = *jobs;
                entries += 1;
                let kind = entry.file_type()?;
                if kind.is_symlink() {
                    return Err(StoreError::Corrupt("linked usage source".into()));
                }
                if kind.is_dir() {
                    if !jobs && builder.directories.len() < 3 {
                        builder
                            .directories
                            .push((fs::read_dir(entry.path())?, false));
                    }
                    continue;
                }
                if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let path = entry.path();
                let stamp = stamp(&path)?;
                if stamp.len > 1024 * 1024 {
                    return Err(exhausted(
                        "usage source record exceeds 1 MiB; no usage was discarded",
                    ));
                }
                builder.pending = Some(PendingFile {
                    file: File::open(&path)?,
                    path,
                    stamp,
                    job: jobs,
                    bytes: Vec::new(),
                });
            }
        })();
        match outcome {
            Ok(true) => {
                index.built = true;
                index.version += 1;
                self.persist_usage_marker(index)?;
                Ok(())
            }
            Ok(false) => {
                let progress = format!(
                    "usage_index_building: indexedRecords={}, scannedBytes={}; retry the same request",
                    builder.files, builder.bytes
                );
                index.builder = Some(builder);
                Err(exhausted(progress))
            }
            Err(error) => {
                index.clear_index();
                Err(error)
            }
        }
    }
    pub fn usage_index_generation(&self) -> Result<String, StoreError> {
        let _mutation = self.lock_mutations()?;
        let mut index = self
            .locks
            .usage_index
            .lock()
            .map_err(|_| StoreError::Corrupt("usage lock".into()))?;
        self.ensure_usage_index_locked(&mut index)?;
        Ok(index.generation())
    }
    pub fn usage_query_snapshot(
        &self,
        from: Option<u64>,
        to: Option<u64>,
        owners: Option<&HashSet<String>>,
        expected: Option<&str>,
    ) -> Result<UsageSnapshot, StoreError> {
        let _mutation = self.lock_mutations()?;
        let mut index = self
            .locks
            .usage_index
            .lock()
            .map_err(|_| StoreError::Corrupt("usage lock".into()))?;
        self.ensure_usage_index_locked(&mut index)?;
        let generation = index.generation();
        if expected.is_some_and(|e| e != generation) {
            return Err(conflict("usage attribution changed; retry summary"));
        }
        let low = from.unwrap_or(0);
        let high = to.unwrap_or(u64::MAX);
        if low > high {
            return Err(invalid("invalid usage range"));
        }
        let keys: Vec<Key> = if let Some(owners) = owners {
            owners
                .iter()
                .filter_map(|owner| index.owners.get(owner))
                .flat_map(|keys| {
                    keys.range(
                        (low, String::new(), String::new())
                            ..=(high, "\u{10ffff}".into(), "\u{10ffff}".into()),
                    )
                    .cloned()
                })
                .collect()
        } else {
            index
                .rows
                .range(
                    (low, String::new(), String::new())
                        ..=(high, "\u{10ffff}".into(), "\u{10ffff}".into()),
                )
                .map(|(key, _)| key.clone())
                .collect()
        };
        let mut records = Vec::new();
        for key in keys {
            let entry = &index.rows[&key];
            let bytes = read_source(&entry.path)?;
            let actual: UsageRecord = serde_json::from_slice(&bytes)?;
            if stamp(&entry.path)? != entry.stamp || actual != entry.record {
                index.clear_index();
                return Err(conflict("usage source changed; bounded rebuild required"));
            }
            records.push(actual);
            index.source_bytes += bytes.len() as u64;
        }
        index.selected_rows += records.len() as u64;
        let job_ids: HashSet<_> = index
            .job_dates
            .range((low, String::new())..=(high, "\u{10ffff}".into()))
            .map(|((_, id), _)| id.clone())
            .collect();
        let mut jobs = Vec::new();
        for id in job_ids {
            let entry = &index.jobs[&id];
            let bytes = read_source(&entry.path)?;
            let actual: Job = serde_json::from_slice(&bytes)?;
            if stamp(&entry.path)? != entry.stamp
                || serde_json::to_value(&actual)? != serde_json::to_value(&entry.job)?
            {
                index.clear_index();
                return Err(conflict(
                    "media usage source changed; bounded rebuild required",
                ));
            }
            jobs.push(actual);
            index.source_bytes += bytes.len() as u64;
        }
        Ok(UsageSnapshot {
            generation,
            records,
            jobs,
        })
    }
    pub fn usage_index_stats(&self) -> Value {
        let index = self.locks.usage_index.lock().unwrap();
        serde_json::json!({"sourceBytesRead":index.source_bytes,"selectedRecords":index.selected_rows,"indexedRecords":index.rows.len(),"indexedMediaJobs":index.jobs.len(),"building":!index.built})
    }
    pub fn cached_usage_summary(
        &self,
        token: Option<&str>,
        query: &str,
        generation: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Result<Option<Value>, StoreError> {
        let index = self
            .locks
            .usage_index
            .lock()
            .map_err(|_| StoreError::Corrupt("usage lock".into()))?;
        let found = index.summaries.iter().rev().find(|s| {
            s.query == query
                && token.is_none_or(|token| s.token == token)
                && generation.is_none_or(|g| s.generation == g)
        });
        let Some(summary) = found else {
            if token.is_some() {
                return Err(conflict(
                    "usage snapshot expired or does not match filters; restart from first page",
                ));
            }
            return Ok(None);
        };
        let mut value = summary.value.clone();
        value["records"] = Value::Array(
            summary
                .records
                .iter()
                .skip(offset)
                .take(limit)
                .cloned()
                .collect(),
        );
        value["paging"] = serde_json::json!({"offset":offset,"limit":limit,"total":summary.records.len(),"snapshot":summary.token,"generation":summary.generation});
        if serde_json::to_vec(&value)?.len() > 6 * 1024 * 1024 {
            return Err(exhausted(
                "usage summary frame exceeds 6 MiB; narrow filters or lower detail limit",
            ));
        }
        Ok(Some(value))
    }
    pub fn cache_usage_summary(
        &self,
        query: &str,
        generation: &str,
        mut value: Value,
        offset: usize,
        limit: usize,
    ) -> Result<Value, StoreError> {
        let records = value
            .as_object_mut()
            .and_then(|v| v.remove("records"))
            .and_then(|v| match v {
                Value::Array(records) => Some(records),
                _ => None,
            })
            .ok_or_else(|| StoreError::Corrupt("summary records missing".into()))?;
        let bytes = serde_json::to_vec(&value)?.len() + serde_json::to_vec(&records)?.len();
        if bytes > 64 * 1024 * 1024 {
            return Err(exhausted(
                "usage snapshot exceeds 64 MiB; narrow the date range",
            ));
        }
        let token = new_id("usage_snapshot");
        {
            let mut index = self
                .locks
                .usage_index
                .lock()
                .map_err(|_| StoreError::Corrupt("usage lock".into()))?;
            if index.generation() != generation {
                return Err(conflict(
                    "usage changed during summary; retry the same filters",
                ));
            }
            while index.summaries.len() >= 4
                || index.summaries.iter().map(|s| s.bytes).sum::<usize>() + bytes > 64 * 1024 * 1024
            {
                index.summaries.pop_front();
            }
            index.summaries.push_back(Summary {
                token: token.clone(),
                query: query.into(),
                generation: generation.into(),
                value,
                records,
                bytes,
            });
        }
        self.cached_usage_summary(Some(&token), query, None, offset, limit)?
            .ok_or_else(|| conflict("usage snapshot unavailable"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> ProductStore {
        ProductStore::open(knorvia_platform_paths::layout(
            std::env::temp_dir().join(format!("usage-index-test-{}", new_id("test"))),
        ))
        .unwrap()
    }
    fn record(n: u64) -> UsageRecord {
        serde_json::from_value(serde_json::json!({"threadId":format!("thread_{}",n%2),"turnId":format!("turn_{n}"),"turnStatus":"completed","model":"historic-model","providerId":"fixture","inputTokens":100,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":2,"reasoningOutputTokens":1,"totalTokens":102,"modelContextWindow":null,"completeness":if n%5==0{"unknown"}else{"known"},"cacheFieldsReported":{"cachedInput":true,"cacheWrite":false},"parentTurnId":if n%2==0{Some("parent")}else{None},"recordedAtMs":(n/2)*86_400_000})).unwrap()
    }
    fn finish(store: &ProductStore) -> (usize, Duration) {
        let mut retries = 0;
        let mut max = Duration::ZERO;
        loop {
            let start = Instant::now();
            let result = store.usage_index_generation();
            max = max.max(start.elapsed());
            match result {
                Ok(_) => return (retries, max),
                Err(error) if error.to_string().contains("usage_index_building:") => {
                    retries += 1;
                    assert!(retries < 1000);
                }
                Err(error) => panic!("{error}"),
            }
        }
    }
    #[test]
    fn ten_year_ledger_cold_rebuild_yields_and_warm_date_owner_reads_only_its_range() {
        let store = store();
        let mut oracle = Vec::new();
        for n in 0..7300 {
            let record = record(n);
            let path = store
                .product_dir()
                .join("usage")
                .join(&record.thread_id)
                .join(format!("{}.json", record.turn_id));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
            oracle.push(record);
        }
        let start = Instant::now();
        let first = store.usage_index_generation().unwrap_err();
        assert!(first.to_string().contains("usage_index_building:"));
        assert!(start.elapsed() < Duration::from_millis(500));
        assert!(
            store.usage_index_stats()["sourceBytesRead"]
                .as_u64()
                .unwrap()
                <= 1024 * 1024
        );
        let (retries, max) = finish(&store);
        assert!(retries > 1);
        eprintln!(
            "A09 7300 facts across10years rebuilt with{} yields maxslice {:?}",
            retries + 1,
            max
        );
        let day = 3000 * 86_400_000;
        let before = store.usage_index_stats();
        let snapshot = store
            .usage_query_snapshot(Some(day), Some(day + 86_399_999), None, None)
            .unwrap();
        let expected: Vec<_> = oracle
            .into_iter()
            .filter(|r| r.recorded_at_ms == day)
            .collect();
        assert_eq!(snapshot.records, expected);
        let after = store.usage_index_stats();
        assert_eq!(
            after["selectedRecords"].as_u64().unwrap()
                - before["selectedRecords"].as_u64().unwrap(),
            2
        );
        assert!(
            after["sourceBytesRead"].as_u64().unwrap()
                - before["sourceBytesRead"].as_u64().unwrap()
                < 4096
        );
        let owners = ["thread_0".into()].into_iter().collect();
        let owner = store
            .usage_query_snapshot(Some(day), Some(day + 86_399_999), Some(&owners), None)
            .unwrap();
        assert_eq!(owner.records.len(), 1);
        assert_eq!(owner.records[0].thread_id, "thread_0");
        // Rebuild is an accelerator operation: delete/corrupt it, preserve facts.
        for corrupt in [false, true] {
            if corrupt {
                fs::write(store.usage_marker_path(), b"corrupt-index").unwrap();
            } else {
                fs::remove_file(store.usage_marker_path()).unwrap();
            }
            assert!(
                store
                    .usage_index_generation()
                    .unwrap_err()
                    .to_string()
                    .contains("usage_index_building:")
            );
            finish(&store);
            assert_eq!(
                store
                    .usage_query_snapshot(Some(day), Some(day), None, None)
                    .unwrap()
                    .records,
                expected
            );
        }
        let path = store.product_dir().join("usage/thread_0/turn_6000.json");
        fs::write(&path, b"{broken").unwrap();
        assert!(
            store
                .usage_query_snapshot(Some(day), Some(day), None, None)
                .is_err()
        );
    }
    #[test]
    fn incremental_usage_and_media_attempt_updates_keep_new_generations_and_unknown_facts() {
        let store = store();
        let record = record(1);
        assert!(store.record_usage(&record).unwrap());
        assert!(!store.record_usage(&record).unwrap());
        let old = store.usage_query_snapshot(None, None, None, None).unwrap();
        let ws = store.create_workspace("fixture").unwrap();
        let job = store.create_job(&ws.id, "media.image").unwrap();
        store.run_job(&job.id).unwrap();
        store.checkpoint_job(&job.id,serde_json::json!({"usage":{"providerId":"historic","model":"media-model","attempts":[{"recordedAtMs":100,"known":false},{"recordedAtMs":10_000,"known":true,"units":[{"name":"image","value":1}]}]}})).unwrap();
        let narrow = store
            .usage_query_snapshot(Some(100), Some(100), None, None)
            .unwrap();
        assert_eq!(narrow.jobs.len(), 1);
        assert_ne!(old.generation, narrow.generation);
        assert_eq!(
            narrow.jobs[0].checkpoint.as_ref().unwrap()["usage"]["attempts"][0]["known"],
            false
        );
        let old_generation = narrow.generation;
        store
            .checkpoint_job(
                &job.id,
                serde_json::json!({"usage":{"attempts":[{"recordedAtMs":20_000,"known":false}]}}),
            )
            .unwrap();
        assert!(
            store
                .usage_query_snapshot(Some(100), Some(100), None, None)
                .unwrap()
                .jobs
                .is_empty()
        );
        let fresh = store
            .usage_query_snapshot(Some(20_000), Some(20_000), None, None)
            .unwrap();
        assert_eq!(fresh.jobs.len(), 1);
        assert_ne!(fresh.generation, old_generation);
    }
    #[test]
    fn oversized_source_fails_before_allocating_or_returning_empty_success() {
        let store = store();
        let dir = store.product_dir().join("usage/thread_0");
        fs::create_dir_all(&dir).unwrap();
        let file = File::create(dir.join("huge.json")).unwrap();
        file.set_len(50 * 1024 * 1024).unwrap();
        assert!(
            store
                .usage_index_generation()
                .unwrap_err()
                .to_string()
                .contains("exceeds 1 MiB")
        );
        assert_eq!(store.usage_index_stats()["sourceBytesRead"], 0);
    }
}
