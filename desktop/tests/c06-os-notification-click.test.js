'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const webRoot = path.resolve(__dirname, '../../web');
const { _electron: electron } = require(path.join(webRoot, 'node_modules/playwright'));
const esbuild = require(path.join(webRoot, 'node_modules/esbuild'));
const provider = path.join(__dirname, 'fixtures/c06-shell-provider.tsx');
const evidence = process.env.KNORVIA_EVIDENCE_DIR || path.resolve(__dirname, '../../runtime/G/evidence');

async function ensureHarness() {
  fs.mkdirSync(evidence, { recursive: true });
  const html = path.join(evidence, 'c06-shell.html');
  // Always rebuild from this checkout; a previous bundle is not source evidence.
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
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><title>C06 actual WorkbenchShell fixture</title></head><body><div id="root"></div><script>${fs.readFileSync(bundle, 'utf8').replace(/<\/script/gi, '<\\/script')}</script></body></html>`);
  return html;
}

function clickWindowsToast() {
  const python = process.env.PYTHON_BIN || 'C:/Users/17018/AppData/Local/Programs/Python/Python313/python.exe';
  const pyCode = `
import ctypes, time
user32 = ctypes.windll.user32
hdesk = user32.OpenInputDesktop(0, False, 0x01FF)
if hdesk: user32.SetThreadDesktop(hdesk)
w = user32.GetSystemMetrics(0)
h = user32.GetSystemMetrics(1)
user32.SetCursorPos(w - 180, h - 100)
time.sleep(0.05)
user32.mouse_event(0x0002, 0, 0, 0, 0)
time.sleep(0.05)
user32.mouse_event(0x0004, 0, 0, 0, 0)
`;
  spawnSync(python, ['-c', pyCode], { windowsHide: true });
}

// Interactive desktop input is an explicit acceptance run, never part of the
// ordinary node test sweep (which must not move the user's pointer).
test('real Windows OS toast notification click activates window and navigates to task', {
  timeout: 90_000,
  skip: process.platform !== 'win32' || process.env.KNORVIA_RUN_OS_NOTIFICATION_TEST !== '1',
}, async () => {
  const html = await ensureHarness();
  const electronExe = process.env.KNORVIA_ELECTRON_BIN || path.resolve(__dirname, '../node_modules/electron/dist/electron.exe');
  const electronApp = await electron.launch({
    executablePath: electronExe,
    args: [path.join(__dirname, 'fixtures/c06-notification-electron.cjs')],
    env: {
      ...process.env,
      KNORVIA_C06_OS_CLICK: '1',
      KNORVIA_C06_ELECTRON_HOME: path.join(evidence, 'electron-os-home'),
      KNORVIA_C06_HTML: html,
    },
  });

  try {
    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.getByTestId('c06-shell-mounted').waitFor();

    const handled = await electronApp.evaluate(() => globalThis.c06Electron.notify('os-toast-task-42', 'turn-1'));
    assert.equal(handled, true, 'TurnNotifier must handle terminal turn event');

    // Wait for real Notification show event
    let shown = false;
    for (let i = 0; i < 40; i++) {
      const stats = await electronApp.evaluate(() => globalThis.c06Electron.stats());
      if (stats.notificationEvents.some(e => e.event === 'show')) {
        shown = true;
        break;
      }
      await new Promise(r => setTimeout(r, 150));
    }
    assert.ok(shown, 'OS notification banner show event must be received');

    // Click OS notification toast via input desktop
    await new Promise(r => setTimeout(r, 400));
    clickWindowsToast();

    // Verify Notification click event emitted by OS
    let clicked = false;
    for (let i = 0; i < 40; i++) {
      const stats = await electronApp.evaluate(() => globalThis.c06Electron.stats());
      if (stats.notificationEvents.some(e => e.event === 'click')) {
        clicked = true;
        break;
      }
      await new Promise(r => setTimeout(r, 150));
    }
    assert.ok(clicked, 'Real OS Notification click event must be observed');

    // Verify WorkbenchShell received read request and navigate
    await page.waitForFunction(value => window.c06?.history.reads.includes(value), 'os-toast-task-42');
    await page.evaluate(() => window.c06.resolve('os-toast-task-42', 'os-project-alpha'));
    await page.waitForFunction(value => window.c06?.history.routes.at(-1) === `/workbench/task/${encodeURIComponent(value)}`, 'os-toast-task-42');

    const finalStats = await electronApp.evaluate(() => globalThis.c06Electron.stats());
    assert.ok(finalStats.activations >= 1, 'Window must be activated by OS notification click');
    assert.equal(finalStats.pending, false);

    const report = {
      mode: 'real Windows OS Notification toast click + production TurnNotifier/open-thread bridge/preload + actual WorkbenchShell',
      osNotificationClicked: true,
      stats: finalStats,
      success: true,
      readTasks: await page.evaluate(() => window.c06.history.reads),
      routes: await page.evaluate(() => window.c06.history.routes),
    };
    fs.writeFileSync(path.join(evidence, 'c06-os-click-result.json'), JSON.stringify(report, null, 2));
  } finally {
    await electronApp.close();
  }
});
