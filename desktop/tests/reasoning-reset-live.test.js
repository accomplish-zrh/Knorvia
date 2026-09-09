'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createKernelEngine } = require('../kernel-engine');
const { startScriptedResponsesFixture } = require('./fixtures/scripted-responses-fixture');
const { poll } = require('../scripts/native-acceptance');

test('default reasoning clears the persisted thread and the actual resumed Kernel request', { timeout: 120000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-reasoning-reset-'));
  const fixture = await startScriptedResponsesFixture();
  const root = path.resolve(__dirname, '../../../knorvia-kernel');
  const env = { ...process.env, ...fixture.providerEnv,
    KNORVIA_DAEMON_BIN: process.env.KNORVIA_DAEMON_BIN || path.join(root, 'knorvia-rs/target/release/knorvia-daemon.exe'),
    KNORVIA_KERNEL_BIN: process.env.KNORVIA_KERNEL_BIN || path.join(root, 'codex-rs/target/debug/codex-app-server.exe') };
  let engine;
  try {
    engine = await createKernelEngine({ home, env, version: 'reasoning-reset-test' });
    const workspace = await engine.rpc('workspace/create', { title: 'Reasoning fixture' });
    const thread = await engine.rpc('thread/start', { workspaceId: workspace.id, model: 'gpt-5.2', reasoningEffort: 'high' });
    const send = async params => {
      const admitted = await engine.rpc('turn/start', { threadId: thread.id, input: 'Local fixture only.', ...params });
      const done = await poll(() => engine.rpc('turn/read', { id: admitted.turn.id }), t => t.status !== 'running');
      assert.equal(done.status, 'completed', JSON.stringify(done));
    };
    await send({});
    assert.equal(fixture.requests.at(-1).reasoning?.effort, 'high');
    await send({ reasoningEffort: null });
    assert.notEqual(fixture.requests.at(-1).reasoning?.effort, 'high');
    assert.equal((await engine.rpc('thread/read', { id: thread.id })).reasoningEffort, null);
    await engine.shutdown();
    engine = await createKernelEngine({ home, env, version: 'reasoning-reset-test' });
    assert.equal((await engine.rpc('thread/read', { id: thread.id })).reasoningEffort, null);
    await send({});
    assert.notEqual(fixture.requests.at(-1).reasoning?.effort, 'high');
    assert.equal(fixture.requests.length, 3);
  } finally { await engine?.shutdown(); await fixture.close(); }
});
