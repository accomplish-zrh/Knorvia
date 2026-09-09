'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isAgentApiPath,
  isUserCodexShim,
  resolveDaemonBin,
  createKernelEngine,
} = require('../kernel-engine');
const { engineCommand } = require('../knorvia-protocol-client');
const DAEMON = process.env.KNORVIA_DAEMON_BIN || path.resolve(__dirname, '../../../knorvia-kernel/knorvia-rs/target/debug/knorvia-daemon.exe');

function waitFor(predicate, description, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${description}`));
      setTimeout(check, 20);
    };
    check();
  });
}

test('agent API paths are Thread/Turn/session only', () => {
  assert.equal(isAgentApiPath('/api/v1/ws'), true);
  assert.equal(isAgentApiPath('/api/v1/chat/sessions'), true);
  assert.equal(isAgentApiPath('/api/v1/sessions?limit=10'), true);
  assert.equal(isAgentApiPath('/api/v1/knorvia/packs'), true);
  assert.equal(isAgentApiPath('/api/v1/knorvia/activity?streamId=1'), true);
  assert.equal(isAgentApiPath('/api/v1/knorvia-other'), false);
  assert.equal(isAgentApiPath('/api/v1/knowledge/list'), false);
  assert.equal(isAgentApiPath('/api/v1/settings/ui'), false);
});

test('resolveDaemonBin never returns a user Codex shim', () => {
  const bin = resolveDaemonBin({
    env: { KNORVIA_DAEMON_BIN: DAEMON },
  });
  assert.ok(bin.toLowerCase().includes('knorvia-daemon'));
  assert.equal(isUserCodexShim(bin), false);
  assert.equal(
    isUserCodexShim('D:\\node-v26.3.0-win-x64\\node_modules\\@openai\\codex\\bin\\codex.js'),
    true,
  );
  const cmd = engineCommand({ daemonBin: bin, home: os.tmpdir() });
  assert.equal(cmd.identity, 'knorvia-daemon');
  assert.ok(!String(cmd.bin).toLowerCase().includes('ipc_bridge'));
});

test('createKernelEngine talks to real development daemon and reports provider failure honestly', {
  skip: !fs.existsSync(DAEMON), timeout: 30000,
}, async () => {
  const daemon = DAEMON;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-engine-'));
  const engine = await createKernelEngine({
    home,
    env: { ...process.env, KNORVIA_DAEMON_BIN: daemon, KNORVIA_PROVIDER_MODEL: '', KNORVIA_PROVIDER_API_KEY: '', KNORVIA_PROVIDER_BASE_URL: '' },
    version: 'test',
  });
  try {
    assert.equal(engine.identity, 'knorvia-daemon');
    assert.equal(engine.initialize.server.name, 'knorvia-daemon');
    const http = await engine.handleHttp({ method: 'GET', path: '/api/v1/sessions' });
    assert.equal(http.status, 200);
    const detail = await engine.handleHttp({ method: 'GET', path: '/api/v1/sessions/not-a-list' });
    assert.equal(detail.status, 410);
    const gone = await engine.handleHttp({ method: 'POST', path: '/api/v1/chat/sessions' });
    assert.equal(gone.status, 410);
    const packs = await engine.handleHttp({ method: 'GET', path: '/api/v1/knorvia/packs' });
    assert.equal(packs.status, 200);
    const packBody = JSON.parse(Buffer.from(packs.body, 'base64').toString('utf8'));
    assert.ok(Array.isArray(packBody.packs));
    assert.ok(packBody.packs.some((p) => p.id === 'research.knowledge'));
    const events = [];
    await engine.handleWsOpen({ id: 'sock1', path: '/api/v1/ws' });
    await engine.handleWsSend(
      { id: 'sock1', data: JSON.stringify({ type: 'ping' }) },
      (msg) => events.push(msg),
    );
    assert.equal(JSON.parse(events[0].data).type, 'pong');
    events.length = 0;
    await engine.handleWsSend(
      { id: 'sock1', data: JSON.stringify({ type: 'start_turn', content: 'hello kernel' }) },
      (msg) => events.push(msg),
    );
    const admitted = events.map(e => JSON.parse(e.data)).find(e => e.type === 'session' && e.turn_id);
    assert.ok(admitted?.turn_id, JSON.stringify(events));
    await waitFor(
      () => events.map(e => JSON.parse(e.data)).some(e => e.type === 'done'),
      'terminal daemon notification',
    );
    const types = events.map((e) => JSON.parse(e.data).type);
    assert.ok(types.includes('done'));
    const done = events.map(e => JSON.parse(e.data)).find(e => e.type === 'done');
    assert.equal(done.metadata.status, 'failed');
    assert.ok(types.includes('error'));
    assert.ok(events.some((e) => JSON.stringify(e).includes('knorvia-daemon')));
  } finally {
    engine.kill();
  }
});

test('packaged engine cannot silently load developer binaries or environment overrides', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-empty-runtime-'));
  assert.throws(() => resolveDaemonBin({ runtimeRoot: empty, packaged: true, env: { KNORVIA_DAEMON_BIN: DAEMON } }), /not found/);
});
