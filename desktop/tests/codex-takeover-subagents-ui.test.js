'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../../web/node_modules/playwright');
const { startNativeGatewayFixture } = require('./fixtures/start-native-gateway-fixture');
const evidence = path.resolve(__dirname, '../../release/codex-integration-20260908/runtime');
const frontend = process.env.KNORVIA_SUBAGENT_UI_URL;
test('Chrome displays two completed agents from the real Kernel durable task without spinners', { timeout: 120000, skip: !frontend && 'Set KNORVIA_SUBAGENT_UI_URL to the running isolated frontend' }, async () => {
  const recorded = JSON.parse(fs.readFileSync(path.join(evidence, 'multiagent-responses-result.json'), 'utf8'));
  assert.equal(recorded.turn.status, 'completed');
  assert.equal(new Set(recorded.childIds).size, 2);
  const fixture = await startNativeGatewayFixture({ home: recorded.home, port: 0, daemonBin: recorded.daemonBin, kernelBin: recorded.kernelBin });
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--no-proxy-server'] });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1060 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const failedRequests = [];
  page.on('pageerror', error => failedRequests.push(error.message));
  await context.addInitScript(() => localStorage.setItem('knorvia-language', 'zh'));
  // Only this isolated browser context gets a session to the historical
  // fixture gateway. The normal studio gateway remains untouched.
  await page.route('**/api/knorvia/native/session', async route => {
    const response = await fetch(fixture.location.url + fixture.location.nativeSessionPath, { headers: { origin: frontend } });
    assert.equal(response.status, 200);
    const session = await response.json(); session.url = fixture.location.url.replace('http:', 'ws:') + fixture.location.nativePath;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
  });
  try {
    await page.goto(frontend + '/workbench/task/' + recorded.turn.threadId);
    const groups = page.locator('.nw-subagents .nw-subagent');
    await groups.first().waitFor({ timeout: 35000 });
    assert.equal(await groups.count(), 2);
    await page.locator('.nw-subagents').screenshot({ path: path.join(evidence, 'subagents-chrome-groups.png') });
    const identities = [], text = [];
    for (let index = 0; index < 2; index++) {
      const group = groups.nth(index);
      assert.match(await group.locator(':scope > summary').innerText(), /已完成/);
      await group.locator(':scope > summary').click();
      await group.locator('.nw-subagent-detail').waitFor();
      assert.ok(await group.locator('.nw-subagent-event').count() > 0);
      text.push(await group.locator('.nw-subagent-detail').innerText());
      await group.locator('.nw-subagent-identity > summary').click();
      identities.push(await group.locator('.nw-subagent-identity code').innerText());
    }
    assert.deepEqual([...identities].sort(), [...recorded.childIds].sort());
    assert.equal(await page.locator('.nw-subagents .nw-spin').count(), 0);
    assert.equal(await page.getByRole('button', { name: '停止这个代理', exact: true }).count(), 0);
    for (const token of ['alpha', 'beta']) assert.ok(text.some(value => value.toLowerCase().includes(token)), token + ' historical output should be visible');
    await groups.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, 'subagents-chrome-expanded.png'), fullPage: true });
    await page.reload(); await groups.first().waitFor({ timeout: 15000 });
    assert.equal(await groups.count(), 2);
    assert.equal(await page.locator('.nw-subagents .nw-spin').count(), 0);
    fs.writeFileSync(path.join(evidence, 'subagents-ui-result.json'), JSON.stringify({ mode: 'real Kernel durable history rendered through a fresh isolated gateway; not live replay', home: recorded.home, productThreadId: recorded.turn.threadId, productTurnId: recorded.turn.id, identities, groups: 2, statuses: ['completed', 'completed'], spinnerCount: 0, outputs: text, pageErrors: failedRequests, reloadPassed: true }, null, 2));
  } finally { await context.close(); await browser.close(); await fixture.close(); }
});
