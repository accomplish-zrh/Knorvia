'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createNativeRuntime } = require('../native-runtime');

function fixtureEngine({ active = false, prepareResult, prepareError, shutdownError } = {}) {
  const state = { calls: [], shutdowns: 0, cancelledRestarts: 0, notification: null };
  return {
    state,
    rpc: async (method, params) => {
      state.calls.push({ method, params });
      if (method === 'system/prepareRestart') {
        if (prepareError) throw prepareError;
        if (active) {
          const error = new Error('Cannot change the model connection while tasks are active');
          error.rpc = {
            code: -32022,
            message: 'Cannot change the model connection while tasks are active',
            data: { activeTurnCount: 1 },
          };
          throw error;
        }
        return prepareResult || { ready: true, activeTurnCount: 0 };
      }
      if (method === 'system/cancelRestart') {
        state.cancelledRestarts += 1;
        return { ready: true, admissionsPaused: false };
      }
      if (method === 'workspace/list') return [{ id: 'ws_fixture' }];
      if (method === 'thread/list') return [{ id: 'th_fixture' }];
      if (method === 'thread/read') {
        return active ? { activeTurn: { id: 'tu_fixture', status: 'running' } } : { activeTurn: null };
      }
      if (method === 'model/list') return { data: [{ id: 'fixture-model' }, { id: 'fixture-model-mini' }] };
      if (method === 'turn/start') return { id: 'tu_started' };
      return { method, params };
    },
    onNotification: (listener) => {
      state.notification = listener;
      return () => { state.notification = null; };
    },
    shutdown: async () => {
      state.shutdowns += 1;
      if (shutdownError && state.shutdowns === 1) throw shutdownError;
    },
  };
}

test('browser connection metadata is non-secret, session updates restart the real runtime seam, and test uses the Kernel catalog', async () => {
  const engines = [];
  const startOptions = [];
  const runtime = await createNativeRuntime({
    home: 'C:\\fixture-home',
    mode: 'browser',
    env: {
      KNORVIA_PROVIDER_MODEL: 'fixture-model',
      KNORVIA_PROVIDER_BASE_URL: 'http://127.0.0.1:4318/v1',
      KNORVIA_PROVIDER_API_KEY: 'local-fixture-key',
    },
    engineFactory: async (options) => {
      startOptions.push(options);
      const engine = fixtureEngine();
      engines.push(engine);
      return engine;
    },
  });
  const notifications = [];
  const stop = runtime.onNotification((note) => notifications.push(note));
  try {
    const initial = await runtime.connectionRead();
    assert.equal(initial.configured, true);
    assert.equal(initial.credentialStorage, 'env');
    assert.deepEqual(initial.capabilities, { selectFolder: false, openPath: false, revealPath: false });
    assert.doesNotMatch(JSON.stringify(initial), /local-fixture-key/);

    const tested = await runtime.connectionTest();
    assert.deepEqual(tested, {
      ok: true,
      message: 'Kernel model catalog is reachable. Provider API connectivity has not been verified by this check.',
      kernelReady: true,
      providerVerified: false,
      checked: 'kernel-model-catalog',
      model: 'fixture-model',
      catalogCount: 2,
    });
    assert.ok(engines[0].state.calls.some((call) => call.method === 'model/list'));

    const updated = await runtime.connectionUpdate({ model: 'fixture-model-v2', apiKey: 'session-fixture-key' });
    assert.equal(updated.model, 'fixture-model-v2');
    assert.equal(updated.credentialStorage, 'session');
    assert.equal(engines.length, 2);
    assert.equal(engines[0].state.shutdowns, 1);
    assert.equal(startOptions[1].env.KNORVIA_PROVIDER_MODEL, 'fixture-model-v2');
    assert.equal(startOptions[1].env.KNORVIA_PROVIDER_API_KEY, 'session-fixture-key');
    assert.ok(notifications.some((note) => note.method === 'connection/state' && note.params.engineState === 'restarting'));
    assert.ok(notifications.some((note) => note.method === 'connection/state' && note.params.engineState === 'ready'));
  } finally {
    stop();
    await runtime.close();
  }
});

test('an incomplete connection still reports real Kernel catalog readiness without claiming provider verification', async () => {
  const engine = fixtureEngine();
  const runtime = await createNativeRuntime({
    home: 'C:\\fixture-home',
    mode: 'browser',
    env: {},
    engineFactory: async () => engine,
  });
  try {
    const tested = await runtime.connectionTest();
    assert.deepEqual(tested, {
      ok: false,
      message: 'The model connection is incomplete, but the Kernel model catalog is reachable',
      kernelReady: true,
      providerVerified: false,
      checked: 'configuration',
      missing: ['model', 'baseUrl', 'apiKey'],
      catalogCount: 2,
    });
    assert.ok(engine.state.calls.some((call) => call.method === 'model/list'));
  } finally {
    await runtime.close();
  }
});

test('connection update fails closed when the daemon atomically reports an active turn', async () => {
  const engines = [];
  const runtime = await createNativeRuntime({
    home: 'C:\\fixture-home',
    mode: 'browser',
    env: {
      KNORVIA_PROVIDER_MODEL: 'fixture-model',
      KNORVIA_PROVIDER_BASE_URL: 'http://127.0.0.1:4318/v1',
      KNORVIA_PROVIDER_API_KEY: 'local-fixture-key',
    },
    engineFactory: async () => {
      const engine = fixtureEngine({ active: true });
      engines.push(engine);
      return engine;
    },
  });
  try {
    await assert.rejects(runtime.connectionUpdate({ model: 'would-interrupt-a-turn' }), (error) => {
      assert.equal(error.rpc?.code, -32022);
      assert.equal(error.rpc?.data?.activeTurnCount, 1);
      return true;
    });
    assert.equal(engines.length, 1);
    assert.equal(engines[0].state.shutdowns, 0);
    assert.equal(engines[0].state.cancelledRestarts, 0);
    assert.ok(engines[0].state.calls.some((call) => call.method === 'system/prepareRestart'));
    assert.equal((await runtime.connectionRead()).model, 'fixture-model');
  } finally {
    await runtime.close();
  }
});

test('an invalid atomic restart preparation fails closed', async () => {
  const engine = fixtureEngine({ prepareResult: { ready: true, activeTurnCount: 1 } });
  const runtime = await createNativeRuntime({
    home: 'C:\\fixture-home',
    mode: 'browser',
    env: {
      KNORVIA_PROVIDER_MODEL: 'fixture-model',
      KNORVIA_PROVIDER_BASE_URL: 'http://127.0.0.1:4318/v1',
      KNORVIA_PROVIDER_API_KEY: 'local-fixture-key',
    },
    engineFactory: async () => engine,
  });
  try {
    await assert.rejects(runtime.connectionUpdate({ model: 'must-not-restart-with-an-invalid-preparation' }), (error) => {
      assert.equal(error.rpc?.code, -32022);
      return true;
    });
    assert.equal(engine.state.shutdowns, 0);
  } finally {
    await runtime.close();
  }
});

test('the daemon Conflict category keeps the established connection-update conflict shape', async () => {
  const error = new Error('3 task(s) are still running; update the connection after they finish');
  error.rpc = {
    code: -32005,
    message: error.message,
    data: { category: 'CONFLICT' },
  };
  const engine = fixtureEngine({ prepareError: error });
  const runtime = await createNativeRuntime({
    home: 'C:\\fixture-home',
    mode: 'browser',
    env: {
      KNORVIA_PROVIDER_MODEL: 'fixture-model',
      KNORVIA_PROVIDER_BASE_URL: 'http://127.0.0.1:4318/v1',
      KNORVIA_PROVIDER_API_KEY: 'local-fixture-key',
    },
    engineFactory: async () => engine,
  });
  try {
    await assert.rejects(runtime.connectionUpdate({ model: 'must-not-interrupt-a-conflict' }), (received) => {
      assert.equal(received.rpc?.code, -32022);
      assert.equal(received.rpc?.data?.activeTurnCount, 3);
      assert.doesNotMatch(received.rpc?.message || '', /3 task\(s\)/);
      return true;
    });
    assert.equal(engine.state.shutdowns, 0);
  } finally {
    await runtime.close();
  }
});

test('a failed old-engine stop cancels the daemon restart freeze before returning', async () => {
  const oldEngine = fixtureEngine({ shutdownError: new Error('fixture daemon refuses to stop') });
  let starts = 0;
  const runtime = await createNativeRuntime({
    home: 'C:\\fixture-home',
    mode: 'browser',
    env: {
      KNORVIA_PROVIDER_MODEL: 'fixture-model',
      KNORVIA_PROVIDER_BASE_URL: 'http://127.0.0.1:4318/v1',
      KNORVIA_PROVIDER_API_KEY: 'local-fixture-key',
    },
    engineFactory: async () => {
      starts += 1;
      return oldEngine;
    },
  });
  try {
    await assert.rejects(runtime.connectionUpdate({ model: 'new-fixture-model' }));
    assert.equal(starts, 1);
    assert.equal(oldEngine.state.shutdowns, 1);
    assert.equal(oldEngine.state.cancelledRestarts, 1);
    assert.equal((await runtime.connectionRead()).model, 'fixture-model');
  } finally {
    await runtime.close();
  }
});

test('empty apiKey is an explicit clear while omission preserves the configured key', async () => {
  const startOptions = [];
  const runtime = await createNativeRuntime({
    home: 'C:\\fixture-home',
    mode: 'browser',
    env: {
      KNORVIA_PROVIDER_MODEL: 'fixture-model',
      KNORVIA_PROVIDER_BASE_URL: 'http://127.0.0.1:4318/v1',
      KNORVIA_PROVIDER_API_KEY: 'local-fixture-key',
    },
    engineFactory: async (options) => {
      startOptions.push(options);
      return fixtureEngine();
    },
  });
  try {
    await runtime.connectionUpdate({ model: 'fixture-model-keeps-key' });
    assert.equal(startOptions[1].env.KNORVIA_PROVIDER_API_KEY, 'local-fixture-key');
    const cleared = await runtime.connectionUpdate({ apiKey: '' });
    assert.equal(cleared.apiKeyConfigured, false);
    assert.equal(Object.hasOwn(startOptions[2].env, 'KNORVIA_PROVIDER_API_KEY'), false);
  } finally {
    await runtime.close();
  }
});
