'use strict';
// User-initiated local runtime diagnostics. The report is generated on
// demand, stays on the machine, and never contacts the network or a model:
// collectors are local snapshots, every string passes redaction, and the
// whole document is capped. It must degrade gracefully - any collector that
// fails (e.g. the daemon is offline) yields a partial report, not an error.

const fs = require('node:fs');
const os = require('node:os');
const { connectionError } = require('./connection-config');

const METHODS = ['runtimeDiagnostics/collect', 'runtimeDiagnostics/save'];
const fail = (code, message) => { throw connectionError(code, message); };

const MAX_REPORT_BYTES = 256 * 1024;
const MAX_ERRORS = 40;
const MAX_ERROR_CHARS = 500;
const MAX_COMPONENTS = 64;
const MAX_CAPABILITIES = 64;
const MAX_PORTS = 32;
const MAX_CHECKS = 32;
const MAX_VALUE_CHARS = 1000;
const MAX_KEY_CHARS = 64;
const MAX_DEPTH = 8;

// --- Redaction -------------------------------------------------------------
// Pipeline order matters: known roots first (so "~" survives), then bearer
// tokens (before their label consumes only the scheme word), labeled
// secrets, key-shaped strings, URL queries, and finally a generic
// absolute-path mask with lookbehinds that keep URLs intact.
const SECRET_LABELED = /((?:api[\s_-]?key|apikey|access[\s_-]?token|refresh[\s_-]?token|token|secret|password|passphrase|authorization|credential|cookie)[a-z0-9\s_-]{0,24}[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;)\]}]+)/gi;
const BEARER = /\b(bearer\s+)[a-z0-9._~+/=-]{8,}/gi;
const SK_KEY = /\bsk-[A-Za-z0-9_-]{8,}/g;
const URL_QUERY = /([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)\?[^\s"')\]}]*/gi;
// "s:" inside https:// must not look like a drive letter, and "/home" inside
// a URL path must not look like a POSIX home directory.
const ABSOLUTE_PATH = /(?<![\w+.-])[A-Za-z]:[\\/][^\s"'`,;)\]}]{2,}|(?<![:\w/])\/(?:home|Users|root)(?:\/[^\s"'`,;)\]}]{2,})?/g;
// Object KEYS carrying these fragments mark the whole value as secret: a
// JSON-structured password never carries a "password:" label inside its
// value, so key-based masking is the only reliable catch.
const SENSITIVE_KEY = /(?:api[\s_-]?key|apikey|access[\s_-]?token|refresh[\s_-]?token|token|secret|password|passphrase|authorization|credential|cookie)/i;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Known local roots (Home, userData, temp, app dir) are replaced with short
// labels before the generic absolute-path mask runs, so a report reader can
// still tell "~" from "[app]" without learning anything about the machine.
// Separators are matched flexibly so a Windows-rooted path also matches its
// forward-slash rendering.
function pathRootReplacers(pathRoots) {
  return pathRoots
    .filter(root => root && typeof root.path === 'string' && root.path.length > 2 && typeof root.label === 'string')
    .sort((a, b) => b.path.length - a.path.length)
    .map(root => {
      const parts = String(root.path).split(/[\\/]+/).filter(Boolean).map(escapeRegExp);
      return { label: root.label, pattern: new RegExp(parts.join('[\\\\/]+'), 'gi') };
    });
}

function redactText(value, replacers = [], secretValues = []) {
  let text = String(value);
  for (const root of replacers) text = text.replace(root.pattern, root.label);
  text = text
    .replace(BEARER, '$1[redacted]')
    .replace(SECRET_LABELED, '$1[redacted]')
    .replace(SK_KEY, '[redacted-key]')
    .replace(URL_QUERY, '$1?[query removed]')
    .replace(ABSOLUTE_PATH, '[local-path]');
  // Values the host already knows are secrets (provider keys from the
  // environment or connection store) are masked verbatim wherever they show
  // up, labeled or not.
  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret.length >= 6) text = text.replaceAll(secret, '[redacted]');
  }
  return text;
}

function redactStructure(value, replacers, depth = 0, secretValues = [], sensitiveKey = false) {
  if (typeof value === 'string') {
    if (sensitiveKey) return '[redacted]';
    return redactText(value, replacers, secretValues).slice(0, MAX_VALUE_CHARS);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return sensitiveKey ? '[redacted]' : value;
  if (depth >= MAX_DEPTH) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 200).map(item => redactStructure(item, replacers, depth + 1, secretValues, sensitiveKey));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      const masked = sensitiveKey || SENSITIVE_KEY.test(key);
      out[redactText(key, replacers, secretValues).slice(0, MAX_KEY_CHARS) || 'key'] = masked
        ? redactStructure(item, replacers, depth + 1, secretValues, true)
        : redactStructure(item, replacers, depth + 1, secretValues);
    }
    return out;
  }
  return sensitiveKey ? '[redacted]' : String(value).slice(0, MAX_VALUE_CHARS);
}

// Self-check helper: finds string values under sensitive keys that survived
// redaction. Empty by itself it proves nothing - the collect() pipeline
// always runs this against the final serialized payload.
function sensitiveKeyScan(text) {
  const violations = [];
  const pair = /"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = pair.exec(String(text)))) {
    if (SENSITIVE_KEY.test(match[1]) && match[2].length >= 6 && match[2] !== '[redacted]') violations.push(match[1]);
  }
  return violations;
}

// --- Bounded in-memory error ring -------------------------------------------
// The host feeds explicit failure events; redaction happens at collect time
// so the ring can never bypass future redaction improvements.
function createErrorRing({ max = MAX_ERRORS, now = () => new Date().toISOString() } = {}) {
  const items = [];
  return {
    record(scope, error) {
      items.push({
        at: now(),
        scope: String(scope || 'host').slice(0, 80),
        message: String(error?.message || error || 'unknown error').slice(0, MAX_ERROR_CHARS * 2),
        code: typeof error?.rpc?.code === 'number' ? error.rpc.code : typeof error?.code === 'number' ? error.code : null,
      });
      if (items.length > max) items.splice(0, items.length - max);
    },
    snapshot() {
      return items.map(item => ({ ...item }));
    },
  };
}

// --- Report ----------------------------------------------------------------
function createRuntimeDiagnostics({
  identity = {},
  pathRoots = [],
  secretValues = [],
  collectors = {},
  now = () => new Date().toISOString(),
  maxReportBytes = MAX_REPORT_BYTES,
  secretsProbe = [],
} = {}) {
  const replacers = pathRootReplacers(pathRoots);
  const bounded = (list, cap) => Array.isArray(list) ? list.slice(0, cap) : [];
  async function safeCollector(name, fn) {
    if (typeof fn !== 'function') return { name, status: 'unavailable', detail: 'no collector registered' };
    try {
      return { name, status: 'ok', data: await fn(), detail: null };
    } catch (error) {
      return { name, status: 'unavailable', detail: String(error?.message || error).slice(0, 300), data: null };
    }
  }
  async function collect() {
    const [components, capabilities, ports, recentErrors, checks] = await Promise.all([
      safeCollector('components', collectors.components),
      safeCollector('capabilities', collectors.capabilities),
      safeCollector('ports', collectors.ports),
      safeCollector('recentErrors', collectors.recentErrors),
      safeCollector('checks', collectors.checks),
    ]);
    const body = {
      reportVersion: 1,
      generatedAt: now(),
      // Identity carries names and versions only - never paths or arguments.
      identity: {
        appVersion: identity.appVersion ?? null,
        channel: identity.channel ?? null,
        electron: identity.electron ?? null,
        chrome: identity.chrome ?? null,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        osRelease: os.release(),
        sourceSha: identity.sourceSha ?? null,
        sourceDirty: identity.sourceDirty ?? null,
        runtimeComponents: identity.runtimeComponents ?? null,
      },
      components: bounded(components.data, MAX_COMPONENTS),
      capabilities: bounded(capabilities.data, MAX_CAPABILITIES),
      ports: bounded(ports.data, MAX_PORTS),
      recentErrors: bounded(recentErrors.data, MAX_ERRORS),
      checks: bounded(checks.data, MAX_CHECKS),
      collectorHealth: [components, capabilities, ports, recentErrors, checks].map(({ name, status, detail }) => ({ name, status, detail: detail ?? null })),
    };
    // Collector-derived strings are redacted as a whole; the report's own
    // metadata below is host-controlled and attached afterwards so rule
    // names never meet their own patterns.
    const redacted = redactStructure(body, replacers, 0, secretValues);
    const finalize = (object) => JSON.stringify(object, null, 2);
    // The self-check runs against the FINAL serialized payload: it verifies
    // the injected probes are absent AND that no sensitive-key string value
    // survived redaction, so an empty probe list is never a blind pass.
    const selfCheckFailed = (text) => {
      if (secretsProbe.some(probe => text.includes(probe))) return 'probe leak';
      const violations = sensitiveKeyScan(text);
      return violations.length ? `sensitive keys not redacted: ${[...new Set(violations)].join(', ').slice(0, 200)}` : null;
    };
    redacted.redaction = {
      rules: ['labeled-secret', 'bearer', 'key-shaped-literals', 'url-query', 'known-path-roots', 'absolute-path', 'known-secret-values', 'sensitive-key-values'],
      knownRootLabels: pathRoots.map(root => root.label).filter(Boolean),
      knownSecretValueCount: secretValues.length,
      environmentIncluded: false,
    };
    redacted.checks = [
      ...redacted.checks,
      { name: 'redaction-self-check', passed: true, detail: null },
    ];
    // Attach metadata, verify the cap, and keep `text` the exact
    // serialization of `report` at every step: the skeleton can never be
    // overwritten by a later re-serialization of the full report.
    let payload = finalize(redacted);
    let selfCheckFailure = selfCheckFailed(payload);
    let truncated = false;
    const overCap = () => Buffer.byteLength(payload, 'utf8') > maxReportBytes;
    const syncCheck = () => {
      selfCheckFailure = selfCheckFailed(payload);
      redacted.checks = [...redacted.checks.filter(check => check.name !== 'redaction-self-check'), { name: 'redaction-self-check', passed: !selfCheckFailure, detail: selfCheckFailure }];
      payload = finalize(redacted);
    };
    syncCheck();
    // Shrink least-valuable sections first; identity and self-checks stay.
    while (overCap() && redacted.recentErrors.length) {
      redacted.recentErrors.pop();
      truncated = true;
      payload = finalize(redacted);
      syncCheck();
    }
    if (overCap() && Array.isArray(redacted.components)) {
      redacted.components = redacted.components.slice(0, 8);
      redacted.capabilities = (redacted.capabilities || []).slice(0, 8);
      truncated = true;
      payload = finalize(redacted);
      syncCheck();
    }
    if (overCap()) {
      const skeleton = {
        reportVersion: 1,
        generatedAt: redacted.generatedAt,
        truncated: true,
        redaction: redacted.redaction,
        checks: [{ name: 'redaction-self-check', passed: !selfCheckFailed(finalize({ checks: [] })), detail: 'report reduced to a skeleton' }],
        note: 'The report exceeded the size cap and was reduced to this skeleton.',
      };
      payload = finalize(skeleton);
      return { report: JSON.parse(payload), text: payload, truncated: true, sizeBytes: Buffer.byteLength(payload, 'utf8') };
    }
    redacted.truncated = truncated;
    payload = finalize(redacted);
    syncCheck();
    return { report: JSON.parse(payload), text: payload, truncated, sizeBytes: Buffer.byteLength(payload, 'utf8') };
  }
  return { handlers: { 'runtimeDiagnostics/collect': async () => collect() }, collect };
}

// Writes a user-chosen destination. Returns no path so the renderer never
// handles or displays absolute local locations.
function saveReportTo({ text, destination }) {
  if (typeof text !== 'string' || !text.trim()) fail(-32602, 'Diagnostics text is empty');
  if (Buffer.byteLength(text, 'utf8') > MAX_REPORT_BYTES * 4) fail(-32602, 'Diagnostics text exceeds the save limit');
  if (typeof destination !== 'string' || !pathLooksLikeFile(destination)) fail(-32602, 'Choose a destination file');
  fs.writeFileSync(destination, text, { encoding: 'utf8', mode: 0o600 });
  return { saved: true };
}

function pathLooksLikeFile(destination) {
  try { return Boolean(require('node:path').isAbsolute(destination)) && !/\\Device\\|^[a-z]:\\$/i.test(destination); } catch { return false; }
}

// Values of environment entries whose NAMES look secret (provider keys and
// similar) feed the verbatim masking pass. Only values are kept, never the
// environment structure itself.
function knownEnvSecretValues(env) {
  return Object.entries(env || {})
    .filter(([key]) => /(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|passphrase|credential)/i.test(key))
    .map(([, value]) => String(value ?? ''))
    .filter(value => value.length >= 6);
}

module.exports = {
  METHODS,
  MAX_REPORT_BYTES,
  createRuntimeDiagnostics,
  createErrorRing,
  saveReportTo,
  knownEnvSecretValues,
  redactText,
  redactStructure,
  sensitiveKeyScan,
};
