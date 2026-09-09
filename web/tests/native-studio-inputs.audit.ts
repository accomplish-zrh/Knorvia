import { expect, test, type Page } from '@playwright/test';

const workspace = process.env.KNORVIA_UI_FIXTURE_WORKSPACE;
const origin = process.env.KNORVIA_NIGHT_IMAGE_ORIGIN;
test.skip(!workspace || !origin, 'Requires an isolated native studio fixture');
test.use({ locale: 'zh-CN' });

async function connect(page: Page, name: string, kind: 'image' | 'video', frames = false) {
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await dialog.getByLabel('连接名称', { exact: true }).fill(name);
  await dialog.getByLabel('媒体类型', { exact: true }).selectOption(kind);
  await dialog.getByLabel('接口协议').selectOption(frames ? 'fal' : 'openai');
  await dialog.getByLabel('接口地址', { exact: true }).fill(frames ? origin! : `${origin}/v1`);
  await dialog.getByLabel('模型名称或端点', { exact: true }).fill(frames ? 'fal-ai/fixture/video' : 'fixture-model');
  if (frames) await dialog.getByLabel('视频图像输入', { exact: true }).selectOption('start-end');
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test('reference images and first/last frames retain their identity through upload, reload, swap, provider submission and reuse', async ({ page }, info) => {
  test.setTimeout(180_000);
  expect(workspace!.replaceAll('\\', '/')).toContain('/isolated-home/workspace');
  await page.addInitScript(() => localStorage.setItem('knorvia-language', 'zh'));
  await page.setViewportSize({ width: 1500, height: 980 });
  await page.goto('/workbench/studio');
  await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
  const encoded = await page.evaluate(() => ['#d93939', '#2684dc'].map(color => {
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 24;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = color; ctx.fillRect(0, 0, 40, 24);
    return canvas.toDataURL('image/png').split(',')[1];
  }));
  const files = encoded.map((base64, index) => ({ name: index ? '蓝色结尾.png' : '红色开场.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') }));
  await connect(page, '参考图验收', 'image');
  await page.getByTestId('studio-reference-upload').setInputFiles(files);
  await expect(page.locator('.ns-reference-tile img')).toHaveCount(2);
  await expect.poll(() => page.locator('.ns-reference-tile img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth === 40))).toBe(true);
  await page.getByLabel('创作描述', { exact: true }).fill('参考图字节验收');
  await page.reload();
  await expect(page.locator('.ns-reference-tile img')).toHaveCount(2);
  await page.getByRole('button', { name: '移除参考图: 蓝色结尾.png', exact: true }).click();
  await expect(page.locator('.ns-reference-tile')).toHaveCount(1);
  // Paste an actual image file into the composer; it traverses the same upload path.
  await page.locator('.ns-composer').evaluate((el, base64) => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const clipboardData = new DataTransfer(); clipboardData.items.add(new File([bytes], '蓝色结尾.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, encoded[1]);
  await expect(page.locator('.ns-reference-tile img')).toHaveCount(2);
  await page.getByRole('button', { name: '开始创作', exact: true }).click();
  await expect(page.locator('.ns-job', { hasText: '参考图字节验收' }).first()).toHaveAttribute('data-phase', 'completed', { timeout: 30_000 });
  const imageRequests = await (await fetch(`${origin}/__night/requests`)).json();
  const image = imageRequests.find((request: { fields?: { name: string; value: string }[] }) => request.fields?.some(field => field.name === 'prompt' && field.value === '参考图字节验收'));
  expect(image.url).toBe('/v1/images/edits');
  expect(image.fields.filter((field: { name: string }) => field.name === 'image[]').map((field: { base64: string }) => field.base64)).toEqual(encoded);

  await page.locator('.ns-kind').getByRole('button', { name: '视频', exact: true }).click();
  await connect(page, '首尾帧验收', 'video', true);
  for (const [index, label] of ['上传 首帧', '上传 尾帧'].entries()) {
    const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: label, exact: true }).click(); await (await chooser).setFiles(files[index]);
  }
  await expect(page.locator('.ns-frame img')).toHaveCount(2);
  await page.getByRole('button', { name: '交换首尾帧', exact: true }).click();
  await page.reload();
  await expect(page.locator('[data-frame="firstFrame"]')).toContainText('蓝色结尾.png');
  await expect(page.locator('[data-frame="lastFrame"]')).toContainText('红色开场.png');
  // A connection without a last-frame contract must keep the file and block submission.
  await connect(page, '仅首帧验收', 'video');
  await expect(page.locator('.ns-input-issue')).toContainText('未配置尾帧支持');
  await expect(page.getByRole('button', { name: '开始创作', exact: true })).toBeDisabled();
  await expect(page.locator('[data-frame="lastFrame"]')).toContainText('红色开场.png');
  await page.getByLabel('创作模型', { exact: true }).selectOption({ label: '首尾帧验收' });
  await page.getByLabel('创作描述', { exact: true }).fill('首尾帧字节验收');
  await page.screenshot({ path: info.outputPath('studio-first-last-frames.png'), fullPage: true });
  await page.getByRole('button', { name: '开始创作', exact: true }).click();
  const job = page.locator('.ns-job', { hasText: '首尾帧字节验收' }).first();
  await expect.poll(async () => { await fetch(`${origin}/__night/release-video`); return job.getAttribute('data-phase'); }, { timeout: 60_000 }).toBe('completed');
  const requests = await (await fetch(`${origin}/__night/requests`)).json();
  const video = requests.find((request: { body?: { prompt: string } }) => request.body?.prompt === '首尾帧字节验收');
  expect(video.body.start_image_url).toBe(`data:image/png;base64,${encoded[1]}`);
  expect(video.body.end_image_url).toBe(`data:image/png;base64,${encoded[0]}`);
  await job.getByRole('button', { name: '继续创作', exact: true }).click();
  await expect(page.locator('[data-frame="firstFrame"] img')).toBeVisible();
  await expect(page.locator('[data-frame="lastFrame"] img')).toBeVisible();
  await page.getByRole('button', { name: '移除 尾帧', exact: true }).click();
  await page.getByRole('button', { name: '从资料库选择 尾帧', exact: true }).click();
  const picker = page.getByRole('dialog');
  await picker.getByLabel('搜索参考素材').fill('红色开场');
  await picker.locator('.ns-reference-library-grid button').first().click();
  await expect(page.locator('[data-frame="lastFrame"]')).toContainText('红色开场.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('.nw-sidebar')).toHaveCSS('opacity', '0');
  await page.screenshot({ path: info.outputPath('studio-frames-mobile.png'), fullPage: true });
});
