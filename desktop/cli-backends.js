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
]);

const DETECT_CACHE_TTL_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 660_000;
const MIN_TURN_TIMEOUT_MS = 1_000;
const MAX_PROMPT_BYTES = 512 * 1024;

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

function parseCodexJsonLines(stdout) {
  // `codex exec --json` emits JSONL events; the final agent message is the
  // payload of the last `agent_message`-style event. Plain text output (no
  // JSON lines) is passed through so version drift degrades gracefully.
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
  let text = null;
  let sessionId = null;
  let sawEvent = false;
  let failure = null;
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      sawEvent = true;
      const msg = event.msg ?? event;
      if (msg.type === 'item.completed' && msg.item?.type === 'agent_message' && typeof msg.item.text === 'string') text = msg.item.text;
      if (msg.type === 'agent_message' && typeof msg.message === 'string') text = msg.message;
      if (msg.type === 'turn.failed' || msg.type === 'error') failure = msg.error?.message ?? msg.message ?? 'CLI turn failed';
      if (typeof msg.session_id === 'string') sessionId = msg.session_id;
      if (typeof msg.thread_id === 'string') sessionId = msg.thread_id;
    } catch {
      // Ignore malformed lines; they cannot become a fabricated answer.
    }
  }
  if (text === null && !sawEvent) text = stdout.trim() || null;
  return { text, sessionId, error: failure };
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
      let stdout = '';
      let stderr = '';
      const timer = options.timeoutMs
        ? setTimeout(() => {
          try { child.kill(); } catch { /* already gone */ }
        }, options.timeoutMs)
        : null;
      child.stdout?.on('data', (chunk) => { stdout += chunk; });
      child.stderr?.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        resolve({ ok: false, exitCode: null, stdout, stderr: `${stderr}${error}` });
      });
      child.on('close', (exitCode) => {
        if (timer) clearTimeout(timer);
        resolve({ ok: exitCode === 0, exitCode, stdout, stderr });
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
      const run = {
        runId,
        backendId,
        pid: child.pid,
        startedAt: nowIso(),
        child,
        finished: false,
      };
      this._runs.set(runId, run);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this.cancel({ runId });
      }, effectiveTimeout);
      const finish = (fn) => {
        if (run.settled) return;
        run.settled = true;
        clearTimeout(timer);
        run.finished = true;
        this._runs.delete(runId);
        fn();
      };
      child.stdout?.on('data', (chunk) => { stdout += chunk; });
      child.stderr?.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => finish(() => reject(new Error(`${backendId} failed to start: ${error.message}`))));
      child.on('close', (exitCode) => {
        if (timedOut) {
          finish(() => reject(new Error(`${backendId} turn timed out after ${effectiveTimeout}ms`)));
          return;
        }
        if (run.canceled) {
          finish(() => reject(new Error(`${backendId} turn canceled`)));
          return;
        }
        if (exitCode !== 0) {
          finish(() => {
            const error = new Error(
              `${backendId} exited with code ${exitCode}: ${(stderr || stdout).slice(0, 2000)}`,
            );
            error.exitCode = exitCode;
            reject(error);
          });
          return;
        }
        const parsed = backend.parse(stdout);
        if (parsed.error || !parsed.text) {
          finish(() => reject(new Error(`${backendId}: ${parsed.error || 'CLI returned no completed assistant message'}`)));
          return;
        }
        if (resume && parsed.sessionId && parsed.sessionId !== sessionId) {
          finish(() => reject(new Error(`${backendId} resumed a different session; anchor was not changed`)));
          return;
        }
        finish(() => resolve({
          runId,
          backendId,
          text: parsed.text,
          sessionId: parsed.sessionId ?? sessionId ?? null,
          exitCode,
          durationMs: Date.now() - Date.parse(run.startedAt),
        }));
      });
    });
  }

  cancel({ runId } = {}) {
    const run = runId ? this._runs.get(runId) : null;
    if (!run) return { canceled: false, reason: 'no such active run owned by this host' };
    run.finished = true;
    run.canceled = true;
    this._runs.delete(runId);
    try {
      if (process.platform === 'win32') {
        // /T kills the process tree Windows recorded for this exact PID.
        spawn('taskkill', ['/pid', String(run.pid), '/T', '/F'], { windowsHide: true });
      } else {
        run.child.kill('SIGTERM');
        setTimeout(() => {
          try { run.child.kill('SIGKILL'); } catch { /* already gone */ }
        }, 3000).unref?.();
      }
    } catch (error) {
      return { canceled: false, reason: String(error) };
    }
    return { canceled: true, runId, pid: run.pid };
  }

  activeRuns() {
    return [...this._runs.keys()];
  }

  availableBackendIds() {
    return this.backends.filter(backend => { const probe = this._probe(backend, backend.id); return probe.installed && canRunDirectly(backend, probe.resolvedPath); }).map(backend => backend.id);
  }
}

function createCliBackendHandlers(options) {
  const host = new CliBackendHost(options);
  return {
    host,
    handlers: {
      [`${METHOD_NAME_PREFIX}list`]: async () => ({ backends: await host.list() }),
      [`${METHOD_NAME_PREFIX}status`]: async (params) => await host.status(params ?? {}),
      [`${METHOD_NAME_PREFIX}runTurn`]: async (params) => await host.runTurn(params ?? {}),
      [`${METHOD_NAME_PREFIX}cancel`]: async (params) => host.cancel(params ?? {}),
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
};
