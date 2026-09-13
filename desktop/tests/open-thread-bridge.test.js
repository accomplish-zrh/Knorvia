'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenThreadBridge, validateOpenThreadId } = require('../open-thread-bridge');

function harness({ ready = true, now } = {}) {
  const delivered = [];
  let shellReady = ready;
  let activated = 0;
  const bridge = createOpenThreadBridge({
    deliver: (id) => delivered.push(id),
    isShellReady: () => shellReady,
    activate: () => { activated += 1; },
    now: now ?? (() => 1000),
    ttlMs: 60_000,
  });
  return { bridge, delivered, setReady: (v) => { shellReady = v; }, activated: () => activated };
}

test('a click while the shell is ready activates the window and delivers the thread id', () => {
  const { bridge, delivered, activated } = harness();
  assert.equal(bridge.open('thread-123'), 'delivered');
  assert.deepEqual(delivered, ['thread-123']);
  assert.equal(activated(), 1);
  assert.equal(bridge.pending, false);
});

test('a click before the shell is ready is buffered once and replayed exactly once on load', () => {
  const { bridge, delivered, setReady } = harness({ ready: false });
  assert.equal(bridge.open('thread-abc'), 'buffered');
  assert.deepEqual(delivered, []);
  setReady(true);
  assert.equal(bridge.flush(), 'thread-abc');
  assert.deepEqual(delivered, ['thread-abc']);
  assert.equal(bridge.flush(), null, 'second flush must not replay');
  assert.deepEqual(delivered, ['thread-abc']);
});

test('only the most recent pending id is kept', () => {
  const { bridge, delivered, setReady } = harness({ ready: false });
  bridge.open('thread-1');
  bridge.open('thread-2');
  setReady(true);
  assert.equal(bridge.flush(), 'thread-2');
  assert.deepEqual(delivered, ['thread-2']);
});

test('malformed ids never reach the renderer and cannot trigger arbitrary navigation', () => {
  const { bridge, delivered } = harness();
  for (const bad of ['', '   ', null, undefined, 42, 'a'.repeat(201), 'thread\nid', "x'; delete", 'id\\..\\..\\etc', '<script>']) {
    assert.notEqual(bridge.open(bad), 'delivered', String(bad));
  }
  assert.deepEqual(delivered, []);
  assert.equal(bridge.pending, false);
});

test('a pending click expires after the bounded TTL and is never replayed stale', () => {
  let clock = 1000;
  const { bridge, delivered, setReady } = harness({ ready: false, now: () => clock });
  bridge.open('thread-old');
  clock += 61_000;
  setReady(true);
  assert.equal(bridge.flush(), null);
  assert.deepEqual(delivered, []);
});

test('flush on a non-shell page keeps nothing pending', () => {
  const { bridge, delivered, setReady } = harness({ ready: false });
  bridge.open('thread-x');
  setReady(true);
  // simulate did-finish-load of the loading page: shell still not ready
  setReady(false);
  assert.equal(bridge.flush(), null);
  setReady(true);
  assert.equal(bridge.flush(), 'thread-x', 'the buffered request survives until the shell really loads');
  assert.deepEqual(delivered, ['thread-x']);
});

test('id validation follows the same rules the main process applies', () => {
  assert.equal(validateOpenThreadId(' abc-DEF_123 '), 'abc-DEF_123');
  assert.equal(validateOpenThreadId('x'.repeat(200)), 'x'.repeat(200));
  assert.equal(validateOpenThreadId('x'.repeat(201)), null);
  assert.equal(validateOpenThreadId('tab\there'), null);
});

test('window activation restores a minimized window and focuses it', () => {
  let restored = false;
  let shown = false;
  let focused = false;
  let minimized = true;

  const mockWindow = {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    restore: () => { restored = true; minimized = false; },
    show: () => { shown = true; },
    focus: () => { focused = true; },
  };

  const bridge = createOpenThreadBridge({
    deliver: () => {},
    isShellReady: () => true,
    activate: () => {
      if (!mockWindow || mockWindow.isDestroyed()) return;
      if (mockWindow.isMinimized()) mockWindow.restore();
      mockWindow.show();
      mockWindow.focus();
    },
  });

  assert.equal(bridge.open('thread-restore-1'), 'delivered');
  assert.equal(restored, true, 'minimized window must be restored');
  assert.equal(shown, true, 'window must be shown');
  assert.equal(focused, true, 'window must be focused');
});

test('TurnNotifier click integration dispatches through open-thread bridge', () => {
  const { createTurnNotifier } = require('../turn-notifications');
  const delivered = [];
  let windowActivated = false;

  const bridge = createOpenThreadBridge({
    deliver: (id) => delivered.push(id),
    isShellReady: () => true,
    activate: () => { windowActivated = true; },
  });

  let clickHandler = null;
  class MockNotification {
    constructor(options) {
      this.options = options;
    }
    static isSupported() { return true; }
    on(event, handler) {
      if (event === 'click') clickHandler = handler;
    }
    show() {}
  }

  const notifier = createTurnNotifier({
    deliverability: () => true,
    onClick: (threadId) => { bridge.open(threadId); },
    Notification: MockNotification,
  });

  const handled = notifier.handle({
    method: 'turn/event',
    params: { threadId: 'thread-click-456', turnId: 'turn-1', status: 'completed' },
  });
  assert.equal(handled, true);
  assert.ok(clickHandler, 'notification click handler must be bound');

  // Simulate user clicking notification banner
  clickHandler();
  assert.equal(windowActivated, true);
  assert.deepEqual(delivered, ['thread-click-456']);
});

test('preload bridge subscriber lifecycle: queuing before subscribe, single delivery, and unsubscribe cleanup', async () => {
  // Model preload.js subscription set and pending buffer
  const openThreadListeners = new Set();
  let pendingOpenThread = null;

  const onIpcEvent = (threadId) => {
    if (openThreadListeners.size === 0) {
      pendingOpenThread = threadId;
      return;
    }
    for (const listener of openThreadListeners) {
      try { listener(threadId); } catch {}
    }
  };

  const subscribe = (callback) => {
    if (typeof callback !== 'function') throw new Error('Open-thread listener must be a function');
    openThreadListeners.add(callback);
    if (pendingOpenThread !== null) {
      const queued = pendingOpenThread;
      pendingOpenThread = null;
      queueMicrotask(() => {
        try { callback(queued); } catch {}
      });
    }
    return () => openThreadListeners.delete(callback);
  };

  // 1. Event arrives before subscriber is mounted: must be buffered
  onIpcEvent('thread-buffered-before-mount');
  assert.equal(pendingOpenThread, 'thread-buffered-before-mount');

  // 2. Subscriber mounts: receives the queued event once
  const receivedA = [];
  const unsubA = subscribe((id) => receivedA.push(id));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(receivedA, ['thread-buffered-before-mount']);
  assert.equal(pendingOpenThread, null);

  // 3. Subsequent event arrives while mounted: dispatched immediately
  onIpcEvent('thread-live-event');
  assert.deepEqual(receivedA, ['thread-buffered-before-mount', 'thread-live-event']);

  // 4. Duplicate subscription does not duplicate Set entries
  const listenerB = (id) => receivedA.push(id);
  const unsubB1 = subscribe(listenerB);
  const unsubB2 = subscribe(listenerB);
  assert.equal(openThreadListeners.size, 2);
  unsubB1();
  assert.equal(openThreadListeners.size, 1);
  // Unsubscribe cleans up listener properly
  unsubA();
  assert.equal(openThreadListeners.size, 0);
  onIpcEvent('thread-after-unsub');
  assert.equal(receivedA.length, 2, 'unsubscribed listener receives no further events');
});
