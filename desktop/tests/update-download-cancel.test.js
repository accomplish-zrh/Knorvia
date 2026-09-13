'use strict';
// Only the original download manager and startup fallback are integrated.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveDownloadsRoot } = require('../update-download');

test('default downloads resolution returns unavailable when the native lookup throws', () => {
  const result = resolveDownloadsRoot(() => { throw new Error("Failed to get 'downloads' path"); });
  assert.equal(result.dir, null);
  assert.match(result.error, /downloads/);
});

test('default downloads resolution uses the actual platform directory', () => {
  const result = resolveDownloadsRoot(name => { assert.equal(name, 'downloads'); return 'D:/downloads'; });
  assert.equal(result.dir, path.join('D:/downloads', 'Knorvia'));
  assert.equal(result.error, null);
});

test('an unavailable default directory is not replaced with a guessed directory', () => {
  const result = resolveDownloadsRoot(() => '');
  assert.equal(result.dir, null);
  assert.match(result.error, /unavailable/);
});
