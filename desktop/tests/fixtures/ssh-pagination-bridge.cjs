'use strict';
// C03 acceptance bridge (nightshift 20260910): serves the esbuild-bundled
// SshFilesPanel harness page and proxies its RPC calls to the REAL desktop
// ssh-session module, which connects to a REAL in-process local ssh2 server
// holding 1251 files. No real user SSH, no network beyond 127.0.0.1.
//
// Usage: node ssh-pagination-bridge.cjs <harnessDir> <port>
// readiness line on stdout: BRIDGE_READY {"port":...,"sessionId":...}

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { Server, utils } = require(process.env.KNORVIA_SSH2_PATH || 'ssh2');
const { createSshSessions } = require(process.env.KNORVIA_SSH_SESSION_PATH || '../../ssh-session');

const STATUS = utils.sftp.STATUS_CODE;
const harnessDir = process.argv[2];
const port = Number(process.argv[3] || 4503);
const FILE_COUNT = 1250;

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-ssh-ui-bridge-'));
  const remote = path.join(home, 'remote');
  fs.mkdirSync(remote);
  fs.mkdirSync(path.join(remote, 'huge'));
  fs.writeFileSync(path.join(remote, 'hello.txt'), '你好 remote');
  const fileList = process.env.KNORVIA_C03_FILES ? Number(process.env.KNORVIA_C03_FILES) : FILE_COUNT;
  for (let i = 0; i < fileList; i++) {
    fs.writeFileSync(path.join(remote, `entry-${String(i).padStart(4, '0')}.txt`), `fixture ${i}`);
  }
  // A subdirectory for folder-switch races, and a synthetic oversized batch
  // directory for the truncation notice scenario (served by name).
  fs.mkdirSync(path.join(remote, 'aaa-sub'));
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(remote, 'aaa-sub', `sub-${i}.txt`), `sub ${i}`);

  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
  let openDirCount = 0;
  const sshServer = new Server({ hostKeys: [key] }, client => {
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
        for (const method of ['STAT', 'LSTAT']) sftp.on(method, (id, name) => done(id, () => sftp.attrs(id, attrs(fs.statSync(local(name))))));
        sftp.on('OPENDIR', (id, name) => done(id, () => {
          const handle = Buffer.alloc(4); handle.writeUInt32BE(++next);
          const dirPath = local(name);
          let entries;
          if (path.basename(dirPath) === 'huge') {
            entries = Array.from({ length: 5200 }, (_, i) => ({ filename: `bulk-${String(i).padStart(4, '0')}`, longname: '', attrs: attrs(fs.statSync(dirPath)) }));
          } else {
            entries = fs.readdirSync(dirPath).map(filename => ({ filename, longname: filename, attrs: attrs(fs.statSync(path.join(dirPath, filename))) }));
          }
          handles.set(next, { entries, sent: false });
          openDirCount += 1;
          sftp.handle(id, handle);
        }));
        sftp.on('READDIR', (id, handle) => done(id, () => {
          const dir = handles.get(handle.readUInt32BE());
          if (dir.sent || !dir.entries.length) sftp.status(id, STATUS.EOF);
          else { dir.sent = true; sftp.name(id, dir.entries); }
        }));
        sftp.on('CLOSE', (id, handle) => done(id, () => { handles.delete(handle.readUInt32BE()); openDirCount = Math.max(0, openDirCount - 1); sftp.status(id, STATUS.OK); }));
        sftp.on('close', () => { for (const fd of handles.values()) try { if (typeof fd === 'number') fs.closeSync(fd); } catch {} });
      });
    }));
  });
  await new Promise(resolve => sshServer.listen(0, '127.0.0.1', resolve));

  const manager = createSshSessions({ home, readyTimeout: 8000, listingTtlMs: process.env.KNORVIA_C03_TTL_MS ? Number(process.env.KNORVIA_C03_TTL_MS) : 60_000 });
  const call = (method, params = {}) => manager.handlers[method](params);
  const host = await call('ssh/host/save', { name: 'Fixture', hostname: '127.0.0.1', port: sshServer.address().port, username: 'fixture', auth: 'password', root: '/workspace' });
  const credentials = { hostId: host.id, cols: 80, rows: 24, secret: 'fixture-only-secret' };
  await call('ssh/open', { ...credentials, sessionId: '00000000-0000-4000-8000-000000000000' }).catch(() => {});
  const challenge = (await call('ssh/host/list')).pendingTrust[0];
  await call('ssh/host/trust', { id: host.id, revision: host.revision, fingerprint: challenge.fingerprint });
  const sessionId = '00000000-0000-4000-8000-000000000001';
  await call('ssh/open', { ...credentials, sessionId });

  const rpcError = error => ({ code: error.rpc?.code ?? -32603, message: error.rpc?.message ?? String(error.message || error) });
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && req.url === '/bootstrap') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessionId, entryCount: fileList + 3, openDirCount }));
      return;
    }
    if (req.method === 'GET' && req.url === '/handles') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ openDirCount }));
      return;
    }
    if (req.method === 'POST' && req.url === '/ssh') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { method, params } = JSON.parse(body);
          // Delay injection: cursor continuations of the root folder can be
          // slowed down to drive stale-response races from the page.
          const cursorDelay = Number(process.env.KNORVIA_C03_CURSOR_DELAY_MS || 0);
          if (method === 'ssh/files/list' && params?.cursor && !params?.path && cursorDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, cursorDelay));
          }
          const result = await call(method, params);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ rpcError: rpcError(error) }));
        }
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/') {
      const html = fs.readFileSync(path.join(harnessDir, 'harness.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  process.stdout.write(`BRIDGE_READY ${JSON.stringify({ port, sessionId, entryCount: fileList + 3 })}\n`);
  const shutdown = () => {
    try { manager.dispose(); } catch {}
    try { sshServer.close(); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(error => { console.error('BRIDGE_FAILED', error); process.exit(1); });
