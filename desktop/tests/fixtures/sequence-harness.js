'use strict';

// Shared in-memory harness for sequence/crash-matrix tests: a fake of the
// Rust control contract plus a studio double whose submissions are idempotent
// by key. Fault injection hooks let tests cut the process between any two
// durable steps without sleeping through real provider flows.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSequenceEngine } = require('../../media-sequence');
const { createTemplateStore } = require('../../studio-templates');

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
  const state = { seq: 0, jobs: new Map(), checkpointFaults: [], idempotency: new Map() };
  const terminal = job => ['succeeded', 'failed', 'cancelled'].includes(job.status);
  const rpc = async (method, params = {}) => {
    if (method === 'workspace/create') return { id: 'ws-1', title: params.title };
    if (method === 'job/create') {
      // The Rust control plane replays the cached outcome for a repeated
      // idempotency key; the fake must behave the same way.
      if (params.idempotencyKey) {
        const cached = state.idempotency.get(params.idempotencyKey);
        if (cached) return { ...state.jobs.get(cached), checkpoint: state.jobs.get(cached).checkpoint && structuredClone(state.jobs.get(cached).checkpoint) };
      }
      const id = `job-${++state.seq}`;
      const job = { id, workspaceId: params.workspaceId, type: params.type, status: 'running', checkpoint: null, createdAt: now(), updatedAt: now(), attempt: 1 };
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
      // Faults are consumed only when their predicate matches this write.
      const idx = state.checkpointFaults.findIndex(fault => fault(params));
      if (idx >= 0) { state.checkpointFaults.splice(idx, 1); const e = new Error('injected checkpoint fault'); e.injected = true; throw e; }
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

function fakeLibrary() {
  const entries = new Map();
  return {
    entries,
    handlers: { 'library/list': async () => ({ entries: [...entries.values()].map(e => ({ ...e })) }) },
    async put(source, destination, expectedSha256) {
      const existing = [...entries.values()].find(entry => entry.path === destination && entry.sha256 === expectedSha256);
      if (existing) return { ...existing }; // content+path idempotent registration
      const bytes = fs.readFileSync(source);
      const entry = { id: `lib-${entries.size + 1}`, path: destination, name: path.basename(destination), sha256: expectedSha256 ?? sha(bytes), size: bytes.length };
      entries.set(entry.id, entry);
      return { ...entry };
    },
  };
}

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
    // Unique per harness so concurrent test processes never share the
    // sequence lock directory — job ids like job-1 collide otherwise.
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'ns-fake-studio-root-')),
    initialize: async () => { },
    workspaceId: () => 'ws-1',
    profiles: { get: id => ({ id, kind: 'video', name: `Conn-${id}`, model: 'model-x', baseUrl: 'http://127.0.0.1:9' }), list: () => [] },
    handlers: { 'studio/cancel': async params => rpc('job/cancel', params) },
    async create(params) {
      const existing = submissions.find(item => item.idempotencyKey === params.idempotencyKey);
      if (existing) return { id: existing.jobId, status: 'running' };
      const id = `shotjob-${++seq}`;
      params.jobId = id;
      submissions.push({ ...params, at: new Date().toISOString() });
      rpc.state.jobs.set(id, { id, workspaceId: 'ws-1', type: 'media.video', status: 'running', checkpoint: { kind: 'video', phase: 'queued' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempt: 1 });
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
      return { file: `${jobId}-tail.png`, libraryId: `lib-${frameSha.slice(0, 8)}`, libraryVersion: frameSha, libraryName: `${jobId}-tail.png`, libraryPath: `创作/尾帧/${jobId}-tail.png`, sourceSha256: outputSha ?? '', frameSha256: frameSha, frameSize: 123, ptsTime: 0.28, timeBase: '1/12800', streamIndex: 0, codec: 'h264', rotation: 0, width: 160, height: 90, usedFullScan: false, decoder: 'test', exportedAt: new Date().toISOString() };
    },
  };
}

function createEngine(rpc, studio, options = {}) {
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ns-seq-home-'));
  const templates = createTemplateStore({ home });
  const engine = createSequenceEngine({ home, rpc, library: options.library ?? fakeLibrary(), studio, templates, pollMs: options.pollMs ?? 20, heartbeatMs: 40, staleMs: options.staleMs ?? 120 });
  return { engine, templates, home };
}

const threeShots = (engine, { start = true } = {}) => engine.handlers['studio/sequence/create']({
  title: '三段串联', globalPrompt: '统一画风：水墨',
  defaults: { profileId: 'conn-video', seconds: 4 },
  idempotencyKey: `chain-${Math.random().toString(36).slice(2, 8)}`,
  start,
  shots: [1, 2, 3].map(index => ({ prompt: `第${index}幕`, profileId: 'conn-video', continuity: index > 1 ? 'previous-tail' : 'none' })),
});

module.exports = { createFakeRpc, createFakeStudio, fakeLibrary, createEngine, threeShots, wait, waitFor, sha };
