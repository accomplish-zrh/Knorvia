'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { connectionError } = require('./connection-config');
const { verifyResolvedPath } = require('./desktop-path-actions');
const { analyzeExtension, STATUS } = require('./extension-compat');
const F = require('./extension-files');
const METHODS = ['extension/list', 'extension/inspect', 'extension/install', 'extension/enable', 'extension/uninstall', 'extension/rollback', 'workspace/extensions/analyze'];
const fail = (code, message) => { throw connectionError(code, message); };
const validId = id => typeof id === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/.test(id);
const pluginName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
function atomic(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`; try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); } }
function createExtensionManager({ home, rpc, fetchImpl = globalThis.fetch }) {
  if (!path.isAbsolute(home || '') || typeof rpc !== 'function') throw new Error('Extensions require an absolute Home and Kernel RPC');
  const root = path.join(home, 'extensions'), catalogFile = path.join(root, 'catalog.json'), staging = path.join(root, 'staging'), journalFile = path.join(root, 'pending-transition.json');
  const skillsRoot = path.join(home, 'state', 'kernel', 'skills');
  fs.mkdirSync(staging, { recursive: true }); fs.mkdirSync(skillsRoot, { recursive: true });
  let state, recoveryError = ''; const entryErrors = new Map();
  const validEntry = e => e && validId(e.id) && typeof e.name === 'string' && Number.isSafeInteger(e.revision) && e.revision > 0 && typeof e.enabled === 'boolean' && Array.isArray(e.versions) && e.versions.length > 0 && e.versions.length <= 10 && e.versions.some(v => v.id === e.activeVersion) && e.versions.every(v => validId(v.id) && /^[a-f\d]{64}$/.test(v.sha256) && typeof v.report?.format === 'string' && Array.isArray(v.report.components) && v.report.components.length <= 2000 && v.report.components.every(c => { try { F.relative(c.component); return typeof c.format === 'string' && typeof c.status === 'string'; } catch { return false; } }));
  try { state = JSON.parse(fs.readFileSync(catalogFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') recoveryError = 'Extension catalog could not be read. It has been preserved; extension changes are disabled until it is repaired'; state = { version: 1, entries: [] }; }
  if (state?.version !== 1 || !Array.isArray(state.entries) || state.entries.length > 100 || state.entries.some(e => !validEntry(e))) { recoveryError = 'Invalid extension catalog. It has been preserved; extension changes are disabled until it is repaired'; state = { version: 1, entries: [] }; }
  let queue = Promise.resolve();
  const serial = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  const current = entry => entry.versions.find(v => v.id === entry.activeVersion);
  const packagePath = (id, version) => { if (!validId(id) || !validId(version)) fail(-32602, 'Invalid extension version'); return path.join(root, 'marketplaces', id, 'packages', version, 'plugin'); };
  const marketplacePath = id => path.join(root, 'marketplaces', id, '.agents', 'plugins', 'marketplace.json');
  const describe = entry => ({ ...entry, versions: entry.versions.map(v => ({ id: v.id, createdAt: v.createdAt, sha256: v.sha256, source: v.source })), report: current(entry)?.report, recoveryError: entryErrors.get(entry.id) || null });
  const find = p => { const entry = state.entries.find(e => e.id === p.id); if (!entry) fail(-32091, 'Extension not found'); if (p.revision !== entry.revision) fail(-32005, 'Extension changed; refresh before editing'); return entry; };
  async function materialize(source, temp) {
    if (!source || typeof source !== 'object') fail(-32602, 'Choose an extension source');
    if (source.type === 'local') {
      const scope = { workspaceId: source.workspaceId, threadId: source.threadId, path: source.path || '' };
      const resolved = verifyResolvedPath(await rpc('workspace/path/resolve', scope), scope);
      if (resolved.kind === 'directory') { F.copy(resolved.target, temp); return { dir: temp, source: { type: 'local', name: path.basename(resolved.target) } }; }
      if (resolved.kind !== 'file' || !resolved.target.toLowerCase().endsWith('.zip')) fail(-32602, 'Choose an extension folder or ZIP file within a project');
      if (fs.statSync(resolved.target).size > 24 * 1024 * 1024) fail(-32082, 'Extension ZIP exceeds 24 MB');
      await F.extractZip(resolved.target, temp);
    } else if (source.type === 'github') {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source.repository || '') || !/^[a-f\d]{40}$/i.test(source.commit || '')) fail(-32602, 'Use owner/repository and a fixed 40-character GitHub commit');
      const url = `https://codeload.github.com/${source.repository}/zip/${source.commit}`;
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'Knorvia-extension-import' } });
      if (!response.ok || !response.body) fail(-32092, 'GitHub package download failed');
      let bytes = 0; const chunks = [];
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 24 * 1024 * 1024) fail(-32082, 'GitHub package exceeds 24 MB'); chunks.push(Buffer.from(chunk)); }
      const archive = `${temp}.zip`;
      try { fs.writeFileSync(archive, Buffer.concat(chunks), { flag: 'wx' }); await F.extractZip(archive, temp); } finally { if (fs.existsSync(archive)) fs.unlinkSync(archive); }
    } else fail(-32602, 'Unsupported extension source');
    let dir = temp;
    const top = fs.readdirSync(temp, { withFileTypes: true });
    if (top.length === 1 && top[0].isDirectory()) dir = path.join(temp, top[0].name);
    if (source.subdirectory) dir = path.join(dir, ...F.relative(source.subdirectory).split('/'));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(-32602, 'Extension subdirectory was not found');
    return { dir, source: source.type === 'github' ? { type: 'github', repository: source.repository, commit: source.commit.toLowerCase(), subdirectory: source.subdirectory || '' } : { type: 'local-zip' } };
  }
  function activation(entry) {
    const version = current(entry), dir = packagePath(entry.id, version.id), report = version.report;
    if (F.scan(dir).sha256 !== version.sha256) fail(-32005, 'Installed extension files changed; preserve your edits before replacing this version');
    if (report.format === 'codex-plugin') {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), 'utf8'));
      if (!pluginName(manifest.name)) fail(-32602, 'Codex plugin requires a valid name');
      return { kind: 'plugin', pluginName: manifest.name, pluginId: `${manifest.name}@knorvia-${entry.id}`, dir };
    }
    const skills = report.components.filter(c => c.format === 'agent-skill' && c.status === STATUS.LOADABLE).map(c => ({ source: path.dirname(path.join(dir, c.component)), name: c.name }));
    return { kind: 'skills', skills, dir };
  }
  async function setActive(entry, enabled) {
    const plan = activation(entry);
    if (plan.kind === 'plugin') {
      if (enabled) {
        atomic(marketplacePath(entry.id), { name: `knorvia-${entry.id}`, plugins: [{ name: plan.pluginName, source: { source: 'local', path: `./packages/${entry.activeVersion}/plugin` } }] });
        await rpc('extension/kernel/install', { marketplacePath: marketplacePath(entry.id), pluginName: plan.pluginName, installAttemptId: randomUUID() });
      } else await rpc('extension/kernel/uninstall', { pluginId: plan.pluginId });
    } else {
      if (enabled && !plan.skills.length) fail(-32093, 'This package has no supported Skills. Its host-specific components have not been activated');
      for (let i = 0; i < plan.skills.length; i++) {
        const target = path.join(skillsRoot, `knorvia-${entry.id}-${i}`), source = plan.skills[i].source;
        if (fs.existsSync(target)) {
          if (F.scan(target).sha256 !== F.scan(source).sha256) fail(-32005, 'An activated skill has local edits; preserve them before changing the extension');
          if (!enabled) F.removeOwned(skillsRoot, target);
        } else if (enabled) F.copy(source, target);
      }
    }
    return rpc('skills/list', { forceReload: true });
  }
  async function transition(previous, next) {
    if (recoveryError) fail(-32094, recoveryError);
    if (fs.existsSync(journalFile)) fail(-32094, 'An interrupted extension change must be recovered before making another change');
    atomic(journalFile, { version: 1, previous, next });
    try {
      if (previous?.enabled) await setActive(previous, false);
      if (next?.enabled) await setActive(next, true);
      const entries = state.entries.filter(e => e.id !== (previous?.id || next.id));
      if (next) entries.push(next);
      const updated = { version: 1, entries }; atomic(catalogFile, updated); state = updated;
      entryErrors.delete(previous?.id || next.id);
    } catch (error) {
      try { if (next?.enabled) await setActive(next, false); if (previous?.enabled) await setActive(previous, true); }
      catch { fail(-32094, 'Extension update failed and needs recovery. Existing package versions are preserved'); }
      fs.unlinkSync(journalFile);
      throw error;
    }
    // If cleanup is interrupted, restore reconciles against the committed
    // catalog, so a completed change is never silently rolled back.
    try { fs.unlinkSync(journalFile); } catch {}
    return next ? describe(next) : { uninstalled: true, versionsRetained: true };
  }
  async function inspect(source, install) {
    const temp = path.join(staging, randomUUID());
    try {
      const loaded = await materialize(source, temp), report = analyzeExtension({ dir: loaded.dir });
      const manifest = F.scan(loaded.dir);
      if (!install) return { report, sha256: manifest.sha256, files: manifest.files.length, bytes: manifest.bytes, source: loaded.source };
      if (install.expectedSha256 !== manifest.sha256) fail(-32005, 'Package changed since inspection; inspect it again before installing');
      const previous = install.id ? find(install) : null;
      if (recoveryError) fail(-32094, recoveryError);
      if (!previous && state.entries.length >= 100) fail(-32082, 'Keep at most 100 installed extensions');
      if (previous?.versions.length >= 10) fail(-32082, 'Keep at most 10 extension versions');
      if (report.status === STATUS.UNSUPPORTED) fail(-32093, 'No supported extension format was found');
      const id = previous?.id || randomUUID(), version = randomUUID(), destination = packagePath(id, version);
      F.copy(loaded.dir, destination);
      // Report paths describe the immutable installed package, never staging.
      report.dir = destination;
      const record = { id: version, createdAt: new Date().toISOString(), sha256: manifest.sha256, report, source: loaded.source };
      const primary = report.components.find(c => c.name);
      const next = { id, name: primary?.name || loaded.source.name || 'Extension', revision: (previous?.revision || 0) + 1, enabled: previous?.enabled || false, activeVersion: version, versions: [...(previous?.versions || []), record] };
      if (previous && previous.name !== next.name) fail(-32005, 'Updated package identity does not match this extension');
      return transition(previous, next);
    } finally { if (fs.existsSync(temp)) F.removeOwned(staging, temp); }
  }
  const handlers = {
    'extension/list': async () => ({ entries: state.entries.map(describe), recoveryError: recoveryError || null }),
    'extension/inspect': p => serial(() => inspect(p.source)),
    'extension/install': p => serial(() => inspect(p.source, p)),
    'extension/enable': p => serial(async () => { const old = find(p); if (typeof p.enabled !== 'boolean') fail(-32602, 'Choose enable or disable'); return transition(old, { ...old, revision: old.revision + 1, enabled: p.enabled }); }),
    'extension/uninstall': p => serial(() => transition(find(p), null)),
    'extension/rollback': p => serial(() => { const old = find(p); if (!old.versions.some(v => v.id === p.version)) fail(-32602, 'Unknown extension version'); return transition(old, { ...old, revision: old.revision + 1, activeVersion: p.version }); }),
    'workspace/extensions/analyze': p => serial(async () => { const scope = { workspaceId: p.workspaceId, threadId: p.threadId, path: p.path || '' }; if (p.dir !== undefined) fail(-32602, 'Choose an extension path within a project'); const resolved = verifyResolvedPath(await rpc('workspace/path/resolve', scope), scope); if (resolved.kind !== 'directory') fail(-32602, 'Extension analysis requires a project folder'); return analyzeExtension({ dir: resolved.target }); }),
  };
  return { handlers, async restore() { return serial(async () => {
    if (recoveryError) return { restored: false, recoveryError };
    if (fs.existsSync(journalFile)) {
      try {
        const pending = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
        if (pending.version !== 1 || (!pending.previous && !pending.next) || (pending.previous && !validEntry(pending.previous)) || (pending.next && !validEntry(pending.next))) fail(-32094, 'Invalid extension recovery record');
        const id = pending.previous?.id || pending.next.id;
        if (pending.next && pending.next.id !== id) fail(-32094, 'Invalid extension recovery identity');
        const committed = state.entries.find(e => e.id === id);
        if (pending.next?.enabled && (!committed?.enabled || committed.activeVersion !== pending.next.activeVersion)) await setActive(pending.next, false);
        if (committed?.enabled) await setActive(committed, true);
        fs.unlinkSync(journalFile);
      } catch { recoveryError = 'An interrupted extension change could not be recovered. Files and recovery records are preserved; extension changes are temporarily disabled'; return { restored: false, recoveryError }; }
    }
    entryErrors.clear();
    for (const entry of state.entries) if (entry.enabled) { try { await setActive(entry, true); } catch (error) { entryErrors.set(entry.id, error.rpc?.message || 'This extension could not be loaded. Its package is preserved; disable it or repair its dependencies'); } }
    return { restored: entryErrors.size === 0, failed: entryErrors.size };
  }); }, async close() { await queue; } };
}
// Connection replacement is awaited by the request that owns it. An engine
// restored after a failed provider switch must also receive its extensions.
function extensionConnectionHandlers(runtime, manager) {
  const wrap = method => async params => {
    const previous = runtime.engine;
    try { return await runtime[method](params); }
    finally { if (runtime.engine && runtime.engine !== previous) await manager.restore(); }
  };
  return { 'connection/update': wrap('connectionUpdate'), 'connection/provider/activate': wrap('providerActivate') };
}
module.exports = { createExtensionManager, extensionConnectionHandlers, METHODS };
