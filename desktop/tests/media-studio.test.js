'use strict';

// Local behavior tests for the media studio worker. Jobs live in an in-memory
// fake of the Rust control contract; all provider traffic stays on loopback
// fixture servers. No external or paid service is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMediaStudio } = require('../media-studio');

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const MP4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
const PNG_B64 = PNG.toString('base64');
const SHA = 'a'.repeat(64);

function waitFor(predicate, what, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      Promise.resolve().then(predicate).then(value => {
        if (value) return resolve();
        if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
        setTimeout(tick, 20);
      }).catch(reject);
    };
    tick();
  });
}

// Minimal in-memory fake of the Rust control-plane job contract:
// job/create→running, terminal protection on finish/cancel/checkpoint.
function createFakeRpc() {
  const now = () => new Date().toISOString();
  const state = { seq: 0, jobs: new Map(), artifacts: new Map(), calls: [] };
  const notFound = message => { const e = new Error(message); e.rpc = { code: -32004, message }; throw e; };
  const terminal = job => ['succeeded', 'failed', 'cancelled'].includes(job.status);
  const rpc = async (method, params = {}) => {
    state.calls.push({ method, params });
    if (method === 'workspace/create') return { id: 'ws-1', title: params.title };
    if (method === 'job/create') {
      // The Rust control plane dedups by idempotency key; the fake must too.
      if (params.idempotencyKey) {
        const existingId = state.idempotency?.get(params.idempotencyKey);
        if (existingId && state.jobs.has(existingId)) return { ...state.jobs.get(existingId), checkpoint: state.jobs.get(existingId).checkpoint && { ...state.jobs.get(existingId).checkpoint } };
      }
      const id = `job-${++state.seq}`;
      const job = { id, workspaceId: params.workspaceId, type: params.type, status: 'running', attempt: 1, checkpoint: null, createdAt: now(), updatedAt: now() };
      state.jobs.set(id, job);
      (state.idempotency ??= new Map()).set(params.idempotencyKey, id);
      return { ...job };
    }
    if (method === 'job/read') {
      const job = state.jobs.get(params.id);
      if (!job) notFound('Job not found');
      return { ...job, checkpoint: job.checkpoint && { ...job.checkpoint } };
    }
    if (method === 'job/checkpoint') {
      const job = state.jobs.get(params.jobId);
      if (!job) notFound('Job not found');
      if (terminal(job)) notFound('Job already finished');
      job.checkpoint = params.checkpoint;
      job.updatedAt = now();
      return { ...job, checkpoint: { ...job.checkpoint } };
    }
    if (method === 'job/finish') {
      const job = state.jobs.get(params.jobId);
      if (!job) notFound('Job not found');
      if (!terminal(job)) job.status = params.status;
      else if (job.status !== params.status) notFound('Job already finished');
      job.updatedAt = now();
      return { ...job, checkpoint: job.checkpoint && { ...job.checkpoint } };
    }
    if (method === 'job/cancel') {
      const job = state.jobs.get(params.id);
      if (!job) notFound('Job not found');
      if (terminal(job)) notFound('Job already finished');
      job.status = 'cancelled';
      job.updatedAt = now();
      return { ...job, checkpoint: job.checkpoint && { ...job.checkpoint } };
    }
    if (method === 'job/list') {
      const filtered = [...state.jobs.values()].filter(job => job.workspaceId === params.workspaceId && job.type.startsWith(params.typePrefix));
      return { jobs: filtered.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 200)).map(job => ({ ...job })), total: filtered.length };
    }
    if (method === 'artifact/create') {
      const id = `art-${++state.seq}`;
      state.artifacts.set(id, { id, staged: null, committed: false });
      return { id };
    }
    if (method === 'artifact/stage') { state.artifacts.get(params.id).staged = params.content; return {}; }
    if (method === 'artifact/commit') { state.artifacts.get(params.id).committed = true; return {}; }
    throw new Error(`fake rpc: unexpected method ${method}`);
  };
  rpc.state = state;
  return rpc;
}

function createFakeLibrary() {
  const recorded = [];
  const handlers = {
    'library/list': async () => ({ entries: [{ id: 'ref-1', name: 'ref.png', sha256: SHA, trashedAt: null }] }),
    'library/read': async ({ id, version }) => {
      if (id !== 'ref-1') { const e = new Error('找不到这份资料'); e.rpc = { code: -32004, message: '找不到这份资料' }; throw e; }
      assert.ok(version, 'reads must pin an explicit version');
      return { entry: { id, name: 'ref.png', sha256: version }, sha256: version, size: PNG.length, base64: PNG_B64, nextOffset: null };
    },
  };
  return {
    handlers,
    recorded,
    async put(source, destination) {
      recorded.push({ source, destination });
      return { path: destination };
    },
  };
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`enc:${value}`),
    decryptString: value => Buffer.from(value).toString('utf8').slice(4),
  };
}

// Loopback provider fixtures. `gate` holds requests until released so tests
// can observe scheduling and cancellation deterministically.
function createFixture(kind, { holdStatus = false } = {}) {
  const hits = { submit: 0, status: 0, cancel: 0, file: 0 };
  const gates = [];
  const gate = () => new Promise(resolve => gates.push(resolve));
  const releaseAll = () => { while (gates.length) gates.shift()(); };
  const server = http.createServer((req, res) => {
    if (kind === 'openai-image' && req.method === 'POST' && (req.url === '/v1/images/generations' || req.url === '/v1/images/edits')) {
      hits.submit += 1;
      // Drain the request body (multipart edits can be large) before
      // responding, or the socket resets mid-upload.
      req.resume();
      req.on('end', () => gates.length ? gate().then(respond) : respond());
      return;
    }
    if (kind === 'fal-video' && req.method === 'POST' && req.url === '/fal-ai/fixture/video') {
      hits.submit += 1;
      res.end(JSON.stringify({ request_id: 'r1', status: 'IN_PROGRESS', status_url: '/queue/r1', response_url: '/result/r1', cancel_url: '/queue/r1/cancel' }));
      return;
    }
    if (kind === 'fal-video' && req.method === 'PUT' && req.url === '/queue/r1/cancel') {
      hits.cancel += 1;
      res.writeHead(200); res.end();
      return;
    }
    if (kind === 'fal-video' && req.url === '/queue/r1') {
      hits.status += 1;
      if (holdStatus) gate().then(() => res.end(JSON.stringify({ status: 'COMPLETED' })));
      else res.end(JSON.stringify({ status: 'COMPLETED' }));
      return;
    }
    if (kind === 'fal-video' && req.url === '/result/r1') {
      res.end(JSON.stringify({ video: { url: `http://127.0.0.1:${server.address().port}/file.mp4` } }));
      return;
    }
    if (req.url === '/file.mp4') {
      hits.file += 1;
      res.setHeader('content-type', 'video/mp4');
      res.end(MP4);
      return;
    }
    if (req.url === '/file.png') {
      hits.file += 1;
      res.setHeader('content-type', 'image/png');
      res.end(PNG);
      return;
    }
    res.writeHead(404); res.end();
    function respond() {
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
    }
  });
  const originP = new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  return {
    hits, gates, gate, releaseAll,
    async origin() { return originP; },
    close() { server.close(); server.closeAllConnections(); },
  };
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-media-studio-'));
}

test('an expired video output is renewed by reading the accepted job, never regenerated', async t => {
  let submissions = 0, queries = 0; const server = http.createServer((req, res) => {
    if (req.url === '/models/acme/video/predictions') { submissions++; res.end(JSON.stringify({ id: 'accepted', status: 'starting' })); }
    else if (req.url === '/predictions/accepted') { queries++; res.end(JSON.stringify({ id: 'accepted', status: 'succeeded', output: [`http://127.0.0.1:${server.address().port}/${queries === 1 ? 'expired' : 'valid'}`] })); }
    else if (req.url === '/expired') { res.writeHead(403); res.end(); }
    else { res.setHeader('content-type', 'video/mp4'); res.end(MP4); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const rpc = createFakeRpc(), studio = createMediaStudio({ home: tempHome(), rpc, library: createFakeLibrary(), pollMs: 5 }); t.after(() => studio.close());
  studio.profiles.save({ id: 'rep-video', name: 'Replicate', kind: 'video', protocol: 'replicate', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'acme/video' });
  const job = await studio.create({ profileId: 'rep-video', prompt: 'a video', idempotencyKey: 'expired-once' });
  await waitFor(async () => (await studio.handlers['studio/read']({ id: job.id })).phase === 'paused', 'expired URL pause');
  await studio.handlers['studio/resume']({ id: job.id });
  await waitFor(async () => (await studio.handlers['studio/read']({ id: job.id })).status === 'succeeded', 'renewed output');
  assert.equal(submissions, 1); assert.equal(queries, 2);
});

async function makeStudio(home, fixture, overrides = {}) {
  const rpc = createFakeRpc();
  const library = createFakeLibrary();
  const origin = await fixture.origin();
  const profiles = [{ id: 'p-image', name: 'fixture image', kind: 'image', protocol: 'openai', baseUrl: `${origin}/v1`, model: 'fixture-model', apiKey: 'fixture-key', agentEnabled: true, extra: {}, custom: {} }];
  const studio = createMediaStudio({ home, rpc, library, safeStorage: fakeSafeStorage(), pollMs: 40, ...overrides });
  studio.profiles.save(profiles[0]);
  await studio.initialize();
  return { rpc, library, studio, origin };
}

test('an openai image job runs to a committed artifact with sanitized public state', async () => {
  const home = tempHome();
  const fixture = createFixture('openai-image');
  const { rpc, studio } = await makeStudio(home, fixture);
  try {
    const job = await studio.create({ profileId: 'p-image', prompt: 'a red cube', size: '64x64', idempotencyKey: 'tok-image-1' });
    await waitFor(() => rpc('job/read', { id: job.id }).then(j => j.status === 'succeeded'), 'job success');
    const stored = rpc.state.jobs.get(job.id);
    assert.equal(stored.checkpoint.phase, 'completed');
    assert.equal(stored.checkpoint.progress, 100);
    assert.ok(stored.checkpoint.artifactId);
    const artifact = rpc.state.artifacts.get(stored.checkpoint.artifactId);
    assert.equal(artifact.committed, true);
    const staged = JSON.parse(artifact.staged);
    assert.equal(staged.studioJobId, job.id);
    assert.equal(staged.outputs.length, 1);
    // Provenance travels with the artifact and never includes secrets.
    assert.equal(staged.source.prompt, 'a red cube');
    assert.equal(staged.source.provider.model, 'fixture-model');
    assert.equal(staged.source.input.size, '64x64');
    assert.equal(JSON.stringify(staged).includes('fixture-key'), false);
    const outputFile = path.join(home, 'artifacts', 'media-studio', staged.outputs[0].name);
    assert.equal(fs.existsSync(outputFile), true);
    assert.equal(fs.existsSync(path.join(home, 'artifacts', 'media-studio', `${job.id}-response.json`)), false, 'provider response file is deleted after publish');
    const publicJob = await studio.handlers['studio/read']({ id: job.id });
    assert.equal(JSON.stringify(publicJob).includes('fixture-key'), false, 'API key must never appear in public job state');
    assert.equal(JSON.stringify(publicJob).includes(PNG_B64), false, 'media bytes must never appear in job state');
    // Same idempotency key returns the same durable job without a resubmission.
    const again = await studio.create({ profileId: 'p-image', prompt: 'a red cube', size: '64x64', idempotencyKey: 'tok-image-1' });
    assert.equal(again.id, job.id);
    assert.equal(fixture.hits.submit, 1);
  } finally { fixture.close(); await studio.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('references are pinned to a library version before the first submission', async () => {
  const home = tempHome();
  const fixture = createFixture('openai-image');
  const { rpc, studio } = await makeStudio(home, fixture);
  try {
    const job = await studio.create({ profileId: 'p-image', prompt: 'edit this', size: '64x64', idempotencyKey: 'tok-ref-1', references: [{ id: 'ref-1' }] });
    await waitFor(() => rpc('job/read', { id: job.id }).then(j => j.status === 'succeeded'), 'job success');
    const pinned = rpc.state.jobs.get(job.id).checkpoint.input.references;
    assert.deepEqual(pinned, [{ id: 'ref-1', version: SHA, name: 'ref.png' }]);
  } finally { fixture.close(); await studio.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('a submission lost mid-flight is reported as an unknown outcome and never retried silently', async () => {
  const home = tempHome();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => req.socket.destroy());
  });
  const origin = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  const fixture = { async origin() { return origin; }, close() { server.close(); server.closeAllConnections(); }, hits: {} };
  const { rpc, studio } = await makeStudio(home, fixture);
  try {
    const job = await studio.create({ profileId: 'p-image', prompt: 'p', size: '64x64', idempotencyKey: 'tok-uncertain-1' });
    await waitFor(async () => (await rpc('job/read', { id: job.id })).status === 'failed', 'job failed');
    const checkpoint = rpc.state.jobs.get(job.id).checkpoint;
    assert.equal(checkpoint.phase, 'unknown');
    assert.match(checkpoint.error, /unknown/i);
    assert.equal(checkpoint.recoverable, false);
    // The terminal job refuses a resume that would resubmit the same request.
    await assert.rejects(() => studio.handlers['studio/resume']({ id: job.id }), /Create a new job/);
  } finally { fixture.close(); await studio.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('a deleted connection pauses the job as needs-connection, then resumes after restore', async () => {
  const home = tempHome();
  const fixture = createFixture('openai-image');
  const { rpc, studio } = await makeStudio(home, fixture);
  try {
    const injected = await rpc('job/create', { workspaceId: 'ws-1', type: 'media.image', idempotencyKey: 'inject-conn-1' });
    await rpc('job/checkpoint', {
      jobId: injected.id,
      checkpoint: { kind: 'image', profileId: 'p-image', provider: { id: 'p-image', name: 'fixture image', kind: 'image', protocol: 'openai', baseUrl: (await fixture.origin()) + '/v1', model: 'fixture-model', authHeader: 'Authorization', authPrefix: 'Bearer', agentEnabled: true, extra: {}, custom: {} }, hadKey: true, input: { prompt: 'p', size: '64x64', aspect: '16:9', count: 1, seconds: 4, quality: 'auto', references: [] }, fingerprint: 'f', phase: 'queued', outputs: [], source: 'studio' },
    });
    studio.profiles.remove('p-image');
    await studio.handlers['studio/resume']({ id: injected.id });
    await waitFor(async () => (await rpc('job/read', { id: injected.id })).checkpoint.phase === 'needs-connection', 'needs-connection phase');
    assert.equal((await rpc('job/read', { id: injected.id })).status, 'running', 'connection loss must not fail the durable job');
    studio.profiles.save({ id: 'p-image', name: 'fixture image', kind: 'image', protocol: 'openai', baseUrl: `${await fixture.origin()}/v1`, model: 'fixture-model', apiKey: 'fixture-key', agentEnabled: true, extra: {}, custom: {} });
    await studio.handlers['studio/resume']({ id: injected.id });
    await waitFor(async () => (await rpc('job/read', { id: injected.id })).status === 'succeeded', 'job success after restore');
    assert.equal(rpc.state.jobs.get(injected.id).checkpoint.phase, 'completed');
  } finally { fixture.close(); await studio.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('a crash after the provider response reached disk resumes from that file without resubmitting', async () => {
  const home = tempHome();
  const fixture = createFixture('openai-image');
  const { rpc, studio } = await makeStudio(home, fixture);
  try {
    const injected = await rpc('job/create', { workspaceId: 'ws-1', type: 'media.image', idempotencyKey: 'inject-recover-1' });
    await rpc('job/checkpoint', {
      jobId: injected.id,
      checkpoint: { kind: 'image', profileId: 'p-image', provider: { id: 'p-image', name: 'n', kind: 'image', protocol: 'openai', baseUrl: `${await fixture.origin()}/v1`, model: 'fixture-model', authHeader: 'Authorization', authPrefix: 'Bearer', agentEnabled: true, extra: {}, custom: {} }, hadKey: true, input: { prompt: 'p', size: '64x64', aspect: '16:9', count: 1, seconds: 4, quality: 'auto', references: [] }, fingerprint: 'f', phase: 'generating', remote: { id: 'remote-1' }, outputs: [], source: 'studio' },
    });
    // Simulate the crash window: response bytes are already on disk but the
    // checkpoint never recorded them.
    fs.writeFileSync(path.join(home, 'artifacts', 'media-studio', `${injected.id}-response.json`), JSON.stringify([{ url: '/file.png' }]));
    await studio.handlers['studio/resume']({ id: injected.id });
    await waitFor(async () => (await rpc('job/read', { id: injected.id })).status === 'succeeded', 'job success');
    assert.equal(fixture.hits.submit, 0, 'recovery must not resubmit the provider request');
    assert.equal(fixture.hits.file, 1, 'outputs are downloaded from the saved response');
  } finally { fixture.close(); await studio.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('cancelling a queued fal video stops the worker and records honest remote state', async () => {
  const home = tempHome();
  const fixture = createFixture('fal-video', { holdStatus: true });
  const { rpc, studio } = await makeStudio(home, fixture);
  try {
    studio.profiles.save({ id: 'p-video', name: 'fixture video', kind: 'video', protocol: 'fal', baseUrl: await fixture.origin(), model: 'fal-ai/fixture/video', apiKey: 'fixture-key', agentEnabled: true, extra: {}, custom: {} });
    const job = await studio.create({ profileId: 'p-video', prompt: 'wave', size: '1280x720', idempotencyKey: 'tok-cancel-1' });
    await waitFor(async () => (await rpc('job/read', { id: job.id })).checkpoint.remote?.id === 'r1', 'remote id checkpointed');
    const cancelled = await studio.handlers['studio/cancel']({ id: job.id });
    assert.equal(cancelled.status, 'cancelled');
    const checkpoint = rpc.state.jobs.get(job.id).checkpoint;
    assert.equal(checkpoint.phase, 'stopped');
    assert.equal(checkpoint.remoteCancelRequested, true, 'the provider was asked to cancel');
    assert.equal(checkpoint.remoteMayContinue, true, 'the provider may still continue and charge');
    assert.equal(fixture.hits.cancel, 1);
    await assert.rejects(() => studio.handlers['studio/resume']({ id: job.id }), /Create a new job/);
  } finally { fixture.close(); await studio.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('one bounded worker slot keeps a slow submission from occupying every job', async () => {
  const home = tempHome();
  const fixture = createFixture('openai-image');
  const { rpc, studio } = await makeStudio(home, fixture, { maxActiveJobs: 1 });
  try {
    fixture.gate();
    const first = await studio.create({ profileId: 'p-image', prompt: 'first', size: '64x64', idempotencyKey: 'tok-q-1' });
    const second = await studio.create({ profileId: 'p-image', prompt: 'second', size: '64x64', idempotencyKey: 'tok-q-2' });
    await waitFor(() => fixture.hits.submit === 1, 'first submission');
    assert.equal(rpc.state.jobs.get(second.id).checkpoint.phase, 'queued', 'the second job waits while the slot is occupied');
    fixture.releaseAll();
    await waitFor(async () => (await rpc('job/read', { id: first.id })).status === 'succeeded', 'first success');
    await waitFor(() => fixture.hits.submit === 2, 'second submission starts only after the slot frees');
    await waitFor(async () => (await rpc('job/read', { id: second.id })).status === 'succeeded', 'second success');
  } finally { fixture.close(); await studio.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('generated outputs stream from studio/content and land in the library with a safe path', async () => {
  const home = tempHome();
  const fixture = createFixture('openai-image');
  const { rpc, library, studio } = await makeStudio(home, fixture);
  try {
    const job = await studio.create({ profileId: 'p-image', prompt: 'save me', size: '64x64', idempotencyKey: 'tok-save-1' });
    await waitFor(async () => (await rpc('job/read', { id: job.id })).status === 'succeeded', 'job success');
    const publicJob = await studio.handlers['studio/read']({ id: job.id });
    const chunk = await studio.handlers['studio/content']({ id: job.id });
    assert.equal(chunk.nextOffset, null);
    assert.equal(Buffer.from(chunk.base64, 'base64').subarray(0, 8).equals(PNG.subarray(0, 8)), true);
    assert.equal(publicJob.outputs[0].size, chunk.size);
    await studio.handlers['studio/library']({ id: job.id });
    assert.equal(library.recorded.length, 1);
    const { source, destination } = library.recorded[0];
    assert.equal(fs.existsSync(source), true);
    assert.equal(destination, `创作/${path.basename(source)}`);
    assert.match(destination, /^创作\/[A-Za-z0-9_-]+\.(png|jpg|webp|gif|mp4|webm)$/);
  } finally { fixture.close(); await studio.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('a fal video job queues, polls and publishes with honest progress', async () => {
  const home = tempHome();
  const fixture = createFixture('fal-video');
  const { rpc, studio } = await makeStudio(home, fixture);
  try {
    studio.profiles.save({ id: 'p-video', name: 'fixture video', kind: 'video', protocol: 'fal', baseUrl: await fixture.origin(), model: 'fal-ai/fixture/video', apiKey: 'fixture-key', agentEnabled: true, extra: {}, custom: {} });
    const job = await studio.create({ profileId: 'p-video', prompt: 'wave', size: '1280x720', aspect: '16:9', idempotencyKey: 'tok-fal-1' });
    await waitFor(async () => (await rpc('job/read', { id: job.id })).status === 'succeeded', 'job success');
    const checkpoint = rpc.state.jobs.get(job.id).checkpoint;
    assert.equal(checkpoint.phase, 'completed');
    assert.equal(checkpoint.remote.id, 'r1');
    assert.equal(checkpoint.outputs[0].mime, 'video/mp4');
    assert.equal(fixture.hits.status >= 1, true);
  } finally { fixture.close(); await studio.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('a silent provider still records a known:false usage attempt, never zeros', async () => {
  const home = tempHome();
  const fixture = createFixture('fal-video');
  const { rpc, studio } = await makeStudio(home, fixture);
  try {
    studio.profiles.save({ id: 'p-video', name: 'fixture video', kind: 'video', protocol: 'fal', baseUrl: await fixture.origin(), model: 'fal-ai/fixture/video', apiKey: 'fixture-key', agentEnabled: true, extra: {}, custom: {} });
    const job = await studio.create({ profileId: 'p-video', prompt: 'wave', size: '1280x720', aspect: '16:9', idempotencyKey: 'tok-usage-1' });
    await waitFor(async () => (await rpc('job/read', { id: job.id })).status === 'succeeded', 'job success');
    const usage = rpc.state.jobs.get(job.id).checkpoint.usage;
    assert.ok(usage, 'usage record must persist even when the provider is silent');
    assert.equal(usage.providerId, 'p-video');
    assert.equal(usage.protocol, 'fal-queue');
    assert.equal(usage.model, 'fal-ai/fixture/video');
    assert.equal(usage.attempts.length, 1);
    assert.equal(usage.attempts[0].known, false);
    assert.deepEqual(usage.attempts[0].units, []);
    assert.ok(usage.attempts[0].at);
  } finally { fixture.close(); await studio.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('provider failures land in honest non-recoverable states without bogus outputs', async () => {
  const cases = [
    { name: 'http failure', respond: () => { return { status: 500, body: 'boom' }; }, phase: 'failed', error: /HTTP 500/ },
    { name: 'empty outputs', respond: () => ({ status: 200, body: { data: [] } }), phase: 'failed', error: /without media outputs/ },
    { name: 'wrong media type', respond: () => ({ status: 200, body: { data: [{ b64_json: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]).toString('base64') }] } }), phase: 'failed', error: /wrong media type/ },
  ];
  for (const item of cases) {
    const home = tempHome();
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const outcome = item.respond();
        res.writeHead(outcome.status, { 'content-type': 'application/json' });
        res.end(typeof outcome.body === 'string' ? outcome.body : JSON.stringify(outcome.body));
      });
    });
    const origin = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
    const fixture = { async origin() { return origin; }, close() { server.close(); server.closeAllConnections(); }, hits: {} };
    const { rpc, studio } = await makeStudio(home, fixture);
    try {
      const job = await studio.create({ profileId: 'p-image', prompt: 'fault matrix', size: '64x64', idempotencyKey: `tok-fault-${item.name.replace(/ /g, '-')}` });
      await waitFor(async () => (await rpc('job/read', { id: job.id })).status === 'failed', `${item.name} failure`);
      const checkpoint = rpc.state.jobs.get(job.id).checkpoint;
      assert.equal(checkpoint.phase, item.phase, item.name);
      assert.match(checkpoint.error, item.error);
      assert.equal(checkpoint.outputs.length, 0, `${item.name} must not publish outputs`);
    } finally { fixture.close(); await studio.close(); fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test('agent submissions require the connection to opt in', async () => {
  const home = tempHome();
  const fixture = createFixture('openai-image');
  const { studio } = await makeStudio(home, fixture);
  try {
    studio.profiles.save({ id: 'p-noagent', name: 'private', kind: 'image', protocol: 'openai', baseUrl: `${await fixture.origin()}/v1`, model: 'fixture-model', apiKey: 'fixture-key', agentEnabled: false, extra: {}, custom: {} });
    await assert.rejects(
      () => studio.create({ profileId: 'p-noagent', prompt: 'p', idempotencyKey: 'tok-agent-1' }, true),
      /Agent access is disabled/,
    );
  } finally { fixture.close(); await studio.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('first and last frames are pinned separately and conflicting simultaneous retries cannot swap them', async () => {
  const home = tempHome(), fixture = createFixture('fal-video');
  const { rpc, studio, library, origin } = await makeStudio(home, fixture);
  const reads = [], secondSha = 'b'.repeat(64);
  const entries = [{ id: 'start', name: 'start.png', sha256: SHA }, { id: 'end', name: 'end.png', sha256: secondSha }];
  library.handlers['library/list'] = async () => ({ entries });
  library.handlers['library/read'] = async ({ id, version }) => { reads.push({ id, version }); return { entry: entries.find(e => e.id === id), size: PNG.length, base64: PNG_B64, nextOffset: null }; };
  studio.profiles.save({ id: 'v', name: 'frames', kind: 'video', protocol: 'fal', baseUrl: origin, model: 'fal-ai/fixture/video', agentEnabled: true, custom: { firstFrameField: 'start_image_url', lastFrameField: 'end_image_url' } });
  const params = { profileId: 'v', prompt: 'transition', firstFrame: { id: 'start' }, lastFrame: { id: 'end' }, idempotencyKey: 'frame-pair' };
  try {
    const first = studio.create(params);
    const changed = studio.create({ ...params, firstFrame: { id: 'end' }, lastFrame: { id: 'start' } });
    await assert.rejects(changed, /different inputs/);
    const job = await first;
    entries[0].sha256 = 'c'.repeat(64); entries[1].sha256 = 'd'.repeat(64);
    await waitFor(async () => (await rpc('job/read', { id: job.id })).status === 'succeeded', 'framed video');
    assert.deepEqual(reads, [{ id: 'start', version: SHA }, { id: 'end', version: secondSha }]);
    const c = rpc.state.jobs.get(job.id).checkpoint;
    assert.equal(c.input.firstFrame.version, SHA); assert.equal(c.input.lastFrame.version, secondSha);
    const source = JSON.parse(rpc.state.artifacts.get(c.artifactId).staged).source;
    assert.equal(source.firstFrame.id, 'start'); assert.equal(source.lastFrame.id, 'end');
    assert.equal(fixture.hits.submit, 1);
    assert.equal((await studio.create(params)).id, job.id);
  } finally { await studio.close(); fixture.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('legacy video reference becomes firstFrame while unsupported tail and ambiguous inputs create no job', async () => {
  const home = tempHome(), fixture = createFixture('fal-video');
  const { rpc, studio, origin } = await makeStudio(home, fixture);
  studio.profiles.save({ id: 'v', name: 'legacy', kind: 'video', protocol: 'fal', baseUrl: origin, model: 'fal-ai/fixture/video', agentEnabled: true });
  try {
    for (const params of [{ lastFrame: { id: 'ref-1' }, firstFrame: { id: 'ref-1' } }, { references: [{ id: 'ref-1' }], firstFrame: { id: 'ref-1' } }]) {
      await assert.rejects(() => studio.create({ profileId: 'v', prompt: 'p', ...params }));
    }
    assert.equal(rpc.state.jobs.size, 0); assert.equal(fixture.hits.submit, 0);
    const job = await studio.create({ profileId: 'v', prompt: 'p', references: [{ id: 'ref-1' }] });
    assert.equal(job.input.firstFrame.id, 'ref-1'); assert.deepEqual(job.input.references, []);
    await waitFor(async () => (await rpc('job/read', { id: job.id })).status === 'succeeded', 'legacy frame');
  } finally { await studio.close(); fixture.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
