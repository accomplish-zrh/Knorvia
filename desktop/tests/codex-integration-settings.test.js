'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createEncryptedConnectionStore, initialConnectionFromEnvironment } = require('../connection-config');
const { createNativeRuntime } = require('../native-runtime');
const { probeResponsesEndpoint } = require('../responses-probe');
const { createTurnNotifier, isQuietTime, DEFAULT_PREFERENCES } = require('../turn-notifications');

test('provider protocol persists separately, switches the child environment and rejects unknown formats', async t => {
  assert.equal(initialConnectionFromEnvironment({KNORVIA_PROVIDER_UPSTREAM_PROTOCOL:'chat'}).protocol, 'chat-completions');
  assert.equal(initialConnectionFromEnvironment({KNORVIA_PROVIDER_PROTOCOL:'responses', KNORVIA_PROVIDER_UPSTREAM_PROTOCOL:'chat'}).protocol, 'responses');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-protocol-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = createEncryptedConnectionStore({ filePath: path.join(home, 'profiles.json'), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
  } });
  const environments = [];
  const runtime = await createNativeRuntime({ home, env: {}, mode: 'desktop', connectionStore: store, engineFactory: async options => {
    environments.push(options.env);
    return { rpc: async method => method === 'system/prepareRestart' ? { ready: true, activeTurnCount: 0 } : {}, shutdown: async () => {} };
  } });
  t.after(() => runtime.close());
  const saved = await runtime.providerSave({ name: 'Fixture Claude', model: 'fixture', baseUrl: 'http://127.0.0.1:4990/v1', protocol: 'anthropic-messages', apiKey: 'fixture-only' });
  const provider = saved.providers.find(value => value.id === saved.savedProviderId);
  await runtime.providerActivate({ id: provider.id, revision: provider.revision });
  assert.equal(environments.at(-1).KNORVIA_PROVIDER_PROTOCOL, 'anthropic-messages');
  assert.equal(environments.at(-1).KNORVIA_PROVIDER_PROFILE_ID, provider.id);
  assert.equal(store.load().protocol, 'anthropic-messages');
  const identical = await runtime.providerSave({ name: 'Separate account', model: 'fixture', baseUrl: 'http://127.0.0.1:4990/v1', protocol: 'anthropic-messages', apiKey: 'fixture-only' });
  const second = identical.providers.find(value => value.id === identical.savedProviderId);
  await runtime.providerActivate({ id: second.id, revision: second.revision });
  assert.equal(environments.at(-1).KNORVIA_PROVIDER_PROFILE_ID, second.id);
  assert.doesNotMatch(JSON.stringify(runtime.connectionRead()), /fixture-only/);
  await assert.rejects(runtime.connectionUpdate({ protocol: 'guess' }), /Unsupported/);
});

test('Chat and Claude probes use matching endpoints, request bodies and authentication without redirects', async t => {
  const calls = [];
  const server = http.createServer((req, res) => { let body = ''; req.on('data', part => body += part); req.on('end', () => {
    calls.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(req.url.includes('redirect') ? 307 : 200, { 'content-type': 'application/json', location: 'http://127.0.0.1:1' });
    res.end(req.url.includes('invalid') ? '{}' : JSON.stringify(req.url.endsWith('/messages') ? { id: 'msg_local', type: 'message', content: [{type:'text',text:'OK'}] } : { id: 'chat_local', choices: [{ message: {role:'assistant',content:'OK'} }] }));
  }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  assert.equal((await probeResponsesEndpoint({ baseUrl, model: 'local', apiKey: 'secret-fixture', protocol: 'chat-completions' })).ok, true);
  assert.equal((await probeResponsesEndpoint({ baseUrl, model: 'local', apiKey: 'secret-fixture', protocol: 'anthropic-messages' })).ok, true);
  assert.equal(calls[0].path, '/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer secret-fixture');
  assert.equal(calls[1].path, '/v1/messages');
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[1].headers['x-api-key'], 'secret-fixture');
  assert.equal(calls[1].body.max_tokens, 8);
  assert.equal((await probeResponsesEndpoint({ baseUrl: baseUrl + '/redirect', model: 'local', apiKey: 'secret-fixture' })).ok, false);
  assert.equal(calls.length, 3);
  assert.equal((await probeResponsesEndpoint({ baseUrl: baseUrl + '/invalid', model: 'local', apiKey: 'secret-fixture', protocol: 'chat-completions' })).providerVerified, false);
});

test('notifications persist preferences and suppress replays across process reconstruction', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-notice-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const delivered = []; let clicked;
  class Banner { static isSupported() { return true; } constructor(options) { this.options = options; } on(_, handler) { this.click = handler; } show() { delivered.push(this); } }
  const notification = id => ({ method: 'turn/event', params: { threadId: 'thread_fixture', turnId: id, status: 'completed' } });
  const options = { home, Notification: Banner, deliverability: () => true, onClick: id => clicked = id };
  const first = createTurnNotifier(options);
  first.handlers['notifications/update']({ sound: false, locale: 'en' });
  assert.equal(first.handle(notification('turn_one')), true);
  delivered[0].click(); assert.equal(clicked, 'thread_fixture');
  assert.equal(delivered[0].options.silent, true);
  const second = createTurnNotifier(options);
  assert.equal(second.handle(notification('turn_one')), false);
  assert.equal(second.getPreferences().locale, 'en');
  second.handlers['notifications/update']({ enabled: false });
  second.handle(notification('turn_muted'));
  second.handlers['notifications/update']({ enabled: true });
  assert.equal(second.handle(notification('turn_muted')), false);
  assert.throws(() => second.handlers['notifications/update']({ quietStart: '25:00' }), /Invalid/);
  assert.equal(isQuietTime({ ...DEFAULT_PREFERENCES, quietHours: true }, new Date(2026, 8, 8, 1)), true);
  assert.equal(isQuietTime({ ...DEFAULT_PREFERENCES, quietHours: true }, new Date(2026, 8, 8, 12)), false);
  assert.equal(delivered.length, 1);
  const attention = { method:'approval/request', params:{threadId:'thread_fixture',turnId:'turn_waiting',approvalId:'approval_fixture'} };
  assert.equal(second.handle(attention), true);
  assert.equal(second.handle(attention), false);
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].options.title, 'Your task needs attention');
});
