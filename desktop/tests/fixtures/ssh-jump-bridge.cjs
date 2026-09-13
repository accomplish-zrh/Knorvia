'use strict';
// C13 + C16 browser acceptance bridge: serves the esbuild-bundled REAL
// RemoteWorkspace harness and proxies its RPC calls to the REAL desktop
// ssh-session module, which connects through a REAL in-process ssh2 bastion to
// a REAL in-process ssh2 target (SFTP with slow reads/writes, mid-transfer
// transport cut). Everything is loopback fixture data: no real host, no real
// credential, no outbound network.
//
// Usage: node ssh-jump-bridge.cjs <harnessDir> <port>
// readiness line: BRIDGE_READY {"port":...,"bastionPort":...,"targetPort":...,...}

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { Server, utils } = require(process.env.KNORVIA_SSH2_PATH || 'ssh2');
const { createSshSessions } = require(process.env.KNORVIA_SSH_SESSION_PATH || '../../ssh-session');

const STATUS = utils.sftp.STATUS_CODE;
const harnessDir = process.argv[2];
const port = Number(process.argv[3] || 4507);

const BASTION_USER = 'keeper';
const BASTION_PASSWORD = 'fixture-bastion-password';
const TARGET_USER = 'inner';
const TARGET_PASSWORD = 'fixture-target-password';
const BIG_BYTES = 24 * 1024 * 1024;
const CUT_BYTES = 6 * 1024 * 1024;
const SLOW_UPLOAD_BYTES = 4 * 1024 * 1024;
const CUT_AFTER_BYTES = 1024 * 1024;
// ssh2 splits SFTP reads/writes into max-packet pieces, so a per-request delay
// would multiply by the packet count. Pace by bytes instead: ~4 MB/s.
const pacedDelay = bytes => Math.max(1, Math.ceil(bytes / 4096));

function syntheticContent(size, seed) {
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
const sha256File = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function targetServer(remote, state) {
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
  const clients = new Set();
  const server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => ctx.method === 'password' && ctx.username === TARGET_USER && ctx.password === TARGET_PASSWORD ? ctx.accept() : ctx.reject());
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
        for (const method of ['STAT', 'LSTAT']) sftp.on(method, (id, name) => done(id, () => {
          const target = local(name);
          if (!fs.existsSync(target)) return sftp.status(id, STATUS.NO_SUCH_FILE);
          sftp.attrs(id, attrs(fs.statSync(target)));
        }));
        sftp.on('OPENDIR', (id, name) => done(id, () => {
          const handle = Buffer.alloc(4); handle.writeUInt32BE(++next);
          const dirPath = local(name);
          const entries = fs.readdirSync(dirPath).filter(filename => !filename.startsWith('.knorvia-')).map(filename => ({ filename, longname: filename, attrs: attrs(fs.statSync(path.join(dirPath, filename))) }));
          handles.set(next, { entries, sent: false });
          sftp.handle(id, handle);
        }));
        sftp.on('READDIR', (id, handle) => done(id, () => {
          const dir = handles.get(handle.readUInt32BE());
          if (!dir || dir.sent || !dir.entries.length) return sftp.status(id, STATUS.EOF);
          dir.sent = true; sftp.name(id, dir.entries);
        }));
        sftp.on('OPEN', (id, name, flags) => done(id, () => {
          const handle = Buffer.alloc(4); handle.writeUInt32BE(++next);
          const target = local(name);
          const fd = fs.openSync(target, flags & 2 ? 'w' : 'r');
          handles.set(next, { fd, path: target });
          sftp.handle(id, handle);
        }));
        sftp.on('READ', (id, handle, offset, length) => done(id, () => {
          const file = handles.get(handle.readUInt32BE());
          if (!file) return sftp.status(id, STATUS.FAILURE);
          const proceed = () => {
            let read; let data;
            try { data = Buffer.alloc(length); read = fs.readSync(file.fd, data, 0, length, offset); } catch { return sftp.status(id, STATUS.FAILURE); }
            // The simulated network fault: drop the whole transport mid-read.
            if (file.path.includes('cut-me') && !state.cutDisabled) {
              state.cutSent += read || 0;
              if (state.cutSent >= CUT_AFTER_BYTES) { clients.forEach(other => other.end()); return; }
            }
            if (read) sftp.data(id, data.subarray(0, read)); else sftp.status(id, STATUS.EOF);
          };
          if (file.path.includes('big-remote.bin')) setTimeout(proceed, pacedDelay(length));
          else proceed();
        }));
        sftp.on('WRITE', (id, handle, offset, data) => done(id, () => {
          const file = handles.get(handle.readUInt32BE());
          if (!file) return sftp.status(id, STATUS.FAILURE);
          const proceed = () => {
            try { fs.writeSync(file.fd, data, 0, data.length, offset); } catch { return sftp.status(id, STATUS.FAILURE); }
            state.bytesWritten += data.length;
            sftp.status(id, STATUS.OK);
          };
          if (file.path.includes('slow-upload.bin')) setTimeout(proceed, pacedDelay(data.length));
          else proceed();
        }));
        sftp.on('FSTAT', (id, handle) => done(id, () => sftp.attrs(id, attrs(fs.fstatSync(handles.get(handle.readUInt32BE()).fd)))));
        sftp.on('CLOSE', (id, handle) => done(id, () => {
          const file = handles.get(handle.readUInt32BE());
          if (file) { file.closed = true; if (file.fd !== undefined) try { fs.closeSync(file.fd); } catch {} }
          handles.delete(handle.readUInt32BE());
          sftp.status(id, STATUS.OK);
        }));
        sftp.on('RENAME', (id, from, to) => done(id, () => {
          if (fs.existsSync(local(to))) return sftp.status(id, STATUS.FAILURE);
          fs.renameSync(local(from), local(to));
          sftp.status(id, STATUS.OK);
        }));
        sftp.on('REMOVE', (id, name) => done(id, () => { fs.unlinkSync(local(name)); sftp.status(id, STATUS.OK); }));
        sftp.on('close', () => { for (const file of handles.values()) if (file.fd !== undefined) try { fs.closeSync(file.fd); } catch {} });
      });
    }));
  });
  return { server, clients };
}

function bastionServer(rule) {
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
  const clients = new Set();
  const forwarded = [];
  const server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => ctx.method === 'password' && ctx.username === BASTION_USER && ctx.password === BASTION_PASSWORD ? ctx.accept() : ctx.reject());
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('pty', acceptPty => acceptPty());
        session.on('shell', acceptShell => { const stream = acceptShell(); stream.write('bastion shell\r\n'); stream.on('data', () => {}); });
        // No SFTP subsystem on the bastion: it only forwards. A session whose
        // file traffic went to the bastion would fail here, not silently work.
      });
      client.on('tcpip', (accept, reject, info) => {
        forwarded.push(`${info.destIP}:${info.destPort}`);
        const upstream = rule(info);
        if (!upstream) return reject();
        const channel = accept();
        channel.on('close', () => upstream.destroy());
        upstream.on('error', () => channel.close());
        upstream.pipe(channel);
        channel.pipe(upstream);
      });
    });
  });
  return { server, clients, forwarded };
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-ssh-jump-bridge-'));
  const remote = path.join(home, 'remote');
  const project = path.join(home, 'project');
  const downloads = path.join(project, 'downloads');
  fs.mkdirSync(remote, { recursive: true });
  fs.mkdirSync(downloads, { recursive: true });
  fs.writeFileSync(path.join(remote, 'note.txt'), 'remote note');
  fs.writeFileSync(path.join(remote, 'big-remote.bin'), syntheticContent(BIG_BYTES, 11));
  fs.writeFileSync(path.join(remote, 'cut-me.bin'), syntheticContent(CUT_BYTES, 13));
  fs.writeFileSync(path.join(project, 'slow-upload.bin'), syntheticContent(SLOW_UPLOAD_BYTES, 5));
  const state = { bytesWritten: 0, cutSent: 0, cutDisabled: true };

  const target = targetServer(remote, state);
  const targetPort = await listen(target.server);
  // The saved target host names itself "target.internal:22"; only the bastion's
  // forwarding rule can resolve it, so a successful session proves traversal.
  const bastion = bastionServer(info => {
    if (info.destIP === 'target.internal' && info.destPort === 22) return net.connect(targetPort, '127.0.0.1');
    return null;
  });
  const bastionPort = await listen(bastion.server);

  const fakeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`enc:${value}`), decryptString: buffer => buffer.toString().slice(4) };
  const rpc = async (method, params = {}) => {
    if (method !== 'workspace/path/resolve') throw new Error(`unexpected rpc ${method}`);
    const absolute = path.join(project, String(params.path || ''));
    const exists = fs.existsSync(absolute);
    return { workspace: { id: 'fixture-project', cwd: project }, absolutePath: absolute, kind: exists && fs.statSync(absolute).isDirectory() ? 'directory' : 'file' };
  };
  const manager = createSshSessions({ home, rpc, safeStorage: fakeStorage, readyTimeout: 8000 });
  const call = (method, params = {}) => manager.handlers[method](params);

  const rpcError = error => ({ code: error.rpc?.code ?? -32603, message: error.rpc?.message ?? String(error.message || error) });
  const json = (res, payload, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(payload)); };
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' }); res.end(); return; }
    res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'GET' && req.url === '/bootstrap') {
      return json(res, {
        bastionPort, targetPort, bastionUser: BASTION_USER, bastionPassword: BASTION_PASSWORD,
        targetUser: TARGET_USER, targetPassword: TARGET_PASSWORD, home, project, remote,
        big: { name: 'big-remote.bin', size: BIG_BYTES, sha256: sha256File(path.join(remote, 'big-remote.bin')) },
        cut: { name: 'cut-me.bin', size: CUT_BYTES },
        slowUpload: { name: 'slow-upload.bin', size: SLOW_UPLOAD_BYTES, sha256: sha256File(path.join(project, 'slow-upload.bin')) },
      });
    }
    if (req.method === 'GET' && req.url === '/state') {
      const storeFile = path.join(home, 'config', 'ssh-hosts.json');
      let storeRaw = '';
      try { storeRaw = fs.readFileSync(storeFile, 'utf8'); } catch { /* no store written yet */ }
      return json(res, {
        remote: fs.readdirSync(remote),
        downloads: fs.readdirSync(downloads),
        downloadsDetail: fs.readdirSync(downloads).map(name => {
          const file = path.join(downloads, name);
          const stat = fs.statSync(file);
          return { name, size: stat.size, sha256: stat.isFile() ? sha256File(file) : null };
        }),
        bastionForwarded: bastion.forwarded,
        state,
        storeRaw,
      });
    }
    if (req.method === 'POST' && req.url === '/cut') { state.cutDisabled = false; state.cutSent = 0; return json(res, { armed: true }); }
    if (req.method === 'POST' && req.url === '/cut-off') { state.cutDisabled = true; return json(res, { armed: false }); }
    if (req.method === 'POST' && req.url === '/rpc') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { method, params } = JSON.parse(body);
          json(res, { result: await call(method, params) });
        } catch (error) {
          json(res, { rpcError: rpcError(error) });
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
  process.stdout.write(`BRIDGE_READY ${JSON.stringify({ port, bastionPort, targetPort, home })}\n`);
  const shutdown = () => {
    try { manager.dispose(); } catch {}
    for (const client of bastion.clients) client.end();
    for (const client of target.clients) client.end();
    try { bastion.server.close(); } catch {}
    try { target.server.close(); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(error => { console.error('BRIDGE_FAILED', error); process.exit(1); });
