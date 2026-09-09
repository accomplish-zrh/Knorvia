'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createPersonalLibrary, CHUNK, hash } = require('../personal-library');
async function fixture(t) { const home = await fs.mkdtemp(path.join(os.tmpdir(), 'knorvia-library-test-')); t.after(() => fs.rm(home, { recursive: true, force: true })); const library = createPersonalLibrary({ home }); return { home, library, call: (method, params = {}) => library.handlers[`library/${method}`](params) }; }
test('real files preserve revisions, reject stale edits, survive restart and recover from trash', async t => {
  const { home, library, call } = await fixture(t);
  const first = await call('write', { path: '笔记.md', text: '原文' });
  assert.equal(await fs.readFile(path.join(library.content, '笔记.md'), 'utf8'), '原文');
  await assert.rejects(call('write', { path: '笔记.md', text: '覆盖' }), error => error.rpc.code === -32005);
  const second = await call('write', { path: '笔记.md', text: '已编辑', expectedSha256: first.sha256 });
  await assert.rejects(call('write', { path: '笔记.md', text: '旧客户端', expectedSha256: first.sha256 }), error => error.rpc.code === -32005);
  const restarted = createPersonalLibrary({ home });
  assert.equal((await restarted.handlers['library/list']()).entries[0].versions, 2);
  const old = await call('read', { id: first.id, version: first.sha256 }); assert.equal(Buffer.from(old.base64, 'base64').toString(), '原文');
  await call('trash', { path: '笔记.md' }); await assert.rejects(fs.stat(path.join(library.content, '笔记.md')), { code: 'ENOENT' });
  await call('restore', { id: first.id }); assert.equal(await fs.readFile(path.join(library.content, '笔记.md'), 'utf8'), '已编辑');
  await call('revert', { id: first.id, version: first.sha256, expectedSha256: second.sha256 });
  assert.equal(await fs.readFile(path.join(library.content, '笔记.md'), 'utf8'), '原文');
});
test('multipart binary import validates order and duplicate chunks, hashes actual bytes and supports cancellation', async t => {
  const { call, library } = await fixture(t); const data = Buffer.alloc(CHUNK + 913, 173), upload = await call('upload/start', { path: '二进制.bin', size: data.length });
  await assert.rejects(call('upload/chunk', { id: upload.id, offset: 100, base64: 'YQ==' }), error => error.rpc.code === -32005);
  const first = { id: upload.id, offset: 0, base64: data.subarray(0, CHUNK).toString('base64') };
  await call('upload/chunk', first); await call('upload/chunk', first);
  await assert.rejects(call('upload/finish', { id: upload.id }));
  await call('upload/chunk', { id: upload.id, offset: CHUNK, base64: data.subarray(CHUNK).toString('base64') });
  const entry = await call('upload/finish', { id: upload.id }); assert.deepEqual(await call('upload/finish', { id: upload.id }), entry);
  assert.equal(entry.sha256, hash(data)); assert.deepEqual(await fs.readFile(path.join(library.content, entry.path)), data);
  const cancel = await call('upload/start', { path: 'cancel.bin', size: 99 }); await call('upload/cancel', cancel); await assert.rejects(call('upload/finish', cancel));
});
test('folder move and recoverable trash retain contents and old revisions, including a post-rename crash receipt', async t => {
  const { home, library, call } = await fixture(t); await call('folder', { path: '资料' }); await call('folder', { path: '资料/子目录' });
  const entry = await call('write', { path: '资料/子目录/a.md', text: 'one' });
  await call('move', { from: '资料', to: '改名' }); assert.equal((await call('list')).entries[0].path, '改名/子目录/a.md');
  await call('trash', { path: '改名' }); const trash = (await call('list')).entries.find(item => item.folder);
  // Emulate an old index surviving after the physical rename. The receipt repairs it.
  const catalog = path.join(library.root, '.knorvia-library/index.json'); const old = JSON.parse(await fs.readFile(catalog)); old.entries = old.entries.filter(item => !item.folder); old.entries[0].trashedAt = null; delete old.entries[0].parentTrash; await fs.writeFile(catalog, JSON.stringify(old));
  const reboot = createPersonalLibrary({ home }); const repaired = await reboot.handlers['library/list'](); assert.equal(repaired.entries.find(item => item.id === entry.id).parentTrash, trash.id);
  await call('restore', { id: trash.id, path: '恢复' }); assert.equal(await fs.readFile(path.join(library.content, '恢复/子目录/a.md'), 'utf8'), 'one');
  assert.equal((await call('list')).entries.find(item => item.id === entry.id).versions, 1);
});
test('path traversal, absolute and reserved paths and directory links never reach outside the library', async t => {
  const { home, call } = await fixture(t); await call('info');
  for (const invalid of ['../escape', 'C:/escape', '/escape', 'a/../b', 'nul.txt', 'foo.', 'a//b']) await assert.rejects(call('write', { path: invalid, text: 'no' }));
  const outside = path.join(home, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(home, 'personal-library/files/link'), 'junction');
  await assert.rejects(call('write', { path: 'link/escape.txt', text: 'no' })); assert.deepEqual(await fs.readdir(outside), []);
});
test('installed helper and UI catalog share revisions and recoverable deletions across processes', async t => {
  const { library, call } = await fixture(t); await call('info');
  const cli = path.join(library.root, '.knorvia-library/tools/personal-library-cli.js');
  const exec = promisify(execFile); const invoke = async (...args) => JSON.parse((await exec(process.execPath, [cli, ...args], { cwd: library.root })).stdout);
  const created = await invoke('write', 'agent.md', 'created by real helper');
  await invoke('write', 'agent.md', 'modified by helper', created.sha256);
  assert.equal((await call('list')).entries[0].versions, 2);
  await invoke('trash', 'agent.md'); assert.ok((await call('list')).entries[0].trashedAt);
  await invoke('restore', created.id); assert.equal(await fs.readFile(path.join(library.content, 'agent.md'), 'utf8'), 'modified by helper');
});
test('two library clients with the same revision cannot silently overwrite each other', async t => {
  const { home, call } = await fixture(t); const first = await call('write', { path: 'shared.txt', text: 'original' });
  const other = createPersonalLibrary({ home });
  const results = await Promise.allSettled([call('write', { path: first.path, text: 'one', expectedSha256: first.sha256 }), other.handlers['library/write']({ path: first.path, text: 'two', expectedSha256: first.sha256 })]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1); assert.equal(results.filter(item => item.status === 'rejected')[0].reason.rpc.code, -32005);
});
test('an externally enlarged file cannot be deleted while only an older small revision is archived', async t => {
  const { library, call } = await fixture(t); await call('write', { path: 'grown.bin', text: 'small' });
  const target = path.join(library.content, 'grown.bin'); await fs.truncate(target, 256 * 1024 * 1024 + 1);
  await assert.rejects(call('trash', { path: 'grown.bin' })); assert.equal((await fs.stat(target)).size, 256 * 1024 * 1024 + 1);
});

test('saving into a missing folder creates it, so studio and agent saves never need a pre-made folder', async t => {
  const { home, call, library } = await fixture(t);
  const source = path.join(home, 'uploads-temp.png');
  await fs.writeFile(source, Buffer.from([137, 80, 78, 71]));
  const entry = await library.put(source, '创作/2026/作品.png');
  assert.equal(entry.path, '创作/2026/作品.png');
  assert.equal((await fs.readFile(path.join(library.content, '创作', '2026', '作品.png'))).subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])), true);
  assert.deepEqual((await call('list')).entries.map(item => item.path), ['创作/2026/作品.png']);
});

test('content search returns files with line snippets and skips trashed entries', async t => {
  const { call } = await fixture(t);
  await call('write', { path: 'notes/plan.md', text: '# 计划\n\n今晚的暗号是菠萝披萨\n普通行' });
  await call('write', { path: 'notes/other.txt', text: '无关内容' });
  const trashed = await call('write', { path: 'notes/old.md', text: '回收站里的菠萝披萨' });
  await call('trash', { path: 'notes/old.md' });
  void trashed;
  const result = await call('search', { query: '菠萝披萨' });
  assert.deepEqual(result.hits.map(hit => hit.path), ['notes/plan.md']);
  assert.equal(result.hits[0].snippets[0].line, 3);
  assert.match(result.hits[0].snippets[0].text, /菠萝披萨/);
  assert.deepEqual(await call('search', { query: '   ' }), { hits: [] });
  assert.deepEqual((await call('search', { query: '不存在的词' })).hits, []);
});

test('content search matches case consistently and preserves the original snippet', async t => {
  const { call } = await fixture(t);
  await call('write', { path: 'notes.md', text: '# Notes\nCodex 工作台\n' });
  for (const query of ['codex', 'CODEX']) {
    const result = await call('search', { query });
    assert.deepEqual(result.hits.map(hit => ({ path: hit.path, snippets: hit.snippets })), [
      { path: 'notes.md', snippets: [{ line: 2, text: 'Codex 工作台' }] },
    ]);
  }
});

test('content search never follows a catalogued folder replaced by an external junction', async t => {
  const { home, library, call } = await fixture(t);
  await call('write', { path: 'notes/private.txt', text: 'library contents' });
  const outside = path.join(home, 'outside-search');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.txt'), 'external-search-marker');
  await fs.rename(path.join(library.content, 'notes'), path.join(library.content, 'original-notes'));
  await fs.symlink(outside, path.join(library.content, 'notes'), 'junction');
  assert.deepEqual((await call('search', { query: 'external-search-marker' })).hits, []);
});

test('content search checks the current file size instead of trusting an older catalog entry', async t => {
  const { library, call } = await fixture(t);
  await call('write', { path: 'grown.txt', text: 'small' });
  const grown = Buffer.alloc(1024 * 1024 + 1, 32);
  grown.write('oversized-search-marker');
  await fs.writeFile(path.join(library.content, 'grown.txt'), grown);
  assert.deepEqual((await call('search', { query: 'oversized-search-marker' })).hits, []);
});
