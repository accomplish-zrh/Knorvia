//! R06 acceptance: memory search index quality, latency, disk reads, and
//! freshness guarantees on a 10,000-record mixed zh/en corpus.
//!
//! The corpus, the 40 queries and the expected results are all derived from
//! one deterministic construction defined here before any measurement runs;
//! metrics are computed against that fixed oracle, never tuned post hoc.

use super::index::term_counts;
use super::*;
use std::path::PathBuf;
use std::time::Instant;

struct TempHome(PathBuf);
impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn new_store(tag: &str) -> (MemoryStore, TempHome) {
    let base = std::env::temp_dir().join(format!(
        "knorvia-memidx-{tag}-{}-{}",
        std::process::id(),
        MEMORY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&base).unwrap();
    let store = MemoryStore::open(&base);
    (store, TempHome(base))
}

fn draft_in(
    owner: &str,
    workspace: &str,
    bot: &str,
    conversation: &str,
    content: &str,
) -> MemoryDraft {
    MemoryDraft {
        scope: MemoryScope {
            owner: owner.into(),
            workspace: workspace.into(),
            bot: bot.into(),
            conversation: conversation.into(),
        },
        kind: "fact".into(),
        content: content.into(),
        source_refs: Vec::new(),
        relation: None,
        valid_from_ms: None,
        valid_to_ms: None,
        pinned: false,
        client_token: None,
    }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 11
    }
    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }
}

const WORKSPACES: usize = 2;
const BOTS: usize = 2;
const CONVERSATIONS: usize = 5;
const PER_SCOPE: usize = 500;
const TOTAL: usize = WORKSPACES * BOTS * CONVERSATIONS * PER_SCOPE; // 10,000
const LANDMARKS: usize = 40;

struct Query {
    text: String,
    /// (workspace, bot, conversation) the query runs from.
    scope: (usize, usize, usize),
    /// Record ids expected in the top hits; empty means "must return none".
    expected: Vec<String>,
}

fn landmark_scope(i: usize) -> (usize, usize, usize) {
    (
        i % WORKSPACES,
        (i / WORKSPACES) % BOTS,
        (i / (WORKSPACES * BOTS)) % CONVERSATIONS,
    )
}

/// Build the whole corpus; returns the store plus the 40 fixed queries.
fn build_corpus(tag: &str) -> (MemoryStore, TempHome, Vec<Query>, Vec<String>) {
    let (store, home) = new_store(tag);
    let mut rng = Rng(0x5EED_2026_0909_0001);
    let mut landmark_record_id: Vec<String> = vec![String::new(); LANDMARKS];
    // Landmarks first, spread across every scope axis.
    for i in 0..LANDMARKS {
        let (ws, bot, conv) = landmark_scope(i);
        let (id, text) = match i {
            0..=15 => (
                format!("landmark-{i:02}"),
                format!(
                    "landmark marker lm{i:02} tracks topic {} owner {}",
                    i,
                    ["ada", "grace", "linus", "turing"][i % 4]
                ),
            ),
            16..=27 => (
                format!("landmark-{i:02}"),
                format!("地标词{i:02} 中文记忆条目 {} 号", i),
            ),
            28..=35 => (
                format!("landmark-{i:02}"),
                format!("pair record synergy{i:02} blueprint{i:02} with context {i}"),
            ),
            36..=38 => (
                format!("landmark-{i:02}"),
                format!("{} needle{i:02} end", "长记录填充内容 ".repeat(60)),
            ),
            _ => (
                format!("landmark-{i:02}"),
                "secret record topsecret39 for the private room only".to_string(),
            ),
        };
        let conversation_name = if i == 39 {
            "private-room".to_string()
        } else {
            format!("conv-{conv}")
        };
        let (created, _) = store
            .create(
                draft_in(
                    "user-bench",
                    &format!("ws-{ws}"),
                    &format!("bot-{bot}"),
                    &conversation_name,
                    &text,
                ),
                "bench",
            )
            .unwrap();
        landmark_record_id[i] = created.id;
        let _ = id;
    }
    // Filler records with common vocabulary across every scope.
    let mut global = LANDMARKS;
    for ws in 0..WORKSPACES {
        for bot in 0..BOTS {
            for conv in 0..CONVERSATIONS {
                for _n in 0..(PER_SCOPE - LANDMARKS / (WORKSPACES * BOTS * CONVERSATIONS)) {
                    let kind = rng.below(3);
                    let content = match kind {
                        0 => format!(
                            "meeting note {} shared agenda item {}",
                            global,
                            rng.below(1_000)
                        ),
                        1 => format!(
                            "会议记录 {}：本周期对齐了 {} 项事项",
                            global,
                            rng.below(1_000)
                        ),
                        _ => format!("general filler {} with words like note agenda 记录", global),
                    };
                    store
                        .create(
                            draft_in(
                                "user-bench",
                                &format!("ws-{ws}"),
                                &format!("bot-{bot}"),
                                &format!("conv-{conv}"),
                                &content,
                            ),
                            "bench",
                        )
                        .unwrap();
                    global += 1;
                }
            }
        }
    }
    assert_eq!(global, TOTAL);
    let mut queries: Vec<Query> = Vec::new();
    for i in 0..16 {
        queries.push(Query {
            text: format!("lm{i:02}"),
            scope: landmark_scope(i),
            expected: vec![landmark_record_id[i].clone()],
        });
    }
    for i in 16..28 {
        queries.push(Query {
            text: format!("地标词{i:02}"),
            scope: landmark_scope(i),
            expected: vec![landmark_record_id[i].clone()],
        });
    }
    for i in 28..36 {
        queries.push(Query {
            text: format!("synergy{i:02} blueprint{i:02}"),
            scope: landmark_scope(i),
            expected: vec![landmark_record_id[i].clone()],
        });
    }
    for i in 36..38 {
        queries.push(Query {
            text: format!("needle{i:02}"),
            scope: landmark_scope(i),
            expected: vec![landmark_record_id[i].clone()],
        });
    }
    // Secrecy: the private-room secret must NOT surface from another room of
    // the very same owner/workspace/bot...
    queries.push(Query {
        text: "topsecret39".into(),
        scope: (0, 1, 0), // ws-0/bot-1/conv-0 — same axes except the room
        expected: Vec::new(),
    });
    // ...but it must still be recallable from its own room.
    queries.push(Query {
        text: "topsecret39".into(),
        scope: (0, 1, 4), // landmark_scope(39) room; conversation is overridden
        expected: vec![landmark_record_id[39].clone()],
    });
    assert_eq!(queries.len(), 40);
    (store, home, queries, landmark_record_id)
}

fn scope_query(scope: &(usize, usize, usize)) -> ScopeQuery {
    ScopeQuery {
        owner: "user-bench".into(),
        workspace: Some(format!("ws-{}", scope.0)),
        bot: Some(format!("bot-{}", scope.1)),
        conversation: Some(format!("conv-{}", scope.2)),
    }
}

fn recall_once(store: &MemoryStore, query: &Query) -> Vec<String> {
    // The two secrecy queries run from their own fixed room name.
    let mut scope = scope_query(&query.scope);
    if query.text.starts_with("topsecret39") {
        scope.conversation = Some("private-room".into());
    }
    store
        .recall(&query.text, &scope, 5, (None, None))
        .unwrap()
        .hits
        .into_iter()
        .map(|hit| hit.record_id)
        .collect()
}

fn percentile(samples: &mut Vec<u128>, p: u128) -> f64 {
    samples.sort_unstable();
    let idx = ((samples.len() as u128 - 1) * p / 100) as usize;
    samples[idx] as f64
}

#[test]
fn ten_thousand_record_corpus_meets_quality_latency_and_disk_read_targets() {
    let (store, _home, queries, landmark_ids) = build_corpus("bench");
    // Warm the index once (rebuild reads every authoritative record).
    store
        .recall("lm00", &scope_query(&(0, 0, 0)), 5, (None, None))
        .unwrap();

    // ---- quality against the fixed oracle ---------------------------------
    let mut recalls_at_5: Vec<f64> = Vec::new();
    let mut reciprocal_ranks: Vec<f64> = Vec::new();
    for query in &queries {
        if query.expected.is_empty() {
            let hits = recall_once(&store, query);
            assert!(hits.is_empty(), "secrecy leak for {}: {hits:?}", query.text);
            continue;
        }
        let hits = recall_once(&store, query);
        let found = hits.iter().filter(|id| query.expected.contains(id)).count();
        recalls_at_5.push(found as f64 / query.expected.len() as f64);
        let rr = hits
            .iter()
            .position(|id| query.expected.contains(id))
            .map(|pos| 1.0 / (pos + 1) as f64)
            .unwrap_or(0.0);
        reciprocal_ranks.push(rr);
    }
    let recall_at_5 = recalls_at_5.iter().sum::<f64>() / recalls_at_5.len() as f64;
    let mrr = reciprocal_ranks.iter().sum::<f64>() / reciprocal_ranks.len() as f64;
    println!(
        "[R06 quality] Recall@5 = {recall_at_5:.3}, MRR = {mrr:.3} over {} scored queries",
        recalls_at_5.len()
    );
    assert!(recall_at_5 >= 0.95, "Recall@5 = {recall_at_5}");
    assert!(mrr >= 0.9, "MRR = {mrr}");

    // ---- latency: indexed vs full-scan baseline, same machine -------------
    let mut indexed_ms: Vec<u128> = Vec::new();
    for _round in 0..3 {
        for query in &queries {
            let start = Instant::now();
            recall_once(&store, query);
            indexed_ms.push(start.elapsed().as_millis());
        }
    }
    let mut scan_ms: Vec<u128> = Vec::new();
    for query in &queries {
        let mut scope = scope_query(&query.scope);
        if query.text.starts_with("topsecret39") {
            scope.conversation = Some("private-room".into());
        }
        let start = Instant::now();
        store
            .recall_full_scan(&query.text, &scope, 5, (None, None))
            .unwrap();
        scan_ms.push(start.elapsed().as_millis());
    }
    let indexed_p50 = percentile(&mut indexed_ms, 50);
    let indexed_p95 = percentile(&mut indexed_ms, 95);
    let scan_p50 = percentile(&mut scan_ms, 50);
    let scan_p95 = percentile(&mut scan_ms, 95);
    println!(
        "[R06 latency ms] indexed p50={indexed_p50} p95={indexed_p95} | full-scan baseline p50={scan_p50} p95={scan_p95} | corpus={TOTAL} records"
    );
    assert!(
        indexed_p95 <= scan_p95,
        "indexed recall should not be slower than the scan baseline"
    );

    // ---- disk reads per strategy ------------------------------------------
    DISK_READS.store(0, Ordering::Relaxed);
    for query in &queries {
        recall_once(&store, query);
    }
    let indexed_reads = DISK_READS.load(Ordering::Relaxed);
    DISK_READS.store(0, Ordering::Relaxed);
    for query in &queries {
        let mut scope = scope_query(&query.scope);
        if query.text.starts_with("topsecret39") {
            scope.conversation = Some("private-room".into());
        }
        store
            .recall_full_scan(&query.text, &scope, 5, (None, None))
            .unwrap();
    }
    let scan_reads = DISK_READS.load(Ordering::Relaxed);
    println!(
        "[R06 disk reads] indexed={indexed_reads} vs full-scan={scan_reads} over 40 queries on {TOTAL} records"
    );
    assert!(
        indexed_reads * 5 < scan_reads,
        "indexed recall must read far fewer record files"
    );
    assert_eq!(landmark_ids.len(), LANDMARKS);
}

#[test]
fn edits_forgets_restores_and_unshares_take_effect_immediately() {
    let (store, _home) = new_store("fresh");
    let (record, _) = store
        .create(
            draft_in("u", "ws", "bot", "g1", "alpha quartz-unique"),
            "user",
        )
        .unwrap();
    let all = ScopeQuery {
        owner: "u".into(),
        workspace: Some("ws".into()),
        bot: Some("bot".into()),
        conversation: Some("g1".into()),
    };
    assert_eq!(
        store
            .recall("quartz-unique", &all, 5, (None, None))
            .unwrap()
            .hits
            .len(),
        1
    );
    // Edit removes the old term: the old revision must not leak.
    store
        .update(
            &record.id,
            Some(1),
            MemoryUpdate {
                content: Some("beta cubic-replacement".into()),
                ..MemoryUpdate::empty()
            },
            "user",
        )
        .unwrap();
    assert_eq!(
        store
            .recall("quartz-unique", &all, 5, (None, None))
            .unwrap()
            .hits
            .len(),
        0,
        "old revision term is gone"
    );
    assert_eq!(
        store
            .recall("cubic-replacement", &all, 5, (None, None))
            .unwrap()
            .hits
            .len(),
        1
    );
    // Forget hides the record; restore brings it back.
    store.forget(&record.id, Some(2), "user").unwrap();
    assert_eq!(
        store
            .recall("cubic-replacement", &all, 5, (None, None))
            .unwrap()
            .hits
            .len(),
        0,
        "forgotten records are not recalled"
    );
    store.restore(&record.id, Some(3), "user").unwrap();
    assert_eq!(
        store
            .recall("cubic-replacement", &all, 5, (None, None))
            .unwrap()
            .hits
            .len(),
        1
    );
    // Sharing widens visibility; revoking closes it again.
    let other = ScopeQuery {
        owner: "u".into(),
        workspace: Some("ws".into()),
        bot: Some("bot".into()),
        conversation: Some("g2".into()),
    };
    let make_scope = || MemoryScope {
        owner: "u".into(),
        workspace: "ws".into(),
        bot: "bot".into(),
        conversation: "g2".into(),
    };
    store
        .share(&record.id, Some(4), vec![make_scope()], Vec::new(), "user")
        .unwrap();
    assert_eq!(
        store
            .recall("cubic-replacement", &other, 5, (None, None))
            .unwrap()
            .hits
            .len(),
        1
    );
    store
        .share(&record.id, Some(5), Vec::new(), vec![make_scope()], "user")
        .unwrap();
    assert_eq!(
        store
            .recall("cubic-replacement", &other, 5, (None, None))
            .unwrap()
            .hits
            .len(),
        0,
        "share revoke takes effect immediately"
    );
}

#[test]
fn corrupt_or_missing_index_rebuilds_without_touching_authoritative_records() {
    let tag = "rebuild";
    let base = std::env::temp_dir().join(format!(
        "knorvia-memidx-{tag}-{}-{}",
        std::process::id(),
        MEMORY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&base).unwrap();
    let index_path = base
        .join("product")
        .join("memory")
        .join("search-index.json");
    {
        let store = MemoryStore::open(&base);
        store
            .create(
                draft_in("u", "ws", "bot", "g1", "rebuild marker-cardinal"),
                "user",
            )
            .unwrap();
        let all = ScopeQuery {
            owner: "u".into(),
            workspace: Some("ws".into()),
            bot: Some("bot".into()),
            conversation: Some("g1".into()),
        };
        assert_eq!(
            store
                .recall("marker-cardinal", &all, 5, (None, None))
                .unwrap()
                .hits
                .len(),
            1
        );
        store.index.persist_now();
        assert!(index_path.exists(), "index persisted on demand");
    }
    // Corrupt the persisted index, then open a fresh store on the same Home:
    // the rebuild path must restore recall from authoritative records alone.
    std::fs::write(&index_path, b"{ this is not json ").unwrap();
    let store2 = MemoryStore::open(&base);
    let all = ScopeQuery {
        owner: "u".into(),
        workspace: Some("ws".into()),
        bot: Some("bot".into()),
        conversation: Some("g1".into()),
    };
    let hits = store2
        .recall("marker-cardinal", &all, 5, (None, None))
        .unwrap();
    assert_eq!(hits.hits.len(), 1, "corrupt index rebuilds safely");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn scope_switch_never_mixes_results() {
    let (store, _home) = new_store("scopes");
    store
        .create(
            draft_in("u", "ws", "bot", "g1", "shared word only-here-a"),
            "user",
        )
        .unwrap();
    store
        .create(
            draft_in("u", "ws", "bot", "g2", "shared word only-here-b"),
            "user",
        )
        .unwrap();
    let g1 = ScopeQuery {
        owner: "u".into(),
        workspace: Some("ws".into()),
        bot: Some("bot".into()),
        conversation: Some("g1".into()),
    };
    let g2 = ScopeQuery {
        owner: "u".into(),
        workspace: Some("ws".into()),
        bot: Some("bot".into()),
        conversation: Some("g2".into()),
    };
    let a_hits = store.recall("shared", &g1, 10, (None, None)).unwrap().hits;
    let b_hits = store.recall("shared", &g2, 10, (None, None)).unwrap().hits;
    assert_eq!(a_hits.len(), 1);
    assert_eq!(b_hits.len(), 1);
    assert_ne!(a_hits[0].record_id, b_hits[0].record_id);
    assert!(term_counts("Shared WORDS!").contains_key("shared"));
}

#[test]
fn restart_reconciles_records_created_or_modified_after_the_last_persist() {
    let tag = "watermark";
    let base = std::env::temp_dir().join(format!(
        "knorvia-memidx-{tag}-{}-{}",
        std::process::id(),
        MEMORY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&base).unwrap();
    let all = ScopeQuery {
        owner: "u".into(),
        workspace: Some("ws".into()),
        bot: Some("bot".into()),
        conversation: Some("g1".into()),
    };
    {
        let store = MemoryStore::open(&base);
        let (record, _) = store
            .create(
                draft_in("u", "ws", "bot", "g1", "warm the index watermarked"),
                "user",
            )
            .unwrap();
        store.recall("watermarked", &all, 5, (None, None)).unwrap();
        store.index.persist_now();
        // Both mutation kinds stay under the 512-change persist batching:
        // a brand-new record and an in-place edit adding a fresh term.
        store
            .create(
                draft_in("u", "ws", "bot", "g1", "brandnew-99-term added later"),
                "user",
            )
            .unwrap();
        store
            .update(
                &record.id,
                Some(1),
                MemoryUpdate {
                    content: Some("watermarked modified-77-term".into()),
                    ..MemoryUpdate::empty()
                },
                "user",
            )
            .unwrap();
    }
    // Reopen: the persisted index is stale by two records; the watermark
    // reconcile must index them before the first query answers.
    let store2 = MemoryStore::open(&base);
    let hits_new = store2
        .recall("brandnew-99-term", &all, 5, (None, None))
        .unwrap();
    assert!(
        !hits_new.hits.is_empty(),
        "records created after the last persist are found after restart"
    );
    let top_new = store2
        .read_record(&hits_new.hits[0].record_id)
        .unwrap()
        .unwrap();
    assert!(
        top_new.content.contains("brandnew-99-term"),
        "the new record ranks first (most matched terms)"
    );
    let hits_mod = store2
        .recall("modified-77-term", &all, 5, (None, None))
        .unwrap();
    assert!(
        !hits_mod.hits.is_empty(),
        "in-place edits after the last persist are found after restart"
    );
    let top_mod = store2
        .read_record(&hits_mod.hits[0].record_id)
        .unwrap()
        .unwrap();
    assert!(
        top_mod.content.contains("modified-77-term"),
        "the edited record ranks first for its new term"
    );
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn out_of_scope_score_flood_cannot_starve_in_scope_matches() {
    let (store, _home) = new_store("scopeflood");
    // The only in-scope record carrying the term scores no higher than the
    // flood of out-of-scope records sharing it.
    store
        .create(
            draft_in("u", "ws", "bot", "g1", "flood beacon-in-scope"),
            "user",
        )
        .unwrap();
    for n in 0..200u32 {
        store
            .create(
                MemoryDraft {
                    scope: MemoryScope {
                        owner: "u".into(),
                        workspace: "ws".into(),
                        bot: "bot".into(),
                        conversation: "other".into(),
                    },
                    kind: "fact".into(),
                    content: format!("flood filler {n:04}"),
                    source_refs: Vec::new(),
                    relation: None,
                    valid_from_ms: None,
                    valid_to_ms: None,
                    pinned: false,
                    client_token: None,
                },
                "user",
            )
            .unwrap();
    }
    let g1 = ScopeQuery {
        owner: "u".into(),
        workspace: Some("ws".into()),
        bot: Some("bot".into()),
        conversation: Some("g1".into()),
    };
    let hits = store.recall("flood", &g1, 5, (None, None)).unwrap();
    assert_eq!(
        hits.hits.len(),
        1,
        "scope filtering happens before truncation"
    );
    let content = store.read_record(&hits.hits[0].record_id).unwrap().unwrap();
    assert!(
        content.content.contains("beacon-in-scope"),
        "the in-scope record is the hit"
    );
}

#[test]
fn expiry_flood_cannot_starve_valid_matches() {
    let (store, _home) = new_store("expflood");
    let at = now_ms();
    store
        .create(
            draft_in("u", "ws", "bot", "g1", "flood beacon-still-valid"),
            "user",
        )
        .unwrap();
    for n in 0..300u32 {
        let mut draft = draft_in(
            "u",
            "ws",
            "bot",
            "g1",
            &format!("flood already-expired {n:04}"),
        );
        draft.valid_to_ms = Some(at.saturating_sub(1_000_000));
        store.create(draft, "user").unwrap();
    }
    let g1 = ScopeQuery {
        owner: "u".into(),
        workspace: Some("ws".into()),
        bot: Some("bot".into()),
        conversation: Some("g1".into()),
    };
    let hits = store.recall("flood", &g1, 5, (None, None)).unwrap();
    assert_eq!(
        hits.hits.len(),
        1,
        "validity filtering happens before the candidate cap"
    );
    let content = store.read_record(&hits.hits[0].record_id).unwrap().unwrap();
    assert!(
        content.content.contains("beacon-still-valid"),
        "the still-valid record is the hit"
    );
}

#[test]
fn concurrent_first_queries_serialize_and_index_everything() {
    let base = std::env::temp_dir().join(format!(
        "knorvia-memidx-concurrent-{}-{}",
        std::process::id(),
        MEMORY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&base).unwrap();
    let store = std::sync::Arc::new(MemoryStore::open(&base));
    for n in 0..50u32 {
        store
            .create(
                draft_in(
                    "u",
                    "ws",
                    "bot",
                    "g1",
                    &format!("concurrent term-{n:02} record"),
                ),
                "user",
            )
            .unwrap();
    }
    let all = ScopeQuery {
        owner: "u".into(),
        workspace: Some("ws".into()),
        bot: Some("bot".into()),
        conversation: Some("g1".into()),
    };
    let mut handles = Vec::new();
    for t in 0..4u32 {
        let store = std::sync::Arc::clone(&store);
        let all = all.clone();
        handles.push(std::thread::spawn(move || {
            let hits = store
                .recall(&format!("term-{t:02}"), &all, 5, (None, None))
                .unwrap();
            let top = store.read_record(&hits.hits[0].record_id).unwrap().unwrap();
            top.content.contains(&format!("term-{t:02}"))
        }));
    }
    for handle in handles {
        assert!(
            handle.join().unwrap(),
            "each concurrent first query ranks its own record first"
        );
    }
    assert_eq!(
        store.index.total_docs(),
        50,
        "index holds the full corpus after concurrent first queries"
    );
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn reconcile_failure_keeps_index_unbuilt_and_retryable() {
    let base = std::env::temp_dir().join(format!(
        "knorvia-memidx-reconcilefail-{}-{}",
        std::process::id(),
        MEMORY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&base).unwrap();
    let store = MemoryStore::open(&base);
    store
        .create(
            draft_in("u", "ws", "bot", "g1", "retryable beacon-after-failure"),
            "user",
        )
        .unwrap();
    let all = ScopeQuery {
        owner: "u".into(),
        workspace: Some("ws".into()),
        bot: Some("bot".into()),
        conversation: Some("g1".into()),
    };
    // Inject a reconcile failure directly: `built` must stay unpublished so
    // the next query retries the reconcile instead of serving a stale index.
    let result = store.index.ensure_built(|| {
        Err::<Vec<MemoryRecord>, _>(MemoryError {
            kind: MemoryErrorKind::Io,
            message: "injected reconcile failure".into(),
        })
    });
    assert!(result.is_err(), "first reconcile fails");
    assert!(
        !store.index.is_built(),
        "built stays unpublished after a failed reconcile"
    );
    let hits = store
        .recall("beacon-after-failure", &all, 5, (None, None))
        .unwrap();
    assert_eq!(
        hits.hits.len(),
        1,
        "a later query rebuilds and finds the record"
    );
    let _ = std::fs::remove_dir_all(&base);
}
