import { toggleWorkbenchTheme } from './helpers/native-appearance';
import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

const workspace = process.env.KNORVIA_UI_FIXTURE_WORKSPACE;
test.skip(!workspace, 'Requires isolated native fixture');
test.use({ locale: 'zh-CN', screenshot: 'only-on-failure' });

test('content workspace opens real previews, preserves tabs, and runs a side conversation', async ({ page, baseURL }, info) => {
  test.setTimeout(120_000); page.setDefaultTimeout(10_000);
  expect(workspace!.replaceAll('\\', '/')).toContain('/isolated-home/workspace');
  expect(new URL(baseURL!).hostname).toBe('127.0.0.1');
  const id = Date.now(), folder = `preview-${id}`, title = `右侧预览验收 ${id}`;
  const root = path.join(workspace!, folder);
  await fs.mkdir(root, { recursive: true });
  const html = '<!doctype html><html lang="zh"><meta charset="utf-8"><title>交互预览</title><style>body{font:18px system-ui;padding:35px;background:#f1faf5;color:#184537}button{font:inherit;padding:12px 24px;border:0;background:#185d45;color:white;border-radius:8px}</style><h1>网页在对话旁边</h1><button id="count" onclick="this.textContent=Number(this.textContent)+1">0</button></html>';
  await fs.writeFile(path.join(root, 'demo.html'), html);
  await fs.writeFile(path.join(root, 'reading.md'), '# 阅读预览\n\n[打开交互页面](demo.html)\n\n' + '保持阅读位置。\n\n'.repeat(70));
  await fs.writeFile(path.join(root, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><rect width="360" height="240" rx="28" fill="#daf3e8"/><circle cx="180" cy="120" r="65" fill="#237455"/></svg>');
  await fs.writeFile(path.join(root, 'unsupported.zip'), Buffer.from([0, 1, 0, 255]));
  const wave = Buffer.alloc(1644); wave.write('RIFF'); wave.writeUInt32LE(1636, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(1600, 40);
  await fs.writeFile(path.join(root, 'sound.wav'), wave);
  const pdfStream = 'BT /F1 18 Tf 30 340 Td (Knorvia preview) Tj ET\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${Buffer.byteLength(pdfStream)} >>\nstream\n${pdfStream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await fs.writeFile(path.join(root, 'document.pdf'), pdf);
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  const noOverflow = async () => expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth && document.body.scrollHeight <= innerHeight + 1)).toBe(true);
  try {
    await page.addInitScript(() => { if (window === window.top) localStorage.setItem('knorvia-language', 'zh'); });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto('/workbench');
    await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.getByLabel('项目名称', { exact: true }).fill(title);
    await page.getByLabel('本地文件夹（可选）').first().fill(workspace!);
    await page.getByRole('button', { name: '创建项目', exact: true }).click();
    await expect(page.locator('dialog')).toHaveCount(0);
    await page.getByRole('textbox', { name: '任务描述', exact: true }).fill(title);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.locator('.nw-task-heading [data-status="completed"]')).toBeVisible({ timeout: 25_000 });
    const taskURL = page.url(), composer = page.locator('.nw-task-composer textarea').first();
    await composer.fill('主对话草稿需要保留');
    await page.getByRole('button', { name: '保存为成果', exact: true }).click();
    await page.getByRole('button', { name: '右侧工作面板', exact: true }).click();
    const panel = page.getByRole('complementary', { name: '右侧工作面板', exact: true });
    await expect(panel.locator('.nw-panel-launch-actions button')).toHaveCount(4);
    await expect(panel.getByRole('tab')).toHaveCount(0);
    await expect(panel.locator('.nw-panel-recommendations')).toContainText(title);
    await noOverflow(); await shot('workspace-launcher');
    await panel.locator('.nw-panel-launch-actions').getByRole('button', { name: /^文件/ }).click();
    await panel.getByRole('button', { name: folder, exact: true }).click();
    await panel.getByRole('button', { name: 'reading.md', exact: true }).click();
    await expect(panel.getByRole('heading', { name: '阅读预览', exact: true })).toBeVisible();
    await panel.getByRole('link', { name: '打开交互页面', exact: true }).click();
    const frame = page.frameLocator('iframe[title$="demo.html"]');
    await expect(frame.locator('#count')).toHaveText('0');
    await frame.locator('#count').click(); await expect(frame.locator('#count')).toHaveText('1');
    await shot('html-interactive');
    await panel.getByRole('tab', { name: 'reading.md', exact: true }).click();
    await panel.locator('.nw-panel-file:not([hidden]) .nw-preview-reading').evaluate(element => { element.scrollTop = 300; });
    await panel.getByRole('tab', { name: 'demo.html', exact: true }).click();
    await expect(frame.locator('#count')).toHaveText('1');
    await panel.getByRole('tab', { name: 'reading.md', exact: true }).click();
    expect(await panel.locator('.nw-panel-file:not([hidden]) .nw-preview-reading').evaluate(element => element.scrollTop)).toBeGreaterThan(250);
    for (const file of ['image.svg', 'document.pdf', 'sound.wav', 'unsupported.zip']) {
      await panel.getByRole('tab', { name: '文件', exact: true }).click();
      await panel.getByRole('button', { name: file, exact: true }).click();
      const content = panel.locator('[role="tabpanel"]:not([hidden])');
      if (file === 'image.svg') { await expect.poll(() => content.locator('img').evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth === 360)).toBe(true); await shot('image-preview'); }
      if (file === 'document.pdf') { await expect(content.locator('iframe')).toHaveAttribute('src', /^blob:/); await page.waitForTimeout(1200); /* Chromium's PDF viewer paints in its own renderer; verify its screenshot as well as the scoped bytes. */ await shot('pdf-preview'); }
      if (file === 'sound.wav') await expect.poll(() => content.locator('audio').evaluate(audio => (audio as HTMLAudioElement).readyState)).toBeGreaterThan(0);
      if (file === 'unsupported.zip') await expect(content).toContainText('此格式暂不支持直接预览');
    }
    await panel.getByRole('button', { name: '打开工作区入口', exact: true }).click();
    await panel.locator('.nw-panel-launch-actions').getByRole('button', { name: /^浏览器/ }).click();
    await panel.getByRole('textbox', { name: '网页地址', exact: true }).fill(url);
    await panel.getByRole('button', { name: '打开网页', exact: true }).click();
    await expect(page.frameLocator('iframe[title="网页预览"]').locator('h1')).toHaveText('网页在对话旁边');
    await noOverflow(); await shot('browser-preview');
    await panel.getByRole('button', { name: '打开工作区入口', exact: true }).click();
    await panel.locator('.nw-panel-launch-actions').getByRole('button', { name: /^侧边聊天/ }).click();
    const chat = panel.getByRole('region', { name: '侧边聊天', exact: true });
    await chat.getByRole('textbox', { name: '任务描述', exact: true }).fill('这是隔离的侧边聊天验收');
    await chat.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(chat.locator('.nw-turn-end[data-status="completed"]')).toBeVisible({ timeout: 25_000 });
    await expect(chat.locator('.nw-agent-message')).toContainText('scripted native fixture response');
    await expect(page).toHaveURL(taskURL); await expect(composer).toHaveValue('主对话草稿需要保留');
    await shot('side-chat');
    await panel.getByRole('tab', { name: 'demo.html', exact: true }).click();
    await expect(frame.locator('#count')).toHaveText('1');
    await panel.getByRole('button', { name: '关闭工作面板', exact: true }).click();
    await expect(composer).toHaveValue('主对话草稿需要保留');
    await page.keyboard.press('Control+Alt+b'); await expect(frame.locator('#count')).toHaveText('1');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 }); await noOverflow(); await shot(`preview-${width}`);
      await panel.getByRole('button', { name: '打开工作区入口', exact: true }).click(); await shot(`launcher-${width}`);
      await panel.getByRole('button', { name: '关闭工作面板', exact: true }).focus(); await page.keyboard.press('Escape');
      await expect(panel).toBeHidden(); await expect(composer).toHaveValue('主对话草稿需要保留'); await page.keyboard.press('Control+Alt+b');
    }
    await page.setViewportSize({ width: 1600, height: 1000 });
    await panel.getByRole('button', { name: '关闭工作面板', exact: true }).click();
    await toggleWorkbenchTheme(page);
    await page.keyboard.press('Control+Alt+b'); await shot('workspace-dark');
    while (await panel.locator('.nw-tab-close').count()) await panel.locator('.nw-tab-close').first().click();
    await expect(panel.locator('.nw-panel-launcher')).toBeVisible(); await expect(panel.getByRole('tab')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
