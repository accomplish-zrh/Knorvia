import { test, expect } from '@playwright/test';
import path from 'node:path';

test.skip(!process.env.KNORVIA_UI_FIXTURE_WORKSPACE, 'Requires the isolated local gateway');

test('workbench pickers keep keyboard selection, cancel, theme and modal behavior', async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem('knorvia-language', 'zh'));
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto('/workbench');
  await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
  // Only the development preview injects CSS. Packaged acceptance must run
  // without this variable so it verifies the renderer shipped in the archive.
  const previewCss = process.env.KNORVIA_SELECT_PREVIEW_CSS;
  if (previewCss) await page.addStyleTag({ path: path.resolve(previewCss) });
  const permissions = page.getByLabel('任务权限', { exact: true });
  expect(await permissions.evaluate(el => getComputedStyle(el).appearance)).toBe('base-select');
  await permissions.focus();
  await page.keyboard.press('Space');
  await expect(permissions).toHaveJSProperty('value', 'write');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(permissions).toHaveValue('write');
  await expect(permissions).toBeFocused();
  await permissions.click();
  await page.getByRole('option', { name: '只读', exact: true }).click();
  await expect(permissions).toHaveValue('read');
  await permissions.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(permissions).toHaveValue('write');
  await expect(page).toHaveURL(/\/workbench$/);
  const model = page.getByLabel('选择模型', { exact: true });
  await model.click();
  await expect(model).toHaveJSProperty('value', '');
  await expect.poll(() => model.evaluate(el => getComputedStyle(el, '::picker(select)').opacity)).toBe('1');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('composer-model-picker.png') });
  await page.keyboard.press('Escape');
  for (const theme of ['snow', 'light', 'glass', 'jade', 'dark', 'dusk']) {
    await page.evaluate(value => { localStorage.setItem('knorvia-theme', value); window.dispatchEvent(new StorageEvent('storage', { key: 'knorvia-theme', newValue: value })); }, theme);
    await model.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect.poll(() => model.evaluate(el => getComputedStyle(el, '::picker(select)').opacity)).toBe('1');
    await page.screenshot({ animations: 'disabled', path: info.outputPath(`picker-${theme}.png`) });
    await page.keyboard.press('Escape');
    await page.evaluate(() => { localStorage.setItem('knorvia-window-frost', 'true'); window.dispatchEvent(new StorageEvent('storage', { key: 'knorvia-window-frost', newValue: 'true' })); });
    await model.click();
    await expect(page.locator('html')).toHaveAttribute('data-window-frost', '');
    expect(await model.evaluate(el => getComputedStyle(el, '::picker(select)').backdropFilter)).toContain('blur');
    await expect.poll(() => model.evaluate(el => getComputedStyle(el, '::picker(select)').opacity)).toBe('1');
    await page.screenshot({ animations: 'disabled', path: info.outputPath(`picker-${theme}-glass.png`) });
    await page.keyboard.press('Escape');
    await page.evaluate(() => { localStorage.setItem('knorvia-window-frost', 'false'); window.dispatchEvent(new StorageEvent('storage', { key: 'knorvia-window-frost', newValue: 'false' })); });
  }
  await page.goto('/workbench/studio');
  if (previewCss) await page.addStyleTag({ path: path.resolve(previewCss) });
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const kind = dialog.getByRole('combobox', { name: '媒体类型', exact: true });
  await kind.click();
  await kind.getByRole('option', { name: '视频', exact: true }).click();
  await expect(kind).toHaveValue('video');
  await kind.click();
  await expect.poll(() => kind.evaluate(el => getComputedStyle(el, '::picker(select)').opacity)).toBe('1');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('modal-picker.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
