import { test, expect } from '@playwright/test';

test('desktop first paint keeps every outer layer transparent and bridges theme changes', async ({ page }, info) => {
  await page.addInitScript(() => {
    localStorage.setItem('knorvia-theme', 'dusk'); localStorage.setItem('knorvia-language', 'zh'); localStorage.setItem('knorvia-window-frost', 'true');
    const calls: unknown[] = [];
    Object.assign(window, { appearanceCalls: calls, knorviaDesktop: { chrome: {
      platform: 'win32', backdropSupported: true, captionOverlay: true, trafficLights: false,
      setTitleBarOverlay: (value: unknown) => calls.push({ overlay: value }),
      setWindowMaterial: (value: unknown) => calls.push({ material: value }),
      windowIsMaximized: () => Promise.resolve(false), onWindowState: () => () => {},
    } } });
  });
  await page.goto('/workbench/settings/appearance');
  await expect(page.getByRole('switch', { name: '玻璃效果', exact: true })).toBeChecked();
  const surfaces = await page.evaluate(() => Object.fromEntries(['html', 'body', '.nw-root', '.nw-settings-main', '.nw-settings-search input'].map(selector => [selector, getComputedStyle(document.querySelector(selector)!).backgroundColor])));
  for (const selector of ['html', 'body', '.nw-root', '.nw-settings-search input']) expect(surfaces[selector], selector).toBe('rgba(0, 0, 0, 0)');
  expect(surfaces['.nw-settings-main']).toMatch(/0\.\d|\/ 0\.\d/);
  await page.getByRole('button', { name: '明亮', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'snow');
  const calls = await page.evaluate(() => (window as unknown as { appearanceCalls: { material?: Record<string, unknown> }[] }).appearanceCalls.filter(call => call.material).map(call => call.material!));
  expect(calls.at(-1)).toMatchObject({ theme: 'snow', frost: true, material: 'acrylic', backgroundColor: '#00000000' });
  await page.getByRole('switch', { name: '玻璃效果', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { appearanceCalls: { material?: Record<string, unknown> }[] }).appearanceCalls.filter(call => call.material).at(-1)?.material)).toMatchObject({ theme: 'snow', frost: false, material: 'none', backgroundColor: '#ffffff' });
  await page.getByRole('switch', { name: '减少动效', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { appearanceCalls: { material?: Record<string, unknown> }[] }).appearanceCalls.filter(call => call.material).at(-1)?.material?.reducedMotion)).toBe(true);
  await page.screenshot({ path: info.outputPath('desktop-caption-and-settings.png') });
});

test('six themes, independent glass controls, persistent preferences and compact layout', async ({ page, context }, info) => {
  test.setTimeout(90_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem('knorvia-language', 'zh');
    if (!sessionStorage.getItem('appearance-audit')) {
      localStorage.setItem('knorvia-theme', 'snow');
      localStorage.setItem('knorvia-window-frost', 'false');
      sessionStorage.setItem('appearance-audit', 'true');
    }
  });
  await page.setViewportSize({ width: 1540, height: 1080 });
  await page.goto('/workbench/settings/appearance');
  await expect(page.locator('.nw-theme-choice')).toHaveCount(6);
  const effect = page.getByRole('switch', { name: '玻璃效果', exact: true });
  const transparency = page.getByRole('slider', { name: '透明度', exact: true });
  const plates = page.getByRole('slider', { name: '阅读区域底色', exact: true });
  const themes = [['snow', '明亮'], ['dark', '深色'], ['light', '暖纸'], ['glass', '雾蓝'], ['jade', '青苔'], ['dusk', '暮紫']];
  for (const enabled of [false, true]) {
    if (enabled) await effect.click();
    for (const [id, label] of themes) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', id);
      await expect(effect).toHaveAttribute('aria-checked', String(enabled));
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
      expect(await page.locator('html').evaluate(el => el.classList.contains('dark'))).toBe(id === 'dark' || id === 'dusk');
      expect(await page.locator('html').evaluate(el => el.hasAttribute('data-window-frost'))).toBe(enabled);
      await page.screenshot({ path: info.outputPath(`${id}-${enabled ? 'glass' : 'solid'}.png`) });
    }
  }
  await transparency.focus(); await page.keyboard.press('Home');
  const opaque = await page.locator('.nw-settings-main').evaluate(el => getComputedStyle(el).backgroundColor);
  await page.keyboard.press('End');
  const transparent = await page.locator('.nw-settings-main').evaluate(el => getComputedStyle(el).backgroundColor);
  expect(opaque).not.toBe(transparent);
  await page.keyboard.press('ArrowLeft'); await expect(transparency).toHaveValue('99');
  await plates.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
  await expect(plates).toHaveValue('1');
  await effect.click(); await expect(transparency).toBeDisabled();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dusk');
  await expect(effect).toHaveAttribute('aria-checked', 'false');
  await expect(transparency).toHaveValue('99'); await expect(plates).toHaveValue('1');
  await effect.click();
  await page.getByRole('button', { name: '重置参数', exact: true }).click();
  await expect(transparency).toHaveValue('62'); await expect(plates).toHaveValue('86');
  // Another client updates the same device preference without a route reload.
  const other = await context.newPage(); await other.goto('/workbench/settings/appearance');
  await other.getByRole('button', { name: '暖纸', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light'); await other.close();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(effect).toBeEnabled();
    expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.nw-settings-main').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await effect.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`compact-${width}.png`) });
    await transparency.focus(); await page.keyboard.press('ArrowRight');
    await expect(transparency).toBeFocused();
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await effect.evaluate(el => parseFloat(getComputedStyle(el).transitionDuration))).toBeLessThan(.01);
  expect(errors).toEqual([]);
});
