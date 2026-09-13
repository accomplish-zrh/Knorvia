'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createShutdownController, raceWithTimer, asShutdownStep } = require('../shutdown-controller');

const never = () => new Promise(() => {});

test('every step reports confirmed when the components close in time', async () => {
  const order = [];
  const controller = createShutdownController({
    totalBudgetMs: 5000,
    steps: [
      { name: 'a', close: async () => { order.push('a'); } },
      { name: 'b', close: async () => { order.push('b'); } },
      { name: 'c', close: () => { order.push('c'); } },
    ],
  });
  const report = await controller.run();
  assert.deepEqual(report.unconfirmed, []);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(report.steps.every((s) => s.status === 'confirmed'), true);
  assert.equal(report.withinBudget, true);
});

test('one never-completing component cannot block the remaining cleanup', async () => {
  const closed = [];
  const started = Date.now();
  const controller = createShutdownController({
    totalBudgetMs: 1500,
    steps: [
      { name: 'media-studio', timeoutMs: 400, close: never },
      { name: 'cli-dispatch', close: async () => { closed.push('cli-dispatch'); } },
      { name: 'ssh-sessions', close: async () => { closed.push('ssh-sessions'); } },
    ],
  });
  const report = await controller.run();
  assert.deepEqual(closed, ['cli-dispatch', 'ssh-sessions'], 'later steps must still run');
  const media = report.steps.find((s) => s.name === 'media-studio');
  assert.equal(media.status, 'unconfirmed');
  assert.match(media.detail, /no completion within 400ms/);
  assert.deepEqual(report.unconfirmed, ['media-studio']);
  assert.ok(Date.now() - started < 5000, 'bounded wall clock');
});

test('budget exhaustion degrades later steps to signalled while cancelling them', async () => {
  const cancelled = [];
  const controller = createShutdownController({
    totalBudgetMs: 300,
    steps: [
      { name: 'hang-1', timeoutMs: 250, close: never },
      { name: 'hang-2', timeoutMs: 250, close: never },
      { name: 'last', close: async () => { cancelled.push('last'); } },
    ],
  });
  const report = await controller.run();
  assert.equal(report.steps.length, 3);
  const statuses = Object.fromEntries(report.steps.map((s) => [s.name, s.status]));
  assert.equal(statuses['hang-1'], 'unconfirmed');
  assert.ok(['signalled', 'unconfirmed'].includes(statuses['hang-2']));
  assert.equal(cancelled.includes('last'), true, 'the final component still received its stop request');
  assert.ok(report.unconfirmed.length >= 1);
});

test('a throwing close is failed, not confirmed, and the run continues', async () => {
  const controller = createShutdownController({
    totalBudgetMs: 2000,
    steps: [
      { name: 'boom', close: async () => { throw new Error('close exploded'); } },
      { name: 'after', close: async () => {} },
    ],
  });
  const report = await controller.run();
  assert.equal(report.steps[0].status, 'failed');
  assert.match(report.steps[0].detail, /close exploded/);
  assert.equal(report.steps[1].status, 'confirmed');
  assert.deepEqual(report.unconfirmed, ['boom']);
});

test('a component that reports confirmed:false stays unconfirmed with its detail', async () => {
  const controller = createShutdownController({
    totalBudgetMs: 2000,
    steps: [
      {
        name: 'cli-backends',
        close: async () => ({ confirmed: false, detail: 'unconfirmed runs: run_1' }),
      },
    ],
  });
  const report = await controller.run();
  assert.equal(report.steps[0].status, 'unconfirmed');
  assert.match(report.steps[0].detail, /run_1/);
});

test('only unconfirmed owned PIDs are force-reaped', async () => {
  const reaped = [];
  const controller = createShutdownController({
    totalBudgetMs: 2000,
    reapPids: (pending) => { reaped.push(...pending); return pending; },
    steps: [
      { name: 'hung', timeoutMs: 100, close: never, ownedPids: () => [4321] },
      { name: 'fine', close: async () => {}, ownedPids: () => [1111] },
    ],
  });
  const report = await controller.run();
  assert.deepEqual(report.reaped.map((r) => r.pid), [4321]);
  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].step, 'hung');
});

test('steps run in declaration order and the total stays inside the budget', async () => {
  const started = Date.now();
  const controller = createShutdownController({
    totalBudgetMs: 600,
    steps: Array.from({ length: 4 }, (_, i) => ({
      name: `hang-${i}`,
      close: never,
    })),
  });
  const report = await controller.run();
  assert.ok(report.totalMs <= 1500, `total ${report.totalMs}ms must stay near the 600ms budget`);
  assert.ok(Date.now() - started < 3000);
  assert.equal(report.unconfirmed.length, 4);
});

test('raceWithTimer resolves timedOut for a zero deadline without waiting', async () => {
  const started = Date.now();
  const outcome = await raceWithTimer(never, 0);
  assert.equal(outcome.timedOut, true);
  assert.ok(Date.now() - started < 50);
  const okOutcome = await raceWithTimer(Promise.resolve('v'), 500);
  assert.deepEqual(okOutcome, { timedOut: false, value: 'v' });
});

// REVIEW fix (C15): the host wrapper must preserve structured shutdown
// results — the discarded {confirmed:false} regression class.
test('asShutdownStep preserves a component-reported confirmed:false', async () => {
  const controller = createShutdownController({
    totalBudgetMs: 2000,
    steps: [asShutdownStep('media-studio', async () => ({ confirmed: false, detail: 'workers still draining', ownedPids: [555] }))],
  });
  const report = await controller.run();
  assert.equal(report.steps[0].status, 'unconfirmed');
  assert.match(report.steps[0].detail, /workers still draining/);
  assert.deepEqual(report.unconfirmed, ['media-studio']);
});

test('asShutdownStep treats a void close completing in time as confirmed and a hang as unconfirmed', async () => {
  const controller = createShutdownController({
    totalBudgetMs: 2000,
    steps: [
      asShutdownStep('legacy-dispose', async () => {}),
      asShutdownStep('hung-dispose', never, { timeoutMs: 100 }),
    ],
  });
  const report = await controller.run();
  assert.equal(report.steps[0].status, 'confirmed', 'void close completing inside the deadline is the only confirmed claim');
  assert.equal(report.steps[1].status, 'unconfirmed');
  assert.match(report.steps[1].detail, /no completion within 100ms/);
});

test('asShutdownStep surfaces thrown close errors as failed with the step name', async () => {
  const controller = createShutdownController({
    totalBudgetMs: 2000,
    steps: [asShutdownStep('ssh-sessions', async () => { throw new Error('socket busy'); })],
  });
  const report = await controller.run();
  assert.equal(report.steps[0].status, 'failed');
  assert.match(report.steps[0].detail, /ssh-sessions: socket busy/);
});

test('wall-clock rollback cannot extend or corrupt the monotonic shutdown deadline', async () => {
  const originalDateNow = Date.now;
  let wall = 50_000;
  Date.now = () => (wall -= 10_000);
  try {
    let observed;
    const controller = createShutdownController({
      totalBudgetMs: 200,
      steps: [{ name: 'cooperative', close: async context => { observed = context; await new Promise(resolve => setTimeout(resolve, 20)); } }],
    });
    const report = await controller.run();
    assert.equal(report.steps[0].status, 'confirmed');
    assert.equal(report.withinBudget, true);
    assert.ok(observed.deadline > 0);
    assert.ok(observed.now() <= observed.hostDeadline);
  } finally { Date.now = originalDateNow; }
});

test('timed-out cooperative close receives abort and cannot publish a late side effect', async () => {
  let published = false;
  let sawAbort = false;
  const controller = createShutdownController({
    totalBudgetMs: 120,
    steps: [{
      name: 'late-writer', timeoutMs: 20,
      close: context => new Promise(resolve => {
        context.signal.addEventListener('abort', () => { sawAbort = true; }, { once: true });
        setTimeout(() => {
          if (!context.signal.aborted) published = true;
          resolve({ confirmed: !context.signal.aborted });
        }, 60);
      }),
    }],
  });
  const report = await controller.run();
  assert.equal(report.steps[0].status, 'unconfirmed', 'deadline never becomes a success receipt');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(sawAbort, true);
  assert.equal(published, false, 'the cooperative writer observes abort before its delayed commit');
});

test('real child is reaped through the bounded owned-PID phase while a bystander survives', async t => {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(() => { try { child.kill(); } catch {} try { bystander.kill(); } catch {} });
  const controller = createShutdownController({
    totalBudgetMs: 1500,
    steps: [{ name: 'owned-worker', timeoutMs: 30, close: never, ownedPids: () => [child.pid] }],
    reapPids: async (pending, context) => {
      assert.equal(pending.length, 1);
      assert.equal(pending[0].pid, child.pid);
      child.kill();
      while (alive(child.pid) && context.now() < context.deadline && !context.signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return alive(child.pid) ? [] : pending;
    },
  });
  const report = await controller.run();
  assert.equal(report.steps[0].status, 'unconfirmed');
  assert.deepEqual(report.reaped.map(item => item.pid), [child.pid]);
  assert.equal(alive(child.pid), false);
  assert.equal(alive(bystander.pid), true, 'PID ownership never widens to unrelated processes');
});

test('a hanging reaper is bounded by the same host deadline and never reports a false receipt', async () => {
  const controller = createShutdownController({
    totalBudgetMs: 90,
    steps: [{ name: 'worker', timeoutMs: 15, close: never, ownedPids: () => [987654] }],
    reapPids: () => never(),
  });
  const report = await controller.run();
  assert.equal(report.reaper.status, 'unconfirmed');
  assert.deepEqual(report.reaped, []);
  assert.ok(report.unconfirmed.includes('process-reaper'));
  assert.ok(report.totalMs < 250, `reaper escaped host deadline: ${report.totalMs}ms`);
});
