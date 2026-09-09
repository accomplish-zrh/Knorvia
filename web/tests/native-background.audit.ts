import { expect, test } from '@playwright/test';
import path from 'node:path';

test.skip(!process.env.KNORVIA_UI_FIXTURE_WORKSPACE, 'Requires an isolated native fixture');
test.use({ locale: 'zh-CN', contextOptions: { reducedMotion: 'no-preference' } });
const photo = path.resolve('public/wallpapers/campus-lake.jpg');
const replacement = path.resolve('public/wallpapers/campus-library.jpg');

test('uploaded backgrounds survive reload, follow routes and themes, replace atomically, sync and remove', async ({ page, context }, info) => {
  test.setTimeout(100_000);
  const errors: string[] = [], uploads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && /campus-lake|campus-library/.test(request.postData() ?? '')) uploads.push(request.url()); });
  await page.addInitScript(() => { localStorage.setItem('knorvia-language', 'zh'); });
  await page.setViewportSize({ width: 1500, height: 980 });
  await page.goto('/workbench/settings/appearance');
  const panel = page.getByRole('region', { name: '背景图片', exact: true });
  const file = panel.getByLabel('上传背景图片', { exact: true });
  await expect(file).toBeEnabled();
  await file.setInputFiles(photo);
  await expect(panel.getByText('campus-lake.jpg', { exact: true })).toBeVisible();
  await expect(page.locator('.nw-background-host')).toHaveAttribute('data-background', 'true');
  const transparency = panel.getByRole('slider', { name: '背景透明度', exact: true });
  const blur = panel.getByRole('slider', { name: '背景模糊', exact: true });
  await transparency.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
  await blur.focus(); await page.keyboard.press('End');
  await expect(blur).toHaveValue('24');
  await panel.getByRole('button', { name: '完整显示', exact: true }).click();
  await page.reload();
  await expect(transparency).toHaveValue('1'); await expect(blur).toHaveValue('24');
  await expect(panel.getByRole('button', { name: '完整显示', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await panel.getByRole('button', { name: '重置背景参数', exact: true }).click();
  await expect(transparency).toHaveValue('72'); await expect(blur).toHaveValue('6');
  const src = await page.locator('.nw-background-photo').getAttribute('src');
  for (const [name, theme] of [['明亮', 'snow'], ['暖纸', 'light'], ['雾蓝', 'glass'], ['青苔', 'jade'], ['深色', 'dark'], ['暮紫', 'dusk']]) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.nw-background-photo')).toHaveAttribute('src', src!);
    expect(await page.locator('.nw-settings-main').evaluate(el => getComputedStyle(el).backgroundColor)).toMatch(/0\.\d|\/ 0\.\d/);
  }
  await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('background-dusk.png') });
  await page.getByRole('switch', { name: '玻璃效果', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-window-frost', '');
  await expect(page.locator('.nw-background-photo')).toHaveAttribute('src', src!);
  await page.getByRole('button', { name: '明亮', exact: true }).click();
  await page.getByRole('link', { name: '返回应用', exact: true }).first().click();
  await expect(page.locator('.nw-home')).toBeVisible();
  await expect(page.locator('.nw-background-photo')).toHaveAttribute('src', src!);
  await page.screenshot({ path: info.outputPath('background-home.png') });
  await page.getByRole('link', { name: '创作台', exact: true }).click();
  await expect(page.locator('.nw-background-photo')).toHaveAttribute('src', src!);
  await page.goto('/workbench/settings/appearance');
  await expect(file).toBeEnabled();
  const other = await context.newPage(); await other.goto('/workbench/settings/appearance');
  await expect(other.getByText('campus-lake.jpg', { exact: true })).toBeVisible();
  await file.setInputFiles(replacement);
  await expect(panel.getByText('campus-library.jpg', { exact: true })).toBeVisible();
  await expect(other.getByText('campus-library.jpg', { exact: true })).toBeVisible();
  await expect(page.locator('.nw-background-photo')).toHaveCount(1);
  const show = panel.getByRole('switch', { name: '显示背景图片', exact: true });
  await show.click(); await expect(page.locator('.nw-background-host')).toHaveAttribute('data-background', 'false');
  await page.reload(); await expect(show).not.toBeChecked();
  await show.click(); await expect(page.locator('.nw-background-host')).toHaveAttribute('data-background', 'true');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 }); await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.nw-settings-main').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`background-${width}.png`) });
  }
  await panel.getByRole('button', { name: '移除背景图片', exact: true }).click();
  await expect(show).toBeDisabled();
  await expect(other.getByRole('switch', { name: '显示背景图片', exact: true })).toBeDisabled();
  await page.reload(); await expect(page.locator('.nw-background-photo')).toHaveCount(0);
  await other.close();
  expect(uploads).toEqual([]); expect(errors).toEqual([]);
});

test('invalid images and failed writes preserve the previous background; dropped images and reduced motion work', async ({ page }, info) => {
  test.setTimeout(75_000);
  await page.addInitScript(() => { localStorage.setItem('knorvia-language', 'zh'); });
  await page.goto('/workbench/settings/appearance');
  const panel = page.getByRole('region', { name: '背景图片', exact: true }), file = panel.getByLabel('上传背景图片', { exact: true });
  await expect(file).toBeEnabled(); await file.setInputFiles(photo);
  await expect(panel.getByText('campus-lake.jpg', { exact: true })).toBeVisible();
  for (const [name, mimeType, buffer, message] of [
    ['document.txt', 'text/plain', Buffer.from('test'), /JPG/],
    ['broken.jpg', 'image/jpeg', Buffer.from('not an image'), /无法读取/],
    ['too-large.png', 'image/png', Buffer.alloc(20 * 1024 * 1024 + 1), /20 MB/],
  ] as const) {
    await file.setInputFiles({ name, mimeType, buffer });
    await expect(panel.getByRole('alert')).toHaveText(message);
    await expect(panel.getByText('campus-lake.jpg', { exact: true })).toBeVisible();
  }
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      if (this.name === 'knorvia-appearance-v1' && args[1] === 'readwrite') { IDBDatabase.prototype.transaction = original; throw new DOMException('Simulated full device', 'QuotaExceededError'); }
      return original.apply(this, args);
    };
  });
  await file.setInputFiles(replacement);
  await expect(panel.getByRole('alert')).toHaveText(/未能保存/);
  await page.reload(); await expect(panel.getByText('campus-lake.jpg', { exact: true })).toBeVisible();
  // Drop actual bytes through the browser's DataTransfer path.
  const transfer = await page.evaluateHandle(async () => {
    const blob = await (await fetch('/wallpapers/campus-library.jpg')).blob();
    const data = new DataTransfer(); data.items.add(new File([blob], 'dropped.jpg', { type: 'image/jpeg' })); return data;
  });
  await panel.locator('.nw-background-card').dispatchEvent('drop', { dataTransfer: transfer }); await transfer.dispose();
  await expect(panel.getByText('dropped.jpg', { exact: true })).toBeVisible();
  await page.getByRole('switch', { name: '减少动效', exact: true }).click();
  await panel.getByRole('switch', { name: '显示背景图片', exact: true }).click();
  await expect.poll(() => page.locator('.nw-background-canvas').evaluate(el => getComputedStyle(el).opacity)).toBe('0');
  await page.getByRole('switch', { name: '减少动效', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await panel.getByRole('switch', { name: '显示背景图片', exact: true }).click();
  await expect.poll(() => page.locator('.nw-background-canvas').evaluate(el => Number(getComputedStyle(el).opacity))).toBeCloseTo(.28, 2);
  await page.screenshot({ path: info.outputPath('background-upload-validated.png') });
  expect(await page.evaluate(() => Object.values(localStorage).some(value => /data:image|;base64,/.test(value)))).toBe(false);
});
