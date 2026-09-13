'use strict';

// Live vertical acceptance: a real knorvia-daemon and a real forked Kernel
// App Server drive an MCP media tool call through the studio MCP endpoint,
// the media worker submits to a loopback media fixture, and the durable
// Job/Artifact land in the Rust store. Both the imagegen and videogen tools
// are exercised. No paid or external service is used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { startKnorviaDaemon, initializeRequest } = require('../knorvia-protocol-client');
const { createMediaStudio } = require('../media-studio');
const { createStudioMcp } = require('../studio-mcp');
const { createPersonalLibrary } = require('../personal-library');

const kernelRoot = path.resolve(__dirname, '../../../knorvia-kernel');
const daemonBin = process.env.KNORVIA_DAEMON_BIN || path.join(kernelRoot, 'knorvia-rs/target/release/knorvia-daemon.exe');
const kernelBin = process.env.KNORVIA_KERNEL_BIN || path.join(kernelRoot, 'codex-rs/target/debug/codex-app-server.exe');

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const MP4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

const SCENARIOS = {
  image: {
    tool: 'imagegen', profileId: 'p-live-image', profile: origin => ({ id: 'p-live-image', name: 'live fixture image', kind: 'image', protocol: 'openai', baseUrl: `${origin}/v1`, model: 'fixture-model', apiKey: 'local-fixture-only', agentEnabled: true, extra: {}, custom: {} }),
    prompt: 'a small red square', kind: 'image', signatureOffset: 0, signature: PNG.subarray(0, 4), mime: 'image/png',
  },
  video: {
    tool: 'videogen', profileId: 'p-live-video', profile: origin => ({ id: 'p-live-video', name: 'live fixture video', kind: 'video', protocol: 'fal', baseUrl: origin, model: 'fal-ai/fixture/video', apiKey: 'local-fixture-only', agentEnabled: true, extra: {}, custom: { firstFrameField: 'start_image_url', lastFrameField: 'end_image_url' } }),
    prompt: 'a slow red gradient', kind: 'video', signatureOffset: 4, signature: MP4.subarray(4, 8), mime: 'video/mp4', aspect: '16:9', seconds: 4,
  },
};

SCENARIOS.canvas = { ...SCENARIOS.image, tool: 'media_canvas', canvas: true };

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`enc:${value}`),
    decryptString: value => Buffer.from(value).toString('utf8').slice(4),
  };
}

// Loopback provider fixture for both protocols: OpenAI-compatible image
// generation and a fal-style video queue that completes immediately.
function startMediaFixture() {
  const hits = { image: 0, video: 0, videoFile: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && (req.url === '/v1/images/generations' || req.url === '/v1/images/edits')) {
      hits.image += 1;
      req.resume();
      req.on('end', () => res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })));
      return;
    }
    if (req.method === 'POST' && req.url === '/fal-ai/fixture/video') {
      hits.video += 1;
      res.end(JSON.stringify({ request_id: 'r1', status: 'IN_PROGRESS', status_url: '/queue/r1', response_url: '/queue/r1/result', cancel_url: '/queue/r1/cancel' }));
      return;
    }
    if (req.url === '/queue/r1') { res.end(JSON.stringify({ status: 'COMPLETED' })); return; }
    if (req.url === '/queue/r1/result') {
      res.end(JSON.stringify({ video: { url: `http://127.0.0.1:${server.address().port}/fixture.mp4` } }));
      return;
    }
    if (req.url === '/fixture.mp4') {
      hits.videoFile += 1;
      res.setHeader('content-type', 'video/mp4');
      res.end(MP4);
      return;
    }
    res.writeHead(404); res.end();
  });
  return {
    hits,
    originReady: new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close() { server.close(); server.closeAllConnections(); },
  };
}

// Minimal scripted Responses provider: the first request must carry the
// requested media tool declaration surfaced by the Kernel from the studio
// MCP server; the scripted model then calls it and reports the durable job.
function startMediaModelFixture(scenario) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) {
      res.writeHead(404); res.end(); return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const rawInput = body.input;
    const inputText = JSON.stringify(rawInput || '');
    const continued = inputText.includes('fixture-media-1');
    const sse = events => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')); };
    const done = () => sse([
      { type: 'response.created', response: { id: 'resp-2' } },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'msg-2', content: [{ type: 'output_text', text: 'media live fixture completed; the durable media job was created' }] } },
      { type: 'response.completed', response: { id: 'resp-2', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: null, output_tokens_details: null } } },
    ]);
    if (continued) {
      // Namespace tool calls arrive back as function_call_output items; the
      // durable outcome is asserted from the store, not from this text.
      const items = Array.isArray(rawInput) ? rawInput : [];
      const outputs = items.filter(item => item && (item.type === 'function_call_output' || item.call_id === 'fixture-media-1'));
      requests.push({ kind: 'continuation', lastOutput: JSON.stringify(outputs.at(-1) || '').slice(0, 2000) });
      done();
      return;
    }
    const mediaTool = (body.tools || []).find(tool => typeof tool?.name === 'string' && tool.name.includes('knorvia_media')) || null;
    const subToolNames = Array.isArray(mediaTool?.tools) ? mediaTool.tools.map(tool => tool?.name).filter(Boolean) : [];
    const surfaced = subToolNames.includes(scenario.tool) ? mediaTool.name : null;
    requests.push({ mediaToolName: mediaTool?.name || null, subToolNames, surfaced });
    if (!surfaced) {
      sse([
        { type: 'response.created', response: { id: 'resp-missing-tool' } },
        { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'msg-missing', content: [{ type: 'output_text', text: `no ${scenario.tool} tool was surfaced to the model` }] } },
        { type: 'response.completed', response: { id: 'resp-missing-tool', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: null, output_tokens_details: null } } },
      ]);
      return;
    }
    // Namespace tools are called with separate `namespace` and `name` fields.
    const args = scenario.canvas ? { action: 'generate', ...scenario.canvasInput, idempotencyKey: 'live-canvas-generate-1' } : { profileId: scenario.profileId, prompt: scenario.prompt, idempotencyKey: `live-${scenario.tool}-1` };
    if (scenario.aspect) args.aspect = scenario.aspect;
    if (scenario.seconds) args.seconds = scenario.seconds;
    if (!scenario.canvas) Object.assign(args, scenario.inputs || {});
    sse([
      { type: 'response.created', response: { id: 'resp-1' } },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'fixture-media-1', namespace: mediaTool.name, name: scenario.tool, arguments: JSON.stringify(args) } },
      { type: 'response.completed', response: { id: 'resp-1', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: null, output_tokens_details: null } } },
    ]);
  });
  server.listen(0, '127.0.0.1');
  return {
    requests,
    providerReady: new Promise(resolve => server.on('listening', () => resolve({
      KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1',
      KNORVIA_KERNEL_TURN_TIMEOUT_SECS: '120',
      KNORVIA_PROVIDER_API_KEY: 'local-fixture-only',
      KNORVIA_PROVIDER_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      KNORVIA_PROVIDER_MODEL: 'knorvia-fixture-model',
    }))),
    close() { server.close(); server.closeAllConnections(); },
  };
}

async function runMediaScenario(name) {
  const scenario = { ...SCENARIOS[name] };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `knorvia-studio-live-${name}-`));
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace);

  const media = startMediaFixture();
  const mediaOrigin = await media.originReady;
  const model = startMediaModelFixture(scenario);
  const providerEnv = await model.providerReady;

  // The studio MCP endpoint must exist before the daemon starts so the
  // kernel-adapter can register it in the Kernel config.
  let daemonRpc = async () => { throw new Error('daemon session not ready yet'); };
  const lazyRpc = (...args) => daemonRpc(...args);
  const library = createPersonalLibrary({ home, rpc: lazyRpc });
  const studio = createMediaStudio({ home, rpc: lazyRpc, library, safeStorage: fakeSafeStorage(), pollMs: 50 });
  const studioMcp = await createStudioMcp({ getStudio: () => studio, getLibrary: () => library });

  const env = { ...process.env, ...providerEnv, ...studioMcp.env, KNORVIA_DAEMON_BIN: daemonBin, KNORVIA_KERNEL_BIN: kernelBin };
  const session = startKnorviaDaemon({ daemonBin, home, env, requestTimeoutMs: 30_000 });
  let diagnostics = '';
  session.child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
  let seq = 0;
  const rpc = async (method, params = {}) => {
    const response = await session.request({ jsonrpc: '2.0', id: `${++seq}`, method, params });
    if (response.error) { const error = new Error(`${method}: ${JSON.stringify(response.error)}`); error.rpc = response.error; throw error; }
    return response.result;
  };
  try {
    const init = await session.request(initializeRequest('knorvia_studio_live', '1'), { timeoutMs: 60_000 });
    assert.ok(!init.error, JSON.stringify(init));
    session.notify({ jsonrpc: '2.0', method: 'initialized' });
    daemonRpc = rpc;

    assert.equal((await rpc('system/health')).ok, true);

    // The studio workspace and its jobs are created through the real Rust
    // control plane, not a test double.
    await studio.initialize();
    studio.profiles.save(scenario.profile(mediaOrigin));
    const inputEntries = [];
    for (const [index, filename] of ['first.png', 'last.png'].entries()) {
      const file = path.join(workspace, filename); fs.writeFileSync(file, Buffer.concat([PNG, Buffer.from([index])]));
      inputEntries.push(await library.put(file, `references/${filename}`));
    }
    const pinned = inputEntries.map(entry => ({ id: entry.id, version: entry.sha256 }));
    scenario.inputs = scenario.kind === 'image' ? { references: pinned } : { firstFrame: pinned[0], lastFrame: pinned[1] };

    if (scenario.canvas) {
      const canvas = await studio.handlers['studio/canvas/create']({ title: 'Kernel canvas', globalPrompt: 'quiet documentary scene', nodes: [
        { id: 'brief', kind: 'text', title: 'Brief', prompt: 'warm afternoon', x: 0, y: 0 },
        ...pinned.map((reference, i) => ({ id: `ref${i}`, kind: 'asset', title: `Reference ${i}`, reference, x: 0, y: 200 + i * 200 })),
        { id: 'output', kind: 'image', title: 'Output', prompt: scenario.prompt, profileId: scenario.profileId, x: 400, y: 0 },
      ], edges: [{ id: 'context', from: 'brief', to: 'output', role: 'context' }, ...pinned.map((_, i) => ({ id: `reference${i}`, from: `ref${i}`, to: 'output', role: 'reference' }))] });
      scenario.canvasInput = { id: canvas.id, revision: canvas.revision, nodeId: 'output' };
    }
    const ws = await rpc('workspace/create', { title: 'studio live', cwd: workspace });
    const thread = await rpc('thread/start', { workspaceId: ws.id, title: `${scenario.tool} live`, cwd: workspace });
    const admitted = await rpc('turn/start', { threadId: thread.id, input: `[${scenario.tool}] generate with the live fixture`, tools: { write: true }, cwd: workspace });
    const turnId = admitted.turn?.id || admitted.id;
    const deadline = Date.now() + 180_000;
    let turn;
    // MCP tool calls surface a native approval; the fixture answers it the
    // way the desktop approval bridge would.
    do {
      await delay(150);
      turn = await rpc('turn/read', { id: turnId });
      if (turn.pendingApprovalId) {
        await rpc('approval/respond', { id: turn.pendingApprovalId, decision: 'allow' }).catch(() => {});
      }
      const snapshot = await rpc('thread/read', { id: thread.id }).catch(() => null);
      for (const entry of snapshot?.pendingApprovals || []) {
        if (entry.turnId === turnId) await rpc('approval/respond', { id: entry.id, decision: 'allow' }).catch(() => {});
      }
    } while (!TERMINAL.has(turn.status) && Date.now() < deadline);
    assert.ok(TERMINAL.has(turn.status), `turn never finished: ${diagnostics}`);
    assert.equal(turn.status, 'completed', `turn failed: ${JSON.stringify(turn.items?.slice(-3))}\n${diagnostics}`);

    // The model actually saw and called the MCP media tool.
    assert.ok(model.requests[0]?.surfaced, `no ${scenario.tool} tool in the model request tools: ${JSON.stringify(model.requests[0])}`);

    // The durable media job finished against the loopback media fixture.
    const expectedSubmits = scenario.kind === 'image' ? 'image' : 'video';
    assert.equal(media.hits[expectedSubmits], 1, 'the media worker must submit exactly once');
    const studioWs = await rpc('workspace/create', { title: '个人创作', idempotencyKey: 'media-studio-workspace-v1' });
    // Generation returns a durable asynchronous job. A completed model turn
    // does not imply that the worker has committed job/finish yet.
    const jobDeadline = Date.now() + 20_000;
    let jobs;
    do {
      jobs = await rpc('job/list', { workspaceId: studioWs.id, typePrefix: 'media.', offset: 0, limit: 50 });
      if (jobs.total === 1 && ['succeeded', 'failed', 'cancelled'].includes(jobs.jobs[0]?.status)) break;
      await delay(100);
    } while (Date.now() < jobDeadline);
    if (jobs.total !== 1 || jobs.jobs[0]?.status !== 'succeeded') {
      throw new Error(`${name} vertical incomplete: jobs=${JSON.stringify(jobs)} turn=${JSON.stringify(turn.items?.map(item => ({ kind: item.kind, payload: item.payload })))} modelRequests=${JSON.stringify(model.requests)}\nstderr=${diagnostics}`);
    }
    assert.equal(jobs.jobs[0].status, 'succeeded');
    const jobId = jobs.jobs[0].id;

    const outputs = fs.readdirSync(path.join(home, 'artifacts', 'media-studio')).filter(file => file.startsWith(`${jobId}-`) && !file.endsWith('-response.json'));
    assert.equal(outputs.length, 1, `expected one published output: ${outputs}`);
    const bytes = fs.readFileSync(path.join(home, 'artifacts', 'media-studio', outputs[0]));
    assert.equal(bytes.subarray(scenario.signatureOffset, scenario.signatureOffset + 4).equals(scenario.signature), true, `published bytes must match the fixture ${scenario.kind}`);

    const artifacts = await rpc('artifact/list', { workspaceId: studioWs.id });
    const mediaArtifact = artifacts.find(artifact => artifact.type === 'application/vnd.knorvia.media+json');
    assert.ok(mediaArtifact, `media artifact missing: ${JSON.stringify(artifacts.map(a => a.type))}`);
    const content = await rpc('artifact/content', { id: mediaArtifact.id });
    const manifest = JSON.parse(content.content);
    assert.equal(manifest.studioJobId, jobId);
    assert.equal(manifest.outputs[0].name, outputs[0]);
    assert.equal(manifest.outputs[0].size, bytes.length);
    if (scenario.kind === 'image') { assert.equal(manifest.source.references.length, 2); assert.equal(manifest.source.references[1].version, inputEntries[1].sha256); }
    else { assert.equal(manifest.source.firstFrame.version, inputEntries[0].sha256); assert.equal(manifest.source.lastFrame.version, inputEntries[1].sha256); }
    if (scenario.canvas) {
      const board = await studio.handlers['studio/canvas/read']({ id: scenario.canvasInput.id });
      assert.equal(board.nodes.find(n => n.id === 'output').jobId, jobId);
      assert.equal(board.nodes.find(n => n.id === 'output').job.source, 'agent');
      const again = await studio.handlers['studio/canvas/generate']({ ...scenario.canvasInput, idempotencyKey: 'live-canvas-generate-1', agentRequested: true });
      assert.equal(again.job.id, jobId);
      assert.equal(media.hits.image, 1, 'retry must not create a second provider request');
      assert.equal(board.nodes.find(n => n.id === 'output').job.input.prompt, 'quiet documentary scene\n\nwarm afternoon\n\n' + scenario.prompt);
    }

  } finally {
    await studio.close().catch(() => {});
    await studioMcp.close().catch(() => {});
    if (session.child.exitCode === null) {
      session.child.stdin.end();
      await Promise.race([once(session.child, 'close'), delay(10_000).then(() => session.child.kill())]);
    }
    media.close();
    model.close();
    await delay(200);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

test('a real kernel turn executes imagegen through studio MCP into a durable job and artifact', {
  skip: !fs.existsSync(daemonBin) || !fs.existsSync(kernelBin), timeout: 240_000,
}, async () => { await runMediaScenario('image'); });

test('a real kernel turn executes videogen through the fal-style queue into a durable job and artifact', {
  skip: !fs.existsSync(daemonBin) || !fs.existsSync(kernelBin), timeout: 240_000,
}, async () => { await runMediaScenario('video'); });

test('a real Kernel calls media_canvas and sees its durable graph, references and image job', {
  skip: !fs.existsSync(daemonBin) || !fs.existsSync(kernelBin), timeout: 240_000,
}, async () => { await runMediaScenario('canvas'); });
