'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const {
  MAX_PEER_BUFFERED_BYTES,
  createNativeGateway,
  sendPeerJson,
} = require('../native-gateway');
const { MAX_REQUEST_BYTES, MAX_TRANSPORT_BYTES } = require('../native-rpc-router');

const ORIGIN = 'http://127.0.0.1:3000';

function getJson(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/knorvia/native/session', method: 'GET', headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

function openSocket(port, token, { origin = ORIGIN } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/knorvia/native`,
      ['knorvia.native.v1', `knorvia.native.token.${token}`],
      { origin, perMessageDeflate: false },
    );
    const cleanup = () => {
      socket.removeListener('open', onOpen);
      socket.removeListener('error', onError);
      socket.removeListener('unexpected-response', onUnexpectedResponse);
    };
    const onOpen = () => {
      cleanup();
      socket.on('error', () => {});
      resolve(socket);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onUnexpectedResponse = (_request, response) => {
      cleanup();
      response.resume();
      reject(new Error(`websocket rejected (${response.statusCode})`));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('unexpected-response', onUnexpectedResponse);
  });
}

class GatewayClient {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = new Set();
    this.sequence = 0;
    socket.on('message', (data, isBinary) => {
      if (isBinary) return this.fail(new Error('unexpected binary gateway frame'));
      let message;
      try { message = JSON.parse(Buffer.from(data).toString('utf8')); } catch {
        return this.fail(new Error('gateway sent invalid JSON'));
      }
      this.deliver(message);
    });
    socket.once('close', () => this.fail(new Error('gateway socket closed')));
  }

  deliver(message) {
    for (const waiter of this.waiters) {
      let matches = false;
      try { matches = waiter.predicate(message); } catch (error) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(error);
        return;
      }
      if (!matches) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.messages.push(message);
  }

  waitFor(predicate, timeoutMs = 1_000) {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error('timed out waiting for native gateway message'));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  request(method, params = {}) {
    const id = `test-${++this.sequence}`;
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return this.waitFor((message) => message.id === id);
  }

  fail(error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  close() {
    this.socket.terminate();
  }
}

test('loopback native gateway issues one-time sessions and routes approved RPC', async () => {
  let notification;
  const calls = [];
  const assertOnlyExpectedCalls = () => {
    const forwarded = calls.filter(call => call.method === 'thread/read');
    const claims = calls.filter(call => call.method === 'cliDispatch/claim');
    assert.deepEqual(forwarded, [{ method: 'thread/read', params: { id: 'thread-1' } }]);
    assert.ok(claims.length >= 1, 'gateway starts its host-side durable CLI claim poll');
    assert.equal(calls.length, forwarded.length + claims.length, 'no unexpected RPC may be hidden by the background poll');
    const knownIds = new Set(require('../cli-backends').KNOWN_BACKENDS.map(backend => backend.id));
    for (const claim of claims) {
      assert.deepEqual(Object.keys(claim.params).sort(), ['backendIds', 'hostId']);
      assert.match(claim.params.hostId, /^host_[a-f0-9-]{36}$/);
      assert.equal(claim.params.hostId, claims[0].params.hostId, 'one gateway keeps one claim owner');
      assert.ok(Array.isArray(claim.params.backendIds));
      assert.equal(new Set(claim.params.backendIds).size, claim.params.backendIds.length);
      for (const id of claim.params.backendIds) assert.ok(knownIds.has(id), `undeclared backend ${id}`);
    }
  };
  const engine = {
    builtinSkills: [{ name: 'short-drama', userModified: true, updateAvailable: true }],
    rpc: async (method, params) => {
      calls.push({ method, params });
      if (method === 'cliDispatch/claim') return { jobs: [], cancels: [] };
      return { method, params };
    },
    onNotification: (listener) => {
      notification = listener;
      return () => { notification = undefined; };
    },
    kill: () => {},
  };
  const gateway = createNativeGateway({
    host: '127.0.0.1', port: 0, dev: true,
    engineFactory: async (options) => {
      assert.equal(options.legacyChatBridge, false);
      return engine;
    },
  });
  await gateway.start();
  const { port } = gateway.address();
  let client;
  try {
    const forbidden = await getJson(port);
    assert.equal(forbidden.status, 403);
    const session = await getJson(port, { 'x-knorvia-native-origin': ORIGIN });
    assert.equal(session.status, 200);
    assert.equal(typeof session.body.token, 'string');

    const socket = await openSocket(port, session.body.token);
    assert.equal(socket.protocol, 'knorvia.native.v1');
    client = new GatewayClient(socket);
    const approved = await client.request('thread/read', { id: 'thread-1' });
    assert.deepEqual(approved, {
      jsonrpc: '2.0', id: 'test-1', result: { method: 'thread/read', params: { id: 'thread-1' } },
    });
    const builtin = await client.request('extension/builtin/status', {});
    assert.deepEqual(builtin.result, { skills: engine.builtinSkills }, 'browser RPC must read the actual native runtime engine');
    assertOnlyExpectedCalls();

    notification({ jsonrpc: '2.0', method: 'turn/event', params: { threadId: 'thread-1', status: 'running' } });
    const note = await client.waitFor((message) => message.method === 'turn/event');
    assert.equal(note.params.threadId, 'thread-1');

    const restrictedDesktopAction = await client.request('desktop/open-path', {
      workspaceId: 'ws_fixture', path: 'notes.txt',
    });
    assert.equal(restrictedDesktopAction.error.code, -32040);
    assert.deepEqual(restrictedDesktopAction.error.data, { transport: 'browser', restricted: true });
    assertOnlyExpectedCalls();

    const rejected = await client.request('provider/execute', {});
    assert.equal(rejected.error.code, -32601);
    assertOnlyExpectedCalls();

    await assert.rejects(openSocket(port, session.body.token), /401/);
  } finally {
    client?.close();
    await gateway.close();
  }
});

test('gateway accepts fragmented JSON text and rejects messages above the configured payload cap', async () => {
  const gateway = createNativeGateway({
    host: '127.0.0.1', port: 0, dev: true,
    engineFactory: async () => ({
      rpc: async (method, params) => ({ method, params }),
      onNotification: () => () => {},
      kill: () => {},
    }),
  });
  await gateway.start();
  const { port } = gateway.address();
  const sockets = [];
  try {
    const session = await getJson(port, { 'x-knorvia-native-origin': ORIGIN });
    const socket = await openSocket(port, session.body.token);
    sockets.push(socket);
    const client = new GatewayClient(socket);
    const request = JSON.stringify({
      jsonrpc: '2.0', id: 'fragmented', method: 'thread/read', params: { id: 'thread-1' },
    });
    socket.send(request.slice(0, 23), { fin: false, binary: false });
    socket.send(request.slice(23), { fin: true, binary: false });
    const response = await client.waitFor((message) => message.id === 'fragmented');
    assert.equal(response.result.method, 'thread/read');

    const oversizedOrdinary = await client.request('thread/read', { id: 'x'.repeat(MAX_REQUEST_BYTES) });
    assert.equal(oversizedOrdinary.error.code, -32602);
    // A large response is legal even though ordinary incoming requests remain capped.
    const sent = [];
    assert.equal(sendPeerJson({ readyState: WebSocket.OPEN, bufferedAmount: 0,
      send: (body, options, done) => { sent.push(body); done(); },
    }, { jsonrpc: '2.0', id: 'bulk', result: { document: '中'.repeat(400000) } }), true);
    assert.ok(Buffer.byteLength(sent[0]) > MAX_REQUEST_BYTES);
    const bounded = [];
    assert.equal(sendPeerJson({ readyState: WebSocket.OPEN, bufferedAmount: 0,
      close: () => assert.fail('oversized result must not disconnect the client'),
      send: (body, options, done) => { bounded.push(JSON.parse(body)); done(); },
    }, { jsonrpc: '2.0', id: 'legacy-large', result: 'x'.repeat(MAX_TRANSPORT_BYTES) }), true);
    assert.equal(bounded[0].id, 'legacy-large');
    assert.equal(bounded[0].error.code, -32013);

    const tooLargeSession = await getJson(port, { 'x-knorvia-native-origin': ORIGIN });
    const tooLarge = await openSocket(port, tooLargeSession.body.token);
    sockets.push(tooLarge);
    const close = once(tooLarge, 'close');
    tooLarge.send('x'.repeat(MAX_TRANSPORT_BYTES + 1));
    const [code] = await close;
    assert.equal(code, 1009);
  } finally {
    for (const socket of sockets) socket.terminate();
    await gateway.close();
  }
});

test('gateway drops a peer before an outbound notification can grow its socket queue', () => {
  let closed;
  const peer = {
    readyState: WebSocket.OPEN,
    bufferedAmount: MAX_PEER_BUFFERED_BYTES,
    close: (code, reason) => { closed = { code, reason }; },
  };
  assert.equal(sendPeerJson(peer, { jsonrpc: '2.0', method: 'turn/event', params: {} }), false);
  assert.deepEqual(closed, { code: 1013, reason: 'client output backlog' });
});

test('gateway close bounds a startup dependency that never settles and memoizes the close', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-gateway-startup-close-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const gateway = createNativeGateway({
    host: '127.0.0.1', port: 0, dev: true, home,
    env: { ...process.env, KNORVIA_SHUTDOWN_BUDGET_MS: '120' },
    engineFactory: () => new Promise(() => {}),
  });
  void gateway.start().catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 20));
  const began = performance.now();
  const first = gateway.close();
  const second = gateway.close();
  assert.equal(first, second, 'repeated close calls share one bounded shutdown');
  const report = await first;
  const elapsed = performance.now() - began;
  assert.ok(elapsed < 600, `gateway close escaped its 120ms host budget (${elapsed}ms)`);
  assert.ok(report.unconfirmed.includes('gateway-startup'));
  assert.equal(report.steps.find(step => step.name === 'gateway-startup')?.status, 'unconfirmed');
});

test('late startup cleanup reuses the expired original shutdown deadline', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-gateway-late-cleanup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let resolveEngine;
  const engineReady = new Promise(resolve => { resolveEngine = resolve; });
  const shutdownTimeouts = [];
  const gateway = createNativeGateway({
    host: '127.0.0.1', port: 0, dev: true, home,
    env: { ...process.env, KNORVIA_SHUTDOWN_BUDGET_MS: '120' },
    engineFactory: () => engineReady,
  });
  const startup = gateway.start().catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 20));
  const report = await gateway.close();
  assert.ok(report.unconfirmed.includes('gateway-startup'));

  // Resolve startup only after the original absolute deadline has expired.
  // The delayed sweep must signal shutdown with zero remaining budget.
  await new Promise(resolve => setTimeout(resolve, 120));
  resolveEngine({
    rpc: async () => ({}),
    onNotification: () => () => {},
    shutdown: async ({ timeoutMs }) => { shutdownTimeouts.push(timeoutMs); },
    kill: () => {},
  });
  await startup;
  const until = Date.now() + 1000;
  while (!shutdownTimeouts.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(shutdownTimeouts, [0], 'late cleanup cannot allocate a fresh shutdown budget');
});
