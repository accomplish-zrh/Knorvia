'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRuntimeIntegrity } = require('../runtime-integrity');

const exec = promisify(execFile);
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'write-runtime-integrity.cjs');
const DIST = '.next-test';

async function stageRuntime(t, { omit = [] } = {}) {
  const runtime = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-runtime-'));
  t.after(() => fsp.rm(runtime, { recursive: true, force: true }));
  const payload = Buffer.from('portable engine payload');
  for (const name of ['knorvia.exe', 'knorvia-daemon.exe', 'knorvia-pack-worker.exe', 'knorvia-kernel-appserver.exe']) {
    await fsp.writeFile(path.join(runtime, name), payload);
  }
  await fsp.mkdir(path.join(runtime, 'bin'), { recursive: true });
  for (const name of ['knorvia.exe', 'knorvia-daemon.exe', 'knorvia-pack-worker.exe', 'knorvia-kernel-appserver.exe']) {
    if (omit.includes(`bin/${name}`)) continue;
    await fsp.copyFile(path.join(runtime, name), path.join(runtime, 'bin', name));
    await fsp.unlink(path.join(runtime, name));
  }
  if (!omit.includes('node/node.exe')) {
    await fsp.mkdir(path.join(runtime, 'node'), { recursive: true });
    await fsp.writeFile(path.join(runtime, 'node', 'node.exe'), Buffer.from('node executable'));
  }
  await fsp.mkdir(path.join(runtime, 'licenses', 'ffmpeg'), { recursive: true });
  await fsp.writeFile(path.join(runtime, 'licenses', 'ffmpeg', 'LICENSE.txt'), 'LGPL v3');
  // A minimal staged web build: required-server-files.json plus two chunks.
  await fsp.mkdir(path.join(runtime, 'web', DIST, 'static', 'chunks'), { recursive: true });
  await fsp.writeFile(path.join(runtime, 'web', DIST, 'required-server-files.json'), '{"config":{}}');
  await fsp.writeFile(path.join(runtime, 'web', DIST, 'static', 'chunks', 'main-abc.js'), 'console.log(1)');
  await fsp.writeFile(path.join(runtime, 'web', DIST, 'static', 'chunks', 'page-def.js'), 'console.log(2)');
  await fsp.writeFile(path.join(runtime, 'web', 'renderer.json'), '{"schemaVersion":1}');
  return runtime;
}

const generate = (runtime, project) => exec(process.execPath, [
  SCRIPT, '--runtime', runtime, '--project', project, '--web-dist', DIST, '--app-version', '1.1.0',
]);

test('the original staged package generates a manifest and passes core and web verification', async t => {
  const runtime = await stageRuntime(t);
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-runtime-proj-'));
  t.after(() => fsp.rm(project, { recursive: true, force: true }));
  await fsp.mkdir(path.join(project, 'desktop'), { recursive: true });
  await fsp.writeFile(path.join(project, 'desktop', 'package-lock.json'), '{"lock":true}');
  const integrity = createRuntimeIntegrity({ runtimeRoot: runtime, packaged: true, webDistDir: DIST });
  assert.equal(integrity.manifest(), null, 'before generation there is no manifest (unknown package)');
  assert.equal(integrity.startupGate().allow, true);
  assert.equal(integrity.startupGate().unverified, true, 'unknown manifest keeps the explicit unverified marker');
  await generate(runtime, project);
  const gate = integrity.startupGate();
  assert.equal(gate.allow, true);
  assert.equal(gate.unverified, false);
  assert.equal(gate.core.status, 'ok');
  const report = integrity.verifyAll();
  assert.equal(report.status, 'ok');
  assert.equal(report.web.status, 'ok');
  assert.equal(report.web.files, 2);
  assert.ok(/^[0-9a-f]{64}$/.test(report.source.sourceSha) || report.source.sourceSha === 'unknown');
  assert.equal(report.claim, 'content-consistency');
  assert.match(report.note, /不代表发行者/);
  const manifest = JSON.parse(await fsp.readFile(path.join(runtime, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 2);
  assert.ok(manifest.components['bin/knorvia-daemon.exe']);
  assert.ok(manifest.components['node/node.exe']);
  assert.ok(manifest.lockfiles.desktop, 'lockfile identity recorded');
});

test('a replaced daemon and an old Kernel are detected and block startup with the component named', async t => {
  const runtime = await stageRuntime(t);
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-runtime-proj2-'));
  t.after(() => fsp.rm(project, { recursive: true, force: true }));
  await generate(runtime, project);
  // Swap the daemon for different content ("mixed package").
  await fsp.writeFile(path.join(runtime, 'bin', 'knorvia-daemon.exe'), Buffer.from('old or foreign daemon'));
  // Mix in an older Kernel app-server build.
  await fsp.writeFile(path.join(runtime, 'bin', 'knorvia-kernel-appserver.exe'), Buffer.from('stale kernel build'));
  // Swap node.exe.
  await fsp.writeFile(path.join(runtime, 'node', 'node.exe'), Buffer.from('a different node runtime'));
  const integrity = createRuntimeIntegrity({ runtimeRoot: runtime, packaged: true, webDistDir: DIST });
  const gate = integrity.startupGate();
  assert.equal(gate.allow, false, 'mismatched core components must not start');
  assert.match(gate.reason, /knorvia-daemon\.exe/);
  assert.match(gate.componentPath, /bin[\\/]knorvia-daemon\.exe$/, 'the offending component is located');
  const report = integrity.verifyAll();
  assert.equal(report.status, 'compromised');
  assert.deepEqual(report.core.mismatched.sort(), ['bin/knorvia-daemon.exe', 'bin/knorvia-kernel-appserver.exe', 'node/node.exe'].sort());
});

test('a dropped static chunk and a missing core component are both detected', async t => {
  const runtime = await stageRuntime(t);
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-runtime-proj3-'));
  t.after(() => fsp.rm(project, { recursive: true, force: true }));
  await generate(runtime, project);
  await fsp.unlink(path.join(runtime, 'web', DIST, 'static', 'chunks', 'page-def.js'));
  const integrity = createRuntimeIntegrity({ runtimeRoot: runtime, packaged: true, webDistDir: DIST });
  const report = integrity.verifyAll();
  assert.equal(report.web.status, 'compromised');
  assert.ok(report.web.missing.some((name) => name.endsWith('page-def.js')), 'the dropped chunk is named');
  // Now drop a core binary as well.
  await fsp.unlink(path.join(runtime, 'bin', 'knorvia-pack-worker.exe'));
  const gate = integrity.startupGate();
  assert.equal(gate.allow, false);
  assert.match(gate.reason, /knorvia-pack-worker\.exe/);
});

test('deleting a manifest line together with its chunk is caught by count and digest', async t => {
  const runtime = await stageRuntime(t);
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-runtime-proj7-'));
  t.after(() => fsp.rm(project, { recursive: true, force: true }));
  await generate(runtime, project);
  // Drop one recorded line and delete exactly that chunk: every remaining
  // per-file hash passes, but the declared count and the aggregate digest
  // expose the gap.
  const filesFile = path.join(runtime, 'web-files.jsonl');
  const lines = (await fsp.readFile(filesFile, 'utf8')).split(String.fromCharCode(10)).filter(Boolean);
  const victim = JSON.parse(lines[1]);
  await fsp.writeFile(filesFile, lines[0] + '\n');
  const chunkPath = path.join(runtime, ...victim.p.split('/'));
  await fsp.rm(chunkPath, { force: true });
  const integrity = createRuntimeIntegrity({ runtimeRoot: runtime, packaged: true, webDistDir: DIST });
  const report = integrity.verifyAll();
  assert.equal(report.web.status, 'compromised', 'an empty manifest cannot pass web verification');
  assert.ok(report.web.mismatched.some((name) => name.includes('count mismatch') || name.includes(victim.p)), 'the gap surfaces as a count/digest mismatch, not a silent pass');
});

// X (06:18 review): a required entry recorded with an empty or malformed
// hash must be reported as compromised and block startup — never skipped.
test('required entries with empty or malformed hashes are explicitly compromised', async t => {
  const runtime = await stageRuntime(t);
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-runtime-proj8-'));
  t.after(() => fsp.rm(project, { recursive: true, force: true }));
  await generate(runtime, project);
  const manifestFile = path.join(runtime, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
  // Corrupt two required values: empty string and null.
  manifest.components['bin/knorvia-daemon.exe'] = '';
  manifest.components['node/node.exe'] = null;
  await fsp.writeFile(manifestFile, JSON.stringify(manifest));
  // And delete the daemon binary entirely.
  await fsp.rm(path.join(runtime, 'bin', 'knorvia-daemon.exe'), { force: true });
  const integrity = createRuntimeIntegrity({ runtimeRoot: runtime, packaged: true, webDistDir: DIST });
  const gate = integrity.startupGate();
  assert.equal(gate.allow, false, 'empty/null hash entries block startup');
  const report = integrity.verifyAll();
  assert.equal(report.status, 'compromised');
  assert.ok(report.core.missing.some((name) => name === 'bin/knorvia-daemon.exe'), 'empty-hash entry named as missing');
  assert.ok(report.core.missing.some((name) => name === 'node/node.exe'), 'the null-hash entry is flagged as an invalid manifest record');
});

test('an old package without a manifest reads as unknown, never as trusted', async t => {
  const runtime = await stageRuntime(t);
  const integrity = createRuntimeIntegrity({ runtimeRoot: runtime, packaged: true, webDistDir: DIST });
  const report = integrity.verifyAll();
  assert.equal(report.status, 'unknown');
  assert.equal(report.source.sourceSha, 'unknown');
  assert.equal(report.source.verified, false);
  const gate = integrity.startupGate();
  assert.equal(gate.allow, true, 'compatibility policy keeps old packages runnable');
  assert.equal(gate.unverified, true);
  // A corrupt manifest is also "unknown", not an error.
  await fsp.writeFile(path.join(runtime, 'manifest.json'), '{ truncated');
  assert.equal(integrity.manifest(), null);
});

test('the generator preserves the legacy runtime passthrough', async t => {
  const runtime = await stageRuntime(t);
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-runtime-proj4-'));
  t.after(() => fsp.rm(project, { recursive: true, force: true }));
  await fsp.writeFile(path.join(runtime, 'manifest.json'), JSON.stringify({ runtime: { mediaWorkerPython: 'D:/staged/python/python.exe' } }));
  await generate(runtime, project);
  const manifest = JSON.parse(await fsp.readFile(path.join(runtime, 'manifest.json'), 'utf8'));
  assert.equal(manifest.runtime?.mediaWorkerPython, 'D:/staged/python/python.exe');
});

// X (04:00 review): a staged runtime missing a required core fails manifest
// GENERATION itself; and a manifest missing a required entry cannot pass
// checkCore even when hand-crafted.
test('generation fails when a required core component is absent from the staging', async t => {
  const runtime = await stageRuntime(t, { omit: ['bin/knorvia-daemon.exe'] });
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-runtime-proj5-'));
  t.after(() => fsp.rm(project, { recursive: true, force: true }));
  await assert.rejects(generate(runtime, project), error => /required core components are missing/.test(error.stderr || error.message));
  assert.equal(fs.existsSync(path.join(runtime, 'manifest.json')), false, 'no manifest is written for an incomplete staging');
});

test('a manifest that omits a required core entry is rejected by checkCore', async t => {
  const runtime = await stageRuntime(t);
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-runtime-proj6-'));
  t.after(() => fsp.rm(project, { recursive: true, force: true }));
  await generate(runtime, project);
  // Simulate a trimmed/hand-crafted manifest missing the daemon entry.
  const manifestFile = path.join(runtime, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
  delete manifest.components['bin/knorvia-daemon.exe'];
  await fsp.writeFile(manifestFile, JSON.stringify(manifest));
  const integrity = createRuntimeIntegrity({ runtimeRoot: runtime, packaged: true, webDistDir: DIST });
  const gate = integrity.startupGate();
  assert.equal(gate.allow, false, 'a trimmed manifest cannot silently pass');
  assert.match(gate.reason, /bin\/knorvia-daemon\.exe/, 'the missing component is named in the reason');
  const report = integrity.verifyAll();
  assert.equal(report.status, 'compromised');
  assert.ok(report.core.missing.some((name) => name === 'bin/knorvia-daemon.exe'));
});
