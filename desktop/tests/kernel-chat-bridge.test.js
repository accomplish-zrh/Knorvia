'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatBridge } = require('../kernel-chat-bridge');

const THREAD = 'thread-1';
const TURN = 'turn-1';

function userItem() {
  return {
    id: 'item-user', seq: 1, threadId: THREAD, turnId: TURN,
    kind: 'userMessage', payload: { text: 'question' },
  };
}

function agentItem(id, seq, text, kernelItemId = id) {
  return {
    id, seq, threadId: THREAD, turnId: TURN,
    kind: 'agentMessage', payload: { text, kernelItemId },
  };
}

function turn(status = 'running', items = [userItem()], extra = {}) {
  return { id: TURN, threadId: THREAD, status, items, ...extra };
}

function startResult(status = 'running', items = [userItem()]) {
  return { turn: { id: TURN, threadId: THREAD, status }, items };
}

function setup(responder) {
  const calls = [];
  const events = [];
  const bridge = createChatBridge({
    workspaceId: 'workspace-1',
    rpc: async (method, params) => {
      calls.push({ method, params });
      return responder(method, params);
    },
  });
  const send = (data, id = 'socket-1') => bridge.handleWsSend(
    { id, data },
    (message) => events.push({ socketId: id, ...JSON.parse(message.data) }),
  );
  const notify = (params, method = 'turn/event') => bridge.handleNotification({
    jsonrpc: '2.0', method, params,
  });
  return { bridge, send, notify, calls, events };
}

function contents(events) {
  return events.filter((event) => event.type === 'content').map((event) => event.content);
}

test('asynchronous notifications are scoped, durable Items are de-duplicated, and deltas do not repeat final text', async () => {
  let snapshot = turn('completed', [
    userItem(),
    agentItem('item-answer', 2, 'hello world', 'kernel-answer'),
    // Equal content is allowed when it belongs to a different persisted Item.
    agentItem('item-repeat-a', 3, 'same', 'kernel-repeat-a'),
    agentItem('item-repeat-b', 4, 'same', 'kernel-repeat-b'),
  ]);
  const { send, notify, calls, events } = setup((method) => {
    if (method === 'thread/start') return { id: THREAD };
    if (method === 'turn/start') return startResult();
    if (method === 'turn/read') return snapshot;
    throw new Error(`unexpected RPC ${method}`);
  });

  await send({ type: 'start_turn', content: 'question' });
  assert.ok(events.some((event) => event.type === 'session' && event.turn_id === TURN));
  assert.ok(!events.some((event) => event.type === 'done'));
  assert.deepEqual(calls.find((call) => call.method === 'turn/start').params.tools, {
    readOnly: true, write: false,
  });

  await notify({
    threadId: 'another-thread', turnId: TURN, kind: 'agentMessage.delta',
    payload: { itemId: 'kernel-answer', text: 'ignored' },
  });
  await notify({
    threadId: THREAD, turnId: 'another-turn', kind: 'agentMessage.delta',
    payload: { itemId: 'kernel-answer', text: 'ignored' },
  });
  await notify({
    threadId: THREAD, turnId: TURN, kind: 'agentMessage.delta',
    payload: { itemId: 'kernel-answer', text: 'hello' },
  });
  await notify({
    threadId: THREAD, turnId: TURN, kind: 'agentMessage.delta',
    payload: { itemId: 'kernel-answer', text: ' world' },
  });
  await notify({
    threadId: THREAD, turnId: TURN, kind: 'agentMessage',
    payload: { text: 'hello world', kernelItemId: 'kernel-answer' },
    item: agentItem('item-answer', 2, 'hello world', 'kernel-answer'),
  });
  // Duplicate notification of the same durable Item is ignored.
  await notify({
    threadId: THREAD, turnId: TURN, kind: 'agentMessage',
    payload: { text: 'hello world', kernelItemId: 'kernel-answer' },
    item: agentItem('item-answer', 2, 'hello world', 'kernel-answer'),
  });
  assert.deepEqual(contents(events), ['hello', ' world']);

  await notify({ threadId: THREAD, turnId: TURN, status: 'completed' });
  assert.equal(calls.filter((call) => call.method === 'turn/read').length, 1);
  assert.deepEqual(contents(events), ['hello', ' world', 'same', 'same']);
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.metadata.status, 'completed');
  assert.equal(done.metadata.remoteStatus, 'completed');
  assert.equal(done.metadata.terminalConfirmed, true);
});

test('a terminal notification waits for the authoritative turn/read snapshot before emitting done', async () => {
  let releaseRead;
  const readPending = new Promise((resolve) => { releaseRead = resolve; });
  const { send, notify, events } = setup(async (method) => {
    if (method === 'thread/start') return { id: THREAD };
    if (method === 'turn/start') return startResult();
    if (method === 'turn/read') return readPending;
    throw new Error(`unexpected RPC ${method}`);
  });
  await send({ type: 'start_turn', content: 'question' });
  const reconciliation = notify({ threadId: THREAD, turnId: TURN, status: 'completed' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!events.some((event) => event.type === 'done'));
  releaseRead(turn('completed', [userItem(), agentItem('persisted-after-terminal', 2, 'authoritative')]));
  await reconciliation;
  assert.deepEqual(contents(events), ['authoritative']);
  assert.equal(events.at(-1).type, 'done');
});

test('unsubscribe during terminal reconciliation suppresses late output but still releases the thread guard', async () => {
  let releaseRead;
  const readPending = new Promise((resolve) => { releaseRead = resolve; });
  let starts = 0;
  const { send, notify, calls, events } = setup((method, params) => {
    if (method === 'thread/start') return { id: THREAD };
    if (method === 'thread/resume') return { id: params.id };
    if (method === 'turn/start') return startResult('running', starts++ ? [] : [userItem()]);
    if (method === 'turn/read') return readPending;
    throw new Error(`unexpected RPC ${method}`);
  });
  await send({ type: 'start_turn', content: 'question' });
  const reconciliation = notify({ threadId: THREAD, turnId: TURN, status: 'completed' });
  await new Promise((resolve) => setImmediate(resolve));
  await send({ type: 'unsubscribe' });
  releaseRead(turn('completed', [userItem()]));
  await reconciliation;
  assert.ok(!events.some((event) => event.type === 'done'));
  await send({ type: 'start_turn', content: 'next' });
  assert.deepEqual(calls.filter((call) => call.method === 'thread/resume').map((call) => call.params), [{ id: THREAD }]);
});

test('interruption keeps a running state until a terminal event, then preserves remote interrupted status', async () => {
  let snapshot = turn('interrupted', [userItem()]);
  const { send, notify, events } = setup((method) => {
    if (method === 'thread/start') return { id: THREAD };
    if (method === 'turn/start') return startResult();
    if (method === 'turn/interrupt') return turn('running');
    if (method === 'turn/read') return snapshot;
    throw new Error(`unexpected RPC ${method}`);
  });
  await send({ type: 'start_turn', content: 'question' });
  await send({ type: 'cancel_turn', turn_id: TURN });
  assert.equal(events.at(-1).type, 'progress');
  assert.equal(events.at(-1).metadata.status, 'running');
  assert.ok(!events.some((event) => event.type === 'done'));

  await notify({ threadId: THREAD, turnId: TURN, status: 'interrupted' });
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.metadata.status, 'cancelled');
  assert.equal(done.metadata.remoteStatus, 'interrupted');
  assert.equal(snapshot.status, 'interrupted');
});

test('transport and terminal-reconciliation failures end local waiting as connection_error without inventing a remote terminal', async () => {
  const startFailure = setup((method) => {
    if (method === 'thread/start') return { id: THREAD };
    if (method === 'turn/start') throw new Error('daemon pipe closed');
    throw new Error(`unexpected RPC ${method}`);
  });
  await startFailure.send({ type: 'start_turn', content: 'question' });
  const initialDone = startFailure.events.at(-1);
  assert.equal(initialDone.type, 'done');
  assert.equal(initialDone.metadata.status, 'connection_error');
  assert.equal(initialDone.metadata.remoteStatus, 'unknown');
  assert.equal(initialDone.metadata.terminalConfirmed, false);

  const reconcileFailure = setup((method) => {
    if (method === 'thread/start') return { id: THREAD };
    if (method === 'turn/start') return startResult();
    if (method === 'turn/read') throw new Error('read transport failed');
    throw new Error(`unexpected RPC ${method}`);
  });
  await reconcileFailure.send({ type: 'start_turn', content: 'question' });
  await reconcileFailure.notify({ threadId: THREAD, turnId: TURN, status: 'completed' });
  const terminalDone = reconcileFailure.events.at(-1);
  assert.equal(terminalDone.type, 'done');
  assert.equal(terminalDone.metadata.status, 'connection_error');
  assert.equal(terminalDone.metadata.remoteStatus, 'completed');
  assert.equal(terminalDone.metadata.terminalConfirmed, false);
  assert.ok(!reconcileFailure.events.some((event) => event.type === 'done' && event.metadata.status === 'completed'));
});

test('persistence failures are local recovery errors, not fabricated remote terminal states', async () => {
  const { send, notify, calls, events } = setup((method) => {
    if (method === 'thread/start') return { id: THREAD };
    if (method === 'turn/start') return startResult();
    throw new Error(`unexpected RPC ${method}`);
  });
  await send({ type: 'start_turn', content: 'question' });
  await notify({ threadId: 'other', turnId: TURN, message: 'ignore me' }, 'turn/persistenceError');
  assert.ok(!events.some((event) => event.metadata.status === 'persistence_error'));
  await notify({ threadId: THREAD, turnId: TURN, message: 'disk write failed' }, 'turn/persistenceError');
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.metadata.status, 'persistence_error');
  assert.equal(done.metadata.terminalConfirmed, false);
  assert.equal(done.metadata.localOnly, true);
  assert.ok(events.some((event) => event.type === 'error' && event.content.includes('disk write failed')));
  assert.equal(calls.filter((call) => call.method === 'turn/read').length, 0);
});

test('resume_from is a snapshot recovery path with current-daemon-only live cursor semantics', async () => {
  const snapshot = turn('running', [
    userItem(),
    agentItem('old-answer', 2, 'already rendered', 'old-kernel-item'),
    agentItem('new-answer', 3, 'replayed once', 'new-kernel-item'),
  ]);
  const { send, notify, calls, events } = setup((method) => {
    if (method === 'turn/read') return snapshot;
    throw new Error(`unexpected RPC ${method}`);
  });
  await send({ type: 'resume_from', turn_id: TURN, seq: 2 });
  assert.deepEqual(calls, [{ method: 'turn/read', params: { id: TURN } }]);
  assert.deepEqual(contents(events), ['replayed once']);
  const recovery = events.find((event) => event.type === 'session');
  assert.equal(recovery.session_id, THREAD);
  assert.equal(recovery.turn_id, TURN);
  assert.equal(recovery.metadata.recovery, 'snapshot');
  assert.equal(recovery.metadata.realtimeCursor, 'current-daemon-only');
  assert.equal(recovery.metadata.crossDaemonRealtimeCursor, false);

  await notify({
    threadId: THREAD, turnId: TURN, kind: 'agentMessage',
    payload: { text: 'still live', kernelItemId: 'live-kernel-item' },
    item: agentItem('live-answer', 4, 'still live', 'live-kernel-item'),
  });
  assert.deepEqual(contents(events), ['replayed once', 'still live']);
});

test('a completed recovery snapshot honors after_seq while still replaying later durable Items', async () => {
  const snapshot = turn('completed', [
    userItem(),
    agentItem('old-answer', 2, 'already rendered', 'old-kernel-item'),
    agentItem('new-answer', 3, 'must still render', 'new-kernel-item'),
  ]);
  const { send, events } = setup((method) => {
    if (method === 'turn/read') return snapshot;
    throw new Error(`unexpected RPC ${method}`);
  });

  await send({ type: 'resume_from', turn_id: TURN, after_seq: 2 });

  assert.deepEqual(contents(events), ['must still render']);
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.metadata.status, 'completed');
  assert.equal(done.metadata.terminalConfirmed, true);
});

test('a terminal notification racing recovery snapshot binding is re-read before recovery can wait forever', async () => {
  let releaseFirstRead;
  const firstRead = new Promise((resolve) => { releaseFirstRead = resolve; });
  let reads = 0;
  const { send, notify, calls, events } = setup((method) => {
    if (method !== 'turn/read') throw new Error(`unexpected RPC ${method}`);
    reads += 1;
    return reads === 1
      ? firstRead
      : turn('completed', [
        userItem(),
        agentItem('old-answer', 2, 'already rendered', 'old-kernel-item'),
        agentItem('race-answer', 3, 'durable final'),
      ]);
  });

  const recovery = send({ type: 'resume_from', turn_id: TURN, after_seq: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.method === 'turn/read').length, 1);

  // The notification is deliberately delivered while the original snapshot
  // is outstanding. That snapshot then reports the stale running state.
  await notify({ threadId: THREAD, turnId: TURN, status: 'completed' });
  releaseFirstRead(turn('running', [
    userItem(),
    agentItem('old-answer', 2, 'already rendered', 'old-kernel-item'),
  ]));
  await recovery;

  assert.equal(calls.filter((call) => call.method === 'turn/read').length, 2);
  assert.deepEqual(contents(events), ['durable final']);
  assert.ok(!events.some((event) => event.type === 'progress' && event.metadata.status === 'running'));
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.metadata.status, 'completed');
  assert.equal(done.metadata.terminalConfirmed, true);
});

test('a confirmed terminal unlocks same-thread continuation, while explicit null creates a new thread', async () => {
  let starts = 0;
  let reads = 0;
  let turnStarts = 0;
  const { send, notify, calls, events } = setup((method, params) => {
    if (method === 'thread/start') return { id: `new-thread-${++starts}` };
    if (method === 'thread/resume') return { id: params.id };
    if (method === 'turn/start') {
      const threadId = params.threadId;
      return { turn: { id: `turn-${threadId}-${++turnStarts}`, threadId, status: 'running' }, items: [] };
    }
    if (method === 'turn/read') {
      reads += 1;
      return { id: params.id, threadId: 'new-thread-1', status: 'completed', items: [] };
    }
    throw new Error(`unexpected RPC ${method}`);
  });
  await send({ type: 'start_turn', content: 'first' });
  await notify({ threadId: 'new-thread-1', turnId: 'turn-new-thread-1-1', status: 'completed' });
  assert.equal(reads, 1);
  await send({ type: 'start_turn', content: 'second' });
  assert.deepEqual(calls.filter((call) => call.method === 'thread/resume').map((call) => call.params), [{ id: 'new-thread-1' }]);
  await notify({ threadId: 'new-thread-1', turnId: 'turn-new-thread-1-2', status: 'completed' });
  await send({ type: 'start_turn', content: 'fresh', session_id: null });
  assert.equal(calls.filter((call) => call.method === 'thread/start').length, 2);
  assert.ok(events.some((event) => event.session_id === 'new-thread-2'));
});

test('overlapping starts are blocked and a closed socket is detached from late notifications', async () => {
  let releaseThread;
  const delayedThread = new Promise((resolve) => { releaseThread = resolve; });
  const { bridge, send, notify, calls, events } = setup(async (method) => {
    if (method === 'thread/start') return delayedThread;
    if (method === 'turn/start') return startResult();
    throw new Error(`unexpected RPC ${method}`);
  });
  const first = send({ type: 'start_turn', content: 'first' });
  await send({ type: 'start_turn', content: 'second' });
  releaseThread({ id: THREAD });
  await first;
  assert.equal(calls.filter((call) => call.method === 'thread/start').length, 1);
  assert.ok(events.some((event) => event.type === 'error' && event.content.includes('already active')));

  const beforeClose = events.length;
  bridge.handleWsClose({ id: 'socket-1' });
  await notify({
    threadId: THREAD, turnId: TURN, kind: 'agentMessage.delta',
    payload: { itemId: 'late', text: 'must not render' },
  });
  await notify({ threadId: THREAD, turnId: TURN, status: 'completed' });
  assert.equal(events.length, beforeClose);
  assert.equal(calls.filter((call) => call.method === 'turn/read').length, 0);
});

test('closing during thread admission prevents a late turn request and sender leak', async () => {
  let releaseThread;
  const pendingThread = new Promise((resolve) => { releaseThread = resolve; });
  const { bridge, send, calls, events } = setup((method) => {
    if (method === 'thread/start') return pendingThread;
    throw new Error(`unexpected RPC ${method}`);
  });
  const admission = send({ type: 'start_turn', content: 'question' });
  await new Promise((resolve) => setImmediate(resolve));
  bridge.handleWsClose({ id: 'socket-1' });
  releaseThread({ id: THREAD });
  await admission;
  assert.deepEqual(calls.map((call) => call.method), ['thread/start']);
  assert.deepEqual(events, []);
});

test('unsupported user replies fail explicitly rather than pretending model delivery', async () => {
  const { send, calls, events } = setup(() => assert.fail('must not call RPC'));
  await send({ type: 'submit_user_reply', text: 'answer' });
  assert.equal(calls.length, 0);
  assert.equal(events[0].type, 'error');
  assert.match(events[0].content, /Unsupported desktop message/);
});
