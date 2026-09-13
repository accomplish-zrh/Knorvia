'use strict';
// P09: idempotent article save. A lost save response must be recoverable by
// retrying with the same idempotency key; a duplicate submit must replay the
// stored result instead of mutating again or failing on revision.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createArticleEngine } = require('../article-video');

function fakeBackend() {
  const jobs = new Map();
  let seq = 0;
  const rpc = async (method, params = {}) => {
    if (method === 'job/read') {
      const job = jobs.get(params.id);
      if (!job) throw Object.assign(new Error('找不到文章视频工程'), { expose: true });
      return job;
    }
    if (method === 'job/checkpoint') {
      const job = jobs.get(params.jobId);
      job.checkpoint = params.checkpoint;
      return job;
    }
    if (method === 'job/create') {
      const id = `job-${++seq}`;
      jobs.set(id, { id, type: 'studio.article', workspaceId: 'ws', checkpoint: null });
      return { id };
    }
    throw new Error(`unexpected rpc ${method}`);
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'article-idem-'));
  const studio = { root: home, workspaceId: () => 'ws', initialize: async () => {} };
  const library = { handlers: {} };
  const engine = createArticleEngine({ studio, rpc, library, playback: {} });
  return { engine, jobs, rpc, home };
}

const project = async ({ engine, jobs, rpc }) => {
  const created = await engine.handlers['studio/article/create']({ title: 'T', article: 'A', audience: '', idempotencyKey: crypto.randomUUID() });
  jobs.get(created.id).checkpoint.revision = 1;
  return created.id;
};

test('save with an idempotency key replays the stored result on duplicate submit', async () => {
  const ctx = fakeBackend();
  const id = await project(ctx);
  const first = await ctx.engine.handlers['studio/article/save']({ id, revision: 1, narration: '第一版', idempotencyKey: 'key-1' });
  assert.equal(first.revision, 2);

  // Same key, even with a stale revision: replay, no second mutation.
  const replay = await ctx.engine.handlers['studio/article/save']({ id, revision: 1, narration: '第一版', idempotencyKey: 'key-1' });
  assert.deepEqual(replay, first);
  assert.equal(ctx.jobs.get(id).checkpoint.revision, 2, 'no extra revision bump');
});

test('save without an idempotency key keeps the strict revision check', async () => {
  const ctx = fakeBackend();
  const id = await project(ctx);
  await ctx.engine.handlers['studio/article/save']({ id, revision: 1, narration: 'v1' });
  await assert.rejects(
    () => ctx.engine.handlers['studio/article/save']({ id, revision: 1, narration: 'stale' }),
    /其他窗口/,
  );
});

test('different keys still mutate; memo is bounded', async () => {
  const ctx = fakeBackend();
  const id = await project(ctx);
  const a = await ctx.engine.handlers['studio/article/save']({ id, revision: 1, narration: 'A', idempotencyKey: 'k-a' });
  const b = await ctx.engine.handlers['studio/article/save']({ id, revision: a.revision, narration: 'B', idempotencyKey: 'k-b' });
  assert.equal(b.revision, a.revision + 1, 'a new key performs a real save');
});
