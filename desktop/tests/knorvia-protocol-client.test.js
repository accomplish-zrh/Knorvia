'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeFrame, tryDecode, initializeRequest, engineCommand } = require('../knorvia-protocol-client');

test('protocol frames are Content-Length and initialize is Knorvia', () => {
  const req = initializeRequest('knorvia_desktop', '0.1.0-dev');
  assert.equal(req.params.client.name, 'knorvia_desktop');
  assert.notEqual(req.params.client.name.toLowerCase().includes('codex'), true);
  const framed = encodeFrame(JSON.stringify(req));
  assert.ok(framed.toString('ascii').startsWith('Content-Length:'));
  const decoded = tryDecode(framed);
  assert.equal(decoded.message.method, 'initialize');
  assert.equal(decoded.message.params.protocol.major, 1);
});

test('engineCommand never selects a user codex binary', () => {
  const kernel = engineCommand({
    daemonBin: 'D:\\tools\\knorvia-kernel\\knorvia-rs\\target\\debug\\knorvia-daemon.exe',
    home: 'C:\\tmp\\khome',
  });
  assert.equal(kernel.identity, 'knorvia-daemon');
  assert.ok(!String(kernel.bin).toLowerCase().includes('codex'));
  assert.ok(!String(kernel.bin).includes('ipc_bridge'));
});

test('desktop client handshake against shipped knorvia-daemon', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { startKnorviaDaemon } = require('../knorvia-protocol-client');
  const daemonBin = 'D:\\tools\\knorvia-kernel\\knorvia-rs\\target\\debug\\knorvia-daemon.exe';
  if (!fs.existsSync(daemonBin)) {
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-desktop-'));
  const session = startKnorviaDaemon({ daemonBin, home });
  try {
    const init = await session.request(initializeRequest('knorvia_desktop', '0.1.0-dev'));
    assert.equal(init.result.server.name, 'knorvia-daemon');
    assert.equal(init.result.server.product, 'Knorvia');
    session.notify({ jsonrpc: '2.0', method: 'initialized' });
    const ws = await session.request({
      jsonrpc: '2.0',
      id: 'ws1',
      method: 'workspace/create',
      params: { title: 'from-desktop' },
    });
    assert.ok(String(ws.result.id).startsWith('ws_'));
  } finally {
    session.child.kill();
  }
});
