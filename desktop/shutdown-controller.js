'use strict';

const { performance } = require('node:perf_hooks');

// All values in a shutdown context use the same monotonic clock. `deadline`
// is meaningful only with the matching `now` function; it is deliberately
// not a wall-clock timestamp.
const monotonicNow = () => performance.now();

function validPid(value) {
  return Number.isInteger(value) && value > 0;
}

function raceWithTimer(promise, ms, { onTimeout } = {}) {
  return new Promise((resolve) => {
    if (!(ms > 0)) {
      try { onTimeout?.(); } catch {}
      resolve({ timedOut: true });
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { onTimeout?.(); } catch {}
      resolve({ timedOut: true });
    }, Math.max(1, Math.ceil(ms)));
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => { if (!done) { done = true; clearTimeout(timer); resolve({ timedOut: false, value }); } },
      (error) => { if (!done) { done = true; clearTimeout(timer); resolve({ timedOut: false, error }); } },
    );
  });
}

function asShutdownStep(name, close, { timeoutMs, ownedPids } = {}) {
  const fn = typeof close === 'function' ? close : (close && typeof close.close === 'function' ? close.close : null);
  if (!fn) throw new Error(`shutdown step ${name} has no close function`);
  return {
    name,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(typeof ownedPids === 'function' ? { ownedPids } : {}),
    close: async (context) => {
      const outcome = await Promise.resolve().then(() => fn(context)).catch((error) => {
        throw Object.assign(new Error(`${name}: ${String(error?.message || error)}`), { stepFailed: true });
      });
      if (outcome && typeof outcome === 'object') return outcome;
      return { confirmed: true };
    },
  };
}

function collectPids(target, values) {
  for (const pid of values || []) if (validPid(pid)) target.add(pid);
}

function createShutdownController({
  steps,
  totalBudgetMs = 15_000,
  now = monotonicNow,
  startedAt,
  deadline,
  reapPids,
  reaperTimeoutMs = 3_000,
} = {}) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('shutdown steps are required');
  if (reapPids && typeof reapPids !== 'function') throw new Error('reapPids must be a function');
  if (typeof now !== 'function') throw new Error('shutdown monotonic clock is required');

  async function run() {
    const beganAt = Number.isFinite(startedAt) ? startedAt : now();
    const hostDeadline = Number.isFinite(deadline) ? deadline : beganAt + Math.max(0, totalBudgetMs);
    const budget = Math.max(0, hostDeadline - beganAt);
    const results = [];
    const reap = [];

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const remaining = Math.max(0, hostDeadline - now());
      // The reaper is a real host phase, so reserve one equal scheduling slot
      // for it instead of letting the last close consume the whole deadline.
      const slots = steps.length - index + (reapPids ? 1 : 0);
      const share = remaining > 0 ? Math.floor(remaining / slots) : 0;
      const configured = Number.isFinite(step.timeoutMs) ? Math.max(0, step.timeoutMs) : share;
      const effective = Math.min(configured, remaining, share);
      const stepDeadline = Math.min(hostDeadline, now() + effective);
      const began = now();
      const entry = { name: step.name, status: 'confirmed', ms: 0, detail: undefined };
      const candidatePids = new Set();
      if (typeof step.ownedPids === 'function') {
        try { collectPids(candidatePids, step.ownedPids()); } catch {}
      }
      const closeFn = typeof step.close === 'function' ? step.close : (step.close && typeof step.close.close === 'function' ? step.close.close : null);
      const abort = new AbortController();
      if (!closeFn) {
        entry.status = 'failed';
        entry.detail = 'step has no close function';
      } else {
        if (!(effective > 0)) abort.abort(new Error('shutdown deadline reached'));
        const context = {
          signal: abort.signal,
          deadline: stepDeadline,
          hostDeadline,
          remainingMs: effective,
          timeoutMs: effective,
          hostRemainingMs: remaining,
          now,
        };
        const closePromise = Promise.resolve().then(() => closeFn(context));
        const outcome = await raceWithTimer(closePromise, effective, {
          onTimeout: () => abort.abort(new Error(`shutdown step ${step.name} exceeded its deadline`)),
        });
        if (outcome.timedOut) {
          entry.status = effective > 0 ? 'unconfirmed' : 'signalled';
          entry.detail = effective > 0 ? `no completion within ${effective}ms` : 'host deadline already exhausted';
        } else if (outcome.error) {
          entry.status = 'failed';
          entry.detail = String(outcome.error?.message || outcome.error).slice(0, 300);
        } else {
          collectPids(candidatePids, outcome.value?.ownedPids);
          if (outcome.value && typeof outcome.value === 'object' && outcome.value.confirmed === false) {
            entry.status = 'unconfirmed';
            entry.detail = typeof outcome.value.detail === 'string' && outcome.value.detail
              ? outcome.value.detail.slice(0, 300)
              : 'component reported it could not confirm shutdown';
          }
        }
      }
      entry.ms = Math.max(0, now() - began);
      if (entry.status !== 'confirmed') {
        for (const pid of candidatePids) reap.push({ pid, step: step.name, reason: entry.status });
      }
      results.push(entry);
    }

    let reapResults = [];
    let reaper = null;
    if (reap.length && reapPids) {
      const remaining = Math.max(0, hostDeadline - now());
      const effective = Math.min(Math.max(0, reaperTimeoutMs), remaining);
      const reaperAbort = new AbortController();
      if (!(effective > 0)) reaperAbort.abort(new Error('shutdown deadline reached'));
      const context = {
        signal: reaperAbort.signal,
        deadline: hostDeadline,
        hostDeadline,
        remainingMs: effective,
        timeoutMs: effective,
        hostRemainingMs: remaining,
        now,
      };
      const began = now();
      const outcome = await raceWithTimer(Promise.resolve().then(() => reapPids(reap, context)), effective, {
        onTimeout: () => reaperAbort.abort(new Error('shutdown reaper exceeded its deadline')),
      });
      reaper = { status: 'confirmed', ms: Math.max(0, now() - began), requested: reap.length };
      if (outcome.timedOut) {
        reaper.status = 'unconfirmed';
        reaper.detail = effective > 0 ? `no completion within ${effective}ms` : 'host deadline already exhausted';
      } else if (outcome.error) {
        reaper.status = 'failed';
        reaper.detail = String(outcome.error?.message || outcome.error).slice(0, 300);
      } else if (Array.isArray(outcome.value)) {
        const requested = new Set(reap.map(item => item.pid));
        reapResults = outcome.value.filter(item => item && requested.has(item.pid));
      }
    }

    const finishedAt = now();
    const unconfirmed = results.filter((r) => r.status !== 'confirmed').map((r) => r.name);
    if (reaper && reaper.status !== 'confirmed') unconfirmed.push('process-reaper');
    return {
      steps: results,
      unconfirmed,
      reaped: reapResults,
      ...(reaper ? { reaper } : {}),
      totalMs: Math.max(0, finishedAt - beganAt),
      withinBudget: finishedAt <= hostDeadline,
      budgetMs: budget,
      deadline: hostDeadline,
    };
  }

  return { run };
}

module.exports = { createShutdownController, raceWithTimer, asShutdownStep, monotonicNow };
