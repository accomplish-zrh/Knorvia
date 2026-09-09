'use strict';

// Contract tests for the CLI bot backend adapter. A fixture "CLI" (a Node
// script driven through process.execPath) stands in for real external CLIs so
// these tests never install anything, never touch a user's global CLI config,
// and never run a paid model. Real local detection results are recorded
// separately by the release evidence, not asserted here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  METHODS,
  CliBackendHost,
  KNOWN_BACKENDS,
  parseCodexJsonLines,
  parseClaudeJson,
} = require('../cli-backends');
const { createNativeRpcRouter } = require('../native-rpc-router');

const CRLF = String.fromCharCode(13, 10);
const Q = String.fromCharCode(34);

function makeTempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `knorvia-cli-fixture-${tag}-`));
}

// A stand-in CLI: node.exe running this script. Version/auth/turn modes
// mirror the observable surface the adapter relies on.
function writeFixtureCli(dir) {
  const script = path.join(dir, 'fixture-cli.js');
  fs.writeFileSync(
    script,
    `
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('Fixture CLI 3.2.1 (spaces & 中文 ok)');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  if (process.env.FIXTURE_LOGGED_IN === '1') { console.log('> Logged in using fixture'); process.exit(0); }
  console.log('> Not logged in');
  process.exit(1);
}
if (args[0] === 'turn') {
  const resumeAt = args.indexOf('--resume');
  let sessionId = 'sess_fresh_0001';
  if (resumeAt !== -1) sessionId = args[resumeAt + 1];
  const prompt = args[args.length - 1];
  console.log(JSON.stringify({ type: 'session_started', session_id: sessionId }));
  console.log(JSON.stringify({ type: 'agent_message', message: 'echo:' + prompt }));
  if (args.includes('--print-cwd')) console.log(JSON.stringify({ type: 'agent_message', message: 'cwd:' + process.cwd() }));
  process.exit(0);
}
if (args[0] === 'hang') {
  setTimeout(() => process.exit(0), 60_000);
  process.exit(124);
}
process.exit(2);
`,
  );
  return script;
}

function fixtureBackend(script) {
  // resolvedPath resolves to process.execPath, so the fixture script itself
  // leads every static argv (version/auth probes) exactly like a CLI binary
  // path would.
  return {
    id: 'cli:fixture',
    label: 'Fixture CLI',
    command: 'fixture',
    versionArgs: [script, '--version'],
    authProbe: { args: [script, 'login', 'status'], loggedInHint: /logged in/i, loggedOutHint: /not logged in/i },
    run: ({ prompt, sessionId, resume }) =>
      resume && sessionId
        ? [script, 'turn', '--resume', sessionId, prompt]
        : [script, 'turn', prompt],
    parse: parseCodexJsonLines,
    capabilities: { resume: true, streaming: false, tools: true, cancellation: true },
    probeVerified: 'fixture',
    docs: 'fixture://',
  };
}

function fixtureHost(script, extra = {}) {
  return new CliBackendHost({
    backends: [fixtureBackend(script)],
    pathOverride: () => process.execPath,
    ...extra,
  });
}

test('runTurn drives the fixture CLI through an argv array and parses the session id', async () => {
  const dir = makeTempDir('turn');
  const script = writeFixtureCli(dir);
  const host = fixtureHost(script);

  const result = await host.runTurn({ backendId: 'cli:fixture', prompt: '你好 世界 with spaces' });
  assert.equal(result.text, 'echo:你好 世界 with spaces');
  assert.equal(result.sessionId, 'sess_fresh_0001');
  assert.equal(result.exitCode, 0);
  assert.equal(host.activeRuns().length, 0);
});

test('resume reuses the caller-provided session id only when the backend declares it', async () => {
  const dir = makeTempDir('resume');
  const script = writeFixtureCli(dir);
  const host = fixtureHost(script);

  const resumed = await host.runTurn({
    backendId: 'cli:fixture',
    prompt: 'continue',
    sessionId: 'sess_prev_9999',
    resume: true,
  });
  assert.equal(resumed.sessionId, 'sess_prev_9999');
  assert.equal(resumed.text, 'echo:continue');

  // A backend without declared resume support must refuse, not guess flags.
  const noResume = fixtureHost(script, {
    backends: [{
      ...fixtureBackend(script),
      id: 'cli:nores',
      capabilities: { resume: 'unknown', streaming: 'unknown', tools: 'unknown', cancellation: 'unknown' },
    }],
  });
  await assert.rejects(
    noResume.runTurn({ backendId: 'cli:nores', prompt: 'x', sessionId: 's1', resume: true }),
    /does not declare resume support/,
  );
});

test('paths with spaces and CJK survive spawn and become the process cwd', async () => {
  const dir = makeTempDir('cwd');
  const script = writeFixtureCli(dir);
  const weirdCwd = path.join(dir, '工作 目录 with spaces');
  fs.mkdirSync(weirdCwd);

  const cwdBackend = {
    ...fixtureBackend(script),
    id: 'cli:cwdprobe',
    run: ({ prompt }) => [script, 'turn', prompt, '--print-cwd'],
  };
  const host = new CliBackendHost({
    backends: [cwdBackend],
    pathOverride: () => process.execPath,
  });

  const result = await host.runTurn({
    backendId: 'cli:cwdprobe',
    prompt: 'where am I',
    cwd: weirdCwd,
  });
  // The fixture prints two agent_message events; the last one wins.
  assert.equal(result.text, `cwd:${weirdCwd}`);
});

test('cancel terminates a run this host owns and reports the pid', async () => {
  const dir = makeTempDir('cancel');
  const script = writeFixtureCli(dir);
  const host = fixtureHost(script);
  const runPromise = host.runTurn({ backendId: 'cli:fixture', prompt: 'ignored', timeoutMs: 60_000 })
    .catch((error) => error);
  // The turn exits quickly; to exercise cancel we start a hanging argv
  // through the same host using the script directly.
  const hanging = new Promise((resolve) => {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [script, 'hang'], { shell: false });
    const runId = 'clirun_manual';
    host._runs.set(runId, { runId, backendId: 'cli:fixture', pid: child.pid, child, finished: false });
    setTimeout(() => resolve(host.cancel({ runId })), 100);
  });
  const cancelResult = await hanging;
  assert.equal(cancelResult.canceled, true);
  await runPromise;
  assert.equal(host.activeRuns().length, 0);
  assert.equal(host.cancel({ runId: 'clirun_manual' }).canceled, false);
});

test('detection reports honest states: installed+connected, needs-user, not-installed', async () => {
  const dir = makeTempDir('detect');
  const script = writeFixtureCli(dir);
  const host = fixtureHost(script);
  process.env.FIXTURE_LOGGED_IN = '1';
  const connected = await host.status({ backendId: 'cli:fixture' });
  assert.equal(connected.installed, true);
  assert.equal(connected.authState, 'connected');
  assert.match(connected.version, /Fixture CLI 3\.2\.1/);

  process.env.FIXTURE_LOGGED_IN = '';
  // Detection results are cached for 30s; force a fresh probe.
  host._detectCache.clear();
  const loggedOut = await host.status({ backendId: 'cli:fixture' });
  assert.equal(loggedOut.authState, 'needs-user');
  assert.equal(loggedOut.authenticated, false);
  delete process.env.FIXTURE_LOGGED_IN;

  const absent = new CliBackendHost({
    backends: [fixtureBackend(script)],
    pathOverride: () => null,
  });
  const missing = await absent.status({ backendId: 'cli:fixture' });
  assert.equal(missing.installed, false);
  assert.equal(missing.authState, 'not-installed');
  assert.equal(missing.resolvedPath, null);
});

test('status-only backends refuse generation, unknown backend ids are attributed', async () => {
  const dir = makeTempDir('statusonly');
  const script = writeFixtureCli(dir);
  const host = new CliBackendHost({
    backends: KNOWN_BACKENDS,
    pathOverride: () => null,
  });
  await assert.rejects(
    () => host.runTurn({ backendId: 'cli:grok', prompt: 'hi' }),
    /status only/,
  );
  await assert.rejects(
    () => host.runTurn({ backendId: 'cli:claude', prompt: 'hi' }),
    /not installed/,
  );
  await assert.rejects(() => host.status({ backendId: 'cli:fixture' }), /unknown CLI backend/);
});

test('router whitelist: social methods pass through, cliBackend methods are local-only', async () => {
  assert.ok(METHODS.has('cliBackend/list'));
  assert.ok(METHODS.has('cliBackend/runTurn'));
  assert.ok(METHODS.has('cliBackend/cancel'));

  const forwarded = [];
  const router = createNativeRpcRouter({
    rpc: async (method, params) => {
      forwarded.push({ method, params });
      return { ok: true, method };
    },
    handlers: {
      'cliBackend/list': async () => ({ backends: [] }),
    },
  });
  const passThrough = await router.handle({ jsonrpc: '2.0', id: 1, method: 'bot/list', params: {} });
  assert.deepEqual(passThrough.result, { ok: true, method: 'bot/list' });
  assert.equal(forwarded[0].method, 'bot/list');

  const handled = await router.handle({ jsonrpc: '2.0', id: 2, method: 'cliBackend/list', params: {} });
  assert.deepEqual(handled.result, { backends: [] });

  // Without a local handler the CLI backend method must NOT fall through to
  // the daemon: spawning processes is a desktop host job.
  const bareRouter = createNativeRpcRouter({
    rpc: async () => ({ reachedDaemon: true }),
    handlers: {},
  });
  const refused = await bareRouter.handle({ jsonrpc: '2.0', id: 3, method: 'cliBackend/runTurn', params: {} });
  assert.equal(refused.error.code, -32601);
});

test('parsers degrade without fabricating answers', () => {
  const codex = parseCodexJsonLines([
    'not json',
    JSON.stringify({ type: 'session_started', session_id: 'sess_x' }),
    JSON.stringify({ type: 'agent_message', message: 'final answer' }),
    '',
  ].join('\n'));
  assert.equal(codex.sessionId, 'sess_x');
  assert.equal(codex.text, 'final answer');

  const plain = parseCodexJsonLines('plain text fallback');
  assert.equal(plain.text, 'plain text fallback');
  assert.equal(plain.sessionId, null);

  const claude = parseClaudeJson(JSON.stringify({ result: 'claude says hi', session_id: 'sess_c' }));
  assert.equal(claude.text, 'claude says hi');
  assert.equal(claude.sessionId, 'sess_c');
  const claudePlain = parseClaudeJson('oops plain');
  assert.equal(claudePlain.text, 'oops plain');
});

test('capability matrix: an old CLI revision without verified resume degrades instead of guessing', async () => {
  const dir = makeTempDir('matrix');
  const script = writeFixtureCli(dir);
  // Two fixture revisions of the same backend family: the old one has no
  // verified resume, the new one does. Detection reports both; the adapter
  // only resumes on the one that declares it.
  const oldRevision = {
    ...fixtureBackend(script),
    id: 'cli:fixture:0.9',
    label: 'Fixture CLI 0.9',
    versionArgs: [script, '--version'],
    capabilities: { resume: false, streaming: false, tools: true, cancellation: true },
  };
  const newRevision = {
    ...fixtureBackend(script),
    id: 'cli:fixture:3.2',
    label: 'Fixture CLI 3.2',
    capabilities: { resume: true, streaming: false, tools: true, cancellation: true },
  };
  const host = new CliBackendHost({
    backends: [oldRevision, newRevision],
    pathOverride: () => process.execPath,
  });

  const list = await host.list();
  const byId = Object.fromEntries(list.map(entry => [entry.backendId, entry]));
  assert.equal(byId['cli:fixture:0.9'].installed, true);
  assert.equal(byId['cli:fixture:3.2'].installed, true);

  // Old revision: resume request is refused (missing capability degrades to
  // an explicit error, never to guessed flags).
  await assert.rejects(
    () => host.runTurn({ backendId: 'cli:fixture:0.9', prompt: 'x', sessionId: 's0', resume: true }),
    /does not declare resume support/,
  );
  // Plain runs still work on the old revision.
  const legacy = await host.runTurn({ backendId: 'cli:fixture:0.9', prompt: 'legacy run' });
  assert.equal(legacy.text, 'echo:legacy run');

  // New revision resumes with the caller-provided session id.
  const modern = await host.runTurn({
    backendId: 'cli:fixture:3.2',
    prompt: 'modern run',
    sessionId: 'sess_modern',
    resume: true,
  });
  assert.equal(modern.sessionId, 'sess_modern');

  // A status-only backend (no run contract) stays unusable for generation.
  await assert.rejects(
    () => host.runTurn({ backendId: 'cli:grok', prompt: 'x' }),
    /unknown CLI backend|status only/,
  );
});

test('windows .cmd shims: probes work through cmd.exe, turn execution refuses', async () => {
  const dir = makeTempDir('shim');
  const script = writeFixtureCli(dir);
  const fs = require('node:fs');
  // A real Windows .cmd shim wrapping the fixture: exactly what npm installs.
  const shim = path.join(dir, 'fixture-cli.cmd');
  fs.writeFileSync(shim, `@echo off` + CRLF + `node ` + Q + script + Q + ` %*` + CRLF);
  const shimBackend = {
    ...fixtureBackend(shim),
    id: 'cli:shim',
    label: 'Shim CLI',
    // Adapter contract: probes argv exclude the command (list() prepends the
    // resolved path itself).
    versionArgs: ['--version'],
    authProbe: { args: ['login', 'status'], loggedInHint: /logged in/i, loggedOutHint: /not logged in/i },
  };
  const host = new CliBackendHost({
    backends: [shimBackend],
    pathOverride: () => shim,
  });

  // Detection probes carry fixed argv, so they go through cmd.exe safely.
  const status = await host.status({ backendId: 'cli:shim' });
  assert.equal(status.installed, true);
  assert.match(status.version, /Fixture CLI 3\.2\.1/);

  // Turn execution carries user prompt text and must NOT pass through
  // cmd.exe: an explicit, honest refusal instead of an injection risk.
  await assert.rejects(
    () => host.runTurn({ backendId: 'cli:shim', prompt: 'hello' }),
    /\.cmd shim.*requires a direct \.exe/s,
  );
});

test('Codex current JSONL returns only completed assistant text and honest errors', () => {
  const result = parseCodexJsonLines([
    JSON.stringify({ type: 'thread.started', thread_id: 'thread_current' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'private tool text' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'completed answer' } }),
  ].join('\n'));
  assert.equal(result.text, 'completed answer');
  assert.equal(result.sessionId, 'thread_current');
  assert.equal(parseCodexJsonLines(JSON.stringify({ type: 'thread.started', thread_id: 'x' })).text, null);
  assert.equal(parseCodexJsonLines(JSON.stringify({ type: 'turn.failed', error: { message: 'capacity' } })).error, 'capacity');
  assert.equal(parseClaudeJson(JSON.stringify({ is_error: true, result: 'permission denied' })).error, 'permission denied');
});

test('official Codex argv contract runs and resumes with current events on a local process', async () => {
  const dir = makeTempDir('official-contract');
  const script = path.join(dir, 'codex-fixture.js');
  fs.writeFileSync(script, `const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.equal(args[0], 'exec'); assert.ok(args.includes('--json'));
const resumed = args[1] === 'resume';
const session = resumed ? args[3] : 'thread_local';
console.log(JSON.stringify({type:'thread.started',thread_id:session}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'answer:'+args.at(-1)}}));`);
  const backend = KNOWN_BACKENDS.find(row => row.id === 'cli:codex');
  const host = new CliBackendHost({ pathOverride: () => process.execPath, backends: [{ ...backend, run: params => [script, ...backend.run(params)] }] });
  const first = await host.runTurn({ backendId: backend.id, prompt: '中文 & $() % PATH' });
  assert.equal(first.text, 'answer:中文 & $() % PATH');
  const next = await host.runTurn({ backendId: backend.id, prompt: 'continue', resume: true, sessionId: first.sessionId });
  assert.equal(next.sessionId, first.sessionId);
  await assert.rejects(host.runTurn({ backendId: backend.id, prompt: 'x', resume: true }), /explicit sessionId/);
  await assert.rejects(host.runTurn({ backendId: backend.id, prompt: 'x', sessionId: 'thread_local' }), /resume=true/);
});

test('known npm CLI executes its fixed entrypoint without sending prompts through cmd', async () => {
  const dir = makeTempDir('npm-entrypoint');
  const entryDir = path.join(dir, 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(entryDir, { recursive: true });
  fs.writeFileSync(path.join(entryDir, 'codex.js'), `console.log(JSON.stringify({type:'thread.started',thread_id:'npm_session'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:process.argv.at(-1)}}));`);
  const shim = path.join(dir, 'codex.cmd');
  fs.writeFileSync(shim, '@echo THIS SHIM MUST NEVER RUN\r\nexit /b 99');
  const host = new CliBackendHost({ pathOverride: () => shim, backends: [KNOWN_BACKENDS[0]] });
  const prompt = '中文 & echo unsafe | %USERPROFILE% $(anything)';
  const result = await host.runTurn({ backendId: 'cli:codex', prompt });
  assert.equal(result.text, prompt);
  assert.equal(result.sessionId, 'npm_session');
});

test('caller-owned cancellation stops an actual pending turn without reporting success', async () => {
  const dir = makeTempDir('actual-cancel');
  const script = path.join(dir, 'wait.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  const host = new CliBackendHost({ pathOverride: () => process.execPath, backends: [{ ...fixtureBackend(script), run: () => [script] }] });
  const pending = host.runTurn({ backendId: 'cli:fixture', prompt: 'wait', runId: 'clirun_owned_test' });
  const rejected = assert.rejects(pending, /canceled|exited/);
  assert.equal(host.cancel({ runId: 'clirun_owned_test' }).canceled, true);
  await rejected;
  assert.deepEqual(host.activeRuns(), []);
});

test('official Claude argv contract returns the same anchored session on resume', async () => {
  const dir = makeTempDir('claude-contract');
  const script = path.join(dir, 'claude-fixture.js');
  fs.writeFileSync(script, `const assert = require('node:assert/strict');
const args = process.argv.slice(2); assert.deepEqual(args.slice(0,3), ['-p','--output-format','json']);
const index = args.indexOf('--resume');
console.log(JSON.stringify({result:'claude:'+args.at(-1),session_id:index === -1 ? 'claude_first' : args[index+1],is_error:args.at(-1)==='fail'}));`);
  const backend = KNOWN_BACKENDS.find(row => row.id === 'cli:claude');
  const host = new CliBackendHost({ pathOverride: () => process.execPath, backends: [{ ...backend, run: params => [script, ...backend.run(params)] }] });
  const first = await host.runTurn({ backendId: backend.id, prompt: '你好' });
  const second = await host.runTurn({ backendId: backend.id, prompt: 'again', resume: true, sessionId: first.sessionId });
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.text, 'claude:again');
  await assert.rejects(host.runTurn({ backendId: backend.id, prompt: 'fail' }), /claude:fail/);
});

test('a CLI that returns a different resume session is rejected, never re-anchored', async () => {
  const dir = makeTempDir('wrong-anchor');
  const script = path.join(dir, 'wrong.js');
  fs.writeFileSync(script, `console.log(JSON.stringify({type:'thread.started',thread_id:'wrong-session'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'wrong answer'}}));`);
  const host = new CliBackendHost({ pathOverride: () => process.execPath, backends: [{ ...fixtureBackend(script), run: () => [script] }] });
  await assert.rejects(host.runTurn({ backendId: 'cli:fixture', prompt: 'continue', resume: true, sessionId: 'right-session' }), /different session/);
});

test('available backend IDs do not run login, version or inference probes', () => {
  const host = new CliBackendHost({ pathOverride: () => process.execPath, backends: KNOWN_BACKENDS });
  host._spawnCapture = () => { throw new Error('probe should not run'); };
  assert.deepEqual(host.availableBackendIds(), ['cli:codex', 'cli:claude']);
});
