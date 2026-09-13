'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createHash } = require('node:crypto');
const F = require('./extension-files');
const { analyzeExtension, STATUS } = require('./extension-compat');

// Export of user-selected installed extensions as a fixed-version container
// that another Home can review and rebuild from.
//
// The container is a directory with manifest.json + packages/<entryId>/
// <versionId>/plugin. Only the package payloads and public source
// information travel: no Home data, no credentials, no activation caches,
// no absolute paths. Every package file is hashed in the manifest, so a
// tampered container is rejected entry-by-entry at import. Packages whose
// content no longer matches their install hash (user-modified) and packages
// that look like they embed credentials are refused for export with a local
// handling note — silently rewriting a package to claim the same hash is
// never acceptable.

const EXPORT_MANIFEST = 'manifest.json';
const TEXT_SUFFIXES = new Set(['.md', '.json', '.yaml', '.yml', '.txt', '.js', '.ts', '.mjs', '.cjs', '.toml', '.xml', '.html', '.css', '.env', '.cfg', '.ini']);
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /(?:api[_-]?key|api[_-]?secret|access[_-]?token|secret|password|token)"?\s*[:=]\s*"?[A-Za-z0-9+/_-]{24,}"?/i,
];

const fail = (message, code = -32602) => { const error = new Error(message); error.rpc = { code, message }; throw error; };
const sha256File = async (file) => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

function looksLikeSecret(root) {
  const findings = [];
  const walk = (folder, prefix = '') => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full, relativePath);
      else if (entry.isFile() && (TEXT_SUFFIXES.has(path.extname(entry.name).toLowerCase()) || /^\.env(?:\.|$)/i.test(entry.name))) {
        const stat = fs.statSync(full);
        if (stat.size > 2 * 1024 * 1024) continue;
        const text = fs.readFileSync(full, 'utf8');
        for (const pattern of SECRET_PATTERNS) {
          const match = pattern.exec(text);
          if (match) {
            findings.push(`${relativePath}: 疑似凭据（${match[0].slice(0, 6)}…）`);
            break;
          }
        }
      }
    }
  };
  walk(root);
  return findings;
}

function readCatalog(catalogFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    if (parsed?.version === 1 && Array.isArray(parsed.entries)) return parsed;
  } catch { /* missing catalog: nothing installed */ }
  return { version: 1, entries: [] };
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 800) fail('导出清单中的文件路径无效', -32004);
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /^[a-zA-Z]:/.test(part))) {
    fail('导出清单中的文件路径无效（疑似路径穿越）', -32004);
  }
  return parts.join('/');
}

// Resolves one package from an export container for the import chain. The
// manifest hashes for that package are verified before anything is copied.
async function resolveExportedPackage({ exportDir, entryId, versionId }) {
  if (!exportDir || !path.isAbsolute(exportDir)) fail('请提供导出目录的绝对路径');
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(path.join(exportDir, EXPORT_MANIFEST), 'utf8')); } catch {
    fail('导出目录缺少有效的 manifest.json', -32004);
  }
  if (manifest?.schemaVersion !== 1 || manifest?.tool !== 'knorvia-extension-export') fail('导出清单版本不受支持', -32004);
  const entry = (manifest.entries || []).find((item) => item.id === entryId);
  if (!entry) fail('导出包中找不到该扩展', -32004);
  const version = entry.versions.find((item) => item.versionId === (versionId || entry.activeVersionId));
  if (!version) fail('导出包中找不到该版本', -32004);
  const pluginDir = path.join(exportDir, 'packages', ...safeRelative(version.packagePath).split('/'));
  for (const file of version.files) {
    const relativePath = safeRelative(file.p);
    const full = path.join(pluginDir, ...relativePath.split('/'));
    let digest = '';
    try { digest = await sha256File(full); } catch { fail(`导出包缺失文件：${relativePath}`, -32004); }
    if (digest !== file.h) fail(`导出包文件被篡改：${relativePath}`, -32004);
  }
  return { pluginDir, source: version.source, sha256: version.sha256, name: entry.name };
}

function createExtensionExport({ home } = {}) {
  if (!path.isAbsolute(home || '')) throw new Error('extension-export requires an absolute Home');
  const root = path.join(home, 'extensions');
  const marketplaces = path.join(root, 'marketplaces');

  // Exports the selected entries at their active version. Per-item results:
  // exported / blocked-user-modified / blocked-secret / not-found.
  async function exportExtensions({ destination, ids }) {
    if (!destination || !path.isAbsolute(destination)) fail('请选择一个绝对路径作为导出位置');
    const selected = new Set(Array.isArray(ids) && ids.length ? ids : []);
    const catalog = readCatalog(path.join(root, 'catalog.json'));
    const entries = catalog.entries.filter((entry) => !selected.size || selected.has(entry.id));
    if (!entries.length) fail('没有可导出的扩展（请先安装或选择扩展）');
    let exists = true;
    try { await fsp.stat(destination); } catch { exists = false; }
    if (exists) fail('导出位置已存在，请选择一个新目录', -32005);
    const results = [];
    const exportedManifestEntries = [];
    await fsp.mkdir(destination, { recursive: true });
    try {
      for (const entry of entries) {
        try {
          const version = entry.versions.find((item) => item.id === entry.activeVersion);
          if (!version) fail('该扩展没有可导出的版本', -32004);
          const pluginDir = path.join(marketplaces, entry.id, 'packages', version.id, 'plugin');
          const manifest = F.scan(pluginDir);
          if (manifest.sha256 !== version.sha256) {
            fail('安装后的包内容与安装哈希不一致（可能被用户修改）；为保留你的修改，未导出。如需导出请先备份并卸载重装', -32005);
          }
          const secretFindings = looksLikeSecret(pluginDir);
          if (secretFindings.length) {
            fail(`疑似嵌入凭据：${secretFindings[0]}。请在本机移除凭据后重新安装该扩展，再导出`, -32093);
          }
          const versionId = version.id;
          const targetBase = path.join(destination, 'packages', entry.id, versionId, 'plugin');
          const files = [];
          for (const file of manifest.files) {
            const from = path.join(pluginDir, ...file.name.split('/'));
            const to = path.join(targetBase, ...file.name.split('/'));
            await fsp.mkdir(path.dirname(to), { recursive: true });
            await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
            files.push({ p: file.name, s: file.size, h: file.sha256 });
          }
          exportedManifestEntries.push({
            id: entry.id,
            name: entry.name,
            activeVersionId: versionId,
            versions: [{
              versionId,
              sha256: version.sha256,
              source: version.source || { type: 'unknown' },
              report: { format: version.report?.format, status: version.report?.status, components: version.report?.components },
              packagePath: path.join(entry.id, versionId, 'plugin'),
              files,
            }],
          });
          results.push({ id: entry.id, name: entry.name, status: 'exported' });
        } catch (error) {
          results.push({ id: entry.id, name: entry.name, status: /凭据/.test(error?.message || '') ? 'blocked-secret' : /用户修改|哈希不一致/.test(error?.message || '') ? 'blocked-user-modified' : 'failed', detail: String(error?.message || error).slice(0, 300) });
        }
      }
      const exported = exportedManifestEntries.length;
      const containerManifest = {
        schemaVersion: 1,
        tool: 'knorvia-extension-export',
        createdAt: new Date().toISOString(),
        appVersion: require('./package.json').version,
        entries: exportedManifestEntries,
      };
      if (!exported) {
        await fsp.rm(destination, { recursive: true, force: true }).catch(() => {});
        const error = new Error('没有扩展被导出；全部被拒绝（详见逐项结果）');
        error.rpc = { code: -32093, message: error.message, data: { results } };
        error.results = results;
        throw error;
      }
      await fsp.writeFile(path.join(destination, EXPORT_MANIFEST), JSON.stringify(containerManifest, null, 2), 'utf8');
      return { ok: true, destination, results, exported };
    } catch (error) {
      if (error?.rpc?.code !== -32093) await fsp.rm(destination, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  // Read-only import plan: per-item new/conflict/already-installed verdicts
  // computed against the current catalog. Tampered containers fail their
  // items here before anything is installed.
  async function planImport({ exportDir, manager }) {
    let manifest;
    try { manifest = JSON.parse(await fsp.readFile(path.join(exportDir, EXPORT_MANIFEST), 'utf8')); } catch {
      return { ok: false, items: [{ status: 'invalid', detail: '导出目录缺少有效的 manifest.json' }] };
    }
    if (manifest?.schemaVersion !== 1) return { ok: false, items: [{ status: 'invalid', detail: '导出清单版本不受支持' }] };
    const list = manager ? await manager.handlers['extension/list']() : { entries: [] };
    const items = [];
    for (const entry of manifest.entries || []) {
      const version = entry.versions.find((item) => item.versionId === entry.activeVersionId);
      if (!version) { items.push({ id: entry.id, name: entry.name, status: 'invalid', detail: '导出清单缺少活跃版本' }); continue; }
      // Verify every package byte and recompute compatibility on this Home's
      // platform; the exporting machine's compatibility report is advisory.
      let report;
      try {
        const resolved = await resolveExportedPackage({ exportDir, entryId: entry.id, versionId: entry.activeVersionId });
        if (F.scan(resolved.pluginDir).sha256 !== version.sha256) fail('导出内容与清单摘要不一致', -32004);
        const analyzed = analyzeExtension({ dir: resolved.pluginDir });
        report = { format: analyzed.format, status: analyzed.status, components: analyzed.components };
      } catch (error) {
        items.push({ id: entry.id, name: entry.name, status: 'invalid', detail: String(error?.message || error).slice(0, 200) });
        continue;
      }
      const sameId = list.entries.find((item) => item.id === entry.id);
      const sameName = list.entries.find((item) => item.name === entry.name && item.id !== entry.id);
      if (sameId) {
        const installedVersion = sameId.versions.some((item) => item.sha256 === version.sha256);
        items.push({ id: entry.id, name: entry.name, status: installedVersion ? 'already-installed' : 'conflict-same-id', detail: installedVersion ? '该扩展已安装（相同内容）' : '目标 Home 已存在同一扩展，但内容不同；不会覆盖' });
        continue;
      }
      if (sameName) {
        // Imported packages receive a Home-local id. Recognize an existing
        // verified version by public provenance and content, without treating
        // a same-name package from a different source as the original export.
        const sourceIdentity = (source) => JSON.stringify(source?.type === 'github'
          ? { type: source.type, repository: source.repository, commit: source.commit, subdirectory: source.subdirectory || '' }
          : source?.type === 'local'
            ? { type: source.type, name: source.name }
            : { type: source?.type || 'unknown' });
        const installedVersion = sameName.versions.some((item) => item.sha256 === version.sha256
          && sourceIdentity(item.source) === sourceIdentity(version.source));
        if (installedVersion) {
          items.push({ id: entry.id, name: entry.name, status: 'already-installed', detail: '该扩展已安装（相同内容与来源）' });
          continue;
        }
        items.push({ id: entry.id, name: entry.name, status: 'conflict-same-name', detail: '目标 Home 存在同名但不同来源的扩展；请先处理后重试' });
        continue;
      }
      const missing = report.components.filter((component) => component.status === STATUS.MISSING_DEPENDENCY);
      if (missing.length) {
        items.push({ id: entry.id, name: entry.name, status: 'missing-dependency', report, detail: missing.map((component) => `${component.component}: ${component.details}`).join('; ').slice(0, 1000) });
        continue;
      }
      items.push({ id: entry.id, name: entry.name, versionId: entry.activeVersionId, sha256: version.sha256, status: 'new', report });
    }
    return { ok: items.every((item) => item.status === 'new' || item.status === 'already-installed'), items };
  }

  // Installs the plan's 'new' items one by one through the existing
  // inspect/install validation chain. Each item reports independently; a
  // failure never rolls back or blocks the others, and re-importing an
  // installed item is a reported no-op instead of a duplicate.
  async function performImport({ exportDir, manager, items: requested }) {
    const plan = await planImport({ exportDir, manager });
    const results = [];
    for (const item of plan.items) {
      if (item.status !== 'new') { results.push({ ...item }); continue; }
      if (Array.isArray(requested) && requested.length && !requested.includes(item.id)) continue;
      try {
        const inspected = await manager.handlers['extension/inspect']({ source: { type: 'exported', exportDir, entryId: item.id, versionId: item.versionId } });
        if (inspected.sha256 !== item.sha256) fail('导出内容与清单摘要不一致', -32004);
        const entry = await manager.handlers['extension/install']({ source: { type: 'exported', exportDir, entryId: item.id, versionId: item.versionId }, expectedSha256: item.sha256 });
        results.push({ id: item.id, name: entry.name || item.name, status: 'installed', enabled: entry.enabled });
      } catch (error) {
        results.push({ id: item.id, name: item.name, status: 'failed', detail: String(error?.message || error).slice(0, 300) });
      }
    }
    return { results };
  }

  return { exportExtensions, planImport, performImport };
}

module.exports = { createExtensionExport, resolveExportedPackage, looksLikeSecret, EXPORT_MANIFEST };
