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
  return { pid: 1, writes, write: data => writes.push(data), resize: () => {}, onData: fn => { onData = fn; }, onExit: fn => { onExit = fn; },
    kill: () => { kills++; onExit({ exitCode: 0 }); }, get kills() { return kills; }, output: data => onData(data) };
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
