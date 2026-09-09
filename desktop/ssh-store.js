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
function createSshStore({ home, safeStorage }) {
  if (!path.isAbsolute(home || '')) throw new Error('SSH requires an absolute application Home');
  const file = path.join(home, 'config', 'ssh-hosts.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') fail(-32080, 'Saved SSH hosts could not be read');
    state = { version: 1, hosts: [] };
  }
  if (state?.version !== 1 || !Array.isArray(state.hosts) || state.hosts.some(h => !h.id || !Number.isInteger(h.revision))) fail(-32080, 'Saved SSH hosts are invalid');
  const secure = () => Boolean(safeStorage?.isEncryptionAvailable?.());
  const get = id => { const host = state.hosts.find(h => h.id === id); if (!host) fail(-32081, 'SSH host not found'); return host; };
  const describe = host => { const { secret, ...publicHost } = host; return { ...publicHost, hasSecret: Boolean(secret) }; };
  function persist(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); state = next; }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  function update(id, revision, change) {
    const previous = get(id);
    if (previous.revision !== revision) fail(-32005, 'SSH host changed; refresh before editing');
    const next = { ...previous, ...change, revision: revision + 1 };
    persist({ version: 1, hosts: state.hosts.map(h => h.id === id ? next : h) });
    return describe(next);
  }
  function save(p) {
    const old = p.id ? get(p.id) : null;
    if (old && old.revision !== p.revision) fail(-32005, 'SSH host changed; refresh before editing');
    if (!old && state.hosts.length >= 100) fail(-32082, 'Maximum 100 SSH hosts');
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
    const credentialsChanged = old && (old.hostname !== hostname || old.port !== port || old.username !== username || old.auth !== p.auth || old.keyPath !== keyPath);
    let secret = credentialsChanged ? undefined : old?.secret;
    if (p.clearSecret) secret = undefined;
    if (p.secret !== undefined) {
      if (typeof p.secret !== 'string' || p.secret.length > 16384 || p.secret.includes('\0')) fail(-32602, 'Invalid SSH secret');
      if (p.secret) {
        if (!secure()) fail(-32083, 'System encryption is unavailable; enter credentials when connecting');
        secret = safeStorage.encryptString(p.secret).toString('base64');
      } else secret = undefined;
    }
    const identityChanged = old && (old.hostname !== hostname || old.port !== port);
    const host = { id: old?.id ?? randomUUID(), revision: (old?.revision ?? 0) + 1, name: text(p.name, 'host name', 80),
      hostname, port, username, auth: p.auth, root, keyPath,
      fingerprint: identityChanged ? undefined : old?.fingerprint, secret };
    persist({ version: 1, hosts: old ? state.hosts.map(h => h.id === old.id ? host : h) : [...state.hosts, host] });
    return describe(host);
  }
  return {
    list: () => ({ hosts: state.hosts.map(describe), secureStorageAvailable: secure() }), get,
    save, update,
    delete(p) { const old = get(p.id); if (old.revision !== p.revision) fail(-32005, 'SSH host changed'); persist({ version: 1, hosts: state.hosts.filter(h => h.id !== p.id) }); return { deleted: true }; },
    secret(host) { if (!host.secret) return ''; if (!secure()) fail(-32083, 'Saved SSH credential is unavailable on this device'); try { return safeStorage.decryptString(Buffer.from(host.secret, 'base64')); } catch { fail(-32083, 'Saved SSH credential could not be decrypted'); } },
  };
}
module.exports = { createSshStore };
