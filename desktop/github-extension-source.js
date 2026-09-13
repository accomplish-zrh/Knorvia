'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createHash } = require('node:crypto');
const YAML = require('yaml');
const F = require('./extension-files');

// Fixed-version subdirectory import from GitHub. The whole-repo ZIP import
// downloads the entire repository and blocks on its single size cap, which
// locks out "one small skill inside a huge repository". With an explicit
// subdirectory this module instead resolves the selected subtree at the
// pinned commit through the git trees API and fetches exactly the blobs it
// contains — nothing else. Integrity: every blob is verified against its
// git SHA-1 object id, truncated trees are rejected (never treated as
// complete), symlinks and submodules are refused, and the final package
// SHA-256 comes from the same extension-files scan the installer uses.

const DEFAULT_API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_API_JSON_BYTES = 16 * 1024 * 1024;
const MODE_SYMLINK = '120000';
const MODE_SUBMODULE = '160000';
const MODE_FILE = '100644';
const MODE_EXEC = '100755';

function fail(message, code = -32602) { const error = new Error(message); error.rpc = { code, message }; throw error; }

// git blob object id: sha1("blob <size>\0" + content)
function gitBlobSha1(content) {
  const hash = createHash('sha1');
  hash.update(`blob ${content.length}\0`);
  hash.update(content);
  return hash.digest('hex');
}

function decodeReferenceText(value) {
  // Markdown backslash escapes and the character references used in HTML
  // attributes represent characters in a URL, not literal path characters.
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1')
    .replace(/&(?:#(x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|period|sol|bsol|colon);/gi, (all, number) => {
      if (number) {
        const code = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
      }
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", period: '.', sol: '/', bsol: '\\', colon: ':' })[all.slice(1, -1).toLowerCase()];
    });
}

function markdownDestinations(content) {
  // Walk destination syntax rather than treating angle brackets, balanced
  // parentheses or reference definitions as part of the filesystem path.
  let fence = null;
  const text = content.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    return line.replace(/(`+)([\s\S]*?)\1/g, '');
  }).join('\n');
  const targets = [];
  const destination = (offset, inline) => {
    let cursor = offset;
    while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++;
    let value = '';
    if (text[cursor] === '<') {
      for (cursor++; cursor < text.length; cursor++) {
        const character = text[cursor];
        if (character === '>' && text[cursor - 1] !== '\\') return value;
        if (character === '\n' || character === '<') return null;
        value += character;
      }
      return null;
    }
    let depth = 0;
    for (; cursor < text.length; cursor++) {
      const character = text[cursor];
      if (character === '\\' && cursor + 1 < text.length) { value += character + text[++cursor]; continue; }
      if (/\s/.test(character)) return depth ? null : value;
      if (character === '(') depth++;
      if (character === ')') {
        if (depth === 0) return inline ? value : null;
        depth--;
      }
      value += character;
    }
    return depth ? null : value;
  };
  const definitions = /^ {0,3}\[(?:\\.|[^\]\\\n])+\]:[ \t]*/gm;
  let match;
  while ((match = definitions.exec(text))) {
    const target = destination(definitions.lastIndex, false);
    if (target !== null) targets.push(decodeReferenceText(target));
  }
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] !== ']' || text[index + 1] !== '(') continue;
    const target = destination(index + 2, true);
    if (target !== null) targets.push(decodeReferenceText(target));
  }
  return { text, targets };
}

function scriptDependencies(content) {
  // Tokenize quoted strings/comments so examples in comments do not become
  // dependencies. Only static string specifiers are interpreted; never eval.
  const tokens = [], references = new Set();
  const emit = token => {
    const previous = tokens.at(-1), before = tokens.at(-2);
    if (token.kind === 'string' && (
      (previous?.kind === 'word' && ['from', 'import'].includes(previous.value)) ||
      (previous?.value === '(' && before?.kind === 'word' && ['require', 'import'].includes(before.value))
    )) references.add(token.value);
    tokens.push(token);
    if (tokens.length > 2) tokens.shift();
  };
  for (let index = 0; index < content.length;) {
    const rest = content.slice(index);
    if (/^\s/.test(rest)) { index++; continue; }
    if (rest.startsWith('//')) { const end = content.indexOf('\n', index + 2); index = end < 0 ? content.length : end + 1; continue; }
    if (rest.startsWith('/*')) { const end = content.indexOf('*/', index + 2); index = end < 0 ? content.length : end + 2; continue; }
    const quote = content[index];
    if (quote === '"' || quote === "'") {
      let value = '', closed = false;
      for (index++; index < content.length; index++) {
        let character = content[index];
        if (character === quote) { index++; closed = true; break; }
        if (character === '\\') {
          character = content[++index];
          if (character === '\n') continue;
          if (character === '\r') { if (content[index + 1] === '\n') index++; continue; }
          if (character === 'x' || character === 'u') {
            const escaped = character === 'x' ? /^[0-9a-f]{2}/i.exec(content.slice(index + 1)) : /^(?:\{[0-9a-f]{1,6}\}|[0-9a-f]{4})/i.exec(content.slice(index + 1));
            if (!escaped) fail('脚本包含无法验证的静态资源路径转义', -32093);
            const code = parseInt(escaped[0].replace(/[{}]/g, ''), 16);
            if (code > 0x10ffff) fail('脚本资源路径转义无效', -32093);
            value += String.fromCodePoint(code); index += escaped[0].length; continue;
          }
          value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' })[character] ?? character;
        } else value += character;
      }
      if (closed) emit({ kind: 'string', value });
      continue;
    }
    if (quote === '`') {
      // Template bodies are dynamic code, not a static quoted specifier.
      for (index++; index < content.length; index++) {
        if (content[index] === '\\') { index++; continue; }
        if (content[index] === '`') { index++; break; }
      }
      emit({ kind: 'dynamic', value: '`' }); continue;
    }
    const identifier = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (identifier) { emit({ kind: 'word', value: identifier[0] }); index += identifier[0].length; }
    else { emit({ kind: 'punctuation', value: content[index++] }); }
  }
  return references;
}

function createGitHubSubtreeFetcher({
  fetchImpl = null,
  apiBase = process.env.KNORVIA_GITHUB_API_BASE || DEFAULT_API_BASE,
  token = process.env.KNORVIA_GITHUB_TOKEN || '',
  maxFiles = F.MAX_FILES ?? 2000, // extension-files scan uses 2000 when not publicly exported
  maxBytes = F.MAX_BYTES,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const doFetch = fetchImpl || ((url, options) => fetch(url, options));
  const requests = [];

  // The timeout stays armed until the body has been fully consumed, and the
  // body is capped WHILE streaming: a missing Content-Length, a huge body or
  // a slow trickle is cut off instead of occupying the import indefinitely.
  async function readBodyCapped(response, cap, what) {
    const body = response.body;
    if (!body || typeof body.getReader !== 'function') {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > cap) fail(`GitHub ${what}超过安全上限`, -32092);
      return text;
    }
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (error?.name === 'AbortError') fail(`GitHub ${what}读取超时`, -32092);
        fail(`GitHub ${what}读取失败：${String(error?.message || error).slice(0, 200)}`, -32092);
      }
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > cap) {
        try { await reader.cancel(); } catch { /* already failing */ }
        fail(`GitHub ${what}超过安全上限`, -32092);
      }
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function apiJson(pathName) {
    const url = `${apiBase}/repos/${pathName}`;
    requests.push(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      let response;
      try {
        response = await doFetch(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Knorvia-extension-import',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (error) {
        if (error?.name === 'AbortError') fail('GitHub 请求超时', -32092);
        fail(`GitHub 请求失败：${String(error?.message || error).slice(0, 200)}`, -32092);
      }
      if (response.status === 403 || response.status === 429) fail('GitHub 请求被限流，请稍后重试', -32092);
      if (response.status === 404 || response.status === 422) fail('GitHub 上找不到该仓库、提交或目录（确认固定提交存在）', -32092);
      if (!response.ok) fail(`GitHub 响应异常（${response.status}）`, -32092);
      const declared = Number(response.headers.get('content-length')) || 0;
      if (declared > MAX_API_JSON_BYTES) fail('GitHub API 响应超过安全上限', -32092);
      const text = await readBodyCapped(response, MAX_API_JSON_BYTES, 'API 响应');
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchBlob(repository, blobSha, destinationFile, expectedSize) {
    const url = `${apiBase}/repos/${repository}/git/blobs/${blobSha}`;
    requests.push(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      let response;
      try {
        response = await doFetch(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Knorvia-extension-import',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (error) {
        if (error?.name === 'AbortError') fail('GitHub 请求超时', -32092);
        fail(`GitHub 请求失败：${String(error?.message || error).slice(0, 200)}`, -32092);
      }
      if (response.status === 403 || response.status === 429) fail('GitHub 请求被限流，请稍后重试', -32092);
      if (!response.ok) fail(`GitHub blob 下载失败（${response.status}）`, -32092);
      const declaredLength = Number(response.headers.get('content-length')) || 0;
      if (declaredLength > MAX_API_JSON_BYTES) fail('GitHub blob 响应超过安全上限', -32092);
      const payload = JSON.parse(await readBodyCapped(response, MAX_API_JSON_BYTES, 'blob 响应'));
      if (payload.encoding !== 'base64' || typeof payload.content !== 'string') fail('GitHub blob 返回了不支持的内容编码', -32092);
      const content = Buffer.from(payload.content, 'base64');
      if (expectedSize !== undefined && content.length !== expectedSize) fail('GitHub blob 大小与树中声明不一致', -32004);
      if (gitBlobSha1(content) !== blobSha) fail('GitHub blob 内容与其对象 ID 不符（可能被篡改）', -32004);
      await fsp.mkdir(path.dirname(destinationFile), { recursive: true });
      await fsp.writeFile(destinationFile, content, { flag: 'wx', mode: 0o600 });
      return content.length;
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveTreeSha(repository, commit, segments) {
    let treeSha = commit;
    let collected = '';
    for (const segment of segments) {
      const tree = await apiJson(`${repository}/git/trees/${treeSha}`);
      if (tree.truncated) fail('GitHub 返回了截断的目录树，无法保证结果完整；本次导入被拒绝', -32004);
      const entry = (tree.tree || []).find((item) => item.path === segment);
      if (!entry || entry.type !== 'tree') fail('扩展子目录在该固定提交中不存在', -32602);
      treeSha = entry.sha;
      collected = collected ? `${collected}/${segment}` : segment;
      void collected;
    }
    return treeSha;
  }

  // X (06:18 review): plan-then-execute. Every entry of a tree level is
  // validated (safe relative path, type, budget) BEFORE any blob is fetched
  // or any file is written, so an escaped path or an over-budget subtree can
  // never leave partial writes outside the destination.
  async function materializeTree(repository, treeSha, destination, state) {
    const tree = await apiJson(`${repository}/git/trees/${treeSha}`);
    if (tree.truncated) fail('GitHub 返回了截断的目录树，无法保证结果完整；本次导入被拒绝', -32004);
    const planned = [];
    let plannedBlobs = 0;
    let plannedBytes = 0;
    for (const entry of tree.tree || []) {
      // Validate the path FIRST: rejects absolute paths, dot segments and
      // backslash/platform escapes before any destination join.
      const safeRel = F.relative(entry.path);
      if (entry.type === 'tree') {
        planned.push({ kind: 'tree', sha: entry.sha, rel: safeRel });
        continue;
      }
      if (entry.type === 'commit') fail('子目录中包含 git 子模块，不受支持', -32093);
      if (entry.mode === MODE_SYMLINK) fail('子目录中包含符号链接，不受支持', -32093);
      if (![MODE_FILE, MODE_EXEC].includes(entry.mode)) fail('子目录中包含不受支持的文件类型', -32093);
      // X (06:18 review): budget-check the whole level in the plan pass, so
      // an over-count or over-size subtree is refused BEFORE any blob is
      // fetched or any file is written.
      plannedBlobs += 1;
      plannedBytes += entry.size || 0;
      if (state.files + plannedBlobs > maxFiles) fail('扩展文件数超出预算', -32082);
      if (state.bytes + plannedBytes > maxBytes) fail('扩展内容总大小超出预算', -32082);
      planned.push({ kind: 'blob', sha: entry.sha, rel: safeRel, size: entry.size || 0 });
    }
    for (const item of planned) {
      if (item.kind === 'tree') {
        await materializeTree(repository, item.sha, path.join(destination, ...item.rel.split('/')), state);
        // The subtree consumed live budget from the SAME shared state; the
        // plan figures for this level are stale the moment recursion ran.
        if (state.files > maxFiles) fail('扩展文件数超出预算', -32082);
        if (state.bytes > maxBytes) fail('扩展内容总大小超出预算', -32082);
        continue;
      }
      // Authoritative check against the SHARED LIVE state immediately before
      // the actual fetch and write — recursion at any level may have consumed
      // budget after this level's plan pass ran.
      if (state.files + 1 > maxFiles) fail('扩展文件数超出预算', -32082);
      if (state.bytes + item.size > maxBytes) fail('扩展内容总大小超出预算', -32082);
      const size = await fetchBlob(repository, item.sha, path.join(destination, ...item.rel.split('/')), item.size);
      state.files += 1;
      state.bytes += size;
      if (state.files > maxFiles || state.bytes > maxBytes) fail('扩展内容总大小超出预算', -32082);
    }
  }

  async function validateSubtreeClosure(destination, manifest) {
    const names = new Set(manifest.files.map(file => file.name));
    const directories = new Set(['.']);
    for (const name of names) {
      let parent = path.posix.dirname(name);
      while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
    }
    for (const file of manifest.files) {
      const ext = path.posix.extname(file.name).toLowerCase();
      if (!['.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.txt', '.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.ps1'].includes(ext)) continue;
      // scan has already verified regular files, nesting and byte limits.
      // A read failure cannot establish a complete resource closure.
      const content = await fsp.readFile(path.join(destination, ...file.name.split('/')), 'utf8');
      const relDir = path.posix.dirname(file.name);
      const checkTarget = (target, { module = false, uri = true } = {}) => {
        if (typeof target !== 'string' || !target.trim()) return;
        const original = target;
        target = target.trim();
        if (target.startsWith('#')) return;
        if (/^(?:https?|mailto|data):/i.test(target) || target.startsWith('//')) return;
        if (/^[a-z][a-z\d+.-]*:/i.test(target)) fail(`子目录包含跨目录资源引用（${original}）`, -32093);
        let clean = uri ? target.split(/[?#]/, 1)[0] : target;
        if (uri) {
          try { clean = decodeURIComponent(clean); }
          catch { fail(`资源路径 URI 编码无效（${original}）`, -32093); }
        }
        clean = clean.replace(/\\/g, '/');
        if (!clean) return;
        if (clean.startsWith('/') || /[\0:]/.test(clean)) fail(`子目录包含跨目录资源引用（${original}）`, -32093);
        const normalized = path.posix.normalize(path.posix.join(relDir, clean)).replace(/\/$/, '') || '.';
        if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
          fail(`子目录包含跨目录资源引用（${original}），超出选定目录闭包范围`, -32093);
        }
        const candidates = [normalized];
        if (module) {
          for (const suffix of ['.js', '.mjs', '.cjs', '.ts', '.json']) candidates.push(normalized + suffix);
          for (const suffix of ['index.js', 'index.mjs', 'index.cjs', 'index.ts', 'index.json']) candidates.push(path.posix.join(normalized, suffix));
        }
        if (!candidates.some(name => names.has(name)) && !(directories.has(normalized) && !module)) {
          fail(`子目录缺少引用资源（${original}，来自 ${file.name}），无法验证资源闭包`, -32093);
        }
      };

      if (['.md', '.markdown', '.txt'].includes(ext)) {
        const markdown = markdownDestinations(content);
        for (const target of markdown.targets) checkTarget(target);
        const html = /<(?:a|img|script|link|source)\b[^>]*\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
        let match;
        while ((match = html.exec(markdown.text))) checkTarget(decodeReferenceText(match[1] ?? match[2] ?? match[3]));
      }
      if (['.js', '.mjs', '.cjs', '.ts'].includes(ext)) {
        for (const ref of scriptDependencies(content)) {
          if (ref.startsWith('.') || ref.startsWith('/') || /^(?:file|[a-z]):/i.test(ref)) checkTarget(ref, { module: true });
        }
      }
      if (['.json', '.yaml', '.yml'].includes(ext)) {
        let data;
        try { data = ext === '.json' ? JSON.parse(content) : YAML.parse(content, { maxAliasCount: 100 }); }
        catch { fail(`无法解析资源配置 ${file.name}，不能验证子目录闭包`, -32093); }
        const seen = new Set();
        const visit = (value, depth = 0) => {
          if (!value || typeof value !== 'object' || seen.has(value)) return;
          if (depth > 64) fail(`资源配置嵌套过深（${file.name}）`, -32093);
          seen.add(value);
          for (const [key, entry] of Object.entries(value)) {
            if (['path', 'file', 'source', 'ref', '$ref', 'url'].includes(key) && typeof entry === 'string') checkTarget(entry, { uri: ['ref', '$ref', 'url'].includes(key) });
            else if (entry && typeof entry === 'object') visit(entry, depth + 1);
          }
        };
        visit(data);
      }
    }
  }

  return {
    get requests() { return [...requests]; },
    // Resolves `subdirectory` at the fixed commit and fetches exactly the
    // objects inside it into `destination`. Network access is limited to the
    // trees/blobs of the selected subtree.
    async fetchSubtree({ repository, commit, subdirectory, destination }) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(repository || '')) fail('Use owner/repository');
      if (!/^[a-f\d]{40}$/i.test(commit || '')) fail('Use a fixed 40-character commit');
      const segments = F.relative(subdirectory).split('/');
      const subtreeSha = await resolveTreeSha(repository, commit.toLowerCase(), segments);
      await fsp.mkdir(destination, { recursive: true });
      // Cleanup below owns only an empty staging directory. The manager uses
      // a fresh UUID path; refuse a reused helper destination before writing.
      if ((await fsp.readdir(destination)).length) fail('扩展下载目标目录必须为空', -32093);
      if ((await fsp.lstat(destination)).isSymbolicLink()) fail('扩展下载目标不能是链接', -32093);
      const state = { files: 0, bytes: 0 };
      try {
        await materializeTree(repository, subtreeSha, destination, state);
        if (!state.files) fail('扩展子目录为空');
        const manifest = F.scan(destination);
        await validateSubtreeClosure(destination, manifest);
        return {
          dir: destination,
          source: { type: 'github', repository, commit: commit.toLowerCase(), subdirectory: F.relative(subdirectory) },
          sha256: manifest.sha256,
          files: state.files,
          bytes: state.bytes,
        };
      } catch (error) {
        try {
          const entries = await fsp.readdir(destination);
          for (const e of entries) {
            await fsp.rm(path.join(destination, e), { recursive: true, force: true });
          }
        } catch {}
        throw error;
      }
    },
  };
}

module.exports = { createGitHubSubtreeFetcher, gitBlobSha1, DEFAULT_API_BASE, REQUEST_TIMEOUT_MS };
