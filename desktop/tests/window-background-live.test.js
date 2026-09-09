'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');

test('actual Electron window hides while the same Kernel turn continues, restores, and explicitly quits', { timeout: 120000 }, async () => {
  const electron = require('electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(electron, [path.join(__dirname, 'fixtures/window-background-live.js')], { env, windowsHide: true, timeout: 110000, maxBuffer: 2 * 1024 * 1024 });
  const line = stdout.split(/\r?\n/).find(item => item.startsWith('WINDOW_BACKGROUND_EVIDENCE '));
  assert.ok(line, stdout);
  const evidence = JSON.parse(line.slice('WINDOW_BACKGROUND_EVIDENCE '.length));
  assert.equal(evidence.actualBrowserWindow, true);
  assert.equal(evidence.hiddenWhileRunning, true);
  assert.equal(evidence.sameProcess, true);
  assert.equal(evidence.sameThread, true);
  assert.equal(evidence.completed, true);
  assert.equal(evidence.explicitExitCleanedDiscovery, true);
});
