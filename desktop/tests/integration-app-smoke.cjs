'use strict';

/**
 * Knorvia Desktop Integration Smoke Test (Closed-Loop & Hardened)
 *
 * Verifies the complete production stack from end to end:
 * Real Electron binary -> Next.js renderer -> Preload bridge ->
 * Knorvia Daemon -> Fixed Kernel App-Server -> Local Scripted Responses Fixture.
 *
 * Supports two modes:
 *  1. Source mode (default): Uses unpacked Electron, stages web-integration,
 *     passes KNORVIA_DAEMON_BIN / KERNEL_BIN / NODE_BIN / KNORVIA_WORKSPACE_ROOT.
 *  2. Packaged mode (--packaged-app <Knorvia.exe>): Launches the packaged executable
 *     directly without '.', without external web/daemon/kernel/node overrides.
 *
 * Hardened assertions:
 *  - KNORVIA_WORKSPACE_ROOT set to dedicated runtime/home.
 *  - system/paths actual home strictly verified to match KNORVIA_WORKSPACE_ROOT BEFORE thread/start.
 *  - Exact returned turn ID assertion (no fallback to any completed turn).
 *  - Strict exact assistant message text assertion.
 *  - Required userData verification (fails test if missing/empty).
 *  - Real durability verification: forced app restart with same isolated home,
 *    re-querying thread/read to assert durable persistence of the completed turn and items.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const WebSocket = require('ws');

const desktopRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(desktopRoot, '..');

// Parse CLI args helper
const getArg = (name, fallback) => {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
};

const PACKAGED_APP_BIN = getArg('packaged-app', '');
const PACKAGED_RUNTIME = getArg('packaged-runtime', '');

const DEFAULT_RUNTIME_ROOT = 'D:/tools/knorvia-integration-20260911/runtime/antigravity-v2';
const DEFAULT_EVIDENCE_ROOT = 'D:/tools/knorvia-integration-20260911/evidence/antigravity-v2';

const RUNTIME_ROOT = path.resolve(getArg('runtime-root', process.env.KNORVIA_INTEGRATION_RUNTIME || DEFAULT_RUNTIME_ROOT));
const EVIDENCE_ROOT = path.resolve(getArg('evidence-root', process.env.KNORVIA_INTEGRATION_EVIDENCE || DEFAULT_EVIDENCE_ROOT));

// Default to newly built debug daemon
const DEFAULT_DEBUG_DAEMON = 'D:/tools/knorvia-nightshift-20260909/cache/A-native-target-d2/debug/knorvia-daemon.exe';
const DAEMON_BIN = getArg('daemon', process.env.KNORVIA_DAEMON_BIN || DEFAULT_DEBUG_DAEMON);
const KERNEL_BIN = getArg('kernel', process.env.KNORVIA_KERNEL_BIN || 'D:/tools/knorvia-kernel/codex-rs/target/debug/codex-app-server.exe');
const ELECTRON_BIN = getArg('electron', process.env.KNORVIA_ELECTRON_BIN || path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe'));
const NODE_BIN = getArg('node', process.env.KNORVIA_NODE_BIN || 'D:/node-v26.3.0-win-x64/node.exe');

const FIXTURE_PORT = Number(getArg('fixture-port', 4611));
const CDP_PORT = Number(getArg('cdp-port', 4612));

const HOME_DIR = path.resolve(RUNTIME_ROOT, 'home');
const USER_DATA_DIR = path.resolve(RUNTIME_ROOT, 'electron-user-data');
const APPDATA_DIR = path.resolve(RUNTIME_ROOT, 'appdata');
const LOCALAPPDATA_DIR = path.resolve(RUNTIME_ROOT, 'localappdata');
const TEMP_DIR = path.resolve(RUNTIME_ROOT, 'temp');
const REGISTRY_FILE = path.resolve(RUNTIME_ROOT, 'PROCESS-REGISTRY.jsonl');

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function registerProcess(pid, entry, purpose) {
  try {
    const record = {
      pid,
      entry,
      purpose,
      registeredAt: new Date().toISOString(),
      stop: 'taskkill /PID <pid> /T /F',
    };
    fs.appendFileSync(REGISTRY_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    console.warn('Failed to write process registry:', e.message);
  }
}

function killPidTree(pid) {
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
  } catch {}
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.reqId = 0;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', data => {
      try {
        const msg = JSON.parse(data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch (e) {}
    });
  }

  send(method, params = {}) {
    const id = ++this.reqId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res?.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`CDP eval exception: ${msg}`);
    }
    return res?.result?.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

function stageWebIntegrationDir(stagingDir) {
  const integrationDist = path.join(projectRoot, 'web', '.next-integration-20260911');
  const knorviaDist = path.join(projectRoot, 'web', '.next-knorvia');

  if (fs.existsSync(path.join(integrationDist, 'standalone', '.next-integration-20260911', 'required-server-files.json'))) {
    log('Staging Next.js standalone with .next-integration-20260911...');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'renderer.json'), JSON.stringify({ schemaVersion: 1, distDir: '.next-integration-20260911' }), 'utf8');

    const srcStandalone = path.join(integrationDist, 'standalone');
    fs.copyFileSync(path.join(srcStandalone, 'server.js'), path.join(stagingDir, 'server.js'));
    fs.copyFileSync(path.join(srcStandalone, 'package.json'), path.join(stagingDir, 'package.json'));

    const mkJunction = (target, linkPath) => {
      if (!fs.existsSync(linkPath)) {
        try { execSync(`cmd /c mklink /J "${linkPath}" "${target}"`, { stdio: 'ignore' }); } catch {}
      }
    };
    mkJunction(path.join(srcStandalone, '.next-integration-20260911'), path.join(stagingDir, '.next-integration-20260911'));
    mkJunction(path.join(srcStandalone, 'node_modules'), path.join(stagingDir, 'node_modules'));
    if (fs.existsSync(path.join(integrationDist, 'static'))) {
      mkJunction(path.join(integrationDist, 'static'), path.join(stagingDir, '.next-integration-20260911', 'static'));
    }
    if (fs.existsSync(path.join(projectRoot, 'web', 'public'))) {
      mkJunction(path.join(projectRoot, 'web', 'public'), path.join(stagingDir, 'public'));
    }
    return { webDir: stagingDir, distDir: '.next-integration-20260911' };
  }

  if (fs.existsSync(path.join(knorviaDist, 'standalone', '.next-knorvia', 'required-server-files.json'))) {
    log('Using existing .next-knorvia standalone...');
    return { webDir: path.join(knorviaDist, 'standalone'), distDir: '.next-knorvia' };
  }

  throw new Error('Neither .next-integration-20260911 nor .next-knorvia standalone is available.');
}

async function launchElectronSession({ isPackaged, webConfig, fixtureBaseUrl, sessionLabel }) {
  log(`Launching Electron session [${sessionLabel}] (mode: ${isPackaged ? 'packaged' : 'source'})...`);
  let child;
  let env;

  if (isPackaged) {
    // Packaged mode: No external KNORVIA_WEB_DIR, KNORVIA_DAEMON_BIN, KERNEL_BIN, NODE_BIN overrides!
    env = {
      ...process.env,
      KNORVIA_WORKSPACE_ROOT: HOME_DIR,
      KNORVIA_HOME: HOME_DIR,
      KNORVIA_PROVIDER_BASE_URL: fixtureBaseUrl,
      KNORVIA_PROVIDER_API_KEY: 'local-fixture-only',
      KNORVIA_PROVIDER_MODEL: 'gpt-5.2',
      KNORVIA_PROVIDER_PROTOCOL: 'responses',
      KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1',
      KNORVIA_KERNEL_TURN_TIMEOUT_SECS: '90',
      APPDATA: APPDATA_DIR,
      LOCALAPPDATA: LOCALAPPDATA_DIR,
      USERPROFILE: HOME_DIR,
      HOME: HOME_DIR,
      TEMP: TEMP_DIR,
      TMP: TEMP_DIR,
      ELECTRON_ENABLE_LOGGING: '1',
    };
    for (const key of ['KNORVIA_WEB_DIR', 'KNORVIA_WEB_ROOT', 'KNORVIA_DAEMON_BIN', 'KNORVIA_KERNEL_BIN', 'KNORVIA_NODE_BIN', 'KNORVIA_RUNTIME_ROOT', 'KNORVIA_NEXT_DIST_DIR', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    child = spawn(PACKAGED_APP_BIN, [
      `--user-data-dir=${USER_DATA_DIR}`,
      '--no-sandbox',
      `--remote-debugging-port=${CDP_PORT}`,
    ], {
      cwd: path.dirname(PACKAGED_APP_BIN),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    // Source mode: Explicitly wire newly built daemon, kernel, node, staged web renderer, and KNORVIA_WORKSPACE_ROOT
    env = {
      ...process.env,
      KNORVIA_WORKSPACE_ROOT: HOME_DIR,
      KNORVIA_HOME: HOME_DIR,
      KNORVIA_NATIVE_HOME: HOME_DIR,
      KNORVIA_DAEMON_BIN: DAEMON_BIN,
      KNORVIA_KERNEL_BIN: KERNEL_BIN,
      KNORVIA_NODE_BIN: NODE_BIN,
      KNORVIA_WEB_DIR: webConfig.webDir,
      KNORVIA_NEXT_DIST_DIR: webConfig.distDir,
      KNORVIA_PROVIDER_BASE_URL: fixtureBaseUrl,
      KNORVIA_PROVIDER_API_KEY: 'local-fixture-only',
      KNORVIA_PROVIDER_MODEL: 'gpt-5.2',
      KNORVIA_PROVIDER_PROTOCOL: 'responses',
      KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1',
      KNORVIA_KERNEL_TURN_TIMEOUT_SECS: '90',
      APPDATA: APPDATA_DIR,
      LOCALAPPDATA: LOCALAPPDATA_DIR,
      USERPROFILE: HOME_DIR,
      HOME: HOME_DIR,
      TEMP: TEMP_DIR,
      TMP: TEMP_DIR,
      ELECTRON_ENABLE_LOGGING: '1',
    };
    child = spawn(ELECTRON_BIN, [
      '.',
      `--user-data-dir=${USER_DATA_DIR}`,
      '--no-sandbox',
      `--remote-debugging-port=${CDP_PORT}`,
    ], {
      cwd: desktopRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  registerProcess(child.pid, isPackaged ? PACKAGED_APP_BIN : `${ELECTRON_BIN} .`, `Integration smoke Electron [${sessionLabel}]`);

  let stderrTail = '';
  child.stderr.on('data', d => {
    stderrTail = (stderrTail + String(d)).slice(-4000);
  });

  // Connect CDP
  log(`Waiting for CDP endpoint on 127.0.0.1:${CDP_PORT}...`);
  let pageTarget = null;
  for (let i = 0; i < 45; i++) {
    try {
      const targets = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json`);
      pageTarget = targets.find(t => t.type === 'page' && (t.url.startsWith('knorvia://') || t.url.includes('data:')));
      if (pageTarget) break;
    } catch (e) {}
    await delay(1000);
  }
  if (!pageTarget) {
    killPidTree(child.pid);
    throw new Error(`CDP page target not found within 45s for [${sessionLabel}]. Stderr: ${stderrTail.slice(-400)}`);
  }

  const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();

  // Wait for preload
  log(`Waiting for preload bridge on [${sessionLabel}]...`);
  let bridgeReady = false;
  for (let i = 0; i < 45; i++) {
    try {
      const probe = await cdp.eval(`(() => {
        return {
          href: window.location.href,
          hasDesktop: Boolean(window.knorviaDesktop),
          hasNative: Boolean(window.knorviaDesktop?.native?.request),
        };
      })()`);
      if (probe?.hasNative && probe?.href?.startsWith('knorvia://app')) {
        bridgeReady = true;
        break;
      }
    } catch (e) {}
    await delay(1000);
  }
  if (!bridgeReady) {
    cdp.close();
    killPidTree(child.pid);
    throw new Error(`Preload bridge not ready within 45s on [${sessionLabel}]`);
  }

  const close = async () => {
    cdp.close();
    killPidTree(child.pid);
    await delay(1500);
  };

  return { child, cdp, close };
}

async function runSmoke() {
  const startTime = Date.now();
  const isPackaged = Boolean(PACKAGED_APP_BIN);
  const report = {
    testName: 'integration-app-smoke',
    executedAt: new Date().toISOString(),
    mode: isPackaged ? 'packaged' : 'source',
    configuration: {
      isPackaged,
      packagedAppBin: PACKAGED_APP_BIN || null,
      packagedRuntime: PACKAGED_RUNTIME || null,
      daemonBin: isPackaged ? '(packaged)' : DAEMON_BIN,
      kernelBin: isPackaged ? '(packaged)' : KERNEL_BIN,
      electronBin: isPackaged ? PACKAGED_APP_BIN : ELECTRON_BIN,
      nodeBin: isPackaged ? '(packaged)' : NODE_BIN,
      workspaceRoot: HOME_DIR,
      fixturePort: FIXTURE_PORT,
      cdpPort: CDP_PORT,
      runtimeRoot: RUNTIME_ROOT,
      evidenceRoot: EVIDENCE_ROOT,
    },
    stages: [],
    success: false,
    durationMs: 0,
  };

  const recordStage = (name, ok, details = {}) => {
    log(`[STAGE] ${ok ? 'PASS' : 'FAIL'} - ${name}`);
    report.stages.push({ name, ok, details, at: new Date().toISOString() });
    if (!ok) report.failureReason = details.error || name;
  };

  // 1. Verify binaries
  log('Step 1: Checking required executables...');
  if (isPackaged) {
    if (!fs.existsSync(PACKAGED_APP_BIN)) {
      recordStage('Binary verification: Packaged App', false, { path: PACKAGED_APP_BIN });
      throw new Error(`Missing packaged app binary at ${PACKAGED_APP_BIN}`);
    }
    recordStage('Binary verification: Packaged App', true, { path: PACKAGED_APP_BIN });
  } else {
    for (const [name, p] of Object.entries({ Daemon: DAEMON_BIN, Kernel: KERNEL_BIN, Electron: ELECTRON_BIN, Node: NODE_BIN })) {
      if (!fs.existsSync(p)) {
        recordStage(`Binary verification: ${name}`, false, { path: p, error: 'File not found' });
        throw new Error(`Missing binary: ${name} at ${p}`);
      }
      recordStage(`Binary verification: ${name}`, true, { path: p });
    }
  }

  // 2. Prepare runtime directories
  log('Step 2: Preparing isolated runtime directories...');
  for (const d of [HOME_DIR, USER_DATA_DIR, APPDATA_DIR, LOCALAPPDATA_DIR, TEMP_DIR, EVIDENCE_ROOT]) {
    fs.mkdirSync(d, { recursive: true });
  }
  recordStage('Runtime directories prepared', true, { runtimeRoot: RUNTIME_ROOT, homeDir: HOME_DIR });

  // 3. Stage web renderer (source mode only)
  let webConfig = null;
  if (!isPackaged) {
    log('Step 3: Staging web renderer...');
    const stagingDir = path.join(RUNTIME_ROOT, 'web-integration');
    webConfig = stageWebIntegrationDir(stagingDir);
    recordStage('Web renderer staged', true, webConfig);
  }

  // 4. Start local scripted responses fixture
  log(`Step 4: Starting scripted responses fixture on port ${FIXTURE_PORT}...`);
  const { startScriptedResponsesFixture } = require(path.join(desktopRoot, 'tests', 'fixtures', 'scripted-responses-fixture.js'));
  const fixture = await startScriptedResponsesFixture({ port: FIXTURE_PORT, host: '127.0.0.1' });
  recordStage('Scripted responses fixture started', true, { baseUrl: fixture.baseUrl });

  let session1 = null;
  let session2 = null;

  try {
    // 5. Launch Session 1
    session1 = await launchElectronSession({
      isPackaged,
      webConfig,
      fixtureBaseUrl: fixture.baseUrl,
      sessionLabel: 'Session 1 - First Boot',
    });
    recordStage('Session 1 booted and ready', true, { pid: session1.child.pid });

    // 6. Assert isolated home BEFORE thread/start
    log('Step 6: Asserting actual daemon home equals KNORVIA_WORKSPACE_ROOT...');
    const health = await session1.cdp.eval(`window.knorviaDesktop.native.request({
      jsonrpc: "2.0",
      id: "smoke-health",
      method: "system/health",
      params: {}
    })`);
    assert.equal(health?.result?.ok, true, 'system/health must be ok');
    assert.equal(health?.result?.server, 'knorvia-daemon', 'server must be knorvia-daemon');

    // Query system/paths for daemon home authority
    const pathsRes = await session1.cdp.eval(`window.knorviaDesktop.native.request({
      jsonrpc: "2.0",
      id: "smoke-paths",
      method: "system/paths",
      params: {}
    })`);
    const actualHome = pathsRes?.result?.home;
    assert.ok(actualHome, 'system/paths must return home');
    assert.equal(
      path.resolve(actualHome).toLowerCase(),
      path.resolve(HOME_DIR).toLowerCase(),
      `Actual daemon home (${actualHome}) must strictly equal isolated KNORVIA_WORKSPACE_ROOT (${HOME_DIR})`
    );
    recordStage('Daemon home verified isolated', true, { actualHome, expectedHome: HOME_DIR });

    // 7. Workspace resolution
    log('Step 7: Resolving workspace...');
    const wsList = await session1.cdp.eval(`window.knorviaDesktop.native.request({
      jsonrpc: "2.0",
      id: "smoke-ws-list",
      method: "workspace/list",
      params: {}
    })`);
    const workspaceId = wsList?.result?.workspaces?.[0]?.id || wsList?.result?.[0]?.id;
    assert.ok(workspaceId, `Workspace required from daemon: ${JSON.stringify(wsList)}`);
    recordStage('Workspace resolved', true, { workspaceId });

    // 8. Start Thread & Turn
    const runId = Date.now();
    log(`Step 8: Starting task thread [${runId}]...`);
    const threadRes = await session1.cdp.eval(`window.knorviaDesktop.native.request({
      jsonrpc: "2.0",
      id: "smoke-th-start",
      method: "thread/start",
      params: {
        workspaceId: "${workspaceId}",
        title: "Integration Verification Task ${runId}",
        idempotencyKey: "smoke-th-${runId}"
      }
    })`);
    const threadId = threadRes?.result?.id;
    assert.ok(threadId, `thread/start failed: ${JSON.stringify(threadRes)}`);
    recordStage('Thread started', true, { threadId });

    log('Step 9: Starting turn and sending intent...');
    const turnRes = await session1.cdp.eval(`window.knorviaDesktop.native.request({
      jsonrpc: "2.0",
      id: "smoke-turn-start",
      method: "turn/start",
      params: {
        threadId: "${threadId}",
        input: "Hello Electron integration verification task",
        idempotencyKey: "smoke-turn-${runId}"
      }
    })`);
    const expectedTurnId = turnRes?.result?.turn?.id || turnRes?.result?.id;
    assert.ok(expectedTurnId, `turn/start failed: ${JSON.stringify(turnRes)}`);
    recordStage('Turn started', true, { expectedTurnId });

    // 9. Await exact turn completion
    log(`Step 10: Polling thread/read for exact turn [${expectedTurnId}] completion...`);
    let completedTurn = null;
    let finalSnapshot = null;
    for (let i = 0; i < 45; i++) {
      await delay(1000);
      const readRes = await session1.cdp.eval(`window.knorviaDesktop.native.request({
        jsonrpc: "2.0",
        id: "smoke-th-read-${i}",
        method: "thread/read",
        params: { id: "${threadId}" }
      })`);
      const snapshot = readRes?.result;
      if (snapshot?.turns?.length > 0) {
        // STRICT: Match exact returned turn ID, NO fallback to any other completed turn!
        const exactTurn = snapshot.turns.find(t => t.id === expectedTurnId);
        if (exactTurn && exactTurn.status === 'completed') {
          completedTurn = exactTurn;
          finalSnapshot = snapshot;
          break;
        }
      }
    }
    assert.ok(completedTurn, `Turn [${expectedTurnId}] failed to reach 'completed' within 45s`);

    // 10. Strict assertions on content, tokens, fixture
    log('Step 11: Asserting strict assistant text, tokens, and fixture requests...');
    const assistantItem = finalSnapshot.items?.find(it => it.kind === 'agentMessage' || it.role === 'assistant');
    assert.ok(assistantItem, 'Thread must contain an assistant message item');
    const assistantText = assistantItem?.payload?.text || '';
    assert.equal(assistantText, 'scripted native fixture response', 'Assistant text must match fixture exactly');

    const tokenItem = finalSnapshot.items?.find(it => it.kind === 'tokenUsage');
    const totalTokens = tokenItem?.payload?.tokenUsage?.total?.totalTokens ?? 0;
    assert.ok(totalTokens > 0, `Total tokens must be > 0, got ${totalTokens}`);

    assert.ok(fixture.requests.length >= 1, `Fixture must have received >= 1 request, got ${fixture.requests.length}`);
    recordStage('Exact turn completion and content assertions', true, {
      turnId: expectedTurnId,
      assistantText,
      totalTokens,
      fixtureRequestsCount: fixture.requests.length,
    });

    // 11. Required userData check: MUST fail if empty/missing
    log('Step 12: Verifying Electron userData directory...');
    assert.ok(fs.existsSync(USER_DATA_DIR), 'userData directory must exist');
    const userDataFiles = fs.readdirSync(USER_DATA_DIR);
    assert.ok(userDataFiles.length > 0, `userData directory (${USER_DATA_DIR}) cannot be empty!`);
    recordStage('Electron userData verification', true, { fileCount: userDataFiles.length, path: USER_DATA_DIR });

    const screenshot = await session1.cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(EVIDENCE_ROOT, 'application.png'), Buffer.from(screenshot.data, 'base64'));

    // 12. Force-stop Session 1 to verify already-completed state survives.
    log('Step 13: Force-stopping Session 1...');
    await session1.close();
    session1 = null;
    recordStage('Session 1 force-stopped', true);

    // 13. Persistence & Durability Verification across App Restart
    log('Step 14: Launching Session 2 (restart verification using SAME isolated home)...');
    session2 = await launchElectronSession({
      isPackaged,
      webConfig,
      fixtureBaseUrl: fixture.baseUrl,
      sessionLabel: 'Session 2 - Restart Boot',
    });
    recordStage('Session 2 booted and ready', true, { pid: session2.child.pid });

    log('Step 15: Verifying durable persistence of thread and turn in Session 2...');
    const restartPaths = await session2.cdp.eval(`window.knorviaDesktop.native.request({
      jsonrpc: "2.0",
      id: "smoke-paths-2",
      method: "system/paths",
      params: {}
    })`);
    assert.equal(
      path.resolve(restartPaths.result.home).toLowerCase(),
      path.resolve(HOME_DIR).toLowerCase(),
      'Restarted session must bind the exact same isolated home'
    );

    const restartRead = await session2.cdp.eval(`window.knorviaDesktop.native.request({
      jsonrpc: "2.0",
      id: "smoke-read-after-restart",
      method: "thread/read",
      params: { id: "${threadId}" }
    })`);
    const restartedSnapshot = restartRead?.result;
    assert.ok(restartedSnapshot, `Thread ${threadId} must exist after app restart`);
    const restartedTurn = restartedSnapshot.turns?.find(t => t.id === expectedTurnId);
    assert.ok(restartedTurn, `Turn ${expectedTurnId} must persist across app restart`);
    assert.equal(restartedTurn.status, 'completed', 'Persisted turn status must remain completed');

    const restartedAssistantItem = restartedSnapshot.items?.find(it => it.kind === 'agentMessage' || it.role === 'assistant');
    assert.ok(restartedAssistantItem, 'Assistant item must persist across app restart');
    assert.equal(restartedAssistantItem.payload?.text, 'scripted native fixture response');

    await session2.cdp.send('Page.navigate', { url: `knorvia://app/workbench/task/${encodeURIComponent(threadId)}` });
    let renderedAnswer = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await delay(500);
      try {
        renderedAnswer = await session2.cdp.eval(`document.body.innerText.includes('scripted native fixture response')`);
        if (renderedAnswer) break;
      } catch { /* navigation can replace the renderer execution context */ }
    }
    assert.ok(renderedAnswer, 'The actual task page must display the persisted assistant answer');
    const taskScreenshot = await session2.cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(EVIDENCE_ROOT, 'task-after-restart.png'), Buffer.from(taskScreenshot.data, 'base64'));
    recordStage('Task page renders persisted answer after restart', true);

    recordStage('Persistence across restart verified', true, {
      threadId,
      turnId: expectedTurnId,
      status: restartedTurn.status,
      assistantText: restartedAssistantItem.payload?.text,
    });

    report.success = true;
    log('=== ALL HARDENED CLOSED-LOOP INTEGRATION CHECKS PASSED SUCCESSFULLY! ===');
  } finally {
    log('Step 16: Teardown and clean process termination...');
    if (session1) await session1.close();
    if (session2) await session2.close();
    await fixture.close();
    report.durationMs = Date.now() - startTime;

    const reportPath = path.join(EVIDENCE_ROOT, 'integration-smoke-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    log(`Report saved to ${reportPath}`);
  }

  return report;
}

if (require.main === module) {
  runSmoke()
    .then(report => {
      process.exitCode = report.success ? 0 : 1;
    })
    .catch(err => {
      console.error('Integration smoke test failed:', err);
      process.exitCode = 1;
    });
}

module.exports = { runSmoke };
