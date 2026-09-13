'use strict';
// C05 nightshift tests: the diagnostics report must fully redact injected
// synthetic secrets, stay within its size cap, degrade when services are
// offline, and never include the real Home or environment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntimeDiagnostics, createErrorRing, saveReportTo, redactText } = require('../runtime-diagnostics');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-diag-home-'));
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-diag-userdata-'));
const SECRET_TOKEN = 'sk-fixture-injected-secret-000000';
const SECRET_BEARER = 'Bearer abc.def.ghi-jkl-mno-1234567890';
const SECRET_PASSWORD = 'p@ssw0rd-fixture-китайский';

const pathRoots = [
  { label: '~', path: HOME },
  { label: '[userData]', path: USER_DATA },
  { label: '[temp]', path: os.tmpdir() },
];

// Synthetic secrets are injected into every collector field and must be
// absent from the serialized report.
const secretsProbe = [SECRET_TOKEN, SECRET_BEARER, SECRET_PASSWORD, HOME, USER_DATA];

function diagnostics(overrides = {}) {
  return createRuntimeDiagnostics({
    identity: { appVersion: '9.9.9-fixture', channel: 'dev', electron: '99.0.0', chrome: '120.0.0', sourceSha: 'abcdef1234567890', sourceDirty: false },
    pathRoots,
    // The host knows this value is a secret (e.g. from a provider key env
    // name), so it is masked verbatim even without a label in front of it.
    secretValues: [SECRET_PASSWORD],
    collectors: {
      components: async () => [
        { name: 'daemon', status: 'ready', detail: `home under ${HOME} with ${SECRET_TOKEN}` },
        { name: 'frontend', status: 'degraded', detail: `endpoint https://127.0.0.1:4507/rpc?token=${SECRET_TOKEN}` },
      ],
      capabilities: async () => [{ name: 'terminal', available: true }, { name: 'ssh', available: false, reason: `Authorization: ${SECRET_BEARER}` }],
      ports: async () => [{ label: 'gateway', port: 4507, state: 'listening', host: '127.0.0.1' }],
      recentErrors: async () => [
        { at: '2026-09-11T00:00:00.000Z', scope: 'fixture', message: `login failed for ${SECRET_PASSWORD} under ${USER_DATA}\\cache`, code: -32000 },
      ],
      checks: async () => [{ name: 'fixture-check', passed: true }],
    },
    secretsProbe,
    ...overrides,
  });
}

test('every injected synthetic secret is fully redacted from the report', async () => {
  const collected = await diagnostics().collect();
  const serialized = collected.text;
  for (const probe of secretsProbe) assert.equal(serialized.includes(probe), false, `leaked: ${probe}`);
  assert.match(serialized, /home under ~ with \[redacted-key\]/);
  assert.match(serialized, /\?\[query removed\]/);
  assert.match(serialized, /Authorization: \[redacted\]/);
  assert.match(serialized, /login failed for \[redacted\] under \[userData\]/);
  assert.equal(collected.report.checks.find(check => check.name === 'redaction-self-check').passed, true);
});

test('the report carries identity and structural facts without paths or environment', async () => {
  const { report } = await diagnostics().collect();
  assert.equal(report.reportVersion, 1);
  assert.equal(report.identity.appVersion, '9.9.9-fixture');
  assert.equal(report.identity.sourceSha, 'abcdef1234567890');
  assert.equal(report.redaction.environmentIncluded, false);
  assert.equal(report.ports[0].state, 'listening');
  assert.ok(JSON.stringify(report).includes('"node"'));
  assert.equal(JSON.stringify(report).includes('PATH='), false);
});

test('offline collectors degrade to a partial report instead of failing', async () => {
  const manager = createRuntimeDiagnostics({
    pathRoots,
    collectors: {
      components: async () => { throw new Error('daemon is offline'); },
      ports: async () => [{ label: 'frontend', port: 4501, state: 'listening', host: '127.0.0.1' }],
    },
    secretsProbe,
  });
  const { report, text } = await manager.collect();
  assert.equal(report.collectorHealth.find(health => health.name === 'components').status, 'unavailable');
  assert.equal(report.components.length, 0);
  assert.equal(report.ports.length, 1);
  assert.match(text, /"generatedAt"/);
});

test('an oversized report shrinks recent errors first and stays within the cap', async () => {
  const manager = createRuntimeDiagnostics({
    pathRoots,
    maxReportBytes: 4 * 1024,
    collectors: {
      recentErrors: async () => Array.from({ length: 40 }, (_, i) => ({
        at: '2026-09-11T00:00:00.000Z',
        scope: `scope-${i}`,
        message: `e${String(i).padStart(2, '0')} ${'detail'.repeat(40)}`,
        code: null,
      })),
      components: async () => Array.from({ length: 30 }, (_, i) => ({ name: `component-${i}`, status: 'ok', detail: 'x'.repeat(200) })),
    },
  });
  const { report, truncated, sizeBytes } = await manager.collect();
  assert.equal(truncated, true);
  assert.ok(sizeBytes <= 4 * 1024, `size ${sizeBytes} must stay within the cap`);
  assert.ok(report.recentErrors.length < 40);
  assert.ok(report.identity.appVersion !== undefined, 'identity survives truncation');
});

test('the error ring keeps a bounded, newest-biased snapshot and redacts at collect time', async () => {
  const ring = createErrorRing({ max: 3 });
  for (let i = 0; i < 10; i++) ring.record('engine', new Error(`failure ${i} ${SECRET_TOKEN}`));
  const snapshot = ring.snapshot();
  assert.equal(snapshot.length, 3);
  assert.match(snapshot[2].message, /failure 9/);
  assert.equal(snapshot.some(item => item.message.includes(SECRET_TOKEN)), true, 'ring stores raw; redaction belongs to collect');
  const manager = createRuntimeDiagnostics({
    pathRoots,
    collectors: { recentErrors: async () => ring.snapshot() },
    secretsProbe: [SECRET_TOKEN],
  });
  const { text } = await manager.collect();
  assert.equal(text.includes(SECRET_TOKEN), false);
  assert.match(text, /\[redacted-key\]/);
});

test('saveReportTo writes a bounded file and refuses unsafe destinations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-diag-save-'));
  const destination = path.join(dir, 'report.json');
  const result = saveReportTo({ text: '{"ok":true}', destination });
  assert.equal(result.saved, true);
  assert.equal(fs.readFileSync(destination, 'utf8'), '{"ok":true}');
  assert.throws(() => saveReportTo({ text: '', destination }), /empty/);
  assert.throws(() => saveReportTo({ text: 'x', destination: 'relative.json' }), /destination/);
  assert.throws(() => saveReportTo({ text: 'y', destination: 'C:\\' }), /destination/);
});

test('redactText keeps useful non-secret facts readable', () => {
  const text = redactText('gateway listening on port 4507 with 3 running terminals', pathRootReplacersSafe());
  assert.equal(text, 'gateway listening on port 4507 with 3 running terminals');
  function pathRootReplacersSafe() { return []; }
});
