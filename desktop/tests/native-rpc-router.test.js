'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NATIVE_METHODS, MAX_TRANSPORT_BYTES, createNativeRpcRouter, validateNativeRequest } = require('../native-rpc-router');

test('bulk studio documents cross one MiB without widening ordinary RPC limits', () => {
  const params = { document: '中'.repeat(700000) };
  for (const method of ['studio/sequence/create', 'studio/sequence/update', 'studio/template/import', 'studio/canvas/create', 'studio/canvas/save']) {
    assert.ok(validateNativeRequest({ jsonrpc: '2.0', id: 'bulk', method, params }).value, method);
  }
  assert.equal(validateNativeRequest({ jsonrpc: '2.0', id: 'ordinary', method: 'thread/read', params }).error.error.code, -32602);
  assert.equal(validateNativeRequest({ jsonrpc: '2.0', id: 'too-big', method: 'studio/sequence/update',
    params: { document: 'x'.repeat(MAX_TRANSPORT_BYTES) } }).error.error.code, -32602);
});

test('native router exposes only the reviewed project-context and automation additions', () => {
  for (const method of [
    'workspace/path/resolve',
    'workspace/files/list',
    'workspace/files/read',
    'workspace/git/status',
    'workspace/git/diff',
    'workspace/worktree/create',
    'automation/list',
    'automation/create',
    'automation/update',
    'automation/delete',
    'automation/run',
    'goal/create',
    'goal/read',
    'goal/list',
    'goal/update',
  ]) assert.equal(NATIVE_METHODS.has(method), true, method);
  assert.equal(NATIVE_METHODS.has('shell/execute'), false);
  assert.equal(NATIVE_METHODS.has('system/prepareRestart'), false);
  assert.equal(NATIVE_METHODS.has('system/cancelRestart'), false);
  assert.equal(NATIVE_METHODS.has('migration/run'), false);
});

test('native router forwards only approved JSON-RPC methods', async () => {
  const calls = [];
  const router = createNativeRpcRouter({
    rpc: async (method, params) => {
      calls.push({ method, params });
      return { id: params.id, status: 'ok' };
    },
  });
  try {
    const response = await router.handle({
      jsonrpc: '2.0', id: 'thread-read', method: 'thread/read', params: { id: 'thread-1' },
    });
    assert.deepEqual(response, {
      jsonrpc: '2.0', id: 'thread-read', result: { id: 'thread-1', status: 'ok' },
    });
    assert.deepEqual(calls, [{ method: 'thread/read', params: { id: 'thread-1' } }]);

    const rejected = await router.handle({
      jsonrpc: '2.0', id: 'provider', method: 'provider/execute', params: { model: 'anything' },
    });
    assert.equal(rejected.error.code, -32601);
    assert.equal(calls.length, 1);
  } finally {
    router.dispose();
  }
});

test('beginClose atomically freezes admission and drains requests accepted before the freeze', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const router = createNativeRpcRouter({
    rpc: async (method) => { calls.push(method); await gate; return { ok: true }; },
  });
  const admitted = router.handle({ jsonrpc: '2.0', id: 'before', method: 'thread/read', params: { id: 't' } });
  await Promise.resolve();
  assert.equal(router.activeCount, 1);
  const closing = router.beginClose();
  const refused = await router.handle({ jsonrpc: '2.0', id: 'after', method: 'thread/read', params: { id: 't' } });
  assert.equal(refused.error.code, -32000);
  assert.deepEqual(calls, ['thread/read']);
  release();
  assert.equal((await admitted).result.ok, true);
  assert.deepEqual(await closing, {
    confirmed: true, admitted: 1, drained: 1,
    detail: 'native RPC admissions frozen and admitted requests drained',
  });
  assert.equal(router.activeCount, 0);
});

test('beginClose reports an undrained request when its shutdown signal aborts', async () => {
  const router = createNativeRpcRouter({ rpc: async () => new Promise(() => {}) });
  void router.handle({ jsonrpc: '2.0', id: 'hang', method: 'thread/read', params: { id: 't' } });
  await Promise.resolve();
  const controller = new AbortController();
  const closing = router.beginClose({ signal: controller.signal });
  controller.abort();
  const receipt = await closing;
  assert.equal(receipt.confirmed, false);
  assert.equal(receipt.admitted, 1);
  assert.match(receipt.detail, /remained in flight/);
});

test('native router rejects unsafe params before daemon dispatch', async () => {
  const unsafe = JSON.parse('{"jsonrpc":"2.0","id":"unsafe","method":"thread/read","params":{"__proto__":{"polluted":true}}}');
  const parsed = validateNativeRequest(unsafe);
  assert.equal(parsed.error.error.code, -32602);
  const router = createNativeRpcRouter({ rpc: async () => assert.fail('unsafe request reached daemon') });
  try {
    const response = await router.handle(unsafe);
    assert.equal(response.error.code, -32602);
  } finally {
    router.dispose();
  }
});

test('native router preserves daemon notifications as JSON-RPC notifications', () => {
  let emit;
  const router = createNativeRpcRouter({
    rpc: async () => ({}),
    onNotification: (listener) => {
      emit = listener;
      return () => { emit = undefined; };
    },
  });
  const received = [];
  const unsubscribe = router.subscribe((message) => received.push(message));
  const note = { jsonrpc: '2.0', method: 'turn/event', params: { threadId: 'thread-1' } };
  emit(note);
  assert.deepEqual(received, [note]);
  unsubscribe();
  emit(note);
  assert.equal(received.length, 1);
  router.dispose();
});

test('connection methods stay local to the host and cannot be forwarded into the daemon', async () => {
  const calls = [];
  const router = createNativeRpcRouter({
    rpc: async (method) => {
      calls.push(method);
      return {};
    },
    handlers: {
      'connection/read': async () => ({ configured: false, apiKeyConfigured: false }),
      'connection/update': async () => ({ configured: true, apiKeyConfigured: true }),
      'connection/test': async () => ({ ok: true, kernelReady: true, providerVerified: false }),
    },
  });
  try {
    const read = await router.handle({ jsonrpc: '2.0', id: 'connection', method: 'connection/read', params: {} });
    assert.equal(read.result.configured, false);
    assert.deepEqual(calls, []);

    const unavailableDesktopAction = await router.handle({
      jsonrpc: '2.0', id: 'desktop', method: 'desktop/open-path',
      params: { workspaceId: 'ws_fixture', path: 'notes.txt' },
    });
    assert.equal(unavailableDesktopAction.error.code, -32601);
    assert.deepEqual(calls, []);

    const scopedFileList = await router.handle({
      jsonrpc: '2.0', id: 'files', method: 'workspace/files/list', params: { workspaceId: 'ws_fixture' },
    });
    assert.deepEqual(scopedFileList.result, {});
    assert.deepEqual(calls, ['workspace/files/list']);
  } finally {
    router.dispose();
  }
});
