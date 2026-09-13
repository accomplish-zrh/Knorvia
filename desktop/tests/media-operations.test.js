'use strict';

// C17 unit tests for the derived-media operations registry: dedup, bounded
// concurrency, refcounted per-caller cancellation and dispose semantics.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaOperations } = require('../media-operations');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('identical operations share one execution and get the same result', async () => {
  const ops = createMediaOperations({});
  let executions = 0;
  const run = () => ops.run({
    key: 'tail-frame:job-1:0:abc',
    kind: 'studio.tail-frame',
    execute: async (signal, report) => {
      executions += 1;
      report('decoding', 40);
      await new Promise(resolve => setTimeout(resolve, 30));
      return { frame: 'png-bytes', executions };
    },
  });
  const [a, b] = [run(), run()];
  const [ra, rb] = await Promise.all([a.promise, b.promise]);
  assert.equal(executions, 1, 'one shared execution for the same key');
  assert.deepEqual(ra, rb);
  assert.equal(a.executionId, b.executionId);
  assert.equal(a.opId !== b.opId, true, 'each caller keeps its own cancel token');
  const listed = ops.list();
  assert.equal(listed.filter(op => op.status === 'completed').length, 1);
  assert.equal(listed[0].callers, 2);
  assert.equal(listed[0].progress, 100);
});

test('different keys run independently and cancelling one leaves the other untouched', async () => {
  const ops = createMediaOperations({ concurrency: 2 });
  const gates = [deferred(), deferred()];
  // Execute bodies observe the signal like the real FFmpeg worker does.
  const hangUntil = (gate, result) => signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
    gate.promise.then(() => resolve(result));
  });
  const first = ops.run({ key: 'k-1', execute: (signal, report) => { report('stage-a', 10); return hangUntil(gates[0], 'one')(signal); } });
  const second = ops.run({ key: 'k-2', execute: (signal, report) => { report('stage-b', 20); return hangUntil(gates[1], 'two')(signal); } });
  const cancelOutcome = await ops.cancel(first.opId);
  assert.equal(cancelOutcome.canceled, true);
  await assert.rejects(first.promise, error => error.rpc?.code === -32012 || /aborted/.test(error.message));
  gates[1].resolve();
  assert.equal(await second.promise, 'two');
  const states = Object.fromEntries(ops.list().map(op => [op.key, op.status]));
  assert.deepEqual(states, { 'k-1': 'canceled', 'k-2': 'completed' });
});

test('a shared execution keeps running until its last caller cancels', async () => {
  const ops = createMediaOperations({});
  let aborted = 0;
  const gate = deferred();
  const run = () => ops.run({ key: 'shared:1', execute: signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted += 1; reject(new Error('aborted')); });
    gate.promise.then(resolve);
  }) });
  const a = run(), b = run();
  await ops.cancel(a.opId);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(aborted, 0, 'one remaining caller keeps the shared work alive');
  gate.resolve();
  assert.equal(await a.promise, undefined);
  assert.equal(await b.promise, undefined);
  // After completion, cancelling a stale token is an honest no-op.
  const outcome = await ops.cancel(b.opId);
  assert.equal(outcome.canceled, false);
  // Both callers cancelling ends the work.
  const gate2 = deferred();
  let lateAborts = 0;
  const lateExecute = signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { lateAborts += 1; reject(new Error('aborted')); });
    gate2.promise.then(resolve);
  });
  const c = ops.run({ key: 'shared:2', execute: lateExecute });
  const d = ops.run({ key: 'shared:2', execute: lateExecute });
  const cancelPromise = Promise.all([ops.cancel(c.opId), ops.cancel(d.opId)]);
  gate2.resolve();
  await cancelPromise;
  await assert.rejects(c.promise, () => true);
  await assert.rejects(d.promise, () => true);
  assert.equal(lateAborts, 1, 'the shared decode aborts exactly once when its last caller cancels');
});

test('concurrency is bounded and queued work starts in order', async () => {
  const ops = createMediaOperations({ concurrency: 1 });
  const order = [];
  const gate = deferred();
  const first = ops.run({ key: 'q-1', kind: 'x', label: 'one', execute: async () => { order.push(1); await gate.promise; return 1; } });
  const second = ops.run({ key: 'q-2', kind: 'x', label: 'two', execute: async () => { order.push(2); return 2; } });
  await new Promise(resolve => setTimeout(resolve, 20));
  const [one, two] = ops.list();
  assert.equal(one.status, 'running');
  assert.equal(two.status, 'queued');
  gate.resolve();
  assert.equal(await first.promise, 1);
  assert.equal(await second.promise, 2);
  assert.deepEqual(order, [1, 2]);
});

test('failures record an honest error and publish no result', async () => {
  const ops = createMediaOperations({});
  const run = ops.run({ key: 'boom', execute: async () => { throw Object.assign(new Error('decode failed'), { rpc: { code: -32602, message: '解码失败' } }); } });
  await assert.rejects(run.promise, error => error.rpc?.message === '解码失败');
  const [record] = ops.list();
  assert.equal(record.status, 'failed');
  assert.equal(record.error, '解码失败');
  assert.equal(record.result, undefined);
});

test('cancelByKey stops every matching execution of a target', async () => {
  const ops = createMediaOperations({ concurrency: 3 });
  const hangUntilAborted = signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const a = ops.run({ key: 'studio-tail-frame:job:0:sha', execute: hangUntilAborted });
  const b = ops.run({ key: 'studio-tail-frame:job:1:sha', execute: hangUntilAborted });
  const other = ops.run({ key: 'library-image:other', execute: hangUntilAborted });
  const outcome = ops.cancelByKey('studio-tail-frame:job:');
  assert.equal(outcome.canceled, true);
  assert.equal(outcome.stopped, 2);
  await assert.rejects(a.promise, () => true);
  await assert.rejects(b.promise, () => true);
  assert.equal(ops.list().find(op => op.key === 'library-image:other').status, 'running');
  void other;
});

test('dispose aborts owned executions and rejects new work', async () => {
  const ops = createMediaOperations({});
  let aborted = 0;
  const run = ops.run({ key: 'dispose-me', execute: signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted += 1; reject(new Error('stopped')); });
  }) });
  const disposing = ops.dispose();
  await assert.rejects(run.promise, () => true);
  await disposing;
  assert.equal(aborted, 1);
  assert.equal(ops.list()[0].status, 'canceled');
  assert.throws(() => ops.run({ key: 'after', execute: () => {} }), /shutting down|exiting/i);
});

test('dispose waits for the owned decode to finish, not just for the status flip', async () => {
  const ops = createMediaOperations({});
  let bodySettled = false;
  // A killed FFmpeg child reports its exit some time after the abort: the
  // status may flip immediately, but shutdown must not claim the process gone.
  const run = ops.run({ key: 'slow-exit', execute: signal => new Promise(resolve => {
    signal.addEventListener('abort', () => setTimeout(() => { bodySettled = true; resolve(); }, 150), { once: true });
  }) });
  run.promise.catch(() => {});
  const startedAt = Date.now();
  await ops.dispose();
  assert.ok(bodySettled, 'shutdown waited for the owned process to be reaped');
  assert.ok(Date.now() - startedAt >= 140, 'dispose did not return while the decode was still dying');
  assert.equal(ops.pendingCount, 0);
});

test('cancelling an execution stops every caller of that shared decode at once', async () => {
  const ops = createMediaOperations({ concurrency: 2 });
  const hang = signal => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  const a = ops.run({ key: 'shared', kind: 'studio.tail-frame', execute: hang });
  const b = ops.run({ key: 'shared', kind: 'studio.tail-frame', execute: hang });
  assert.equal(a.executionId, b.executionId, 'both callers joined one decode');
  const outcome = ops.cancelExecution(a.executionId, '队列中已取消');
  assert.equal(outcome.canceled, true);
  assert.equal(outcome.stopped, 2, 'both caller tokens were released');
  await assert.rejects(a.promise, error => error.rpc?.message === '队列中已取消');
  await assert.rejects(b.promise, error => error.rpc?.message === '队列中已取消');
  assert.equal(ops.list()[0].status, 'canceled');
  assert.equal(ops.pendingCount, 0, 'the stopped decode released its slot');
});

test('execution cancel refuses unknown, finished and already-aborting work', async () => {
  const ops = createMediaOperations({ concurrency: 2 });
  assert.deepEqual(ops.cancelExecution('00000000-0000-4000-8000-000000000000'), { canceled: false, reason: 'unknown-operation', executionId: '00000000-0000-4000-8000-000000000000', stopped: 0 });
  const finished = ops.run({ key: 'done', execute: async () => 'ok' });
  assert.equal((await finished.promise), 'ok');
  assert.equal(ops.cancelExecution(finished.executionId).reason, 'unknown-operation');
  // One caller already cancelled: the abort is in flight, nothing new stopped.
  const shared = ops.run({ key: 'aborted', execute: signal => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }) });
  ops.cancel(shared.opId);
  assert.deepEqual(ops.cancelExecution(shared.executionId), { canceled: false, reason: 'already-canceling', executionId: shared.executionId, stopped: 0 });
  await assert.rejects(shared.promise, () => true);
});
