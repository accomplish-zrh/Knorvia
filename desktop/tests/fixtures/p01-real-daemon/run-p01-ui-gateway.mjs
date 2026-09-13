'use strict';
// P01 full-product chain: real daemon (spawned by the native gateway
// fixture) + real Next dev server proxying /api/knorvia/native to that
// gateway + real Chrome driving the workbench UI. A workspace is registered
// against a synthetic project (deep dirs, Chinese/space names, many files)
// through the gateway WebSocket, then the ProjectExplorer project search is
// exercised in the browser.
//
// Run: node run-p01-ui-gateway.mjs --daemon <exe> --kernel <exe> --out <json>

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(__dirname, '..', '..', '..', '..');
const { startNativeGatewayFixture } = require(path.join(moduleRoot, 'desktop', 'tests', 'fixtures', 'start-native-gateway-fixture.js'));


const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const daemonBin = arg('daemon', '');
const kernelBin = arg('kernel', '');
const OUT = arg('out', path.join(__dirname, 'result.json'));
const WEB_PORT = Number(arg('webport', 4473));
const GATEWAY_PORT = Number(arg('gatewayport', 4472));
const webRoot = path.resolve(arg('webroot', path.resolve(moduleRoot, 'web')));
const { chromium } = require(path.join(webRoot, 'node_modules', 'playwright'));
const WebSocket = require(path.join(moduleRoot, 'desktop', 'node_modules', 'ws'));

const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); if (!ok) process.exitCode = 1; };

function write(relative, contents) {
  const file = path.join(FIXTURE, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}
let FIXTURE = '';

async function gatewayRpc(gatewayUrl, method, params) {
  const session = await (await fetch(`${gatewayUrl}/knorvia/native/session`, { headers: { origin: gatewayUrl } })).json();
  const url = `${gatewayUrl.replace(/^http/, 'ws')}/knorvia/native`;
  const socket = new WebSocket(url, ['knorvia.native.v1', `knorvia.native.token.${session.token}`], { origin: gatewayUrl });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const reply = await new Promise((resolve, reject) => {
    socket.on('message', data => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.id === 'setup') resolve(parsed);
      } catch { /* ignore */ }
    });
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'setup', method, params }));
    setTimeout(() => reject(new Error('gateway rpc timeout')), 30000);
  });
  socket.close();
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-p01-ui-'));
  const home = path.join(base, 'home');
  FIXTURE = path.join(home, 'workspace');
  fs.mkdirSync(FIXTURE, { recursive: true });
  // project content before the workspace is registered
  for (let index = 0; index < 620; index += 1) write(`notes/file-${String(index).padStart(3, '0')}.txt`, `body ${index}\n`);
  write('docs/深/层级/notes.md', '# 层级笔记\n深层内容 needle\n');
  write('docs/带 空格 文件.txt', '带空格的文件名\n');
  write('.gitignore', 'secret-keys/\n');
  write('secret-keys/api.txt', 'matchneedle\n');
  write('visible.txt', 'matchneedle here\n');

  const fixture = await startNativeGatewayFixture({ home, daemonBin, kernelBin, port: GATEWAY_PORT, host: '127.0.0.1' });
  record('gateway fixture started', Boolean(fixture.gateway), `url=${fixture.location.url}`);

  const devServer = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '-p', String(WEB_PORT)], {
    cwd: webRoot,
    env: { ...process.env, KNORVIA_NEXT_DIST_DIR: '.next-night-dev', KNORVIA_NATIVE_GATEWAY_URL: fixture.location.url },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let browser;
  try {
    const deadline = Date.now() + 240000;
    for (;;) {
      try { const r = await fetch(`http://127.0.0.1:${WEB_PORT}/workbench`); if (r.ok || r.status === 404) break; } catch { /* warming */ }
      if (Date.now() > deadline) throw new Error('web dev not ready');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    const workspace = await gatewayRpc(fixture.location.url, 'workspace/create', { title: 'P01 UI', cwd: FIXTURE, idempotencyKey: crypto.randomUUID() });
    record('workspace registered through real gateway', Boolean(workspace.id), `id=${workspace.id}`);

    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.addInitScript(() => {
      window.__rpcLog = [];
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        send(data) {
          try {
            const parsed = JSON.parse(data);
            if (parsed?.method) window.__rpcLog.push(`-> ${parsed.method} ${JSON.stringify(parsed.params ?? {}).slice(0, 160)}`);
          } catch { /* ignore */ }
          super.send(data);
        }
      };
    });
    await page.addInitScript(() => {
      window.__rpcLog = [];
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        send(data) {
          try {
            const parsed = JSON.parse(data);
            if (parsed?.method) window.__rpcLog.push(`-> ${parsed.method}`);
          } catch { /* ignore */ }
          super.send(data);
        }
      };
      window.addEventListener('message', event => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed?.error) window.__rpcLog.push(`error: ${parsed.error.message}`);
        } catch { /* ignore */ }
      });
    });
    await page.goto(`http://127.0.0.1:${WEB_PORT}/workbench/project/${encodeURIComponent(workspace.id)}`, { timeout: 240000, waitUntil: 'commit' });
    await page.waitForFunction(() => Boolean(document.querySelector('.nw-explorer')), null, { timeout: 240000 });

    // real directory listing through the whole chain
    await page.waitForFunction(() => document.querySelectorAll('.nw-file-row').length > 0, null, { timeout: 60000 });
    const rows = await page.evaluate(() => document.querySelectorAll('.nw-file-row').length);
    record('explorer lists the real project over the gateway', rows > 0, `rows=${rows}`);

    // open the project-wide search
    const searchToggle = page.getByRole('button', { name: /全项目搜索|Search the project/ }).first();
    await searchToggle.click();
    fs.mkdirSync('D:/tools/knorvia-nightshift-20260909/evidence/C/p01', { recursive: true });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: 'D:/tools/knorvia-nightshift-20260909/evidence/C/p01/ui-search-open.png' });
    const searchInput = page.getByLabel(/搜索文件名与内容|Search file names and content/);
    await searchInput.scrollIntoViewIfNeeded().catch(() => {});
    await searchInput.waitFor({ timeout: 30000 });
    await searchInput.fill('层级');
    await page.getByRole('button', { name: /^搜索$|^Search$/ }).click();
    // (path-mode search first: deep Chinese directory)
    try {
      await page.waitForFunction(() => document.querySelectorAll('.nw-project-search-row').length > 0, null, { timeout: 60000 });
    } catch (error) {
      await page.screenshot({ path: 'D:/tools/knorvia-nightshift-20260909/evidence/C/p01/ui-search-failed.png' }).catch(() => {});
      console.log('RPC LOG:', JSON.stringify(await page.evaluate(() => (window.__rpcLog || []).slice(-30))));
      throw error;
    }
    const found = await page.evaluate(() => [...document.querySelectorAll('.nw-project-search-path')].map(node => node.textContent));
    record('UI search finds the deep Chinese directory', found.some(text => (text ?? '').includes('docs/深/层级')), JSON.stringify(found.slice(0, 5)));

    // Consecutive query in the SAME panel: switch the keyword and the mode
    // without any reload — the review's real-interaction requirement.
    await searchInput.fill('matchneedle');
    const modeSelect = page.getByLabel(/搜索范围|Search scope/);
    await modeSelect.selectOption('content');
    await page.getByRole('button', { name: /^搜索$|^Search$/ }).click();
    // Wait for the NEW search's verdict, not the previous query's rows.
    try {
      await page.waitForFunction(() => {
        const paths = [...document.querySelectorAll('.nw-project-search-path')].map(node => node.textContent ?? '');
        return paths.some(text => text.includes('visible.txt')) || document.body.innerText.includes('没有匹配的结果');
      }, null, { timeout: 60000 });
    } catch (error) {
      await page.screenshot({ path: 'D:/tools/knorvia-nightshift-20260909/evidence/C/p01/ui-content-failed.png' }).catch(() => {});
      console.log('RPC LOG:', JSON.stringify(await page.evaluate(() => (window.__rpcLog || []).slice(-30))));
      console.log('SEARCH TEXT:', await searchInput.inputValue());
      throw error;
    }
    const contentPaths = await page.evaluate(() => [...document.querySelectorAll('.nw-project-search-path')].map(node => node.textContent));
    record('UI content search hits visible file and skips ignored', contentPaths.some(t => (t ?? '').includes('visible.txt')) && !contentPaths.some(t => (t ?? '').includes('secret-keys')), JSON.stringify(contentPaths.slice(0, 6)));

    // (C02) rapid keyword change -> cancel mid-scan -> brand-new query.
    // The old search must not poison the new one and an old cancel must not
    // kill the new request.
    await searchInput.fill('层级');
    await page.getByRole('button', { name: /^搜索$|^Search$/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.nw-project-search-row').length > 0, null, { timeout: 60000 });
    await searchInput.fill('file-');
    await page.getByRole('button', { name: /^搜索$|^Search$/ }).click();
    // cancel as early as possible during the fresh scan
    const stopButton = page.getByRole('button', { name: /^停止$|^Stop$/ }).first();
    const cancelled = await stopButton.click().then(() => true).catch(() => false);
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.nw-project-search-path')];
      return rows.some(node => (node.textContent ?? '').includes('file-')) || document.body.innerText.includes('已停止') || document.body.innerText.includes('没有匹配');
    }, null, { timeout: 60000 });
    const afterCancelRows = await page.evaluate(() => [...document.querySelectorAll('.nw-project-search-path')].map(node => node.textContent));
    record('rapid change + cancel keeps results coherent', cancelled && afterCancelRows.every(t => !(t ?? '').includes('层级')), JSON.stringify(afterCancelRows.slice(0, 4)));

    // a brand-new query right after the cancel must run normally
    await searchInput.fill('matchneedle');
    await page.getByRole('button', { name: /^搜索$|^Search$/ }).click();
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.nw-project-search-path')];
      return rows.some(node => (node.textContent ?? '').includes('visible.txt')) || document.body.innerText.includes('没有匹配的结果');
    }, null, { timeout: 60000 });
    const freshRows = await page.evaluate(() => [...document.querySelectorAll('.nw-project-search-path')].map(node => node.textContent));
    record('new query after cancel runs with a fresh session', freshRows.some(t => (t ?? '').includes('visible.txt')), JSON.stringify(freshRows.slice(0, 4)));

    const shotDir = 'D:/tools/knorvia-nightshift-20260909/evidence/C/p01';
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, 'ui-search-results.png') });
    record('screenshot saved', fs.existsSync(path.join(shotDir, 'ui-search-results.png')));
  } finally {
    if (browser) await browser.close().catch(() => {});
    devServer.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (!devServer.killed) devServer.kill('SIGKILL');
    await fixture.close();
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ results, measuredAt: new Date().toISOString(), daemonBin }, null, 2));
  console.log('report written:', OUT);
}

main().catch(error => { console.error(error); record('fatal', false, String(error && error.stack || error).slice(0, 800)); process.exit(1); });
