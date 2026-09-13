'use strict';
// P09 real-backend chain: exercises studio/article create/save/read against
// the actual knorvia-daemon binary (stdio frames, isolated Home). Covers the
// backend half of P09 acceptance: save with a stable idempotency key replays
// on duplicate submit, saves without a key keep the strict revision check
// (server-ahead conflict), a save whose response was lost is recoverable via
// read-back, and create is idempotent per key. No voice/build/render runs.
//
// Run: node run-p09-real-daemon.mjs --daemon <exe> --kernel <exe> --out <json>

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
const { createMediaStudio } = require(path.join(moduleRoot, 'desktop', 'media-studio'));
const { createPersonalLibrary } = require(path.join(moduleRoot, 'desktop', 'personal-library'));

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const daemonBin = arg('daemon', '');
const kernelBin = arg('kernel', '');
const outPath = arg('out', path.join(__dirname, 'result.json'));

const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); if (!ok) process.exitCode = 1; };

async function main() {
  if (!fs.existsSync(daemonBin)) throw new Error(`daemon not found: ${daemonBin}`);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-p09-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env };
  if (kernelBin && fs.existsSync(kernelBin)) env.KNORVIA_KERNEL_BIN = kernelBin;
  else if (kernelBin) throw new Error(`kernel not found: ${kernelBin}`);

  const session = startKnorviaDaemon({ daemonBin, home, env, requestTimeoutMs: 120000 });
  let studio = null;
  try {
    const init = await session.request(initializeRequest('p09_e2e', '1'));
    assert.ok(!init.error, JSON.stringify(init));
    session.notify({ jsonrpc: '2.0', method: 'initialized' });
    const rpc = async (method, params = {}) => {
      const r = await session.request({ jsonrpc: '2.0', id: `p09-${Math.random()}`, method, params });
      if (r.error) throw Object.assign(new Error(r.error.message), { rpc: r.error });
      return r.result;
    };
    // studio/article/* handlers live in the desktop layer (media-studio),
    // which persists projects as daemon jobs. This exercises the real
    // desktop handler code over the real daemon job store - the same
    // surface the Electron gateway exposes to the renderer.
    const library = createPersonalLibrary({ home, rpc });
    studio = createMediaStudio({ home, rpc, library });
    await studio.initialize();
    const rpc2 = async (method, params = {}) => studio.handlers[method](params);
    const create = { title: 'P09 实测', article: '开篇有清晰的想法，然后让声音引导场景。', audience: '', idempotencyKey: crypto.randomUUID() };
    const created = await rpc2('studio/article/create', create);
    record('create returns revision 1 project', created.id && created.revision === 1, `id=${created.id}`);

    // Duplicate create with the same key must not build a second project...
    let sameKeySameProject = false;
    let duplicateDetail = '';
    try {
      const again = await rpc2('studio/article/create', create);
      duplicateDetail = `again.id=${again.id} first.id=${created.id}`;
      sameKeySameProject = again.id === created.id;
    } catch (error) { duplicateDetail = `threw: ${error.message}`; }
    record('duplicate create with same key resolves to the same project', sameKeySameProject, duplicateDetail);

    // Save with a stable idempotency key; replay returns the stored result.
    const key = crypto.randomUUID();
    const first = await rpc2('studio/article/save', { id: created.id, revision: created.revision, narration: '第一段口播。\n\n第二段口播。', idempotencyKey: key });
    record('save advances the revision', first.revision === 2, `rev=${first.revision}`);
    const replay = await rpc2('studio/article/save', { id: created.id, revision: 1, narration: '第一段口播。\n\n第二段口播。', idempotencyKey: key });
    record('duplicate save replays the stored result without mutating', replay.revision === first.revision && replay.narration === first.narration, `rev=${replay.revision}`);

    // Save without a key: strict revision check (server-ahead conflict).
    let conflictMessage = '';
    try { await rpc2('studio/article/save', { id: created.id, revision: 1, narration: '过期内容' }); }
    catch (error) { conflictMessage = error.message; }
    record('stale save without key is rejected (optimistic concurrency)', /其他窗口|modified/.test(conflictMessage), conflictMessage);

    // Response-lost recovery: read-back shows the saved narration.
    const truth = await rpc2('studio/article/read', { id: created.id });
    record('read-back shows the landed save', truth.narration === '第一段口播。\n\n第二段口播。' && truth.revision === 2, `rev=${truth.revision}`);

    // A different key mutates again (no accidental memo hit).
    const second = await rpc2('studio/article/save', { id: created.id, revision: truth.revision, narration: '新版本口播', idempotencyKey: crypto.randomUUID() });
    record('a new key performs a real save', second.revision === 3, `rev=${second.revision}`);
  } finally {
    try { if (studio) await studio.close(); } catch { /* best effort */ }
    if (session?.child.exitCode === null) {
      session.child.stdin.end();
      await Promise.race([once(session.child, 'close'), delay(5000).then(() => { if (session.child.exitCode === null) session.child.kill(); })]);
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ results, measuredAt: new Date().toISOString(), daemon: daemonBin, daemonSha256_16: crypto.createHash('sha256').update(fs.readFileSync(daemonBin)).digest('hex').slice(0, 16) }, null, 2));
  }
}

main().catch(error => { console.error(error); record('fatal', false, String(error && error.stack || error).slice(0, 800)); process.exit(1); });
