'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPowerPolicy, turnReferenceFromNotification } = require('../power-policy');

function fakeBlocker() {
  const starts = [];
  let current = null;
  return {
    starts,
    start(type) { starts.push({ type, at: starts.length }); current = starts.length; return current; },
    stop(id) { if (id === current) current = null; },
    get held() { return current !== null; },
    get startCount() { return starts.length; },
  };
}

const prefs = (enabled = true, onBattery = 'keep') => () => ({ version: 1, enabled, onBattery });

test('multiple active tasks share exactly one blocker; the last release frees it', () => {
  const blocker = fakeBlocker();
  const policy = createPowerPolicy({ powerSaveBlocker: blocker, readPreferences: prefs() });
  policy.acquire('turn:t1', '任务 1');
  policy.acquire('turn:t2', '任务 2');
  assert.equal(blocker.startCount, 1, 'one blocker for two tasks');
  assert.equal(blocker.held, true);
  policy.release('turn:t1');
  assert.equal(blocker.held, true, 'the second task keeps the blocker');
  policy.release('turn:t2');
  assert.equal(blocker.held, false);
  assert.equal(policy.state().blocking, false);
  assert.equal(policy.state().references.length, 0);
});

test('a minimized idle app never prevents sleep', () => {
  const blocker = fakeBlocker();
  const policy = createPowerPolicy({ powerSaveBlocker: blocker, readPreferences: prefs() });
  assert.equal(policy.state().blocking, false);
  assert.equal(blocker.startCount, 0);
});

test('a disabled setting and a battery release policy both stop the blocker', () => {
  const blocker = fakeBlocker();
  const policy = createPowerPolicy({ powerSaveBlocker: blocker, readPreferences: prefs(false) });
  policy.acquire('turn:t1');
  assert.equal(blocker.held, false, 'disabled means no blocker even with active tasks');

  const policy2 = createPowerPolicy({ powerSaveBlocker: blocker, readPreferences: prefs(true, 'release') });
  policy2.acquire('turn:t1');
  policy2.setBattery(true);
  assert.equal(blocker.held, false, 'battery release policy stops the blocker');
  assert.equal(policy2.state().onBattery, true);
  policy2.setBattery(false);
  assert.equal(blocker.held, true, 'back on AC the reference blocks again');
  assert.equal(blocker.startCount, 2, 'the second hold is a fresh blocker');
});

test('the blocking window expires after the maximum duration and is visible in the state', () => {
  let clock = 1_000_000;
  const blocker = fakeBlocker();
  const policy = createPowerPolicy({ powerSaveBlocker: blocker, readPreferences: prefs(), maxDurationMs: 3600_000, now: () => clock });
  policy.acquire('turn:long-task', 'long running task');
  assert.equal(blocker.held, true);
  clock += 3600_001;
  policy.acquire('turn:another-task', 'a later task inside the same window');
  assert.equal(blocker.held, false, 'expired window stops blocking');
  assert.equal(policy.state().windowExpired, true);
  // Draining the references arms a fresh window for the next task.
  policy.release('turn:long-task');
  policy.release('turn:another-task');
  policy.acquire('turn:fresh');
  assert.equal(blocker.held, true, 'a fresh task opens a fresh window');
  assert.equal(policy.state().windowExpired, false);
});

test('suspend/resume wipes references without replaying side effects', () => {
  const blocker = fakeBlocker();
  const policy = createPowerPolicy({ powerSaveBlocker: blocker, readPreferences: prefs() });
  policy.acquire('turn:t1');
  policy.acquire('media:job-1', '受管媒体任务');
  assert.equal(policy.state().references.length, 2);
  policy.reset('resumed');
  assert.equal(policy.state().references.length, 0, 'all references dropped');
  assert.equal(blocker.held, false);
  assert.equal(policy.state().stoppedReason, 'resumed');
  // The authoritative source re-acquires only for a real new event.
  policy.acquire('turn:t2');
  assert.equal(blocker.held, true);
});

test('duplicate acquires collapse and unknown releases are ignored', () => {
  const blocker = fakeBlocker();
  const policy = createPowerPolicy({ powerSaveBlocker: blocker, readPreferences: prefs() });
  policy.acquire('turn:t1');
  policy.acquire('turn:t1', 'duplicate');
  assert.equal(policy.state().references.length, 1);
  assert.equal(blocker.startCount, 1);
  policy.release('turn:unknown');
  assert.equal(blocker.held, true, 'an unknown release must not drop the real reference');
});

test('turn notifications map to reference lifecycles', () => {
  const blocker = fakeBlocker();
  const policy = createPowerPolicy({ powerSaveBlocker: blocker, readPreferences: prefs() });
  const running = turnReferenceFromNotification({ method: 'turn/event', params: { turnId: 'turn-9', status: 'running' } });
  assert.deepEqual(running, { key: 'turn:turn-9', active: true });
  policy.acquire(running.key, running.key);
  assert.equal(blocker.held, true);
  const done = turnReferenceFromNotification({ method: 'turn/event', params: { turnId: 'turn-9', status: 'completed' } });
  policy.release(done.key);
  assert.equal(blocker.held, false);
  // Non-turn or non-terminal notifications never touch the policy.
  assert.equal(turnReferenceFromNotification({ method: 'turn/event', params: { turnId: '', status: 'running' } }), null);
  assert.equal(turnReferenceFromNotification({ method: 'thread/event', params: { turnId: 'x', status: 'running' } }), null);
  assert.equal(turnReferenceFromNotification({ method: 'turn/event', params: { turnId: 'x', status: 'streaming' } }), null);
});

// X (06:18 item 6, root counterexample power-window-0632): a same-key
// re-acquire past the window bound must release the blocker and set
// windowExpired — an eternal activity must not reset the window.
test('same-key re-acquire past the bound expires the window (root counterexample)', t => {
  let clock = 1000;
  let blockerHeld = false;
  const policy = createPowerPolicy({
    powerSaveBlocker: { start: () => { blockerHeld = true; return 1; }, stop: () => { blockerHeld = false; } },
    readPreferences: () => ({ version: 1, enabled: true, onBattery: 'keep' }),
    maxDurationMs: 10,
    now: () => clock,
  });
  policy.acquire('media:host', '受管媒体任务');
  assert.equal(policy.state().blocking, true);
  clock = 1011; // past the 10ms bound, SAME key re-acquired
  policy.acquire('media:host', '受管媒体任务');
  assert.equal(policy.state().blocking, false, 'expired window releases the blocker');
  assert.equal(policy.state().windowExpired, true);
  assert.equal(policy.state().references.length, 1, 'the activity stays listed but holds no blocker');
});

test('a real poll tick re-evaluates expiry for held references', t => {
  let clock = 1000;
  let blockerHeld = false;
  const policy = createPowerPolicy({
    powerSaveBlocker: { start: () => { blockerHeld = true; return 1; }, stop: () => { blockerHeld = false; } },
    readPreferences: () => ({ version: 1, enabled: true, onBattery: 'keep' }),
    maxDurationMs: 3600_000,
    now: () => clock,
  });
  policy.acquire('turn:t1');
  assert.equal(blockerHeld, true);
  clock += 3600_001;
  const state = policy.poll();
  assert.equal(state.blocking, false, 'poll releases the expired blocker');
  assert.equal(state.windowExpired, true);
});

// X (07:05 card item 6): one acquire with no new events, a real tick past
// the bound releases the blocker and sets windowExpired; the same key then
// cannot re-arm the window until the set drains.
test('a real poll tick releases an expired single-activity blocker', t => {
  let clock = 1000;
  let blockerHeld = false;
  const policy = createPowerPolicy({
    powerSaveBlocker: { start: () => { blockerHeld = true; return 1; }, stop: () => { blockerHeld = false; } },
    readPreferences: () => ({ version: 1, enabled: true, onBattery: 'keep' }),
    maxDurationMs: 3600_000,
    now: () => clock,
  });
  policy.acquire('turn:t1');
  assert.equal(blockerHeld, true);
  clock += 3600_001;
  const state = policy.poll();
  assert.equal(state.blocking, false, 'the tick releases the expired blocker');
  assert.equal(state.windowExpired, true);
  // The same key cannot re-arm while the window is expired.
  policy.acquire('turn:t1');
  assert.equal(policy.state().blocking, false);
  // Drain and re-arm with a genuinely fresh task.
  policy.release('turn:t1');
  policy.acquire('turn:fresh');
  assert.equal(policy.state().blocking, true, 'a fresh task opens a fresh window');
  assert.equal(policy.state().windowExpired, false);
});

test('pollTick resolves to the real tick function', t => {
  const policy = createPowerPolicy({
    powerSaveBlocker: { start: () => 1, stop: () => {} },
    readPreferences: () => ({ version: 1, enabled: true, onBattery: 'keep' }),
  });
  assert.equal(typeof policy.pollTick, 'function', 'the closure bug (undefined poll) is fixed');
});
