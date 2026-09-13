'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { connectionError } = require('./connection-config');
const { verifyResolvedPath } = require('./desktop-path-actions');
const { analyzeExtension, STATUS } = require('./extension-compat');
const F = require('./extension-files');
const { createGitHubSubtreeFetcher } = require('./github-extension-source');
const METHODS = ['extension/list', 'extension/inspect', 'extension/install', 'extension/enable', 'extension/uninstall', 'extension/rollback', 'workspace/extensions/analyze', 'extension/storage/plan', 'extension/storage/cleanup', 'extension/builtin/status'];
const fail = (code, message, data) => { throw connectionError(code, message, data); };
const validId = id => typeof id === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/.test(id);
const pluginName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
function atomic(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`; try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); } }
function pidAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
function atomicWriteLock(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    // A concurrent reader's handle makes the rename fail transiently on
    // Windows (EPERM/EBUSY): bounded retry, the intent stays the same
    // because the single-flight claim serializes stealers.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temp, file); break; }
      catch (error) {
        if (attempt >= 10 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function readLock(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
// Cross-instance mutex for the shared extension catalog.
//
// Ownership protocol (CODEX-0615-C02):
// - Every install (fresh or dead-owner recovery) goes through the SINGLE
//   shared steal slot `catalog.lock.steal` via link-CAS (atomic
//   create-if-absent). Exactly one process ever holds a given slot instance.
// - Only the link-CAS winner may rename THAT slot onto `catalog.lock`, and
//   only after re-checking that no live lock owner is present. The rename
//   source is exclusively ours from link-CAS until commit or abort-unlink.
// - A contender that loses link-CAS never renames, unlinks, or replaces the
//   existing steal file. Live mid-flight creators cause wait/timeout; a
//   pre-existing slot whose creator is dead/unreadable is an ORPHAN and
//   fail-closes (-32095, reason orphaned-steal). Auto-consuming an orphan
//   (read-then-rename or rename-to-private) cannot be proven safe once the
//   shared path may already have been reused by a new live recoverer.
// - Manual recovery for an orphan: delete `catalog.lock.steal` only after
//   confirming no live Knorvia process is mid-recovery, then retry. Dead
//   catalog.lock owners with a clear steal path recover automatically.
// - A LIVE lock holder is never stolen (no age-based steal). Release unlinks
//   only when the on-disk token still matches the owner.
// Steps are exposed through createCatalogLock for deterministic tests.
function createCatalogLock(root, { lockStaleMs = 30_000, lockTimeoutMs = 15_000 } = {}) {
  const lockFile = path.join(root, 'catalog.lock');
  const stealFile = path.join(root, 'catalog.lock.steal');
  const token = `${process.pid}_${randomUUID()}`;
  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const writeTempRecord = record => {
    const temp = `${lockFile}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    return temp;
  };
  const linkCas = (temp, destination) => {
    try { fs.linkSync(temp, destination); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  };
  const renameWithRetry = (from, destination) => {
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(from, destination); return true; }
      catch (error) {
        if (attempt >= 10 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return false;
        sleep(25);
      }
    }
  };
  // Installs `record` as the lock through an exclusively acquired steal slot.
  // Losers of link-CAS do not touch the foreign slot or the lock.
  const installRecoveryRecord = record => {
    const temp = writeTempRecord(record);
    try {
      if (!linkCas(temp, stealFile)) {
        const stale = readLock(stealFile);
        if (stale && pidAlive(stale.pid)) return { committed: false, reason: 'another recovery is mid-flight' };
        if (!stale) {
          try {
            if (Date.now() - fs.statSync(stealFile).mtimeMs < 2000) {
              return { committed: false, reason: 'fresh unknown steal record' };
            }
          } catch { /* stat raced with slot removal; retry */ return { committed: false, reason: 'steal slot raced away' }; }
        }
        // Orphan (dead or old-unreadable) steal: fail closed. Never rename,
        // unlink, or replace a slot we did not create - the shared path may
        // already hold a newer live recoverer's slot by the time we act.
        return { committed: false, reason: 'orphaned-steal' };
      }
      // We exclusively hold the slot we created. Re-check lock liveness under
      // it: a live owner means abort and release OUR slot only.
      const current = readLock(lockFile);
      if (fs.existsSync(lockFile) && (!current || !Number.isInteger(current.pid) || current.pid <= 0)) {
        try { fs.unlinkSync(stealFile); } catch { /* best effort */ }
        return { committed: false, reason: 'unreadable-owner' };
      }
      if (current && pidAlive(current.pid)) {
        try { fs.unlinkSync(stealFile); } catch { /* best effort */ }
        return { committed: false, reason: 'live owner appeared' };
      }
      if (!renameWithRetry(stealFile, lockFile)) return { committed: false, reason: 'recovery rename failed; slot preserved for recovery' };
      return { committed: true };
    } finally { try { fs.unlinkSync(temp); } catch { /* best effort */ } }
  };
  // Same commit path as acquire: never bypass the steal slot with a direct
  // lock link-CAS (that would race a steal holder mid-commit).
  const tryAcquire = (gen = 0) => {
    const info = readLock(lockFile);
    if (info && pidAlive(info.pid)) return false;
    const record = fs.existsSync(lockFile)
      ? { token, pid: process.pid, at: Date.now(), gen: (Number(info?.gen) || 0) + 1, stolenFrom: info?.token ?? null }
      : { token, pid: process.pid, at: Date.now(), gen };
    return installRecoveryRecord(record).committed;
  };
  const owns = () => readLock(lockFile)?.token === token;
  const release = () => {
    // A concurrent reader's open handle makes unlink fail transiently on
    // Windows; bounded retry keeps an owner's release from being silently
    // swallowed (which would leave a live-looking record behind).
    for (let attempt = 0; ; attempt++) {
      try {
        if (readLock(lockFile)?.token !== token) return;
        fs.unlinkSync(lockFile);
        return;
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        if (attempt >= 10 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return;
        sleep(25);
      }
    }
  };
  const acquire = async () => {
    const deadline = Date.now() + lockTimeoutMs;
    for (;;) {
      const info = readLock(lockFile);
      if (info && pidAlive(info.pid)) {
        if (info.token === token) return;
        if (Date.now() > deadline) fail(-32095, 'Another Knorvia instance is holding the extension store lock; retry once its change completes', { holderPid: info.pid });
        await new Promise(resolve => setTimeout(resolve, 50)); continue;
      }
      if (fs.existsSync(lockFile) && (!info || !Number.isInteger(info.pid) || info.pid <= 0)) {
        // Unreadable ownership cannot establish that an old holder is dead.
        if (Date.now() > deadline) fail(-32095, 'The extension lock record is unreadable; recovery is required before extension changes', { reason: 'unreadable-owner' });
        await new Promise(resolve => setTimeout(resolve, 50)); continue;
      }
      // Every acquisition - fresh or recovery - goes through the shared
      // steal slot, so install commits are serialized by the link-CAS.
      const gen = Number(info?.gen) || 0;
      const record = fs.existsSync(lockFile)
        ? { token, pid: process.pid, at: Date.now(), gen: gen + 1, stolenFrom: info?.token ?? null }
        : { token, pid: process.pid, at: Date.now(), gen: 0 };
      const outcome = installRecoveryRecord(record);
      if (outcome.committed) break;
      if (Date.now() > deadline) {
        if (outcome.reason === 'orphaned-steal' || outcome.reason === 'fresh unknown steal record') {
          fail(-32095, 'An orphaned extension lock steal slot blocks recovery; delete catalog.lock.steal only after confirming no live Knorvia process holds it, then retry', { reason: outcome.reason, stealFile });
        }
        fail(-32095, 'The extension lock could not be recovered within the timeout; extension changes stay refused', { reason: outcome.reason });
      }
      // Yield on every retry so one waiter cannot block another local owner.
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  return { token, lockFile, stealFile, tryAcquire, acquire, installRecoveryRecord, owns, release };
}
async function withCatalogLock(root, options, work) {
  const { lockStaleMs = 30_000, lockTimeoutMs = 15_000 } = options || {};
  const lock = createCatalogLock(root, { lockStaleMs, lockTimeoutMs });
  await lock.acquire();
  try {
    return await work();
  } finally {
    lock.release();
  }
}
function createExtensionManager({ home, rpc, fetchImpl = globalThis.fetch, lockStaleMs = 30_000, lockTimeoutMs = 15_000, getBuiltinSkills = null }) {
  if (!path.isAbsolute(home || '') || typeof rpc !== 'function') throw new Error('Extensions require an absolute Home and Kernel RPC');
  const root = path.join(home, 'extensions'), catalogFile = path.join(root, 'catalog.json'), staging = path.join(root, 'staging'), journalFile = path.join(root, 'pending-transition.json');
  const skillsRoot = path.join(home, 'state', 'kernel', 'skills');
  fs.mkdirSync(staging, { recursive: true }); fs.mkdirSync(skillsRoot, { recursive: true });
  let state, recoveryError = ''; const entryErrors = new Map();
  const validEntry = e => e && validId(e.id) && typeof e.name === 'string' && Number.isSafeInteger(e.revision) && e.revision > 0 && typeof e.enabled === 'boolean' && Array.isArray(e.versions) && e.versions.length > 0 && e.versions.length <= 10 && e.versions.some(v => v.id === e.activeVersion) && e.versions.every(v => validId(v.id) && /^[a-f\d]{64}$/.test(v.sha256) && typeof v.report?.format === 'string' && Array.isArray(v.report.components) && v.report.components.length <= 2000 && v.report.components.every(c => { try { F.relative(c.component); return typeof c.format === 'string' && typeof c.status === 'string'; } catch { return false; } }));
  const readCatalog = () => {
    let parsed, readError = '';
    try { parsed = JSON.parse(fs.readFileSync(catalogFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') readError = 'Extension catalog could not be read. It has been preserved; extension changes are disabled until it is repaired'; parsed = { version: 1, entries: [] }; }
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > 100 || parsed.entries.some(e => !validEntry(e))) { readError = 'Invalid extension catalog. It has been preserved; extension changes are disabled until it is repaired'; parsed = { version: 1, entries: [] }; }
    return { state: parsed, recoveryError: readError };
  };
  const initial = readCatalog(); state = initial.state; recoveryError = initial.recoveryError;
  const lockOptions = { lockStaleMs, lockTimeoutMs };
  let queue = Promise.resolve();
  let closing = false;
  const serial = work => {
    if (closing) fail(-32000, 'Extension manager is closing; reopen the application before changing extensions');
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const current = entry => entry.versions.find(v => v.id === entry.activeVersion);
  const packagePath = (id, version) => { if (!validId(id) || !validId(version)) fail(-32602, 'Invalid extension version'); return path.join(root, 'marketplaces', id, 'packages', version, 'plugin'); };
  const marketplacePath = id => path.join(root, 'marketplaces', id, '.agents', 'plugins', 'marketplace.json');
  const marketplacesRoot = path.join(root, 'marketplaces');
  // C05: uninstall intentionally retains package files (rollback/journal
  // safety), so this scan makes the retained storage reviewable: orphan
  // packages (ids absent from the catalog) and unreferenced version folders
  // are reclaimable; every referenced version stays protected, and a
  // referenced version whose files no longer match its install hash is
  // reported as modified instead of ever being auto-deleted.
  async function computeExtensionStorage() {
    const entries = new Map(state.entries.map(entry => [entry.id, entry]));
    const reclaimable = [];
    const protectedModified = [];
    const installed = [];
    let idDirs = [];
    try { idDirs = fs.readdirSync(marketplacesRoot, { withFileTypes: true }); } catch { idDirs = []; }
    for (const dirent of idDirs) {
      if (!dirent.isDirectory()) continue;
      const id = dirent.name;
      const entry = entries.get(id);
      if (!entry) {
        try {
          const manifest = F.scan(path.join(marketplacesRoot, id));
          reclaimable.push({ kind: 'orphan-package', id, bytes: manifest.bytes });
        } catch (error) {
          protectedModified.push({ id, reason: '该目录无法按扩展包规则读取，请手动检查后再删除', detail: String(error?.message || error).slice(0, 200) });
        }
        continue;
      }
      let installedBytes = 0;
      const packagesDir = path.join(marketplacesRoot, id, 'packages');
      let versionDirs = [];
      try { versionDirs = fs.readdirSync(packagesDir, { withFileTypes: true }); } catch { versionDirs = []; }
      for (const versionDir of versionDirs) {
        if (!versionDir.isDirectory()) continue;
        const versionId = versionDir.name;
        const record = entry.versions.find(v => v.id === versionId);
        if (!record) {
          try {
            const manifest = F.scan(path.join(packagesDir, versionId));
            reclaimable.push({ kind: 'orphan-version', id, versionId, bytes: manifest.bytes });
          } catch (error) {
            protectedModified.push({ id, versionId, reason: '该版本目录无法按扩展包规则读取，请手动检查后再删除', detail: String(error?.message || error).slice(0, 200) });
          }
          continue;
        }
        try {
          const manifest = F.scan(path.join(packagesDir, versionId, 'plugin'));
          installedBytes += manifest.bytes;
          if (manifest.sha256 !== record.sha256) {
            protectedModified.push({ id, versionId, reason: '安装后的包内容与安装哈希不一致（可能被修改）；先修复或在界面中处理，不会自动删除' });
          }
        } catch (error) {
          protectedModified.push({ id, versionId, reason: '包内容无法读取；不会自动删除', detail: String(error?.message || error).slice(0, 200) });
        }
      }
      installed.push({ id, name: entry.name, enabled: entry.enabled, versions: entry.versions.length, bytes: installedBytes });
    }
    return {
      version: 1,
      token: createHash('sha256').update(JSON.stringify(reclaimable)).digest('hex'),
      installed,
      reclaimable,
      protectedModified,
      reclaimableBytes: reclaimable.reduce((sum, item) => sum + item.bytes, 0),
    };
  }
  const describe = entry => ({ ...entry, versions: entry.versions.map(v => ({ id: v.id, createdAt: v.createdAt, sha256: v.sha256, source: v.source })), report: current(entry)?.report, recoveryError: entryErrors.get(entry.id) || null });
  const find = p => {
    // Entry lookups re-read the shared catalog so a revision handed back by
    // the freshest listing is accepted even if this instance's memory lags;
    // transition re-checks under the lock, which stays authoritative.
    const fresh = readCatalog();
    if (!fresh.recoveryError) state = fresh.state;
    const entry = state.entries.find(e => e.id === p.id); if (!entry) fail(-32091, 'Extension not found'); if (p.revision !== entry.revision) fail(-32005, 'Extension changed; refresh before editing'); return entry;
  };
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
      if (source.subdirectory) {
        // C12: a pinned subdirectory resolves and fetches only that subtree
        // at the fixed commit — a huge repository no longer hits the
        // whole-repo ZIP cap for a small selected Skill.
        const fetcher = createGitHubSubtreeFetcher({ fetchImpl });
        const outcome = await fetcher.fetchSubtree({
          repository: source.repository,
          commit: source.commit,
          subdirectory: source.subdirectory,
          destination: temp,
        });
        return { dir: temp, source: outcome.source };
      }
      const url = `https://codeload.github.com/${source.repository}/zip/${source.commit}`;
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'Knorvia-extension-import' } });
      if (!response.ok || !response.body) fail(-32092, 'GitHub package download failed');
      let bytes = 0; const chunks = [];
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 24 * 1024 * 1024) fail(-32082, 'GitHub package exceeds 24 MB'); chunks.push(Buffer.from(chunk)); }
      const archive = `${temp}.zip`;
      try { fs.writeFileSync(archive, Buffer.concat(chunks), { flag: 'wx' }); await F.extractZip(archive, temp); } finally { if (fs.existsSync(archive)) fs.unlinkSync(archive); }
    } else if (source.type === 'exported') {
      // C10: import from a verified extension-export container. The package
      // is hash-verified against the container manifest before the copy, so
      // the normal inspect/install chain validates a byte-identical payload.
      const { resolveExportedPackage } = require('./extension-export');
      const resolved = await resolveExportedPackage({ exportDir: source.exportDir, entryId: source.entryId, versionId: source.versionId });
      F.copy(resolved.pluginDir, temp);
      return { dir: temp, source: resolved.source };
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
    // Multi-instance safety: the whole transaction runs under the shared
    // catalog lock, re-reads the catalog another instance may have committed,
    // and CAS-checks the entry revision before touching anything. A stale
    // caller is refused instead of silently overwriting a sibling update.
    return withCatalogLock(root, lockOptions, async () => {
      const fresh = readCatalog();
      state = fresh.state;
      if (fresh.recoveryError) { recoveryError = fresh.recoveryError; fail(-32094, recoveryError); }
      if (fs.existsSync(journalFile)) fail(-32094, 'An interrupted extension change must be recovered before making another change');
      let effectivePrevious = previous;
      if (previous) {
        const committed = state.entries.find(e => e.id === previous.id);
        if (!committed) fail(-32091, 'Extension not found');
        if (committed.revision !== previous.revision) fail(-32005, 'Extension changed; refresh before editing');
        effectivePrevious = committed;
      }
      atomic(journalFile, { version: 1, previous: effectivePrevious, next });
      try {
        if (effectivePrevious?.enabled) await setActive(effectivePrevious, false);
        if (next?.enabled) await setActive(next, true);
        // Commit from the freshly read entries so a sibling instance's
        // unrelated committed entries survive this change.
        const entries = state.entries.filter(e => e.id !== (effectivePrevious?.id || next.id));
        if (next) entries.push(next);
        const updated = { version: 1, entries }; atomic(catalogFile, updated); state = updated;
        entryErrors.delete(effectivePrevious?.id || next.id);
      } catch (error) {
        try { if (next?.enabled) await setActive(next, false); if (effectivePrevious?.enabled) await setActive(effectivePrevious, true); }
        catch { fail(-32094, 'Extension update failed and needs recovery. Existing package versions are preserved'); }
        fs.unlinkSync(journalFile);
        throw error;
      }
      // If cleanup is interrupted, restore reconciles against the committed
      // catalog, so a completed change is never silently rolled back.
      try { fs.unlinkSync(journalFile); } catch {}
      return next ? describe(next) : { uninstalled: true, versionsRetained: true };
    });
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
    // The listing re-reads the shared catalog so changes committed by another
    // manager instance on the same Home are visible without a restart; an
    // atomic rename guarantees a whole old-or-new catalog view.
    'extension/list': async () => { let view = state; if (!recoveryError) { try { const fresh = readCatalog(); if (!fresh.recoveryError) view = fresh.state; } catch { /* keep the in-memory view */ } } return { entries: view.entries.map(describe), recoveryError: recoveryError || null }; },
    'extension/inspect': p => serial(() => inspect(p.source)),
    'extension/install': p => serial(() => inspect(p.source, p)),
    'extension/enable': p => serial(async () => { const old = find(p); if (typeof p.enabled !== 'boolean') fail(-32602, 'Choose enable or disable'); return transition(old, { ...old, revision: old.revision + 1, enabled: p.enabled }); }),
    'extension/uninstall': p => serial(() => transition(find(p), null)),
    'extension/rollback': p => serial(() => { const old = find(p); if (!old.versions.some(v => v.id === p.version)) fail(-32602, 'Unknown extension version'); return transition(old, { ...old, revision: old.revision + 1, activeVersion: p.version }); }),
    'workspace/extensions/analyze': p => serial(async () => { const scope = { workspaceId: p.workspaceId, threadId: p.threadId, path: p.path || '' }; if (p.dir !== undefined) fail(-32602, 'Choose an extension path within a project'); const resolved = verifyResolvedPath(await rpc('workspace/path/resolve', scope), scope); if (resolved.kind !== 'directory') fail(-32602, 'Extension analysis requires a project folder'); return analyzeExtension({ dir: resolved.target }); }),
    'extension/builtin/status': async () => ({ skills: typeof getBuiltinSkills === 'function' ? getBuiltinSkills() : [] }),
    // C05: storage review and plan-gated reclamation of retained packages.
    'extension/storage/plan': () => serial(async () => {
      const fresh = readCatalog();
      if (!fresh.recoveryError) state = fresh.state;
      return computeExtensionStorage();
    }),
    'extension/storage/cleanup': p => serial(() => withCatalogLock(root, lockOptions, async () => {
      const fresh = readCatalog();
      state = fresh.state;
      if (fresh.recoveryError) { recoveryError = fresh.recoveryError; fail(-32094, recoveryError); }
      if (fs.existsSync(journalFile)) fail(-32094, 'An interrupted extension change must be recovered before reclaiming extension storage');
      const plan = await computeExtensionStorage();
      if (p?.token !== plan.token) fail(-32005, 'Reclaim plan is stale; request a fresh preview before cleaning up');
      if (!plan.reclaimable.length) return { freedBytes: 0, removedPackages: 0, removedVersions: 0 };
      for (const item of plan.reclaimable) {
        const target = item.kind === 'orphan-package'
          ? path.join(marketplacesRoot, item.id)
          : path.join(marketplacesRoot, item.id, 'packages', item.versionId);
        F.removeOwned(marketplacesRoot, target);
      }
      return {
        freedBytes: plan.reclaimableBytes,
        removedPackages: plan.reclaimable.filter(item => item.kind === 'orphan-package').length,
        removedVersions: plan.reclaimable.filter(item => item.kind === 'orphan-version').length,
      };
    })),
  };
  return { handlers, async restore() { return serial(async () => {
    if (recoveryError) return { restored: false, recoveryError };
    try {
      // Recovery reconciles shared on-disk state, so it must hold the same
      // cross-instance lock as transitions; a crashed holder's stale lock is
      // stolen, a live sibling's lock makes restore report and stay read-only.
      return await withCatalogLock(root, lockOptions, async () => {
        const fresh = readCatalog();
        if (!fresh.recoveryError) state = fresh.state;
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
      });
    } catch (error) {
      if (error?.rpc?.code === -32095) return { restored: false, recoveryError: error.rpc.message };
      throw error;
    }
  }); }, async close(context = {}) {
    closing = true;
    if (context.signal?.aborted) return { confirmed: false, ownedPids: [], detail: 'extension operation remained queued at shutdown deadline' };
    if (!context.signal) { await queue; return { confirmed: true, ownedPids: [], detail: 'extension admissions frozen and queue drained' }; }
    const aborted = new Promise(resolve => context.signal.addEventListener('abort', () => resolve(false), { once: true }));
    const settled = queue.then(() => true, () => true);
    if (!await Promise.race([settled, aborted])) return { confirmed: false, ownedPids: [], detail: 'extension operation remained queued at shutdown deadline' };
    return { confirmed: true, ownedPids: [], detail: 'extension admissions frozen and queue drained' };
  } };
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
module.exports = { createExtensionManager, extensionConnectionHandlers, METHODS, __catalogLock: { withCatalogLock, createCatalogLock, atomicWriteLock, readLock } };
