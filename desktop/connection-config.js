'use strict';

// Connection settings are deliberately kept outside the daemon's durable
// product store. The daemon receives a short-lived child-process environment;
// an API key is never sent back through JSON-RPC or written in plaintext.

const fs = require('fs');
const path = require('path');

const CONNECTION_CONFIG_VERSION = 2;
const MAX_MODEL_LENGTH = 256;
const MAX_BASE_URL_LENGTH = 2048;
const MAX_API_KEY_LENGTH = 16 * 1024;
const PROVIDER_PROTOCOLS = ['responses', 'chat-completions', 'anthropic-messages'];

function normalizeProtocol(value) {
  if (value === undefined || value === null) return 'responses';
  value = ({ chat: 'chat-completions', 'chat_completions': 'chat-completions', anthropic: 'anthropic-messages', claude: 'anthropic-messages' })[value] || value;
  if (!PROVIDER_PROTOCOLS.includes(value)) throw connectionError(-32602, 'Unsupported model protocol');
  return value;
}

function connectionError(code, message, data) {
  const error = new Error(message);
  error.rpc = { code, message };
  if (data !== undefined) error.rpc.data = data;
  return error;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function optionalText(value, field, maxLength) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw connectionError(-32602, `${field} must be a string`);
  }
  if (value.includes('\0')) {
    throw connectionError(-32602, `${field} must not contain a null byte`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw connectionError(-32602, `${field} is too long`);
  }
  return trimmed;
}

function normalizeModel(value) {
  const model = optionalText(value, 'model', MAX_MODEL_LENGTH);
  if (model !== undefined && !model) {
    throw connectionError(-32602, 'model must not be empty');
  }
  return model;
}

function normalizeBaseUrl(value) {
  const baseUrl = optionalText(value, 'baseUrl', MAX_BASE_URL_LENGTH);
  if (baseUrl === undefined || baseUrl === '') return baseUrl;
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw connectionError(-32602, 'baseUrl must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw connectionError(-32602, 'baseUrl must be a credential-free HTTP(S) URL');
  }
  // The Kernel accepts a Responses API base such as http://127.0.0.1:4318/v1.
  // Preserve its path while normalizing a harmless trailing slash.
  return parsed.toString().replace(/\/$/, '');
}

function normalizeApiKey(value) {
  if (typeof value !== 'string') {
    throw connectionError(-32602, 'apiKey must be a string');
  }
  if (value.includes('\0') || value.length > MAX_API_KEY_LENGTH) {
    throw connectionError(-32602, 'apiKey is invalid');
  }
  // Keys may intentionally contain whitespace for compatible local gateways;
  // only an explicit empty string clears one.
  return value;
}

function encryptionAvailable(safeStorage) {
  try {
    return Boolean(safeStorage
      && typeof safeStorage.isEncryptionAvailable === 'function'
      && safeStorage.isEncryptionAvailable());
  } catch {
    return false;
  }
}

function readJsonConfig(filePath, fsImpl = fs) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || ![1, CONNECTION_CONFIG_VERSION].includes(parsed.version)) throw new Error('invalid configuration');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // Fail closed: never overwrite an unreadable credential collection.
    throw connectionError(-32024, 'The saved model connections could not be read');
  }
}

function safeStoredText(value, normalizer) {
  try { return normalizer(value); } catch { return undefined; }
}

/**
 * Persist non-secret settings alongside an Electron safeStorage-encrypted key.
 * The store intentionally has no API that returns serialized secret material
 * to a caller; `load` returns a key only for immediate child-process setup.
 */
function createEncryptedConnectionStore({ filePath, safeStorage, fsImpl = fs }) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('connection configuration file path required');
  }

  function snapshot() {
    try {
      if (!fsImpl.existsSync(filePath)) return { exists: false };
      return { exists: true, body: fsImpl.readFileSync(filePath) };
    } catch {
      throw connectionError(-32024, 'The saved model connections could not be backed up');
    }
  }

  function writeBody(body) {
    const directory = path.dirname(filePath);
    fsImpl.mkdirSync(directory, { recursive: true });
    const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fsImpl.writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 });
      fsImpl.renameSync(temp, filePath);
    } finally {
      try {
        if (fsImpl.existsSync(temp)) fsImpl.unlinkSync(temp);
      } catch {}
    }
  }

  function restore(saved) {
    if (!saved?.exists) {
      try { if (fsImpl.existsSync(filePath)) fsImpl.unlinkSync(filePath); } catch {}
      return;
    }
    writeBody(saved.body);
  }

  function decode(record) {
    const protocol = normalizeProtocol(record.protocol);
    const model = safeStoredText(record.model, normalizeModel);
    const baseUrl = safeStoredText(record.baseUrl, normalizeBaseUrl);
    const hasApiKeySetting = record.hasApiKeySetting === true
      || typeof record.apiKeyEncrypted === 'string';
    let apiKey;
    let decryptionFailed = false;
    if (typeof record.apiKeyEncrypted === 'string' && record.apiKeyEncrypted) {
      if (!encryptionAvailable(safeStorage)) {
        decryptionFailed = true;
      } else {
        try {
          apiKey = safeStorage.decryptString(Buffer.from(record.apiKeyEncrypted, 'base64'));
          if (typeof apiKey !== 'string' || !apiKey) {
            apiKey = undefined;
            decryptionFailed = true;
          }
        } catch {
          apiKey = undefined;
          decryptionFailed = true;
        }
      }
    }
    return {
      hasRecord: true,
      model,
      baseUrl,
      protocol,
      apiKey,
      hasApiKeySetting,
      decryptionFailed,
      // Opaque host-only recovery material. Never include this in RPC metadata.
      ...(decryptionFailed ? { apiKeyEncrypted: record.apiKeyEncrypted } : {}),
    };
  }

  function loadCatalog() {
    const record = readJsonConfig(filePath, fsImpl);
    if (!record || record.version === 1) return null;
    if (!Array.isArray(record.providers) || !record.providers.length || record.providers.length > 100
      || record.providers.some(p => !p || typeof p.id !== 'string' || typeof p.name !== 'string'
        || !Number.isSafeInteger(p.revision) || p.revision < 1)
      || new Set(record.providers.map(p => p.id)).size !== record.providers.length
      || !record.providers.some(p => p.id === record.activeProviderId)) {
      throw connectionError(-32024, 'The saved provider collection is invalid');
    }
    return { activeProviderId: record.activeProviderId, providers: record.providers.map(p => ({
      ...decode(p), id: p.id, name: p.name, revision: p.revision,
    })) };
  }

  function load() {
    const record = readJsonConfig(filePath, fsImpl);
    if (!record) return { hasRecord: false };
    if (record.version === 1) return decode(record);
    const catalog = loadCatalog();
    return { ...catalog.providers.find(p => p.id === catalog.activeProviderId), version: 2 };
  }

  function encode({ model, baseUrl, protocol, apiKey, hasApiKeySetting, decryptionFailed, apiKeyEncrypted: preservedCipher }) {
    if (!encryptionAvailable(safeStorage)) {
      throw connectionError(-32024, 'Secure credential storage is unavailable on this desktop');
    }
    let apiKeyEncrypted = null;
    if (decryptionFailed && typeof preservedCipher === 'string' && preservedCipher) {
      apiKeyEncrypted = preservedCipher;
    } else if (hasApiKeySetting && typeof apiKey === 'string' && apiKey) {
      try {
        apiKeyEncrypted = safeStorage.encryptString(apiKey).toString('base64');
      } catch {
        throw connectionError(-32024, 'The desktop could not encrypt this API key');
      }
    }
    return {
      model: model || null,
      baseUrl: baseUrl || null,
      protocol: normalizeProtocol(protocol),
      // `true` + a null encrypted value represents an intentional clear. It
      // prevents a process-level provider key from silently returning later.
      hasApiKeySetting: Boolean(hasApiKeySetting),
      apiKeyEncrypted,
    };
  }

  function saveCatalog({ activeProviderId, providers }) {
    // Read first even when replacing everything, so an unreadable file stays intact.
    readJsonConfig(filePath, fsImpl);
    if (!Array.isArray(providers) || !providers.length || providers.length > 100
      || new Set(providers.map(p => p.id)).size !== providers.length
      || !providers.some(p => p.id === activeProviderId)) throw connectionError(-32602, 'Invalid provider collection');
    writeBody(JSON.stringify({ version: CONNECTION_CONFIG_VERSION, activeProviderId,
      providers: providers.map(p => ({ id: p.id, name: p.name, revision: p.revision, ...encode(p) })),
    }));
  }

  function save(value) {
    const catalog = loadCatalog();
    const activeProviderId = catalog?.activeProviderId || 'default';
    const previous = catalog?.providers.find(p => p.id === activeProviderId);
    const updated = { id: activeProviderId, name: previous?.name || 'Default provider',
      revision: (previous?.revision || 0) + 1, ...value };
    saveCatalog({ activeProviderId, providers: catalog
      ? catalog.providers.map(p => p.id === activeProviderId ? updated : p) : [updated] });
  }

  return {
    get available() { return encryptionAvailable(safeStorage); },
    load,
    loadCatalog,
    restore,
    save,
    saveCatalog,
    snapshot,
  };
}

function initialConnectionFromEnvironment(env = process.env) {
  return {
    protocol: normalizeProtocol(env.KNORVIA_PROVIDER_PROTOCOL || env.KNORVIA_PROVIDER_UPSTREAM_PROTOCOL || undefined),
    model: typeof env.KNORVIA_PROVIDER_MODEL === 'string' && env.KNORVIA_PROVIDER_MODEL.trim()
      ? env.KNORVIA_PROVIDER_MODEL.trim() : undefined,
    baseUrl: typeof env.KNORVIA_PROVIDER_BASE_URL === 'string' && env.KNORVIA_PROVIDER_BASE_URL.trim()
      ? env.KNORVIA_PROVIDER_BASE_URL.trim() : undefined,
    apiKey: typeof env.KNORVIA_PROVIDER_API_KEY === 'string' && env.KNORVIA_PROVIDER_API_KEY
      ? env.KNORVIA_PROVIDER_API_KEY : undefined,
  };
}

module.exports = {
  CONNECTION_CONFIG_VERSION,
  MAX_API_KEY_LENGTH,
  createEncryptedConnectionStore,
  connectionError,
  encryptionAvailable,
  hasOwn,
  initialConnectionFromEnvironment,
  normalizeApiKey,
  normalizeBaseUrl,
  normalizeModel,
  normalizeProtocol,
  PROVIDER_PROTOCOLS,
};
