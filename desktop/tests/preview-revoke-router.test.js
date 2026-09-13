'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NATIVE_METHODS, LOCAL_METHODS, createNativeRpcRouter } = require('../native-rpc-router');
const { createPreviewRevocationHandlers, METHODS: REVOKE_METHODS } = require('../preview-revoke');

// X-C-5/C19 review follow-up: the revocation methods must be callable
// through the REAL shared router allow-list in BOTH hosts (Electron main
// and the dev gateway register their own handlers against this same
// NATIVE_METHODS/LOCAL_METHODS set — no main.js side effect may be needed).

function stubMediaPreview() {
  const live = new Map();
  let seq = 0;
  return {
    issue: async ({ workspaceId, threadId, file, mime }) => {
      seq += 1;
      const token = `${String(seq).padStart(2, '0')}${'a'.repeat(62)}`;
      live.set(token, { workspaceId, threadId, file, mime });
      return { url: `http://127.0.0.1:0/${token}`, token, expiresAt: new Date(Date.now() + 600000).toISOString() };
    },
    revoke: (token) => live.delete(token),
    revokeScope: ({ workspaceId, threadId } = {}) => {
      let revoked = 0;
      for (const [token, record] of [...live]) {
        if ((workspaceId && record.workspaceId === workspaceId) || (threadId && record.threadId === threadId)) {
          live.delete(token);
          revoked += 1;
        }
      }
      return revoked;
    },
    stat: (token) => (live.get(token) ? { ...live.get(token) } : null),
    get liveCount() { return live.size; },
  };
}

function routerFor(service) {
  return createNativeRpcRouter({
    rpc: async () => assert.fail('router test must not reach the daemon'),
    handlers: { ...createPreviewRevocationHandlers(service).handlers },
  });
}

const call = (router, method, params) => router.handle({ jsonrpc: '2.0', id: `t-${method}-${Math.random()}`, method, params });

test('the shared router allow-list contains the revocation methods for both hosts', () => {
  for (const method of REVOKE_METHODS) {
    assert.ok(NATIVE_METHODS.has(method), `${method} in NATIVE_METHODS`);
    assert.ok(LOCAL_METHODS.has(method), `${method} in LOCAL_METHODS`);
  }
});

test('a real router request revokes a capability and rejects stale tokens', async () => {
  const service = stubMediaPreview();
  const router = routerFor(service);
  const issued = await service.issue({ workspaceId: 'ws-1', threadId: 'th-1', file: 'x.mp4', mime: 'video/mp4' });
  assert.equal(service.liveCount, 1);
  const ok = await call(router, 'preview/revoke', { token: issued.token });
  assert.equal(ok.result.revoked, true, JSON.stringify(ok));
  assert.equal(service.liveCount, 0);
  const stale = await call(router, 'preview/revoke', { token: issued.token });
  assert.equal(stale.result.revoked, false, 'revoking an already-revoked token reports false');
  const rejected = await call(router, 'preview/revoke', { token: 'nope' });
  assert.equal(rejected.error?.code, -32602, 'invalid token surfaces as a JSON-RPC error response');
});

test('a real router request revokes a whole scope', async () => {
  const service = stubMediaPreview();
  const router = routerFor(service);
  await service.issue({ workspaceId: 'ws-2', threadId: undefined, file: 'a.mp4', mime: 'video/mp4' });
  await service.issue({ workspaceId: 'ws-2', threadId: undefined, file: 'b.mp4', mime: 'video/mp4' });
  const outcome = await call(router, 'preview/revokeScope', { workspaceId: 'ws-2' });
  assert.equal(outcome.result.revoked, 2);
  assert.equal(service.liveCount, 0);
});

test('preview/read stays an allowed method while revocation rides the same allow-list', () => {
  assert.ok(NATIVE_METHODS.has('preview/read'));
  assert.ok(LOCAL_METHODS.has('preview/read'));
});
