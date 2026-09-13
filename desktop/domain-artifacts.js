'use strict';

// Domain records are ordinary versioned library artifacts. The library owns
// path validation, immutable versions and compare-and-swap writes.
const crypto = require('node:crypto');
const MAX_BYTES = 2 * 1024 * 1024;
const TEXT = /\.(md|txt|json|csv|tsv|log|ya?ml|toml|html?|js|ts|py|rs)$/i;

function fail(message, code = -32602) {
  const error = new Error(message); error.rpc = { code, message }; throw error;
}
function text(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name}需要 1–${max} 字的文本`);
  return value.trim();
}
function recordPath(value, prefix) {
  if (typeof value !== 'string' || !value.startsWith(prefix) || /[\\\x00-\x1f]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..') || !value.endsWith('.json')) fail('成果路径无效');
  return value;
}
function createDomainArtifacts(library) {
  if (!library?.handlers) throw new Error('Domain artifacts require the personal library');
  const h = library.handlers;
  async function list(prefix = '') {
    const { entries } = await h['library/list']({});
    return entries.filter(e => !e.trashedAt && !e.folder && e.path.startsWith(prefix));
  }
  async function readVersion(id, version, maxBytes = MAX_BYTES) {
    const chunks = []; let offset = 0; let first;
    for (;;) {
      const part = await h['library/read']({ id, version, offset });
      first ??= part;
      if (!Number.isSafeInteger(part.size) || part.size < 0 || part.size > maxBytes) fail('资料超过此流程的读取大小限制');
      if (part.sha256 !== first.sha256 || (version && part.sha256 !== version)) fail('资料版本不一致', -32005);
      const chunk = Buffer.from(part.base64, 'base64');
      if (offset + chunk.length > maxBytes) fail('资料超过此流程的读取大小限制');
      chunks.push(chunk);
      if (part.nextOffset == null) break;
      if (!Number.isSafeInteger(part.nextOffset) || part.nextOffset !== offset + chunk.length || part.nextOffset <= offset) fail('资料读取不完整');
      offset = part.nextOffset;
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== first.size || crypto.createHash('sha256').update(bytes).digest('hex') !== first.sha256) fail('资料内容校验失败', -32005);
    return { text: bytes.toString('utf8'), sha256: first.sha256, entry: first.entry, size: bytes.length };
  }
  async function read(path, kind) {
    const entry = (await list()).find(e => e.path === path);
    if (!entry) fail('找不到这份成果', -32004);
    const loaded = await readVersion(entry.id, entry.sha256);
    let body;
    try { body = JSON.parse(loaded.text); } catch { fail('成果内容不是有效 JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || (kind && body.kind !== kind)) fail('成果类型不匹配');
    return { ...body, path: entry.path, sha256: loaded.sha256 };
  }
  async function write(path, body, expectedSha256) {
    const now = new Date().toISOString();
    const next = { ...body, path, sha256: undefined, revision: (body.revision ?? 0) + 1, createdAt: body.createdAt ?? now, updatedAt: now };
    const serialized = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(serialized) > MAX_BYTES) fail('成果记录超过 2 MB，请新建练习或简报');
    const result = await h['library/write']({ path, text: serialized, expectedSha256 });
    return { ...next, sha256: result.sha256 };
  }
  async function pinSources(refs) {
    if (!Array.isArray(refs) || !refs.length || refs.length > 10) fail('需要 1–10 份资料来源');
    const entries = await list(); const seen = new Set(); const result = [];
    for (const ref of refs) {
      const id = ref?.id ?? ref?.libraryId;
      const entry = entries.find(e => e.id === id);
      if (!entry) fail('找不到引用的资料', -32004);
      if (seen.has(id)) fail('不能重复引用同一份资料');
      seen.add(id);
      const versions = await h['library/versions']({ id });
      const version = ref.version ?? entry.sha256;
      if (!versions.some(v => v.sha256 === version)) fail('引用的资料版本不存在');
      result.push({ libraryId: id, version, path: entry.path, name: entry.name });
    }
    return result;
  }
  async function verifyEvidence(evidence, refs) {
    if (!evidence || typeof evidence !== 'object') fail('内容需要来源证据');
    const source = refs.find(ref => ref.libraryId === evidence.libraryId);
    if (!source || (evidence.version && evidence.version !== source.version)) fail('证据必须引用已固定的资料版本');
    if (!Number.isSafeInteger(evidence.line) || evidence.line < 1) fail('证据需要有效行号');
    const quote = text(evidence.quote, '原文引用', 400).replace(/\r\n/g, '\n');
    if (!TEXT.test(source.name)) fail('行号证据需要文本来源；请先导入提取后的文本');
    const content = await readVersion(source.libraryId, source.version, 1024 * 1024);
    const lines = content.text.replace(/\r\n/g, '\n').split('\n');
    const excerpt = lines.slice(evidence.line - 1, evidence.line + quote.split('\n').length - 1).join('\n');
    if (!excerpt.includes(quote)) fail('引用内容与指定版本和行号的原文不符');
    return { libraryId: source.libraryId, version: source.version, line: evidence.line, quote };
  }
  async function currency(refs) {
    const entries = await list();
    return refs.map(ref => {
      const current = entries.find(e => e.id === ref.libraryId);
      return { ...ref, evidenceStatus: !current ? 'missing' : current.sha256 === ref.version ? 'current' : 'superseded' };
    });
  }
  return { list, readVersion, read, write, pinSources, verifyEvidence, currency };
}

module.exports = { createDomainArtifacts, fail, text, recordPath };
