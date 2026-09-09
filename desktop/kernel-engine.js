'use strict';

const fs = require('fs');
const path = require('path');
const { startKnorviaDaemon, encodeFrame, initializeRequest } = require('./knorvia-protocol-client');

const { createChatBridge } = require('./kernel-chat-bridge');
const { ensureBuiltinSkills } = require('./builtin-skills');

const AGENT_PREFIXES = [
  '/api/v1/ws',
  '/api/v1/chat',
  '/api/v1/sessions',
  '/api/v1/knorvia',
];

function isAgentApiPath(urlPath) {
  if (typeof urlPath !== 'string') return false;
  const p = urlPath.split('?')[0];
  return AGENT_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

function isUserCodexShim(bin) {
  const s = String(bin || '').toLowerCase();
  return s.includes('node_modules') && s.includes('codex');
}

// The staged release layout records the media worker's interpreter
// (manifest.json → runtime.mediaWorkerPython). The daemon spawns the Python
// media packs through KNORVIA_PYTHON, so the engine threads the staged
// interpreter into the daemon's environment.
function stagedRuntimeEnv(runtimeRoot, env = process.env) {
  if (!runtimeRoot) return env;
  const candidates = [
    path.join(runtimeRoot, 'manifest.json'),
    path.join(runtimeRoot, '..', 'manifest.json'),
  ];
  for (const manifestPath of candidates) {
    try {
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const python = manifest?.runtime?.mediaWorkerPython;
      if (python && fs.existsSync(python)) {
        return { ...env, KNORVIA_PYTHON: python };
      }
    } catch {
      // A malformed manifest falls through — the daemon's default resolution
      // still applies.
    }
  }
  return env;
}

function resolveDaemonBin({ runtimeRoot, env = process.env, packaged = false } = {}) {
  const candidates = [];
  if (!packaged && env.KNORVIA_DAEMON_BIN) candidates.push(env.KNORVIA_DAEMON_BIN);
  if (runtimeRoot) {
    candidates.push(path.join(runtimeRoot, 'knorvia-daemon.exe'));
    candidates.push(path.join(runtimeRoot, 'knorvia-daemon'));
    candidates.push(path.join(runtimeRoot, 'bin', 'knorvia-daemon.exe'));
  }
  if (!packaged) {
    candidates.push(path.join(__dirname, 'bin', 'knorvia-daemon.exe'));
    candidates.push(path.join(__dirname, '..', '..', 'knorvia-kernel', 'knorvia-rs', 'target', 'debug', 'knorvia-daemon.exe'));
    candidates.push(path.join(__dirname, '..', '..', 'knorvia-kernel', 'knorvia-rs', 'target', 'release', 'knorvia-daemon.exe'));
  }
  for (const cand of candidates) {
    if (cand && fs.existsSync(cand) && !isUserCodexShim(cand)) return cand;
  }
  throw new Error(
    'knorvia-daemon binary not found. Set KNORVIA_DAEMON_BIN. Desktop no longer spawns python -m knorvia.desktop.ipc_bridge as the Agent Runtime.',
  );
}

function encodedHttp(status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  return {
    kind: 'http_response',
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body,
  };
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => finish();
    const onError = () => {
      // A process `error` can precede `close`; keep waiting for close so the
      // caller never starts a replacement while the Home owner is alive.
    };
    const timer = setTimeout(() => finish(new Error('knorvia-daemon did not stop before the restart deadline')), timeoutMs);
    timer.unref?.();
    child.once('close', onClose);
    child.on('error', onError);
  });
}

async function createKernelEngine({
  home,
  env = process.env,
  runtimeRoot,
  packaged = false,
  version = '0.1.0-dev',
  // The old WebSocket-to-StreamEvent adapter remains available for the
  // migration surface, but the native workbench and dev gateway use the
  // daemon's JSON-RPC notifications directly.
  legacyChatBridge = true,
}) {
  env = stagedRuntimeEnv(runtimeRoot, env);
  const daemonBin = resolveDaemonBin({ runtimeRoot, env, packaged });
  if (isUserCodexShim(daemonBin)) {
    throw new Error('refusing to spawn user-installed Codex CLI');
  }
  fs.mkdirSync(home, { recursive: true });
  ensureBuiltinSkills(home);
  const session = startKnorviaDaemon({ daemonBin, home, env });
  let reqSeq = 1;
  async function rpc(method, params) {
    reqSeq += 1;
    const msg = await session.request({
      jsonrpc: '2.0',
      id: `eng-${reqSeq}`,
      method,
      params: params || {},
    });
    if (msg.error) {
      const err = new Error(msg.error.message || JSON.stringify(msg.error));
      err.rpc = msg.error;
      throw err;
    }
    return msg.result;
  }

  let init;
  let workspace;
  try {
    init = await session.request(initializeRequest('knorvia_desktop', version));
    if (init.error) throw new Error(init.error.message || 'initialize failed');
    if (init.result?.server?.name !== 'knorvia-daemon') {
      throw new Error(`unexpected daemon identity: ${JSON.stringify(init.result?.server)}`);
    }
    session.notify({ jsonrpc: '2.0', method: 'initialized' });
    workspace = await rpc('workspace/create', { title: 'Desktop', idempotencyKey: 'desktop-default-workspace' });
  } catch (error) {
    session.child.kill();
    throw error;
  }

  const bridge = legacyChatBridge ? createChatBridge({ rpc, workspaceId: workspace.id }) : null;
  let bridgeDisposed = false;
  const notificationListeners = new Set();
  const removeNotificationListener = session.onNotification((notification) => {
    // Notifications are independent of request/response ordering. The legacy
    // bridge owns its own reconciliation; native consumers receive the exact
    // daemon notification and recover durable truth through thread/read.
    if (bridge) void bridge.handleNotification(notification).catch(() => {});
    for (const listener of notificationListeners) {
      try { listener(notification); } catch {}
    }
  });
  function disposeBridge() {
    if (bridgeDisposed) return;
    bridgeDisposed = true;
    try { removeNotificationListener?.(); } catch {}
    notificationListeners.clear();
    bridge?.dispose();
  }
  // A sidecar crash after asynchronous turn admission has no request waiter
  // to reject. Tell active renderers that their local stream ended without
  // claiming any remote terminal outcome, then drop listener references.
  session.child.once('close', (code, signal) => {
    bridge?.handleTransportClosed(new Error(`knorvia-daemon closed (${signal || code})`));
    disposeBridge();
  });
  session.child.once('error', (error) => {
    bridge?.handleTransportClosed(error);
    disposeBridge();
  });

  function requestJson(request) {
    if (!request?.body) return {};
    try {
      const raw = Buffer.from(String(request.body), 'base64').toString('utf8');
      return JSON.parse(raw);
    } catch {
      try {
        return JSON.parse(String(request.body));
      } catch {
        return {};
      }
    }
  }

  async function handleHttp(request) {
    const urlPath = String(request.path || '');
    const pathname = urlPath.split('?')[0];
    const method = String(request.method || 'GET').toUpperCase();
    const body = requestJson(request);
    try {
      if (method === 'GET' && pathname === '/api/v1/sessions') {
        const threads = await rpc('thread/list', { workspaceId: workspace.id });
        const sessions = (Array.isArray(threads) ? threads : []).map((th) => ({
          id: th.id,
          title: th.title,
          created_at: th.createdAt,
          updated_at: th.updatedAt,
          pinned: false,
          archived: th.status === 'archived',
        }));
        return encodedHttp(200, { sessions });
      }
      if (method === 'GET' && pathname === '/api/v1/knorvia/packs') {
        const packs = await rpc('capability/list', {});
        return encodedHttp(200, { packs });
      }
      if (method === 'POST' && pathname === '/api/v1/knorvia/packs/invoke') {
        const out = await rpc('capability/invoke', body);
        return encodedHttp(200, out);
      }
      if (method === 'POST' && pathname === '/api/v1/knorvia/packs/cancel') {
        const out = await rpc('capability/cancel', body);
        return encodedHttp(200, out);
      }
      if (method === 'POST' && pathname === '/api/v1/knorvia/packs/resume') {
        const out = await rpc('capability/resume', body);
        return encodedHttp(200, out);
      }
      if (method === 'GET' && pathname === '/api/v1/knorvia/workspaces') {
        const list = await rpc('workspace/list', {});
        return encodedHttp(200, { workspaces: list });
      }
      if (method === 'POST' && pathname === '/api/v1/knorvia/workspaces') {
        const created = await rpc('workspace/create', { title: body.title || 'Workspace' });
        return encodedHttp(200, created);
      }
      if (method === 'GET' && pathname === '/api/v1/knorvia/artifacts') {
        const qs = new URLSearchParams(urlPath.split('?')[1] || '');
        const list = await rpc('artifact/list', {
          workspaceId: body.workspaceId || qs.get('workspaceId') || workspace.id,
        });
        return encodedHttp(200, { artifacts: list });
      }
      if (method === 'GET' && pathname === '/api/v1/knorvia/activity') {
        const qs = new URLSearchParams(urlPath.split('?')[1] || '');
        const streamId = body.streamId || qs.get('streamId') || workspace.id;
        const events = await rpc('activity/list', { streamId });
        return encodedHttp(200, events);
      }
      if (method === 'POST' && pathname === '/api/v1/workspace/create') {
        const created = await rpc('workspace/create', { title: 'Workspace' });
        return encodedHttp(200, created);
      }
      return encodedHttp(410, {
        error: 'gone',
        message: 'Agent Thread/Turn is owned by knorvia-daemon. This FastAPI control path has been removed.',
        runtime: 'knorvia-daemon',
      });
    } catch (error) {
      return encodedHttp(502, { error: String(error.message || error) });
    }
  }

  function kill() {
    disposeBridge();
    try { session.child.kill(); } catch {}
  }

  async function shutdown({ timeoutMs = 8_000 } = {}) {
    disposeBridge();
    const child = session.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // Close stdio first. The daemon then drops its ControlPlane normally, and
    // the KernelSession Drop implementation kills and reaps the App Server
    // before releasing the Home lock. A hard child kill is only a bounded
    // fallback for a sidecar that refuses to exit.
    const graceful = waitForChildExit(child, timeoutMs);
    try { child.stdin?.end(); } catch {}
    try {
      await graceful;
      return;
    } catch {}
    const forced = waitForChildExit(child, Math.max(1_000, Math.min(3_000, timeoutMs)));
    try { child.kill(); } catch {}
    await forced;
  }

  function onNotification(listener) {
    if (typeof listener !== 'function') throw new Error('notification listener must be a function');
    if (bridgeDisposed) return () => {};
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  }

  const legacyBridgeUnavailable = async ({ id }) => ({
    type: 'error',
    id,
    error: 'Legacy chat bridge is disabled; use the native Knorvia Protocol client.',
  });

  return {
    child: session.child,
    daemonBin,
    identity: 'knorvia-daemon',
    workspace,
    initialize: init.result,
    rpc,
    onNotification,
    handleHttp,
    handleWsOpen: bridge ? bridge.handleWsOpen : legacyBridgeUnavailable,
    handleWsSend: bridge ? bridge.handleWsSend : async () => {},
    handleWsClose: bridge ? bridge.handleWsClose : () => {},
    kill,
    shutdown,
    isAgentApiPath,
  };
}

module.exports = {
  AGENT_PREFIXES,
  isAgentApiPath,
  isUserCodexShim,
  resolveDaemonBin,
  stagedRuntimeEnv,
  createKernelEngine,
  encodeFrame,
};
