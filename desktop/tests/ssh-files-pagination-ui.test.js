'use strict';
// C03 nightshift acceptance: real Chrome clicks the REAL SshFilesPanel
// (bundled unmodified with esbuild, workbench provider shimmed) against the
// real desktop ssh-session module in front of a real local ssh2 server with
// 1251 files. Verifies in-page continuation: first page 200 entries, each
// click loads the next page, the tail is reachable, the handle is released
// at EOF, and the completion notice renders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const webRoot = path.resolve(__dirname, '..', '..', 'web');
const desktopRoot = path.resolve(__dirname, '..');
const evidenceDir = process.env.KNORVIA_EVIDENCE_DIR || path.join(os.tmpdir(), 'knorvia-ssh-ui-evidence');
const registry = process.env.KNORVIA_PROCESS_REGISTRY || null;
const PORT = 4503;

function freePort(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

test('Chrome pages a 1251-entry remote directory through the real SSH files panel', { timeout: 120_000 }, async t => {
  const { chromium } = require(path.join(webRoot, 'node_modules', 'playwright'));
  const esbuild = require(path.join(webRoot, 'node_modules', 'esbuild'));
  fs.mkdirSync(evidenceDir, { recursive: true });

  // 1. Bundle the unmodified panel plus the harness with the shimmed provider.
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
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>C03 SSH 分页验收</title>',
    `<style>${css}</style></head><body><div id="root"></div>`,
    `<script type="module">${js}</script></body></html>`,
  ].join(''));

  // 2. Start the bridge in front of the real ssh-session module.
  assert.ok(await freePort(PORT), `port ${PORT} must be free before the fixture starts`);
  const bridge = spawn(process.execPath, [
    path.join(desktopRoot, 'tests', 'fixtures', 'ssh-pagination-bridge.cjs'), evidenceDir, String(PORT),
  ], {
    env: {
      ...process.env,
      KNORVIA_SSH_SESSION_PATH: path.join(desktopRoot, 'ssh-session.js'),
      KNORVIA_SSH2_PATH: path.join(desktopRoot, 'node_modules', 'ssh2'),
      TMPDIR: process.env.TMP || os.tmpdir(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (registry) {
    fs.appendFileSync(registry, JSON.stringify({
      pid: bridge.pid, creationDate: new Date().toISOString(), parentProcessId: process.pid,
      entry: path.join(desktopRoot, 'tests', 'fixtures', 'ssh-pagination-bridge.cjs'),
      purpose: 'C03 SSH pagination browser acceptance bridge', stop: 'kill pid (test tears it down in finally)',
    }) + '\n');
  }
  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    bridge.stdout.on('data', chunk => {
      buffer += chunk;
      const match = buffer.match(/BRIDGE_READY (.*)/);
      if (match) resolve(JSON.parse(match[1]));
    });
    bridge.stderr.on('data', chunk => { buffer += ''; console.error(String(chunk)); });
    bridge.on('exit', code => reject(new Error(`bridge exited early: ${code}`)));
  });
  t.after(async () => {
    try { bridge.kill('SIGTERM'); await new Promise(resolve => { bridge.once('exit', resolve); setTimeout(resolve, 3000).unref(); }); } catch { /* already gone */ }
    if (registry) fs.appendFileSync(registry, JSON.stringify({ pid: bridge.pid, stoppedAt: new Date().toISOString() }) + '\n');
  });
  const boot = await ready;

  // 3. Drive the real panel in the installed Chrome.
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
    await page.locator('[data-testid="bootstrap-marker"]').filter({ hasText: `BOOTSTRAP:${boot.entryCount}` }).waitFor({ timeout: 15000 });

    const rows = page.locator('.nw-ssh-file-list button');
    await rows.first().waitFor({ timeout: 15000 });
    assert.equal(await rows.count(), 200, 'first page shows the bounded default of 200 entries');
    assert.equal(await page.getByRole('button', { name: '加载更多条目' }).count(), 1, 'continuation control is visible');

    const growth = [200];
    for (let n = 0; n < 10; n++) {
      const more = page.getByRole('button', { name: '加载更多条目' });
      if (!await more.count()) break;
      await more.click();
      await page.waitForFunction(previous => document.querySelectorAll('.nw-ssh-file-list button').length > previous, growth.at(-1), { timeout: 15000 });
      growth.push(await rows.count());
    }
    assert.equal(await rows.count(), boot.entryCount, `the tail is reachable: ${growth.join(' -> ')}`);
    assert.ok(growth.length >= 6, 'several real continuation pages were clicked');
    assert.ok(await page.getByText(`已显示全部 ${boot.entryCount} 项。`).isVisible(), 'completion notice replaces the load-more control');
    assert.equal(await page.getByRole('button', { name: '加载更多条目' }).count(), 0);

    // EOF released the remote directory handle inside the real session.
    const handles = await (await fetch(`http://127.0.0.1:${boot.port}/handles`)).json();
    assert.equal(handles.openDirCount, 0, 'remote handle is released after the last page');

    await page.screenshot({ path: path.join(evidenceDir, 'ssh-pagination-ui.png'), fullPage: true });
    fs.writeFileSync(path.join(evidenceDir, 'ssh-pagination-ui-result.json'), JSON.stringify({
      mode: 'real Chrome + real SshFilesPanel + real desktop ssh-session module + real local ssh2 server; workbench provider shimmed',
      sessionId: boot.sessionId, entryCount: boot.entryCount, pageGrowth: growth,
      openDirCountAfterEof: handles.openDirCount, pageErrors,
    }, null, 2));
    assert.deepEqual(pageErrors, [], 'no page errors');
  } finally {
    await context.close();
    await browser.close();
  }
});
