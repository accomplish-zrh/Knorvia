'use strict';

// Pet package validation, import and export (B18/B22). Layouts follow the
// official hatch-pet contract (schemaVersion 1: 8 columns × 9 rows, 192×208
// cells, 1536×1872 atlas) and the community v2 layout (8×11); unknown schema
// versions are rejected with a clear reason instead of being force-fitted.
// Atlas validation decodes the full image and checks the format contract;
// no third-party material ships with this module.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const P = require('./studio-providers');
const ATLAS = require('./pet-atlas');

const LAYOUTS = {
  1: { columns: 8, rows: 9, cellWidth: 192, cellHeight: 208, atlasWidth: 1536, atlasHeight: 1872 },
  2: { columns: 8, rows: 11, cellWidth: 192, cellHeight: 208, atlasWidth: 1536, atlasHeight: 2288 },
};
const MAX_ATLAS_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_LICENSE_BYTES = 256 * 1024;
// Official v1 manifests carry only these keys; everything the runtime needs
// beyond them is derived from the layout, never invented per package.
const V1_KEYS = ['schemaVersion', 'id', 'displayName', 'description', 'spritesheetPath'];
const fail = (message, reason) => { const e = new Error(message); e.rpc = { code: -32602, message, ...(reason ? { reason } : {}) }; if (reason) e.reason = reason; throw e; };
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function pngSize(file) {
  const { width, height } = ATLAS.pngInfo(fs.readFileSync(file)); return { width, height };
}
const layoutFor = schemaVersion => LAYOUTS[schemaVersion] ?? fail(`不支持的精灵图版本 ${schemaVersion}；支持 1（官方 8×9）和 2（社区 8×11）`, 'unsupported-pet-version');

// Validates a package directory: manifest shape, path safety, atlas layout.
// Returns the normalized manifest plus content hashes for provenance.
function validatePackage(dir) {
  let stat; try { stat = fs.statSync(dir); } catch { fail('找不到宠物包目录', 'invalid-pet-package'); }
  if (!stat.isDirectory()) fail('宠物包路径不是目录', 'invalid-pet-package');
  dir = fs.realpathSync(dir);
  const manifestFile = path.join(dir, fs.existsSync(path.join(dir, 'pet.json')) ? 'pet.json' : 'manifest.json');
  let manifestStat;
  try { manifestStat = fs.statSync(manifestFile); } catch { fail('宠物清单缺失', 'invalid-pet-package'); }
  if (!manifestStat.isFile() || !fs.realpathSync(manifestFile).startsWith(dir + path.sep)) fail('宠物清单必须是包内普通文件', 'invalid-pet-package');
  if (manifestStat.size > MAX_MANIFEST_BYTES) fail('宠物清单超出 32 KB 上限', 'invalid-pet-package');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { fail('manifest.json 缺失或无法解析', 'invalid-pet-package'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('manifest.json 内容无效', 'invalid-pet-package');
  if (raw.schemaVersion === undefined) {
    // Official v1 manifests predate schemaVersion; they are exactly the v1
    // layout and are normalized with the explicit adapter, never rewritten
    // inside the user's source folder.
      raw = { schemaVersion: raw.spriteVersion ?? 1, ...raw };
  }
  if (typeof raw.schemaVersion !== 'number' || !LAYOUTS[raw.schemaVersion]) fail(`不支持的精灵图版本 ${raw.schemaVersion}`, 'unsupported-pet-version');
  const layout = LAYOUTS[raw.schemaVersion];
  const manifest = { schemaVersion: raw.schemaVersion, id: P.id(raw.id), displayName: P.text(raw.displayName, 80), description: P.text(raw.description ?? '', 300), spritesheetPath: raw.spritesheetPath };
  if (!manifest.displayName) fail('宠物包缺少 displayName', 'invalid-pet-package');
  if (typeof manifest.spritesheetPath !== 'string' || !manifest.spritesheetPath) fail('宠物包缺少 spritesheetPath', 'invalid-pet-package');
  const sheet = path.resolve(dir, manifest.spritesheetPath);
  const within = sheet === path.resolve(dir) || sheet.startsWith(path.resolve(dir) + path.sep);
  if (!within) fail('spritesheetPath 必须位于宠物包目录内', 'invalid-pet-package');
  if (path.basename(sheet) !== manifest.spritesheetPath) fail('spritesheetPath 必须是包内相对文件名', 'invalid-pet-package');
  let sheetStat; try { sheetStat = fs.statSync(sheet); } catch { fail('精灵图文件缺失', 'invalid-pet-package'); }
  if (!fs.realpathSync(sheet).startsWith(dir + path.sep) || !fs.realpathSync(manifestFile).startsWith(dir + path.sep)) fail('宠物包文件不能链接到目录外', 'invalid-pet-package');
  if (!sheetStat.isFile() || sheetStat.size === 0) fail('精灵图文件为空', 'invalid-pet-package');
  if (sheetStat.size > MAX_ATLAS_BYTES) fail('精灵图超出 8 MB 上限', 'invalid-pet-package');
  const size = ATLAS.readImage(sheet);
  if (size.width !== layout.atlasWidth || size.height !== layout.atlasHeight) {
    fail(`精灵图尺寸 ${size.width}x${size.height} 不符合 schemaVersion ${raw.schemaVersion} 的 ${layout.atlasWidth}x${layout.atlasHeight}`, 'invalid-pet-package');
  }
  const atlasSha256 = sha256(sheet);
  if (raw.atlasSha256 && raw.atlasSha256 !== atlasSha256) fail('精灵图哈希与清单不一致', 'invalid-pet-package');
  return { manifest, layout, atlasSha256, manifestSha256: sha256(manifestFile), dir, qa: ATLAS.inspectAtlas(size, layout) };
}

// Export = a reviewed copy: manifest (normalized), atlas, optional license.
// Only package material travels; user photos and credentials never do.
function exportPackage({ sourceDir, targetDir }) {
  const validated = validatePackage(sourceDir);
  const license = path.join(validated.dir, 'LICENSE.txt');
  if (fs.existsSync(license)) {
    const stat = fs.statSync(license);
    if (!stat.isFile() || !fs.realpathSync(license).startsWith(validated.dir + path.sep)) fail('许可文件必须位于宠物包目录内', 'invalid-pet-package');
    if (stat.size > MAX_LICENSE_BYTES) fail('许可文件超出 256 KB 上限', 'invalid-pet-package');
  }
  if (fs.existsSync(targetDir)) fail('导出目录已存在，请选择新目录');
  fs.mkdirSync(targetDir, { recursive: true });
  const manifest = { ...validated.manifest, atlasSha256: validated.atlasSha256 };
  P.atomic(path.join(targetDir, 'manifest.json'), manifest);
  P.atomic(path.join(targetDir, 'pet.json'), manifest);
  fs.copyFileSync(path.join(validated.dir, validated.manifest.spritesheetPath), path.join(targetDir, validated.manifest.spritesheetPath));
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(targetDir, 'LICENSE.txt'));
  const revalidated = validatePackage(targetDir);
  if (revalidated.atlasSha256 !== validated.atlasSha256) fail('导出校验失败：精灵图哈希不一致', 'invalid-pet-package');
  return { manifest, atlasSha256: validated.atlasSha256, exportedTo: targetDir };
}

module.exports = { validatePackage, exportPackage, LAYOUTS, pngSize };
