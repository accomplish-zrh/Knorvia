//! Typed control-plane RPC for the memory store (route C).
//!
//! Every method is scope-first: the caller must present a scope query and
//! the store filters before anything is ranked or returned, so a secret
//! noted in one conversation can never be recalled into another. Wiring
//! (mod declaration + route arms) is A's; see mailbox to-A/C-001.

use super::*;
use knorvia_store::memory::{MemoryDraft, MemoryError, MemoryErrorKind, MemoryStore, ScopeQuery};

fn invalid(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(ErrorCategory::InvalidArgument, message.into())
}

fn memory_error(error: MemoryError) -> ProtocolError {
    let category = match error.kind {
        MemoryErrorKind::InvalidArgument => ErrorCategory::InvalidArgument,
        MemoryErrorKind::NotFound => ErrorCategory::NotFound,
        MemoryErrorKind::Conflict => ErrorCategory::Conflict,
        MemoryErrorKind::Corrupt | MemoryErrorKind::Io => ErrorCategory::Internal,
    };
    ProtocolError::new(category, error.to_string())
}

fn parse_scope(params: &Value) -> Result<ScopeQuery, ProtocolError> {
    let scope = params
        .get("scope")
        .ok_or_else(|| invalid("memory scope is required"))?;
    let owner = scope["owner"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("memory scope owner is required"))?;
    let axis = |key: &str| -> Result<Option<String>, ProtocolError> {
        match scope.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) if !text.is_empty() && text.len() <= 128 => {
                Ok(Some(text.clone()))
            }
            _ => Err(invalid("invalid memory scope axis")),
        }
    };
    Ok(ScopeQuery {
        owner: owner.to_string(),
        workspace: axis("workspace")?,
        bot: axis("bot")?,
        conversation: axis("conversation")?,
    })
}

fn parse_scope_exact(
    value: &Value,
    what: &str,
) -> Result<knorvia_store::memory::MemoryScope, ProtocolError> {
    let scope: knorvia_store::memory::MemoryScope = serde_json::from_value(value.clone())
        .map_err(|_| invalid(format!("invalid {what} scope")))?;
    Ok(scope)
}

// Legacy local management calls omit scope. Agent- or view-scoped calls
// must not bypass the same visibility checks by addressing a known id.
fn check_record_scope(store: &MemoryStore, params: &Value, id: &str) -> Result<(), ProtocolError> {
    if params.get("scope").is_some() {
        let scope = parse_scope(params)?;
        let record = store.read_record(id).map_err(memory_error)?;
        if record
            .as_ref()
            .is_none_or(|record| !scope.visible_from(record))
        {
            return Err(ProtocolError::new(
                ErrorCategory::NotFound,
                "Memory record is not visible in this scope",
            ));
        }
    }
    Ok(())
}

fn parse_source_refs(
    params: &Value,
) -> Result<Vec<knorvia_store::memory::MemorySourceRef>, ProtocolError> {
    match params.get("sourceRefs") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(refs)) => refs
            .iter()
            .map(|ref_value| {
                Ok(knorvia_store::memory::MemorySourceRef {
                    kind: ref_value["kind"].as_str().unwrap_or("external").to_string(),
                    id: ref_value["id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| invalid("source ref needs an id"))?
                        .to_string(),
                    note: ref_value["note"].as_str().map(str::to_string),
                })
            })
            .collect(),
        Some(_) => Err(invalid("sourceRefs must be an array")),
    }
}

impl ControlPlane {
    pub(crate) fn memory(&self) -> MemoryStore {
        MemoryStore::open(&self.store.paths().state)
    }

    pub(crate) fn rpc_memory_record(&self, params: &Value) -> Result<Value, ProtocolError> {
        let scope = parse_scope_exact(
            params
                .get("scope")
                .ok_or_else(|| invalid("memory scope is required"))?,
            "record",
        )?;
        let content = params["content"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid("memory content is required"))?;
        let kind = params["kind"].as_str().unwrap_or("fact");
        let store = self.memory();
        let draft = MemoryDraft {
            scope,
            kind: kind.to_string(),
            content: content.to_string(),
            source_refs: parse_source_refs(params)?,
            relation: params
                .get("relation")
                .and_then(|value| serde_json::from_value(value.clone()).ok()),
            valid_from_ms: None,
            valid_to_ms: params["validToMs"].as_u64(),
            pinned: params["pinned"].as_bool().unwrap_or(false),
            client_token: params["clientToken"].as_str().map(str::to_string),
        };
        let (record, created) = store
            .create(draft, params["actor"].as_str().unwrap_or("user"))
            .map_err(memory_error)?;
        Ok(json!({ "record": record, "created": created }))
    }

    pub(crate) fn rpc_memory_get(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = params["id"]
            .as_str()
            .ok_or_else(|| invalid("memory id is required"))?;
        check_record_scope(&self.memory(), params, id)?;
        let record = self.memory().read_record(id).map_err(memory_error)?;
        Ok(json!({ "record": record }))
    }

    pub(crate) fn rpc_memory_list(&self, params: &Value) -> Result<Value, ProtocolError> {
        let scope = parse_scope(params)?;
        let offset = params["offset"].as_u64().unwrap_or(0) as usize;
        let limit = params["limit"].as_u64().unwrap_or(100).clamp(1, 500) as usize;
        let include: Option<Vec<String>> = params
            .get("includeStatuses")
            .and_then(|value| serde_json::from_value(value.clone()).ok());
        let include_refs: Option<Vec<&str>> = include
            .as_ref()
            .map(|statuses| statuses.iter().map(String::as_str).collect());
        let (records, total) = self
            .memory()
            .list(&scope, include_refs.as_deref(), offset, limit)
            .map_err(memory_error)?;
        Ok(
            json!({ "records": records, "total": total, "paging": { "offset": offset, "limit": limit, "total": total } }),
        )
    }

    pub(crate) fn rpc_memory_search(&self, params: &Value) -> Result<Value, ProtocolError> {
        let query = params["query"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| invalid("memory query is required"))?;
        let scope = parse_scope(params)?;
        let limit = params["limit"].as_u64().unwrap_or(20).clamp(1, 100) as usize;
        let thread_id = params["threadId"].as_str().map(str::to_string);
        let turn_id = params["turnId"].as_str().map(str::to_string);
        let embeddings: Option<knorvia_store::memory::MemoryEmbeddingQuery> = params
            .get("embeddings")
            .map(|value| {
                serde_json::from_value(value.clone())
                    .map_err(|_| invalid("invalid embedding query"))
            })
            .transpose()?;
        let trace = self
            .memory()
            .recall_with_embeddings(
                query,
                &scope,
                limit,
                (thread_id, turn_id),
                embeddings.as_ref(),
            )
            .map_err(memory_error)?;
        let mut results = Vec::with_capacity(trace.hits.len());
        for hit in &trace.hits {
            if let Some(record) = self
                .memory()
                .read_record(&hit.record_id)
                .map_err(memory_error)?
            {
                results.push(json!({
                    "record": record,
                    "score": hit.score,
                    "matchedTerms": hit.matched_terms,
                    "reasons": hit.reasons,
                }));
            }
        }
        Ok(json!({ "results": results, "trace": trace }))
    }

    pub(crate) fn rpc_memory_forget(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = params["id"]
            .as_str()
            .ok_or_else(|| invalid("memory id is required"))?;
        check_record_scope(&self.memory(), params, id)?;
        let record = self
            .memory()
            .forget(
                id,
                params["expectedRevision"].as_u64(),
                params["actor"].as_str().unwrap_or("user"),
            )
            .map_err(memory_error)?;
        Ok(json!({ "record": record }))
    }

    pub(crate) fn rpc_memory_update(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = params["id"]
            .as_str()
            .ok_or_else(|| invalid("memory id is required"))?;
        check_record_scope(&self.memory(), params, id)?;
        let content = params["content"]
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| invalid("memory content is required"))?;
        let record = self
            .memory()
            .update(
                id,
                params["expectedRevision"].as_u64(),
                knorvia_store::memory::MemoryUpdate {
                    content: Some(content.into()),
                    ..knorvia_store::memory::MemoryUpdate::empty()
                },
                params["actor"].as_str().unwrap_or("user"),
            )
            .map_err(memory_error)?;
        Ok(json!({ "record": record }))
    }

    pub(crate) fn rpc_memory_restore(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = params["id"]
            .as_str()
            .ok_or_else(|| invalid("memory id is required"))?;
        check_record_scope(&self.memory(), params, id)?;
        let record = self
            .memory()
            .restore(
                id,
                params["expectedRevision"].as_u64(),
                params["actor"].as_str().unwrap_or("user"),
            )
            .map_err(memory_error)?;
        Ok(json!({ "record": record }))
    }

    pub(crate) fn rpc_memory_merge(&self, params: &Value) -> Result<Value, ProtocolError> {
        let source = params["sourceId"]
            .as_str()
            .ok_or_else(|| invalid("sourceId is required"))?;
        let target = params["targetId"]
            .as_str()
            .ok_or_else(|| invalid("targetId is required"))?;
        check_record_scope(&self.memory(), params, source)?;
        check_record_scope(&self.memory(), params, target)?;
        let (record, _) = self
            .memory()
            .merge(
                source,
                target,
                params["expectedRevision"].as_u64(),
                // B03 (night 2026-09-10): preview-then-execute needs the
                // survivor's revision pinned, not just the source's.
                params["expectedTargetRevision"].as_u64(),
                params["actor"].as_str().unwrap_or("user"),
            )
            .map_err(memory_error)?;
        Ok(json!({ "record": record }))
    }

    pub(crate) fn rpc_memory_share(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = params["id"]
            .as_str()
            .ok_or_else(|| invalid("memory id is required"))?;
        check_record_scope(&self.memory(), params, id)?;
        let parse_scopes =
            |key: &str| -> Result<Vec<knorvia_store::memory::MemoryScope>, ProtocolError> {
                match params.get(key) {
                    None | Some(Value::Null) => Ok(Vec::new()),
                    Some(Value::Array(scopes)) => scopes
                        .iter()
                        .map(|scope| parse_scope_exact(scope, key))
                        .collect(),
                    Some(_) => Err(invalid(format!("{key} must be an array"))),
                }
            };
        let add = parse_scopes("addScopes")?;
        let remove = parse_scopes("removeScopes")?;
        let record = self
            .memory()
            .share(
                id,
                params["expectedRevision"].as_u64(),
                add,
                remove,
                params["actor"].as_str().unwrap_or("user"),
            )
            .map_err(memory_error)?;
        Ok(json!({ "record": record }))
    }

    pub(crate) fn rpc_memory_pin(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = params["id"]
            .as_str()
            .ok_or_else(|| invalid("memory id is required"))?;
        check_record_scope(&self.memory(), params, id)?;
        let pinned = params["pinned"]
            .as_bool()
            .ok_or_else(|| invalid("pinned is required"))?;
        let record = self
            .memory()
            .pin(
                id,
                params["expectedRevision"].as_u64(),
                pinned,
                params["actor"].as_str().unwrap_or("user"),
            )
            .map_err(memory_error)?;
        Ok(json!({ "record": record }))
    }

    pub(crate) fn rpc_memory_timeline(&self, params: &Value) -> Result<Value, ProtocolError> {
        let store = self.memory();
        let limit = params["limit"].as_u64().unwrap_or(300).clamp(1, 2_000) as usize;
        let from = params["fromMs"].as_u64();
        let to = params["toMs"].as_u64();
        if let Some(record_id) = params["recordId"].as_str() {
            check_record_scope(&store, params, record_id)?;
            store
                .read_record(record_id)
                .map_err(memory_error)?
                .ok_or_else(|| {
                    ProtocolError::new(
                        ErrorCategory::NotFound,
                        format!("memory record {record_id} not found"),
                    )
                })?;
            let scope = params
                .get("scope")
                .map(|_| parse_scope(params))
                .transpose()?;
            let events: Vec<_> = store
                .read_history(record_id)
                .map_err(memory_error)?
                .into_iter()
                .filter(|event| {
                    scope
                        .as_ref()
                        .is_none_or(|scope| scope.visible_from(&event.record))
                })
                .filter(|event| {
                    from.is_none_or(|from| event.at_ms >= from)
                        && to.is_none_or(|to| event.at_ms <= to)
                })
                .take(limit)
                .collect();
            return Ok(json!({ "events": events }));
        }
        let scope = parse_scope(params)?;
        let events = store
            .timeline(&scope, from, to, limit)
            .map_err(memory_error)?;
        let mut current = HashMap::new();
        let mut output = Vec::new();
        for event in events {
            if !current.contains_key(&event.record.id) {
                current.insert(
                    event.record.id.clone(),
                    store.read_record(&event.record.id).map_err(memory_error)?,
                );
            }
            let mut value =
                serde_json::to_value(&event).map_err(|error| invalid(error.to_string()))?;
            if let Some(Some(record)) = current.get(&event.record.id) {
                value["currentStatus"] = json!(record.status);
                value["currentRevision"] = json!(record.revision);
                value["currentPinned"] = json!(record.pinned);
            }
            output.push(value);
        }
        Ok(json!({ "events": output }))
    }

    pub(crate) fn rpc_memory_graph(&self, params: &Value) -> Result<Value, ProtocolError> {
        let scope = parse_scope(params)?;
        let include_forgotten = params["includeForgotten"].as_bool().unwrap_or(false);
        let limit = params["limit"].as_u64().unwrap_or(300).clamp(1, 1_000) as usize;
        let graph = self
            .memory()
            .graph(&scope, include_forgotten, limit)
            .map_err(memory_error)?;
        Ok(serde_json::to_value(graph)
            .map_err(|error| ProtocolError::new(ErrorCategory::Internal, error.to_string()))?)
    }

    pub(crate) fn rpc_memory_recall_trace(&self, params: &Value) -> Result<Value, ProtocolError> {
        let id = params["id"]
            .as_str()
            .ok_or_else(|| invalid("recall trace id is required"))?;
        let trace = self.memory().read_recall_trace(id).map_err(memory_error)?;
        if params.get("scope").is_some() {
            let scope = parse_scope(params)?;
            if trace
                .as_ref()
                .is_none_or(|trace| !scope.includes_trace_scope(&trace.scope))
            {
                return Err(ProtocolError::new(
                    ErrorCategory::NotFound,
                    "Recall trace is not visible in this scope",
                ));
            }
        }
        Ok(json!({ "trace": trace }))
    }

    pub(crate) fn rpc_memory_export(&self, params: &Value) -> Result<Value, ProtocolError> {
        let scope = parse_scope(params)?;
        self.memory().export(&scope).map_err(memory_error)
    }

    pub(crate) fn rpc_memory_import(&self, params: &Value) -> Result<Value, ProtocolError> {
        let memory = self.memory();
        let actor = params["actor"].as_str().unwrap_or("user");
        let action = params["action"].as_str().unwrap_or("import");
        let result = match action {
            "receipt" => serde_json::to_value(
                memory
                    .import_receipt(required_str(params, "operationId")?)
                    .map_err(memory_error)?,
            ),
            "resume" => serde_json::to_value(
                memory
                    .resume_import(required_str(params, "operationId")?)
                    .map_err(memory_error)?,
            ),
            "plan" => serde_json::to_value(
                memory
                    .plan_import(
                        params
                            .get("bundle")
                            .ok_or_else(|| invalid("bundle is required"))?,
                    )
                    .map_err(memory_error)?,
            ),
            "apply" => serde_json::to_value(
                memory
                    .apply_import(
                        params
                            .get("bundle")
                            .ok_or_else(|| invalid("bundle is required"))?,
                        required_str(params, "planHash")?,
                        required_str(params, "operationId")?,
                        actor,
                    )
                    .map_err(memory_error)?,
            ),
            "import" => {
                let bundle = params
                    .get("bundle")
                    .ok_or_else(|| invalid("bundle is required"))?;
                return serde_json::to_value(
                    memory
                        .import_with_receipt(bundle, actor)
                        .map_err(memory_error)?,
                )
                .map_err(|e| invalid(e.to_string()));
            }
            _ => return Err(invalid("unknown memory import action")),
        };
        result.map_err(|e| invalid(e.to_string()))
    }
}

#[cfg(test)]
mod memory_rpc_tests {
    use super::*;
    use knorvia_store::memory::MemoryScope;

    fn scope_of(conversation: &str) -> MemoryScope {
        MemoryScope {
            owner: "local".into(),
            workspace: "ws".into(),
            bot: "bot-a".into(),
            conversation: conversation.into(),
        }
    }

    fn create(plane: &ControlPlane, conversation: &str, content: &str) -> Value {
        plane
            .rpc_memory_record(&json!({
                "scope": scope_of(conversation),
                "kind": "fact",
                "content": content,
                "clientToken": format!("{conversation}:{content}"),
            }))
            .unwrap()
    }

    #[test]
    fn import_plan_apply_and_receipt_roundtrip_retains_original_operation() {
        let plane = crate::tests::plane();
        create(&plane, "g1", "original");
        let bundle = plane
            .rpc_memory_export(&json!({"scope":{"owner":"local"}}))
            .unwrap();
        let target = crate::tests::plane();
        let plan = target
            .rpc_memory_import(&json!({"action":"plan","bundle":bundle}))
            .unwrap();
        assert_eq!(plan["items"][0]["action"], "create");
        let receipt=target.rpc_memory_import(&json!({"action":"apply","bundle":bundle,"planHash":plan["planHash"],"operationId":"rpc_import"})).unwrap();
        assert_eq!(receipt["created"], 1);
        assert_eq!(
            target
                .rpc_memory_import(&json!({"action":"receipt","operationId":"rpc_import"}))
                .unwrap(),
            receipt
        );
        assert_eq!(
            target
                .rpc_memory_import(&json!({"action":"resume","operationId":"rpc_import"}))
                .unwrap(),
            receipt
        );
    }

    #[test]
    fn cross_conversation_secret_is_invisible_through_the_rpc() {
        let plane = crate::tests::plane();
        create(&plane, "g1", "G1 密码是 lantern");
        let leaked = plane
            .rpc_memory_search(&json!({
                "query": "lantern",
                "scope": { "owner": "local", "workspace": "ws", "bot": "bot-a", "conversation": "g2" },
            }))
            .unwrap();
        assert_eq!(
            leaked["results"].as_array().unwrap().len(),
            0,
            "G2 never sees G1 secrets"
        );
        let own = plane
            .rpc_memory_search(&json!({
                "query": "lantern",
                "scope": { "owner": "local", "workspace": "ws", "bot": "bot-a", "conversation": "g1" },
            }))
            .unwrap();
        let results = own["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0]["matchedTerms"].as_array().unwrap().len() >= 1);
        // the recall left a durable trace with the real hit reason
        let trace_id = own["trace"]["id"].as_str().unwrap();
        let trace = plane
            .rpc_memory_recall_trace(&json!({ "id": trace_id }))
            .unwrap();
        assert_eq!(trace["trace"]["hits"].as_array().unwrap().len(), 1);
        // idempotent replay via clientToken
        let replay = create(&plane, "g1", "G1 密码是 lantern");
        assert_eq!(replay["created"], json!(false));
    }

    #[test]
    fn forget_and_restore_flow_through_rpc_with_revision_checks() {
        let plane = crate::tests::plane();
        let created = create(&plane, "g1", "marmalade fact");
        let id = created["record"]["id"].as_str().unwrap().to_string();
        let revision = created["record"]["revision"].as_u64().unwrap();
        let forgotten = plane
            .rpc_memory_forget(&json!({ "id": id, "expectedRevision": revision }))
            .unwrap();
        assert_eq!(forgotten["record"]["status"], json!("forgotten"));
        let stale = plane.rpc_memory_restore(&json!({ "id": id, "expectedRevision": revision }));
        assert_eq!(stale.unwrap_err().category, ErrorCategory::Conflict);
        plane
            .rpc_memory_restore(&json!({ "id": id, "expectedRevision": revision + 1 }))
            .unwrap();
        // timeline shows the full audited story
        let events = plane
            .rpc_memory_timeline(&json!({
                "scope": { "owner": "local", "workspace": "ws", "bot": "bot-a", "conversation": "g1" },
            }))
            .unwrap();
        let actions: Vec<&str> = events["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["action"].as_str().unwrap())
            .collect();
        assert_eq!(actions, vec!["create", "forget", "restore"]);
    }

    #[test]
    fn addressed_records_and_traces_cannot_bypass_conversation_scope() {
        let plane = crate::tests::plane();
        let created = create(&plane, "g1", "private lantern");
        let id = &created["record"]["id"];
        let wrong = json!({"id":id,"recordId":id,"scope":scope_of("g2")});
        assert_eq!(
            plane.rpc_memory_get(&wrong).unwrap_err().category,
            ErrorCategory::NotFound
        );
        assert_eq!(
            plane.rpc_memory_forget(&wrong).unwrap_err().category,
            ErrorCategory::NotFound
        );
        assert_eq!(
            plane.rpc_memory_timeline(&wrong).unwrap_err().category,
            ErrorCategory::NotFound
        );
        let trace = plane
            .rpc_memory_search(&json!({"query":"lantern","scope":scope_of("g1")}))
            .unwrap();
        assert_eq!(
            plane
                .rpc_memory_recall_trace(&json!({"id":trace["trace"]["id"],"scope":scope_of("g2")}))
                .unwrap_err()
                .category,
            ErrorCategory::NotFound
        );
        let updated = plane
            .rpc_memory_update(
                &json!({"id":id,"scope":scope_of("g1"),"expectedRevision":1,"content":"new fact"}),
            )
            .unwrap();
        assert_eq!(updated["record"]["revision"], 2);
        assert_eq!(updated["record"]["content"], "new fact");
    }

    #[test]
    fn share_widens_and_account_wide_publish_is_refused() {
        let plane = crate::tests::plane();
        let created = create(&plane, "g1", "shareable fact");
        let id = created["record"]["id"].as_str().unwrap().to_string();
        let everywhere =
            json!({ "owner": "local", "workspace": "*", "bot": "*", "conversation": "*" });
        assert_eq!(
            plane
                .rpc_memory_share(&json!({ "id": id, "addScopes": [everywhere] }))
                .unwrap_err()
                .category,
            ErrorCategory::InvalidArgument,
            "account-level publishing is refused"
        );
        plane
            .rpc_memory_share(&json!({
                "id": id,
                "addScopes": [scope_of("g2")],
            }))
            .unwrap();
        let visible = plane
            .rpc_memory_list(&json!({
                "scope": { "owner": "local", "workspace": "ws", "bot": "bot-a", "conversation": "g2" },
            }))
            .unwrap();
        assert_eq!(
            visible["records"].as_array().unwrap().len(),
            1,
            "explicit share makes it visible in g2"
        );
    }

    #[test]
    fn graph_only_contains_real_records_and_dropping_owner_is_invalid() {
        let plane = crate::tests::plane();
        create(&plane, "g1", "node content");
        let graph = plane
            .rpc_memory_graph(&json!({
                "scope": { "owner": "local", "workspace": "ws", "bot": "bot-a", "conversation": "g1" },
            }))
            .unwrap();
        assert_eq!(graph["nodes"].as_array().unwrap().len(), 1);
        assert_eq!(graph["edges"].as_array().unwrap().len(), 0);
        let empty = plane
            .rpc_memory_graph(&json!({
                "scope": { "owner": "local", "workspace": "ws", "bot": "bot-a", "conversation": "other" },
            }))
            .unwrap();
        assert_eq!(
            empty["nodes"].as_array().unwrap().len(),
            0,
            "no fabricated nodes"
        );
        assert!(
            plane
                .rpc_memory_list(&json!({ "scope": { "workspace": "ws" } }))
                .is_err()
        );
    }
}
