'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');
const { startNativeGatewayFixture } = require('./start-native-gateway-fixture');
const { keepWindowInBackground } = require('../../window-lifecycle');

app.on('window-all-closed', () => {});
async function main() {
  await app.whenReady();
  const kernelRoot = path.resolve(__dirname, '../../../../knorvia-kernel');
  let fixture, window, socket; let quitting = false;
  try {
    fixture = await startNativeGatewayFixture({ port: 0, cleanup: true, slowDelayMs: 90000, daemonBin: process.env.KNORVIA_DAEMON_BIN || path.join(kernelRoot, 'knorvia-rs/target/release/knorvia-daemon.exe') });
    const endpoint = new URL(fixture.location.url);
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/knorvia/native/session`, { headers: { 'x-knorvia-native-origin': 'http://127.0.0.1:3000' } });
    const session = await response.json();
    socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/knorvia/native`, ['knorvia.native.v1', `knorvia.native.token.${session.token}`], { origin: 'http://127.0.0.1:3000' });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let seq = 0;
    const request = (method, params = {}) => new Promise((resolve, reject) => {
      const id = `background-${++seq}`;
      const timer = setTimeout(() => { socket.off('message', listener); reject(new Error(`Timeout: ${method}`)); }, 20000);
      const listener = data => { const msg = JSON.parse(data); if (msg.id !== id) return; clearTimeout(timer); socket.off('message', listener); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); };
      socket.on('message', listener); socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
    const workspaces = await request('workspace/list');
    const workspace = workspaces[0] || await request('workspace/create', { title: 'Background fixture', cwd: fixture.workspace });
    const thread = await request('thread/start', { workspaceId: workspace.id, cwd: fixture.workspace, title: 'Background fixture' });
    const admitted = await request('turn/start', { threadId: thread.id, input: '[slow] continue this local fixture after the window closes', cwd: fixture.workspace, tools: { write: false } });
    const turnId = admitted.turn?.id || admitted.id;
    const deadline = Date.now() + 45000;
    while (!fixture.responses.requests.some(r => r.kind === 'slow')) { assert.ok(Date.now() < deadline, 'slow Responses request started'); await delay(100); }
    window = new BrowserWindow({ show: false, width: 600, height: 360, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    keepWindowInBackground(window, () => !quitting);
    await window.loadURL(`data:text/html,${encodeURIComponent(`<main data-thread="${thread.id}">Background fixture task</main>`)}`);
    window.showInactive(); assert.equal(window.isVisible(), true);
    window.close(); await delay(200);
    assert.equal(window.isDestroyed(), false); assert.equal(window.isVisible(), false);
    const during = await request('turn/read', { id: turnId });
    assert.ok(!['completed', 'failed', 'cancelled', 'interrupted'].includes(during.status), JSON.stringify(during));
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(__dirname, '../../creative-cli.js'), '--home', fixture.home, 'status'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 15000 });
    const external = JSON.parse(stdout); assert.equal(external.ok, true); assert.equal(external.result.pid, process.pid);
    assert.equal(fixture.responses.releaseSlowTurns(), 1);
    let complete; do { await delay(100); complete = await request('turn/read', { id: turnId }); } while (complete.status !== 'completed' && Date.now() < deadline);
    assert.equal(complete.status, 'completed');
    window.showInactive(); assert.equal(window.isVisible(), true);
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("main").dataset.thread'), thread.id);
    const snapshot = await request('thread/read', { id: thread.id });
    assert.equal(snapshot.thread?.id || snapshot.id, thread.id);
    quitting = true;
    await new Promise(resolve => { window.once('closed', resolve); window.close(); });
    assert.equal(window.isDestroyed(), true);
    socket.terminate(); socket = null; await fixture.close();
    assert.equal(fs.existsSync(path.join(fixture.home, 'state/creative-cli.json')), false);
    process.stdout.write(`WINDOW_BACKGROUND_EVIDENCE ${JSON.stringify({ actualBrowserWindow: true, hiddenWhileRunning: true, sameProcess: true, sameThread: true, completed: true, explicitExitCleanedDiscovery: true })}\n`);
    fixture = null;
  } finally {
    quitting = true; if (window && !window.isDestroyed()) window.destroy(); socket?.terminate(); await fixture?.close();
  }
}
main().then(() => app.exit(0), error => { process.stderr.write(`${error.stack || error}\n`); app.exit(1); });
