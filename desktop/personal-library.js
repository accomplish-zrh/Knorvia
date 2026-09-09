'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const MAX_FILE = 256 * 1024 * 1024;
const CHUNK = 512 * 1024;
const METHODS = ['library/info', 'library/list', 'library/search', 'library/folder', 'library/read', 'library/write', 'library/upload/start', 'library/upload/chunk', 'library/upload/finish', 'library/upload/cancel', 'library/move', 'library/trash', 'library/restore', 'library/versions', 'library/revert', 'library/workspace', 'library/import-project'];
function fail(message, code = -32602) { const error = new Error(message); error.rpc = { code, message }; throw error; }
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fileHash(file) { const value = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) value.update(chunk); return value.digest('hex'); }
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

function relative(value, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > 1500 || /[\x00-\x1f<>:"|?*]/.test(value)) fail('文件名包含不支持的字符');
  const clean = value.replaceAll('\\', '/');
  if (!clean && allowEmpty) return '';
  const parts = clean.split('/');
  if (!clean || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('请选择资料库内的有效路径');
  return parts.join('/');
}

/** A file library, not a second Thread or Artifact store. Every revision is a real file. */
function createPersonalLibrary({ home, rpc } = {}) {
  if (!path.isAbsolute(home || '')) throw new Error('Personal library requires an absolute Home');
  const root = path.join(home, 'personal-library');
  const content = path.join(root, 'files');
  const meta = path.join(root, '.knorvia-library');
  const indexFile = path.join(meta, 'index.json');
  async function persist(index) { const temporary = `${indexFile}.${uid()}.tmp`; await fsp.writeFile(temporary, JSON.stringify(index), { flush: true }); await fsp.rename(temporary, indexFile); }
  let initialization;
  async function initialize() {
    initialization ??= (async () => {
      await fsp.mkdir(content, { recursive: true });
      for (const dir of ['versions', 'uploads', 'tools', 'trash']) await fsp.mkdir(path.join(meta, dir), { recursive: true });
      // The portable Node helper gives the actual Kernel the same reversible operations as the UI.
      if (path.resolve(__dirname) !== path.resolve(meta, 'tools')) {
        for (const name of ['personal-library.js', 'personal-library-cli.js']) {
          const source = await fsp.readFile(path.join(__dirname, name)), target = path.join(meta, 'tools', name);
          if (await fsp.readFile(target).then(value => value.equals(source)).catch(() => false)) continue;
          const temporary = `${target}.${uid()}.tmp`; await fsp.writeFile(temporary, source); await fsp.rename(temporary, target);
        }
      }
      const guide = '# Personal library\n\nThis is the user\'s private Knorvia file library. User files live in `files/`. ' +
        'Use `.knorvia-library/tools/personal-library-cli.js` with Node for library operations; do not edit `.knorvia-library` metadata yourself. ' +
        'Commands: `list`, `write <relative-path> <text>`, `put <source-file> <relative-path>`, `move <from> <to>`, `trash <relative-path>`, `restore <entry-id>`. ' +
        'Paths are relative to files/. Replacements require the existing revision hash as the last argument. `list` returns revision hashes. ' +
        'The helper preserves revisions and uses a recoverable trash. For Office/media generation, create a temporary file and import it with `put`. ' +
        'Do not permanently delete files or rewrite unrelated documents. Inspect requested files before editing. Report the resulting library paths.\n';
      await fsp.writeFile(path.join(root, 'AGENTS.md'), guide, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    })().catch(error => { initialization = undefined; throw error; });
    return initialization;
  }
  async function checked(value, { empty = false, missing = false } = {}) {
    const rel = relative(value, empty), target = path.join(content, rel);
    const resolvedRoot = await fsp.realpath(content);
    if (path.resolve(resolvedRoot).toLowerCase() !== path.resolve(content).toLowerCase()) fail('资料库位置已改变，请重新打开工作台');
    let next = content;
    for (const part of rel.split('/').filter(Boolean)) {
      next = path.join(next, part);
      const stat = await fsp.lstat(next).catch(error => { if (missing && error.code === 'ENOENT') return null; throw error; });
      if (stat?.isSymbolicLink()) fail('资料库不跟随符号链接');
      if (stat && path.resolve(await fsp.realpath(next)).toLowerCase() !== path.resolve(next).toLowerCase()) fail('资料库路径已改变');
    }
    return { rel, target };
  }
  async function locked(operation) {
    await initialize();
    const lock = path.join(meta, 'write.lock'); const started = Date.now();
    for (;;) {
      try { await fsp.mkdir(lock); await fsp.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid })); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner; try { owner = JSON.parse(await fsp.readFile(path.join(lock, 'owner.json'), 'utf8')); } catch {}
        const stat = await fsp.stat(lock).catch(() => null);
        if ((owner?.pid && !alive(owner.pid)) || (!owner && stat && Date.now() - stat.mtimeMs > 30_000)) {
          await fsp.unlink(path.join(lock, 'owner.json')).catch(() => {}); await fsp.rmdir(lock).catch(() => {}); continue;
        }
        if (Date.now() - started > 10_000) fail('资料库正在保存，请稍后重试', -32042);
        await delay(25);
      }
    }
    try {
      const previous = await fsp.readFile(indexFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const index = previous === null ? { version: 1, entries: [], workspaceId: null } : JSON.parse(previous);
      if (index.version !== 1 || !Array.isArray(index.entries)) fail('资料库目录需要修复，请保留原文件', -32042);
      const result = await operation(index);
      if (JSON.stringify(index) !== previous) await persist(index);
      return result;
    } finally { await fsp.unlink(path.join(lock, 'owner.json')).catch(() => {}); await fsp.rmdir(lock).catch(() => {}); }
  }
  async function snapshot(index, rel, file, existing) {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) fail('请选择一个文件');
    if (stat.size > MAX_FILE) fail('单个文件目前支持最大 256 MB');
    const entry = existing ?? { id: uid(), path: rel, versions: [], createdAt: now() };
    const versionDir = path.join(meta, 'versions', entry.id); await fsp.mkdir(versionDir, { recursive: true });
    const temporary = path.join(versionDir, `${uid()}.tmp`); let digest;
    try {
      await fsp.copyFile(file, temporary); digest = await fileHash(temporary);
      if ((await fsp.stat(temporary)).size !== stat.size || await fileHash(file) !== digest) fail('文件正在被修改，请稍后重试', -32005);
      const handle = await fsp.open(temporary, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      await fsp.link(temporary, path.join(versionDir, digest)).catch(error => { if (error.code !== 'EEXIST') throw error; });
    } finally { await fsp.unlink(temporary).catch(() => {}); }
    if (entry.sha256 !== digest) entry.versions.push({ sha256: digest, size: stat.size, at: now() });
    Object.assign(entry, { path: rel, name: path.basename(rel), sha256: digest, size: stat.size, mtimeMs: stat.mtimeMs, modifiedAt: stat.mtime.toISOString(), trashedAt: null });
    if (!existing) index.entries.push(entry);
    return entry;
  }
  async function scan(index) {
    const present = new Set(), folders = []; let scanned = 0, limited = false;
    // A folder and its recovery receipt are separate from the catalog. Reconcile
    // a process exit after the folder rename but before the catalog commit.
    for (const name of await fsp.readdir(path.join(meta, 'trash'))) if (/^[\da-f-]{36}\.json$/.test(name)) {
      const receipt = JSON.parse(await fsp.readFile(path.join(meta, 'trash', name), 'utf8'));
      if (!await fsp.lstat(path.join(meta, 'trash', receipt.folder.id)).catch(() => null)) continue;
      if (!index.entries.some(entry => entry.id === receipt.folder.id)) index.entries.push(receipt.folder);
      for (const saved of receipt.children) {
        const current = index.entries.find(entry => entry.id === saved.id);
        if (current) { current.trashedAt = receipt.folder.trashedAt; current.parentTrash = receipt.folder.id; }
        else index.entries.push({ ...saved, trashedAt: receipt.folder.trashedAt, parentTrash: receipt.folder.id });
      }
    }
    async function walk(directory, rel = '', depth = 0) {
      if (depth > 24) { limited = true; return; }
      for (const dirent of await fsp.readdir(directory, { withFileTypes: true })) {
        if (++scanned > 10_000) { limited = true; return; }
        if (dirent.isSymbolicLink()) continue;
        const child = rel ? `${rel}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) { folders.push(child); await walk(path.join(directory, dirent.name), child, depth + 1); }
        else if (dirent.isFile()) {
          present.add(child); const file = path.join(directory, dirent.name), stat = await fsp.stat(file);
          const old = index.entries.find(entry => !entry.trashedAt && entry.path === child);
          if (stat.size <= MAX_FILE && (!old || stat.size !== old.size || stat.mtimeMs !== old.mtimeMs)) await snapshot(index, child, file, old);
        }
      }
    }
    await checked('', { empty: true }); await walk(content);
    if (!limited) for (const entry of index.entries) if (!entry.trashedAt && !present.has(entry.path)) entry.trashedAt = now();
    return { folders, limited };
  }
  const publicEntry = entry => ({ id: entry.id, path: entry.path, name: entry.name, sha256: entry.sha256, size: entry.size, modifiedAt: entry.modifiedAt, ...(entry.accessedAt ? { accessedAt: entry.accessedAt } : {}), trashedAt: entry.trashedAt, folder: entry.folder === true, ...(entry.parentTrash ? { parentTrash: entry.parentTrash } : {}), versions: entry.versions.length });
  async function publish(index, source, destination, expectedSha256) {
    const { rel, target } = await checked(destination, { missing: true });
    const parentRel = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    // Saving into a not-yet-existing folder creates it, like a normal save
    // dialog; intermediate folders are created wholesale under the lock.
    await checked(parentRel, { empty: true, missing: true });
    await fsp.mkdir(path.join(content, parentRel), { recursive: true }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const old = index.entries.find(entry => !entry.trashedAt && entry.path === rel);
    const exists = await fsp.stat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (exists) {
      if (!exists.isFile()) fail('该位置已存在文件夹');
      const current = await fileHash(target);
      if (!expectedSha256 || current !== expectedSha256) fail('文件已有更新，请重新读取后再保存', -32005);
      await snapshot(index, rel, target, old);
    } else if (expectedSha256) fail('原文件已被移走或删除，请重新读取', -32005);
    await persist(index); // Old revisions are durable before replacing their source.
    const temporary = path.join(meta, 'uploads', `${uid()}.save`);
    await fsp.copyFile(source, temporary);
    try {
      // Check once more immediately before publication. All library helpers share this lock.
      if (exists && await fileHash(target) !== expectedSha256) fail('文件在保存时发生变化，请重新读取', -32005);
      if (!exists) { await fsp.link(temporary, target); await fsp.unlink(temporary); }
      else await fsp.rename(temporary, target);
    } finally { await fsp.unlink(temporary).catch(() => {}); }
    return publicEntry(await snapshot(index, rel, target, index.entries.find(entry => !entry.trashedAt && entry.path === rel)));
  }
  async function write({ path: destination, text, base64, expectedSha256 }) {
    const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : typeof base64 === 'string' ? Buffer.from(base64, 'base64') : fail('没有可保存的内容');
    if (bytes.length > CHUNK) fail('请使用分块上传保存较大文件');
    return locked(async index => {
      const source = path.join(meta, 'uploads', `${uid()}.part`); await fsp.writeFile(source, bytes);
      try { return await publish(index, source, destination, expectedSha256); } finally { await fsp.unlink(source).catch(() => {}); }
    });
  }
  const handlers = {
    'library/info': () => locked(async index => ({ root, filesRoot: content, workspaceId: index.workspaceId, maxFileBytes: MAX_FILE, chunkBytes: CHUNK })),
    'library/list': () => locked(async index => ({ ...await scan(index), entries: index.entries.map(publicEntry) })),
    'library/folder': params => locked(async () => { const { target, rel } = await checked(params.path, { missing: true }); await fsp.mkdir(target); return { path: rel }; }),
    'library/write': write,
    'library/read': params => locked(async index => {
      const entry = index.entries.find(item => item.id === params.id);
      if (!entry) fail('找不到这份资料', -32004);
      const digest = params.version ?? entry.sha256;
      if (!entry.versions.some(version => version.sha256 === digest)) fail('找不到这个版本', -32004);
      if (!entry.trashedAt && !params.version) {
        const { target } = await checked(entry.path); const current = await fileHash(target);
        if (current !== entry.sha256) await snapshot(index, entry.path, target, entry);
      }
      if (params.expectedSha256 && params.expectedSha256 !== entry.sha256 && !params.version) fail('资料已更新，请刷新预览', -32005);
      const sha256 = params.version ?? entry.sha256;
      const source = path.join(meta, 'versions', entry.id, sha256);
      const offset = params.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) fail('读取位置无效');
      const handle = await fsp.open(source, 'r');
      try { const stat = await handle.stat(), buffer = Buffer.alloc(Math.min(CHUNK, Math.max(0, stat.size - offset))); const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset); if (offset === 0) entry.accessedAt = now(); return { entry: publicEntry(entry), sha256, size: stat.size, base64: buffer.subarray(0, bytesRead).toString('base64'), nextOffset: offset + bytesRead < stat.size ? offset + bytesRead : null }; }
      finally { await handle.close(); }
    }),
    'library/upload/start': params => locked(async () => {
      const destination = relative(params.path);
      if (!Number.isSafeInteger(params.size) || params.size < 0 || params.size > MAX_FILE) fail('单个文件目前支持最大 256 MB');
      let active = 0;
      for (const name of await fsp.readdir(path.join(meta, 'uploads'))) if (/^[\da-f-]{36}\.json$/.test(name)) {
        const record = path.join(meta, 'uploads', name), old = JSON.parse(await fsp.readFile(record, 'utf8'));
        if (Date.now() - old.createdAt > 24 * 3600_000) { await fsp.unlink(path.join(meta, 'uploads', name.replace(/\.json$/, '.part'))).catch(() => {}); await fsp.unlink(record); }
        else if (!old.result) active++;
      }
      if (active >= 16) fail('正在上传的文件过多，请稍后重试', -32042);
      const id = uid(); await fsp.writeFile(path.join(meta, 'uploads', `${id}.json`), JSON.stringify({ path: destination, size: params.size, expectedSha256: params.expectedSha256, createdAt: Date.now() })); await fsp.writeFile(path.join(meta, 'uploads', `${id}.part`), ''); return { id, chunkBytes: CHUNK };
    }),
    'library/upload/cancel': params => locked(async () => {
      if (!/^[\da-f-]{36}$/.test(params.id)) fail('上传编号无效');
      const record = path.join(meta, 'uploads', `${params.id}.json`);
      const upload = JSON.parse(await fsp.readFile(record, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
      if (upload.result) return { cancelled: false };
      await fsp.unlink(path.join(meta, 'uploads', `${params.id}.part`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fsp.unlink(record).catch(error => { if (error.code !== 'ENOENT') throw error; }); return { cancelled: true };
    }),
    'library/upload/chunk': params => locked(async () => {
      if (!/^[\da-f-]{36}$/.test(params.id) || typeof params.base64 !== 'string' || params.base64.length > CHUNK * 1.34 + 4) fail('上传分块无效');
      const upload = JSON.parse(await fsp.readFile(path.join(meta, 'uploads', `${params.id}.json`), 'utf8'));
      const source = path.join(meta, 'uploads', `${params.id}.part`), bytes = Buffer.from(params.base64, 'base64'), stat = await fsp.stat(source);
      if (!Number.isSafeInteger(params.offset) || params.offset < 0 || params.offset + bytes.length > upload.size || bytes.length > CHUNK) fail('上传分块位置无效');
      if (params.offset < stat.size) { const handle = await fsp.open(source, 'r'); try { const existing = Buffer.alloc(bytes.length); const { bytesRead } = await handle.read(existing, 0, bytes.length, params.offset); if (bytesRead === bytes.length && existing.equals(bytes)) return { offset: params.offset + bytes.length }; } finally { await handle.close(); } fail('上传重试内容不同', -32005); }
      if (params.offset !== stat.size) fail('上传分块顺序不正确', -32005);
      await fsp.appendFile(source, bytes); return { offset: stat.size + bytes.length };
    }),
    'library/upload/finish': params => locked(async index => {
      if (!/^[\da-f-]{36}$/.test(params.id)) fail('上传编号无效');
      const record = path.join(meta, 'uploads', `${params.id}.json`), upload = JSON.parse(await fsp.readFile(record, 'utf8'));
      if (upload.result) return upload.result;
      const source = path.join(meta, 'uploads', `${params.id}.part`);
      if ((await fsp.stat(source)).size !== upload.size) fail('文件还没有完整上传');
      const result = await publish(index, source, upload.path, upload.expectedSha256);
      upload.result = result; await fsp.writeFile(record, JSON.stringify(upload)); await fsp.unlink(source); return result;
    }),
    'library/move': params => locked(async index => {
      await scan(index); const from = await checked(params.from), to = await checked(params.to, { missing: true });
      if (to.rel.startsWith(from.rel + '/') || to.rel === from.rel) fail('请选择不同的目标位置');
      if (await fsp.lstat(to.target).catch(() => null)) fail('目标位置已存在同名资料', -32005);
      await fsp.rename(from.target, to.target);
      for (const entry of index.entries) if (!entry.trashedAt && (entry.path === from.rel || entry.path.startsWith(from.rel + '/'))) { entry.path = to.rel + entry.path.slice(from.rel.length); entry.name = path.basename(entry.path); }
      return { path: to.rel };
    }),
    'library/trash': params => locked(async index => {
      await scan(index); const selected = await checked(params.path);
      const entries = index.entries.filter(entry => !entry.trashedAt && (entry.path === selected.rel || entry.path.startsWith(selected.rel + '/')));
      // Snapshots already exist before removal. A crash can be reconciled from those copies.
      const stat = await fsp.lstat(selected.target);
      if (stat.isFile() && stat.size > MAX_FILE) fail('文件超过 256 MB，尚未保存完整历史，请在文件管理器中处理');
      await persist(index);
      if (stat.isDirectory()) {
        const id = uid(), held = path.join(meta, 'trash', id);
        const folder = { id, folder: true, path: selected.rel, name: path.basename(selected.rel), size: entries.reduce((sum, entry) => sum + entry.size, 0), versions: [], trashedAt: now(), modifiedAt: now() };
        await fsp.writeFile(`${held}.json`, JSON.stringify({ folder, children: entries })); await fsp.rename(selected.target, held);
        index.entries.push(folder);
        for (const entry of entries) { entry.trashedAt = now(); entry.parentTrash = id; }
        return { trashed: entries.length, folder: selected.rel };
      }
      if (!entries.length) fail('请先导入这份文件，再移动到回收站');
      await fsp.unlink(selected.target); for (const entry of entries) entry.trashedAt = now(); return { trashed: entries.length };
    }),
    'library/restore': params => locked(async index => {
      const entry = index.entries.find(item => item.id === params.id && item.trashedAt); if (!entry) fail('回收站里没有这份资料', -32004);
      const destination = relative(params.path ?? entry.path); const { target } = await checked(destination, { missing: true });
      if (await fsp.lstat(target).catch(() => null)) fail('原位置已有同名文件，请修改恢复位置', -32005);
      if (entry.folder) {
        await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.rename(path.join(meta, 'trash', entry.id), target);
        for (const child of index.entries) if (child.parentTrash === entry.id) { child.path = destination + child.path.slice(entry.path.length); child.name = path.basename(child.path); child.trashedAt = null; delete child.parentTrash; }
        index.entries = index.entries.filter(item => item.id !== entry.id); return { path: destination, folder: true };
      }
      await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.copyFile(path.join(meta, 'versions', entry.id, entry.sha256), target, fs.constants.COPYFILE_EXCL);
      await snapshot(index, destination, target, entry); return publicEntry(entry);
    }),
    'library/versions': params => locked(async index => { const entry = index.entries.find(item => item.id === params.id); if (!entry) fail('找不到这份资料', -32004); return [...entry.versions].reverse(); }),
    // First content-search vertical: bounded on-demand scan of text files.
    // Hits return the file plus line snippets so the UI can jump to context.
    'library/search': params => locked(async index => {
      const query = typeof params.query === 'string' ? params.query.trim() : '';
      if (!query) return { hits: [] };
      const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 50);
      const needle = query.toLocaleLowerCase();
      const textFile = /\.(md|txt|json|csv|tsv|log|ya?ml|toml|ini|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|c|cpp|h|sh|ps1|bat|sql|xml)$/i;
      const searchLimit = 1024 * 1024;
      const buffer = Buffer.alloc(searchLimit + 1);
      const hits = [];
      for (const entry of index.entries) {
        if (hits.length >= limit) break;
        if (entry.trashedAt || !textFile.test(entry.name)) continue;
        let raw;
        try {
          const { target } = await checked(entry.path);
          const handle = await fsp.open(target, 'r');
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > searchLimit) continue;
            let length = 0;
            while (length < buffer.length) {
              const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
              if (!bytesRead) break;
              length += bytesRead;
            }
            // A file can grow after stat; never read beyond the search limit.
            if (length > searchLimit) continue;
            raw = buffer.toString('utf8', 0, length);
          } finally { await handle.close(); }
        } catch { continue; }
        if (!raw.toLocaleLowerCase().includes(needle)) continue;
        const lines = raw.split(/\r?\n/);
        const snippets = [];
        for (const [offset, line] of lines.entries()) {
          if (line.toLocaleLowerCase().includes(needle)) {
            snippets.push({ line: offset + 1, text: line.trim().slice(0, 200) });
            if (snippets.length >= 3) break;
          }
        }
        hits.push({ id: entry.id, path: entry.path, name: entry.name, sha256: entry.sha256, totalLines: lines.length, snippets });
      }
      return { hits, scanned: true };
    }),
    'library/revert': params => locked(async index => { const entry = index.entries.find(item => item.id === params.id && !item.trashedAt); if (!entry?.versions.some(version => version.sha256 === params.version)) fail('找不到这个版本', -32004); return publish(index, path.join(meta, 'versions', entry.id, params.version), entry.path, params.expectedSha256); }),
    'library/workspace': () => locked(async index => {
      if (!rpc) fail('当前环境无法创建助手任务');
      if (index.workspaceId) { const existing = await rpc('workspace/read', { id: index.workspaceId }).catch(() => null); if (existing) return existing; }
      const workspace = await rpc('workspace/create', { title: '个人资料库', cwd: root }); index.workspaceId = workspace.id; return workspace;
    }),
    'library/import-project': params => locked(async index => {
      if (!rpc) fail('当前环境无法读取项目文件');
      const selected = await rpc('workspace/path/resolve', { threadId: params.threadId, path: params.path });
      // Use the same authoritative resolver and validation as desktop open/preview.
      const { scopeParams, verifyResolvedPath } = require('./desktop-path-actions');
      const scope = scopeParams({ threadId: params.threadId, path: params.path });
      const verified = verifyResolvedPath(selected, scope);
      if (verified.kind !== 'file') fail('请选择项目中的文件');
      if ((await fsp.stat(verified.target)).size > MAX_FILE) fail('单个文件目前支持最大 256 MB');
      return publish(index, verified.target, params.destination, params.expectedSha256);
    }),
  };
  return { handlers, root, content, async put(source, destination, expectedSha256) { return locked(async index => { if ((await fsp.stat(source)).size > MAX_FILE) fail('单个文件目前支持最大 256 MB'); return publish(index, source, destination, expectedSha256); }); } };
}
module.exports = { createPersonalLibrary, METHODS, MAX_FILE, CHUNK, relative, fileHash, hash };
