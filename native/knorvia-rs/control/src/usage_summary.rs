use super::*;
use knorvia_store::UsageRecord;
use std::collections::BTreeMap;

fn invalid(message: &str) -> ProtocolError {
    ProtocolError::new(ErrorCategory::InvalidArgument, message)
}
fn optional_u64(params: &Value, key: &str) -> Result<Option<u64>, ProtocolError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| invalid("Invalid usage range")),
    }
}
fn optional_text<'a>(params: &'a Value, key: &str) -> Result<Option<&'a str>, ProtocolError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() && value.len() <= 256 => Ok(Some(value)),
        _ => Err(invalid("Invalid usage filter")),
    }
}
fn sum(bucket: &mut Value, key: &str, delta: u64) {
    bucket[key] = json!(bucket[key].as_u64().unwrap_or(0).saturating_add(delta));
}
fn add_tokens(bucket: &mut Value, record: &UsageRecord) {
    for (key, value) in [
        ("inputTokens", record.input_tokens),
        ("cachedInputTokens", record.cached_input_tokens),
        ("cacheWriteInputTokens", record.cache_write_input_tokens),
        ("outputTokens", record.output_tokens),
        ("reasoningOutputTokens", record.reasoning_output_tokens),
        ("totalTokens", record.total_tokens),
    ] {
        sum(bucket, key, value);
    }
}
fn day_at(ms: u64, offset: i64) -> String {
    let local_ms = i128::from(ms) - i128::from(offset) * 60_000;
    let days = local_ms.div_euclid(86_400_000) as i64;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

impl ControlPlane {
    pub(crate) fn rpc_usage_summary(&self, params: &Value) -> Result<Value, ProtocolError> {
        let from = optional_u64(params, "fromMs")?;
        let to = optional_u64(params, "toMs")?;
        if from.zip(to).is_some_and(|(a, b)| a > b) {
            return Err(invalid("Usage start must precede end"));
        }
        let offset = optional_u64(params, "offset")?.unwrap_or(0).min(1_000_000) as usize;
        let limit = optional_u64(params, "limit")?.unwrap_or(100).clamp(1, 500) as usize;
        let timezone = match params.get("timezoneOffsetMinutes") {
            None => 0,
            Some(value) => value
                .as_i64()
                .filter(|value| (-840..=840).contains(value))
                .ok_or_else(|| invalid("Invalid timezone offset"))?,
        };
        let model = optional_text(params, "model")?;
        let provider = optional_text(params, "providerId")?;
        let workspace = optional_text(params, "workspaceId")?;
        let bot = optional_text(params, "botId")?;
        let conversation = optional_text(params, "conversationId")?;
        let thread = optional_text(params, "threadId")?;
        let conversation_kind = optional_text(params, "conversationKind")?;
        if conversation_kind.is_some_and(|kind| !["group", "dm"].contains(&kind)) {
            return Err(invalid("Invalid conversation kind"));
        }
        // Include superseded bindings: historical usage keeps its original
        // room attribution after a Bot changes backend or starts a new session.
        let bindings = self
            .store
            .list_bindings(None, None)
            .map_err(|error| error.into_protocol())?;
        let rooms = self
            .store
            .list_rooms()
            .map_err(|error| error.into_protocol())?;
        let bots = self
            .store
            .list_bots()
            .map_err(|error| error.into_protocol())?;
        let room_kinds: HashMap<_, _> = rooms
            .iter()
            .map(|room| (room.id.as_str(), room.kind.as_str()))
            .collect();
        let mut ownership = HashMap::<String, (String, String)>::new();
        let mut ambiguous = std::collections::HashSet::new();
        for binding in &bindings {
            if let Some(thread_id) = &binding.knorvia_thread_id {
                let owner = (binding.bot_id.clone(), binding.conversation_id.clone());
                if ownership
                    .get(thread_id)
                    .is_some_and(|previous| previous != &owner)
                {
                    ambiguous.insert(thread_id.clone());
                } else {
                    ownership.insert(thread_id.clone(), owner);
                }
            }
        }
        for id in ambiguous {
            ownership.remove(&id);
        }
        let matches_owner = |thread_id: &str| {
            if thread.is_some_and(|id| id != thread_id) {
                return false;
            }
            if bot.is_none() && conversation.is_none() && conversation_kind.is_none() {
                return true;
            }
            ownership.get(thread_id).is_some_and(|(bot_id, room_id)| {
                bot.is_none_or(|id| id == bot_id)
                    && conversation.is_none_or(|id| id == room_id)
                    && conversation_kind
                        .is_none_or(|kind| room_kinds.get(room_id.as_str()) == Some(&kind))
            })
        };
        let mut records = Vec::new();
        let mut thread_workspaces = HashMap::<String, String>::new();
        self.store
            .visit_usage_in_range(from, to, |record| {
                if model.is_some_and(|value| value != record.model)
                    || provider.is_some_and(|value| value != record.provider_id)
                    || !matches_owner(&record.thread_id)
                {
                    return Ok(());
                }
                if let Some(expected) = workspace {
                    if !thread_workspaces.contains_key(&record.thread_id) {
                        let thread = self.store.read_thread(&record.thread_id)?;
                        thread_workspaces.insert(record.thread_id.clone(), thread.workspace_id);
                    }
                    if thread_workspaces.get(&record.thread_id).map(String::as_str)
                        != Some(expected)
                    {
                        return Ok(());
                    }
                }
                records.push(record);
                Ok(())
            })
            .map_err(|error| error.into_protocol())?;
        let mut totals = json!({"turns": records.len(), "knownTurns":0,"partialTurns":0,"unknownTurns":0,
            "inputTokens":0,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0,"totalTokens":0});
        // Cache accounting is honest about presence: only turns whose
        // upstream actually reported cache fields contribute to the hit
        // ratio; unreported turns stay in unknownTurns instead of a
        // fabricated 0%.
        let mut cache = json!({"knownTurns":0,"unknownTurns":0,"knownWriteTurns":0,"unknownWriteTurns":0,"fullyKnownTurns":0,"knownUncachedInputTokens":0,
            "knownInputTokens":0,"knownCachedInputTokens":0,"knownCacheWriteInputTokens":0,"hitRatio":Value::Null});
        let mut by_model = BTreeMap::<String, Value>::new();
        let mut by_provider = BTreeMap::<String, Value>::new();
        let mut by_day = BTreeMap::<String, Value>::new();
        let mut by_agent = BTreeMap::<String, Value>::new();
        let mut by_bot = BTreeMap::<String, Value>::new();
        let mut by_conversation = BTreeMap::<String, Value>::new();
        let mut billing_rows = BTreeMap::<String, Value>::new();
        for record in &records {
            sum(
                &mut totals,
                match record.completeness.as_str() {
                    "known" => "knownTurns",
                    "partial" => "partialTurns",
                    _ => "unknownTurns",
                },
                1,
            );
            add_tokens(&mut totals, record);
            let cache_reported = record
                .cache_fields_reported
                .map(|reported| reported.cached_input)
                .unwrap_or(false);
            if cache_reported {
                sum(&mut cache, "knownTurns", 1);
                sum(&mut cache, "knownInputTokens", record.input_tokens);
                sum(
                    &mut cache,
                    "knownCachedInputTokens",
                    record.cached_input_tokens,
                );
            } else {
                sum(&mut cache, "unknownTurns", 1);
            }
            if record
                .cache_fields_reported
                .is_some_and(|fields| fields.cache_write)
            {
                sum(&mut cache, "knownWriteTurns", 1);
                sum(
                    &mut cache,
                    "knownCacheWriteInputTokens",
                    record.cache_write_input_tokens,
                );
                if cache_reported {
                    sum(&mut cache, "fullyKnownTurns", 1);
                    sum(
                        &mut cache,
                        "knownUncachedInputTokens",
                        record
                            .input_tokens
                            .saturating_sub(record.cached_input_tokens)
                            .saturating_sub(record.cache_write_input_tokens),
                    );
                }
            } else {
                sum(&mut cache, "unknownWriteTurns", 1);
            }
            let role = if record.parent_turn_id.is_some() {
                "subAgent"
            } else {
                "main"
            };
            let bucket = by_agent.entry(role.into()).or_insert_with(
                || json!({"role":role,"turns":0,"knownTurns":0,"partialTurns":0,"unknownTurns":0}),
            );
            sum(bucket, "turns", 1);
            add_tokens(bucket, record);
            sum(
                bucket,
                match record.completeness.as_str() {
                    "known" => "knownTurns",
                    "partial" => "partialTurns",
                    _ => "unknownTurns",
                },
                1,
            );
            let bucket = by_model
                .entry(record.model.clone())
                .or_insert_with(|| json!({"model":record.model,"turns":0}));
            sum(bucket, "turns", 1);
            add_tokens(bucket, record);
            sum(
                bucket,
                match record.completeness.as_str() {
                    "known" => "knownTurns",
                    "partial" => "partialTurns",
                    _ => "unknownTurns",
                },
                1,
            );
            let bucket = by_provider
                .entry(record.provider_id.clone())
                .or_insert_with(|| json!({"providerId":record.provider_id,"turns":0}));
            sum(bucket, "turns", 1);
            add_tokens(bucket, record);
            if let Some((bot_id, room_id)) = ownership.get(&record.thread_id) {
                let bucket = by_bot
                    .entry(bot_id.clone())
                    .or_insert_with(|| json!({"botId":bot_id,"turns":0}));
                sum(bucket, "turns", 1);
                add_tokens(bucket, record);
                let bucket = by_conversation.entry(room_id.clone()).or_insert_with(|| json!({"conversationId":room_id,"kind":room_kinds.get(room_id.as_str()),"turns":0}));
                sum(bucket, "turns", 1);
                add_tokens(bucket, record);
            }
            // Price historical usage on the usage date, by provider. Never
            // estimate from a truncated page or apply today's rate to old turns.
            let billing_day = day_at(record.recorded_at_ms, 0);
            let cache_known = record
                .cache_fields_reported
                .is_some_and(|fields| fields.cached_input);
            let write_known = record
                .cache_fields_reported
                .is_some_and(|fields| fields.cache_write);
            let key = serde_json::to_string(&(
                &record.provider_id,
                &record.model,
                &billing_day,
                &record.completeness,
                cache_known,
                write_known,
            ))
            .unwrap();
            let bucket = billing_rows.entry(key).or_insert_with(|| json!({"providerId":record.provider_id,"model":record.model,"day":billing_day,"completeness":record.completeness,"cacheKnown":cache_known,"cacheWriteKnown":write_known,"turns":0}));
            sum(bucket, "turns", 1);
            add_tokens(bucket, record);
            let day = day_at(record.recorded_at_ms, timezone);
            let bucket = by_day
                .entry(day.clone())
                .or_insert_with(|| json!({"day":day,"turns":0,"totalTokens":0}));
            sum(bucket, "turns", 1);
            sum(bucket, "totalTokens", record.total_tokens);
        }
        let known_input = cache["knownInputTokens"].as_u64().unwrap_or(0);
        let known_cached = cache["knownCachedInputTokens"].as_u64().unwrap_or(0);
        if known_input > 0 {
            // Two-decimal fixed ratio keeps the value deterministic across
            // serialization paths; null stays "not measurable", never 0.
            cache["hitRatio"] =
                json!((known_cached as f64 / known_input as f64 * 10000.0).round() / 10000.0);
        }
        let mut media_rows = BTreeMap::<String, Value>::new();
        let mut media_jobs = 0u64;
        let mut unknown_jobs = 0u64;
        let mut legacy_dates = 0u64;
        self.store.visit_usage_jobs(|job| {
            if !["media.image", "media.video"].contains(&job.r#type.as_str()) { return Ok(()); }
            // Jobs without an attributable thread cannot be claimed by a Bot
            // or room filter. Their usage remains visible in the global view.
            if bot.is_some() || conversation.is_some() || conversation_kind.is_some() || thread.is_some() {
                let job_thread = job.checkpoint.as_ref().and_then(|value| value["threadId"].as_str());
                if !job_thread.is_some_and(matches_owner) { return Ok(()); }
            }
            if workspace.is_some_and(|value| value != job.workspace_id) { return Ok(()); }
            let Some(usage) = job.checkpoint.as_ref().and_then(|value| value.get("usage")) else { return Ok(()); };
            let provider_id = usage["providerId"].as_str().unwrap_or("unknown");
            let model_name = usage["model"].as_str().unwrap_or("unknown");
            if model.is_some_and(|value| value != model_name) || provider.is_some_and(|value| value != provider_id) { return Ok(()); }
            let fallback_time = job.updated_at.trim_end_matches("ms").parse::<u64>().ok();
            let fallback_attempt = vec![json!({"known":false})];
            let attempts = usage["attempts"].as_array().filter(|a| !a.is_empty()).unwrap_or(&fallback_attempt);
            let matching: Vec<_> = attempts.iter().filter(|attempt| {
                let time = attempt["recordedAtMs"].as_u64().or(fallback_time);
                time.is_some_and(|time| from.is_none_or(|from| time >= from) && to.is_none_or(|to| time <= to)) || (from.is_none() && to.is_none())
            }).collect();
            if matching.is_empty() { return Ok(()); }
            media_jobs += 1;
            let key = serde_json::to_string(&(provider_id, model_name))?;
            let bucket = media_rows.entry(key).or_insert_with(|| json!({"providerId":provider_id,"model":model_name,"jobs":0,"unknownAttempts":0,"units":{}}));
            sum(bucket, "jobs", 1);
            let mut any_unknown = false;
            for attempt in matching {
                if attempt["recordedAtMs"].as_u64().is_none() { legacy_dates += 1; }
                if attempt["known"].as_bool() != Some(true) { any_unknown = true; sum(bucket, "unknownAttempts", 1); continue; }
                if let Some(units) = attempt["units"].as_array() {
                    for unit in units {
                        let Some(name) = unit["name"].as_str() else { continue; };
                        let Some(value) = unit["value"].as_f64().filter(|value| value.is_finite() && *value >= 0.0) else { continue; };
                        let current = bucket["units"][name].as_f64().unwrap_or(0.0);
                        bucket["units"][name] = json!(current + value);
                    }
                }
            }
            if any_unknown { unknown_jobs += 1; }
            Ok(())
        }).map_err(|error| error.into_protocol())?;
        records.sort_by(|a, b| {
            b.recorded_at_ms
                .cmp(&a.recorded_at_ms)
                .then_with(|| a.thread_id.cmp(&b.thread_id))
                .then_with(|| a.turn_id.cmp(&b.turn_id))
        });
        let total = records.len();
        let page: Vec<_> = records.into_iter().skip(offset).take(limit).collect();
        Ok(
            json!({"totals":totals,"cache":cache,"byModel":by_model.into_values().collect::<Vec<_>>(),
            "byAgentRole":by_agent.into_values().collect::<Vec<_>>(),
            "byBot":by_bot.into_values().collect::<Vec<_>>(),"byConversation":by_conversation.into_values().collect::<Vec<_>>(),
            "billingRows":billing_rows.into_values().collect::<Vec<_>>(),
            "filterOptions":{"bots":bots.iter().map(|bot| json!({"id":bot.id,"name":bot.name})).collect::<Vec<_>>(),"conversations":rooms.iter().map(|room| json!({"id":room.id,"title":room.title,"kind":room.kind})).collect::<Vec<_>>()},
            "byProvider":by_provider.into_values().collect::<Vec<_>>(),"byDay":by_day.into_values().collect::<Vec<_>>(),
            "records":page,"paging":{"offset":offset,"limit":limit,"total":total},
            "appliedFilters":{"fromMs":from,"toMs":to,"model":model,"providerId":provider,"workspaceId":workspace,"botId":bot,"conversationId":conversation,"conversationKind":conversation_kind,"threadId":thread,"timezoneOffsetMinutes":timezone},
            "media":{"jobsScanned":media_jobs,"unknownJobs":unknown_jobs,"legacyTimestampAttempts":legacy_dates,"byProvider":media_rows.into_values().collect::<Vec<_>>(),
                "note":"Media units are separate from tokens. Historical attempts without a timestamp use the job update time."},
            "notes":["Totals include every matching record; paging only limits the detail records.",
                "Cached input and reasoning output are subsets and are not added twice.",
                "Unknown usage is not a measured zero. No provider prices or billing amounts are inferred.",
                "Cache hit ratio only counts turns whose provider actually reported cache fields; a null ratio means unknown, not zero.",
                "The daily chart uses the requested local timezone offset; historical DST changes require an explicit UTC view."]}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_day_crosses_utc_boundary_and_offsets_are_explicit() {
        assert_eq!(day_at(0, 0), "1970-01-01");
        assert_eq!(day_at(0, 60), "1969-12-31");
        assert_eq!(day_at(20 * 3_600_000, -480), "1970-01-02");
    }
    #[test]
    fn full_summary_is_independent_of_detail_page_and_filters_model() {
        let plane = crate::tests::plane();
        for n in 0..602 {
            plane
                .store
                .record_usage(&UsageRecord {
                    thread_id: "thr_usage".into(),
                    turn_id: format!("turn_{n}"),
                    turn_status: "completed".into(),
                    model: if n == 601 {
                        "other".into()
                    } else {
                        "fixture".into()
                    },
                    provider_id: "local".into(),
                    input_tokens: 2,
                    cached_input_tokens: 1,
                    cache_write_input_tokens: 0,
                    output_tokens: 3,
                    reasoning_output_tokens: 1,
                    total_tokens: 5,
                    model_context_window: None,
                    completeness: "known".into(),
                    cache_fields_reported: None,
                    recorded_at_ms: 1_000 + n,
                    parent_turn_id: if n % 2 == 0 {
                        Some("turn_parent".into())
                    } else {
                        None
                    },
                    kernel_thread_id: None,
                })
                .unwrap();
        }
        let result = plane
            .rpc_usage_summary(&json!({"limit":1,"offset":500}))
            .unwrap();
        assert_eq!(result["totals"]["totalTokens"], 3010);
        assert_eq!(result["records"].as_array().unwrap().len(), 1);
        assert_eq!(result["paging"]["total"], 602);
        assert_eq!(result["byAgentRole"][0]["totalTokens"], 1505);
        assert_eq!(result["byAgentRole"][1]["totalTokens"], 1505);
        let filtered = plane.rpc_usage_summary(&json!({"model":"other"})).unwrap();
        assert_eq!(filtered["totals"]["totalTokens"], 5);
        assert!(
            plane
                .rpc_usage_summary(&json!({"fromMs":4,"toMs":2}))
                .is_err()
        );
    }

    #[test]
    fn cache_ratio_only_counts_turns_that_reported_cache_fields() {
        let plane = crate::tests::plane();
        // Reported: 60 cached of 200 input → ratio 0.3 over known turns only.
        plane
            .store
            .record_usage(&UsageRecord {
                thread_id: "thr_cache".into(),
                turn_id: "turn_known".into(),
                turn_status: "completed".into(),
                model: "fixture".into(),
                provider_id: "local".into(),
                input_tokens: 200,
                cached_input_tokens: 60,
                cache_write_input_tokens: 20,
                output_tokens: 30,
                reasoning_output_tokens: 0,
                total_tokens: 230,
                model_context_window: None,
                completeness: "known".into(),
                cache_fields_reported: Some(knorvia_store::usage::CacheFieldsReported {
                    cached_input: true,
                    cache_write: true,
                }),
                recorded_at_ms: 1_000,
                parent_turn_id: None,
                kernel_thread_id: None,
            })
            .unwrap();
        // Not reported: upstream never sent cache fields; totals still add
        // its tokens, but it must not dilute or fake the hit ratio.
        plane
            .store
            .record_usage(&UsageRecord {
                thread_id: "thr_cache".into(),
                turn_id: "turn_unknown".into(),
                turn_status: "completed".into(),
                model: "fixture".into(),
                provider_id: "local".into(),
                input_tokens: 5_000,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                output_tokens: 10,
                reasoning_output_tokens: 0,
                total_tokens: 5_010,
                model_context_window: None,
                completeness: "known".into(),
                cache_fields_reported: None,
                recorded_at_ms: 2_000,
                parent_turn_id: None,
                kernel_thread_id: None,
            })
            .unwrap();
        let result = plane.rpc_usage_summary(&json!({})).unwrap();
        assert_eq!(
            result["totals"]["inputTokens"], 5_200,
            "totals are complete"
        );
        assert_eq!(result["cache"]["knownTurns"], 1);
        assert_eq!(result["cache"]["unknownTurns"], 1);
        assert_eq!(result["cache"]["knownInputTokens"], 200);
        assert_eq!(result["cache"]["knownCachedInputTokens"], 60);
        assert_eq!(result["cache"]["knownCacheWriteInputTokens"], 20);
        let ratio = result["cache"]["hitRatio"].as_f64().unwrap();
        assert!(
            (ratio - 0.3).abs() < 1e-9,
            "ratio uses only known turns: got {ratio}"
        );
        // With no reporting turns at all the ratio is null, not zero.
        let only_unknown = plane
            .rpc_usage_summary(&json!({"model":"nonexistent-model"}))
            .unwrap();
        assert_eq!(only_unknown["cache"]["hitRatio"], serde_json::Value::Null);
    }

    #[test]
    fn bot_room_filters_keep_historical_usage_and_billing_rows_are_not_paged() {
        let plane = crate::tests::plane();
        let bot = plane
            .store
            .create_bot("Helper", "fixture soul", "kernel", None)
            .unwrap();
        let group = plane
            .store
            .create_room("group", "G1", &[bot.id.clone()])
            .unwrap();
        let dm = plane
            .store
            .create_room("dm", "Private", &[bot.id.clone()])
            .unwrap();
        for (index, room) in [&group, &dm].iter().enumerate() {
            let binding = plane
                .store
                .resolve_session_binding(&bot.id, &room.id, "kernel", Default::default())
                .unwrap();
            let thread_id = format!("thr_usage_scope_{index}");
            plane
                .store
                .attach_binding_session(&binding.binding.id, &thread_id, None, None)
                .unwrap();
            for n in 0..2 {
                plane
                    .store
                    .record_usage(&UsageRecord {
                        thread_id: thread_id.clone(),
                        turn_id: format!("turn_usage_{index}_{n}"),
                        parent_turn_id: None,
                        kernel_thread_id: None,
                        turn_status: "completed".into(),
                        model: "fixture".into(),
                        provider_id: "p1".into(),
                        input_tokens: 100,
                        cached_input_tokens: 30,
                        cache_write_input_tokens: 20,
                        output_tokens: 5,
                        reasoning_output_tokens: 2,
                        total_tokens: 105,
                        model_context_window: None,
                        completeness: "known".into(),
                        cache_fields_reported: Some(knorvia_store::usage::CacheFieldsReported {
                            cached_input: true,
                            cache_write: true,
                        }),
                        recorded_at_ms: 1000 + n * 86_400_000,
                    })
                    .unwrap();
            }
        }
        let scoped = plane.rpc_usage_summary(&json!({"botId":bot.id,"conversationId":group.id,"conversationKind":"group","limit":1})).unwrap();
        assert_eq!(scoped["totals"]["turns"], 2);
        assert_eq!(scoped["totals"]["totalTokens"], 210);
        assert_eq!(scoped["records"].as_array().unwrap().len(), 1);
        assert_eq!(scoped["billingRows"].as_array().unwrap().len(), 2);
        assert_eq!(scoped["cache"]["hitRatio"], 0.3);
        assert_eq!(
            plane
                .rpc_usage_summary(&json!({"conversationKind":"dm"}))
                .unwrap()["totals"]["turns"],
            2
        );
        assert_eq!(
            plane
                .rpc_usage_summary(&json!({"botId":"not-a-bot"}))
                .unwrap()["totals"]["turns"],
            0
        );
    }
}
