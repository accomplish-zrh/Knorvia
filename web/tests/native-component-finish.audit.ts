import { expect, test } from '@playwright/test';

test.skip(!process.env.KNORVIA_UI_FIXTURE_WORKSPACE, 'Requires isolated native gateway');
test.use({ locale: 'zh-CN' });

test('optional article dialog retains readable controls, sticky close and keyboard focus across themes', async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => localStorage.setItem('knorvia-language', 'zh'));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/workbench/studio');
  await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const trigger = page.getByRole('button', { name: '文章转视频', exact: true });
  for (const theme of ['snow', 'dark', 'jade']) {
    await page.evaluate(value => {
      localStorage.setItem('knorvia-theme', value);
      window.dispatchEvent(new StorageEvent('storage', { key: 'knorvia-theme', newValue: value }));
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await trigger.click();
    const dialog = page.getByRole('dialog');
    const article = dialog.getByRole('textbox', { name: '文章或主题', exact: true });
    await article.fill('让复杂的创作，变成清晰的表达。');
    await expect(article).toBeFocused();
    const field = await article.evaluate(el => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, color: style.color, border: style.borderStyle };
    });
    expect(field.background).not.toBe(field.color);
    expect(field.border).toBe('solid');
    const primary = dialog.getByRole('button', { name: '创建工程', exact: true });
    await expect(primary).toBeEnabled();
    const primaryColors = await primary.evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
    expect(primaryColors.bg).not.toBe(primaryColors.fg);
    await page.screenshot({ path: info.outputPath(`article-${theme}.png`), animations: 'disabled' });
    await dialog.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const close = dialog.getByRole('button', { name: '关闭对话框', exact: true });
    const visibleClose = await close.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === el || el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    });
    expect(visibleClose).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  await page.setViewportSize({ width: 480, height: 850 });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('article-mobile.png'), animations: 'disabled' });
});
