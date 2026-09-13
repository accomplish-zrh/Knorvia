'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Packaging input closure check (REVIEW 0152 item 2): every relative
// production require reachable from the desktop root must be listed in
// desktop/package.json build.files, and the modules named by the reviewer
// must be present in the list. Files that belong to another lane and do not
// exist in THIS worktree are checked by name only — their existence is
// proven in the integration tree, not fabricated here.

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const filesList = pkg.build.files.filter((entry) => typeof entry === 'string');
const listed = new Set(filesList);

function listDesktopModules() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name);
}

function relativeRequires(fileName) {
  const text = fs.readFileSync(path.join(ROOT, fileName), 'utf8');
  const out = [];
  for (const match of text.matchAll(/require\(["'](\.\/[^"']+)["']\)/g)) {
    const target = match[1].replace(/^\.\//, '');
    if (!target.endsWith('.js')) out.push(`${target}.js`);
    else out.push(target);
  }
  return out;
}

test('build.files lists the reviewer-named required modules', () => {
  for (const name of [
    'home-backup.js', 'github-extension-source.js', 'preview-revoke.js',
    'media-operations.js', 'ssh-forward.js', 'ssh-jump.js', 'ssh-transfer.js',
    'terminal-profiles.js', 'workspace-media-preview.js',
  ]) {
    assert.ok(listed.has(name), `${name} must be in build.files`);
  }
});

test('every local production require of an existing desktop module is packaged', () => {
  const gaps = [];
  for (const fileName of listDesktopModules()) {
    // Test files are not packaged; everything else in the desktop root is a
    // production module candidate.
    if (listed.has(fileName)) {
      for (const dependency of relativeRequires(fileName)) {
        if (!listed.has(dependency) && fs.existsSync(path.join(ROOT, dependency))) {
          gaps.push(`${fileName} -> ${dependency}`);
        }
      }
    }
  }
  assert.deepEqual(gaps, [], `modules required by packaged files but missing from build.files:\n${gaps.join('\n')}`);
});

test('the packaged entry points and their transitive C-owned modules all exist in this tree', () => {
  for (const entry of ['main.js', 'preload.js', 'frontend-host.js']) {
    assert.ok(listed.has(entry), `${entry} packaged`);
    assert.ok(fs.existsSync(path.join(ROOT, entry)));
  }
  for (const name of ['home-backup.js', 'github-extension-source.js', 'preview-revoke.js', 'frontend-supervisor.js', 'open-thread-bridge.js', 'workspace-migration.js', 'shutdown-controller.js', 'update-download.js', 'runtime-integrity.js', 'power-policy.js', 'extension-export.js', 'extension-convert.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, name)), `${name} exists in this worktree`);
    assert.ok(listed.has(name), `${name} listed`);
  }
});
