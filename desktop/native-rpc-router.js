'use strict';

// The native workbench is deliberately a small allow-listed projection of the
// daemon control plane. It is shared by Electron IPC and the loopback-only
// development gateway, so neither transport can become an arbitrary daemon
// method forwarder when the web surface changes.

const MAX_REQUEST_BYTES = 1024 * 1024;
// Bulk editors have a 3 MiB document cap; reserve room for the RPC envelope.
// Ordinary methods keep the smaller cap on both Electron and browser paths.
const MAX_TRANSPORT_BYTES = 4 * 1024 * 1024;
const BULK_METHODS = new Set(['studio/sequence/create', 'studio/sequence/update', 'studio/template/import', 'studio/canvas/create', 'studio/canvas/save']);
const MAX_JSON_DEPTH = 32;
const { METHODS: TERMINAL_METHODS } = require('./workspace-terminal');
const { METHODS: LIBRARY_METHODS } = require('./personal-library');
const { METHODS: STUDIO_METHODS } = require('./media-studio');
const { METHODS: NOTIFICATION_METHODS } = require('./turn-notifications');
const { METHODS: SSH_METHODS } = require('./ssh-session');
const { METHODS: EXTENSION_METHODS } = require('./extension-manager');
const { METHODS: WORKTREE_SNAPSHOT_METHODS } = require('./worktree-snapshots');
const { METHODS: CLI_BACKEND_METHODS } = require('./cli-backends');
const LEARNING_METHODS = ['learning/sources', 'learning/lecture/read', 'learning/lecture/create', 'learning/quiz/read', 'learning/quiz/create', 'learning/attempt/record', 'learning/attempt/correct', 'learning/mastery/read', 'learning/mastery/rebuild', 'learning/review/due',
  'learning/practice/start', 'learning/practice/read', 'learning/practice/answer', 'learning/practice/assess', 'learning/practice/due',
  'creative/brief/create', 'creative/brief/read', 'creative/brief/review'];

const NATIVE_METHODS = new Set([
  ...LEARNING_METHODS,
  ...WORKTREE_SNAPSHOT_METHODS,
  ...NOTIFICATION_METHODS,
  ...SSH_METHODS,
  ...EXTENSION_METHODS,
  ...LIBRARY_METHODS,
  ...STUDIO_METHODS,
  ...TERMINAL_METHODS,
  'system/health',
  'system/version',
  'system/paths',
  // Connection is owned by the native host because the daemon/App Server
  // captures provider values only when it is spawned.
  'connection/read',
  'connection/provider/save',
  'connection/provider/delete',
  'connection/provider/activate',
  'connection/update',
  'connection/test',
  // Desktop-only filesystem actions are local handlers. The daemon's scope
  // resolver remains the sole authority for an open/reveal target.
  'desktop/select-folder',
  'desktop/open-location',
  'desktop/open-path',
  'desktop/reveal-path',
  'preview/read',
  // C19: scoped revocable media-preview capabilities. The names are owned
  // by the shared transport allow-list; the handlers are registered by each
  // host (Electron main / dev gateway) alongside preview/read.
  'preview/revoke',
  'preview/revokeScope',
  'workspace/create',
  'workspace/read',
  'workspace/list',
  'workspace/update',
  'workspace/path/resolve',
  'workspace/files/list',
  'workspace/files/read',
  'workspace/files/search',
  'workspace/files/search/cancel',
  'workspace/git/status',
  'workspace/git/diff',
  // B05 (night 2026-09-10): read-only delivery review routes (daemon side
  // integrated by A at 946bc59).
  'workspace/git/compare',
  'workspace/git/compare-diff',
  'workspace/worktree/create',
  'workspace/extensions/analyze',
  'workspace/worktree/list',
  'workspace/worktree/lock',
  'workspace/worktree/unlock',
  'workspace/worktree/remove',
  'thread/start',
  'thread/read',
  'thread/list',
  'thread/resume',
  'thread/fork',
  'thread/update',
  'thread/archive',
  'thread/unarchive',
  'turn/start',
  'turnQueue/enqueue', 'turnQueue/read', 'turnQueue/cancel', 'turnQueue/pause', 'turnQueue/resume',
  'turn/read',
  'turn/steer',
  'turn/interrupt',
  'turn/agent/interrupt',
  'approval/respond',
  'userInput/respond',
  'usage/summary',
  'model/list',
  'skills/list',
  'capability/list',
  'capability/invoke',
  'capability/cancel',
  'capability/resume',
  'artifact/create',
  'artifact/read',
  'artifact/list',
  'artifact/catalog',
  'artifact/content',
  'artifact/stage',
  'artifact/commit',
  'automation/list',
  'automation/create',
  'automation/update',
  'automation/delete',
  'automation/run',
  'goal/create',
  'goal/read',
  'goal/list',
  'goal/update',
  'goal/run',
  'goal/evidence/add',
  // Social domain: bots, rooms and durable session bindings. These pass
  // through to the daemon; the Rust store is the sole owner of the anchors.
  'bot/ensureDefault',
  'bot/create',
  'bot/read',
  'bot/list',
  'bot/updateSoul',
  'bot/rename',
  'room/create',
  'room/ensureDm',
  'room/read',
  'room/list',
  'room/rename',
  'room/addMember',
  'room/removeMember',
  'room/send',
  'room/messages',
  'room/interrupt',
  'room/checkpoint',
  'room/markRead',
  'room/attention/resolve',
  'sessionBinding/resolve',
  'sessionBinding/attach',
  'sessionBinding/markLost',
  'sessionBinding/recordDelivery',
  'sessionBinding/read',
  'sessionBinding/list',
  // C-004 wiring: memory records and account-link state pass through to the
  // daemon, which owns scope checks, revisions and single-flight connects.
  'memory/record',
  'memory/update',
  'memory/get',
  'memory/list',
  'memory/search',
  'memory/forget',
  'memory/restore',
  'memory/merge',
  'memory/share',
  'memory/pin',
  'memory/timeline',
  'memory/graph',
  'memory/recall-trace',
  'memory/export',
  'memory/import',
  'auth/link/list',
  'auth/link/refresh',
  'auth/link/connect-start',
  'auth/link/connect-cancel',
  'auth/link/disconnect',
  // CLI bot backends are detected and driven by the desktop host: spawning
  // external CLIs is a process-management job, not a daemon control fact.
  ...CLI_BACKEND_METHODS,
]);

const LOCAL_METHODS = new Set([
  ...LEARNING_METHODS,
  ...WORKTREE_SNAPSHOT_METHODS,
  ...SSH_METHODS,
  ...EXTENSION_METHODS,
  'desktop/open-location',
  ...NOTIFICATION_METHODS,
  ...LIBRARY_METHODS,
  ...STUDIO_METHODS,
  ...TERMINAL_METHODS,
  'connection/read',
  'connection/provider/save',
  'connection/provider/delete',
  'connection/provider/activate',
  'connection/update',
  'connection/test',
  'desktop/select-folder',
  'desktop/open-path',
  'desktop/reveal-path',
  'preview/read',
  // C19: scoped revocable media-preview capabilities. The names are owned
  // by the shared transport allow-list; the handlers are registered by each
  // host (Electron main / dev gateway) alongside preview/read.
  'preview/revoke',
  'preview/revokeScope',
  ...CLI_BACKEND_METHODS,
]);

function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function resultResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function isRequestId(value) {
  return (typeof value === 'string' && value.length > 0 && value.length <= 160)
    || (typeof value === 'number' && Number.isFinite(value));
}

function isSafeJson(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isSafeJson(item, depth + 1));
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(value).every(([key, item]) => (
    key !== '__proto__'
    && key !== 'prototype'
    && key !== 'constructor'
    && isSafeJson(item, depth + 1)
  ));
}

function requestByteLength(message) {
  try {
    return Buffer.byteLength(JSON.stringify(message), 'utf8');
  } catch {
    return Infinity;
  }
}

function validateNativeRequest(message) {
  const id = message?.id;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { error: errorResponse(null, -32600, 'Native request must be a JSON-RPC object') };
  }
  if (message.jsonrpc !== '2.0') {
    return { error: errorResponse(isRequestId(id) ? id : null, -32600, 'Native request requires jsonrpc 2.0') };
  }
  if (!isRequestId(id)) {
    return { error: errorResponse(null, -32600, 'Native request requires a string or numeric id') };
  }
  if (typeof message.method !== 'string' || !NATIVE_METHODS.has(message.method)) {
    return { error: errorResponse(id, -32601, 'Native method is not available') };
  }
  const params = message.params === undefined ? {} : message.params;
  if (!params || typeof params !== 'object' || Array.isArray(params) || !isSafeJson(params)) {
    return { error: errorResponse(id, -32602, 'Native method params must be a safe JSON object') };
  }
  if (requestByteLength(message) > (BULK_METHODS.has(message.method) ? MAX_TRANSPORT_BYTES : MAX_REQUEST_BYTES)) {
    return { error: errorResponse(id, -32602, 'Native request is too large') };
  }
  return { value: { id, method: message.method, params } };
}

function daemonErrorResponse(id, error) {
  const rpc = error?.rpc;
  const code = typeof rpc?.code === 'number' || typeof rpc?.code === 'string' ? rpc.code : -32603;
  const message = typeof rpc?.message === 'string' && rpc.message
    ? rpc.message
    : typeof error?.message === 'string' && error.message
      ? error.message
      : 'Native daemon request failed';
  // Keep response data structural and bounded. Provider stderr and host paths
  // are intentionally not copied into a browser-facing error body.
  const data = rpc?.data && isSafeJson(rpc.data) ? rpc.data : undefined;
  return errorResponse(id, code, message, data);
}

function createNativeRpcRouter({ rpc, onNotification, handlers = {} }) {
  if (typeof rpc !== 'function') throw new Error('native RPC router requires rpc');
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
    throw new Error('native RPC router handlers must be an object');
  }
  const listeners = new Set();
  const inFlight = new Set();
  let disposed = false;
  let closing = false;
  const removeNotificationListener = typeof onNotification === 'function'
    ? onNotification((message) => {
      if (disposed || !message || typeof message.method !== 'string') return;
      for (const listener of listeners) {
        try { listener(message); } catch {}
      }
    })
    : null;

  async function handle(message) {
    if (disposed || closing) return errorResponse(message?.id, -32000, 'Native connection is closing');
    const parsed = validateNativeRequest(message);
    if (parsed.error) return parsed.error;
    // Admission and registration are synchronous. beginClose() can therefore
    // freeze the router and capture every request admitted before it without
    // a gap in which a Home writer can enter untracked.
    const operation = (async () => {
    try {
      const localHandler = handlers[parsed.value.method];
      if (LOCAL_METHODS.has(parsed.value.method) && typeof localHandler !== 'function') {
        return errorResponse(parsed.value.id, -32601, 'Native method is unavailable for this transport');
      }
      const result = typeof localHandler === 'function'
        ? await localHandler(parsed.value.params, parsed.value)
        : await rpc(parsed.value.method, parsed.value.params);
      return resultResponse(parsed.value.id, result);
    } catch (error) {
      return daemonErrorResponse(parsed.value.id, error);
    }
    })();
    inFlight.add(operation);
    try { return await operation; }
    finally { inFlight.delete(operation); }
  }

  async function beginClose(context = {}) {
    closing = true;
    const admitted = [...inFlight];
    if (!admitted.length) return { confirmed: true, admitted: 0, drained: 0, detail: 'native RPC admissions frozen; no requests were in flight' };
    const drain = Promise.allSettled(admitted);
    if (context.signal?.aborted) {
      return { confirmed: false, admitted: admitted.length, drained: 0, detail: 'native RPC admissions frozen; deadline expired before drain' };
    }
    let removeAbort;
    const aborted = new Promise(resolve => {
      if (!context.signal) return;
      const onAbort = () => resolve(null);
      context.signal.addEventListener('abort', onAbort, { once: true });
      removeAbort = () => context.signal.removeEventListener('abort', onAbort);
    });
    const outcome = context.signal ? await Promise.race([drain, aborted]) : await drain;
    removeAbort?.();
    if (!outcome) {
      const drained = admitted.length - admitted.filter(item => inFlight.has(item)).length;
      return { confirmed: false, admitted: admitted.length, drained, detail: `${inFlight.size} native RPC request(s) remained in flight at the shutdown deadline` };
    }
    return { confirmed: true, admitted: admitted.length, drained: admitted.length, detail: 'native RPC admissions frozen and admitted requests drained' };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new Error('Native notification listener must be a function');
    if (disposed) return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispose() {
    if (disposed) return;
    closing = true;
    disposed = true;
    listeners.clear();
    try { removeNotificationListener?.(); } catch {}
  }

  return {
    methods: NATIVE_METHODS,
    handle,
    beginClose,
    get activeCount() { return inFlight.size; },
    subscribe,
    dispose,
  };
}

module.exports = {
  MAX_REQUEST_BYTES,
  MAX_TRANSPORT_BYTES,
  LOCAL_METHODS,
  NATIVE_METHODS,
  createNativeRpcRouter,
  daemonErrorResponse,
  errorResponse,
  isSafeJson,
  resultResponse,
  validateNativeRequest,
};
