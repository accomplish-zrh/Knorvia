'use strict';

// A manually operated host terminal, separate from Kernel-owned agent turns.
// The daemon resolves the initial directory; the renderer cannot supply a
// command, executable, environment or absolute cwd to terminal/open.
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { connectionError } = require('./connection-config');
const { verifyResolvedPath } = require('./desktop-path-actions');

const MAX_BUFFER = 512 * 1024;
const MAX_READ = 32 * 1024;
const MAX_INPUT = 16 * 1024;
const METHODS = ['terminal/open', 'terminal/list', 'terminal/read', 'terminal/write', 'terminal/resize', 'terminal/close'];
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

function createWorkspaceTerminal({ rpc, spawn, env = process.env, maxSessions = 24, maxPerThread = 8 } = {}) {
  if (typeof rpc !== 'function') throw new Error('Terminal requires scoped daemon RPC');
  const sessions = new Map();
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
  function describe(s) {
    return { sessionId: s.sessionId, threadId: s.threadId, cwd: s.cwd, shell: s.shell, pid: s.pty.pid,
      status: s.status, exitCode: s.exitCode, cols: s.cols, rows: s.rows, inputSeq: s.inputSeq,
      platform: process.platform, windowsBuild: Number(os.release().split('.')[2]) || 0 };
  }
  async function find(p) {
    if (disposed || closed.has(keyOf(p)) || !sessions.has(keyOf(p))) fail(-32044, 'This terminal session has ended');
    const s = await sessions.get(keyOf(p));
    if (disposed || closed.has(keyOf(p))) fail(-32044, 'This terminal session has ended');
    return s;
  }
  function stop(s) {
    if (s.status === 'running') { s.pty.kill(); s.status = 'closing'; }
    live.delete(s);
  }
  async function open(params) {
    const p = paramsFor(params, ['cols', 'rows']); const size = dimensions(p); const key = keyOf(p);
    if (disposed || closed.has(key)) fail(-32044, 'This terminal session has ended; open a new terminal');
    if (sessions.has(key)) return describe(await sessions.get(key));
    if (sessions.size >= maxSessions || [...sessions.keys()].filter(k => inThread(k, p.threadId)).length >= maxPerThread) fail(-32045, 'Close an existing terminal before opening another');
    const pending = (async () => {
      const scope = { threadId: p.threadId, path: '' };
      const resolved = verifyResolvedPath(await rpc('workspace/path/resolve', scope), scope);
      if (resolved.kind !== 'directory') fail(-32041, 'The task folder is not a directory');
      if (disposed || closed.has(key)) fail(-32044, 'This terminal session has ended');
      const windows = process.platform === 'win32';
      const executable = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/bash';
      const launch = spawn ?? require('node-pty').spawn;
      let pty;
      try { pty = launch(executable, windows ? ['-NoLogo', '-NoProfile'] : ['--noprofile', '--norc'], {
        ...size, name: 'xterm-256color', cwd: resolved.target, env: terminalEnvironment(env), useConpty: true, useConptyDll: true,
      }); } catch { fail(-32046, 'The local terminal could not start'); }
      const s = { ...p, ...size, cwd: resolved.target, shell: windows ? 'PowerShell' : 'Bash', pty,
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
      pty.onExit(({ exitCode }) => { s.status = 'exited'; s.exitCode = exitCode; live.delete(s); });
      return s;
    })();
    sessions.set(key, pending);
    try { return describe(await pending); } catch (error) { sessions.delete(key); throw error; }
  }
  async function list(params) {
    const p = paramsFor(params, [], false);
    if (disposed) return [];
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
    rememberClosed(key); sessions.delete(key);
    if (pending) {
      let s; try { s = await pending; } catch { /* Open cancelled before spawn. */ }
      if (s) try { stop(s); } catch (error) { closed.delete(key); sessions.set(key, pending); throw error; }
    }
    return { closed: true };
  }
  function dispose() {
    if (disposed) return; disposed = true;
    for (const s of live) { try { stop(s); } catch {} }
    sessions.clear();
  }
  return { handlers: { 'terminal/open': open, 'terminal/list': list, 'terminal/read': read, 'terminal/write': write, 'terminal/resize': resize, 'terminal/close': close }, dispose };
}
module.exports = { createWorkspaceTerminal, METHODS, MAX_BUFFER, MAX_READ, MAX_INPUT, terminalEnvironment };
