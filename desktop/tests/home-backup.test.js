'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createHomeBackup,
  resolvePendingHomeOverride,
  writePendingHomeOverride,
  clearPendingHomeOverride,
  OVERRIDE_FILE,
} = require('../home-backup');
const { createPersonalLibrary } = require('../personal-library');

async function tempDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

// A realistic fixture Home: user settings (with opaque ciphertext credentials),
// a personal library with real history and a trash entry, kernel state, and
// extension records with retained packages.
async function seedHome(t) {
  const home = await tempDir(t, 'knorvia-home-src-');
  await fsp.mkdir(path.join(home, 'data', 'user', 'settings'), { recursive: true });
  await fsp.writeFile(path.join(home, 'data', 'user', 'settings', 'interface.json'), JSON.stringify({ theme: 'snow' }));
  await fsp.writeFile(path.join(home, 'data', 'user', 'settings', 'model-connection.json'), JSON.stringify({ encrypted: 'opaque-safe-storage-ciphertext' }));
  const library = createPersonalLibrary({ home });
  const v1 = await library.handlers['library/write']({ path: 'notes.md', text: 'version one' });
  await library.handlers['library/write']({ path: 'notes.md', text: 'version two', expectedSha256: v1.sha256 });
  const junk = await library.handlers['library/write']({ path: 'junk.txt', text: 'to trash' });
  await library.handlers['library/trash']({ path: 'junk.txt' });
  await library.handlers['library/write']({ path: 'user-supplied.lock', text: 'this suffix is user data' });
  await fsp.mkdir(path.join(home, 'state', 'kernel', 'skills', 'demo'), { recursive: true });
  await fsp.writeFile(path.join(home, 'state', 'kernel', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\nbody');
  await fsp.writeFile(path.join(home, 'state', 'kernel', 'history.jsonl'), JSON.stringify({ threadId: 't1', status: 'completed' }));
  const packageDir = path.join(home, 'extensions', 'marketplaces', '1e46dea1-1111-4111-8111-111111111111', 'packages', 'v1', 'plugin');
  await fsp.mkdir(packageDir, { recursive: true });
  await fsp.writeFile(path.join(packageDir, 'SKILL.md'), '---\nname: packaged\n---\nbody');
  await fsp.writeFile(path.join(home, 'extensions', 'catalog.json'), JSON.stringify({ version: 1, entries: [{ id: '1e46dea1-1111-4111-8111-111111111111', name: 'demo', revision: 1, enabled: false, activeVersion: 'v1', versions: [{ id: 'v1' }] }] }));
  await fsp.mkdir(path.join(home, 'settings'), { recursive: true });
  await fsp.writeFile(path.join(home, 'settings', 'media.json'), JSON.stringify({ volume: 0.5 }));
  await fsp.mkdir(path.join(home, 'worktree-snapshots', '00000000-0000-4000-8000-000000000001'), { recursive: true });
  await fsp.writeFile(path.join(home, 'worktree-snapshots', '00000000-0000-4000-8000-000000000001', 'snapshot.json'), JSON.stringify({ state: 'inspected' }));
  await fsp.mkdir(path.join(home, 'exports'), { recursive: true });
  await fsp.writeFile(path.join(home, 'exports', '用户成果.txt'), 'portable export');
  return { home, library, v1, junk };
}

function makeBackup(t, home) {
  return createHomeBackup({
    home,
    appVersion: '1.1.0-test',
    lockPaths: [path.join(home, 'personal-library', '.knorvia-library', 'write.lock'), path.join(home, 'extensions', 'catalog.lock')],
    now: () => '2026-09-11T23:59:00.000Z',
  });
}

test('a seeded Home exports after shutdown, verifies, and restores to an empty directory with identical hashes', async t => {
  const { home, v1 } = await seedHome(t);
  const destination = path.join(await tempDir(t, 'knorvia-home-dst-'), 'backup-one');
  const target = path.join(await tempDir(t, 'knorvia-home-ret-'), 'restored');
  const backup = makeBackup(t, home);
  const plan = await backup.plan();
  assert.equal(plan.canExportNow, true);
  assert.ok(plan.components.some((c) => c.name === 'data' && c.requiresReloginOnOtherMachine), 'credentials flagged');
  assert.ok(plan.totalBytes > 0 && plan.totalFiles > 0);
  const exported = await backup.export({ destination });
  assert.equal(exported.ok, true);
  const verification = await backup.verify(destination);
  assert.equal(verification.ok, true, verification.problems?.join(';'));
  const preview = await backup.previewRestore(destination);
  assert.equal(preview.ok, true);
  assert.ok(preview.components.length >= 5);
  const restored = await backup.restore({ backupDir: destination, targetHome: target });
  assert.equal(restored.ok, true);
  // The restored Home reads the same records: the real library sees both
  // versions and the trash entry, hashes intact.
  const restoredLibrary = createPersonalLibrary({ home: target });
  const list = await restoredLibrary.handlers['library/list']();
  const entry = list.entries.find((item) => item.path === 'notes.md');
  assert.equal(entry.versions, 2);
  const read = await restoredLibrary.handlers['library/read']({ id: entry.id, version: v1.sha256 });
  assert.equal(Buffer.from(read.base64, 'base64').toString(), 'version one');
  assert.ok(list.entries.some((item) => item.path === 'junk.txt' && item.trashedAt), 'trash survives restore');
  const lockEntry = list.entries.find((item) => item.path === 'user-supplied.lock');
  const lockRead = await restoredLibrary.handlers['library/read']({ id: lockEntry.id });
  assert.equal(Buffer.from(lockRead.base64, 'base64').toString(), 'this suffix is user data');
  assert.equal(
    await fsp.readFile(path.join(target, 'data', 'user', 'settings', 'model-connection.json'), 'utf8'),
    JSON.stringify({ encrypted: 'opaque-safe-storage-ciphertext' }),
    'credential file copies as opaque ciphertext',
  );
  assert.ok(fs.existsSync(path.join(target, '.knorvia-backup', 'restore.json')), 'restore receipt written');
  assert.equal(await fsp.readFile(path.join(target, 'settings', 'media.json'), 'utf8'), JSON.stringify({ volume: 0.5 }));
  assert.ok(fs.existsSync(path.join(target, 'worktree-snapshots', '00000000-0000-4000-8000-000000000001', 'snapshot.json')));
  assert.equal(await fsp.readFile(path.join(target, 'exports', '用户成果.txt'), 'utf8'), 'portable export');
});

test('a corrupt backup fails verification and restore never creates the target', async t => {
  const { home, v1 } = await seedHome(t);
  const destination = path.join(await tempDir(t, 'knorvia-home-dst2-'), 'backup-two');
  const target = path.join(await tempDir(t, 'knorvia-home-ret2-'), 'restored');
  const backup = makeBackup(t, home);
  await backup.export({ destination });
  // Corrupt one payload file.
  const victim = path.join(destination, 'state', 'kernel', 'history.jsonl');
  await fsp.writeFile(victim, 'tampered');
  const verification = await backup.verify(destination);
  assert.equal(verification.ok, false);
  assert.ok(verification.problems.some((p) => /哈希不符/.test(p)));
  await assert.rejects(backup.restore({ backupDir: destination, targetHome: target }), error => error.rpc.code === -32004);
  assert.equal(fs.existsSync(target), false, 'no half-restored Home is left behind');
});

test('an existing target, the running Home, and path traversal are all refused', async t => {
  const { home, v1 } = await seedHome(t);
  const destination = path.join(await tempDir(t, 'knorvia-home-dst3-'), 'backup-three');
  const existingTarget = path.join(await tempDir(t, 'knorvia-home-ret3-'), 'occupied');
  await fsp.mkdir(existingTarget);
  const backup = makeBackup(t, home);
  await backup.export({ destination });
  await assert.rejects(backup.export({ destination }), error => /已存在/.test(error.message));
  await assert.rejects(backup.restore({ backupDir: destination, targetHome: existingTarget }), error => /已存在/.test(error.message));
  await assert.rejects(backup.restore({ backupDir: destination, targetHome: home }), error => /当前正在使用/.test(error.message));
  // A tampered manifest with a traversal entry cannot escape the backup dir.
  const filesPath = path.join(destination, 'files.jsonl');
  const evil = JSON.stringify({ p: '../../../escaped.txt', s: 1, h: '0'.repeat(64) });
  await fsp.writeFile(filesPath, `${evil}\n`);
  const preview = await backup.previewRestore(destination);
  assert.equal(preview.ok, false);
  assert.ok(preview.problems.some((p) => /路径穿越|无效/.test(p)));
});

test('export refuses while a writer lock is held and cancels cleanly on failure', async t => {
  const { home, v1 } = await seedHome(t);
  const destination = path.join(await tempDir(t, 'knorvia-home-dst4-'), 'backup-four');
  const backup = makeBackup(t, home);
  const lockFile = path.join(home, 'personal-library', '.knorvia-library', 'write.lock');
  await fsp.mkdir(lockFile);
  const plan = await backup.plan();
  assert.equal(plan.canExportNow, false);
  assert.equal(plan.busyLocks.length, 1);
  assert.equal(plan.requiresSafeShutdown, true);
  await assert.rejects(backup.export({ destination }), error => /写入锁/.test(error.message));
  assert.equal(fs.existsSync(destination), false);
  await fsp.rmdir(lockFile);
  const exported = await backup.export({ destination });
  assert.equal(exported.ok, true);
});

test('symlinks inside the Home are skipped, never followed', async t => {
  const home = await tempDir(t, 'knorvia-home-link-');
  await fsp.mkdir(path.join(home, 'data'));
  await fsp.writeFile(path.join(home, 'data', 'real.json'), '{}');
  const outside = await tempDir(t, 'knorvia-home-outside-');
  await fs.symlinkSync(outside, path.join(home, 'data', 'linked'), 'junction');
  const destination = path.join(await tempDir(t, 'knorvia-home-dst5-'), 'backup-five');
  const backup = makeBackup(t, home);
  const plan = await backup.plan();
  assert.ok(plan.warnings.some((warning) => /符号链接/.test(warning)));
  const exported = await backup.export({ destination });
  assert.equal(exported.ok, true);
  assert.equal(fs.existsSync(path.join(destination, 'data', 'linked')), false, 'links are not copied');
  assert.equal((await fsp.readdir(outside)).length, 0, 'the link target was never written');
});

test('verification rejects a backup payload directory replaced by a junction', async t => {
  const { home } = await seedHome(t);
  const destination = path.join(await tempDir(t, 'knorvia-home-link-dst-'), 'backup');
  const outside = await tempDir(t, 'knorvia-home-link-payload-');
  const backup = makeBackup(t, home);
  await backup.export({ destination });
  await fsp.cp(path.join(destination, 'state'), outside, { recursive: true });
  await fsp.rm(path.join(destination, 'state'), { recursive: true });
  fs.symlinkSync(outside, path.join(destination, 'state'), 'junction');
  const verification = await backup.verify(destination);
  assert.equal(verification.ok, false);
  assert.ok(verification.problems.some(problem => /符号链接|junction/.test(problem)));
});

test('restore rejects a target whose parent junction resolves inside the active Home', async t => {
  const { home } = await seedHome(t);
  const destination = path.join(await tempDir(t, 'knorvia-home-parent-dst-'), 'backup');
  const aliasRoot = await tempDir(t, 'knorvia-home-parent-alias-');
  const alias = path.join(aliasRoot, 'home-alias');
  fs.symlinkSync(home, alias, 'junction');
  const backup = makeBackup(t, home);
  await backup.export({ destination });
  await assert.rejects(
    backup.restore({ backupDir: destination, targetHome: path.join(alias, 'new-home') }),
    error => error?.rpc?.code === -32005 && /junction|当前 Home/.test(error.message),
  );
});

test('mid-file cancellation never publishes the final destination', async t => {
  const home = await tempDir(t, 'knorvia-home-cancel-src-');
  await fsp.mkdir(path.join(home, 'artifacts'), { recursive: true });
  const largeFile = path.join(home, 'artifacts', 'large.bin');
  await fsp.writeFile(largeFile, '');
  await fsp.truncate(largeFile, 64 * 1024 * 1024);
  const destination = path.join(await tempDir(t, 'knorvia-home-cancel-dst-'), 'backup');
  const controller = new AbortController();
  const backup = createHomeBackup({
    home,
    acquireLease: async () => ({ held: true, isAlive: () => true, release: async () => {} }),
    freeSpace: async () => {
      setTimeout(() => controller.abort(), 5);
      return Number.POSITIVE_INFINITY;
    },
  });
  await assert.rejects(backup.export({ destination, signal: controller.signal }), error => error?.rpc?.code === -32040);
  assert.equal(fs.existsSync(destination), false);
});

test('directory traversal observes cancellation and removes its owned staging root', async t => {
  const base = await tempDir(t, 'knorvia-home-walk-abort-');
  const home = path.join(base, 'home');
  const destination = path.join(base, 'backup');
  for (let index = 0; index < 20; index += 1) {
    const dir = path.join(home, 'data', `folder-${String(index).padStart(2, '0')}`);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'record.json'), '{}');
  }
  const controller = new AbortController();
  const originalLstat = fsp.lstat;
  let walked = 0;
  fsp.lstat = async function patchedLstat(candidate, ...args) {
    const result = await originalLstat.call(this, candidate, ...args);
    if (path.resolve(String(candidate)).startsWith(path.resolve(home) + path.sep) && ++walked === 8) controller.abort();
    return result;
  };
  t.after(() => { fsp.lstat = originalLstat; });
  const backup = createHomeBackup({
    home,
    freeSpace: async () => Number.POSITIVE_INFINITY,
    acquireLease: async () => ({ held: true, isAlive: () => true, release: async () => {} }),
  });
  await assert.rejects(backup.export({ destination, signal: controller.signal }), error => error?.name === 'AbortError' || error?.rpc?.code === -32040);
  assert.ok(walked >= 8);
  assert.equal(fs.existsSync(destination), false);
  assert.equal((await fsp.readdir(base)).some(name => name.includes('.knorvia-staging-')), false);
});

test('post-copy source hashes and directory generation reject an unmanaged writer', async t => {
  for (const mutation of ['content', 'directory']) {
    const base = await tempDir(t, `knorvia-home-generation-${mutation}-`);
    const home = path.join(base, 'home');
    const destination = path.join(base, 'backup');
    const source = path.join(home, 'data', 'record.json');
    await fsp.mkdir(path.dirname(source), { recursive: true });
    await fsp.writeFile(source, 'aa');
    let leaseChecks = 0;
    const backup = createHomeBackup({
      home,
      freeSpace: async () => Number.POSITIVE_INFINITY,
      acquireLease: async () => ({
        held: true,
        isAlive: () => {
          leaseChecks += 1;
          if (leaseChecks === 2) {
            if (mutation === 'content') {
              const writer = spawnSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "bb")', source], {
                windowsHide: true, stdio: 'ignore',
              });
              if (writer.status !== 0) throw new Error('cross-process fixture writer failed');
            }
            else fs.writeFileSync(path.join(home, 'data', 'late.json'), '{}');
          }
          return true;
        },
        release: async () => {},
      }),
    });
    await assert.rejects(
      backup.export({ destination }),
      error => error?.rpc?.code === -32040 && /发生变化|重新校验/.test(error.message),
    );
    assert.equal(fs.existsSync(destination), false, `${mutation} drift must not publish`);
    assert.equal((await fsp.readdir(base)).some(name => name.includes('.knorvia-staging-')), false);
  }
});

test('losing the daemon OS lease after the last copied file blocks publish', async t => {
  const base = await tempDir(t, 'knorvia-home-lease-loss-');
  const home = path.join(base, 'home');
  const destination = path.join(base, 'backup');
  await fsp.mkdir(path.join(home, 'data'), { recursive: true });
  await fsp.writeFile(path.join(home, 'data', 'record.json'), '{}');
  let checks = 0;
  const backup = createHomeBackup({
    home,
    freeSpace: async () => Number.POSITIVE_INFINITY,
    acquireLease: async () => ({ held: true, isAlive: () => ++checks === 1, release: async () => {} }),
  });
  await assert.rejects(
    backup.export({ destination }),
    error => error?.rpc?.code === -32040 && /lease was lost/.test(error.message),
  );
  assert.ok(checks >= 2, 'lease is checked again after the final file copy');
  assert.equal(fs.existsSync(destination), false);
});

test('a deadline observed during final destination lstat prevents atomic publish', async t => {
  const base = await tempDir(t, 'knorvia-home-final-lstat-');
  const home = path.join(base, 'home');
  const destination = path.join(base, 'backup');
  await fsp.mkdir(path.join(home, 'data'), { recursive: true });
  await fsp.writeFile(path.join(home, 'data', 'record.json'), '{}');
  const controller = new AbortController();
  const originalLstat = fsp.lstat;
  let destinationChecks = 0;
  fsp.lstat = async function patchedLstat(candidate, ...args) {
    try { return await originalLstat.call(this, candidate, ...args); }
    finally {
      if (path.resolve(String(candidate)) === path.resolve(destination) && ++destinationChecks === 3) controller.abort();
    }
  };
  t.after(() => { fsp.lstat = originalLstat; });
  const backup = createHomeBackup({
    home,
    freeSpace: async () => Number.POSITIVE_INFINITY,
    acquireLease: async () => ({ held: true, isAlive: () => true, release: async () => {} }),
  });
  await assert.rejects(backup.export({ destination, signal: controller.signal }), error => error?.name === 'AbortError' || error?.rpc?.code === -32040);
  assert.equal(fs.existsSync(destination), false);
  assert.equal((await fsp.readdir(base)).some(name => name.includes('.knorvia-staging-')), false);
});

test('a failed copy removes its registered partial staging file and owned directory', async t => {
  const { Readable } = require('node:stream');
  const base = await tempDir(t, 'knorvia-home-partial-copy-');
  const home = path.join(base, 'home');
  const destination = path.join(base, 'backup');
  const source = path.join(home, 'data', 'record.json');
  await fsp.mkdir(path.dirname(source), { recursive: true });
  await fsp.writeFile(source, 'source bytes');
  const originalCreateReadStream = fs.createReadStream;
  let sourceReads = 0;
  fs.createReadStream = function patchedCreateReadStream(candidate, ...args) {
    if (path.resolve(String(candidate)) === path.resolve(source) && ++sourceReads === 2) {
      let sent = false;
      return new Readable({
        read() {
          if (sent) return;
          sent = true;
          this.push(Buffer.alloc(1024, 7));
          setImmediate(() => this.destroy(new Error('fixture copy failure')));
        },
      });
    }
    return originalCreateReadStream.call(this, candidate, ...args);
  };
  t.after(() => { fs.createReadStream = originalCreateReadStream; });
  const backup = createHomeBackup({
    home,
    freeSpace: async () => Number.POSITIVE_INFINITY,
    acquireLease: async () => ({ held: true, isAlive: () => true, release: async () => {} }),
  });
  await assert.rejects(backup.export({ destination }), /fixture copy failure/);
  assert.equal(fs.existsSync(destination), false);
  assert.equal((await fsp.readdir(base)).some(name => name.includes('.knorvia-staging-')), false, 'owned partial staging tree is removed');
});

test('staged verification observes its abort signal', async t => {
  const base = await tempDir(t, 'knorvia-home-verify-abort-');
  const home = path.join(base, 'home');
  const destination = path.join(base, 'backup');
  await fsp.mkdir(path.join(home, 'artifacts'), { recursive: true });
  await fsp.writeFile(path.join(home, 'artifacts', 'record.bin'), Buffer.alloc(2 * 1024 * 1024, 3));
  const backup = createHomeBackup({
    home,
    freeSpace: async () => Number.POSITIVE_INFINITY,
    acquireLease: async () => ({ held: true, isAlive: () => true, release: async () => {} }),
  });
  await backup.export({ destination });
  const controller = new AbortController();
  const originalCreateReadStream = fs.createReadStream;
  let armed = true;
  fs.createReadStream = function patchedCreateReadStream(candidate, ...args) {
    const stream = originalCreateReadStream.call(this, candidate, ...args);
    if (armed && path.resolve(String(candidate)).startsWith(path.resolve(destination) + path.sep)) {
      armed = false;
      setTimeout(() => controller.abort(), 1);
    }
    return stream;
  };
  t.after(() => { fs.createReadStream = originalCreateReadStream; });
  await assert.rejects(backup.verify(destination, { signal: controller.signal }), error => error?.name === 'AbortError');
});

test('the pending Home override only honours directories with a restore receipt', async t => {
  const userData = await tempDir(t, 'knorvia-home-userdata-');
  const restoredHome = await tempDir(t, 'knorvia-home-restored-');
  assert.equal(resolvePendingHomeOverride(userData), null);
  writePendingHomeOverride(userData, restoredHome);
  assert.equal(resolvePendingHomeOverride(userData), null, 'no receipt yet — override ignored');
  await fsp.mkdir(path.join(restoredHome, '.knorvia-backup'), { recursive: true });
  await fsp.writeFile(path.join(restoredHome, '.knorvia-backup', 'restore.json'), JSON.stringify({ version: 1, restoredAt: '2026-09-12T00:00:00Z' }));
  const override = resolvePendingHomeOverride(userData);
  assert.equal(override.root, restoredHome);
  // A forged override pointing at an arbitrary directory is not honoured.
  writePendingHomeOverride(userData, os.tmpdir());
  assert.equal(resolvePendingHomeOverride(userData), null);
  clearPendingHomeOverride(userData);
  assert.equal(resolvePendingHomeOverride(userData), null);
  assert.equal(fs.existsSync(path.join(userData, OVERRIDE_FILE)), false);
});
