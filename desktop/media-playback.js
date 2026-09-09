'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Read-only capability URLs. No API credentials, arbitrary paths, uploads or
// mutations are exposed. The browser can seek without loading a whole video
// into React/IPC memory. A server lives only as long as its owning studio.
function createMediaPlayback({ root, ttlMs = 30 * 60 * 1000, maxEntries = 256 } = {}) {
  const entries = new Map(); let starting; let server; let closed = false;
  const base = fs.realpathSync(root);
  const resolve = file => {
    const real = fs.realpathSync(file);
    if (!real.startsWith(base + path.sep)) throw new Error('Media path outside studio');
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new Error('Media is not a regular file');
    return { real, stat };
  };
  async function start() {
    if (closed) throw new Error('Media service is closed');
    if (!starting) starting = new Promise((yes, no) => {
      server = http.createServer((req, res) => {
        const id = req.url?.split('?')[0]?.slice(1);
        const record = id && entries.get(id);
        const finish = status => { res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(); };
        if (!['GET', 'HEAD'].includes(req.method)) { finish(405); return; }
        if (!record || record.expiresAt < Date.now()) { if (id) entries.delete(id); finish(404); return; }
        let file;
        try { file = resolve(record.file); } catch { finish(404); return; }
        if (file.stat.size !== record.size || file.stat.mtimeMs !== record.mtimeMs) { entries.delete(id); finish(409); return; }
        let from = 0, to = record.size - 1, status = 200;
        if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === `"${record.sha256}"`)) {
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!range || (!range[1] && !range[2])) { res.setHeader('Content-Range', `bytes */${record.size}`); finish(416); return; }
          if (!range[1]) from = Math.max(0, record.size - Number(range[2]));
          else { from = Number(range[1]); if (range[2]) to = Math.min(to, Number(range[2])); }
          if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from >= record.size || from > to) { res.setHeader('Content-Range', `bytes */${record.size}`); finish(416); return; }
          status = 206;
        }
        const headers = { 'Content-Type': record.mime, 'Content-Length': Math.max(0, to - from + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=60', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ETag: `"${record.sha256}"`, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(record.name)}` };
        if (req.url?.endsWith('?download=1')) headers['Content-Disposition'] = headers['Content-Disposition'].replace('inline;', 'attachment;');
        if (status === 206) headers['Content-Range'] = `bytes ${from}-${to}/${record.size}`;
        res.writeHead(status, headers);
        if (req.method === 'HEAD' || !record.size) { res.end(); return; }
        const stream = fs.createReadStream(file.real, { start: from, end: to, highWaterMark: 128 * 1024 });
        stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
      });
      server.headersTimeout = 10000; server.requestTimeout = 30000;
      server.once('error', no); server.listen(0, '127.0.0.1', yes);
    });
    await starting;
  }
  return {
    async issue({ file, name = path.basename(file), mime, sha256 }) {
      const { real, stat } = resolve(file);
      if (!/^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime)|audio\/wav)$/.test(mime)) throw new Error('Unsupported playback media type');
      await start();
      for (const [id, entry] of entries) if (entry.expiresAt < Date.now()) entries.delete(id);
      const old = [...entries].find(([, entry]) => entry.file === real && entry.sha256 === sha256 && entry.expiresAt - Date.now() > 60000);
      const token = old?.[0] ?? crypto.randomBytes(32).toString('hex');
      if (!old) {
        if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
        entries.set(token, { file: real, size: stat.size, mtimeMs: stat.mtimeMs, mime, name, sha256, expiresAt: Date.now() + ttlMs });
      }
      return { url: `http://127.0.0.1:${server.address().port}/${token}`, expiresAt: entries.get(token).expiresAt, size: stat.size, mime, name, sha256 };
    },
    async close() { closed = true; entries.clear(); if (starting) await starting.catch(() => {}); if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } },
  };
}
module.exports = { createMediaPlayback };
