//! R06: incrementally maintained keyword index for memory recall.
//!
//! The authoritative fact is always the memory store's record file: every
//! candidate the index proposes is re-read from disk and re-validated
//! (scope, status, validity window, revision) before it can become a hit,
//! so a stale or corrupt index can slow recall down but never widen
//! visibility or leak an old revision. The index itself is a rebuildable
//! acceleration layer: it is rebuilt from the authoritative records when it
//! is missing or corrupt, updated incrementally on every commit, and
//! persisted opportunistically.

use super::{MemoryRecord, terms_of};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::RwLock;

pub const INDEX_VERSION: u32 = 2;
/// Persist the rebuilt/updated index after this many mutations.
pub const PERSIST_EVERY: u64 = 512;

#[derive(Serialize, Deserialize, Clone, Debug)]
struct IndexedMeta {
    revision: u64,
    /// Cached status gate so forgotten records leave the candidate set even
    /// before the disk re-validation runs.
    active: bool,
    /// Scope axes and explicit shares, so candidate ranking can filter by
    /// visibility BEFORE truncating - a flood of high-scoring out-of-scope
    /// records can no longer starve lower-scored in-scope matches.
    scope: super::MemoryScope,
    shared: Vec<super::MemoryScope>,
    /// Cached validity window and pin state, so an expiry flood cannot
    /// consume the candidate cap ahead of valid records either.
    valid_from_ms: u64,
    valid_to_ms: Option<u64>,
    pinned: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct PersistedIndex {
    version: u32,
    total_docs: u64,
    /// term -> { record id -> term frequency }
    postings: HashMap<String, HashMap<String, u32>>,
    meta: HashMap<String, IndexedMeta>,
    /// Per-document term lists so an update can retract old postings.
    doc_terms: HashMap<String, Vec<String>>,
}

struct IndexState {
    postings: HashMap<String, HashMap<String, u32>>,
    meta: HashMap<String, IndexedMeta>,
    doc_terms: HashMap<String, Vec<String>>,
    total_docs: u64,
    built: bool,
    pending_persists: u64,
}

impl IndexState {
    fn remove_document(&mut self, id: &str) {
        if let Some(terms) = self.doc_terms.remove(id) {
            for term in terms {
                if let Some(docs) = self.postings.get_mut(&term) {
                    docs.remove(id);
                    if docs.is_empty() {
                        self.postings.remove(&term);
                    }
                }
            }
        }
        if self.meta.remove(id).is_some() {
            self.total_docs = self.total_docs.saturating_sub(1);
        }
    }

    fn insert_document(&mut self, record: &MemoryRecord, term_counts: &HashMap<String, u32>) {
        self.remove_document(&record.id);
        let terms: Vec<String> = term_counts.keys().cloned().collect();
        for (term, tf) in term_counts {
            self.postings
                .entry(term.clone())
                .or_default()
                .insert(record.id.clone(), *tf);
        }
        self.meta.insert(
            record.id.clone(),
            IndexedMeta {
                revision: record.revision,
                active: record.status == super::ACTIVE,
                scope: record.scope.clone(),
                shared: record.shared_scopes.clone(),
                valid_from_ms: record.valid_from_ms,
                valid_to_ms: record.valid_to_ms,
                pinned: record.pinned,
            },
        );
        self.doc_terms.insert(record.id.clone(), terms);
        self.total_docs += 1;
    }
}

/// Shared, interior-mutable search index. `&self` everywhere to sit inside
/// `MemoryStore` whose methods take `&self`.
pub struct MemorySearchIndex {
    path: PathBuf,
    state: RwLock<IndexState>,
}

impl MemorySearchIndex {
    pub fn new(index_path: PathBuf) -> Self {
        Self {
            path: index_path,
            state: RwLock::new(IndexState {
                postings: HashMap::new(),
                meta: HashMap::new(),
                doc_terms: HashMap::new(),
                total_docs: 0,
                built: false,
                pending_persists: 0,
            }),
        }
    }

    /// Load a previously persisted index and reconcile it against the
    /// authoritative records, rebuilding when it is missing/corrupt/from
    /// another version. The reconcile closes the watermark gap: records
    /// created or edited after the last persist (mutations are batched) are
    /// indexed before the first query answers, so a restart can never
    /// permanently hide them.
    pub fn ensure_built<F>(&self, rebuild_source: F) -> Result<(), super::MemoryError>
    where
        F: FnOnce() -> Result<Vec<MemoryRecord>, super::MemoryError>,
    {
        {
            let state = self.state.read().map_err(|_| poisoned())?;
            if state.built {
                return Ok(());
            }
        }
        // One write lock is held across load + authoritative reconcile +
        // publish. Concurrent first queries serialize here; commits block
        // briefly and their upserts land on the built index, so nothing can
        // bypass the watermark reconcile and `built` is only published after
        // the reconcile fully succeeds.
        let mut state = self.state.write().map_err(|_| poisoned())?;
        if state.built {
            return Ok(());
        }
        let mut restored = false;
        if let Ok(bytes) = std::fs::read(&self.path) {
            if let Ok(persisted) = serde_json::from_slice::<PersistedIndex>(&bytes) {
                if persisted.version == INDEX_VERSION {
                    state.postings = persisted.postings;
                    state.meta = persisted.meta;
                    state.doc_terms = persisted.doc_terms;
                    state.total_docs = persisted.total_docs;
                    restored = true;
                }
            }
        }
        // Authoritative reconcile (startup-only cost): add missing records,
        // refresh revision drift, drop records that no longer exist.
        let records = rebuild_source()?;
        if !restored {
            state.postings = HashMap::new();
            state.meta = HashMap::new();
            state.doc_terms = HashMap::new();
            state.total_docs = 0;
        }
        let mut changed = !restored;
        let mut seen: HashSet<String> = HashSet::with_capacity(records.len());
        for record in &records {
            seen.insert(record.id.clone());
            let stale = match state.meta.get(&record.id) {
                Some(meta) => meta.revision != record.revision,
                None => true,
            };
            if stale {
                state.insert_document(record, &term_counts(&record.content));
                changed = true;
            }
        }
        let extras: Vec<String> = state
            .meta
            .keys()
            .filter(|id| !seen.contains(*id))
            .cloned()
            .collect();
        for id in extras {
            state.remove_document(&id);
            changed = true;
        }
        state.built = true;
        if changed {
            state.pending_persists = PERSIST_EVERY; // force a persist of the refreshed index
        }
        Ok(())
    }

    /// Incremental update from the store's single write path.
    pub fn upsert(&self, record: &MemoryRecord) {
        let Ok(mut state) = self.state.write() else {
            return;
        };
        if !state.built {
            return; // not built yet: the eventual build reads authoritative data
        }
        state.insert_document(record, &term_counts(&record.content));
        state.pending_persists += 1;
        let due = state.pending_persists >= PERSIST_EVERY;
        if due {
            state.pending_persists = 0;
            let persisted = PersistedIndex {
                version: INDEX_VERSION,
                total_docs: state.total_docs,
                postings: state.postings.clone(),
                meta: state.meta.clone(),
                doc_terms: state.doc_terms.clone(),
            };
            drop(state);
            let _ = self.write_persisted(&persisted);
        }
    }

    /// Drop a record's postings entirely (created-then-deleted outside the
    /// index's knowledge).
    pub fn remove(&self, id: &str) {
        let Ok(mut state) = self.state.write() else {
            return;
        };
        state.remove_document(id);
    }

    /// Candidate hits matching ANY of `terms` (the recall contract is
    /// "at least one keyword matches"), ranked by a transparent tf-idf style
    /// score, best-first, capped at `cap` entries. Corpus statistics (df, N)
    /// come from the index, so ranking reflects corpus frequencies rather
    /// than raw hit counts; records with more distinct matching terms and
    /// rarer terms rank higher.
    pub fn rank(
        &self,
        terms: &[String],
        cap: usize,
        scope: &super::ScopeQuery,
        at_ms: u64,
    ) -> Vec<(String, u64)> {
        let Ok(state) = self.state.read() else {
            return Vec::new();
        };
        if terms.is_empty() || state.total_docs == 0 {
            return Vec::new();
        }
        let total_docs = state.total_docs as f64;
        // Present term posting lists, rarest first: the accumulator starts
        // small and every other term only updates overlapping documents.
        let mut per_term: Vec<&HashMap<String, u32>> = Vec::with_capacity(terms.len());
        for term in terms {
            match state.postings.get(term) {
                Some(docs) if !docs.is_empty() => per_term.push(docs),
                // A term that matches nothing simply contributes no candidates.
                _ => continue,
            }
        }
        if per_term.is_empty() {
            return Vec::new();
        }
        per_term.sort_by_key(|docs| docs.len());
        let mut acc: HashMap<&str, f64> = HashMap::new();
        for docs in &per_term {
            let df = docs.len() as f64;
            let idf = (1.0 + total_docs / df).ln();
            for (id, tf) in docs.iter() {
                // Visibility gates BEFORE truncation: out-of-scope and
                // expired records - no matter how highly scored - can never
                // consume the cap that belongs to this query's visible,
                // valid candidates (pinned records stay recallable past
                // expiry by explicit user choice).
                match state.meta.get(id) {
                    Some(meta)
                        if meta.active && scope_visible(scope, &meta.scope, &meta.shared) => {}
                    _ => continue,
                }
                if let Some(meta) = state.meta.get(id) {
                    let in_window = meta.valid_from_ms <= at_ms
                        && meta.valid_to_ms.map_or(true, |to| at_ms <= to);
                    if !in_window && !meta.pinned {
                        continue;
                    }
                }
                *acc.entry(id.as_str()).or_insert(0.0) += idf * (1.0 + (*tf as f64).ln());
            }
        }
        let mut out: Vec<(String, u64)> = acc
            .into_iter()
            // Scale into u64 with two decimal digits of resolution.
            .map(|(id, score)| (id.to_string(), (score * 100.0) as u64))
            .collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        out.truncate(cap);
        out
    }

    /// Cached revision for a record, when known.
    pub fn revision_of(&self, id: &str) -> Option<u64> {
        let state = self.state.read().ok()?;
        state.meta.get(id).map(|m| m.revision)
    }

    /// Test hook: whether a built index has been published.
    pub fn is_built(&self) -> bool {
        self.state.read().map(|s| s.built).unwrap_or(false)
    }

    pub fn total_docs(&self) -> u64 {
        self.state.read().map(|s| s.total_docs).unwrap_or(0)
    }

    pub fn persist_now(&self) {
        let Ok(state) = self.state.read() else { return };
        if !state.built {
            return;
        }
        let persisted = PersistedIndex {
            version: INDEX_VERSION,
            total_docs: state.total_docs,
            postings: state.postings.clone(),
            meta: state.meta.clone(),
            doc_terms: state.doc_terms.clone(),
        };
        drop(state);
        let _ = self.write_persisted(&persisted);
    }

    fn write_persisted(&self, persisted: &PersistedIndex) -> Result<(), std::io::Error> {
        use std::io::Write;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec(persisted).map_err(std::io::Error::other)?;
        let tmp = self
            .path
            .with_extension(format!("tmp.{}", std::process::id()));
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

/// Same visibility semantics as `ScopeQuery::visible_from`, applied to the
/// index's cached scope snapshot. The disk re-validation remains authoritative.
fn scope_visible(
    query: &super::ScopeQuery,
    scope: &super::MemoryScope,
    shared: &[super::MemoryScope],
) -> bool {
    query.matches_scope(scope) || shared.iter().any(|s| query.matches_scope(s))
}

fn poisoned() -> super::MemoryError {
    super::MemoryError {
        kind: super::MemoryErrorKind::Corrupt,
        message: "memory index lock poisoned".into(),
    }
}

/// Term frequencies mirroring `terms_of` tokenization (lowercase, ascii
/// alnum runs, non-ascii alnum characters as single terms) but keeping
/// counts so ranking can use real term frequencies.
pub fn term_counts(text: &str) -> HashMap<String, u32> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    let mut current = String::new();
    let mut push = |current: &mut String, counts: &mut HashMap<String, u32>| {
        if !current.is_empty() {
            *counts.entry(current.clone()).or_default() += 1;
            current.clear();
        }
    };
    for ch in text.to_lowercase().chars() {
        if ch.is_alphanumeric() {
            if ch.is_ascii_alphanumeric() {
                current.push(ch);
            } else {
                push(&mut current, &mut counts);
                *counts.entry(ch.to_string()).or_default() += 1;
            }
        } else {
            push(&mut current, &mut counts);
        }
    }
    push(&mut current, &mut counts);
    counts
}

/// Query terms stay set-shaped (a term either matches or not) — reuse the
/// canonical tokenizer so query and document side always agree.
pub fn query_terms(text: &str) -> Vec<String> {
    terms_of(text)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::term_counts;
    pub(crate) fn counts_of(text: &str) -> usize {
        term_counts(text).len()
    }
}
