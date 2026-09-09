import { expect, type Page } from '@playwright/test';

export async function toggleWorkbenchTheme(page: Page) {
  const returnURL = page.url();
  const dark = await page.locator('html').evaluate(el => el.classList.contains('dark'));
  await page.keyboard.press('Control+,');
  await page.getByRole('link', { name: '外观', exact: true }).click();
  await page.getByRole('button', { name: dark ? '明亮' : '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', dark ? 'snow' : 'dark');
  await page.getByRole('link', { name: '返回应用', exact: true }).first().click();
  await expect(page).toHaveURL(returnURL);
  await expect(page.locator('.nw-root:not(.nw-settings-root)')).toBeVisible();
}
