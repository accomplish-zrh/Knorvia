#!/usr/bin/env node
'use strict';

// Writes runtime manifest.json (schemaVersion 2) next to the staged portable
// runtime. Identity comes from the ACTUAL frozen build inputs: the git HEAD
// and dirty state of the worktree being packaged, the staged native
// binaries, node.exe, the web build's required-server-files.json plus every
// static chunk, the media/ffmpeg payloads and the desktop lockfile. The
// claim is content consistency only — no signing keys are involved, so this
// is never a statement about the publisher.
//
// Usage:
//   node scripts/write-runtime-integrity.cjs --runtime <staged-runtime-dir>
//        [--project <project-root>] [--web-dist <dist dir name>] [--app-version <semver>]

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function walkFiles(root, prefix = '', out = []) {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, relativePath, out);
    else if (entry.isFile()) out.push({ relativePath, full });
  }
  return out;
}

const runtime = path.resolve(arg('runtime', ''));
if (!runtime || !fs.existsSync(runtime)) {
  console.error('runtime directory is required');
  process.exit(1);
}
const projectRoot = path.resolve(arg('project', path.join(__dirname, '..')));
const webDistDir = arg('web-dist', '.next-knorvia');
const appVersion = arg('app-version', '');

// Source identity: the actual worktree state being packaged, never a guess.
let source = { commit: 'unknown', dirty: -1 };
try {
  source.commit = execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch { /* not a git checkout: keep unknown */ }
try {
  const porcelain = execFileSync('git', ['-C', projectRoot, 'status', '--porcelain'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }).toString();
  source.dirty = porcelain.split('\n').filter((line) => line.trim()).length;
} catch { /* keep -1 */ }

const components = {};
const addFile = (relativePath) => {
  const full = path.join(runtime, ...relativePath.split('/'));
  if (!fs.existsSync(full)) return false;
  components[relativePath] = sha256File(full);
  return true;
};

// X (04:00 review): the required core closure must be present at GENERATION
// time. A staged runtime missing one of these cannot produce a manifest that
// masquerades as complete — generation fails instead.
const REQUIRED_CORE = [
  'bin/knorvia.exe', 'bin/knorvia-daemon.exe', 'bin/knorvia-pack-worker.exe', 'bin/knorvia-kernel-appserver.exe',
  'node/node.exe',
];
const missingCore = REQUIRED_CORE.filter((relativePath) => !fs.existsSync(path.join(runtime, ...relativePath.split('/'))));
if (missingCore.length) {
  console.error(`runtime manifest generation failed: required core components are missing from the staged runtime: ${missingCore.join(', ')}`);
  process.exit(1);
}
for (const binary of REQUIRED_CORE) addFile(binary);
for (const entry of walkFiles(path.join(runtime, 'bin'))) {
  if (entry.relativePath.endsWith('.dll')) components[`bin/${path.basename(entry.relativePath)}`] = sha256File(entry.full);
}
components['licenses/ffmpeg/LICENSE.txt'] = fs.existsSync(path.join(runtime, 'licenses', 'ffmpeg', 'LICENSE.txt'))
  ? sha256File(path.join(runtime, 'licenses', 'ffmpeg', 'LICENSE.txt')) : '';

const webRoot = path.join(runtime, 'web');
const serverFiles = path.join(webRoot, webDistDir, 'required-server-files.json');
const web = { distDir: webDistDir, serverFilesSha256: '', staticFiles: 0, staticHash: '' };
if (fs.existsSync(serverFiles)) {
  web.serverFilesSha256 = sha256File(serverFiles);
  const staticFiles = walkFiles(path.join(webRoot, webDistDir, 'static'));
  const lines = [];
  const aggregate = createHash('sha256');
  for (const file of staticFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'))) {
    const digest = sha256File(file.full);
    lines.push(JSON.stringify({ p: `web/${webDistDir}/static/${file.relativePath}`, h: digest }));
    aggregate.update(digest);
  }
  fs.writeFileSync(path.join(runtime, 'web-files.jsonl'), lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  web.staticFiles = staticFiles.length;
  web.staticHash = aggregate.digest('hex');
}

const lockfiles = {};
for (const [name, file] of Object.entries({
  desktop: path.join(projectRoot, 'desktop', 'package-lock.json'),
  web: path.join(projectRoot, 'web', 'package-lock.json'),
})) {
  lockfiles[name] = fs.existsSync(file) ? sha256File(file) : '';
}

// Preserve the legacy `runtime` passthrough (e.g. runtime.mediaWorkerPython)
// if an earlier step recorded it on a previous manifest.
let legacyRuntime;
try { legacyRuntime = JSON.parse(fs.readFileSync(path.join(runtime, 'manifest.json'), 'utf8'))?.runtime; } catch { legacyRuntime = undefined; }

const manifest = {
  schemaVersion: 2,
  product: 'Knorvia',
  ...(appVersion ? { appVersion } : {}),
  createdAt: new Date().toISOString(),
  // Content consistency only: without signing keys this manifest cannot
  // authenticate a publisher, and it must never claim to.
  claim: 'content-consistency',
  source,
  ...(legacyRuntime && typeof legacyRuntime === 'object' ? { runtime: legacyRuntime } : {}),
  lockfiles,
  components,
  web,
};
fs.writeFileSync(path.join(runtime, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
process.stdout.write(`runtime manifest written: ${path.join(runtime, 'manifest.json')}\n`);
