'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startNativeGatewayFixture } = require('./fixtures/start-native-gateway-fixture');
const { startScriptedResponsesFixture } = require('./fixtures/scripted-responses-fixture');

const kernelRoot = path.resolve(__dirname, '../../../knorvia-kernel');
const daemon = process.env.KNORVIA_DAEMON_BIN || path.join(kernelRoot, 'knorvia-rs/target/debug/knorvia-daemon.exe');
const appServer = process.env.KNORVIA_KERNEL_BIN || path.join(kernelRoot, 'codex-rs/target/debug/codex-app-server.exe');
const ORIGIN = 'http://127.0.0.1:3000';

class GatewaySocket {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.notifications = [];
    this.sequence = 0;
    socket.on('message', (data, isBinary) => this.receive(data, isBinary));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('gateway socket closed')));
  }

  request(method, params = {}) {
    const id = `live-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  receive(data, isBinary) {
    if (isBinary) return this.fail(new Error('unexpected binary gateway frame'));
    let message;
    try { message = JSON.parse(Buffer.from(data).toString('utf8')); } catch {
      return this.fail(new Error('gateway sent invalid JSON'));
    }
    if (typeof message.method === 'string') {
      this.notifications.push(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message);
      error.rpc = message.error;
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  fail(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close() {
    this.socket.terminate();
  }
}

function getSession(port) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/knorvia/native/session',
      headers: { 'x-knorvia-native-origin': ORIGIN },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`session status ${response.statusCode}`));
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      });
    });
    request.once('error', reject);
    request.end();
  });
}

function connect(port, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/knorvia/native`,
      ['knorvia.native.v1', `knorvia.native.token.${token}`],
      { origin: ORIGIN, perMessageDeflate: false },
    );
    socket.once('open', () => resolve(new GatewaySocket(socket)));
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      reject(new Error(`upgrade rejected (${response.statusCode})`));
    });
    socket.once('error', reject);
  });
}

function waitFor(predicate, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = async () => {
      try {
        if (await predicate()) return resolve();
        if (Date.now() >= deadline) return reject(new Error('timed out waiting for native turn completion'));
        setTimeout(() => { void check(); }, 50);
      } catch (error) {
        reject(error);
      }
    };
    void check();
  });
}

test('saved providers route real turns to separate endpoints and switch back without replay', {
  skip: !fs.existsSync(daemon) || !fs.existsSync(appServer), timeout: 120_000,
}, async () => {
  let fixture; let second; let client;
  try {
    fixture = await startNativeGatewayFixture({ daemonBin: daemon, kernelBin: appServer, port: 0, cleanup: true });
    second = await startScriptedResponsesFixture({ expectedApiKey: 'provider-b-fixture-key' });
    client = await connect(fixture.location.port, (await getSession(fixture.location.port)).token);
    const added = await client.request('connection/provider/save', {
      name: 'Local B', baseUrl: second.baseUrl, model: 'model-b', apiKey: 'provider-b-fixture-key',
    });
    assert.equal(added.providers.length, 2);
    assert.equal(fixture.responses.requests.length + second.requests.length, 0);
    const workspaces = await client.request('workspace/list');
    const thread = await client.request('thread/start', { workspaceId: workspaces[0].id, cwd: fixture.workspace, title: 'Multi-provider fixture' });
    const send = async model => {
      const admitted = await client.request('turn/start', { threadId: thread.id, input: `respond with ${model}`, model, cwd: fixture.workspace, tools: { write: false } });
      await waitFor(async () => (await client.request('turn/read', { id: admitted.turn?.id || admitted.id })).status === 'completed');
    };
    await send('gpt-5.2');
    await client.request('connection/provider/activate', { id: added.savedProviderId });
    await send('model-b');
    assert.equal(second.requests.length, 1);
    assert.equal(second.requests[0].model, 'model-b');
    assert.equal(fixture.responses.requests.length, 1);
    await client.request('connection/provider/activate', { id: 'default' });
    await send('gpt-5.2');
    assert.equal(fixture.responses.requests.length, 2);
    assert.equal(second.requests.length, 1);
    await client.request('connection/provider/delete', { id: added.savedProviderId, revision: 1 });
    assert.equal((await client.request('connection/read')).providers.length, 1);
    assert.doesNotMatch(JSON.stringify(client.notifications), /provider-b-fixture-key|local-fixture-only|apiKeyEncrypted/);
  } finally { client?.close(); await fixture?.close(); await second?.close(); }
});

test('native gateway distinguishes its real Kernel catalog from a local provider probe', {
  skip: !fs.existsSync(daemon) || !fs.existsSync(appServer), timeout: 120_000,
}, async () => {
  let fixture;
  let client;
  try {
    fixture = await startNativeGatewayFixture({ daemonBin: daemon, kernelBin: appServer, port: 0, cleanup: true });
    const session = await getSession(fixture.location.port);
    client = await connect(fixture.location.port, session.token);

    const connection = await client.request('connection/read');
    assert.equal(connection.configured, true);
    assert.equal(connection.transport, 'browser');
    assert.equal(connection.credentialStorage, 'env');
    assert.doesNotMatch(JSON.stringify(connection), /local-fixture-only/);

    const catalog = await client.request('connection/test');
    assert.equal(catalog.ok, true, JSON.stringify(catalog));
    assert.equal(catalog.kernelReady, true);
    assert.equal(catalog.providerVerified, false);
    assert.equal(catalog.checked, 'kernel-model-catalog');
    assert.equal(fixture.responses.requests.length, 0);

    const probe = await client.request('connection/test', { probeProvider: true });
    assert.equal(probe.ok, true, JSON.stringify(probe));
    assert.equal(probe.kernelReady, true);
    assert.equal(probe.providerVerified, true);
    assert.equal(probe.checked, 'provider-probe');
    assert.equal(probe.status, 200);
    assert.equal(fixture.responses.requests.length, 1);
    assert.equal(fixture.responses.requests[0].kind, 'message');
  } finally {
    client?.close();
    await fixture?.close();
  }
});

test('an idle connection update replaces the daemon and applies its model without replaying work', {
  skip: !fs.existsSync(daemon) || !fs.existsSync(appServer), timeout: 120_000,
}, async () => {
  let fixture;
  let client;
  try {
    fixture = await startNativeGatewayFixture({ daemonBin: daemon, kernelBin: appServer, port: 0, cleanup: true });
    const session = await getSession(fixture.location.port);
    client = await connect(fixture.location.port, session.token);

    const changed = await client.request('connection/update', { model: 'fixture-model-after-restart' });
    assert.equal(changed.model, 'fixture-model-after-restart');
    assert.equal(changed.engineState, 'ready');
    // Restart inspection and daemon replacement are not a model mutation.
    assert.equal(fixture.responses.requests.length, 0);

    const workspaces = await client.request('workspace/list');
    const thread = await client.request('thread/start', {
      workspaceId: workspaces[0].id,
      title: 'connection replacement fixture',
      cwd: fixture.workspace,
    });
    const started = await client.request('turn/start', {
      threadId: thread.id,
      input: 'confirm the restarted connection model',
      tools: { write: false },
      cwd: fixture.workspace,
    });
    const turnId = started.turn?.id || started.id;
    await waitFor(async () => {
      const snapshot = await client.request('turn/read', { id: turnId });
      return snapshot.status === 'completed';
    });
    assert.equal(fixture.responses.requests.length, 1);
    assert.equal(fixture.responses.requests[0].model, 'fixture-model-after-restart');
  } finally {
    client?.close();
    await fixture?.close();
  }
});

test('an active real turn keeps its daemon and returns the explicit connection-update conflict', {
  skip: !fs.existsSync(daemon) || !fs.existsSync(appServer), timeout: 120_000,
}, async () => {
  let fixture;
  let client;
  try {
    fixture = await startNativeGatewayFixture({
      daemonBin: daemon, kernelBin: appServer, port: 0, cleanup: true, slowDelayMs: 60_000,
    });
    const session = await getSession(fixture.location.port);
    client = await connect(fixture.location.port, session.token);
    const workspaces = await client.request('workspace/list');
    const thread = await client.request('thread/start', {
      workspaceId: workspaces[0].id,
      title: 'connection conflict fixture',
      cwd: fixture.workspace,
    });
    const started = await client.request('turn/start', {
      threadId: thread.id,
      input: '[slow] keep this turn active while changing the model',
      tools: { write: false },
      cwd: fixture.workspace,
    });
    const turnId = started.turn?.id || started.id;
    await waitFor(async () => {
      const snapshot = await client.request('thread/read', { id: thread.id });
      return snapshot.activeTurn?.id === turnId
        && fixture.responses.requests.some((request) => request.kind === 'slow');
    });

    await assert.rejects(client.request('connection/update', { model: 'must-not-restart-while-active' }), (error) => {
      assert.equal(error.rpc?.code, -32022);
      assert.equal(error.rpc?.data?.activeTurnCount, 1);
      return true;
    });
    const backup = await client.request('connection/provider/save', { name: 'Backup during a turn', model: 'backup-model', baseUrl: fixture.providerUrl, apiKey: 'local-fixture-only' });
    await assert.rejects(client.request('connection/provider/activate', { id: backup.savedProviderId }), error => error.rpc?.code === -32022);
    assert.equal((await client.request('connection/read')).providers.length, 2);
    assert.equal((await client.request('connection/read')).model, 'gpt-5.2');

    fixture.responses.releaseSlowTurns();
    await waitFor(async () => {
      const snapshot = await client.request('turn/read', { id: turnId });
      return snapshot.status === 'completed';
    });
  } finally {
    client?.close();
    await fixture?.close();
  }
});

// This drives the real daemon and forked Kernel through the new gateway with a
// local scripted Responses endpoint. No user home, credential, or external
// provider is involved.
test('native gateway streams a real scripted daemon turn and recovers it by snapshot', {
  skip: !fs.existsSync(daemon) || !fs.existsSync(appServer), timeout: 120_000,
}, async () => {
  let fixture;
  let client;
  try {
    fixture = await startNativeGatewayFixture({ daemonBin: daemon, kernelBin: appServer, port: 0, cleanup: true });
    const session = await getSession(fixture.location.port);
    client = await connect(fixture.location.port, session.token);
    const health = await client.request('system/health');
    assert.equal(health.ok, true);
    const workspaces = await client.request('workspace/list');
    assert.ok(workspaces.length > 0);
    const thread = await client.request('thread/start', { workspaceId: workspaces[0].id, title: 'native gateway turn' });
    const admitted = await client.request('turn/start', {
      threadId: thread.id, input: 'respond from the scripted native gateway model', tools: { write: false },
    });
    const turnId = admitted.turn?.id || admitted.id;
    assert.ok(turnId, JSON.stringify(admitted));
    let snapshot;
    await waitFor(async () => {
      snapshot = await client.request('turn/read', { id: turnId });
      return snapshot.status === 'completed';
    });
    assert.equal(snapshot.status, 'completed');
    assert.ok(snapshot.items.some((item) => item.kind === 'agentMessage'
      && item.payload?.text === 'scripted native fixture response'), JSON.stringify(snapshot));
    assert.ok(client.notifications.some((event) => event.method === 'turn/event'));
  } finally {
    client?.close();
    await fixture?.close();
  }
});

test('fixture approval denies then allows a real isolated file write', {
  skip: !fs.existsSync(daemon) || !fs.existsSync(appServer), timeout: 120_000,
}, async () => {
  let fixture;
  let client;
  try {
    fixture = await startNativeGatewayFixture({ daemonBin: daemon, kernelBin: appServer, port: 0, cleanup: true });
    const session = await getSession(fixture.location.port);
    client = await connect(fixture.location.port, session.token);
    const workspaces = await client.request('workspace/list');
    const thread = await client.request('thread/start', {
      workspaceId: workspaces[0].id,
      title: 'fixture approval',
      cwd: fixture.workspace,
    });
    const marker = path.join(fixture.workspace, 'knorvia-fixture-approved.txt');
    assert.equal(fs.existsSync(marker), false);

    const awaitApproval = async (turnId) => {
      let snapshot;
      await waitFor(async () => {
        snapshot = await client.request('thread/read', { id: thread.id });
        return snapshot.pendingApprovals?.some((approval) => approval.turnId === turnId) === true;
      });
      return snapshot.pendingApprovals.find((approval) => approval.turnId === turnId);
    };
    const awaitTerminal = async (turnId) => {
      let snapshot;
      await waitFor(async () => {
        snapshot = await client.request('turn/read', { id: turnId });
        return !['running', 'pending', 'cancelling'].includes(snapshot.status);
      });
      return snapshot;
    };

    const deniedStart = await client.request('turn/start', {
      threadId: thread.id,
      input: '[approval] deny the isolated write',
      tools: { write: true },
      cwd: fixture.workspace,
    });
    const deniedTurnId = deniedStart.turn?.id || deniedStart.id;
    const deniedApproval = await awaitApproval(deniedTurnId);
    assert.ok(deniedApproval?.id, JSON.stringify(deniedApproval));
    assert.equal(fs.existsSync(marker), false);
    await client.request('approval/respond', { id: deniedApproval.id, decision: 'deny' });
    await awaitTerminal(deniedTurnId);
    assert.equal(fs.existsSync(marker), false);

    const allowedStart = await client.request('turn/start', {
      threadId: thread.id,
      input: '[approval] allow the isolated write',
      tools: { write: true },
      cwd: fixture.workspace,
    });
    const allowedTurnId = allowedStart.turn?.id || allowedStart.id;
    const allowedApproval = await awaitApproval(allowedTurnId);
    assert.ok(allowedApproval?.id, JSON.stringify(allowedApproval));
    await client.request('approval/respond', { id: allowedApproval.id, decision: 'allow' });
    await awaitTerminal(allowedTurnId);
    assert.equal(fs.existsSync(marker), true);
  } finally {
    client?.close();
    await fixture?.close();
  }
});

test('fixture user input persists a real request and resumes the native turn', {
  skip: !fs.existsSync(daemon) || !fs.existsSync(appServer), timeout: 120_000,
}, async () => {
  let fixture;
  let client;
  try {
    fixture = await startNativeGatewayFixture({ daemonBin: daemon, kernelBin: appServer, port: 0, cleanup: true });
    const session = await getSession(fixture.location.port);
    client = await connect(fixture.location.port, session.token);
    const workspaces = await client.request('workspace/list');
    const thread = await client.request('thread/start', {
      workspaceId: workspaces[0].id,
      title: 'fixture user input',
      cwd: fixture.workspace,
    });
    const started = await client.request('turn/start', {
      threadId: thread.id,
      input: '[user-input] ask the fixture question',
      tools: { write: false },
      cwd: fixture.workspace,
    });
    const turnId = started.turn?.id || started.id;
    let pendingInput;
    let latestSnapshot;
    try {
      await waitFor(async () => {
        latestSnapshot = await client.request('thread/read', { id: thread.id });
        pendingInput = latestSnapshot.pendingUserInputs?.find((item) => item.turnId === turnId);
        return Boolean(pendingInput?.id);
      });
    } catch (error) {
      throw new Error(`${error.message}\nuser input trace: ${JSON.stringify({
        notifications: client.notifications,
        requests: fixture.responses.requests,
        snapshot: latestSnapshot,
        started,
      })}`);
    }
    assert.ok(pendingInput?.id, JSON.stringify(pendingInput));
    assert.ok(client.notifications.some((event) => event.method === 'userInput/request'
      && event.params?.id === pendingInput.id));
    await client.request('userInput/respond', {
      id: pendingInput.id,
      answers: { mode: { answers: ['Safe (Recommended)'] } },
    });
    let terminal;
    await waitFor(async () => {
      terminal = await client.request('turn/read', { id: turnId });
      return !['running', 'pending', 'cancelling'].includes(terminal.status);
    });
    assert.equal(terminal.status, 'completed', JSON.stringify(terminal));
    assert.ok(terminal.items.some((item) => item.kind === 'agentMessage'
      && String(item.payload?.text || '').includes('user input fixture completed')),
    JSON.stringify(terminal));
  } finally {
    client?.close();
    await fixture?.close();
  }
});

test('fixture forwards a steer into a real active Kernel turn and persists the user item', {
  skip: !fs.existsSync(daemon) || !fs.existsSync(appServer), timeout: 120_000,
}, async () => {
  let fixture;
  let client;
  try {
    fixture = await startNativeGatewayFixture({
      daemonBin: daemon, kernelBin: appServer, port: 0, cleanup: true, slowDelayMs: 60_000,
    });
    const session = await getSession(fixture.location.port);
    client = await connect(fixture.location.port, session.token);
    const workspaces = await client.request('workspace/list');
    const thread = await client.request('thread/start', {
      workspaceId: workspaces[0].id,
      title: 'fixture steer',
      cwd: fixture.workspace,
    });
    const started = await client.request('turn/start', {
      threadId: thread.id,
      input: '[slow] keep this real turn active for steering',
      tools: { write: false },
      cwd: fixture.workspace,
    });
    const turnId = started.turn?.id || started.id;
    assert.ok(turnId, JSON.stringify(started));
    await waitFor(async () => {
      const snapshot = await client.request('thread/read', { id: thread.id });
      return snapshot.activeTurn?.id === turnId
        && fixture.responses.requests.some((request) => request.kind === 'slow');
    });

    const steered = await client.request('turn/steer', {
      threadId: thread.id,
      turnId,
      input: 'Continue with the fixture result after this steer.',
      clientMessageId: 'fixture-steer-1',
    });
    assert.equal(steered.turnId, turnId, JSON.stringify(steered));
    assert.equal(steered.item?.kind, 'userMessage', JSON.stringify(steered));
    assert.equal(steered.item?.status, 'completed', JSON.stringify(steered));
    assert.equal(steered.item?.payload?.text, 'Continue with the fixture result after this steer.');

    fixture.responses.releaseSlowTurns();
    let terminal;
    await waitFor(async () => {
      terminal = await client.request('turn/read', { id: turnId });
      return !['running', 'pending', 'cancelling'].includes(terminal.status);
    });
    assert.equal(terminal.status, 'completed', JSON.stringify(terminal));
    const snapshot = await client.request('thread/read', { id: thread.id });
    assert.ok(snapshot.items.some((item) => item.id === steered.item.id
      && item.kind === 'userMessage' && item.status === 'completed'), JSON.stringify(snapshot));
  } finally {
    client?.close();
    await fixture?.close();
  }
});

test('fixture interrupts a real active Kernel turn and reaches a durable cancelled state', {
  skip: !fs.existsSync(daemon) || !fs.existsSync(appServer), timeout: 120_000,
}, async () => {
  let fixture;
  let client;
  try {
    fixture = await startNativeGatewayFixture({
      daemonBin: daemon, kernelBin: appServer, port: 0, cleanup: true, slowDelayMs: 60_000,
    });
    const session = await getSession(fixture.location.port);
    client = await connect(fixture.location.port, session.token);
    const workspaces = await client.request('workspace/list');
    const thread = await client.request('thread/start', {
      workspaceId: workspaces[0].id,
      title: 'fixture interrupt',
      cwd: fixture.workspace,
    });
    const started = await client.request('turn/start', {
      threadId: thread.id,
      input: '[slow] keep this real turn active for interruption',
      tools: { write: false },
      cwd: fixture.workspace,
    });
    const turnId = started.turn?.id || started.id;
    assert.ok(turnId, JSON.stringify(started));
    await waitFor(async () => {
      const snapshot = await client.request('thread/read', { id: thread.id });
      return snapshot.activeTurn?.id === turnId
        && fixture.responses.requests.some((request) => request.kind === 'slow');
    });

    const interrupted = await client.request('turn/interrupt', { turnId });
    assert.equal(interrupted.id, turnId, JSON.stringify(interrupted));
    let terminal;
    await waitFor(async () => {
      terminal = await client.request('turn/read', { id: turnId });
      return !['running', 'pending', 'cancelling'].includes(terminal.status);
    });
    assert.equal(terminal.status, 'cancelled', JSON.stringify(terminal));
  } finally {
    client?.close();
    await fixture?.close();
  }
});
