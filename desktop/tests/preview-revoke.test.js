'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreviewRevocationHandlers, TOKEN_PATTERN } = require('../preview-revoke');

const TOKEN = 'a'.repeat(64);
const TOKEN2 = 'b'.repeat(64);

function stubService() {
  const calls = [];
  const live = new Set([TOKEN, TOKEN2]);
  return {
    calls,
    revoke: (token) => { calls.push(['revoke', token]); return live.delete(token); },
    revokeScope: (scope) => { calls.push(['revokeScope', scope]); return scope.workspaceId ? 2 : 1; },
  };
}

test('a valid token revoke reaches the service and reports the outcome', async () => {
  const service = stubService();
  const { handlers } = createPreviewRevocationHandlers(service);
  assert.deepEqual(await handlers['preview/revoke']({ token: TOKEN }), { revoked: true });
  assert.deepEqual(await handlers['preview/revoke']({ token: TOKEN.toUpperCase() }), { revoked: false }, 'case-insensitive token, already gone');
  assert.deepEqual(service.calls[0], ['revoke', TOKEN]);
});

test('malformed tokens are rejected without touching the service', async () => {
  const service = stubService();
  const { handlers } = createPreviewRevocationHandlers(service);
  for (const bad of [undefined, null, '', 'short', 'z'.repeat(64), `${TOKEN}extra`, { token: TOKEN }]) {
    await assert.rejects(handlers['preview/revoke']({ token: bad }), error => error.rpc.code === -32602);
  }
  await assert.rejects(handlers['preview/revoke'](), error => error.rpc.code === -32602);
  assert.equal(service.calls.length, 0, 'the service is never consulted for invalid input');
});

test('revokeScope requires a scope and forwards it verbatim', async () => {
  const service = stubService();
  const { handlers } = createPreviewRevocationHandlers(service);
  assert.deepEqual(await handlers['preview/revokeScope']({ workspaceId: 'ws-1' }), { revoked: 2 });
  assert.deepEqual(await handlers['preview/revokeScope']({ threadId: 'thread-9' }), { revoked: 1 });
  assert.deepEqual(service.calls[0], ['revokeScope', { workspaceId: 'ws-1', threadId: undefined }]);
  await assert.rejects(handlers['preview/revokeScope']({}), error => error.rpc.code === -32602);
  await assert.rejects(handlers['preview/revokeScope']({ workspaceId: 42 }), error => error.rpc.code === -32602);
  assert.equal(service.calls.filter(([method]) => method === 'revokeScope').length, 2, 'rejected calls never reach the service');
});

test('the service contract is enforced at registration time', () => {
  assert.throws(() => createPreviewRevocationHandlers(null), /revoke\/revokeScope/);
  assert.throws(() => createPreviewRevocationHandlers({ revoke: () => {} }), /revoke\/revokeScope/);
  const { methods } = createPreviewRevocationHandlers(stubService());
  assert.deepEqual(methods, ['preview/revoke', 'preview/revokeScope']);
  assert.ok(TOKEN_PATTERN.test('0123abcdef'.repeat(6) + '0123'));
  assert.ok(!TOKEN_PATTERN.test('g'.repeat(64)));
});
