'use strict';
// C05 Electron smoke: boots the real Electron shell (no app UI) with an
// explicitly isolated user-data dir, generates a diagnostics report through
// the real module, saves it to a chosen local file, prints one result line
// and exits. Readiness marker: DIAG_SMOKE {...}
const path = require('node:path');

const { app } = require('electron');

const out = process.env.KNORVIA_DIAG_SMOKE_OUT;

app.whenReady().then(async () => {
  try {
    if (!out) throw new Error('KNORVIA_DIAG_SMOKE_OUT is required');
    const { createRuntimeDiagnostics, saveReportTo, knownEnvSecretValues } = require(path.join(__dirname, '..', '..', 'runtime-diagnostics'));
    const manager = createRuntimeDiagnostics({
      identity: { appVersion: 'electron-smoke', channel: 'smoke', electron: process.versions.electron },
      pathRoots: [
        { label: '[userData]', path: app.getPath('userData') },
        { label: '[temp]', path: require('os').tmpdir() },
      ],
      secretValues: knownEnvSecretValues(process.env),
      collectors: {
        components: async () => [{ name: 'electron-shell', status: 'ready', detail: 'smoke shell is up' }],
        ports: async () => [],
        recentErrors: async () => [{ at: new Date().toISOString(), scope: 'smoke', message: `synthetic failure with ${process.env.KNORVIA_FIXTURE_SECRET_VALUE}`, code: -32000 }],
      },
      secretsProbe: [process.env.KNORVIA_FIXTURE_SECRET_VALUE].filter(Boolean),
    });
    const collected = await manager.collect();
    const saved = saveReportTo({ text: collected.text, destination: out });
    process.stdout.write(`DIAG_SMOKE ${JSON.stringify({
      ok: saved.saved === true,
      userData: app.getPath('userData'),
      electron: process.versions.electron,
      sizeBytes: collected.sizeBytes,
      selfCheck: collected.report.checks.find(check => check.name === 'redaction-self-check').passed,
    })}\n`);
    app.exit(0);
  } catch (error) {
    process.stdout.write(`DIAG_SMOKE ${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
    app.exit(1);
  }
});
