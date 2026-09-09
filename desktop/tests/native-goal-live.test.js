'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { startKnorviaDaemon, initializeRequest } = require('../knorvia-protocol-client');
const { startScriptedResponsesFixture } = require('./fixtures/scripted-responses-fixture');
const { poll, assertCompleted } = require('../scripts/native-acceptance');

test('Goal executes through the real Kernel, gates completion on output evidence and survives reopening', {
  skip: process.env.KNORVIA_RUN_SHARED_DAEMON_TESTS !== '1', timeout: 120_000,
}, async () => {
  const daemon = process.env.KNORVIA_DAEMON_BIN;
  const cli = process.env.KNORVIA_CLI_BIN;
  const kernel = process.env.KNORVIA_KERNEL_BIN;
  for (const binary of [daemon, cli, kernel]) assert.ok(binary && fs.existsSync(binary), 'required live binary missing');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-goal-live-'));
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(home, 'bin'));
  const daemonCopy = path.join(home, 'bin', 'knorvia-daemon.exe');
  fs.copyFileSync(daemon, daemonCopy);
  const fixture = await startScriptedResponsesFixture();
  const env = { ...process.env, ...fixture.providerEnv, KNORVIA_DAEMON_BIN: daemonCopy };
  const session = startKnorviaDaemon({ daemonBin: daemonCopy, home, env, requestTimeoutMs: 15_000 });
  let id = 0;
  const rpc = async (method, params = {}) => {
    const response = await session.request({ jsonrpc: '2.0', id: ++id, method, params });
    if (response.error) { const error = new Error(JSON.stringify(response.error)); error.rpc = response.error; throw error; }
    return response.result;
  };
  const runCli = async (...args) => {
    const result = await promisify(execFile)(cli, ['--home', home, ...args], { env, windowsHide: true, timeout: 15_000 });
    return JSON.parse(result.stdout);
  };
  try {
    const initialized = await session.request(initializeRequest('knorvia_goal_test', '1'));
    assert.ok(initialized.result);
    session.notify({ jsonrpc: '2.0', method: 'initialized' });
    const ws = await rpc('workspace/create', { title: 'Goal fixture', cwd: workspace });
    const goal = await runCli('goal', 'create', '--workspace-id', ws.id, '--title', 'Deliver a verified answer',
      '--success-criteria', 'The fixture answer is durable', '--constraints', 'Only isolated fixture data', '--next-action', 'Write the verified answer');
    assert.equal(goal.revision, 1, 'creation context must be one transaction');
    assert.equal(goal.constraints, 'Only isolated fixture data');
    assert.equal(goal.nextAction, 'Write the verified answer');
    await assert.rejects(rpc('goal/update', { id: goal.id, status: 'completed' }), (error) => error.rpc.code === -32006);
    const admitted = await runCli('goal', 'run', '--id', goal.id, '--revision', '1');
    assert.ok(admitted.threadId && admitted.turn.id);
    const turn = await poll(() => rpc('turn/read', { id: admitted.turn.id }), (snapshot) => snapshot.status !== 'running');
    assertCompleted(turn);
    const linked = await rpc('thread/read', { id: admitted.threadId });
    assert.equal(linked.goalId, goal.id);
    let read = await rpc('goal/read', { id: goal.id });
    assert.equal(read.execution.completed, 1);
    assert.equal(read.execution.readyToComplete, false);
    await assert.rejects(rpc('goal/update', { id: goal.id, status: 'completed' }), (error) => error.rpc.code === -32006);
    const user = turn.items.find((item) => item.kind === 'userMessage');
    await assert.rejects(rpc('goal/evidence/add', { id: goal.id, revision: read.revision, turnId: turn.id, itemId: user.id, summary: 'a prompt is not evidence' }),
      (error) => error.rpc.code === -32602);
    const output = turn.items.find((item) => item.kind === 'agentMessage');
    const accepted = await runCli('goal', 'evidence', '--id', goal.id, '--revision', String(read.revision),
      '--turn-id', turn.id, '--item-id', output.id, '--summary', 'Checked the exact fixture response in durable storage');
    read = await rpc('goal/read', { id: goal.id });
    assert.equal(read.execution.readyToComplete, true);
    const completed = await rpc('goal/update', { id: goal.id, revision: accepted.revision, status: 'completed' });
    assert.equal(completed.status, 'completed');
    await assert.rejects(rpc('goal/run', { id: goal.id, revision: completed.revision }), (error) => error.rpc.code === -32006);
    await assert.rejects(rpc('goal/update', { id: goal.id, title: 'rewrite history' }), (error) => error.rpc.code === -32006);
    const exited = once(session.child, 'close');
    session.child.stdin.end();
    await exited;
    const reopened = await runCli('goal', 'read', '--id', goal.id);
    assert.equal(reopened.status, 'completed');
    assert.equal(reopened.completionEvidence.itemId, output.id);
    assert.equal(reopened.execution.completed, 1);
    assert.equal(fixture.requests.length, 1, 'reopening a Goal must not replay work');
  } finally {
    if (session.child.exitCode === null && session.child.signalCode === null) {
      const exited = once(session.child, 'close');
      session.child.stdin.end();
      await exited;
    }
    await fixture.close();
  }
});
