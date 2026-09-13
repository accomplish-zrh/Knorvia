'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExtensionManager } = require('../extension-manager');

const skill = (name, body = 'Use the fixture') => `---\nname: ${name}\ndescription: >-\n  A useful skill\n  for fixture work\n---\n${body}\n`;

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-ext-storage-'));
  const sourceDir = path.join(home, 'input');
  fs.mkdirSync(sourceDir);
  const rpc = async (method, p) => {
    if (method === 'workspace/path/resolve') {
      const target = path.join(sourceDir, p.path);
      return { workspace: { id: 'fixture', cwd: sourceDir }, absolutePath: target, kind: fs.statSync(target).isDirectory() ? 'directory' : 'file' };
    }
    if (method === 'skills/list') return { data: [{ skills: [] }] };
    if (method.startsWith('extension/kernel/')) return { ok: true };
    throw new Error(`Unexpected RPC ${method}`);
  };
  const manager = createExtensionManager({ home, rpc });
  const source = { type: 'local', workspaceId: 'fixture', path: '' };
  const call = (method, p = {}) => manager.handlers[method](p);
  const install = async p => { const inspected = await call('extension/inspect', { source }); return call('extension/install', { source, expectedSha256: inspected.sha256, ...p }); };
  return { home, sourceDir, manager, source, call, install };
}

test('uninstalled orphan packages are reviewable and reclaimable; installed packages are not in the plan', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('keep-me'));
  const kept = await f.install();
  fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('drop-me'));
  const dropped = await f.install();
  await f.call('extension/uninstall', { id: dropped.id, revision: dropped.revision });
  const marketRoot = path.join(f.home, 'extensions', 'marketplaces');
  assert.equal(fs.existsSync(path.join(marketRoot, dropped.id)), true, 'uninstall retains packages by design');
  const plan = await f.call('extension/storage/plan');
  assert.deepEqual(plan.reclaimable.map(item => item.id), [dropped.id], 'only the uninstalled package is reclaimable');
  assert.ok(plan.reclaimable[0].bytes > 0);
  assert.equal(plan.protectedModified.length, 0);
  assert.deepEqual(plan.installed.map(item => item.id), [kept.id]);
  const result = await f.call('extension/storage/cleanup', { token: plan.token });
  assert.equal(result.removedPackages, 1);
  assert.equal(fs.existsSync(path.join(marketRoot, dropped.id)), false, 'orphan package reclaimed');
  assert.equal(fs.existsSync(path.join(marketRoot, kept.id)), true, 'installed package untouched');
  // The kept extension still works after cleanup.
  const enabled = await f.call('extension/enable', { id: kept.id, revision: kept.revision, enabled: true });
  assert.equal(enabled.enabled, true);
});

test('rollback references are never reclaimable and a stale plan is rejected', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('multi-version', 'v1'));
  const entry = await f.install();
  const v1 = entry.activeVersion;
  fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('multi-version', 'v2'));
  const updated = await f.install({ id: entry.id, revision: entry.revision });
  await f.call('extension/rollback', { id: entry.id, revision: updated.revision, version: v1 });
  const before = await f.call('extension/storage/plan');
  assert.deepEqual(before.reclaimable, [], 'referenced versions (incl. the rolled-back one) are protected');
  // An orphan appears after the preview: the token no longer matches.
  const marketRoot = path.join(f.home, 'extensions', 'marketplaces');
  const orphan = path.join(marketRoot, '01234567-89ab-cdef-0123-456789abcdef');
  fs.mkdirSync(path.join(orphan, 'packages', 'x'), { recursive: true });
  fs.writeFileSync(path.join(orphan, 'packages', 'x', 'data'), 'leftover');
  await assert.rejects(f.call('extension/storage/cleanup', { token: before.token }), error => error.rpc.code === -32005);
  const fresh = await f.call('extension/storage/plan');
  assert.equal(fresh.reclaimable.length, 1);
  const result = await f.call('extension/storage/cleanup', { token: fresh.token });
  assert.equal(result.removedPackages, 1);
  assert.equal(fs.existsSync(path.join(marketRoot, entry.id)), true, 'both referenced versions remain');
  assert.equal(fs.existsSync(path.join(marketRoot, entry.id, 'packages', v1)), true);
});

test('a referenced version modified after install is reported, never auto-deleted', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('edited-package'));
  const entry = await f.install();
  const plugin = path.join(f.home, 'extensions', 'marketplaces', entry.id, 'packages', entry.activeVersion, 'plugin');
  fs.appendFileSync(path.join(plugin, 'SKILL.md'), '\nuser edit');
  const plan = await f.call('extension/storage/plan');
  assert.deepEqual(plan.reclaimable, [], 'modified referenced versions are not reclaimable');
  assert.equal(plan.protectedModified.length, 1);
  assert.match(plan.protectedModified[0].reason, /不会自动删除/);
  await f.call('extension/storage/cleanup', { token: plan.token });
  assert.equal(fs.existsSync(path.join(plugin, 'SKILL.md')), true, 'cleanup must not delete the modified package');
});

test('an unreferenced version folder inside an installed entry is reclaimable on its own', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('partial-orphan'));
  const entry = await f.install();
  const packagesDir = path.join(f.home, 'extensions', 'marketplaces', entry.id, 'packages');
  const strayId = '99999999-9999-4999-8999-999999999999';
  fs.mkdirSync(path.join(packagesDir, strayId, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(packagesDir, strayId, 'plugin', 'SKILL.md'), skill('stray'));
  const plan = await f.call('extension/storage/plan');
  assert.deepEqual(plan.reclaimable.map(item => item.kind), ['orphan-version']);
  assert.equal(plan.reclaimable[0].versionId, strayId);
  const result = await f.call('extension/storage/cleanup', { token: plan.token });
  assert.equal(result.removedVersions, 1);
  assert.equal(fs.existsSync(path.join(packagesDir, strayId)), false);
  assert.equal(fs.existsSync(path.join(packagesDir, entry.activeVersion)), true, 'referenced version untouched');
});

test('cleanup refuses to run while an interrupted transition journal is present', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('journal-case'));
  await f.install();
  fs.writeFileSync(path.join(f.home, 'extensions', 'pending-transition.json'), JSON.stringify({ version: 1, previous: null, next: null }));
  const plan = await f.call('extension/storage/plan');
  await assert.rejects(f.call('extension/storage/cleanup', { token: plan.token }), error => error.rpc.code === -32094);
  fs.unlinkSync(path.join(f.home, 'extensions', 'pending-transition.json'));
  const result = await f.call('extension/storage/cleanup', { token: plan.token });
  assert.equal(result.removedPackages, 0);
});
