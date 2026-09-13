'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { connectionError } = require('./connection-config');
const fail = (code, message) => { throw connectionError(code, message); };
const text = (value, label, max = 256) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) fail(-32602, `Invalid ${label}`);
  return value.trim();
};
const LOCK_RETRY_MS = 20;
// Cross-instance writes and dead-owner recovery share one recursive install:
// exclusively link-CAS a child slot, recheck the parent, then rename the child
// onto the parent. The parent path is never renamed away and a foreign child
// is never unlinked, so a stale diagnosis cannot vacate a live writer. A dead
// child is recovered by the same install one level deeper, not by
// read-then-unlink. Incomplete or unreadable records stay refused. Bounded
// depth keeps a wedged deepest slot a busy timeout rather than an unlink race.
// Commit still rechecks the ownership token so a replaced holder cannot write.
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_AFTER_MS = 1000;
const LOCK_RECOVERY_DEPTH = 3;
const pidGone = pid => {
  try { process.kill(pid, 0); return false; } catch (error) {
    // EPERM means the process exists but is not ours to signal: still alive.
    return error.code === 'ESRCH';
  }
};
const pathExists = file => { try { fs.statSync(file); return true; } catch { return false; } };
const sleepSync = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const retryBusy = fn => {
  for (let attempt = 0; attempt < 12; attempt++) {
    try { return fn(); } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 11) throw error;
      sleepSync(25);
    }
  }
};
const validState = state => !!state && typeof state === 'object' && !Array.isArray(state)
  && state.version === 1 && Array.isArray(state.hosts) && state.hosts.length <= 100
  && state.hosts.every(h => h && typeof h.id === 'string' && h.id && Number.isInteger(h.revision))
  && new Set(state.hosts.map(h => h.id)).size === state.hosts.length;
function createSshStore({ home, safeStorage, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, lockStaleAfterMs = LOCK_STALE_AFTER_MS, onLockEvent } = {}) {
  if (!path.isAbsolute(home || '')) throw new Error('SSH requires an absolute application Home');
  const file = path.join(home, 'config', 'ssh-hosts.json');
  const lockFile = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const report = event => { try { onLockEvent?.(event); } catch { /* diagnostics never break a write */ } };
  const secure = () => Boolean(safeStorage?.isEncryptionAvailable?.());
  const describe = host => { const { secret, ...publicHost } = host; return { ...publicHost, hasSecret: Boolean(secret) }; };
  // Every operation re-reads the file from disk, so a second Knorvia window
  // (or an edit made while this store object existed) is always visible and
  // mutations are planned against the newest state instead of a construction-
  // time snapshot.
  function loadFromDisk() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, hosts: [] };
      fail(-32080, 'Saved SSH hosts could not be read');
    }
    let state;
    try { state = JSON.parse(raw); } catch { fail(-32080, 'Saved SSH hosts could not be read'); }
    if (!validState(state)) fail(-32080, 'Saved SSH hosts are invalid');
    return state;
  }
  function persist(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  // Slot content: "<holder pid> <ownership token>". The token makes ownership
  // verifiable: a same-PID re-acquire or a replaced path can never release or
  // install over someone else's record.
  const readOwnerRecord = target => {
    let raw;
    try { raw = fs.readFileSync(target, 'utf8'); } catch { return null; }
    const [pidField, tokenField] = raw.trim().split(/\s+/);
    const pid = Number.parseInt(pidField, 10);
    let ageMs = 0;
    try { ageMs = Date.now() - fs.statSync(target).mtimeMs; } catch { return null; }
    if (!Number.isInteger(pid) || pid <= 0) return { pid: null, token: null, raw, ageMs, complete: false };
    return { pid, token: tokenField || null, raw, ageMs, complete: Boolean(tokenField) };
  };
  const ownerRecord = target => {
    const record = readOwnerRecord(target);
    return record && record.pid ? record : null;
  };
  const ownsRecord = (target, token) => {
    const record = ownerRecord(target);
    return !!record && record.token === token && record.pid === process.pid;
  };
  const ownsLock = token => ownsRecord(lockFile, token);
  const liveOwner = record => !!record && record.pid && !pidGone(record.pid);
  const recoverableDead = record => !!record && record.complete && record.ageMs >= lockStaleAfterMs && pidGone(record.pid);
  const unlinkIfOwned = (target, token) => {
    try {
      const record = ownerRecord(target);
      if (record && record.token === token && record.pid === process.pid) fs.unlinkSync(target);
    } catch { /* best effort */ }
  };
  const renameOver = (from, to) => {
    try { retryBusy(() => fs.renameSync(from, to)); return true; } catch { return false; }
  };
  // Install `token` onto `target` through an exclusive child slot. A dead
  // child is itself installed the same way (depth + 1). Losers never unlink
  // or rename a slot they did not create.
  function installAt(target, token, depth) {
    if (depth > LOCK_RECOVERY_DEPTH) return false;
    const child = `${target}.steal`;
    const temp = `${target}.${token}.${depth}.tmp`;
    try { fs.writeFileSync(temp, `${process.pid} ${token}`, { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code === 'ENOENT') {
        try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch { /* retry from acquire */ }
        return false;
      }
      fail(-32080, 'Saved SSH hosts could not be locked');
    }
    let holdChild = false;
    try {
      try {
        retryBusy(() => fs.linkSync(temp, child));
        holdChild = true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        if (error.code !== 'EEXIST' && error.code !== 'EPERM') fail(-32080, 'Saved SSH hosts could not be locked');
        if (!pathExists(child)) return false;
        const held = ownerRecord(child);
        if (liveOwner(held)) return false;
        if (!recoverableDead(held)) return false;
        if (!installAt(child, token, depth + 1)) return false;
        holdChild = ownsRecord(child, token);
        if (!holdChild) return false;
      }
      if (!ownsRecord(child, token)) return false;
      const exists = pathExists(target);
      const current = ownerRecord(target);
      if (exists && ownsRecord(target, token)) return true;
      if (exists && liveOwner(current)) {
        if (depth === 0) report({ type: 'recovery-aborted', ownerPid: current.pid, reason: 'live-owner' });
        return false;
      }
      if (exists && !recoverableDead(current)) {
        if (depth === 0) report({ type: 'recovery-aborted', ownerPid: current?.pid ?? null, reason: current?.complete ? 'not-stale' : (current ? 'incomplete' : 'unreadable-owner') });
        return false;
      }
      if (!renameOver(child, target)) return false;
      holdChild = false;
      if (!ownsRecord(target, token)) return false;
      if (depth === 0 && exists && current) report({ type: 'recovered', ownerPid: current.pid, ageMs: current.ageMs });
      return true;
    } finally {
      try { fs.unlinkSync(temp); } catch { /* extra hard link or leftover temp */ }
      if (holdChild) unlinkIfOwned(child, token);
    }
  }
  // Every acquire, including the first writer on an empty path, goes through
  // installAt so recovery and ordinary writers cannot interleave on vacancy.
  async function acquireLock() {
    const deadline = Date.now() + lockTimeoutMs;
    const token = randomUUID();
    for (;;) {
      if (Date.now() >= deadline) fail(-32089, 'SSH host data is busy with another Knorvia window; try again shortly. An interrupted window is recovered automatically once its process has exited.');
      if (ownsLock(token)) return token;
      const exists = pathExists(lockFile);
      const current = ownerRecord(lockFile);
      if (exists && liveOwner(current)) {
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
        continue;
      }
      if (!exists || recoverableDead(current)) {
        try {
          if (installAt(lockFile, token, 0)) return token;
        } catch (error) {
          if (error?.rpc) throw error;
          fail(-32080, 'Saved SSH hosts could not be locked');
        }
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  function releaseLock(token) {
    // Remove the lock file only while it still holds OUR ownership record;
    // a path replaced by another contender is never deleted.
    try { if (ownsLock(token)) fs.unlinkSync(lockFile); } catch { /* best effort */ }
  }
  // The whole plan runs against the freshly read disk state while the lock is
  // held, so a delete that happened in another window cannot be resurrected by
  // this window overwriting a stale in-memory list, and an edit to a host that
  // was deleted elsewhere returns Conflict instead of recreating it.
  async function mutate(plan) {
    const token = await acquireLock();
    try {
      const { next, result } = plan(loadFromDisk());
      // Recheck the ownership token before committing the planned mutation.
      if (!ownsLock(token)) fail(-32089, 'Saved SSH hosts lock changed during the update; nothing was written. Try again.');
      if (next) persist(next);
      return result;
    } finally { releaseLock(token); }
  }
  async function save(p) {
    const hostname = text(p.hostname, 'hostname');
    if (!/^[a-zA-Z0-9.:%_-]+$/.test(hostname) || hostname.startsWith('-')) fail(-32602, 'Invalid SSH hostname');
    const port = p.port ?? 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(-32602, 'Invalid SSH port');
    if (!['agent', 'password', 'privateKey'].includes(p.auth)) fail(-32602, 'Choose SSH authentication');
    const root = p.root ? text(p.root, 'remote directory', 4096) : '';
    if (root && !root.startsWith('/')) fail(-32602, 'The remote directory must be an absolute POSIX path');
    const keyPath = p.keyPath ? text(p.keyPath, 'key path', 4096) : '';
    if (keyPath && !path.isAbsolute(keyPath)) fail(-32602, 'Private key path must be absolute');
    const username = text(p.username, 'username');
    if (p.secret !== undefined && (typeof p.secret !== 'string' || p.secret.length > 16384 || p.secret.includes('\0'))) fail(-32602, 'Invalid SSH secret');
    return mutate(fresh => {
      const previous = p.id ? fresh.hosts.find(h => h.id === p.id) : null;
      if (p.id && !previous) fail(-32081, 'SSH host not found');
      if (previous && previous.revision !== p.revision) fail(-32005, 'SSH host changed; refresh before editing');
      if (!previous && fresh.hosts.length >= 100) fail(-32082, 'Maximum 100 SSH hosts');
      // Jump configuration (C13): one hop, no self-reference, no cycles via
      // chains - the named target must exist and must not itself use a jump.
      let jumpHostId;
      if (p.jumpHostId) {
        const selfId = previous?.id ?? p.id;
        if (p.jumpHostId === selfId) fail(-32602, 'A host cannot use itself as its jump host');
        const target = fresh.hosts.find(h => h.id === p.jumpHostId);
        if (!target) fail(-32004, 'The selected jump host does not exist; save it first');
        if (target.jumpHostId) fail(-32602, 'Only a single jump hop is supported; the selected jump host is itself behind a jump host');
        jumpHostId = p.jumpHostId;
      }
      const credentialsChanged = previous && (previous.hostname !== hostname || previous.port !== port || previous.username !== username || previous.auth !== p.auth || previous.keyPath !== keyPath);
      let secret = credentialsChanged ? undefined : previous?.secret;
      if (p.clearSecret) secret = undefined;
      if (p.secret !== undefined) {
        if (p.secret) {
          if (!secure()) fail(-32083, 'System encryption is unavailable; enter credentials when connecting');
          secret = safeStorage.encryptString(p.secret).toString('base64');
        } else secret = undefined;
      }
      const identityChanged = previous && (previous.hostname !== hostname || previous.port !== port);
      const host = { id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, name: text(p.name, 'host name', 80),
        hostname, port, username, auth: p.auth, root, keyPath, jumpHostId,
        fingerprint: identityChanged ? undefined : previous?.fingerprint, secret };
      return { next: { version: 1, hosts: previous ? fresh.hosts.map(h => h.id === previous.id ? host : h) : [...fresh.hosts, host] }, result: describe(host) };
    });
  }
  async function update(id, revision, change) {
    return mutate(fresh => {
      const previous = fresh.hosts.find(h => h.id === id);
      if (!previous) fail(-32081, 'SSH host not found');
      if (previous.revision !== revision) fail(-32005, 'SSH host changed; refresh before editing');
      const next = { ...previous, ...change, revision: revision + 1 };
      return { next: { version: 1, hosts: fresh.hosts.map(h => h.id === id ? next : h) }, result: describe(next) };
    });
  }
  return {
    list: () => ({ hosts: loadFromDisk().hosts.map(describe), secureStorageAvailable: secure() }),
    get(id) { const host = loadFromDisk().hosts.find(h => h.id === id); if (!host) fail(-32081, 'SSH host not found'); return host; },
    save, update,
    async delete(p) {
      return mutate(fresh => {
        const previous = fresh.hosts.find(h => h.id === p.id);
        if (!previous) fail(-32081, 'SSH host not found');
        if (previous.revision !== p.revision) fail(-32005, 'SSH host changed');
        // A host other sessions still traverse is not deletable; the
        // dependency message names the dependent host.
        const dependent = fresh.hosts.find(h => h.jumpHostId === p.id);
        if (dependent) fail(-32005, `${dependent.name} still uses this host as its jump host; change its jump setting first`);
        return { next: { version: 1, hosts: fresh.hosts.filter(h => h.id !== p.id) }, result: { deleted: true } };
      });
    },
    secret(host) { if (!host.secret) return ''; if (!secure()) fail(-32083, 'Saved SSH credential is unavailable on this device'); try { return safeStorage.decryptString(Buffer.from(host.secret, 'base64')); } catch { fail(-32083, 'Saved SSH credential could not be decrypted'); } },
  };
}
module.exports = { createSshStore };
