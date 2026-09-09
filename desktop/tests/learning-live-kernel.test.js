'use strict';

// A real Kernel turn calls the learning MCP tool. A separate CLI process reads
// the identical pinned library version; no hosted model or paid tool is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { createKernelEngine } = require('../kernel-engine');
const { createPersonalLibrary } = require('../personal-library');
const { createLearningPack } = require('../learning-pack');
const { createStudioMcp } = require('../studio-mcp');
const { createCreativeCliService } = require('../creative-cli-service');
const run = promisify(execFile);

test('B11 real Kernel learning tool + external CLI share durable source and lecture versions', { timeout: 180000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-learning-live-'));
  const workspace = path.join(home, 'workspace'); fs.mkdirSync(workspace);
  let engine, mcp, service, source; const requests = [];
  const model = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks));
    const namespace = body.tools?.find(t => t.tools?.some(s => s.name === 'learning_lecture'));
    const continuation = JSON.stringify(body.input).includes('learning-fixture-call');
    requests.push({ namespace: namespace?.name, continuation, input: body.input });
    const item = continuation || !namespace
      ? { type: 'message', role: 'assistant', id: 'learning-message', content: [{ type: 'output_text', text: continuation ? 'Saved the sourced lecture.' : 'Learning tool unavailable.' }] }
      : { type: 'function_call', namespace: namespace.name, name: 'learning_lecture', call_id: 'learning-fixture-call', arguments: JSON.stringify({ action: 'create', topic: '本地测试讲义', authorship: 'deterministic', sourceRefs: [{ id: source.id, version: source.sha256 }] }) };
    const events = [{ type: 'response.created', response: { id: `resp-${requests.length}` } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id: `resp-${requests.length}`, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: null, output_tokens_details: null } } }];
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  try {
    const rpc = (method, params = {}) => engine.rpc(method, params);
    const library = createPersonalLibrary({ home, rpc });
    const learning = createLearningPack({ home, library, rpc });
    mcp = await createStudioMcp({ getStudio: () => ({}), getLibrary: () => library, getLearning: () => learning });
    const kernelRoot = path.resolve(__dirname, '../../../knorvia-kernel');
    engine = await createKernelEngine({ home, version: 'learning-live-test', env: { ...process.env,
      KNORVIA_DAEMON_BIN: process.env.KNORVIA_DAEMON_BIN || path.join(kernelRoot, 'knorvia-rs/target/release/knorvia-daemon.exe'),
      KNORVIA_KERNEL_BIN: process.env.KNORVIA_KERNEL_BIN || path.join(kernelRoot, 'codex-rs/target/debug/codex-app-server.exe'),
      KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1', KNORVIA_PROVIDER_API_KEY: 'local-fixture-only',
      KNORVIA_PROVIDER_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, KNORVIA_PROVIDER_MODEL: 'knorvia-fixture-model', ...mcp.env,
    } });
    service = createCreativeCliService({ home, rpc, library, studio: {}, learning }); await service.listen();
    const cli = async (command, params = {}) => {
      const { stdout } = await run(process.execPath, [path.join(__dirname, '../creative-cli.js'), '--home', home, command, JSON.stringify(params)], { windowsHide: true, timeout: 30000 });
      const body = JSON.parse(stdout); assert.equal(body.ok, true, stdout); return body.result;
    };
    source = await cli('library.write', { path: '资料/本地测试.md', text: '# 核心概念\n证据必须固定到资料版本。\n' });
    assert.ok((await cli('tools.list')).tools.some(t => t.name === 'learning_lecture'));
    const ws = await rpc('workspace/create', { title: 'Learning fixture', cwd: workspace });
    const thread = await rpc('thread/start', { workspaceId: ws.id, title: 'Learning fixture', cwd: workspace });
    const admitted = await rpc('turn/start', { threadId: thread.id, input: 'Use learning_lecture to organize the provided source.', tools: { write: true }, cwd: workspace });
    const turnId = admitted.turn?.id || admitted.id; let turn;
    const deadline = Date.now() + 120000;
    do {
      await delay(150); turn = await rpc('turn/read', { id: turnId });
      if (turn.pendingApprovalId) await rpc('approval/respond', { id: turn.pendingApprovalId, decision: 'allow' }).catch(() => {});
      const snapshot = await rpc('thread/read', { id: thread.id });
      for (const approval of snapshot.pendingApprovals || []) if (approval.turnId === turnId) await rpc('approval/respond', { id: approval.id, decision: 'allow' }).catch(() => {});
    } while (!['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.status) && Date.now() < deadline);
    assert.equal(turn.status, 'completed', JSON.stringify(turn));
    assert.ok(requests[0].namespace, 'the real Kernel must surface learning tools to the model');
    assert.ok(requests.some(r => r.continuation), 'the model must receive the actual tool result');
    const listing = await cli('library.list');
    const entry = listing.entries.find(e => e.path.startsWith('learning/讲座/')); assert.ok(entry);
    const lecture = await cli('learning.lecture.read', { path: entry.path });
    assert.equal(lecture.revision, 1); assert.equal(lecture.sha256, entry.sha256);
    assert.equal(lecture.sourceRefs[0].version, source.sha256);
    const direct = await learning.commands['learning/lecture/read']({ path: entry.path });
    assert.deepEqual(lecture, JSON.parse(JSON.stringify(direct)), 'UI handlers and independent CLI read one artifact');
    const reopened = createLearningPack({ home, library: createPersonalLibrary({ home, rpc }), rpc });
    assert.deepEqual(JSON.parse(JSON.stringify(await reopened.commands['learning/lecture/read']({ path: entry.path }))), lecture, 'new service instance recovers the same version');
    await cli('library.write', { path: source.path, text: '# 已更新\n新资料版本。', expectedSha256: source.sha256 });
    assert.equal((await cli('learning.lecture.read', { path: entry.path })).sourceRefs[0].evidenceStatus, 'superseded');
  } finally {
    await service?.close(); await mcp?.close(); await engine?.shutdown(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    // Remove only this test's freshly allocated Home.
    fs.rmSync(home, { recursive: true, force: true });
  }
});
