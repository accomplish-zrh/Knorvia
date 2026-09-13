'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  attemptMigration,
  resolveWorkspaceRoot,
  readPendingMigration,
  retryPendingMigration,
  writePendingMigration,
  clearPendingMigration,
  legacyCandidates,
} = require('../workspace-migration');
const { recoveryScreen } = require('../startup-screen');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-migration-'));
}

function seedLegacy(parent, marker = 'legacy user notebook') {
  const legacy = legacyCandidates(parent)[0];
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'data.txt'), marker, 'utf8');
  return legacy;
}

test('blocked rename keeps the legacy directory intact and records a code-only pending state', () => {
  const parent = tempHome();
  const userData = tempHome();
  const target = path.join(parent, 'Knorvia-data');
  const legacy = seedLegacy(parent);
  const realRename = fs.renameSync;
  try {
    const outcome = (() => {
      const patched = new Proxy(fs, {
        get(t, prop) {
          if (prop === 'renameSync') {
            return () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); };
          }
          return Reflect.get(t, prop);
        },
      });
      return attemptMigration({ parent, target, fsImpl: patched });
    })();
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.code, 'EBUSY');
    assert.equal(outcome.operation, 'rename');
    // The legacy data is untouched at its original location.
    assert.equal(fs.readFileSync(path.join(legacy, 'data.txt'), 'utf8'), 'legacy user notebook');
    assert.equal(fs.existsSync(target), false, 'no partial or empty target directory may appear');
    writePendingMigration(userData, {
      parent, target, legacy: outcome.legacy, code: outcome.code, operation: outcome.operation, at: new Date().toISOString(),
    });
    const pending = readPendingMigration(userData);
    assert.equal(pending.code, 'EBUSY');
    const raw = fs.readFileSync(path.join(userData, 'pending-workspace-migration.json'), 'utf8');
    // The state carries directory paths and the OS code only — no content,
    // no credentials, no error message text.
    assert.equal(JSON.parse(raw).version, 1);
    assert.doesNotMatch(raw, /resource busy|legacy user notebook/);
  } finally {
    fs.renameSync = realRename;
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('an existing target is never overwritten and the migration stays idempotent', () => {
  const parent = tempHome();
  seedLegacy(parent, 'old data');
  const target = path.join(parent, 'Knorvia-data');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'existing.txt'), 'current workspace', 'utf8');
  const outcome = attemptMigration({ parent, target });
  assert.equal(outcome.status, 'ready');
  assert.deepEqual(outcome.migrated, []);
  assert.equal(fs.readFileSync(path.join(target, 'existing.txt'), 'utf8'), 'current workspace');
  assert.equal(fs.existsSync(legacyCandidates(parent)[0]), true, 'legacy stays put when target exists');
  fs.rmSync(parent, { recursive: true, force: true });
});

test('retry after the lock is released migrates once, clears state, and repeats idempotently', () => {
  const parent = tempHome();
  const userData = tempHome();
  const target = path.join(parent, 'Knorvia-data');
  const legacy = seedLegacy(parent);
  let locked = true;
  const realRename = fs.renameSync;
  const mock = (source, dest) => {
    if (locked) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return realRename(source, dest);
  };
  const patched = new Proxy(fs, {
    get(t, prop) { return prop === 'renameSync' ? mock : Reflect.get(t, prop); },
  });
  try {
    const first = attemptMigration({ parent, target, fsImpl: patched });
    assert.equal(first.status, 'blocked');
    writePendingMigration(userData, { parent, target, legacy, code: first.code, at: new Date().toISOString() });
    locked = false;
    const retry = retryPendingMigration(userData, patched);
    assert.equal(retry.status, 'ready');
    assert.equal(fs.readFileSync(path.join(target, 'data.txt'), 'utf8'), 'legacy user notebook');
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(readPendingMigration(userData), null, 'pending state cleared after success');
    const second = retryPendingMigration(userData, patched);
    assert.deepEqual(second, { status: 'idle' }, 'retry without pending state is a no-op');
    // After migration a fresh attempt sees the existing target and does not overwrite.
    assert.equal(attemptMigration({ parent, target }).migrated.length, 0);
  } finally {
    fs.renameSync = realRename;
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('a repeat blocked retry refreshes the recorded code and keeps the recovery entry', () => {
  const parent = tempHome();
  const userData = tempHome();
  const target = path.join(parent, 'Knorvia-data');
  seedLegacy(parent);
  let code = 'EBUSY';
  const patched = new Proxy(fs, {
    get(t, prop) {
      if (prop === 'renameSync') return () => { throw Object.assign(new Error('x'), { code }); };
      return Reflect.get(t, prop);
    },
  });
  try {
    writePendingMigration(userData, { parent, target, code: 'EPERM', at: new Date().toISOString() });
    const outcome = retryPendingMigration(userData, patched);
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.code, 'EBUSY');
    assert.equal(readPendingMigration(userData).code, 'EBUSY', 'state kept for the next retry');
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('workspace root decision tree: env, dev, portable and appData layouts', () => {
  const parent = tempHome();
  try {
    assert.deepEqual(resolveWorkspaceRoot({ envRoot: 'relative/path' }).status, 'invalid-env');
    assert.equal(resolveWorkspaceRoot({ envRoot: 'relative/path' }).status, 'invalid-env');
    const ready = resolveWorkspaceRoot({ envRoot: parent, packaged: true });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.root, path.resolve(parent));
    const dev = resolveWorkspaceRoot({ packaged: false, devFallbackRoot: path.join(parent, 'desktop-data') });
    assert.equal(dev.root, path.join(parent, 'desktop-data'));
    const portable = resolveWorkspaceRoot({ packaged: true, portableDir: parent });
    assert.equal(portable.status, 'ready');
    assert.equal(portable.root, path.join(parent, 'Knorvia-data'), 'portable layout resolves under the portable dir');
    clearPendingMigration(parent);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('startup recovery screen renders bounded actions and sanitizes the code', () => {
  const logo = Buffer.from('89504e47').toString('base64');
  const html = recoveryScreen({ logo, code: 'EPERM<script>alert(1)</script>' });
  assert.match(html, /重试迁移/);
  assert.match(html, /打开旧数据目录/);
  assert.match(html, /退出/);
  assert.match(html, /旧数据保持原样/);
  assert.doesNotMatch(html, /script>alert/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /knorviaDesktop\.migration/);
});
