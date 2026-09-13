'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const webRoot = path.resolve(__dirname, '../../web');
const { chromium, _electron: electron } = require(path.join(webRoot, 'node_modules/playwright'));
const esbuild = require(path.join(webRoot, 'node_modules/esbuild'));
const provider = path.join(__dirname, 'fixtures/c06-shell-provider.tsx');
const preloadSource = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
const evidence = process.env.KNORVIA_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-c06-'));

async function buildHarness() {
  fs.mkdirSync(evidence, { recursive: true });
  const bundle = path.join(evidence, 'c06-shell.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'fixtures/c06-shell-harness.tsx')], bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, nodePaths: [path.join(webRoot, 'node_modules')], tsconfig: path.join(webRoot, 'tsconfig.json'),
    loader: { '.css': 'empty' }, outfile: bundle, logLevel: 'silent', plugins: [{
      name: 'c06-unrelated-shell-dependencies', setup(build) {
        build.onResolve({ filter: /^\.\/NativeWorkbenchProvider$/ }, () => ({ path: provider }));
        build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: provider }));
        build.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'c06' }));
        build.onResolve({ filter: /^\.\/(WorkbenchMark|SettingsLayout|SettingsView|PetOverlay|SidebarContent|BotSidebar|TaskAttentionMenu|SidebarResize)$/ }, () => ({ path: 'unrelated-children', namespace: 'c06' }));
        build.onLoad({ filter: /.*/, namespace: 'c06' }, ({ path: name }) => ({
          contents: name === 'link' ? `import { createElement } from 'react'; export default function Link({ children, ...props }) { return createElement('a', props, children); }`
            : `export const sidebarWidth = v => typeof v === 'number' ? v : 280; ${['WorkbenchMark', 'SettingsLayout', 'SettingsView', 'PetOverlay', 'SidebarContent', 'BotSidebar', 'TaskAttentionMenu', 'SidebarResize'].map(name => `export const ${name} = () => null;`).join('\n')}`,
          resolveDir: webRoot, loader: 'js',
        }));
      },
    }],
  });
  const html = path.join(evidence, 'c06-shell.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><title>C06 actual WorkbenchShell fixture</title></head><body><div id="root"></div><script>${fs.readFileSync(bundle, 'utf8').replace(/<\/script/gi, '<\\/script')}</script></body></html>`);
  return html;
}
async function settled(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function readSeen(page, id) { await page.waitForFunction(value => window.c06?.history.reads.includes(value), id); }
async function routed(page, id) { await page.waitForFunction(value => window.c06?.history.routes.at(-1) === `/workbench/task/${encodeURIComponent(value)}`, id); }

test('actual preload and mounted WorkbenchShell preserve task identity, lifecycle and newest navigation', { timeout: 90_000 }, async () => {
  const html = await buildHarness();
  const browser = await chromium.launch({ executablePath: process.env.KNORVIA_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const pageErrors = [], checks = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    // The exact production preload is evaluated; only Electron transport is
    // shimmed in this Chrome run. The next test uses actual Electron IPC.
    await page.addInitScript({ content: `(() => {
      const channels = new Map();
      const fixtureIpc = { on(name, fn) { channels.set(name, fn); }, invoke() { return Promise.resolve(); }, send() {}, removeListener() {} };
      const require = name => { if (name !== 'electron') throw new Error(name); return { ipcRenderer: fixtureIpc, contextBridge: { exposeInMainWorld(name, api) { window[name] = api; } } }; };
      const process = { platform: 'win32', argv: [] };
      ${preloadSource}
      window.c06Emit = id => channels.get('knorvia:open-thread')({}, id);
      window.c06Emit('before-mount');
    })();` });
    await page.goto(pathToFileURL(html).href);
    await readSeen(page, 'before-mount');
    await page.evaluate(() => window.c06.resolve('before-mount', 'project-queued'));
    await routed(page, 'before-mount');
    checks.push('queued-before-mount-flat-snapshot');

    await page.evaluate(() => { window.c06Emit('slow-a'); window.c06Emit('fast-b'); });
    await readSeen(page, 'fast-b');
    await page.evaluate(() => window.c06.resolve('fast-b', 'project-b'));
    await routed(page, 'fast-b');
    await page.evaluate(() => window.c06.resolve('slow-a', 'project-a'));
    await settled(page);
    assert.equal(await page.evaluate(() => window.c06.history.routes.at(-1)), '/workbench/task/fast-b');
    assert.equal(await page.evaluate(() => window.c06.state().workspaceId), 'project-b');
    checks.push('slow-success-cannot-overwrite-newer-click');

    await page.evaluate(() => { window.c06Emit('old-error'); window.c06Emit('new-success'); });
    await readSeen(page, 'new-success');
    await page.evaluate(() => window.c06.resolve('new-success'));
    await routed(page, 'new-success');
    await page.evaluate(() => window.c06.reject('old-error'));
    await settled(page);
    assert.deepEqual(await page.evaluate(() => window.c06.history.errors), []);
    checks.push('stale-error-cannot-overwrite-current-task');

    await page.evaluate(() => { window.c06Emit('during-rerender'); window.c06.rerender(); });
    await readSeen(page, 'during-rerender');
    await settled(page);
    await page.evaluate(() => window.c06.resolve('during-rerender'));
    await routed(page, 'during-rerender');
    assert.equal(await page.evaluate(() => window.c06.history.reads.filter(id => id === 'during-rerender').length), 1);
    checks.push('provider-rerender-does-not-drop-or-duplicate-click');

    const countBeforeUnmount = await page.evaluate(() => window.c06.history.routes.length);
    await page.evaluate(() => window.c06Emit('unmounted'));
    await readSeen(page, 'unmounted');
    await page.evaluate(() => window.c06.unmount());
    await page.getByTestId('c06-shell-unmounted').waitFor();
    await page.evaluate(() => window.c06.resolve('unmounted'));
    await settled(page);
    assert.equal(await page.evaluate(() => window.c06.history.routes.length), countBeforeUnmount);
    await page.evaluate(() => { window.c06Emit('queued-remount'); window.c06.mount(); });
    await readSeen(page, 'queued-remount');
    await page.evaluate(() => window.c06.resolve('queued-remount'));
    await routed(page, 'queued-remount');
    checks.push('unmount-blocks-late-route-and-remount-consumes-queued-once');

    await page.evaluate(() => window.c06Emit('manual-navigation'));
    await readSeen(page, 'manual-navigation');
    await page.evaluate(() => window.c06.navigate('/workbench/library'));
    await settled(page);
    const previousRoutes = await page.evaluate(() => window.c06.history.routes.length);
    await page.evaluate(() => window.c06.resolve('manual-navigation'));
    await settled(page);
    assert.equal(await page.evaluate(() => window.c06.history.routes.length), previousRoutes);
    checks.push('manual-navigation-invalidates-pending-notification');

    await page.evaluate(() => window.c06.setCached('cached-deleted'));
    await settled(page);
    await page.evaluate(() => window.c06Emit('cached-deleted'));
    await readSeen(page, 'cached-deleted');
    await page.evaluate(() => window.c06.reject('cached-deleted'));
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /Task not found/);
    assert.equal(await page.evaluate(() => window.c06.history.routes.length), previousRoutes);
    checks.push('cached-deleted-task-is-revalidated-and-visible-error');

    const previousReads = await page.evaluate(() => window.c06.history.reads.length);
    await page.evaluate(() => window.c06Emit('invalid\nid'));
    await settled(page);
    assert.equal(await page.evaluate(() => window.c06.history.reads.length), previousReads);
    assert.match(await page.getByRole('alert').innerText(), /Task not found/);
    checks.push('invalid-id-feedback-without-read-or-route');

    await page.evaluate(() => window.c06Emit('wrong-snapshot'));
    await readSeen(page, 'wrong-snapshot');
    await page.evaluate(() => window.c06.resolve('wrong-snapshot', 'wrong-project', { id: 'another-thread' }));
    await settled(page);
    assert.equal(await page.evaluate(() => window.c06.history.routes.length), previousRoutes);
    checks.push('mismatched-snapshot-cannot-change-project-or-route');
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: path.join(evidence, 'c06-shell.png') });
    fs.writeFileSync(path.join(evidence, 'c06-component-result.json'), JSON.stringify({ mode: 'actual WorkbenchShell + actual preload in installed Chrome; provider/Next router/unrelated child components shimmed', checks, pageErrors }, null, 2));
  } catch (error) {
    const state = await page.evaluate(() => ({ history: window.c06?.history, desktop: Boolean(window.knorviaDesktop), emit: typeof window.c06Emit, text: document.body.innerText })).catch(() => null);
    fs.writeFileSync(path.join(evidence, 'c06-component-failure.json'), JSON.stringify({ checks, pageErrors, state, error: String(error) }, null, 2));
    throw error;
  } finally { await browser.close(); }
});

test('real Electron notification relay crosses real IPC and preload into actual WorkbenchShell, including reload', { timeout: 90_000 }, async () => {
  const html = await buildHarness();
  const electronApp = await electron.launch({ executablePath: require(path.join(__dirname, '../node_modules/electron')), args: [path.join(__dirname, 'fixtures/c06-notification-electron.cjs')], env: { ...process.env, KNORVIA_C06_ELECTRON_HOME: path.join(evidence, 'electron-home'), KNORVIA_C06_HTML: html } });
  try {
    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(10_000);
    await page.getByTestId('c06-shell-mounted').waitFor();
    await electronApp.evaluate(() => { globalThis.c06Electron.setReady(false); globalThis.c06Electron.notify('electron-queued', 'turn-1'); globalThis.c06Electron.click(); });
    assert.equal((await electronApp.evaluate(() => globalThis.c06Electron.stats())).pending, true);
    await electronApp.evaluate(() => { globalThis.c06Electron.setReady(true); globalThis.c06Electron.flush(); globalThis.c06Electron.flush(); });
    await readSeen(page, 'electron-queued');
    await page.evaluate(() => window.c06.resolve('electron-queued', 'electron-project'));
    await routed(page, 'electron-queued');
    assert.equal(await page.evaluate(() => window.c06.history.reads.filter(id => id === 'electron-queued').length), 1);
    assert.equal(await page.evaluate(() => window.c06.state().workspaceId), 'electron-project');

    await electronApp.evaluate(() => { globalThis.c06Electron.setReady(false); globalThis.c06Electron.notify('electron-reload', 'turn-2'); globalThis.c06Electron.click(); });
    await page.reload();
    await readSeen(page, 'electron-reload');
    await page.evaluate(() => window.c06.resolve('electron-reload', 'reload-project'));
    await routed(page, 'electron-reload');
    const stats = await electronApp.evaluate(() => globalThis.c06Electron.stats());
    assert.equal(stats.activations, 2);
    assert.equal(stats.pending, false);
    assert.equal(await page.evaluate(() => window.c06.history.reads.filter(id => id === 'electron-reload').length), 1);
    fs.writeFileSync(path.join(evidence, 'c06-electron-result.json'), JSON.stringify({ mode: 'real Electron + production TurnNotifier/open-thread bridge/preload + actual WorkbenchShell; synthetic Notification click event, provider/router shimmed', osNotificationClicked: false, checks: ['pending-before-ready', 'real-IPC-preload-route-and-project', 'duplicate-flush-once', 'reload-before-shell-ready'], stats }, null, 2));
  } finally { await electronApp.close(); }
});
