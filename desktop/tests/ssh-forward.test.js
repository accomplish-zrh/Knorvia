'use strict';

// RF-D01: controlled local SSH port forwarding. A real ssh2 server (with
// connection-level 'tcpip' handling) bridges loopback listeners to two remote
// HTTP echo services, proving traffic traversal, isolation between forwards,
// explicit port-conflict failure, teardown on disconnect and the loopback-only
// contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const { Server, utils } = require('ssh2');
const { createSshSessions } = require('../ssh-session');
const STATUS = utils.sftp.STATUS_CODE;

function echoServer(tag) {
  const connections = [];
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`${tag}:${req.url}`);
  });
  server.on('connection', socket => connections.push(socket));
  const close = async () => { for (const socket of connections) socket.destroy(); await new Promise(resolve => server.close(resolve)); };
  const listen = () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  return { listen, close };
}

async function fixture(t, { maxConcurrentChannels } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-ssh-forward-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const echoA = echoServer('svc-a'), echoB = echoServer('svc-b');
  const portA = await echoA.listen(), portB = await echoB.listen();
  t.after(() => echoA.close());
  t.after(() => echoB.close());
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
  const clients = new Set();
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => ctx.method === 'password' && ctx.password === 'fixture-secret' ? ctx.accept() : ctx.reject());
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('pty', acceptPty => acceptPty());
        session.on('shell', acceptShell => { const stream = acceptShell(); stream.write('fixture ready\r\n'); stream.on('data', data => stream.write(data)); });
        session.on('sftp', acceptSftp => { const sftp = acceptSftp(); sftp.on('REALPATH', (id, name) => sftp.name(id, [{ filename: name === '.' ? '/workspace' : name, longname: name, attrs: {} }])); sftp.on('CLOSE', id => sftp.status(id, STATUS.OK)); });
      });
      // Incoming direct-tcpip opens arrive as connection-level 'tcpip'.
      client.on('tcpip', (accept, reject, info) => {
        const channel = accept();
        const upstream = netConnect(info.destPort, info.destIP);
        channel.on('close', () => upstream.destroy());
        upstream.on('error', () => channel.close());
        upstream.pipe(channel);
        channel.pipe(upstream);
      });
    });
  });
  function netConnect(port, host) {
    const net = require('node:net');
    return net.connect(port, host === 'svc-a.internal' ? '127.0.0.1' : host === 'svc-b.internal' ? '127.0.0.1' : host);
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sshPort = server.address().port;
  t.after(async () => { for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });
  const rpc = async () => ({ workspace: { id: 'fixture', cwd: home }, absolutePath: home, kind: 'file' });
  const manager = createSshSessions({ home, rpc, readyTimeout: 5000, ...(maxConcurrentChannels ? { maxConcurrentChannels } : {}) });
  t.after(() => manager.dispose());
  const call = (method, params = {}) => manager.handlers[method](params);
  const host = await call('ssh/host/save', { name: 'Fixture', hostname: '127.0.0.1', port: sshPort, username: 'fixture', auth: 'password', root: '/workspace' });
  await assert.rejects(call('ssh/open', { sessionId: randomUUID(), hostId: host.id, cols: 80, rows: 24, secret: 'fixture-secret' }), e => e.rpc.code === -32087);
  const pending = (await call('ssh/host/list')).pendingTrust[0];
  await call('ssh/host/trust', { id: host.id, revision: host.revision, fingerprint: pending.fingerprint });
  const open = async () => {
    const sessionId = randomUUID();
    const opened = await call('ssh/open', { sessionId, hostId: host.id, cols: 90, rows: 26, secret: 'fixture-secret' });
    assert.equal(opened.status, 'ready');
    return sessionId;
  };
  const httpGet = (port, urlPath) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
  });
  return { home, call, open, sshPort, portA, portB, httpGet };
}

test('local forwards reach remote services; two forwards stay isolated', async t => {
  const f = await fixture(t);
  const sessionId = await f.open();
  const first = await f.call('ssh/forward/start', { sessionId, remoteHost: 'svc-a.internal', remotePort: f.portA });
  const second = await f.call('ssh/forward/start', { sessionId, remoteHost: 'svc-b.internal', remotePort: f.portB });
  assert.equal(first.status, 'active');
  assert.ok(first.localPort >= 1024 && first.localPort !== second.localPort);
  const viaFirst = await f.httpGet(first.localPort, '/one');
  const viaSecond = await f.httpGet(second.localPort, '/two');
  assert.equal(viaFirst.body, 'svc-a:/one', 'the first forward reaches service A only');
  assert.equal(viaSecond.body, 'svc-b:/two', 'the second forward reaches service B only');
  const listing = (await f.call('ssh/forward/list', { sessionId })).forwards;
  assert.equal(listing.filter(x => x.status === 'active').length, 2);
  assert.equal(listing[0].connectionsServed >= 1, true);
});

test('an occupied local port fails explicitly and leaves other listeners untouched', async t => {
  const f = await fixture(t);
  const sessionId = await f.open();
  const healthy = await f.call('ssh/forward/start', { sessionId, remoteHost: 'svc-a.internal', remotePort: f.portA });
  await f.httpGet(healthy.localPort, '/warmup');
  // The SSH server's own port is definitely occupied by another listener.
  await assert.rejects(
    f.call('ssh/forward/start', { sessionId, remoteHost: 'svc-b.internal', remotePort: f.portB, localPort: f.sshPort }),
    e => { assert.equal(e.rpc.code, -32053); assert.match(e.rpc.message, /already in use/i); return true; },
  );
  assert.equal((await f.httpGet(healthy.localPort, '/after')).body, 'svc-a:/after', 'the healthy forward keeps serving');
});

test('closing a forward releases exactly its listener; the terminal and other forwards continue', async t => {
  const f = await fixture(t);
  const sessionId = await f.open();
  const keep = await f.call('ssh/forward/start', { sessionId, remoteHost: 'svc-a.internal', remotePort: f.portA });
  const drop = await f.call('ssh/forward/start', { sessionId, remoteHost: 'svc-b.internal', remotePort: f.portB });
  const close = await f.call('ssh/forward/close', { sessionId, forwardId: drop.forwardId });
  assert.equal(close.closed, true);
  assert.equal(close.forward.status, 'closed');
  await new Promise(resolve => setTimeout(resolve, 120));
  await assert.rejects(f.httpGet(drop.localPort, '/gone'), error => /ECONNREFUSED|timeout/.test(error.message) || error.code === 'ECONNRESET');
  assert.equal((await f.httpGet(keep.localPort, '/still')).body, 'svc-a:/still');
  const read = await f.call('ssh/read', { sessionId, cursor: 0 });
  assert.ok(read.data.includes('fixture ready'), 'the terminal survives a forward close');
  await assert.rejects(f.call('ssh/forward/close', { sessionId, forwardId: 'no-such' }), e => e.rpc.code === -32004);
});

test('SSH disconnect releases every listener as detached', async t => {
  const f = await fixture(t);
  const sessionId = await f.open();
  const first = await f.call('ssh/forward/start', { sessionId, remoteHost: 'svc-a.internal', remotePort: f.portA });
  const second = await f.call('ssh/forward/start', { sessionId, remoteHost: 'svc-b.internal', remotePort: f.portB });
  await f.call('ssh/close', { sessionId });
  await new Promise(resolve => setTimeout(resolve, 150));
  const listing = (await f.call('ssh/forward/list', { sessionId })).forwards.filter(x => [first.forwardId, second.forwardId].includes(x.forwardId));
  assert.equal(listing.every(x => x.status === 'detached'), true);
  await assert.rejects(f.httpGet(first.localPort, '/gone'), () => true);
  await assert.rejects(f.httpGet(second.localPort, '/gone'), () => true);
});

test('untrusted sessions, invalid ports, bind-host attempts and channel limits are refused cleanly', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('ssh/forward/start', { sessionId: randomUUID(), remoteHost: 'svc-a.internal', remotePort: f.portA }), e => e.rpc.code === -32084);
  const sessionId = await f.open();
  for (const params of [
    { remoteHost: 'svc-a.internal', remotePort: 0 },
    { remoteHost: 'svc-a.internal', remotePort: 70000 },
    { remoteHost: '', remotePort: f.portA },
    { remoteHost: 'svc a', remotePort: f.portA },
    { remoteHost: 'svc-a.internal', remotePort: f.portA, localPort: 70000 },
    { remoteHost: 'svc-a.internal', remotePort: f.portA, localHost: '0.0.0.0' },
  ]) {
    await assert.rejects(f.call('ssh/forward/start', { sessionId, ...params }), e => e.rpc.code === -32602, JSON.stringify(params));
  }
});

test('channel limits refuse extra concurrent streams without killing the forward', async t => {
  const g = await fixture(t, { maxConcurrentChannels: 1 });
  const sessionId = await g.open();
  const forward = await g.call('ssh/forward/start', { sessionId, remoteHost: 'svc-a.internal', remotePort: g.portA });
  assert.equal(forward.status, 'active');
  const net = require('node:net');
  const firstSocket = net.connect(forward.localPort, '127.0.0.1');
  await new Promise(resolve => firstSocket.once('connect', resolve));
  // A second concurrent stream exceeds the cap: it is destroyed immediately.
  const secondSocket = net.connect(forward.localPort, '127.0.0.1');
  await new Promise(resolve => secondSocket.once('close', resolve));
  assert.equal(secondSocket.destroyed, true);
  firstSocket.destroy();
  // The forward itself stays active and keeps serving later streams.
  await new Promise(resolve => setTimeout(resolve, 100));
  const later = await g.httpGet(forward.localPort, '/later');
  assert.equal(later.body, 'svc-a:/later');
  const [record] = (await g.call('ssh/forward/list', { sessionId })).forwards;
  assert.equal(record.status, 'active');
});
