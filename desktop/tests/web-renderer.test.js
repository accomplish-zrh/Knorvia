'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveNodeLauncher, resolveWebRenderer } = require('../web-renderer');

function waitForRendererReady(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeListener('data', onStdout);
      child.stderr.removeListener('data', onStderr);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onStdout = (chunk) => {
      if (String(chunk).split(/\r?\n/).some((line) => line.trim() === 'READY')) finish();
    };
    const onStderr = (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_096); };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`source renderer exited before READY (${code}): ${stderr}`));
    const timer = setTimeout(() => finish(new Error(`source renderer did not become ready: ${stderr}`)), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'close');
  // `frontend-host` owns an HTTP server. On Windows use the child-process
  // termination path rather than waiting for a Next signal handler to drain
  // keep-alive work after the test has already observed READY.
  try { child.kill('SIGKILL'); } catch {}
  await Promise.race([
    exited,
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref?.();
    }),
  ]);
}

function createStandalone(root) {
  fs.mkdirSync(path.join(root, '.next', 'standalone', '.next'), { recursive: true });
  fs.mkdirSync(path.join(root, '.next', 'standalone', 'node_modules', 'next'), { recursive: true });
  fs.writeFileSync(path.join(root, '.next', 'standalone', '.next', 'required-server-files.json'), '{"config":{}}', 'utf8');
}

test('KNORVIA_WEB_DIR prefers a current Next standalone renderer over the staged Python compatibility path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-web-renderer-'));
  const standalone = path.join(root, '.next', 'standalone');
  createStandalone(root);
  try {
    const resolved = resolveWebRenderer({ webDir: root, runtimeRoot: path.join(root, 'missing-runtime') });
    assert.equal(resolved.webRoot, standalone);
    assert.equal(resolved.distDir, '.next');
    assert.equal(resolved.source, 'KNORVIA_WEB_DIR');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source renderer startup can use Electron as Node when no staged runtime exists', () => {
  const launcher = resolveNodeLauncher({
    runtimeRoot: path.join(os.tmpdir(), 'knorvia-missing-runtime'),
    env: {},
    electronExecPath: process.execPath,
  });
  assert.equal(launcher.command, process.execPath);
  assert.equal(launcher.useElectronAsNode, true);
});

test('an isolated release declares its build directory without permitting paths outside the renderer', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-renderer-manifest-'));
  const web = path.join(runtime, 'web');
  try {
    fs.mkdirSync(path.join(web, '.next-canvas-release'), { recursive: true });
    fs.mkdirSync(path.join(web, 'node_modules', 'next'), { recursive: true });
    fs.writeFileSync(path.join(web, '.next-canvas-release', 'required-server-files.json'), '{"config":{}}');
    const manifest = path.join(web, 'renderer.json');
    fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, distDir: '.next-canvas-release' }));
    assert.equal(resolveWebRenderer({ runtimeRoot: runtime }).distDir, '.next-canvas-release');
    for (const distDir of ['../outside', '.next/../outside', 'D:\\outside']) {
      fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, distDir }));
      assert.throws(() => resolveWebRenderer({ runtimeRoot: runtime }), /not found/);
    }
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});

test('a relocated native release resolves its bundled renderer without Python or source paths', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-native-release-'));
  try {
    createStandalone(runtime);
    fs.renameSync(path.join(runtime, '.next', 'standalone'), path.join(runtime, 'web'));
    const renderer = resolveWebRenderer({ runtimeRoot: runtime });
    assert.equal(renderer.webRoot, path.join(runtime, 'web'));
    assert.equal(renderer.distDir, '.next');
    assert.equal(renderer.source, 'staged-runtime');
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});

const currentStandalone = process.env.KNORVIA_ACCEPT_WEB_ROOT || path.resolve(__dirname, '../../web/.next/standalone');
test('the configured standalone output can start the named-pipe renderer host', {
  skip: process.platform !== 'win32'
    || !fs.existsSync(currentStandalone),
  timeout: 45_000,
}, async () => {
  const { webRoot, distDir } = resolveWebRenderer({ webDir: currentStandalone });
  const frontendHost = path.resolve(__dirname, '../frontend-host.js');
  const pipe = `\\\\.\\pipe\\knorvia-source-renderer-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, [frontendHost], {
    cwd: webRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KNORVIA_WEB_ROOT: webRoot,
      KNORVIA_UI_PIPE: pipe,
      KNORVIA_NEXT_DIST_DIR: distDir,
    },
  });
  try {
    await waitForRendererReady(child);
    assert.equal(child.exitCode, null);
  } finally {
    await stopChild(child);
  }
});
