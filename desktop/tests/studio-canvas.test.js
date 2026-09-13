'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPersonalLibrary } = require('../personal-library');
const { createCanvasEngine, validateGraph, CANVAS_DIR, CANVAS_EXT } = require('../studio-canvas');
const { createMediaStudio } = require('../media-studio');

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);

function setupTestEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-canvas-test-'));
  const library = createPersonalLibrary({ home });

  const profilesMap = new Map([
    ['p-image', { id: 'p-image', name: 'OpenAI Image', kind: 'image', protocol: 'openai', model: 'gpt-image', agentEnabled: true, custom: {} }],
    ['p-image-disabled', { id: 'p-image-disabled', name: 'Disabled Image', kind: 'image', protocol: 'openai', model: 'gpt-image', agentEnabled: false, custom: {} }],
    ['p-video', { id: 'p-video', name: 'Video Gen', kind: 'video', protocol: 'fal', model: 'fal-ai/fixture/video', agentEnabled: true, custom: { firstFrameField: 'start_image_url', lastFrameField: 'end_image_url' } }],
    ['p-video-disabled', { id: 'p-video-disabled', name: 'Disabled Video', kind: 'video', protocol: 'fal', model: 'fal-ai/fixture/video', agentEnabled: false, custom: {} }],
  ]);

  const jobs = new Map();
  let jobSeq = 0;
  const createdJobs = [];

  const studio = {
    root: path.join(home, 'artifacts', 'media-studio'),
    profiles: {
      get: (id) => {
        const p = profilesMap.get(id);
        if (!p) {
          const err = new Error('Model connection not found');
          err.rpc = { code: -32602, message: 'Model connection not found' };
          throw err;
        }
        return p;
      },
    },
    create: async (params, agent = false) => {
      createdJobs.push({ ...params, agentRequested: agent, source: agent ? 'agent' : 'studio' });
      const id = `job-${++jobSeq}`;
      const job = {
        id,
        status: 'running',
        profileId: params.profileId,
        prompt: params.prompt,
        references: params.references,
        firstFrame: params.firstFrame,
        lastFrame: params.lastFrame,
        source: agent ? 'agent' : 'studio',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      jobs.set(id, job);
      return { ...job };
    },
    readJob: async (id) => {
      const job = jobs.get(id);
      if (!job) throw new Error('Job not found');
      return { ...job };
    },
    read: async (id) => {
      const job = jobs.get(id);
      if (!job) throw new Error('Job not found');
      return { ...job };
    },
    publicJob: (job) => ({ id: job.id, status: job.status, profileId: job.profileId }),
    handlers: {
      'studio/read': async ({ id }) => {
        const job = jobs.get(id);
        if (!job) {
          const err = new Error('Job not found');
          err.rpc = { code: -32004, message: 'Job not found' };
          throw err;
        }
        return { ...job };
      },
      'studio/library': async ({ id }) => {
        const job = jobs.get(id);
        const name = job?.outputs?.[0]?.name || job?.output?.name || 'test-img.png';
        const written = await library.handlers['library/write']({
          path: `创作/${name}`,
          base64: PNG.toString('base64'),
        });
        return written;
      },
      'studio/frame/export': async ({ id, index }) => {
        const written = await library.handlers['library/write']({
          path: '创作/tail-frame.png',
          base64: PNG.toString('base64'),
        });
        return {
          id: written.id,
          name: 'tail-frame.png',
          sha256: written.sha256,
          libraryId: written.id,
          libraryVersion: written.sha256,
        };
      },
    },
  };

  const canvas = createCanvasEngine({ home, library, studio });

  const cleanup = () => {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {}
  };

  return { home, library, studio, canvas, jobs, createdJobs, cleanup };
}

// -------------------------------------------------------------
// 1. Graph DAG & Edge Role Validation tests
// -------------------------------------------------------------
test('validateGraph accepts valid acyclic graph and diamond DAG', () => {
  const nodes = [
    { id: 'n1', kind: 'text', title: 'Text 1', x: 0, y: 0, prompt: 'Hello' },
    { id: 'n2', kind: 'image', title: 'Img 1', x: 100, y: 100, profileId: 'p-image' },
    { id: 'n3', kind: 'image', title: 'Img 2', x: 100, y: -100, profileId: 'p-image' },
    { id: 'n4', kind: 'video', title: 'Vid 1', x: 200, y: 0, profileId: 'p-video' },
  ];
  const edges = [
    { id: 'e1', from: 'n1', to: 'n2', role: 'context' },
    { id: 'e2', from: 'n1', to: 'n3', role: 'context' },
    { id: 'e3', from: 'n2', to: 'n4', role: 'firstFrame' },
    { id: 'e4', from: 'n3', to: 'n4', role: 'lastFrame' },
  ];
  const validated = validateGraph(nodes, edges);
  assert.equal(validated.nodes.length, 4);
  assert.equal(validated.edges.length, 4);
});

test('validateGraph enforces node and edge limits and kinds', () => {
  assert.throws(() => validateGraph(Array.from({ length: 81 }, (_, i) => ({ id: `n${i}`, kind: 'text', x: 0, y: 0 })), []), /Canvas cannot exceed 80 nodes/);
  assert.throws(() => validateGraph([], Array.from({ length: 201 }, (_, i) => ({ id: `e${i}`, from: 'a', to: 'b', role: 'context' }))), /Canvas cannot exceed 200 edges/);
  assert.throws(() => validateGraph([{ id: 'n1', kind: 'unknown', x: 0, y: 0 }], []), /Invalid node kind/);
  assert.throws(() => validateGraph([{ id: 'n1', kind: 'text', x: NaN, y: 0 }], []), /coordinates must be finite numbers/);
  assert.throws(() => validateGraph([{ id: 'n1', kind: 'text', x: 0, y: 0 }, { id: 'n1', kind: 'text', x: 10, y: 10 }], []), /Duplicate node id/);
});

test('validateGraph strictly enforces edge roles and allowed node kinds', () => {
  const nodes = [
    { id: 'txt', kind: 'text', x: 0, y: 0 },
    { id: 'ast', kind: 'asset', x: 10, y: 10 },
    { id: 'img', kind: 'image', x: 20, y: 20 },
    { id: 'img2', kind: 'image', x: 25, y: 25 },
    { id: 'vid', kind: 'video', x: 30, y: 30 },
  ];

  // context: from must be text; to cannot be asset
  assert.throws(() => validateGraph(nodes, [{ id: 'e1', from: 'img', to: 'txt', role: 'context' }]), /context edge from node must be 'text'/);
  assert.throws(() => validateGraph(nodes, [{ id: 'e2', from: 'txt', to: 'ast', role: 'context' }]), /context edge cannot connect to 'asset'/);
  assert.doesNotThrow(() => validateGraph(nodes, [{ id: 'e3', from: 'txt', to: 'img', role: 'context' }]));

  // reference: from must be asset/image; to must be image
  assert.throws(() => validateGraph(nodes, [{ id: 'e4', from: 'txt', to: 'img', role: 'reference' }]), /reference edge from node must be 'asset' or 'image'/);
  assert.throws(() => validateGraph(nodes, [{ id: 'e5', from: 'ast', to: 'vid', role: 'reference' }]), /reference edge to node must be 'image'/);
  assert.doesNotThrow(() => validateGraph(nodes, [{ id: 'e6', from: 'ast', to: 'img', role: 'reference' }]));
  assert.doesNotThrow(() => validateGraph(nodes, [{ id: 'e7', from: 'img', to: 'img2', role: 'reference' }]));

  // firstFrame: from must be asset/image/video; to must be video
  assert.throws(() => validateGraph(nodes, [{ id: 'e8', from: 'txt', to: 'vid', role: 'firstFrame' }]), /firstFrame edge from node must be 'asset', 'image' or 'video'/);
  assert.throws(() => validateGraph(nodes, [{ id: 'e9', from: 'img', to: 'img2', role: 'firstFrame' }]), /firstFrame edge to node must be 'video'/);
  assert.doesNotThrow(() => validateGraph(nodes, [{ id: 'e10', from: 'img', to: 'vid', role: 'firstFrame' }]));

  // lastFrame: from must be asset/image; to must be video
  assert.throws(() => validateGraph(nodes, [{ id: 'e11', from: 'vid', to: 'vid', role: 'lastFrame' }]), /Edge cannot connect node to itself/);
  assert.throws(() => validateGraph(nodes, [{ id: 'e12', from: 'txt', to: 'vid', role: 'lastFrame' }]), /lastFrame edge from node must be 'asset' or 'image'/);
  assert.doesNotThrow(() => validateGraph(nodes, [{ id: 'e13', from: 'img', to: 'vid', role: 'lastFrame' }]));
});

test('validateGraph rejects self loops, duplicate edges, dangling endpoints and cycles', () => {
  const nodes = [
    { id: 'a', kind: 'text', x: 0, y: 0 },
    { id: 'b', kind: 'text', x: 10, y: 10 },
    { id: 'c', kind: 'text', x: 20, y: 20 },
  ];

  assert.throws(() => validateGraph(nodes, [{ id: 'e1', from: 'a', to: 'a', role: 'context' }]), /Edge cannot connect node to itself/);
  assert.throws(() => validateGraph(nodes, [{ id: 'e1', from: 'a', to: 'nonexistent', role: 'context' }]), /does not exist/);
  assert.throws(() => validateGraph(nodes, [
    { id: 'e1', from: 'a', to: 'b', role: 'context' },
    { id: 'e2', from: 'a', to: 'b', role: 'context' },
  ]), /Duplicate edge/);

  // Cycle
  assert.throws(() => validateGraph(nodes, [
    { id: 'e1', from: 'a', to: 'b', role: 'context' },
    { id: 'e2', from: 'b', to: 'c', role: 'context' },
    { id: 'e3', from: 'c', to: 'a', role: 'context' },
  ]), /Canvas connections cannot contain cycles/);
});

// -------------------------------------------------------------
// 2. Create Idempotency & Multi-chunk Canvas Document Reading
// -------------------------------------------------------------
test('create deduplicates by idempotencyKey and rejects conflicting bodies', async () => {
  const env = setupTestEnv();
  try {
    const key = 'idem-create-canvas-1';
    const first = await env.canvas.handlers['studio/canvas/create']({
      idempotencyKey: key,
      title: 'Canvas One',
      nodes: [{ id: 't1', kind: 'text', x: 0, y: 0, prompt: 'Text' }],
      edges: [],
    });

    // Same key with same body: returns exact same canvas without creating a duplicate
    const second = await env.canvas.handlers['studio/canvas/create']({
      idempotencyKey: key,
      title: 'Canvas One',
      nodes: [{ id: 't1', kind: 'text', x: 0, y: 0, prompt: 'Text' }],
      edges: [],
    });
    assert.equal(second.id, first.id);
    assert.equal(second.revision, first.revision);

    // Same key with different body: throws conflict error
    await assert.rejects(
      env.canvas.handlers['studio/canvas/create']({
        idempotencyKey: key,
        title: 'Canvas Different Title',
        nodes: [{ id: 't1', kind: 'text', x: 0, y: 0, prompt: 'Text' }],
        edges: [],
      }),
      /Idempotency key conflict/
    );

    // List shows only one canvas created
    const listed = await env.canvas.handlers['studio/canvas/list']();
    assert.equal(listed.canvases.length, 1);
  } finally {
    env.cleanup();
  }
});

test('read and list support multi-chunk canvas documents (> 512 KiB)', async () => {
  const env = setupTestEnv();
  try {
    // Generate a large canvas with 40 nodes with big prompt text totaling ~600 KiB (exceeding 512 KiB chunk limit)
    const largePrompt = 'A'.repeat(7500); // 7.5 KB each
    const nodes = [];
    for (let i = 0; i < 40; i++) {
      nodes.push({ id: `node-${i}`, kind: 'text', title: `Node ${i}`, x: i * 10, y: i * 10, prompt: largePrompt });
    }

    const created = await env.canvas.handlers['studio/canvas/create']({
      title: 'Big Document Canvas',
      nodes,
      edges: [],
    });

    // Read full multi-chunk document
    const doc = await env.canvas.handlers['studio/canvas/read']({ id: created.id });
    assert.equal(doc.id, created.id);
    assert.equal(doc.nodes.length, 40);
    assert.equal(doc.nodes[0].prompt, largePrompt);

    // List multi-chunk document
    const listRes = await env.canvas.handlers['studio/canvas/list']();
    assert.equal(listRes.canvases.length, 1);
    assert.equal(listRes.canvases[0].nodeCount, 40);
  } finally {
    env.cleanup();
  }
});

// -------------------------------------------------------------
// 3. Save Validation, CAS & Kind Change Protections
// -------------------------------------------------------------
test('save enforces required arrays, protects pending intents and running jobs, and clears mismatched jobIds', async () => {
  const env = setupTestEnv();
  try {
    const doc = await env.canvas.handlers['studio/canvas/create']({
      title: 'Save Protection Canvas',
      nodes: [
        { id: 'img1', kind: 'image', title: 'Img 1', x: 0, y: 0, profileId: 'p-image', prompt: 'Photo' },
      ],
      edges: [],
    });

    // Save must reject missing nodes/edges
    await assert.rejects(
      env.canvas.handlers['studio/canvas/save']({ id: doc.id, revision: 1 }),
      /nodes and edges arrays are required for save/
    );

    // Generate node
    const genRes = await env.canvas.handlers['studio/canvas/generate']({
      id: doc.id,
      revision: 1,
      nodeId: 'img1',
      idempotencyKey: 'idemp-save-test',
    });
    assert.ok(genRes.job.id);

    // Attempt to delete running node: must fail
    await assert.rejects(
      env.canvas.handlers['studio/canvas/save']({
        id: doc.id,
        revision: genRes.canvas.revision,
        nodes: [],
        edges: [],
      }),
      /正在生成中或有未决意图的节点不能被删除/
    );

    // Finish job
    env.jobs.get(genRes.job.id).status = 'succeeded';

    // Now edit node kind from 'image' to 'text': must NOT inherit image's jobId!
    const changedKindDoc = await env.canvas.handlers['studio/canvas/save']({
      id: doc.id,
      revision: genRes.canvas.revision,
      nodes: [
        { id: 'img1', kind: 'text', title: 'Now Text', x: 0, y: 0, prompt: 'Converted' },
      ],
      edges: [],
    });
    assert.equal(changedKindDoc.nodes[0].jobId, undefined, 'Mismatched jobId must be cleared when node kind changes');
  } finally {
    env.cleanup();
  }
});

// -------------------------------------------------------------
// 4. Reference Verification with Real Library Data
// -------------------------------------------------------------
test('generate verifies real image bytes in personal library for asset references', async () => {
  const env = setupTestEnv();
  try {
    // 1. Put a valid PNG in the library
    const written = await env.library.handlers['library/write']({
      path: '素材/my-image.png',
      base64: PNG.toString('base64'),
    });

    const doc = await env.canvas.handlers['studio/canvas/create']({
      title: 'Asset Reference Test',
      nodes: [
        { id: 'ast', kind: 'asset', title: 'Valid Asset', x: 0, y: 0, reference: { id: written.id, version: written.sha256 } },
        { id: 'img', kind: 'image', title: 'Target', x: 100, y: 0, profileId: 'p-image', prompt: 'Style of asset' },
      ],
      edges: [{ id: 'e1', from: 'ast', to: 'img', role: 'reference' }],
    });

    const genRes = await env.canvas.handlers['studio/canvas/generate']({
      id: doc.id,
      revision: 1,
      nodeId: 'img',
      idempotencyKey: 'idemp-asset-ref-ok',
    });
    assert.ok(genRes.job);
    const lastCall = env.createdJobs[env.createdJobs.length - 1];
    assert.equal(lastCall.references[0].id, written.id);

    // 2. An asset with corrupted/non-image bytes must be rejected
    const corruptFile = await env.library.handlers['library/write']({
      path: '素材/not-image.txt',
      text: 'hello this is not an image file',
    });

    const docBad = await env.canvas.handlers['studio/canvas/create']({
      title: 'Bad Asset Reference Test',
      nodes: [
        { id: 'ast-bad', kind: 'asset', title: 'Text Asset', x: 0, y: 0, reference: { id: corruptFile.id, version: corruptFile.sha256 } },
        { id: 'img-bad', kind: 'image', title: 'Target', x: 100, y: 0, profileId: 'p-image', prompt: 'Test' },
      ],
      edges: [{ id: 'e1', from: 'ast-bad', to: 'img-bad', role: 'reference' }],
    });

    await assert.rejects(
      env.canvas.handlers['studio/canvas/generate']({
        id: docBad.id,
        revision: 1,
        nodeId: 'img-bad',
        idempotencyKey: 'idemp-bad-asset',
      }),
      /不是支持的有效图片格式/
    );
  } finally {
    env.cleanup();
  }
});

// -------------------------------------------------------------
// 5. Generate Idempotency, CAS Failure Repair & Upstream Frame Wire
// -------------------------------------------------------------
test('generate same key returns existing job even if canvas revision incremented, and repairs missing node.jobId', async () => {
  const env = setupTestEnv();
  try {
    const doc = await env.canvas.handlers['studio/canvas/create']({
      title: 'Repair Test',
      nodes: [{ id: 'n1', kind: 'image', title: 'Target', x: 0, y: 0, profileId: 'p-image', prompt: 'Landscape' }],
      edges: [],
    });

    const key = 'idem-repair-key';
    const firstGen = await env.canvas.handlers['studio/canvas/generate']({
      id: doc.id,
      revision: 1,
      nodeId: 'n1',
      idempotencyKey: key,
    });
    assert.equal(firstGen.canvas.revision, 2);
    assert.equal(env.createdJobs.length, 1);

    // Simulate other edits bumping canvas revision to 3
    const savedRev3 = await env.canvas.handlers['studio/canvas/save']({
      id: doc.id,
      revision: 2,
      title: 'Repair Test Renamed',
      nodes: firstGen.canvas.nodes,
      edges: [],
    });
    assert.equal(savedRev3.revision, 3);

    // Retry with SAME idempotency key: must return the exact same job even though canvas revision is now 3!
    const retryGen = await env.canvas.handlers['studio/canvas/generate']({
      id: doc.id,
      revision: 1, // Caller still sends old revision 1
      nodeId: 'n1',
      idempotencyKey: key,
    });
    assert.equal(retryGen.job.id, firstGen.job.id);
    assert.equal(env.createdJobs.length, 1, 'Must not recreate job in studio');
  } finally {
    env.cleanup();
  }
});

test('an unknown provider outcome stays protected even when its job is terminal', async () => {
  const env = setupTestEnv();
  try {
    const doc = await env.canvas.handlers['studio/canvas/create']({ title: 'Unknown outcome', nodes: [{ id: 'out', kind: 'image', title: 'Image', x: 0, y: 0, profileId: 'p-image', prompt: 'Scene' }], edges: [] });
    const first = await env.canvas.handlers['studio/canvas/generate']({ id: doc.id, revision: 1, nodeId: 'out', idempotencyKey: 'unknown-first' });
    env.jobs.set(first.job.id, { ...first.job, status: 'failed', phase: 'unknown' });
    await env.canvas.recover();
    await assert.rejects(env.canvas.handlers['studio/canvas/generate']({ id: doc.id, revision: 2, nodeId: 'out', idempotencyKey: 'new-key' }), /in progress/);
    await assert.rejects(env.canvas.handlers['studio/canvas/save']({ id: doc.id, revision: 2, title: doc.title, nodes: [], edges: [] }), /不能被删除/);
    const retry = await env.canvas.handlers['studio/canvas/generate']({ id: doc.id, revision: 1, nodeId: 'out', idempotencyKey: 'unknown-first' });
    assert.equal(retry.job.id, first.job.id);
    assert.equal(env.createdJobs.length, 1);
  } finally { env.cleanup(); }
});

test('video firstFrame resolution calls frame export and sets real frame reference', async () => {
  const env = setupTestEnv();
  try {
    const doc = await env.canvas.handlers['studio/canvas/create']({
      title: 'Video Continuity Canvas',
      nodes: [
        { id: 'vid1', kind: 'video', title: 'Shot 1', x: 0, y: 0, profileId: 'p-video', prompt: 'Intro video' },
        { id: 'vid2', kind: 'video', title: 'Shot 2', x: 100, y: 0, profileId: 'p-video', prompt: 'Next video' },
      ],
      edges: [{ id: 'e1', from: 'vid1', to: 'vid2', role: 'firstFrame' }],
    });

    // Generate vid1
    const gen1 = await env.canvas.handlers['studio/canvas/generate']({
      id: doc.id,
      revision: 1,
      nodeId: 'vid1',
      idempotencyKey: 'key-shot1',
    });
    env.jobs.get(gen1.job.id).status = 'succeeded';
    env.jobs.get(gen1.job.id).output = { name: 'shot1.mp4' };

    // Generate vid2
    const gen2 = await env.canvas.handlers['studio/canvas/generate']({
      id: doc.id,
      revision: gen1.canvas.revision,
      nodeId: 'vid2',
      idempotencyKey: 'key-shot2',
    });
    assert.ok(gen2.job);
    const lastCall = env.createdJobs[env.createdJobs.length - 1];
    assert.ok(lastCall.firstFrame);
    assert.ok(lastCall.firstFrame.id);
  } finally {
    env.cleanup();
  }
});

// -------------------------------------------------------------
// 6. Media Studio Integration & Recover (No Self-Deadlock)
// -------------------------------------------------------------
test('createMediaStudio initialize completes without recover deadlock', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-studio-deadlock-test-'));
  const rpc = async (method) => {
    if (method === 'workspace/create') return { id: 'ws-test' };
    if (method === 'job/list') return { jobs: [], total: 0 };
    return {};
  };
  const library = createPersonalLibrary({ home });

  const studio = createMediaStudio({ home, rpc, library });
  try {
    // initialize must resolve cleanly without hanging
    await studio.initialize();

    for (const method of [
      'studio/canvas/list',
      'studio/canvas/create',
      'studio/canvas/read',
      'studio/canvas/save',
      'studio/canvas/generate',
    ]) {
      assert.ok(typeof studio.handlers[method] === 'function', `Handler ${method} must be exposed`);
    }
  } finally {
    await studio.close();
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {}
  }
});

// -------------------------------------------------------------
// 7. Defect Regressions (Points 1 - 7)
// -------------------------------------------------------------

test('Regression Point 1: 117-char UUID keys hashed to <= 90 chars and work with real createMediaStudio', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-canvas-p1-'));
  const jobStore = new Map();
  const rpc = async (method, params) => {
    if (method === 'workspace/create') return { id: 'ws-test' };
    if (method === 'job/list') return { jobs: [], total: 0 };
    if (method === 'job/create') {
      assert.ok(params.idempotencyKey.length <= 90, `idempotencyKey length ${params.idempotencyKey.length} must be <= 90`);
      const id = `job-${crypto.randomUUID()}`;
      const j = { id, status: 'queued', workspaceId: 'ws-test', type: 'media.image', checkpoint: null };
      jobStore.set(id, j);
      return { id };
    }
    if (method === 'job/read') {
      const j = jobStore.get(params.id) || { id: params.id, status: 'queued', workspaceId: 'ws-test', type: 'media.image', checkpoint: null };
      return j;
    }
    if (method === 'job/checkpoint') {
      const j = jobStore.get(params.jobId);
      if (j) j.checkpoint = params.checkpoint;
      return { id: params.jobId, ...params.checkpoint };
    }
    return {};
  };
  const library = createPersonalLibrary({ home });
  const studio = createMediaStudio({ home, rpc, library });
  try {
    await studio.initialize();
    studio.profiles.save({
      id: 'p-real-img',
      name: 'Real Image',
      kind: 'image',
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'gpt-image',
      apiKey: 'k',
      agentEnabled: true,
      extra: {},
      custom: {},
    });

    const nodeId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();

    const doc = await studio.handlers['studio/canvas/create']({
      title: 'UUID Test Canvas',
      nodes: [
        { id: nodeId, kind: 'image', title: 'Image Node', x: 0, y: 0, profileId: 'p-real-img', prompt: 'A test prompt' },
      ],
      edges: [],
    });

    const gen = await studio.handlers['studio/canvas/generate']({
      id: doc.id,
      revision: 1,
      nodeId,
      idempotencyKey,
      agentRequested: true,
    });

    assert.ok(gen.job);
    assert.ok(gen.job.id);
  } finally {
    await studio.close();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

test('Regression Point 2: create idempotency preallocates canvasId and writes pending intent before library write', async () => {
  const env = setupTestEnv();
  try {
    const key = 'create-test-key-1';
    const doc1 = await env.canvas.handlers['studio/canvas/create']({
      title: 'Canvas 1',
      idempotencyKey: key,
      nodes: [{ id: 'n1', kind: 'text', title: 'T', x: 0, y: 0, prompt: 'hello' }],
      edges: [],
    });

    const cIntentPath = path.join(env.canvas.root, 'create-intents', `${crypto.createHash('sha256').update(key).digest('hex')}.json`);
    assert.ok(fs.existsSync(cIntentPath), 'Create intent file must exist');
    const record = JSON.parse(fs.readFileSync(cIntentPath, 'utf8'));
    assert.equal(record.canvasId, doc1.id);
    assert.equal(record.status, 'created');

    const doc2 = await env.canvas.handlers['studio/canvas/create']({
      title: 'Canvas 1',
      idempotencyKey: key,
      nodes: [{ id: 'n1', kind: 'text', title: 'T', x: 0, y: 0, prompt: 'hello' }],
      edges: [],
    });
    assert.equal(doc2.id, doc1.id);

    await assert.rejects(
      async () => {
        await env.canvas.handlers['studio/canvas/create']({
          title: 'Canvas Conflict',
          idempotencyKey: key,
          nodes: [{ id: 'n1', kind: 'text', title: 'T', x: 0, y: 0, prompt: 'different prompt' }],
          edges: [],
        });
      },
      (err) => err.rpc?.code === -32602
    );
  } finally {
    env.cleanup();
  }
});

test('Regression Point 3: validateGraph and generate reject multiple firstFrame/lastFrame and > 6 references', async () => {
  const env = setupTestEnv();
  try {
    assert.throws(() => {
      validateGraph(
        [
          { id: 'v1', kind: 'video', x: 0, y: 0 },
          { id: 'v2', kind: 'video', x: 10, y: 0 },
          { id: 'target', kind: 'video', x: 20, y: 0 },
        ],
        [
          { id: 'e1', from: 'v1', to: 'target', role: 'firstFrame' },
          { id: 'e2', from: 'v2', to: 'target', role: 'firstFrame' },
        ]
      );
    }, /视频节点只能有一条 firstFrame 连线/);

    assert.throws(() => {
      validateGraph(
        [
          { id: 'img1', kind: 'image', x: 0, y: 0 },
          { id: 'img2', kind: 'image', x: 10, y: 0 },
          { id: 'target', kind: 'video', x: 20, y: 0 },
        ],
        [
          { id: 'e1', from: 'img1', to: 'target', role: 'lastFrame' },
          { id: 'e2', from: 'img2', to: 'target', role: 'lastFrame' },
        ]
      );
    }, /视频节点只能有一条 lastFrame 连线/);

    assert.throws(() => {
      const nodes = [{ id: 'target', kind: 'image', x: 0, y: 0 }];
      const edges = [];
      for (let i = 1; i <= 7; i++) {
        nodes.push({ id: `img${i}`, kind: 'image', x: i * 10, y: 0 });
        edges.push({ id: `e${i}`, from: `img${i}`, to: 'target', role: 'reference' });
      }
      validateGraph(nodes, edges);
    }, /图片节点参考图连线不能超过 6 条/);
  } finally {
    env.cleanup();
  }
});

test('Regression Point 4: agentRequested is passed to studio.create and actor change on same key is rejected', async () => {
  const env = setupTestEnv();
  try {
    const doc = await env.canvas.handlers['studio/canvas/create']({
      title: 'Agent Permissions Canvas',
      nodes: [
        { id: 'img-agent', kind: 'image', title: 'Agent Img', x: 0, y: 0, profileId: 'p-image', prompt: 'Prompt' },
        { id: 'img-disabled', kind: 'image', title: 'Disabled Img', x: 100, y: 0, profileId: 'p-image-disabled', prompt: 'Prompt' },
      ],
      edges: [],
    });

    await assert.rejects(
      async () => {
        await env.canvas.handlers['studio/canvas/generate']({
          id: doc.id,
          revision: 1,
          nodeId: 'img-disabled',
          idempotencyKey: 'key-disabled-1',
          agentRequested: true,
        });
      },
      (err) => err.rpc?.code === -32602
    );

    const gen = await env.canvas.handlers['studio/canvas/generate']({
      id: doc.id,
      revision: 1,
      nodeId: 'img-agent',
      idempotencyKey: 'key-actor-1',
      agentRequested: true,
    });
    assert.ok(gen.job);
    const lastJob = env.createdJobs[env.createdJobs.length - 1];
    assert.equal(lastJob.agentRequested, true);
    assert.equal(lastJob.source, 'agent');

    await assert.rejects(
      async () => {
        await env.canvas.handlers['studio/canvas/generate']({
          id: doc.id,
          revision: 1,
          nodeId: 'img-agent',
          idempotencyKey: 'key-actor-1',
          agentRequested: false,
        });
      },
      (err) => err.rpc?.code === -32602
    );

    const retry = await env.canvas.handlers['studio/canvas/generate']({
      id: doc.id,
      revision: 1,
      nodeId: 'img-agent',
      idempotencyKey: 'key-actor-1',
      agentRequested: true,
    });
    assert.equal(retry.job.id, gen.job.id);
  } finally {
    env.cleanup();
  }
});

test('Regression Point 5: parameter pre-validation rejects before writing pending intent', async () => {
  const env = setupTestEnv();
  try {
    const doc = await env.canvas.handlers['studio/canvas/create']({
      title: 'Validation Canvas',
      nodes: [
        { id: 'img1', kind: 'image', title: 'Invalid Count', x: 0, y: 0, profileId: 'p-image', prompt: 'test prompt', settings: { count: 8 } },
      ],
      edges: [],
    });

    const iPath = path.join(env.canvas.root, 'intents', `${doc.id}-img1.json`);

    await assert.rejects(
      async () => {
        await env.canvas.handlers['studio/canvas/generate']({
          id: doc.id,
          revision: 1,
          nodeId: 'img1',
          idempotencyKey: 'key-invalid-count',
        });
      },
      /Invalid prompt, dimensions, count, duration or references/
    );

    assert.equal(fs.existsSync(iPath), false, 'No pending intent file must be created on pre-validation failure');
  } finally {
    env.cleanup();
  }
});

test('Regression Point 6: P.id enforces valid IDs and reference.name is preserved', async () => {
  const env = setupTestEnv();
  try {
    assert.throws(() => {
      validateGraph([{ id: 'bad node name with spaces', kind: 'text', x: 0, y: 0 }], []);
    }, /Invalid id/);

    assert.throws(() => {
      validateGraph(
        [{ id: 'n1', kind: 'text', x: 0, y: 0 }, { id: 'n2', kind: 'text', x: 1, y: 1 }],
        [{ id: 'bad edge!', from: 'n1', to: 'n2', role: 'context' }]
      );
    }, /Invalid id/);

    const sha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const { nodes } = validateGraph(
      [{
        id: 'asset1',
        kind: 'asset',
        x: 0,
        y: 0,
        reference: { id: 'ref-1', version: sha, name: 'Custom Name' },
      }],
      []
    );
    assert.equal(nodes[0].reference.name, 'Custom Name');
  } finally {
    env.cleanup();
  }
});

test('Regression Point 7: readCanvasDocument enforces strict schema and save preserves server-owned jobId', async () => {
  const env = setupTestEnv();
  try {
    const doc = await env.canvas.handlers['studio/canvas/create']({
      title: 'Strict Schema Canvas',
      nodes: [{ id: 'n1', kind: 'image', title: 'Img', x: 0, y: 0, profileId: 'p-image', prompt: 'prompt' }],
      edges: [],
    });

    const gen = await env.canvas.handlers['studio/canvas/generate']({
      id: doc.id,
      revision: 1,
      nodeId: 'n1',
      idempotencyKey: 'key-strict-1',
    });
    assert.ok(gen.job.id);

    const saved = await env.canvas.handlers['studio/canvas/save']({
      id: doc.id,
      revision: gen.canvas.revision,
      nodes: [
        { id: 'n1', kind: 'image', title: 'Img Renamed', x: 50, y: 50, profileId: 'p-image', prompt: 'prompt' },
        { id: 'n2', kind: 'image', title: 'Forged', x: 10, y: 10, jobId: 'fake-job-id' },
      ],
      edges: [],
    });

    const n1 = saved.nodes.find(n => n.id === 'n1');
    assert.equal(n1.jobId, gen.job.id, 'Existing jobId must be preserved by server reconciliation');

    const n2 = saved.nodes.find(n => n.id === 'n2');
    assert.equal(n2.jobId, undefined, 'Client-forged jobId must not be accepted');
  } finally {
    env.cleanup();
  }
});
