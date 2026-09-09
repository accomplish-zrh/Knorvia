'use strict';

// Real Kernel acceptance. Evidence survives failures; a successful RPC is never
// treated as a successful task. No user Home or external provider is accepted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { startKnorviaDaemon, initializeRequest } = require('../knorvia-protocol-client');
const { startScriptedResponsesFixture } = require('../tests/fixtures/scripted-responses-fixture');

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const ANSWER = 'scripted native fixture response';

function assertCompleted(snapshot, expected = ANSWER) {
  assert.equal(snapshot.status, 'completed', `Turn ${snapshot.id}: ${JSON.stringify(snapshot)}`);
  assert.ok(snapshot.items?.some((item) => item.kind === 'agentMessage'
    && item.status === 'completed' && item.payload?.text?.includes(expected)),
  `Turn ${snapshot.id} lacks the expected durable assistant output`);
  assert.equal(snapshot.items.filter((item) => item.kind === 'userMessage').length, 1,
    'the real Kernel must not duplicate the product user Item');
}

async function poll(read, accept, timeout = 100_000) {
  const deadline = Date.now() + timeout;
  let latest;
  do {
    latest = await read();
    if (accept(latest)) return latest;
    await delay(80);
  } while (Date.now() < deadline);
  throw new Error(`acceptance timed out: ${JSON.stringify(latest)}`);
}

async function stopChild(child, force = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'close');
  if (force && process.platform === 'win32') {
    // Only this runner's direct child and descendants; no name-based killing.
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' });
    const [code] = await once(killer, 'close');
    assert.equal(code, 0, 'owned process-tree termination must succeed');
  } else if (force) {
    child.kill('SIGKILL');
  } else {
    child.stdin.end();
  }
  await Promise.race([exited, delay(15_000, null, { ref: false }).then(() => {
    throw new Error(`owned daemon ${child.pid} did not stop`);
  })]);
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function runAcceptance(options) {
  const { daemon, kernel, evidence, mode = 'steady', cycles = 3, seconds = 0,
    negative = false, approval = false, intervalMs = 50 } = options;
  assert.ok(['steady', 'graceful', 'crash'].includes(mode), 'invalid experiment mode');
  assert.ok(Number.isSafeInteger(cycles) && cycles > 0, 'cycles must be positive');
  assert.ok(Number.isSafeInteger(seconds) && seconds >= 0, 'seconds must be nonnegative');
  assert.ok(Number.isSafeInteger(intervalMs) && intervalMs >= 0 && intervalMs <= 60000, 'intervalMs must be between 0 and 60000');
  assert.ok(evidence && !fs.existsSync(evidence), 'evidence must name a NEW directory');
  assert.ok(fs.statSync(daemon).isFile() && fs.statSync(kernel).isFile(), 'both binaries are required');
  const root = path.resolve(evidence);
  const home = path.join(root, 'isolated-home');
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.mkdirSync(workspace);
  const daemonCopy = path.join(home, 'bin', path.basename(daemon));
  const kernelCopy = path.join(home, 'bin', path.basename(kernel));
  fs.copyFileSync(daemon, daemonCopy);
  fs.copyFileSync(kernel, kernelCopy);
  const summary = {
    schemaVersion: 1, startedAt: new Date().toISOString(), mode, requestedSeconds: seconds,
    requestedCycles: cycles, intervalMs, negative, approval, home, workspace,
    binaries: { daemon: { path: daemon, sha256: digest(daemonCopy) },
      kernel: { path: kernel, sha256: digest(kernelCopy) } },
    verifierSha256: digest(__filename), fixtureSha256: digest(require.resolve('../tests/fixtures/scripted-responses-fixture')),
    platform: process.platform, ownerProcesses: [],
    successfulTurns: 0, crashInterruptedTurns: 0, gracefulRestarts: 0, forcedProcessTreeKills: 0,
    providerRequests: 0, assertions: 0, cycles: 0, errors: [], processes: [], passed: false,
  };
  const event = (kind, detail) => fs.appendFileSync(path.join(root, 'events.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), kind, ...detail })}\n`);
  const save = () => fs.writeFileSync(path.join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  let fixture;
  let client;
  let sequence = 0;
  let lastTurn;
  const start = Date.now();
  const rpc = async (method, params = {}) => {
    const response = await client.request({ jsonrpc: '2.0', id: `accept-${++sequence}`, method, params });
    if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    return response.result;
  };
  const connect = async () => {
    // Inherited provider config is deliberately replaced, including failure injection.
    const env = { ...process.env, ...fixture.providerEnv, KNORVIA_KERNEL_BIN: kernelCopy, KNORVIA_DAEMON_BIN: daemonCopy };
    if (negative) env.KNORVIA_PROVIDER_MODEL = '';
    client = startKnorviaDaemon({ daemonBin: daemonCopy, home, env, requestTimeoutMs: 20_000 });
    summary.processes.push({ pid: client.child.pid, startedAt: new Date().toISOString() });
    const initializedAt = Date.now();
    const result = await client.request(initializeRequest('knorvia_acceptance', '1.0'), { timeoutMs: 660_000 });
    assert.ok(!result.error, JSON.stringify(result));
    client.notify({ jsonrpc: '2.0', method: 'initialized' });
    assert.equal((await rpc('system/health')).ok, true);
    const discovery = path.join(home, 'run', 'shared-owner.json');
    const ownerPid = fs.existsSync(discovery) ? JSON.parse(fs.readFileSync(discovery, 'utf8')).pid : client.child.pid;
    summary.ownerProcesses.push({ pid: ownerPid, startedAt: new Date().toISOString() });
    event('daemon-started', { proxyPid: client.child.pid, ownerPid, initializeMs: Date.now() - initializedAt });
  };
  const terminal = (id) => poll(() => rpc('turn/read', { id }), (turn) => TERMINAL.has(turn.status));
  const verify = async (id, expected) => {
    const snapshot = await terminal(id);
    assertCompleted(snapshot, expected);
    summary.assertions += 3;
    event('verified-terminal', { id, status: snapshot.status, itemIds: snapshot.items.map((item) => item.id) });
    return snapshot;
  };
  try {
    save();
    fixture = await startScriptedResponsesFixture({ slowDelayMs: 120_000 });
    await connect();
    const ws = await rpc('workspace/create', { title: 'Isolated native acceptance', cwd: workspace });
    const newTurn = async (input, write = false) => {
      const thread = await rpc('thread/start', { workspaceId: ws.id, title: input, cwd: workspace });
      const admitted = await rpc('turn/start', { threadId: thread.id, input, tools: { write }, cwd: workspace });
      return { threadId: thread.id, id: admitted.turn?.id || admitted.id };
    };
    if (approval) {
      const marker = path.join(workspace, 'knorvia-fixture-approved.txt');
      const turn = await newTurn('[approval] verify a real isolated output file', true);
      const pending = await poll(() => rpc('thread/read', { id: turn.threadId }),
        (snapshot) => snapshot.pendingApprovals?.some((entry) => entry.turnId === turn.id));
      assert.equal(fs.existsSync(marker), false, 'side effect must wait for consent');
      const entry = pending.pendingApprovals.find((candidate) => candidate.turnId === turn.id);
      await rpc('approval/respond', { id: entry.id, decision: 'allow' });
      await verify(turn.id, 'approval fixture completed');
      assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'approved by Knorvia fixture');
      summary.assertions += 2;
      summary.successfulTurns++;
      event('verified-artifact', { path: marker, sha256: digest(marker), turnId: turn.id });
    }
    const workloadStart = Date.now();
    do {
      const turn = await newTurn(`acceptance cycle ${summary.cycles + 1}`);
      await verify(turn.id);
      summary.successfulTurns++;
      lastTurn = turn.id;
      if (mode === 'graceful') {
        await stopChild(client.child);
        summary.gracefulRestarts++;
        event('graceful-restart', { completedTurnId: turn.id });
        await connect();
        await verify(turn.id);
      } else if (mode === 'crash') {
        const before = fixture.requests.length;
        const interrupted = await newTurn('[slow] interrupt only this isolated unfinished turn');
        await poll(async () => fixture.requests.slice(before), (requests) => requests.some((r) => r.kind === 'slow'));
        assert.equal((await rpc('turn/read', { id: interrupted.id })).status, 'running');
        await stopChild(client.child, true);
        summary.forcedProcessTreeKills++;
        event('forced-process-tree-kill', { interruptedTurnId: interrupted.id });
        const requestsBeforeRestart = fixture.requests.length;
        await connect();
        const recovered = await terminal(interrupted.id);
        assert.equal(recovered.status, 'interrupted', JSON.stringify(recovered));
        await delay(500);
        assert.equal(fixture.requests.length, requestsBeforeRestart, 'recovery silently replayed model work');
        summary.crashInterruptedTurns++;
        summary.assertions += 3;
        await verify(turn.id);
      }
      summary.cycles++;
      summary.providerRequests += fixture.requests.length;
      fixture.requests.length = 0; // keep the verifier bounded during long runs
      summary.workloadSeconds = (Date.now() - workloadStart) / 1000;
      save();
      if (summary.cycles % 10 === 0) process.stdout.write(`verified ${summary.cycles} cycles (${mode})\n`);
      await delay(intervalMs);
    } while (seconds ? Date.now() - workloadStart < seconds * 1000 : summary.cycles < cycles);
    // Reopen and re-read the last successful task even for uninterrupted soaks.
    // This final audit restart is separate from the timed experiment counters.
    await stopChild(client.child);
    await connect();
    await verify(lastTurn);
    summary.finalRecoveryAudit = true;
    summary.passed = true;
  } catch (error) {
    summary.errors.push({ name: error.name, message: error.message, stack: error.stack });
    event('failure', { message: error.message });
  } finally {
    if (client) {
      try { await stopChild(client.child); } catch (error) {
        summary.errors.push({ message: `cleanup: ${error.message}` });
        summary.passed = false;
        try { await stopChild(client.child, true); } catch (forced) {
          summary.errors.push({ message: `forced cleanup: ${forced.message}` });
        }
      }
    }
    summary.providerRequests += fixture?.requests.length ?? 0;
    await fixture?.close();
    summary.finishedAt = new Date().toISOString();
    summary.elapsedSeconds = (Date.now() - start) / 1000;
    save();
  }
  return summary;
}

if (require.main === module) {
  const { values } = parseArgs({ options: {
    daemon: { type: 'string' }, kernel: { type: 'string' }, evidence: { type: 'string' },
    mode: { type: 'string', default: 'steady' }, cycles: { type: 'string', default: '3' },
    seconds: { type: 'string', default: '0' }, negative: { type: 'boolean', default: false },
    approval: { type: 'boolean', default: false },
    'interval-ms': { type: 'string', default: '50' },
  } });
  runAcceptance({ ...values, cycles: Number(values.cycles), seconds: Number(values.seconds), intervalMs: Number(values['interval-ms']) })
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      process.exitCode = summary.passed ? 0 : 1;
    }).catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}

module.exports = { assertCompleted, poll, runAcceptance };
