'use strict';

// C07 lock ownership lifecycle. A live holder, and any record that cannot be
// verified (pid-only legacy format, unparsable content, a record younger than
// the stale floor), is never preempted: contenders stay bounded busy. A
// complete record whose owner process has really exited is reclaimed
// automatically. Every holder here is a REAL child process inside this lane's
// isolated temp Home, including one killed in the middle of its own write.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createSshStore } = require('../ssh-store');

const fakeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`enc:${value}`), decryptString: buffer => buffer.toString().slice(4) };
const node = process.execPath;
const cleanup = [];
process.on('exit', () => { for (const dir of cleanup) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } });

function fixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-lock-lifecycle-'));
  cleanup.push(home);
  return home;
}
const lockFile = home => path.join(home, 'config', 'ssh-hosts.json.lock');

function spawnHolder(home) {
  // A real live process that owns the lock record with its own PID and
  // rewinds the lock-file mtime — the reviewer's exact counterexample.
  const child = spawn(node, ['-e', `
    const fs = require('node:fs'), path = require('node:path');
    const lockFile = path.join(process.env.KNORVIA_TEST_LOCK_HOME, 'config', 'ssh-hosts.json.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, String(process.pid));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lockFile, old, old);
    console.log('HOLDER-READY');
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, KNORVIA_TEST_LOCK_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.on('exit', resolve));
  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', chunk => { buffer += chunk; if (buffer.includes('HOLDER-READY')) resolve(); });
    child.stderr.on('data', chunk => { buffer += chunk; });
    child.on('exit', () => reject(new Error(`holder exited before ready: ${buffer}`)));
    setTimeout(() => reject(new Error(`holder never became ready: ${buffer}`)), 8000);
  });
  return { child, ready, exited };
}

test('a live holder with a rewound lock mtime is reported busy, never stolen', async t => {
  const home = fixtureHome();
  const store = createSshStore({ home, safeStorage: fakeStorage });
  const holder = spawnHolder(home);
  t.after(async () => { holder.child.kill(); await holder.exited.catch(() => {}); });
  await holder.ready;
  // Re-rewind after readiness so the mtime lie is definitely in place.
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockFile(home), old, old);
  const before = fs.readFileSync(lockFile(home), 'utf8');
  const contender = createSshStore({ home, safeStorage: fakeStorage, lockTimeoutMs: 250 });
  const started = Date.now();
  await assert.rejects(contender.save({
    name: 'Blocked', hostname: 'blocked.example', port: 22, username: 'u', auth: 'password', secret: 'x',
  }), e => e.rpc.code === -32089);
  assert.ok(Date.now() - started >= 200, 'the contender waited the bounded timeout');
  assert.equal(fs.readFileSync(lockFile(home), 'utf8'), before, 'the live holder lock record is untouched');
  assert.equal(fs.existsSync(path.join(home, 'config', 'ssh-hosts.json')), false, 'no data was written under a foreign lock');
  // While the holder is still alive, a repeat contender is equally refused.
  await assert.rejects(contender.save({
    name: 'Blocked', hostname: 'blocked-2.example', port: 22, username: 'u', auth: 'password', secret: 'x',
  }), e => e.rpc.code === -32089);
});

test('a tokenless legacy holder record stays bounded busy until controlled maintenance', async t => {
  const home = fixtureHome();
  const store = createSshStore({ home, safeStorage: fakeStorage });
  const holder = spawnHolder(home);
  t.after(async () => { holder.child.kill(); await holder.exited.catch(() => {}); });
  await holder.ready;
  holder.child.kill();
  await holder.exited;
  const locked = fs.readFileSync(lockFile(home));
  const contender = createSshStore({ home, safeStorage: fakeStorage, lockTimeoutMs: 150 });
  await assert.rejects(contender.save({ name: 'Blocked', hostname: 'blocked.example', port: 22, username: 'u', auth: 'agent' }), e => e.rpc.code === -32089);
  assert.deepEqual(fs.readFileSync(lockFile(home)), locked);
  assert.equal(fs.existsSync(path.join(home, 'config', 'ssh-hosts.json')), false);
  // The fixture's only holder has exited and its contender has returned.
  // This is explicit maintenance, not automatic product recovery.
  fs.unlinkSync(lockFile(home));
  const saved = await createSshStore({ home, safeStorage: fakeStorage, lockTimeoutMs: 5000 }).save({
    name: 'After crash', hostname: 'after-crash.example', port: 22, username: 'u', auth: 'password', secret: 'kept',
  });
  assert.equal(saved.hasSecret, true);
  assert.equal(fs.existsSync(lockFile(home)), false, 'the recovered lock is released after the save');
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'config', 'ssh-hosts.json'), 'utf8'));
  assert.equal(raw.hosts.length, 1);
  assert.equal(fakeStorage.decryptString(Buffer.from(raw.hosts[0].secret, 'base64')), 'kept');
});

// A holder that owns the lock through the REAL production code path: the
// injected safeStorage encryptString runs inside mutate() while the lock is
// held, so blocking there reproduces a window that dies mid-write.
function spawnRealHolder(home, holdMs) {
  const child = spawn(node, ['-e', `
    const fs = require('node:fs'), path = require('node:path');
    const { createSshStore } = require(process.env.KNORVIA_SSH_STORE_MODULE);
    const lockFile = path.join(process.env.KNORVIA_TEST_LOCK_HOME, 'config', 'ssh-hosts.json.lock');
    const holdMs = Number(process.env.KNORVIA_LOCK_HOLD_MS);
    const storage = {
      isEncryptionAvailable: () => true,
      encryptString(value) {
        process.stdout.write('LOCKED ' + fs.readFileSync(lockFile, 'utf8') + '\\n');
        const start = Date.now();
        while (Date.now() - start < holdMs) {}
        return Buffer.from('enc:' + value);
      },
      decryptString: buffer => buffer.toString().slice(4),
    };
    createSshStore({ home: process.env.KNORVIA_TEST_LOCK_HOME, safeStorage: storage }).save({
      name: 'holder', hostname: 'holder.example', port: 22, username: 'u', auth: 'password', secret: 'holder-secret',
    }).then(() => { console.log('HOLDER-COMMITTED'); process.exit(0); })
      .catch(error => { console.log('HOLDER-REFUSED ' + JSON.stringify({ code: error?.rpc?.code })); process.exit(3); });
  `], {
    env: {
      ...process.env,
      KNORVIA_TEST_LOCK_HOME: home,
      KNORVIA_SSH_STORE_MODULE: path.join(__dirname, '..', 'ssh-store.js'),
      KNORVIA_LOCK_HOLD_MS: String(holdMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.on('exit', resolve));
  let buffer = '';
  const locked = new Promise((resolve, reject) => {
    const onData = chunk => {
      buffer += chunk;
      const match = /^LOCKED (\d+) (\S+)/m.exec(buffer);
      if (match) resolve({ record: `${match[1]} ${match[2]}` });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', chunk => { buffer += chunk; });
    child.on('exit', code => reject(new Error(`holder exited (${code}) before locking: ${buffer}`)));
    setTimeout(() => reject(new Error(`holder never locked: ${buffer}`)), 10000);
  });
  const output = new Promise(resolve => { child.stdout.on('data', chunk => { buffer += chunk; }); child.on('exit', () => resolve(buffer)); });
  return { child, locked, exited, output };
}

test('a holder killed mid-write is recovered automatically and the next save lands', async t => {
  const home = fixtureHome();
  const seed = createSshStore({ home, safeStorage: fakeStorage });
  const kept = await seed.save({ name: 'Kept', hostname: 'kept.example', port: 22, username: 'u', auth: 'password', secret: 'kept-secret' });
  const holder = spawnRealHolder(home, 30000);
  t.after(async () => { holder.child.kill(); await holder.exited.catch(() => {}); });
  const { record } = await holder.locked;
  assert.equal(record.split(' ')[0], String(holder.child.pid), 'the record really names the live holder');
  // The production holder is now stuck inside its own critical section: a
  // contender must wait, not steal.
  await assert.rejects(createSshStore({ home, safeStorage: fakeStorage, lockTimeoutMs: 250 })
    .save({ name: 'Early', hostname: 'early.example', port: 22, username: 'u', auth: 'agent' }), e => e.rpc.code === -32089);
  assert.equal(fs.readFileSync(lockFile(home), 'utf8'), record, 'a live holder record is untouched');
  holder.child.kill();
  await holder.exited;

  const events = [];
  const contender = createSshStore({ home, safeStorage: fakeStorage, lockTimeoutMs: 8000, onLockEvent: e => events.push(e) });
  const saved = await contender.save({ name: 'After crash', hostname: 'after-crash.example', port: 22, username: 'u', auth: 'agent' });
  assert.equal(saved.name, 'After crash');
  assert.deepEqual(events.map(e => e.type), ['recovered'], 'the abandoned record was reclaimed without manual maintenance');
  assert.equal(events[0].ownerPid, holder.child.pid);
  assert.equal(fs.existsSync(lockFile(home)), false, 'the recovered lock is released again after the save');
  assert.equal(fs.existsSync(`${lockFile(home)}.steal`), false, 'the steal slot is released with the lock');
  assert.equal(fs.readdirSync(path.join(home, 'config')).filter(name => name.includes('.stale-') || name.includes('.steal')).length, 0, 'no claim or steal files are left behind');
  const hosts = contender.list().hosts.map(h => h.hostname).sort();
  assert.deepEqual(hosts, ['after-crash.example', 'kept.example'], "the crashed holder's unacknowledged write is absent and nothing else was lost");
  assert.equal(contender.list().hosts.find(h => h.id === kept.id).hasSecret, true, 'the surviving secret is still there');
  assert.equal(fakeStorage.decryptString(Buffer.from(JSON.parse(fs.readFileSync(path.join(home, 'config', 'ssh-hosts.json'), 'utf8')).hosts.find(h => h.id === kept.id).secret, 'base64')), 'kept-secret');
}, { timeout: 40000 });

test('automatic recovery preserves every concurrent acknowledged write', async t => {
  const home = fixtureHome();
  const seed = createSshStore({ home, safeStorage: fakeStorage });
  await seed.save({ name: 'Seed', hostname: 'seed.example', port: 22, username: 'u', auth: 'agent' });
  const holder = spawnRealHolder(home, 30000);
  t.after(async () => { holder.child.kill(); await holder.exited.catch(() => {}); });
  await holder.locked;
  holder.child.kill();
  await holder.exited;

  const childScript = `
    const { createSshStore } = require(process.env.KNORVIA_SSH_STORE_MODULE);
    const store = createSshStore({ home: process.env.KNORVIA_TEST_LOCK_HOME, lockTimeoutMs: 20000 });
    (async () => {
      const idx = Number(process.env.KNORVIA_TEST_LOCK_CHILD_INDEX);
      for (let i = 0; i < 8; i++) {
        await store.save({ name: 'child-' + idx + '-' + i, hostname: 'c' + idx + '-' + i + '.example', port: 22, username: 'u', auth: 'agent' });
      }
      console.log('CHILD-DONE');
    })().catch(e => { console.error('CHILD-FAIL', e.message); process.exit(1); });
  `;
  const children = [1, 2, 3].map(index => spawn(node, ['-e', childScript], {
    env: {
      ...process.env,
      KNORVIA_TEST_LOCK_HOME: home,
      KNORVIA_SSH_STORE_MODULE: path.join(__dirname, '..', 'ssh-store.js'),
      KNORVIA_TEST_LOCK_CHILD_INDEX: String(index),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  // One watcher per child, attached at spawn time: a child that already
  // exited never re-emits 'exit', so a lazily attached listener would hang.
  const results = children.map(child => new Promise(resolve => {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('exit', code => resolve({ code, output }));
  }));
  t.after(async () => { for (const child of children) child.kill(); await Promise.all(results); });
  for (const result of await Promise.all(results)) assert.equal(result.code, 0, `child failed: ${result.output}`);
  const hosts = seed.list().hosts;
  assert.equal(hosts.length, 25, 'the seed host plus all 24 concurrent saves are present');
  assert.equal(hosts.filter(h => h.hostname === 'c1-3.example').length, 1);
  assert.equal(fs.existsSync(lockFile(home)), false, 'the lock is released after the last write');
  assert.equal(fs.readdirSync(path.join(home, 'config')).filter(name => name.includes('.stale-') || name.includes('.steal')).length, 0);
}, { timeout: 90000 });

test('a holder whose lock was taken over mid-critical-section cannot write anything', async t => {
  const home = fixtureHome();
  const seed = createSshStore({ home, safeStorage: fakeStorage });
  await seed.save({ name: 'Kept', hostname: 'kept.example', port: 22, username: 'u', auth: 'password', secret: 'kept-secret' });
  const holder = spawnRealHolder(home, 900);
  t.after(async () => { holder.child.kill(); await holder.exited.catch(() => {}); });
  await holder.locked;
  // Simulate the worst case for automatic recovery: the abandoned record is
  // replaced by another owner's while this holder still works. The commit-time
  // token recheck is what makes that survivable.
  fs.writeFileSync(lockFile(home), `${process.pid} foreign-token`);
  const output = await holder.output;
  assert.match(output, /HOLDER-REFUSED \{"code":-32089\}/, 'the preempted holder reports busy instead of committing');
  assert.equal(fs.readFileSync(lockFile(home), 'utf8'), `${process.pid} foreign-token`, 'the preempted holder never deletes the new owner record');
  const hosts = JSON.parse(fs.readFileSync(path.join(home, 'config', 'ssh-hosts.json'), 'utf8')).hosts;
  assert.deepEqual(hosts.map(h => h.hostname), ['kept.example'], 'nothing was written under a foreign lock');
  assert.equal(fakeStorage.decryptString(Buffer.from(hosts[0].secret, 'base64')), 'kept-secret');
}, { timeout: 30000 });

test('two real processes saving concurrently never lose a host', async t => {
  const home = fixtureHome();
  const childScript = `
    const { createSshStore } = require(process.env.KNORVIA_SSH_STORE_MODULE);
    const store = createSshStore({ home: process.env.KNORVIA_TEST_LOCK_HOME });
    (async () => {
      const idx = Number(process.env.KNORVIA_TEST_LOCK_CHILD_INDEX);
      for (let i = 0; i < 20; i++) {
        await store.save({ name: 'child-' + idx + '-' + i, hostname: 'h' + idx + '-' + i + '.example', port: 22, username: 'u', auth: 'agent' });
      }
      console.log('CHILD-DONE');
      process.exit(0);
    })().catch(e => { console.error('CHILD-FAIL', e.message); process.exit(1); });
  `;
  const children = [1, 2].map(index => spawn(node, ['-e', childScript], {
    env: {
      ...process.env,
      KNORVIA_TEST_LOCK_HOME: home,
      KNORVIA_SSH_STORE_MODULE: path.join(__dirname, '..', 'ssh-store.js'),
      KNORVIA_TEST_LOCK_CHILD_INDEX: String(index),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const results = await Promise.all(children.map(child => new Promise(resolve => {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('exit', code => resolve({ code, output }));
  })));
  for (const result of results) assert.equal(result.code, 0, `child failed: ${result.output}`);
  const store = createSshStore({ home, safeStorage: fakeStorage });
  assert.equal(store.list().hosts.length, 40, 'all 40 saves from both processes landed');
  assert.equal(fs.existsSync(lockFile(home)), false, 'the lock is released after the last save');
});
