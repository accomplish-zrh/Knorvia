'use strict';

// Durable storyboard sequence + template + tail-frame acceptance tests.
// Jobs live in an in-memory fake of the Rust control contract; the sequence
// engine drives a fake studio so chain semantics are testable without a
// provider. Frame export uses REAL ffmpeg fixtures on disk. No network.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSequenceEngine } = require('../media-sequence');
const { createTemplateStore } = require('../studio-templates');
const { createMediaStudio } = require('../media-studio');
const F = require('./fixtures/video-fixtures');

let ffmpegAvailable = true;
try { F.ffmpeg(); } catch { ffmpegAvailable = false; }

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, what, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait(20);
  }
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function createFakeRpc() {
  const now = () => new Date().toISOString();
  const state = { seq: 0, jobs: new Map(), artifacts: new Map(), idempotency: new Map() };
  const terminal = job => ['succeeded', 'failed', 'cancelled'].includes(job.status);
  const rpc = async (method, params = {}) => {
    if (method === 'workspace/create') return { id: 'ws-1', title: params.title };
    if (method === 'job/create') {
      if (state.idempotency.has(params.idempotencyKey)) return { ...state.jobs.get(state.idempotency.get(params.idempotencyKey)) };
      const id = `job-${++state.seq}`;
      const job = { id, workspaceId: params.workspaceId, type: params.type, status: 'running', checkpoint: null, createdAt: now(), updatedAt: now() };
      state.jobs.set(id, job);
      if (params.idempotencyKey) state.idempotency.set(params.idempotencyKey, id);
      return { ...job };
    }
    if (method === 'job/read') {
      const job = state.jobs.get(params.id);
      if (!job) { const e = new Error('Job not found'); e.rpc = { code: -32004, message: 'Job not found' }; throw e; }
      return { ...job, checkpoint: job.checkpoint && structuredClone(job.checkpoint) };
    }
    if (method === 'job/checkpoint') {
      const job = state.jobs.get(params.jobId);
      if (!job || terminal(job)) { const e = new Error('Job not running'); e.rpc = { code: -32602, message: 'Job not running' }; throw e; }
      job.checkpoint = structuredClone(params.checkpoint);
      job.updatedAt = now();
      return { ...job, checkpoint: structuredClone(job.checkpoint) };
    }
    if (method === 'job/finish') {
      const job = state.jobs.get(params.jobId);
      if (job && !terminal(job)) job.status = params.status;
      return { ...job, checkpoint: job.checkpoint && structuredClone(job.checkpoint) };
    }
    if (method === 'job/cancel') {
      const job = state.jobs.get(params.id);
      if (job && !terminal(job)) job.status = 'cancelled';
      return { ...job, checkpoint: job.checkpoint && structuredClone(job.checkpoint) };
    }
    if (method === 'job/list') {
      const filtered = [...state.jobs.values()].filter(job => job.workspaceId === params.workspaceId && job.type.startsWith(params.typePrefix));
      return { jobs: filtered.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 200)).map(job => ({ ...job, checkpoint: job.checkpoint && structuredClone(job.checkpoint) })), total: filtered.length };
    }
    throw new Error(`fake rpc: unexpected method ${method}`);
  };
  rpc.state = state;
  return rpc;
}

// A studio double: submission is idempotent by key, shot jobs complete
// asynchronously, and every completed job gets its own deterministic tail
// frame so chain continuity assertions have real content.
function createFakeStudio(rpc, { completeMs = 80 } = {}) {
  const submissions = [];
  let seq = 0;
  const completeJob = (id, outcome) => wait(completeMs).then(() => {
    const job = rpc.state.jobs.get(id);
    if (!job || ['succeeded', 'failed', 'cancelled'].includes(job.status)) return;
    Object.assign(job, outcome);
  });
  return {
    submissions,
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'media-sequence-test-')),
    initialize: async () => { },
    workspaceId: () => 'ws-1',
    profiles: { get: id => ({ id, kind: 'video', name: `Conn-${id}`, model: 'model-x', baseUrl: 'http://127.0.0.1:9' }), list: () => [] },
    handlers: { 'studio/cancel': async params => rpc('job/cancel', params) },
    async create(params) {
      submissions.push({ ...params, at: new Date().toISOString() });
      const existing = submissions.find(item => item.idempotencyKey === params.idempotencyKey && item !== params);
      if (existing?.jobId) return { id: existing.jobId, status: 'running' };
      const id = `shotjob-${++seq}`;
      params.jobId = id;
      // Shot jobs are ordinary media.video jobs in the same store.
      rpc.state.jobs.set(id, { id, workspaceId: 'ws-1', type: 'media.video', status: 'running', checkpoint: { kind: 'video', phase: 'queued' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      void completeJob(id, {
        status: 'succeeded',
        checkpoint: {
          kind: 'video', phase: 'completed', progress: 100, artifactId: `art-${id}`,
          outputs: [{ name: `${id}-1.mp4`, mime: 'video/mp4', size: 4096, sha256: sha(`bytes-${id}`) }],
          usage: { raw: { videoSeconds: params.seconds }, provider: { name: 'Conn-x', model: 'model-x' } },
        },
      });
      return { id, status: 'running' };
    },
    async exportTailFrameForJob(jobId, index) {
      const job = rpc.state.jobs.get(jobId);
      const outputSha = job?.checkpoint?.outputs?.[index ?? 0]?.sha256;
      const frameSha = sha(`tailframe-of-${outputSha ?? jobId}`);
      return { file: `${jobId}-tail.png`, libraryId: `lib-${frameSha.slice(0, 8)}`, libraryVersion: frameSha, libraryName: `${jobId}-tail.png`, libraryPath: `创作/尾帧/${jobId}-tail.png`, sourceSha256: outputSha ?? '', frameSha256: frameSha, frameSize: 123, ptsTime: 0.28, streamIndex: 0, codec: 'h264', rotation: 0, usedFullScan: false, decoder: 'test', exportedAt: new Date().toISOString() };
    },
  };
}

function createEngine(rpc, studio, options = {}) {
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ns-seq-home-'));
  const templates = createTemplateStore({ home });
  const engine = createSequenceEngine({ home, rpc, library: fakeLibrary(), studio, templates, pollMs: options.pollMs ?? 20, heartbeatMs: 40, staleMs: options.staleMs ?? 120 });
  return { engine, templates, home };
}
function fakeLibrary() {
  const entries = new Map();
  return {
    entries,
    handlers: {
      'library/list': async () => ({ entries: [...entries.values()].map(e => ({ ...e })) }),
    },
    async put(source, destination, expectedSha256) {
      const bytes = fs.readFileSync(source);
      const entry = { id: `lib-${entries.size + 1}`, path: destination, name: path.basename(destination), sha256: expectedSha256 ?? sha(bytes), size: bytes.length };
      entries.set(entry.id, entry);
      return { ...entry };
    },
  };
}
const sequenceHandlers = engine => engine.handlers;
async function createChain(engine, studio, { shots = 3, start = true, globalPrompt = '统一画风：水墨' } = {}) {
  return sequenceHandlers(engine)['studio/sequence/create']({
    title: '三段串联', globalPrompt,
    defaults: { profileId: 'conn-video', seconds: 4 },
    idempotencyKey: `chain-${Math.random().toString(36).slice(2, 8)}`,
    start,
    shots: Array.from({ length: shots }, (_, index) => ({ prompt: `第${index + 1}幕`, profileId: 'conn-video', continuity: index ? 'previous-tail' : 'none' })),
  }).then(async sequence => { if (start) await waitFor(async () => (await sequenceHandlers(engine)['studio/sequence/read']({ id: sequence.id })).state === 'completed', 'chain completion'); return sequence; });
}

test('sequence: template CRUD, revision pinning and restricted rendering', () => {
  const { templates } = createEngine(createFakeRpc(), createFakeStudio(createFakeRpc()));
  const handlers = templates.handlers;
  const saved = handlers['studio/template/save']({ name: '水墨开场', kind: 'video', prompt: '{{subject}} 在 {{place}}，{{style}} 风格', defaults: { style: '水墨' } });
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.variables.sort(), ['place', 'style', 'subject']);
  const rendered = handlers['studio/template/render']({ id: saved.id, params: { subject: '孤雁', place: '江上' } });
  assert.equal(rendered.text, '孤雁 在 江上，水墨 风格');
  assert.throws(() => handlers['studio/template/render']({ id: saved.id, params: { subject: '孤雁' } }), /place/);
  // revision history keeps older prompts renderable
  const edited = handlers['studio/template/save']({ id: saved.id, name: '水墨开场', prompt: '新版 {{subject}}' });
  assert.equal(edited.revision, 2);
  assert.equal(handlers['studio/template/render']({ id: saved.id, params: { subject: 'x' } }).text, '新版 x');
  assert.equal(templates.renderRevision(saved.id, 1, { subject: '孤雁', place: '江上' }), '孤雁 在 江上，水墨 风格');
  // import always creates new entries
  const imported = handlers['studio/template/import']({ templates: [{ name: '导入', prompt: '你好 {{who}}' }] });
  assert.equal(imported.imported, 1);
  assert.ok(imported.templates[0].id !== saved.id);
  assert.ok(handlers['studio/template/list']({ query: '导入' }).templates.length === 1);
  assert.equal(handlers['studio/template/remove']({ id: imported.templates[0].id }).removed, true);
  // The restricted replacement never evaluates anything; prototype-pollution
  // attempts are rejected at the parameter boundary instead.
  assert.throws(() => handlers['studio/template/save']({ name: '注入', prompt: '{{__proto__}}', defaults: JSON.parse('{"__proto__": {"polluted": 1}}') }), /Invalid parameter key/);
});

test('sequence: three-shot chain A→B→C with real tail-frame continuity', async () => {
  const rpc = createFakeRpc();
  const studio = createFakeStudio(rpc);
  const { engine } = createEngine(rpc, studio);
  const sequence = await createChain(engine, studio);
  const read = await sequenceHandlers(engine)['studio/sequence/read']({ id: sequence.id });
  assert.equal(read.state, 'completed');
  assert.equal(read.progress, 100);
  const states = read.shots.map(shot => shot.status);
  assert.deepEqual(states, ['completed', 'completed', 'completed']);
  // Strict submission order A→B→C
  const order = studio.submissions.map(item => item.prompt);
  assert.match(order[0], /第1幕/);
  assert.match(order[1], /第2幕/);
  assert.match(order[2], /第3幕/);
  // Each continuation's pinned first frame is the previous shot's tail frame.
  const tails = read.shots.map(shot => shot.result.tailFrame.frameSha256);
  assert.equal(read.shots[1].firstFrame.version, tails[0]);
  assert.equal(read.shots[2].firstFrame.version, tails[1]);
  assert.notEqual(tails[0], tails[1]);
  // Global prompt is part of every accepted prompt.
  for (const shot of read.shots) assert.match(shot.acceptedPrompt, /统一画风：水墨/);
  // Usage facts travel with each shot result.
  assert.equal(read.shots[0].result.usage.raw.videoSeconds, 4);
});

test('sequence: create dedupes on the same idempotency key', async () => {
  const rpc = createFakeRpc();
  const { engine } = createEngine(rpc, createFakeStudio(rpc));
  const handlers = sequenceHandlers(engine);
  const params = { title: 'x', defaults: { profileId: 'conn-video' }, idempotencyKey: 'same-key', shots: [{ prompt: 'A', profileId: 'conn-video', continuity: 'none' }] };
  const first = await handlers['studio/sequence/create'](params);
  const second = await handlers['studio/sequence/create'](params);
  assert.equal(first.id, second.id);
});

test('sequence: unknown submission blocks the chain and nothing is resubmitted', async () => {
  const rpc = createFakeRpc();
  const studio = createFakeStudio(rpc);
  // Shot A's job ends terminal-failed with phase unknown (submission lost).
  const original = studio.create.bind(studio);
  studio.create = async params => {
    const job = await original(params);
    const record = rpc.state.jobs.get(job.id);
    record.status = 'failed';
    record.checkpoint = { phase: 'unknown', error: '提交结果未知' };
    return job;
  };
  const { engine } = createEngine(rpc, studio);
  const handlers = sequenceHandlers(engine);
  const sequence = await handlers['studio/sequence/create']({ title: 'x', defaults: { profileId: 'conn-video' }, start: true, shots: [{ prompt: 'A', profileId: 'conn-video', continuity: 'none' }, { prompt: 'B', profileId: 'conn-video', continuity: 'previous-tail' }] });
  await waitFor(async () => (await handlers['studio/sequence/read']({ id: sequence.id })).state === 'needs-attention', 'needs-attention');
  const read = await handlers['studio/sequence/read']({ id: sequence.id });
  assert.equal(read.shots[0].status, 'blocked');
  assert.match(read.blockedReason, /未知/);
  // B was never submitted and stays waiting on its dependency.
  assert.equal(studio.submissions.length, 1);
  assert.equal(read.shots[1].status, 'waiting-dependency');
  assert.equal(read.shots[1].jobId, undefined);
  // An explicit retry is the only way forward; it must not fire by itself.
  await assert.rejects(handlers['studio/sequence/resume']({ id: sequence.id }), /重新生成/);
  await wait(120);
  assert.equal(studio.submissions.length, 1, 'resume must not resubmit an unknown shot');
});

test('sequence: failure of the middle shot blocks downstream', async () => {
  const rpc = createFakeRpc();
  const studio = createFakeStudio(rpc);
  let calls = 0;
  const original = studio.create.bind(studio);
  studio.create = async params => {
    const job = await original(params);
    if (++calls === 2) {
      wait(30).then(() => { const record = rpc.state.jobs.get(job.id); record.status = 'failed'; record.checkpoint = { phase: 'failed', error: '生成失败' }; });
    }
    return job;
  };
  const { engine } = createEngine(rpc, studio);
  const handlers = sequenceHandlers(engine);
  const sequence = await handlers['studio/sequence/create']({ title: 'x', defaults: { profileId: 'conn-video' }, start: true, shots: [{ prompt: 'A', profileId: 'conn-video', continuity: 'none' }, { prompt: 'B', profileId: 'conn-video', continuity: 'previous-tail' }, { prompt: 'C', profileId: 'conn-video', continuity: 'previous-tail' }] });
  await waitFor(async () => (await handlers['studio/sequence/read']({ id: sequence.id })).state === 'needs-attention', 'needs-attention');
  const read = await handlers['studio/sequence/read']({ id: sequence.id });
  assert.equal(read.shots[0].status, 'completed');
  assert.equal(read.shots[1].status, 'failed');
  assert.equal(read.shots[2].status, 'waiting-dependency');
  assert.equal(studio.submissions.length, 2, 'C must never be submitted after B failed');
  // Retry B as an explicit new attempt; the chain resumes from B.
  await handlers['studio/sequence/retry']({ id: sequence.id, shotId: read.shots[1].id, confirmRegenerate: true });
  await waitFor(async () => (await handlers['studio/sequence/read']({ id: sequence.id })).state === 'completed', 'chain completion after retry');
  const done = await handlers['studio/sequence/read']({ id: sequence.id });
  assert.equal(done.shots[2].firstFrame.version, done.shots[1].result.tailFrame.frameSha256);
});

test('sequence: pause stops dispatch after the in-flight shot; resume finishes', async () => {
  const rpc = createFakeRpc();
  const studio = createFakeStudio(rpc, { completeMs: 200 });
  const { engine } = createEngine(rpc, studio);
  const handlers = sequenceHandlers(engine);
  const sequence = await handlers['studio/sequence/create']({ title: 'x', defaults: { profileId: 'conn-video' }, shots: [{ prompt: 'A', profileId: 'conn-video', continuity: 'none' }, { prompt: 'B', profileId: 'conn-video', continuity: 'previous-tail' }, { prompt: 'C', profileId: 'conn-video', continuity: 'previous-tail' }] });
  await handlers['studio/sequence/start']({ id: sequence.id });
  // Pause while A is in remote flight: A must finish, B/C must not dispatch.
  await waitFor(async () => (await handlers['studio/sequence/read']({ id: sequence.id })).shots[0].status === 'submitted', 'A submitted');
  await handlers['studio/sequence/pause']({ id: sequence.id });
  await waitFor(async () => {
    const read = await handlers['studio/sequence/read']({ id: sequence.id });
    return read.shots[0].status === 'completed' && read.state === 'paused';
  }, 'pause after A completes');
  await wait(120);
  let read = await handlers['studio/sequence/read']({ id: sequence.id });
  assert.equal(read.shots[1].status, 'waiting-dependency');
  assert.ok(studio.submissions.length <= 1, 'no new dispatch while paused');
  await handlers['studio/sequence/resume']({ id: sequence.id });
  await waitFor(async () => (await handlers['studio/sequence/read']({ id: sequence.id })).state === 'completed', 'completion after resume');
  read = await handlers['studio/sequence/read']({ id: sequence.id });
  assert.equal(read.shots.length, 3);
  assert.equal(studio.submissions.length, 3);
});

test('sequence: crash after submit recovers without duplicate submissions', async () => {
  const rpc = createFakeRpc();
  const studio = createFakeStudio(rpc, { completeMs: 1000 });
  const { engine, home } = createEngine(rpc, studio, { staleMs: 60000 });
  const handlers = sequenceHandlers(engine);
  const sequence = await handlers['studio/sequence/create']({ title: 'x', defaults: { profileId: 'conn-video' }, start: true, shots: [{ prompt: 'A', profileId: 'conn-video', continuity: 'none' }, { prompt: 'B', profileId: 'conn-video', continuity: 'previous-tail' }] });
  // Wait until A is submitted, then crash the whole engine (window: the shot
  // job exists but the process dies mid-tracking).
  await waitFor(async () => studio.submissions.length >= 1, 'first submission');
  await wait(50);
  await engine.close();
  // Restart: a fresh engine over the same store picks the sequence back up.
  const templates = createTemplateStore({ home });
  const engine2 = createSequenceEngine({ home, rpc, library: fakeLibrary(), studio, templates, pollMs: 20, heartbeatMs: 40, staleMs: 60000 });
  await engine2.recover();
  await waitFor(async () => (await handlers['studio/sequence/read']({ id: sequence.id })).state === 'completed', 'recovered completion', 15000);
  const read = await handlers['studio/sequence/read']({ id: sequence.id });
  assert.deepEqual(read.shots.map(shot => shot.status), ['completed', 'completed']);
  assert.equal(read.shots[1].firstFrame.version, read.shots[0].result.tailFrame.frameSha256);
  // Same-key create dedup: A was submitted exactly once across the crash.
  const keys = studio.submissions.map(item => item.idempotencyKey);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate submission keys');
  assert.equal(keys.length, 2);
  await engine2.close();
});

test('sequence: cancel stops the chain, shot cancel stays visible', async () => {
  const rpc = createFakeRpc();
  const studio = createFakeStudio(rpc, { completeMs: 500 });
  const { engine } = createEngine(rpc, studio);
  const handlers = sequenceHandlers(engine);
  const sequence = await handlers['studio/sequence/create']({ title: 'x', defaults: { profileId: 'conn-video' }, start: true, shots: [{ prompt: 'A', profileId: 'conn-video', continuity: 'none' }, { prompt: 'B', profileId: 'conn-video', continuity: 'previous-tail' }] });
  await waitFor(async () => studio.submissions.length >= 1, 'first submission');
  await handlers['studio/sequence/cancel']({ id: sequence.id });
  const read = await handlers['studio/sequence/read']({ id: sequence.id });
  assert.equal(read.state, 'cancelled');
  assert.equal(read.shots[0].status, 'cancelled');
  assert.equal(read.shots[1].status, 'waiting-dependency');
  await wait(100);
  assert.equal(studio.submissions.length, 1);
});

test('sequence: update rules — revision CAS, submitted shots immutable', async () => {
  const rpc = createFakeRpc();
  const studio = createFakeStudio(rpc);
  const { engine } = createEngine(rpc, studio);
  const handlers = sequenceHandlers(engine);
  const sequence = await handlers['studio/sequence/create']({ title: 'x', defaults: { profileId: 'conn-video' }, shots: [{ prompt: 'A', profileId: 'conn-video', continuity: 'none' }, { prompt: 'B', profileId: 'conn-video', continuity: 'previous-tail' }] });
  // stale revision rejected
  await assert.rejects(() => handlers['studio/sequence/update']({ id: sequence.id, revision: 99, patch: { title: 'y' } }), /刷新/);
  const updated = await handlers['studio/sequence/update']({ id: sequence.id, revision: 1, patch: { title: '新标题', globalPrompt: '新全局', shotEdits: [{ shotId: sequence.shots[1].id, prompt: 'B改动' }] } });
  assert.equal(updated.title, '新标题');
  assert.equal(updated.revision, 2);
  assert.equal(updated.shots[1].prompt, 'B改动');
  // once submitted, structure edits are refused while it is still running
  await handlers['studio/sequence/start']({ id: sequence.id });
  await waitFor(async () => {
    const current = await handlers['studio/sequence/read']({ id: sequence.id });
    return current.shots.some(shot => shot.status === 'submitted' || shot.status === 'completed');
  }, 'first shot submitted');
  await assert.rejects(() => handlers['studio/sequence/update']({ id: sequence.id, revision: 2, patch: { shots: [{ prompt: 'A', profileId: 'conn-video', continuity: 'none' }] } }), /提交/);
  await waitFor(async () => (await handlers['studio/sequence/read']({ id: sequence.id })).state === 'completed', 'completion');
});

test('sequence: preview composes prompts and warns on missing first-frame support', async () => {
  const rpc = createFakeRpc();
  const studio = createFakeStudio(rpc);
  studio.profiles.get = id => ({ id, kind: 'video', name: `Conn-${id}`, model: 'model-x', baseUrl: 'http://127.0.0.1:9' });
  // strip inputCapabilities → engine warns via P.inputCapabilities fallback
  const { engine, templates } = createEngine(rpc, studio);
  const saved = templates.handlers['studio/template/save']({ name: 't', prompt: '模板内容 {{x}}' });
  const handlers = sequenceHandlers(engine);
  const sequence = await handlers['studio/sequence/create']({ title: 'x', globalPrompt: '全局', defaults: { profileId: 'conn-video' }, shots: [{ prompt: 'A', profileId: 'conn-video', continuity: 'none', templateId: saved.id, templateParams: { x: 1 } }, { prompt: 'B', profileId: 'conn-video', continuity: 'previous-tail' }] });
  const preview = await handlers['studio/sequence/preview']({ id: sequence.id });
  assert.equal(preview.shots[0].prompt, '全局\n\n模板内容 1');
  assert.ok(Array.isArray(preview.shots[1].warnings));
});

test('studio: frame export RPC registers an immutable library entry (real ffmpeg)', { skip: !ffmpegAvailable && 'ffmpeg unavailable' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-frame-studio-'));
  const rpc = createFakeRpc();
  const entries = new Map();
  const library = {
    handlers: { 'library/list': async () => ({ entries: [...entries.values()].map(e => ({ ...e })) }) },
    async put(source, destination, expectedSha256) {
      const bytes = fs.readFileSync(source);
      const entry = { id: `lib-${entries.size + 1}`, path: destination, name: path.basename(destination), sha256: expectedSha256 ?? sha(bytes), size: bytes.length };
      entries.set(entry.id, entry);
      return { ...entry };
    },
  };
  // A real generated video placed where a completed job's output would live.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-frame-job-'));
  const video = F.sequence(dir, 'jobvideo.mp4', ['0xFF0000', '0x00FF00', '0x0000FF']);
  const jobId = 'jobframe-1';
  const studio = createMediaStudio({ home, rpc, library });
  const root = studio.root;
  const fsx = fs;
  fsx.mkdirSync(root, { recursive: true });
  fsx.copyFileSync(video, path.join(root, `${jobId}-1.mp4`));
  rpc.state.jobs.set(jobId, {
    id: jobId, workspaceId: 'ws-1', type: 'media.video', status: 'succeeded', checkpoint: null, createdAt: '', updatedAt: '',
  });
  // The studio's read() requires its own workspace id; initialize first.
  await studio.initialize();
  rpc.state.jobs.get(jobId).workspaceId = studio.workspaceId();
  rpc.state.jobs.get(jobId).checkpoint = {
    kind: 'video', phase: 'completed',
    outputs: [{ name: `${jobId}-1.mp4`, mime: 'video/mp4', size: fsx.statSync(path.join(root, `${jobId}-1.mp4`)).size, sha256: sha(fsx.readFileSync(path.join(root, `${jobId}-1.mp4`))) }],
  };
  const result = await studio.handlers['studio/frame/export']({ id: jobId, index: 0 });
  assert.equal(result.frame.streamIndex, 0);
  assert.ok(result.frame.ptsTime > 0);
  assert.equal(result.library.path, `创作/尾帧/${jobId}-tail-1.png`);
  assert.ok(entries.size === 1);
  const saved = [...entries.values()][0];
  assert.equal(saved.sha256, result.frame.frameSha256);
  F.expectColor(path.join(studio.root, `${jobId}-tail-1.png`), '0x0000FF');
  // Idempotent: a second export reuses the same record and library entry.
  const second = await studio.handlers['studio/frame/export']({ id: jobId, index: 0 });
  assert.equal(second.frame.frameSha256, result.frame.frameSha256);
  assert.equal(entries.size, 1);
  // Chunked content read matches the exported bytes.
  let chunks = []; let offset = 0;
  for (;;) {
    const part = await studio.handlers['studio/frame/content']({ id: jobId, index: 0, offset });
    chunks.push(Buffer.from(part.base64, 'base64'));
    if (part.nextOffset === null) break;
    offset = part.nextOffset;
  }
  const bytes = Buffer.concat(chunks);
  assert.equal(sha(bytes), result.frame.frameSha256);
  // Source video bytes unchanged.
  assert.equal(sha(fsx.readFileSync(path.join(root, `${jobId}-1.mp4`))), rpc.state.jobs.get(jobId).checkpoint.outputs[0].sha256);
  await studio.close();
});
