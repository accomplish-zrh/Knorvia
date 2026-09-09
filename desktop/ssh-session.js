'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createSshStore } = require('./ssh-store');
const { connectionError } = require('./connection-config');
const { verifyResolvedPath } = require('./desktop-path-actions');
const METHODS = ['ssh/host/list', 'ssh/host/save', 'ssh/host/delete', 'ssh/host/trust', 'ssh/open', 'ssh/list', 'ssh/read', 'ssh/write', 'ssh/resize', 'ssh/close', 'ssh/files/list', 'ssh/files/read', 'ssh/files/upload', 'ssh/files/download'];
const LIMIT = 512 * 1024;
const fail = (code, message, data) => { throw connectionError(code, message, data); };
const validId = value => typeof value === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value);
const fingerprint = key => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
function dimensions(p) { if (!Number.isInteger(p.cols) || !Number.isInteger(p.rows) || p.cols < 2 || p.cols > 500 || p.rows < 2 || p.rows > 250) fail(-32602, 'Invalid terminal dimensions'); }
function relativeRemote(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\0\\]/.test(value) || value.startsWith('/') || value.split('/').some(x => x === '..')) fail(-32602, 'Remote path must stay inside the host directory');
  return value || '.';
}
const within = (root, target) => target === root || target.startsWith(root === '/' ? '/' : `${root}/`);
const call = (object, method, ...args) => new Promise((resolve, reject) => object[method](...args, (error, result) => error ? reject(error) : resolve(result)));
async function boundedDownload(sftp, target, maximum, destination) {
  const chunks = []; let size = 0;
  const limit = new Transform({ transform(chunk, encoding, callback) { size += chunk.length; callback(size > maximum ? new Error('Remote file exceeds the transfer limit') : null, chunk); } });
  if (destination) await pipeline(sftp.createReadStream(target), limit, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  else { limit.on('data', chunk => chunks.push(chunk)); await pipeline(sftp.createReadStream(target), limit); }
  return destination ? size : Buffer.concat(chunks);
}
function createSshSessions({ home, safeStorage, rpc, Client, env = process.env, readyTimeout = 15000, maxSessions = 12 } = {}) {
  const store = createSshStore({ home, safeStorage });
  const sessions = new Map(), tombstones = new Set(), challenges = new Map();
  let disposed = false;
  const describe = s => ({ sessionId: s.id, hostId: s.hostId, name: s.name, hostname: s.hostname, status: s.status, cwd: s.root, cols: s.cols, rows: s.rows, inputSeq: s.inputSeq, exitCode: s.exitCode, error: s.error || '' });
  function session(p, ready = false) {
    const s = sessions.get(p.sessionId);
    if (!s) fail(-32084, 'SSH session is no longer available');
    if (ready && s.status !== 'ready') fail(-32085, 'SSH connection ended; reconnect with a new session. Input is never replayed');
    return s;
  }
  function append(s, chunk) { s.buffer += s.decoder.write(chunk); if (s.buffer.length > LIMIT) { const removed = s.buffer.length - LIMIT; s.buffer = s.buffer.slice(removed); s.offset += removed; } }
  function stop(s, status = 'closed') { s.status = status; s.channel?.close(); s.sftp?.end(); s.client.end(); s.rejectOpen?.(connectionError(-32085, 'SSH connection cancelled')); }
  async function open(p) {
    if (disposed || !validId(p.sessionId) || tombstones.has(p.sessionId)) fail(-32602, 'A fresh SSH session UUID is required');
    dimensions(p);
    if (sessions.has(p.sessionId)) { const existing = session(p); if (existing.hostId !== p.hostId) fail(-32005, 'Session belongs to another host'); return existing.pending || describe(existing); }
    if ([...sessions.values()].filter(s => ['connecting', 'ready'].includes(s.status)).length >= maxSessions) fail(-32082, 'Close an SSH session before opening another');
    if (sessions.size >= 100) { const oldest = [...sessions.values()].find(s => !['connecting', 'ready'].includes(s.status)); if (oldest) sessions.delete(oldest.id); else fail(-32082, 'SSH session limit reached'); }
    const host = { ...store.get(p.hostId) };
    const secret = p.secret === undefined ? store.secret(host) : p.secret;
    if (typeof secret !== 'string' || secret.length > 16384) fail(-32602, 'Invalid SSH credential');
    const options = { host: host.hostname, port: host.port, username: host.username, readyTimeout, keepaliveInterval: 10000, keepaliveCountMax: 3,
      hostVerifier(key) {
        const observed = fingerprint(key);
        if (host.fingerprint === observed) return true;
        challenges.set(host.id, { fingerprint: observed, previousFingerprint: host.fingerprint || null, revision: host.revision, expiresAt: Date.now() + 120000 });
        return false;
      } };
    if (host.auth === 'password') options.password = secret;
    else if (host.auth === 'privateKey') {
      if (!host.keyPath) fail(-32602, 'Select a private key file');
      const stat = fs.lstatSync(host.keyPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) fail(-32602, 'Private key must be a regular file under 64 KB');
      options.privateKey = fs.readFileSync(host.keyPath); if (secret) options.passphrase = secret;
    } else { options.agent = env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined); if (!options.agent) fail(-32086, 'SSH agent is unavailable; choose a private key or password'); }
    const SshClient = Client || require('ssh2').Client;
    const s = { id: p.sessionId, hostId: host.id, name: host.name, hostname: host.hostname, root: host.root, cols: p.cols, rows: p.rows, status: 'connecting', client: new SshClient(), buffer: '', decoder: new StringDecoder('utf8'), offset: 0, inputSeq: 0, exitCode: null };
    sessions.set(s.id, s);
    s.pending = new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); delete s.rejectOpen; delete s.pending; if (error) { s.status = 'failed'; s.error = error.rpc?.message || 'SSH connection failed'; s.client.destroy(); reject(error); } else resolve(describe(s)); };
      s.rejectOpen = finish;
      const timer = setTimeout(() => finish(connectionError(-32085, 'SSH connection timed out')), readyTimeout + 2000);
      s.client.on('error', () => {
        const challenge = challenges.get(host.id);
        const error = challenge && challenge.revision === host.revision
          ? connectionError(-32087, challenge.previousFingerprint ? 'SSH host key changed. Verify its fingerprint before reconnecting' : 'Verify the SSH host fingerprint before connecting', { hostId: host.id, ...challenge })
          : connectionError(-32085, 'SSH authentication or connection failed');
        if (!settled) finish(error); else { s.status = 'disconnected'; s.error = error.message; }
      });
      s.client.on('close', () => { if (!settled) finish(connectionError(-32085, 'SSH connection ended')); else if (s.status === 'ready') s.status = 'disconnected'; });
      s.client.on('ready', async () => {
        try {
          s.sftp = await call(s.client, 'sftp');
          s.root = await call(s.sftp, 'realpath', host.root || '.');
          if (!s.root.startsWith('/') || /[\0\r\n]/.test(s.root)) fail(-32085, 'This SSH connection requires a POSIX remote directory');
          if (tombstones.has(s.id) || disposed || settled) return stop(s);
          s.client.shell({ term: 'xterm-256color', cols: p.cols, rows: p.rows }, (error, channel) => {
            if (error) return finish(connectionError(-32085, 'Remote terminal could not be opened'));
            if (tombstones.has(s.id) || disposed || settled) { channel.close(); return; }
            s.channel = channel;
            channel.on('data', data => append(s, data)); channel.stderr?.on('data', data => append(s, data));
            channel.on('exit', code => { s.exitCode = Number.isInteger(code) ? code : null; });
            channel.on('close', () => { if (s.status === 'ready') s.status = 'exited'; });
            // Host root is a canonical POSIX path. Quote as one shell word.
            channel.write(`cd -- '${s.root.replace(/'/g, "'\\''")}'\r`);
            s.status = 'ready'; finish();
          });
        } catch { finish(connectionError(-32085, 'Remote directory or SFTP is unavailable')); }
      });
      try { s.client.connect(options); } catch { finish(connectionError(-32085, 'SSH connection could not be started')); }
    });
    return s.pending;
  }
  async function remote(p, create = false) {
    const s = session(p, true), rel = relativeRemote(p.path), candidate = path.posix.resolve(s.root, rel);
    if (!within(s.root, candidate)) fail(-32602, 'Remote path escaped its root');
    const resolved = await call(s.sftp, 'realpath', create ? path.posix.dirname(candidate) : candidate);
    if (!within(s.root, resolved)) fail(-32088, 'Remote symbolic link escaped its root');
    const target = create ? path.posix.join(resolved, path.posix.basename(candidate)) : resolved;
    return { s, target };
  }
  const handlers = {
    'ssh/host/list': async () => ({ ...store.list(), pendingTrust: [...challenges.entries()].filter(([, v]) => v.expiresAt > Date.now()).map(([hostId, v]) => ({ hostId, ...v })) }),
    'ssh/host/save': async p => store.save(p),
    'ssh/host/delete': async p => { if ([...sessions.values()].some(s => s.hostId === p.id && ['ready', 'connecting'].includes(s.status))) fail(-32005, 'Disconnect this host before deleting it'); challenges.delete(p.id); return store.delete(p); },
    'ssh/host/trust': async p => { const c = challenges.get(p.id); if (!c || c.expiresAt < Date.now() || c.revision !== p.revision || c.fingerprint !== p.fingerprint) fail(-32005, 'Fingerprint challenge expired; connect again'); if (c.previousFingerprint && p.replace !== true) fail(-32087, 'Explicitly approve the changed fingerprint'); const result = store.update(p.id, p.revision, { fingerprint: c.fingerprint }); challenges.delete(p.id); return result; },
    'ssh/open': open,
    'ssh/list': async () => [...sessions.values()].map(describe),
    'ssh/read': async p => { const s = session(p); if (!Number.isSafeInteger(p.cursor) || p.cursor < 0) fail(-32602, 'Invalid SSH output cursor'); const start = Math.max(0, p.cursor - s.offset), end = Math.min(s.buffer.length, start + 32768); return { ...describe(s), data: s.buffer.slice(start, end), cursor: s.offset + end, truncated: p.cursor < s.offset, hasMore: end < s.buffer.length }; },
    'ssh/write': async p => { const s = session(p, true); if (!Number.isSafeInteger(p.seq) || typeof p.data !== 'string' || !p.data || Buffer.byteLength(p.data) > 16384) fail(-32602, 'Invalid SSH input'); const digest = createHash('sha256').update(p.data).digest('hex'); if (p.seq === s.inputSeq && digest === s.lastInput) return { inputSeq: s.inputSeq }; if (p.seq !== s.inputSeq + 1) fail(-32005, 'SSH input sequence conflict; unconfirmed input will not be replayed'); if (s.channel.writableLength > 65536) fail(-32082, 'SSH input buffer is full; wait before sending more'); s.inputSeq = p.seq; s.lastInput = digest; s.channel.write(p.data); return { inputSeq: s.inputSeq }; },
    'ssh/resize': async p => { dimensions(p); const s = session(p, true); s.channel.setWindow(p.rows, p.cols, 0, 0); s.rows = p.rows; s.cols = p.cols; return { rows: s.rows, cols: s.cols }; },
    'ssh/close': async p => { if (!validId(p.sessionId)) fail(-32602, 'Invalid session'); tombstones.add(p.sessionId); if (tombstones.size > 2048) tombstones.delete(tombstones.values().next().value); const s = sessions.get(p.sessionId); if (s) stop(s); return { closed: true }; },
    'ssh/files/list': async p => {
      const { s, target } = await remote(p), handle = await call(s.sftp, 'opendir', target), entries = []; let truncated = false;
      try { for (;;) { let batch; try { batch = await call(s.sftp, 'readdir', handle); } catch (error) { if (error.code === 1) break; throw error; } if (batch === false) break; for (const entry of batch) { if (entry.filename !== '.' && entry.filename !== '..') entries.push(entry); if (entries.length > 500) { truncated = true; break; } } if (truncated) break; } }
      finally { await call(s.sftp, 'close', handle).catch(() => {}); }
      return { path: p.path || '', entries: entries.slice(0, 500).map(e => ({ name: e.filename, kind: e.attrs.isDirectory() ? 'directory' : e.attrs.isSymbolicLink() ? 'symlink' : 'file', size: e.attrs.size })), truncated };
    },
    'ssh/files/read': async p => { const { s, target } = await remote(p); const stat = await call(s.sftp, 'stat', target); if (!stat.isFile() || stat.size > 256 * 1024) fail(-32082, 'Preview supports files up to 256 KB'); const data = await boundedDownload(s.sftp, target, 256 * 1024); return { path: p.path, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), content: data.includes(0) ? null : data.toString('utf8'), binary: data.includes(0) }; },
    'ssh/files/upload': async p => {
      const { s, target } = await remote(p, true);
      const scope = { workspaceId: p.workspaceId, threadId: p.threadId, path: p.localPath };
      const local = verifyResolvedPath(await rpc('workspace/path/resolve', scope), scope);
      if (local.kind !== 'file') fail(-32602, 'Select a local file');
      const stat = fs.statSync(local.target); if (stat.size > 16 * 1024 * 1024) fail(-32082, 'Upload supports files up to 16 MB');
      // Bind the read to the inspected file identity before network transfer.
      // A local file replaced by a link between selection and open is refused.
      const fd = fs.openSync(local.target, 'r'); let data;
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || fs.realpathSync(local.target) !== local.target) fail(-32005, 'Local file changed before upload');
        data = Buffer.alloc(stat.size); let offset = 0;
        while (offset < data.length) { const read = fs.readSync(fd, data, offset, data.length - offset, offset); if (!read) break; offset += read; }
        if (offset !== data.length || fs.fstatSync(fd).size !== stat.size) fail(-32005, 'Local file changed while reading');
      } finally { fs.closeSync(fd); }
      let existing = false; try { await call(s.sftp, 'lstat', target); existing = true; } catch (error) { if (error.code !== 2) throw error; }
      if (existing) fail(-32005, 'Remote file already exists; choose a new name');
      const temp = `${target}.knorvia-${randomUUID()}.tmp`;
      const checksum = createHash('sha256').update(data).digest('hex');
      try { await pipeline(Readable.from(data), s.sftp.createWriteStream(temp, { flags: 'wx', mode: 0o600 })); const stored = await boundedDownload(s.sftp, temp, 16 * 1024 * 1024); if (stored.length !== data.length || createHash('sha256').update(stored).digest('hex') !== checksum) fail(-32005, 'Remote temporary file failed verification; original destination was preserved'); await call(s.sftp, 'rename', temp, target); }
      finally { try { await call(s.sftp, 'unlink', temp); } catch {} }
      return { path: p.path, size: stat.size, sha256: checksum };
    },
    'ssh/files/download': async p => {
      const { s, target } = await remote(p); const remoteStat = await call(s.sftp, 'stat', target);
      if (!remoteStat.isFile() || remoteStat.size > 16 * 1024 * 1024) fail(-32082, 'Download supports files up to 16 MB');
      const scope = { workspaceId: p.workspaceId, threadId: p.threadId, path: p.localDirectory || '' };
      const local = verifyResolvedPath(await rpc('workspace/path/resolve', scope), scope);
      if (local.kind !== 'directory') fail(-32602, 'Select a local destination directory');
      const name = p.name || path.posix.basename(target); if (typeof name !== 'string' || !name || /[<>:"/\\|?*\0]/.test(name) || name === '.' || name === '..' || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) fail(-32602, 'Invalid download filename');
      const destination = path.join(local.target, name), temp = path.join(local.target, `.knorvia-download-${randomUUID()}`);
      try { await boundedDownload(s.sftp, target, 16 * 1024 * 1024, temp); fs.copyFileSync(temp, destination, fs.constants.COPYFILE_EXCL); }
      finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
      return { name, size: fs.statSync(destination).size };
    },
  };
  return { handlers, dispose() { disposed = true; for (const s of sessions.values()) stop(s); challenges.clear(); } };
}
module.exports = { createSshSessions, METHODS, fingerprint, relativeRemote };
