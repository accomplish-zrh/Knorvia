'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { planPreferencesMigration, verifyPlanSources, sha256 } = require('./fixtures/workspace-migration-plan');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-migration-design-'));
  const source = path.join(root, 'Windows-userData'), home = path.join(root, 'portable', 'Knorvia-data');
  fs.mkdirSync(path.join(source, 'settings', 'wallpapers'), { recursive: true }); fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(source, 'window-appearance.json'), JSON.stringify({ theme: 'light', frost: true, reducedMotion: true, unknownSecret: 'never export' }));
  fs.writeFileSync(path.join(source, 'settings', 'wallpaper.json'), JSON.stringify({ id: 'custom' }));
  fs.writeFileSync(path.join(source, 'settings', 'wallpapers', 'custom.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
  fs.writeFileSync(path.join(source, 'provider-config.json'), 'private credentials must stay here');
  fs.mkdirSync(path.join(source, 'Local Storage')); fs.writeFileSync(path.join(source, 'Local Storage', 'live-db'), 'do not copy a live database');
  // This fixture creates its own parent and checks the canonical cleanup scope before recursive deletion.
  t.after(() => {
    const canonical = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^knorvia-migration-design-/);
    fs.rmSync(canonical, { recursive: true, force: true });
  });
  return { root, source, home, plan: () => planPreferencesMigration({ sourceUserData: source, targetHome: home }) };
}
function fixturePublish(plan, { interrupt = false } = {}) {
  verifyPlanSources(plan);
  const staging = `${plan.destination}.staging-${randomUUID()}`; fs.mkdirSync(staging);
  for (const entry of plan.files) {
    const bytes = entry.json === undefined ? fs.readFileSync(path.join(plan.source, ...entry.sourceRelativePath.split('/')))
      : Buffer.from(`${JSON.stringify(entry.json, null, 2)}\n`);
    assert.equal(sha256(bytes), entry.sha256);
    const target = path.join(staging, ...entry.targetRelativePath.split('/')); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' }); assert.equal(sha256(fs.readFileSync(target)), entry.sha256);
  }
  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(plan), { flag: 'wx' });
  if (interrupt) return { staging, published: false };
  verifyPlanSources(plan); fs.renameSync(staging, plan.destination);
  return { published: true, destination: plan.destination };
}
test('A29 plans only allowlisted preferences, normalizes fields, and publishes fixture without touching source', t => {
  const f = fixture(t), original = fs.readFileSync(path.join(f.source, 'window-appearance.json')), plan = f.plan();
  assert.equal(plan.files.length, 3); assert.equal(fs.existsSync(plan.destination), false);
  assert.equal(JSON.stringify(plan).includes('never export'), false);
  assert.equal(fixturePublish(plan).published, true);
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'window-appearance.json')), original);
  assert.equal(fs.existsSync(path.join(plan.destination, 'provider-config.json')), false);
  assert.equal(fs.existsSync(path.join(plan.destination, 'Local Storage')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plan.destination, 'window-appearance.json'))), { theme: 'light', frost: true, reducedMotion: true });
  assert.throws(() => f.plan(), /already exists/);
});
test('A29 interruption leaves source and published path untouched, and a changed source invalidates a plan', t => {
  const f = fixture(t), plan = f.plan(), original = fs.readFileSync(path.join(f.source, 'settings', 'wallpapers', 'custom.png'));
  const result = fixturePublish(plan, { interrupt: true });
  assert.equal(fs.existsSync(plan.destination), false); assert.equal(fs.existsSync(result.staging), true);
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'settings', 'wallpapers', 'custom.png')), original);
  fs.writeFileSync(path.join(f.source, 'settings', 'wallpaper.json'), JSON.stringify({ id: 'none' }));
  assert.throws(() => fixturePublish(plan), /source changed/);
  assert.equal(fs.existsSync(plan.destination), false);
});
test('A29 refuses existing targets, ambiguous assets, malformed preferences and linked input directories', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, 'settings', 'wallpapers', 'custom.jpg'), 'other');
  assert.throws(f.plan, /ambiguous/); fs.unlinkSync(path.join(f.source, 'settings', 'wallpapers', 'custom.jpg'));
  fs.writeFileSync(path.join(f.source, 'window-appearance.json'), '{'); assert.throws(f.plan);
  const outside = path.join(f.root, 'other'); fs.mkdirSync(outside);
  const link = path.join(f.root, 'linked-data'); fs.symlinkSync(outside, link, 'junction');
  assert.throws(() => planPreferencesMigration({ sourceUserData: link, targetHome: f.home }), /links|junctions/);
  fs.unlinkSync(link);
});
