'use strict';
// CODEX-0030-C-FIX items 4+6 (server side): expired cursors answer stably
// and release handles, idle sweeps run without requests, and empty /
// dot-only / oversized readdir batches never fabricate or lose entries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Server, utils } = require('ssh2');
const { createSshSessions } = require('../ssh-session');
const STATUS = utils.sftp.STATUS_CODE;

async function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-ssh-fix-')), remote = path.join(home, 'remote');
  fs.mkdirSync(remote);
  fs.writeFileSync(path.join(remote, 'hello.txt'), '你好 remote');
  fs.mkdirSync(path.join(remote, 'dots-only'));
  fs.mkdirSync(path.join(remote, 'empty-batch'));
  fs.writeFileSync(path.join(remote, 'empty-batch', 'real.txt'), 'x');
  fs.mkdirSync(path.join(remote, 'huge-batch'));
  const key = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
  const openDirs = new Set();
  const server = new Server({ hostKeys: [key] }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === 'fixture-only-secret' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', acceptPty => acceptPty());
      session.on('shell', acceptShell => { const stream = acceptShell(); stream.write('fixture ready\r\n'); stream.on('data', () => {}); });
      session.on('sftp', acceptSftp => {
        const sftp = acceptSftp(), handles = new Map(); let next = 0;
        const local = name => path.join(remote, path.posix.relative('/workspace', name));
        const attrs = st => ({ mode: st.mode, size: st.size, uid: 0, gid: 0, atime: 0, mtime: 0 });
        const done = (id, work) => { try { work(); } catch (error) { sftp.status(id, error.code === 'ENOENT' ? STATUS.NO_SUCH_FILE : STATUS.FAILURE); } };
        sftp.on('REALPATH', (id, name) => sftp.name(id, [{ filename: name === '.' ? '/workspace' : name, longname: name, attrs: {} }]));
        sftp.on('OPENDIR', (id, name) => done(id, () => {
          const handle = Buffer.alloc(4); handle.writeUInt32BE(++next);
          const dirPath = local(name);
          const base = path.basename(dirPath);
          let entries;
          if (base === 'dots-only') entries = ['.', '..'].map(filename => ({ filename, longname: filename, attrs: attrs(fs.statSync(dirPath)) }));
          else if (base === 'huge-batch') entries = Array.from({ length: 5200 }, (_, i) => ({ filename: `bulk-${String(i).padStart(4, '0')}`, longname: '', attrs: attrs(fs.statSync(dirPath)) }));
          else entries = fs.readdirSync(dirPath).map(filename => ({ filename, longname: filename, attrs: attrs(fs.statSync(path.join(dirPath, filename))) }));
          handles.set(next, { entries, sent: false, emptyBatch: base === 'empty-batch' });
          openDirs.add(next);
          sftp.handle(id, handle);
        }));
        sftp.on('READDIR', (id, handle) => done(id, () => {
          const dir = handles.get(handle.readUInt32BE());
          if (dir.emptyBatch) { dir.emptyBatch = false; sftp.name(id, []); return; }
          if (dir.sent || !dir.entries.length) sftp.status(id, STATUS.EOF);
          else { dir.sent = true; sftp.name(id, dir.entries); }
        }));
        sftp.on('CLOSE', (id, handle) => done(id, () => { handles.delete(handle.readUInt32BE()); openDirs.delete(handle.readUInt32BE()); sftp.status(id, STATUS.OK); }));
        sftp.on('close', () => { for (const fd of handles.values()) try { if (typeof fd === 'number') fs.closeSync(fd); } catch {} });
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    manager.dispose();
    await new Promise(resolve => {
      try { server.closeAllConnections?.(); } catch { /* not supported */ }
      server.close(() => resolve());
      setTimeout(resolve, 1500).unref();
    });
  });
  const rpc = async () => { throw new Error('not used by listings'); };
  const manager = createSshSessions({ home, rpc, readyTimeout: 3000, ...options });
  const call = (method, params = {}) => manager.handlers[method](params);
  const host = await call('ssh/host/save', { name: 'Fixture', hostname: '127.0.0.1', port: server.address().port, username: 'fixture', auth: 'password', root: '/workspace' });
  const credentials = { hostId: host.id, cols: 80, rows: 24, secret: 'fixture-only-secret' };
  await call('ssh/open', { ...credentials, sessionId: randomUUID() }).catch(() => {});
  const challenge = (await call('ssh/host/list')).pendingTrust[0];
  await call('ssh/host/trust', { id: host.id, revision: host.revision, fingerprint: challenge.fingerprint });
  const sessionId = randomUUID();
  await call('ssh/open', { ...credentials, sessionId });
  return { remote, call, sessionId, openDirCount: () => openDirs.size };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function untilOpenDirs(f, expected, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (f.openDirCount() <= expected) return;
    if (Date.now() > end) throw new Error(`remote handles did not drop to ${expected} within ${timeoutMs}ms`);
    await delay(50);
  }
}

test('expired cursors fail stably, release handles, and the idle sweep runs without requests', { timeout: 20000 }, async t => {
  const f = await fixture(t, { listingTtlMs: 400 });
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(f.remote, `t${String(i).padStart(2, '0')}.txt`), 'x');
  const page1 = await f.call('ssh/files/list', { sessionId: f.sessionId, path: '', limit: 5 });
  assert.equal(page1.hasMore, true);
  assert.equal(f.openDirCount(), 1);
  // No further requests happen: the idle sweep timer releases the handle.
  await delay(1300);
  assert.equal(f.openDirCount(), 0, 'the idle sweep timer released the remote handle');
  // The expired cursor is refused stably - its stale handle is never read.
  await assert.rejects(
    f.call('ssh/files/list', { sessionId: f.sessionId, path: '', cursor: page1.cursor, limit: 5 }),
    e => { assert.equal(e.rpc.code, -32005); assert.match(e.rpc.message, /expired/i); return true; },
  );
  await assert.rejects(
    f.call('ssh/files/list', { sessionId: f.sessionId, path: '', cursor: page1.cursor, limit: 5 }),
    e => e.rpc.code === -32005,
    'the expiry answer stays stable on retry',
  );
  // A fresh listing keeps working afterwards.
  const fresh = await f.call('ssh/files/list', { sessionId: f.sessionId, path: '', limit: 5 });
  assert.equal(fresh.entries.length, 5);
  assert.equal(fresh.hasMore, true);
});

test('empty and dot-only readdir batches never produce undefined entries', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const dots = await f.call('ssh/files/list', { sessionId: f.sessionId, path: 'dots-only', limit: 10 });
  assert.deepEqual(dots.entries, [], 'a dot-only batch filters to zero entries without crashing');
  assert.equal(dots.cursor, null);
  assert.equal(dots.hasMore, false);
  const empty = await f.call('ssh/files/list', { sessionId: f.sessionId, path: 'empty-batch', limit: 10 });
  assert.deepEqual(empty.entries.map(e => e.name), ['real.txt'], 'the empty batch is skipped and real entries still arrive');
  assert.equal(empty.hasMore, false);
  assert.equal(empty.cursor, null);
});

test('a single oversized batch pages fully and reports truncated at the tail', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  let cursor;
  const names = new Set();
  let truncated = false;
  let pages = 0;
  for (;;) {
    const page = await f.call('ssh/files/list', { sessionId: f.sessionId, path: 'huge-batch', limit: 400, cursor });
    page.entries.forEach(e => names.add(e.name));
    pages += 1;
    if (!page.hasMore) { truncated = page.truncated === true; break; }
    cursor = page.cursor;
    assert.ok(pages < 30, 'pagination must terminate');
  }
  assert.equal(pages, 13, '5000 retained entries page at 400 per page');
  assert.equal(names.size, 5000, 'retained entries are unique');
  assert.equal(truncated, true, 'the dropped excess surfaces as truncated on the final page');
  await untilOpenDirs(f, 0);
});
