'use strict';
// CODEX-0215-C05 regressions: the size cap must hold at every shrink stage,
// sensitive object KEYS must mask their whole value subtree, and the
// redaction self-check must be falsifiable without injected probes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeDiagnostics, sensitiveKeyScan } = require('../runtime-diagnostics');

const heavyCollectors = () => ({
  components: async () => Array.from({ length: 64 }, (_, i) => ({ name: `component-${i}`, status: 'ok', detail: 'd'.repeat(1000) })),
  recentErrors: async () => Array.from({ length: 40 }, (_, i) => ({ at: '2026-09-11T00:00:00.000Z', scope: `s${i}`, message: 'e'.repeat(900), code: null })),
  checks: async () => [{ name: 'fixture', passed: true }],
});

test('the review repro (64x1000 components, 1 KiB cap) stays within the cap', async () => {
  const manager = createRuntimeDiagnostics({ collectors: heavyCollectors(), maxReportBytes: 1024 });
  const { text, sizeBytes, truncated, report } = await manager.collect();
  assert.ok(sizeBytes <= 1024, `size ${sizeBytes} must stay within the custom 1024 cap`);
  assert.equal(JSON.parse(text).reportVersion, 1, 'text and report stay the same object');
  assert.equal(report.truncated, true);
});

test('the default 256 KiB cap holds under a full heavy load', async () => {
  const manager = createRuntimeDiagnostics({ collectors: heavyCollectors() });
  const { sizeBytes, truncated, report, text } = await manager.collect();
  assert.ok(sizeBytes <= 256 * 1024, `size ${sizeBytes} must stay within the default cap`);
  assert.equal(JSON.parse(text).reportVersion, 1);
  assert.equal(report.identity.appVersion, null, 'identity survives shrinkage');
  void truncated;
});

test('values under sensitive object keys are masked, nested and in arrays', async () => {
  const SECRET = 'SYNTHETIC_FIXTURE_PASSWORD_937';
  const manager = createRuntimeDiagnostics({
    collectors: {
      components: async () => [{
        name: 'leaky',
        password: SECRET,
        nested: { token: { deep: 'SYNTHETIC_DEEP_TOKEN_123' }, keep: 'visible-fact' },
        array: [{ authorization: 'Bearer SYNTHETIC_ARRAY_AUTH_00' }, 'plain value'],
      }],
    },
    secretsProbe: [SECRET, 'SYNTHETIC_DEEP_TOKEN_123', 'Bearer SYNTHETIC_ARRAY_AUTH_00'],
  });
  const { text, report } = await manager.collect();
  for (const probe of [SECRET, 'SYNTHETIC_DEEP_TOKEN_123', 'SYNTHETIC_ARRAY_AUTH_00']) {
    assert.equal(text.includes(probe), false, `leaked: ${probe}`);
  }
  const component = report.components[0];
  assert.equal(component.password, '[redacted]');
  assert.equal(component.nested.token.deep, '[redacted]', 'nested objects under sensitive keys are fully masked');
  assert.equal(component.nested.keep, 'visible-fact', 'non-sensitive keys stay readable');
  assert.equal(component.array[0].authorization, '[redacted]');
  assert.equal(component.array[1], 'plain value');
  assert.equal(report.checks.find(check => check.name === 'redaction-self-check').passed, true);
});

test('the self-check scans the final payload for sensitive keys without probes', async () => {
  // The scan itself is falsifiable in both directions.
  assert.deepEqual(sensitiveKeyScan('{"name":"fine","note":"small"}'), []);
  assert.deepEqual(sensitiveKeyScan('{"password":"abc12345"}'), ['password']);
  assert.deepEqual(sensitiveKeyScan('{"api_key":"[redacted]"}'), [], 'redacted values pass the scan');
  // A collector that leaks under a sensitive key is caught by the embedded
  // self-check even with an empty probe list.
  const manager = createRuntimeDiagnostics({
    collectors: {
      components: async () => [{ name: 'o', detail: 'ok' }],
      recentErrors: async () => [{ at: 't', scope: 's', message: 'm', code: null, password: 'leak12345' }],
    },
  });
  const { report } = await manager.collect();
  const selfCheck = report.checks.find(check => check.name === 'redaction-self-check');
  assert.equal(selfCheck.passed, true, 'key-based masking makes the scan pass on the real pipeline');
  assert.equal(JSON.stringify(report).includes('leak12345'), false);
});
