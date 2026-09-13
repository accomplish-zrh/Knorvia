'use strict';
// CODEX-0030-C-FIX items 4+5+6 (UI side): the panel must surface truncation,
// answer expiry without ever claiming "all shown", and discard superseded
// page responses after a folder switch. Real Chrome + real SshFilesPanel +
// real desktop ssh-session module against the local ssh2 fixture server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const webRoot = path.resolve(__dirname, '..', '..', 'web');
const desktopRoot = path.resolve(__dirname, '..');
const evidenceDir = process.env.KNORVIA_EVIDENCE_DIR || path.join(os.tmpdir(), 'knorvia-ssh-fix-ui-evidence');
const PORT = 4506;

function freePort(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function buildHarness() {
  const esbuild = require(path.join(webRoot, 'node_modules', 'esbuild'));
  fs.mkdirSync(evidenceDir, { recursive: true });
  const bundleFile = path.join(evidenceDir, 'ssh-harness-bundle.js');
  const providerShimPlugin = {
    name: 'ssh-ui-provider-shim',
    setup(build) {
      build.onResolve({ filter: /^\.\/NativeWorkbenchProvider$/ }, () => ({
        path: path.join(desktopRoot, 'tests', 'fixtures', 'ssh-ui-provider-shim.tsx'),
      }));
    },
  };
  await esbuild.build({
    entryPoints: [path.join(desktopRoot, 'tests', 'fixtures', 'ssh-ui-harness.tsx')],
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
  const css = fs.readFileSync(path.join(webRoot, 'components', 'native', 'ssh.css'), 'utf8');
  const js = fs.readFileSync(bundleFile, 'utf8').replace(/<\/script>/gi, '<\\/script>');
  fs.writeFileSync(path.join(evidenceDir, 'harness.html'), [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>C03 修复验收</title>',
    `<style>${css}</style></head><body><div id="root"></div>`,
    `<script type="module">${js}</script></body></html>`,
  ].join(''));
}

async function startBridge(t, extraEnv = {}) {
  assert.ok(await freePort(PORT), `port ${PORT} must be free before the fixture starts`);
  const bridge = spawn(process.execPath, [
    path.join(desktopRoot, 'tests', 'fixtures', 'ssh-pagination-bridge.cjs'), evidenceDir, String(PORT),
  ], {
    env: {
      ...process.env,
      KNORVIA_SSH_SESSION_PATH: path.join(desktopRoot, 'ssh-session.js'),
      KNORVIA_SSH2_PATH: path.join(desktopRoot, 'node_modules', 'ssh2'),
      TMPDIR: process.env.TMP || os.tmpdir(),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`bridge not ready: ${buffer.slice(-300)}`)), 60_000);
    bridge.stdout.on('data', chunk => {
      buffer += chunk;
      const match = buffer.match(/BRIDGE_READY (.*)/);
      if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); }
    });
    bridge.stderr.on('data', chunk => { buffer += chunk; });
    bridge.on('exit', code => { clearTimeout(timer); reject(new Error(`bridge exited early: ${code}`)); });
  });
  t.after(async () => {
    try { bridge.kill('SIGTERM'); await new Promise(resolve => { bridge.once('exit', resolve); setTimeout(resolve, 5000).unref(); }); } catch { /* gone */ }
  });
  return ready;
}

async function withPanel(t, extraEnv, scenario) {
  const { chromium } = require(path.join(webRoot, 'node_modules', 'playwright'));
  await buildHarness();
  const boot = await startBridge(t, extraEnv);
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--no-proxy-server'],
  });
  const context = await browser.newContext({ viewport: { width: 900, height: 900 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${boot.port}/`);
    await page.locator('[data-testid="bootstrap-marker"]').filter({ hasText: /BOOTSTRAP:\d+/ }).waitFor({ timeout: 30_000 });
    await page.locator('.nw-ssh-file-list button').first().waitFor({ timeout: 15_000 });
    await scenario(page);
    assert.deepEqual(pageErrors, [], 'no page errors');
  } finally {
    await context.close();
    await browser.close();
  }
}

const listRows = page => page.locator('.nw-ssh-file-list button');

test('an oversized single batch ends in the incomplete notice, never "all shown"', { timeout: 180_000 }, async t => {
  await withPanel(t, { KNORVIA_C03_FILES: '50' }, async page => {
    await page.getByRole('button', { name: 'huge', exact: true }).click();
    // Wait for the huge listing to actually load before paging.
    await page.waitForFunction(prev => document.querySelectorAll('.nw-ssh-file-list button').length > prev, 53, { timeout: 20_000 });
    let clicks = 0;
    for (;;) {
      const more = page.getByRole('button', { name: '加载更多条目' });
      if (!await more.count()) break;
      const before = await listRows(page).count();
      await more.click();
      await page.waitForFunction(prev => document.querySelectorAll('.nw-ssh-file-list button').length > prev, before, { timeout: 20_000 });
      clicks += 1;
      assert.ok(clicks < 40, 'paging must terminate');
    }
    const total = await listRows(page).count();
    assert.equal(total, 5000, `retained entries page fully (${clicks} clicks), got ${total}`);
    assert.ok(await page.getByText('远程目录条目超出单批保留上限，此列表不完整。').isVisible(), 'the incomplete notice replaces any completion claim');
    assert.equal(await page.getByText(/已显示全部/).count(), 0, '"all shown" must never appear for a truncated listing');
    await page.screenshot({ path: path.join(evidenceDir, 'ssh-pagination-truncated.png'), fullPage: true });
  });
});

test('an expired cursor mid-paging shows the error and never a completion notice', { timeout: 180_000 }, async t => {
  await withPanel(t, { KNORVIA_C03_FILES: '500', KNORVIA_C03_TTL_MS: '600' }, async page => {
    // First page loads fine; wait past the TTL so the cursor expires.
    await delay(900);
    await page.getByRole('button', { name: '加载更多条目' }).click();
    const alert = page.locator('.nw-inline-error[role="alert"]');
    await alert.waitFor({ timeout: 15_000 });
    assert.match(await alert.innerText(), /expired/i, 'the expiry error is shown');
    assert.equal(await page.getByText(/已显示全部/).count(), 0, 'an expired page must not be reported as complete');
    assert.equal(await page.getByRole('button', { name: '加载更多条目' }).count(), 1, 'the continuation control stays for a refresh');
    // Refresh recovers with a fresh listing.
    await page.getByRole('button', { name: '刷新文件' }).click();
    await page.waitForFunction(() => !document.querySelector('.nw-inline-error[role="alert"]'), null, { timeout: 15_000 });
    assert.ok(await listRows(page).count() > 0, 'a fresh listing works after expiry');
  });
});

test('a superseded page response is discarded after a folder switch and never merged', { timeout: 180_000 }, async t => {
  await withPanel(t, { KNORVIA_C03_FILES: '250', KNORVIA_C03_CURSOR_DELAY_MS: '1500' }, async page => {
    // Page 1 of the root arrives fast and includes the aaa-sub folder.
    const subButton = page.getByRole('button', { name: 'aaa-sub', exact: true });
    await subButton.waitFor({ timeout: 15_000 });
    // Kick off the slow root continuation, then switch folders immediately.
    await page.getByRole('button', { name: '加载更多条目' }).click();
    await subButton.click();
    await page.waitForFunction(prev => document.querySelectorAll('.nw-ssh-file-list button').length === prev, 3, { timeout: 15_000 });
    // Let the delayed stale response land; it must be discarded, not merged.
    await delay(2200);
    assert.equal(await listRows(page).count(), 3, 'only the new folder entries remain after the stale page lands');
    assert.ok(await page.getByText('已显示全部 3 项。').isVisible(), 'the new folder completes normally');
    const names = await page.locator('.nw-ssh-file-list button span').allInnerTexts();
    assert.ok(names.every(name => name.startsWith('sub-')), `no stale root entries leaked: ${names.join(', ')}`);
  });
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
