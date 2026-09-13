const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('../../web/node_modules/playwright');
const base = process.env.SITE_URL || 'http://127.0.0.1:4490';
const out = process.env.SITE_CHECK_OUT || path.resolve(__dirname, '../../work/product-orbit-20260909/acceptance');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const checks = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    await page.goto(base + '/?inspect#videos');
    await page.locator('[data-page-next]').click();
    await page.locator('#copy-example').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.locator('#detail-example-text').textContent());
    assert.equal(await page.locator('#copy-example-label').textContent(), '已复制');
    await page.locator('[data-page-next]').click();
    assert.equal(await page.locator('#copy-example-label').textContent(), '复制示例');
    await context.clearPermissions();
    // Exercise a denied clipboard as well as the real permitted Chrome clipboard.
    await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) }));
    await page.locator('#copy-example').click();
    assert.equal(await page.evaluate(() => getSelection().toString()), await page.locator('#detail-example-text').textContent());
    checks.push('Example copies through the Chrome clipboard; a denied clipboard selects the text and announces a usable fallback');

    await page.locator('[data-detail-page="0"]').click();
    await page.waitForFunction(() => document.querySelector('#open-screenshot').classList.contains('is-loaded'));
    await page.locator('#open-screenshot').click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('zoom-dialog').open);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'open-screenshot');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dialog-open')), false);
    checks.push('Animated close restores nested screenshot focus, then releases the document scroll lock');

    await page.evaluate(() => location.hash = '#images');
    await page.locator('#feature-dialog[open]').waitFor();
    await page.keyboard.press('Escape');
    await page.evaluate(() => location.hash = '#memory');
    await page.waitForFunction(() => document.getElementById('detail-category').textContent === '记忆');
    await page.waitForTimeout(250);
    assert(await page.locator('#feature-dialog').evaluate(d => d.open));
    assert.equal(await page.locator('dialog.is-closing').count(), 0);
    checks.push('Changing the selected topic during exit cancels the stale close without losing the new dialog');

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await mobile.goto(base + '/?inspect#videos');
    await mobile.locator('[data-page-next]').click();
    const cdp = await mobile.context().newCDPSession(mobile);
    const swipe = async (x, y, dx, dy) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 8, y: y + dy * i / 8 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await swipe(295, 330, -170, 4);
    assert.equal(await mobile.locator('#detail-page-count').textContent(), '3 / 4');
    await swipe(115, 330, 170, 4);
    assert.equal(await mobile.locator('#detail-page-count').textContent(), '2 / 4');
    await swipe(220, 570, 3, -220);
    assert.equal(await mobile.locator('#detail-page-count').textContent(), '2 / 4');
    assert(await mobile.locator('.detail-body').evaluate(e => e.scrollTop > 20));
    assert.equal(await mobile.evaluate(() => scrollY), 0);
    await mobile.screenshot({ path: path.join(out, 'refined-mobile-reading.png') });
    checks.push('Real Chrome touch swipes paginate within the topic; vertical gestures scroll the text without moving the page behind it');

    const retry = await browser.newPage();
    let failImage = true;
    await retry.route(/\/assets\/conversation-(720|1440)\.webp/, route => failImage ? route.fulfill({ status: 503, body: '' }) : route.continue());
    await retry.goto(base + '/#workspace');
    await retry.locator('#open-screenshot.is-unavailable').waitFor();
    failImage = false;
    await retry.locator('#open-screenshot').click();
    await retry.locator('#open-screenshot.is-loaded').waitFor();
    await retry.locator('#open-screenshot').click();
    assert(await retry.locator('#zoom-dialog').evaluate(d => d.open));
    checks.push('A failed real screenshot has an explicit retry state and opens normally after recovery');

    const compatibility = await browser.newPage();
    await compatibility.addInitScript(() => { window.createImageBitmap = undefined; });
    await compatibility.goto(base + '/?inspect');
    await compatibility.waitForFunction(() => window.__orbit?.getState().ready && document.body.classList.contains('scene-ready'));
    assert.equal((await compatibility.evaluate(() => __orbit.getState())).panels.length, 6);
    checks.push('Browsers without ImageBitmap retain the complete 3D gallery through the image-loader fallback');

    const lighting = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await lighting.goto(base + '/?inspect');
    await lighting.waitForFunction(() => window.__orbit?.getState().ready);
    await lighting.evaluate(() => __orbit.setPaused(true));
    const download = lighting.locator('.site-header [data-open-download]');
    const bounds = await download.boundingBox();
    const clip = { x: bounds.x - 25, y: Math.max(0, bounds.y - 12), width: bounds.width + 50, height: bounds.height + 42 };
    await lighting.mouse.move(bounds.x + 22, bounds.y + bounds.height / 2);
    await lighting.waitForTimeout(700);
    const leftGlow = await lighting.screenshot({ clip, path: path.join(out, 'button-light-left.png') });
    await lighting.mouse.move(bounds.x + bounds.width - 22, bounds.y + bounds.height / 2);
    await lighting.waitForTimeout(700);
    const rightGlow = await lighting.screenshot({ clip, path: path.join(out, 'button-light-right.png') });
    assert(!leftGlow.equals(rightGlow), 'The specular pool must visibly follow the pointer');
    const hoveredBounds = await download.boundingBox();
    assert(Math.abs(hoveredBounds.x - bounds.x) < 4 && Math.abs(hoveredBounds.y - bounds.y) < 4, 'The click target must stay under the pointer');
    await lighting.mouse.down();
    await lighting.waitForTimeout(130);
    await lighting.screenshot({ clip, path: path.join(out, 'button-light-pressed.png') });
    await download.dispatchEvent('pointercancel');
    await lighting.mouse.move(600, 90); await lighting.mouse.up();
    assert.equal(await lighting.locator('.luminous-button.is-pressed').count(), 0);
    await download.focus(); await lighting.keyboard.press('Enter');
    await lighting.locator('#download-dialog[open]').waitFor();
    await lighting.keyboard.press('Escape');
    await lighting.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert(await download.evaluate(e => document.activeElement === e));
    checks.push('Moving edge light is visible, pointer cancellation clears press state, and keyboard activation keeps download and focus behavior');

    await lighting.emulateMedia({ reducedMotion: 'reduce' });
    await download.hover(); await lighting.waitForTimeout(80);
    assert.equal(await download.evaluate(e => getComputedStyle(e).transform), 'none');
    assert.equal(await download.evaluate(e => e.getAnimations({ subtree: true }).length), 0);
    await download.click();
    assert(await lighting.locator('#download-dialog').evaluate(d => d.open));
    const touchDownload = mobile.locator('.site-header [data-open-download]');
    await mobile.keyboard.press('Escape');
    await mobile.waitForFunction(() => !document.querySelector('dialog[open]'));
    await touchDownload.tap();
    assert(await mobile.locator('#download-dialog').evaluate(d => d.open));
    assert.equal(await mobile.locator('.luminous-button.is-pressed').count(), 0);
    checks.push('Reduced motion keeps static lighting with no transform or running button animations; touch activation opens the same download dialog');

    fs.writeFileSync(path.join(out, 'interaction-polish.json'), JSON.stringify({ date: new Date().toISOString(), base, passed: checks.length, checks }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
