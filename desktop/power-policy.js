'use strict';

// "Keep the computer awake during long tasks" management.
//
// Exactly one prevent-app-suspension powerSaveBlocker covers every active
// reference (authoritative durable Turn events, managed CLI jobs; managed
// media activity plugs in through the same provider list once D's activity
// interface lands). An idle or minimized app never holds a blocker. The
// blocking window is bounded by a maximum duration, honours a battery
// policy, and a system suspend/resume only re-reads the authoritative state:
// reasons are dropped on resume and re-acquired by real events — side
// effects are never replayed and a shutdown is never claimed preventable.

function createPowerPolicy({
  powerSaveBlocker,
  readPreferences = () => ({ version: 1, enabled: true, onBattery: 'keep' }),
  maxDurationMs = 4 * 60 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  if (!powerSaveBlocker || typeof powerSaveBlocker.start !== 'function' || typeof powerSaveBlocker.stop !== 'function') {
    throw new Error('power-policy requires a powerSaveBlocker with start/stop');
  }
  let preferences = readPreferences();
  if (!preferences || typeof preferences !== 'object') preferences = { version: 1, enabled: true, onBattery: 'keep' };
  const references = new Map(); // key -> { reason, at }
  let blockerId = null;
  let windowStartedAt = null;
  let windowExpired = false;
  let onBattery = false;
  let lastStopReason = '';

  function effectiveBlocking() {
    if (!preferences.enabled || windowExpired) return false;
    if (onBattery && preferences.onBattery === 'release') return false;
    return references.size > 0;
  }

  function sync() {
    const shouldBlock = effectiveBlocking();
    if (shouldBlock && blockerId === null) {
      blockerId = powerSaveBlocker.start('prevent-app-suspension');
      windowStartedAt = now();
      lastStopReason = '';
    } else if (!shouldBlock && blockerId !== null) {
      try { powerSaveBlocker.stop(blockerId); } catch { /* already stopped */ }
      blockerId = null;
      windowStartedAt = null;
    }
  }

  // X (06:18 item 6): the window-expiry check must apply to SAME-KEY
  // re-acquires as well — an eternal activity must not reset the window.
  function evaluateExpiry() {
    if (windowStartedAt !== null && now() - windowStartedAt > maxDurationMs) {
      windowExpired = true;
    }
  }

  function poll() {
    evaluateExpiry();
    sync();
    return computeState();
  }

  function computeState() {
    const blocking = blockerId !== null;
    const expiresAt = blocking && windowStartedAt !== null ? windowStartedAt + maxDurationMs : null;
    return {
      blocking,
      blockerHeld: blocking,
      windowExpired,
      onBattery,
      expiresAt,
      stoppedReason: blocking ? '' : (lastStopReason || (preferences.enabled ? '' : 'disabled')),
      preferences: { ...preferences },
      references: [...references.entries()].map(([key, value]) => ({ key, reason: value.reason, at: value.at })),
    };
  }

  return {
    // Real poll tick: re-evaluate expiry and sync the blocker.
    poll,
    // Acquire a named reference; the same key is idempotent.
    acquire(key, reason = key) {
      if (typeof key !== 'string' || !key) return this.state();
      evaluateExpiry();
      if (references.size === 0 && windowExpired) windowExpired = false; // fresh task, fresh window
      references.set(key, { reason: String(reason).slice(0, 200), at: new Date(now()).toISOString() });
      sync();
      return this.state();
    },
    release(key) {
      references.delete(key);
      if (references.size === 0) windowExpired = false;
      sync();
      return this.state();
    },
    get pollTick() { return poll; },
    // Authoritative state wipe (suspend/resume, shutdown): stop blocking,
    // drop every reason; real events may re-acquire afterwards.
    reset(stopReason = 'resumed') {
      references.clear();
      windowExpired = false;
      lastStopReason = stopReason;
      sync();
      return this.state();
    },
    setPreferences(next) {
      if (next && typeof next === 'object') preferences = { ...preferences, ...next };
      sync();
      return this.state();
    },
    setBattery(onBatteryPower) {
      onBattery = Boolean(onBatteryPower);
      sync();
      return this.state();
    },
    state() {
      return computeState();
    },
  };
}

// Turn lifecycle events are the authoritative activity source: a durable
// running Turn holds a reference; terminal states release it.
function turnReferenceFromNotification(notification) {
  if (notification?.method !== 'turn/event') return null;
  const params = notification.params ?? {};
  if (typeof params.turnId !== 'string' || !params.turnId || params.turnId.length > 200) return null;
  if (params.status === 'running') return { key: `turn:${params.turnId}`, active: true };
  if (['completed', 'failed', 'cancelled', 'interrupted'].includes(params.status)) {
    return { key: `turn:${params.turnId}`, active: false };
  }
  return null;
}

module.exports = { createPowerPolicy, turnReferenceFromNotification };
