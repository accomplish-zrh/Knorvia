import { expect, test } from '@playwright/test';

test.skip(!process.env.KNORVIA_UI_FIXTURE_WORKSPACE, 'Requires the isolated native fixture');

test('minimal home keeps keyboard starters and goal entry usable in both languages and narrow widths', async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem('knorvia-language', 'zh'));
  await page.setViewportSize({ width: 1500, height: 980 });
  await page.goto('/workbench');
  await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
  const input = page.locator('.nw-composer > textarea');
  const starters = page.getByRole('group', { name: '快速开始' });
  await expect(starters.getByRole('button')).toHaveCount(4);
  await starters.getByRole('button', { name: '整理资料', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue(/阅读这个项目的资料/);
  await expect(input).toBeFocused();
  await input.fill('');
  await page.getByRole('button', { name: '添加内容或模式' }).click();
  await page.getByRole('button', { name: '目标', exact: true }).click();
  await expect(page.locator('.nw-goal-mode-label')).toBeVisible();
  await page.getByRole('button', { name: '添加内容或模式' }).click();
  await page.getByRole('button', { name: '普通对话', exact: true }).click();
  await expect(page.locator('.nw-goal-mode-label')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('home-refined.png') });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('.nw-sidebar')).toHaveAttribute('inert', '');
    expect(await page.locator('.nw-main').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    for (const button of await starters.getByRole('button').all()) await expect(button).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`home-${width}.png`) });
  }
  await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
  await expect(page.locator('.nw-home h1')).toHaveText('What would you like to do?');
  expect(await page.locator('.nw-main').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('home-english-320.png') });
});
