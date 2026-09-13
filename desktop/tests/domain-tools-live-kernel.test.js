'use strict';

// Real daemon + Kernel + MCP + a separate CLI process. The Responses endpoint
// is a local scripted fixture; this is not a hosted-provider quality test.
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

test('real Kernel discovers and executes practice and creative review through MCP; CLI reads durable records', { skip: process.env.KNORVIA_RUN_DOMAIN_LIVE !== '1', timeout: 180000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-domain-live-'));
  const workspace = path.join(home, 'workspace'); fs.mkdirSync(workspace);
  let engine, mcp, service; const calls = []; const requests = [];
  const model = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const input = JSON.stringify(body.input);
    const next = calls.find(call => !input.includes(call.id));
    const namespace = next ? body.tools?.find(tool => tool.tools?.some(item => item.name === next.name)) : null;
    requests.push({ requestedTool: next?.name, namespace: namespace?.name, input });
    const item = next && namespace
      ? { type: 'function_call', namespace: namespace.name, name: next.name, call_id: next.id, arguments: JSON.stringify(next.args) }
      : { type: 'message', role: 'assistant', id: 'domain-message', content: [{ type: 'output_text', text: next ? 'Required domain tool missing.' : 'Practice and reviewed brief saved.' }] };
    const events = [{ type: 'response.created', response: { id: `domain-${requests.length}` } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id: `domain-${requests.length}`, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: null, output_tokens_details: null } } }];
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  try {
    const rpc = (method, params = {}) => engine.rpc(method, params);
    const library = createPersonalLibrary({ home, rpc });
    const learning = createLearningPack({ library });
    mcp = await createStudioMcp({ getStudio: () => ({}), getLibrary: () => library, getLearning: () => learning });
    engine = await createKernelEngine({ home, version: 'domain-live-test', env: { ...process.env, ...mcp.env,
      KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1', KNORVIA_PROVIDER_API_KEY: 'local-fixture-only',
      KNORVIA_PROVIDER_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, KNORVIA_PROVIDER_MODEL: 'knorvia-fixture-model',
    } });
    service = createCreativeCliService({ home, rpc, library, studio: {}, learning }); await service.listen();
    const cli = async (command, params = {}) => {
      const { stdout } = await promisify(execFile)(process.execPath, [path.join(__dirname, '../creative-cli.js'), '--home', home, command, JSON.stringify(params)], { windowsHide: true, timeout: 30000 });
      const body = JSON.parse(stdout); assert.equal(body.ok, true, stdout); return body.result;
    };
    const source = await cli('library.write', { path: '资料/fixture.md', text: '# Signal\nA periodic signal can be decomposed into sine waves.\n' });
    const output = await cli('library.write', { path: '作品/explainer.md', text: '# Signal explainer\nA periodic signal can be decomposed into sine waves.\n' });
    const evidence = { libraryId: source.id, version: source.sha256, line: 2, quote: 'A periodic signal can be decomposed into sine waves.' };
    const quiz = await cli('learning.quiz.create', { topic: 'Signal', authorship: 'agent', sourceRefs: [{ id: source.id }], questions: [{ id: 'q1', prompt: 'What is the basis?', options: ['sine waves', 'noise'], answerIndex: 0, evidence }] });
    const briefPath = 'creative/简报/live-brief.json';
    const sessionPath = 'learning/练习会话/live-session.json';
    calls.push(
      { id: 'domain-step-1', name: 'learning_practice', args: { action: 'start', quizPath: quiz.path, sessionId: 'live-session' } },
      { id: 'domain-step-2', name: 'learning_practice', args: { action: 'answer', path: sessionPath, questionId: 'q1', submissionId: 'live-answer', answerIndex: 0 } },
      { id: 'domain-step-3', name: 'creative_brief', args: { action: 'create', requestId: 'live-brief', title: 'Signal explainer', audience: 'Beginners', objective: 'Explain the source', format: 'Article', authorship: 'agent', sourceRefs: [{ id: source.id }], claims: [{ id: 'claim1', text: evidence.quote, evidence }], criteria: [{ id: 'coverage', description: 'Explains the signal basis.' }] } },
      { id: 'domain-step-4', name: 'creative_brief', args: { action: 'review', path: briefPath, reviewId: 'live-review', reviewer: 'agent', outputRefs: [{ id: output.id }], evaluations: [{ criterionId: 'coverage', outcome: 'pass', note: 'The supplied fixture article contains the cited basis.' }] } },
    );
    const ws = await rpc('workspace/create', { title: 'Domain fixture', cwd: workspace });
    const thread = await rpc('thread/start', { workspaceId: ws.id, title: 'Domain fixture', cwd: workspace });
    const started = await rpc('turn/start', { threadId: thread.id, input: 'Run the four scripted domain tool calls; the learner selected option 0. Save and review the provided article.', tools: { write: true }, cwd: workspace });
    const turnId = started.turn?.id || started.id; const deadline = Date.now() + 120000; let turn;
    do {
      await delay(150); turn = await rpc('turn/read', { id: turnId });
      const snapshot = await rpc('thread/read', { id: thread.id });
      for (const approval of snapshot.pendingApprovals ?? []) if (approval.turnId === turnId) await rpc('approval/respond', { id: approval.id, decision: 'allow' });
    } while (!['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.status) && Date.now() < deadline);
    assert.equal(turn.status, 'completed', JSON.stringify(turn));
    for (const call of calls) assert.ok(requests.some(request => request.input.includes(call.id)), `Kernel must receive the result of ${call.name}`);
    const session = await cli('learning.practice.read', { path: sessionPath });
    assert.equal(session.status, 'completed'); assert.equal(session.progress.answered, 1); assert.equal(session.lastFeedback.outcome, 'correct');
    const brief = await cli('creative.brief.read', { path: briefPath });
    assert.equal(brief.status, 'ready'); assert.equal(brief.reviews.length, 1);
    const reopened = createLearningPack({ library: createPersonalLibrary({ home, rpc }) });
    assert.deepEqual(JSON.parse(JSON.stringify(await reopened.callTool('creative_brief', { action: 'read', path: briefPath }))), brief);
    assert.equal((await cli('tools.call', { name: 'learning_practice', arguments: calls[1].args })).duplicate, true);
  } finally {
    await service?.close(); await mcp?.close(); await engine?.shutdown(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('knorvia-domain-live-'));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
