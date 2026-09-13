'use strict';
// P09 end-to-end: drives the real article-to-video dialog in real Chrome
// against the real Next dev server, with the native gateway WebSocket
// intercepted so studio/article RPCs are answered by a scripted backend.
// Covers: pre-create draft restore after reload, in-project draft restore,
// dirty project switch (keep-draft path), server-ahead conflict (both
// versions kept), and save clearing the draft. No paid model is invoked:
// nothing in the flow triggers voice/build/render.

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const webRoot = path.resolve(arg('webroot', path.resolve(__dirname, '..', '..', '..')));
const PORT = Number(arg('port', 4475));
const OUT = arg('out', path.join(webRoot, 'dist', 'article-draft-e2e', 'result.json'));
const SHOTS = path.resolve(arg('shots', 'D:/tools/knorvia-nightshift-20260909/evidence/C/p09'));

const articleText = (label) => `${label}\n\n${'这一段用于让文章足够长，验证草稿可以承载长文内容。'.repeat(60)}`;

async function main() {
  const devServer = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '-p', String(PORT)], {
    cwd: webRoot,
    env: { ...process.env, KNORVIA_NEXT_DIST_DIR: '.next-night-dev' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const results = { steps: [] };
  const step = (name, ok, detail = '') => { results.steps.push({ name, ok, detail }); console.log(`${ok ? '✔' : '✖'} ${name} ${detail}`); if (!ok) throw new Error(`step failed: ${name} ${detail}`); };
  try {
    const deadline = Date.now() + 240000;
    for (;;) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/workbench`, { method: 'GET' }); if (r.ok || r.status === 404) break; } catch { /* not ready */ }
      if (Date.now() > deadline) throw new Error('next dev not ready');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await (await browser.newContext()).newPage();
    mkdirSync(SHOTS, { recursive: true });

    const p1 = { id: 'p1', title: '工程一', revision: 4, narration: '服务器口播一', scenes: [{ heading: '开场', detail: '画面一' }], aspect: '16:9', phase: 'script', busy: null, guide: 'guide', article: '原文一' };
    const p2 = { id: 'p2', title: '工程二', revision: 2, narration: '服务器口播二', scenes: [], aspect: '9:16', phase: 'script', busy: null, guide: 'guide', article: '原文二' };
    const saveCalls = [];
    const respond = (message) => {
      const { id, method } = message;
      let result = {};
      if (method === 'connection/read') result = { capabilities: {}, providers: [] };
      else if (method === 'model/list') result = [{ id: 'mock-model', displayName: 'Mock', isDefault: true }];
      else if (method === 'workspace/list') result = [{ id: 'ws1', title: 'P', revision: 1, createdAt: 'x', updatedAt: 'x' }];
      else if (method === 'thread/list') result = { threads: [], nextCursor: null };
      else if (method === 'studio/article/config') result = { node: '', runtime: '' };
      else if (method === 'library/list') result = { entries: [] };
      else if (method === 'studio/article/list') result = { projects: [p1, p2], total: 2 };
      else if (method === 'studio/list') result = { jobs: [], total: 0 };
      else if (method === 'studio/models') result = { profiles: [] };
      else if (method === 'studio/template/list') result = { templates: [] };
      else if (method === 'studio/article/read') {
        const wanted = message.params.id === 'p1' ? p1 : p2;
        result = { ...wanted, revision: wanted.id === 'p1' ? readRevisionP1 : wanted.revision };
      } else if (method === 'studio/article/save') {
        saveCalls.push({ id: message.params.id, idempotencyKey: message.params.idempotencyKey, revision: message.params.revision });
        result = { ...p1, revision: 6, narration: message.params.narration };
      }
      return { jsonrpc: '2.0', id, result };
    };
    let readRevisionP1 = 4;

    await page.route('**/api/knorvia/native/session', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ token: 'e2e-token', expiresAt: Date.now() + 3600_000 }),
    }));
    await page.routeWebSocket(/\/api\/knorvia\/native$/, ws => {
      ws.onMessage(message => {
        try { const parsed = JSON.parse(message); if (parsed && parsed.id !== undefined) ws.send(JSON.stringify(respond(parsed))); } catch { /* ignore */ }
      });
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'connection/state', params: { engineState: 'ready' } }));
    });

    await page.goto(`http://127.0.0.1:${PORT}/workbench/studio`, { timeout: 240000, waitUntil: 'commit' });
    const opener = page.getByRole('button', { name: /文章转视频|Article to video/ }).first();
    await opener.waitFor({ timeout: 240000 });
    // A click before React hydration is a no-op; retry until the modal opens.
    const modal = page.locator('.ns-article');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await opener.click().catch(() => {});
      try { await modal.waitFor({ timeout: 3000 }); break; } catch { /* retry */ }
    }
    await modal.waitFor({ timeout: 30000 });

    // Step 1: long pre-create text survives a full reload.
    const titleInput = page.getByLabel(/标题|Title/).first();
    await titleInput.waitFor({ timeout: 30000 });
    await titleInput.fill('测试标题');
    await page.getByLabel(/文章或主题|Article or topic/).fill(articleText('需要恢复的长文'));
    const draftKey = 'knorvia-studio-article-draft:ws1';
    await page.waitForFunction(key => { const raw = localStorage.getItem(key); return !!raw && raw.includes('测试标题'); }, draftKey, { timeout: 15000 });
    await page.reload({ waitUntil: 'commit' });
    await opener.waitFor({ timeout: 60000 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await opener.click().catch(() => {});
      try { await modal.waitFor({ timeout: 3000 }); break; } catch { /* retry */ }
    }
    await modal.waitFor({ timeout: 30000 });
    const restoredTitle = await titleInput.inputValue();
    const restoredArticle = await page.getByLabel(/文章或主题|Article or topic/).inputValue();
    const note = await page.getByText(/已恢复上次未创建的草稿|Restored the draft/).count();
    step('pre-create draft survives reload', restoredTitle === '测试标题' && restoredArticle.startsWith('需要恢复的长文') && note === 1,
      `title=${restoredTitle} articleLen=${restoredArticle.length} note=${note}`);
    await page.screenshot({ path: path.join(SHOTS, '01-precreate-restored.png') });

    // Step 2: editing a project stores a project draft; switching with dirty
    // state offers the three-way choice, and keep-draft restores on return.
    const projectSelect = page.getByLabel(/文章视频工程|Article video project/);
    const chooseProject = async (id) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await projectSelect.isEnabled().catch(() => false)) break;
        await page.waitForTimeout(100);
      }
      await projectSelect.selectOption(id);
    };
    await chooseProject('p1');
    const narration = page.getByLabel(/口播稿/).first();
    await narration.waitFor({ timeout: 30000 });
    const serverNarration = await narration.inputValue();
    step('project opens with server narration', serverNarration === '服务器口播一', `got=${serverNarration}`);
    await narration.fill('本地修改口播');
    await page.waitForFunction(() => true, null, { timeout: 100 }).catch(() => {});
    await page.waitForTimeout(500);

    await chooseProject('p2');
    const switchDialog = page.getByRole('alertdialog', { name: /未保存的修改|Unsaved changes/ });
    await switchDialog.waitFor({ timeout: 15000 });
    await page.screenshot({ path: path.join(SHOTS, '02-switch-choice.png') });
    step('dirty switch offers save/keep/discard', await switchDialog.getByText(/保留草稿并切换|Keep draft, then switch/).count() === 1);
    await switchDialog.getByRole('button', { name: /保留草稿并切换|Keep draft, then switch/ }).click();
    const p2Narration = await page.getByLabel(/口播稿/).first().inputValue();
    step('switch to p2 shows p2 narration', p2Narration === '服务器口播二', `got=${p2Narration}`);

    // Step 3: returning with the server unchanged fast-forwards the draft.
    await chooseProject('p1');
    let restoredDraft = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      restoredDraft = await page.getByLabel(/口播稿/).first().inputValue().catch(() => '');
      if (restoredDraft === '本地修改口播') break;
      await page.waitForTimeout(100);
    }
    const restoredNote = await page.getByText(/已恢复本工程未保存的本地修改|Restored your unsaved changes/).count();
    step('returning restores the local draft', restoredDraft === '本地修改口播' && restoredNote === 1, `got=${restoredDraft} note=${restoredNote}`);
    await page.screenshot({ path: path.join(SHOTS, '03-draft-restored.png') });

    // Step 4: server moved ahead — both versions are kept and the user chooses.
    readRevisionP1 = 5;
    await chooseProject('p2');
    await switchDialog.waitFor({ timeout: 15000 });
    await switchDialog.getByRole('button', { name: /保留草稿并切换|Keep draft, then switch/ }).click();
    await chooseProject('p1');
    const conflict = page.getByRole('alertdialog', { name: /服务器版本已更新|The server version moved ahead/ });
    await conflict.waitFor({ timeout: 15000 });
    const serverNarrationKept = await page.getByLabel(/口播稿/).first().inputValue();
    await page.screenshot({ path: path.join(SHOTS, '04-conflict-both-kept.png') });
    step('server-ahead conflict keeps both versions', await conflict.getByText(/应用我的草稿|Apply my draft/).count() === 1 && serverNarrationKept === '服务器口播一',
      `narration=${serverNarrationKept}`);
    await conflict.getByRole('button', { name: /应用我的草稿|Apply my draft/ }).click();
    step('apply-draft restores local narration', (await page.getByLabel(/口播稿/).first().inputValue()) === '本地修改口播');

    // Step 5: saving clears the project draft and carries the idempotency key.
    await page.getByRole('button', { name: /保存修改|Save changes/ }).click();
    await page.waitForFunction(key => { const raw = localStorage.getItem(key); return !raw || !raw.includes('本地修改口播'); }, draftKey, { timeout: 30000 });
    step('save clears the project draft and sends the idempotency key', saveCalls.length >= 1 && !!saveCalls[saveCalls.length - 1].idempotencyKey,
      `saveCalls=${JSON.stringify(saveCalls)}`);

    results.ok = true;
  } catch (error) {
    results.fatal = String(error && error.stack || error).slice(0, 2000);
    try { await page.screenshot({ path: path.join(SHOTS, '99-fatal.png') }); } catch { /* best effort */ }
    throw error;
  } finally {
    mkdirSync(path.dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(results, null, 2));
    devServer.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 1200));
    if (!devServer.killed) devServer.kill('SIGKILL');
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch(error => { console.error(error); process.exit(1); });
