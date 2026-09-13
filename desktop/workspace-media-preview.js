'use strict';

// Scoped, revocable capability URLs for workspace media (C19). The daemon
// resolves a workspace/thread path; this service binds the resolved regular
// file (realpath + size + mtime) into a short-lived token served over a
// loopback-only HTTP server with Range/HEAD support so video and PDF previews
// can seek without pushing whole files through IPC or the browser gateway.
// Tokens never accept a path from the network: a URL addresses exactly one
// bound file identity. Panel close, scope switch, expiry, file replacement
// and symlink switches all revoke or reject reads.

const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 512;
const STREAM_CHUNK = 256 * 1024;

function createWorkspaceMediaPreview({ ttlMs = DEFAULT_TTL_MS, maxEntries = MAX_ENTRIES, streamChunk = STREAM_CHUNK } = {}) {
  const tokens = new Map();
  let starting; let server; let closed = false;

  function sweepExpired(now = Date.now()) {
    for (const [token, record] of tokens) if (record.expiresAt <= now) tokens.delete(token);
  }
  const etagOf = record => `"${crypto.createHash('sha256').update(`${record.file}:${record.size}:${record.mtimeMs}`).digest('hex').slice(0, 32)}"`;
  const publicView = record => ({ token: record.token, url: `http://127.0.0.1:${server.address().port}/${record.token}`, expiresAt: record.expiresAt, size: record.size, mime: record.mime, name: record.name });

  async function start() {
    if (closed) throw new Error('Media preview service is closed');
    if (!starting) starting = new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        try { serve(req, res); } catch { res.writeHead(500, { 'X-Content-Type-Options': 'nosniff' }); res.end(); }
      });
      server.headersTimeout = 10000;
      server.requestTimeout = 60000;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    await starting;
  }
  function drop(token) { tokens.delete(token); }

  function serve(req, res) {
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, If-Range',
      'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, ETag',
    };
    const fail = (status, extra = {}) => { res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors, ...extra }); res.end(); };
    if (req.method === 'OPTIONS') return fail(204, { Allow: 'GET, HEAD, OPTIONS' });
    const token = (req.url || '').split('?')[0].replace(/^\//, '').replace(/\/+$/, '');
    if (!/^[0-9a-f]{64}$/.test(token)) return fail(404);
    if (!['GET', 'HEAD'].includes(req.method)) return fail(405, { Allow: 'GET, HEAD, OPTIONS' });
    const record = tokens.get(token);
    if (!record) return fail(404);
    if (record.expiresAt <= Date.now()) { drop(token); return fail(404); }
    // The token is bound to one file identity: a replacement or a symlink
    // switch behind the same path is refused and the capability is revoked.
    let real; let stat;
    try {
      real = fs.realpathSync(record.file);
      stat = fs.statSync(real);
    } catch { drop(token); return fail(404); }
    if (!stat.isFile() || real !== record.file) { drop(token); return fail(404); }
    if (stat.size !== record.size || stat.mtimeMs !== record.mtimeMs) { drop(token); return fail(409); }
    if (record.path !== record.file) {
      // The capability was issued through a symlinked path: it stops working
      // the moment that path resolves anywhere else.
      let viaPath;
      try { viaPath = fs.realpathSync(record.path); } catch { drop(token); return fail(404); }
      if (viaPath !== record.file) { drop(token); return fail(404); }
    }
    let from = 0; let to = record.size - 1; let status = 200;
    if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etagOf(record))) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range));
      if (!range || (!range[1] && !range[2])) return fail(416, { 'Content-Range': `bytes */${record.size}` });
      if (!range[1]) from = Math.max(0, record.size - Number(range[2]));
      else { from = Number(range[1]); if (range[2]) to = Math.min(to, Number(range[2])); }
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from >= record.size || from > to) return fail(416, { 'Content-Range': `bytes */${record.size}` });
      status = 206;
    }
    const headers = {
      'Content-Type': record.mime,
      'Content-Length': Math.max(0, to - from + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=30',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...cors,
      ETag: etagOf(record),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(record.name)}`,
    };
    if (status === 206) headers['Content-Range'] = `bytes ${from}-${to}/${record.size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !record.size) { res.end(); return; }
    const stream = fs.createReadStream(record.file, { start: from, end: to, highWaterMark: streamChunk });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  return {
    // Binds one daemon-resolved absolute file into a capability URL. The
    // caller passes the resolved target only - never a renderer path.
    async issue({ workspaceId, threadId, file, mime }) {
      if (!file || !path.isAbsolute(file)) throw new Error('Media preview needs a resolved absolute file');
      if (!mime || !/^(image|video|audio|application)\//.test(mime)) throw new Error('Unsupported preview media type');
      if (!workspaceId && !threadId) throw new Error('Media preview needs a workspace or thread scope');
      const real = fs.realpathSync(file);
      const stat = fs.statSync(real);
      if (!stat.isFile()) throw new Error('Media preview needs a regular file');
      await start();
      sweepExpired();
      const existing = [...tokens.values()].find(record => record.file === real && record.size === stat.size && record.mtimeMs === stat.mtimeMs && record.mime === mime && record.workspaceId === (workspaceId || '') && record.threadId === (threadId || '') && record.expiresAt - Date.now() > 30000);
      if (existing) return publicView(existing);
      if (tokens.size >= maxEntries) sweepExpired();
      if (tokens.size >= maxEntries) tokens.delete(tokens.keys().next().value);
      const token = crypto.randomBytes(32).toString('hex');
      const record = { token, workspaceId: workspaceId || '', threadId: threadId || '', path: file, file: real, size: stat.size, mtimeMs: stat.mtimeMs, mime, name: path.basename(real), expiresAt: Date.now() + ttlMs };
      tokens.set(token, record);
      return publicView(record);
    },
    // The file changed behind the panel: revoke its capability.
    revoke(token) { return tokens.delete(token); },
    // Panel close or workspace/thread switch: revoke everything in scope.
    revokeScope({ workspaceId, threadId } = {}) {
      let revoked = 0;
      for (const [token, record] of tokens) {
        if ((workspaceId && record.workspaceId === workspaceId) || (threadId && record.threadId === threadId)) { tokens.delete(token); revoked += 1; }
      }
      return revoked;
    },
    stat(token) { return tokens.get(token) ? { ...tokens.get(token) } : null; },
    async close(context = {}) {
      closed = true; tokens.clear();
      const work = (async () => {
        if (starting) await starting.catch(() => {});
        if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        return true;
      })();
      if (!context.signal) { await work; return { confirmed: true, ownedPids: [], detail: 'preview tokens revoked and server closed' }; }
      if (context.signal.aborted) return { confirmed: false, ownedPids: [], detail: 'preview server did not close before shutdown deadline' };
      const aborted = new Promise(resolve => context.signal.addEventListener('abort', () => resolve(false), { once: true }));
      if (!await Promise.race([work, aborted])) return { confirmed: false, ownedPids: [], detail: 'preview server did not close before shutdown deadline' };
      return { confirmed: true, ownedPids: [], detail: 'preview tokens revoked and server closed' };
    },
  };
}

module.exports = { createWorkspaceMediaPreview, DEFAULT_TTL_MS };
