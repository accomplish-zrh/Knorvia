'use strict';

// C20 activity contract: studio.pendingActivityCount is the merged,
// non-negative count of outstanding managed media work — this scheduler's
// running/waiting/accepting jobs plus the derived-operation registry
// (frame exports). Terminal transitions decrement it; close reports zero;
// finished history never counts. Verified against a gated real-provider
// fixture and a gated frame export.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FW = require('../media-frame-worker');
const { createMediaStudio } = require('../media-studio');

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const PNG_B64 = PNG.toString('base64');
const SHA = 'a'.repeat(64);
const fakeSafeStorage = () => ({ isEncryptionAvailable: () => true, encryptString: v => Buffer.from(`enc:${v}`), decryptString: b => b.toString().slice(4) });
const waitFor = async (predicate, what, timeoutMs = 8000) => {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

function makeStudio(home) {
  const jobs = new Map();
  const artifacts = new Map();
  const now = () => new Date().toISOString();
  const finished = job => ['succeeded', 'failed', 'cancelled'].includes(job.status);
  const rpc = async (method, params = {}) => {
    if (method === 'workspace/create') return { id: 'ws-activity' };
    if (method === 'job/list') return { jobs: [], total: 0 };
    if (method === 'job/create') {
      const job = { id: params.idempotencyKey, workspaceId: params.workspaceId, type: params.type, status: 'running', createdAt: now(), updatedAt: now(), checkpoint: undefined };
      jobs.set(job.id, job);
      return { ...job };
    }
    if (method === 'job/read') {
      const job = jobs.get(params.id);
      if (!job) { const e = new Error('Job not found'); e.rpc = { code: -32004, message: 'Job not found' }; throw e; }
      return { ...job, checkpoint: job.checkpoint && { ...job.checkpoint } };
    }
    if (method === 'job/checkpoint') {
      const job = jobs.get(params.jobId);
      if (!job) { const e = new Error('Job not found'); e.rpc = { code: -32004, message: 'Job not found' }; throw e; }
      job.checkpoint = params.checkpoint;
      job.updatedAt = now();
      return { ...job, checkpoint: { ...job.checkpoint } };
    }
    if (method === 'job/cancel') {
      const job = jobs.get(params.id);
      if (!finished(job)) job.status = 'cancelled';
      return { ...job };
    }
    if (method === 'job/finish') {
      const job = jobs.get(params.jobId);
      if (!finished(job)) job.status = params.status;
      return { ...job };
    }
    if (method === 'artifact/create') { artifacts.set(params.idempotencyKey, { id: `art-${artifacts.size + 1}`, staged: null, committed: false }); return artifacts.get(params.idempotencyKey); }
    if (method === 'artifact/stage') { artifacts.get(params.id)?.staged !== undefined && (artifacts.get(params.id).staged = params.content); return {}; }
    if (method === 'artifact/commit') { const a = artifacts.get(params.id); if (a) a.committed = true; return {}; }
    throw new Error(`fake rpc: unexpected method ${method}`);
  };
  const libraryPuts = [];
  const library = {
    handlers: {
      'library/list': async () => ({ entries: libraryPuts.map((p, i) => ({ id: `lib-${i + 1}`, name: path.basename(p.destination), path: p.destination, sha256: p.sha256, trashedAt: null })) }),
      'library/read': async () => { throw new Error('unused'); },
    },
    async put(source, destination) {
      const record = { source, destination, sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(source)).digest('hex') };
      libraryPuts.push(record);
      return { id: `lib-${libraryPuts.length}`, name: path.basename(destination), path: destination, sha256: record.sha256 };
    },
  };
  const studio = createMediaStudio({ home, rpc, library, safeStorage: fakeSafeStorage(), pollMs: 5 });
  return { studio, jobs, libraryPuts, artifacts };
}

async function imageStudio(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-activity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Gated provider: submissions queue on a release promise until allowed.
  const gates = [];
  const releaseAll = () => { while (gates.length) gates.shift()(); };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const answer = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNG_B64 }] })); };
      if (req.url.includes('generations')) gates.push(answer); else answer();
    });
  });
  const origin = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(async () => { releaseAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const { studio } = makeStudio(home);
  t.after(() => studio.close());
  await studio.initialize();
  studio.profiles.save({ id: 'p-image', name: 'fixture image', kind: 'image', protocol: 'openai', baseUrl: `${origin}/v1`, model: 'fixture-model', apiKey: 'fixture-key', agentEnabled: true });
  return { studio, releaseAll, gates };
}

const notFinished = jobs => Promise.all(jobs.map(job => waitFor(async () => (job.checkpoint ? job : null) === null ? false : true, 'x', 1).catch(() => {})));

test('generation activity counts running jobs and returns to zero after completion', async t => {
  const { studio, releaseAll, gates } = await imageStudio(t);
  const jobA = await studio.create({ profileId: 'p-image', prompt: 'first', size: '64x64', idempotencyKey: 'act-1' });
  await waitFor(async () => gates.length > 0, 'first submission to reach the provider');
  const count = () => studio.pendingActivityCount;
  assert.ok(Number.isFinite(count()) && count() > 0, 'a running generation keeps the activity count above zero');
  // A second generation starts; finishing the first must not zero the count.
  const jobB = await studio.create({ profileId: 'p-image', prompt: 'second', size: '64x64', idempotencyKey: 'act-2' });
  await waitFor(async () => count() >= 2, 'both generations counted');
  await waitFor(async () => gates.length >= 2, 'both submissions reached the provider');
  releaseAll();
  try {
    await waitFor(async () => (await Promise.all([studio.readJob(jobA.id), studio.readJob(jobB.id)])).every(j => j.status === 'succeeded'), 'both jobs succeed');
  } catch (error) {
    for (const job of [jobA, jobB]) {
      const j = await studio.readJob(job.id);
      console.log('DBG', j.id, j.status, j.phase, j.error || '');
    }
    throw error;
  }
  assert.equal(count(), 0, 'the count truly returns to zero after all terminal transitions');
});

test('cancelling a gated submission returns the count to zero', async t => {
  const { studio, releaseAll, gates } = await imageStudio(t);
  const job = await studio.create({ profileId: 'p-image', prompt: 'cancel me', size: '64x64', idempotencyKey: 'act-cancel' });
  await waitFor(async () => gates.length > 0, 'submission reached the provider');
  assert.ok(studio.pendingActivityCount > 0);
  await studio.handlers['studio/cancel']({ id: job.id });
  releaseAll();
  assert.equal(studio.pendingActivityCount, 0, 'a cancelled job no longer counts as activity');
});

test('close reports zero even with work still gated', async t => {
  const { studio, releaseAll, gates } = await imageStudio(t);
  void gates;
  const job = await studio.create({ profileId: 'p-image', prompt: 'shutdown case', size: '64x64', idempotencyKey: 'act-close' });
  await waitFor(async () => studio.pendingActivityCount > 0, 'job counted while running');
  await studio.close();
  releaseAll();
  assert.equal(studio.pendingActivityCount, 0, 'closing the service releases the activity signal');
  void job;
});

test('a running frame export counts through the operations registry and cancels to zero', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-activity-frame-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { studio, libraryPuts } = await (async () => {
    const videoJobId = 'job-frame-1';
    const name = `${videoJobId}-1.mp4`;
    const root = path.join(home, 'artifacts', 'media-studio');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, name), PNG);
    const output = { name, mime: 'video/mp4', size: fs.statSync(path.join(root, name)).size, sha256: SHA };
    const job = { id: videoJobId, workspaceId: 'ws-activity', type: 'media.video', status: 'succeeded', createdAt: now(), updatedAt: now(), checkpoint: { kind: 'video', outputs: [output] } };
    const rpc = async (method, params = {}) => {
      if (method === 'workspace/create') return { id: 'ws-activity' };
      if (method === 'job/list') return { jobs: [], total: 0 };
      if (method === 'job/read') {
        if (params.id !== videoJobId) { const e = new Error('Job not found'); e.rpc = { code: -32004, message: 'Job not found' }; throw e; }
        return job;
      }
      throw new Error(`fake rpc: unexpected method ${method}`);
    };
    const libraryPuts = [];
    const library = {
      handlers: { 'library/list': async () => ({ entries: [] }), 'library/read': async () => { throw new Error('unused'); } },
      async put(source, destination) { libraryPuts.push({ source, destination }); return { id: 'lib-1', name: 'x', path: destination, sha256: '0'.repeat(64) }; },
    };
    return { studio: createMediaStudio({ home, rpc, library, safeStorage: fakeSafeStorage(), pollMs: 5 }), libraryPuts };
  })();
  t.after(() => studio.close());
  await studio.initialize();
  const realCreate = FW.createFrameWorker;
  let exports = 0;
  FW.createFrameWorker = () => ({
    binaries: realCreate({}).binaries,
    decoderVersion: async () => 'fixture-decoder',
    exportTailFrame: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { exports += 1; reject(Object.assign(new Error('帧导出已取消'), { rpc: { code: -32602, message: '帧导出已取消', reason: 'cancelled' } })); }, { once: true });
    }),
  });
  try {
    const exportPromise = studio.handlers['studio/frame/export']({ id: 'job-frame-1' });
    await waitFor(async () => studio.pendingActivityCount > 0, 'frame export counted while running');
    await studio.handlers['studio/frame/cancel']({ id: 'job-frame-1' });
    await assert.rejects(exportPromise, () => true);
    assert.equal(studio.pendingActivityCount, 0, 'the cancelled frame export no longer counts');
    assert.equal(exports, 1, 'the owned decode was told to terminate');
    assert.equal(libraryPuts.length, 0, 'a cancelled export publishes nothing');
  } finally { FW.createFrameWorker = realCreate; }
});
function now() { return new Date().toISOString(); }
