import { expect, test } from '@playwright/test';

test.skip(!process.env.KNORVIA_UI_FIXTURE_WORKSPACE, 'Requires an isolated native fixture');
test.use({ locale: 'zh-CN', contextOptions: { reducedMotion: 'no-preference' }, video: 'on' });

test('sidebar and modal transitions remain interactive and both reduced-motion preferences take effect', async ({ page }, info) => {
  await page.addInitScript(() => { localStorage.setItem('knorvia-language', 'zh'); localStorage.setItem('knorvia-reading-v1', JSON.stringify({ size: 15, width: 'standard', reducedMotion: false })); });
  await page.setViewportSize({ width: 1500, height: 980 });
  await page.goto('/workbench');
  await expect(page.locator('.nw-connection')).toHaveClass(/is-connected/);
  const sidebar = page.locator('.nw-sidebar');
  const initial = await sidebar.evaluate(el => el.getBoundingClientRect().width);
  expect(initial).toBeGreaterThan(200);
  const moving = await page.evaluate(async () => {
    const sidebar = document.querySelector<HTMLElement>('.nw-sidebar')!;
    (sidebar.querySelector('[aria-label="收起侧栏"]') as HTMLButtonElement).click();
    // Observe rendered frames; a wall-clock delay can run before Chrome has
    // rendered the first transition frame when packaging is loading the CPU.
    return await new Promise<{ width: number; inert: boolean; animations: number }>((resolve, reject) => {
      const deadline = performance.now() + 2000, initial = sidebar.getBoundingClientRect().width;
      const sample = () => {
        const width = sidebar.getBoundingClientRect().width;
        if (sidebar.inert && width > 0 && width < initial) resolve({ width, inert: sidebar.inert, animations: sidebar.getAnimations().length });
        else if (performance.now() > deadline) reject(new Error(`Sidebar did not render an intermediate frame: width=${width}, min=${getComputedStyle(sidebar).minWidth}`));
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  });
  expect(moving.inert).toBe(true); expect(moving.animations).toBeGreaterThan(0);
  expect(moving.width).toBeGreaterThan(0); expect(moving.width).toBeLessThan(initial);
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await expect.poll(() => sidebar.evaluate(el => el.getBoundingClientRect().width)).toBe(initial);
  await page.getByRole('link', { name: '创作台', exact: true }).click();
  await expect(page.locator('.ns-kind-highlight')).toBeVisible();
  const selection = await page.evaluate(async () => {
    const group = document.querySelector<HTMLElement>('.ns-kind')!;
    const buttons = group.querySelectorAll('button');
    const indicator = group.querySelector<HTMLElement>('.ns-kind-highlight')!;
    const position = () => indicator.getBoundingClientRect().x - group.getBoundingClientRect().x;
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const start = position();
    buttons[1].click();
    await new Promise(resolve => setTimeout(resolve, 100));
    const midway = position(), sampledAt = performance.now();
    buttons[0].click(); await frame();
    const retarget = position(), frameElapsed = performance.now() - sampledAt;
    await new Promise(resolve => setTimeout(resolve, 650));
    return { start, midway, retarget, frameElapsed, end: position(), target: buttons[1].offsetLeft };
  });
  expect(selection.midway).toBeGreaterThan(selection.start + 5);
  expect(selection.midway).toBeLessThan(selection.target);
  // Frame delivery slows under concurrent packaging. Judge movement against
  // elapsed time; an arbitrary 15 px bound falsely fails a delayed frame.
  expect(Math.abs(selection.retarget - selection.midway)).toBeLessThan(Math.max(15, selection.frameElapsed * 2));
  expect(Math.abs(selection.end - selection.start)).toBeLessThan(1);
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => getComputedStyle(el).transitionDuration)).not.toBe('0s');
  const disclosure = dialog.locator('.ns-advanced');
  await disclosure.locator('summary').click();
  await expect(disclosure).toHaveAttribute('open', '');
  const disclosureFrames = await disclosure.evaluate(async element => {
    const details = element as HTMLDetailsElement;
    await new Promise(resolve => setTimeout(resolve, 300));
    details.open = false;
    const heights: number[] = [];
    await new Promise<void>(resolve => {
      const start = performance.now();
      function frame() {
        heights.push(parseFloat(getComputedStyle(details, '::details-content').height));
        if (performance.now() - start < 320) requestAnimationFrame(frame); else resolve();
      }
      requestAnimationFrame(frame);
    });
    return heights;
  });
  expect(disclosureFrames.some(height => height > 5)).toBe(true);
  expect(disclosureFrames.at(-1)).toBe(0);
  await disclosure.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '模型连接', exact: true })).toBeFocused();
  await page.screenshot({ path: info.outputPath('studio-motion.png') });

  await page.evaluate(() => {
    localStorage.setItem('knorvia-reading-v1', JSON.stringify({ size: 15, width: 'standard', reducedMotion: true }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'knorvia-reading-v1' }));
  });
  await expect(page.locator('.nw-root')).toHaveAttribute('data-reduce-motion', 'true');
  await page.locator('.ns-kind button').nth(1).click();
  const reducedSelection = await page.locator('.ns-kind').evaluate(group => {
    const indicator = group.querySelector<HTMLElement>('.ns-kind-highlight')!;
    const selected = group.querySelector<HTMLButtonElement>('[aria-pressed="true"]')!;
    return Math.abs(indicator.getBoundingClientRect().x - selected.getBoundingClientRect().x);
  });
  expect(reducedSelection).toBeLessThan(1);
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  expect(await dialog.evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
  expect(await dialog.locator('.ns-advanced').evaluate(el => getComputedStyle(el, '::details-content').transitionDuration)).toBe('0s');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await page.evaluate(() => {
    localStorage.setItem('knorvia-reading-v1', JSON.stringify({ size: 15, width: 'standard', reducedMotion: false }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'knorvia-reading-v1' }));
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  expect(await dialog.evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
  expect(await page.locator('.ns-create').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
});
