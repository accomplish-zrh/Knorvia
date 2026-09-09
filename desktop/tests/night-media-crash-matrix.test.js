'use strict';

// Crash-window matrix for the durable storyboard queue (MED-09 / B07).
// Each test injects a fault between two durable steps and then recovers with
// a fresh engine over the same store; the assertions pin the no-duplicate-
// side-effect guarantees: one submission per key, one library entry per tail
// frame, no fake completion, unknown never auto-resubmitted.
const assert = require('node:assert/strict');
const test = require('node:test');
const { createFakeRpc, createFakeStudio, fakeLibrary, createEngine, threeShots, wait, waitFor } = require('./fixtures/sequence-harness');

test('crash matrix 1+2: fault before the jobId checkpoint lands — recovery reuses the same submission', async () => {
  const rpc = createFakeRpc();
  const studio = createFakeStudio(rpc, { completeMs: 60 });
  // Fault once: the checkpoint that would persist the shot jobId is lost.
  rpc.state.checkpointFaults.push(params => Boolean(params.checkpoint?.shots?.find(shot => shot.status === 'submitted')));
  const { engine, home } = createEngine(rpc, studio, { staleMs: 60000 });
  const sequence = await threeShots(engine, { start: true });
  await waitFor(async () => studio.submissions.length >= 1, 'first submission');
  await wait(80); // let the injected fault fire and the runner give up
  const afterCrash = await engine.handlers['studio/sequence/read']({ id: sequence.id });
  assert.equal(afterCrash.shots[0].jobId, undefined, 'jobId checkpoint was lost');
  await engine.close();
  // Restart: an interrupted runner leaves needs-attention; the explicit user
  // resume is what continues the chain. The same idempotency key must reuse
  // the existing remote job.
  const restarted = createEngine(rpc, studio, { home, staleMs: 60000 });
  await restarted.engine.recover();
  await restarted.engine.handlers['studio/sequence/resume']({ id: sequence.id });
  await waitFor(async () => (await restarted.engine.handlers['studio/sequence/read']({ id: sequence.id })).state === 'completed', 'recovered completion', 15000);
  const read = await restarted.engine.handlers['studio/sequence/read']({ id: sequence.id });
  assert.deepEqual(read.shots.map(shot => shot.status), ['completed', 'completed', 'completed']);
  const keys = studio.submissions.map(item => item.idempotencyKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.length, 3, 'exactly one submission per shot across the crash');
  await restarted.engine.close();
});

test('crash matrix 3: crash while the first shot is remote-in-flight — tracking resumes, no new submission', async () => {
  const rpc = createFakeRpc();
  const studio = createFakeStudio(rpc, { completeMs: 700 });
  const { engine, home } = createEngine(rpc, studio, { staleMs: 60000 });
  const sequence = await threeShots(engine, { start: true });
  await waitFor(async () => studio.submissions.length >= 1, 'first submission');
  await engine.close(); // crash mid-tracking
  const restarted = createEngine(rpc, studio, { home, staleMs: 60000 });
  await restarted.engine.recover();
  await waitFor(async () => (await restarted.engine.handlers['studio/sequence/read']({ id: sequence.id })).state === 'completed', 'recovered completion', 20000);
  assert.equal(studio.submissions.length, 3);
  assert.equal(new Set(studio.submissions.map(item => item.idempotencyKey)).size, 3);
  await restarted.engine.close();
});

test('crash matrix 4+5: video saved but tail-frame chain state lost — export is idempotent, one library entry', async () => {
  const rpc = createFakeRpc();
  const studio = createFakeStudio(rpc, { completeMs: 40 });
  const library = fakeLibrary();
  let exports = 0;
  const originalExport = studio.exportTailFrameForJob.bind(studio);
  studio.exportTailFrameForJob = async (...args) => {
    exports += 1;
    if (exports === 1) {
      // Crash after the export but before the sequence checkpoint records it.
      rpc.state.checkpointFaults.push(params => Boolean(params.checkpoint?.shots?.find(shot => shot.result?.tailFrame)));
    }
    return originalExport(...args);
  };
  const { engine, home } = createEngine(rpc, studio, { staleMs: 60000, library });
  const sequence = await threeShots(engine, { start: true });
  await waitFor(async () => studio.submissions.length >= 1, 'first submission');
  await wait(150);
  await engine.close();
  const restarted = createEngine(rpc, studio, { home, staleMs: 60000, library });
  await restarted.engine.recover();
  await restarted.engine.handlers['studio/sequence/resume']({ id: sequence.id });
  await waitFor(async () => (await restarted.engine.handlers['studio/sequence/read']({ id: sequence.id })).state === 'completed', 'recovered completion', 15000);
  const read = await restarted.engine.handlers['studio/sequence/read']({ id: sequence.id });
  // Three shots, but the first shot's tail frame is exported at most twice
  // (crash + recovery) while the library keeps a single entry per content.
  assert.ok(exports >= 1 && exports <= 6, `unexpected export count ${exports}`);
  const tailPaths = read.shots.filter(shot => shot.result?.tailFrame).map(shot => shot.result.tailFrame.libraryPath);
  assert.equal(new Set(tailPaths).size, tailPaths.length, 'no duplicated library paths');
  await restarted.engine.close();
});

test('crash matrix 6: paused sequences never auto-resume after restart', async () => {
  const rpc = createFakeRpc();
  const studio = createFakeStudio(rpc, { completeMs: 500 });
  const { engine, home } = createEngine(rpc, studio, { staleMs: 60000 });
  const sequence = await threeShots(engine, { start: true });
  await waitFor(async () => studio.submissions.length >= 1, 'first submission');
  await engine.handlers['studio/sequence/pause']({ id: sequence.id });
  await wait(520); // current shot completes under pause
  await engine.close();
  const restarted = createEngine(rpc, studio, { home, staleMs: 60000 });
  await restarted.engine.recover();
  await wait(200);
  const read = await restarted.engine.handlers['studio/sequence/read']({ id: sequence.id });
  assert.equal(read.state, 'paused', 'paused must stay paused across restart');
  assert.equal(studio.submissions.length, 1, 'no dispatch while paused');
  await restarted.engine.handlers['studio/sequence/resume']({ id: sequence.id });
  await waitFor(async () => (await restarted.engine.handlers['studio/sequence/read']({ id: sequence.id })).state === 'completed', 'completion after explicit resume', 15000);
  await restarted.engine.close();
});

test('crash matrix 7: unknown submission survives restart and is never resubmitted automatically', async () => {
  const rpc = createFakeRpc();
  const studio = createFakeStudio(rpc);
  // Only the FIRST submission is lost with an unknown outcome; a deliberate
  // retry (new key) succeeds like a healthy provider would.
  const original = studio.create.bind(studio);
  studio.create = async params => {
    const job = await original(params);
    if (studio.submissions.length === 1) {
      const record = rpc.state.jobs.get(job.id);
      record.status = 'failed';
      record.checkpoint = { phase: 'unknown', error: '提交结果未知' };
    }
    return job;
  };
  const { engine, home } = createEngine(rpc, studio, { staleMs: 60000 });
  const sequence = await threeShots(engine, { start: true });
  await waitFor(async () => (await engine.handlers['studio/sequence/read']({ id: sequence.id })).state === 'needs-attention', 'needs-attention');
  await engine.close();
  const restarted = createEngine(rpc, studio, { home, staleMs: 60000 });
  await restarted.engine.recover();
  await wait(200);
  const read = await restarted.engine.handlers['studio/sequence/read']({ id: sequence.id });
  assert.equal(read.state, 'needs-attention');
  assert.equal(studio.submissions.length, 1, 'unknown never resubmits, not even across restart');
  // Explicit retry is the human decision that moves forward.
  await assert.rejects(restarted.engine.handlers['studio/sequence/retry']({ id: sequence.id, shotId: read.shots[0].id }), /确认/);
  await restarted.engine.handlers['studio/sequence/retry']({ id: sequence.id, shotId: read.shots[0].id, confirmRegenerate: true });
  await waitFor(async () => (await restarted.engine.handlers['studio/sequence/read']({ id: sequence.id })).state === 'completed', 'completion after retry', 15000);
  assert.equal(studio.submissions.length, 4, 'A retry gets a new key; B and C submit once each');
  await restarted.engine.close();
});

test('crash matrix 8: 20 duplicate sequence-create calls with one key create one queue', async () => {
  const rpc = createFakeRpc();
  const studio = createFakeStudio(rpc);
  const { engine } = createEngine(rpc, studio);
  const params = {
    title: 'x', globalPrompt: '统一画风：水墨', defaults: { profileId: 'conn-video', seconds: 4 },
    idempotencyKey: 'dup-key', start: false,
    shots: [1, 2, 3].map(index => ({ prompt: `第${index}幕`, profileId: 'conn-video', continuity: index > 1 ? 'previous-tail' : 'none' })),
  };
  const created = await Promise.all(Array.from({ length: 20 }, () => engine.handlers['studio/sequence/create'](params)));
  const ids = new Set(created.map(sequence => sequence.id));
  assert.equal(ids.size, 1, 'all 20 calls return the same sequence');
  const list = await engine.handlers['studio/sequence/list']({ offset: 0, limit: 50 });
  assert.equal(list.total, 1, 'exactly one queue root exists');
});
