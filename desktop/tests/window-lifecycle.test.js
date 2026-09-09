'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { keepWindowInBackground } = require('../window-lifecycle');

test('closing a view keeps the host alive, while explicit Quit and missing tray allow shutdown', () => {
  const view = new EventEmitter();
  let hidden = 0; let prevented = 0; let quitting = false; let tray = true;
  view.hide = () => hidden++;
  const remove = keepWindowInBackground(view, () => tray && !quitting);
  const close = () => view.emit('close', { preventDefault: () => prevented++ });
  close(); close();
  assert.equal(hidden, 2);
  assert.equal(prevented, 2);
  quitting = true; close();
  assert.equal(prevented, 2);
  quitting = false; tray = false; close();
  assert.equal(prevented, 2);
  remove(); assert.equal(view.listenerCount('close'), 0);
});
