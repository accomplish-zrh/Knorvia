const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('../../web/node_modules/playwright');
const features = require('./orbit-content.cjs');
const out = process.env.SITE_CHECK_OUT || path.resolve(__dirname, '../../work/product-orbit-20260909/acceptance');
const base = process.env.SITE_URL || 'http://127.0.0.1:4490';
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const results = [], errors = [];
  const report = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ date: new Date().toISOString(), url: base, passed: results.length, results, errors }, null, 2));
  try {
    const p = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
    p.on('pageerror', e => errors.push(e.message));
    p.on('response', r => { if (r.status() >= 400 && new URL(r.url()).origin === new URL(base).origin) errors.push(r.status() + ' ' + r.url()); });
    await p.goto(base + '/?inspect');
    await p.waitForFunction(() => window.__orbit?.getState().ready && document.body.classList.contains('scene-ready'));
    await p.waitForFunction(() => getComputedStyle(document.querySelector('#orbit-canvas')).opacity === '1');
    assert(await p.evaluate(() => scrollY === 0 && document.querySelector('#site-footer').getBoundingClientRect().top >= innerHeight), 'Footer must be entirely below the initial viewport');
    await p.locator('#motion-toggle').click();
    await p.locator('#reset-view').click();
    await p.waitForTimeout(1800);
    const initial = await p.evaluate(() => __orbit.getState());
    assert(initial.paused && initial.panels.length === 6 && initial.triangles > 30000);
    assert(initial.panels.some(v => v.z < -3) && initial.panels.some(v => v.z > 3));
    await p.screenshot({ path: path.join(out, 'desktop-ring.png') });
    results.push('One tilted 3D orbit with six curved, textured, depth-ordered panels');

    const frozen = await p.evaluate(() => __orbit.getState());
    await p.waitForTimeout(400);
    const still = await p.evaluate(() => __orbit.getState());
    assert.equal(still.frames, frozen.frames);
    assert.equal(still.phase, frozen.phase);
    results.push('Pause settles and stops rendering and simulation');

    assert.equal(await p.locator('input[type="range"]').count(), 0);
    assert.equal(await p.locator('#spread-toggle').count(), 0);
    async function dragPhoto(distance) {
      const s = await p.evaluate(() => __orbit.getState());
      const card = s.panels.find(v => v.id === 'workspace');
      const length = Math.hypot(card.x - s.center.x, card.y - s.center.y);
      await p.mouse.move(card.x, card.y); await p.mouse.down();
      await p.mouse.move(card.x + (card.x - s.center.x) / length * distance, card.y + (card.y - s.center.y) / length * distance, { steps: 16 }); await p.mouse.up();
    }
    await dragPhoto(135);
    await p.waitForFunction(() => __orbit.getState().radius > 6);
    await p.screenshot({ path: path.join(out, 'direct-drag-expanded.png') });
    await dragPhoto(-190);
    await p.waitForFunction(() => __orbit.getState().radius < 4.7);
    assert.equal(await p.locator('#feature-dialog').evaluate(d => d.open), false);
    assert(Math.abs((await p.evaluate(() => __orbit.getState().phase)) - initial.phase) < .002);
    await p.locator('#reset-view').click(); await p.waitForTimeout(1800);
    results.push('Dragging a photo outward expands the entire orbit; inward contracts it without rotating or opening details; no radius controls');


    const water = await p.evaluate(() => __orbit.getWaterState());
    assert.equal(water.base.state, 'submerged');
    assert(water.letter.every(s => s.state === 'above'));
    assert(water.panels.some(s => s.state === 'above') && water.panels.some(s => s.state === 'submerged') && water.panels.some(s => s.state === 'crossing'));
    results.push('Depth-tested water: submerged base, dry K, and above / submerged / crossing photos coexist');

    async function arcDrag(degrees) {
      const s = await p.evaluate(() => __orbit.getState());
      const card = s.panels.find(v => v.id === 'workspace');
      const dx = card.x - s.center.x, dy = card.y - s.center.y;
      await p.mouse.move(card.x, card.y); await p.mouse.down();
      for (let step = 1; step <= 18; step++) {
        const a = degrees * Math.PI / 180 * step / 18;
        await p.mouse.move(s.center.x + dx * Math.cos(a) - dy * Math.sin(a), s.center.y + dx * Math.sin(a) + dy * Math.cos(a));
      }
      await p.mouse.up();
    }
    await arcDrag(48);
    assert(Math.abs((await p.evaluate(() => __orbit.getState().phase)) - initial.phase) > .4);
    assert(Math.abs((await p.evaluate(() => __orbit.getState().targetRadius)) - initial.radius) < .03);
    assert(!await p.locator('#feature-dialog').evaluate(d => d.open));
    await p.locator('#reset-view').click(); await p.waitForTimeout(1600);
    results.push('Circular photo drag rotates the shared orbit while a radial drag controls spread; no accidental dialog');

    async function focusFeature(id) {
      const index = features.findIndex(f => f.id === id);
      await p.locator(`.feature-dock [data-feature="${id}"]`).click();
      await p.waitForFunction(i => __orbit.getState().focused === i && __orbit.getState().targetPhase === null, index);
      const s = await p.evaluate(() => __orbit.getState());
      assert(Math.abs(s.panels[index].z - s.radius) < .15, 'chosen panel is in front');
      assert(!await p.locator('#feature-dialog').evaluate(d => d.open), 'first navigation click only rotates');
      assert.equal(await p.locator('.feature-dock [aria-current]').getAttribute('data-feature'), id);
      return s;
    }
    async function showFeature(id) {
      await focusFeature(id);
      await p.locator(`.feature-dock [data-feature="${id}"]`).click();
      await p.locator('#feature-dialog[open]').waitFor();
    }

    const panel = (await p.evaluate(() => __orbit.getState())).panels.find(f => f.id === 'workspace');
    const canvasBounds = await p.locator('#orbit-canvas').boundingBox();
    await p.mouse.click(canvasBounds.x + panel.x, canvasBounds.y + panel.y);
    await p.locator('#feature-dialog[open]').waitFor();
    assert.equal(await p.locator('#detail-category').textContent(), '工作台');
    assert.equal(await p.evaluate(() => __orbit.getState().paused), true);
    await p.locator('[aria-label="关闭详情"]').click();
    await p.waitForFunction(() => !location.hash);
    results.push('Actual curved canvas surface opens the correct detail; dialog freezes orbit');

    const beforeDrag = await p.evaluate(() => __orbit.getState().phase);
    await p.mouse.move(100, 600); await p.mouse.down(); await p.mouse.move(400, 600, { steps: 16 }); await p.mouse.up();
    assert(Math.abs((await p.evaluate(() => __orbit.getState().phase)) - beforeDrag) > 1);
    assert.equal(await p.locator('#feature-dialog').evaluate(d => d.open), false);
    await p.locator('#reset-view').click();
    results.push('Dragging empty space rotates the shared orbit without accidental clicks; reset works');

    for (const f of features) {
      await showFeature(f.id);
      assert.equal(await p.locator('#detail-title').textContent(), f.headline);
      await p.waitForFunction(() => { const i = document.getElementById('detail-screenshot'); return i.complete && i.naturalWidth > 0 && /-(720|1440)\.webp/.test(i.currentSrc); });
      assert((await p.locator('#detail-screenshot').getAttribute('src')).includes(f.screenshot));

      await p.waitForTimeout(600);
      assert(await p.locator('#feature-dialog').evaluate(d => { const r=d.getBoundingClientRect(); return r.width<=482 && r.height < innerHeight*.77; }));
      assert(await p.locator('[data-page-previous]').isDisabled());
      assert.equal(await p.locator('#detail-page-count').textContent(), '1 / 4');
      if (f.id === 'library') {
        await p.screenshot({ path: path.join(out, 'library-detail.png') });
      }
      for (let chapter = 1; chapter < f.pages.length; chapter++) {
        await p.locator('[data-page-next]').click();
        assert.equal(await p.locator('#detail-category').textContent(), f.label);
        assert.equal(await p.evaluate(() => location.hash), '#' + f.id);
        assert.equal(await p.locator('#detail-page-count').textContent(), `${chapter + 1} / 4`);
        assert.equal(await p.locator('#detail-title').textContent(), f.pages[chapter].headline);
        assert.equal(await p.locator('#detail-features .feature-point').count(), 3);
        const reading = await p.locator('#detail-reading').textContent();
        for (const [title, body] of f.pages[chapter].points) {
          assert(reading.includes(title) && reading.includes(body), 'Complete guide point');
        }
        assert.equal(await p.locator('#detail-example-text').textContent(), f.pages[chapter].example);
        assert.equal(await p.evaluate(() => __orbit.getState().selected), features.indexOf(f));
        if (f.id === 'videos') { await p.waitForTimeout(330); await p.screenshot({ path: path.join(out, `video-guide-${chapter + 1}.png`) }); }
      }
      assert(await p.locator('[data-page-next]').isDisabled());
      await p.keyboard.press('PageUp');
      assert.equal(await p.locator('#detail-page-count').textContent(), '3 / 4');
      await p.locator('[data-detail-page="0"]').click();
      assert(await p.locator('#detail-visual').isVisible());
      await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('dialog.is-closing'));
      await p.waitForFunction(() => !location.hash);
      assert.equal(await p.evaluate(() => document.activeElement?.dataset.feature), f.id);
    }

    results.push('All six photos have four rich guide pages; arrows paginate only the chosen topic, preserve its URL and scene selection, and stop at each end');
    await focusFeature('workspace');
    const held = await p.evaluate(() => __orbit.getState().phase);
    await p.waitForTimeout(500);
    assert.equal(await p.evaluate(() => __orbit.getState().phase), held);
    await p.locator('.orbit-label[data-feature="workspace"]').focus(); await p.keyboard.press('Enter');
    assert.equal(await p.locator('#detail-category').textContent(), '工作台');
    await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('dialog.is-closing')); await p.waitForFunction(() => !location.hash);
    await p.locator('.feature-dock [data-feature="images"]').click();
    await p.locator('.feature-dock [data-feature="bots"]').click();
    await p.waitForFunction(() => __orbit.getState().focused===4 && __orbit.getState().targetPhase===null);
    assert(Math.abs((await p.evaluate(() => __orbit.getState())).panels[4].z - 5.2)<.15);
    await p.locator('#reset-view').click();
    results.push('Focused photo holds still and is keyboard accessible; rapid navigation chooses the latest target');


    await showFeature('videos');
    await p.locator('#open-screenshot').click();
    assert(await p.locator('#zoom-dialog').evaluate(d => d.open));
    await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('dialog.is-closing'));
    assert(await p.locator('#feature-dialog').evaluate(d => d.open));
    assert.equal(await p.evaluate(() => document.activeElement.id), 'open-screenshot');
    await p.locator('[data-page-next]').click();
    assert.equal(await p.locator('#detail-category').textContent(), '视频创作');
    await p.goBack();
    await p.waitForFunction(() => !document.getElementById('feature-dialog').open);
    await p.goForward();
    await p.waitForFunction(() => document.getElementById('feature-dialog').open);
    assert.equal(await p.locator('#detail-category').textContent(), '视频创作');
    assert.equal(await p.locator('#detail-page-count').textContent(), '1 / 4');
    await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('dialog.is-closing'));
    results.push('Screenshot zoom preserves focus; guide pages add no history entries; Back closes and Forward reopens the chosen photo');

    await p.locator('.feature-dock a').first().focus();
    await p.keyboard.press('End');
    assert.equal(await p.evaluate(() => document.activeElement.dataset.feature), 'memory');
    await p.keyboard.press('ArrowRight');
    assert.equal(await p.evaluate(() => document.activeElement.dataset.feature), 'workspace');
    results.push('Feature navigation supports arrows, Home and End');

    await p.locator('.about-button').click();
    assert(await p.locator('#about-dialog').evaluate(d => d.open));
    await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('dialog.is-closing'));
    await p.locator('[data-open-download]').first().click();
    assert((await p.locator('.release-note').textContent()).includes('v1.0.0'));
    assert((await p.locator('#download-dialog a.full').getAttribute('href')).endsWith('Knorvia-1.0.0-setup.exe'));
    await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('dialog.is-closing'));
    results.push('About and download controls work; public release and development UI remain accurate');

    for (const width of [320, 390, 768, 1024, 1920]) {
      await p.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
      await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await p.waitForTimeout(300);
      assert(await p.locator('#site-footer').evaluate(e => e.getBoundingClientRect().top >= innerHeight), `footer leaked into first screen at ${width}`);
      assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && Math.abs(document.querySelector('.universe').getBoundingClientRect().height - innerHeight) <= 1), `overflow ${width}`);
      assert(await p.locator('.about-button').isVisible());
      assert(await p.locator('[data-open-download]').first().isVisible());
      assert(await p.locator('.feature-dock').evaluate(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
      if (width === 390) {
        await p.screenshot({ path: path.join(out, 'mobile-ring.png') });
        await showFeature('memory');
        assert(await p.locator('#feature-dialog').evaluate(d => d.open));
        assert(await p.locator('.detail-shell').evaluate(e => e.scrollWidth <= e.clientWidth));
        await p.screenshot({ path: path.join(out, 'mobile-detail.png') });
        await p.locator('[data-page-next]').click(); await p.waitForTimeout(330);
        assert(await p.locator('.detail-body').evaluate(e => e.scrollWidth <= e.clientWidth));
        assert(await p.locator('.detail-pager').evaluate(e => { const r=e.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.bottom<innerHeight; }));
        await p.screenshot({ path: path.join(out, 'mobile-guide.png') });
        await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('dialog.is-closing'));
      }
    }
    results.push('320–1920 px: no page overflow; mobile details, about and download accessible');


    await p.setViewportSize({ width: 1440, height: 1000 });

    assert.equal(await p.locator('#discover').count(),0);
    await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await p.mouse.move(20, 400); await p.mouse.wheel(0, 240);
    await p.waitForFunction(() => scrollY > 0 && document.querySelector('#site-footer').getBoundingClientRect().top < innerHeight);
    await p.locator('.next-page').click();
    await p.locator('#site-footer').scrollIntoViewIfNeeded();
    await p.waitForTimeout(600);
    assert.equal(await p.locator('.service-links a').last().getAttribute('href'),'https://wzyp.cn/shop/future');
    assert.equal(await p.locator('.service-links a').first().getAttribute('href'),'https://api.knorvia.xyz');
    assert.equal(await p.locator('.footer-main nav a').count(),4);
    await p.screenshot({path:path.join(out,'footer-desktop.png')});
    await p.locator('.footer-main [data-open-download]').click();
    assert(await p.locator('#download-dialog').evaluate(d=>d.open));
    await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('dialog.is-closing'));
    results.push('Footer stays fully below the first screen until scrolling; compact resources, download and paired relay/current shop links');

    await p.setViewportSize({width:390,height:844});
    await p.locator('#site-footer').scrollIntoViewIfNeeded(); await p.waitForTimeout(300);
    assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await p.screenshot({path:path.join(out,'footer-mobile.png')});
    await p.setViewportSize({ width: 1440, height: 1000 });
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await p.goto(base + '/?inspect#memory');
    await p.waitForFunction(() => window.__orbit?.getState().ready);
    assert(await p.locator('#motion-toggle').isDisabled());
    assert.equal(await p.locator('#detail-category').textContent(), '记忆');
    await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('dialog.is-closing'));
    await p.waitForTimeout(200);
    const reducedFrame = await p.evaluate(() => __orbit.getState().frames);
    await p.waitForTimeout(350);
    assert.equal(await p.evaluate(() => __orbit.getState().frames), reducedFrame);

    await focusFeature('images');
    assert.equal(await p.evaluate(() => __orbit.getState().targetPhase), null);
    await p.locator('.feature-dock [data-feature="images"]').hover();
    assert.equal(await p.locator('.luminous-button').first().evaluate(e=>getComputedStyle(e,'::after').animationName), 'none');
    results.push('Reduced-motion preference freezes water and orbit, snaps navigation without animation, and preserves deep links');

    await p.addScriptTag({ path: require.resolve('../../web/node_modules/axe-core/axe.js') });
    const axe = await p.evaluate(async () => await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
    fs.writeFileSync(path.join(out, 'axe.json'), JSON.stringify(axe.violations, null, 2));
    assert.equal(axe.violations.length, 0, JSON.stringify(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))));
    results.push('Automated WCAG 2.1 AA audit: zero violations on main page');


    await p.locator('.feature-dock [data-feature="images"]').click();
    await p.locator('[data-page-next]').click();
    const detailAxe = await p.evaluate(async () => await axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));
    assert.equal(detailAxe.violations.length,0,JSON.stringify(detailAxe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))));
    await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('dialog.is-closing'));
    results.push('Compact feature dialog and glass CTA pass automated accessibility audit');

    const nojs = await browser.newPage({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
    await nojs.goto(base);
    assert.equal(await nojs.locator('.fallback-feature:visible').count(), 6);
    assert(await nojs.locator('.noscript-download a').isVisible());
    await nojs.close(); results.push('No JavaScript: six readable features, screenshots and download link');

    const fallback = await browser.newPage();
    await fallback.route('**/assets/three.module.js', r => r.abort());
    await fallback.goto(base);
    await fallback.waitForFunction(() => document.body.classList.contains('scene-failed'));
    await fallback.locator('.feature-dock [data-feature="bots"]').click();
    assert.equal(await fallback.locator('#detail-category').textContent(), 'Bots');
    await fallback.close(); results.push('Unavailable WebGL dependency retains brand and functional feature details');
    assert.equal(errors.length, 0, JSON.stringify(errors));
    results.push('No page errors or missing first-party resources');
    report(); console.log(JSON.stringify({ passed: results.length, results }, null, 2));
  } catch (e) { errors.push(e.stack); const pages=browser.contexts().flatMap(c=>c.pages()); if(pages[0]) {await pages[0].screenshot({path:path.join(out,'failure.png')}).catch(()=>{}); const state=await pages[0].evaluate(()=>({scrollY,state:window.__orbit?.getState(),dialogs:[...document.querySelectorAll('dialog')].map(d=>({id:d.id,open:d.open}))})).catch(()=>null); fs.writeFileSync(path.join(out,'failure-state.json'),JSON.stringify(state,null,2));} report(); throw e; }
  finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
