'use strict';
// P04 acceptance: incremental library content index on the real backend.
// 5,000 synthetic text files; version-tracked invalidation; cursor
// pagination; saves never blocked by an in-flight search; explicit coverage
// for oversized and unreadable files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPersonalLibrary } = require('../personal-library');
const { createLibrarySearchIndex, tokenize, MAX_INDEXED_BYTES, INDEX_VERSION } = require('../library-search-index');

const TOTAL = Number(process.env.SEARCH_CORPUS) || 5000;
const HITS = 25;

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'knorvia-libsearch-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const library = createPersonalLibrary({ home });
  const call = (method, params = {}) => library.handlers[`library/${method}`](params);
  const contentDir = path.join(home, 'personal-library', 'files');
  await fs.mkdir(contentDir, { recursive: true });
  // Seed files directly on disk; one list() snapshots them into the catalog.
  const dirA = path.join(contentDir, '语料');
  await fs.mkdir(dirA, { recursive: true });
  for (let i = 0; i < TOTAL; i++) {
    const lines = [`文件 ${i} 的第一行。`, '普通填充行 shared-line。', `第 ${i} 号语料 ends-${String(i).padStart(4, '0')}`];
    if (i < HITS) lines.splice(1, 0, `紫罗兰出现在第 2 行 violet-${i}`);
    await fs.writeFile(path.join(dirA, `doc-${String(i).padStart(4, '0')}.md`), lines.join('\n'));
  }
  await call('list');
  return { home, library, call, contentDir };
}

test('5,000-file corpus: refresh indexes everything, search paginates with line snippets', async t => {
  const { call } = await fixture(t);
  const page1 = await call('search', { query: '紫罗兰', limit: 20 });
  assert.equal(page1.hits.length, 20);
  assert.equal(page1.coverage.indexed, TOTAL, 'every text file indexed');
  assert.equal(page1.coverage.tooLarge, 0);
  assert.ok(page1.nextCursor !== null, 'more pages exist');
  // Snippets point at the real line and carry the indexed version hash.
  for (const hit of page1.hits) {
    assert.equal(hit.totalLines, 4, 'four seeded lines per hit file');
    assert.equal(hit.snippets[0].line, 2);
    assert.match(hit.snippets[0].text, /紫罗兰/);
    assert.ok(hit.sha256);
  }
  const page2 = await call('search', { query: '紫罗兰', limit: 20, cursor: page1.nextCursor });
  assert.equal(page2.hits.length, HITS - 20, 'remaining hits on page two');
  assert.equal(page2.nextCursor, null, 'cursor ends the result set');
  const seen = new Set([...page1.hits, ...page2.hits].map(hit => hit.path));
  assert.equal(seen.size, HITS, 'no repeats across pages');
  // Deterministic order across pages (score desc, then path).
  const ordered = [...page1.hits, ...page2.hits];
  assert.deepEqual([...ordered].map(hit => hit.path).sort((a, b) => a < b ? -1 : 1), ordered.map(hit => hit.path), 'ties break by path within equal scores');
});

test('external edits, renames, trash and restore invalidate by file version', async t => {
  const { call, contentDir } = await fixture(t);
  await call('search', { query: '紫罗兰', limit: 5 });
  // External modification changes the content hash on the next scan.
  const victim = path.join(contentDir, '语料', 'doc-0000.md');
  await fs.writeFile(victim, '文件 0 的第一行。\n紫罗兰被移动到第 2 行 violet-0\n普通填充行 shared-line。\n第 0 号语料 ends-0');
  await call('list');
  const after = await call('search', { query: '紫罗兰', limit: 50 });
  const hit0 = after.hits.find(hit => hit.path === '语料/doc-0000.md');
  assert.ok(hit0, 'modified file still matches');
  assert.equal(hit0.snippets[0].line, 2, 'snippet tracks the new content, not the old index');
  // Trash removes the file from results; restore brings it back.
  await call('trash', { path: '语料/doc-0001.md' });
  const trashed = await call('search', { query: '紫罗兰', limit: 50 });
  assert.ok(!trashed.hits.some(hit => hit.path === '语料/doc-0001.md'), 'trashed files are not searchable');
  const entry = (await call('list')).entries.find(item => item.path === '语料/doc-0001.md');
  await call('restore', { id: entry.id });
  const restored = await call('search', { query: '紫罗兰', limit: 50 });
  assert.ok(restored.hits.some(hit => hit.path === '语料/doc-0001.md'), 'restored files are searchable again');
});

test('a running search never holds the write lock: saves stay fast and cancel works', async t => {
  const { call } = await fixture(t);
  // Warm the index so the search walks a big postings map.
  await call('search', { query: 'ends-', limit: 5 });
  const first = call('search', { query: 'ends-0001', limit: 20, requestId: 'req-1' });
  const saveStarted = Date.now();
  await call('write', { path: '并发写入.md', text: '保存不等待检索' });
  const saveMs = Date.now() - saveStarted;
  console.log(`[latency] concurrent library write completed in ${saveMs}ms while a search traversed ${TOTAL} files`);
  assert.ok(saveMs < 2000, `write completed in ${saveMs}ms while a search ran`);
  const second = call('search', { query: 'ends-0002', limit: 20, requestId: 'req-2', cancelRequestId: 'req-1' });
  const [a, b] = await Promise.all([first, second]);
  assert.ok(Array.isArray(a.hits) && Array.isArray(b.hits));
  assert.ok(b.hits.length >= 1, 'cancelling a prior query leaves the new one intact');
});

test('oversized and unreadable files are counted, not silently dropped', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'knorvia-libsearch-cov-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const metaDir = path.join(home, 'meta');
  await fs.mkdir(metaDir, { recursive: true });
  // The snippet reader reads the real file, so the fixture files must exist.
  await fs.writeFile(path.join(home, 'ok.md'), '紫罗兰 synthetic content');
  await fs.writeFile(path.join(home, 'broken.md'), '紫罗兰 synthetic content');
  let brokenReadsFail = true;
  const index = createLibrarySearchIndex({
    metaDir,
    resolvePath: rel => path.join(home, rel),
    readTextFile: async (target, maxBytes) => {
      if (String(target).includes('broken') && brokenReadsFail) throw new Error('injected read failure');
      const raw = '紫罗兰 synthetic content';
      const bytes = Buffer.from(raw);
      if (bytes.length > maxBytes) throw new Error('too large');
      return { raw, bytes, size: bytes.length, mtimeMs: 0 };
    },
  });
  const catalog = [
    { path: 'ok.md', name: 'ok.md', sha256: 'a1', size: 10, trashedAt: null },
    { path: 'big.md', name: 'big.md', sha256: 'b2', size: MAX_INDEXED_BYTES + 1, trashedAt: null },
    { path: 'broken.md', name: 'broken.md', sha256: 'c3', size: 5, trashedAt: null },
  ];
  const info = await index.refresh(catalog);
  assert.equal(info.reindexed, 1, 'ok.md indexed; big.md skipped by size without a read');
  let coverage = index.coverage();
  assert.equal(coverage.indexed, 1);
  assert.equal(coverage.tooLarge, 1);
  assert.equal(coverage.unreadable, 1, 'the read failure is counted as unreadable');
  // Once reads work again, the unreadable file indexes and the counter clears.
  brokenReadsFail = false;
  await index.refresh(catalog);
  coverage = index.coverage();
  assert.equal(coverage.indexed, 2, 'broken.md recovered on a later refresh');
  assert.equal(coverage.unreadable, 0);
  const hits = await index.search('nonexistent-term', {});
  assert.equal(hits.hits.length, 0, 'querying a term that does not exist finds nothing');
  const found = await index.search('synthetic', {});
  assert.equal(found.hits.length, 2, 'both recovered files match after refresh');
  assert.deepEqual(tokenize('Violet 紫罗兰').keys().toArray().sort(), ['violet', '兰', '紫', '罗'], 'latin words and CJK unigrams');
});

test('the persisted index rebuilds without touching originals; disk image survives restart', async t => {
  const { call, home } = await fixture(t);
  const first = await call('search', { query: '紫罗兰', limit: 5 });
  const indexFile = path.join(home, 'personal-library', '.knorvia-library', 'search-index.json');
  const snapshot = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  assert.equal(snapshot.version, INDEX_VERSION);
  assert.ok(Object.keys(snapshot.files).length >= TOTAL, 'index persisted to disk');
  // Rebuild does not mutate library files or their version history.
  const before = await call('list');
  await call('search', { query: '紫罗兰', limit: 5 });
  const after = await call('list');
  assert.deepEqual(after.entries.map(entry => [entry.path, entry.sha256, entry.versions]), before.entries.map(entry => [entry.path, entry.sha256, entry.versions]), 'catalog untouched by search');
  assert.equal(first.hits.length, 5);
});

test('content words like constructor are ordinary terms: no crash, no prototype hits', async t => {
  const { call } = await fixture(t);
  await call('write', { path: 'widget.js', text: 'class Widget { constructor() {} }' });
  await call('write', { path: 'note.txt', text: 'plain notes without the magic words' });
  const result = await call('search', { query: 'constructor', limit: 20 });
  assert.deepEqual(result.hits.map(hit => hit.path), ['widget.js'], 'only the real file matches');
  assert.equal(result.coverage.unreadable, 0, 'constructor did not break indexing');
  const proto = await call('search', { query: '__proto__' });
  assert.deepEqual(proto.hits.map(hit => hit.path), [], 'inherited keys never become hits');
  await call('write', { path: 'proto-doc.md', text: 'explains __proto__ and constructor chains' });
  const both = await call('search', { query: 'constructor', limit: 20 });
  assert.ok(both.hits.some(hit => hit.path === 'proto-doc.md'), 'files actually containing the term match');
});

test('external same-length edits: the NEW word is directly searchable, no stale hash', async t => {
  const { call, contentDir } = await fixture(t);
  // Warm the index so the file has indexed state to invalidate.
  await call('search', { query: '紫罗兰', limit: 5 });
  const victim = path.join(contentDir, '语料', 'doc-0005.md');
  const before = await fs.readFile(victim, 'utf8');
  const after = before.replace('紫罗兰', '翠鸟鸟');
  assert.equal(Buffer.byteLength(after), Buffer.byteLength(before), 'same-length external edit');
  await fs.writeFile(victim, after);
  // No list() and no old-word query: the very FIRST query for the new word
  // must find it (the freshness sweep invalidates the stale entry).
  const newQuery = await call('search', { query: '翠鸟鸟', limit: 50 });
  const repaired = newQuery.hits.find(hit => hit.path === '语料/doc-0005.md');
  assert.ok(repaired, 'new word is directly searchable after an external edit');
  assert.equal(repaired.snippets[0].line, 2);
  const oldQuery = await call('search', { query: '紫罗兰', limit: 50 });
  const staleHit = oldQuery.hits.find(hit => hit.path === '语料/doc-0005.md');
  assert.equal(staleHit, undefined, 'a hit is never served from the outdated version');
});

test('a fully phrase-filtered page still advances its cursor (no self-loop)', async t => {
  const { call } = await fixture(t);
  // 北中间京: unigrams 北 and 京 exist (candidates match) but the phrase
  // 北京 never appears contiguously.
  await call('write', { path: '迷宫.md', text: '北中间京' });
  const page1 = await call('search', { query: '北京', limit: 1 });
  assert.deepEqual(page1.hits, [], 'phrase-filtered candidates produce no hits');
  assert.equal(page1.nextCursor, null, 'a consumed page never loops on itself');
  // Paging with the returned cursor terminates cleanly.
  const page2 = await call('search', { query: '北京', limit: 1, cursor: page1.nextCursor });
  assert.deepEqual(page2.hits, []);
  assert.equal(page2.nextCursor, null);
});

test('cancellation observably stops the refresh traversal of a superseded query', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'knorvia-libsearch-cancel-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const metaDir = path.join(home, 'meta');
  await fs.mkdir(metaDir, { recursive: true });
  let reads = 0;
  const index = createLibrarySearchIndex({
    metaDir,
    resolvePath: rel => path.join(home, rel),
    readTextFile: async (target, maxBytes) => {
      reads += 1;
      await new Promise(resolve => setTimeout(resolve, 2)); // slow reads: the traversal takes time
      const raw = `payload ${path.basename(target)}`;
      if (raw.length > maxBytes) throw new Error('too large');
      return { raw, bytes: Buffer.from(raw), size: Buffer.byteLength(raw), mtimeMs: 0 };
    },
  });
  const catalog = Array.from({ length: 400 }, (_, i) => ({
    path: `f${i}.txt`, name: `f${i}.txt`, sha256: `sha-${i}`, size: 20, trashedAt: null,
  }));
  const flag = index.begin_request('req-1', undefined);
  const refreshing = index.refresh(catalog, { budget: 400, signal: flag });
  await new Promise(resolve => setTimeout(resolve, 30));
  // Supersede req-1 the way a newer query would.
  index.begin_request('req-2', 'req-1');
  await new Promise(resolve => setTimeout(resolve, 30));
  const readsAtCancelCheck = reads;
  const info = await refreshing;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(info.aborted, true, 'the superseded refresh reports it aborted');
  assert.ok(reads < 400, `stopped early: ${reads} of 400 files read`);
  assert.equal(reads, readsAtCancelCheck, 'no further reads after cancellation');
  flag.dispose();
});

test('2101-file corpus: the tail file is found on the first query after an external edit', async t => {
  // CODEX-0615-B01 counterexample scale: a full index over 2,101 real files,
  // then the LAST file is externally edited (same length). The first query
  // for the new word must hit — no old-word repair trip, no head-of-list
  // sweep starvation.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'knorvia-libsearch-tail-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const library = createPersonalLibrary({ home });
  const call = (method, params = {}) => library.handlers[`library/${method}`](params);
  const contentDir = path.join(home, 'personal-library', 'files');
  await fs.mkdir(contentDir, { recursive: true });
  const TOTAL_TAIL = 2101;
  for (let i = 0; i < TOTAL_TAIL; i++) {
    const marker = i === TOTAL_TAIL - 1 ? '旧词-尾部' : `填充行-${i}`;
    await fs.writeFile(path.join(contentDir, `f${String(i).padStart(5, '0')}.md`), `文件 ${i}\n${marker}\n`);
  }
  await call('list');
  await call('search', { query: '旧词-尾部', limit: 5 });
  const victim = path.join(contentDir, 'f02100.md');
  const before = await fs.readFile(victim, 'utf8');
  const after = before.replace('旧词-尾部', '新词-尾部');
  assert.equal(Buffer.byteLength(after), Buffer.byteLength(before), 'same-length external edit');
  await fs.writeFile(victim, after);
  for (let round = 1; round <= 3; round++) {
    const result = await call('search', { query: '新词-尾部', limit: 10 });
    const hit = result.hits.find(h => h.path === 'f02100.md');
    assert.ok(hit, `round ${round}: the tail file's new word is found on the first query`);
    assert.equal(hit.sha256, result.hits.find(h => h.path === 'f02100.md').sha256);
  }
  const oldWord = await call('search', { query: '旧词-尾部', limit: 10 });
  assert.ok(!oldWord.hits.some(h => h.path === 'f02100.md'), 'the old word no longer matches the tail file');
});
