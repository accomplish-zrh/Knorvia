'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNativeRuntime } = require('../native-runtime');
const { createEncryptedConnectionStore } = require('../connection-config');
const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`fixture:${value}`),
  decryptString: value => {
    const text = value.toString();
    if (!text.startsWith('fixture:')) throw new Error('unreadable fixture cipher');
    return text.slice(8);
  },
};
const env = { KNORVIA_PROVIDER_MODEL: 'model-a', KNORVIA_PROVIDER_BASE_URL: 'http://127.0.0.1:4811/v1', KNORVIA_PROVIDER_API_KEY: 'fixture-key-a' };
const providerB = { name: '备用 B', model: 'model-b', baseUrl: 'http://127.0.0.1:4812/v1', apiKey: 'fixture-key-b' };

async function harness(t, { mode = 'desktop', legacy, secureStorage = cipher, active = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-providers-'));
  const filePath = path.join(root, 'connections.json');
  if (legacy) fs.writeFileSync(filePath, JSON.stringify(legacy));
  const store = createEncryptedConnectionStore({ filePath, safeStorage: secureStorage });
  const state = { starts: [], stops: 0, active, failNext: false, events: [] };
  const runtimes = [];
  const start = async () => {
    const runtime = await createNativeRuntime({ home: root, mode, env, connectionStore: store, engineFactory: async options => {
      state.starts.push(options.env);
      if (state.failNext) { state.failNext = false; throw new Error('fixture start failure'); }
      return {
        rpc: async method => {
          if (method === 'system/prepareRestart') return { ready: !state.active, activeTurnCount: state.active ? 1 : 0 };
          if (method === 'model/list') return { data: [] };
          return {};
        },
        shutdown: async () => { state.stops++; },
      };
    } });
    runtime.onNotification(event => state.events.push(event)); runtimes.push(runtime);
    return runtime;
  };
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    const resolved = fs.realpathSync(root);
    assert.ok(resolved.startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`));
    assert.ok(path.basename(resolved).startsWith('knorvia-providers-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { runtime: await start(), start, store, filePath, state };
}

test('saved providers are separate, survive restart, and never return or write plaintext keys', async t => {
  const { runtime, start, state, filePath } = await harness(t);
  const added = await runtime.providerSave(providerB);
  assert.equal(state.starts.length, 1, 'saving an inactive profile does not restart');
  assert.equal(added.providers.length, 2);
  assert.equal(added.activeProviderId, 'default');
  assert.ok(added.providers.every(p => p.persistent));
  assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /fixture-key-[ab]/);
  await runtime.providerActivate({ id: added.savedProviderId });
  assert.equal(state.starts.at(-1).KNORVIA_PROVIDER_API_KEY, providerB.apiKey);
  assert.equal(state.starts.at(-1).KNORVIA_PROVIDER_BASE_URL, providerB.baseUrl);
  await runtime.close();
  const restarted = await start();
  assert.equal(restarted.connection.activeProviderId, added.savedProviderId);
  assert.equal(restarted.connection.providers.length, 2);
  await restarted.providerActivate({ id: 'default' });
  assert.equal(state.starts.at(-1).KNORVIA_PROVIDER_API_KEY, env.KNORVIA_PROVIDER_API_KEY);
  assert.equal(state.starts.at(-1).KNORVIA_PROVIDER_BASE_URL, env.KNORVIA_PROVIDER_BASE_URL);
  assert.doesNotMatch(JSON.stringify([added, restarted.connection, state.events]), /fixture-key-|apiKeyEncrypted/);
});

test('v1 migration preserves the old key and model while adding another provider', async t => {
  const legacy = { version: 1, model: 'legacy-model', baseUrl: env.KNORVIA_PROVIDER_BASE_URL, hasApiKeySetting: true, apiKeyEncrypted: cipher.encryptString('legacy-only-key').toString('base64') };
  const { runtime, filePath, state } = await harness(t, { legacy });
  assert.equal(state.starts[0].KNORVIA_PROVIDER_API_KEY, 'legacy-only-key');
  const added = await runtime.providerSave(providerB);
  assert.equal(JSON.parse(fs.readFileSync(filePath)).version, 2);
  assert.equal(added.providers.find(p => p.id === 'default').model, 'legacy-model');
  await runtime.providerActivate({ id: added.savedProviderId });
  await runtime.providerActivate({ id: 'default' });
  assert.equal(state.starts.at(-1).KNORVIA_PROVIDER_API_KEY, 'legacy-only-key');
});

test('omitted keys are profile-local; clear never falls back to inherited credentials', async t => {
  const { runtime, state, start } = await harness(t);
  const { apiKey: ignored, ...withoutKey } = providerB;
  const empty = await runtime.providerSave(withoutKey);
  assert.equal(empty.providers.find(p => p.id === empty.savedProviderId).apiKeyConfigured, false);
  await assert.rejects(runtime.providerActivate({ id: empty.savedProviderId }), e => e.rpc.code === -32602);
  assert.equal(state.starts.length, 1);
  const filled = await runtime.providerSave({ ...providerB, id: empty.savedProviderId, revision: 1 });
  const renamed = await runtime.providerSave({ id: filled.savedProviderId, revision: 2, name: 'Renamed' });
  await runtime.providerActivate({ id: renamed.savedProviderId });
  assert.equal(state.starts.at(-1).KNORVIA_PROVIDER_API_KEY, providerB.apiKey);
  await runtime.providerSave({ id: renamed.savedProviderId, revision: 3, name: 'Renamed', clearKey: true });
  assert.equal(state.starts.at(-1).KNORVIA_PROVIDER_API_KEY, undefined);
  await runtime.close();
  const restarted = await start();
  assert.equal(restarted.connection.apiKeyConfigured, false);
  assert.equal(state.starts.at(-1).KNORVIA_PROVIDER_API_KEY, undefined);
});

test('active turns allow saving backups but block activation and active model edits without changing disk', async t => {
  const { runtime, filePath, state } = await harness(t, { active: true });
  const added = await runtime.providerSave(providerB);
  const before = fs.readFileSync(filePath);
  await assert.rejects(runtime.providerActivate({ id: added.savedProviderId }), e => e.rpc.code === -32022);
  await assert.rejects(runtime.providerSave({ id: 'default', revision: 1, name: 'Daily', model: 'changed' }), e => e.rpc.code === -32022);
  assert.deepEqual(fs.readFileSync(filePath), before);
  assert.equal(state.stops, 0);
  assert.equal(runtime.connection.activeProviderId, 'default');
});

test('failed replacement restores the entire encrypted collection and old provider', async t => {
  const { runtime, filePath, state } = await harness(t);
  const added = await runtime.providerSave(providerB);
  const before = fs.readFileSync(filePath);
  state.failNext = true;
  await assert.rejects(runtime.providerActivate({ id: added.savedProviderId }), e => e.rpc.code === -32023 && e.rpc.data.recovered);
  assert.deepEqual(fs.readFileSync(filePath), before);
  assert.equal(runtime.connection.activeProviderId, 'default');
  assert.equal(state.starts.at(-1).KNORVIA_PROVIDER_API_KEY, env.KNORVIA_PROVIDER_API_KEY);
  assert.equal(runtime.connection.engineState, 'ready');
});

test('stale edits and deletes conflict; deleting one provider preserves every other key', async t => {
  const { runtime, store } = await harness(t);
  const added = await runtime.providerSave(providerB);
  await runtime.providerSave({ id: added.savedProviderId, revision: 1, name: 'B updated' });
  await assert.rejects(runtime.providerSave({ id: added.savedProviderId, revision: 1, name: 'stale' }), e => e.rpc.code === -32025);
  await assert.rejects(runtime.providerDelete({ id: added.savedProviderId, revision: 1 }), e => e.rpc.code === -32025);
  await assert.rejects(runtime.providerDelete({ id: 'default', revision: 1 }), e => e.rpc.code === -32025);
  const removed = await runtime.providerDelete({ id: added.savedProviderId, revision: 2 });
  assert.equal(removed.providers.length, 1);
  assert.equal(store.loadCatalog().providers[0].apiKey, env.KNORVIA_PROVIDER_API_KEY);
});

test('an unreadable key remains encrypted through unrelated edits and cannot inherit the environment key', async t => {
  const opaque = Buffer.from('old-device-cipher').toString('base64');
  const legacy = { version: 1, model: 'old-model', baseUrl: env.KNORVIA_PROVIDER_BASE_URL, hasApiKeySetting: true, apiKeyEncrypted: opaque };
  const { runtime, state, filePath } = await harness(t, { legacy });
  assert.equal(state.starts[0].KNORVIA_PROVIDER_API_KEY, undefined);
  await runtime.providerSave(providerB);
  await runtime.providerSave({ id: 'default', revision: 1, name: 'Recovered label' });
  assert.equal(JSON.parse(fs.readFileSync(filePath)).providers.find(p => p.id === 'default').apiKeyEncrypted, opaque);
  assert.equal(runtime.connection.credentialStorage, 'unavailable');
  await runtime.providerSave({ id: 'default', revision: 2, name: 'Recovered label', apiKey: 'repaired-fixture-key' });
  assert.equal(state.starts.at(-1).KNORVIA_PROVIDER_API_KEY, 'repaired-fixture-key');
});

test('browser profiles are session-only and desktop storage failures leave no partial changes', async t => {
  const browser = await harness(t, { mode: 'browser' });
  const added = await browser.runtime.providerSave(providerB);
  assert.equal(added.providers.at(-1).persistent, false);
  assert.equal(fs.existsSync(browser.filePath), false);
  const desktop = await harness(t, { secureStorage: { ...cipher, isEncryptionAvailable: () => false } });
  await assert.rejects(desktop.runtime.providerSave(providerB), e => e.rpc.code === -32024);
  assert.equal(desktop.runtime.connection.providers.length, 1);
  assert.equal(fs.existsSync(desktop.filePath), false);
});

test('a failed atomic write or unreadable file never discards existing encrypted profiles', async t => {
  const { runtime, filePath, store } = await harness(t);
  await runtime.providerSave(providerB);
  const before = fs.readFileSync(filePath);
  const failing = createEncryptedConnectionStore({ filePath, safeStorage: cipher,
    fsImpl: { ...fs, renameSync: () => { throw new Error('fixture disk unavailable'); } },
  });
  assert.throws(() => failing.saveCatalog(store.loadCatalog()));
  assert.deepEqual(fs.readFileSync(filePath), before);
  fs.writeFileSync(filePath, '{corrupt-fixture');
  await assert.rejects(runtime.providerSave({ ...providerB, name: 'Do not overwrite' }), e => e.rpc.code === -32024);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{corrupt-fixture');
  assert.equal(runtime.connection.providers.length, 2);
});
