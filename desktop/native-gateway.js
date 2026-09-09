'use strict';

// Development-only loopback gateway for the browser workbench. It uses the
// same createKernelEngine sidecar as Desktop, accepts a narrow native RPC
// allow-list, and never exposes the daemon's stdio transport on TCP.

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');
const { createKernelEngine } = require('./kernel-engine');
const { MAX_TRANSPORT_BYTES, createNativeRpcRouter, errorResponse } = require('./native-rpc-router');
const { createNativeRuntime } = require('./native-runtime');
const { createWorkspacePreview } = require('./workspace-preview');
const { createPersonalLibrary } = require('./personal-library');
const { createMediaStudio } = require('./media-studio');
const { createStudioMcp } = require('./studio-mcp');
const { createLearningPack } = require('./learning-pack');
const { createCreativeCliService } = require('./creative-cli-service');
const { createOpenmaicCourse } = require('./openmaic-course');
const { createLibraryImageOps } = require('./library-image-ops');
const { createCliBackendHandlers } = require('./cli-backends');
const { createCliDispatchBridge } = require('./cli-dispatch');
const { createCuratedCatalog } = require('./curated-catalog');
const { createWorkspaceTerminal } = require('./workspace-terminal');
const { createTurnNotifier } = require('./turn-notifications');
const { createExtensionManager, extensionConnectionHandlers } = require('./extension-manager');
const { createSshSessions } = require('./ssh-session');
const { createWorktreeSnapshots } = require('./worktree-snapshots');
const { browserDesktopPathHandlers } = require('./desktop-path-actions');

const NATIVE_GATEWAY_PATH = '/knorvia/native';
const NATIVE_GATEWAY_SESSION_PATH = '/knorvia/native/session';
const NATIVE_GATEWAY_HEALTH_PATH = '/health';
const NATIVE_SUBPROTOCOL = 'knorvia.native.v1';
const TOKEN_PROTOCOL_PREFIX = 'knorvia.native.token.';
const TOKEN_TTL_MS = 2 * 60 * 1000;
// The gateway is intentionally a small local development boundary. These caps
// prevent one local tab from accumulating an unbounded session, request, or
// notification queue while it is stalled in a debugger or disconnected.
const MAX_PENDING_SESSIONS = 256;
const MAX_INFLIGHT_REQUESTS_PER_PEER = 32;
const MAX_PEER_BUFFERED_BYTES = 2 * MAX_TRANSPORT_BYTES;

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase();
  return value === '::1'
    || value === '::ffff:127.0.0.1'
    || /^127(?:\.\d{1,3}){3}$/.test(value);
}

function isLoopbackBindHost(host) {
  const value = String(host || '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

function parseAllowedOrigins(raw) {
  return new Set(String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean));
}

function originIsAllowed(origin, allowedOrigins) {
  if (typeof origin !== 'string' || !origin) return false;
  if (allowedOrigins?.size) return allowedOrigins.has(origin);
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (parsed.hostname === 'localhost'
        || parsed.hostname === '127.0.0.1'
        || parsed.hostname === '[::1]'
        || parsed.hostname === '::1')
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function requestOrigin(headers) {
  const direct = typeof headers?.origin === 'string' ? headers.origin : '';
  const forwarded = typeof headers?.['x-knorvia-native-origin'] === 'string'
    ? headers['x-knorvia-native-origin']
    : '';
  if (direct && forwarded && direct !== forwarded) return null;
  return direct || forwarded || null;
}

function isTrustedGatewayRequest(request, allowedOrigins) {
  return isLoopbackAddress(request?.socket?.remoteAddress)
    && originIsAllowed(requestOrigin(request?.headers), allowedOrigins);
}

function parseProtocols(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(part));
}

function writeJson(response, status, value, origin) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  };
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'origin';
  }
  response.writeHead(status, headers);
  response.end(body);
}

function rejectUpgrade(socket, status, message) {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      'ascii',
    );
  } catch {}
  socket.destroy();
}

function closePeer(peer, code, reason) {
  if (!peer || peer.readyState === WebSocket.CLOSED) return;
  try {
    peer.close(code, reason);
  } catch {
    try { peer.terminate(); } catch {}
  }
}

// `ws` owns framing, fragmented-message reassembly, mask validation, UTF-8
// checks, ping/pong and protocol errors. The only application queue is this
// bounded JSON sender so a stalled browser cannot grow Node's socket buffer.
function sendPeerJson(peer, message) {
  if (!peer || peer.readyState !== WebSocket.OPEN) return false;
  let body;
  try {
    body = JSON.stringify(message);
  } catch {
    closePeer(peer, 1011, 'invalid gateway message');
    return false;
  }
  if (typeof body !== 'string') {
    closePeer(peer, 1011, 'invalid gateway message');
    return false;
  }
  let byteLength = Buffer.byteLength(body, 'utf8');
  if (byteLength > MAX_TRANSPORT_BYTES) {
    if (message && Object.hasOwn(message, 'id') && !Object.hasOwn(message, 'method')) {
      // Keep the session usable when legacy data exceeds a detail response cap.
      // Never truncate data or turn an unsuccessful read into a success.
      body = JSON.stringify(errorResponse(message.id, -32013, 'This result is too large. Narrow the selection or read individual items.', { maxBytes: MAX_TRANSPORT_BYTES }));
      byteLength = Buffer.byteLength(body, 'utf8');
    } else {
      closePeer(peer, 1009, 'gateway message too large');
      return false;
    }
  }
  if (Number(peer.bufferedAmount || 0) + byteLength > MAX_PEER_BUFFERED_BYTES) {
    closePeer(peer, 1013, 'client output backlog');
    return false;
  }
  try {
    peer.send(body, { binary: false, compress: false }, (error) => {
      if (error) {
        try { peer.terminate(); } catch {}
      }
    });
    return true;
  } catch {
    try { peer.terminate(); } catch {}
    return false;
  }
}

function createNativeGateway({
  host = process.env.KNORVIA_NATIVE_GATEWAY_HOST || '127.0.0.1',
  port = Number(process.env.KNORVIA_NATIVE_GATEWAY_PORT || 4318),
  home = process.env.KNORVIA_NATIVE_HOME || path.resolve(__dirname, '..', 'desktop-data'),
  env = process.env,
  version = '0.1.0-dev',
  dev = process.env.KNORVIA_NATIVE_GATEWAY_DEV === '1',
  engineFactory = createKernelEngine,
  allowedOrigins = parseAllowedOrigins(process.env.KNORVIA_NATIVE_ALLOWED_ORIGINS),
  publicPath = '/api/knorvia/native',
  sessionPath = '/api/knorvia/native/session',
} = {}) {
  if (!dev) throw new Error('The native gateway is development-only. Set KNORVIA_NATIVE_GATEWAY_DEV=1.');
  if (!isLoopbackBindHost(host)) throw new Error('The native gateway may bind only a loopback host.');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid native gateway port.');

  const tokens = new Map();
  const peers = new Set();
  const server = http.createServer();
  const webSocketServer = new WebSocketServer({
    clientTracking: false,
    handleProtocols: (protocols) => protocols.has(NATIVE_SUBPROTOCOL) ? NATIVE_SUBPROTOCOL : false,
    maxPayload: MAX_TRANSPORT_BYTES,
    noServer: true,
    // Compression raises the effective message size and gives a local caller a
    // needless CPU amplification path. JSON-RPC frames here are small enough
    // that it has no user-facing benefit.
    perMessageDeflate: false,
  });
  let runtime;
  let terminals;
  let router;
  let removeRouterNotification;
  let started = false;
  let closed = false;
  const tokenSweep = setInterval(() => {
    const now = Date.now();
    for (const [token, session] of tokens) if (session.expiresAt <= now) tokens.delete(token);
  }, TOKEN_TTL_MS);
  tokenSweep.unref?.();

  function issueSession(origin) {
    const now = Date.now();
    for (const [token, session] of tokens) if (session.expiresAt <= now) tokens.delete(token);
    if (tokens.size >= MAX_PENDING_SESSIONS) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now + TOKEN_TTL_MS;
    tokens.set(token, { origin, expiresAt });
    return {
      protocol: NATIVE_SUBPROTOCOL,
      url: publicPath,
      sessionPath,
      token,
      expiresAt,
    };
  }

  server.on('request', (request, response) => {
    const url = new URL(request.url || '/', 'http://knorvia.local');
    const origin = requestOrigin(request.headers);
    if (url.pathname === NATIVE_GATEWAY_HEALTH_PATH && request.method === 'GET') {
      writeJson(response, 200, { ok: true, product: 'Knorvia', protocol: NATIVE_SUBPROTOCOL });
      return;
    }
    if (url.pathname !== NATIVE_GATEWAY_SESSION_PATH) {
      writeJson(response, 404, { error: 'not_found' });
      return;
    }
    if (request.method === 'OPTIONS') {
      if (!isTrustedGatewayRequest(request, allowedOrigins)) {
        writeJson(response, 403, { error: 'forbidden' });
        return;
      }
      response.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'x-knorvia-native-origin',
        'access-control-allow-methods': 'GET, OPTIONS',
        vary: 'origin',
      });
      response.end();
      return;
    }
    if (request.method !== 'GET' || !isTrustedGatewayRequest(request, allowedOrigins)) {
      writeJson(response, 403, { error: 'forbidden' });
      return;
    }
    const session = issueSession(origin);
    if (!session) {
      writeJson(response, 429, { error: 'too_many_pending_native_sessions' }, origin);
      return;
    }
    writeJson(response, 200, session, origin);
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://knorvia.local');
    if (url.pathname !== NATIVE_GATEWAY_PATH) return rejectUpgrade(socket, 404, 'Not Found');
    if (!isTrustedGatewayRequest(request, allowedOrigins)) return rejectUpgrade(socket, 403, 'Forbidden');
    if (String(request.headers.upgrade || '').toLowerCase() !== 'websocket'
      || request.headers['sec-websocket-version'] !== '13'
      || typeof request.headers['sec-websocket-key'] !== 'string') {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    const protocols = parseProtocols(request.headers['sec-websocket-protocol']);
    const tokenProtocol = protocols.find((value) => value.startsWith(TOKEN_PROTOCOL_PREFIX));
    const token = tokenProtocol?.slice(TOKEN_PROTOCOL_PREFIX.length);
    const origin = requestOrigin(request.headers);
    const session = token ? tokens.get(token) : null;
    if (!protocols.includes(NATIVE_SUBPROTOCOL) || !session || session.expiresAt <= Date.now() || session.origin !== origin) {
      if (token) tokens.delete(token);
      return rejectUpgrade(socket, 401, 'Unauthorized');
    }
    tokens.delete(token);
    webSocketServer.handleUpgrade(request, socket, head, (peer) => {
      let inFlight = 0;
      const removePeer = () => peers.delete(peer);
      peers.add(peer);
      peer.once('close', removePeer);
      peer.once('error', removePeer);
      peer.on('message', (data, isBinary) => {
        if (isBinary) {
          closePeer(peer, 1003, 'text messages required');
          return;
        }
        if (inFlight >= MAX_INFLIGHT_REQUESTS_PER_PEER) {
          sendPeerJson(peer, errorResponse(null, -32029, 'Too many in-flight native requests'));
          return;
        }
        let message;
        try {
          message = JSON.parse(Buffer.from(data).toString('utf8'));
        } catch {
          sendPeerJson(peer, errorResponse(null, -32700, 'Invalid JSON-RPC JSON'));
          return;
        }
        inFlight += 1;
        Promise.resolve(router.handle(message))
          .then((response) => sendPeerJson(peer, response))
          .catch(() => sendPeerJson(peer, errorResponse(message?.id, -32603, 'Native gateway request failed')))
          .finally(() => { inFlight -= 1; });
      });
    });
  });

  let mediaStudio; let studioMcp; let personalLibrary; let extensionManager; let sshSessions; let worktreeSnapshots; let creativeCliService; let cliDispatch;
  let starting; let closing;
  function start() {
    if (closed) throw new Error('Native gateway is closed');
    if (started) return Promise.resolve(address());
    if (starting) return starting;
    starting = startServices();
    return starting;
  }
  async function startServices() {
    try {
    // Learning/catalog packs are constructed lazily on first tool use: the
    // studio, library and extension managers are created further below.
    let learningPack;
    let curatedCatalog;
    studioMcp = await createStudioMcp({
      getStudio: () => mediaStudio,
      getLibrary: () => personalLibrary,
      getLearning: () => (learningPack ??= createLearningPack({ home, library: personalLibrary, studio: mediaStudio, rpc: runtime.rpc })),
      getCatalog: () => (curatedCatalog ??= createCuratedCatalog({ home, library: personalLibrary, studio: mediaStudio, extensionManager, rpc: runtime.rpc })),
      home,
    });
    if (closed) throw new Error('Native gateway is closed');
    runtime = await createNativeRuntime({
      home,
      env: { ...env, ...studioMcp.env },
      version,
      mode: 'browser',
      engineFactory,
      // Browser workbench never needs the compatibility StreamEvent bridge.
      legacyChatBridge: false,
    });
    if (closed) throw new Error('Native gateway is closed');
    personalLibrary = createPersonalLibrary({ home, rpc: runtime.rpc });
    mediaStudio = createMediaStudio({ home, rpc: runtime.rpc, library: personalLibrary });
    terminals = createWorkspaceTerminal({ rpc: runtime.rpc });
    sshSessions = createSshSessions({ home, rpc: runtime.rpc });
    worktreeSnapshots = createWorktreeSnapshots({ home, rpc: runtime.rpc });
    extensionManager = createExtensionManager({ home, rpc: runtime.rpc });
    await extensionManager.restore();
    learningPack ??= createLearningPack({ home, library: personalLibrary, studio: mediaStudio, rpc: runtime.rpc });
    curatedCatalog ??= createCuratedCatalog({ home, library: personalLibrary, studio: mediaStudio, extensionManager, rpc: runtime.rpc });
    creativeCliService = createCreativeCliService({ home, rpc: runtime.rpc, library: personalLibrary, studio: mediaStudio, extensionManager, learning: learningPack, catalog: curatedCatalog, course: createOpenmaicCourse({ library: personalLibrary }), imageOps: createLibraryImageOps({ library: personalLibrary }), version });
    await creativeCliService.listen();
    const turnNotifier = createTurnNotifier({ home, browser: true });
    const cliBackends = createCliBackendHandlers({ env });
    cliDispatch = createCliDispatchBridge({ rpc: runtime.rpc, handlers: cliBackends.handlers, backendIds: () => cliBackends.host.availableBackendIds() });
    void cliDispatch.start();
    router = createNativeRpcRouter({
      rpc: runtime.rpc,
      onNotification: runtime.onNotification,
      handlers: {
        'connection/read': runtime.connectionRead,
        'connection/provider/save': runtime.providerSave,
        'connection/provider/delete': runtime.providerDelete,
        'connection/provider/activate': runtime.providerActivate,
        'connection/update': runtime.connectionUpdate,
        'connection/test': runtime.connectionTest,
        ...turnNotifier.handlers,
        ...extensionManager.handlers,
        ...extensionConnectionHandlers(runtime, extensionManager),
        ...sshSessions.handlers,
        ...worktreeSnapshots.handlers,
        ...browserDesktopPathHandlers(),
        ...createWorkspacePreview({ rpc: runtime.rpc }),
        ...personalLibrary.handlers,
        ...mediaStudio.handlers,
        ...terminals.handlers,
        ...learningPack.commands,
        ...cliBackends.handlers,
      },
    });
    removeRouterNotification = router.subscribe((notification) => {
      for (const peer of peers) sendPeerJson(peer, notification);
    });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      started = true;
      if (closed) throw new Error('Native gateway is closed');
      return address();
    } catch (error) {
      closed = true;
      await disposeServices();
      throw error;
    }
  }

  function address() {
    const listening = server.address();
    const boundPort = typeof listening === 'object' && listening ? listening.port : port;
    return {
      host,
      port: boundPort,
      url: `http://${host.includes(':') ? `[${host}]` : host}:${boundPort}`,
      nativePath: NATIVE_GATEWAY_PATH,
      nativeSessionPath: NATIVE_GATEWAY_SESSION_PATH,
    };
  }

  function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      try { await starting; } catch {}
      await disposeServices();
    })();
    return closing;
  }

  async function disposeServices() {
    try { await cliDispatch?.close(); } catch {}
    cliDispatch = undefined;
    try { await creativeCliService?.close(); } catch {}
    creativeCliService = undefined;
    clearInterval(tokenSweep);
    tokens.clear();
    for (const peer of peers) {
      try { peer.terminate(); } catch {}
    }
    peers.clear();
    try { removeRouterNotification?.(); } catch {}
    try { router?.dispose(); } catch {}
    try { webSocketServer.close(); } catch {}
    if (started) {
      started = false;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    // Reject new Agent calls before aborting media work, and leave the durable
    // daemon available until workers have settled their checkpoints.
    try { await studioMcp?.close(); } catch {}
    studioMcp = undefined;
    try { await mediaStudio?.close(); } catch {}
    mediaStudio = undefined;
    terminals?.dispose();
    terminals = undefined;
    sshSessions?.dispose(); sshSessions = undefined;
    try { await worktreeSnapshots?.close(); } catch {}
    worktreeSnapshots = undefined;
    try { await extensionManager?.close(); } catch {}
    extensionManager = undefined;
    try { await runtime?.close?.(); } catch {}
    runtime = undefined;
    router = undefined;
  }

  return {
    address,
    close,
    start,
    server,
    get runtime() { return runtime; },
    webSocketServer,
  };
}

async function runMain() {
  const gateway = createNativeGateway({
    dev: process.argv.includes('--dev') || process.env.KNORVIA_NATIVE_GATEWAY_DEV === '1',
  });
  const location = await gateway.start();
  process.stdout.write(`KNORVIA_NATIVE_GATEWAY=${location.url}${location.nativePath}\n`);
  const stop = () => gateway.close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  runMain().catch((error) => {
    process.stderr.write(`native gateway failed: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  NATIVE_GATEWAY_HEALTH_PATH,
  NATIVE_GATEWAY_PATH,
  NATIVE_GATEWAY_SESSION_PATH,
  NATIVE_SUBPROTOCOL,
  TOKEN_PROTOCOL_PREFIX,
  MAX_INFLIGHT_REQUESTS_PER_PEER,
  MAX_PEER_BUFFERED_BYTES,
  MAX_PENDING_SESSIONS,
  createNativeGateway,
  isLoopbackAddress,
  isLoopbackBindHost,
  isTrustedGatewayRequest,
  originIsAllowed,
  parseAllowedOrigins,
  parseProtocols,
  requestOrigin,
  sendPeerJson,
};
