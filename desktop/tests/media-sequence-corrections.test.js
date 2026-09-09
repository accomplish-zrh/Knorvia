'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./fixtures/sequence-harness');

test('queue submission rejects same key with different payload and supports 200 stable shots', async t => {
  const rpc = H.createFakeRpc(), studio = H.createFakeStudio(rpc);
  const { engine } = H.createEngine(rpc, studio); t.after(() => engine.close());
  const input = { title: 'large', idempotencyKey: 'fixed', defaults: { profileId: 'video', seconds: 4 }, shots: Array.from({ length: 200 }, (_, i) => ({ prompt: `shot ${i} ${'认真描述这一段的角色、场景、动作与连续性。'.repeat(12)}` })) };
  const first = await engine.handlers['studio/sequence/create'](input);
  assert.equal(first.shots.length, 200);
  await assert.rejects(engine.handlers['studio/sequence/create']({ ...input, globalPrompt: 'different' }), error => error.rpc.code === -32005);
  const order = [...first.shots]; [order[1], order[2]] = [order[2], order[1]];
  const next = await engine.handlers['studio/sequence/update']({ id: first.id, revision: first.revision, patch: { shots: order } });
  assert.equal(next.shots[1].id, first.shots[2].id);
  assert.equal(next.shots[2].id, first.shots[1].id);
  const updates = await Promise.allSettled(['a', 'b'].map(title => engine.handlers['studio/sequence/update']({ id: first.id, revision: next.revision, patch: { title } })));
  assert.equal(updates.filter(v => v.status === 'fulfilled').length, 1, 'one CAS update wins');
});

test('tail extraction failure resumes the existing completed video without another submission', async t => {
  const rpc = H.createFakeRpc(), studio = H.createFakeStudio(rpc);
  const extract = studio.exportTailFrameForJob; let fail = true;
  studio.exportTailFrameForJob = (...args) => { if (fail) { fail = false; throw new Error('disk full'); } return extract(...args); };
  const { engine } = H.createEngine(rpc, studio); t.after(() => engine.close());
  const sequence = await H.threeShots(engine);
  await H.waitFor(async () => (await engine.handlers['studio/sequence/read']({ id: sequence.id })).state === 'needs-attention', 'frame error');
  const failed = await engine.handlers['studio/sequence/read']({ id: sequence.id });
  assert.equal(studio.submissions.length, 1);
  await engine.handlers['studio/sequence/retry']({ id: sequence.id, shotId: failed.shots[0].id });
  await H.waitFor(async () => (await engine.handlers['studio/sequence/read']({ id: sequence.id })).state === 'completed', 'recovery');
  const done = await engine.handlers['studio/sequence/read']({ id: sequence.id });
  assert.equal(studio.submissions.length, 3);
  assert.equal(done.shots[0].jobId, failed.shots[0].jobId);
  assert.equal(done.shots[0].attempt, 0);
});

test('two hosts cannot steal a long running sequence after the old heartbeat threshold', async t => {
  const rpc = H.createFakeRpc(), studio = H.createFakeStudio(rpc, { completeMs: 500 });
  const first = H.createEngine(rpc, studio, { staleMs: 40 });
  const second = H.createEngine(rpc, studio, { home: first.home, staleMs: 40 });
  t.after(async () => { await first.engine.close(); await second.engine.close(); });
  const sequence = await H.threeShots(first.engine);
  await H.waitFor(() => studio.submissions.length === 1, 'first submission');
  await H.wait(100); await second.engine.recover();
  await H.waitFor(async () => (await first.engine.handlers['studio/sequence/read']({ id: sequence.id })).state === 'completed', 'completion');
  assert.equal(studio.submissions.length, 3);
});

test('saved sequence snapshots preserve variables and survive template deletion and later edits', async t => {
  const rpc = H.createFakeRpc(), studio = H.createFakeStudio(rpc);
  const { engine, templates } = H.createEngine(rpc, studio); t.after(() => engine.close());
  const template = templates.handlers['studio/template/save']({ name: '角色', prompt: '{{who}} 原版', defaults: { who: '猫' } });
  const input = { title: 'snapshot', idempotencyKey: 'snapshot', defaults: { profileId: 'video', seconds: 4 }, globalPrompt: '全局', shots: [{ prompt: '', templateId: template.id, templateParams: { who: '狗' } }, { prompt: '第二段' }] };
  const queue = await engine.handlers['studio/sequence/create'](input);
  assert.equal(queue.shots[0].templateSnapshot, '狗 原版'); assert.equal(queue.shots[0].templateParams.who, '狗');
  templates.handlers['studio/template/remove']({ id: template.id, expectedRevision: 1 });
  const getProfile = studio.profiles.get; studio.profiles.get = () => { throw new Error('connection removed'); };
  const replay = await engine.handlers['studio/sequence/create'](input);
  assert.equal(replay.id, queue.id, 'lost creation response can be recovered after dependencies are removed');
  await assert.rejects(engine.handlers['studio/sequence/create']({ ...input, title: 'different' }), error => error.rpc?.code === -32005);
  studio.profiles.get = getProfile;
  const shots = queue.shots.map(shot => ({ ...shot })); shots[1].prompt = '修改第二段';
  const edited = await engine.handlers['studio/sequence/update']({ id: queue.id, revision: queue.revision, patch: { shots } });
  assert.equal(edited.shots[0].templateSnapshot, '狗 原版');
  await engine.handlers['studio/sequence/start']({ id: queue.id });
  await H.waitFor(async () => (await engine.handlers['studio/sequence/read']({ id: queue.id })).state === 'completed', 'snapshot completion');
  assert.equal(studio.submissions[0].prompt, '全局\n\n狗 原版');
});

test('image-required sequences pin a manual first frame and automatic continuation overrides later manual input', async t => {
  const rpc = H.createFakeRpc(), studio = H.createFakeStudio(rpc);
  studio.profiles.get = id => ({ id, kind: 'video', name: 'Runway', protocol: 'runway', model: 'gen4_turbo', custom: {}, extra: {} });
  const { engine } = H.createEngine(rpc, studio); t.after(() => engine.close());
  const reference = { id: 'library-image', version: 'a'.repeat(64), name: '分镜首帧.png' };
  const input = { title: 'image to sequence', defaults: { profileId: 'video', seconds: 4 }, shots: [{ prompt: '第一幕', firstFrame: reference }, { prompt: '第二幕', continuity: 'previous-tail', firstFrame: { ...reference, id: 'must-be-ignored' } }] };
  await assert.rejects(engine.handlers['studio/sequence/create']({ ...input, shots: [{ prompt: 'missing' }] }), /首帧/);
  const queue = await engine.handlers['studio/sequence/create'](input);
  assert.deepEqual(queue.shots[0].firstFrame, reference); assert.equal(queue.shots[1].firstFrame, undefined);
  await engine.handlers['studio/sequence/start']({ id: queue.id });
  await H.waitFor(async () => (await engine.handlers['studio/sequence/read']({ id: queue.id })).state === 'completed', 'image-led sequence');
  assert.deepEqual(studio.submissions[0].firstFrame, reference);
  assert.notEqual(studio.submissions[1].firstFrame.id, 'must-be-ignored');
  assert.notEqual(studio.submissions[1].firstFrame.version, reference.version);
});
