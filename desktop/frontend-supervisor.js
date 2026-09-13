'use strict';

// Bounded supervision for the desktop renderer host (frontend-host.js child).
// After the first READY an unexpected exit must not leave the window pinned to
// a dead named pipe: the supervisor restarts the child within a crash budget,
// reports every attempt to diagnostics, and after exhaustion offers one clear
// manual entry instead of looping. Planned shutdown exits never restart.

function createFrontendSupervisor({
  startChild,
  isShuttingDown = () => false,
  maxRestarts = 3,
  windowMs = 10 * 60 * 1000,
  restartDelayMs = 1500,
  stabilityMs = 10 * 60 * 1000,
  onRestart,
  onReady,
  onExhausted,
  now = () => Date.now(),
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof startChild !== 'function') throw new Error('startChild is required');
  let child = null;
  let stopped = false;
  let restarting = false;
  let exhausted = false;
  let generation = 0;
  const crashes = [];

  function prune(stamp) {
    while (crashes.length && stamp - crashes[0] > windowMs) crashes.shift();
  }

  function recordCrash(detail) {
    crashes.push(now());
    prune(crashes[crashes.length - 1]);
    if (crashes.length > maxRestarts && !exhausted) {
      exhausted = true;
      onExhausted?.({ restarts: crashes.length - 1, ...detail });
      return true;
    }
    return false;
  }

  function monitor(next) {
    child = next;
    next.on('exit', (code) => { void handleExit({ lastExitCode: code }); });
  }

  async function launch() {
    const gen = ++generation;
    const { child: next, ready } = await startChild();
    await ready;
    monitor(next);
    onReady?.(next);
    // Only sustained stability repays the crash budget. A timer tied to this
    // generation clears the window when the child is still the current one
    // after stabilityMs; any newer launch invalidates a stale timer.
    if (stabilityMs > 0 && stabilityMs !== Infinity) {
      const timer = setTimeout(() => {
        if (gen === generation && !exhausted) crashes.length = 0;
      }, stabilityMs);
      timer.unref?.();
    }
  }

  async function handleExit(detail) {
    if (stopped || isShuttingDown() || restarting) return;
    if (recordCrash(detail)) return;
    restarting = true;
    try {
      while (!stopped && !isShuttingDown()) {
        if (restartDelayMs > 0) await delay(restartDelayMs);
        if (stopped || isShuttingDown()) return;
        try {
          onRestart?.({ attempt: crashes.length, ...detail });
          await launch();
          return;
        } catch (error) {
          if (stopped || isShuttingDown()) return;
          if (recordCrash({ lastError: String(error?.message || error) })) return;
        }
      }
    } finally {
      restarting = false;
    }
  }

  return {
    monitor,
    stop() { stopped = true; child = null; },
    // Manual entry after exhaustion: opens one fresh bounded supervision
    // window instead of silently resuming an exhausted budget.
    resume() {
      if (restarting) return;
      stopped = false;
      exhausted = false;
      crashes.length = 0;
      void handleExit({ manual: true });
    },
    get monitoredPid() { return child?.pid ?? null; },
    get restartCount() { return crashes.length; },
    get exhausted() { return exhausted; },
    get restarting() { return restarting; },
  };
}

module.exports = { createFrontendSupervisor };
