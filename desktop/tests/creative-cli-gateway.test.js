'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const WebSocket = require('ws');
const { startNativeGatewayFixture } = require('./fixtures/start-native-gateway-fixture');
const { discoveryFor } = require('../creative-cli');
const run = promisify(execFile);

test('independent creative CLI attaches to the actual gateway and shares learning with native UI RPC', { timeout: 120000 }, async () => {
  const kernelRoot = path.resolve(__dirname, '../../../knorvia-kernel');
  const fixture = await startNativeGatewayFixture({ port: 0, cleanup: true, daemonBin: process.env.KNORVIA_DAEMON_BIN || path.join(kernelRoot, 'knorvia-rs/target/release/knorvia-daemon.exe') });
  let socket;
  try {
    const discovery = discoveryFor(fixture.home); assert.ok(discovery, 'gateway startup publishes the authenticated CLI endpoint');
    const cli = async (command, params = {}) => {
      const { stdout } = await run(process.execPath, [path.join(__dirname, '../creative-cli.js'), '--home', fixture.home, command, JSON.stringify(params)], { windowsHide: true, timeout: 30000 });
      const response = JSON.parse(stdout); assert.equal(response.ok, true, stdout); return response.result;
    };
    const status = await cli('status'); assert.equal(status.pid, process.pid, 'the external CLI attaches to the gateway, without a second daemon');
    const endpoint = new URL(fixture.location.url);
    const sessionResponse = await fetch(`http://127.0.0.1:${endpoint.port}/knorvia/native/session`, { headers: { 'x-knorvia-native-origin': 'http://127.0.0.1:3000' } });
    assert.equal(sessionResponse.status, 200); const session = await sessionResponse.json();
    socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/knorvia/native`, ['knorvia.native.v1', `knorvia.native.token.${session.token}`], { origin: 'http://127.0.0.1:3000' });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let seq = 0;
    const request = (method, params = {}) => new Promise((resolve, reject) => {
      const id = `learning-${++seq}`;
      const timeout = setTimeout(() => { socket.off('message', listener); reject(new Error(`Native request timed out: ${method}`)); }, 15000);
      const listener = data => { const msg = JSON.parse(data); if (msg.id !== id) return; clearTimeout(timeout); socket.off('message', listener); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); };
      socket.on('message', listener); socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
    const source = await cli('library.write', { path: '资料/gateway.md', text: '# 网关材料\n桌面与外部助手共享同一资料。' });
    const sources = await request('learning/sources'); assert.ok(sources.sources.some(s => s.id === source.id && s.version === source.sha256));
    const lecture = await request('learning/lecture/create', { topic: '共享学习', authorship: 'deterministic', sourceRefs: [{ id: source.id, version: source.sha256 }] });
    assert.deepEqual(await cli('learning.lecture.read', { path: lecture.path }), lecture);
    const listing = await cli('library.list'); assert.equal(listing.entries.find(e => e.path === lecture.path).sha256, lecture.sha256);
    const tools = await cli('tools.list'); assert.ok(tools.tools.some(t => t.name === 'learning_quiz'));
    await assert.rejects(request('learning/lecture/create', { topic: 'missing source' }), /资料/);
  } finally {
    socket?.terminate(); await fixture.close(); assert.equal(fs.existsSync(path.join(fixture.home, 'state/creative-cli.json')), false, 'gateway shutdown removes the discovery endpoint');
  }
});
