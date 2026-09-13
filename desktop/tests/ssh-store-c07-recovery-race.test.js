'use strict';

// C07 production-module regression: a stale recoverer must not displace a live
// lock or let a third writer land an acknowledged save that a later commit
// then drops. Dead steal creators are still recovered automatically. Incomplete
// lock records stay refused. Children are real processes against the live
// ssh-store module; filesystem hooks only pause the production calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createSshStore } = require('../ssh-store');

const fakeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`enc:${value}`), decryptString: buffer => buffer.toString().slice(4) };
const node = process.execPath;
const storeModule = path.join(__dirname, '..', 'ssh-store.js');
const cleanup = [];
process.on('exit', () => { for (const dir of cleanup) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } });

function fixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-c07-race-'));
  cleanup.push(home);
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  return home;
}
const hostsFile = home => path.join(home, 'config', 'ssh-hosts.json');
const lockFile = home => `${hostsFile(home)}.lock`;
const stealFile = home => `${lockFile(home)}.steal`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const namesOf = home => JSON.parse(fs.readFileSync(hostsFile(home), 'utf8')).hosts.map(h => h.name);

function spawnDeadPid() {
  const dead = spawnSync(node, ['-e', 'process.exit(0)'], { windowsHide: true });
  return dead.pid;
}

function waitFlag(dir, flag, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (!fs.existsSync(path.join(dir, flag))) {
      if (Date.now() >= deadline) throw new Error('missing fixture event: ' + flag);
      await sleep(15);
    }
  })();
}

function startRole(home, gates, role, extraEnv = {}) {
  const child = spawn(node, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const home = process.env.KNORVIA_TEST_LOCK_HOME;
    const gates = process.env.KNORVIA_TEST_GATES;
    const role = process.env.KNORVIA_TEST_ROLE;
    const lock = path.join(home, 'config/ssh-hosts.json.lock');
    const steal = lock + '.steal';
    const catalog = path.join(home, 'config/ssh-hosts.json');
    const signal = name => fs.writeFileSync(path.join(gates, name), String(process.pid));
    function pause(name) {
      signal(name + '-waiting');
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(path.join(gates, name + '-go'))) {
        if (Date.now() >= deadline) throw new Error('fixture gate timed out: ' + name);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    const rename = fs.renameSync, link = fs.linkSync;
    let pausedSteal = false, pausedCatalog = false;
    fs.linkSync = function(source, destination) {
      // Honest analog of the original B-before-reclaim pause (rename lock away):
      // after diagnosing a dead owner, B's first exclusive action is link-CAS
      // onto lock.steal. Pausing here lets A recover while B still holds only
      // a stale diagnosis.
      if (role === 'B' && destination === steal && !pausedSteal) { pausedSteal = true; pause('B-before-reclaim'); }
      return link.apply(this, arguments);
    };
    fs.renameSync = function(source, destination) {
      if (role === 'B' && source === steal && destination === lock) pause('B-before-install');
      if (role === 'A' && destination === catalog && !pausedCatalog) { pausedCatalog = true; pause('A-after-token-check'); }
      return rename.apply(this, arguments);
    };
    const { createSshStore } = require(process.env.KNORVIA_SSH_STORE_MODULE);
    const store = createSshStore({
      home,
      lockTimeoutMs: Number(process.env.KNORVIA_LOCK_TIMEOUT_MS || 20000),
      lockStaleAfterMs: 0,
    });
    store.save({ name: role, hostname: role.toLowerCase() + '.example.test', username: 'fixture', auth: 'agent' })
      .then(host => { signal(role + '-completed'); process.stdout.write(JSON.stringify({ role, ok: true, id: host.id }) + '\\n'); })
      .catch(error => { process.stderr.write(JSON.stringify({ role, error: error.message, rpc: error.rpc }) + '\\n'); process.exitCode = 1; });
  `], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KNORVIA_TEST_LOCK_HOME: home,
      KNORVIA_TEST_GATES: gates,
      KNORVIA_TEST_ROLE: role,
      KNORVIA_SSH_STORE_MODULE: storeModule,
      ...extraEnv,
    },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const completion = once(child, 'close').then(([code]) => ({ code, stdout, stderr, pid: child.pid }));
  return { child, completion };
}

test('C07: stale recoverer cannot vacate a live lock or drop an acknowledged save', { timeout: 60000 }, async t => {
  const home = fixtureHome();
  const gates = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-c07-gates-'));
  cleanup.push(gates);
  fs.writeFileSync(lockFile(home), `${spawnDeadPid()} dead-owner-token`);
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'close').catch(() => {})));
  });

  const b = startRole(home, gates, 'B');
  children.push(b.child);
  await waitFlag(gates, 'B-before-reclaim-waiting');
  const lockWhileBPaused = fs.readFileSync(lockFile(home), 'utf8');
  assert.match(lockWhileBPaused, /dead-owner-token/, 'B has not yet taken the steal slot, so the dead record is still in place');
  assert.equal(fs.existsSync(stealFile(home)), false, 'B paused before creating the steal slot');

  const a = startRole(home, gates, 'A');
  children.push(a.child);
  await waitFlag(gates, 'A-after-token-check-waiting');
  const aLock = fs.readFileSync(lockFile(home), 'utf8');
  assert.equal(aLock.split(' ')[0], String(a.child.pid), 'A recovered and holds a live ownership record');
  assert.notEqual(aLock, lockWhileBPaused, 'A replaced the dead record in place rather than vacating the path');
  assert.equal(fs.existsSync(stealFile(home)), false, 'A renamed its steal slot onto the lock; the path is not vacant');

  const c = startRole(home, gates, 'C');
  children.push(c.child);
  fs.writeFileSync(path.join(gates, 'B-before-reclaim-go'), 'continue');
  // Original schedule waited for C-completed in the lock-path hole. That wait
  // is now a negative assertion: C must not land while A still holds the lock.
  await sleep(800);
  assert.equal(fs.existsSync(path.join(gates, 'C-completed')), false, 'C cannot obtain the lock while A holds it');
  assert.equal(fs.existsSync(path.join(gates, 'B-completed')), false, 'B cannot install over A');
  assert.equal(fs.existsSync(path.join(gates, 'B-before-install-waiting')), false, 'B must abort before renaming onto a live lock');
  assert.equal(fs.readFileSync(lockFile(home), 'utf8'), aLock, 'the live lock bytes are untouched by the stale recoverer');
  assert.equal(fs.existsSync(hostsFile(home)), false, 'nobody has committed yet; A is paused before persist');

  // B is allowed to install only after the live-holder assertions above.
  // Release its second gate before A exits, so a later legitimate acquire
  // cannot be held by the test until the production lock deadline expires.
  fs.writeFileSync(path.join(gates, 'B-before-install-go'), 'continue');
  fs.writeFileSync(path.join(gates, 'A-after-token-check-go'), 'continue');
  const [aResult, bResult, cResult] = await Promise.all([a.completion, b.completion, c.completion]);
  assert.equal(aResult.code, 0, aResult.stderr);
  assert.equal(bResult.code, 0, bResult.stderr);
  assert.equal(cResult.code, 0, cResult.stderr);
  assert.deepEqual(namesOf(home).sort(), ['A', 'B', 'C']);
  assert.equal(fs.existsSync(lockFile(home)), false);
  assert.equal(fs.existsSync(stealFile(home)), false);
  assert.equal(children.every(child => child.exitCode !== null || child.signalCode !== null), true);
});

test('C07: a recoverer killed on the steal slot is recovered automatically', { timeout: 40000 }, async t => {
  const home = fixtureHome();
  const gates = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-c07-steal-'));
  cleanup.push(gates);
  await createSshStore({ home, safeStorage: fakeStorage }).save({
    name: 'Kept', hostname: 'kept.example', port: 22, username: 'u', auth: 'password', secret: 'kept-secret',
  });
  fs.writeFileSync(lockFile(home), `${spawnDeadPid()} abandoned-token`);
  const holder = startRole(home, gates, 'B', { KNORVIA_LOCK_TIMEOUT_MS: '20000' });
  t.after(async () => { holder.child.kill(); await holder.completion.catch(() => {}); });
  await waitFlag(gates, 'B-before-reclaim-waiting');
  fs.writeFileSync(path.join(gates, 'B-before-reclaim-go'), 'continue');
  await waitFlag(gates, 'B-before-install-waiting');
  assert.equal(fs.existsSync(stealFile(home)), true, 'B holds the steal slot');
  assert.match(fs.readFileSync(lockFile(home), 'utf8'), /abandoned-token/, 'the dead lock is still in place until install');
  holder.child.kill();
  await holder.completion;

  const events = [];
  const saved = await createSshStore({
    home, safeStorage: fakeStorage, lockTimeoutMs: 8000, lockStaleAfterMs: 0, onLockEvent: e => events.push(e),
  }).save({ name: 'After steal crash', hostname: 'after-steal.example', port: 22, username: 'u', auth: 'agent' });
  assert.equal(saved.name, 'After steal crash');
  assert.equal(events.some(e => e.type === 'recovered'), true, 'the abandoned lock is recovered after the steal creator dies');
  assert.deepEqual(createSshStore({ home, safeStorage: fakeStorage }).list().hosts.map(h => h.hostname).sort(), ['after-steal.example', 'kept.example']);
  assert.equal(fakeStorage.decryptString(Buffer.from(JSON.parse(fs.readFileSync(hostsFile(home), 'utf8')).hosts.find(h => h.hostname === 'kept.example').secret, 'base64')), 'kept-secret');
  assert.equal(fs.existsSync(lockFile(home)), false);
  assert.equal(fs.existsSync(stealFile(home)), false);
  assert.equal(fs.existsSync(`${stealFile(home)}.steal`), false);
  assert.equal(fs.existsSync(`${stealFile(home)}.reclaim`), false);
});

test('C07: a live nested steal slot is never unlinked by a stale recoverer', async () => {
  const home = fixtureHome();
  const deadLock = spawnDeadPid();
  const deadSteal = spawnDeadPid();
  fs.writeFileSync(lockFile(home), `${deadLock} abandoned-token`);
  fs.writeFileSync(stealFile(home), `${deadSteal} dead-steal-token`);
  fs.writeFileSync(`${stealFile(home)}.steal`, `${process.pid} live-nested-token`);
  const nested = fs.readFileSync(`${stealFile(home)}.steal`, 'utf8');
  const beforeLock = fs.readFileSync(lockFile(home), 'utf8');
  const beforeSteal = fs.readFileSync(stealFile(home), 'utf8');
  const contender = createSshStore({ home, safeStorage: fakeStorage, lockTimeoutMs: 250, lockStaleAfterMs: 0 });
  await assert.rejects(contender.save({ name: 'Blocked', hostname: 'blocked.example', port: 22, username: 'u', auth: 'agent' }), e => e.rpc.code === -32089);
  assert.equal(fs.readFileSync(lockFile(home), 'utf8'), beforeLock, 'dead lock is not replaced while a live nested slot exists');
  assert.equal(fs.readFileSync(stealFile(home), 'utf8'), beforeSteal, 'dead steal is not unlinked to make room for recovery');
  assert.equal(fs.readFileSync(`${stealFile(home)}.steal`, 'utf8'), nested, 'the live nested slot is never consumed');
  assert.equal(fs.existsSync(hostsFile(home)), false);
});

test('C07: incomplete and unreadable lock records still refuse automatic recovery', async () => {
  const home = fixtureHome();
  const a = createSshStore({ home, safeStorage: fakeStorage, lockTimeoutMs: 200, lockStaleAfterMs: 0 });
  fs.writeFileSync(lockFile(home), String(2147483646));
  await assert.rejects(a.save({ name: 'Blocked', hostname: 'blocked.example', port: 22, username: 'u', auth: 'agent' }), e => e.rpc.code === -32089);
  assert.equal(fs.readFileSync(lockFile(home), 'utf8'), String(2147483646));
  assert.equal(fs.existsSync(stealFile(home)), false);
  fs.writeFileSync(lockFile(home), 'not-a-pid');
  await assert.rejects(a.save({ name: 'Blocked', hostname: 'blocked-2.example', port: 22, username: 'u', auth: 'agent' }), e => e.rpc.code === -32089);
  assert.equal(fs.readFileSync(lockFile(home), 'utf8'), 'not-a-pid');
  assert.equal(fs.existsSync(hostsFile(home)), false);
});
