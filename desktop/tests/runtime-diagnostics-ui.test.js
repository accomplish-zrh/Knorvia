'use strict';
// C05 nightshift acceptance: real Chrome renders the REAL RuntimeDiagnosticsPanel
// (bundled unmodified, workbench provider shimmed), connects through the real
// one-time-token WebSocket to the REAL loopback gateway (real daemon), then
// generates, copies and downloads the local diagnostics report without any
// network destination and with redaction self-check passing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const webRoot = path.resolve(__dirname, '..', '..', 'web');
const desktopRoot = path.resolve(__dirname, '..');
const evidenceDir = process.env.KNORVIA_EVIDENCE_DIR || path.join(os.tmpdir(), 'knorvia-diag-ui-evidence');
const registry = process.env.KNORVIA_PROCESS_REGISTRY || null;
const PORT = 4504;

function freePort(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

test('Chrome generates, copies and downloads a redacted local diagnostics report', { timeout: 180_000 }, async t => {
  const { chromium } = require(path.join(webRoot, 'node_modules', 'playwright'));
  const esbuild = require(path.join(webRoot, 'node_modules', 'esbuild'));
  fs.mkdirSync(evidenceDir, { recursive: true });

  const bundleFile = path.join(evidenceDir, 'diagnostics-harness-bundle.js');
  const providerShimPlugin = {
    name: 'diagnostics-ui-provider-shim',
    setup(build) {
      build.onResolve({ filter: /^\.\/NativeWorkbenchProvider$/ }, () => ({
        path: path.join(desktopRoot, 'tests', 'fixtures', 'ssh-ui-provider-shim.tsx'),
      }));
    },
  };
  await esbuild.build({
    entryPoints: [path.join(desktopRoot, 'tests', 'fixtures', 'diagnostics-ui-harness.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [providerShimPlugin],
    loader: { '.css': 'empty' },
    nodePaths: [path.join(webRoot, 'node_modules')],
    outfile: bundleFile,
    logLevel: 'silent',
  });
  const css = fs.readFileSync(path.join(webRoot, 'components', 'native', 'runtime-diagnostics.css'), 'utf8');
  const js = fs.readFileSync(bundleFile, 'utf8').replace(/<\/script>/gi, '<\\/script>');
  fs.writeFileSync(path.join(evidenceDir, 'harness.html'), [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>C05 运行诊断验收</title>',
    `<style>${css}</style></head><body><div id="root"></div>`,
    `<script type="module">${js}</script></body></html>`,
  ].join(''));

  assert.ok(await freePort(PORT), `port ${PORT} must be free before the fixture starts`);
  const bridge = spawn(process.execPath, [
    path.join(desktopRoot, 'tests', 'fixtures', 'runtime-diagnostics-bridge.cjs'), evidenceDir, String(PORT),
  ], {
    env: {
      ...process.env,
      KNORVIA_DAEMON_BIN: process.env.KNORVIA_DAEMON_BIN || 'D:\\tools\\knorvia-kernel\\knorvia-rs\\target\\debug\\knorvia-daemon.exe',
      KNORVIA_KERNEL_BIN: process.env.KNORVIA_KERNEL_BIN || 'D:\\tools\\knorvia-kernel\\codex-rs\\target\\debug\\codex-app-server.exe',
      TMPDIR: process.env.TMP || os.tmpdir(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (registry) {
    fs.appendFileSync(registry, JSON.stringify({
      pid: bridge.pid, creationDate: new Date().toISOString(), parentProcessId: process.pid,
      entry: path.join(desktopRoot, 'tests', 'fixtures', 'runtime-diagnostics-bridge.cjs'),
      purpose: 'C05 diagnostics browser acceptance bridge (real gateway fixture)',
      stop: 'kill pid (test tears it down in finally)',
    }) + '\n');
  }
  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`bridge did not become ready: ${buffer.slice(-400)}`)), 90_000);
    bridge.stdout.on('data', chunk => {
      buffer += chunk;
      const match = buffer.match(/BRIDGE_READY (.*)/);
      if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); }
    });
    bridge.stderr.on('data', chunk => { buffer += chunk; });
    bridge.on('exit', code => { clearTimeout(timer); reject(new Error(`bridge exited early: ${code}`)); });
  });
  t.after(async () => {
    try { bridge.kill('SIGTERM'); await new Promise(resolve => { bridge.once('exit', resolve); setTimeout(resolve, 5000).unref(); }); } catch { /* already gone */ }
    if (registry) fs.appendFileSync(registry, JSON.stringify({ pid: bridge.pid, stoppedAt: new Date().toISOString() }) + '\n');
  });
  const boot = await ready;

  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--no-proxy-server'],
  });
  const context = await browser.newContext({ viewport: { width: 980, height: 1000 }, locale: 'zh-CN' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${boot.port}` });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${boot.port}/`);
    await page.locator('[data-testid="bootstrap-marker"]').filter({ hasText: 'BOOTSTRAP:ready' }).waitFor({ timeout: 30_000 });

    await page.getByRole('button', { name: '生成诊断报告' }).click();
    const pre = page.locator('.nw-diagnostics-report pre');
    await pre.waitFor({ timeout: 30_000 });
    const reportText = await pre.innerText();
    const report = JSON.parse(reportText);
    assert.equal(report.reportVersion, 1);
    assert.equal(report.redaction.environmentIncluded, false);
    assert.equal(report.checks.find(check => check.name === 'redaction-self-check').passed, true);
    assert.ok(report.collectorHealth.find(health => health.name === 'components').status === 'ok');
    assert.ok(report.identity.appVersion, 'identity versions are present');
    const leak = reportText.match(/sk-[A-Za-z0-9_-]{8,}/);
    assert.equal(leak, null, `key-shaped string leaked into the report: ${leak && leak[0]}`);

    // Clipboard export. (Browsers normalize newlines in innerText/clipboard,
    // so compare with line endings normalized.)
    await page.getByRole('button', { name: '复制报告' }).click();
    const clipboard = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
    assert.equal(clipboard, reportText.replace(/\r\n/g, '\n'), 'clipboard export carries the exact report');

    // Local file export (browser fallback download; no network destination).
    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
    await page.getByRole('button', { name: '保存到本地文件' }).click();
    const download = await downloadPromise;
    const downloadFile = path.join(evidenceDir, 'diagnostics-download.json');
    await download.saveAs(downloadFile);
    assert.equal(fs.readFileSync(downloadFile, 'utf8').replace(/\r\n/g, '\n'), reportText.replace(/\r\n/g, '\n'), 'download export carries the exact report');

    await page.screenshot({ path: path.join(evidenceDir, 'diagnostics-ui.png'), fullPage: true });
    fs.writeFileSync(path.join(evidenceDir, 'diagnostics-ui-result.json'), JSON.stringify({
      mode: 'real Chrome + real RuntimeDiagnosticsPanel + real one-time-token WebSocket + real loopback gateway (real daemon); workbench provider shimmed',
      reportVersion: report.reportVersion,
      sizeBytes: reportText.length,
      redactionSelfCheck: report.checks.find(check => check.name === 'redaction-self-check').passed,
      componentHealth: report.collectorHealth,
      pageErrors,
    }, null, 2));
    assert.deepEqual(pageErrors, [], 'no page errors');
  } finally {
    await context.close();
    await browser.close();
  }
});
