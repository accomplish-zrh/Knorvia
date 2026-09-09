'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const { createKernelEngine, resolveDaemonBin, stagedRuntimeEnv } = require('../kernel-engine');

// The staged release set (tools/release_manifest.py output) is the layout
// the installer ships. The desktop engine must boot from exactly that
// layout: runtimeRoot/bin holds the knorvia-branded binaries, the staged
// manifest's media-worker interpreter rides into the daemon env, and the
// engine serves Thread/Turn from the daemon inside it.

const STAGED_BIN = process.env.KNORVIA_RELEASE_STAGED_BIN;

test('resolveDaemonBin finds the daemon in the staged bin/ layout', { skip: !STAGED_BIN }, () => {
  const bin = resolveDaemonBin({
    runtimeRoot: STAGED_BIN,
    env: {},
    packaged: true,
  });
  assert.ok(fs.existsSync(bin));
  assert.ok(bin.toLowerCase().includes('knorvia-daemon'));
});

test('the staged manifest verifies native components or the optional legacy worker environment', { skip: !STAGED_BIN }, () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(STAGED_BIN, '..', 'manifest.json'), 'utf8'),
  );
  const env = stagedRuntimeEnv(STAGED_BIN, {});
  if (manifest.runtime === 'native') {
    assert.equal(manifest.product, 'Knorvia');
    for (const name of ['knorvia.exe', 'knorvia-daemon.exe', 'knorvia-pack-worker.exe', 'knorvia-kernel-appserver.exe']) {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(STAGED_BIN, name))).digest('hex');
      assert.equal(hash, manifest.components[`bin/${name}`].toLowerCase());
    }
  } else {
    const python = manifest?.runtime?.mediaWorkerPython;
    assert.ok(python && fs.existsSync(python), 'legacy manifest must record its optional worker interpreter');
    assert.equal(env.KNORVIA_PYTHON, python);
  }
  // Without a manifest the daemon's default resolution applies untouched.
  const bare = stagedRuntimeEnv(os.tmpdir(), { KEEP: '1' });
  assert.equal(bare.KNORVIA_PYTHON, undefined);
  assert.equal(bare.KEEP, '1');
});

test('the desktop engine boots from the staged layout', { skip: !STAGED_BIN }, async () => {
  const daemon = resolveDaemonBin({
    runtimeRoot: STAGED_BIN,
    env: {},
    packaged: true,
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-staged-'));
  const engine = await createKernelEngine({
    home,
    runtimeRoot: STAGED_BIN,
    packaged: true,
    env: { ...process.env },
    version: 'staged',
  });
  try {
    assert.equal(engine.identity, 'knorvia-daemon');
    assert.equal(engine.initialize.server.name, 'knorvia-daemon');
    // The staged engine is Knorvia, never a Codex product.
    assert.equal(engine.initialize.server.product, 'Knorvia');
    const http = await engine.handleHttp({ method: 'GET', path: '/api/v1/sessions' });
    assert.equal(http.status, 200);
    const packs = await engine.handleHttp({ method: 'GET', path: '/api/v1/knorvia/packs' });
    assert.equal(packs.status, 200);
    const packBody = JSON.parse(Buffer.from(packs.body, 'base64').toString('utf8'));
    assert.ok(packBody.packs.some((p) => p.id === 'media.visualize'));
  } finally {
    await engine.shutdown();
  }
});
