'use strict';

// Live vertical for the storyboard chain (B06 + MEDIA §8 core E2E): a real
// knorvia-daemon and Rust store drive a three-shot sequence through the
// media worker; the loopback fixture serves REAL per-shot mp4 files, so the
// automatic tail-frame extraction and first-frame pinning are exercised with
// genuine ffmpeg output. No paid or external service is used.

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
const F = require('./fixtures/video-fixtures');

const kernelRoot = path.resolve(__dirname, '../../../knorvia-kernel');
const daemonBin = process.env.KNORVIA_DAEMON_BIN || path.join(kernelRoot, 'knorvia-rs/target/release/knorvia-daemon.exe');
const kernelBin = process.env.KNORVIA_KERNEL_BIN || path.join(kernelRoot, 'codex-rs/target/release/codex-app-server.exe');
const runtimeEvidence = process.env.KNORVIA_TEST_MEDIA_EVIDENCE || path.resolve(__dirname, '../../release/codex-integration-20260908/media/kernel');

let ffmpegAvailable = true;
try { F.ffmpeg(); } catch { ffmpegAvailable = false; }

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`enc:${value}`),
    decryptString: value => Buffer.from(value).toString('utf8').slice(4),
  };
}

// Serves three REAL distinct per-shot videos generated at fixture start; the
// Nth video submit receives the Nth file, so every shot's tail frame differs
// and the chain's content-hash assertions have real material.
function startShotFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-live-shots-'));
  const files = ['0xFF0000', '0xFFFFFF', '0x0000FF'].map((last, index) => F.sequence(dir, `shot-${index}.mp4`, ['0x111111', last]));
  const hits = { video: 0, files: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/fal-ai/live/sequence-video') {
      const index = hits.video++;
      res.end(JSON.stringify({ request_id: `r${index}`, status: 'IN_PROGRESS', response_url: `/queue/r${index}/result`, status_url: `/queue/r${index}`, cancel_url: `/queue/r${index}/cancel` }));
      return;
    }
    if (/^\/queue\/r\d+\/result$/.test(req.url)) {
      const index = Number(req.url.slice('/queue/r'.length, -'/result'.length));
      res.end(JSON.stringify({ video: { url: `http://127.0.0.1:${server.address().port}/shot/${index}` } }));
      return;
    }
    if (req.url.startsWith('/queue/r')) { res.end(JSON.stringify({ status: 'COMPLETED' })); return; }
    if (req.url.startsWith('/shot/')) {
      hits.files += 1;
      res.setHeader('content-type', 'video/mp4');
      fs.createReadStream(files[Number(req.url.slice('/shot/'.length)) % files.length]).pipe(res);
      return;
    }
    res.writeHead(404); res.end();
  });
  return {
    hits,
    originReady: new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close() { server.close(); server.closeAllConnections(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } },
  };
}

test('agent leg: a real kernel turn creates a sequence, edits subtitles and starts a retake through MCP', {
  // A first-turn MCP call must work without a sacrificial warm-up turn.
  skip: !fs.existsSync(daemonBin) || !fs.existsSync(kernelBin) || !ffmpegAvailable, timeout: 120_000,
}, async () => {
  fs.mkdirSync(runtimeEvidence, { recursive: true });
  const home = fs.mkdtempSync(path.join(runtimeEvidence, 'sequence-agent-'));
  const media = startShotFixture();
  const mediaOrigin = await media.originReady;
  // Scripted Responses model: turn 1 must surface the knorvia_media namespace
  // tool, then it calls media_sequence_create; turn 2 reads the durable answer.
  const requests = [];
  let continuationCount = 0;
  const model = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const outputs = (body.input || []).filter(item => item.type === 'function_call_output');
    const sse = events => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')); };
    const done = text => sse([
      { type: 'response.created', response: { id: 'resp-done' } },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'msg-done', content: [{ type: 'output_text', text }] } },
      { type: 'response.completed', response: { id: 'resp-done', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: null, output_tokens_details: null } } },
    ]);
    const mediaTool = (body.tools || []).find(tool => typeof tool?.name === 'string' && tool.name.includes('knorvia_media')) || null;
    const subTools = Array.isArray(mediaTool?.tools) ? mediaTool.tools.map(tool => tool?.name).filter(Boolean) : [];
    const isTurnWithTools = subTools.length > 0;
    if (!isTurnWithTools) {
      if ((body.tools || []).some(tool => tool.type === 'tool_search')) {
        requests.push({ leg: 'discover' });
        sse([{ type:'response.created', response:{id:'discover'} }, {type:'response.output_item.done',item:{type:'tool_search_call',execution:'client',call_id:'media-discovery',arguments:{query:'knorvia_media media_sequence_create media_sequence_status',limit:2}}}, {type:'response.completed',response:{id:'discover',usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}]);
      } else { requests.push({ leg: 'missing-tools' }); done('required studio tools unavailable'); }
      return;
    }
    if (!outputs.some(item => item.call_id === 'seq-1')) {
      requests.push({ leg: 'create', subTools });
      if (!subTools.includes('media_sequence_create')) { console.error('[agent-leg] surfaced subTools:', JSON.stringify(subTools)); done('sequence tool missing'); return; }
      sse([
        { type: 'response.created', response: { id: 'resp-create' } },
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'seq-1', namespace: mediaTool.name, name: 'media_sequence_create', arguments: JSON.stringify({
          title: 'agent 三段', globalPrompt: '统一画风：水墨', start: true,
          defaults: { profileId: 'p-live-seq', seconds: 4 },
          shots: [1, 2, 3].map(index => ({ prompt: `第${index}幕`, profileId: 'p-live-seq', continuity: index > 1 ? 'previous-tail' : 'none' })),
        }) } },
        { type: 'response.completed', response: { id: 'resp-create', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: null, output_tokens_details: null } } },
      ]);
      return;
    }
    continuationCount += 1;
    requests.push({ leg: `continuation-${continuationCount}` });
    if (continuationCount === 1) {
      // Read the actual durable identity; do not race the outer UI polling
      // loop or invent an id from a timer-dependent shared variable.
      const page = await rpc('job/list', {workspaceId:studio.workspaceId(),typePrefix:'studio.sequence',limit:10});
      sequenceId = page.jobs[0]?.id;
      const deadline = Date.now() + 45000;
      do { const view = await studio.handlers['studio/sequence/read']({id:sequenceId}); lastStatus = view.state; if (['completed','failed','blocked'].includes(lastStatus)) break; await delay(100); } while (Date.now() < deadline);
      sse([
        { type: 'response.created', response: { id: 'resp-status' } },
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'seq-2', namespace: mediaTool.name, name: 'media_sequence_status', arguments: JSON.stringify({ id: sequenceId ?? '' }) } },
        { type: 'response.completed', response: { id: 'resp-status', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: null, output_tokens_details: null } } },
      ]);
      return;
    }
    const invoke = (name, args) => sse([
      { type: 'response.created', response: { id: `edit-${continuationCount}` } },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: `edit-${continuationCount}`, namespace: mediaTool.name, name, arguments: JSON.stringify(args) } },
      { type: 'response.completed', response: { id: `edit-${continuationCount}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]);
    if (continuationCount === 2) { invoke('media_edit', { action: 'create', sequenceId }); return; }
    if (continuationCount === 3 || continuationCount === 4) {
      const page = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: 'studio.edit', limit: 1 });
      const project = page.jobs[0], c = project?.checkpoint;
      if (!c) { done('edit project missing'); return; }
      if (continuationCount === 3) invoke('media_subtitles', { action: 'import', id: project.id, revision: c.revision, content: '1\n00:00:00,000 --> 00:00:00,100\nAgent caption\n' });
      else invoke('media_retake', { action: 'start', id: project.id, revision: c.revision, clipId: c.edit.clips[0].id, startFrame: 0, endFrame: Math.min(6, c.edit.clips[0].endFrame), profileId: 'p-live-seq', prompt: 'Local fixture retake', idempotencyKey: 'agent-retake' });
      return;
    }
    if (continuationCount === 5) {
      const page = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: 'studio.retake', limit: 1 });
      const retakeId = page.jobs[0]?.id;
      if (!retakeId) { done('retake missing'); return; }
      const deadline = Date.now() + 30000;
      do { const j = await studio.handlers['studio/edit/retake/read']({ id: retakeId }); if (['succeeded', 'failed'].includes(j.status)) break; await delay(100); } while (Date.now() < deadline);
      invoke('media_retake', { action: 'status', id: retakeId }); return;
    }
    if (continuationCount === 6) { invoke('article_video', { action: 'create', title: 'Agent article workflow', article: 'An article grounded in actual voice timing.', idempotencyKey: 'agent-article' }); return; }
    if (continuationCount === 7) { const page = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: 'studio.article', limit: 1 }); invoke('article_video', { action: 'save', id: page.jobs[0].id, revision: page.jobs[0].checkpoint.revision, narration: 'A clear message comes first.' }); return; }
    done(`sequence, captions, retake and article reported: ${lastStatus ?? 'unknown'}`);
  });
  let sequenceId = null; let lastStatus = null;
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const modelPort = model.address().port;

  let daemonRpc = async () => { throw new Error('daemon not ready'); };
  const lazyRpc = (...args) => daemonRpc(...args);
  const library = createPersonalLibrary({ home, rpc: lazyRpc });
  const studio = createMediaStudio({ home, rpc: lazyRpc, library, safeStorage: fakeSafeStorage(), pollMs: 50 });
  const studioMcp = await createStudioMcp({ getStudio: () => studio, getLibrary: () => library });
  const env = { ...process.env, KNORVIA_PROVIDER_PROTOCOL:'responses', KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1', KNORVIA_KERNEL_TURN_TIMEOUT_SECS: '90', KNORVIA_PROVIDER_API_KEY: 'local-fixture-only', KNORVIA_PROVIDER_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, KNORVIA_PROVIDER_MODEL: 'knorvia-fixture-model', KNORVIA_DAEMON_BIN: daemonBin, KNORVIA_KERNEL_BIN: kernelBin, ...studioMcp.env };
  const session = startKnorviaDaemon({ daemonBin, home, env, requestTimeoutMs: 30_000 });
  let diagnostics = '';
  session.child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
  let seq = 0;
  const rpc = async (method, params = {}) => {
    const response = await session.request({ jsonrpc: '2.0', id: `${++seq}`, method, params });
    if (response.error) { const error = new Error(`${method}: ${JSON.stringify(response.error)}`); error.rpc = response.error; throw error; }
    return response.result;
  };
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
  try {
    const init = await session.request(initializeRequest('knorvia_sequence_agent', '1'), { timeoutMs: 60_000 });
    assert.ok(!init.error, JSON.stringify(init));
    session.notify({ jsonrpc: '2.0', method: 'initialized' });
    daemonRpc = rpc;
    await studio.initialize();
    studio.profiles.save({ id: 'p-live-seq', name: 'live sequence video', kind: 'video', protocol: 'fal', baseUrl: mediaOrigin, model: 'fal-ai/live/sequence-video', apiKey: 'local-fixture-only', agentEnabled: true, extra: {}, custom: { firstFrameField: 'start_image_url', lastFrameField: 'end_image_url' } });

    const ws = await rpc('workspace/create', { title: 'sequence agent', cwd: home });
    const thread = await rpc('thread/start', { workspaceId: ws.id, title: 'sequence via agent' });
    const admitted = await rpc('turn/start', { threadId: thread.id, input: 'create and then report a three-shot sequence', tools: { write: true } });
    const turnId = admitted.turn?.id || admitted.id;
    const deadline = Date.now() + 240_000;
    let turn;
    do {
      await delay(250);
      turn = await rpc('turn/read', { id: turnId });
      if (turn.pendingApprovalId) await rpc('approval/respond', { id: turn.pendingApprovalId, decision: 'allow' }).catch(() => { });
      const snapshot = await rpc('thread/read', { id: thread.id }).catch(() => null);
      for (const entry of snapshot?.pendingApprovals || []) {
        if (entry.turnId === turnId) await rpc('approval/respond', { id: entry.id, decision: 'allow' }).catch(() => { });
      }
      // While the agent works, capture the created sequence id for the
      // scripted status query and let the studio chain finish.
      if (!sequenceId) {
        const page = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: 'studio.sequence', offset: 0, limit: 10 }).catch(() => null);
        if (page?.total) {
          sequenceId = page.jobs[0].id;
          const view = await studio.handlers['studio/sequence/read']({ id: sequenceId });
          lastStatus = view.state;
        }
      } else {
        const view = await studio.handlers['studio/sequence/read']({ id: sequenceId }).catch(() => null);
        if (view) lastStatus = view.state;
      }
    } while (!TERMINAL.has(turn.status) && Date.now() < deadline);
    assert.ok(TERMINAL.has(turn.status), `turn never finished: ${diagnostics}`);
    assert.equal(turn.status, 'completed', `turn failed: ${JSON.stringify(turn.items?.slice(-3))}\n${diagnostics}`);
    const createLeg = requests.find(request => request.leg === 'create');
    assert.ok(createLeg?.subTools?.includes('media_sequence_create'), `media_sequence_create was not surfaced: ${JSON.stringify(requests)}`);
    // The agent-mediated path created exactly one durable sequence, and the
    // chain itself ran to completion in the Rust store.
    const page = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: 'studio.sequence', offset: 0, limit: 10 });
    assert.equal(page.total, 1);
    const view = await studio.handlers['studio/sequence/read']({ id: page.jobs[0].id });
    assert.equal(view.state, 'completed', `state=${view.state} blocked=${view.blockedReason ?? ''}`);
    assert.equal(view.shots.filter(shot => shot.status === 'completed').length, 3);
    assert.equal(media.hits.video, 4);
    const edits = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: 'studio.edit', limit: 1 });
    assert.equal(edits.jobs[0].checkpoint.edit.captions[0].text, 'Agent caption');
    const retakes = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: 'studio.retake', limit: 1 });
    assert.equal(retakes.total, 1); assert.equal(retakes.jobs[0].status, 'succeeded');
    assert.equal(retakes.jobs[0].checkpoint.agentRequested, true);
    const articles = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: 'studio.article', limit: 1 });
    assert.equal(articles.total, 1); assert.equal(articles.jobs[0].checkpoint.narration, 'A clear message comes first.');
  } finally {
    fs.writeFileSync(path.join(runtimeEvidence, 'agent-sequence-result.json'), JSON.stringify({home,kernelBin,daemonBin,requests,sequenceId,lastStatus,hits:media.hits,diagnostics},null,2));
    await studio.close().catch(() => { });
    await studioMcp.close().catch(() => { });
    if (session.child.exitCode === null) {
      session.child.stdin.end();
      await Promise.race([once(session.child, 'close'), delay(10_000).then(() => session.child.kill())]);
    }
    media.close();
    model.close(); model.closeAllConnections();
    await delay(200);
  }
});

test('live chain: three shots auto-continue through real tail frames in the Rust store', {
  skip: !fs.existsSync(daemonBin) || !ffmpegAvailable, timeout: 300_000,
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-sequence-live-'));
  const media = startShotFixture();
  const mediaOrigin = await media.originReady;
  let daemonRpc = async () => { throw new Error('daemon session not ready yet'); };
  const lazyRpc = (...args) => daemonRpc(...args);
  const library = createPersonalLibrary({ home, rpc: lazyRpc });
  const studio = createMediaStudio({ home, rpc: lazyRpc, library, safeStorage: fakeSafeStorage(), pollMs: 50 });
  const env = { ...process.env, KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1', KNORVIA_DAEMON_BIN: daemonBin };
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
    const init = await session.request(initializeRequest('knorvia_sequence_live', '1'), { timeoutMs: 60_000 });
    assert.ok(!init.error, JSON.stringify(init));
    session.notify({ jsonrpc: '2.0', method: 'initialized' });
    daemonRpc = rpc;
    assert.equal((await rpc('system/health')).ok, true);

    await studio.initialize();
    studio.profiles.save({ id: 'p-live-seq', name: 'live sequence video', kind: 'video', protocol: 'fal', baseUrl: mediaOrigin, model: 'fal-ai/live/sequence-video', apiKey: 'local-fixture-only', agentEnabled: true, extra: {}, custom: { firstFrameField: 'start_image_url' } });

    const sequence = await studio.handlers['studio/sequence/create']({
      title: 'live 三段串联', globalPrompt: '统一画风：水墨',
      defaults: { profileId: 'p-live-seq', seconds: 4 },
      idempotencyKey: 'live-seq-1', start: true,
      shots: [1, 2, 3].map(index => ({ prompt: `第${index}幕`, profileId: 'p-live-seq', continuity: index > 1 ? 'previous-tail' : 'none' })),
    });
    const deadline = Date.now() + 240_000;
    let view;
    do {
      await delay(250);
      view = await studio.handlers['studio/sequence/read']({ id: sequence.id });
    } while (view.state !== 'completed' && view.state !== 'failed' && view.state !== 'needs-attention' && Date.now() < deadline);
    assert.equal(view.state, 'completed', `state=${view.state} blocked=${view.blockedReason ?? ''} shots=${JSON.stringify(view.shots.map(s => ({ status: s.status, error: s.error, job: s.job })))}\n${diagnostics}`);
    assert.equal(media.hits.video, 3, 'exactly three provider submits');

    // The chain: each continuation's pinned first frame equals the previous
    // shot's exported tail-frame library version.
    const tails = view.shots.map(shot => shot.result.tailFrame);
    assert.equal(view.shots[1].firstFrame.version, tails[0].libraryVersion);
    assert.equal(view.shots[2].firstFrame.version, tails[1].libraryVersion);
    assert.notEqual(tails[0].libraryVersion, tails[2].libraryVersion, 'per-shot fixture videos make distinct tail frames');
    // The submitted shot jobs actually carried the pinned first frames, and
    // every job records a usage attempt even when the fixture is silent.
    for (const [index, shot] of view.shots.entries()) {
      if (!index) continue;
      const job = await rpc('job/read', { id: shot.jobId });
      assert.equal(job.checkpoint.input.firstFrame.version, tails[index - 1].libraryVersion);
    }
    for (const shot of view.shots) {
      const job = await rpc('job/read', { id: shot.jobId });
      assert.ok(job.checkpoint.usage, `shot job checkpoint must carry usage: ${shot.jobId}`);
      assert.equal(job.checkpoint.usage.attempts.length, 1);
      assert.equal(job.checkpoint.usage.attempts[0].known, false, 'fixture returns no usage; known stays false without zeros');
      assert.deepEqual(job.checkpoint.usage.attempts[0].units, []);
    }

    // Tail frames are durable personal-library entries, idempotent per job.
    const index = await library.handlers['library/list']();
    const tailEntries = index.entries.filter(entry => entry.path.startsWith('创作/尾帧/'));
    assert.equal(tailEntries.length, 3, `three tail-frame library entries: ${JSON.stringify(index.entries.map(e => e.path))}`);

    // The Rust store holds one sequence root and three shot jobs.
    const studioWs = await rpc('workspace/create', { title: '个人创作', idempotencyKey: 'media-studio-workspace-v1' });
    const roots = await rpc('job/list', { workspaceId: studioWs.id, typePrefix: 'studio.sequence', offset: 0, limit: 50 });
    assert.equal(roots.total, 1);
    assert.equal(roots.jobs[0].status, 'succeeded');
    const mediaJobs = await rpc('job/list', { workspaceId: studioWs.id, typePrefix: 'media.', offset: 0, limit: 50 });
    assert.equal(mediaJobs.total, 3);
    assert.ok(mediaJobs.jobs.every(job => job.status === 'succeeded'));
    // Three published artifacts with provenance linking the chain.
    const artifacts = await rpc('artifact/list', { workspaceId: studioWs.id });
    const mediaArtifacts = artifacts.filter(artifact => artifact.type === 'application/vnd.knorvia.media+json');
    assert.equal(mediaArtifacts.length, 3);
  } finally {
    await studio.close().catch(() => { });
    if (session.child.exitCode === null) {
      session.child.stdin.end();
      await Promise.race([once(session.child, 'close'), delay(10_000).then(() => session.child.kill())]);
    }
    media.close();
    await delay(200);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
