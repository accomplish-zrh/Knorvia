import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const workspace = process.env.KNORVIA_UI_FIXTURE_WORKSPACE;
test.skip(!workspace, 'Requires the isolated native gateway');
test.use({ locale: 'zh-CN', screenshot: 'only-on-failure' });

// Real local HTML test material, opened and edited through the library UI.
const documentHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的资料，随时接着用</title><style>
*{box-sizing:border-box}body{margin:0;color:#23352f;background:linear-gradient(130deg,#eef7f3,#f4f3fa);font:16px/1.85 "Microsoft YaHei",sans-serif}main{max-width:1060px;margin:auto;padding:72px 64px 90px}.tag{display:inline-flex;align-items:center;gap:8px;color:#44806c;font-size:13px;letter-spacing:.1em}.tag:before{content:'';width:7px;height:7px;border-radius:50%;background:#65a78f}h1{font-size:44px;line-height:1.3;letter-spacing:-.05em;margin:24px 0}header>p{max-width:660px;color:#66766f;font-size:17px}article{margin-top:52px;display:grid;gap:20px}section{padding:28px 32px;border:1px solid #ffffffb0;background:#ffffffc9;border-radius:18px;box-shadow:0 8px 24px #30443a04}h2{font-size:20px;line-height:1.5;margin:0 0 10px}p{margin:0;color:#66766f}.number{color:#669382;font-size:12px;letter-spacing:.12em;display:block;margin-bottom:8px}button{margin-top:18px;border:0;border-radius:9px;background:#335d4f;color:white;padding:10px 16px;font:inherit;font-size:13px;cursor:pointer}.bottom{margin-top:32px;font-size:12px;color:#91a099}@media(max-width:650px){main{padding:36px 22px}h1{font-size:32px}section{padding:24px}article{margin-top:32px}}
</style></head><body><main><header><span class="tag">KNORVIA · 个人资料</span><h1>我的资料，<br>随时接着用。</h1><p>把笔记、文档和工作成果收在一起。需要时打开，改好后保存，也可以交给助手继续处理。</p></header><article><section><span class="number">01 / 收好</span><h2>文件有自己的位置</h2><p>用文件夹整理资料，从左侧目录直接打开。正文拥有完整的阅读空间，切换文件时，目录始终在手边。</p></section><section><span class="number">02 / 继续编辑</span><h2>每次修改，都接着上次的成果</h2><p>点文档顶栏的编辑按钮，保存后即可返回预览。需要回看时，在历史记录中打开之前的版本。</p></section><section><span class="number">03 / 一起完成</span><h2>让助手帮忙整理和改写</h2><p>对当前资料提出要求，助手会在真实文件上处理。产生的新资料会留在自己的资料库中。</p><button onclick="this.textContent='这份资料已准备好继续使用'">试试文档内的按钮</button></section></article><p class="bottom">此文件为界面验收用的示例资料，不随安装包写入个人资料库。</p></main></body></html>`;

test('documents occupy the workspace, with a live directory, header editing and searchable return', async ({ page, baseURL }, info) => {
  test.setTimeout(90_000);
  expect(workspace!.replaceAll('\\', '/')).toContain('/isolated-home/workspace');
  expect(new URL(baseURL!).hostname).toBe('127.0.0.1');
  const library = path.join(path.dirname(workspace!), 'personal-library/files');
  await fs.mkdir(path.join(library, '工作笔记'), { recursive: true });
  await fs.writeFile(path.join(library, '我的资料使用指南.html'), documentHtml);
  await fs.writeFile(path.join(library, '工作笔记', '本周计划.md'), '# 本周计划\n\n把有用的想法留下来。\n\n## 正在进行\n\n- 整理资料\n- 继续上次的文档\n- 记录新的想法');
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('knorvia-language', 'zh'); });
  await page.setViewportSize({ width: 1800, height: 1120 });
  await page.goto('/workbench/library');
  await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
  const directory = page.locator('.nl-folder-tree'), editor = page.locator('.nl-inspector');
  await directory.getByRole('button', { name: '我的资料使用指南.html', exact: true }).click();
  const frame = page.frameLocator('iframe[title="我的资料使用指南.html"]');
  await expect(frame.getByRole('heading', { name: /我的资料，\s*随时接着用。/ })).toBeVisible();
  await expect(page.locator('.nl-list-area')).toBeHidden();
  await expect(directory).toBeVisible();
  expect((await editor.boundingBox())!.width).toBeGreaterThan(1150);
  await page.screenshot({ path: info.outputPath('library-document-desktop.png'), fullPage: true });
  await frame.getByRole('button').click(); await expect(frame.getByRole('button')).toHaveText('这份资料已准备好继续使用');
  await editor.getByRole('button', { name: '编辑这份资料', exact: true }).click();
  await editor.getByRole('textbox', { name: '资料内容', exact: true }).fill(documentHtml.replace('把笔记、文档和工作成果收在一起。', '把笔记、文档和新的工作成果收在一起。'));
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: '资料内容' })).toHaveValue(/新的工作成果/);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(frame.locator('header>p')).toContainText('新的工作成果');
  expect(await fs.readFile(path.join(library, '我的资料使用指南.html'), 'utf8')).toContain('新的工作成果');
  await page.reload(); await expect(frame.locator('header>p')).toContainText('新的工作成果');
  await editor.getByRole('button', { name: '收起资料目录' }).click(); await expect(page.locator('.nl-rail')).toBeHidden();
  await editor.getByRole('button', { name: '展开资料目录' }).click(); await expect(directory).toBeVisible();
  await directory.getByRole('button', { name: '展开文件夹: 工作笔记', exact: true }).click();
  await directory.getByRole('button', { name: '本周计划.md', exact: true }).click();
  await expect(editor.getByRole('heading', { name: '本周计划', exact: true })).toBeVisible();
  await directory.getByRole('button', { name: '我的资料使用指南.html', exact: true }).click();
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索资料名称或路径' })).toBeFocused();
  await page.getByRole('textbox', { name: '搜索资料名称或路径' }).fill('使用指南');
  await expect(page.locator('.nl-file-row')).toHaveCount(1);
  await page.locator('.nl-list-area').getByRole('button', { name: /^我的资料使用指南.html/ }).click();
  for (const width of [1440, 1100, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(frame.getByRole('heading', { name: /我的资料，\s*随时接着用。/ })).toBeVisible();
    expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1440 || width === 390) await page.screenshot({ path: info.outputPath(`library-document-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1800, height: 1120 });
});
