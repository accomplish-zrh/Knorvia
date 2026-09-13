'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Execute the shipped preload file. Only Electron's host boundary is replaced;
// none of the listener, queuing, or cleanup implementation is copied here.
function preload() {
  const ipcRenderer = new EventEmitter();
  let desktop;
  vm.runInNewContext(fs.readFileSync(process.env.KNORVIA_C06_PRELOAD_SOURCE || path.join(__dirname, '../preload.js'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return { ipcRenderer, contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'knorviaDesktop'); desktop = value; } } };
    },
    process: { platform: process.platform, argv: [] },
    queueMicrotask,
  }, { filename: 'desktop/preload.js' });
  return { subscribe: desktop.notifications.onOpenThread, click: id => ipcRenderer.emit('knorvia:open-thread', {}, id) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('actual preload retains only the latest pending click and delivers it once after mounting', async () => {
  const bridge = preload(), received = [];
  bridge.click('thread-a'); bridge.click('thread-b');
  bridge.subscribe(id => received.push(id));
  await flush(); await flush();
  assert.deepEqual(received, ['thread-b']);
});

test('actual preload preserves pending click if its first subscriber unmounts before delivery', async () => {
  const bridge = preload(), stale = [], mounted = [];
  bridge.click('thread-a');
  bridge.subscribe(id => stale.push(id))();
  await flush();
  assert.deepEqual(stale, [], 'unmounted shell must not navigate');
  bridge.subscribe(id => mounted.push(id));
  await flush();
  assert.deepEqual(mounted, ['thread-a'], 'the click survives until an active shell mounts');
});

test('actual preload handles React cleanup/remount in the same microtask turn', async () => {
  const bridge = preload(), first = [], second = [];
  bridge.click('thread-a');
  bridge.subscribe(id => first.push(id))();
  bridge.subscribe(id => second.push(id));
  await flush();
  assert.deepEqual(first, []);
  assert.deepEqual(second, ['thread-a']);
});

test('a newer live click supersedes an older mount microtask', async () => {
  const bridge = preload(), received = [];
  bridge.click('thread-a');
  bridge.subscribe(id => received.push(id));
  bridge.click('thread-b');
  await flush();
  assert.deepEqual(received, ['thread-b']);
});

test('unsubscribing during live dispatch suppresses a removed subscriber; cleanup is idempotent', () => {
  const bridge = preload(), received = [];
  let removeSecond;
  const removeFirst = bridge.subscribe(() => removeSecond());
  const second = id => received.push(id);
  removeSecond = bridge.subscribe(second);
  bridge.click('thread-a');
  assert.deepEqual(received, []);
  removeFirst();
  bridge.subscribe(second);
  removeSecond(); // old cleanup cannot remove a subsequently mounted listener
  bridge.click('thread-b');
  assert.deepEqual(received, ['thread-b']);
});

test('duplicate callback subscription does not duplicate delivery and exceptions do not block other listeners', () => {
  const bridge = preload(), received = [];
  const listener = id => received.push(id);
  bridge.subscribe(() => { throw new Error('fixture listener failed'); });
  bridge.subscribe(listener); bridge.subscribe(listener);
  bridge.click('thread-a');
  assert.deepEqual(received, ['thread-a']);
  assert.throws(() => bridge.subscribe(null), /must be a function/);
});
