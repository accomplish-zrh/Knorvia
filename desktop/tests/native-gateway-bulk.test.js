'use strict';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { startNativeGatewayFixture } = require('./fixtures/start-native-gateway-fixture');
const { MAX_REQUEST_BYTES, MAX_TRANSPORT_BYTES } = require('../native-rpc-router');
const daemon = process.env.KNORVIA_DAEMON_BIN || 'D:/tools/knorvia-kernel/knorvia-rs/target/release/knorvia-daemon.exe';
const kernel = process.env.KNORVIA_KERNEL_BIN || 'D:/tools/knorvia-kernel/codex-rs/target/release/codex-app-server.exe';
const origin = 'http://127.0.0.1:3000';

test('real wire carries large sequence edits and template imports, preserves ordinary limits, and never submits generation', {
  skip: !fs.existsSync(daemon) || !fs.existsSync(kernel), timeout: 90000,
}, async () => {
  const fixture = await startNativeGatewayFixture({ daemonBin: daemon, kernelBin: kernel, port: 0, cleanup: true });
  let socket; const pending = new Map(), traffic = []; let sequence = 0;
  try {
    const session = await fetch(`${fixture.location.url}/knorvia/native/session`, { headers: { 'x-knorvia-native-origin': origin } }).then(response => response.json());
    socket = new WebSocket(`ws://127.0.0.1:${fixture.location.port}/knorvia/native`, ['knorvia.native.v1', `knorvia.native.token.${session.token}`], { origin, perMessageDeflate: false });
    socket.on('error', () => {}); await once(socket, 'open');
    socket.on('message', raw => {
      const bytes = Buffer.byteLength(raw), message = JSON.parse(raw.toString()); const request = pending.get(message.id);
      if (!request) return; pending.delete(message.id); clearTimeout(request.timer);
      traffic.push({ method: request.method, requestBytes: request.bytes, responseBytes: bytes, errorCode: message.error?.code });
      if (message.error) request.reject(Object.assign(new Error(message.error.message), { rpc: message.error })); else request.resolve(message.result);
    });
    const rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const id = `bulk-${++sequence}`, body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`No wire response for ${method}`)); }, 15000);
      pending.set(id, { method, resolve, reject, timer, bytes: Buffer.byteLength(body) }); socket.send(body);
    });
    const profile = await rpc('studio/model/save', { name: 'Wire fixture only', kind: 'video', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'wire-fixture', agentEnabled: false });
    // Keep the wire payload above 1 MiB while leaving room for the persisted
    // acceptedPrompt copy and per-shot metadata under the 3 MiB detail cap.
    const shots = Array.from({ length: 200 }, (_, i) => ({ prompt: `${i} ${'场景'.repeat(950)}`, continuity: 'none' }));
    const created = await rpc('studio/sequence/create', { title: 'Large wire fixture', defaults: { profileId: profile.id, seconds: 4 }, shots, start: false });
    assert.equal(created.shots.length, 200); assert.equal(created.state, 'ready');
    const reordered = [...created.shots].reverse();
    const edited = await rpc('studio/sequence/update', { id: created.id, revision: created.revision, patch: { shots: reordered } });
    assert.equal(edited.shots[0].id, created.shots[199].id);
    const read = await rpc('studio/sequence/read', { id: created.id }); assert.equal(read.shots[0].prompt, shots[199].prompt);
    assert.ok(Buffer.byteLength(JSON.stringify(read)) < 3 * 1024 * 1024);
    const oversizeShots = shots.map((shot, i) => ({ ...shot, prompt: `${i} ${'场景'.repeat(1200)}` }));
    const detailLimitError = error => error.rpc?.code === -32602 && /3 MiB/.test(error.rpc.message);
    await assert.rejects(rpc('studio/sequence/create', { title: 'Rejected oversized detail', defaults: { profileId: profile.id, seconds: 4 }, shots: oversizeShots, start: false }), detailLimitError);
    await assert.rejects(rpc('studio/sequence/update', { id: created.id, revision: edited.revision, patch: { shots: oversizeShots } }), detailLimitError);
    const afterRejected = await rpc('studio/sequence/read', { id: created.id });
    assert.equal(afterRejected.revision, edited.revision, 'oversized update must not commit a revision');
    assert.deepEqual(afterRejected.shots, edited.shots, 'oversized update must preserve all accepted content');
    assert.equal((await rpc('studio/sequence/list')).total, 1, 'oversized create must not leave a durable sequence');
    const templates = Array.from({ length: 100 }, (_, i) => ({ name: `Wire template ${i}`, prompt: '提示'.repeat(2500), kind: 'video' }));
    const imported = await rpc('studio/template/import', { templates }); assert.equal(imported.imported, 100);
    const list = await rpc('studio/template/list'); assert.equal(list.templates.length, 100);
    await assert.rejects(rpc('thread/read', { id: 'x'.repeat(MAX_REQUEST_BYTES) }), error => error.rpc.code === -32602);
    assert.equal((await rpc('system/health')).ok, true, 'ordinary oversize rejection must leave the connection usable');
    for (const method of ['studio/sequence/create', 'studio/sequence/update', 'studio/template/import']) {
      const entry = traffic.find(value => value.method === method); assert.ok(entry.requestBytes > MAX_REQUEST_BYTES); assert.ok(entry.requestBytes < MAX_TRANSPORT_BYTES); assert.ok(entry.responseBytes > MAX_REQUEST_BYTES); assert.equal(entry.errorCode, undefined);
    }
    const rejectedDetails = traffic.filter(value => value.errorCode === -32602 && value.method.startsWith('studio/sequence/'));
    assert.equal(rejectedDetails.length, 2);
    for (const entry of rejectedDetails) {
      assert.ok(entry.requestBytes > MAX_REQUEST_BYTES && entry.requestBytes < MAX_TRANSPORT_BYTES);
      assert.ok(entry.responseBytes < 1024, 'detail errors must stay small and preserve this socket');
    }
    assert.equal(fixture.responses.requests.length, 0, 'bulk editing must not call a model');
    const closed = once(socket, 'close'); socket.send('x'.repeat(MAX_TRANSPORT_BYTES + 1)); assert.equal((await closed)[0], 1009);
    const evidence = path.resolve(__dirname, '../../release/codex-integration-20260908/workspace'); fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, 'gateway-bulk-wire-result.json'), JSON.stringify({ result: 'PASS', traffic, generatedRequests: fixture.responses.requests.length, overTransportCloseCode: 1009 }, null, 2));
  } finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('fixture closed')); }
    socket?.terminate(); await fixture.close();
  }
});
