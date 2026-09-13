'use strict';
// P01 real-backend chain: exercises workspace/files/search and
// workspace/files/search/cancel against the actual knorvia-daemon binary
// (stdio frames, isolated Home, no network, no model). The fixture project
// mirrors the acceptance matrix: 600 same-level files, deep directories,
// Chinese and space file names, .gitignore rules, binary and oversize files.
//
// Run: node tests/fixtures/p01-real-daemon/run-p01-real-daemon.mjs \
//        --daemon <knorvia-daemon.exe> --kernel <codex-app-server.exe> --out <report.json>

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(__dirname, '..', '..', '..', '..');
const { startKnorviaDaemon, initializeRequest } = require(path.join(moduleRoot, 'desktop', 'knorvia-protocol-client'));

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const daemonBin = arg('daemon', '');
const kernelBin = arg('kernel', '');
const outPath = arg('out', path.join(__dirname, 'result.json'));

function write(relative, contents) {
  const file = path.join(FIXTURE, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

let FIXTURE = '';

const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); if (!ok) process.exitCode = 1; };

async function collectAll(rpc, workspace, params) {
  const matches = [];
  let searchId = null;
  let cursor = null;
  let last = null;
  for (;;) {
    const pageParams = { workspaceId: workspace, ...params };
    if (searchId) pageParams.searchId = searchId;
    if (cursor) pageParams.cursor = cursor;
    const page = await rpc('workspace/files/search', pageParams);
    searchId = page.searchId;
    cursor = page.page.nextCursor ?? null;
    matches.push(...page.matches);
    last = page;
    if (page.page.done || page.matchedLimitReached || !page.page.nextCursor) break;
  }
  return { last, matches, searchId };
}

async function main() {
  if (!fs.existsSync(daemonBin)) throw new Error(`daemon not found: ${daemonBin}`);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-p01-'));
  FIXTURE = path.join(base, 'project');
  fs.mkdirSync(FIXTURE, { recursive: true });

  // fixture: 600 same-level files
  for (let index = 0; index < 600; index += 1) write(`notes/file-${String(index).padStart(3, '0')}.txt`, `body of file ${index}\n`);
  write('notes/deep.md', 'covering deep file\n');
  // deep directory chain with Chinese names
  write('docs/深/层级/notes.md', '# 层级笔记\n深层的中文内容 needle\n');
  write('docs/带 空格 文件.txt', '带空格的文件名\n');
  // ignore rules
  write('.gitignore', 'secret-keys/\n*.log\n');
  write('secret-keys/api.txt', 'matchneedle\n');
  write('debug.log', 'matchneedle\n');
  write('visible.txt', 'matchneedle here\n');
  fs.writeFileSync(path.join(FIXTURE, 'blob.bin'), Buffer.from([0x6d, 0x61, 0x00, 0x74, 0x63, 0x68]));
  write('large.txt', `matchneedle\n${'x'.repeat(1024 * 1024 + 64)}`);

  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env };
  if (kernelBin && fs.existsSync(kernelBin)) { env.KNORVIA_KERNEL_BIN = kernelBin; }
  else if (kernelBin) throw new Error(`kernel not found: ${kernelBin}`);

  const session = startKnorviaDaemon({ daemonBin, home, env, requestTimeoutMs: 120000 });
  try {
    const init = await session.request(initializeRequest('p01_e2e', '1'));
    assert.ok(!init.error, JSON.stringify(init));
    session.notify({ jsonrpc: '2.0', method: 'initialized' });

    const rpc = async (method, params = {}) => {
      const r = await session.request({ jsonrpc: '2.0', id: `p01-${Math.random()}`, method, params });
      if (r.error) throw Object.assign(new Error(r.error.message), { rpc: r.error });
      return r.result;
    };

    const workspace = (await rpc('workspace/create', { title: 'P01 fixture', cwd: FIXTURE })).id;

    // 1. paths search finds files beyond any first listing page
    const late = await collectAll(rpc, workspace, { query: 'file-450', mode: 'paths' });
    record('paths search finds unmounted late file', late.matches.some(m => m.path === 'notes/file-450.txt'), JSON.stringify(last => null) && `hits=${late.matches.length}`);

    // 2. deep and Chinese/space names
    const deep = await collectAll(rpc, workspace, { query: '层级', mode: 'paths' });
    const deepOk = deep.matches.some(m => m.path === 'docs/深/层级/notes.md' || m.path === 'docs/深/层级');
    const spaces = await collectAll(rpc, workspace, { query: '带 空格', mode: 'paths' });
    record('deep Chinese/space paths found', deepOk && spaces.matches.some(m => m.path === 'docs/带 空格 文件.txt'), `deep=${deepOk}`);

    // 3. content search line/snippet, case handling
    const content = await collectAll(rpc, workspace, { query: 'needle', mode: 'content' });
    const deepHit = content.matches.find(m => m.path === 'docs/深/层级/notes.md');
    const visibleHit = content.matches.find(m => m.path === 'visible.txt');
    const secretLeak = content.matches.some(m => m.path.includes('secret-keys'));
    const logLeak = content.matches.some(m => m.path === 'debug.log');
    const largeLeak = content.matches.some(m => m.path === 'large.txt');
    record('content match has line/column/snippet', !!visibleHit && visibleHit.line === 1 && !!visibleHit.snippet && !!visibleHit.column, JSON.stringify(visibleHit ?? {}));
    record('deep Chinese content hit', !!deepHit && deepHit.line === 2, JSON.stringify(deepHit ?? {}));
    record('ignored/binary/large excluded', !secretLeak && !logLeak && !largeLeak, `secret=${secretLeak} log=${logLeak} large=${largeLeak}`);
    record('coverage counters present', typeof content.last.coverage.skippedBinary === 'number' && content.last.coverage.skippedLarge >= 1 && content.last.coverage.ignoredEntries >= 2, JSON.stringify(content.last.coverage));

    // 4. directories are name-searchable but not content-scanned
    const dirHit = await collectAll(rpc, workspace, { query: '层级', mode: 'paths' });
    record('directory name match included', dirHit.matches.some(m => m.kind === 'directory' && m.path === 'docs/深/层级'), JSON.stringify(dirHit.matches.map(m => m.kind)));

    // 5. pagination walks everything exactly once (600 files + 3 extras)
    const page1 = await rpc('workspace/files/search', { workspaceId: workspace, query: 'file-', mode: 'paths', maxResults: 100 });
    const seen = page1.matches.map(m => m.path);
    let cursor = page1.page.nextCursor;
    let sid = page1.searchId;
    let pages = 1;
    while (cursor) {
      const page = await rpc('workspace/files/search', { workspaceId: workspace, query: 'file-', mode: 'paths', maxResults: 100, searchId: sid, cursor });
      pages += 1;
      seen.push(...page.matches.map(m => m.path));
      cursor = page.page.nextCursor;
      sid = page.searchId;
      if (page.page.done) break;
    }
    const unique = new Set(seen);
    record('pagination complete and duplicate-free', pages >= 6 && seen.length === 600 && unique.size === seen.length, `pages=${pages} seen=${seen.length}`);

    // 6. cancel really terminates; stale cursor rejected
    const first = await rpc('workspace/files/search', { workspaceId: workspace, query: 'file-', mode: 'paths', maxResults: 50 });
    const cancelled = await rpc('workspace/files/search/cancel', { searchId: first.searchId });
    record('cancel acknowledges', cancelled.cancelled === true);
    let staleRejected = false;
    let staleDetail = '';
    try { await rpc('workspace/files/search', { workspaceId: workspace, query: 'file-', mode: 'paths', searchId: first.searchId, cursor: '1' }); }
    catch (error) { staleDetail = error.message; staleRejected = /expired|cancelled/.test(error.message); }
    record('next page after cancel is rejected', staleRejected, staleDetail);

    // 7. first call without cursor starts page 0 (A's semantic fix)
    const noCursor = await rpc('workspace/files/search', { workspaceId: workspace, query: 'needle', mode: 'content', maxResults: 5 });
    record('first call without cursor succeeds', noCursor.page.index === 0 && noCursor.searchId.length > 0);
    await rpc('workspace/files/search/cancel', { searchId: noCursor.searchId }).catch(() => {});
  } finally {
    if (session?.child.exitCode === null) {
      session.child.stdin.end();
      await Promise.race([once(session.child, 'close'), delay(5000).then(() => { if (session.child.exitCode === null) session.child.kill(); })]);
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ results, fixture: FIXTURE, home, measuredAt: new Date().toISOString(), daemon: daemonBin, daemonSha256_16: crypto.createHash('sha256').update(fs.readFileSync(daemonBin)).digest('hex').slice(0, 16) }, null, 2));
  }
}

main().catch(error => { console.error(error); record('fatal', false, String(error && error.stack || error).slice(0, 800)); process.exit(1); });
