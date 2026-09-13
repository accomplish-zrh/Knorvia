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
  JsonlAnswerTracker,
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

test('cancel keeps the run until real exit, confirms the tree is gone, and keeps a receipt', async () => {
  const dir = makeTempDir('cancel');
  const script = path.join(dir, 'hang-tree.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  const host = new CliBackendHost({ pathOverride: () => process.execPath, backends: [{ ...fixtureBackend(script), run: () => [script] }] });
  const runId = 'clirun_cancel_real';
  let settlements = 0;
  const pending = host.runTurn({ backendId: 'cli:fixture', prompt: 'wait', runId })
    .then(() => { settlements += 1; return 'resolved'; })
    .catch((error) => { settlements += 1; return String(error); });
  await delay(200);
  // Before cancel the run is still live and tracked.
  assert.deepEqual(host.activeRuns(), [runId]);
  const cancelResult = host.cancel({ runId });
  assert.equal(cancelResult.canceled, true);
  assert.equal(typeof cancelResult.pid, 'number');
  // A run stays owned until its close event fires; a second cancel reports
  // the in-flight kill instead of pretending to cancel again.
  assert.deepEqual(host.activeRuns(), [runId]);
  const repeat = host.cancel({ runId });
  assert.equal(repeat.canceled, true);
  assert.equal(repeat.alreadyCanceling, true);
  // Cancel is only confirmed once the process actually exited.
  const exitResult = await cancelResult.exitWait;
  assert.equal(exitResult.directChildExited, true);
  assert.equal(exitResult.treeConfirmed, true, 'no-descendant trees are trivially confirmed');
  assert.deepEqual(exitResult.unconfirmedPids, []);
  assert.ok(pidAlive(cancelResult.pid) === false, 'process should be gone after exitWait');
  const outcome = await pending;
  assert.match(outcome, /canceled/);
  assert.equal(settlements, 1, 'runTurn promise must settle exactly once');
  assert.deepEqual(host.activeRuns(), []);
  const receipt = host.getRunReceipt(runId);
  assert.equal(receipt.outcome, 'canceled');
  assert.equal(receipt.canceled, true);
  assert.ok(receipt.killEvents.length >= 1);
  assert.equal(host.getRunReceipt('clirun_missing'), null);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH', '/FI', `PID eq ${pid}`], { encoding: 'utf8', timeout: 10_000 });
    return out.includes(`"${pid}"`);
  } catch {
    return false;
  }
}

async function waitUntilDead(pids, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = pids.filter(pidAlive);
    if (!alive.length) return;
    if (Date.now() > deadline) throw new Error(`processes still alive after ${timeoutMs}ms: ${alive.join(', ')}`);
    await delay(250);
  }
}

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

// ---- C01 nightshift additions: bounded lifecycle, real cancel, receipts ----

test('a multi-megabyte JSONL stream keeps the final answer while raw output stays bounded', async () => {
  const dir = makeTempDir('flood');
  const script = path.join(dir, 'flood.js');
  fs.writeFileSync(script, [
    'const filler = JSON.stringify({ type: "agent_message", message: "f".repeat(4096) });',
    'for (let i = 0; i < 5100; i++) process.stdout.write(filler + "\\n");',
    'process.stdout.write(JSON.stringify({ type: "agent_message", message: "FINAL_ANSWER_survived" }) + "\\n");',
  ].join('\n'));
  const host = new CliBackendHost({ pathOverride: () => process.execPath, backends: [{ ...fixtureBackend(script), run: () => [script] }] });
  const result = await host.runTurn({ backendId: 'cli:fixture', prompt: 'flood' });
  assert.equal(result.text, 'FINAL_ANSWER_survived', 'the final answer must survive a >20MiB stream');
  assert.ok(!result.answerTruncatedBytes, 'no answer truncation expected for many smaller events');
  const receipt = result.receipt;
  assert.equal(receipt.outcome, 'completed');
  assert.ok(receipt.outputBytes > 20 * 1024 * 1024, `expected >20MiB output, got ${receipt.outputBytes}`);
  assert.ok(receipt.outputDroppedBytes > 0, 'raw bytes beyond the parse window must be counted, not hoarded');
  assert.ok(receipt.stdoutExcerpt.length < 64 * 1024, `receipt excerpt must stay bounded, got ${receipt.stdoutExcerpt.length}`);
  assert.ok(receipt.stderrExcerpt.length < 64 * 1024);
});

test('oversized plain-text output is rejected loudly instead of silently truncated', async () => {
  const dir = makeTempDir('flood-plain');
  const script = path.join(dir, 'flood-plain.js');
  fs.writeFileSync(script, 'process.stdout.write("x".repeat(9 * 1024 * 1024));');
  const claudeBackend = {
    ...fixtureBackend(script),
    id: 'cli:floodplain',
    run: () => [script],
    parse: parseClaudeJson,
  };
  const host = new CliBackendHost({ pathOverride: () => process.execPath, backends: [claudeBackend] });
  await assert.rejects(
    () => host.runTurn({ backendId: 'cli:floodplain', prompt: 'flood' }),
    /parse window; final answer withheld/,
  );
  assert.deepEqual(host.activeRuns(), []);
});

test('timeout terminates the process tree and the receipt records the kill', async () => {
  const dir = makeTempDir('timeout');
  const script = path.join(dir, 'hang.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  const host = new CliBackendHost({ pathOverride: () => process.execPath, backends: [{ ...fixtureBackend(script), run: () => [script] }] });
  const outcome = await host.runTurn({ backendId: 'cli:fixture', prompt: 'hang', runId: 'clirun_timeout_test', timeoutMs: 1500 })
    .catch((error) => String(error));
  assert.match(String(outcome), /timed out after 1500ms/);
  assert.deepEqual(host.activeRuns(), []);
  const receipt = host.getRunReceipt('clirun_timeout_test');
  assert.equal(receipt.outcome, 'timeout');
  assert.equal(receipt.timedOut, true);
  await waitUntilDead([receipt.pid]);
});

test('startup failure is visible, settles once, and leaves a receipt without a lingering run', async () => {
  const dir = makeTempDir('spawn-fail');
  const missing = path.join(dir, 'missing-cli.exe');
  const host = new CliBackendHost({ pathOverride: () => missing, backends: [{ ...fixtureBackend(missing), run: () => [missing] }] });
  let settlements = 0;
  const pending = host.runTurn({ backendId: 'cli:fixture', prompt: 'x', runId: 'clirun_spawn_fail' })
    .then(() => { settlements += 1; return 'resolved'; })
    .catch((error) => { settlements += 1; return String(error); });
  const outcome = await pending;
  assert.match(String(outcome), /failed to start/);
  await delay(100);
  assert.equal(settlements, 1, 'startup failure must settle the promise exactly once');
  assert.deepEqual(host.activeRuns(), []);
  const receipt = host.getRunReceipt('clirun_spawn_fail');
  assert.equal(receipt.outcome, 'spawn-error');
  assert.match(receipt.error, /failed to start/);
});

test('cancel empties a live parent/child/grandchild process tree and reports once', async () => {
  const dir = makeTempDir('tree');
  const script = path.join(dir, 'tree.js');
  fs.writeFileSync(script, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { spawn } = require("node:child_process");',
    'const mode = process.argv[2];',
    'const dirPath = process.argv[3];',
    'fs.writeFileSync(path.join(dirPath, mode + ".pid"), String(process.pid));',
    'if (mode === "parent") spawn(process.execPath, [__filename, "child", dirPath], { shell: false });',
    'if (mode === "child") spawn(process.execPath, [__filename, "grandchild", dirPath], { shell: false });',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const host = new CliBackendHost({ pathOverride: () => process.execPath, backends: [{ ...fixtureBackend(script), run: () => [script, 'parent', dir] }] });
  const runId = 'clirun_tree_parent';
  const pending = host.runTurn({ backendId: 'cli:fixture', prompt: 'tree', runId }).catch((error) => String(error));
  const pids = { parent: 0, child: 0, grandchild: 0 };
  const deadline = Date.now() + 10_000;
  for (;;) {
    for (const level of Object.keys(pids)) {
      try { pids[level] = Number(fs.readFileSync(path.join(dir, level + '.pid'), 'utf8')); } catch { /* not yet */ }
    }
    if (pids.parent && pids.child && pids.grandchild) break;
    if (Date.now() > deadline) throw new Error('tree fixture never wrote its pid files');
    await delay(100);
  }
  const cancelResult = host.cancel({ runId });
  assert.equal(cancelResult.canceled, true);
  const treeExit = await cancelResult.exitWait;
  assert.equal(treeExit.directChildExited, true, 'cancel must wait for the direct child to actually exit');
  assert.equal(treeExit.treeConfirmed, true, 'registered parent/child/grandchild identities all verified dead');
  assert.deepEqual(treeExit.unconfirmedPids, []);
  await waitUntilDead([pids.parent, pids.child, pids.grandchild]);
  const outcome = await pending;
  assert.match(String(outcome), /canceled/);
  assert.deepEqual(host.activeRuns(), []);
  const receipt = host.getRunReceipt(runId);
  assert.equal(receipt.outcome, 'canceled');
  assert.equal(receipt.killEvents.length, 1, 'a single cancel must issue exactly one kill sequence');
  // The RPC surface on its own host stays JSON-serializable and honest:
  // awaitExitMs yields a real-exit boolean, receipts are queryable, and no
  // promise ever crosses the wire.
  const { createCliBackendHandlers } = require('../cli-backends');
  const wire = createCliBackendHandlers({ pathOverride: () => process.execPath, backends: [{ ...fixtureBackend(script), run: () => [script, 'parent', dir] }] });
  const wireRunId = 'clirun_wire_tree';
  const wirePending = wire.handlers['cliBackend/runTurn']({ backendId: 'cli:fixture', prompt: 'tree', runId: wireRunId }).catch((error) => String(error));
  const wirePidFile = path.join(dir, 'parent.pid');
  const wireDeadline = Date.now() + 10_000;
  while (!fs.existsSync(wirePidFile) && Date.now() < wireDeadline) await delay(100);
  const wireCancel = await wire.handlers['cliBackend/cancel']({ runId: wireRunId, awaitExitMs: 15_000 });
  assert.equal(wireCancel.canceled, true);
  assert.equal(wireCancel.exited, true, 'RPC cancel with awaitExitMs must confirm the real exit');
  assert.equal(wireCancel.exitWait === undefined, true, 'exitWait promise must never cross the RPC wire');
  assert.match(String(await wirePending), /canceled/);
  const wireReceipts = await wire.handlers['cliBackend/receipts']({ runId: wireRunId });
  assert.equal(wireReceipts.receipts.length, 1);
  assert.equal(wireReceipts.receipts[0].runId, wireRunId);
  assert.equal(wireReceipts.receipts[0].outcome, 'canceled');
  // A cancel for an unknown run reports honestly over RPC too.
  const fresh = await wire.handlers['cliBackend/cancel']({ runId: 'clirun_never_started' });
  assert.equal(fresh.canceled, false);
  assert.match(fresh.reason, /no such active run/);
});

test('closeAll cancels every live run and waits for real exit', async () => {
  const dir = makeTempDir('closeall');
  const script = path.join(dir, 'hang.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  const host = new CliBackendHost({ pathOverride: () => process.execPath, backends: [{ ...fixtureBackend(script), run: () => [script] }] });
  const pendingA = host.runTurn({ backendId: 'cli:fixture', prompt: 'a', runId: 'clirun_close_run_a', timeoutMs: 60_000 }).catch((e) => String(e));
  const pendingB = host.runTurn({ backendId: 'cli:fixture', prompt: 'b', runId: 'clirun_close_run_b', timeoutMs: 60_000 }).catch((e) => String(e));
  await delay(200);
  const summary = await host.closeAll({ timeoutMs: 15_000 });
  assert.equal(summary.canceled, 2);
  assert.equal(summary.exitedWithinTimeout, true);
  assert.deepEqual(host.activeRuns(), []);
  assert.match(String(await pendingA), /canceled/);
  assert.match(String(await pendingB), /canceled/);
  await waitUntilDead([host.getRunReceipt('clirun_close_run_a').pid, host.getRunReceipt('clirun_close_run_b').pid]);
});

test('detection probes are bounded: a flooding version banner cannot balloon memory', async () => {
  const dir = makeTempDir('probe-flood');
  const script = path.join(dir, 'probe-flood.js');
  fs.writeFileSync(script, [
    'if (process.argv[2] === "--version") {',
    '  console.log("Fixture CLI 3.2.1 flood-probe");',
    '  process.stdout.write("y".repeat(6 * 1024 * 1024));',
    '  process.exit(0);',
    '}',
    'process.exit(2);',
  ].join('\n'));
  const host = new CliBackendHost({ pathOverride: () => process.execPath, backends: [{ ...fixtureBackend(script) }] });
  const captured = await host._spawnCapture([process.execPath, script, '--version'], { timeoutMs: 20_000 });
  assert.ok(captured.ok);
  assert.match(captured.stdout, /Fixture CLI 3\.2\.1/);
  assert.match(captured.stdout, /excerpt dropped/);
  assert.ok(captured.stdout.length < 256 * 1024, `probe stdout must stay bounded, got ${captured.stdout.length}`);
  assert.ok(captured.stderr.length < 256 * 1024);
  // list() still extracts the version line from the bounded excerpt head.
  const status = await host.status({ backendId: 'cli:fixture' });
  assert.match(status.version, /Fixture CLI 3\.2\.1/);
});

test('a single answer larger than the text limit keeps its tail and reports the truncation', () => {
  const tracker = new JsonlAnswerTracker({ textLimit: 1024 });
  tracker.feedLine(JSON.stringify({ type: 'session_started', session_id: 'sess_big' }));
  tracker.feedLine(JSON.stringify({ type: 'agent_message', message: 'A'.repeat(4096) }));
  tracker.end();
  const result = tracker.result();
  assert.equal(result.sessionId, 'sess_big');
  assert.equal(result.answerTruncatedBytes, 4096 - 1024);
  assert.ok(result.text.startsWith('AAAA'), 'kept text is the tail of the oversized answer');
});

// ---- CODEX-0030-C-FIX additions: honest termination confirmation ----

// A real, alive stand-in process so identity checks exercise the live path.
function spawnSleeper() {
  const { spawn } = require('node:child_process');
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { shell: false, stdio: 'ignore' });
}

test('a surviving registered descendant forces cancel and closeAll to report unconfirmed (repro of the false-all-exited lie)', { timeout: 60_000 }, async () => {
  const dir = makeTempDir('survivor');
  const script = path.join(dir, 'hang.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  const spawnSleeperPid = spawnSleeper().pid;
  // Injected product seams: the termination tool kills only a run's direct
  // root (a real taskkill without /T) and REFUSES every registered survivor
  // - exactly the "tool failed to clear the tree" shape. The fake process
  // table keeps reporting the survivor even after the run record is deleted
  // by the close event, because verification runs after that.
  const fakeRowFor = rootPid => [{ pid: spawnSleeperPid, ppid: rootPid, creation: 'FIXED-IDENTITY' }];
  const injectSeams = (host, runId) => {
    let rootPid;
    host._processTableOverride = async () => {
      rootPid = rootPid ?? host._runs.get(runId)?.pid;
      return rootPid ? fakeRowFor(rootPid) : [];
    };
    host._spawnTreeKill = async (pid) => {
      rootPid = rootPid ?? host._runs.get(runId)?.pid;
      if (pid === rootPid) {
        require('node:child_process').spawnSync('taskkill', ['/pid', String(pid), '/F'], { windowsHide: true });
        return { exitCode: 1, error: 'injected tool failure: tree kill unavailable' };
      }
      return { exitCode: 1, error: 'injected tool failure: survivor kill refused' };
    };
  };
  try {
    // Phase 1: cancel-level honesty - the direct child exits, the registered
    // survivor keeps the tree unconfirmed.
    const hostA = new CliBackendHost({ pathOverride: () => process.execPath, backends: [{ ...fixtureBackend(script), run: () => [script] }] });
    const runIdA = 'clirun_survivor_cancel';
    injectSeams(hostA, runIdA);
    const pendingA = Promise.race([
      hostA.runTurn({ backendId: 'cli:fixture', prompt: 'hang', runId: runIdA }).then(() => 'resolved', (error) => String(error)),
      delay(20_000).then(() => 'PENDING-TIMEOUT'),
    ]);
    await delay(200);
    const exitResult = await hostA.cancel({ runId: runIdA }).exitWait;
    assert.equal(exitResult.directChildExited, true, 'the direct child itself did exit');
    assert.equal(exitResult.treeConfirmed, false, 'the surviving registered descendant must keep the tree unconfirmed');
    assert.deepEqual(exitResult.unconfirmedPids, [spawnSleeperPid]);
    assert.match(String(await pendingA), /canceled/);

    // Phase 2: the direct prototype call the review used - a run that ends
    // unconfirmed must surface in closeAll instead of being swallowed into
    // exitedWithinTimeout:true.
    const hostB = new CliBackendHost({ pathOverride: () => process.execPath, backends: [{ ...fixtureBackend(script), run: () => [script] }] });
    const runIdB = 'clirun_survivor_closeall';
    injectSeams(hostB, runIdB);
    void hostB.runTurn({ backendId: 'cli:fixture', prompt: 'hang', runId: runIdB }).catch(() => {});
    await delay(200);
    const summary = await hostB.closeAll({ timeoutMs: 20_000 });
    assert.equal(summary.exitedWithinTimeout, false, 'closeAll must not lie when a run was unconfirmed');
    assert.deepEqual(summary.unconfirmedRuns, [runIdB]);
  } finally {
    try { require('node:child_process').spawnSync('taskkill', ['/pid', String(spawnSleeperPid), '/T', '/F'], { windowsHide: true }); } catch { /* already gone */ }
  }
  await waitUntilDead([spawnSleeperPid]);
});

test('a reused PID with a different creation identity counts as confirmed dead', { timeout: 60_000 }, async () => {
  const dir = makeTempDir('reuse');
  const script = path.join(dir, 'hang.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  const host = new CliBackendHost({ pathOverride: () => process.execPath, backends: [{ ...fixtureBackend(script), run: () => [script] }] });
  const runId = 'clirun_reuse_identity';
  const sleeper = spawnSleeper();
  const pending = host.runTurn({ backendId: 'cli:fixture', prompt: 'hang', runId }).catch((error) => String(error));
  await delay(200);
  host._processTableOverride = async () => {
    const run = host._runs.get(runId);
    // Same PID, different creation identity: an unrelated successor process.
    return run ? [{ pid: sleeper.pid, ppid: run.pid, creation: 'REUSED-IDENTITY' }] : [];
  };
  try {
    const exitResult = await host.cancel({ runId }).exitWait;
    assert.equal(exitResult.treeConfirmed, true, 'identity mismatch means our process is gone');
    assert.deepEqual(exitResult.unconfirmedPids, []);
  } finally {
    try { sleeper.kill('SIGKILL'); } catch { /* already gone */ }
  }
  await waitUntilDead([sleeper.pid]);
  await pending;
});

test('failed descendant enumeration reports unconfirmed instead of a blind true', { timeout: 60_000 }, async () => {
  const dir = makeTempDir('enumfail');
  const script = path.join(dir, 'hang.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  const host = new CliBackendHost({ pathOverride: () => process.execPath, backends: [{ ...fixtureBackend(script), run: () => [script] }] });
  const pending = host.runTurn({ backendId: 'cli:fixture', prompt: 'hang', runId: 'clirun_enumfail' }).catch((error) => String(error));
  await delay(200);
  host._processTableOverride = async () => null;
  const exitResult = await host.cancel({ runId: 'clirun_enumfail' }).exitWait;
  assert.equal(exitResult.directChildExited, true);
  assert.equal(exitResult.treeConfirmed, false);
  assert.match(exitResult.reason || '', /enumeration/);
  await pending;
});

test('real tree cancel registers descendant identities and confirms the whole tree through the product path', { timeout: 60_000 }, async () => {
  const dir = makeTempDir('tree-identity');
  const script = path.join(dir, 'tree.js');
  fs.writeFileSync(script, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { spawn } = require("node:child_process");',
    'const mode = process.argv[2];',
    'const dirPath = process.argv[3];',
    'fs.writeFileSync(path.join(dirPath, mode + ".pid"), String(process.pid));',
    'if (mode === "parent") spawn(process.execPath, [__filename, "child", dirPath], { shell: false });',
    'if (mode === "child") spawn(process.execPath, [__filename, "grandchild", dirPath], { shell: false });',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const host = new CliBackendHost({ pathOverride: () => process.execPath, backends: [{ ...fixtureBackend(script), run: () => [script, 'parent', dir] }] });
  const runId = 'clirun_tree_identity';
  const pending = host.runTurn({ backendId: 'cli:fixture', prompt: 'tree', runId }).catch((error) => String(error));
  const pids = { parent: 0, child: 0, grandchild: 0 };
  const deadline = Date.now() + 10_000;
  for (;;) {
    for (const level of Object.keys(pids)) {
      try { pids[level] = Number(fs.readFileSync(path.join(dir, level + '.pid'), 'utf8')); } catch { /* not yet */ }
    }
    if (pids.parent && pids.child && pids.grandchild) break;
    if (Date.now() > deadline) throw new Error('tree fixture never wrote its pid files');
    await delay(100);
  }
  const exitResult = await host.cancel({ runId }).exitWait;
  assert.equal(exitResult.directChildExited, true);
  assert.equal(exitResult.treeConfirmed, true, 'registered identities verified dead through the real process table');
  assert.deepEqual(exitResult.unconfirmedPids, []);
  const receipt = host.getRunReceipt(runId);
  assert.ok(receipt.registeredDescendantPids.includes(pids.child), 'descendants were registered before the kill');
  assert.ok(receipt.registeredDescendantPids.includes(pids.grandchild));
  assert.match(String(await pending), /canceled/);
  await waitUntilDead([pids.parent, pids.child, pids.grandchild]);
});
