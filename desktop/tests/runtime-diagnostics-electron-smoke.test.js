'use strict';
// C05: isolated Electron export-path smoke. Boots the real Electron binary
// with an explicit --user-data-dir under this night's runtime root, verifies
// app.getPath('userData') matches it, and exercises the real diagnostics
// collect + local file save path. Skipped honestly when the Electron binary
// is unavailable; a hang is treated as an environment limitation (recorded).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const desktopRoot = path.resolve(__dirname, '..');
const electronCandidates = [
  process.env.KNORVIA_ELECTRON_BIN,
  'D:\\tools\\Knorvia\\desktop\\node_modules\\electron\\dist\\electron.exe',
].filter(Boolean);
const electronBin = electronCandidates.find(candidate => fs.existsSync(candidate));

test('isolated Electron shell exports a redacted diagnostics report through the real save path', { timeout: 120_000, skip: !electronBin && `Electron binary not found (tried: ${electronCandidates.join(', ')})` }, async () => {
  if (!electronBin) return;
  const evidenceDir = process.env.KNORVIA_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-diag-electron-'));
  fs.mkdirSync(evidenceDir, { recursive: true });
  const userData = process.env.KNORVIA_ELECTRON_USER_DATA || path.join(evidenceDir, 'electron-user-data');
  fs.mkdirSync(userData, { recursive: true });
  const destination = path.join(evidenceDir, 'electron-diagnostics-smoke.json');
  const secretValue = 'sk-electron-smoke-secret-31337';
  const child = spawn(electronBin, [
    '--user-data-dir=' + userData,
    '--no-sandbox',
    path.join(desktopRoot, 'tests', 'fixtures', 'electron-diagnostics-smoke.cjs'),
  ], {
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '0',
      KNORVIA_DIAG_SMOKE_OUT: destination,
      KNORVIA_FIXTURE_SECRET_VALUE: secretValue,
      TMPDIR: process.env.TMP || os.tmpdir(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  child.stdout.on('data', chunk => { buffer += chunk; });
  child.stderr.on('data', chunk => { buffer += chunk; });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Electron smoke hung past 90s; tail: ${buffer.slice(-400)}`)), 90_000);
    child.on('exit', () => {
      clearTimeout(timer);
      const match = buffer.match(/DIAG_SMOKE (.*)/);
      if (!match) reject(new Error(`no DIAG_SMOKE line; tail: ${buffer.slice(-400)}`));
      else resolve(JSON.parse(match[1]));
    });
  });
  assert.equal(result.ok, true, `smoke failed: ${result.error || 'unknown'}`);
  // The isolated user-data dir is verified INSIDE the shell, not just APPDATA.
  assert.equal(path.resolve(result.userData).toLowerCase(), path.resolve(userData).toLowerCase());
  assert.equal(result.selfCheck, true, 'redaction self-check passes inside Electron');
  const saved = fs.readFileSync(destination, 'utf8');
  assert.ok(saved.includes('"reportVersion": 1'));
  assert.equal(saved.includes(secretValue), false, 'the injected synthetic secret never reaches the saved report');
});
