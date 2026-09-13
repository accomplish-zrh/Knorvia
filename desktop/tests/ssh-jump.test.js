'use strict';

// C13: single-hop bastion connections. Two independent ssh2 servers act as
// bastion and internal target. The target uses a hostname that only the
// bastion can resolve ("target.internal"), so a successful connection proves
// the traffic really traversed the bastion. Fingerprint challenges are
// per-host, deletion of a referenced bastion is refused, and closing the
// jumped session leaves an independent session untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const { Server, utils } = require('ssh2');
const { createSshSessions } = require('../ssh-session');
const STATUS = utils.sftp.STATUS_CODE;

const hostKeyOf = label => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });

function sshFixture({ password, hostKey, onDirectTcpip, forwarding }) {
  const clients = new Set();
  const seenOpens = [];
  const server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => ctx.method === 'password' && ctx.password === password ? ctx.accept() : ctx.reject());
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('pty', acceptPty => acceptPty());
        session.on('shell', acceptShell => { const stream = acceptShell(); stream.write('fixture ready\r\n'); stream.on('data', data => stream.write(data)); });
        session.on('sftp', acceptSftp => {
          const sftp = acceptSftp();
          sftp.on('REALPATH', (id, name) => sftp.name(id, [{ filename: name === '.' ? '/workspace' : name, longname: name, attrs: {} }]));
          sftp.on('OPENDIR', (id, name) => {
            const handle = Buffer.alloc(4); handle.writeUInt32BE(7);
            seenOpens.push(name);
            sftp.handle(id, handle);
          });
          sftp.on('READDIR', (id, handle) => {
            const entry = { filename: 'inner.txt', longname: 'inner.txt', attrs: { mode: 33188, size: 5, uid: 0, gid: 0, atime: 0, mtime: 0 } };
            sftp.name(id, [entry]);
            sftp.name(id, []);
          });
          sftp.on('CLOSE', (id) => sftp.status(id, STATUS.OK));
        });
      });
      // Incoming direct-tcpip opens are emitted as the connection-level 'tcpip'
      // event in ssh2's server API; the upstream socket answers the channel.
      if (onDirectTcpip) client.on('tcpip', (accept, reject, info) => {
        if (forwarding) { forwarding.requests++; if (forwarding.mode === 'reject') { reject(); return; } if (forwarding.mode === 'stall') return; }
        const channel = accept();
        const upstream = onDirectTcpip(info);
        channel.on('close', () => upstream.destroy());
        upstream.on('error', () => channel.close());
        upstream.pipe(channel);
        channel.pipe(upstream);
      });
    });
  });
  return {
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: async () => { for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); },
    seenOpens,
    clients,
  };
}

async function fixture(t, { bastionSecret = 'bastion-secret', readyTimeout = 5000 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-ssh-jump-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // The internal target only listens on the real loopback port; the saved
  // host record names it as target.internal:22, which only the bastion's
  // forwarding rule can resolve.
  let targetPort;
  const forwarding = { mode: 'allow', requests: 0 };
  const target = sshFixture({
    password: 'target-secret',
    hostKey: hostKeyOf('target'),
  });
  const bastion = sshFixture({
    password: 'bastion-secret',
    hostKey: hostKeyOf('bastion'),
    forwarding,
    onDirectTcpip: info => {
      if (info.destIP === 'target.internal' && info.destPort === 22) return net.connect(targetPort, '127.0.0.1');
      const socket = net.connect(info.destPort || 1, info.destIP || '127.0.0.1');
      socket.on('error', () => {});
      return socket;
    },
  });
  const bastionPort = await bastion.listen();
  targetPort = await target.listen();
  t.after(() => bastion.close());
  t.after(() => target.close());
  const rpc = async () => ({ workspace: { id: 'fixture', cwd: home }, absolutePath: home, kind: 'file' });
  const fakeStorage = { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(`enc:${v}`), decryptString: b => b.toString().slice(4) };
  const manager = createSshSessions({ home, rpc, safeStorage: fakeStorage, readyTimeout });
  t.after(() => manager.dispose());
  const call = (method, params = {}) => manager.handlers[method](params);
  const bastionHost = await call('ssh/host/save', { name: 'Bastion', hostname: '127.0.0.1', port: bastionPort, username: 'keeper', auth: 'password', root: '/workspace', ...(bastionSecret ? { secret: bastionSecret } : {}) });
  const targetHost = await call('ssh/host/save', { name: 'Internal', hostname: 'target.internal', port: 22, username: 'inner', auth: 'password', root: '/workspace', jumpHostId: bastionHost.id });
  const trustAll = async () => {
    for (const challenge of (await call('ssh/host/list')).pendingTrust) {
      await call('ssh/host/trust', { id: challenge.hostId, revision: challenge.revision, fingerprint: challenge.fingerprint });
    }
  };
  const open = async (host, secret, extra = {}) => {
    const sessionId = randomUUID();
    const opened = await call('ssh/open', { sessionId, hostId: host.id, cols: 90, rows: 26, secret, ...extra });
    assert.equal(opened.status, 'ready');
    return sessionId;
  };
  return { home, call, trustAll, open, forwarding, dispose: () => manager.dispose(), bastionHost, targetHost, bastionSeen: bastion.seenOpens, targetSeen: target.seenOpens, bastionClients: bastion.clients, targetClients: target.clients };
}

test('a host behind a single-hop bastion connects, verifies both fingerprints and serves terminal plus SFTP', async t => {
  const f = await fixture(t);
  // First attempt: only the bastion is reached, so only its challenge exists.
  await assert.rejects(f.call('ssh/open', { sessionId: randomUUID(), hostId: f.targetHost.id, cols: 80, rows: 24, secret: 'target-secret' }), e => {
    assert.equal(e.rpc.code, -32087);
    assert.equal(e.rpc.data.hostId, f.bastionHost.id, 'the first challenge names the bastion');
    return true;
  });
  await f.trustAll();
  // Second attempt: through the trusted bastion, the target presents its own.
  await assert.rejects(f.call('ssh/open', { sessionId: randomUUID(), hostId: f.targetHost.id, cols: 80, rows: 24, secret: 'target-secret' }), e => {
    if (process.env.KNORVIA_DEBUG_TRANSFER) console.log('ATTEMPT2', e.rpc?.code, e.rpc?.message);
    assert.equal(e.rpc.code, -32087);
    assert.equal(e.rpc.data.hostId, f.targetHost.id, 'the second challenge names the target');
    return true;
  });
  await f.trustAll();
  const sessionId = await f.open(f.targetHost, 'target-secret');
  assert.equal(f.bastionSeen.length, 0, 'no SFTP directory was opened on the bastion itself');
  const read = await f.call('ssh/read', { sessionId, cursor: 0 });
  assert.ok(read.data.includes('fixture ready'), 'the terminal runs on the internal target');
  const listing = await f.call('ssh/files/list', { sessionId, path: '' });
  assert.equal(listing.entries[0].name, 'inner.txt', 'SFTP flows through the same jumped connection');
});

test('direct access to the internal hostname fails, proving traversal goes through the bastion', async t => {
  const f = await fixture(t);
  await f.trustAll().catch(() => {});
  const directHost = await f.call('ssh/host/save', { name: 'Direct', hostname: 'target.internal', port: 22, username: 'inner', auth: 'password', root: '/workspace' });
  await assert.rejects(f.call('ssh/open', { sessionId: randomUUID(), hostId: directHost.id, cols: 80, rows: 24, secret: 'target-secret' }), error => {
    assert.equal(error.rpc.code, -32085);
    return true;
  });
});

test('bastion and target fingerprint changes surface as separate per-host challenges', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('ssh/open', { sessionId: randomUUID(), hostId: f.targetHost.id, cols: 80, rows: 24, secret: 'target-secret' }), e => e.rpc.code === -32087);
  await f.trustAll();
  await assert.rejects(f.call('ssh/open', { sessionId: randomUUID(), hostId: f.targetHost.id, cols: 80, rows: 24, secret: 'target-secret' }), e => e.rpc.code === -32087);
  await f.trustAll();
  // Change the recorded target fingerprint: the next connect challenges for
  // the target host specifically, with the previous fingerprint attached.
  const store = require('../ssh-store');
  const fakeStorage = { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(`enc:${v}`), decryptString: b => b.toString().slice(4) };
  const storeInstance = store.createSshStore({ home: f.home, safeStorage: fakeStorage });
  const target = storeInstance.list().hosts.find(h => h.id === f.targetHost.id);
  await storeInstance.update(target.id, target.revision, { fingerprint: 'SHA256:stale-rotated' });
  await assert.rejects(f.call('ssh/open', { sessionId: randomUUID(), hostId: f.targetHost.id, cols: 80, rows: 24, secret: 'target-secret' }), e => {
    assert.equal(e.rpc.code, -32087);
    assert.equal(e.rpc.data.hostId, f.targetHost.id, 'the challenge names the target host');
    assert.equal(e.rpc.data.previousFingerprint, 'SHA256:stale-rotated');
    return true;
  });
  const pending = (await f.call('ssh/host/list')).pendingTrust;
  assert.ok(pending.some(c => c.hostId === f.targetHost.id && c.previousFingerprint === 'SHA256:stale-rotated'));
});

test('self-reference, chains and deleting a referenced bastion are refused; delete order works', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('ssh/host/save', { ...f.bastionHost, jumpHostId: f.bastionHost.id }), e => e.rpc.code === -32602);
  // A chain: the target already jumps via the bastion; saving the bastion to
  // jump via the target would form a cycle and is rejected.
  await assert.rejects(f.call('ssh/host/save', { ...f.bastionHost, jumpHostId: f.targetHost.id }), e => e.rpc.code === -32602);
  // Deleting the referenced bastion fails with a clear dependency message.
  await assert.rejects(f.call('ssh/host/delete', { id: f.bastionHost.id, revision: f.bastionHost.revision }), e => {
    assert.equal(e.rpc.code, -32005);
    assert.match(e.rpc.message, /jump host/i);
    return true;
  });
  // Deleting the dependent target first, then the bastion, works.
  await f.call('ssh/host/delete', { id: f.targetHost.id, revision: f.targetHost.revision });
  await f.call('ssh/host/delete', { id: f.bastionHost.id, revision: f.bastionHost.revision });
});

test('closing the jumped session only tears down its own chain', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('ssh/open', { sessionId: randomUUID(), hostId: f.targetHost.id, cols: 80, rows: 24, secret: 'target-secret' }), e => e.rpc.code === -32087);
  await f.trustAll();
  await assert.rejects(f.call('ssh/open', { sessionId: randomUUID(), hostId: f.targetHost.id, cols: 80, rows: 24, secret: 'target-secret' }), e => e.rpc.code === -32087);
  await f.trustAll();
  const jumped = await f.open(f.targetHost, 'target-secret');
  const directToBastion = await f.open(f.bastionHost, 'bastion-secret');
  await f.call('ssh/close', { sessionId: jumped });
  await assert.rejects(f.call('ssh/write', { sessionId: jumped, seq: 1, data: 'no' }), e => e.rpc.code === -32085);
  const stillOpen = await f.call('ssh/read', { sessionId: directToBastion, cursor: 0 });
  assert.ok(stillOpen.data.includes('fixture ready'), 'the independent session survives');
  const listed = await f.call('ssh/list', {});
  const surviving = listed.find(s => s.sessionId === directToBastion);
  assert.equal(surviving.status, 'ready');
});

test('a bastion password typed for one connect authenticates both hops and is never persisted', async t => {
  const f = await fixture(t, { bastionSecret: null });
  // No saved credential and nothing typed: an explicit prompt, before any socket opens.
  await assert.rejects(f.call('ssh/open', { sessionId: randomUUID(), hostId: f.targetHost.id, cols: 80, rows: 24, secret: 'target-secret' }), e => {
    assert.equal(e.rpc.code, -32602);
    assert.match(e.rpc.message, /jump host password/i);
    return true;
  });
  await assert.rejects(f.call('ssh/open', { sessionId: randomUUID(), hostId: f.targetHost.id, cols: 80, rows: 24, secret: 'target-secret', jumpSecret: 'bastion-secret' }), e => {
    assert.equal(e.rpc.code, -32087);
    assert.equal(e.rpc.data.hostId, f.bastionHost.id, 'the transient credential reached the bastion, which then challenged');
    return true;
  });
  await f.trustAll();
  await assert.rejects(f.call('ssh/open', { sessionId: randomUUID(), hostId: f.targetHost.id, cols: 80, rows: 24, secret: 'target-secret', jumpSecret: 'bastion-secret' }), e => e.rpc.code === -32087 && e.rpc.data.hostId === f.targetHost.id);
  await f.trustAll();
  const sessionId = await f.open(f.targetHost, 'target-secret', { jumpSecret: 'bastion-secret' });
  const read = await f.call('ssh/read', { sessionId, cursor: 0 });
  assert.ok(read.data.includes('fixture ready'), 'the terminal runs on the internal target through the transient bastion credential');
  // Nothing was written back: the host record still reports no secret and the
  // store file holds no copy of either password.
  const bastion = (await f.call('ssh/host/list')).hosts.find(h => h.id === f.bastionHost.id);
  assert.equal(bastion.hasSecret, false, 'a transient bastion password must not be saved');
  const target = (await f.call('ssh/host/list')).hosts.find(h => h.id === f.targetHost.id);
  assert.equal(target.hasSecret, false);
  const persisted = fs.readFileSync(path.join(f.home, 'config', 'ssh-hosts.json'), 'utf8');
  assert.ok(!persisted.includes('bastion-secret') && !persisted.includes('target-secret'), 'no plaintext credential in the store file');
});

test('malformed credentials are refused before a connection is attempted', async t => {
  const f = await fixture(t);
  const attempts = [
    { secret: 'target-secret', jumpSecret: 42 },
    { secret: 'target-secret', jumpSecret: 'a'.repeat(20000) },
    { secret: 'target-secret', jumpSecret: 'bad\0secret' },
    { secret: 'bad\0secret' },
  ];
  for (const extra of attempts) {
    await assert.rejects(f.call('ssh/open', { sessionId: randomUUID(), hostId: f.targetHost.id, cols: 80, rows: 24, ...extra }), e => e.rpc.code === -32602, `expected -32602 for ${JSON.stringify(Object.keys(extra))}`);
  }
  assert.equal((await f.call('ssh/list', {})).length, 0, 'no session was created by a refused open');
});

test('a dropped target connection releases the bastion hop instead of leaving a live tunnel', async t => {
  const f = await fixture(t);
  const settle = async (predicate, what, timeoutMs = 8000) => {
    const started = Date.now();
    for (;;) {
      if (await predicate()) return;
      if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  await assert.rejects(f.call('ssh/open', { sessionId: randomUUID(), hostId: f.targetHost.id, cols: 80, rows: 24, secret: 'target-secret' }), e => e.rpc.code === -32087);
  await f.trustAll();
  await assert.rejects(f.call('ssh/open', { sessionId: randomUUID(), hostId: f.targetHost.id, cols: 80, rows: 24, secret: 'target-secret' }), e => e.rpc.code === -32087);
  await f.trustAll();
  const sessionId = await f.open(f.targetHost, 'target-secret');
  assert.ok(f.bastionClients.size >= 1, 'the jumped session holds a live bastion transport');
  assert.ok(f.targetClients.size >= 1, 'the internal target really accepted the tunnelled connection');
  for (const client of [...f.targetClients]) client.end();
  await settle(async () => (await f.call('ssh/list', {})).find(s => s.sessionId === sessionId)?.status === 'disconnected', 'the session to report disconnected');
  await settle(() => f.bastionClients.size === 0, 'the bastion hop to be released');
});


async function settle(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function trustedFixture(t) {
  const f = await fixture(t, { readyTimeout: 1500 });
  await assert.rejects(f.open(f.targetHost, 'target-secret'), e => e.rpc.code === -32087);
  await f.trustAll();
  await assert.rejects(f.open(f.targetHost, 'target-secret'), e => e.rpc.code === -32087);
  await f.trustAll();
  const warmup = await f.open(f.targetHost, 'target-secret');
  await f.call('ssh/close', { sessionId: warmup });
  await settle(() => f.bastionClients.size === 0 && f.targetClients.size === 0, 'warmup transports to exit');
  return f;
}
async function survivingSessionStillWorks(f, id) {
  await f.call('ssh/write', { sessionId: id, seq: 1, data: 'after-failed-hop\n' });
  await settle(async () => (await f.call('ssh/read', { sessionId: id, cursor: 0 })).data.includes('after-failed-hop'), 'fresh bystander terminal echo');
  assert.equal((await f.call('ssh/files/list', { sessionId: id, path: '' })).entries[0].name, 'inner.txt');
}

test('a refused forwardOut releases its bastion and leaves another SSH session usable', async t => {
  const f = await trustedFixture(t), bystander = await f.open(f.bastionHost, 'bastion-secret');
  f.forwarding.mode = 'reject';
  await assert.rejects(f.open(f.targetHost, 'target-secret'), e => e.rpc.code === -32085);
  await settle(() => f.bastionClients.size === 1 && f.targetClients.size === 0, 'only failed chain to exit');
  await survivingSessionStillWorks(f, bystander);
  await f.dispose();
  await settle(() => f.bastionClients.size === 0, 'all owned transports after dispose');
});

test('cancelling an unanswered forwardOut joins its close without touching another SSH session', async t => {
  const f = await trustedFixture(t), bystander = await f.open(f.bastionHost, 'bastion-secret');
  f.forwarding.mode = 'stall'; const before = f.forwarding.requests, sessionId = randomUUID();
  const pending = f.call('ssh/open', { sessionId, hostId: f.targetHost.id, cols: 80, rows: 24, secret: 'target-secret' }).then(value => ({ value }), error => ({ error }));
  await settle(() => f.forwarding.requests > before, 'unanswered direct-tcpip request');
  assert.deepEqual(await f.call('ssh/close', { sessionId }), { closed: true });
  const outcome = await pending;
  assert.equal(outcome.error?.rpc.code, -32085); assert.match(outcome.error.rpc.message, /cancelled/);
  await settle(() => f.bastionClients.size === 1 && f.targetClients.size === 0, 'cancelled chain to exit');
  await survivingSessionStillWorks(f, bystander);
});

test('forwardOut has an establishment deadline and dispose cancels another in-flight hop', async t => {
  const f = await trustedFixture(t);
  f.forwarding.mode = 'stall'; const began = Date.now();
  await assert.rejects(f.open(f.targetHost, 'target-secret'), e => e.rpc.code === -32085 && /timed out/.test(e.rpc.message));
  assert.ok(Date.now() - began < 3000, 'readyTimeout also bounds the direct-tcpip wait');
  await settle(() => f.bastionClients.size === 0 && f.targetClients.size === 0, 'timed-out chain to exit');
  const before = f.forwarding.requests;
  const pending = f.open(f.targetHost, 'target-secret').then(value => ({ value }), error => ({ error }));
  await settle(() => f.forwarding.requests > before, 'second in-flight direct-tcpip request');
  assert.equal((await f.dispose()).confirmed, true);
  assert.match((await pending).error.rpc.message, /cancelled/);
  await settle(() => f.bastionClients.size === 0 && f.targetClients.size === 0, 'disposed in-flight chain to exit');
});
