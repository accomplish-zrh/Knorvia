'use strict';
const crypto = require('node:crypto');

// Only claim durable jobs admitted by the daemon. Retrying an acknowledgement
// never launches the external process again; an uncertain run stays uncertain.
function createCliDispatchBridge({ rpc, handlers, backendIds, intervalMs = 1000, hostId = `host_${crypto.randomUUID()}`, onError = () => {} }) {
  const running = new Map();
  const completed = new Map();
  const acknowledging = new Set();
  let closed = false;
  let timer;
  let polling;

  async function acknowledge() {
    for (const [id, result] of completed) {
      if (acknowledging.has(id)) continue;
      acknowledging.add(id);
      try {
        await rpc('cliDispatch/complete', result);
        completed.delete(id);
      } catch (error) { onError(error); }
      finally { acknowledging.delete(id); }
    }
  }

  function execute(job) {
    if (running.has(job.runId) || completed.has(job.requestId)) return;
    const work = (async () => {
      const result = { hostId, requestId: job.requestId, conversationId: job.conversationId, runId: job.runId };
      try {
        const output = await Promise.resolve().then(() => handlers['cliBackend/runTurn'](job));
        result.text = output.text;
        result.sessionId = output.sessionId;
      } catch (error) {
        result.error = String(error?.message || 'CLI execution failed').slice(0, 2048);
      }
      completed.set(job.requestId, result);
      running.delete(job.runId);
      await acknowledge();
    })();
    running.set(job.runId, work);
  }

  async function poll() {
    await acknowledge();
    if (closed) return;
    const available = running.size < 4 && completed.size === 0 ? await backendIds() : [];
    const response = await rpc('cliDispatch/claim', { hostId, backendIds: available });
    for (const runId of response.cancels ?? []) {
      if (running.has(runId)) await handlers['cliBackend/cancel']({ runId });
    }
    for (const job of response.jobs ?? []) {
      if (!closed) execute(job);
      else completed.set(job.requestId, { hostId, requestId: job.requestId, conversationId: job.conversationId, runId: job.runId, error: 'Host closed before execution' });
    }
  }

  function tick() {
    if (closed || polling) return polling;
    polling = poll().catch(onError).finally(() => {
      polling = undefined;
      if (!closed) { timer = setTimeout(tick, intervalMs); timer.unref?.(); }
    });
    return polling;
  }

  async function close() {
    closed = true;
    clearTimeout(timer);
    try { await polling; } catch {}
    await Promise.allSettled([...running.keys()].map(runId => handlers['cliBackend/cancel']({ runId })));
    await Promise.allSettled([...running.values()]);
    await acknowledge();
  }

  return { start: tick, close, get activeCount() { return running.size; } };
}

module.exports = { createCliDispatchBridge };
