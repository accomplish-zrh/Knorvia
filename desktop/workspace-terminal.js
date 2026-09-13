'use strict';

// A manually operated host terminal, separate from Kernel-owned agent turns.
// The daemon resolves the initial directory; the renderer cannot supply a
// command, executable, environment or absolute cwd to terminal/open.
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { connectionError } = require('./connection-config');
const { verifyResolvedPath } = require('./desktop-path-actions');
const { createTerminalProfiles } = require('./terminal-profiles');

const MAX_BUFFER = 512 * 1024;
const MAX_READ = 32 * 1024;
const MAX_INPUT = 16 * 1024;
const METHODS = ['terminal/open', 'terminal/list', 'terminal/read', 'terminal/write', 'terminal/resize', 'terminal/close', 'terminal/profiles/list', 'terminal/profiles/default'];
const fail = (code, message) => { throw connectionError(code, message); };

function paramsFor(params, extras = [], session = true) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail(-32602, 'Terminal params must be an object');
  const keys = ['threadId', ...(session ? ['sessionId'] : []), ...extras];
  for (const key of Object.keys(params)) if (!keys.includes(key)) fail(-32602, `Terminal does not accept ${key}`);
  if (typeof params.threadId !== 'string' || !params.threadId || params.threadId.length > 160) fail(-32602, 'A persistent threadId is required');
  if (session && (typeof params.sessionId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(params.sessionId))) fail(-32602, 'A terminal session UUID is required');
  return params;
}
function dimensions(params) {
  for (const key of ['cols', 'rows']) if (!Number.isInteger(params[key]) || params[key] < 2 || params[key] > (key === 'cols' ? 500 : 250)) fail(-32602, 'Terminal size is out of range');
  return { cols: params.cols, rows: params.rows };
}
function terminalEnvironment(env) {
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !/^(KNORVIA_|ELECTRON_|NODE_OPTIONS$|OPENAI_API_KEY$|DEEPSEEK_API_KEY$)/i.test(key)) result[key] = String(value);
  }
  return { ...result, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Knorvia' };
}

function createWorkspaceTerminal({ rpc, spawn, env = process.env, home, profiles, maxSessions = 24, maxPerThread = 8, maxExitedPerThread = 4, maxExitedTotal = 32, exitedRetentionMs = 300_000, exitedBufferMax = 64 * 1024, disposeTimeoutMs = 5000 } = {}) {
  if (typeof rpc !== 'function') throw new Error('Terminal requires scoped daemon RPC');
  // C18: shell choice comes from a host-managed profile directory; without
  // the injected service (or an app Home to persist the preference) the
  // platform default shell is used exactly as before.
  const profileService = profiles ?? (home ? createTerminalProfiles({ home, env }) : undefined);
  const sessions = new Map();
  let exitSeqCounter = 0;
  // `live` counts only terminals still holding a PTY (running or closing), so
  // quota is a resource count, not a record count.
  const live = new Set();
  // Closing also invalidates an in-flight open. A delayed retry cannot silently
  // start another shell after the user has closed its tab.
  const closed = new Map();
  let disposed = false;
  const keyOf = p => JSON.stringify([p.threadId, p.sessionId]);
  const inThread = (key, threadId) => JSON.parse(key)[0] === threadId;
  function rememberClosed(key) {
    closed.set(key, true);
    if (closed.size > 1024) closed.delete(closed.keys().next().value);
  }
  // Exited terminals are kept as a bounded, expiring history: the newest
  // exits stay readable (tail output + exit code) up to per-thread, global
  // and time caps; eviction marks the key closed so cursors and retries get
  // the same honest "session has ended" answer instead of a resurrection.
  // `history` indexes the settled records because `sessions` stores promises.
  const history = new Map();
  function evictExited(key) {
    history.delete(key);
    sessions.delete(key);
    rememberClosed(key);
  }
  function sweepExited(now = Date.now()) {
    const all = [];
    for (const [key, value] of history) {
      if (now - value.exitedAt > exitedRetentionMs) evictExited(key);
      else all.push([key, value]);
    }
    // Newest first: the most recent exits are the ones worth keeping.
    // Newest first by a monotonic sequence (timestamps alone tie within a
    // millisecond and would make eviction order nondeterministic).
    all.sort((a, b) => b[1].exitSeq - a[1].exitSeq);
    const perThread = new Map();
    let total = 0;
    for (const [key, value] of all) {
      const count = perThread.get(value.threadId) ?? 0;
      if (count >= maxExitedPerThread || total >= maxExitedTotal) evictExited(key);
      else { perThread.set(value.threadId, count + 1); total += 1; }
    }
  }
  function describe(s) {
    return { sessionId: s.sessionId, threadId: s.threadId, cwd: s.cwd, shell: s.shell, profileId: s.profileId, pid: s.pty.pid,
      status: s.status, exitCode: s.exitCode, exitedAt: s.exitedAt ? new Date(s.exitedAt).toISOString() : null,
      cols: s.cols, rows: s.rows, inputSeq: s.inputSeq,
      platform: process.platform, windowsBuild: Number(os.release().split('.')[2]) || 0 };
  }
  async function find(p) {
    if (disposed || closed.has(keyOf(p)) || !sessions.has(keyOf(p))) fail(-32044, 'This terminal session has ended');
    const s = await sessions.get(keyOf(p));
    if (disposed || closed.has(keyOf(p))) fail(-32044, 'This terminal session has ended');
    return s;
  }
  function stop(s) {
    // A closing terminal still owns its PTY until the exit event confirms,
    // so it keeps occupying the running quota for exactly that window.
    if (s.status === 'running') { s.pty.kill(); s.status = 'closing'; }
  }
  // Quota reservations for opens that are still resolving their directory:
  // without them, two concurrent opens both pass the check while `live` is
  // still empty and the quota is bypassed. key -> threadId.
  const pendingReservations = new Map();
  const reservationsFor = threadId => { let n = 0; for (const tid of pendingReservations.values()) if (tid === threadId) n += 1; return n; };
  async function open(params) {
    const p = paramsFor(params, ['cols', 'rows', 'profileId']); const size = dimensions(p); const key = keyOf(p);
    if (disposed || closed.has(key)) fail(-32044, 'This terminal session has ended; open a new terminal');
    if (sessions.has(key)) return describe(await sessions.get(key));
    sweepExited();
    // Quota counts terminals that still hold a PTY (running or closing) plus
    // in-flight reservations, so concurrent opens cannot slip past the cap.
    if (live.size + pendingReservations.size >= maxSessions || ([...live].filter(s => s.threadId === p.threadId).length + reservationsFor(p.threadId)) >= maxPerThread) fail(-32045, 'Close an existing terminal before opening another');
    pendingReservations.set(key, p.threadId);
    try {
    const pending = (async () => {
      const scope = { threadId: p.threadId, path: '' };
      const resolved = verifyResolvedPath(await rpc('workspace/path/resolve', scope), scope);
      if (resolved.kind !== 'directory') fail(-32041, 'The task folder is not a directory');
      if (disposed || closed.has(key)) fail(-32044, 'This terminal session has ended');
      const windows = process.platform === 'win32';
      // Shell selection (C18): a host-managed profile chosen by ID, the saved
      // default, or the platform fallback. The renderer never names an
      // executable; a selected profile that is not installed is an explicit
      // error, never a silent switch to another shell.
      let profile;
      if (profileService) profile = profileService.resolve(p.profileId);
      const executable = profile?.executable ?? (windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/bash');
      const args = profile?.args ?? (windows ? ['-NoLogo', '-NoProfile'] : ['--noprofile', '--norc']);
      const shellLabel = profile?.name ?? (windows ? 'PowerShell' : 'Bash');
      const launch = spawn ?? require('node-pty').spawn;
      let pty;
      try { pty = launch(executable, args, {
        ...size, name: 'xterm-256color', cwd: resolved.target, env: terminalEnvironment(env), useConpty: true, useConptyDll: true,
      }); } catch { fail(-32046, 'The local terminal could not start'); }
      const s = { ...p, ...size, cwd: resolved.target, shell: shellLabel, profileId: profile?.id, pty,
        status: 'running', exitCode: null, buffer: '', offset: 0, inputSeq: 0, receipts: new Map() };
      live.add(s);
      pty.onData(data => {
        s.buffer += data;
        if (s.buffer.length > MAX_BUFFER) {
          let trim = s.buffer.length - MAX_BUFFER;
          if (s.buffer.charCodeAt(trim) >= 0xDC00 && s.buffer.charCodeAt(trim) <= 0xDFFF) trim++;
          s.buffer = s.buffer.slice(trim); s.offset += trim;
        }
      });
      pty.onExit(({ exitCode }) => {
        s.status = 'exited'; s.exitCode = exitCode; s.exitedAt = Date.now(); s.exitSeq = ++exitSeqCounter;
        // Shutdown confirmation (C15): the exit event releases this PTY from
        // the pending-ownership set whatever dispose is waiting on.
        pendingExit.delete(s);
        // History keeps the recent tail only, so bounded retention can never
        // add up to unbounded memory across many exited terminals.
        if (s.buffer.length > exitedBufferMax) {
          let trim = s.buffer.length - exitedBufferMax;
          if (s.buffer.charCodeAt(trim) >= 0xDC00 && s.buffer.charCodeAt(trim) <= 0xDFFF) trim++;
          s.buffer = s.buffer.slice(trim); s.offset += trim;
        }
        live.delete(s);
        // A record the user already closed (or a host being disposed) never
        // returns as readable history.
        if (!closed.has(keyOf(s)) && !disposed) {
          history.set(keyOf(s), s);
          sweepExited();
        }
      });
      return s;
    })();
    sessions.set(key, pending);
    try { return describe(await pending); } catch (error) { sessions.delete(key); throw error; }
    } finally { pendingReservations.delete(key); }
  }
  async function list(params) {
    const p = paramsFor(params, [], false);
    if (disposed) return [];
    sweepExited();
    const entries = await Promise.allSettled([...sessions.entries()].filter(([key]) => inThread(key, p.threadId)).map(([, value]) => value));
    return entries.filter(entry => entry.status === 'fulfilled' && !closed.has(keyOf(entry.value))).map(entry => describe(entry.value));
  }
  async function read(params) {
    const p = paramsFor(params, ['cursor']);
    if (!Number.isSafeInteger(p.cursor) || p.cursor < 0) fail(-32602, 'Terminal cursor is invalid');
    const s = await find(p);
    const end = s.offset + s.buffer.length;
    if (p.cursor > end) fail(-32602, 'Terminal cursor is ahead of output');
    const start = Math.max(s.offset, p.cursor), from = start - s.offset;
    let to = Math.min(s.buffer.length, from + MAX_READ);
    if (s.buffer.charCodeAt(to - 1) >= 0xD800 && s.buffer.charCodeAt(to - 1) <= 0xDBFF) to--;
    return { ...describe(s), data: s.buffer.slice(from, to), cursor: s.offset + to, truncated: p.cursor < s.offset, hasMore: s.offset + to < end };
  }
  async function write(params) {
    const p = paramsFor(params, ['data', 'seq']);
    if (typeof p.data !== 'string' || !p.data.length || p.data.length > MAX_INPUT || !Number.isSafeInteger(p.seq) || p.seq < 1) fail(-32602, 'Terminal input is invalid or too large');
    const s = await find(p); const digest = createHash('sha256').update(p.data).digest('hex');
    if (p.seq <= s.inputSeq) {
      const previous = s.receipts.get(p.seq);
      if (previous?.digest === digest) {
        if (!previous.committed) fail(-32047, 'Terminal input outcome is unknown; it will not be replayed');
        return { inputSeq: s.inputSeq };
      }
      fail(-32005, 'Terminal input sequence was already used');
    }
    if (p.seq !== s.inputSeq + 1) fail(-32005, 'Terminal input arrived out of order');
    if (s.status !== 'running') fail(-32044, 'This terminal session has exited');
    // Reserve before writing: uncertain input is never replayed automatically.
    const receipt = { digest, committed: false };
    s.inputSeq = p.seq; s.receipts.set(p.seq, receipt);
    if (s.receipts.size > 128) s.receipts.delete(s.receipts.keys().next().value);
    try { s.pty.write(p.data); receipt.committed = true; }
    catch { fail(-32047, 'Terminal input outcome is unknown; it will not be replayed'); }
    return { inputSeq: s.inputSeq };
  }
  async function resize(params) {
    const p = paramsFor(params, ['cols', 'rows']); const size = dimensions(p); const s = await find(p);
    if (s.status === 'running' && (s.cols !== size.cols || s.rows !== size.rows)) { s.pty.resize(size.cols, size.rows); Object.assign(s, size); }
    return { cols: s.cols, rows: s.rows };
  }
  async function close(params) {
    const p = paramsFor(params); const key = keyOf(p); const pending = sessions.get(key);
    rememberClosed(key); sessions.delete(key); history.delete(key);
    if (pending) {
      let s; try { s = await pending; } catch { /* Open cancelled before spawn. */ }
      if (s) try { stop(s); } catch (error) { closed.delete(key); sessions.set(key, pending); throw error; }
    }
    return { closed: true };
  }
  // C15 shutdown contract: kill() is issued synchronously for every PTY this
  // service owns, so shutdown is confirmed; the owned pids travel with the
  // result and the OS-level exit lands asynchronously via onExit.
  // C15 shutdown contract: dispose() only reports confirmed once every owned
  // PTY's exit event has actually been observed (bounded wait). "kill was
  // called" or "callback has not arrived yet" is never success — unresolved
  // terminals stay listed with their pids and reasons for C's shutdown
  // controller, and a repeat dispose re-checks them instead of trusting the
  // disposed flag.
  const pendingExit = new Map();
  function activePids() {
    const pids = new Set();
    for (const s of live) if (Number.isInteger(s.pty?.pid) && s.pty.pid > 0) pids.add(s.pty.pid);
    for (const entry of pendingExit.values()) if (Number.isInteger(entry.pid) && entry.pid > 0) pids.add(entry.pid);
    return [...pids];
  }
  async function drainPendingExit(context, timeoutMs) {
    const clock = typeof context?.now === 'function' ? context.now : Date.now;
    const deadline = Number.isFinite(context?.deadline) ? context.deadline : clock() + timeoutMs;
    while (pendingExit.size && clock() < deadline && !context?.signal?.aborted) {
      const delay = Math.min(25, Math.max(1, deadline - clock()));
      await new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          context?.signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, delay);
        timer.unref?.();
        context?.signal?.addEventListener('abort', finish, { once: true });
      });
    }
  }
  async function dispose(context = {}) {
    if (!disposed) {
      disposed = true;
      for (const s of live) {
        const pid = Number.isInteger(s.pty?.pid) ? s.pty.pid : null;
        const entry = { pid, reason: 'terminated by dispose' };
        // Registered before the kill: a PTY whose exit event lands
        // synchronously during stop() must end up released, not re-added.
        pendingExit.set(s, entry);
        try { stop(s); } catch (error) { entry.reason = `kill failed: ${error?.message || 'unknown error'}`; }
      }
      live.clear();
      sessions.clear();
      history.clear();
      pendingReservations.clear();
    }
    const timeoutMs = Number.isFinite(context.remainingMs) ? Math.max(0, context.remainingMs) : disposeTimeoutMs;
    await drainPendingExit(context, timeoutMs);
    const unconfirmed = [...pendingExit.values()];
    if (!unconfirmed.length) {
      return { confirmed: true, ownedPids: [], detail: 'all owned PTYs confirmed exit' };
    }
    return {
      confirmed: false,
      ownedPids: unconfirmed.map(entry => entry.pid).filter(pid => pid !== null),
      detail: `${unconfirmed.length} terminal(s) did not confirm exit within ${timeoutMs}ms: ${unconfirmed.map(entry => entry.reason).join('; ')}`,
    };
  }
  // C18 profile directory: read-only detection plus the persisted default.
  function profileCatalog() {
    if (!profileService) return { available: false, profiles: [], defaultProfileId: undefined };
    const detection = profileService.detect();
    return { available: true, profiles: detection.profiles, defaultProfileId: detection.defaultProfileId, defaultMissing: detection.defaultMissing };
  }
  function setDefaultProfile(params) {
    if (!profileService) fail(-32013, 'Terminal shell selection needs the host wiring; restart the app with the terminal profile directory');
    if (!params || typeof params !== 'object' || Array.isArray(params)) fail(-32602, 'Terminal params must be an object');
    return profileService.setDefault(params.profileId ?? null);
  }
  return { handlers: { 'terminal/open': open, 'terminal/list': list, 'terminal/read': read, 'terminal/write': write, 'terminal/resize': resize, 'terminal/close': close, 'terminal/profiles/list': async () => profileCatalog(), 'terminal/profiles/default': async params => setDefaultProfile(params) }, dispose, activePids };
}
module.exports = { createWorkspaceTerminal, METHODS, MAX_BUFFER, MAX_READ, MAX_INPUT, terminalEnvironment };
