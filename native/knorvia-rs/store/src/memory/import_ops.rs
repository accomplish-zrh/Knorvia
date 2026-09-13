//! Whole-bundle preflight and restartable, individually audited import operations.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};
const MAX_IMPORT_RECORDS: usize = 2000;
const MAX_IMPORT_BYTES: usize = 6 * 1024 * 1024;

pub(super) fn write_lock(root: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    locks.retain(|_, v| v.strong_count() > 0);
    if let Some(lock) = locks.get(root).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(root.to_path_buf(), Arc::downgrade(&lock));
    lock
}
fn hash(value: &impl Serialize) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(value).expect("serializable import value"),
    ))
}
pub(super) fn bundle_operation_id(bundle: &serde_json::Value) -> String {
    format!("imp_{}", hash(bundle))
}
fn comparable(record: &MemoryRecord) -> serde_json::Value {
    let mut value = serde_json::to_value(record).unwrap();
    for field in [
        "revision",
        "recordedAtMs",
        "importedFromRevision",
        "useCount",
        "lastUsedAtMs",
    ] {
        value.as_object_mut().unwrap().remove(field);
    }
    value
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlanItem {
    pub id: String,
    pub action: String,
    pub reason: String,
    pub expected_revision: Option<u64>,
    pub expected_hash: Option<String>,
    pub source: MemoryRecord,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryImportPlan {
    pub plan_hash: String,
    pub bundle_hash: String,
    pub items: Vec<ImportPlanItem>,
    pub conflicts: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItemReceipt {
    pub id: String,
    pub action: String,
    pub state: String,
    pub resulting_revision: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryImportReceipt {
    pub operation_id: String,
    pub plan_hash: String,
    pub status: String,
    pub created: usize,
    pub applied: usize,
    pub kept: usize,
    pub items: Vec<ImportItemReceipt>,
    pub error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Operation {
    id: String,
    plan: MemoryImportPlan,
    actor: String,
    at_ms: u64,
    states: Vec<String>,
    error: Option<String>,
}

impl MemoryStore {
    /// Legacy one-step transport still exposes an operation receipt on partial
    /// failure. Repeating the bundle resumes/returns this same durable operation.
    pub fn import_with_receipt(
        &self,
        bundle: &serde_json::Value,
        actor: &str,
    ) -> Result<MemoryImportReceipt, MemoryError> {
        let id = bundle_operation_id(bundle);
        if self.import_path(&id).exists() {
            return self.resume_import(&id);
        }
        let plan = self.plan_import(bundle)?;
        self.apply_import(bundle, &plan.plan_hash, &id, actor)
    }
    pub(super) fn import_path(&self, id: &str) -> PathBuf {
        self.root.join("imports").join(format!("{id}.json"))
    }
    /// Zero filesystem writes, including malformed later records and unknown versions.
    pub fn plan_import(&self, bundle: &serde_json::Value) -> Result<MemoryImportPlan, MemoryError> {
        let _lock = self.writes.lock().unwrap_or_else(|e| e.into_inner());
        self.plan_import_locked(bundle)
    }
    fn plan_import_locked(
        &self,
        bundle: &serde_json::Value,
    ) -> Result<MemoryImportPlan, MemoryError> {
        if bundle["format"] != "knorvia-memory-export" || bundle["version"] != 1 {
            return err(
                MemoryErrorKind::InvalidArgument,
                "unsupported memory bundle format/version",
            );
        }
        if serde_json::to_vec(bundle).unwrap().len() > MAX_IMPORT_BYTES {
            return err(
                MemoryErrorKind::InvalidArgument,
                "memory bundle exceeds 6 MiB",
            );
        }
        let values = bundle["records"].as_array().ok_or_else(|| MemoryError {
            kind: MemoryErrorKind::InvalidArgument,
            message: "records array required".into(),
        })?;
        if values.len() > MAX_IMPORT_RECORDS {
            return err(
                MemoryErrorKind::InvalidArgument,
                "memory bundle exceeds 2000 records",
            );
        }
        let mut ids = HashSet::new();
        let mut records = Vec::new();
        for value in values {
            let record: MemoryRecord =
                serde_json::from_value(value.clone()).map_err(|e| MemoryError {
                    kind: MemoryErrorKind::InvalidArgument,
                    message: format!("bad record: {e}"),
                })?;
            sanitize_id(&record.id)?;
            if !ids.insert(record.id.clone()) {
                return err(
                    MemoryErrorKind::InvalidArgument,
                    "duplicate memory record id",
                );
            }
            validate(&MemoryDraft {
                scope: record.scope.clone(),
                kind: record.kind.clone(),
                content: record.content.clone(),
                source_refs: record.source_refs.clone(),
                relation: record.relation.clone(),
                valid_from_ms: Some(record.valid_from_ms),
                valid_to_ms: record.valid_to_ms,
                pinned: record.pinned,
                client_token: record.client_token.clone(),
            })?;
            if record.revision == 0
                || record.revision == u64::MAX
                || !matches!(record.status.as_str(), ACTIVE | FORGOTTEN | MERGED)
            {
                return err(
                    MemoryErrorKind::InvalidArgument,
                    "invalid memory revision/status",
                );
            }
            if record.shared_scopes.len() > MAX_SHARED_SCOPES {
                return err(MemoryErrorKind::InvalidArgument, "too many shared scopes");
            }
            for scope in &record.shared_scopes {
                sanitize_scope(scope, "shared scope")?;
                if scope.owner != record.scope.owner {
                    return err(
                        MemoryErrorKind::InvalidArgument,
                        "shared scope owner differs",
                    );
                }
            }
            if (record.status == MERGED) != record.merged_into.is_some() {
                return err(
                    MemoryErrorKind::InvalidArgument,
                    "merged status/reference mismatch",
                );
            }
            if let Some(target) = &record.merged_into {
                sanitize_id(target)?;
                if target == &record.id {
                    return err(MemoryErrorKind::InvalidArgument, "self merge reference");
                }
            }
            records.push(record);
        }
        // Relation/merge references must resolve to a record visible to the
        // referring scope. A bad final reference cannot follow earlier writes.
        for record in &records {
            for target in record
                .relation
                .as_ref()
                .map(|r| &r.target_id)
                .into_iter()
                .chain(record.merged_into.iter())
            {
                let found = records
                    .iter()
                    .find(|r| &r.id == target)
                    .cloned()
                    .or(self.read_record(target)?);
                let Some(found) = found else {
                    return err(
                        MemoryErrorKind::InvalidArgument,
                        format!("missing memory reference {target}"),
                    );
                };
                let query = ScopeQuery {
                    owner: record.scope.owner.clone(),
                    workspace: Some(record.scope.workspace.clone()),
                    bot: Some(record.scope.bot.clone()),
                    conversation: Some(record.scope.conversation.clone()),
                };
                if !query.visible_from(&found) {
                    return err(
                        MemoryErrorKind::InvalidArgument,
                        "memory reference crosses an unshared scope",
                    );
                }
            }
        }
        let mut items = Vec::new();
        for source in records {
            let local = self.read_record(&source.id)?;
            let (action, reason) = match &local {
                None => ("create", "missing locally"),
                Some(local)
                    if local.scope != source.scope
                        || local.shared_scopes != source.shared_scopes =>
                {
                    ("conflict", "scope changes require explicit local mutation")
                }
                Some(local) if local.status == FORGOTTEN && source.status != FORGOTTEN => {
                    ("keep", "local forgotten state is preserved")
                }
                Some(local) if comparable(local) == comparable(&source) => {
                    ("keep", "same content and state")
                }
                Some(local)
                    if source.revision == local.revision
                        || Some(source.revision) == local.imported_from_revision =>
                {
                    ("conflict", "same source revision has different content")
                }
                Some(local)
                    if source.revision
                        > local
                            .revision
                            .max(local.imported_from_revision.unwrap_or(0)) =>
                {
                    ("update", "source revision is newer")
                }
                _ => ("keep", "local revision is newer"),
            };
            items.push(ImportPlanItem {
                id: source.id.clone(),
                action: action.into(),
                reason: reason.into(),
                expected_revision: local.as_ref().map(|r| r.revision),
                expected_hash: local.as_ref().map(hash),
                source,
            });
        }
        let conflicts = items.iter().filter(|i| i.action == "conflict").count();
        let mut plan = MemoryImportPlan {
            plan_hash: String::new(),
            bundle_hash: hash(bundle),
            items,
            conflicts,
        };
        plan.plan_hash = hash(&plan);
        Ok(plan)
    }
    pub fn apply_import(
        &self,
        bundle: &serde_json::Value,
        expected_hash: &str,
        operation_id: &str,
        actor: &str,
    ) -> Result<MemoryImportReceipt, MemoryError> {
        sanitize_id(operation_id)?;
        let _lock = self.writes.lock().unwrap_or_else(|e| e.into_inner());
        let path = self.import_path(operation_id);
        if path.exists() {
            let mut op: Operation = Self::read_json(&path)?;
            if op.plan.bundle_hash != hash(bundle) || op.plan.plan_hash != expected_hash {
                return err(
                    MemoryErrorKind::Conflict,
                    "operation id already belongs to a different import plan",
                );
            }
            return self.run_import(&mut op, None);
        }
        let plan = self.plan_import_locked(bundle)?;
        if plan.plan_hash != expected_hash {
            return err(
                MemoryErrorKind::Conflict,
                "stale memory import plan; preflight again",
            );
        }
        if plan.conflicts > 0 {
            return err(
                MemoryErrorKind::Conflict,
                "memory import plan has unresolved conflicts",
            );
        }
        let mut op = Operation {
            id: operation_id.into(),
            states: vec!["pending".into(); plan.items.len()],
            plan,
            actor: actor.chars().take(256).collect(),
            at_ms: now_ms(),
            error: None,
        };
        Self::write_json(&path, &op)?;
        self.run_import(&mut op, None)
    }
    pub fn resume_import(&self, operation_id: &str) -> Result<MemoryImportReceipt, MemoryError> {
        sanitize_id(operation_id)?;
        let _lock = self.writes.lock().unwrap_or_else(|e| e.into_inner());
        let mut op: Operation = Self::read_json(&self.import_path(operation_id))?;
        self.run_import(&mut op, None)
    }
    pub fn import_receipt(&self, operation_id: &str) -> Result<MemoryImportReceipt, MemoryError> {
        sanitize_id(operation_id)?;
        let _lock = self.writes.lock().unwrap_or_else(|e| e.into_inner());
        let mut op: Operation = Self::read_json(&self.import_path(operation_id))?;
        self.reconcile_import(&mut op)?;
        Ok(Self::receipt(&op))
    }
    fn target(op: &Operation, item: &ImportPlanItem) -> MemoryRecord {
        let mut record = item.source.clone();
        record.revision = item.expected_revision.unwrap_or(0) + 1;
        record.imported_from_revision = Some(item.source.revision);
        record.recorded_at_ms = op.at_ms;
        record
    }
    fn reconcile_import(&self, op: &mut Operation) -> Result<(), MemoryError> {
        for (i, item) in op.plan.items.iter().enumerate() {
            if op.states[i] != "applying" {
                continue;
            }
            let target = Self::target(op, item);
            let path = self
                .history_dir(&item.id)
                .join(format!("{:016}.json", target.revision));
            if !path.exists() {
                continue;
            }
            let revision: MemoryRevision = Self::read_json(&path)?;
            let current = self.read_record(&item.id)?;
            if revision.note == Some(format!("import:{}", op.id))
                && revision.record == target
                && current.as_ref().is_some_and(|r| {
                    r.revision > target.revision
                        || (r.revision == target.revision
                            && comparable(r) == comparable(&target)
                            && r.imported_from_revision == target.imported_from_revision)
                })
            {
                op.states[i] = "applied".into();
            }
        }
        Ok(())
    }
    fn receipt(op: &Operation) -> MemoryImportReceipt {
        let mut receipt = MemoryImportReceipt {
            operation_id: op.id.clone(),
            plan_hash: op.plan.plan_hash.clone(),
            status: "completed".into(),
            created: 0,
            applied: 0,
            kept: 0,
            items: vec![],
            error: op.error.clone(),
        };
        for (item, state) in op.plan.items.iter().zip(&op.states) {
            if state == "applied" {
                if item.action == "create" {
                    receipt.created += 1;
                } else {
                    receipt.applied += 1;
                }
            } else if state == "kept" {
                receipt.kept += 1;
            } else {
                receipt.status = "partial".into();
            }
            receipt.items.push(ImportItemReceipt {
                id: item.id.clone(),
                action: item.action.clone(),
                state: state.clone(),
                resulting_revision: (state == "applied")
                    .then(|| item.expected_revision.unwrap_or(0) + 1),
            });
        }
        receipt
    }
    fn run_import(
        &self,
        op: &mut Operation,
        fail_after: Option<usize>,
    ) -> Result<MemoryImportReceipt, MemoryError> {
        self.reconcile_import(op)?;
        op.error = None;
        for i in 0..op.plan.items.len() {
            if matches!(op.states[i].as_str(), "applied" | "kept") {
                continue;
            }
            let item = op.plan.items[i].clone();
            let result = (|| {
                let current = self.read_record(&item.id)?;
                if current.as_ref().map(hash) != item.expected_hash {
                    return err(
                        MemoryErrorKind::Conflict,
                        format!("record {} changed after import was accepted", item.id),
                    );
                }
                if item.action == "keep" {
                    op.states[i] = "kept".into();
                    return Self::write_json(&self.import_path(&op.id), op);
                }
                op.states[i] = "applying".into();
                Self::write_json(&self.import_path(&op.id), op)?;
                let target = Self::target(op, &item);
                let revision = MemoryRevision {
                    record: target.clone(),
                    action: if item.action == "create" {
                        "create"
                    } else {
                        "update"
                    }
                    .into(),
                    actor: op.actor.clone(),
                    at_ms: op.at_ms,
                    note: Some(format!("import:{}", op.id)),
                };
                Self::write_json(
                    &self
                        .history_dir(&item.id)
                        .join(format!("{:016}.json", target.revision)),
                    &revision,
                )?;
                Self::write_json(&self.record_path(&item.id), &target)?;
                self.index.upsert(&target);
                if fail_after == Some(i + 1) {
                    return err(
                        MemoryErrorKind::Io,
                        "injected disk failure after record commit before receipt",
                    );
                }
                op.states[i] = "applied".into();
                Self::write_json(&self.import_path(&op.id), op)
            })();
            if let Err(error) = result {
                op.error = Some(error.to_string());
                self.reconcile_import(op)?;
                // The original accepted operation is already durable even if
                // a full disk also prevents this explanatory checkpoint.
                let _ = Self::write_json(&self.import_path(&op.id), op);
                return Ok(Self::receipt(op));
            }
        }
        Self::write_json(&self.import_path(&op.id), op)?;
        Ok(Self::receipt(op))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store(tag: &str) -> MemoryStore {
        MemoryStore::open(&std::env::temp_dir().join(format!(
            "import-{tag}-{}-{}",
            std::process::id(),
            MEMORY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        )))
    }
    fn record(id: &str) -> MemoryRecord {
        serde_json::from_value(json!({"id":id,"revision":1,"scope":{"owner":"local","workspace":"ws","bot":"bot","conversation":"room"},"kind":"fact","content":id,"createdAtMs":10,"validFromMs":10,"status":"active","useCount":0,"recordedAtMs":10})).unwrap()
    }
    fn bundle(records: Vec<MemoryRecord>) -> serde_json::Value {
        json!({"format":"knorvia-memory-export","version":1,"records":records})
    }
    #[test]
    fn entire_bundle_validation_is_zero_write_and_equal_revision_content_conflicts() {
        let store = store("preflight");
        let good = bundle(vec![record("mem_a"), record("mem_b")]);
        for mutate in 0..6 {
            let mut bad = good.clone();
            match mutate {
                0 => bad["version"] = json!(2),
                1 => bad["records"][1]["content"] = json!(42),
                2 => bad["records"][1]["status"] = json!("bogus"),
                3 => bad["records"][1]["id"] = json!("mem_a"),
                4 => {
                    bad["records"][1]["relation"] =
                        json!({"targetId":"missing","relationType":"ref"})
                }
                _ => {
                    bad["records"][1]["sharedScopes"] = json!([{"owner":"other","workspace":"ws","bot":"bot","conversation":"room"}])
                }
            }
            assert!(store.import(&bad, "user").is_err());
            assert!(!store.root.exists(), "invalid item {mutate} wrote to disk");
        }
        let plan = store.plan_import(&good).unwrap();
        assert!(!store.root.exists());
        let receipt = store
            .apply_import(&good, &plan.plan_hash, "operation_test", "user")
            .unwrap();
        assert_eq!(receipt.created, 2);
        let mut conflict = good.clone();
        conflict["records"][1]["content"] = json!("different same revision");
        let plan = store.plan_import(&conflict).unwrap();
        assert_eq!(plan.conflicts, 1);
        assert_eq!(plan.items[1].action, "conflict");
        assert!(
            store
                .apply_import(&conflict, &plan.plan_hash, "operation_conflict", "user")
                .is_err()
        );
        assert!(!store.import_path("operation_conflict").exists());
        assert_eq!(store.read_history("mem_b").unwrap().len(), 1);
    }
    #[test]
    fn stale_plan_and_scope_change_are_rejected_and_forgotten_is_preserved() {
        let store = store("stale");
        let mut source = record("mem_a");
        let good = bundle(vec![source.clone()]);
        store.import(&good, "user").unwrap();
        source.revision = 3;
        source.content = "new".into();
        let newer = bundle(vec![source.clone()]);
        let plan = store.plan_import(&newer).unwrap();
        assert_eq!(plan.items[0].action, "update");
        store.forget("mem_a", Some(1), "user").unwrap();
        assert!(
            store
                .apply_import(&newer, &plan.plan_hash, "stale_operation", "user")
                .is_err()
        );
        assert!(!store.import_path("stale_operation").exists());
        let plan = store.plan_import(&newer).unwrap();
        assert_eq!(plan.items[0].action, "keep");
        store
            .apply_import(&newer, &plan.plan_hash, "keep_forgotten", "user")
            .unwrap();
        assert_eq!(
            store.read_record("mem_a").unwrap().unwrap().status,
            FORGOTTEN
        );
        source.scope.conversation = "other_room".into();
        let plan = store.plan_import(&bundle(vec![source])).unwrap();
        assert_eq!(plan.items[0].action, "conflict");
    }
    #[test]
    fn restart_after_second_record_commit_reconciles_receipts_and_never_repeats_history() {
        let store = store("crash");
        let good = bundle(vec![record("mem_a"), record("mem_b"), record("mem_c")]);
        let plan = store.plan_import(&good).unwrap();
        let id = "crashed_operation";
        let mut op = Operation {
            id: id.into(),
            states: vec!["pending".into(); 3],
            plan: plan.clone(),
            actor: "user".into(),
            at_ms: 12,
            error: None,
        };
        MemoryStore::write_json(&store.import_path(id), &op).unwrap();
        let receipt = store.run_import(&mut op, Some(2)).unwrap();
        assert_eq!(receipt.status, "partial");
        assert_eq!(receipt.created, 2);
        assert_eq!(receipt.items[2].state, "pending");
        // Emulate failure of the receipt checkpoint itself: disk retains the
        // pre-commit applying state but durable history/current prove item2.
        op.states[1] = "applying".into();
        MemoryStore::write_json(&store.import_path(id), &op).unwrap();
        let reopened = MemoryStore::open(store.root.parent().unwrap().parent().unwrap());
        assert_eq!(reopened.import_receipt(id).unwrap().created, 2);
        reopened.forget("mem_b", Some(1), "user").unwrap();
        let receipt = reopened.resume_import(id).unwrap();
        assert_eq!(receipt.status, "completed");
        assert_eq!(receipt.created, 3);
        let again = reopened
            .apply_import(&good, &plan.plan_hash, id, "user")
            .unwrap();
        assert_eq!(again.created, 3);
        assert_eq!(reopened.read_history("mem_a").unwrap().len(), 1);
        assert_eq!(reopened.read_history("mem_b").unwrap().len(), 2);
        assert_eq!(reopened.read_history("mem_c").unwrap().len(), 1);
        assert_eq!(
            reopened.read_record("mem_b").unwrap().unwrap().status,
            FORGOTTEN
        );
    }
    #[test]
    fn changed_pending_item_returns_partial_receipt_without_overwriting_it() {
        let store = store("pending");
        let good = bundle(vec![record("mem_a"), record("mem_b"), record("mem_c")]);
        let plan = store.plan_import(&good).unwrap();
        let mut op = Operation {
            id: "partial_operation".into(),
            states: vec!["pending".into(); 3],
            plan,
            actor: "user".into(),
            at_ms: 12,
            error: None,
        };
        MemoryStore::write_json(&store.import_path(&op.id), &op).unwrap();
        store.run_import(&mut op, Some(2)).unwrap();
        let mut other = record("mem_c");
        other.scope.conversation = "other".into();
        store.import(&bundle(vec![other.clone()]), "user").unwrap();
        let receipt = store.resume_import(&op.id).unwrap();
        assert_eq!(receipt.status, "partial");
        assert_eq!(receipt.created, 2);
        assert!(receipt.error.unwrap().contains("changed after"));
        assert_eq!(
            store
                .read_record("mem_c")
                .unwrap()
                .unwrap()
                .scope
                .conversation,
            "other"
        );
    }
}
