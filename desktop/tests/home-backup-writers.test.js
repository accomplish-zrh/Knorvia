'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHomeBackup, runPendingBackupRequest, acquireOsDaemonLockLease } = require('../home-backup');
const { createPersonalLibrary } = require('../personal-library');

async function seededHome(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-writers-home-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await fsp.mkdir(path.join(home, 'data', 'user', 'settings'), { recursive: true });
  await fsp.writeFile(path.join(home, 'data', 'user', 'settings', 'interface.json'), '{}');
  return home;
}

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-writers-tmp-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

function backup(t, home) {
  return createHomeBackup({ home, appVersion: '1.1.0-test' });
}

test('a blocked writer receipt refuses the export and creates nothing', async t => {
  const home = await seededHome(t);
  const destination = path.join(await tempDir(t), 'backup');
  const prefs = backup(t, home);
  // The daemon's shutdown step did not confirm within its slice.
  await assert.rejects(
    prefs.export({ destination, blockedWriters: ['native-runtime(unconfirmed)', 'media-studio(unconfirmed)'] }),
    error => {
      assert.equal(error.rpc.code, -32040);
      assert.match(error.message, /native-runtime\(unconfirmed\)/);
      assert.match(error.message, /media-studio\(unconfirmed\)/);
      return true;
    },
  );
  assert.equal(fs.existsSync(destination), false, 'no destination directory is created for a blocked copy');
  // After the writers really exit, the same request succeeds.
  const exported = await prefs.export({ destination, blockedWriters: [] });
  assert.equal(exported.ok, true);
});

// X (07:34 review): the real orchestration function main.js calls — the
// same pending/result files, real pending JSON, a seeded readable record,
// and every step awaited.
function orchestrationFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-writers-orch-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-writers-orch-ud-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const pendingFile = path.join(userData, 'pending-home-backup.json');
  const resultFile = path.join(userData, 'last-home-backup-result.json');
  const destination = path.join(userData, 'backup-dest');
  fs.mkdirSync(path.join(home, 'data', 'user', 'settings'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'user', 'settings', 'interface.json'), '{}', 'utf8');
  const library = createPersonalLibrary({ home });
  fs.writeFileSync(pendingFile, JSON.stringify({ version: 1, destination }), 'utf8');
  return { home, userData, pendingFile, resultFile, destination, library };
}

async function runOrchestration(t, overrides = {}) {
  const base = orchestrationFixture(t);
  // Seed a real readable record before any orchestration runs.
  await base.library.handlers['library/write']({ path: 'notes.md', text: 'orchestrated backup fixture' });
  const options = {
    home: base.home,
    userDataDir: base.userData,
    appVersion: '1.1.0-test',
    pendingFile: base.pendingFile,
    resultFile: base.resultFile,
    lockPaths: overrides.lockPaths || [],
    blockedWriters: [],
    ...overrides,
  };
  return { base, result: await runPendingBackupRequest(options) };
}

test('orchestration: a blocked writer receipt refuses the copy, keeps the pending request retryable and names the components', async t => {
  const { base, result } = await runOrchestration(t, {
    blockedWriters: ['native-runtime(unconfirmed)', 'knorvia-daemon process alive'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.ok(result.blockedWriters.includes('native-runtime(unconfirmed)'));
  assert.equal(fs.existsSync(base.destination), false, 'the copy never ran');
  assert.equal(fs.existsSync(base.pendingFile), true, 'the pending request survives for retry');
  const persisted = JSON.parse(fs.readFileSync(base.resultFile, 'utf8'));
  assert.equal(persisted.retryable, true);
  assert.ok(persisted.blockedWriters.includes('knorvia-daemon process alive'));
});

test('orchestration: the controller-exception conclusion (no steps) still blocks the copy', async t => {
  const { base, result } = await runOrchestration(t, {
    blockedWriters: ['shutdown-controller: unconfirmed'],
  });
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(base.destination), false);
  assert.equal(fs.existsSync(base.pendingFile), true);
});

test('orchestration: with every writer confirmed the copy runs, verifies and clears the pending request', async t => {
  const { base, result } = await runOrchestration(t, {});
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.existsSync(base.pendingFile), false, 'success clears the pending request');
  const verification = await backup(t, base.home).verify(base.destination);
  assert.equal(verification.ok, true, verification.problems?.join(';'));
  // Restore into a fresh directory and read the original records through
  // the real library.
  const target = path.join(base.userData, 'restored-home');
  const restored = await backup(t, base.home).restore({ backupDir: base.destination, targetHome: target });
  assert.equal(restored.ok, true);
  const restoredLibrary = createPersonalLibrary({ home: target });
  const list = await restoredLibrary.handlers['library/list']();
  assert.ok(list.entries.length >= 1, 'restored library reads the original records');
});

test('an existing chosen output must be refused and its content preserved, never treated as owned debris', async t => {
  const home = await seededHome(t);
  // An existing user directory containing files (not a completed backup)
  const existingDir = path.join(await tempDir(t), 'existing-user-dir');
  fs.mkdirSync(path.join(existingDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(existingDir, 'data', 'partial.txt'), 'precious-user-data');
  const prefs = backup(t, home);
  await assert.rejects(
    prefs.export({ destination: existingDir }),
    error => {
      assert.equal(error.rpc.code, -32005);
      assert.match(error.message, /已存在/);
      return true;
    },
  );
  // User content must be preserved, never deleted as debris!
  assert.equal(fs.existsSync(path.join(existingDir, 'data', 'partial.txt')), true, 'pre-existing file must survive');
  assert.equal(fs.readFileSync(path.join(existingDir, 'data', 'partial.txt'), 'utf8'), 'precious-user-data');
});

test('failure cleanup only removes directories created during the current run with matching staging token', async t => {
  const home = await seededHome(t);
  const destination = path.join(await tempDir(t), 'failed-export');
  let stagingDir;
  let foreign;
  // freeSpace runs after the staging directory and ownership token exist.
  // Simulate an unrelated actor adding a file before this export fails.
  const failBackup = createHomeBackup({
    home,
    appVersion: '1.1.0-test',
    freeSpace: async (candidate) => {
      stagingDir = candidate;
      foreign = path.join(candidate, 'arrived-after-staging.txt');
      await fsp.writeFile(foreign, 'foreign user content');
      throw new Error('disk full simulated failure');
    },
  });
  await assert.rejects(failBackup.export({ destination }), error => /disk full/.test(error.message));
  assert.equal(fs.existsSync(destination), false, 'the user-selected final path is never published on failure');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign user content', 'failure cleanup preserves files it did not create');
  assert.equal(fs.existsSync(path.join(stagingDir, '.knorvia-export-staging')), false, 'the export removes only its ownership token');
});

test('OS daemon lock contention on state/daemon.lock refuses export with -32040 before reading files', async t => {
  const home = await seededHome(t);
  const destination = path.join(await tempDir(t), 'backup-os-lock');
  const daemonLock = path.join(home, 'state', 'daemon.lock');
  // External process (daemon or another writer) acquires exclusive OS file lock
  const externalLease = await acquireOsDaemonLockLease(daemonLock);
  assert.ok(externalLease && externalLease.held, 'external lease held on state/daemon.lock');
  const prefs = backup(t, home);
  await assert.rejects(
    prefs.export({ destination }),
    error => {
      assert.equal(error.rpc.code, -32040);
      assert.match(error.message, /无法获得排他锁/);
      return true;
    },
  );
  assert.equal(fs.existsSync(destination), false, 'no files copied when OS lock cannot be acquired');
  // Release the external lease; export must now succeed
  await externalLease.release();
  const exported = await prefs.export({ destination });
  assert.equal(exported.ok, true);
  const verification = await prefs.verify(destination);
  assert.equal(verification.ok, true);
});


test('orchestration: a writer entering after commit cannot trigger deletion of the completed snapshot', async t => {
  const base = orchestrationFixture(t);
  const busyLock = path.join(base.userData, 'knorvia-daemon.lock');
  let recursiveDeletes = 0;
  const fsImpl = {
    ...fs,
    rmSync(target, options) {
      if (path.resolve(target) === path.resolve(base.destination) && options?.recursive) recursiveDeletes += 1;
      return fs.rmSync(target, options);
    },
  };
  const result = await runPendingBackupRequest({
    home: base.home,
    userDataDir: base.userData,
    appVersion: '1.1.0-test',
    pendingFile: base.pendingFile,
    resultFile: base.resultFile,
    lockPaths: [busyLock],
    blockedWriters: [],
    fsImpl,
  });
  assert.equal(result.ok, true, result.error);
  // The exclusive locks were held through manifest commit. A new writer can
  // legitimately enter after export() returns and must not invalidate it.
  fs.mkdirSync(busyLock, { recursive: true });
  const foreign = path.join(base.destination, 'foreign-after-commit.txt');
  fs.writeFileSync(foreign, 'do not delete');
  assert.equal(recursiveDeletes, 0, 'orchestration never recursively deletes the selected destination');
  assert.equal(fs.existsSync(base.pendingFile), false, 'the completed request is cleared');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'do not delete');
  assert.equal((await backup(t, base.home).verify(base.destination)).ok, true, 'the committed snapshot remains valid');
  const persisted = JSON.parse(fs.readFileSync(base.resultFile, 'utf8'));
  assert.equal(persisted.ok, true);
});

test('orchestration: an export failure (busy lock) keeps the pending request retryable', async t => {
  const base = orchestrationFixture(t);
  // A daemon lock still present is a real export precondition (the caller
  // passes live lock paths); export must refuse and the request must survive.
  const busyLock = path.join(base.userData, 'knorvia-daemon.lock');
  fs.mkdirSync(busyLock, { recursive: true });
  const result = await runPendingBackupRequest({
    home: base.home, userDataDir: base.userData, appVersion: '1.1.0-test',
    pendingFile: base.pendingFile, resultFile: base.resultFile, lockPaths: [busyLock],
    blockedWriters: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /写入锁/);
  assert.equal(fs.existsSync(base.pendingFile), true, 'the pending request survives an export failure');
  assert.equal(fs.existsSync(base.destination), false);
});

test('orchestration commits and clears the request when abort lands as atomic rename completes', async t => {
  const base = orchestrationFixture(t);
  const controller = new AbortController();
  const originalRename = fsp.rename;
  fsp.rename = async function patchedRename(source, target, ...args) {
    const result = await originalRename.call(this, source, target, ...args);
    if (path.resolve(String(target)) === path.resolve(base.destination)) controller.abort();
    return result;
  };
  t.after(() => { fsp.rename = originalRename; });
  const result = await runPendingBackupRequest({
    home: base.home,
    userDataDir: base.userData,
    appVersion: '1.1.0-test',
    pendingFile: base.pendingFile,
    resultFile: base.resultFile,
    blockedWriters: [],
    signal: controller.signal,
    acquireLease: async () => ({ held: true, isAlive: () => true, release: async () => {} }),
  });
  assert.equal(result.ok, true, 'a verified atomic rename is the successful commit point');
  assert.equal(result.committed, true);
  assert.equal(result.verified, true);
  assert.equal(result.completedAfterDeadline, true);
  assert.equal(result.retryable, false);
  assert.equal(fs.existsSync(base.pendingFile), false, 'committed request is cleared instead of becoming an impossible retry');
  assert.equal(fs.existsSync(base.destination), true, 'the already-atomic valid snapshot is retained, never recursively removed');
  assert.equal((await backup(t, base.home).verify(base.destination)).ok, true);
  const persisted = JSON.parse(fs.readFileSync(base.resultFile, 'utf8'));
  assert.equal(persisted.ok, true);
  assert.equal(persisted.committed, true);
  assert.equal(persisted.completedAfterDeadline, true);
});
