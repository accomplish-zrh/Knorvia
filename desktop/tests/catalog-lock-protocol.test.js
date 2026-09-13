'use strict';
// CODEX-0615-C02 regressions: recovery installs only through an exclusively
// link-CAS'd steal slot the caller created. A pre-existing steal slot is
// never renamed, unlinked, or replaced by losers (fail-closed orphan-steal).
// Scenarios:
// - two recoverers race one dead owner: exactly one holds, loser times out;
// - orphan dead steal fail-closes without touching lock or steal; manual
//   steal removal then allows dead-owner recovery;
// - orphan dead steal cannot overwrite a live lock owner;
// - path-reused live steal (after an orphan observation) is still never
//   consumed;
// - a steal slot whose creator is ALIVE blocks recovery;
// - a live holder is never stolen; release never unlinks a foreign record;
// - same-process async withCatalogLock critical sections do not overlap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { __catalogLock } = require('../extension-manager');

const lockFileOf = home => path.join(home, 'extensions', 'catalog.lock');
const stealFileOf = home => path.join(home, 'extensions', 'catalog.lock.steal');
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function untilFile(file, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(file)) return;
    if (Date.now() > end) throw new Error(`file never appeared: ${file}`);
    wait(40);
  }
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function spawnDeadPid() {
  const doomed = spawn(process.execPath, ['-e', 'process.exit(0)'], { shell: false });
  const pid = doomed.pid;
  const end = Date.now() + 10_000;
  // Prefer OS liveness over the Node 'exit' event so Atomics.wait loops still
  // observe a truly dead pid (needed for orphan-steal vs mid-flight).
  while (pidAlive(pid)) {
    if (Date.now() > end) throw new Error(`pid ${pid} never exited`);
    wait(10);
  }
  return pid;
}
function seedDeadOwner(home, token) {
  fs.mkdirSync(path.join(home, 'extensions'), { recursive: true });
  const deadPid = spawnDeadPid();
  __catalogLock.atomicWriteLock(lockFileOf(home), { token, pid: deadPid, at: Date.now(), gen: 7 });
  return deadPid;
}

const extensionManagerPath = path.resolve(__dirname, '../extension-manager.js');
// Recovery driver: acquire (recovery included) with a bounded timeout, then
// park while owning until released. Every outcome lands in a result file.
const recoveryChildSource = [
  `const { __catalogLock } = require(${JSON.stringify(extensionManagerPath)});`,
  'const fs = require("node:fs");',
  'const home = process.argv[2], role = process.argv[3], releaseFile = process.argv[4];',
  'fs.mkdirSync(home + "/extensions", { recursive: true });',
  'const lock = __catalogLock.createCatalogLock(home + "/extensions", { lockStaleMs: 300, lockTimeoutMs: Number(process.argv[5] || 1500) });',
  '(async () => {',
  '  try {',
  '    await lock.acquire();',
  '    fs.writeFileSync(home + "/" + role + ".held", "1");',
  '    fs.writeFileSync(home + "/" + role + ".gen", String(JSON.parse(fs.readFileSync(home + "/extensions/catalog.lock", "utf8")).gen));',
  '    while (!fs.existsSync(releaseFile)) await new Promise(r => setTimeout(r, 40));',
  '    lock.release();',
  '    fs.writeFileSync(home + "/" + role + ".done", "1");',
  '  } catch (e) {',
  '    fs.writeFileSync(home + "/" + role + ".timeout", String(e.rpc?.code || e.code || e.message));',
  '    if (e.rpc?.data) fs.writeFileSync(home + "/" + role + ".reason", String(e.rpc.data.reason || ""));',
  '  }',
  '})().catch(e => fs.writeFileSync(home + "/" + role + ".fatal", String(e.message)));',
].join('\n');

function spawnReaper(home, role, releaseFile, timeoutMs) {
  return spawn(process.execPath, [path.join(home, 'recovery-child.cjs'), home, role, releaseFile, String(timeoutMs || 1500)], { shell: false, stdio: 'ignore' });
}

test('two recoverers race one dead owner: exactly one holds, the loser times out without writing', { timeout: 90_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-race2-'));
  seedDeadOwner(home, 'dead_holder_token');
  fs.writeFileSync(path.join(home, 'recovery-child.cjs'), recoveryChildSource);
  const release = path.join(home, 'release');
  // Both recoverers start at the same instant and race for the steal slot.
  const a = spawnReaper(home, 'a', release, 30_000);
  const b = spawnReaper(home, 'b', release, 1500);
  untilFile(path.join(home, 'a.held'));
  // A is parked while owning; B must time out WITHOUT writing the lock.
  untilFile(path.join(home, 'b.timeout'));
  assert.equal(fs.readFileSync(path.join(home, 'b.timeout'), 'utf8'), '-32095');
  const owned = JSON.parse(fs.readFileSync(lockFileOf(home), 'utf8'));
  assert.equal(owned.gen, 8, 'A installed exactly one generation-bumped record');
  assert.equal(owned.stolenFrom, 'dead_holder_token');
  // B never produced a held marker: the critical sections did not overlap.
  assert.equal(fs.existsSync(path.join(home, 'b.held')), false);
  fs.writeFileSync(release, '1');
  untilFile(path.join(home, 'a.done'));
  const end = Date.now() + 10_000;
  while (fs.existsSync(lockFileOf(home))) { if (Date.now() > end) throw new Error('lock never released'); wait(50); }
  await Promise.all([a, b].map(child => new Promise(resolve => { child.once('exit', code => resolve(code)); setTimeout(() => resolve('timeout'), 30_000); })));
  assert.equal(fs.existsSync(path.join(home, 'b.held')), false);
});

test('orphan dead steal fail-closes without consuming the slot; manual clear restores dead-owner recovery', { timeout: 90_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-orphan-steal-'));
  const deadArbiterPid = spawnDeadPid();
  seedDeadOwner(home, 'dead_holder_token');
  // Crashed recovery left a steal slot after link-CAS but before rename.
  __catalogLock.atomicWriteLock(stealFileOf(home), { token: 'crashed_arbiter_token', pid: deadArbiterPid, at: Date.now(), gen: 8 });
  const beforeLock = fs.readFileSync(lockFileOf(home), 'utf8');
  const beforeSteal = fs.readFileSync(stealFileOf(home), 'utf8');
  const probe = __catalogLock.createCatalogLock(path.join(home, 'extensions'), { lockStaleMs: 300, lockTimeoutMs: 400 });
  const outcome = probe.installRecoveryRecord({
    token: probe.token, pid: process.pid, at: Date.now(), gen: 8, stolenFrom: 'dead_holder_token',
  });
  assert.equal(outcome.committed, false);
  assert.equal(outcome.reason, 'orphaned-steal');
  assert.equal(fs.readFileSync(lockFileOf(home), 'utf8'), beforeLock, 'orphan path must not rewrite catalog.lock');
  assert.equal(fs.readFileSync(stealFileOf(home), 'utf8'), beforeSteal, 'orphan path must not rename/unlink/replace foreign steal');

  fs.writeFileSync(path.join(home, 'recovery-child.cjs'), recoveryChildSource);
  const release = path.join(home, 'release');
  const child = spawnReaper(home, 'r', release, 1200);
  untilFile(path.join(home, 'r.timeout'));
  assert.equal(fs.readFileSync(path.join(home, 'r.timeout'), 'utf8'), '-32095');
  assert.equal(fs.readFileSync(path.join(home, 'r.reason'), 'utf8'), 'orphaned-steal');
  assert.equal(fs.existsSync(path.join(home, 'r.held')), false);
  assert.equal(fs.readFileSync(lockFileOf(home), 'utf8'), beforeLock);
  assert.equal(fs.readFileSync(stealFileOf(home), 'utf8'), beforeSteal);

  // Safe manual recovery: remove orphan steal only after no live holder, then retry.
  fs.unlinkSync(stealFileOf(home));
  fs.writeFileSync(release, '1');
  const recovered = __catalogLock.createCatalogLock(path.join(home, 'extensions'), { lockStaleMs: 300, lockTimeoutMs: 5000 });
  await recovered.acquire();
  const owned = JSON.parse(fs.readFileSync(lockFileOf(home), 'utf8'));
  assert.equal(owned.gen, 8);
  assert.equal(owned.stolenFrom, 'dead_holder_token');
  assert.equal(owned.token, recovered.token);
  assert.equal(fs.existsSync(stealFileOf(home)), false);
  recovered.release();
  await child;
});

test('orphan dead steal cannot overwrite a live lock owner', { timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-orphan-live-'));
  fs.mkdirSync(path.join(home, 'extensions'), { recursive: true });
  const deadArbiterPid = spawnDeadPid();
  __catalogLock.atomicWriteLock(lockFileOf(home), { token: 'LIVE_OWNER', pid: process.pid, at: Date.now(), gen: 9 });
  __catalogLock.atomicWriteLock(stealFileOf(home), { token: 'dead_steal', pid: deadArbiterPid, at: 0, gen: 2 });
  const beforeLock = fs.readFileSync(lockFileOf(home), 'utf8');
  const beforeSteal = fs.readFileSync(stealFileOf(home), 'utf8');
  const lock = __catalogLock.createCatalogLock(path.join(home, 'extensions'), { lockStaleMs: 50, lockTimeoutMs: 400 });
  const outcome = lock.installRecoveryRecord({
    token: lock.token, pid: process.pid, at: Date.now(), gen: 10, stolenFrom: 'x',
  });
  assert.equal(outcome.committed, false);
  assert.equal(outcome.reason, 'orphaned-steal');
  assert.equal(fs.readFileSync(lockFileOf(home), 'utf8'), beforeLock, 'live owner must remain');
  assert.equal(fs.readFileSync(stealFileOf(home), 'utf8'), beforeSteal, 'foreign steal must remain');
  await assert.rejects(() => lock.acquire(), e => e.rpc?.code === -32095 && e.rpc?.data?.holderPid === process.pid);
  assert.equal(fs.readFileSync(lockFileOf(home), 'utf8'), beforeLock);
});

test('path-reused live steal after orphan observation is never consumed', { timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-reuse-steal-'));
  const deadArbiterPid = spawnDeadPid();
  seedDeadOwner(home, 'dead_holder_token');
  __catalogLock.atomicWriteLock(stealFileOf(home), { token: 'orphan_steal', pid: deadArbiterPid, at: 0, gen: 8 });
  const lock = __catalogLock.createCatalogLock(path.join(home, 'extensions'), { lockStaleMs: 300, lockTimeoutMs: 400 });
  assert.equal(lock.installRecoveryRecord({
    token: lock.token, pid: process.pid, at: Date.now(), gen: 8, stolenFrom: 'dead_holder_token',
  }).reason, 'orphaned-steal');
  // Simulate the shared path being reused by a NEW live recoverer while a
  // late observer still "knows" an orphan existed. Fail-closed must not
  // rename that live slot onto the lock.
  __catalogLock.atomicWriteLock(stealFileOf(home), { token: 'live_reused_slot', pid: process.pid, at: Date.now(), gen: 8 });
  const beforeLock = fs.readFileSync(lockFileOf(home), 'utf8');
  const beforeSteal = fs.readFileSync(stealFileOf(home), 'utf8');
  const late = lock.installRecoveryRecord({
    token: lock.token, pid: process.pid, at: Date.now(), gen: 8, stolenFrom: 'dead_holder_token',
  });
  assert.equal(late.committed, false);
  assert.equal(late.reason, 'another recovery is mid-flight');
  assert.equal(fs.readFileSync(lockFileOf(home), 'utf8'), beforeLock);
  assert.equal(fs.readFileSync(stealFileOf(home), 'utf8'), beforeSteal, 'reused live steal must not be renamed/unlinked');
});

test('a steal slot held by a LIVE creator blocks recovery and the lock is never touched', { timeout: 90_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-live2-'));
  seedDeadOwner(home, 'dead_holder_token');
  // A live creator holds the steal slot (mid-flight recovery simulation).
  __catalogLock.atomicWriteLock(stealFileOf(home), { token: 'live_arbiter_token', pid: process.pid, at: Date.now() });
  fs.writeFileSync(path.join(home, 'recovery-child.cjs'), recoveryChildSource);
  const release = path.join(home, 'release');
  const child = spawnReaper(home, 'r', release, 1200);
  untilFile(path.join(home, 'r.timeout'));
  assert.equal(fs.readFileSync(path.join(home, 'r.timeout'), 'utf8'), '-32095', 'recovery is honestly refused while the slot is alive');
  const untouched = JSON.parse(fs.readFileSync(lockFileOf(home), 'utf8'));
  assert.equal(untouched.token, 'dead_holder_token', 'the lock record was never touched');
  assert.equal(untouched.gen, 7);
  assert.equal(fs.readFileSync(stealFileOf(home), 'utf8').includes('live_arbiter_token'), true, 'the live slot was never overwritten');
  // Once the live slot is gone, recovery works normally.
  fs.unlinkSync(stealFileOf(home));
  fs.writeFileSync(release, '1');
  const lock2 = __catalogLock.createCatalogLock(path.join(home, 'extensions'), { lockStaleMs: 300, lockTimeoutMs: 5000 });
  await lock2.acquire();
  assert.equal(JSON.parse(fs.readFileSync(lockFileOf(home), 'utf8')).gen, 8);
  lock2.release();
  await child;
});

test('a live holder is never stolen and release never unlinks a foreign record', { timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-guard3-'));
  const livePid = process.pid;
  fs.mkdirSync(path.join(home, 'extensions'), { recursive: true });
  __catalogLock.atomicWriteLock(lockFileOf(home), { token: 'live_owner_token', pid: livePid, at: Date.now(), gen: 3 });
  const lock = __catalogLock.createCatalogLock(path.join(home, 'extensions'), { lockStaleMs: 50, lockTimeoutMs: 400 });
  await assert.rejects(() => lock.acquire(), e => e.rpc?.code === -32095, 'a live holder is never stolen');
  assert.equal(JSON.parse(fs.readFileSync(lockFileOf(home), 'utf8')).token, 'live_owner_token', 'the live owner record is untouched');
  // The live record also blocks a fresh tryAcquire (steal-serialized).
  assert.equal(lock.tryAcquire(), false);
  // Release guard: an owned lock corrupted to a foreign token is not
  // unlinked by the (no-longer-matching) owner.
  const guard = __catalogLock.createCatalogLock(path.join(home, 'extensions'), { lockStaleMs: 50, lockTimeoutMs: 400 });
  fs.unlinkSync(lockFileOf(home));
  assert.equal(guard.tryAcquire(), true);
  __catalogLock.atomicWriteLock(lockFileOf(home), { token: 'foreign_holder', pid: process.pid, at: Date.now(), gen: 4 });
  guard.release();
  assert.equal(fs.existsSync(lockFileOf(home)), true, 'the token-guarded release left the foreign record alone');
  fs.unlinkSync(lockFileOf(home));
});

test('same-process async withCatalogLock critical sections do not overlap', { timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-async-'));
  const root = path.join(home, 'extensions');
  fs.mkdirSync(root, { recursive: true });
  const intervals = [];
  const run = async id => {
    await __catalogLock.withCatalogLock(root, { lockStaleMs: 300, lockTimeoutMs: 10_000 }, async () => {
      const start = Date.now();
      await new Promise(r => setTimeout(r, 120));
      const end = Date.now();
      intervals.push({ id, start, end });
    });
  };
  await Promise.all([run('a'), run('b'), run('c')]);
  assert.equal(intervals.length, 3);
  intervals.sort((x, y) => x.start - y.start);
  for (let i = 1; i < intervals.length; i++) {
    assert.ok(intervals[i - 1].end <= intervals[i].start, `overlap between ${intervals[i - 1].id} and ${intervals[i].id}`);
  }
  assert.equal(fs.existsSync(path.join(root, 'catalog.lock')), false);
  assert.equal(fs.existsSync(path.join(root, 'catalog.lock.steal')), false);
});

test('a late orphan read cannot install a replacement live steal over a live owner', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-late-orphan-'));
  const deadPid = seedDeadOwner(home, 'dead');
  const lockFile = lockFileOf(home), stealFile = stealFileOf(home);
  __catalogLock.atomicWriteLock(stealFile, { token: 'orphan', pid: deadPid, gen: 8 });
  const contender = __catalogLock.createCatalogLock(path.join(home, 'extensions'));
  const originalRead = fs.readFileSync;
  let gated = false;
  fs.readFileSync = function (file, ...args) {
    const value = originalRead.call(this, file, ...args);
    if (file === stealFile && !gated) {
      gated = true;
      // Pause after the old contents are read, then reuse both paths before
      // the late observer acts on that now-stale value.
      __catalogLock.atomicWriteLock(lockFile, { token: 'new-live-owner', pid: process.pid, gen: 9 });
      __catalogLock.atomicWriteLock(stealFile, { token: 'new-live-steal', pid: process.pid, gen: 10 });
    }
    return value;
  };
  try {
    assert.equal(contender.installRecoveryRecord({ token: contender.token, pid: process.pid, gen: 8 }).committed, false);
  } finally { fs.readFileSync = originalRead; }
  assert.equal(gated, true);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'new-live-owner');
  assert.equal(JSON.parse(fs.readFileSync(stealFile, 'utf8')).token, 'new-live-steal');
});

test('unreadable old ownership refuses acquire and tryAcquire without replacing the record', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-unreadable-'));
  fs.mkdirSync(path.join(home, 'extensions'));
  const file = lockFileOf(home);
  fs.writeFileSync(file, '{damaged');
  fs.utimesSync(file, new Date(0), new Date(0));
  const lock = __catalogLock.createCatalogLock(path.join(home, 'extensions'), { lockStaleMs: 1, lockTimeoutMs: 60 });
  assert.equal(lock.tryAcquire(), false);
  await assert.rejects(lock.acquire, e => e.rpc?.data?.reason === 'unreadable-owner');
  assert.equal(fs.readFileSync(file, 'utf8'), '{damaged');
  assert.equal(fs.existsSync(stealFileOf(home)), false);
});
