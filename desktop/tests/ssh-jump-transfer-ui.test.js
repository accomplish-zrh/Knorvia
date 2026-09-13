'use strict';
// C13 + C16 browser acceptance: real Chrome drives the UNMODIFIED
// RemoteWorkspace (host editor form, connect dialog, SSH terminal panel, SSH
// files panel) against the real desktop ssh-session module, which connects
// through a real in-process ssh2 bastion to a real in-process ssh2 target.
// Proven in the actual UI: saving and clearing a host credential, a bastion
// password typed for one connection only, the two per-host fingerprint
// challenges, a 24 MB streaming download with live progress, an individual
// transfer cancel while the session stays usable, and an honest
// "disconnected, incomplete" transfer restarted explicitly on a new session.
// Fixture data only: no real host, no real credential, loopback only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const webRoot = path.resolve(__dirname, '..', '..', 'web');
const desktopRoot = path.resolve(__dirname, '..');
const evidenceDir = process.env.KNORVIA_EVIDENCE_DIR || path.join(os.tmpdir(), 'knorvia-ssh-jump-transfer-ui-evidence');
const registry = process.env.KNORVIA_PROCESS_REGISTRY || null;
const PORT = Number(process.env.KNORVIA_C1316_PORT || 4507);

function freePort(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function settle(predicate, what, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

const rowText = async row => (await row.innerText()).replace(/\s+/g, ' ').trim();

// Samples a transfer row while it runs, so progress is proven from what the
// user actually saw instead of from a final status alone.
async function collectProgress(row, donePattern, timeoutMs) {
  const started = Date.now();
  const samples = [];
  for (;;) {
    const text = await row.innerText();
    const percent = /(\d+)%/.exec(text);
    if (percent) samples.push(Number(percent[1]));
    if (new RegExp(donePattern).test(text)) return samples;
    if (Date.now() - started > timeoutMs) throw new Error(`transfer never reached ${donePattern}; last text: ${text}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

test('Chrome saves bastion credentials, jumps both hops and streams large transfers with cancel and restart', { timeout: 420_000 }, async t => {
  const { chromium } = require(path.join(webRoot, 'node_modules', 'playwright'));
  const esbuild = require(path.join(webRoot, 'node_modules', 'esbuild'));
  fs.mkdirSync(evidenceDir, { recursive: true });

  // 1. Bundle the real RemoteWorkspace with only the workbench provider shimmed.
  const bundleFile = path.join(evidenceDir, 'ssh-remote-bundle.js');
  await esbuild.build({
    entryPoints: [path.join(desktopRoot, 'tests', 'fixtures', 'ssh-remote-harness.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'ssh-ui-provider-shim',
      setup(build) {
        build.onResolve({ filter: /^\.\/NativeWorkbenchProvider$/ }, () => ({ path: path.join(desktopRoot, 'tests', 'fixtures', 'ssh-ui-provider-shim.tsx') }));
      },
    }],
    loader: { '.css': 'empty' },
    nodePaths: [path.join(webRoot, 'node_modules')],
    tsconfig: path.join(webRoot, 'tsconfig.json'),
    outfile: bundleFile,
    logLevel: 'silent',
  });
  const css = fs.readFileSync(path.join(webRoot, 'components', 'native', 'ssh.css'), 'utf8');
  const js = fs.readFileSync(bundleFile, 'utf8').replace(/<\/script>/gi, '<\\/script>');
  fs.writeFileSync(path.join(evidenceDir, 'harness.html'), [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>C13/C16 SSH 跳板与传输验收</title>',
    `<style>${css}</style></head><body><div id="root"></div>`,
    // Some bundled modules read Node's `process` global at import time.
    '<script>window.process={env:{NODE_ENV:"production"},platform:"browser",browser:true,version:"",versions:{}}</script>',
    `<script type="module">${js}</script></body></html>`,
  ].join(''));

  // 2. Start the bridge in front of the real ssh-session module.
  assert.ok(await freePort(PORT), `port ${PORT} must be free before the fixture starts`);
  const bridge = spawn(process.execPath, [path.join(desktopRoot, 'tests', 'fixtures', 'ssh-jump-bridge.cjs'), evidenceDir, String(PORT)], {
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
      entry: path.join(desktopRoot, 'tests', 'fixtures', 'ssh-jump-bridge.cjs'),
      purpose: 'C13/C16 bastion + transfer browser acceptance bridge', stop: 'kill pid (test tears it down in finally)',
    }) + '\n');
  }
  const bridgeLog = [];
  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    bridge.stdout.on('data', chunk => { buffer += String(chunk); const match = buffer.match(/BRIDGE_READY (.*)/); if (match) resolve(JSON.parse(match[1])); });
    bridge.stderr.on('data', chunk => { bridgeLog.push(String(chunk)); });
    bridge.on('exit', code => reject(new Error(`bridge exited early: ${code} ${buffer}`)));
    setTimeout(() => reject(new Error(`bridge never became ready: ${buffer}`)), 30000).unref();
  });
  t.after(async () => {
    try { bridge.kill('SIGTERM'); await new Promise(resolve => { bridge.once('exit', resolve); setTimeout(resolve, 3000).unref(); }); } catch { /* already gone */ }
    if (registry) fs.appendFileSync(registry, JSON.stringify({ pid: bridge.pid, stoppedAt: new Date().toISOString() }) + '\n');
  });
  const announced = await ready;
  const boot = { ...announced, ...await (await fetch(`http://127.0.0.1:${announced.port}/bootstrap`)).json() };
  const state = async () => (await fetch(`http://127.0.0.1:${boot.port}/state`)).json();
  const arm = route => fetch(`http://127.0.0.1:${boot.port}${route}`, { method: 'POST' });
  const storedHosts = async () => {
    const { storeRaw } = await state();
    if (!storeRaw) return [];
    return JSON.parse(storeRaw).hosts.map(host => ({ ...host, decodedSecret: host.secret ? Buffer.from(host.secret, 'base64').toString('utf8') : null }));
  };

  // 3. Drive the real components in the installed Chrome.
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--no-proxy-server'],
  });
  const context = await browser.newContext({ viewport: { width: 1000, height: 1200 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const observations = { pageErrors };
  try {
    await page.goto(`http://127.0.0.1:${boot.port}/`);
    await page.getByTestId('harness-ready').waitFor({ timeout: 15000 });
    const dialog = () => page.getByRole('dialog');

    // 3a. Save the bastion through the real form, including its password.
    await page.getByRole('button', { name: '添加主机', exact: true }).click();
    await dialog().getByLabel('名称', { exact: true }).fill('Bastion');
    await dialog().getByLabel('服务器地址', { exact: true }).fill('127.0.0.1');
    await dialog().getByLabel('端口', { exact: true }).fill(String(boot.bastionPort));
    await dialog().getByLabel('用户名', { exact: true }).fill(boot.bastionUser);
    await dialog().getByLabel('登录方式').selectOption('password');
    await dialog().getByLabel('密码', { exact: true }).fill(boot.bastionPassword);
    await dialog().getByLabel('远程目录（可选）', { exact: true }).fill('/workspace');
    assert.ok(await dialog().getByLabel('跳板机（可选，单跳）').isVisible(), 'the editor offers an explicit single-hop jump choice');
    await dialog().getByRole('button', { name: '保存主机', exact: true }).click();
    await dialog().waitFor({ state: 'hidden', timeout: 10000 });
    const bastionRow = page.locator('.nw-ssh-host').filter({ hasText: 'Bastion' });
    await settle(async () => (await storedHosts()).length === 1, 'the bastion host to be saved');
    await bastionRow.getByText('已保存凭据').waitFor({ timeout: 10000 });
    const savedBastion = (await storedHosts()).find(host => host.name === 'Bastion');
    assert.equal(savedBastion.decodedSecret, `enc:${boot.bastionPassword}`, 'the form secret went through the encryption boundary, not plaintext');
    assert.ok(!(await state()).storeRaw.includes(boot.bastionPassword), 'no plaintext password in the store file');
    observations.bastionSavedSecret = savedBastion.decodedSecret;

    // 3b. Clear that credential through the same form: from now on the bastion
    // password exists only for the connection it is typed into.
    await bastionRow.getByRole('button', { name: '编辑', exact: true }).click();
    await dialog().getByLabel('清除已保存的密码', { exact: true }).check();
    await dialog().getByRole('button', { name: '保存主机', exact: true }).click();
    await dialog().waitFor({ state: 'hidden', timeout: 10000 });
    await settle(async () => (await storedHosts()).find(host => host.name === 'Bastion')?.secret === undefined, 'the stored bastion credential to be cleared');
    await bastionRow.getByText('未保存凭据').waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(evidenceDir, 'ssh-01-hosts.png'), fullPage: true });

    // 3c. Save the internal target behind the bastion, with its own password.
    const bastionId = (await storedHosts()).find(host => host.name === 'Bastion').id;
    await page.getByRole('button', { name: '添加主机', exact: true }).click();
    await dialog().getByLabel('名称', { exact: true }).fill('Internal');
    await dialog().getByLabel('服务器地址', { exact: true }).fill('target.internal');
    await dialog().getByLabel('端口', { exact: true }).fill('22');
    await dialog().getByLabel('用户名', { exact: true }).fill(boot.targetUser);
    await dialog().getByLabel('登录方式').selectOption('password');
    await dialog().getByLabel('密码', { exact: true }).fill(boot.targetPassword);
    await dialog().getByLabel('远程目录（可选）', { exact: true }).fill('/workspace');
    await dialog().getByLabel('跳板机（可选，单跳）').selectOption(bastionId);
    await dialog().getByRole('button', { name: '保存主机', exact: true }).click();
    await dialog().waitFor({ state: 'hidden', timeout: 10000 });
    const targetRow = page.locator('.nw-ssh-host').filter({ hasText: 'Internal' });
    await settle(async () => (await storedHosts()).length === 2, 'the target host to be saved');
    await targetRow.getByText('经跳板机连接').waitFor({ timeout: 10000 });
    const savedTarget = (await storedHosts()).find(host => host.name === 'Internal');
    assert.equal(savedTarget.decodedSecret, `enc:${boot.targetPassword}`);
    assert.equal(savedTarget.jumpHostId, bastionId);

    // 3d. Connect: the bastion password is typed for this connection only, and
    // bastion and target each demand their own fingerprint trust.
    await targetRow.getByRole('button', { name: '连接', exact: true }).click();
    const jumpField = dialog().getByLabel(/跳板机 .*密码/);
    assert.ok(await jumpField.isVisible(), 'the connect dialog asks for the bastion credential');
    assert.equal(await jumpField.getAttribute('placeholder'), '仅用于本次连接，不会被保存', 'an unsaved bastion is offered as one-shot input');
    await jumpField.fill(boot.bastionPassword);
    await dialog().getByRole('button', { name: '连接', exact: true }).click();
    await page.locator('.nw-ssh-trust').first().waitFor({ timeout: 30000 });
    assert.match(await page.locator('.nw-ssh-trust strong').first().innerText(), /Bastion/, 'the first challenge names the bastion');
    observations.firstChallenge = await page.locator('.nw-ssh-trust code').first().innerText();
    await page.locator('.nw-ssh-trust').first().getByRole('button', { name: '信任此指纹', exact: true }).click();
    await page.locator('.nw-ssh-trust').first().waitFor({ state: 'detached', timeout: 10000 });
    await dialog().getByRole('button', { name: '连接', exact: true }).click();
    await page.locator('.nw-ssh-trust').first().waitFor({ timeout: 30000 });
    assert.match(await page.locator('.nw-ssh-trust strong').first().innerText(), /Internal/, 'after the bastion, the target presents its own fingerprint');
    observations.secondChallenge = await page.locator('.nw-ssh-trust code').first().innerText();
    await page.screenshot({ path: path.join(evidenceDir, 'ssh-02-two-challenges.png'), fullPage: true });
    await page.locator('.nw-ssh-trust').first().getByRole('button', { name: '信任此指纹', exact: true }).click();
    await page.locator('.nw-ssh-trust').first().waitFor({ state: 'detached', timeout: 10000 });
    await dialog().getByRole('button', { name: '连接', exact: true }).click();
    await page.getByRole('button', { name: '文件', exact: true }).waitFor({ timeout: 30000 });
    assert.equal((await storedHosts()).find(host => host.name === 'Bastion')?.secret, undefined, 'the typed bastion password was never saved');

    // The terminal of the jumped session is really attached to the target.
    const terminal = page.locator('.nw-terminal');
    await terminal.waitFor({ timeout: 10000 });
    const firstSessionId = await terminal.getAttribute('data-session-id');
    await page.waitForFunction(() => document.querySelector('.nw-terminal-screen')?.innerText.includes('fixture ready'), null, { timeout: 20000 });
    observations.firstSessionId = firstSessionId;
    observations.terminalCwd = await page.locator('.nw-terminal-toolbar span small').innerText();
    assert.equal(observations.terminalCwd, '/workspace', 'the working directory comes from the internal target');

    // 3e. A 24 MB download (above the 16 MB legacy cap) streams with live
    // progress and lands byte-identical.
    await page.getByRole('button', { name: '文件', exact: true }).click();
    const fileRow = name => page.locator('.nw-ssh-file-list button').filter({ hasText: name }).first();
    await fileRow('big-remote.bin').waitFor({ timeout: 20000 });
    const listed = (await page.locator('.nw-ssh-file-list button').allInnerTexts()).map(text => text.split('\n')[0]).sort();
    assert.deepEqual(listed, ['big-remote.bin', 'cut-me.bin', 'note.txt'], 'the listing came through the tunnel');
    await fileRow('big-remote.bin').click();
    await page.locator('.nw-inline-error').filter({ hasText: '256 KB' }).waitFor({ timeout: 10000 });
    await page.locator('summary').filter({ hasText: '传输文件' }).click();
    await page.getByLabel('下载：项目内保存目录', { exact: true }).fill('downloads');
    const downloadButton = page.getByRole('button', { name: '流式下载选中文件' });
    assert.ok(await downloadButton.isEnabled(), 'the over-cap file stays selectable for a streaming download');
    await downloadButton.click();
    const bigRow = page.locator('.nw-ssh-transfer-row').filter({ hasText: 'big-remote.bin' });
    await bigRow.waitFor({ timeout: 10000 });
    const downloadProgress = await collectProgress(bigRow, '已完成', 150000);
    observations.downloadProgress = downloadProgress;
    assert.ok(downloadProgress.filter(value => value > 0 && value < 100).length >= 2, `live percentages must be shown, saw ${downloadProgress.join(',')}`);
    for (let i = 1; i < downloadProgress.length; i++) assert.ok(downloadProgress[i] >= downloadProgress[i - 1], `progress regressed: ${downloadProgress.join(',')}`);
    let after = await state();
    const bigDownload = after.downloadsDetail.find(entry => entry.name === 'big-remote.bin');
    assert.ok(bigDownload, 'the 24 MB file reached the local project');
    assert.equal(bigDownload.size, boot.big.size);
    assert.equal(bigDownload.sha256, boot.big.sha256, 'byte-identical download');
    assert.ok(!after.downloads.some(name => name.startsWith('.knorvia-download-')), 'no staging temp left behind');

    // 3f. Cancel one running upload while the session keeps working.
    await page.getByLabel('上传：项目内文件路径', { exact: true }).fill('slow-upload.bin');
    await page.getByLabel('远程文件名', { exact: true }).fill('slow-upload.bin');
    await page.getByRole('button', { name: '流式上传到当前目录' }).click();
    const uploadRow = page.locator('.nw-ssh-transfer-row').filter({ hasText: 'slow-upload.bin' });
    const cancelButton = uploadRow.getByRole('button', { name: '取消此传输' });
    await cancelButton.waitFor({ timeout: 20000 });
    observations.uploadRunning = await rowText(uploadRow);
    await cancelButton.click();
    await page.waitForFunction(() => /slow-upload\.bin.*已取消/s.test(document.querySelector('.nw-ssh-transfers')?.innerText || ''), null, { timeout: 30000 });
    observations.uploadCancelled = await rowText(uploadRow);
    after = await state();
    assert.ok(!after.remote.includes('slow-upload.bin'), 'a cancelled upload publishes nothing');
    assert.ok(!after.remote.some(name => name.includes('.knorvia-')), 'the cancelled upload cleaned its own staging file');
    assert.ok(after.state.bytesWritten < boot.slowUpload.size, `the cancelled upload stopped early, after ${after.state.bytesWritten} bytes`);
    await page.getByRole('button', { name: '终端', exact: true }).click();
    await page.locator('.nw-terminal[data-status="ready"]').waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(evidenceDir, 'ssh-03-transfers.png'), fullPage: true });

    // 3g. A transport that dies mid-download reports the transfer honestly
    // incomplete, and the user restarts it explicitly on a new session.
    await arm('/cut');
    await page.getByRole('button', { name: '文件', exact: true }).click();
    await fileRow('cut-me.bin').click();
    await page.locator('summary').filter({ hasText: '传输文件' }).click();
    await page.getByLabel('下载：项目内保存目录', { exact: true }).fill('downloads');
    await page.getByRole('button', { name: '流式下载选中文件' }).click();
    const cutRow = page.locator('.nw-ssh-transfer-row').filter({ hasText: 'cut-me.bin' });
    await cutRow.waitFor({ timeout: 20000 });
    await page.waitForFunction(() => /连接中断，未完成/.test(document.querySelector('.nw-ssh-transfers')?.innerText || ''), null, { timeout: 40000 });
    observations.detachedRow = await rowText(cutRow);
    await page.locator('.nw-ssh-transfers p').filter({ hasText: '不会自动续传' }).waitFor({ timeout: 10000 });
    after = await state();
    assert.ok(!after.downloads.includes('cut-me.bin'), 'the interrupted download published nothing');
    assert.ok(!after.downloads.some(name => name.startsWith('.knorvia-download-')), 'the interrupted download cleaned its staging file');
    await page.getByRole('button', { name: '主机', exact: true }).click();
    await settle(async () => (await page.locator('.nw-ssh-live').count()) === 0, 'the dead session to stop being offered as live');
    await arm('/cut-off');

    // 3h. Reconnect through the same form path: the bastion password still has
    // to be typed, and the restarted transfer completes.
    await targetRow.getByRole('button', { name: '连接', exact: true }).click();
    await dialog().getByLabel(/跳板机 .*密码/).fill(boot.bastionPassword);
    await dialog().getByRole('button', { name: '连接', exact: true }).click();
    await page.getByRole('button', { name: '文件', exact: true }).waitFor({ timeout: 30000 });
    const secondSessionId = await page.locator('.nw-terminal').getAttribute('data-session-id');
    assert.notEqual(secondSessionId, firstSessionId, 'the reconnect opened a new session');
    observations.secondSessionId = secondSessionId;
    assert.equal((await storedHosts()).find(host => host.name === 'Bastion')?.secret, undefined, 'still no saved bastion password');
    await page.getByRole('button', { name: '文件', exact: true }).click();
    await fileRow('cut-me.bin').click();
    await page.locator('summary').filter({ hasText: '传输文件' }).click();
    await page.getByLabel('下载：项目内保存目录', { exact: true }).fill('downloads');
    await page.getByRole('button', { name: '流式下载选中文件' }).click();
    const retryRow = page.locator('.nw-ssh-transfer-row').filter({ hasText: 'cut-me.bin' });
    await retryRow.waitFor({ timeout: 20000 });
    await page.waitForFunction(() => /已完成/.test(document.querySelector('.nw-ssh-transfers')?.innerText || ''), null, { timeout: 90000 });
    observations.restartedRow = await rowText(retryRow);
    after = await state();
    const cutDownload = after.downloadsDetail.find(entry => entry.name === 'cut-me.bin');
    assert.ok(cutDownload, 'the explicit restart produced the file');
    assert.equal(cutDownload.size, boot.cut.size);
    assert.ok(after.bastionForwarded.filter(entry => entry === 'target.internal:22').length >= 2, 'both sessions really traversed the bastion');
    observations.state = { remote: after.remote, downloads: after.downloadsDetail, bastionForwarded: after.bastionForwarded };
    await page.screenshot({ path: path.join(evidenceDir, 'ssh-04-restarted.png'), fullPage: true });
    assert.deepEqual(pageErrors, [], 'no page errors');
  } finally {
    fs.writeFileSync(path.join(evidenceDir, 'ssh-jump-transfer-ui-result.json'), JSON.stringify({
      mode: 'real Chrome + real RemoteWorkspace/SshConnections/SshFilesPanel (esbuild bundle, only the workbench provider shimmed) + real desktop ssh-session module + real ssh2 bastion and target servers',
      bridge: { port: boot.port, bastionPort: boot.bastionPort, targetPort: boot.targetPort, home: boot.home },
      fixtures: { big: boot.big, cut: boot.cut, slowUpload: boot.slowUpload },
      observations,
      bridgeStderr: bridgeLog.join('').slice(-4000),
      pageErrors,
    }, null, 2));
    await context.close();
    await browser.close();
  }
});
