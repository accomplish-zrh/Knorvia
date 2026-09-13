//! Durable per-turn token usage ledger.
//!
//! One record per product Turn is written at turn terminal from the Turn's
//! final `tokenUsage` item. The record keeps the Kernel's two counting
//! semantics apart: the per-turn delta (`last`) is the request-level fact the
//! summaries aggregate, while the thread-cumulative snapshot (`total`) is a
//! watermark used only to prove that replays do not add consumption. Summary
//! queries must never re-add cumulative snapshots.

use crate::{ProductStore, StoreError};
use knorvia_protocol::Item;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Counting semantics annotations the product guarantees. `cachedInputTokens`
/// is a subset of `inputTokens` (OpenAI prompt-cache semantics) and
/// `reasoningOutputTokens` is a subset of `outputTokens`; neither may be
/// added a second time on top of its parent field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub thread_id: String,
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kernel_thread_id: Option<String>,
    /// Product turn terminal state (`completed`, `failed`, `cancelled`,
    /// `interrupted`). `known` completeness requires `completed`.
    pub turn_status: String,
    /// Model configured for the thread when the turn ran. Attribution is the
    /// thread's selection, not a per-provider response fact; when no model is
    /// attributable this is `"unknown"` and consumers must show unknown, not
    /// a fabricated name.
    pub model: String,
    /// Gateway provider id the thread was configured with (currently always
    /// `knorvia`, the Responses-only gateway profile).
    pub provider_id: String,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_write_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
    pub model_context_window: Option<u64>,
    /// `known` (completed turn, usage reported), `partial` (non-completed
    /// terminal turn, usage reported up to the interruption), or `unknown`
    /// (no usage fact arrived). Unknown is never written as zeros.
    pub completeness: String,
    /// Per-field cache-reporting presence, captured from the tokenUsage
    /// payload at derivation time. `None` means the payload shape did not
    /// say (legacy records): consumers must show cache hit ratio as
    /// unknown for those turns, never as a measured 0%.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_fields_reported: Option<CacheFieldsReported>,
    pub recorded_at_ms: u64,
}

/// Which cache fields the upstream actually reported. `cachedInputTokens`
/// is a subset of `inputTokens` and `cacheWriteInputTokens` is billing
/// input on Anthropic-style APIs; a missing field is "not reported", not
/// a measured zero.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheFieldsReported {
    pub cached_input: bool,
    pub cache_write: bool,
}

fn usage_dir(state: &PathBuf, thread_id: &str) -> PathBuf {
    state.join("product").join("usage").join(thread_id)
}

fn sanitize(id: &str) -> Result<(), StoreError> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(StoreError::Corrupt(format!("unsafe usage id {id:?}")));
    }
    Ok(())
}

fn usage_from_item(item: &Item) -> Option<(serde_json::Value, bool)> {
    if item.kind != "tokenUsage" {
        return None;
    }
    let usage = item.payload.get("tokenUsage")?;
    let complete = item.status == "completed";
    Some((usage.clone(), complete))
}

impl ProductStore {
    /// Media summaries scan the job store once, not once for every workspace.
    pub fn visit_usage_jobs(
        &self,
        mut visit: impl FnMut(knorvia_protocol::Job) -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        for job in self.usage_query_snapshot(None, None, None, None)?.jobs {
            visit(job)?;
        }
        Ok(())
    }

    /// Visit the entire ledger once without a UI page limit or an N-page rescan.
    /// Read errors are surfaced rather than turning missing facts into zero usage.
    pub fn visit_usage_in_range(
        &self,
        from_ms: Option<u64>,
        to_ms: Option<u64>,
        mut visit: impl FnMut(UsageRecord) -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        for record in self
            .usage_query_snapshot(from_ms, to_ms, None, None)?
            .records
        {
            visit(record)?;
        }
        Ok(())
    }

    fn usage_path(&self, thread_id: &str, turn_id: &str) -> PathBuf {
        usage_dir(&self.paths().state.clone(), thread_id).join(format!("{turn_id}.json"))
    }

    /// Persist the usage fact for a finished Turn. The first write wins: a
    /// later recovery/replay that re-derives the same Turn must never create
    /// a second record (transport replays are not new consumption).
    pub fn record_usage(&self, record: &UsageRecord) -> Result<bool, StoreError> {
        let _mutation = self.lock_mutations()?;
        let first_ledger = !self.paths().state.join("product").join("usage").exists();
        sanitize(&record.thread_id)?;
        sanitize(&record.turn_id)?;
        let path = self.usage_path(&record.thread_id, &record.turn_id);
        if path.exists() {
            return Ok(false);
        }
        let bytes = serde_json::to_vec_pretty(record)?;
        crate::atomic_write(&path, &bytes)?;
        if self.note_usage_record(record, first_ledger).is_err() {
            let _ = self.invalidate_usage_index();
        }
        Ok(true)
    }

    /// Deterministically ordered page over the usage ledger, oldest first.
    /// `(usage, total)` — `total` is the whole-ledger size so clients can
    /// page without re-reading everything.
    pub fn list_usage(
        &self,
        offset: usize,
        limit: usize,
    ) -> Result<(Vec<UsageRecord>, usize), StoreError> {
        self.list_usage_in_range(offset, limit, None, None)
    }

    /// Like [`Self::list_usage`] but restricted to records whose
    /// `recorded_at_ms` falls in `[from_ms, to_ms]` (inclusive; `None` is
    /// unbounded). Sorting stays deterministic.
    pub fn list_usage_in_range(
        &self,
        offset: usize,
        limit: usize,
        from_ms: Option<u64>,
        to_ms: Option<u64>,
    ) -> Result<(Vec<UsageRecord>, usize), StoreError> {
        let mut records = self
            .usage_query_snapshot(from_ms, to_ms, None, None)?
            .records;
        records.sort_by(|a, b| {
            a.recorded_at_ms
                .cmp(&b.recorded_at_ms)
                .then_with(|| a.thread_id.cmp(&b.thread_id))
                .then_with(|| a.turn_id.cmp(&b.turn_id))
        });
        let total = records.len();
        Ok((
            records
                .into_iter()
                .skip(offset)
                .take(limit.min(500))
                .collect(),
            total,
        ))
    }

    /// Derive the usage record for one terminal Turn from its durable items.
    /// Public for the runner and tests; callers pass the turn's items and the
    /// attribution facts the runner owns.
    pub fn build_usage_record(
        items: &[Item],
        thread_id: &str,
        turn_id: &str,
        turn_status: &str,
        model: &str,
        provider_id: &str,
        recorded_at_ms: u64,
    ) -> Option<UsageRecord> {
        let mut seen = std::collections::HashSet::new();
        let mut per_turn = serde_json::json!({});
        let mut final_usage = None;
        let fields = [
            "inputTokens",
            "cachedInputTokens",
            "cacheWriteInputTokens",
            "outputTokens",
            "reasoningOutputTokens",
            "totalTokens",
        ];
        for (usage, complete) in items.iter().filter_map(usage_from_item) {
            // `last` is one model request, not one product Turn. The thread
            // cumulative watermark distinguishes repeated identical request
            // costs while suppressing replayed notifications.
            let watermark = usage
                .get("total")
                .cloned()
                .unwrap_or_else(|| usage["last"].clone())
                .to_string();
            if !seen.insert(watermark) {
                continue;
            }
            for name in fields {
                let current = per_turn[name].as_u64().unwrap_or(0);
                let delta = usage["last"][name].as_u64().unwrap_or(0);
                per_turn[name] = serde_json::json!(current.saturating_add(delta));
            }
            final_usage = Some((usage, complete));
        }
        let (usage, reported_complete) = final_usage?;
        let totals = usage.get("total").cloned().unwrap_or_default();
        let field = |parent: &serde_json::Value, name: &str| {
            parent
                .get(name)
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0)
        };
        let any_reported = ["inputTokens", "outputTokens", "totalTokens"]
            .iter()
            .any(|name| field(&per_turn, name) > 0 || field(&totals, name) > 0);
        let completeness = if reported_complete && turn_status == "completed" {
            "known"
        } else if any_reported {
            "partial"
        } else {
            "unknown"
        };
        // Cache presence is read from the final usage payload: a key that
        // is present-and-numeric was reported; an absent key (or an
        // explicit `cacheReportingKnown: false` hint) is "not reported",
        // which downstream must show as unknown rather than a 0 ratio.
        // When several model requests make up the Turn, a field counts as
        // reported only if every deduplicated request reported it.
        let mut cache_seen_cached = true;
        let mut cache_seen_write = true;
        let mut cache_requests = 0usize;
        for (usage, _) in items.iter().filter_map(usage_from_item) {
            let watermark = usage
                .get("total")
                .cloned()
                .unwrap_or_else(|| usage["last"].clone())
                .to_string();
            if !seen.contains(&watermark) {
                continue;
            }
            let last = &usage["last"];
            cache_requests += 1;
            if !last["cachedInputTokens"].is_number() {
                cache_seen_cached = false;
            }
            if !last["cacheWriteInputTokens"].is_number() {
                cache_seen_write = false;
            }
            // The owned Kernel adapter distinguishes normalized default
            // zeroes from actual cache-presence evidence. Without this
            // hint, direct provider/legacy items retain their old semantics.
            if last["cacheFieldsReported"]["cachedInput"] == serde_json::Value::Bool(false) {
                cache_seen_cached = false;
            }
            if last["cacheFieldsReported"]["cacheWrite"] == serde_json::Value::Bool(false) {
                cache_seen_write = false;
            }
            if last["cacheReportingKnown"] == serde_json::Value::Bool(false) {
                cache_seen_cached = false;
                cache_seen_write = false;
            }
        }
        let cache_fields_reported = (cache_requests > 0).then_some(CacheFieldsReported {
            cached_input: cache_seen_cached,
            cache_write: cache_seen_write,
        });
        Some(UsageRecord {
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            parent_turn_id: None,
            kernel_thread_id: None,
            turn_status: turn_status.to_string(),
            model: model.to_string(),
            provider_id: provider_id.to_string(),
            input_tokens: field(&per_turn, "inputTokens"),
            cached_input_tokens: field(&per_turn, "cachedInputTokens"),
            cache_write_input_tokens: field(&per_turn, "cacheWriteInputTokens"),
            output_tokens: field(&per_turn, "outputTokens"),
            reasoning_output_tokens: field(&per_turn, "reasoningOutputTokens"),
            total_tokens: field(&per_turn, "totalTokens"),
            model_context_window: usage
                .get("modelContextWindow")
                .and_then(serde_json::Value::as_u64),
            completeness: completeness.to_string(),
            cache_fields_reported,
            recorded_at_ms,
        })
    }
}

#[cfg(test)]
mod usage_tests {
    use super::*;
    use crate::ProductStore;
    use knorvia_platform_paths::layout;
    use serde_json::json;

    fn store() -> (ProductStore, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "knorvia-usage-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        (ProductStore::open(layout(base.clone())).unwrap(), base)
    }

    fn item(turn: &str, seq: u64, input: u64, output: u64, total: u64, status: &str) -> Item {
        Item {
            id: format!("item_{seq}"),
            thread_id: "thr_t".into(),
            turn_id: turn.into(),
            kind: "tokenUsage".into(),
            status: status.into(),
            seq,
            payload: json!({"tokenUsage": {
                "last": {"inputTokens": input, "outputTokens": output, "totalTokens": total,
                    "cachedInputTokens": 0, "cacheWriteInputTokens": 0, "reasoningOutputTokens": 0},
                "total": {"inputTokens": input, "outputTokens": output, "totalTokens": total,
                    "cachedInputTokens": 0, "cacheWriteInputTokens": 0, "reasoningOutputTokens": 0},
                "modelContextWindow": 272_000
            }}),
        }
    }

    #[test]
    fn usage_record_is_first_write_wins_and_pages_deterministically() {
        let (store, base) = store();
        let items = [item("turn_1", 1, 100, 40, 140, "completed")];
        let record = ProductStore::build_usage_record(
            &items,
            "thr_t",
            "turn_1",
            "completed",
            "gpt-5.2",
            "knorvia",
            1_000,
        )
        .expect("usage derived from tokenUsage item");
        assert_eq!(record.completeness, "known");
        assert_eq!(record.input_tokens, 100);
        assert!(store.record_usage(&record).unwrap(), "first write wins");
        // A replay must not create a second fact or rewrite the first.
        assert!(!store.record_usage(&record).unwrap());
        let (page, total) = store.list_usage(0, 50).unwrap();
        assert_eq!(total, 1);
        assert_eq!(page.len(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn normalized_kernel_cache_presence_is_per_field_and_cannot_invent_zero_measurements() {
        let mut unknown = item("kernel-default", 1, 160, 40, 200, "completed");
        unknown.payload["tokenUsage"]["last"]["cacheFieldsReported"] =
            json!({"cachedInput":false,"cacheWrite":false});
        let record = ProductStore::build_usage_record(
            &[unknown.clone()],
            "thread",
            "turn",
            "completed",
            "model",
            "provider",
            1000,
        )
        .unwrap();
        assert_eq!(record.completeness, "known", "total tokens remain reported");
        assert_eq!(record.total_tokens, 200);
        assert_eq!(
            record.cache_fields_reported,
            Some(CacheFieldsReported {
                cached_input: false,
                cache_write: false
            })
        );
        unknown.payload["tokenUsage"]["last"]["cachedInputTokens"] = json!(120);
        unknown.payload["tokenUsage"]["last"]["cacheFieldsReported"]["cachedInput"] = json!(true);
        let positive = ProductStore::build_usage_record(
            &[unknown],
            "thread",
            "turn2",
            "completed",
            "model",
            "provider",
            1001,
        )
        .unwrap();
        assert_eq!(positive.cached_input_tokens, 120);
        assert_eq!(
            positive.cache_fields_reported,
            Some(CacheFieldsReported {
                cached_input: true,
                cache_write: false
            })
        );
    }

    #[test]
    fn usage_sums_model_requests_and_marks_incomplete_turns_partial() {
        let store_base = store();
        let items = [
            item("turn_2", 1, 10, 5, 15, "completed"),
            item("turn_2", 2, 30, 20, 50, "completed"),
            item("turn_2", 3, 35, 22, 57, "completed"),
        ];
        let record = ProductStore::build_usage_record(
            &items,
            "thr_t",
            "turn_2",
            "interrupted",
            "unknown-model",
            "knorvia",
            2_000,
        )
        .expect("usage derived");
        assert_eq!(
            record.input_tokens, 75,
            "all distinct request watermarks contribute"
        );
        assert_eq!(
            record.completeness, "partial",
            "non-completed terminal turn"
        );
        let missing = ProductStore::build_usage_record(
            &[],
            "thr_t",
            "turn_3",
            "failed",
            "gpt-5.2",
            "knorvia",
            3_000,
        );
        assert!(
            missing.is_none(),
            "no usage fact means no fabricated record"
        );
        let _ = store_base;
    }

    fn sparse_item(turn: &str, seq: u64, hint: Option<bool>) -> Item {
        let mut usage = json!({"last": {"inputTokens": 50, "outputTokens": 5, "totalTokens": 55}});
        if let Some(hint) = hint {
            usage["last"]["cacheReportingKnown"] = json!(hint);
        }
        Item {
            id: format!("item_{seq}"),
            thread_id: "thr_t".into(),
            turn_id: turn.into(),
            kind: "tokenUsage".into(),
            status: "completed".into(),
            seq,
            payload: json!({"tokenUsage": usage}),
        }
    }

    #[test]
    fn cache_presence_is_distinguished_from_measured_zero() {
        // Full payload: cache fields present-and-numeric are "reported",
        // even when the reported value is zero.
        let record = ProductStore::build_usage_record(
            &[item("turn_c1", 1, 100, 40, 140, "completed")],
            "thr_t",
            "turn_c1",
            "completed",
            "gpt-5.2",
            "knorvia",
            4_000,
        )
        .unwrap();
        assert_eq!(
            record.cache_fields_reported,
            Some(CacheFieldsReported {
                cached_input: true,
                cache_write: true
            }),
            "present zero is a reported zero"
        );
        // Sparse payload without cache keys: presence unknown, tokens keep
        // the zero fallback but the record says "not reported".
        let record = ProductStore::build_usage_record(
            &[sparse_item("turn_c2", 2, None)],
            "thr_t",
            "turn_c2",
            "completed",
            "claude-test",
            "knorvia",
            5_000,
        )
        .unwrap();
        assert_eq!(
            record.cache_fields_reported,
            Some(CacheFieldsReported {
                cached_input: false,
                cache_write: false
            }),
        );
        assert_eq!(record.cached_input_tokens, 0);
        // An explicit `cacheReportingKnown: false` hint wins over key
        // presence (adapters that forward zeros without knowledge).
        let record = ProductStore::build_usage_record(
            &[sparse_item("turn_c3", 3, Some(false))],
            "thr_t",
            "turn_c3",
            "completed",
            "claude-test",
            "knorvia",
            6_000,
        )
        .unwrap();
        assert_eq!(
            record.cache_fields_reported,
            Some(CacheFieldsReported {
                cached_input: false,
                cache_write: false
            }),
        );
        // Mixed requests in one turn: only every-request-reported counts.
        let record = ProductStore::build_usage_record(
            &[
                item("turn_c4", 4, 100, 40, 140, "completed"),
                sparse_item("turn_c4", 5, None),
            ],
            "thr_t",
            "turn_c4",
            "completed",
            "mixed",
            "knorvia",
            7_000,
        )
        .unwrap();
        assert_eq!(
            record.cache_fields_reported,
            Some(CacheFieldsReported {
                cached_input: false,
                cache_write: false
            }),
            "a request without cache keys makes every field's presence unknown"
        );
        // Legacy records written before the field existed still load; the
        // serde default is None, i.e. presence unknown, never a fake zero.
        let legacy: UsageRecord = serde_json::from_value(json!({
            "threadId": "thr_t", "turnId": "turn_c5", "turnStatus": "completed",
            "model": "gpt-5.2", "providerId": "knorvia",
            "inputTokens": 10, "cachedInputTokens": 0, "cacheWriteInputTokens": 0,
            "outputTokens": 5, "reasoningOutputTokens": 0, "totalTokens": 15,
            "completeness": "known", "recordedAtMs": 10_000
        }))
        .unwrap();
        assert_eq!(legacy.cache_fields_reported, None);
    }

    #[test]
    fn replayed_terminal_usage_never_rewrites_the_ledger() {
        let (store, base) = store();
        let items = [item("turn_r1", 1, 10, 5, 15, "completed")];
        let record = ProductStore::build_usage_record(
            &items,
            "thr_t",
            "turn_r1",
            "completed",
            "gpt-5.2",
            "knorvia",
            8_000,
        )
        .unwrap();
        assert!(store.record_usage(&record).unwrap());
        // A crash-recovery replay re-derives the same record; first write
        // wins so the ledger never double-counts.
        let replay = ProductStore::build_usage_record(
            &items,
            "thr_t",
            "turn_r1",
            "completed",
            "gpt-5.2",
            "knorvia",
            9_000,
        )
        .unwrap();
        assert!(!store.record_usage(&replay).unwrap());
        let (_, total) = store.list_usage(0, 50).unwrap();
        assert_eq!(total, 1);
        let _ = std::fs::remove_dir_all(&base);
    }
}
