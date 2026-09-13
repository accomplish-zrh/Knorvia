'use strict';

// CLI bot backends: controlled adapters that let a Knorvia bot execute on an
// externally installed, official CLI (Codex CLI, Claude Code, Grok CLI).
//
// Hard boundaries:
// - Detection only runs version/auth probes. A generation task is never
//   started by detection, and a missing CLI is reported, never faked.
// - Every spawn uses an argument array (no shell), so paths with spaces or
//   CJK characters survive intact.
// - Cancellation terminates only process trees this module started.
// - Nothing here reads, writes or overwrites a user's global CLI config; the
//   caller passes the cwd and credentials stay inside the CLI's own store.
//
// Capability claims are per backend and honest: "unknown" is a valid answer
// and is preferred over an invented flag. `probeVerified` records whether a
// capability row comes from local detection, the fixture contract test, or
// public documentation only.

const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const METHOD_NAME_PREFIX = 'cliBackend/';

const METHODS = new Set([
  `${METHOD_NAME_PREFIX}list`,
  `${METHOD_NAME_PREFIX}status`,
  `${METHOD_NAME_PREFIX}runTurn`,
  `${METHOD_NAME_PREFIX}cancel`,
  `${METHOD_NAME_PREFIX}receipts`,
]);

const DETECT_CACHE_TTL_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 660_000;
const MIN_TURN_TIMEOUT_MS = 1_000;
const MAX_PROMPT_BYTES = 512 * 1024;
// Bounded capture budgets. Turn/probe output is never accumulated without a
// cap: diagnostics keep a head+tail excerpt, parsers get an explicit window,
// and anything beyond that is counted and reported instead of hoarded.
const TURN_PARSE_WINDOW_BYTES = 8 * 1024 * 1024;
const TURN_DIAG_HEAD_BYTES = 64 * 1024;
const TURN_DIAG_TAIL_BYTES = 64 * 1024;
const ANSWER_TEXT_LIMIT_BYTES = 2 * 1024 * 1024;
const PROBE_PARSE_WINDOW_BYTES = 1 * 1024 * 1024;
const PROBE_DIAG_HEAD_BYTES = 32 * 1024;
const PROBE_DIAG_TAIL_BYTES = 64 * 1024;
const RECEIPT_EXCERPT_BYTES = 4 * 1024;
const KILL_GRACE_MS = 10_000;
const KILL_ESCALATE_MS = 5_000;
const MAX_RECEIPTS = 50;

// Registry of known official CLIs. `run` builder receives
// ({ prompt, sessionId, resume }) and must return an argv array without the
// command itself. Resume support is declared per backend; "unknown" disables
// resume instead of guessing flags.
const KNOWN_BACKENDS = [
  {
    id: 'cli:codex',
    label: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    authProbe: { args: ['login', 'status'], loggedInHint: /logged in/i, loggedOutHint: /not logged in/i },
    run: ({ prompt, sessionId, resume }) =>
      resume && sessionId
        ? ['exec', 'resume', '--json', sessionId, prompt]
        : ['exec', '--json', prompt],
    parse: parseCodexJsonLines,
    capabilities: { resume: true, streaming: false, tools: true, cancellation: true },
    probeVerified: 'local-detection+fixture',
    docs: 'https://github.com/openai/codex',
  },
  {
    id: 'cli:claude',
    label: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    authProbe: null,
    run: ({ prompt, sessionId, resume }) => {
      const base = ['-p', '--output-format', 'json'];
      if (resume && sessionId) base.push('--resume', sessionId);
      base.push(prompt);
      return base;
    },
    parse: parseClaudeJson,
    capabilities: { resume: true, streaming: false, tools: true, cancellation: true },
    probeVerified: 'fixture',
    docs: 'https://code.claude.com/docs',
  },
  {
    id: 'cli:grok',
    label: 'Grok CLI',
    command: 'grok',
    versionArgs: ['--version'],
    authProbe: null,
    run: null, // No verified non-interactive run contract yet: status only.
    parse: null,
    capabilities: { resume: 'unknown', streaming: 'unknown', tools: 'unknown', cancellation: 'unknown' },
    probeVerified: 'local-detection',
    docs: 'https://docs.x.ai',
  },
];

// Incremental tracker for `codex exec --json` JSONL event streams. Feeding
// complete lines as they arrive keeps only the winning answer, session id and
// failure in memory, so a multi-gigabyte stream can never push the final
// agent message out of reach the way a truncated buffer would. Event
// semantics mirror parseCodexJsonLines exactly.
class JsonlAnswerTracker {
  constructor({ textLimit = ANSWER_TEXT_LIMIT_BYTES } = {}) {
    this.textLimit = textLimit;
    this.text = null;
    this.sessionId = null;
    this.failure = null;
    this.sawEvent = false;
    this.answerTruncatedBytes = 0;
    this._partial = '';
  }

  feedLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return; // Malformed lines cannot become a fabricated answer.
    }
    this.sawEvent = true;
    const msg = event.msg ?? event;
    if (msg.type === 'item.completed' && msg.item?.type === 'agent_message' && typeof msg.item.text === 'string') {
      this._setAnswer(msg.item.text);
    }
    if (msg.type === 'agent_message' && typeof msg.message === 'string') this._setAnswer(msg.message);
    if (msg.type === 'turn.failed' || msg.type === 'error') {
      this.failure = msg.error?.message ?? msg.message ?? 'CLI turn failed';
    }
    if (typeof msg.session_id === 'string') this.sessionId = msg.session_id;
    if (typeof msg.thread_id === 'string') this.sessionId = msg.thread_id;
  }

  // Splits a decoded chunk into complete lines; retains the partial tail.
  feed(chunk) {
    this._partial += chunk;
    let newlineAt;
    while ((newlineAt = this._partial.indexOf('\n')) !== -1) {
      const line = this._partial.slice(0, newlineAt);
      this._partial = this._partial.slice(newlineAt + 1);
      this.feedLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  }

  end() {
    if (this._partial) {
      this.feedLine(this._partial);
      this._partial = '';
    }
  }

  _setAnswer(text) {
    if (Buffer.byteLength(text, 'utf8') <= this.textLimit) {
      this.text = text;
      return;
    }
    // One answer alone overflows the limit: keep its tail and say loudly how
    // much was dropped instead of pretending the text is complete.
    const buf = Buffer.from(text, 'utf8');
    this.answerTruncatedBytes += buf.length - this.textLimit;
    this.text = buf.subarray(buf.length - this.textLimit).toString('utf8');
  }

  result() {
    return {
      text: this.text,
      sessionId: this.sessionId,
      error: this.failure,
      sawEvent: this.sawEvent,
      answerTruncatedBytes: this.answerTruncatedBytes,
    };
  }
}

// Bounded byte sink: retains a head+tail diagnostic excerpt and an explicit
// parse window, counts everything it had to drop.
class BoundedCapture {
  constructor({ parseLimit = TURN_PARSE_WINDOW_BYTES, headLimit = TURN_DIAG_HEAD_BYTES, tailLimit = TURN_DIAG_TAIL_BYTES } = {}) {
    this.parseLimit = parseLimit;
    this.headLimit = headLimit;
    this.tailLimit = tailLimit;
    this.parseBuf = Buffer.alloc(0);
    this.headBuf = Buffer.alloc(0);
    this.tailBuf = Buffer.alloc(0);
    this.parseOverflow = false;
    this.totalBytes = 0;
  }

  write(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    if (!buf.length) return;
    this.totalBytes += buf.length;
    const fill = (target, limit) => {
      if (target.length >= limit) return { buf: target, full: true };
      const room = limit - target.length;
      if (buf.length <= room) return { buf: Buffer.concat([target, buf]), full: false };
      return { buf: Buffer.concat([target, buf.subarray(0, room)]), full: true };
    };
    const parse = fill(this.parseBuf, this.parseLimit);
    this.parseBuf = parse.buf;
    this.parseOverflow = this.parseOverflow || parse.full;
    this.headBuf = fill(this.headBuf, this.headLimit).buf;
    const tail = Buffer.concat([this.tailBuf, buf]);
    this.tailBuf = tail.length > this.tailLimit ? tail.subarray(tail.length - this.tailLimit) : tail;
  }

  get parseText() {
    return this.parseBuf.toString('utf8');
  }

  // Head + explicit drop marker + tail, so excerpt readers see both the
  // beginning (version banners) and the end (final messages) with an honest
  // gap notice in between.
  get excerpt() {
    const head = this.headBuf.toString('utf8');
    const tail = this.tailBuf.toString('utf8');
    const dropped = this.totalBytes - this.headBuf.length - this.tailBuf.length;
    if (dropped > 0) return `${head}\n…[excerpt dropped ${dropped} bytes]…\n${tail}`;
    return head + tail;
  }
}

function parseCodexJsonLines(stdout) {
  // `codex exec --json` emits JSONL events; the final agent message is the
  // payload of the last `agent_message`-style event. Plain text output (no
  // JSON lines) is passed through so version drift degrades gracefully.
  const tracker = new JsonlAnswerTracker();
  for (const line of stdout.split(/\r?\n/)) tracker.feedLine(line);
  const result = tracker.result();
  if (result.text === null && !result.sawEvent) {
    return { text: stdout.trim() || null, sessionId: null, error: result.error };
  }
  return { text: result.text, sessionId: result.sessionId, error: result.error };
}

function parseClaudeJson(stdout) {
  // `claude -p --output-format json` prints one JSON object with result text
  // and session metadata. Non-JSON output is surfaced verbatim.
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return { text: trimmed || null, sessionId: null };
  try {
    const parsed = JSON.parse(trimmed);
    return {
      text: typeof parsed.result === 'string' ? parsed.result : null,
      sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
      error: parsed.is_error === true ? parsed.result ?? 'Claude turn failed' : null,
    };
  } catch {
    return { text: trimmed, sessionId: null };
  }
}

function nowIso() {
  return new Date().toISOString();
}

function isCmdShim(resolvedPath) {
  return /\.(cmd|bat)$/i.test(resolvedPath ?? '');
}

function canRunDirectly(backend, resolvedPath) {
  if (!resolvedPath || typeof backend.run !== 'function' || typeof backend.parse !== 'function') return false;
  if (!isCmdShim(resolvedPath)) return true;
  const entries = { 'cli:codex': ['@openai', 'codex', 'bin', 'codex.js'], 'cli:claude': ['@anthropic-ai', 'claude-code', 'cli.js'] };
  const parts = entries[backend.id];
  if (!parts) return false;
  try { return require('fs').statSync(path.join(path.dirname(resolvedPath), 'node_modules', ...parts)).isFile(); } catch { return false; }
}

// Probe-only launcher for .cmd/.bat shims. Node refuses to spawn .cmd/.bat
// directly (command-injection hardening), so fixed-argument probes go through
// cmd.exe with every argument double-quoted. NEVER pass user-controlled text
// here — probes use registry-fixed argv only.
function spawnArgv(argv, options = {}) {
  const { spawn } = require('child_process');
  if (isCmdShim(argv[0])) {
    // /S strips exactly one outer pair of quotes, so the whole command is
    // wrapped once more and passed verbatim (Node would otherwise escape
    // the inner quotes in a way cmd.exe cannot parse).
    const inner = argv.map((arg) => `"${String(arg).replaceAll('"', '')}"`).join(' ');
    return spawn('cmd.exe', ['/d', '/s', '/c', `"${inner}"`], {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
      cwd: options.cwd || undefined,
      env: options.env,
    });
  }
  return spawn(argv[0], argv.slice(1), {
    shell: false,
    windowsHide: true,
    cwd: options.cwd || undefined,
    env: options.env,
  });
}

class CliBackendHost {
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => Date.now());
    this.backends = (options.backends ?? KNOWN_BACKENDS).map((backend) => Object.freeze({ ...backend }));
    this._detectCache = new Map();
    this._runs = new Map();
    this._receipts = new Map();
    this._pathOverride = options.pathOverride ?? null;
  }

  _whichPath(backend) {
    // Test seam: resolve "command on PATH" through an injectable lookup so
    // fixture tests never need real CLIs installed.
    if (this._pathOverride) return this._pathOverride(backend.command);
    const pathVar = this.env.PATH ?? this.env.Path ?? '';
    const exts = process.platform === 'win32'
      ? (this.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
      : [''];
    const quietWin = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [];
    for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
      for (const ext of [...exts, ...quietWin]) {
        const candidate = path.join(dir, `${backend.command}${ext.toLowerCase()}`);
        try {
          require('fs').accessSync(candidate);
          return candidate;
        } catch {
          // keep searching
        }
      }
    }
    return null;
  }

  _probe(backend, cacheKey) {
    const cached = this._detectCache.get(cacheKey);
    if (cached && this.now() - cached.at < DETECT_CACHE_TTL_MS) return cached.value;
    const resolved = this._whichPath(backend);
    const result = {
      backendId: backend.id,
      label: backend.label,
      installed: Boolean(resolved),
      resolvedPath: resolved,
      version: null,
      authenticated: 'unknown',
      authState: resolved ? 'unknown' : 'not-installed',
      capabilities: { ...backend.capabilities, installed: Boolean(resolved), run: canRunDirectly(backend, resolved) },
      probeVerified: backend.probeVerified,
      docs: backend.docs,
      checkedAt: nowIso(),
    };
    this._detectCache.set(cacheKey, { at: this.now(), value: result });
    return result;
  }

  async _spawnCapture(argv, options = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnArgv(argv, { cwd: options.cwd, env: this.env });
      } catch (error) {
        resolve({ ok: false, exitCode: null, stdout: '', stderr: String(error) });
        return;
      }
      // Probes are bounded like turns: excerpt-only retention, tree kill on
      // timeout, and exit confirmation instead of fire-and-forget kills.
      const run = this._newRunRecord({ runId: `probe_${child.pid ?? 'x'}`, backendId: 'probe', child });
      const out = new BoundedCapture({
        parseLimit: PROBE_PARSE_WINDOW_BYTES,
        headLimit: PROBE_DIAG_HEAD_BYTES,
        tailLimit: PROBE_DIAG_TAIL_BYTES,
      });
      const err = new BoundedCapture({
        parseLimit: PROBE_PARSE_WINDOW_BYTES,
        headLimit: PROBE_DIAG_HEAD_BYTES,
        tailLimit: PROBE_DIAG_TAIL_BYTES,
      });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => out.write(Buffer.from(chunk, 'utf8')));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => err.write(Buffer.from(chunk, 'utf8')));
      const timer = options.timeoutMs
        ? setTimeout(() => {
          run.timedOut = true;
          this._killTree(run, { reason: 'probe-timeout' });
        }, options.timeoutMs)
        : null;
      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        this._settleExitWaiters(run);
        resolve({ ok: false, exitCode: null, stdout: out.excerpt, stderr: `${err.excerpt}${error}` });
      });
      child.on('close', (exitCode) => {
        if (timer) clearTimeout(timer);
        this._settleExitWaiters(run);
        resolve({ ok: exitCode === 0, exitCode, stdout: out.excerpt, stderr: err.excerpt });
      });
    });
  }

  async list() {
    const results = [];
    for (const backend of this.backends) {
      const probe = this._probe(backend, backend.id);
      // Real local version detection: the probe runs the CLI's version
      // command once per TTL window and reports what the binary prints.
      if (probe.installed && probe.version === null && backend.versionArgs.length) {
        const version = await this._spawnCapture(
          [probe.resolvedPath, ...backend.versionArgs],
          { timeoutMs: 15_000 },
        );
        if (version.ok) {
          probe.version = version.stdout.split(/\r?\n/).find((line) => line.trim())?.trim() ?? null;
        } else {
          probe.version = null;
          probe.installed = false;
          probe.authState = 'not-installed';
          probe.resolvedPath = null;
          this._detectCache.set(backend.id, { at: this.now(), value: probe });
          results.push({ ...probe });
          continue;
        }
      }
      if (probe.installed && backend.authProbe) {
        const auth = await this._spawnCapture([probe.resolvedPath, ...backend.authProbe.args], { timeoutMs: 15_000 });
        if (auth.ok) {
          probe.authenticated = true;
          probe.authState = 'connected';
        } else if (backend.authProbe.loggedOutHint && backend.authProbe.loggedOutHint.test(auth.stdout + auth.stderr)) {
          probe.authenticated = false;
          probe.authState = 'needs-user';
        } else {
          probe.authenticated = 'unknown';
        }
      }
      if (probe.installed && !backend.authProbe) {
        // Without a public auth probe we refuse to invent a login state.
        probe.authState = 'unknown';
      }
      results.push({ ...probe });
    }
    return results;
  }

  async status({ backendId } = {}) {
    const backend = this.backends.find((candidate) => candidate.id === backendId);
    if (!backend) {
      throw new Error(`unknown CLI backend ${backendId}; known: ${this.backends.map((b) => b.id).join(', ')}`);
    }
    const all = await this.list();
    return all.find((entry) => entry.backendId === backendId);
  }

  async runTurn(params) {
    const {
      backendId,
      prompt,
      cwd,
      sessionId,
      resume = false,
      timeoutMs,
    } = params ?? {};
    if (!prompt || Buffer.byteLength(String(prompt), 'utf8') > MAX_PROMPT_BYTES) {
      throw new Error('cliBackend/runTurn needs a prompt within 512 KiB');
    }
    const backend = this.backends.find((candidate) => candidate.id === backendId);
    if (!backend) throw new Error(`unknown CLI backend ${backendId}`);
    if (typeof backend.run !== 'function' || typeof backend.parse !== 'function') {
      throw new Error(`backend ${backendId} has no verified run contract; status only`);
    }
    if (resume && (typeof sessionId !== 'string' || !sessionId.trim())) {
      throw new Error('resume requires an explicit sessionId; recent-session fallback is forbidden');
    }
    if (sessionId && !resume) {
      throw new Error('sessionId requires resume=true; refusing to silently start a fresh session');
    }
    if (resume && backend.capabilities.resume !== true) {
      throw new Error(`backend ${backendId} does not declare resume support; refusing to guess flags`);
    }
    const probe = this._probe(backend, backend.id);
    if (!probe.installed) {
      throw new Error(`backend ${backendId} is not installed on this machine`);
    }
    // Security boundary (A11): user prompt text must never pass through
    // cmd.exe. A Windows .cmd/.bat shim cannot carry argv safely, so turn
    // execution requires a real executable; probes stay available.
    let executable = probe.resolvedPath;
    let prefix = [];
    if (isCmdShim(executable)) {
      // Known npm packages have a fixed Node entrypoint. Resolve that file
      // directly without parsing/executing the shim or putting prompts in cmd.
      const entrypoints = {
        'cli:codex': ['@openai', 'codex', 'bin', 'codex.js'],
        'cli:claude': ['@anthropic-ai', 'claude-code', 'cli.js'],
      };
      const parts = entrypoints[backendId];
      const entrypoint = parts && path.join(path.dirname(executable), 'node_modules', ...parts);
      if (entrypoint && require('fs').existsSync(entrypoint) && require('fs').statSync(entrypoint).isFile()) {
        executable = process.execPath;
        prefix = [entrypoint];
      }
    }
    if (isCmdShim(executable)) {
      throw new Error(
        `backend ${backendId} resolved to a .cmd shim ("${probe.resolvedPath}"); ` +
        'turn execution requires a direct .exe — detection and status stay available',
      );
    }
    const argv = [executable, ...prefix, ...backend.run({ prompt: String(prompt), sessionId, resume })];
    const runId = params.runId ?? `clirun_${crypto.randomBytes(8).toString('hex')}`;
    if (!/^clirun_[a-zA-Z0-9_-]{8,80}$/.test(runId) || this._runs.has(runId)) throw new Error('runId must be unique and start with clirun_');
    const effectiveTimeout = Math.max(
      MIN_TURN_TIMEOUT_MS,
      Math.min(Number(timeoutMs) || DEFAULT_TURN_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS),
    );
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), {
          shell: false,
          windowsHide: true,
          cwd: cwd || undefined,
          env: prefix.length ? { ...this.env, ELECTRON_RUN_AS_NODE: '1' } : this.env,
        });
      } catch (error) {
        reject(new Error(`failed to spawn ${backendId}: ${error.message}`));
        return;
      }
      const run = this._newRunRecord({ runId, backendId, child });
      this._runs.set(runId, run);
      const out = new BoundedCapture();
      const err = new BoundedCapture();
      // Codex-style JSONL is tracked incrementally line by line, so the final
      // answer survives even when raw output vastly exceeds the parse window.
      const tracker = backend.parse === parseCodexJsonLines ? new JsonlAnswerTracker() : null;
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        out.write(Buffer.from(chunk, 'utf8'));
        if (tracker) tracker.feed(chunk);
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => err.write(Buffer.from(chunk, 'utf8')));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        run.timedOut = true;
        this.cancel({ runId });
      }, effectiveTimeout);
      const finish = (fn) => {
        if (run.settled) return;
        run.settled = true;
        run.finished = true;
        run.finishedAt = nowIso();
        clearTimeout(timer);
        this._runs.delete(runId);
        this._settleExitWaiters(run);
        fn();
      };
      const failureSuffix = () => ` [receipt: ${runId}]`;
      child.on('error', (error) => {
        const message = `${backendId} failed to start: ${error.message}`;
        this._recordReceipt(run, 'spawn-error', null, message, { out, err });
        finish(() => reject(new Error(message)));
      });
      child.on('close', (exitCode) => {
        if (timedOut) {
          const message = `${backendId} turn timed out after ${effectiveTimeout}ms; process tree terminated${failureSuffix()}`;
          this._recordReceipt(run, 'timeout', exitCode, message, { out, err });
          finish(() => reject(new Error(message)));
          return;
        }
        if (run.canceled) {
          const message = `${backendId} turn canceled${failureSuffix()}`;
          this._recordReceipt(run, 'canceled', exitCode, null, { out, err });
          finish(() => reject(new Error(message)));
          return;
        }
        if (exitCode !== 0) {
          finish(() => {
            const detail = (err.excerpt || out.excerpt).slice(0, 2000);
            const error = new Error(`${backendId} exited with code ${exitCode}: ${detail}${failureSuffix()}`);
            error.exitCode = exitCode;
            this._recordReceipt(run, 'failed', exitCode, error.message, { out, err });
            reject(error);
          });
          return;
        }
        let parsed;
        let answerTruncatedBytes = 0;
        if (tracker) {
          // Incremental tracking already holds every event that mattered, so
          // a full parse window is unnecessary — the answer cannot have been
          // silently dropped no matter how much raw output overflowed.
          tracker.end();
          const tracked = tracker.result();
          if (tracked.sawEvent) {
            parsed = { text: tracked.text, sessionId: tracked.sessionId, error: tracked.error };
            answerTruncatedBytes = tracked.answerTruncatedBytes;
          } else if (out.parseOverflow) {
            parsed = { overflow: true };
          } else {
            parsed = { text: out.parseText.trim() || null, sessionId: null, error: tracked.error };
          }
        } else if (out.parseOverflow) {
          parsed = { overflow: true };
        } else {
          parsed = backend.parse(out.parseText);
        }
        if (parsed.overflow) {
          // The bounded parse window overflowed and there is no incremental
          // tracker: refuse to guess a final answer from a truncated window,
          // and say so instead of silently dropping it.
          const message = `${backendId} output exceeded the ${TURN_PARSE_WINDOW_BYTES} byte parse window; final answer withheld instead of guessed${failureSuffix()}`;
          this._recordReceipt(run, 'parse-overflow', exitCode, message, { out, err });
          finish(() => reject(new Error(message)));
          return;
        }
        if (parsed.error || !parsed.text) {
          const message = `${backendId}: ${parsed.error || 'CLI returned no completed assistant message'}${failureSuffix()}`;
          this._recordReceipt(run, 'no-answer', exitCode, message, { out, err });
          finish(() => reject(new Error(message)));
          return;
        }
        if (resume && parsed.sessionId && parsed.sessionId !== sessionId) {
          const message = `${backendId} resumed a different session; anchor was not changed${failureSuffix()}`;
          this._recordReceipt(run, 'anchor-mismatch', exitCode, message, { out, err });
          finish(() => reject(new Error(message)));
          return;
        }
        const receipt = this._recordReceipt(run, 'completed', exitCode, null, { out, err });
        finish(() => resolve({
          runId,
          backendId,
          text: parsed.text,
          sessionId: parsed.sessionId ?? sessionId ?? null,
          exitCode,
          durationMs: Date.now() - Date.parse(run.startedAt),
          ...(answerTruncatedBytes > 0 ? { answerTruncatedBytes } : {}),
          receipt,
        }));
      });
    });
  }

  _newRunRecord({ runId, backendId, child }) {
    return {
      runId,
      backendId,
      pid: child?.pid ?? null,
      startedAt: nowIso(),
      child,
      finished: false,
      settled: false,
      canceled: false,
      timedOut: false,
      exited: false,
      killEvents: [],
      exitWaiters: [],
      registeredDescendants: [],
    };
  }

  // Resolves every exitWait waiter with `true`: the child's close/error event
  // fired, so nothing spawned under this run record is still our direct
  // child. Tree members are verified by cancel()/closeAll() callers.
  _settleExitWaiters(run) {
    run.exited = true;
    for (const waiter of run.exitWaiters.splice(0)) waiter.resolve(true);
  }

  _waitForExit(run, ms) {
    if (run.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      };
      const timer = setTimeout(() => {
        const index = run.exitWaiters.indexOf(waiter);
        if (index !== -1) run.exitWaiters.splice(index, 1);
        resolve(false);
      }, ms);
      timer.unref?.();
      run.exitWaiters.push(waiter);
    });
  }

  // Kills the process tree this host started. Windows uses taskkill /T /F on
  // the exact root PID; POSIX escalates TERM → KILL. The kill is fire from
  // the cancel() call site, but its result is awaited separately by
  // _cancelAndWaitExit so termination claims are backed by evidence. Every
  // attempt is logged into the run's kill events for the diagnostic receipt.
  _killTree(run, { reason } = {}) {
    const event = { at: nowIso(), reason: reason ?? 'cancel', method: null, escalated: false };
    run.killEvents.push(event);
    try {
      if (process.platform === 'win32') {
        event.method = 'taskkill /T /F';
        event.taskkillDone = this._spawnTreeKill(run.pid, event);
      } else {
        event.method = 'SIGTERM';
        run.child?.kill('SIGTERM');
        setTimeout(() => {
          if (run.exited) return;
          try {
            run.child?.kill('SIGKILL');
            event.escalated = true;
          } catch { /* already gone */ }
        }, 3000).unref?.();
      }
    } catch (error) {
      event.error = String(error);
    }
  }

  // Overridable termination seams (tests inject failures here; production
  // uses taskkill). Returns a promise of { exitCode } for the kill tool.
  _spawnTreeKill(pid, event) {
    return new Promise((resolve) => {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
          .on('exit', (code) => {
            event.taskkillExitCode = code;
            resolve({ exitCode: code });
          })
          .on('error', (error) => {
            event.error = String(error);
            resolve({ exitCode: null, error: String(error) });
          });
      } catch (error) {
        event.error = String(error);
        resolve({ exitCode: null, error: String(error) });
      }
    });
  }

  // Enumerates the live descendant tree of a PID with creation identity
  // (PID + creation timestamp) so later verification cannot be fooled by PID
  // reuse. Overridable in tests; production uses one PowerShell CIM snapshot
  // per call, emitted pipe-delimited so quoting layers cannot mangle it.
  async _processTable() {
    if (this._processTableOverride) return this._processTableOverride();
    if (process.platform !== 'win32') return [];
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const rows = await new Promise((resolve) => {
      try {
        const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { \'{0}|{1}|{2}\' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate }'], { windowsHide: true });
        let out = '';
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => { out += chunk; });
        child.on('error', () => resolve(null));
        const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, 8000);
        timer.unref?.();
        child.on('exit', () => { clearTimeout(timer); resolve(out); });
      } catch { resolve(null); }
    });
    if (!rows) return null;
    const table = [];
    for (const line of rows.split(/\r?\n/)) {
      const cells = line.split('|');
      if (cells.length < 3) continue;
      const pid = Number(cells[0]);
      const ppid = Number(cells[1]);
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue;
      table.push({ pid, ppid, creation: cells.slice(2).join('|') });
    }
    return table;
  }

  _descendantsFromTable(table, rootPid) {
    const byParent = new Map(table.map(row => [row.pid, row]));
    const descendants = new Map();
    const walk = (parentPid) => {
      for (const row of table) {
        if (row.ppid !== parentPid || descendants.has(row.pid)) continue;
        descendants.set(row.pid, row);
        walk(row.pid);
      }
    };
    walk(rootPid);
    return [...descendants.values()];
  }

  // Verifies registered descendants are really gone: existence first, then
  // creation identity for anything still alive, so a reused PID never passes
  // for our tree. Returns { confirmedPids, unconfirmedPids }.
  async _verifyDescendants(descendants) {
    const confirmed = [];
    const unconfirmed = [];
    const stillAlive = [];
    for (const row of descendants) {
      let alive = false;
      try { process.kill(row.pid, 0); alive = true; } catch { alive = false; }
      if (!alive) confirmed.push(row.pid);
      else stillAlive.push(row);
    }
    if (!stillAlive.length) return { confirmedPids: confirmed, unconfirmedPids: unconfirmed };
    // One fresh table for identity checks of survivors.
    const table = await this._processTable();
    if (!table) {
      // Cannot verify: report unconfirmed rather than guessing.
      for (const row of stillAlive) unconfirmed.push(row.pid);
      return { confirmedPids: confirmed, unconfirmedPids: unconfirmed, verificationFailed: true };
    }
    for (const row of stillAlive) {
      const current = table.find(entry => entry.pid === row.pid);
      if (!current) confirmed.push(row.pid);
      else if (current.creation === row.creation) unconfirmed.push(row.pid);
      else confirmed.push(row.pid); // PID reused by an unrelated process
    }
    return { confirmedPids: confirmed, unconfirmedPids: unconfirmed };
  }

  async _cancelAndWaitExit(run, reason) {
    // Register the descendant tree (with creation identity) BEFORE killing,
    // then kill and await both the direct child close and the kill tool.
    let descendants = [];
    let enumerated = false;
    if (process.platform === 'win32') {
      try {
        const table = await this._processTable();
        if (table) { descendants = this._descendantsFromTable(table, run.pid); enumerated = true; }
      } catch { enumerated = false; }
    }
    run.registeredDescendants = descendants;
    this._killTree(run, { reason });
    const killResult = await Promise.resolve(run.killEvents.at(-1)?.taskkillDone);
    let directChildExited = await this._waitForExit(run, KILL_GRACE_MS);
    if (!directChildExited && process.platform === 'win32') {
      this._killTree(run, { reason: `${reason}-escalate` });
      await Promise.resolve(run.killEvents.at(-1)?.taskkillDone);
      directChildExited = await this._waitForExit(run, KILL_ESCALATE_MS);
    }
    if (process.platform !== 'win32') {
      // Only the direct child's close is verified here; no tree claim is
      // made on this platform and tests must not present it as verified.
      return { directChildExited, treeConfirmed: false, unconfirmedPids: [], reason: 'tree confirmation is only implemented on Windows' };
    }
    if (!enumerated) {
      return { directChildExited, treeConfirmed: false, unconfirmedPids: [], reason: 'descendant enumeration unavailable' };
    }
    let verification = await this._verifyDescendants(descendants);
    // Kill-tool failure or surviving descendants: retry each registered,
    // still-verified survivor directly (they are our tree by identity), then
    // re-verify once.
    if (unconfirmedSurvivors(verification).length || (killResult && killResult.exitCode !== 0 && directChildExited)) {
      for (const pid of unconfirmedSurvivors(verification)) {
        try { await this._spawnTreeKill(pid, { method: 'taskkill /PID /T /F (survivor)' }); } catch { /* best effort */ }
      }
      verification = await this._verifyDescendants(descendants);
    }
    return {
      directChildExited,
      treeConfirmed: verification.unconfirmedPids.length === 0,
      unconfirmedPids: verification.unconfirmedPids,
      ...(verification.verificationFailed ? { reason: 'descendant verification failed' } : {}),
    };

    function unconfirmedSurvivors(current) {
      return current.unconfirmedPids ?? [];
    }
  }

  _recordReceipt(run, outcome, exitCode, error, { out, err } = {}) {
    const receipt = {
      runId: run.runId,
      backendId: run.backendId,
      pid: run.pid,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? nowIso(),
      durationMs: Date.now() - Date.parse(run.startedAt),
      outcome,
      exitCode,
      canceled: Boolean(run.canceled),
      timedOut: Boolean(run.timedOut),
      error: error ? String(error).slice(0, 2000) : null,
      killEvents: (run.killEvents ?? []).map((event) => ({ ...event })),
      registeredDescendantPids: (run.registeredDescendants ?? []).map(row => row.pid),
      outputBytes: out?.totalBytes ?? 0,
      outputDroppedBytes: out ? Math.max(0, out.totalBytes - out.parseBuf.length) : 0,
      outputTruncated: Boolean(out?.parseOverflow),
      stdoutExcerpt: out ? out.excerpt.slice(0, RECEIPT_EXCERPT_BYTES * 4) : '',
      stderrExcerpt: err ? err.excerpt.slice(0, RECEIPT_EXCERPT_BYTES * 4) : '',
    };
    this._receipts.set(receipt.runId, receipt);
    while (this._receipts.size > MAX_RECEIPTS) {
      const oldest = this._receipts.keys().next().value;
      this._receipts.delete(oldest);
    }
    return receipt;
  }

  getRunReceipt(runId) {
    return this._receipts.get(runId) ?? null;
  }

  runReceipts() {
    return [...this._receipts.values()];
  }

  cancel({ runId } = {}) {
    const run = runId ? this._runs.get(runId) : null;
    if (!run) return { canceled: false, reason: 'no such active run owned by this host' };
    run.killEvents ??= [];
    run.exitWaiters ??= [];
    if (run.canceled) {
      // Repeated cancel is honest and idempotent: report that a kill is
      // already in flight instead of pretending to cancel again.
      return { canceled: true, runId, pid: run.pid, alreadyCanceling: true, exitWait: run.exitPromise ?? null };
    }
    run.canceled = true;
    run.cancelRequestedAt = nowIso();
    run.exitPromise = this._cancelAndWaitExit(run, 'cancel');
    return { canceled: true, runId, pid: run.pid, exitWait: run.exitPromise };
  }

  // Cancel every live run and wait (bounded) for termination confirmation.
  // Each run's structured exit result is kept individually: a single
  // unconfirmed run makes exitedWithinTimeout false and is listed by id, so
  // callers (desktop shutdown) can record the failure instead of believing
  // everything exited.
  async closeAll({ timeoutMs = KILL_GRACE_MS + KILL_ESCALATE_MS + 20_000, signal } = {}) {
    const runs = [...this._runs.values()];
    if (!runs.length) return { canceled: 0, exitedWithinTimeout: true, unconfirmedRuns: [] };
    const pairs = runs
      .map(run => ({ run, exitWait: this.cancel({ runId: run.runId }).exitWait }))
      .filter(pair => pair.exitWait);
    const timeoutHandle = new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs));
      timer.unref?.();
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(null); }, { once: true });
    });
    const settled = await Promise.race([Promise.all(pairs.map(pair => pair.exitWait)), timeoutHandle]);
    if (!settled) {
      return {
        canceled: runs.length,
        exitedWithinTimeout: false,
        unconfirmedRuns: pairs.map(pair => pair.run.runId),
        reason: 'closeAll timed out before all exit results settled',
      };
    }
    const unconfirmedRuns = [];
    pairs.forEach((pair, index) => {
      const result = settled[index];
      if (!result || result.directChildExited !== true || result.treeConfirmed !== true) unconfirmedRuns.push(pair.run.runId);
    });
    return { canceled: runs.length, exitedWithinTimeout: unconfirmedRuns.length === 0, unconfirmedRuns };
  }

  activeRuns() {
    return [...this._runs.keys()];
  }

  activePids() {
    return [...new Set([...this._runs.values()].map(run => run.pid).filter(pid => Number.isInteger(pid) && pid > 0))];
  }

  availableBackendIds() {
    return this.backends.filter(backend => { const probe = this._probe(backend, backend.id); return probe.installed && canRunDirectly(backend, probe.resolvedPath); }).map(backend => backend.id);
  }
}

function createCliBackendHandlers(options) {
  const host = new CliBackendHost(options);
  // Cancel responses must stay JSON-serializable: the internal exitWait
  // promise never crosses the wire; awaitExitMs lets RPC callers opt into a
  // bounded real-exit confirmation instead.
  const toWireCancel = async (params) => {
    const { exitWait, ...wire } = host.cancel(params ?? {});
    const awaitExitMs = Number(params?.awaitExitMs);
    if (exitWait && Number.isFinite(awaitExitMs) && awaitExitMs > 0) {
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), awaitExitMs);
        timer.unref?.();
      });
      const result = await Promise.race([exitWait, timedOut]);
      if (timer) clearTimeout(timer);
      if (!result) return { ...wire, exited: false, exitUnconfirmed: true };
      return {
        ...wire,
        exited: result.directChildExited === true && result.treeConfirmed === true,
        directChildExited: result.directChildExited === true,
        treeConfirmed: result.treeConfirmed === true,
        unconfirmedPids: result.unconfirmedPids ?? [],
        ...(result.reason ? { reason: result.reason } : {}),
      };
    }
    return wire;
  };
  return {
    host,
    handlers: {
      [`${METHOD_NAME_PREFIX}list`]: async () => ({ backends: await host.list() }),
      [`${METHOD_NAME_PREFIX}status`]: async (params) => await host.status(params ?? {}),
      [`${METHOD_NAME_PREFIX}runTurn`]: async (params) => await host.runTurn(params ?? {}),
      [`${METHOD_NAME_PREFIX}cancel`]: toWireCancel,
      [`${METHOD_NAME_PREFIX}receipts`]: async (params) => {
        const runId = params?.runId;
        if (runId) return { receipts: host.getRunReceipt(runId) ? [host.getRunReceipt(runId)] : [] };
        return { receipts: host.runReceipts() };
      },
    },
  };
}

module.exports = {
  METHODS,
  METHOD_NAME_PREFIX,
  KNOWN_BACKENDS,
  CliBackendHost,
  createCliBackendHandlers,
  parseCodexJsonLines,
  parseClaudeJson,
  JsonlAnswerTracker,
  BoundedCapture,
};
