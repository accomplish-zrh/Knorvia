'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createCliDispatchBridge } = require('../cli-dispatch');

async function until(read) {
  const end = Date.now() + 3000;
  while (!read()) { if (Date.now() > end) throw new Error('host bridge timeout'); await delay(5); }
}

test('lost completion response retries the acknowledgement without re-executing CLI', async () => {
  const job = { requestId: 'request1', runId: 'clirun_fixture1', conversationId: 'room1', backendId: 'fixture', prompt: 'hello' };
  let claimed = false; let runs = 0; let acks = 0;
  const bridge = createCliDispatchBridge({
    intervalMs: 5, hostId: 'local-fixture', backendIds: () => ['fixture'],
    handlers: { 'cliBackend/runTurn': async () => { runs++; return { text: 'done', sessionId: 'exact-session' }; } },
    rpc: async (method, params) => {
      if (method === 'cliDispatch/claim') { const jobs = claimed ? [] : [job]; claimed = true; return { jobs, cancels: [] }; }
      assert.equal(params.sessionId, 'exact-session'); assert.equal(params.hostId, 'local-fixture');
      if (++acks === 1) throw new Error('lost response after durable commit');
      return { accepted: true, status: 'completed' };
    },
  });
  try { void bridge.start(); await until(() => acks === 2); assert.equal(runs, 1); }
  finally { await bridge.close(); }
});

test('cancel belongs to the claimed run and close records its terminal result', async () => {
  let rejectRun; let claimed = false; let acknowledged; const canceled = [];
  const job = { requestId: 'request2', runId: 'clirun_fixture2', conversationId: 'room2' };
  const bridge = createCliDispatchBridge({
    intervalMs: 5, backendIds: () => ['fixture'],
    handlers: {
      'cliBackend/runTurn': () => new Promise((_, reject) => { rejectRun = reject; }),
      'cliBackend/cancel': ({ runId }) => { canceled.push(runId); rejectRun(new Error('canceled')); },
    },
    rpc: async (method, params) => {
      if (method === 'cliDispatch/complete') { acknowledged = params; return { accepted: true }; }
      if (!claimed) { claimed = true; return { jobs: [job], cancels: [] }; }
      return { jobs: [], cancels: ['unowned-run', job.runId] };
    },
  });
  try { void bridge.start(); await until(() => acknowledged); assert.deepEqual(canceled, [job.runId]); assert.equal(acknowledged.error, 'canceled'); }
  finally { await bridge.close(); }
});
