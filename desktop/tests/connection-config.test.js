'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createEncryptedConnectionStore,
  normalizeBaseUrl,
} = require('../connection-config');

function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`fixture-encrypted:${value}`, 'utf8'),
    decryptString: (value) => {
      const raw = Buffer.from(value).toString('utf8');
      if (!raw.startsWith('fixture-encrypted:')) throw new Error('invalid fixture cipher');
      return raw.slice('fixture-encrypted:'.length);
    },
  };
}

test('encrypted desktop connection store never writes a fixture API key in plaintext', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-connection-store-'));
  const filePath = path.join(root, 'settings', 'model-connection.json');
  const store = createEncryptedConnectionStore({ filePath, safeStorage: fakeSafeStorage() });
  const apiKey = 'local-fixture-secret-only';
  try {
    store.save({
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:4318/v1',
      apiKey,
      hasApiKeySetting: true,
    });
    const onDisk = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(onDisk, new RegExp(apiKey));
    assert.match(onDisk, /apiKeyEncrypted/);
    const loaded = store.load();
    assert.equal(loaded.model, 'fixture-model');
    assert.equal(loaded.baseUrl, 'http://127.0.0.1:4318/v1');
    assert.equal(loaded.apiKey, apiKey);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an explicitly cleared encrypted key remains cleared instead of falling back to process env', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-connection-clear-'));
  const filePath = path.join(root, 'model-connection.json');
  const store = createEncryptedConnectionStore({ filePath, safeStorage: fakeSafeStorage() });
  try {
    store.save({ model: 'fixture-model', baseUrl: 'http://127.0.0.1:4318/v1', apiKey: undefined, hasApiKeySetting: true });
    const loaded = store.load();
    assert.equal(loaded.hasApiKeySetting, true);
    assert.equal(loaded.apiKey, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('encrypted connection writes replace an existing record atomically enough for a later restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-connection-replace-'));
  const filePath = path.join(root, 'model-connection.json');
  const store = createEncryptedConnectionStore({ filePath, safeStorage: fakeSafeStorage() });
  try {
    store.save({ model: 'fixture-one', baseUrl: 'http://127.0.0.1:4318/v1', apiKey: 'fixture-key-one', hasApiKeySetting: true });
    store.save({ model: 'fixture-two', baseUrl: 'http://127.0.0.1:4318/v1', apiKey: 'fixture-key-two', hasApiKeySetting: true });
    const loaded = store.load();
    assert.equal(loaded.model, 'fixture-two');
    assert.equal(loaded.apiKey, 'fixture-key-two');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('desktop refuses to persist an API key when Electron secure storage is unavailable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-connection-unavailable-'));
  const filePath = path.join(root, 'model-connection.json');
  const store = createEncryptedConnectionStore({ filePath, safeStorage: fakeSafeStorage({ available: false }) });
  try {
    assert.throws(() => store.save({
      model: 'fixture-model', baseUrl: 'http://127.0.0.1:4318/v1', apiKey: 'must-not-write', hasApiKeySetting: true,
    }), (error) => error.rpc?.code === -32024);
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('connection URL normalization permits a loopback Responses fixture but rejects embedded credentials', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:4318/v1/'), 'http://127.0.0.1:4318/v1');
  assert.throws(() => normalizeBaseUrl('https://key@example.test/v1'), /credential-free/);
});
