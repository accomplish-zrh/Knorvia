'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { createFrontendSupervisor } = require('../frontend-supervisor');

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  return child;
}

function immediateStartChild(pid) {
  return { child: fakeChild(pid), ready: Promise.resolve() };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('unexpected exit after READY triggers one bounded restart and hands the new child back', async () => {
  const restarts = [];
  let ready = null;
  let pid = 1;
  const supervisor = createFrontendSupervisor({
    startChild: () => immediateStartChild(++pid),
    restartDelayMs: 0,
    onRestart: (info) => restarts.push(info),
    onReady: (child) => { ready = child; },
  });
  const first = fakeChild(1);
  supervisor.monitor(first);
  assert.equal(supervisor.monitoredPid, 1);
  first.emit('exit', 1);
  await settle();
  await settle();
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].lastExitCode, 1);
  assert.equal(supervisor.monitoredPid, 2);
  assert.equal(ready.pid, 2);
  assert.equal(supervisor.exhausted, false);
  supervisor.stop();
});

test('crash budget is exhausted without infinite respawns and exhaustion is reported once', async () => {
  let spawns = 0;
  const exhausted = [];
  const supervisor = createFrontendSupervisor({
    startChild: () => {
      spawns += 1;
      const child = fakeChild(spawns);
      // Die after the supervisor attaches its exit listener (macrotask).
      setTimeout(() => child.emit('exit', 1), 0);
      return { child, ready: Promise.resolve() };
    },
    maxRestarts: 2,
    restartDelayMs: 0,
    onExhausted: (info) => exhausted.push(info),
  });
  supervisor.resume();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(exhausted.length, 1, 'exhaustion must be reported exactly once');
  const spawnsAtExhaustion = spawns;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawns, spawnsAtExhaustion, 'no further restarts after exhaustion');
  assert.ok(spawnsAtExhaustion <= 4, `bounded spawns, saw ${spawnsAtExhaustion}`);
  supervisor.stop();
});

test('resume after exhaustion opens a fresh budget and can recover', async () => {
  let spawns = 0;
  let failNext = true;
  const exhausted = [];
  const supervisor = createFrontendSupervisor({
    startChild: () => {
      spawns += 1;
      const child = fakeChild(spawns);
      if (failNext) setTimeout(() => child.emit('exit', 1), 0);
      return { child, ready: Promise.resolve() };
    },
    maxRestarts: 1,
    restartDelayMs: 0,
    onExhausted: (info) => exhausted.push(info),
  });
  supervisor.resume();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(supervisor.exhausted, true);
  failNext = false;
  supervisor.resume();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(supervisor.exhausted, false, 'manual retry opens one fresh bounded window');
  assert.ok(supervisor.monitoredPid, 'a healthy replacement child is monitored');
  supervisor.stop();
});

test('planned shutdown and supervisor.stop() never restart the child', async () => {
  let shuttingDown = false;
  let spawns = 0;
  const supervisor = createFrontendSupervisor({
    startChild: () => { spawns += 1; return immediateStartChild(spawns); },
    isShuttingDown: () => shuttingDown,
    restartDelayMs: 0,
  });
  const child = fakeChild(1);
  supervisor.monitor(child);
  shuttingDown = true;
  child.emit('exit', 0);
  await settle();
  assert.equal(spawns, 0);

  const supervisor2 = createFrontendSupervisor({
    startChild: () => { spawns += 1; return immediateStartChild(spawns); },
    restartDelayMs: 0,
  });
  const child2 = fakeChild(9);
  supervisor2.monitor(child2);
  supervisor2.stop();
  child2.emit('exit', 0);
  await settle();
  assert.equal(spawns, 0, 'neither path may respawn during shutdown');
});

test('old crashes age out of the budget window so a later crash can restart again', async () => {
  let clock = 1000;
  let pid = 0;
  const spawned = [];
  const supervisor = createFrontendSupervisor({
    startChild: () => {
      const child = fakeChild(++pid);
      spawned.push(child);
      return { child, ready: Promise.resolve() };
    },
    maxRestarts: 1,
    windowMs: 100,
    restartDelayMs: 0,
    now: () => clock,
  });
  const first = fakeChild(++pid);
  supervisor.monitor(first);
  first.emit('exit', 1);
  await settle();
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(supervisor.monitoredPid, 2);
  clock += 501; // the recorded crash is now outside the window
  spawned[0].emit('exit', 1);
  await settle();
  await settle();
  assert.equal(spawned.length, 2, 'aged-out crash must not consume the fresh budget');
  assert.equal(supervisor.exhausted, false);
  supervisor.stop();
});

test('real child process: killed renderer host is restarted', { timeout: 20000 }, async () => {
  const node = process.execPath;
  let spawns = 0;
  const exits = [];
  const makeChild = () => {
    spawns += 1;
    const child = spawn(node, ['-e', "process.stdout.write('READY\\n'); setInterval(() => {}, 1e6);"], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let markReady;
    const ready = new Promise((resolve) => { markReady = resolve; });
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('READY')) markReady(); });
    child.on('exit', (code) => exits.push({ pid: child.pid, code }));
    return { child, ready };
  };
  const supervisor = createFrontendSupervisor({
    startChild: () => Promise.resolve(makeChild()),
    maxRestarts: 1,
    windowMs: 60 * 1000,
    restartDelayMs: 10,
  });
  const first = makeChild();
  supervisor.monitor(first.child);
  await first.ready;
  assert.equal(spawns, 1);
  process.kill(first.child.pid);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(spawns, 2, 'crashed real child must be restarted');
  const replacementPid = supervisor.monitoredPid;
  assert.ok(replacementPid, 'supervisor tracks the replacement child');
  supervisor.stop();
  process.kill(replacementPid);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(exits.length >= 1, 'real exit events were observed');
});
