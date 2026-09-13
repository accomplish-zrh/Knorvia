'use strict';

// Real Kernel + MCP + Rust store acceptance. The scripted local model only
// creates drafts; a separate loopback counter proves no media is generated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { compileCanvas, compileSequence } = require('../builtin-skills/short-drama/scripts/compile-story.cjs');
const { createKernelEngine } = require('../kernel-engine');
const { ensureBuiltinSkills } = require('../builtin-skills');
const { createMediaStudio } = require('../media-studio');
const { createStudioMcp, callMediaTool } = require('../studio-mcp');
const { createPersonalLibrary } = require('../personal-library');
const { createExtensionManager } = require('../extension-manager');
const yazl = require('yazl');

const skillRoot = path.join(__dirname, '../builtin-skills/short-drama');
const example = () => JSON.parse(fs.readFileSync(path.join(skillRoot, 'assets/example-story.json'), 'utf8'));
const available = [process.env.KNORVIA_DAEMON_BIN, process.env.KNORVIA_KERNEL_BIN].every(p => p && fs.existsSync(p));
const storage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => Buffer.from(b).toString() };

function removeTestHome(home) {
  const relative = path.relative(os.tmpdir(), path.resolve(home));
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(home).startsWith('knorvia-drama-'));
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('installed short-drama skill includes its executable assets and preserves local edits', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-drama-seed-'));
  try {
    ensureBuiltinSkills(home);
    const installed = path.join(home, 'state/kernel/skills/short-drama');
    const entry = path.join(installed, 'SKILL.md');
    fs.appendFileSync(entry, '\nMy preferred story structure.\n');
    ensureBuiltinSkills(home);
    assert.match(fs.readFileSync(entry, 'utf8'), /My preferred story structure/);
    const installedCompiler = require(path.join(installed, 'scripts/compile-story.cjs'));
    const plan = JSON.parse(fs.readFileSync(path.join(installed, 'assets/example-story.json'), 'utf8'));
    assert.ok(installedCompiler.compileCanvas(plan).nodes.length >= plan.shots.length * 2);
    assert.equal(installedCompiler.compileSequence(plan, { videoProfileId: 'test-video' }).start, false);
  } finally { removeTestHome(home); }
});

test('short-drama ZIP installs and compiles from the extension directory without the source checkout', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-drama-zip-'));
  let manager;
  try {
    const input = path.join(home, 'input'); fs.mkdirSync(input);
    const zipPath = path.join(input, 'short-drama.zip'), zip = new yazl.ZipFile();
    const files = ['SKILL.md', 'agents/openai.yaml', 'assets/example-story.json', 'references/plan.md', 'references/workflow.md', 'scripts/compile-story.cjs'];
    for (const rel of files) zip.addFile(path.join(skillRoot, rel), `short-drama/${rel}`);
    const saved = new Promise((resolve, reject) => zip.outputStream.pipe(fs.createWriteStream(zipPath, { flags: 'wx' })).on('close', resolve).on('error', reject));
    zip.end(); await saved;
    const rpc = async (method, params) => {
      if (method === 'workspace/path/resolve') {
        assert.equal(params.workspaceId, 'drama-input');
        assert.equal(params.path, 'short-drama.zip');
        return { workspace: { id: 'drama-input', cwd: input }, absolutePath: zipPath, kind: 'file' };
      }
      if (method === 'skills/list') return { data: [{ skills: [{ name: 'short-drama', enabled: true }] }] };
      throw new Error(`Unexpected extension RPC: ${method}`);
    };
    manager = createExtensionManager({ home, rpc });
    const source = { type: 'local', workspaceId: 'drama-input', path: 'short-drama.zip' };
    const inspection = await manager.handlers['extension/inspect']({ source });
    assert.equal(inspection.report.format, 'agent-skill');
    let entry = await manager.handlers['extension/install']({ source, expectedSha256: inspection.sha256 });
    assert.equal(entry.enabled, false);
    entry = await manager.handlers['extension/enable']({ id: entry.id, revision: entry.revision, enabled: true });
    const installedRoot = path.join(home, 'state/kernel/skills');
    const installed = fs.readdirSync(installedRoot).map(name => path.join(installedRoot, name)).find(dir => fs.existsSync(path.join(dir, 'SKILL.md')));
    assert.ok(installed);
    for (const rel of files) assert.deepEqual(fs.readFileSync(path.join(installed, rel)), fs.readFileSync(path.join(skillRoot, rel)), rel);
    const compiler = require(path.join(installed, 'scripts/compile-story.cjs'));
    const plan = JSON.parse(fs.readFileSync(path.join(installed, 'assets/example-story.json')));
    assert.equal(compiler.compileCanvas(plan).action, 'create');
    assert.equal(compiler.compileSequence(plan, { videoProfileId: 'fixture-video' }).start, false);
    await manager.handlers['extension/enable']({ id: entry.id, revision: entry.revision, enabled: false });
    assert.equal(fs.existsSync(path.join(installed, 'SKILL.md')), false);
    assert.ok(fs.existsSync(zipPath), 'Disabling must preserve the input archive');
  } finally { await manager?.close(); removeTestHome(home); }
});

async function startPlanningModel(scenario) {
  const calls = [], evidence = { advertised: false, surfaced: false };
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw);
      evidence.advertised ||= raw.includes('short-drama') && raw.includes('SKILL.md');
      const media = (body.tools || []).find(t => t.name?.includes('knorvia_media'));
      evidence.surfaced ||= ['media_canvas', 'media_sequence_create'].every(name => media?.tools?.some(t => t.name === name));
      const outputs = (Array.isArray(body.input) ? body.input : []).filter(i => i.type === 'function_call_output');
      const seen = new Set(outputs.map(i => i.call_id));
      const next = !seen.has('drama-canvas') ? ['drama-canvas', 'media_canvas', scenario.canvas] : !seen.has('drama-sequence') ? ['drama-sequence', 'media_sequence_create', scenario.sequence] : null;
      const id = `response-${calls.length + 1}`;
      calls.push({ tool: next?.[1] || null, outputs });
      const item = next && media ? { type: 'function_call', call_id: next[0], namespace: media.name, name: next[1], arguments: JSON.stringify(next[2]) } : { type: 'message', role: 'assistant', id: `message-${calls.length}`, content: [{ type: 'output_text', text: 'Local fixture drafted the story. No generation was requested.' }] };
      const events = [
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: null, output_tokens_details: null } } },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    calls, evidence,
    env: {
      KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1', KNORVIA_KERNEL_TURN_TIMEOUT_SECS: '90',
      KNORVIA_PROVIDER_API_KEY: 'local-fixture-only',
      KNORVIA_PROVIDER_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      KNORVIA_PROVIDER_MODEL: 'knorvia-fixture-model',
    },
    close() { server.closeAllConnections(); server.close(); },
  };
}

test('a real Kernel discovers short-drama and saves compiled canvas and queue without generation, surviving restart', { skip: !available, timeout: 150000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-drama-live-'));
  let engine, studio, mcp, mediaHits = 0;
  const media = http.createServer((req, res) => { mediaHits++; req.resume(); res.writeHead(500); res.end('Generation is forbidden in this planning acceptance.'); });
  media.listen(0, '127.0.0.1'); await once(media, 'listening');
  const scenario = {}, model = await startPlanningModel(scenario);
  const rpc = (...args) => engine.rpc(...args);
  const library = createPersonalLibrary({ home, rpc });
  try {
    studio = createMediaStudio({ home, rpc, library, safeStorage: storage, pollMs: 50 });
    mcp = await createStudioMcp({ getStudio: () => studio, getLibrary: () => library });
    const env = { ...process.env, ...model.env, ...mcp.env };
    engine = await createKernelEngine({ home, env, legacyChatBridge: false });
    const listed = await rpc('skills/list', { forceReload: true });
    const skill = listed.data.flatMap(g => g.skills).find(s => s.name === 'short-drama');
    assert.ok(skill, JSON.stringify(listed));
    assert.ok(path.resolve(skill.path).startsWith(home + path.sep));
    await studio.initialize();
    studio.profiles.save({ id: 'drama-video', name: 'Draft fixture only', kind: 'video', protocol: 'fal', baseUrl: `http://127.0.0.1:${media.address().port}`, model: 'fixture/video', apiKey: 'local-fixture-only', agentEnabled: true, extra: {}, custom: { firstFrameField: 'start_image_url', lastFrameField: 'end_image_url' } });
    const cwd = path.join(home, 'workspace'); fs.mkdirSync(cwd);
    const workspace = await rpc('workspace/create', { title: 'Short drama acceptance', cwd });
    const thread = await rpc('thread/start', { workspaceId: workspace.id, title: 'Story drafts', cwd });
    const plan = example();
    scenario.canvas = compileCanvas(plan, { videoProfileId: 'drama-video', threadId: thread.id });
    scenario.sequence = compileSequence(plan, { videoProfileId: 'drama-video' });
    const admitted = await rpc('turn/start', { threadId: thread.id, input: 'Use the short-drama skill to create the prepared canvas and an unstarted storyboard queue. Do not generate media.', tools: { write: true }, cwd });
    const turnId = admitted.turn?.id || admitted.id, deadline = Date.now() + 90000;
    let turn;
    do {
      await delay(150); turn = await rpc('turn/read', { id: turnId });
      if (turn.pendingApprovalId) await rpc('approval/respond', { id: turn.pendingApprovalId, decision: 'allow' });
      const snapshot = await rpc('thread/read', { id: thread.id });
      for (const approval of snapshot.pendingApprovals || []) if (approval.turnId === turnId) await rpc('approval/respond', { id: approval.id, decision: 'allow' }).catch(() => {});
    } while (!['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.status) && Date.now() < deadline);
    assert.equal(turn.status, 'completed', JSON.stringify(turn));
    assert.equal(model.evidence.advertised, true);
    assert.equal(model.evidence.surfaced, true);
    assert.deepEqual(model.calls.filter(c => c.tool).map(c => c.tool), ['media_canvas', 'media_sequence_create']);

    // Read the results from the product store before any test-side create call.
    const canvases = await studio.handlers['studio/canvas/list']({});
    const sequences = await studio.handlers['studio/sequence/list']({});
    assert.equal(canvases.canvases.length, 1, JSON.stringify(canvases));
    assert.equal(sequences.sequences.length, 1, JSON.stringify(sequences));
    const canvasId = canvases.canvases[0].id, sequenceId = sequences.sequences[0].id;
    const canvas = await studio.handlers['studio/canvas/read']({ id: canvasId });
    const sequence = await studio.handlers['studio/sequence/read']({ id: sequenceId });
    assert.equal(canvas.threadId, thread.id);
    assert.equal(canvas.nodes.filter(n => n.kind === 'video').length, plan.shots.length);
    assert.equal(canvas.nodes.some(n => n.jobId), false);
    assert.equal(sequence.state, 'ready');
    assert.equal(sequence.shots.length, plan.shots.length);
    assert.equal(sequence.shots.some(s => s.jobId), false);
    assert.equal(mediaHits, 0);
    assert.equal((await callMediaTool({ studio, library, name: 'media_canvas', params: scenario.canvas })).id, canvasId);
    assert.equal((await callMediaTool({ studio, library, name: 'media_sequence_create', params: scenario.sequence })).id, sequenceId);
    await studio.close(); await engine.shutdown();
    engine = await createKernelEngine({ home, env, legacyChatBridge: false });
    studio = createMediaStudio({ home, rpc, library, safeStorage: storage, pollMs: 50 });
    await studio.initialize();
    assert.equal((await studio.handlers['studio/canvas/read']({ id: canvasId })).nodes.length, canvas.nodes.length);
    assert.equal((await studio.handlers['studio/sequence/read']({ id: sequenceId })).state, 'ready');
    assert.equal((await studio.handlers['studio/sequence/list']({})).total, 1);
    assert.equal(mediaHits, 0, 'Restarting a draft must not dispatch any media request');
  } finally {
    await studio?.close(); await mcp?.close(); await engine?.shutdown(); model.close();
    media.closeAllConnections(); media.close(); removeTestHome(home);
  }
});
