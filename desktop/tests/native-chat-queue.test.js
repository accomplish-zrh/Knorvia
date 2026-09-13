'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { startKnorviaDaemon, initializeRequest } = require('../knorvia-protocol-client');
const { startScriptedResponsesFixture } = require('./fixtures/scripted-responses-fixture');

test('durable chat FIFO runs through the actual shared owner and Kernel, survives detach, and pauses on Stop', { timeout: 120000 }, async () => {
  const daemonBin = process.env.KNORVIA_DAEMON_BIN;
  const kernelBin = process.env.KNORVIA_KERNEL_BIN;
  assert.ok(daemonBin && fs.existsSync(daemonBin), 'an explicitly built daemon is required');
  assert.ok(kernelBin && fs.existsSync(kernelBin), 'the pinned Kernel is required');
  const evidence = path.resolve(process.env.KNORVIA_TEST_EVIDENCE || process.env.TEMP, 'chat-queue');
  fs.mkdirSync(evidence, { recursive: true });
  const home = fs.mkdtempSync(path.join(evidence, 'isolated-home-'));
  const fixture = await startScriptedResponsesFixture({ slowDelayMs: 60000 });
  let client, sequence = 0, threadId, diagnostics = '';
  const states = [];
  async function start() {
    client = startKnorviaDaemon({ daemonBin, home, env: { ...process.env, ...fixture.providerEnv, KNORVIA_KERNEL_BIN: kernelBin }, requestTimeoutMs: 25000 });
    client.child.stderr.on('data', value => { diagnostics = (diagnostics + value).slice(-20000); });
    const init = await client.request(initializeRequest('knorvia_queue_acceptance', '1'));
    assert.ok(init.result, JSON.stringify(init.error));
    client.notify({ jsonrpc: '2.0', method: 'initialized' });
  }
  async function rpc(method, params = {}) {
    const reply = await client.request({ jsonrpc: '2.0', id: `queue-test-${++sequence}`, method, params });
    if (reply.error) throw Object.assign(new Error(reply.error.message), { rpc: reply.error });
    return reply.result;
  }
  async function waitFor(read, predicate, label, timeout = 25000) {
    const end = Date.now() + timeout;
    let value;
    while (Date.now() < end) { value = await read(); if (predicate(value)) return value; await delay(100); }
    throw new Error(`${label}: ${JSON.stringify(value)}`);
  }
  const queue = () => rpc('turnQueue/read', { threadId });
  const snapshot = () => rpc('thread/read', { id: threadId });
  const enqueue = (id, input) => rpc('turnQueue/enqueue', { threadId, requestId: id, idempotencyKey: `${id}-enqueue`, input, options: { cwd: home, write: false } });
  async function detach() {
    const child = client.child;
    if (child.exitCode !== null) return;
    const closed = once(child, 'close');
    child.stdin.end();
    await Promise.race([closed, delay(12000, undefined, { ref: false }).then(() => { throw new Error('stdio client did not detach'); })]);
  }
  try {
    await start();
    const workspace = await rpc('workspace/create', { cwd: home, title: 'Queue acceptance' });
    const thread = await rpc('thread/start', { workspaceId: workspace.id, cwd: home });
    threadId = thread.id;
    await rpc('turn/start', { threadId, input: '[slow] first active task', cwd: home });
    await waitFor(snapshot, s => s.activeTurn?.status === 'running', 'initial turn running');
    await waitFor(async () => fixture.requests, r => r.some(x => x.kind === 'slow'), 'provider actually holding first response');
    await enqueue('queue-first', 'FIRST QUEUED MESSAGE');
    const withSecond = await enqueue('queue-cancel', 'THIS MUST NEVER BE DELIVERED');
    await enqueue('queue-third', 'THIRD QUEUED MESSAGE');
    await assert.rejects(rpc('turnQueue/cancel', { threadId, revision: withSecond.revision, messageId: 'queue-cancel' }));
    let q = await queue();
    await rpc('turnQueue/cancel', { threadId, revision: q.revision, messageId: 'queue-cancel' });
    await enqueue('queue-first', 'FIRST QUEUED MESSAGE');
    q = await queue();
    assert.deepEqual(q.items.map(i => i.status), ['queued', 'cancelled', 'queued']);
    await assert.rejects(enqueue('queue-first', 'CHANGED INPUT'));
    states.push({ stage: 'queued-dedup-cancel', queue: q });
    // The stdio proxy closes while the real shared owner retains its active
    // turn. The FIFO must finish without any renderer or connected client.
    await detach();
    fixture.releaseSlowTurns();
    await delay(2500);
    await start();
    q = await waitFor(queue, q => q.items.filter(i => i.status === 'delivered').length === 2, 'FIFO delivered');
    assert.deepEqual(q.items.filter(i => i.status === 'delivered').map(i => i.id), ['queue-first', 'queue-third']);
    await waitFor(snapshot, s => !s.activeTurn, 'last queued turn completed');
    const s = await snapshot();
    const text = i => String(i.payload?.text || i.payload?.input || '');
    const users = s.items.filter(i => i.kind === 'userMessage').map(text);
    assert.equal(users.filter(t => t === 'FIRST QUEUED MESSAGE').length, 1);
    assert.equal(users.filter(t => t === 'THIRD QUEUED MESSAGE').length, 1);
    assert.equal(users.some(t => t.includes('THIS MUST NEVER')), false);
    assert.ok(users.indexOf('FIRST QUEUED MESSAGE') < users.indexOf('THIRD QUEUED MESSAGE'));
    states.push({ stage: 'detached-fifo-complete', queue: q, snapshot: s });

    const running = await rpc('turn/start', { threadId, input: '[slow] stop this task', cwd: home });
    const turnId = running.turn?.id || running.id;
    await waitFor(async () => fixture.requests, r => r.filter(x => x.kind === 'slow').length === 2, 'provider actually holding stop response');
    await enqueue('queue-after-stop', 'WAIT FOR MY EXPLICIT CONTINUE');
    await rpc('turn/interrupt', { turnId });
    await waitFor(snapshot, s => !s.activeTurn, 'interrupted task terminal');
    q = await queue();
    assert.equal(q.paused, true);
    assert.equal(q.items.find(i => i.id === 'queue-after-stop').status, 'queued');
    fixture.releaseSlowTurns();
    await rpc('system/prepareRestart');
    await detach();
    await start();
    q = await queue();
    assert.equal(q.paused, true, 'pause survives a real owner restart');
    states.push({ stage: 'stopped-and-restarted', queue: q });
    await rpc('turnQueue/resume', { threadId, revision: q.revision });
    q = await waitFor(queue, q => q.items.find(i => i.id === 'queue-after-stop')?.status === 'delivered', 'explicit resume');
    await waitFor(snapshot, s => !s.activeTurn, 'resumed turn finished');
    states.push({ stage: 'resumed-once', queue: q, snapshot: await snapshot() });
    const goal = await rpc('goal/create', { workspaceId: workspace.id, title: 'Queued Goal', successCriteria: 'Provide the requested fixture answer', nextAction: 'Answer the next instruction' });
    const goalRun = await rpc('goal/run', { id: goal.id, revision: goal.revision, input: '[slow] active Goal run', cwd: home, requestKey: 'initial-goal-run' });
    threadId = goalRun.threadId;
    assert.ok(threadId);
    await waitFor(async () => fixture.requests, r => r.filter(x => x.kind === 'slow').length === 3, 'actual Goal response');
    await enqueue('queue-goal-followup', 'FOLLOW UP AFTER THE GOAL RUN');
    q = await queue();
    assert.equal(q.afterExecutionId, goalRun.execution.id);
    assert.equal(q.items[0].status, 'queued');
    fixture.releaseSlowTurns();
    q = await waitFor(queue, q => q.items[0]?.status === 'delivered', 'Goal FIFO followup');
    assert.equal(q.items[0].dispatchMethod, 'goal/run');
    assert.ok(q.items[0].executionId);
    await waitFor(snapshot, s => !s.activeTurn, 'Goal queued turn finished');
    states.push({ stage: 'goal-fifo-complete', queue: q, snapshot: await snapshot() });
    await rpc('system/prepareRestart');
  } finally {
    fixture.releaseSlowTurns();
    if (client?.child.exitCode === null) {
      try { if (threadId) { const s = await snapshot(); if (s.activeTurn) await rpc('turn/interrupt', { turnId: s.activeTurn.id }); } await rpc('system/prepareRestart'); } catch {}
      try { await detach(); } catch { client.child.kill(); }
    }
    await fixture.close();
    fs.writeFileSync(path.join(evidence, `result-${path.basename(home)}.json`), JSON.stringify({ home, daemonBin, kernelBin, states, diagnostics }, null, 2));
  }
});
