'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Runtime component integrity for the packaged desktop shell.
//
// Reads the manifest.json written from the ACTUAL frozen build inputs and
// verifies the running installation against it: core binaries (daemon,
// pack worker, CLI, Kernel app-server, node.exe), media payloads, and the
// web build's static chunks. A missing or content-different core component
// yields a decision to refuse starting that component and name it; an old
// package without a manifest reports "unknown" and is never dressed up as
// trusted. The claim is content consistency only — with no signing keys
// this cannot authenticate a publisher. All verification is local: no
// network, and no user chats, Home content or keys are read.

const MAX_WEB_FILES = 20_000;
// X (04:00 review): the manifest must DECLARE this core closure — a trimmed
// or hand-crafted manifest that simply omits entries can no longer pass.
const REQUIRED_CORE = [
  'bin/knorvia.exe', 'bin/knorvia-daemon.exe', 'bin/knorvia-pack-worker.exe', 'bin/knorvia-kernel-appserver.exe',
  'node/node.exe',
];

function fail(message, code = -32602) { const error = new Error(message); error.rpc = { code, message }; throw error; }

function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function createRuntimeIntegrity({ runtimeRoot, packaged = false, webDistDir = '.next-knorvia' } = {}) {
  if (!runtimeRoot || !path.isAbsolute(runtimeRoot)) throw new Error('runtime-integrity requires an absolute runtime root');
  const manifestPath = path.join(runtimeRoot, 'manifest.json');
  const webFilesPath = path.join(runtimeRoot, 'web-files.jsonl');
  let cached;

  function manifest() {
    if (cached) return cached;
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { parsed = null; }
    cached = parsed && parsed.schemaVersion === 2 && parsed.components && typeof parsed.components === 'object'
      ? parsed
      : null;
    return cached;
  }

  // Core gate: every declared core component must exist with the exact
  // recorded content. Returns the per-component state and the decision.
  function checkCore() {
    const manifestData = manifest();
    if (!manifestData) {
      return {
        status: 'unknown',
        detail: '此安装包没有运行时完整性清单：无法验证组件内容（按兼容策略继续，报告中标记为未验证）',
        missing: [],
        mismatched: [],
        components: [],
      };
    }
    const missing = [];
    const mismatched = [];
    const components = [];
    const validHash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
    // X (06:18 review): the required closure must be DECLARED with a valid
    // 64-hex hash AND verified on disk. An entry that is omitted, empty or
    // malformed is reported as missing — it can never be skipped as optional.
    for (const required of REQUIRED_CORE) {
      const expected = manifestData.components[required];
      if (!validHash(expected)) {
        missing.push(required);
        components.push({ name: required, status: 'missing' });
        continue;
      }
      const full = path.join(runtimeRoot, ...required.split('/'));
      let actual = '';
      let present = true;
      try { actual = sha256File(full); } catch { present = false; }
      if (!present) missing.push(required);
      else if (actual !== expected.toLowerCase()) mismatched.push(required);
      components.push({ name: required, status: !present ? 'missing' : actual === expected.toLowerCase() ? 'ok' : 'modified' });
    }
    // Optional (non-required) declared entries: verify when a valid hash is
    // recorded; entries absent at build time (empty hash) are skipped.
    for (const [relativePath, expected] of Object.entries(manifestData.components)) {
      if (REQUIRED_CORE.includes(relativePath)) continue;
      if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) continue;
      const full = path.join(runtimeRoot, ...relativePath.split('/'));
      let actual = '';
      let present = true;
      try { actual = sha256File(full); } catch { present = false; }
      if (!present) missing.push(relativePath);
      else if (actual !== expected.toLowerCase()) mismatched.push(relativePath);
      components.push({ name: relativePath, status: !present ? 'missing' : actual === expected.toLowerCase() ? 'ok' : 'modified' });
    }
    return {
      status: missing.length || mismatched.length ? 'compromised' : 'ok',
      detail: missing.length || mismatched.length
        ? `核心组件缺失或内容与构建清单不一致：${[...missing, ...mismatched].slice(0, 8).join('；')}`
        : '所有核心组件与构建清单一致',
      missing,
      mismatched,
      components,
    };
  }

  // Web build verification: every static chunk recorded at build time must
  // still exist byte-for-byte. Bounded, offline, on demand.
  function checkWeb() {
    const manifestData = manifest();
    if (!manifestData) return { status: 'unknown', missing: [], mismatched: [], files: 0 };
    let lines;
    try { lines = fs.readFileSync(webFilesPath, 'utf8').split('\n').filter(Boolean); } catch {
      return { status: 'compromised', missing: ['web-files.jsonl'], mismatched: [], files: 0 };
    }
    if (lines.length > MAX_WEB_FILES) fail('静态文件清单超出验证上限', -32082);
    const missing = [];
    const mismatched = [];
    for (const line of lines) {
      let parsed;
      try { parsed = JSON.parse(line); } catch { mismatched.push('(files entry unreadable)'); continue; }
      const full = path.join(runtimeRoot, ...parsed.p.replaceAll('\\', '/').split('/'));
      let actual = '';
      try { actual = sha256File(full); } catch { missing.push(parsed.p); continue; }
      if (actual !== parsed.h) mismatched.push(parsed.p);
    }
    if (manifestData.web?.serverFilesSha256) {
      const serverFiles = path.join(runtimeRoot, 'web', webDistDir, 'required-server-files.json');
      let actual = '';
      try { actual = sha256File(serverFiles); } catch { missing.push(`web/${webDistDir}/required-server-files.json`); }
      if (actual && actual !== manifestData.web.serverFilesSha256) mismatched.push(`web/${webDistDir}/required-server-files.json`);
    }
    // X (04:00 review): a missing line in web-files.jsonl plus its deleted
    // chunk left every remaining per-file check passing. The declared count
    // and the aggregate digest over the recorded digests catch the gap.
    if (manifestData.web?.staticFiles !== undefined && lines.length !== manifestData.web.staticFiles) {
      mismatched.push(`static manifest count mismatch: the manifest declares ${manifestData.web.staticFiles} entries, files.jsonl carries ${lines.length}`);
    }
    if (manifestData.web?.staticHash) {
      const aggregate = createHash('sha256').update(lines.map((line) => { try { return JSON.parse(line).h; } catch { return ''; } }).join('')).digest('hex');
      if (aggregate !== manifestData.web.staticHash) {
        mismatched.push('aggregate static chunk digest does not match the manifest');
      }
    }
    return {
      status: missing.length || mismatched.length ? 'compromised' : 'ok',
      missing,
      mismatched,
      files: lines.length,
    };
  }

  // Startup gate for the daemon/engine binaries. Dev checkouts have no
  // manifest: the dev override stays explicit in the result.
  function startupGate() {
    const core = checkCore();
    if (core.status === 'ok') return { allow: true, unverified: false, reason: core.detail, core };
    if (core.status === 'unknown') {
      // Old-package compatibility policy: continue, but never silently —
      // diagnostics carry the unverified marker.
      return { allow: true, unverified: true, reason: core.detail, core };
    }
    const offender = [...core.mismatched, ...core.missing][0] || 'unknown component';
    return {
      allow: false,
      unverified: false,
      component: offender,
      componentPath: path.join(runtimeRoot, ...offender.split('/')),
      reason: `核心组件与构建清单不一致：${[...core.mismatched, ...core.missing].join(', ')}；已阻止启动以避免混合包`,
      core,
    };
  }

  function identity() {
    const manifestData = manifest();
    return {
      sourceSha: manifestData?.source?.commit || 'unknown',
      sourceDirty: typeof manifestData?.source?.dirty === 'number' ? manifestData.source.dirty : null,
      verified: Boolean(manifestData),
    };
  }

  function verifyAll() {
    const core = checkCore();
    const web = checkWeb();
    const id = identity();
    return {
      status: core.status === 'unknown' ? 'unknown' : core.status === 'compromised' || web.status === 'compromised' ? 'compromised' : 'ok',
      source: id,
      core,
      web,
      claim: 'content-consistency',
      note: '本检查只验证内容与构建清单一致，不代表发行者签名认证。',
    };
  }

  return { manifestPath, manifest, checkCore, checkWeb, startupGate, identity, verifyAll };
}

module.exports = { createRuntimeIntegrity };
