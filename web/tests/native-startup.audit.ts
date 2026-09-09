import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const requireDesktop = createRequire(path.resolve('../desktop/package.json'));
const { startupScreen } = requireDesktop('./startup-screen.js');
const { palettes } = requireDesktop('./window-appearance.js');
const logo = fs.readFileSync(path.resolve('../desktop/build/logo.png')).toString('base64');

test('native startup document animates locally, matches themes and respects both motion preferences', async ({ page }, info) => {
  const network: string[] = [], errors: string[] = [];
  page.on('request', request => { if (request.url().startsWith('http')) network.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const [theme, palette] of Object.entries(palettes) as [string, { colors: { bg: string } }][]) {
    await page.setContent(startupScreen({ logo, theme }));
    await expect(page.getByRole('status')).toHaveText('正在准备你的工作空间');
    expect(await page.locator('.mark img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    const frames = await page.evaluate(() => {
      const mark = document.querySelector('.mark')!;
      const animations = document.getAnimations();
      for (const animation of animations) { animation.pause(); animation.currentTime = 90; }
      const before = { transform: getComputedStyle(mark).transform, opacity: getComputedStyle(mark).opacity };
      for (const animation of animations) animation.currentTime = 1400;
      return { before, after: { transform: getComputedStyle(mark).transform, opacity: getComputedStyle(mark).opacity }, background: getComputedStyle(document.body).backgroundColor };
    });
    expect(frames.before.transform).not.toBe(frames.after.transform);
    expect(Number(frames.after.opacity)).toBe(1);
    const hex = palette.colors.bg.slice(1).match(/../g)!.map(v => parseInt(v, 16));
    expect(frames.background).toBe(`rgb(${hex.join(', ')})`);
    if (theme === 'snow' || theme === 'dusk') await page.screenshot({ path: info.outputPath(`startup-${theme}.png`) });
  }
  await page.setContent(startupScreen({ logo, frost: true }));
  expect(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  for (const appReduced of [true, false]) {
    await page.emulateMedia({ reducedMotion: appReduced ? 'no-preference' : 'reduce' });
    await page.setContent(startupScreen({ logo, reducedMotion: appReduced }));
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await expect(page.locator('.mark')).toHaveCSS('opacity', '1');
    await expect(page.locator('.sheen')).toBeHidden();
  }
  // Check caption controls through the same preload interface without opening a native window.
  await page.evaluate(() => Object.assign(window, { captionCalls: [], knorviaDesktop: { chrome: {
    windowMinimize: () => (window as unknown as { captionCalls: string[] }).captionCalls.push('min'),
    windowMaximize: () => (window as unknown as { captionCalls: string[] }).captionCalls.push('max'),
    windowClose: () => (window as unknown as { captionCalls: string[] }).captionCalls.push('close'),
  } } }));
  await page.setContent(startupScreen({ logo }));
  for (const name of ['Minimize', 'Maximize', 'Close']) await page.getByRole('button', { name }).click();
  expect(await page.evaluate(() => (window as unknown as { captionCalls: string[] }).captionCalls)).toEqual(['min', 'max', 'close']);
  expect(network).toEqual([]); expect(errors).toEqual([]);
});

test('bottom settings stays reachable and workspace entrance never replays during navigation', async ({ page }, info) => {
  await page.addInitScript(() => {
    localStorage.setItem('knorvia-language', 'zh');
    Object.assign(window, { entranceCount: 0 });
    new MutationObserver(records => {
      for (const record of records) if (record.attributeName === 'data-workbench-arriving' && record.oldValue === null)
        (window as unknown as { entranceCount: number }).entranceCount++;
    }).observe(document, { attributes: true, subtree: true, attributeOldValue: true, attributeFilter: ['data-workbench-arriving'] });
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto('/workbench');
  const footer = page.locator('.nw-settings-footer');
  await expect(footer.getByRole('link')).toHaveCount(1);
  await expect(footer.getByRole('link', { name: '设置', exact: true })).toBeVisible();
  await expect(footer.locator('svg.lucide-settings')).toBeVisible();
  await expect(page.getByText('本地工作台', { exact: true })).toHaveCount(0);
  await expect.poll(() => page.locator('html').getAttribute('data-workbench-arriving')).toBeNull();
  expect(await footer.evaluate(el => innerHeight - el.getBoundingClientRect().bottom)).toBeLessThan(25);
  const entrances = () => page.evaluate(() => (window as unknown as { entranceCount: number }).entranceCount);
  const originalCount = await entrances(); expect(originalCount).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath('bottom-settings.png') });
  await footer.getByRole('link').click();
  await expect(page).toHaveURL(/\/workbench\/settings$/);
  await page.getByRole('link', { name: '返回应用', exact: true }).click();
  await expect(footer).toBeVisible();
  expect(await entrances()).toBe(originalCount);
  await page.keyboard.press('Control+,');
  await expect(page).toHaveURL(/\/workbench\/settings$/);
  await page.getByRole('link', { name: '外观', exact: true }).click();
  await page.getByRole('switch', { name: '减少动效', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('switch', { name: '减少动效', exact: true })).toBeChecked();
  expect(await entrances()).toBe(0);
  await page.getByRole('link', { name: '返回应用', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await expect(footer.getByRole('link')).toBeInViewport();
  await page.screenshot({ path: info.outputPath('compact-bottom-settings.png') });
  await footer.getByRole('link').click();
  await expect(page).toHaveURL(/\/workbench\/settings$/);
});
