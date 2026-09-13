'use strict';

// In-memory personal-library stand-in with real sha256 and compare-and-swap.
// Handlers match domain-artifacts / learning-pack: list, read, write, versions.
const crypto = require('node:crypto');
const path = require('node:path');

function fail(message, code = -32602) {
  const error = new Error(message); error.rpc = { code, message }; throw error;
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const nowIso = () => new Date().toISOString();
const publicEntry = entry => ({
  id: entry.id, path: entry.path, name: entry.name, sha256: entry.sha256, size: entry.size,
  modifiedAt: entry.modifiedAt, trashedAt: entry.trashedAt, folder: false, versions: entry.versions.length,
});

function createFakeLibrary() {
  const entries = [];
  const blobs = new Map();
  let tail = Promise.resolve();
  let gate = Promise.resolve();
  function locked(fn) {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }
  function find(id) { return entries.find(entry => entry.id === id); }
  function byPath(rel) { return entries.find(entry => !entry.trashedAt && entry.path === rel); }

  const handlers = {
    'library/list': () => locked(async () => ({ entries: entries.map(publicEntry) })),
    'library/versions': params => locked(async () => {
      const entry = find(params.id);
      if (!entry) fail('找不到这份资料', -32004);
      return [...entry.versions].reverse();
    }),
    'library/read': params => locked(async () => {
      const entry = find(params.id);
      if (!entry) fail('找不到这份资料', -32004);
      const digest = params.version ?? entry.sha256;
      if (!entry.versions.some(version => version.sha256 === digest)) fail('找不到这个版本', -32004);
      const bytes = blobs.get(digest);
      if (!bytes) fail('找不到这个版本', -32004);
      const offset = params.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) fail('读取位置无效');
      const slice = bytes.subarray(offset);
      return {
        entry: publicEntry(entry), sha256: digest, size: bytes.length,
        base64: slice.toString('base64'), nextOffset: null,
      };
    }),
    'library/write': async params => {
      await gate;
      return locked(async () => {
        if (typeof params.text !== 'string') fail('没有可保存的内容');
        const rel = params.path;
        if (typeof rel !== 'string' || !rel) fail('请选择资料库内的有效路径');
        const bytes = Buffer.from(params.text, 'utf8');
        const digest = hash(bytes);
        const old = byPath(rel);
        if (old) {
          if (!params.expectedSha256 || old.sha256 !== params.expectedSha256) fail('文件已有更新，请重新读取后再保存', -32005);
        } else if (params.expectedSha256) fail('原文件已被移走或删除，请重新读取', -32005);
        blobs.set(digest, bytes);
        const at = nowIso();
        if (old) {
          if (old.sha256 !== digest) old.versions.push({ sha256: digest, size: bytes.length, at });
          Object.assign(old, { sha256: digest, size: bytes.length, modifiedAt: at });
          return publicEntry(old);
        }
        const entry = {
          id: crypto.randomUUID(), path: rel, name: path.posix.basename(rel),
          sha256: digest, size: bytes.length, modifiedAt: at, trashedAt: null, folder: false,
          versions: [{ sha256: digest, size: bytes.length, at }],
        };
        entries.push(entry);
        return publicEntry(entry);
      });
    },
  };

  return {
    handlers,
    blockWrites() {
      let release;
      gate = new Promise(resolve => { release = resolve; });
      return () => { gate = Promise.resolve(); release(); };
    },
    corrupt(rel) {
      const entry = byPath(rel);
      if (!entry) fail('找不到这份资料', -32004);
      const bytes = Buffer.from(blobs.get(entry.sha256));
      bytes[0] ^= 0xff;
      blobs.set(entry.sha256, bytes);
    },
  };
}

module.exports = { createFakeLibrary };
