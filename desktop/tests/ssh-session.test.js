'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const { Server, utils } = require('ssh2');
const { createSshSessions, relativeRemote } = require('../ssh-session');
const { createSshStore } = require('../ssh-store');
const STATUS = utils.sftp.STATUS_CODE;
async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-ssh-')), remote = path.join(home, 'remote'); fs.mkdirSync(remote); fs.writeFileSync(path.join(remote, 'hello.txt'), '你好 remote');
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
  const received = [], sizes = [], clients = new Set();
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === 'fixture-only-secret' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', acceptPty => acceptPty());
      session.on('window-change', (acceptWindow, rejectWindow, info) => { sizes.push(info); acceptWindow?.(); });
      session.on('shell', acceptShell => { const stream = acceptShell(); stream.write('fixture ready\r\n'); stream.on('data', data => { received.push(data.toString()); if (data.toString().includes('fixture-long-output')) stream.write(Buffer.alloc(700000, 120)); else stream.write(data); }); });
      session.on('sftp', acceptSftp => {
        const sftp = acceptSftp(), handles = new Map(); let next = 0;
        const local = name => path.join(remote, path.posix.relative('/workspace', name));
        const attrs = st => ({ mode: st.mode, size: st.size, uid: 0, gid: 0, atime: 0, mtime: 0 });
        const done = (id, work) => { try { work(); } catch (error) { sftp.status(id, error.code === 'ENOENT' ? STATUS.NO_SUCH_FILE : STATUS.FAILURE); } };
        sftp.on('REALPATH', (id, name) => sftp.name(id, [{ filename: name === '.' ? '/workspace' : name === '/workspace/escape' ? '/outside/secret' : name, longname: name, attrs: {} }]));
        for (const method of ['STAT', 'LSTAT']) sftp.on(method, (id, name) => done(id, () => sftp.attrs(id, attrs(fs.statSync(local(name))))));
        sftp.on('OPENDIR', (id, name) => done(id, () => { const handle = Buffer.alloc(4); handle.writeUInt32BE(++next); handles.set(next, { entries: fs.readdirSync(local(name)).map(filename => ({ filename, longname: filename, attrs: attrs(fs.statSync(path.join(local(name), filename))) })), sent: false }); sftp.handle(id, handle); }));
        sftp.on('READDIR', (id, handle) => done(id, () => { const dir = handles.get(handle.readUInt32BE()); if (dir.sent || !dir.entries.length) sftp.status(id, STATUS.EOF); else { dir.sent = true; sftp.name(id, dir.entries); } }));
        sftp.on('OPEN', (id, name, flags) => done(id, () => { const handle = Buffer.alloc(4); handle.writeUInt32BE(++next); const fd = fs.openSync(local(name), flags & 2 ? 'w' : 'r'); handles.set(next, fd); sftp.handle(id, handle); }));
        sftp.on('READ', (id, handle, offset, length) => done(id, () => { const data = Buffer.alloc(length); const read = fs.readSync(handles.get(handle.readUInt32BE()), data, 0, length, offset); if (read) sftp.data(id, data.subarray(0, read)); else sftp.status(id, STATUS.EOF); }));
        sftp.on('WRITE', (id, handle, offset, data) => done(id, () => { fs.writeSync(handles.get(handle.readUInt32BE()), data, 0, data.length, offset); sftp.status(id, STATUS.OK); }));
        sftp.on('FSTAT', (id, handle) => done(id, () => sftp.attrs(id, attrs(fs.fstatSync(handles.get(handle.readUInt32BE()))))));
        sftp.on('CLOSE', (id, handle) => done(id, () => { const h = handle.readUInt32BE(); if (typeof handles.get(h) === 'number') fs.closeSync(handles.get(h)); handles.delete(h); sftp.status(id, STATUS.OK); }));
        sftp.on('RENAME', (id, from, to) => done(id, () => { if (fs.existsSync(local(to))) return sftp.status(id, STATUS.FAILURE); fs.renameSync(local(from), local(to)); sftp.status(id, STATUS.OK); }));
        sftp.on('REMOVE', (id, name) => done(id, () => { fs.unlinkSync(local(name)); sftp.status(id, STATUS.OK); }));
        sftp.on('close', () => { for (const fd of handles.values()) try { fs.closeSync(fd); } catch {} });
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });
  const rpc = async (method, p) => ({ workspace: { id: 'fixture', cwd: home }, absolutePath: path.join(home, p.path), kind: fs.statSync(path.join(home, p.path)).isDirectory() ? 'directory' : 'file' });
  const manager = createSshSessions({ home, rpc, readyTimeout: 3000 }); t.after(() => manager.dispose());
  const call = (method, params = {}) => manager.handlers[method](params);
  const host = await call('ssh/host/save', { name: 'Fixture', hostname: '127.0.0.1', port: server.address().port, username: 'fixture', auth: 'password', root: '/workspace' });
  return { home, remote, manager, call, host, received, sizes, disconnect: () => { for (const client of clients) client.end(); } };
}
test('real SSH host trust, PTY, idempotent input, SFTP and cancellation', async t => {
  const f = await fixture(t), credentials = { hostId: f.host.id, cols: 80, rows: 24, secret: 'fixture-only-secret' };
  await assert.rejects(f.call('ssh/open', { ...credentials, sessionId: randomUUID() }), e => e.rpc.code === -32087);
  const pending = (await f.call('ssh/host/list')).pendingTrust[0]; assert.match(pending.fingerprint, /^SHA256:/);
  await assert.rejects(f.call('ssh/host/trust', { id: f.host.id, revision: f.host.revision, fingerprint: 'wrong' }));
  await f.call('ssh/host/trust', { id: f.host.id, revision: f.host.revision, fingerprint: pending.fingerprint });
  const sessionId = randomUUID(); const opened = await f.call('ssh/open', { ...credentials, sessionId }); assert.equal(opened.status, 'ready');
  await f.call('ssh/write', { sessionId, seq: 1, data: 'echo first\r' }); await f.call('ssh/write', { sessionId, seq: 1, data: 'echo first\r' });
  await assert.rejects(f.call('ssh/write', { sessionId, seq: 1, data: 'different' }));
  await f.call('ssh/resize', { sessionId, cols: 101, rows: 35 });
  assert.equal((await f.call('ssh/files/read', { sessionId, path: 'hello.txt' })).content, '你好 remote');
  assert.ok((await f.call('ssh/files/list', { sessionId, path: '' })).entries.some(e => e.name === 'hello.txt'));
  await assert.rejects(f.call('ssh/files/read', { sessionId, path: 'escape' }), e => e.rpc.code === -32088);
  fs.writeFileSync(path.join(f.home, 'send.txt'), 'upload data');
  await f.call('ssh/files/upload', { sessionId, path: 'upload.txt', workspaceId: 'fixture', localPath: 'send.txt' });
  assert.equal(fs.readFileSync(path.join(f.remote, 'upload.txt'), 'utf8'), 'upload data');
  await assert.rejects(f.call('ssh/files/upload', { sessionId, path: 'upload.txt', workspaceId: 'fixture', localPath: 'send.txt' }));
  await f.call('ssh/files/download', { sessionId, path: 'hello.txt', workspaceId: 'fixture', name: 'received.txt' });
  assert.equal(fs.readFileSync(path.join(f.home, 'received.txt'), 'utf8'), '你好 remote');
  await assert.rejects(f.call('ssh/files/download', { sessionId, path: 'hello.txt', workspaceId: 'fixture', name: 'received.txt' }));
  assert.equal(f.received.filter(x => x.includes('echo first')).length, 1); assert.equal(f.sizes.at(-1).cols, 101);
  assert.equal(fs.readFileSync(path.join(f.home, 'config', 'ssh-hosts.json'), 'utf8').includes('fixture-only-secret'), false);
  assert.equal(new createSshStore({ home: f.home }).list().hosts[0].fingerprint, pending.fingerprint);
  await f.call('ssh/close', { sessionId }); await assert.rejects(f.call('ssh/write', { sessionId, seq: 2, data: 'never' }));
  await assert.rejects(f.call('ssh/open', { ...credentials, sessionId }));
});
test('host changes clear stored credentials and stale revisions are rejected', async t => {
  const f = await fixture(t); const fakeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`encrypted:${value}`), decryptString: value => value.toString().slice(10) };
  const store = createSshStore({ home: f.home, safeStorage: fakeStorage });
  let host = store.save({ ...f.host, secret: 'one-host-only' }); assert.equal(host.hasSecret, true);
  host = store.save({ ...host, hostname: 'different.example' }); assert.equal(host.hasSecret, false);
  await assert.rejects(f.call('ssh/host/save', { ...f.host, revision: 0 }));
  for (const value of ['../a', '/etc/passwd', 'a/../../b', 'a\\b', 'a\0b']) assert.throws(() => relativeRemote(value));
});
test('a changed host fingerprint cannot be trusted without explicit replacement', async t => {
  const f = await fixture(t); f.manager.dispose();
  const store = createSshStore({ home: f.home }); const host = store.update(f.host.id, f.host.revision, { fingerprint: 'SHA256:previous-server' });
  const manager = createSshSessions({ home: f.home, readyTimeout: 3000 }); t.after(() => manager.dispose());
  const call = (method, params) => manager.handlers[method](params);
  await assert.rejects(call('ssh/open', { sessionId: randomUUID(), hostId: host.id, cols: 80, rows: 24, secret: 'fixture-only-secret' }), e => e.rpc.code === -32087);
  const challenge = (await call('ssh/host/list', {})).pendingTrust[0]; assert.equal(challenge.previousFingerprint, 'SHA256:previous-server');
  await assert.rejects(call('ssh/host/trust', { id: host.id, revision: host.revision, fingerprint: challenge.fingerprint }), e => e.rpc.code === -32087);
  await call('ssh/host/trust', { id: host.id, revision: host.revision, fingerprint: challenge.fingerprint, replace: true });
  assert.equal((await call('ssh/open', { sessionId: randomUUID(), hostId: host.id, cols: 80, rows: 24, secret: 'fixture-only-secret' })).status, 'ready');
});
test('cancelling an in-progress connection closes it without replaying credentials or input', { timeout: 8000 }, async t => {
  const net = require('node:net'), sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-ssh-cancel-')), manager = createSshSessions({ home, readyTimeout: 3000 }); t.after(() => manager.dispose());
  const host = await manager.handlers['ssh/host/save']({ name: 'Stalled fixture', hostname: '127.0.0.1', port: server.address().port, username: 'fixture', auth: 'password' });
  const sessionId = randomUUID(), pending = manager.handlers['ssh/open']({ sessionId, hostId: host.id, cols: 80, rows: 24, secret: 'never-stored' }); const rejected = assert.rejects(pending);
  await manager.handlers['ssh/close']({ sessionId }); await rejected;
  await assert.rejects(manager.handlers['ssh/open']({ sessionId, hostId: host.id, cols: 80, rows: 24, secret: 'never-stored' }));
});
test('long SSH output remains bounded, Ctrl+C is delivered, and disconnect does not replay input', { timeout: 8000 }, async t => {
  const f = await fixture(t), credentials = { hostId: f.host.id, cols: 80, rows: 24, secret: 'fixture-only-secret' };
  await assert.rejects(f.call('ssh/open', { ...credentials, sessionId: randomUUID() })); const challenge = (await f.call('ssh/host/list')).pendingTrust[0]; await f.call('ssh/host/trust', { id: f.host.id, revision: f.host.revision, fingerprint: challenge.fingerprint });
  const sessionId = randomUUID(); await f.call('ssh/open', { ...credentials, sessionId }); await f.call('ssh/write', { sessionId, seq: 1, data: 'fixture-long-output\r' });
  let output; for (let n = 0; n < 100; n++) { output = await f.call('ssh/read', { sessionId, cursor: 0 }); if (output.truncated) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(output.truncated, true); assert.ok(output.data.length <= 32768); assert.ok(output.cursor <= 700100); await f.call('ssh/write', { sessionId, seq: 2, data: '\x03' });
  for (let n = 0; n < 50 && !f.received.some(value => value.includes('\x03')); n++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(f.received.some(value => value.includes('\x03')));
  f.disconnect(); for (let n = 0; n < 50; n++) { if ((await f.call('ssh/read', { sessionId, cursor: output.cursor })).status !== 'ready') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  await assert.rejects(f.call('ssh/write', { sessionId, seq: 3, data: 'must-not-replay' }));
  const next = await f.call('ssh/open', { ...credentials, sessionId: randomUUID() }); assert.equal(next.inputSeq, 0); assert.equal(f.received.some(value => value.includes('must-not-replay')), false);
});
