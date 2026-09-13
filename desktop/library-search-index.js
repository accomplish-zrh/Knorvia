'use strict';
// P04: incremental content index for the personal library's text files.
//
// The first search implementation ran inside the library's global write.lock
// and rescanned every file per query. This module keeps a persisted postings
// index (term -> file -> matching line numbers) keyed by each entry's
// content hash, so:
//   * search never touches the write lock — it reads its own index file and
//     only the handful of files a query actually hits;
//   * files are re-indexed only when their content version changes; the
//     catalog sha drives the refresh, and a candidate whose bytes no longer
//     match its indexed version is repaired during the query that reads it;
//   * every hit is verified against the bytes actually read: a file whose
//     content no longer matches the indexed version is re-indexed on the
//     spot and never presented with a stale hash;
//   * queries are cancelable end to end (the sweep and the candidate walk
//     both observe the cancellation flag) and paginate through a stable
//     cursor;
//   * uncovered files are counted and reported (too large, unreadable),
//     never silently ignored.
// Dictionaries are prototype-free (Object.create(null)) and every keyed
// read goes through `has()`, so content words like `constructor` or
// `__proto__` are ordinary terms. Chinese and other CJK text is indexed as
// character unigrams; latin and digit runs as whole lowercase words. The
// authoritative record is still the library itself — this index is a
// rebuildable acceleration layer.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const INDEX_VERSION = 3;
const MAX_INDEXED_BYTES = 1024 * 1024; // same per-file cap as the on-demand scan
const TEXT_FILE = /\.(md|txt|json|csv|tsv|log|ya?ml|toml|ini|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|c|cpp|h|sh|ps1|bat|sql|xml)$/i;

function nullProto() {
  return Object.create(null);
}

/** Prototype-safe property read: inherited keys like `constructor` never count. */
function has(map, key) {
  return typeof map === 'object' && map !== null && Object.prototype.hasOwnProperty.call(map, key);
}

function tokenize(text) {
  const terms = new Map();
  const lowered = text.toLowerCase();
  let run = '';
  const flush = () => {
    if (run) { terms.set(run, (terms.get(run) ?? 0) + 1); run = ''; }
  };
  for (const char of lowered) {
    const code = char.codePointAt(0);
    if (/\w/.test(char)) run += char;
    else if (code > 0x2e7f) { flush(); terms.set(char, (terms.get(char) ?? 0) + 1); }
    else flush();
  }
  flush();
  return terms;
}

function splitLines(raw) {
  return raw.split(/\r?\n/);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function createLibrarySearchIndex({ metaDir, resolvePath, readTextFile, now = () => new Date().toISOString() }) {
  // `resolvePath(rel) -> absolute path` keeps the library's path safety
  // (symlink/junction guard) inside personal-library.js; `readTextFile(abs,
  // maxBytes) -> { raw, bytes, size, mtimeMs }` is injected so tests can
  // observe and fail reads.
  const indexFile = path.join(metaDir, 'search-index.json');
  let state = { version: INDEX_VERSION, files: nullProto(), skipped: nullProto() };
  let loaded = false;
  let dirty = false;
  const canceledRequests = new Set();

  // A request flag registers a query identity and can cancel an earlier one.
  // Both the freshness sweep and the candidate walk observe it, so a
  // superseded query actually stops its own traversal.
  function begin_request(requestId, canceledRequestId) {
    if (canceledRequestId) canceledRequests.add(canceledRequestId);
    const aborted = () => requestId !== undefined && canceledRequests.has(requestId);
    return { aborted, dispose: () => { if (requestId) canceledRequests.delete(requestId); } };
  }

  async function load() {
    if (loaded) return state;
    try {
      const raw = await fs.readFile(indexFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === INDEX_VERSION && parsed.files) {
        // Re-root every dictionary on a null prototype: JSON.parse returns
        // ordinary objects whose inherited keys would alias content words.
        const files = nullProto();
        for (const key of Object.keys(parsed.files)) files[key] = parsed.files[key];
        const skipped = nullProto();
        for (const key of Object.keys(parsed.skipped ?? {})) skipped[key] = parsed.skipped[key];
        state = { version: INDEX_VERSION, files, skipped };
      }
    } catch {
      state = { version: INDEX_VERSION, files: nullProto(), skipped: nullProto() };
    }
    loaded = true;
    return state;
  }

  async function persist() {
    if (!dirty) return;
    await fs.mkdir(path.dirname(indexFile), { recursive: true });
    const temporary = `${indexFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state));
    await fs.rename(temporary, indexFile);
    dirty = false;
  }

  function indexEntry(entry, raw, size, mtimeMs) {
    const lines = splitLines(raw);
    const postings = nullProto();
    for (const [offset, line] of lines.entries()) {
      for (const [term] of tokenize(line)) {
        if (!has(postings, term)) postings[term] = [];
        postings[term].push(offset + 1);
      }
    }
    state.files[entry.path] = {
      sha256: entry.sha256,
      size,
      mtimeMs,
      lines: lines.length,
      id: entry.id,
      name: entry.name,
      indexedAt: now(),
      postings,
    };
  }

  /** Bring the index in line with the catalog; returns work stats. */
  async function refresh(catalog, options = {}) {
    await load();
    const signal = options.signal;
    const aborted = () => (typeof signal?.aborted === 'function' ? signal.aborted() : Boolean(signal?.aborted));
    let reindexed = 0;
    let checked = 0;
    // CODEX-0615-B01: one full-coverage pass. Every catalogued text file is
    // stat-checked (cheap, metadata only) and re-read ONLY when its size or
    // mtime drifted from the indexed copy. No head-of-list budget can starve
    // the tail, and files whose catalog sha is permanently stale cost
    // nothing extra: indexed entries are always content-verified at write
    // time, so the file system's own timestamps decide freshness.
    const present = nullProto();
    for (const entry of catalog) {
      if (aborted()) { await persist(); return { reindexed, checked, aborted: true }; }
      if (entry.trashedAt || entry.folder || !TEXT_FILE.test(entry.name)) continue;
      present[entry.path] = true;
      const indexed = has(state.files, entry.path) ? state.files[entry.path] : null;
      if (entry.size > MAX_INDEXED_BYTES) {
        if (!indexed || indexed.size !== entry.size) {
          state.skipped[entry.path] = { reason: 'too-large', size: entry.size, sha256: entry.sha256 };
          delete state.files[entry.path];
          dirty = true;
        }
        continue;
      }
      checked += 1;
      let stat = null;
      try {
        stat = await fs.stat(await resolvePath(entry.path));
      } catch {
        if (indexed) { delete state.files[entry.path]; dirty = true; }
        state.skipped[entry.path] = { reason: 'unreadable', size: entry.size, sha256: entry.sha256 };
        continue;
      }
      if (indexed && indexed.size === stat.size && indexed.mtimeMs === stat.mtimeMs) continue;
      try {
        const target = await resolvePath(entry.path);
        const read = await readTextFile(target, MAX_INDEXED_BYTES);
        indexEntry({ ...entry, sha256: sha256(read.bytes) }, read.raw, read.size, read.mtimeMs);
        delete state.skipped[entry.path];
        reindexed += 1;
        dirty = true;
      } catch {
        state.skipped[entry.path] = { reason: 'unreadable', size: entry.size, sha256: entry.sha256 };
        delete state.files[entry.path];
        dirty = true;
      }
    }
    for (const known of Object.keys(state.files)) {
      if (!has(present, known)) delete state.files[known];
    }
    for (const known of Object.keys(state.skipped)) {
      if (!has(present, known)) delete state.skipped[known];
    }
    await persist();
    return { reindexed, checked, aborted: aborted() };
  }

  function matchFiles(terms) {
    // OR semantics (the on-demand scan's contract): a file matching any
    // query term is a candidate; richer matches rank first and ties break
    // by path so ordering is deterministic.
    const results = [];
    for (const rel of Object.keys(state.files)) {
      const file = state.files[rel];
      let score = 0;
      for (const term of terms) {
        if (has(file.postings, term)) score += file.postings[term].length;
      }
      if (score > 0) results.push({ rel, file, score });
    }
    results.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return results;
  }

  /** Re-index one file from freshly read bytes; returns the new entry. */
  function reindexFromActual(entry, raw, bytes, size, mtimeMs) {
    indexEntry({ ...entry, sha256: sha256(bytes) }, raw, size, mtimeMs);
    delete state.skipped[entry.path];
    dirty = true;
    return state.files[entry.path];
  }

  /**
   * Search the current snapshot. Up to `limit` hits starting at `cursor`
   * (an offset into this snapshot's ranked list). Every candidate's bytes
   * are read fresh and hashed: a content change since indexing either
   * re-validates the hit with the ACTUAL hash (stale: true) or drops it and
   * re-indexes the file — a stale hash is never presented as current.
   */
  async function search(query, options = {}) {
    await load();
    const flag = options.flag ?? begin_request(options.requestId, options.cancelRequestId);
    const text = typeof query === 'string' ? query.trim() : '';
    if (!text) { flag.dispose(); return { hits: [], nextCursor: null, coverage: coverage(), truncated: false, staleCount: 0, scannedThisQuery: 0, aborted: flag.aborted() }; }
    const terms = [...tokenize(text).keys()];
    // Whitespace-separated segments containing CJK behave like the original
    // substring search: the contiguous phrase must appear in the file. Latin
    // segments keep term matching. Unigram postings stay the candidate
    // source; the phrase check decides which candidates are real hits.
    const phrases = text
      .toLowerCase()
      .split(/\s+/)
      .filter(segment => segment && /[^ -]/.test(segment));
    const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 50);
    const offset = Math.max(Number(options.cursor) || 0, 0);
    const matches = matchFiles(terms);
    const hits = [];
    let stale = 0;
    let scanned = 0;
    let examined = 0;
    for (let i = offset; i < matches.length && hits.length < limit; i++) {
      if (flag.aborted()) break;
      examined = i - offset + 1;
      const { rel, file, score } = matches[i];
      let read;
      try {
        read = await readTextFile(await resolvePath(rel), MAX_INDEXED_BYTES);
      } catch {
        state.skipped[rel] = { reason: 'unreadable', size: file.size, sha256: file.sha256 };
        delete state.files[rel];
        dirty = true;
        continue;
      }
      scanned += 1;
      const actualSha = sha256(read.bytes);
      const changed = actualSha !== file.sha256;
      const lines = splitLines(read.raw);
      const matchedContent = contentMatches(read.raw, terms, phrases);
      if (changed) {
        // Re-evaluate against the actual content; repair the index entry.
        reindexFromActual({ path: rel, id: file.id, name: file.name, sha256: actualSha }, read.raw, read.bytes, read.size, read.mtimeMs);
        if (!matchedContent) continue; // the old hit is gone; new terms need a new query
        stale += 1;
        hits.push(buildHit(rel, actualSha, score + 1, lines, terms, phrases, true));
        continue;
      }
      if (!matchedContent) continue; // unigram candidate, but the phrase is absent
      hits.push(buildHit(rel, file.sha256, score, lines, terms, phrases, false));
    }
    flag.dispose();
    // The cursor advances past every candidate this page CONSUMED — hits,
    // phrase-filtered and dropped alike — so a fully filtered page can never
    // loop on itself (nextCursor must move forward or end).
    const consumed = offset + examined;
    const nextCursor = consumed < matches.length ? consumed : null;
    return {
      hits,
      nextCursor,
      coverage: coverage(),
      truncated: consumed < matches.length,
      staleCount: stale,
      scannedThisQuery: scanned,
      aborted: flag.aborted(),
    };
  }

  function contentMatches(raw, terms, phrases) {
    const lowered = raw.toLowerCase();
    return phrases.every(phrase => lowered.includes(phrase)) && terms.some(term => lowered.includes(term));
  }

  function buildHit(rel, sha, score, lines, terms, phrases, isStale) {
    const file = state.files[rel];
    const snippets = [];
    for (const [lineOffset, line] of lines.entries()) {
      const lowered = line.toLowerCase();
      if (phrases.every(phrase => lowered.includes(phrase)) && terms.some(term => lowered.includes(term))) {
        snippets.push({ line: lineOffset + 1, text: line.trim().slice(0, 200) });
        if (snippets.length >= 3) break;
      }
    }
    return { id: file.id, path: rel, name: file.name, sha256: sha, score, totalLines: lines.length, snippets, ...(isStale ? { stale: true } : {}) };
  }

  function coverage() {
    const skipped = { 'too-large': 0, unreadable: 0 };
    for (const entry of Object.values(state.skipped)) skipped[entry.reason] = (skipped[entry.reason] ?? 0) + 1;
    return {
      indexed: Object.keys(state.files).length,
      tooLarge: skipped['too-large'] ?? 0,
      unreadable: skipped.unreadable ?? 0,
      model: 'full-stat-sweep',
    };
  }

  return {
    load,
    refresh,
    search,
    coverage,
    begin_request,
    get state() { return state; },
    async reset() {
      state = { version: INDEX_VERSION, files: nullProto(), skipped: nullProto() };
      loaded = true;
      dirty = true;
      await persist();
    },
  };
}

module.exports = { createLibrarySearchIndex, tokenize, TEXT_FILE, MAX_INDEXED_BYTES, INDEX_VERSION, has };
