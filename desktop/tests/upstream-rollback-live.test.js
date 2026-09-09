'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { startKnorviaDaemon, initializeRequest } = require('../knorvia-protocol-client');
const { startScriptedResponsesFixture } = require('./fixtures/scripted-responses-fixture');
const { poll, assertCompleted } = require('../scripts/native-acceptance');

test('a real task resumes across pinned Kernel, upstream candidate, then pinned rollback without replay', {
  skip: process.env.KNORVIA_RUN_UPSTREAM_COMPAT_TESTS !== '1', timeout: 120_000,
}, async () => {
  const binaries = {
    daemon: process.env.KNORVIA_DAEMON_BIN,
    pinned: process.env.KNORVIA_PINNED_KERNEL_BIN,
    candidate: process.env.KNORVIA_CANDIDATE_KERNEL_BIN,
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-upstream-rollback-'));
  const bin = path.join(home, 'bin');
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(bin); fs.mkdirSync(workspace);
  const hashes = {};
  for (const [name, source] of Object.entries(binaries)) {
    assert.ok(source && fs.existsSync(source), `required ${name} binary missing`);
    hashes[name] = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const copy = path.join(bin, `${name}.exe`);
    fs.copyFileSync(source, copy);
    binaries[name] = copy;
  }
  const fixture = await startScriptedResponsesFixture();
  let session;
  let threadId;
  const turnIds = [];
  const outputIds = [];
  const phases = [];
  async function close() {
    if (!session || session.child.exitCode !== null || session.child.signalCode !== null) return;
    const exited = once(session.child, 'close');
    session.child.stdin.end();
    assert.equal((await exited)[0], 0);
    assert.equal(fs.existsSync(path.join(home, 'run', 'shared-owner.json')), false);
  }
  try {
    for (const phase of ['pinned', 'candidate', 'pinned']) {
      const beforeRequests = fixture.requests.length;
      session = startKnorviaDaemon({ daemonBin: binaries.daemon, home, requestTimeoutMs: 15_000,
        env: { ...process.env, ...fixture.providerEnv, KNORVIA_DAEMON_BIN: binaries.daemon, KNORVIA_KERNEL_BIN: binaries[phase] } });
      let id = 0;
      const rpc = async (method, params = {}) => {
        const response = await session.request({ jsonrpc: '2.0', id: ++id, method, params });
        assert.equal(response.error, undefined, JSON.stringify(response.error));
        return response.result;
      };
      assert.ok((await session.request(initializeRequest('upstream_rollback', '1'))).result);
      session.notify({ jsonrpc: '2.0', method: 'initialized' });
      if (!threadId) {
        const project = await rpc('workspace/create', { title: 'Isolated upgrade rehearsal', cwd: workspace });
        threadId = (await rpc('thread/start', { workspaceId: project.id, title: 'Persist through upgrade and rollback', cwd: workspace })).id;
      }
      const before = await rpc('thread/read', { id: threadId });
      assert.deepEqual(before.items.filter(item => item.kind === 'agentMessage').map(item => item.id), outputIds);
      assert.equal(fixture.requests.length, beforeRequests, 'reopening must not send a provider request');
      const admitted = await rpc('turn/start', { threadId, input: `Reply during ${phase} phase ${turnIds.length + 1}`, tools: { write: false } });
      const turn = await poll(() => rpc('turn/read', { id: admitted.turn.id }), value => value.status !== 'running');
      assertCompleted(turn);
      turnIds.push(turn.id);
      outputIds.push(turn.items.find(item => item.kind === 'agentMessage').id);
      const after = await rpc('thread/read', { id: threadId });
      assert.equal(after.items.filter(item => item.kind === 'userMessage').length, turnIds.length);
      assert.deepEqual(after.items.filter(item => item.kind === 'agentMessage').map(item => item.id), outputIds);
      assert.equal(fixture.requests.length, beforeRequests + 1, 'each admitted turn must have exactly one fixture request');
      phases.push({ phase, turnId: turn.id, outputId: outputIds.at(-1), providerRequests: fixture.requests.length });
      await close();
    }
    fs.writeFileSync(path.join(home, 'rehearsal.json'), JSON.stringify({ result: 'PASS', home, hashes, phases,
      scope: 'real Kernel + local scripted provider, isolated Home; no production baseline switch' }, null, 2));
    process.stdout.write(`upstream rollback evidence: ${path.join(home, 'rehearsal.json')}\n`);
  } finally {
    try { await close(); } finally { await fixture.close(); }
  }
});
