'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createWorkspaceTerminal, MAX_BUFFER, MAX_INPUT } = require(process.env.KNORVIA_TERMINAL_MODULE || '../workspace-terminal');

function fixture(spawn, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-terminal-中文 '));
  const scope = { threadId: 'terminal-test-task', sessionId: randomUUID() };
  const manager = createWorkspaceTerminal({ spawn, ...options, rpc: async (method, params) => {
    assert.equal(method, 'workspace/path/resolve'); assert.equal(params.threadId, scope.threadId); assert.equal(params.path, '');
    return { workspace: { id: 'test-project', cwd }, absolutePath: cwd, kind: 'directory' };
  } });
  return { manager, cwd, scope, call: (method, params) => manager.handlers[`terminal/${method}`]({ ...scope, ...params }) };
}
function fakePty() {
  const writes = []; let onData, onExit, kills = 0;
  const pty = { pid: 1, writes, write: data => writes.push(data), resize: () => {}, onData: fn => { onData = fn; }, onExit: fn => { onExit = fn; },
    kill: () => { kills++; onExit({ exitCode: 0 }); }, get kills() { return kills; }, output: data => onData(data) };
  // Test seam: fire the manager's exit handler with a chosen code without
  // going through kill().
  pty.emitExit = code => onExit({ exitCode: code });
  return pty;
}
test('scoped terminal rejects renderer-controlled commands, environment and unscoped access', async t => {
  let starts = 0; const f = fixture(() => { starts++; return fakePty(); }); t.after(() => f.manager.dispose());
  for (const extra of [{ cwd: 'C:\\' }, { env: { PATH: 'bad' } }, { command: 'bad' }, { shell: 'cmd.exe' }, { path: '..' }, { cols: 10000 }]) {
    await assert.rejects(f.call('open', { cols: 80, rows: 24, ...extra }), error => error.rpc.code === -32602);
  }
  assert.equal(starts, 0);
  await f.call('open', { cols: 80, rows: 24 });
  await assert.rejects(f.call('read', { threadId: 'another-task', cursor: 0 }), error => error.rpc.code === -32044);
  await assert.rejects(f.call('write', { seq: 1, data: 'x'.repeat(MAX_INPUT + 1) }), error => error.rpc.code === -32602);
});
test('concurrent open and input retries never duplicate a shell or side effect; closed tabs cannot restart', async t => {
  const pty = fakePty(); let starts = 0; const f = fixture(() => { starts++; return pty; }); t.after(() => f.manager.dispose());
  const pair = await Promise.all([f.call('open', { cols: 80, rows: 24 }), f.call('open', { cols: 90, rows: 30 })]);
  assert.equal(starts, 1); assert.equal(pair[0].pid, pair[1].pid);
  await f.call('write', { seq: 1, data: 'once\r' }); await f.call('write', { seq: 1, data: 'once\r' });
  assert.deepEqual(pty.writes, ['once\r']);
  await assert.rejects(f.call('write', { seq: 1, data: 'different\r' }), error => error.rpc.code === -32005);
  await assert.rejects(f.call('write', { seq: 3, data: 'out-of-order\r' }), error => error.rpc.code === -32005);
  await f.call('close'); await f.call('close'); assert.equal(pty.kills, 1);
  await assert.rejects(f.call('open', { cols: 80, rows: 24 }), error => error.rpc.code === -32044);
});
test('bounded output signals truncation and keeps Unicode intact; per-task capacity releases on close', async t => {
  const pty = fakePty(); const f = fixture(() => pty, { maxPerThread: 1 }); t.after(() => f.manager.dispose());
  await f.call('open', { cols: 80, rows: 24 });
  pty.output('🟢'.repeat(MAX_BUFFER));
  let snapshot = await f.call('read', { cursor: 0 }); assert.equal(snapshot.truncated, true); assert.equal(snapshot.data.isWellFormed(), true);
  let count = snapshot.data.length;
  while (snapshot.hasMore) { snapshot = await f.call('read', { cursor: snapshot.cursor }); count += snapshot.data.length; assert.equal(snapshot.data.isWellFormed(), true); }
  assert.equal(count, MAX_BUFFER);
  await assert.rejects(f.call('open', { sessionId: randomUUID(), cols: 80, rows: 24 }), error => error.rpc.code === -32045);
  await f.call('close'); await f.call('open', { sessionId: randomUUID(), cols: 80, rows: 24 });
});
test('a failed input write remains unknown on retry without repeating its side effect', async t => {
  const pty = fakePty(); let writes = 0; pty.write = () => { writes++; throw new Error('write outcome unknown'); };
  const f = fixture(() => pty); t.after(() => f.manager.dispose());
  await f.call('open', { cols: 80, rows: 24 });
  for (let i = 0; i < 2; i++) await assert.rejects(f.call('write', { seq: 1, data: 'once\r' }), error => error.rpc.code === -32047);
  assert.equal(writes, 1); assert.equal((await f.call('read', { cursor: 0 })).inputSeq, 1);
});
test('closing or disposing during directory resolution prevents a late shell launch', async () => {
  let resolve, starts = 0;
  const cwd = os.tmpdir(), scope = { threadId: 'pending', sessionId: randomUUID() };
  const manager = createWorkspaceTerminal({ spawn: () => { starts++; return fakePty(); }, rpc: () => new Promise(done => { resolve = done; }) });
  const opened = manager.handlers['terminal/open']({ ...scope, cols: 80, rows: 24 });
  const rejected = assert.rejects(opened, error => error.rpc.code === -32044);
  const closing = manager.handlers['terminal/close'](scope);
  resolve({ workspace: { id: 'test', cwd }, absolutePath: cwd, kind: 'directory' });
  await rejected; await closing; manager.dispose(); assert.equal(starts, 0);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(60); }
  assert.fail(message);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function consoleChildren() {
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const command = `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${process.pid}' | Where-Object { $_.Name -in @('conhost.exe','OpenConsole.exe') }).Count`;
  return Number(execFileSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8', timeout: 6000 }).trim());
}
test('real ConPTY runs Unicode in its scoped cwd, resizes, interrupts, resumes and kills child processes', { skip: process.platform !== 'win32', timeout: 35000 }, async t => {
  const initialConsoles = consoleChildren();
  const f = fixture(); t.after(() => f.manager.dispose());
  const opened = await f.call('open', { cols: 85, rows: 25 }); assert.ok(opened.pid > 0); assert.equal(opened.cwd, fs.realpathSync(f.cwd));
  let seq = 0;
  const write = data => f.call('write', { seq: ++seq, data });
  await write("$knorviaValue='中文保留'; [IO.File]::WriteAllText((Join-Path $pwd 'cwd.txt'), $pwd.Path)\r");
  await until(() => fs.existsSync(path.join(f.cwd, 'cwd.txt')), 'PowerShell did not write in scoped cwd');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'cwd.txt'), 'utf8'), opened.cwd);
  await f.call('resize', { cols: 102, rows: 34 }); assert.equal((await f.call('read', { cursor: 0 })).cols, 102);
  const node = (process.env.KNORVIA_TERMINAL_TEST_NODE || 'D:\\node-v26.3.0-win-x64\\node.exe').replaceAll("'", "''");
  fs.writeFileSync(path.join(f.cwd, 'child.js'), 'require("fs").writeFileSync("child.pid",String(process.pid));setInterval(()=>{},1000)');
  fs.writeFileSync(path.join(f.cwd, 'child2.js'), 'require("fs").writeFileSync("child2.pid",String(process.pid));setInterval(()=>{},1000)');
  await write(`& '${node}' child.js\r`);
  const childFile = path.join(f.cwd, 'child.pid');
  await until(() => fs.existsSync(childFile), 'Foreground child did not start');
  const child = Number(fs.readFileSync(childFile, 'utf8')); assert.ok(alive(child));
  await write('\x03'); await until(() => !alive(child), 'Ctrl+C did not interrupt foreground child');
  await write("[IO.File]::WriteAllText((Join-Path $pwd 'resumed.txt'), $knorviaValue)\r");
  await until(() => fs.existsSync(path.join(f.cwd, 'resumed.txt')), 'Shell did not resume after Ctrl+C');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'resumed.txt'), 'utf8'), '中文保留');
  assert.equal((await f.manager.handlers['terminal/list']({ threadId: f.scope.threadId }))[0].pid, opened.pid);
  await write(`& '${node}' child2.js\r`);
  await until(() => fs.existsSync(path.join(f.cwd, 'child2.pid')), 'Second foreground child did not start');
  const child2 = Number(fs.readFileSync(path.join(f.cwd, 'child2.pid'), 'utf8'));
  await f.call('close'); await until(() => !alive(opened.pid) && !alive(child2), 'Closing terminal left its shell or child alive');
  assert.deepEqual(await f.manager.handlers['terminal/list']({ threadId: f.scope.threadId }), []);
  const exited = await f.call('open', { sessionId: randomUUID(), cols: 80, rows: 24 });
  await f.call('write', { sessionId: exited.sessionId, seq: 1, data: 'exit 7\r' });
  await until(async () => (await f.call('read', { sessionId: exited.sessionId, cursor: 0 })).status === 'exited', 'Normal shell exit was not reported');
  assert.equal((await f.call('read', { sessionId: exited.sessionId, cursor: 0 })).exitCode, 7);
  const finalSession = await f.call('open', { sessionId: randomUUID(), cols: 80, rows: 24 });
  f.manager.dispose(); await until(() => !alive(finalSession.pid), 'Host shutdown left a terminal shell alive');
  await until(() => consoleChildren() === initialConsoles, 'Terminal left a hidden Windows console host alive');
  console.log(JSON.stringify({ realConPTY: true, shellPid: opened.pid, childPid: child, terminatedChildPid: child2, cwd: f.cwd }));
});

test('terminal methods require an explicit host handler and never fall through to the daemon', async () => {
  const { createNativeRpcRouter } = require('../native-rpc-router');
  let forwarded = 0; const router = createNativeRpcRouter({ rpc: async () => { forwarded++; } });
  for (const method of ['open', 'list', 'read', 'write', 'resize', 'close']) {
    const result = await router.handle({ jsonrpc: '2.0', id: method, method: `terminal/${method}`, params: {} });
    assert.equal(result.error.code, -32601);
  }
  assert.equal(forwarded, 0); router.dispose();
});

// ---- C04 nightshift additions: running quota vs bounded exited history ----

function delayedPty() {
  // kill() only requests the exit; the exit event fires when the test
  // releases it, so the closing window is observable.
  const inner = fakePty();
  const fires = [];
  inner.kill = () => { fires.push(() => inner.emitExit(0)); };
  inner.releaseExit = () => { for (const fire of fires.splice(0)) fire(); };
  return inner;
}

test('a natural exit frees the running quota while the record stays readable, then expires', async t => {
  const created = [];
  const f = fixture(() => { const p = fakePty(); created.push(p); return p; }, { maxPerThread: 1, maxExitedPerThread: 2, maxExitedTotal: 2, exitedRetentionMs: 400 });
  t.after(() => f.manager.dispose());
  const first = await f.call('open', { cols: 80, rows: 24 });
  created[0].output('first output\n');
  // Natural exit while a second terminal wants the slot: history, not quota.
  created[0].emitExit(7);
  const second = await f.call('open', { sessionId: randomUUID(), cols: 80, rows: 24 });
  assert.notEqual(second.sessionId, first.sessionId);
  const still = await f.call('read', { sessionId: first.sessionId, cursor: 0 });
  assert.equal(still.status, 'exited');
  assert.equal(still.exitCode, 7);
  assert.match(still.data, /first output/);
  assert.ok(still.exitedAt, 'exited records expose their exit time');
  await assert.rejects(f.call('write', { sessionId: first.sessionId, seq: 1, data: 'no\r' }), error => error.rpc.code === -32044, 'input to an exited record is refused');
  // After the retention window the record expires: cursors and close retries
  // get the same clear ended answer.
  await f.call('close', { sessionId: second.sessionId });
  await delay(450);
  await f.call('open', { sessionId: randomUUID(), cols: 80, rows: 24 });
  await assert.rejects(f.call('read', { sessionId: first.sessionId, cursor: 0 }), error => error.rpc.code === -32044);
  const listed = await f.manager.handlers['terminal/list']({ threadId: f.scope.threadId });
  assert.equal(listed.some(row => row.sessionId === first.sessionId), false);
});

test('exited history is bounded per thread; eviction answers stay stable', async t => {
  const created = [];
  const f = fixture(() => { const p = fakePty(); created.push(p); return p; }, { maxPerThread: 1, maxExitedPerThread: 2, maxExitedTotal: 2, exitedRetentionMs: 60_000 });
  t.after(() => f.manager.dispose());
  const exits = [];
  for (let i = 0; i < 4; i++) {
    const session = await f.call('open', { sessionId: randomUUID(), cols: 80, rows: 24 });
    exits.push(session.sessionId);
    created[created.length - 1].emitExit(i);
  }
  const listed = await f.manager.handlers['terminal/list']({ threadId: f.scope.threadId });
  const exitedIds = listed.filter(row => row.status === 'exited').map(row => row.sessionId);
  assert.deepEqual(exitedIds, exits.slice(-2), 'only the newest exits are retained');
  for (const id of exits.slice(0, 2)) {
    await assert.rejects(f.call('read', { sessionId: id, cursor: 0 }), error => error.rpc.code === -32044);
    assert.equal((await f.call('close', { sessionId: id })).closed, true, 'close on an evicted record is honest and stable');
  }
  for (const id of exits.slice(-2)) assert.equal((await f.call('read', { sessionId: id, cursor: 0 })).status, 'exited');
});

test('exited history keeps a bounded output tail instead of the whole buffer', async t => {
  const created = [];
  const f = fixture(() => { const p = fakePty(); created.push(p); return p; }, { maxExitedPerThread: 4, maxExitedTotal: 4, exitedRetentionMs: 60_000, exitedBufferMax: 1024 });
  t.after(() => f.manager.dispose());
  const session = await f.call('open', { cols: 80, rows: 24 });
  created[0].output('x'.repeat(4096));
  created[0].output('tail-kept\n');
  created[0].emitExit(3);
  let page = await f.call('read', { sessionId: session.sessionId, cursor: 0 });
  assert.equal(page.truncated, true, 'the trimmed front is reported as truncated');
  assert.equal(page.exitCode, 3);
  let total = page.data.length;
  let tailSeen = page.data.includes('tail-kept');
  while (page.hasMore) {
    page = await f.call('read', { sessionId: session.sessionId, cursor: page.cursor });
    total += page.data.length;
    tailSeen = tailSeen || page.data.includes('tail-kept');
  }
  assert.ok(total <= 1024 + 32, `retained output must be bounded, got ${total}`);
  assert.equal(tailSeen, true, 'the most recent output survives the trim');
});

test('a closing terminal keeps occupying the running quota until its exit confirms', async t => {
  const created = [];
  const f = fixture(() => { const p = delayedPty(); created.push(p); return p; }, { maxPerThread: 1 });
  t.after(() => f.manager.dispose());
  const first = await f.call('open', { cols: 80, rows: 24 });
  await f.call('close', { sessionId: first.sessionId });
  await assert.rejects(f.call('open', { sessionId: randomUUID(), cols: 80, rows: 24 }), error => error.rpc.code === -32045, 'closing still holds the slot');
  created[0].releaseExit();
  const second = await f.call('open', { sessionId: randomUUID(), cols: 80, rows: 24 });
  assert.ok(second.sessionId, 'the slot is released once the exit event confirms');
});

// ---- CODEX-0215-C04 additions: quota reservations across async resolution ----

function quotaHarness(options = {}) {
  const cwd = os.tmpdir();
  let spawns = 0;
  const rpcWaiters = [];
  const manager = createWorkspaceTerminal({
    spawn: () => { spawns += 1; return fakePty(); },
    rpc: (method, params) => new Promise((resolve, reject) => { rpcWaiters.push({ resolve, reject, method, params }); }),
    ...options,
  });
  const drainResolve = () => { for (const waiter of rpcWaiters.splice(0)) waiter.resolve({ workspace: { id: 'q', cwd }, absolutePath: cwd, kind: 'directory' }); };
  const drainReject = () => { for (const waiter of rpcWaiters.splice(0)) waiter.reject(new Error('resolver refused')); };
  return { manager, spawns: () => spawns, rpcWaiters, drainResolve, drainReject, dispose: () => manager.dispose() };
}

const settle = promise => promise.then(v => ({ ok: true, v }), e => ({ ok: false, e }));

test('concurrent opens cannot bypass the running quota', async t => {
  const harness = quotaHarness({ maxSessions: 1, maxPerThread: 1 });
  t.after(() => harness.dispose());
  const r1 = settle(harness.manager.handlers['terminal/open']({ threadId: 'q', sessionId: randomUUID(), cols: 80, rows: 24 }));
  const r2 = settle(harness.manager.handlers['terminal/open']({ threadId: 'q', sessionId: randomUUID(), cols: 80, rows: 24 }));
  await delay(80);
  // The second open is refused immediately: the first hold's reservation
  // already occupies the whole quota before any resolution lands.
  assert.equal(harness.rpcWaiters.length, 1, 'the quota is reserved before resolution, so the second open never reaches the resolver');
  assert.equal(harness.spawns(), 0, 'no shell spawns while the quota is reserved');
  harness.drainResolve();
  const settled = await Promise.all([r1, r2]);
  assert.equal(settled.filter(s => s.ok).length, 1, 'exactly one open wins');
  const loser = settled.find(s => !s.ok);
  assert.equal(loser.e.rpc.code, -32045, 'the loser is refused by the reserved quota');
  assert.equal(harness.spawns(), 1, 'only one shell spawns');
});

test('a failed resolution releases its reservation so later opens work', async t => {
  const harness = quotaHarness({ maxSessions: 1, maxPerThread: 1 });
  t.after(() => harness.dispose());
  const first = settle(harness.manager.handlers['terminal/open']({ threadId: 'q', sessionId: randomUUID(), cols: 80, rows: 24 }));
  await delay(50);
  harness.drainReject();
  const firstResult = await first;
  assert.match(firstResult.e.message, /resolver refused/, 'the resolver refusal surfaces');
  const second = settle(harness.manager.handlers['terminal/open']({ threadId: 'q', sessionId: randomUUID(), cols: 80, rows: 24 }));
  await delay(50);
  harness.drainResolve();
  const secondResult = await second;
  assert.ok(secondResult.v.sessionId, 'the reservation was released: a later open succeeds');
  assert.equal(harness.spawns(), 1);
});

test('duplicate concurrent opens of one session hold a single quota slot and spawn once', async t => {
  const harness = quotaHarness({ maxSessions: 1, maxPerThread: 1 });
  t.after(() => harness.dispose());
  const sessionId = randomUUID();
  const r1 = settle(harness.manager.handlers['terminal/open']({ threadId: 'q', sessionId, cols: 80, rows: 24 }));
  const r2 = settle(harness.manager.handlers['terminal/open']({ threadId: 'q', sessionId, cols: 80, rows: 24 }));
  await delay(80);
  harness.drainResolve();
  const settled = await Promise.all([r1, r2]);
  assert.equal(settled.filter(s => s.ok).length, 2, 'both callers receive the same session');
  assert.equal(harness.spawns(), 1, 'exactly one shell spawns');
});
