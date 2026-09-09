import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

const workspace = process.env.KNORVIA_UI_FIXTURE_WORKSPACE;
test.skip(!workspace, 'Requires isolated native fixture');
test.use({ locale: 'zh-CN', screenshot: 'only-on-failure' });

async function officeFixtures() {
  const doc = new JSZip();
  doc.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  doc.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  doc.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Word 原文</w:t></w:r><w:r><w:t> 保留第二片段</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>');
  doc.file('customXml/untouched.xml', '<original>Keep every byte &amp; styling.</original>');
  const ppt = new JSZip();
  ppt.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  ppt.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr b="1"/><a:t>幻灯片原文</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
  ppt.file('ppt/media/untouched.bin', Buffer.from([7, 8, 9, 0]));
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('资料'); sheet.getCell('A1').value = '单元格原文'; sheet.getCell('A1').font = { bold: true, color: { argb: 'FF336699' } }; sheet.getCell('B2').value = 42; sheet.getCell('C3').value = { formula: 'B2*2', result: 84 }; sheet.getCell('B4').value = '保留其他内容';
  const xlsx = await JSZip.loadAsync(await book.xlsx.writeBuffer()); xlsx.file('customXml/untouched.xml', '<keep>Keep charts and data.</keep>');
  return { docx: await doc.generateAsync({ type: 'nodebuffer' }), pptx: await ppt.generateAsync({ type: 'nodebuffer' }), xlsx: await xlsx.generateAsync({ type: 'nodebuffer' }) };
}

test('personal library imports, edits original formats, keeps revisions, restores trash and runs actual Kernel changes', async ({ page, context, baseURL }, info) => {
  test.setTimeout(180_000); page.setDefaultTimeout(15_000);
  expect(workspace!.replaceAll('\\', '/')).toContain('/isolated-home/workspace'); expect(new URL(baseURL!).hostname).toBe('127.0.0.1');
  const home = path.dirname(workspace!), library = path.join(home, 'personal-library/files'), id = Date.now(), folder = `资料验收-${id}`;
  await fs.mkdir(library, { recursive: true });
  for (const name of ['agent-created.md', 'agent-edit.md', 'agent-remove.md']) await fs.unlink(path.join(library, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await fs.writeFile(path.join(library, 'agent-edit.md'), 'before agent'); await fs.writeFile(path.join(library, 'agent-remove.md'), 'recover after agent');
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('knorvia-language', 'zh'); });
  await page.setViewportSize({ width: 1800, height: 1060 }); await page.goto('/workbench/library'); await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
  await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建资料文件夹', exact: true }).click(); await page.getByLabel('名称或资料库内路径', { exact: true }).fill(folder); await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('.nl-folder-tree').getByRole('button', { name: folder, exact: true }).click();
  const files = await officeFixtures();
  await page.locator('.nl-list-area input[type=file]').setInputFiles([
    { name: '笔记.md', mimeType: 'text/markdown', buffer: Buffer.from('# 手动编辑验收\n\n原始正文') },
    { name: '文档.docx', mimeType: 'application/octet-stream', buffer: files.docx },
    { name: '表格.xlsx', mimeType: 'application/octet-stream', buffer: files.xlsx },
    { name: '演示.pptx', mimeType: 'application/octet-stream', buffer: files.pptx },
    { name: '图片.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260"><rect width="400" height="260" rx="30" fill="#ccdfe9"/><text x="35" y="145" font-size="26">Knorvia Library</text></svg>') },
    { name: '页面.html', mimeType: 'text/html', buffer: Buffer.from('<h1>资料库页面</h1><button onclick="this.textContent=\'已点击\'">点击测试</button>') },
    { name: '大文件.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(700_000, 13) },
  ]);
  await expect(page.locator('.nl-file-row')).toHaveCount(7); await expect(page.locator('.nl-error')).toHaveCount(0);
  await page.locator('.nl-list-area').getByRole('button', { name: /^笔记.md/ }).click(); const editor = page.getByRole('complementary', { name: '资料预览与编辑' });
  await expect(editor.getByRole('heading', { name: '手动编辑验收' })).toBeVisible();
  await editor.getByRole('button', { name: '编辑这份资料', exact: true }).click(); await editor.getByRole('textbox', { name: '资料内容' }).fill('# 手动编辑验收\n\n保存后的中文正文');
  await page.keyboard.press('Control+s'); await expect(editor.getByRole('heading', { name: '手动编辑验收' })).toBeVisible();
  expect(await fs.readFile(path.join(library, folder, '笔记.md'), 'utf8')).toContain('保存后的中文正文');
  const fileUrl = page.url(); await page.reload(); await expect(editor).toContainText('保存后的中文正文');
  await editor.getByRole('button', { name: '版本历史', exact: true }).click(); await editor.locator('.nl-history button').last().click(); await expect(editor).toContainText('原始正文');
  await editor.getByRole('button', { name: '返回当前', exact: true }).click(); await expect(editor).toContainText('保存后的中文正文');
  // Two real Chrome clients: stale save must retain both the stored and draft content.
  const second = await context.newPage(); await second.goto(fileUrl); await expect(second.locator('.nl-inspector')).toContainText('保存后的中文正文');
  await editor.getByRole('button', { name: '编辑这份资料', exact: true }).click(); await editor.getByRole('textbox', { name: '资料内容' }).fill('另一个客户端不能覆盖我'); await editor.getByRole('button', { name: '保存', exact: true }).click(); await expect(editor.locator('.nl-progress')).toHaveCount(0);
  await second.locator('.nl-inspector').getByRole('button', { name: '编辑这份资料', exact: true }).click(); await second.getByRole('textbox', { name: '资料内容' }).fill('旧客户端修改'); await second.locator('.nl-inspector').getByRole('button', { name: '保存', exact: true }).click(); await expect(second.locator('.nl-editor-error')).toContainText('文件已有更新'); await expect(second.getByRole('textbox', { name: '资料内容' })).toHaveValue('旧客户端修改');
  expect(await fs.readFile(path.join(library, folder, '笔记.md'), 'utf8')).toBe('另一个客户端不能覆盖我'); await second.close();
  await page.bringToFront(); await editor.getByRole('button', { name: '关闭资料预览' }).click();
  await page.locator('.nl-folder-tree').getByRole('button', { name: folder, exact: true }).click();
  for (const [name, label, content] of [['文档.docx', '段落 1 · 1', 'Word 已修改'], ['演示.pptx', '幻灯片 1 · 1 · 1', '幻灯片已修改']]) {
    await page.locator('.nl-list-area').getByRole('button', { name: new RegExp(`^${name}`) }).click(); await editor.getByRole('button', { name: '编辑这份资料', exact: true }).click();
    await editor.getByRole('textbox', { name: label, exact: true }).fill(content); await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect(editor.getByRole('button', { name: '编辑这份资料', exact: true })).toBeVisible(); await expect(editor.locator('.nl-progress')).toHaveCount(0);
    const saved = await JSZip.loadAsync(await fs.readFile(path.join(library, folder, name)));
    const xml = name.endsWith('docx') ? 'word/document.xml' : 'ppt/slides/slide1.xml'; expect(await saved.file(xml)!.async('string')).toContain(content);
    const untouched = name.endsWith('docx') ? 'customXml/untouched.xml' : 'ppt/media/untouched.bin'; const original = await JSZip.loadAsync(name.endsWith('docx') ? files.docx : files.pptx);
    expect(await saved.file(untouched)!.async('nodebuffer')).toEqual(await original.file(untouched)!.async('nodebuffer'));
    await editor.getByRole('button', { name: '关闭资料预览' }).click();
  }
  await page.locator('.nl-list-area').getByRole('button', { name: /^表格.xlsx/ }).click(); await editor.getByRole('button', { name: '编辑这份资料', exact: true }).click();
  await editor.locator('[data-formula-bar]').fill('单元格已编辑'); await editor.locator('[data-formula-bar]').press('Enter'); await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor.locator('.nl-progress')).toHaveCount(0); await expect(editor.locator('[data-formula-bar]')).toHaveValue('单元格已编辑');
  const savedBook = new ExcelJS.Workbook(); await savedBook.xlsx.readFile(path.join(library, folder, '表格.xlsx')); expect(savedBook.worksheets[0].getCell('A1').value).toBe('单元格已编辑'); expect(savedBook.worksheets[0].getCell('A1').font.bold).toBe(true); expect(savedBook.worksheets[0].getCell('B4').value).toBe('保留其他内容');
  const savedXlsx = await JSZip.loadAsync(await fs.readFile(path.join(library, folder, '表格.xlsx'))); expect(await savedXlsx.file('customXml/untouched.xml')!.async('string')).toBe('<keep>Keep charts and data.</keep>');
  await editor.getByRole('button', { name: '关闭资料预览' }).click();
  await page.locator('.nl-list-area').getByRole('button', { name: /^图片.svg/ }).click(); await expect(editor.getByRole('img')).toBeVisible(); await page.screenshot({ path: info.outputPath('library-preview.png'), fullPage: true });
  for (const width of [1200, 800, 390, 320]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth && document.body.scrollHeight <= innerHeight + 1)).toBe(true); }
  await page.screenshot({ path: info.outputPath('library-mobile.png'), fullPage: true }); await page.setViewportSize({ width: 1800, height: 1060 });
  await editor.getByRole('button', { name: '关闭资料预览' }).click(); await page.locator('.nl-list-area').getByRole('button', { name: /^页面.html/ }).click(); await page.frameLocator('iframe[title="页面.html"]').getByRole('button', { name: '点击测试' }).click(); await expect(page.frameLocator('iframe[title="页面.html"]').getByRole('button')).toHaveText('已点击'); await editor.getByRole('button', { name: '关闭资料预览' }).click();
  await page.locator('.nl-list-area').getByRole('button', { name: /^大文件.bin/ }).click(); const download = page.waitForEvent('download'); await editor.getByRole('button', { name: '下载资料' }).click(); const downloaded = await download; expect((await fs.readFile((await downloaded.path())!)).equals(Buffer.alloc(700_000, 13))).toBe(true); await editor.getByRole('button', { name: '关闭资料预览' }).click();
  await page.locator('.nl-list-area').getByRole('button', { name: `资料操作: ${folder}/笔记.md`, exact: true }).click(); await page.getByRole('button', { name: '移入回收站', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '移入回收站', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '回收站', exact: true }).click(); await page.locator('.nl-list-area').getByRole('button', { name: /^笔记.md/ }).click(); await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); expect(await fs.readFile(path.join(library, folder, '笔记.md'), 'utf8')).toBe('另一个客户端不能覆盖我');
  await page.getByRole('button', { name: '我的资料', exact: true }).click(); await page.getByRole('button', { name: '让助手处理', exact: true }).click(); await page.getByLabel('你想怎么处理？').fill('[library-write] 接入真实资料库增改删验收'); await page.getByRole('button', { name: '开始对话', exact: true }).click();
  await expect(page).toHaveURL(/\/workbench\/task\//);
  await expect(page.locator('.nw-task-heading [data-status="completed"], .nw-approval')).toBeVisible({ timeout: 25_000 });
  if (await page.locator('.nw-approval').isVisible()) {
    await expect(page.locator('.nw-approval')).toContainText('isolated library required');
    await expect(page.locator('.nw-approval')).toContainText(path.join(home, 'personal-library'));
    await page.getByRole('button', { name: '允许这次操作', exact: true }).click();
  }
  await expect(page.locator('.nw-task-heading [data-status="completed"]')).toBeVisible({ timeout: 45_000 });
  expect(await fs.readFile(path.join(library, 'agent-created.md'), 'utf8')).toBe('created by actual Kernel'); expect(await fs.readFile(path.join(library, 'agent-edit.md'), 'utf8')).toBe('edited by actual Kernel'); await expect(fs.stat(path.join(library, 'agent-remove.md'))).rejects.toThrow();
  await page.getByRole('button', { name: '存入资料库', exact: true }).click(); await page.getByLabel('名称或资料库内路径', { exact: true }).fill(`助手回复-${id}.md`); await page.getByRole('button', { name: '保存到资料库', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); expect(await fs.readFile(path.join(library, `助手回复-${id}.md`), 'utf8')).toContain('fixture response');
  await page.getByRole('button', { name: '右侧工作面板', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '右侧工作面板', exact: true });
  await panel.locator('.nw-panel-launch-actions').getByRole('button', { name: /^文件/ }).click(); await panel.getByRole('button', { name: 'files', exact: true }).click(); await panel.getByRole('button', { name: 'agent-created.md', exact: true }).click();
  await panel.getByRole('button', { name: '存入资料库', exact: true }).click(); await page.getByLabel('名称或资料库内路径', { exact: true }).fill(`项目导入-${id}.md`); await page.getByRole('button', { name: '保存到资料库', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); expect(await fs.readFile(path.join(library, `项目导入-${id}.md`), 'utf8')).toBe('created by actual Kernel');
  await page.getByRole('link', { name: '资料库', exact: true }).click(); await expect(page.locator('.nl-list-area').getByRole('button', { name: /^agent-created.md/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('library-complete.png'), fullPage: true }); expect(errors).toEqual([]);
});

test('library media previews and all six themes remain usable on narrow layouts', async ({ page }, info) => {
  test.setTimeout(90_000);
  const library = path.join(path.dirname(workspace!), 'personal-library/files'); const name = `媒体-${Date.now()}`; await fs.mkdir(path.join(library, name));
  const wave = Buffer.alloc(1644); wave.write('RIFF'); wave.writeUInt32LE(1636, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(1600, 40); await fs.writeFile(path.join(library, name, '声音.wav'), wave);
  const stream = 'BT /F1 18 Tf 30 340 Td (Personal Library) Tj ET\n'; const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets: number[] = []; objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }); const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`; await fs.writeFile(path.join(library, name, '阅读.pdf'), pdf);
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('knorvia-language', 'zh'); }); await page.goto('/workbench/library'); await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
  await page.locator('.nl-folder-tree').getByRole('button', { name, exact: true }).click();
  const editor = page.locator('.nl-inspector'); await page.locator('.nl-list-area').getByRole('button', { name: /^声音.wav/ }).click(); await expect(editor.locator('audio')).toBeVisible(); await expect.poll(() => editor.locator('audio').evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThan(0); await editor.getByRole('button', { name: '关闭资料预览' }).click();
  await page.locator('.nl-list-area').getByRole('button', { name: /^阅读.pdf/ }).click(); await expect(editor.locator('iframe')).toHaveAttribute('src', /^blob:/); await editor.getByRole('button', { name: '关闭资料预览' }).click();
  // A self-generated six-frame VP8 test pattern; a fixed sample avoids headless canvas capture timing.
  const movie = await fs.readFile(path.join(process.cwd(), 'tests/fixtures/library-test-pattern.webm'));
  await page.locator('.nl-list-area input[type=file]').setInputFiles({ name: '视频.webm', mimeType: 'video/webm', buffer: movie }); await page.locator('.nl-list-area').getByRole('button', { name: /^视频.webm/ }).click(); await expect.poll(() => editor.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThan(0); await editor.getByRole('button', { name: '关闭资料预览' }).click();
  const palettes = JSON.parse(await fs.readFile(path.join(process.cwd(), 'lib/appearance-palettes.json'), 'utf8'));
  for (const theme of Object.keys(palettes)) for (const frost of [false, true]) {
    await page.evaluate(({ theme, frost }) => { localStorage.setItem('knorvia-theme', theme); localStorage.setItem('knorvia-window-frost', String(frost)); window.dispatchEvent(new StorageEvent('storage', { key: 'knorvia-theme' })); }, { theme, frost });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme); expect(await page.locator('html').getAttribute('data-window-frost') !== null).toBe(frost);
    await page.setViewportSize({ width: frost ? 390 : 1600, height: 1000 }); expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth && document.body.scrollHeight <= innerHeight + 1)).toBe(true);
  }
  await page.screenshot({ path: info.outputPath('library-theme-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.getByRole('button', { name: '取消', exact: true }).click();
});

test('library content search finds text inside files and jumps to the hit', async ({ page }, info) => {
  test.setTimeout(90_000);
  const library = path.join(path.dirname(workspace!), 'personal-library/files');
  await fs.mkdir(path.join(library, '搜索验收'), { recursive: true });
  await fs.writeFile(path.join(library, '搜索验收', '深挖.md'), '# 笔记\n\n只有这一行写着夜枭观测站。Codex 内容验收。\n');
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('knorvia-language', 'zh'); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/workbench/library');
  await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
  const searchBox = page.getByLabel('搜索资料名称或路径', { exact: true });
  await searchBox.fill('夜枭观测站');
  const hit = page.locator('.nl-content-hit', { hasText: '搜索验收/深挖.md' });
  await expect(hit).toContainText('夜枭观测站', { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: '没有找到资料', exact: true })).toHaveCount(0);
  await page.getByLabel('资料类型', { exact: true }).selectOption('image');
  await expect(hit).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '没有找到资料', exact: true })).toBeVisible();
  await page.getByLabel('资料类型', { exact: true }).selectOption('all');
  await searchBox.fill('不存在的内容验收词');
  await expect(hit).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '没有找到资料', exact: true })).toBeVisible();
  await searchBox.fill('codex');
  await expect(hit).toContainText('Codex');
  await expect(page.getByRole('heading', { name: '没有找到资料', exact: true })).toHaveCount(0);
  await hit.click();
  await expect(page.locator('.nl-inspector')).toContainText('夜枭观测站');
  await page.screenshot({ path: info.outputPath('library-content-search.png'), fullPage: true });
});
