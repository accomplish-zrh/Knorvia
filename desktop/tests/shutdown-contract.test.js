'use strict';

// C15→D shutdown contract: every D-owned service close/dispose resolves with
// { confirmed, ownedPids?, detail } instead of returning nothing, throwing or
// hanging; the media studio reports unconfirmed when its close chain exceeds
// the deadline. Targeted counterexamples only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSshSessions } = require('../ssh-session');
const { createWorkspaceTerminal } = require('../workspace-terminal');
const { createMediaStudio } = require('../media-studio');
const { createPersonalLibrary } = require('../personal-library');
const { createWorktreeSnapshots } = require('../worktree-snapshots');
const { createExtensionManager } = require('../extension-manager');

function sshFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-shutdown-ssh-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const rpc = async () => ({ workspace: { id: 'fixture', cwd: home }, absolutePath: home, kind: 'file' });
  const manager = createSshSessions({ home, rpc, safeStorage: { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(`enc:${v}`), decryptString: b => b.toString().slice(4) }, readyTimeout: 4000 });
  t.after(() => manager.dispose());
  return { home, manager, call: (method, params = {}) => manager.handlers[method](params) };
}

test('ssh dispose confirms and reports released transfers/forwards; no pids owned', async t => {
  const f = sshFixture(t);
  const outcome = await f.manager.dispose();
  assert.equal(outcome.confirmed, true);
  assert.deepEqual(outcome.ownedPids, []);
  assert.match(outcome.detail, /0 SSH session/);
  // A second dispose is an honest idempotent confirmation.
  const again = await f.manager.dispose();
  assert.equal(again.confirmed, true);
  assert.match(again.detail, /already disposed/);
});

test('terminal dispose confirms only after every owned PTY exit event arrives', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-shutdown-term-'));
  process.on('exit', () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} });
  const started = [];
  const manager = createWorkspaceTerminal({
    disposeTimeoutMs: 400,
    rpc: async () => ({ workspace: { id: 'p', cwd }, absolutePath: cwd, kind: 'directory' }),
    spawn: (executable, args, options) => {
      let exitHandler;
      const pty = { pid: 4000 + started.length, writes: [], write: () => {}, resize: () => {}, onData: () => {}, onExit: fn => { exitHandler = fn; }, kill() { this.killed = true; this.emitExit(); }, emitExit: () => exitHandler({ exitCode: 0 }) };
      started.push(pty);
      return pty;
    },
  });
  const scope = { threadId: 'shutdown-task' };
  await manager.handlers['terminal/open']({ ...scope, sessionId: randomUUID(), cols: 80, rows: 24 });
  await manager.handlers['terminal/open']({ ...scope, sessionId: randomUUID(), cols: 80, rows: 24 });
  // Both PTYs exit immediately on kill: dispose confirms with the pid inventory.
  const outcome = await manager.dispose();
  assert.equal(outcome.confirmed, true);
  assert.deepEqual(outcome.ownedPids, []);
  assert.match(outcome.detail, /all owned PTYs confirmed exit/);
  assert.equal(started.every(pty => pty.killed), true, 'every owned PTY received its termination');
  // Repeated dispose keeps reporting honestly; no fake success after the fact.
  const again = await manager.dispose();
  assert.equal(again.confirmed, true);
  assert.match(again.detail, /all owned PTYs confirmed exit/);
});

test('kill called without a following exit event stays unconfirmed and keeps the pid', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-shutdown-noexit-'));
  process.on('exit', () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} });
  const manager = createWorkspaceTerminal({
    disposeTimeoutMs: 120,
    rpc: async () => ({ workspace: { id: 'p', cwd }, absolutePath: cwd, kind: 'directory' }),
    spawn: () => { let exitHandler; const pty = { pid: 5001, writes: [], write: () => {}, resize: () => {}, onData: () => {}, onExit: fn => { exitHandler = fn; }, kill() { this.killed = true; } }; return pty; },
  });
  await manager.handlers['terminal/open']({ threadId: 't', sessionId: randomUUID(), cols: 80, rows: 24 });
  const outcome = await manager.dispose();
  assert.equal(outcome.confirmed, false, 'a kill whose exit event never arrives is not success');
  assert.deepEqual(outcome.ownedPids, [5001], 'the unconfirmed pid is retained for the shutdown controller');
  assert.match(outcome.detail, /did not confirm exit/);
  // The exit arriving late is honoured by a repeat dispose: it re-checks
  // instead of trusting the disposed flag — here it still stays honest.
  const stillUnconfirmed = await manager.dispose();
  assert.equal(stillUnconfirmed.confirmed, false);
});

test('a failing kill is reported as an unconfirmed owner, not success', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-shutdown-killfail-'));
  process.on('exit', () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} });
  const manager = createWorkspaceTerminal({
    disposeTimeoutMs: 100,
    rpc: async () => ({ workspace: { id: 'p', cwd }, absolutePath: cwd, kind: 'directory' }),
    spawn: () => { let exitHandler; const pty = { pid: 6002, writes: [], write: () => {}, resize: () => {}, onData: () => {}, onExit: fn => { exitHandler = fn; }, kill() { throw new Error('access denied'); } }; return pty; },
  });
  await manager.handlers['terminal/open']({ threadId: 't', sessionId: randomUUID(), cols: 80, rows: 24 });
  const outcome = await manager.dispose();
  assert.equal(outcome.confirmed, false);
  assert.deepEqual(outcome.ownedPids, [6002]);
  assert.match(outcome.detail, /kill failed: access denied/);
});

test('partial exits: only the PTYs without an exit event stay listed as unconfirmed', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-shutdown-partial-'));
  process.on('exit', () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} });
  const ptys = [];
  const manager = createWorkspaceTerminal({
    disposeTimeoutMs: 150,
    rpc: async () => ({ workspace: { id: 'p', cwd }, absolutePath: cwd, kind: 'directory' }),
    spawn: () => {
      let exitHandler;
      const pty = { pid: 7000 + ptys.length, writes: [], write: () => {}, resize: () => {}, onData: () => {}, onExit: fn => { exitHandler = fn; }, kill() { this.killed = true; }, emitExit: () => exitHandler({ exitCode: 0 }) };
      ptys.push(pty);
      return pty;
    },
  });
  await manager.handlers['terminal/open']({ threadId: 't', sessionId: randomUUID(), cols: 80, rows: 24 });
  await manager.handlers['terminal/open']({ threadId: 't', sessionId: randomUUID(), cols: 80, rows: 24 });
  // The first PTY exits on kill, the second ignores it entirely.
  ptys[0].kill = function () { this.killed = true; this.emitExit(); };
  const outcome = await manager.dispose();
  assert.equal(outcome.confirmed, false);
  assert.deepEqual(outcome.ownedPids, [7001], 'only the PTY without an exit event remains unconfirmed');
  // Once the straggler exits, a repeat dispose can finally confirm everything.
  ptys[1].emitExit();
  const after = await manager.dispose();
  assert.equal(after.confirmed, true);
  assert.deepEqual(after.ownedPids, []);
});

function studioFixture(t, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-shutdown-studio-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const puts = [];
  const library = {
    handlers: { 'library/list': async () => ({ entries: [] }), 'library/read': async () => { throw new Error('unused'); } },
    async put(source, destination) { puts.push(destination); return { id: 'lib-1', name: 'x', path: destination, sha256: '0'.repeat(64) }; },
  };
  const rpc = async (method) => {
    if (method === 'workspace/create') return { id: 'ws-shutdown' };
    if (method === 'job/list') return { jobs: [], total: 0 };
    throw new Error(`unexpected ${method}`);
  };
  const studio = createMediaStudio({ home, rpc, library, safeStorage: { isEncryptionAvailable: () => true, encryptString: v => v, decryptString: v => v }, pollMs: 5, ...overrides });
  return { studio, puts };
}

test('media studio close resolves with a confirmed structured result and memoizes it', async t => {
  const { studio } = studioFixture(t);
  await studio.initialize();
  const outcome = await studio.close();
  assert.equal(outcome.confirmed, true);
  assert.deepEqual(outcome.ownedPids, []);
  assert.match(outcome.detail, /closed/);
  const again = await studio.close();
  assert.equal(again, outcome, 'the shutdown outcome is reported identically on repeat calls');
});

test('a stuck close component is reported by name within the deadline while others still recover', async t => {
  const { studio } = studioFixture(t, { closeTimeoutMs: 150 });
  await studio.initialize();
  // Inject the never-completing close C15's counterexample asks for, on a
  // component D owns; every other close step keeps running to completion.
  studio.sequence.close = () => new Promise(() => {});
  const started = Date.now();
  const outcome = await studio.close();
  const elapsed = Date.now() - started;
  assert.equal(outcome.confirmed, false, 'an unfinished close chain is never reported as confirmed');
  assert.match(outcome.detail, /unconfirmed components: sequence/);
  assert.ok(!/article|playback/.test(outcome.detail.split('unconfirmed components:')[1]), 'settled components are not blamed');
  assert.ok(elapsed < 2000, `close resolved within the deadline instead of hanging (took ${elapsed}ms)`);
  const again = await studio.close();
  assert.equal(again.confirmed, false);
});

test('Home writers freeze admission before their shutdown drain receipts', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-writer-freeze-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const rpc = async () => { throw new Error('request must be rejected before RPC'); };
  const library = createPersonalLibrary({ home, rpc });
  const snapshots = createWorktreeSnapshots({ home, rpc });
  const extensions = createExtensionManager({ home, rpc, getBuiltinSkills: () => [] });
  assert.equal((await library.close()).confirmed, true);
  assert.equal((await snapshots.close()).confirmed, true);
  assert.equal((await extensions.close()).confirmed, true);
  await assert.rejects(
    library.handlers['library/write']({ path: 'late.txt', text: 'late' }),
    error => error.rpc?.code === -32000,
  );
  assert.throws(
    () => snapshots.handlers['worktree/snapshot/inspect']({ workspaceId: 'late' }),
    error => error.rpc?.code === -32000,
  );
  assert.throws(
    () => extensions.handlers['extension/enable']({ id: 'late', revision: 1, enabled: true }),
    error => error.rpc?.code === -32000,
  );
  assert.equal(fs.existsSync(path.join(home, 'personal-library', 'files', 'late.txt')), false);
});
