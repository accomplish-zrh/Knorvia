'use strict';

// C07: cross-instance consistency of the saved SSH host/trust store.
// Two store instances on one Home must serialize through a lock file, plan
// writes against the newest on-disk state, refuse to resurrect hosts deleted
// elsewhere, and never reset a corrupted store. All state is local fixture
// data; no real hosts or credentials are touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSshStore } = require('../ssh-store');

const fakeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`enc:${value}`), decryptString: buffer => buffer.toString().slice(4) };
const store = home => createSshStore({ home, safeStorage: fakeStorage });
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-ssh-store-'));
const hostsFile = home => path.join(home, 'config', 'ssh-hosts.json');
const lockFile = home => `${hostsFile(home)}.lock`;
const saveParams = (over = {}) => ({ name: 'Host', hostname: 'a.example', port: 22, username: 'u', auth: 'password', ...over });
const idsOf = home => store(home).list().hosts.map(h => h.id);

test('two instances adding different hosts and updating trust both keep their changes', async () => {
  const home = fixture();
  const a = store(home), b = store(home);
  const h1 = await a.save(saveParams({ secret: 'secret-one' }));
  const h2 = await b.save(saveParams({ hostname: 'b.example', secret: 'secret-two' }));
  assert.deepEqual((await Promise.resolve(a.list())).hosts.map(h => h.id).sort(), [h1.id, h2.id].sort());
  // Trust recorded by instance B is visible to instance A without a restart.
  await b.update(h1.id, h1.revision, { fingerprint: 'SHA256:trusted-by-b' });
  assert.equal(a.list().hosts.find(h => h.id === h1.id).fingerprint, 'SHA256:trusted-by-b');
  // A saves yet another host afterwards; B's trust update and both secrets survive.
  await a.save(saveParams({ hostname: 'c.example' }));
  const raw = JSON.parse(fs.readFileSync(hostsFile(home), 'utf8'));
  assert.equal(raw.hosts.length, 3);
  assert.equal(raw.hosts.find(h => h.id === h1.id).fingerprint, 'SHA256:trusted-by-b');
  assert.equal(fakeStorage.decryptString(Buffer.from(raw.hosts.find(h => h.id === h1.id).secret, 'base64')), 'secret-one');
  assert.equal(fakeStorage.decryptString(Buffer.from(raw.hosts.find(h => h.id === h2.id).secret, 'base64')), 'secret-two');
});

test('a host deleted by another instance is not resurrected by a later save', async () => {
  const home = fixture();
  const a = store(home), b = store(home);
  const h1 = await a.save(saveParams());
  const h2 = await b.save(saveParams({ hostname: 'b.example' }));
  await b.delete({ id: h1.id, revision: h1.revision });
  // A still holds h1 in what used to be its construction-time snapshot; its
  // save of another host used to rewrite the whole stale list and revive h1.
  const h2renamed = await a.save({ ...h2, name: 'Renamed by A' });
  const remaining = a.list().hosts;
  assert.equal(remaining.some(h => h.id === h1.id), false);
  assert.equal(remaining.find(h => h.id === h2.id).name, 'Renamed by A');
  assert.equal(h2renamed.revision, h2.revision + 1);
});

test('editing a host deleted by another instance returns Conflict instead of recreating it', async () => {
  const home = fixture();
  const a = store(home), b = store(home);
  const h = await a.save(saveParams());
  await b.delete({ id: h.id, revision: h.revision });
  await assert.rejects(a.save({ ...h, name: 'Zombie' }), e => e.rpc.code === -32081);
  await assert.rejects(a.update(h.id, h.revision, { fingerprint: 'SHA256:x' }), e => e.rpc.code === -32081);
  await assert.rejects(a.delete({ id: h.id, revision: h.revision }), e => e.rpc.code === -32081);
  assert.equal(a.list().hosts.length, 0);
});

test('the same host saved from a stale revision returns Conflict on every mutation path', async () => {
  const home = fixture();
  const a = store(home), b = store(home);
  const h = await a.save(saveParams());
  await b.save({ ...h, name: 'Winner' });
  await assert.rejects(a.save({ ...h, name: 'Loser' }), e => e.rpc.code === -32005);
  await assert.rejects(a.update(h.id, h.revision, { fingerprint: 'SHA256:stale' }), e => e.rpc.code === -32005);
  await assert.rejects(a.delete({ id: h.id, revision: h.revision }), e => e.rpc.code === -32005);
  assert.equal(a.list().hosts.find(x => x.id === h.id).name, 'Winner');
});

test('a corrupted store is refused everywhere and never reset or overwritten', async () => {
  const home = fixture();
  const a = store(home);
  const h = await a.save(saveParams({ secret: 'keep-me' }));
  for (const broken of ['{broken json', JSON.stringify({ version: 2, hosts: [] }), JSON.stringify({ version: 1, hosts: [{ id: 'x' }, { id: 'x' }] })]) {
    fs.writeFileSync(hostsFile(home), broken);
    assert.throws(a.list, e => e.rpc.code === -32080);
    assert.throws(() => a.get(h.id), e => e.rpc.code === -32080);
    await assert.rejects(a.save(saveParams({ hostname: 'other.example' })), e => e.rpc.code === -32080);
    assert.equal(fs.readFileSync(hostsFile(home), 'utf8'), broken, 'corrupted bytes must stay untouched');
    assert.equal(fs.existsSync(lockFile(home)), false, 'a failed mutation must release its lock');
  }
  fs.writeFileSync(hostsFile(home), JSON.stringify({ version: 1, hosts: [] }));
});

test('a live foreign lock times out with a clear error and leaves data intact', async () => {
  const home = fixture();
  const a = store(home);
  const h = await a.save(saveParams({ secret: 'persisted' }));
  // A lock owned by this very PID (alive) and freshly written must not be stolen.
  fs.writeFileSync(lockFile(home), String(process.pid));
  const contender = createSshStore({ home, safeStorage: fakeStorage, lockTimeoutMs: 150 });
  await assert.rejects(contender.save(saveParams({ hostname: 'blocked.example' })), e => e.rpc.code === -32089);
  assert.equal(a.list().hosts.length, 1);
  assert.equal(fakeStorage.decryptString(Buffer.from(JSON.parse(fs.readFileSync(hostsFile(home), 'utf8')).hosts[0].secret, 'base64')), 'persisted');
  // An unparsable lock is never removed automatically, at any age.
  fs.writeFileSync(lockFile(home), 'not-a-pid');
  await assert.rejects(contender.save(saveParams({ hostname: 'blocked.example' })), e => e.rpc.code === -32089);
  assert.equal(a.list().hosts.length, 1);
});

test('dead-owner locks: incomplete or fresh records are refused, abandoned ones are reclaimed', async () => {
  const home = fixture();
  const a = createSshStore({ home, safeStorage: fakeStorage, lockTimeoutMs: 400 });
  // A pid-only legacy holder record carries no ownership token, so it can
  // never be verified as abandoned: it stays untouched.
  fs.writeFileSync(lockFile(home), String(2147483646));
  await assert.rejects(a.save(saveParams()), e => e.rpc.code === -32089);
  assert.equal(fs.readFileSync(lockFile(home), 'utf8'), String(2147483646));
  fs.writeFileSync(lockFile(home), String(2147483645));
  await assert.rejects(a.save(saveParams({ hostname: 'after-crash.example' })), e => e.rpc.code === -32089);
  assert.equal(fs.readFileSync(lockFile(home), 'utf8'), String(2147483645));
  assert.equal(a.list().hosts.length, 0);

  // A complete record from an owner that is gone but was seen less than the
  // stale floor ago is still treated as live: the exclusive open stays busy.
  const fresh = createSshStore({ home, safeStorage: fakeStorage, lockTimeoutMs: 300 });
  fs.writeFileSync(lockFile(home), '2147483644 fresh-owner-token');
  await assert.rejects(fresh.save(saveParams({ hostname: 'too-fresh.example' })), e => e.rpc.code === -32089);
  assert.equal(fs.readFileSync(lockFile(home), 'utf8'), '2147483644 fresh-owner-token');

  // Past the floor the abandoned record is reclaimed automatically and the
  // save lands; nothing else in the store is disturbed.
  const seed = createSshStore({ home, safeStorage: fakeStorage, lockStaleAfterMs: 0 });
  await seed.save(saveParams({ name: 'Kept', hostname: 'kept.example', secret: 'persisted' }));
  const events = [];
  const recoverer = createSshStore({ home, safeStorage: fakeStorage, lockTimeoutMs: 2000, lockStaleAfterMs: 0, onLockEvent: e => events.push(e) });
  fs.writeFileSync(lockFile(home), '2147483643 abandoned-token');
  const saved = await recoverer.save(saveParams({ name: 'After crash', hostname: 'after-crash.example', auth: 'agent' }));
  assert.equal(saved.hasSecret, false);
  assert.deepEqual(events.map(e => e.type), ['recovered']);
  assert.equal(events[0].ownerPid, 2147483643);
  assert.equal(fs.existsSync(lockFile(home)), false, 'the reclaimed lock is released normally afterwards');
  assert.equal(fs.existsSync(`${lockFile(home)}.steal`), false, 'the steal slot is not left behind after recovery');
  const raw = JSON.parse(fs.readFileSync(hostsFile(home), 'utf8'));
  assert.deepEqual(raw.hosts.map(h => h.hostname).sort(), ['after-crash.example', 'kept.example']);
  assert.equal(fakeStorage.decryptString(Buffer.from(raw.hosts.find(h => h.hostname === 'kept.example').secret, 'base64')), 'persisted');
});

test('a LIVE holder is never stolen by lock-file age, however old it looks', async () => {
  const home = fixture();
  const a = store(home);
  await a.save(saveParams());
  // This process holds the lock record and stays alive: age must never
  // promote a live holder to "crashed".
  fs.writeFileSync(lockFile(home), `${process.pid} live-holder-token`);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockFile(home), old, old);
  const contender = createSshStore({ home, safeStorage: fakeStorage, lockTimeoutMs: 150 });
  await assert.rejects(contender.save(saveParams({ hostname: 'stale-lock.example' })), e => e.rpc.code === -32089);
  // The live holder's record and the data are both untouched.
  assert.equal(fs.readFileSync(lockFile(home), 'utf8'), `${process.pid} live-holder-token`);
  assert.equal(a.list().hosts.length, 1);
  // The same live lock also blocks a contender from a same-PID perspective.
  await assert.rejects(contender.save(saveParams({ hostname: 'stale-lock-2.example' })), e => e.rpc.code === -32089);
  assert.equal(a.list().hosts.length, 1);
});

test('concurrent saves inside one process are serialized and both land', async () => {
  const home = fixture();
  const a = store(home);
  const [x, y] = await Promise.all([
    a.save(saveParams({ hostname: 'x.example' })),
    a.save(saveParams({ hostname: 'y.example' })),
  ]);
  assert.notEqual(x.id, y.id);
  assert.deepEqual(a.list().hosts.map(h => h.id).sort(), [x.id, y.id].sort());
});
