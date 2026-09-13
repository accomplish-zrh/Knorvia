'use strict';

// Creative CLI contract tests (KNORVIA-NIGHT B02/B04/B05/B06/B16).
// Offline tests cover the command contract, JSON envelope and error mapping
// against in-process fakes. One real-store test boots knorvia-daemon when
// KNORVIA_DAEMON_BIN is set and drives the same local material flow an
// external agent would, proving the workbench and the CLI see one truth.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createCreativeCliService, rpcToErrorCode, EXIT_CODES } = require('../creative-cli-service');
const { parseArgs, readParams, discoveryFor, exitFor, DEFAULT_HOME } = require('../creative-cli');
const { createLearningPack } = require('../learning-pack');
const { createCuratedCatalog } = require('../curated-catalog');
const { analyzeSkillDir } = require('../skill-preflight');
const { createPersonalLibrary } = require('../personal-library');

test('external CLI refuses non-loopback credential destinations and malformed commands', async () => {
  const { sendCommand } = require('../creative-cli');
  await assert.rejects(sendCommand({ url: 'https://example.com/creative-cli', token: 'private', command: 'status', params: {}, timeoutMs: 100 }), /本机回环/);
  await assert.rejects(sendCommand({ url: 'http://127.0.0.1:4420/creative-cli?redirect=x', token: 'private', command: 'status', params: {}, timeoutMs: 100 }), /本机回环/);
  assert.throws(() => parseArgs(['--url', 'http://127.0.0.1/creative-cli', 'status']), /一起提供/);
  assert.throws(() => parseArgs(['status', '--home']), /缺少参数/);
  assert.equal(parseArgs(['--help']).command, 'help');
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'creative-contract-'));
  const service = createCreativeCliService({ home, studio: fakeStudio(), library: {} });
  try {
    await assert.rejects(service.dispatch('toString', {}), /未知命令/);
    await assert.rejects(service.dispatch('status', []), /JSON 对象/);
    await service.listen();
    const record = JSON.parse(fs.readFileSync(service.discoveryFile, 'utf8'));
    fs.writeFileSync(service.discoveryFile, JSON.stringify({ ...record, token: 'another-instance' }));
    await service.close();
    assert.equal(JSON.parse(fs.readFileSync(service.discoveryFile, 'utf8')).token, 'another-instance', 'closing an old instance must preserve the new discovery');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

function fakeStudio() {
  const calls = [];
  return {
    calls,
    workspaceId: () => 'ws-test',
    profiles: new Map(),
    handlers: {
      'studio/models': async () => ({ profiles: [{ id: 'p1' }] }),
      'studio/read': async params => { calls.push(['read', params]); return { id: params.id, status: 'running' }; },
      'studio/cancel': async params => { calls.push(['cancel', params]); return { id: params.id, status: 'cancelled' }; },
      'studio/edit/read': async params => { calls.push(['edit/read', params]); return { id: params.id, revision: 3 }; },
    },
  };
}

test('CLI grammar accepts dotted commands, group/action pairs and JSON params', async () => {
  const a = parseArgs(['--home', 'x', 'tools', 'call', '{"name":"media_edit"}']);
  assert.equal(a.command, 'tools.call');
  assert.deepEqual(await readParams(a.paramsText), { name: 'media_edit' });
  const b = parseArgs(['learning.lecture.create', '{"topic":"t"}']);
  assert.equal(b.command, 'learning.lecture.create');
  assert.deepEqual(await readParams(b.paramsText), { topic: 't' });
  const c = parseArgs(['jobs', 'list']);
  assert.equal(c.command, 'jobs.list');
  assert.deepEqual(await readParams(c.paramsText), {});
  assert.equal(parseArgs(['--timeout', '100', 'status']).timeoutMs, 100);
  assert.equal(parseArgs(['status', '{}']).command, 'status');
  assert.throws(() => parseArgs(['--bogus']), /未知选项/);
  assert.throws(() => parseArgs([]), /缺少命令/);
  await assert.rejects(readParams('[]'), /JSON 对象/);
});

test('stable exit codes cover the documented error families', () => {
  assert.deepEqual(EXIT_CODES, { usage: 2, 'not-found': 3, conflict: 4, busy: 4, timeout: 5, 'dependency-missing': 6, failed: 7, refused: 8, unavailable: 8 });
  assert.equal(exitFor({ ok: true }), 0);
  assert.equal(exitFor({ ok: false, error: { code: 'conflict' } }), 4);
  assert.equal(exitFor({ ok: false, error: { code: 'mystery' } }), 7);
  assert.equal(rpcToErrorCode(Object.assign(new Error('x'), { rpc: { code: -32005 } })), 'conflict');
  assert.equal(rpcToErrorCode(Object.assign(new Error('x'), { rpc: { code: -32004 } })), 'not-found');
  assert.equal(rpcToErrorCode(Object.assign(new Error('x'), { rpc: { code: -32602 } })), 'usage');
  assert.equal(rpcToErrorCode(Object.assign(new Error('x'), { reason: 'dependency-missing' })), 'dependency-missing');
  assert.equal(rpcToErrorCode(new Error('x')), 'failed');
});

test('service enforces bearer token, loopback-only contract and stable envelope', async () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'creative-cli-'));
  const studio = fakeStudio();
  const service = createCreativeCliService({ home, library: null, studio, version: 'test' });
  const record = await service.listen();
  try {
    assert.equal(record.serviceVersion, 1);
    assert.match(record.url, /http:\/\/127\.0\.0\.1:\d+\/creative-cli/);
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'state', 'creative-cli.json'), 'utf8'));
    assert.equal(saved.token, record.token);
    const call = async (body, headers = {}) => {
      const response = await fetch(record.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: response.status, body: response.status === 200 ? await response.json() : null };
    };
    assert.equal((await call({ command: 'status' })).status, 403);
    assert.equal((await call({ command: 'status' }, { authorization: 'Bearer wrong' })).status, 403);
    assert.equal((await call({ command: 'status' }, { authorization: `Bearer ${record.token}`, origin: 'http://evil' })).status, 403);
    const ok = await call({ id: 1, command: 'status' }, { authorization: `Bearer ${record.token}` });
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.result.workspaceId, 'ws-test');
    const missing = await call({ command: 'tools.describe', params: { name: 'nope' } }, { authorization: `Bearer ${record.token}` });
    assert.equal(missing.body.ok, false);
    assert.equal(missing.body.error.code, 'not-found');
    const unknown = await call({ command: 'rpc.anything' }, { authorization: `Bearer ${record.token}` });
    assert.equal(unknown.body.error.code, 'usage');
    // Dot-form commands reach slash-keyed module handlers (learning/catalog);
    // unknown commands of either spelling are usage errors, never pass-through.
    const aliasMissing = await call({ command: 'learning/mastery/read' }, { authorization: `Bearer ${record.token}` });
    assert.equal(aliasMissing.body.error.code, 'usage');
    const tools = await call({ command: 'tools.list' }, { authorization: `Bearer ${record.token}` });
    assert.ok(tools.body.result.tools.length >= 18);
    assert.ok(tools.body.result.tools.every(tool => tool.inputSchema.additionalProperties === false));
    const describe = await call({ command: 'tools.describe', params: { name: 'media_edit' } }, { authorization: `Bearer ${record.token}` });
    assert.ok(describe.body.result.inputSchema.properties.action.enum.includes('import'));
    const jobsUnavailable = await call({ command: 'jobs.list' }, { authorization: `Bearer ${record.token}` });
    assert.equal(jobsUnavailable.body.error.code, 'unavailable');
  } finally {
    await service.close();
    assert.equal(discoveryFor(home), null, 'discovery file is removed when the service stops');
  }
});

test('CLI connects to a running service through the discovery file', async () => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const run = promisify(execFile);
  const cliPath = path.join(__dirname, '..', 'creative-cli.js');
  const runCli = async args => {
    try {
      const { stdout } = await run(process.execPath, [cliPath, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      return JSON.parse(stdout.trim());
    } catch (error) {
      return JSON.parse(String(error.stdout).trim());
    }
  };
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'creative-cli-attach-'));
  const service = createCreativeCliService({ home, library: null, studio: fakeStudio(), version: 'test' });
  const record = await service.listen();
  try {
    const found = discoveryFor(home);
    assert.equal(found.url, record.url);
    assert.equal(found.token, record.token);
    assert.equal(found.pid, process.pid);
    const body = await runCli(['--home', home, 'status']);
    assert.equal(body.ok, true);
    assert.equal(body.result.home, path.resolve(home));
    const bad = await runCli(['--home', home, 'tools.describe', '{"name":"nope"}']);
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'not-found');
    const schema = await runCli(['schema']);
    assert.ok(schema.result.commands.includes('jobs.wait'));
    assert.ok(schema.result.commands.includes('learning.attempt.record'));
    const orphan = await runCli(['--home', path.join(home, 'nope'), 'status']);
    assert.equal(orphan.ok, false);
    assert.equal(orphan.error.code, 'unavailable');
  } finally {
    await service.close();
    assert.equal(DEFAULT_HOME.length > 0, true);
  }
});

test('jobs.wait reports timeout without resubmitting; cancel routes by job family', async () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'creative-cli-wait-'));
  const running = { id: 'job_x', workspaceId: 'ws-test', type: 'studio.render', status: 'running', checkpoint: { phase: 'rendering' } };
  const reads = [];
  const rpc = async (method, params) => {
    reads.push([method, params]);
    if (method === 'job/read') return running;
    throw new Error('unexpected ' + method);
  };
  const studio = fakeStudio();
  const service = createCreativeCliService({ home, rpc, library: null, studio });
  const record = await service.listen();
  try {
    const wait = await service.dispatch('jobs.wait', { id: 'job_x', timeoutMs: 200 });
    assert.equal(wait.outcome, 'timeout');
    assert.equal(wait.job.status, 'running');
    assert.equal(reads.filter(([method]) => method === 'job/create').length, 0, 'waiting never creates or resubmits jobs');
    const cancelled = { ...running, status: 'cancelled' };
    studio.handlers['studio/edit/render/cancel'] = async () => { running.status = 'cancelled'; return cancelled; };
    const stop = await service.dispatch('jobs.cancel', { id: 'job_x' });
    assert.equal(stop.id, 'job_x');
    const waited = await service.dispatch('jobs.wait', { id: 'job_x', timeoutMs: 1000 });
    assert.equal(waited.outcome, 'terminal');
    assert.equal(waited.job.status, 'cancelled');
  } finally { await service.close(); }
});

test('serve attaches to a running service instead of booting a second stack', async () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'creative-cli-serve-'));
  const service = createCreativeCliService({ home, library: null, studio: fakeStudio(), version: 'test' });
  await service.listen();
  try {
    const { execFile } = require('node:child_process');
    const { promisify } = require('node:util');
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(__dirname, '..', 'creative-cli.js'), '--home', home, 'serve'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const body = JSON.parse(stdout.trim());
    assert.equal(body.ok, true);
    assert.equal(body.result.attached, true);
    assert.equal(body.result.url, service.address);
  } finally { await service.close(); }
});

test('learning pack: deterministic lecture, evidence currency, attempt dedup and mastery recovery', async () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'creative-cli-learn-'));
  const library = createPersonalLibrary({ home });
  const learning = createLearningPack({ home, library });
  const source = await library.handlers['library/write']({ path: '资料/课件.md', text: '# 概念\n\n周期信号可分解为正弦波叠加。\n\n## 应用\n\nDCT 是其实数版本。\n' });
  const refs = [{ id: source.id, version: source.sha256 }];
  const sources = await learning.commands['learning/sources']();
  assert.equal(sources.sources.length, 1);
  const lecture = await learning.commands['learning/lecture/create']({ topic: '信号', authorship: 'deterministic', sourceRefs: refs });
  assert.equal(lecture.sourceRefs[0].evidenceStatus, 'current');
  assert.ok(lecture.sections.length >= 2);
  assert.ok(lecture.sections[0].evidence.quote.includes('# 概念'));
  await assert.rejects(learning.commands['learning/lecture/create']({ topic: '信号', authorship: 'deterministic', sourceRefs: refs, outline: [{ heading: 'x', evidence: { libraryId: source.id, line: 1, quote: 'q' } }] }), /不接受外部大纲/);
  await assert.rejects(learning.commands['learning/quiz/create']({ topic: '信号', authorship: 'deterministic', sourceRefs: refs, questions: [{ prompt: 'p', evidence: { libraryId: source.id, line: 1, quote: 'q' } }] }), /教学判断/);
  const quiz = await learning.commands['learning/quiz/create']({ topic: '信号', authorship: 'agent', sourceRefs: refs, questions: [{ prompt: '周期信号可分解为什么？', options: ['正弦波', '方波'], answerIndex: 0, evidence: { libraryId: source.id, version: source.sha256, line: 3, quote: '周期信号可分解为正弦波叠加。' } }] });
  assert.equal(quiz.questions.length, 1);
  const badEvidence = learning.commands['learning/quiz/create']({ topic: '信号', authorship: 'agent', sourceRefs: refs, questions: [{ prompt: 'p', evidence: { libraryId: 'other', line: 1, quote: 'q' } }] });
  await assert.rejects(badEvidence, /已声明的资料库来源/);
  const quizPath = quiz.path;
  const first = await learning.commands['learning/attempt/record']({ path: quizPath, attemptId: 'a-1', results: [{ questionId: quiz.questions[0].id, outcome: 'correct' }] });
  assert.equal(first.duplicate, false);
  assert.equal(first.mastery.streak, 1);
  const dup = await learning.commands['learning/attempt/record']({ path: quizPath, attemptId: 'a-1', results: [{ questionId: quiz.questions[0].id, outcome: 'wrong' }] });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.mastery.attemptCount, 1, 'the same attemptId never counts twice');
  const other = await learning.commands['learning/quiz/create']({ topic: '几何', authorship: 'agent', sourceRefs: refs, questions: [{ prompt: 'p2', options: ['a', 'b'], answerIndex: 1, evidence: { libraryId: source.id, line: 1, quote: '概念' } }] });
  await learning.commands['learning/attempt/record']({ path: other.path, attemptId: 'a-2', results: [{ questionId: other.questions[0].id, outcome: 'wrong' }] });
  const mastery = await learning.commands['learning/mastery/read']();
  assert.equal(mastery.topics['信号'].attemptCount, 1);
  assert.equal(mastery.topics['几何'].streak, 0);
  await assert.rejects(learning.commands['learning/attempt/record']({ path: quizPath, attemptId: 'a-3', results: [{ questionId: 'ghost', outcome: 'correct' }] }), /没有题目/);
  const due = await learning.commands['learning/review/due']({ now: new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString() });
  assert.ok(due.due.length >= 2);
  const rebuilt = await learning.commands['learning/mastery/rebuild']();
  assert.equal(rebuilt.topics['信号'].attemptCount, 1);
  assert.equal(rebuilt.topics['几何'].attemptCount, 1);
  const corrected = await learning.commands['learning/attempt/correct']({ path: other.path, attemptId: 'a-2', questionId: other.questions[0].id, outcome: 'correct' });
  assert.equal(corrected.mastery.correctAttempts, 1, 'correcting an answer recomputes the durable aggregate');
  assert.equal(corrected.mastery.attemptCount, 1, 'correction is not a new attempt');
  const readQuiz = await learning.commands['learning/quiz/read']({ path: other.path });
  assert.equal(readQuiz.revision, 3, 'create, record and correction each persist one revision');
  assert.equal(readQuiz.questions[0].evidence.version, source.sha256, 'omitted evidence version is pinned to the declared source');
  await assert.rejects(learning.commands['learning/attempt/record']({ path: other.path, attemptId: 'duplicate-question', results: [{ questionId: other.questions[0].id, outcome: 'correct' }, { questionId: other.questions[0].id, outcome: 'wrong' }] }), /重复提交/);
  // Source update marks old evidence superseded; the artifact stays readable.
  const updated = await library.handlers['library/write']({ path: '资料/课件.md', text: '# 概念 v2\n', expectedSha256: source.sha256 });
  const reread = await learning.commands['learning/lecture/read']({ path: lecture.path });
  assert.equal(reread.sourceRefs[0].evidenceStatus, 'superseded');
  assert.equal(updated.sha256.length, 64);
});

test('skill preflight reports missing frontmatter, CLI and model facts without auto-fixing', () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'creative-cli-preflight-'));
  const skillDir = path.join(home, 'skill-a');
  fs.mkdirSync(skillDir, { recursive: true });
  const broken = analyzeSkillDir(skillDir);
  assert.equal(broken.loadable, false);
  assert.ok(broken.issues.some(issue => issue.code === 'missing-skill-md'));
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: demo skill\ncli-dependencies: definitely-not-installed-cli\n---\n# Demo\n');
  const analysis = analyzeSkillDir(skillDir, { modelProfiles: 0 });
  assert.equal(analysis.loadable, false);
  assert.ok(analysis.checks.some(check => check.name === 'cli:definitely-not-installed-cli' && check.ok === false));
  assert.ok(analysis.checks.some(check => check.name === 'model-profiles' && check.ok === false));
  assert.ok(analysis.issues.some(issue => issue.code === 'cli-missing'));
  const good = analyzeSkillDir(path.join(__dirname, '..', 'builtin-skills', 'remotion-best-practices'));
  assert.equal(good.loadable, true, `remotion skill should preflight clean: ${JSON.stringify(good.issues)}`);
});

test('curated catalog separates builtin, needs-config and needs-install with preflight checks', async () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'creative-cli-catalog-'));
  const studio = fakeStudio();
  const catalog = createCuratedCatalog({ home, library: null, studio });
  const { entries } = await catalog.commands['catalog/list']();
  assert.ok(entries.length === 9, `expected 9 curated entries, got ${entries.length}`);
  for (const entry of entries) assert.ok(['builtin', 'needs-install', 'needs-config', 'unavailable'].includes(entry.status), entry.id);
  const statuses = Object.fromEntries(entries.map(entry => [entry.id, entry.status]));
  assert.equal(statuses['learning-pack'], 'builtin');
  assert.equal(statuses['subtitles'], 'needs-config');
  assert.equal(statuses['openmaic-skill-package'], 'needs-install');
  assert.ok(entries.find(entry => entry.id === 'openmaic-skill-package').source.commit === 'f50a25644c9c3893503cf0727ccf613c0ce1e748');
  const preflight = await catalog.commands['catalog/preflight']({ id: 'media-edit' });
  assert.equal(preflight.id, 'media-edit');
  assert.ok(preflight.checks.some(check => check.name === 'ffmpeg'));
  await assert.rejects(catalog.commands['catalog/preflight']({ id: 'nope' }), /精选目录/);
});

// ---------------------------------------------------------------------------
// Real store + real FFmpeg: the local material round-trip an external agent
// performs, with the workbench-visible durable state asserted afterwards.

test('real daemon + FFmpeg: CLI media round-trip, idempotency, cancel and workbench parity', { timeout: 300000, skip: !process.env.KNORVIA_DAEMON_BIN }, async () => {
  const { startKnorviaDaemon, initializeRequest } = require('../knorvia-protocol-client');
  const { createMediaStudio } = require('../media-studio');
  const { createKernelEngine } = require('../kernel-engine');
  const { resolveBinaries } = require('../media-frame-worker');
  const os = require('node:os');
  const parent = path.resolve(__dirname, '../../..', '.knorvia-nightshift-20260908');
  fs.mkdirSync(parent, { recursive: true });
  const home = fs.mkdtempSync(path.join(parent, 'cli-e2e-'));
  const binaries = resolveBinaries();
  let engine; let studio; let service; let provider;
  try {
    // A local scripted Responses fixture satisfies the daemon's provider
    // requirement without any paid model call.
    provider = await require('./fixtures/scripted-responses-fixture').startScriptedResponsesFixture({});
    // The CLI boots its own engine stack against an explicit home.
    engine = await createKernelEngine({ home, env: { ...process.env, ...provider.providerEnv }, version: 'cli-test' });
    const rpc = (method, params = {}) => engine.rpc(method, params);
    const library = createPersonalLibrary({ home, rpc });
    studio = createMediaStudio({ home, rpc, library });
    await studio.initialize();
    const learning = createLearningPack({ home, library, studio, rpc });
    const catalog = createCuratedCatalog({ home, library, studio });
    const courseModule = require('../openmaic-course');
    const course = courseModule.createOpenmaicCourse({ library });
    const imageOps = require('../library-image-ops').createLibraryImageOps({ library });
    service = createCreativeCliService({ home, rpc, library, studio, learning, catalog, course, imageOps });
    await service.listen();

    const dispatch = async (command, params = {}) => {
      const body = await require('../creative-cli').sendCommand({ url: service.address, token: service.token, command, params, timeoutMs: 120000 });
      if (!body.ok) return body;
      return body.result;
    };

    // 1. Real local material through a Chinese+space path.
    const videoPath = path.join(home, '夜景 原 片.mp4');
    execFileSync(binaries.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=30:d=1', '-vf', 'drawbox=x=80:y=0:w=80:h=90:color=blue:t=fill', '-c:v', 'libx264', '-an', '-y', videoPath], { windowsHide: true, timeout: 60000 });
    const entry = await library.put(videoPath, '素材/夜景 原 片.mp4');
    // 2. tools.list/describe/call surface the shared media toolset.
    const tools = await dispatch('tools.list');
    assert.ok(tools.tools.some(tool => tool.name === 'media_edit'));
    const imported = await dispatch('tools.call', { name: 'media_edit', arguments: { action: 'import', title: '夜景成片', references: [{ id: entry.id, version: entry.sha256 }, { id: entry.id, version: entry.sha256 }], idempotencyKey: 'cli-import-1' } });
    assert.equal(imported.sources.length, 2);
    // 3. Identical request → the same durable project, no second job.
    const again = await dispatch('tools.call', { name: 'media_edit', arguments: { action: 'import', title: '夜景成片', references: [{ id: entry.id, version: entry.sha256 }, { id: entry.id, version: entry.sha256 }], idempotencyKey: 'cli-import-1' } });
    assert.equal(again.id, imported.id);
    // 4. Update on the current revision; a stale revision is rejected.
    const updated = await dispatch('tools.call', { name: 'media_edit', arguments: { action: 'update', id: imported.id, revision: imported.revision, edit: { aspect: '1:1', clips: [{ ...imported.edit.clips[0], rotation: 90, mirror: true, fit: 'cover' }], captions: [{ startFrame: 0, endFrame: 15, text: '中文字幕' }] } } });
    assert.equal(updated.revision, imported.revision + 1);
    await assert.rejects(studio.handlers['studio/edit/update']({ action: 'update', id: imported.id, revision: imported.revision, edit: { clips: updated.edit.clips } }), /更新/);
    // 5. Export, wait through the CLI job surface, then play-probe the file.
    const render = await dispatch('tools.call', { name: 'media_edit', arguments: { action: 'export', id: imported.id, revision: updated.revision, idempotencyKey: 'cli-export-1' } });
    const wait = await dispatch('jobs.wait', { id: render.id, timeoutMs: 150000 });
    assert.equal(wait.outcome, 'terminal');
    assert.equal(wait.job.status, 'succeeded');
    assert.ok(wait.job.checkpoint.libraryId, 'finished render records the library entry');
    const outputFile = path.join(studio.root, 'edits', wait.job.checkpoint.output.name);
    const probe = JSON.parse(execFileSync(binaries.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', outputFile], { windowsHide: true, maxBuffer: 4194304 }).toString());
    assert.ok(probe.streams.some(stream => stream.codec_type === 'subtitle'), 'captions survive the export');
    assert.ok(fs.existsSync(path.join(home, 'personal-library', 'files', '成片', `${render.id}.mp4`)), 'export is published back into the library');
    // 6. Unknown outcome is never resubmitted; cancel reports terminal state.
    const cancelled = await dispatch('tools.call', { name: 'media_edit', arguments: { action: 'export', id: imported.id, revision: updated.revision, idempotencyKey: 'cli-export-2' } });
    const stop = await dispatch('jobs.cancel', { id: cancelled.id });
    assert.ok(['cancelled', 'failed', 'succeeded'].includes(stop.status));
    // 7. Workbench parity: the same durable job store the UI reads contains
    // exactly the CLI-created jobs, and the library list matches too.
    const jobs = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: 'studio.', offset: 0, limit: 50 });
    const ids = jobs.jobs.map(job => job.id);
    assert.ok(ids.includes(render.id));
    assert.ok(ids.includes(imported.id));
    const libraryIndex = await library.handlers['library/list']();
    assert.ok(libraryIndex.entries.some(item => item.path === `成片/${render.id}.mp4`));
    // 8. Learning parity: artifacts stored through the CLI service are plain
    // library entries the UI lists.
    const source = await library.handlers['library/write']({ path: '资料/课件.md', text: '# A\n\nalpha\n\n# B\n\nbeta\n' });
    const lecture = await dispatch('learning.lecture.create', { topic: 't', authorship: 'deterministic', sourceRefs: [{ id: source.id, version: source.sha256 }] });
    const artifacts = await dispatch('artifacts.list', { folder: 'learning/' });
    assert.ok(artifacts.entries.some(item => item.path === lecture.path));
    // Skills: the engine seeded learning-pack and the kernel discovers it
    // alongside the bundled Remotion skill.
    const skills = await rpc('skills/list', { forceReload: true });
    const skillNames = (skills.data ?? []).flatMap(group => group.skills ?? []).map(skill => skill.name);
    assert.ok(skillNames.includes('learning-pack'), JSON.stringify(skillNames));
    assert.ok(skillNames.includes('remotion-best-practices'), JSON.stringify(skillNames));
    // 9. B13: the tail frame of the finished export is extracted locally (no
    // model) from the pinned library version, with provenance.
    const finalIndex = await library.handlers['library/list']();
    const finalVideo = finalIndex.entries.find(item => item.path === `成片/${render.id}.mp4`);
    assert.ok(finalVideo, 'finished export is a library video');
    const tail = await dispatch('library.video.extract-frame', { libraryId: finalVideo.id, version: finalVideo.sha256 });
    assert.ok(tail.entry?.sha256, 'extracted frame lands in the library');
    assert.equal(tail.provenance.sourceVersion, finalVideo.sha256);
    assert.equal(tail.provenance.decodedByPts, true);
    // 10. B13: generation tools without a configured model fail clearly and
    // never fabricate a job.
    const noModelSequence = await dispatch('tools.call', { name: 'media_sequence_create', arguments: { title: 'x', defaults: { profileId: 'missing' }, shots: [{ prompt: 'p' }] } });
    assert.equal(noModelSequence.ok, false);
    // 11. B15: local image processing writes a new entry pinned to its source.
    const png = path.join(home, '来源 图.png');
    execFileSync(binaries.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=200x100', '-frames:v', '1', '-y', png], { windowsHide: true, timeout: 30000 });
    const imgEntry = await library.put(png, '素材/来源 图.png');
    const processed = await dispatch('library.image.process', { libraryId: imgEntry.id, crop: { x: 0, y: 0, width: 100, height: 50 }, scale: { width: 50 }, format: 'jpg' });
    assert.ok(processed.entry.path.startsWith('素材加工/'));
    assert.equal(processed.source.libraryId, imgEntry.id);
    assert.equal(processed.source.version, imgEntry.sha256);
    const probeImage = execFileSync(binaries.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', path.join(home, 'personal-library', 'files', processed.entry.path)], { windowsHide: true, maxBuffer: 4194304 });
    const imageStreams = JSON.parse(probeImage.toString()).streams;
    assert.equal(imageStreams[0].width, 50);
    assert.ok(imageStreams[0].height <= 25);
    // 12. B08: course artifact slice — deterministic sample validates, saves,
    // reopens and reports unsupported formats clearly.
    const saved = await course.commands['course/save']({ course: { ...courseModule.sampleCourse(), modules: [{ title: '模块一', lessons: [{ title: '课时', blocks: [{ type: 'text', text: '正文' }] }] }] } });
    assert.ok(saved.path.startsWith('learning/课程/'));
    const reopened = await course.commands['course/read']({ path: saved.path });
    assert.equal(reopened.title, '傅里叶变换入门');
    assert.equal(reopened.view.length, 1);
    assert.throws(() => course.validateCourse({ schemaVersion: 2, title: 'x', topic: 'y', modules: [] }), /schema 版本/);
    assert.throws(() => course.validateCourse({ schemaVersion: 1, title: 'x', topic: 'y', modules: [{ title: 'm', lessons: [{ blocks: [{ type: 'audio', text: 'z' }] }] }] }), /不支持的内容块类型/);
  } finally {
    await service?.close(); await studio?.close();
    if (engine) { try { await engine.shutdown(); } catch {} }
    try { await provider?.close(); } catch {}
  }
});
