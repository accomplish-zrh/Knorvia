'use strict';

// Real daemon admission + durable room/session state + the production host
// dispatch bridge. Only a deliberately injected Node child-process fixture is
// executable; no installed Codex/Claude/Grok CLI or real model is consulted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { createKernelEngine } = require('../kernel-engine');
const { createCliDispatchBridge } = require('../cli-dispatch');
const { CliBackendHost, parseCodexJsonLines } = require('../cli-backends');
const { startScriptedResponsesFixture } = require('./fixtures/scripted-responses-fixture');

async function until(read, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read(); if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await delay(80);
  }
}

async function bounded(work, label, timeoutMs = 15000) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

test('CLI Bot uses independent room sessions, resumes exactly, cancels without late output and acknowledges once', { timeout: 120000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-cli-bot-live-'));
  const workspace = path.join(home, 'workspace'); fs.mkdirSync(workspace);
  const script = path.join(workspace, 'fixture-cli.cjs');
  const sideEffects = path.join(workspace, 'invocations.jsonl');
  fs.writeFileSync(script, `
const fs = require('node:fs'), crypto = require('node:crypto');
const args = JSON.parse(process.argv[2]);
const sessionId = args.resume ? args.sessionId : 'fixture-session-' + crypto.randomUUID();
const record = { phase: 'started', sessionId, resume: args.resume, prompt: args.prompt, pid: process.pid };
fs.appendFileSync(${JSON.stringify(sideEffects)}, JSON.stringify(record) + '\\n');
function finish() {
  fs.appendFileSync(${JSON.stringify(sideEffects)}, JSON.stringify({ ...record, phase: 'finished' }) + '\\n');
  console.log(JSON.stringify({ type: 'session_started', session_id: sessionId }));
  console.log(JSON.stringify({ type: 'agent_message', message: 'fixture-reply:' + sessionId }));
}
if (args.prompt.includes('[cancel-fixture]')) setTimeout(finish, 15000); else finish();
`);
  const backendId = 'cli:fixture';
  const host = new CliBackendHost({
    pathOverride: command => { assert.equal(command, 'knorvia-isolated-fixture'); return process.execPath; },
    backends: [{ id: backendId, label: 'Fixture', command: 'knorvia-isolated-fixture', versionArgs: [], authProbe: null,
      run: args => [script, JSON.stringify(args)], parse: parseCodexJsonLines,
      capabilities: { resume: true, streaming: false, tools: false, cancellation: true }, probeVerified: 'fixture', docs: 'fixture://local-only' }],
  });
  let engine, bridge, provider; const claimed = [], acknowledgements = [], bridgeErrors = [];
  let droppedResponse = false;
  const evidence = { fixtureOnly: true, sameRoomResume: false, crossRoomIsolation: false, cancelNoLateWrite: false, noRepeatedSideEffect: false };
  try {
    provider = await startScriptedResponsesFixture({});
    const kernelRoot = path.resolve(__dirname, '../../../knorvia-kernel');
    engine = await createKernelEngine({ home, version: 'cli-bot-live', env: { ...process.env, ...provider.providerEnv,
      KNORVIA_DAEMON_BIN: process.env.KNORVIA_DAEMON_BIN || path.join(kernelRoot, 'knorvia-rs/target/release/knorvia-daemon.exe'),
      KNORVIA_KERNEL_BIN: process.env.KNORVIA_KERNEL_BIN || path.join(kernelRoot, 'codex-rs/target/debug/codex-app-server.exe'),
    } });
    const rpc = (method, params = {}) => bounded(engine.rpc(method, params), method, method === 'room/interrupt' ? 5000 : 15000);
    bridge = createCliDispatchBridge({ hostId: 'cli-bot-live-fixture-host', intervalMs: 30, backendIds: () => host.availableBackendIds(),
      handlers: { 'cliBackend/runTurn': params => host.runTurn(params), 'cliBackend/cancel': params => host.cancel(params) },
      onError: error => bridgeErrors.push(String(error.message)),
      rpc: async (method, params) => {
        const result = await rpc(method, params);
        if (method === 'cliDispatch/claim') claimed.push(...result.jobs);
        if (method === 'cliDispatch/complete') {
          acknowledgements.push({ ...params, status: result.status });
          if (!droppedResponse && result.status === 'completed') { droppedResponse = true; throw new Error('fixture lost completion reply after durable commit'); }
        }
        return result;
      },
    });
    await bridge.start();
    const ws = await rpc('workspace/create', { title: 'CLI Bot fixture', cwd: workspace });
    const bot = await rpc('bot/create', { name: 'Fixture', soul: 'Only echo the isolated local fixture result.', backendKind: 'cli', backendBindingId: backendId });
    const roomA = await rpc('room/create', { kind: 'group', title: 'Fixture room A', botIds: [bot.id] });
    const roomB = await rpc('room/create', { kind: 'group', title: 'Fixture room B', botIds: [bot.id] });
    const messages = id => rpc('room/messages', { conversationId: id, limit: 200 });
    const starts = () => fs.existsSync(sideEffects) ? fs.readFileSync(sideEffects, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(item => item.phase === 'started') : [];
    const send = (id, text) => rpc('room/send', { conversationId: id, workspaceId: ws.id, content: `@Fixture ${text}`, timeoutSecs: 60 });
    const completed = async (id, count) => {
      const result = await messages(id);
      const items = result.messages.filter(m => m.meta?.cliDispatch?.status === 'completed');
      return items.length >= count ? items : null;
    };
    await send(roomA.id, 'first room A');
    const firstA = (await until(() => completed(roomA.id, 1), 'room A first completed'))[0];
    await until(() => acknowledgements.filter(a => a.requestId === firstA.meta.cliDispatch.requestId).length >= 2, 'lost acknowledgement retry');
    assert.equal(starts().length, 1, 'retrying a durable completion acknowledgement never reruns the child process');
    evidence.noRepeatedSideEffect = true;
    // The worker removes its active dispatch immediately after consuming the
    // durable completion. Retry only admission conflicts, not accepted turns.
    async function admitted(id, text) {
      return until(async () => { try { return await send(id, text); } catch (error) { if (/active dispatch/.test(error.message)) return null; throw error; } }, 'room send admitted');
    }
    await admitted(roomB.id, 'first room B');
    const firstB = (await until(() => completed(roomB.id, 1), 'room B first completed'))[0];
    assert.notEqual(firstA.meta.cliDispatch.resultSessionId, firstB.meta.cliDispatch.resultSessionId);
    assert.equal(starts()[0].resume, false); assert.equal(starts()[1].resume, false);
    evidence.crossRoomIsolation = true;
    await admitted(roomA.id, 'second room A');
    const allA = await until(() => completed(roomA.id, 2), 'room A resumed completion');
    const secondA = allA.find(m => m.id !== firstA.id);
    assert.equal(secondA.meta.cliDispatch.resultSessionId, firstA.meta.cliDispatch.resultSessionId);
    assert.equal(starts()[2].resume, true); assert.equal(starts()[2].sessionId, starts()[0].sessionId);
    assert.equal(starts().length, 3);
    const visibleA = (await messages(roomA.id)).messages.filter(m => m.sender === 'bot' && !m.meta?.hidden);
    const visibleB = (await messages(roomB.id)).messages.filter(m => m.sender === 'bot' && !m.meta?.hidden);
    assert.equal(visibleA.length, 2, 'lost response acknowledgement must not duplicate visible replies');
    assert.equal(visibleB.length, 1);
    const bindings = await rpc('sessionBinding/list', { botId: bot.id });
    const anchorA = bindings.find(b => b.conversationId === roomA.id);
    const anchorB = bindings.find(b => b.conversationId === roomB.id);
    assert.ok(anchorA && anchorB); assert.notEqual(anchorA.id, anchorB.id);
    assert.notEqual(anchorA.knorviaThreadId, anchorB.knorviaThreadId);
    evidence.sameRoomResume = true;
    await admitted(roomB.id, '[cancel-fixture] do not publish this delayed output');
    await until(() => host.activeRuns().length === 1 && starts().length === 4, 'delayed CLI process started');
    const cancelJob = claimed.find(j => j.prompt.includes('[cancel-fixture]')); assert.ok(cancelJob);
    assert.equal((await rpc('room/interrupt', { conversationId: roomB.id })).interrupted, true);
    await until(async () => (await messages(roomB.id)).messages.find(m => m.meta?.cliDispatch?.requestId === cancelJob.requestId && m.meta.cliDispatch.status === 'canceled'), 'durable cancel');
    await until(() => host.activeRuns().length === 0 && bridge.activeCount === 0, 'owned child canceled');
    const before = (await messages(roomB.id)).messages;
    const late = await rpc('cliDispatch/complete', { hostId: 'cli-bot-live-fixture-host', requestId: cancelJob.requestId, conversationId: roomB.id, runId: cancelJob.runId, text: 'late output must never replace canceled state', sessionId: 'wrong-late-session' });
    assert.equal(late.status, 'canceled');
    assert.deepEqual((await messages(roomB.id)).messages, before);
    assert.equal(starts().length, 4);
    const finished = fs.readFileSync(sideEffects, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(item => item.phase === 'finished');
    assert.equal(finished.length, 3, 'canceled child did not publish its delayed side effect');
    assert.equal(provider.requests.length, 0, 'CLI bots did not fall back to the configured Kernel model');
    evidence.cancelNoLateWrite = true;
    evidence.childRuns = starts().length; evidence.completedRuns = finished.length; evidence.modelRequests = provider.requests.length;
    assert.deepEqual(bridgeErrors, ['fixture lost completion reply after durable commit']);
    evidence.passed = true;
  } catch (error) {
    evidence.failure = error.stack || String(error);
    throw error;
  } finally {
    if (!evidence.passed) {
      for (const runId of host.activeRuns()) host.cancel({ runId });
      if (engine?.child?.pid && engine.child.exitCode === null) {
        if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(engine.child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
        else engine.kill();
      }
    }
    await bounded(bridge?.close(), 'bridge cleanup', 5000).catch(() => {});
    await engine?.shutdown(); await provider?.close();
    const folder = path.resolve(__dirname, '../../work/non-login-followup-20260909/evidence'); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'cli-bot-live.json'), JSON.stringify(evidence, null, 2));
    if (evidence.passed) fs.rmSync(home, { recursive: true, force: true });
  }
});
