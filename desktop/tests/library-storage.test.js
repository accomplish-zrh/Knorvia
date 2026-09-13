'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPersonalLibrary } = require('../personal-library');

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'knorvia-library-storage-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const library = createPersonalLibrary({ home });
  return { home, library, call: (method, params = {}) => library.handlers[`library/${method}`](params) };
}

test('storage plan previews reclaimable space and deletes nothing', async t => {
  const { library, call } = await fixture(t);
  const second = await call('write', { path: 'a.md', text: 'one' });
  await call('write', { path: 'a.md', text: 'two', expectedSha256: second.sha256 });
  await call('write', { path: 'b.md', text: 'three' });
  await call('write', { path: 'old.md', text: 'deleted content here' });
  await call('trash', { path: 'old.md' });
  await call('folder', { path: 'proj' });
  await call('write', { path: 'proj/x.md', text: 'inside folder' });
  await call('trash', { path: 'proj' });

  const versionsDir = path.join(library.root, '.knorvia-library', 'versions');
  const before = (await fs.readdir(versionsDir)).sort();
  const plan = await call('storage/plan');
  const after = (await fs.readdir(versionsDir)).sort();
  assert.deepEqual(after, before, 'the preview must not touch a single file');
  assert.equal(plan.trash.items, 2, 'one trashed file + one trashed folder');
  assert.ok(plan.trash.bytes >= Buffer.byteLength('deleted content here') + Buffer.byteLength('inside folder'));
  assert.equal(plan.history.versions, 1, 'a.md v1 is the only superseded version');
  assert.ok(plan.reclaimableBytes > 0);
  assert.equal(plan.deletions.length, plan.trash.items + plan.history.versions);
  assert.match(plan.token, /^[0-9a-f]{64}$/);
});

test('cleanup removes history and trash, keeps the working copy and latest version readable', async t => {
  const { call, library } = await fixture(t);
  const v1 = await call('write', { path: 'a.md', text: 'one' });
  const v2 = await call('write', { path: 'a.md', text: 'two', expectedSha256: v1.sha256 });
  const junk = await call('write', { path: 'junk.md', text: 'junk' });
  await call('trash', { path: 'junk.md' });
  const plan = await call('storage/plan');
  const result = await call('storage/cleanup', { token: plan.token });
  assert.equal(result.removedVersions, 1);
  assert.equal(result.removedTrashItems, 1);
  assert.ok(result.freedBytes >= Buffer.byteLength('one') + Buffer.byteLength('junk'));
  // Working copy intact, latest version readable, history version unreadable.
  assert.equal(await fs.readFile(path.join(library.content, 'a.md'), 'utf8'), 'two');
  const current = await call('read', { id: v2.id });
  assert.equal(Buffer.from(current.base64, 'base64').toString(), 'two');
  await assert.rejects(call('read', { id: v1.id, version: v1.sha256 }), error => error.rpc.code === -32004);
  const versionFile = path.join(library.root, '.knorvia-library', 'versions', v2.id, v1.sha256);
  await assert.rejects(fs.stat(versionFile), { code: 'ENOENT' }, 'removed history version is gone from disk');
  assert.equal(await fs.stat(path.join(library.root, '.knorvia-library', 'versions', v2.id, v2.sha256)).then(s => s.isFile()), true, 'latest version file kept');
  await assert.rejects(fs.stat(path.join(library.content, 'junk.md')), { code: 'ENOENT' });
  const list = await call('list');
  assert.equal(list.entries.find(item => item.id === junk.id), undefined, 'purged trash entry leaves the catalog');
  // A fresh plan is empty afterwards and a stale rerun is rejected.
  const fresh = await call('storage/plan');
  assert.equal(fresh.deletions.length, 0);
  await assert.rejects(call('storage/cleanup', { token: plan.token }), error => error.rpc.code === -32005);
  const rerun = await call('storage/cleanup', { token: fresh.token });
  assert.equal(rerun.freedBytes, 0);
});

test('a plan computed before a library change is rejected as stale', async t => {
  const { call } = await fixture(t);
  const entry = await call('write', { path: 'doc.md', text: 'v1' });
  await call('write', { path: 'doc.md', text: 'v2', expectedSha256: entry.sha256 });
  const plan = await call('storage/plan');
  // The library changes after the user received the plan.
  const current = await call('read', { id: entry.id });
  await call('write', { path: 'doc.md', text: 'v3', expectedSha256: entry.sha256 }).catch(() => {});
  const latest = await call('list');
  const live = latest.entries.find(item => item.id === entry.id);
  await call('write', { path: 'doc.md', text: 'v3', expectedSha256: live.sha256 });
  await assert.rejects(call('storage/cleanup', { token: plan.token }), error => error.rpc.code === -32005);
  const refreshed = await call('storage/plan');
  assert.equal(refreshed.history.versions, 2);
  const done = await call('storage/cleanup', { token: refreshed.token });
  assert.equal(done.removedVersions, 2);
});

test('move and trash identity guards reject replaced, renamed or edited paths', async t => {
  const { call } = await fixture(t);
  const entry = await call('write', { path: 'doc.md', text: 'original' });
  await call('move', { from: 'doc.md', to: 'renamed.md', expectedId: entry.id, expectedSha256: entry.sha256 });
  // A different entry now owns the old path: the stale identity must not be
  // able to act on it.
  const replacement = await call('write', { path: 'doc.md', text: 'replacement file' });
  await assert.rejects(
    call('move', { from: 'doc.md', to: 'hijacked.md', expectedId: entry.id }),
    error => error.rpc.code === -32005,
  );
  await call('move', { from: 'doc.md', to: 'doc3.md', expectedId: replacement.id, expectedSha256: replacement.sha256 });
  // Trash with a stale hash (content changed after the caller looked).
  const live = (await call('list')).entries.find(item => item.path === 'doc3.md');
  await call('write', { path: 'doc3.md', text: 'edited', expectedSha256: live.sha256 });
  await assert.rejects(
    call('trash', { path: 'doc3.md', expectedId: live.id, expectedSha256: live.sha256 }),
    error => error.rpc.code === -32005,
  );
  // The edited file is still there, untouched by the rejected call.
  assert.equal(await fs.readFile(path.join((await call('info')).filesRoot, 'doc3.md'), 'utf8'), 'edited');
  // REVIEW counterexample: the caller pinned a file that was since moved
  // away and NOT replaced. The old path is empty on disk, but with identity
  // fields provided this must surface as a Conflict, not a raw ENOENT.
  const moved = await call('write', { path: 'vanish.md', text: 'will vanish' });
  await call('move', { from: 'vanish.md', to: 'elsewhere.md' });
  await assert.rejects(
    call('trash', { path: 'vanish.md', expectedId: moved.id, expectedSha256: moved.sha256 }),
    error => error.rpc.code === -32005,
  );
  await assert.rejects(
    call('move', { from: 'vanish.md', to: 'again.md', expectedId: moved.id }),
    error => error.rpc.code === -32005,
  );
  // Legacy calls without identity fields behave exactly as before.
  const plain = await call('write', { path: 'plain.md', text: 'plain' });
  await call('trash', { path: 'plain.md' });
  await call('restore', { id: plain.id });
});

test('cleanup crash window leaves orphans that the next plan reclaims', async t => {
  const { call, library } = await fixture(t);
  const entry = await call('write', { path: 'doc.md', text: 'v1' });
  await call('write', { path: 'doc.md', text: 'v2', expectedSha256: entry.sha256 });
  const plan = await call('storage/cleanup', { token: (await call('storage/plan')).token });
  assert.equal(plan.removedVersions, 1);
  // Simulate a crash after the catalog commit but before the unlink: an
  // orphaned version directory exists on disk without any catalog reference.
  const orphanDir = path.join(library.root, '.knorvia-library', 'versions', 'not-an-entry');
  await fs.mkdir(orphanDir, { recursive: true });
  await fs.writeFile(path.join(orphanDir, 'blob'), 'y'.repeat(20));
  const next = await call('storage/plan');
  const orphan = next.deletions.find(item => item.kind === 'orphan-versions');
  assert.ok(orphan, 'the orphaned version directory must be visible in the next preview');
  assert.equal(orphan.bytes, 20);
  const cleanup = await call('storage/cleanup', { token: next.token });
  assert.equal(cleanup.removedVersions, 0);
  assert.ok(cleanup.freedBytes >= 20);
  await assert.rejects(fs.stat(path.join(library.root, '.knorvia-library', 'versions', 'not-an-entry')), { code: 'ENOENT' });
});
