'use strict';

// Unified registry for locally derived media operations (C17): tail-frame
// decodes, library image processing. Every operation has a stable identity,
// a bounded concurrency slot, stage/progress reporting and per-caller
// cancellation. Identical operations (same key: source id, version, params)
// share one execution instead of decoding twice, and each caller keeps its
// own cancellation token - the shared work only aborts when no un-cancelled
// caller remains. These are session operations: they never masquerade as the
// durable Rust Job store. Temporary artifacts stay unique per request and are
// published by the execute implementations only after success.
const { randomUUID } = require('node:crypto');

const DEFAULT_CONCURRENCY = 2;
const HISTORY_MAX = 100;
const RECORD_TTL_MS = 30 * 60 * 1000;
const TERMINAL = ['completed', 'failed', 'canceled'];
const canceledError = message => Object.assign(new Error(message || 'Operation cancelled'), { rpc: { code: -32012, message: message || 'Operation cancelled' } });

function createMediaOperations({ concurrency = DEFAULT_CONCURRENCY, historyMax = HISTORY_MAX, recordTtlMs = RECORD_TTL_MS } = {}) {
  const executions = new Map();   // executionId -> record
  const byKey = new Map();        // key -> record (active only)
  const byCaller = new Map();     // caller opId -> record
  const queue = [];
  let running = 0;
  let disposed = false;
  const publicRecord = record => {
    const { runtime, failure, ...rest } = record;
    return { ...rest, callers: record.callers };
  };
  function evictFinished(now = Date.now()) {
    const finished = [...executions.values()].filter(record => TERMINAL.includes(record.status)).sort((a, b) => a.finishedAt - b.finishedAt);
    for (const record of finished) {
      if (now - record.finishedAt > recordTtlMs || finished.indexOf(record) < finished.length - historyMax) {
        executions.delete(record.executionId);
      }
    }
  }
  function finalize(record, status, error, result) {
    if (TERMINAL.includes(record.status)) return;
    record.status = status;
    record.error = error?.rpc?.message || (status === 'failed' ? 'The operation failed and nothing was published' : '');
    if (error && status !== 'completed') record.failure = error;
    if (result !== undefined) record.result = result;
    record.progress = status === 'completed' ? 100 : record.progress;
    record.finishedAt = Date.now();
    byKey.delete(record.key);
    for (const opId of [...byCaller.keys()]) if (byCaller.get(opId) === record) byCaller.delete(opId);
    record.runtime.settled.resolve();
    // Queued work that was dropped never ran, so it is already body-settled.
    if (!record.runtime.started) record.runtime.body.resolve();
    // Only executions that already held a concurrency slot release one;
    // a queued cancellation never occupied a slot.
    if (record.runtime.started) { running -= 1; evictFinished(); const next = queue.shift(); if (next && !disposed) { running += 1; next.record.status = 'running'; start(next.record, next.execute); } }
  }
  // Every caller of one execution gets the shared result on success and the
  // shared failure (cancellation included) as a rejection otherwise.
  function callerPromise(record) {
    return record.runtime.settled.promise.then(() => {
      if (record.status === 'completed') return record.result;
      throw record.failure || canceledError(record.error);
    });
  }
  function start(record, execute) {
    const signal = record.runtime.controller.signal;
    const report = record.runtime.report;
    record.runtime.started = true;
    let promise;
    try {
      promise = Promise.resolve(execute(signal, report));
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then(
      result => { finalize(record, 'completed', undefined, result); record.runtime.body.resolve(); },
      error => {
        const status = signal.aborted ? 'canceled' : 'failed';
        const finalError = status === 'canceled' ? (error?.rpc ? error : canceledError(record.cancelMessage || '操作已取消')) : error;
        finalize(record, status, finalError);
        record.runtime.body.resolve();
      },
    ).catch(() => {});
  }
  function run({ key, kind, label, execute }) {
    if (disposed) throw canceledError('The media service is shutting down');
    if (typeof key !== 'string' || !key || typeof execute !== 'function') throw new Error('Media operations need a key and an execute function');
    const existing = byKey.get(key);
    if (existing && !TERMINAL.includes(existing.status)) {
      const opId = randomUUID();
      existing.callers += 1;
      byCaller.set(opId, existing);
      return { opId, executionId: existing.executionId, promise: callerPromise(existing) };
    }
    const record = {
      executionId: randomUUID(), key, kind: kind || 'media.operation', label: label || key,
      status: running >= concurrency ? 'queued' : 'running', stage: '', progress: 0,
      callers: 1, result: undefined, error: '', startedAt: Date.now(), finishedAt: 0,
    };
    let resolve;
    const settled = new Promise(resolvePromise => { resolve = resolvePromise; });
    let resolveBody;
    const body = new Promise(resolvePromise => { resolveBody = resolvePromise; });
    const controller = new AbortController();
    record.runtime = {
      controller, settled: { promise: settled, resolve }, body: { promise: body, resolve: resolveBody },
      report: (stage, progress) => {
        if (typeof stage === 'string') record.stage = stage;
        if (Number.isFinite(progress)) record.progress = Math.max(record.progress, Math.min(100, progress));
      },
    };
    executions.set(record.executionId, record);
    byKey.set(key, record);
    const opId = randomUUID();
    byCaller.set(opId, record);
    if (record.status === 'queued') queue.push({ record, execute });
    else { running += 1; start(record, execute); }
    return { opId, executionId: record.executionId, promise: callerPromise(record) };
  }
  // Cancelling one caller token never disturbs other callers of the same
  // shared execution; the work itself aborts only with its last caller.
  function cancel(opId, message) {
    const record = byCaller.get(opId);
    if (!record) return { canceled: false, reason: 'unknown-operation' };
    byCaller.delete(opId);
    record.callers -= 1;
    record.cancelMessage = message;
    if (record.callers <= 0) {
      if (record.runtime.started) {
        record.runtime.controller.abort();
      } else {
        const index = queue.findIndex(entry => entry.record === record);
        if (index >= 0) queue.splice(index, 1);
        finalize(record, 'canceled', canceledError(message));
      }
      return { canceled: true, executionId: record.executionId };
    }
    return { canceled: false, reason: record.callers > 0 ? 'other-callers-remain' : 'already-finished', executionId: record.executionId };
  }
  // Stops one whole execution for every caller that joined it. Used when the
  // UI closes the panel that started the work: no caller is left to serve.
  function cancelExecution(executionId, message) {
    const record = executions.get(executionId);
    if (!record || TERMINAL.includes(record.status)) return { canceled: false, reason: 'unknown-operation', executionId, stopped: 0 };
    record.cancelMessage = message;
    const opIds = [...byCaller.entries()].filter(([, value]) => value === record).map(([opId]) => opId);
    if (!opIds.length) return { canceled: false, reason: 'already-canceling', executionId, stopped: 0 };
    for (const opId of opIds) cancel(opId, message);
    return { canceled: true, reason: 'execution', executionId, stopped: opIds.length };
  }
  function list() {
    evictFinished();
    return [...executions.values()].map(publicRecord);
  }
  // Cancels every caller token of every execution whose key starts with the
  // prefix (e.g. one job's tail-frame exports). Returns whether at least one
  // active operation actually stopped.
  function cancelByKey(prefix, message) {
    let stopped = 0;
    for (const record of [...byKey.values()]) {
      if (!record.key.startsWith(prefix) || TERMINAL.includes(record.status)) continue;
      for (const opId of [...byCaller.keys()]) if (byCaller.get(opId) === record) cancel(opId, message);
      // A running execution finalizes asynchronously once its execute body
      // observes the abort; the abort request itself is what we count.
      if (!TERMINAL.includes(record.status)) record.runtime.controller.abort();
      stopped += 1;
    }
    return { canceled: stopped > 0, stopped };
  }
  async function dispose(message = 'The app is exiting; owned media operations were stopped') {
    disposed = true;
    queue.length = 0;
    for (const record of executions.values()) {
      if (TERMINAL.includes(record.status)) continue;
      record.runtime.controller.abort();
      finalize(record, 'canceled', canceledError(message));
    }
    // Wait for the owned decode processes themselves, not just for callers to
    // be notified: a record can be terminal while its FFmpeg child is dying.
    for (const record of executions.values()) if (!record.runtime.started) record.runtime.body.resolve();
    await Promise.allSettled([...executions.values()].map(record => record.runtime?.body?.promise));
  }
  return { run, cancel, cancelExecution, cancelByKey, list, dispose, get pendingCount() { return running + queue.length; } };
}

module.exports = { createMediaOperations, DEFAULT_CONCURRENCY };
