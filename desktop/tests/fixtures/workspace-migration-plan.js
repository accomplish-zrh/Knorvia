'use strict';

// A29 design fixture only. No production caller and no migration/apply operation.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validAppearance } = require('../../window-appearance');
const { BUILTINS } = require('../../wallpaper');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const imageNames = ['custom.jpeg', 'custom.jpg', 'custom.png', 'custom.webp'];

function noLinks(absolute) {
  const resolved = path.resolve(absolute), root = path.parse(resolved).root;
  let current = root;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw Error('Migration refuses symbolic links or junctions');
  }
  return fs.realpathSync(resolved);
}
function readBounded(root, relative, limit) {
  const file = path.join(root, ...relative.split('/'));
  if (!fs.existsSync(file)) return null;
  const actual = noLinks(file), info = fs.statSync(actual);
  if (!info.isFile() || info.size > limit) throw Error(`Invalid migration input: ${relative}`);
  const bytes = fs.readFileSync(actual);
  if (bytes.length > limit) throw Error(`Migration input grew: ${relative}`);
  return bytes;
}
function planPreferencesMigration({ sourceUserData, targetHome }) {
  if (!path.isAbsolute(sourceUserData) || !path.isAbsolute(targetHome)) throw Error('Absolute explicit roots required');
  const source = noLinks(sourceUserData), targetRoot = noLinks(targetHome);
  if (!fs.statSync(source).isDirectory() || !fs.statSync(targetRoot).isDirectory()) throw Error('Existing directories required');
  const destination = path.join(targetRoot, 'preferences-import-v1');
  if (fs.existsSync(destination)) throw Error('Migration destination already exists; preserve it');
  const files = [];
  const add = (relative, original, normalized) => {
    const bytes = normalized === undefined ? original : Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`);
    files.push({ sourceRelativePath: relative, targetRelativePath: relative, sourceSha256: sha256(original),
      sha256: sha256(bytes), size: bytes.length, ...(normalized === undefined ? {} : { json: normalized }) });
  };
  const appearance = readBounded(source, 'window-appearance.json', 32 * 1024);
  if (appearance) {
    const raw = JSON.parse(appearance);
    if (!validAppearance(raw)) throw Error('Invalid appearance preferences; preserve original');
    add('window-appearance.json', appearance, { theme: raw.theme, frost: raw.frost,
      ...(typeof raw.reducedMotion === 'boolean' ? { reducedMotion: raw.reducedMotion } : {}) });
  }
  const wallpaper = readBounded(source, 'settings/wallpaper.json', 32 * 1024);
  if (wallpaper) {
    const raw = JSON.parse(wallpaper), allowed = new Set(['none', 'custom', ...BUILTINS.map(value => value.id)]);
    if (!raw || !allowed.has(raw.id)) throw Error('Invalid wallpaper preferences; preserve original');
    add('settings/wallpaper.json', wallpaper, { id: raw.id });
    if (raw.id === 'custom') {
      // Ambiguous custom files must be resolved explicitly instead of silently selecting one.
      const matches = imageNames.map(name => `settings/wallpapers/${name}`)
        .filter(relative => fs.existsSync(path.join(source, ...relative.split('/'))));
      if (matches.length !== 1) throw Error('Custom wallpaper is missing or ambiguous');
      const bytes = readBounded(source, matches[0], 8 * 1024 * 1024);
      if (!bytes?.length) throw Error('Custom wallpaper is empty');
      add(matches[0], bytes);
    }
  }
  return { schemaVersion: 1, mode: 'design-fixture-only', source, destination, files,
    excluded: ['credentials', 'provider-config', 'SSH secrets', 'Local Storage', 'IndexedDB', 'Cookies', 'Cache',
      'Crashpad', 'logs', 'update-state', 'product Home', 'project files'],
    requires: ['application pause', 'image decoding validation', 'typed renderer preference export',
      'source revalidation before commit', 'atomic new-directory publish', 'source retention', 'restart verification'] };
}
function verifyPlanSources(plan) {
  if (fs.existsSync(plan.destination)) throw Error('Migration destination already exists; preserve it');
  for (const entry of plan.files) {
    const bytes = readBounded(plan.source, entry.sourceRelativePath, 8 * 1024 * 1024);
    if (!bytes || sha256(bytes) !== entry.sourceSha256) throw Error(`Migration source changed: ${entry.sourceRelativePath}`);
  }
  return true;
}
module.exports = { planPreferencesMigration, verifyPlanSources, sha256 };
