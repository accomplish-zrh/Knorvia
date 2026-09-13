'use strict';
// CODEX-0030-C boundary verification: the browser harness drives the real
// SshFilesPanel with a shimmed workbench provider, which is NOT the full
// Electron entry chain. This test pins the actual entry wiring at the source
// level so the cursor path through the real entry points is anchored:
// RemoteWorkspace (entry) -> SshFilesPanel -> request('ssh/files/list',
// {cursor}) -> preload native-request -> native-rpc-router allow-list ->
// desktop ssh-session handler. The full application shell launch itself
// remains environment-blocked (see release notes P08) and stays an honestly
// recorded uncovered item.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const web = path.resolve(__dirname, '..', '..', 'web', 'components', 'native');
const desktop = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(web, file), 'utf8');

test('the real RemoteWorkspace entry renders SshFilesPanel with the session scope', () => {
  const source = read('RemoteWorkspace.tsx');
  assert.match(source, /import \{ SshFilesPanel \} from '\.\/SshFilesPanel'/);
  assert.match(source, /<SshFilesPanel sessionId=\{sessionId\} threadId=\{threadId\} \/>/, 'the entry passes the session identity down to the panel');
});

test('SshFilesPanel sends the cursor on continuations and cancels stale ones', () => {
  const source = read('SshFilesPanel.tsx');
  assert.match(source, /path: requestedFolder, cursor: requestedCursor \}/, 'loadMore passes the cursor');
  assert.match(source, /cancel: true/, 'stale cursors are cancelled');
  assert.match(source, /seq !== loadSeq\.current/, 'superseded responses are discarded by generation');
  assert.match(source, /truncated/, 'the truncation flag is consumed by the UI');
});

test('the desktop allow-list routes ssh/files/list to the local handler with cursor params', () => {
  const router = fs.readFileSync(path.join(desktop, 'native-rpc-router.js'), 'utf8');
  assert.match(router, /SSH_METHODS/, 'ssh methods are part of the allow-list build');
  const session = fs.readFileSync(path.join(desktop, 'ssh-session.js'), 'utf8');
  assert.match(session, /'ssh\/files\/list'/);
  assert.match(session, /p\.cursor !== undefined && p\.cursor !== null/, 'the handler consumes the cursor');
});

test('the settings entry still wires RemoteWorkspace and the diagnostics panel', () => {
  const settings = read('SettingsView.tsx');
  assert.match(settings, /<RemoteWorkspace \/>/);
  assert.match(settings, /<RuntimeDiagnosticsPanel \/>/);
});
