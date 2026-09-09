'use strict';

// Owns a replaceable daemon/App Server pair for the native workbench. A
// provider change cannot be applied to a running Kernel because its provider
// environment is captured at process launch, so this controller serializes a
// safe stop/start without replaying any product mutation.

const { createKernelEngine } = require('./kernel-engine');
const { randomUUID } = require('node:crypto');
const { probeResponsesEndpoint } = require('./responses-probe');
const {
  connectionError,
  hasOwn,
  initialConnectionFromEnvironment,
  normalizeApiKey,
  normalizeBaseUrl,
  normalizeModel,
  normalizeProtocol,
} = require('./connection-config');

const READ_ONLY_DAEMON_METHODS = new Set([
  'system/health',
  'system/version',
  'workspace/read',
  'workspace/list',
  'workspace/path/resolve',
  'workspace/files/list',
  'workspace/files/read',
  'workspace/git/status',
  'workspace/git/diff',
  'thread/read',
  'thread/list',
  'turn/read',
  'model/list',
  'skills/list',
  'capability/list',
  'artifact/read',
  'artifact/list',
  'artifact/content',
  'automation/list',
]);

function isMutation(method) {
  return !READ_ONLY_DAEMON_METHODS.has(method);
}

function safeEnvConnection(env) {
  const raw = initialConnectionFromEnvironment(env);
  let model;
  let baseUrl;
  try { model = raw.model && normalizeModel(raw.model); } catch {}
  try { baseUrl = raw.baseUrl && normalizeBaseUrl(raw.baseUrl); } catch {}
  return { model, baseUrl, apiKey: raw.apiKey, protocol: raw.protocol };
}

function applyProviderEnvironment(baseEnv, connection) {
  const env = { ...baseEnv };
  // Delete before setting so an explicit in-app clear wins over a process
  // environment inherited by Electron or the browser gateway.
  delete env.KNORVIA_PROVIDER_MODEL;
  delete env.KNORVIA_PROVIDER_BASE_URL;
  delete env.KNORVIA_PROVIDER_API_KEY;
  env.KNORVIA_PROVIDER_PROTOCOL = normalizeProtocol(connection.protocol);
  env.KNORVIA_PROVIDER_PROFILE_ID = connection.id || 'default';
  if (connection.model) env.KNORVIA_PROVIDER_MODEL = connection.model;
  if (connection.baseUrl) env.KNORVIA_PROVIDER_BASE_URL = connection.baseUrl;
  if (connection.apiKey) env.KNORVIA_PROVIDER_API_KEY = connection.apiKey;
  return env;
}

function selectKnownParams(params, allowed, method) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw connectionError(-32602, `${method} params must be an object`);
  }
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) throw connectionError(-32602, `${method} does not accept ${key}`);
  }
  return params;
}

function connectionMetadata(connection, { mode, phase, capabilities }) {
  const keyConfigured = Boolean(connection.apiKey);
  let credentialStorage = 'none';
  if (connection.decryptionFailed) credentialStorage = 'unavailable';
  else if (connection.apiKeySource === 'safeStorage') credentialStorage = 'safeStorage';
  else if (connection.apiKeySource === 'session') credentialStorage = 'session';
  else if (connection.apiKeySource === 'env') credentialStorage = 'env';
  return {
    configured: Boolean(connection.model && connection.baseUrl && keyConfigured),
    model: connection.model || null,
    baseUrl: connection.baseUrl || null,
    protocol: normalizeProtocol(connection.protocol),
    apiKeyConfigured: keyConfigured,
    credentialStorage,
    persistent: connection.modelSource === 'safeStorage'
      || connection.baseUrlSource === 'safeStorage'
      || connection.apiKeySource === 'safeStorage',
    source: {
      model: connection.modelSource,
      baseUrl: connection.baseUrlSource,
      apiKey: connection.apiKeySource,
    },
    transport: mode,
    engineState: phase,
    restartRequired: false,
    capabilities: {
      selectFolder: Boolean(capabilities?.selectFolder),
      openPath: Boolean(capabilities?.openPath),
      revealPath: Boolean(capabilities?.revealPath),
    },
  };
}

function makeInitialConnection({ env, store, mode }) {
  const inherited = safeEnvConnection(env);
  const connection = {
    model: inherited.model,
    protocol: inherited.protocol,
    baseUrl: inherited.baseUrl,
    apiKey: inherited.apiKey,
    modelSource: inherited.model ? 'env' : 'none',
    baseUrlSource: inherited.baseUrl ? 'env' : 'none',
    apiKeySource: inherited.apiKey ? 'env' : 'none',
    hasApiKeySetting: false,
    decryptionFailed: false,
    storedRecordCorrupt: false,
  };
  if (mode !== 'desktop' || !store) return connection;
  const saved = store.load();
  if (!saved?.hasRecord) return connection;
  connection.protocol = normalizeProtocol(saved.protocol);
  if (saved.model) {
    connection.model = saved.model;
    connection.modelSource = 'safeStorage';
  }
  if (saved.baseUrl) {
    connection.baseUrl = saved.baseUrl;
    connection.baseUrlSource = 'safeStorage';
  }
  if (saved.hasApiKeySetting) {
    connection.hasApiKeySetting = true;
    if (saved.apiKey) {
      connection.apiKey = saved.apiKey;
      connection.apiKeySource = 'safeStorage';
    } else {
      // An explicit clear or a key that cannot be decrypted must not silently
      // fall back to an inherited process secret.
      connection.apiKey = undefined;
      connection.apiKeySource = saved.decryptionFailed ? 'none' : 'safeStorage';
      connection.decryptionFailed = Boolean(saved.decryptionFailed);
      if (saved.decryptionFailed) connection.apiKeyEncrypted = saved.apiKeyEncrypted;
    }
  }
  return connection;
}

function nextConnection(current, params, { mode, storeAvailable }) {
  selectKnownParams(params, new Set(['model', 'baseUrl', 'protocol', 'apiKey', 'clearKey']), 'connection/update');
  const next = { ...current };
  if (hasOwn(params, 'protocol')) next.protocol = normalizeProtocol(params.protocol);
  if (hasOwn(params, 'model')) {
    const model = normalizeModel(params.model);
    if (!model) throw connectionError(-32602, 'model must not be empty');
    next.model = model;
    next.modelSource = mode === 'browser' ? 'session' : (storeAvailable ? 'safeStorage' : 'session');
  }
  if (hasOwn(params, 'baseUrl')) {
    const baseUrl = normalizeBaseUrl(params.baseUrl);
    next.baseUrl = baseUrl || undefined;
    next.baseUrlSource = next.baseUrl
      ? (mode === 'browser' ? 'session' : (storeAvailable ? 'safeStorage' : 'session'))
      : 'none';
  }
  if (hasOwn(params, 'clearKey') && typeof params.clearKey !== 'boolean') {
    throw connectionError(-32602, 'clearKey must be a boolean');
  }
  const hasApiKey = hasOwn(params, 'apiKey');
  const clearKey = params.clearKey === true || (hasApiKey && params.apiKey === '');
  if (clearKey && hasApiKey && params.apiKey !== '') {
    throw connectionError(-32602, 'clearKey cannot be combined with a non-empty apiKey');
  }
  if (hasApiKey && !clearKey) {
    const apiKey = normalizeApiKey(params.apiKey);
    if (!apiKey) throw connectionError(-32602, 'apiKey must not be empty unless it is being cleared');
    next.apiKey = apiKey;
    next.apiKeySource = mode === 'browser' ? 'session' : (storeAvailable ? 'safeStorage' : 'session');
    next.hasApiKeySetting = mode === 'desktop' && storeAvailable;
  } else if (clearKey) {
    next.apiKey = undefined;
    next.apiKeySource = mode === 'browser' ? 'session' : (storeAvailable ? 'safeStorage' : 'session');
    next.hasApiKeySetting = mode === 'desktop' && storeAvailable;
  }
  if (hasApiKey || clearKey) { next.decryptionFailed = false; delete next.apiKeyEncrypted; }
  return next;
}

function connectionChanged(before, after) {
  return before.id !== after.id
    || before.model !== after.model
    || normalizeProtocol(before.protocol) !== normalizeProtocol(after.protocol)
    || before.baseUrl !== after.baseUrl
    || before.apiKey !== after.apiKey;
}

async function waitForPendingTurnStarts(pending) {
  // Requests which crossed the gate before update began must settle before
  // inspecting durable snapshots. This prevents a just-admitted turn from
  // being lost between the idle check and daemon shutdown.
  while (pending.size) await Promise.allSettled([...pending]);
}

async function stopEngine(engine, timeoutMs) {
  if (!engine) return;
  if (typeof engine.shutdown === 'function') {
    await engine.shutdown({ timeoutMs });
    return;
  }
  // Unit-test engine seams may not have a process. Production Kernel engines
  // implement shutdown and wait for their daemon process to release Home.
  try { engine.kill?.(); } catch {}
}

async function prepareEngineRestart(engine) {
  if (!engine || typeof engine.rpc !== 'function') {
    throw connectionError(-32020, 'Knorvia engine is restarting');
  }
  // This runs on the ControlPlane owner. Unlike a renderer-side count of
  // durable turns, it freezes admissions and checks active turns atomically,
  // including work claimed by the automation scheduler.
  let result;
  try {
    result = await engine.rpc('system/prepareRestart', {});
  } catch (error) {
    // `system/prepareRestart` is internal and currently uses the Kernel's
    // general Conflict category. Keep the workbench's established connection
    // update conflict stable even if that category has a different generic
    // JSON-RPC number. Do not expose the daemon's raw text: it can contain
    // implementation detail and is not needed to explain the user action.
    const rpc = error?.rpc;
    const category = rpc?.data?.category;
    if (rpc?.code === -32005 || category === 'CONFLICT') {
      const match = /(?:^|\s)(\d+)\s+task\(s\)\s+are\s+still\s+running\b/i
        .exec(String(rpc?.message || error?.message || ''));
      const activeTurnCount = match ? Number(match[1]) : undefined;
      throw connectionError(-32022, 'Cannot change the model connection while tasks are active', {
        ...(Number.isSafeInteger(activeTurnCount) ? { activeTurnCount } : {}),
      });
    }
    throw error;
  }
  if (result?.ready === true && result.activeTurnCount === 0) return result;
  if (Number.isSafeInteger(result?.activeTurnCount) && result.activeTurnCount > 0) {
    throw connectionError(-32022, 'Cannot change the model connection while tasks are active', {
      activeTurnCount: result.activeTurnCount,
    });
  }
  throw connectionError(-32021, 'Cannot prepare the Kernel for a safe model connection restart');
}

async function cancelPreparedRestart(engine) {
  if (!engine || typeof engine.rpc !== 'function') return;
  // This is deliberately a direct engine request. The public runtime gate is
  // closed while replacement is in progress, but the daemon must be allowed
  // to resume admissions if stopping the old engine did not happen.
  try { await engine.rpc('system/cancelRestart', {}); } catch {}
}

/**
 * Start and safely replace one private Knorvia engine.
 *
 * `mode: 'browser'` intentionally does not receive an encrypted store: its
 * configuration remains process/session memory and `connection/read` says so.
 */
async function createNativeRuntime({
  home,
  env = process.env,
  runtimeRoot,
  packaged = false,
  version = '0.1.0-dev',
  legacyChatBridge = false,
  mode = 'desktop',
  connectionStore,
  engineFactory = createKernelEngine,
  capabilities,
  shutdownTimeoutMs = 8_000,
} = {}) {
  if (!home || typeof home !== 'string') throw new Error('native runtime home required');
  if (!['desktop', 'browser'].includes(mode)) throw new Error('native runtime mode must be desktop or browser');
  const baseEnv = { ...env };
  const effectiveCapabilities = capabilities || (mode === 'desktop'
    ? { selectFolder: true, openPath: true, revealPath: true }
    : { selectFolder: false, openPath: false, revealPath: false });
  let connection = makeInitialConnection({ env: baseEnv, store: connectionStore, mode });
  const storedCatalog = mode === 'desktop' ? connectionStore?.loadCatalog?.() : null;
  let activeProviderId = storedCatalog?.activeProviderId || 'default';
  let providers = storedCatalog ? storedCatalog.providers.map(p => ({ ...p,
    modelSource: p.model ? 'safeStorage' : 'none', baseUrlSource: p.baseUrl ? 'safeStorage' : 'none',
    apiKeySource: p.decryptionFailed ? 'none' : 'safeStorage', hasApiKeySetting: true,
  })) : [{ ...connection, id: 'default', name: 'Default provider', revision: 1 }];
  connection = providers.find(p => p.id === activeProviderId);
  let engine;
  let phase = 'starting';
  let stopping = false;
  let restartRequested = false;
  let restartPromise = null;
  let removeEngineNotification = null;
  const pendingTurnStarts = new Set();
  const notificationListeners = new Set();
  const engineListeners = new Set();

  function metadata() {
    return { ...connectionMetadata(connection, { mode, phase, capabilities: effectiveCapabilities }),
      activeProviderId, secureStorageAvailable: mode === 'desktop' && Boolean(connectionStore?.available),
      providers: providers.map(p => {
        const safe = connectionMetadata(p, { mode, phase, capabilities: effectiveCapabilities });
        return { id: p.id, name: p.name, revision: p.revision, model: safe.model, baseUrl: safe.baseUrl, protocol: safe.protocol,
          configured: safe.configured, apiKeyConfigured: safe.apiKeyConfigured,
          credentialStorage: safe.credentialStorage, persistent: safe.persistent };
      }),
    };
  }

  function emitConnectionState() {
    const notification = { jsonrpc: '2.0', method: 'connection/state', params: metadata() };
    for (const listener of notificationListeners) {
      try { listener(notification); } catch {}
    }
  }

  function emitEngineChange(next) {
    for (const listener of engineListeners) {
      try { listener(next); } catch {}
    }
  }

  function emitDaemonNotification(notification) {
    for (const listener of notificationListeners) {
      try { listener(notification); } catch {}
    }
  }

  function bindEngine(next) {
    try { removeEngineNotification?.(); } catch {}
    removeEngineNotification = typeof next?.onNotification === 'function'
      ? next.onNotification(emitDaemonNotification) : null;
    engine = next;
    emitEngineChange(next);
  }

  async function startEngine(candidate) {
    return engineFactory({
      home,
      env: applyProviderEnvironment(baseEnv, candidate),
      runtimeRoot,
      packaged,
      version,
      legacyChatBridge,
    });
  }

  async function rpc(method, params = {}) {
    const currentEngine = engine;
    if (!currentEngine) {
      throw connectionError(-32020, 'Knorvia engine is restarting');
    }
    if (restartRequested && method !== 'connection/read') {
      throw connectionError(-32020, 'Knorvia engine is restarting; wait for the connection state to refresh');
    }
    if (method !== 'turn/start') return currentEngine.rpc(method, params);
    const sent = Promise.resolve(currentEngine.rpc(method, params));
    pendingTurnStarts.add(sent);
    try {
      return await sent;
    } finally {
      pendingTurnStarts.delete(sent);
    }
  }

  function prepareCatalog(nextProviders) {
    if (mode !== 'desktop') return nextProviders;
    if (!connectionStore?.available) throw connectionError(-32024, 'Secure storage is unavailable; no providers were changed');
    return nextProviders.map(p => ({ ...p, hasApiKeySetting: true,
      modelSource: p.model ? 'safeStorage' : 'none', baseUrlSource: p.baseUrl ? 'safeStorage' : 'none',
      apiKeySource: p.decryptionFailed ? 'none' : 'safeStorage',
    }));
  }

  function persistCatalog(nextProviders, nextId) {
    if (mode !== 'desktop') return false;
    try { connectionStore.saveCatalog({ providers: nextProviders, activeProviderId: nextId }); }
    catch (error) { throw error?.rpc ? error : connectionError(-32024, 'The providers could not be saved securely'); }
    return true;
  }

  function commitCatalog(nextProviders, nextId) {
    providers = nextProviders; activeProviderId = nextId;
    connection = providers.find(p => p.id === nextId);
  }

  async function replaceEngine(candidate, nextProviders, nextId) {
    restartRequested = true;
    phase = 'checking';
    emitConnectionState();
    let saved = null;
    let persisted = false;
    let persistenceAttempted = false;
    let restartPrepared = false;
    let oldEngineStopped = false;
    const oldConnection = connection;
    const oldEngine = engine;
    try {
      await waitForPendingTurnStarts(pendingTurnStarts);
      saved = mode === 'desktop' && connectionStore?.available
        ? connectionStore.snapshot() : null;
      await prepareEngineRestart(oldEngine);
      restartPrepared = true;
      try {
        persistenceAttempted = Boolean(saved);
        persisted = persistCatalog(nextProviders, nextId);
      } catch (error) {
        throw error?.rpc ? error : connectionError(-32024, 'The desktop could not save this connection securely');
      }

      phase = 'restarting';
      emitConnectionState();
      // `shutdown` waits for daemon exit; the next daemon's Home lock
      // acquisition is then the final proof that the old owner is gone.
      await stopEngine(oldEngine, shutdownTimeoutMs);
      oldEngineStopped = true;
      try { removeEngineNotification?.(); } catch {}
      removeEngineNotification = null;
      engine = undefined;
      emitEngineChange(undefined);

      try {
        const next = await startEngine(candidate);
        commitCatalog(nextProviders, nextId);
        bindEngine(next);
      } catch (error) {
        try { if (saved) connectionStore.restore(saved); } catch {}
        let recovered = false;
        try {
          const restored = await startEngine(oldConnection);
          connection = oldConnection;
          bindEngine(restored);
          recovered = true;
        } catch {}
        throw connectionError(
          -32023,
          recovered
            ? 'The new model connection could not start; the previous connection was restored'
            : 'The new model connection could not start and the previous engine could not be restored',
          { recovered },
        );
      }
      phase = 'ready';
      emitConnectionState();
      return metadata();
    } catch (error) {
      // `prepareRestart` freezes daemon admissions. If the old daemon remains
      // available, undo that freeze before surfacing the failed update. Once
      // shutdown completed, it is intentionally not cancelled: a replacement
      // (or recovery daemon) owns the next admission state.
      if (restartPrepared && !oldEngineStopped) {
        await cancelPreparedRestart(oldEngine);
      }
      // A failed shutdown must not leave a new encrypted setting persisted
      // against an old engine. Roll back only opaque ciphertext/metadata; no
      // credential is returned or logged during this recovery.
      if ((persisted || persistenceAttempted) && saved) {
        try { connectionStore.restore(saved); } catch {}
      }
      if (!engine && !oldEngine) phase = 'unavailable';
      throw error;
    } finally {
      restartRequested = false;
      if (phase !== 'ready' && engine) {
        phase = 'ready';
        emitConnectionState();
      } else if (!engine && phase !== 'ready') {
        phase = 'unavailable';
        emitConnectionState();
      }
    }
  }

  async function connectionUpdate(params = {}) {
    if (stopping || restartPromise || restartRequested) {
      throw connectionError(-32020, 'A connection update is already in progress');
    }
    const candidate = nextConnection(connection, params, {
      mode,
      storeAvailable: Boolean(connectionStore?.available),
    });
    return saveCollection(providers.map(p => p.id === activeProviderId
      ? { ...candidate, revision: p.revision + 1 } : p), activeProviderId);
  }

  async function saveCollection(nextProviders, nextId) {
    const prepared = prepareCatalog(nextProviders);
    const candidate = prepared.find(p => p.id === nextId);
    if (!connectionChanged(connection, candidate)) {
      persistCatalog(prepared, nextId);
      commitCatalog(prepared, nextId);
      emitDaemonNotification({ jsonrpc: '2.0', method: 'connection/providers', params: metadata() });
      return metadata();
    }
    const operation = replaceEngine(candidate, prepared, nextId);
    restartPromise = operation;
    try {
      return await operation;
    } finally {
      if (restartPromise === operation) restartPromise = null;
    }
  }

  function assertProviderMutation() {
    if (stopping || restartPromise || restartRequested) throw connectionError(-32020, 'A connection update is already in progress');
  }

  function findProvider(id, revision) {
    if (typeof id !== 'string') throw connectionError(-32602, 'A provider id is required');
    const found = providers.find(p => p.id === id);
    if (!found) throw connectionError(-32004, 'This provider no longer exists');
    if (revision !== undefined && revision !== found.revision) throw connectionError(-32025, 'This provider changed in another window; reload it before saving');
    return found;
  }

  async function providerSave(params = {}) {
    assertProviderMutation();
    selectKnownParams(params, new Set(['id', 'revision', 'name', 'model', 'baseUrl', 'protocol', 'apiKey', 'clearKey']), 'connection/provider/save');
    if (typeof params.name !== 'string' || !params.name.trim() || params.name.trim().length > 80
      || /[\u0000-\u001f\u007f]/.test(params.name)) throw connectionError(-32602, 'Provider name must be 1–80 characters');
    if (params.id !== undefined && !Number.isSafeInteger(params.revision)) throw connectionError(-32602, 'The provider revision is required');
    const previous = params.id === undefined ? { id: randomUUID(), revision: 0,
      modelSource: 'none', baseUrlSource: 'none', apiKeySource: 'none' } : findProvider(params.id, params.revision);
    if (!previous.revision && providers.length >= 100) throw connectionError(-32602, 'Save up to 100 providers');
    const fields = Object.fromEntries(['model', 'baseUrl', 'protocol', 'apiKey', 'clearKey'].filter(k => hasOwn(params, k)).map(k => [k, params[k]]));
    const candidate = { ...nextConnection(previous, fields, { mode, storeAvailable: Boolean(connectionStore?.available) }),
      name: params.name.trim(), revision: previous.revision + 1 };
    if (!candidate.model || !candidate.baseUrl) throw connectionError(-32602, 'A model and service URL are required');
    const next = previous.revision ? providers.map(p => p.id === previous.id ? candidate : p) : [...providers, candidate];
    const result = await saveCollection(next, activeProviderId);
    return { ...result, savedProviderId: candidate.id };
  }

  async function providerActivate(params = {}) {
    assertProviderMutation();
    selectKnownParams(params, new Set(['id', 'revision']), 'connection/provider/activate');
    const candidate = findProvider(params.id, params.revision);
    if (candidate.id === activeProviderId) return metadata();
    if (!candidate.model || !candidate.baseUrl || !candidate.apiKey || candidate.decryptionFailed) {
      throw connectionError(-32602, 'Complete this provider configuration before using it');
    }
    return saveCollection(providers, candidate.id);
  }

  async function providerDelete(params = {}) {
    assertProviderMutation();
    selectKnownParams(params, new Set(['id', 'revision']), 'connection/provider/delete');
    if (!Number.isSafeInteger(params.revision)) throw connectionError(-32602, 'The provider revision is required');
    const candidate = findProvider(params.id, params.revision);
    if (candidate.id === activeProviderId) throw connectionError(-32025, 'Switch to another provider before deleting the current one');
    return saveCollection(providers.filter(p => p.id !== candidate.id), activeProviderId);
  }

  async function connectionTest(params = {}) {
    selectKnownParams(params, new Set(['probeProvider']), 'connection/test');
    if (params.probeProvider !== undefined && typeof params.probeProvider !== 'boolean') {
      throw connectionError(-32602, 'probeProvider must be a boolean');
    }
    if (restartRequested || restartPromise || !engine) {
      throw connectionError(-32020, 'Knorvia engine is restarting');
    }
    const missing = [];
    if (!connection.model) missing.push('model');
    if (!connection.baseUrl) missing.push('baseUrl');
    if (!connection.apiKey) missing.push('apiKey');
    let catalog;
    try {
      // This crosses the real daemon-to-App-Server boundary. It proves the
      // Kernel route is alive, while the result below deliberately keeps
      // provider verification separate from catalog availability.
      catalog = await engine.rpc('model/list', { limit: 50 });
    } catch {
      return {
        ok: false,
        message: missing.length
          ? 'The model connection is incomplete and the Kernel model catalog could not be reached'
          : 'The Kernel model catalog could not be reached',
        kernelReady: false,
        providerVerified: false,
        checked: missing.length ? 'configuration' : 'kernel-model-catalog',
        ...(missing.length ? { missing } : {}),
      };
    }
    const models = Array.isArray(catalog) ? catalog
      : Array.isArray(catalog?.data) ? catalog.data : [];
    if (missing.length) {
      return {
        ok: false,
        message: 'The model connection is incomplete, but the Kernel model catalog is reachable',
        kernelReady: true,
        providerVerified: false,
        checked: 'configuration',
        missing,
        catalogCount: models.length,
      };
    }
    if (params.probeProvider !== true) {
      return {
        ok: true,
        message: 'Kernel model catalog is reachable. Provider API connectivity has not been verified by this check.',
        kernelReady: true,
        // `model/list` proves that the real daemon/App Server is alive. It does
        // not make a paid model request, so it must not be described as provider
        // connectivity verification.
        providerVerified: false,
        checked: 'kernel-model-catalog',
        model: connection.model,
        catalogCount: models.length,
      };
    }
    const probe = await probeResponsesEndpoint({
      protocol: connection.protocol,
      model: connection.model,
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
    });
    return {
      ok: probe.ok,
      message: probe.message,
      kernelReady: true,
      providerVerified: probe.providerVerified,
      checked: 'provider-probe',
      model: connection.model,
      catalogCount: models.length,
      ...(probe.status ? { status: probe.status } : {}),
    };
  }

  phase = 'starting';
  bindEngine(await startEngine(connection));
  phase = 'ready';

  function onNotification(listener) {
    if (typeof listener !== 'function') throw new Error('native runtime notification listener must be a function');
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  }

  function onEngineChange(listener) {
    if (typeof listener !== 'function') throw new Error('native runtime engine listener must be a function');
    engineListeners.add(listener);
    try { listener(engine); } catch {}
    return () => engineListeners.delete(listener);
  }

  async function close() {
    if (stopping) return;
    stopping = true;
    restartRequested = true;
    phase = 'stopping';
    emitConnectionState();
    const current = engine;
    try { removeEngineNotification?.(); } catch {}
    removeEngineNotification = null;
    engine = undefined;
    emitEngineChange(undefined);
    try { await stopEngine(current, shutdownTimeoutMs); } finally {
      notificationListeners.clear();
      engineListeners.clear();
    }
  }

  return {
    get engine() { return engine; },
    get restarting() { return restartRequested; },
    get connection() { return metadata(); },
    connectionRead: async (params = {}) => {
      selectKnownParams(params, new Set(), 'connection/read');
      return metadata();
    },
    connectionTest,
    connectionUpdate,
    providerSave,
    providerActivate,
    providerDelete,
    close,
    // Existing callers use a synchronous kill on app shutdown. It begins the
    // same graceful asynchronous close without exposing child process handles.
    kill: () => { void close(); },
    onEngineChange,
    onNotification,
    rpc,
  };
}

module.exports = {
  READ_ONLY_DAEMON_METHODS,
  applyProviderEnvironment,
  cancelPreparedRestart,
  connectionMetadata,
  createNativeRuntime,
  isMutation,
  nextConnection,
  prepareEngineRestart,
};
