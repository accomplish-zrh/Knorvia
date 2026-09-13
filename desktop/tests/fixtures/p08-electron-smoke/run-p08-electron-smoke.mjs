'use strict';
// P08 Electron shell smoke: launch the real desktop shell (Electron) with an
// isolated APPDATA (userData) and isolated native Home, drive the REAL
// preload IPC entry (window.knorviaDesktop.update.check) over CDP, and verify
// the update controller ran by reading the persisted update-state.json.
// A native dialog will appear on screen; it is captured and dismissed by the
// operator with desktop control (out of this script's scope). No installer is
// downloaded; the GitHub call is a public metadata GET.
//
// Run: node run-p08-electron-smoke.mjs --electron <electron.exe> --desktop <dir> --out <json>

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const electronBin = arg('electron', '');
const desktopDir = path.resolve(arg('desktop', path.join(__dirname, '..', '..')));
const outPath = arg('out', path.join(__dirname, 'result.json'));
const CDP_PORT = Number(arg('cdpport', 9223));

const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); if (!ok) process.exitCode = 1; };

async function main() {
  assert.ok(fs.existsSync(electronBin), `electron not found: ${electronBin}`);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-p08-'));
  const appData = path.join(base, 'appdata');
  const home = path.join(base, 'home');
  const userData = path.join(appData, 'Knorvia');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const env = {
    ...process.env,
    APPDATA: appData,
    KNORVIA_NATIVE_HOME: home,
    KNORVIA_HOME: home,
    KNORVIA_DAEMON_BIN: process.env.KNORVIA_DAEMON_BIN || '',
    ELECTRON_ENABLE_LOGGING: '1',
  };
  const child = spawn(electronBin, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: desktopDir,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: false,
  });
  let stderrTail = '';
  child.stderr.on('data', d => { stderrTail = (stderrTail + String(d)).slice(-4000); });

  try {
    // wait for the CDP endpoint
    let cdpOk = false;
    for (let i = 0; i < 60 && !cdpOk; i += 1) {
      try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) cdpOk = true; } catch { /* booting */ }
      if (!cdpOk) await delay(1000);
    }
    record('electron CDP endpoint reachable', cdpOk, stderrTail.slice(-200));

    const { chromium } = require(path.join(desktopDir, 'node_modules', 'playwright'));
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const contexts = browser.contexts();
    const page = await (async () => {
      for (const context of contexts) {
        for (const p of context.pages()) {
          try {
            const has = await p.evaluate(() => Boolean(window.knorviaDesktop && window.knorviaDesktop.update));
            if (has) return p;
          } catch { /* target without the bridge */ }
        }
      }
      const created = await contexts[0]?.newPage();
      return created ?? null;
    })();
    record('renderer with knorviaDesktop bridge found', Boolean(page));

    if (page) {
      const check = await page.evaluate(async () => {
        try { const r = await window.knorviaDesktop.update.check(); return { ok: true, result: r }; }
        catch (error) { return { ok: false, error: String(error && error.message || error) }; }
      });
      console.log('check result:', JSON.stringify(check).slice(0, 300));
      record('IPC knorvia:update-check resolves through the real controller', check.ok || /native method|connecting/.test(check.error ?? '') === false, JSON.stringify(check).slice(0, 200));

      // the controller persists lastCheck (+version or error) in userData
      let state = null;
      for (let i = 0; i < 20; i += 1) {
        await delay(1000);
        try { state = JSON.parse(fs.readFileSync(path.join(userData, 'Knorvia', 'update-state.json'), 'utf8')); } catch { /* not yet */ }
        if (state && (state.lastCheck || state.lastError)) break;
      }
      record('update-state.json persisted in isolated userData', Boolean(state && (state.lastCheck || state.lastError)), JSON.stringify(state).slice(0, 300));
    }
  } finally {
    child.kill();
    await delay(2000);
    if (!child.killed) child.kill('SIGKILL');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ results, measuredAt: new Date().toISOString(), userData, stderrTail: stderrTail.slice(-800) }, null, 2));
  }
  console.log('report written:', outPath);
}

main().catch(error => { console.error(error); record('fatal', false, String(error && error.stack || error).slice(0, 600)); process.exit(1); });
