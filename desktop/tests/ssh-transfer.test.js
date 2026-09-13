'use strict';

// C16: streaming SFTP transfers. Real ssh2 server fixture on loopback; a
// 64 MB upload/download round-trip proves hash fidelity and bounded memory
// (sampled in-flight bytes), while slow/throttled fixture paths exercise
// cancellation, disconnection, source mutation and no-overwrite publishing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Server, utils } = require('ssh2');
const { createSshSessions } = require('../ssh-session');
const STATUS = utils.sftp.STATUS_CODE;

const BIG = 64 * 1024 * 1024;
const SLOW_BYTES = 4 * 1024 * 1024;

// Deterministic pseudo-random content: reproducible hashes without a huge literal.
function syntheticContent(size, seed = 7) {
  const buffer = Buffer.alloc(size);
  let state = seed;
  for (let offset = 0; offset < size; offset += 4096) {
    for (let i = 0; i < 4096 && offset + i < size; i++) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      buffer[offset + i] = state & 0xff;
    }
  }
  return buffer;
}
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-ssh-transfer-'));
  const remote = path.join(home, 'remote');
  fs.mkdirSync(remote);
  const state = { bytesReceived: 0, cutSent: 0, cutLimit: 1024 * 1024, delayMs: options.delayMs ?? 25 };
  const clients = new Set();
  const key = options.key ?? (() => {
    const { generateKeyPairSync } = require('node:crypto');
    return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
  })();
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === 'fixture-only-secret' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', acceptPty => acceptPty());
      session.on('shell', acceptShell => { const stream = acceptShell(); stream.write('fixture ready\r\n'); stream.on('data', data => stream.write(data)); });
      session.on('sftp', acceptSftp => {
        const sftp = acceptSftp(), handles = new Map(); let next = 0;
        const local = name => path.join(remote, path.posix.relative('/workspace', name));
        const attrs = st => ({ mode: st.mode, size: st.size, uid: 0, gid: 0, atime: 0, mtime: 0 });
        const done = (id, work) => { try { work(); } catch (error) { sftp.status(id, error.code === 'ENOENT' ? STATUS.NO_SUCH_FILE : STATUS.FAILURE); } };
        sftp.on('REALPATH', (id, name) => sftp.name(id, [{ filename: name === '.' ? '/workspace' : name, longname: name, attrs: {} }]));
        for (const method of ['STAT', 'LSTAT']) sftp.on(method, (id, name) => done(id, () => sftp.attrs(id, attrs(fs.statSync(local(name))))));
        sftp.on('OPENDIR', (id, name) => done(id, () => {
          const handle = Buffer.alloc(4); handle.writeUInt32BE(++next);
          const dirPath = local(name);
          const entries = fs.readdirSync(dirPath).map(filename => ({ filename, longname: filename, attrs: attrs(fs.statSync(path.join(dirPath, filename))) }));
          handles.set(next, { entries, sent: false });
          sftp.handle(id, handle);
        }));
        sftp.on('READDIR', (id, handle) => done(id, () => { const dir = handles.get(handle.readUInt32BE()); if (dir.sent || !dir.entries.length) sftp.status(id, STATUS.EOF); else { dir.sent = true; sftp.name(id, dir.entries); } }));
        sftp.on('OPEN', (id, name, flags) => done(id, () => {
          const handle = Buffer.alloc(4); handle.writeUInt32BE(++next);
          const target = local(name);
          const fd = fs.openSync(target, flags & 2 ? 'w' : 'r');
          handles.set(next, { fd, path: target });
          sftp.handle(id, handle);
        }));
        sftp.on('READ', (id, handle, offset, length) => done(id, () => {
          const file = handles.get(handle.readUInt32BE());
          const proceed = () => {
            let read; let data;
            try { data = Buffer.alloc(length); read = fs.readSync(file.fd, data, 0, length, offset); } catch (error) {
              if (error.code === 'EBADF' || file.closed) return sftp.status(id, STATUS.FAILURE);
              throw error;
            }
            if (read) state.cutSent += read;
            if (file.path.includes('cut-me') && state.cutSent >= state.cutLimit) { client.end(); return; }
            if (read) sftp.data(id, data.subarray(0, read)); else sftp.status(id, STATUS.EOF);
          };
          if (file.path.includes('slow-')) setTimeout(proceed, state.delayMs);
          else proceed();
        }));
        sftp.on('WRITE', (id, handle, offset, data) => done(id, () => {
          const file = handles.get(handle.readUInt32BE());
          const proceed = () => {
            // A cancelled transfer destroys the client stream while delayed
            // writes are still queued; answering FAILURE for the dead handle
            // keeps the fixture honest without crashing its timers.
            try { fs.writeSync(file.fd, data, 0, data.length, offset); } catch (error) {
              if (error.code === 'EBADF' || file.closed) return sftp.status(id, STATUS.FAILURE);
              throw error;
            }
            state.bytesReceived += data.length;
            sftp.status(id, STATUS.OK);
          };
          // A first write to a race staging file makes the destination appear,
          // so the client's final rename collides with an existing user file.
          if (path.basename(file.path).startsWith('race.txt.knorvia-') && !fs.existsSync(path.join(remote, 'race.txt'))) fs.writeFileSync(path.join(remote, 'race.txt'), 'user-file');
          if (path.basename(file.path).includes('slow-')) setTimeout(proceed, state.delayMs);
          else proceed();
        }));
        sftp.on('FSTAT', (id, handle) => done(id, () => sftp.attrs(id, attrs(fs.fstatSync(handles.get(handle.readUInt32BE()).fd)))));
        sftp.on('CLOSE', (id, handle) => done(id, () => { const h = handle.readUInt32BE(); const file = handles.get(h); if (file) { file.closed = true; if (file.fd !== undefined) try { fs.closeSync(file.fd); } catch {} } handles.delete(h); sftp.status(id, STATUS.OK); }));
        sftp.on('RENAME', (id, from, to) => done(id, () => { if (fs.existsSync(local(to))) return sftp.status(id, STATUS.FAILURE); fs.renameSync(local(from), local(to)); sftp.status(id, STATUS.OK); }));
        sftp.on('REMOVE', (id, name) => done(id, () => { fs.unlinkSync(local(name)); sftp.status(id, STATUS.OK); }));
        sftp.on('close', () => { for (const file of handles.values()) if (file.fd !== undefined) try { fs.closeSync(file.fd); } catch {} });
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });
  const rpc = async (method, p) => ({ workspace: { id: 'fixture', cwd: home }, absolutePath: path.join(home, p.path), kind: fs.existsSync(path.join(home, p.path)) ? (fs.statSync(path.join(home, p.path)).isDirectory() ? 'directory' : 'file') : 'file' });
  const manager = createSshSessions({ home, rpc, readyTimeout: 5000 });
  t.after(() => manager.dispose());
  const call = (method, params = {}) => manager.handlers[method](params);
  const host = await call('ssh/host/save', { name: 'Fixture', hostname: '127.0.0.1', port: server.address().port, username: 'fixture', auth: 'password', root: '/workspace' });
  // The first connect records the fingerprint challenge; approve it explicitly.
  await assert.rejects(call('ssh/open', { sessionId: randomUUID(), hostId: host.id, cols: 80, rows: 24, secret: 'fixture-only-secret' }), e => e.rpc.code === -32087);
  const fingerprint = (await call('ssh/host/list')).pendingTrust[0].fingerprint;
  await call('ssh/host/trust', { id: host.id, revision: host.revision, fingerprint });
  const open = async () => { const sessionId = randomUUID(); const opened = await call('ssh/open', { sessionId, hostId: host.id, cols: 80, rows: 24, secret: 'fixture-only-secret' }); assert.equal(opened.status, 'ready'); return sessionId; };
  const waitUntil = async (predicate, what, timeoutMs = 90000) => {
    const started = Date.now();
    for (;;) {
      if (await predicate()) return true;
      if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const listTransfers = async session => (await call('ssh/transfer/list', { sessionId: session })).transfers;
  return { home, remote, manager, call, open, waitUntil, listTransfers, state, listRemote: () => fs.readdirSync(remote) };
}

test('a 64 MB upload streams with hash fidelity, bounded in-flight bytes and monotonic progress', async t => {
  const f = await fixture(t);
  const sessionId = await f.open();
  const content = syntheticContent(BIG);
  const localFile = path.join(f.home, 'big.bin');
  fs.writeFileSync(localFile, content);
  const started = await f.call('ssh/transfer/start', { sessionId, direction: 'upload', path: 'big.bin', workspaceId: 'fixture', localPath: 'big.bin' });
  assert.equal(started.status, 'running');
  assert.equal(started.bytesTotal, BIG);
  const samples = [];
  let last = -1;
  await f.waitUntil(async () => {
    const [record] = (await f.listTransfers(sessionId)).filter(x => x.transferId === started.transferId);
    if (!record) return false;
    if (record.bytesDone < last) throw new Error(`progress regressed: ${last} -> ${record.bytesDone}`);
    last = record.bytesDone;
    samples.push(record.bytesDone);
    return record.status !== 'running';
  }, 'upload completion');
  const [record] = (await f.listTransfers(sessionId)).filter(x => x.transferId === started.transferId);
  assert.equal(record.status, 'completed');
  assert.equal(record.bytesDone, BIG);
  assert.equal(record.sha256, sha256(content));
  assert.equal(sha256(fs.readFileSync(path.join(f.remote, 'big.bin'))), sha256(content));
  assert.ok(record.stats.maxInFlightBytes <= 4 * 1024 * 1024, `in-flight bytes must stay bounded, saw ${record.stats.maxInFlightBytes}`);
  assert.ok(!f.listRemote().some(name => name.includes('.tmp')), 'no staging temp survives a completed upload');
  assert.ok(samples.length > 0 && samples[samples.length - 1] === BIG, 'progress must reach the full size');
});

test('a 64 MB download streams with hash fidelity and bounded in-flight bytes', async t => {
  const f = await fixture(t);
  const sessionId = await f.open();
  const content = syntheticContent(BIG, 11);
  fs.writeFileSync(path.join(f.remote, 'big-remote.bin'), content);
  fs.mkdirSync(path.join(f.home, 'downloads'));
  const started = await f.call('ssh/transfer/start', { sessionId, direction: 'download', path: 'big-remote.bin', workspaceId: 'fixture', localDirectory: 'downloads' });
  assert.equal(started.status, 'running');
  await f.waitUntil(async () => (await f.listTransfers(sessionId)).find(x => x.transferId === started.transferId)?.status !== 'running', 'download completion');
  const [record] = (await f.listTransfers(sessionId)).filter(x => x.transferId === started.transferId);
  assert.equal(record.status, 'completed');
  assert.equal(record.sha256, sha256(content));
  assert.equal(sha256(fs.readFileSync(path.join(f.home, 'downloads', 'big-remote.bin'))), sha256(content));
  assert.ok(record.stats.maxInFlightBytes <= 4 * 1024 * 1024, `in-flight bytes must stay bounded, saw ${record.stats.maxInFlightBytes}`);
  assert.ok(!fs.readdirSync(path.join(f.home, 'downloads')).some(name => name.startsWith('.knorvia-download-')), 'no local staging temp survives');
});

test('cancelling one slow upload leaves another transfer and the terminal unaffected', async t => {
  const f = await fixture(t);
  const sessionId = await f.open();
  fs.writeFileSync(path.join(f.home, 'slow-upload.bin'), syntheticContent(SLOW_BYTES, 5));
  const slow = await f.call('ssh/transfer/start', { sessionId, direction: 'upload', path: 'slow-upload.bin', workspaceId: 'fixture', localPath: 'slow-upload.bin' });
  const content = syntheticContent(512 * 1024, 6);
  fs.writeFileSync(path.join(f.home, 'quick.bin'), content);
  const quick = await f.call('ssh/transfer/start', { sessionId, direction: 'upload', path: 'quick.bin', workspaceId: 'fixture', localPath: 'quick.bin' });
  await new Promise(resolve => setTimeout(resolve, 400));
  const cancel = await f.call('ssh/transfer/cancel', { sessionId, transferId: slow.transferId });
  assert.equal(cancel.canceled, true);
  assert.equal(cancel.transfer.status, 'canceled');
  await f.waitUntil(async () => (await f.listTransfers(sessionId)).find(x => x.transferId === quick.transferId)?.status !== 'running', 'quick upload completion');
  assert.equal((await f.listTransfers(sessionId)).find(x => x.transferId === quick.transferId).status, 'completed');
  assert.equal(sha256(fs.readFileSync(path.join(f.remote, 'quick.bin'))), sha256(content));
  // The cancelled upload stops making progress: after the in-flight tail
  // drains, the server receives no further bytes, and only this operation's
  // staging path is cleaned.
  await new Promise(resolve => setTimeout(resolve, 500));
  const bytesAfterTail = f.state.bytesReceived;
  assert.ok(bytesAfterTail < SLOW_BYTES, 'a cancelled upload must not deliver the whole file');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(f.state.bytesReceived, bytesAfterTail, 'a cancelled upload must stop transferring bytes');
  await f.waitUntil(() => !f.listRemote().some(name => name.includes('slow-upload.bin.knorvia-')), 'temp cleanup');
  assert.ok(!f.listRemote().some(name => name.includes('.tmp')));
  // The terminal keeps working on the same session.
  const read = await f.call('ssh/read', { sessionId, cursor: 0 });
  assert.ok(read.data.includes('fixture ready'));
});

test('an occupied remote destination is never overwritten by upload, staging is cleaned', async t => {
  const f = await fixture(t);
  const sessionId = await f.open();
  fs.writeFileSync(path.join(f.remote, 'dupe.txt'), 'user-file');
  fs.writeFileSync(path.join(f.home, 'dupe.txt'), 'incoming');
  const started = await f.call('ssh/transfer/start', { sessionId, direction: 'upload', path: 'dupe.txt', workspaceId: 'fixture', localPath: 'dupe.txt' });
  await f.waitUntil(async () => (await f.listTransfers(sessionId)).find(x => x.transferId === started.transferId)?.status !== 'running', 'upload outcome');
  const [record] = (await f.listTransfers(sessionId)).filter(x => x.transferId === started.transferId);
  assert.equal(record.status, 'failed');
  assert.match(record.error, /already exists/i);
  assert.equal(fs.readFileSync(path.join(f.remote, 'dupe.txt'), 'utf8'), 'user-file');
  await f.waitUntil(() => !f.listRemote().some(name => name.includes('.knorvia-')), 'temp cleanup');
  // A rename that collides because the destination appeared mid-flight also
  // fails without touching the user file.
  fs.writeFileSync(path.join(f.home, 'race.txt'), 'incoming');
  const raced = await f.call('ssh/transfer/start', { sessionId, direction: 'upload', path: 'race.txt', workspaceId: 'fixture', localPath: 'race.txt' });
  await f.waitUntil(async () => (await f.listTransfers(sessionId)).find(x => x.transferId === raced.transferId)?.status !== 'running', 'raced upload outcome');
  const [racedRecord] = (await f.listTransfers(sessionId)).filter(x => x.transferId === raced.transferId);
  assert.equal(racedRecord.status, 'failed');
  assert.equal(fs.readFileSync(path.join(f.remote, 'race.txt'), 'utf8'), 'user-file');
  await f.waitUntil(() => !f.listRemote().some(name => name.includes('.knorvia-')), 'raced temp cleanup');
});

test('an existing local file is never overwritten by download; leftovers are cleaned', async t => {
  const f = await fixture(t);
  const sessionId = await f.open();
  fs.writeFileSync(path.join(f.remote, 'incoming.txt'), 'remote-content');
  fs.mkdirSync(path.join(f.home, 'downloads'));
  fs.writeFileSync(path.join(f.home, 'downloads', 'incoming.txt'), 'user-file');
  const started = await f.call('ssh/transfer/start', { sessionId, direction: 'download', path: 'incoming.txt', workspaceId: 'fixture', localDirectory: 'downloads' });
  await f.waitUntil(async () => {
    const all = await f.listTransfers(sessionId);
    return all.find(x => x.transferId === started.transferId)?.status !== 'running';
  }, 'download outcome', 8000);
  const [record] = (await f.listTransfers(sessionId)).filter(x => x.transferId === started.transferId);
  assert.equal(record.status, 'failed');
  assert.match(record.error, /already exists/i);
  assert.equal(fs.readFileSync(path.join(f.home, 'downloads', 'incoming.txt'), 'utf8'), 'user-file');
  assert.ok(!fs.readdirSync(path.join(f.home, 'downloads')).some(name => name.startsWith('.knorvia-download-')));
});

test('a local file edited during upload fails and publishes nothing', async t => {
  const f = await fixture(t);
  const sessionId = await f.open();
  fs.writeFileSync(path.join(f.home, 'slow-growing.bin'), syntheticContent(SLOW_BYTES, 9));
  const started = await f.call('ssh/transfer/start', { sessionId, direction: 'upload', path: 'slow-growing.bin', workspaceId: 'fixture', localPath: 'slow-growing.bin' });
  await new Promise(resolve => setTimeout(resolve, 400));
  fs.appendFileSync(path.join(f.home, 'slow-growing.bin'), 'tail');
  await f.waitUntil(async () => (await f.listTransfers(sessionId)).find(x => x.transferId === started.transferId)?.status !== 'running', 'upload outcome');
  const [record] = (await f.listTransfers(sessionId)).filter(x => x.transferId === started.transferId);
  assert.equal(record.status, 'failed');
  assert.match(record.error, /changed during the transfer/i);
  assert.equal(fs.existsSync(path.join(f.remote, 'slow-growing.bin')), false, 'a failed upload must not publish');
  await f.waitUntil(() => !f.listRemote().some(name => name.includes('.knorvia-')), 'temp cleanup');
});

test('a mid-download disconnect reports the transfer honestly incomplete; explicit restart succeeds', async t => {
  const f = await fixture(t);
  const sessionId = await f.open();
  const content = syntheticContent(4 * 1024 * 1024, 13);
  fs.writeFileSync(path.join(f.remote, 'cut-me.bin'), content);
  fs.mkdirSync(path.join(f.home, 'downloads'));
  const started = await f.call('ssh/transfer/start', { sessionId, direction: 'download', path: 'cut-me.bin', workspaceId: 'fixture', localDirectory: 'downloads' });
  await f.waitUntil(async () => (await f.listTransfers(sessionId)).find(x => x.transferId === started.transferId)?.status !== 'running', 'disconnect outcome');
  const [record] = (await f.listTransfers(sessionId)).filter(x => x.transferId === started.transferId);
  assert.equal(record.status, 'detached');
  assert.match(record.error, /ended before the transfer finished/i);
  assert.ok(!fs.readdirSync(path.join(f.home, 'downloads')).some(name => name.startsWith('.knorvia-download-')), 'staging temp is cleaned after disconnect');
  await new Promise(resolve => setTimeout(resolve, 200));
  // The user explicitly restarts on a fresh session; no silent resume. The
  // simulated network fault is gone, so the restart can finish.
  f.state.cutSent = 0;
  f.state.cutLimit = Number.MAX_SAFE_INTEGER;
  const sessionId2 = await f.open();
  const retry = await f.call('ssh/transfer/start', { sessionId: sessionId2, direction: 'download', path: 'cut-me.bin', workspaceId: 'fixture', localDirectory: 'downloads' });
  await f.waitUntil(async () => (await f.listTransfers(sessionId2)).find(x => x.transferId === retry.transferId)?.status !== 'running', 'retry completion');
  const [retryRecord] = (await f.listTransfers(sessionId2)).filter(x => x.transferId === retry.transferId);
  assert.equal(retryRecord.status, 'completed');
  assert.equal(sha256(fs.readFileSync(path.join(f.home, 'downloads', 'cut-me.bin'))), sha256(content));
});

test('malicious paths and duplicate requests are rejected without touching user files', async t => {
  const f = await fixture(t);
  const sessionId = await f.open();
  await assert.rejects(f.call('ssh/transfer/start', { sessionId, direction: 'upload', path: '../escape.bin', workspaceId: 'fixture', localPath: 'a.txt' }), e => e.rpc.code === -32602);
  await assert.rejects(f.call('ssh/transfer/start', { sessionId, direction: 'download', path: 'a/../../b.txt', workspaceId: 'fixture', localDirectory: '' }), e => e.rpc.code === -32602);
  await assert.rejects(f.call('ssh/transfer/start', { sessionId, direction: 'sideways', path: 'x.txt', workspaceId: 'fixture' }), e => e.rpc.code === -32602);
  await assert.rejects(f.call('ssh/transfer/cancel', { sessionId, transferId: 'does-not-exist' }), e => e.rpc.code === -32004);
  // Uploading the same target twice: the second request fails honestly and
  // keeps the first result.
  fs.writeFileSync(path.join(f.home, 'same.txt'), 'one');
  const first = await f.call('ssh/transfer/start', { sessionId, direction: 'upload', path: 'same.txt', workspaceId: 'fixture', localPath: 'same.txt' });
  await f.waitUntil(async () => (await f.listTransfers(sessionId)).find(x => x.transferId === first.transferId)?.status === 'completed', 'first upload');
  fs.writeFileSync(path.join(f.home, 'same.txt'), 'two');
  const dup = await f.call('ssh/transfer/start', { sessionId, direction: 'upload', path: 'same.txt', workspaceId: 'fixture', localPath: 'same.txt' });
  await f.waitUntil(async () => (await f.listTransfers(sessionId)).find(x => x.transferId === dup.transferId)?.status !== 'running', 'duplicate outcome');
  const [dupRecord] = (await f.listTransfers(sessionId)).filter(x => x.transferId === dup.transferId);
  assert.equal(dupRecord.status, 'failed');
  assert.match(dupRecord.error, /already exists/i);
  assert.equal(fs.readFileSync(path.join(f.remote, 'same.txt'), 'utf8'), 'one');
});

test('transfers require a ready session and unknown sessions are refused', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('ssh/transfer/list', { sessionId: randomUUID() }), e => e.rpc.code === -32084);
  const sessionId = await f.open();
  const listing = await f.call('ssh/transfer/list', { sessionId });
  assert.deepEqual(listing.transfers, []);
});
