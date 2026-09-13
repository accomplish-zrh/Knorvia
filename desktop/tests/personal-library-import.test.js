'use strict';
// P05 acceptance: batch import against the real personal-library backend.
// 30 synthetic files including zero-byte, duplicate names and the 256 MiB
// boundary, plus finish-retry idempotency and cancel races. No real model,
// no user data — everything lives in a per-test temp Home.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPersonalLibrary, CHUNK, MAX_FILE, hash } = require('../personal-library');

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'knorvia-import-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const library = createPersonalLibrary({ home });
  const call = (method, params = {}) => library.handlers[`library/${method}`](params);
  return { home, library, call };
}

async function uploadBytes(call, relativePath, data, expectedSha256) {
  const upload = await call('upload/start', { path: relativePath, size: data.length, expectedSha256 });
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    await call('upload/chunk', { id: upload.id, offset, base64: data.subarray(offset, offset + CHUNK).toString('base64') });
  }
  return call('upload/finish', { id: upload.id });
}

test('30-file batch imports with zero-byte, duplicate names and nested folders', async t => {
  const { call } = await fixture(t);
  const sources = [];
  for (let i = 0; i < 29; i++) {
    sources.push({ path: `批次${Math.floor(i / 10)}/资料-${String(i).padStart(2, '0')}.md`, data: Buffer.from(`# 资料 ${i}\n\n内容 ${i}。\n`) });
  }
  sources.push({ path: '批次0/空文件.txt', data: Buffer.alloc(0) });
  for (const source of sources) await uploadBytes(call, source.path, source.data);
  const index = await call('list');
  assert.equal(index.entries.filter(item => !item.trashedAt).length, 30, 'all 30 files imported');
  for (const source of sources) {
    const entry = index.entries.find(item => item.path === source.path);
    assert.ok(entry, `${source.path} present`);
    assert.equal(entry.sha256, hash(source.data));
  }
  const empty = index.entries.find(item => item.path === '批次0/空文件.txt');
  assert.equal(empty.size, 0, 'zero-byte import survives');
  const read = await call('read', { id: empty.id });
  assert.equal(read.size, 0);
});

test('duplicate names conflict until the caller chooses: keep both, or overwrite as a version', async t => {
  const { call } = await fixture(t);
  const first = await uploadBytes(call, '报告.md', Buffer.from('第一版'));
  // Same name without the current sha is a typed conflict — never a silent
  // overwrite.
  await assert.rejects(uploadBytes(call, '报告.md', Buffer.from('第二版')), error => error.rpc.code === -32005);
  assert.equal((await call('list')).entries.filter(item => item.path === '报告.md').length, 1);
  // Overwrite-as-version with the current sha: one entry, two versions.
  const second = await uploadBytes(call, '报告.md', Buffer.from('第二版'), first.sha256);
  assert.equal(second.id, first.id, 'same entry');
  assert.equal(second.versions, 2);
  const old = await call('read', { id: first.id, version: first.sha256 });
  assert.equal(Buffer.from(old.base64, 'base64').toString(), '第一版', 'original version preserved');
  // Keep-both: a second entry under an adjacent name.
  const copy = await uploadBytes(call, '报告 (2).md', Buffer.from('第二版'));
  assert.notEqual(copy.id, first.id);
  assert.equal((await call('list')).entries.filter(item => item.path.startsWith('报告')).length, 2);
});

test('256 MiB boundary: exact size uploads, one byte over is rejected', async t => {
  const { call } = await fixture(t);
  await assert.rejects(call('upload/start', { path: 'too-big.bin', size: MAX_FILE + 1 }), error => /256 MB|最大/.test(error.message));
  const sparse = Buffer.alloc(MAX_FILE); // zero-filled sparse fixture
  const entry = await uploadBytes(call, '边界.bin', sparse);
  assert.equal(entry.size, MAX_FILE);
  assert.equal(entry.sha256, hash(sparse), 'hash covers every byte of the sparse fixture');
});

test('finish retry after a lost response is idempotent; cancel cannot revoke success', async t => {
  const { call } = await fixture(t);
  const data = Buffer.from('幂等 finish');
  const upload = await call('upload/start', { path: '网络重试.md', size: data.length });
  await call('upload/chunk', { id: upload.id, offset: 0, base64: data.toString('base64') });
  const first = await call('upload/finish', { id: upload.id });
  const replay = await call('upload/finish', { id: upload.id });
  assert.deepEqual(replay, first, 'replayed finish returns the same entry');
  const cancel = await call('upload/cancel', { id: upload.id });
  assert.deepEqual(cancel, { cancelled: false }, 'cancel after finish does nothing');
  const index = await call('list');
  assert.equal(index.entries.filter(item => item.path === '网络重试.md').length, 1, 'no duplicate entry');
});

test('canceling mid-upload removes only its own part and record', async t => {
  const { call, library } = await fixture(t);
  const upload = await call('upload/start', { path: '取消我.bin', size: CHUNK * 2 });
  await call('upload/chunk', { id: upload.id, offset: 0, base64: Buffer.alloc(CHUNK, 7).toString('base64') });
  const canceled = await call('upload/cancel', { id: upload.id });
  assert.deepEqual(canceled, { cancelled: true });
  const uploadsDir = path.join(library.root, '.knorvia-library', 'uploads');
  const leftovers = (await fs.readdir(uploadsDir)).filter(name => name.startsWith(upload.id));
  assert.deepEqual(leftovers, [], 'part file and record cleaned');
  const index = await call('list');
  assert.ok(!index.entries.some(item => item.path === '取消我.bin'));
});
