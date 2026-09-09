'use strict';

// Independent, offline certification of an ended run. This reads durable files
// instead of trusting the runner's success counters or its live RPC responses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function files(directory) {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => json(path.join(directory, name)));
}

function certify(directory) {
  const root = path.resolve(directory);
  const summary = json(path.join(root, 'summary.json'));
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.passed, true, 'run failed or is still running');
  assert.ok(summary.finishedAt && summary.finalRecoveryAudit, 'final recovery audit missing');
  assert.deepEqual(summary.errors, []);
  assert.equal(path.resolve(summary.home), path.join(root, 'isolated-home'));
  assert.ok(summary.successfulTurns > 0, 'no successful work was observed');
  assert.ok(summary.providerRequests >= summary.successfulTurns + summary.crashInterruptedTurns,
    'provider observations cannot substantiate the task counters');
  if (summary.requestedSeconds) assert.ok(summary.workloadSeconds >= summary.requestedSeconds, 'timed run ended early');
  else assert.ok(summary.cycles >= summary.requestedCycles, 'run did not finish its requested cycles');
  for (const binary of Object.values(summary.binaries)) {
    assert.equal(hash(path.join(summary.home, 'bin', path.basename(binary.path))), binary.sha256);
  }
  const product = path.join(summary.home, 'state', 'product');
  const turns = files(path.join(product, 'turns'));
  const counts = {};
  for (const turn of turns) {
    counts[turn.status] = (counts[turn.status] || 0) + 1;
    assert.ok(['completed', 'interrupted'].includes(turn.status), `unexpected durable ${turn.status} Turn ${turn.id}`);
    assert.match(turn.threadId, /^thr_[a-zA-Z0-9_-]+$/);
    if (turn.status === 'completed') {
      const items = files(path.join(product, 'items', 'threads', turn.threadId)).filter((item) => item.turnId === turn.id);
      assert.equal(items.filter((item) => item.kind === 'userMessage').length, 1);
      assert.ok(items.some((item) => item.kind === 'agentMessage' && item.status === 'completed'
        && ['scripted native fixture response', 'approval fixture completed'].some((text) => String(item.payload?.text).startsWith(text))),
      `durable output missing for ${turn.id}`);
    }
  }
  assert.equal(counts.completed, summary.successfulTurns);
  assert.equal(counts.interrupted || 0, summary.crashInterruptedTurns);
  assert.equal(turns.length, summary.successfulTurns + summary.crashInterruptedTurns);
  if (summary.mode === 'steady') {
    assert.equal(summary.forcedProcessTreeKills, 0);
    assert.equal(summary.gracefulRestarts, 0);
    assert.equal(summary.ownerProcesses.length, 2, 'steady experiment changed owner before final audit');
  }
  if (summary.mode === 'crash') assert.equal(summary.forcedProcessTreeKills, summary.crashInterruptedTurns);
  const events = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const verified = new Set(events.filter((event) => event.kind === 'verified-terminal').map((event) => event.id));
  assert.equal(verified.size, summary.successfulTurns);
  for (const event of events.filter((entry) => entry.kind === 'verified-artifact')) {
    assert.ok(path.resolve(event.path).startsWith(path.join(root, 'isolated-home', 'workspace') + path.sep));
    assert.equal(hash(event.path), event.sha256, 'artifact changed since acceptance');
  }
  const certificate = {
    certifiedAt: new Date().toISOString(), result: 'PASS',
    scope: 'real Kernel + local scripted provider; durable output/recovery only',
    summarySha256: hash(path.join(root, 'summary.json')), eventsSha256: hash(path.join(root, 'events.jsonl')),
    certifierSha256: hash(__filename), durableTurns: counts, providerRequests: summary.providerRequests,
    mode: summary.mode, workloadSeconds: summary.workloadSeconds, binaries: summary.binaries,
  };
  fs.writeFileSync(path.join(root, 'certificate.json'), `${JSON.stringify(certificate, null, 2)}\n`);
  return certificate;
}

if (require.main === module) {
  try {
    assert.ok(process.argv[2], 'usage: node verify-native-acceptance.js <evidence-directory>');
    process.stdout.write(`${JSON.stringify(certify(process.argv[2]))}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { certify };
