import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
const origin = process.env.KNORVIA_NIGHT_IMAGE_ORIGIN;
test.skip(!process.env.KNORVIA_UI_FIXTURE_WORKSPACE || !origin, 'Requires the isolated local studio gateway');
test.use({ locale: 'zh-CN' });
declare global { interface Window { __sequenceSockets: WebSocket[] } }
async function rpc<T>(page: Page, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(async ({ method, params }) => {
    const found = window.__sequenceSockets.find(socket => socket.readyState === WebSocket.OPEN && socket.protocol.includes('knorvia'));
    if (!found) throw Error('No connected native fixture socket');
    const socket: WebSocket = found;
    const id = 'sequence-audit-' + crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(Error('Fixture RPC timeout: ' + method)); }, 20000);
      function receive(event: MessageEvent) {
        let response; try { response = JSON.parse(String(event.data)); } catch { return; }
        if (response.id !== id) return;
        clearTimeout(timer); socket.removeEventListener('message', receive);
        if (response.error) reject(Error(response.error.message)); else resolve(response.result);
      }
      socket.addEventListener('message', receive); socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }, { method, params }) as Promise<T>;
}
test('storyboard persists 200 stable shots, reorders across pages, edits pinned templates, retries one submission and chains real video tails', async ({ page }, info) => {
  test.setTimeout(240000);
  const observations: { method: string; params: Record<string, unknown> }[] = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    try { const data = JSON.parse(String(payload)); if (data.method?.startsWith('studio/sequence/')) observations.push({ method: data.method, params: data.params }); } catch {}
  }));
  await page.addInitScript(() => {
    localStorage.setItem('knorvia-language', 'zh');
    const Original = window.WebSocket; window.__sequenceSockets = [];
    window.WebSocket = class extends Original { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); window.__sequenceSockets.push(this); } };
  });
  await page.setViewportSize({ width: 1480, height: 1000 });
  await page.goto('/workbench/studio');
  await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  const label = '分镜本机验收-' + Date.now();
  await dialog.getByLabel('连接名称', { exact: true }).fill(label);
  await dialog.getByLabel('媒体类型', { exact: true }).selectOption('video');
  await dialog.getByLabel('接口协议').selectOption('fal');
  await dialog.getByLabel('接口地址', { exact: true }).fill(origin!);
  await dialog.getByLabel('模型名称或端点', { exact: true }).fill('fal-ai/fixture/video');
  await dialog.getByLabel('视频图像输入', { exact: true }).selectOption('first');
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const profiles = await rpc<{ profiles: { id: string; name: string }[] }>(page, 'studio/models');
  const profileId = profiles.profiles.find(profile => profile.name === label)!.id;
  expect(profileId).toBeTruthy();
  const template = await rpc<{ id: string; revision: number }>(page, 'studio/template/save', { name: label + '-模板', kind: 'video', prompt: '{{character}} 走进 {{scene}}', defaults: { scene: '雨后的庭院' } });
  const title = '200镜头-' + Date.now();
  await page.evaluate(({ profileId, title }) => {
    const shots = Array.from({ length: 200 }, (_, index) => ({ id: crypto.randomUUID(), prompt: '场景 ' + (index + 1), profileId, seconds: 4, continuity: index ? 'previous-tail' : 'none' }));
    localStorage.setItem('knorvia.studio.sequence.editor.v2', JSON.stringify({ draft: { title, globalPrompt: '银色光线，稳定角色', profileId, seconds: 4, shots } }));
  }, { profileId, title });
  await page.reload();
  await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
  await page.locator('.ns-sequence-toggle').click();
  const editor = page.locator('.ns-sequence-editor');
  await expect(editor.locator('.ns-shot-row')).toHaveCount(20);
  const movedId = await editor.locator('.ns-shot-row').nth(19).getAttribute('data-shot-id');
  await editor.getByLabel('分镜 20 提示词', { exact: true }).press('Alt+ArrowDown');
  await expect(editor.getByLabel('分镜 21 提示词', { exact: true })).toBeFocused();
  await expect(editor.locator('.ns-shot-row').first()).toHaveAttribute('data-shot-id', movedId!);
  await editor.getByLabel('分镜 21 秒数', { exact: true }).fill('6');
  await page.waitForTimeout(350);
  await page.reload(); await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/); await page.locator('.ns-sequence-toggle').click();
  await expect(editor.getByLabel('队列名称', { exact: true })).toHaveValue(title);
  await editor.getByRole('navigation', { name: '分镜编辑分页', exact: true }).getByRole('button', { name: '下一页' }).click();
  await expect(editor.locator('.ns-shot-row').first()).toHaveAttribute('data-shot-id', movedId!);
  await expect(editor.getByLabel('分镜 21 秒数', { exact: true })).toHaveValue('6');
  await editor.getByRole('navigation', { name: '分镜编辑分页', exact: true }).getByRole('button', { name: '上一页' }).click();
  await editor.getByLabel('分镜 1 模板', { exact: true }).selectOption(template.id);
  await expect(editor.getByRole('button', { name: '保存队列', exact: true })).toBeDisabled();
  await editor.getByLabel('分镜 1 变量 character', { exact: true }).fill('小狐狸');
  await expect(editor).toContainText('小狐狸 走进 雨后的庭院');
  await editor.getByRole('button', { name: '保存队列', exact: true }).click();
  const item = page.locator('.ns-sequence-item', { has: page.locator('.ns-sequence-title', { hasText: title }) });
  await expect(item).toContainText('待开始', { timeout: 30000 });
  const create = observations.find(observation => observation.method === 'studio/sequence/create' && observation.params.title === title)!;
  expect((create.params.shots as unknown[]).length).toBe(200);
  const records = await rpc<{ sequences: { id: string; title: string; revision: number; shots: { id: string; templateSnapshot?: string }[] }[] }>(page, 'studio/sequence/list', { offset: 0, limit: 50 });
  const saved = records.sequences.find(sequence => sequence.title === title)!;
  expect(saved.shots[20].id).toBe(movedId);
  expect(saved.shots[0].templateSnapshot).toBe('小狐狸 走进 雨后的庭院');
  await item.getByRole('button', { name: '编辑分镜', exact: true }).click();
  await editor.getByLabel('分镜 2 提示词', { exact: true }).fill('新的第二幕');
  await editor.getByLabel('分镜 2 秒数', { exact: true }).fill('8');
  await editor.getByRole('button', { name: '保存分镜修改', exact: true }).click();
  await expect(item).toContainText('新的第二幕');
  // Replay exactly the accepted create request after a simulated lost reply.
  await page.evaluate(({ params }) => {
    const defaults = params.defaults as { profileId: string; seconds: number };
    const draft = { title: params.title, globalPrompt: params.globalPrompt, ...defaults, shots: params.shots };
    localStorage.setItem('knorvia.studio.sequence.editor.v2', JSON.stringify({ draft, pending: { idempotencyKey: params.idempotencyKey, start: params.start, draft } }));
  }, { params: create.params });
  await page.reload(); await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/); await page.locator('.ns-sequence-toggle').click();
  await page.getByRole('button', { name: '确认提交结果', exact: true }).click();
  await expect(page.locator('.ns-sequence-pending')).toHaveCount(0);
  const replayed = await rpc<{ sequences: { id: string; title: string }[] }>(page, 'studio/sequence/list', { offset: 0, limit: 50 });
  expect(replayed.sequences.filter(sequence => sequence.title === title).map(sequence => sequence.id)).toEqual([saved.id]);
  const chainTitle = '真实尾帧三段-' + Date.now();
  await editor.getByLabel('队列名称', { exact: true }).fill(chainTitle);
  await editor.getByLabel('通用提示词', { exact: true }).fill('同一个狐狸主角，电影质感');
  await editor.getByLabel('分镜 1 提示词', { exact: true }).fill(chainTitle + ' 第一幕');
  for (let i = 2; i <= 3; i++) { await editor.getByRole('button', { name: '添加分镜', exact: true }).click(); await editor.getByLabel('分镜 ' + i + ' 提示词', { exact: true }).fill(chainTitle + ' 第' + i + '幕'); }
  await editor.getByRole('button', { name: '开始生成整个队列', exact: true }).click();
  const chain = page.locator('.ns-sequence-item', { has: page.locator('.ns-sequence-title', { hasText: chainTitle }) });
  await expect.poll(async () => { await fetch(origin + '/__night/release-video'); return chain.locator('.ns-state-badge').textContent(); }, { timeout: 75000, intervals: [500, 1000, 1000] }).toBe('已完成');
  await expect(chain.locator('.ns-sequence-progress')).toHaveText('3/3');
  const requests = await (await fetch(origin + '/__night/requests')).json() as { body?: { prompt?: string; image_url?: string } }[];
  const receipts = requests.filter(request => request.body?.prompt?.includes(chainTitle));
  expect(receipts).toHaveLength(3);
  expect(JSON.stringify(receipts[1])).toContain('data:image/png;base64,');
  expect(JSON.stringify(receipts[2])).toContain('data:image/png;base64,');
  await page.screenshot({ path: info.outputPath('sequence-functional-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 480, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('sequence-functional-narrow.png'), fullPage: true });
  const evidence = path.resolve('../release/codex-integration-20260908/runtime/sequence-ui-result.json');
  fs.writeFileSync(evidence, JSON.stringify({ title, savedId: saved.id, chainTitle, movedId, requests: observations.filter(observation => /create|update/.test(observation.method)), chainReceipts: receipts }, null, 2));
});
