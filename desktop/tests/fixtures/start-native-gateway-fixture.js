'use strict';

// Starts exactly one Knorvia daemon behind the development native gateway and
// a local scripted Responses endpoint. This is a manual QA launcher, not a
// substitute runtime: requests still traverse the real Kernel/App Server.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNativeGateway } = require('../../native-gateway');
const { resolveDaemonBin } = require('../../kernel-engine');
const { startScriptedResponsesFixture } = require('./scripted-responses-fixture');

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-native-workbench-'));
}

function canCleanFixtureHome(home, ownsHome) {
  if (!ownsHome) return false;
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(home);
  return resolved.startsWith(`${tempRoot}${path.sep}`)
    && path.basename(resolved).startsWith('knorvia-native-workbench-');
}

function copiedDaemon(source, home) {
  if (!source || !fs.existsSync(source)) throw new Error(`knorvia-daemon binary not found: ${source || '(none)'}`);
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const destination = path.join(binDir, path.basename(source));
  // On Windows the running executable holds a file lock. Copying it into this
  // fixture's isolated home lets another terminal rebuild target/debug safely.
  fs.copyFileSync(source, destination);
  return destination;
}

function resolveKernelBin(env) {
  if (env.KNORVIA_KERNEL_BIN && fs.existsSync(env.KNORVIA_KERNEL_BIN)) return env.KNORVIA_KERNEL_BIN;
  const source = path.resolve(
    __dirname,
    '../../../../knorvia-kernel/codex-rs/target/debug/codex-app-server.exe',
  );
  if (!fs.existsSync(source)) throw new Error(`codex-app-server binary not found: ${source}`);
  return source;
}

async function startNativeGatewayFixture(options = {}) {
  const ownsHome = options.home === undefined;
  const home = path.resolve(options.home || fixtureRoot());
  const cleanup = options.cleanup === true && canCleanFixtureHome(home, ownsHome);
  const daemonBin = options.daemonBin;
  const host = options.host || '127.0.0.1';
  const kernelBin = options.kernelBin;
  const port = options.port === undefined
    ? Number(process.env.KNORVIA_NATIVE_GATEWAY_PORT || 4318)
    : options.port;
  const slowDelayMs = options.slowDelayMs;
  const sourceDaemon = daemonBin || resolveDaemonBin({ env: process.env });
  const daemonCopy = copiedDaemon(sourceDaemon, home);
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const responses = await startScriptedResponsesFixture({ host, slowDelayMs });
  const env = {
    ...process.env,
    ...responses.providerEnv,
    KNORVIA_DAEMON_BIN: daemonCopy,
    KNORVIA_KERNEL_BIN: kernelBin || resolveKernelBin(process.env),
  };
  const gateway = createNativeGateway({
    dev: true,
    env,
    home,
    host,
    port,
    // Optional absolute public WS path: lets a browser tab connect straight to
    // the gateway when no WebSocket-capable proxy sits in front of it.
    publicPath: options.publicPath,
  });
  try {
    const location = await gateway.start();
    return {
      daemonBin: daemonCopy,
      gateway,
      home,
      cleanup,
      location,
      ownsHome,
      providerUrl: responses.baseUrl,
      responses,
      workspace,
      async close() {
        try { await gateway.close(); } finally {
          await responses.close();
          if (cleanup) {
            try { fs.rmSync(home, { force: true, recursive: true }); } catch {}
          }
        }
      },
    };
  } catch (error) {
    await responses.close();
    if (cleanup) {
      try { fs.rmSync(home, { force: true, recursive: true }); } catch {}
    }
    throw error;
  }
}

async function runMain() {
  const rawDelay = process.env.KNORVIA_NATIVE_FIXTURE_SLOW_MS;
  const fixtureHome = process.env.KNORVIA_NATIVE_FIXTURE_HOME || undefined;
  const fixture = await startNativeGatewayFixture({
    home: fixtureHome,
    slowDelayMs: rawDelay ? Number(rawDelay) : undefined,
  });
  // Deliberately omit the fixture API key. These values are enough to point
  // Next's same-origin proxy at the already-running local gateway.
  process.stdout.write(`${JSON.stringify({
    nativeGatewayUrl: fixture.location.url,
    nativeGatewayPath: fixture.location.nativePath,
    providerUrl: fixture.providerUrl,
    slowControlUrl: `${fixture.responses.controlUrl}/__knorvia_fixture/release-slow`,
    workspace: fixture.workspace,
  })}\n`);
  const stop = () => fixture.close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  runMain().catch((error) => {
    process.stderr.write(`native gateway fixture failed: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  copiedDaemon,
  canCleanFixtureHome,
  resolveKernelBin,
  startNativeGatewayFixture,
};
