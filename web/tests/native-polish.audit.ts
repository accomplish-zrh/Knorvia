import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

const workspace = process.env.KNORVIA_UI_FIXTURE_WORKSPACE;
test.skip(!workspace, 'Requires isolated native gateway and actual Kernel');
test.use({ locale: 'zh-CN', screenshot: 'only-on-failure' });

test('library drafts survive reload, preserve original revisions, and save conflicts as new files', async ({ page }, info) => {
  test.setTimeout(90_000);
  expect(workspace!.replaceAll('\\', '/')).toContain('/isolated-home/workspace');
  const library = path.join(path.dirname(workspace!), 'personal-library/files'), folder = `草稿验收-${Date.now()}`;
  await fs.mkdir(path.join(library, folder), { recursive: true });
  await fs.writeFile(path.join(library, folder, '笔记.md'), '# 原文件\n\n尚未修改');
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('计划'); sheet.getCell('A1').value = '修改前'; sheet.getCell('A1').font = { bold: true }; sheet.getCell('B2').value = '保持';
  await book.xlsx.writeFile(path.join(library, folder, '计划.xlsx'));
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('knorvia-language', 'zh'); });
  await page.setViewportSize({ width: 1600, height: 1000 }); await page.goto('/workbench/library');
  await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
  await page.locator('.nl-folder-tree').getByRole('button', { name: folder, exact: true }).click();
  await page.locator('.nl-folder-tree').getByRole('button', { name: '笔记.md', exact: true }).click();
  const editor = page.locator('.nl-inspector');
  await editor.getByRole('button', { name: '编辑这份资料', exact: true }).click();
  await page.getByRole('textbox', { name: '资料内容', exact: true }).fill('# 我的未保存修改\n\n中文草稿不应丢失');
  await expect(page.locator('.nl-draft-bar')).toContainText('草稿已保留');
  await page.reload();
  await expect(page.getByRole('textbox', { name: '资料内容', exact: true })).toHaveValue(/中文草稿不应丢失/);
  await expect(page.locator('.nl-draft-bar')).toContainText('已恢复未保存的修改');
  const draftDownload = page.waitForEvent('download'); await editor.getByRole('button', { name: '下载资料', exact: true }).click();
  expect(await fs.readFile((await (await draftDownload).path())!, 'utf8')).toContain('中文草稿不应丢失');
  expect(await fs.readFile(path.join(library, folder, '笔记.md'), 'utf8')).toBe('# 原文件\n\n尚未修改');
  // A different writer changes the real file while this window has a draft.
  await fs.writeFile(path.join(library, folder, '笔记.md'), '# 另一处保存的内容');
  await page.reload();
  await expect(page.getByRole('textbox', { name: '资料内容', exact: true })).toHaveValue(/中文草稿不应丢失/);
  await expect(page.locator('.nl-draft-bar')).toContainText('原文件已有更新');
  await editor.getByRole('button', { name: '另存为', exact: true }).click();
  await page.getByLabel('副本名称或路径', { exact: true }).fill(`${folder}/保留的修改.md`);
  await page.keyboard.press('Control+s'); await expect(page.getByRole('dialog')).toBeVisible();
  expect(await fs.readFile(path.join(library, folder, '笔记.md'), 'utf8')).toBe('# 另一处保存的内容');
  await page.getByRole('button', { name: '保存副本', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(editor.getByRole('heading', { name: '我的未保存修改', exact: true })).toBeVisible();
  const copiedURL = page.url(); await page.reload(); expect(page.url()).toBe(copiedURL);
  await expect(editor.getByRole('heading', { name: '我的未保存修改', exact: true })).toBeVisible();
  expect(await fs.readFile(path.join(library, folder, '笔记.md'), 'utf8')).toBe('# 另一处保存的内容');
  expect(await fs.readFile(path.join(library, folder, '保留的修改.md'), 'utf8')).toContain('中文草稿不应丢失');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await page.locator('.nl-folder-tree').getByRole('button', { name: '计划.xlsx', exact: true }).click();
  await editor.getByRole('button', { name: '编辑这份资料', exact: true }).click();
  await editor.locator('[data-formula-bar]').fill('刷新后保留'); await editor.locator('[data-formula-bar]').press('Enter');
  await expect(page.locator('.nl-draft-bar')).toContainText('草稿已保留'); await page.reload();
  await expect(editor.locator('[data-formula-bar]')).toHaveValue('刷新后保留');
  await page.screenshot({ path: info.outputPath('library-restored-spreadsheet.png'), fullPage: true });
  await editor.getByRole('button', { name: '保存', exact: true }).click(); await expect(page.locator('.nl-draft-bar')).toHaveCount(0);
  const saved = new ExcelJS.Workbook(); await saved.xlsx.readFile(path.join(library, folder, '计划.xlsx'));
  expect(saved.worksheets[0].getCell('A1').value).toBe('刷新后保留'); expect(saved.worksheets[0].getCell('A1').font.bold).toBe(true); expect(saved.worksheets[0].getCell('B2').value).toBe('保持');
});

test('accepted sends survive lost acknowledgements and read failures without duplicate turns; attachment drafts restore', async ({ page }, info) => {
  test.setTimeout(100_000);
  let failRead = 0, loseAcknowledgement = false, lost = false, delayConnectionRead = false;
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  // Only response delivery is faulted. Every operation reaches the actual daemon.
  await page.routeWebSocket('**/knorvia/native', socket => {
    const server = socket.connectToServer(), methods = new Map<string | number, string>();
    socket.onMessage(message => { const request = JSON.parse(String(message)); if (request.method) { methods.set(request.id, request.method); sent.push(request); } server.send(message); });
    server.onMessage(message => {
      const response = JSON.parse(String(message)), method = methods.get(response.id);
      if (response.result && method === 'connection/read' && delayConnectionRead) { setTimeout(() => socket.send(message), 2000); return; }
      if (response.result && method === 'turn/start') {
        if (loseAcknowledgement) { loseAcknowledgement = false; lost = true; socket.send(JSON.stringify({ jsonrpc: '2.0', id: response.id, error: { code: -32098, message: '验收：响应交付中断，保留这次提交重试' } })); return; }
        failRead = 2;
      }
      if (response.result && method === 'thread/read' && failRead > 0) { failRead--; socket.send(JSON.stringify({ jsonrpc: '2.0', id: response.id, error: { code: -32098, message: '验收：读取暂时失败' } })); return; }
      socket.send(message);
    });
  });
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('knorvia-language', 'zh'); }); await page.goto('/workbench');
  await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
  const prompt = `发送恢复 ${Date.now()}`;
  await page.getByRole('textbox', { name: '任务描述', exact: true }).fill(prompt);
  await page.locator('.nw-composer input[type=file]').setInputFiles({ name: '上下文.txt', mimeType: 'text/plain', buffer: Buffer.from('附件草稿必须恢复') });
  await expect(page.locator('.nw-attachments')).toContainText('上下文.txt'); await page.reload();
  await expect(page.locator('.nw-attachments')).toContainText('上下文.txt');
  await expect(page.getByRole('textbox', { name: '任务描述', exact: true })).toHaveValue(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page).toHaveURL(/\/workbench\/task\//);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('knorvia-native-draft:new'))).toBe(null);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('knorvia-native-draft:new:attachments'))).toBe(null);
  await expect(page.locator('.nw-task-heading [data-status="completed"]')).toBeVisible({ timeout: 25_000 });
  expect(sent.filter(request => request.method === 'turn/start')).toHaveLength(1);
  expect(String(sent.find(request => request.method === 'turn/start')?.params.input)).toContain('附件草稿必须恢复');
  loseAcknowledgement = true;
  const input = page.locator('.nw-task-composer textarea').first(); await input.fill('这次只执行一遍');
  await page.getByRole('button', { name: '发送任务', exact: true }).click(); await expect.poll(() => lost).toBe(true);
  await expect(input).toHaveValue('这次只执行一遍');
  await expect(page.locator('.nw-task-heading [data-status="completed"]')).toBeVisible({ timeout: 25_000 });
  delayConnectionRead = true;
  await page.reload(); await expect(input).toHaveValue('这次只执行一遍');
  await page.getByRole('button', { name: '发送任务', exact: true }).click(); await expect(input).toHaveValue('');
  await expect(page.locator('.nw-user-message')).toHaveCount(2);
  const retries = sent.filter(request => request.method === 'turn/start' && request.params.input === '这次只执行一遍');
  await info.attach('retry-requests', { body: JSON.stringify(retries, null, 2), contentType: 'application/json' });
  expect(retries).toHaveLength(2); expect(retries[0].params.idempotencyKey).toBe(retries[1].params.idempotencyKey);
  expect(sent.filter(request => request.method === 'thread/start')).toHaveLength(1);
});

test('reading preferences, busy dialogs, automation filters and output previews work in the actual workspace', async ({ page, context }, info) => {
  test.setTimeout(120_000);
  const title = `打磨验收 ${Date.now()}`;
  let releaseCreate: (() => void) | undefined;
  await page.routeWebSocket('**/knorvia/native', socket => {
    const server = socket.connectToServer(), methods = new Map<string | number, string>();
    socket.onMessage(message => { const request = JSON.parse(String(message)); if (request.method) methods.set(request.id, request.method); server.send(message); });
    server.onMessage(message => {
      const response = JSON.parse(String(message));
      if (response.result && methods.get(response.id) === 'automation/create') { releaseCreate = () => socket.send(message); return; }
      socket.send(message);
    });
  });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('knorvia-language', 'zh'); });
  await page.setViewportSize({ width: 1600, height: 1000 }); await page.goto('/workbench');
  await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
  await page.getByRole('textbox', { name: '任务描述', exact: true }).fill(title);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.nw-task-heading [data-status="completed"]')).toBeVisible({ timeout: 25_000 });
  const taskURL = page.url();
  await page.keyboard.press('Control+,'); await expect(page).toHaveURL(/\/settings/);
  await page.getByRole('link', { name: '外观', exact: true }).click();
  const size = page.getByRole('slider', { name: '阅读字号', exact: true }); await size.focus(); await page.keyboard.press('End');
  await expect(size).toHaveValue('20'); await page.getByRole('button', { name: '宽松', exact: true }).click();
  await page.getByRole('switch', { name: '减少动效', exact: true }).click();
  await expect(page.locator('.nw-root')).toHaveAttribute('data-reduce-motion', 'true');
  const other = await context.newPage(); await other.goto('/workbench/settings/appearance');
  await expect(other.getByRole('slider', { name: '阅读字号', exact: true })).toHaveValue('20');
  await other.getByRole('button', { name: '专注', exact: true }).click();
  await expect(page.getByRole('button', { name: '专注', exact: true })).toHaveAttribute('aria-pressed', 'true'); await other.close();
  await page.screenshot({ path: info.outputPath('reading-comfort.png'), fullPage: true });
  await page.getByRole('link', { name: '返回应用', exact: true }).first().click(); await expect(page).toHaveURL(taskURL);
  await expect(page.locator('.nw-task-content')).toHaveCSS('max-width', '800px');
  await expect(page.locator('.nw-user-message')).toHaveCSS('font-size', '20px');
  await page.reload(); await expect(page.locator('.nw-user-message')).toHaveCSS('font-size', '20px');
  await page.getByRole('button', { name: '保存为成果', exact: true }).click(); await expect(page.locator('.nw-toast')).toContainText('成果');
  await page.goto('/workbench/artifacts'); await page.locator('.nw-output-row').filter({ hasText: title }).click();
  const reader = page.locator('.nw-output-reader'); await reader.getByRole('button', { name: '编辑', exact: true }).click();
  await reader.getByRole('textbox', { name: '成果内容', exact: true }).fill('# 实时预览\n\n这一版还没保存');
  await reader.getByRole('button', { name: '预览', exact: true }).click(); await expect(reader.getByRole('heading', { name: '实时预览' })).toBeVisible();
  const downloadPromise = page.waitForEvent('download'); await reader.getByRole('button', { name: '下载', exact: true }).click();
  const downloaded = await downloadPromise; expect(await fs.readFile((await downloaded.path())!, 'utf8')).toContain('这一版还没保存');
  page.once('dialog', dialog => dialog.dismiss()); await reader.getByRole('button', { name: '关闭成果', exact: true }).click(); await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: '保存新版本', exact: true }).click(); await expect(reader.getByRole('button', { name: '保存新版本', exact: true })).toBeDisabled();
  await reader.getByRole('button', { name: '存入资料库', exact: true }).click();
  await page.getByLabel('名称或资料库内路径', { exact: true }).fill(`${title}.md`); await page.getByRole('button', { name: '保存到资料库', exact: true }).click(); await expect(page.locator('dialog')).toHaveCount(0);
  expect(await fs.readFile(path.join(path.dirname(workspace!), 'personal-library/files', `${title}.md`), 'utf8')).toContain('这一版还没保存');
  await reader.getByRole('button', { name: '上一版本', exact: true }).click(); await expect(reader.locator('.nw-markdown')).toContainText('scripted native fixture response');
  await reader.getByRole('button', { name: '回到当前', exact: true }).click(); await expect(reader.getByRole('heading', { name: '实时预览' })).toBeVisible();
  await page.getByRole('link', { name: '自动化', exact: true }).click(); await page.getByRole('button', { name: '新建自动化', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('名称', { exact: true }).fill(title); await dialog.getByLabel('希望它完成什么', { exact: true }).fill('仅检查隔离验收项目');
  await dialog.getByRole('button', { name: '创建并启用', exact: true }).click(); await expect.poll(() => Boolean(releaseCreate)).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible(); await expect(dialog.getByLabel('名称', { exact: true })).toBeDisabled();
  await page.keyboard.press('Control+,'); await expect(page).toHaveURL(/\/automations$/); releaseCreate!(); await expect(dialog).toHaveCount(0);
  await page.getByRole('searchbox', { name: '搜索自动化', exact: true }).fill(title);
  const card = page.locator('.nw-automation'); await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: `暂停: ${title}`, exact: true }).click(); await expect(card.locator('.nw-automation-state')).toHaveText('已暂停');
  await page.getByRole('group', { name: '自动化状态', exact: true }).getByRole('button', { name: /^已启用/ }).click(); await expect(page.getByRole('heading', { name: '没有匹配的自动化' })).toBeVisible();
  await page.getByRole('group', { name: '自动化状态', exact: true }).getByRole('button', { name: /^已暂停/ }).click(); await expect(card).toHaveCount(1);
  for (const width of [1600, 390, 320]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth && document.body.scrollHeight <= innerHeight + 1)).toBe(true); }
  await page.screenshot({ path: info.outputPath('automations-320.png'), fullPage: true }); await page.setViewportSize({ width: 1600, height: 1000 });
  await card.getByRole('button', { name: `删除: ${title}`, exact: true }).click(); await dialog.getByRole('button', { name: '删除计划', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('tool icons distinguish categories and states, with accessible fallback for unknown tools', async ({ page }, info) => {
  test.setTimeout(60_000);
  // A read-only presentation fixture: these extra records are never executed or
  // written into the daemon. Actual Kernel execution is covered by the other journeys.
  const records = [
    { kind: 'commandExecution', status: 'completed', payload: { command: '读取工作文件', commandActions: [{ type: 'read' }], exitCode: 0 } },
    { kind: 'commandExecution', status: 'completed', payload: { command: '执行检查', exitCode: 1, aggregatedOutput: '可展开查看失败详情' } },
    { kind: 'fileChange', status: 'completed', payload: { changes: [{ path: '工作计划.md', diff: '+ 修订后的内容' }] } },
    { kind: 'mcpToolCall', status: 'inProgress', payload: { server: 'Chrome', tool: 'navigate' } },
    { kind: 'webSearch', status: 'completed', payload: { query: '查找参考资料' } },
    { kind: 'mcpToolCall', status: 'completed', payload: { server: 'image_gen', tool: 'imagegen' } },
    { kind: 'collabAgentToolCall', status: 'interrupted', payload: { tool: 'spawn_agent' } },
    { kind: 'mcpToolCall', status: 'completed', payload: { server: 'personal_library', tool: 'read_file' } },
    { kind: 'dynamicToolCall', status: 'waiting_input', payload: { tool: 'automation_update' } },
    { kind: 'mcpToolCall', status: 'completed', payload: { server: 'spreadsheets', tool: 'read_workbook' } },
    { kind: 'mcpToolCall', status: 'completed', payload: { server: 'presentations', tool: 'render_slide' } },
    { kind: 'futureTool', status: 'unknown', payload: { detail: '未来新增的工具仍能查看原始详情' } },
  ];
  await page.routeWebSocket('**/knorvia/native', socket => {
    const server = socket.connectToServer(), methods = new Map<string | number, string>();
    socket.onMessage(message => { const request = JSON.parse(String(message)); if (request.method) methods.set(request.id, request.method); server.send(message); });
    server.onMessage(message => {
      const response = JSON.parse(String(message)), snapshot = response.result;
      if (methods.get(response.id) === 'thread/read' && snapshot?.items && !snapshot.activeTurn) {
        const seq = Math.max(0, ...snapshot.items.map((item: { seq: number }) => item.seq));
        snapshot.items.push(...records.map((item, index) => ({ ...item, id: `icon-fixture-${index}`, seq: seq + index + 1, threadId: snapshot.id, turnId: snapshot.lastTurn?.id ?? '' })));
        socket.send(JSON.stringify(response)); return;
      }
      socket.send(message);
    });
  });
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('knorvia-language', 'zh'); });
  await page.setViewportSize({ width: 1600, height: 1000 }); await page.goto('/workbench');
  await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
  await page.getByRole('textbox', { name: '任务描述', exact: true }).fill(`工具图标验收 ${Date.now()}`); await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.nw-task-heading [data-status="completed"]')).toBeVisible({ timeout: 25_000 }); await page.reload();
  for (const category of ['terminal', 'read', 'edit', 'browser', 'search', 'image', 'agent', 'library', 'automation', 'spreadsheet', 'presentation', 'tool']) await expect(page.locator(`[data-tool-category="${category}"]`).first()).toBeVisible();
  for (const state of ['running', 'done', 'failed', 'stopped', 'waiting']) await expect(page.locator(`[data-tool-state="${state}"]`).first()).toBeVisible();
  const unknown = page.locator('[data-tool-kind="futureTool"]'); await unknown.locator('summary').focus(); await page.keyboard.press('Enter'); await expect(unknown.locator('pre')).toContainText('未来新增的工具仍能查看原始详情');
  await page.screenshot({ path: info.outputPath('tool-icons-light.png'), fullPage: true });
  await page.evaluate(() => { localStorage.setItem('knorvia-theme', 'dark'); window.dispatchEvent(new StorageEvent('storage', { key: 'knorvia-theme', newValue: 'dark' })); });
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await expect(page.locator('[data-tool-category=browser]').first()).toBeVisible(); await page.screenshot({ path: info.outputPath('tool-icons-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth && document.body.scrollHeight <= innerHeight + 1)).toBe(true);
});
