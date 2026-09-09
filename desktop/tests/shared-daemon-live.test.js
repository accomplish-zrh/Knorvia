'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { startKnorviaDaemon, initializeRequest, encodeFrame } = require('../knorvia-protocol-client');
const { startScriptedResponsesFixture } = require('./fixtures/scripted-responses-fixture');
const { poll, assertCompleted } = require('../scripts/native-acceptance');

test('CLI and independent stdio clients share one owner, isolate sessions and survive detach', {
  skip: process.env.KNORVIA_RUN_SHARED_DAEMON_TESTS !== '1', timeout: 120_000,
}, async () => {
  const daemon = process.env.KNORVIA_DAEMON_BIN;
  const cli = process.env.KNORVIA_CLI_BIN;
  const kernel = process.env.KNORVIA_KERNEL_BIN;
  for (const binary of [daemon, cli, kernel]) assert.ok(binary && fs.existsSync(binary), 'required live binary missing');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-shared-live-'));
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(home, 'bin'));
  const daemonCopy = path.join(home, 'bin', 'knorvia-daemon.exe');
  fs.copyFileSync(daemon, daemonCopy);
  const fixture = await startScriptedResponsesFixture({ slowDelayMs: 60_000 });
  const env = { ...process.env, ...fixture.providerEnv, KNORVIA_DAEMON_BIN: daemonCopy, KNORVIA_TRANSPORT_TRACE: '1' };
  const clients = [];
  async function connect(initialize = true) {
    const session = startKnorviaDaemon({ daemonBin: daemonCopy, home, env, requestTimeoutMs: 15_000 });
    let diagnostics = '';
    session.child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-4000); });
    clients.push(session);
    let id = 0;
    session.rpc = async (method, params = {}) => {
      const response = await session.request({ jsonrpc: '2.0', id: ++id, method, params });
      if (response.error) { const error = new Error(JSON.stringify(response.error)); error.rpc = response.error; throw error; }
      return response.result;
    };
    if (initialize) {
      const init = await session.request(initializeRequest('knorvia_shared_test', '1')).catch((error) => {
        throw new Error(`${error.message}; client ${clients.length}: ${diagnostics}`);
      });
      assert.ok(init.result, JSON.stringify(init));
      session.notify({ jsonrpc: '2.0', method: 'initialized' });
    }
    return session;
  }
  async function detach(session) {
    if (session.child.exitCode !== null || session.child.signalCode !== null) return;
    const exited = once(session.child, 'close');
    session.child.stdin.end();
    await exited;
  }
  try {
    const first = await connect();
    const owner = JSON.parse(fs.readFileSync(path.join(home, 'run', 'shared-owner.json'), 'utf8'));
    const second = await connect();
    const unready = await connect(false);
    await assert.rejects(unready.rpc('workspace/list'), (error) => error.rpc.data.category === 'NOT_INITIALIZED');
    await detach(unready);
    // Same JSON-RPC ids from separate clients must return to the right caller.
    const [one, two] = await Promise.all([
      first.rpc('workspace/create', { title: 'first-client', cwd: workspace }),
      second.rpc('workspace/create', { title: 'second-client', cwd: workspace }),
    ]);
    assert.equal(one.title, 'first-client');
    assert.equal(two.title, 'second-client');
    assert.notEqual(one.id, two.id);
    const result = await promisify(execFile)(cli, ['--home', home, 'workspace', 'list'],
      { env, windowsHide: true, timeout: 15_000 });
    const workspaces = JSON.parse(result.stdout);
    assert.ok(workspaces.some((entry) => entry.id === one.id));
    assert.ok(workspaces.some((entry) => entry.id === two.id));
    await assert.rejects(first.rpc('system/prepareRestart'), (error) => error.rpc.data.category === 'CONFLICT');
    const invalid = net.connect(owner.port, '127.0.0.1');
    invalid.on('error', () => {});
    await once(invalid, 'connect');
    let leaked = '';
    invalid.on('data', (data) => { leaked += data; });
    const rejected = once(invalid, 'close');
    invalid.write(encodeFrame(JSON.stringify({ token: 'incorrect-token' })));
    await rejected;
    assert.equal(leaked, '', 'unauthenticated peers must not receive product data');
    const thread = await first.rpc('thread/start', { workspaceId: one.id, title: 'shared live task', cwd: workspace });
    const turn = await first.rpc('turn/start', { threadId: thread.id, input: '[slow] survive first client detach', tools: { write: false }, cwd: workspace });
    const turnId = turn.turn?.id || turn.id;
    await poll(async () => fixture.requests, (requests) => requests.some((request) => request.kind === 'slow'));
    await detach(first);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'run', 'shared-owner.json'), 'utf8')).pid, owner.pid);
    assert.equal((await second.rpc('turn/read', { id: turnId })).status, 'running');
    fixture.releaseSlowTurns();
    const terminal = await poll(() => second.rpc('turn/read', { id: turnId }), (snapshot) => snapshot.status !== 'running');
    assertCompleted(terminal, 'slow fixture released');
    await detach(second);
    await poll(async () => fs.existsSync(path.join(home, 'run', 'shared-owner.json')), (exists) => !exists);
  } finally {
    fixture.releaseSlowTurns();
    for (const session of clients) await detach(session);
    await fixture.close();
  }
});
