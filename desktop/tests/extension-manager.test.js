'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExtensionManager, extensionConnectionHandlers } = require('../extension-manager');
const { analyzeExtension, parseYamlFrontmatter } = require('../extension-compat');
const { extractZip, relative } = require('../extension-files');
const yazl = require('yazl');
const skill = (name, body = 'Use the fixture') => `---\nname: ${name}\ndescription: >-\n  A useful skill\n  for fixture work\n---\n${body}\n`;
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-extension-')), sourceDir = path.join(home, 'input'); fs.mkdirSync(sourceDir);
  const calls = [], loaded = [];
  const rpc = async (method, p) => {
    calls.push({ method, p });
    if (method === 'workspace/path/resolve') { const target = path.join(sourceDir, p.path); return { workspace: { id: 'fixture', cwd: sourceDir }, absolutePath: target, kind: fs.statSync(target).isDirectory() ? 'directory' : 'file' }; }
    if (method === 'skills/list') {
      loaded.length = 0;
      for (const item of fs.readdirSync(path.join(home, 'state', 'kernel', 'skills'))) { const file = path.join(home, 'state', 'kernel', 'skills', item, 'SKILL.md'); if (fs.existsSync(file)) loaded.push(fs.readFileSync(file, 'utf8')); }
      return { data: [{ skills: loaded.map((value, i) => ({ name: `skill-${i}`, enabled: true })) }] };
    }
    if (method.startsWith('extension/kernel/')) return { ok: true };
    throw new Error(`Unexpected RPC ${method}`);
  };
  const manager = createExtensionManager({ home, rpc });
  const source = { type: 'local', workspaceId: 'fixture', path: '' };
  const call = (method, p = {}) => manager.handlers[method](p);
  const install = async p => { const inspected = await call('extension/inspect', { source }); return call('extension/install', { source, expectedSha256: inspected.sha256, ...p }); };
  return { home, sourceDir, manager, source, call, install, calls, loaded, rpc };
}
async function zipFile(file, entries) {
  const zip = new yazl.ZipFile();
  for (const [name, content, options] of entries) zip.addBuffer(Buffer.from(content), name, options);
  zip.end(); await new Promise((resolve, reject) => { zip.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject); });
}
test('Skill install, activation, update, rollback, disable and uninstall preserve source', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('sample', 'version one')); fs.mkdirSync(path.join(f.sourceDir, 'references')); fs.writeFileSync(path.join(f.sourceDir, 'references', 'note.txt'), 'reference');
  let entry = await f.install(); assert.equal(entry.enabled, false); assert.equal(f.loaded.length, 0);
  entry = await f.call('extension/enable', { id: entry.id, revision: entry.revision, enabled: true }); assert.equal(f.loaded.length, 1); assert.match(f.loaded[0], /version one/);
  const originalVersion = entry.activeVersion;
  fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('sample', 'version two'));
  entry = await f.install({ id: entry.id, revision: entry.revision }); assert.match(f.loaded[0], /version two/);
  entry = await f.call('extension/rollback', { id: entry.id, revision: entry.revision, version: originalVersion }); assert.match(f.loaded[0], /version one/);
  const restored = createExtensionManager({ home: f.home, rpc: f.rpc }); await restored.restore(); assert.equal(f.loaded.length, 1);
  entry = await f.call('extension/enable', { id: entry.id, revision: entry.revision, enabled: false }); assert.equal(f.loaded.length, 0);
  await assert.rejects(f.call('extension/uninstall', { id: entry.id, revision: 1 }));
  await f.call('extension/uninstall', { id: entry.id, revision: entry.revision }); assert.equal((await f.call('extension/list')).entries.length, 0);
  assert.match(fs.readFileSync(path.join(f.sourceDir, 'SKILL.md'), 'utf8'), /version two/);
});
test('package change after inspection and modified active Skill are protected', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('protected'));
  const inspected = await f.call('extension/inspect', { source: f.source }); fs.appendFileSync(path.join(f.sourceDir, 'SKILL.md'), '\nchanged');
  await assert.rejects(f.call('extension/install', { source: f.source, expectedSha256: inspected.sha256 }), e => e.rpc.code === -32005);
  let entry = await f.install(); entry = await f.call('extension/enable', { id: entry.id, revision: entry.revision, enabled: true });
  const projection = path.join(f.home, 'state', 'kernel', 'skills', `knorvia-${entry.id}-0`, 'SKILL.md'); fs.appendFileSync(projection, '\nuser edit');
  await assert.rejects(f.call('extension/enable', { id: entry.id, revision: entry.revision, enabled: false })); assert.match(fs.readFileSync(projection, 'utf8'), /user edit/);
});
test('Codex plugin uses a private local marketplace and Kernel lifecycle', async () => {
  const f = fixture(); fs.mkdirSync(path.join(f.sourceDir, '.codex-plugin')); fs.writeFileSync(path.join(f.sourceDir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'sample-plugin', version: '1.0.0' }));
  let entry = await f.install(); entry = await f.call('extension/enable', { id: entry.id, revision: entry.revision, enabled: true });
  const call = f.calls.find(c => c.method === 'extension/kernel/install'); assert.equal(call.p.pluginName, 'sample-plugin'); assert.ok(call.p.marketplacePath.startsWith(path.join(f.home, 'extensions', 'marketplaces'))); assert.equal(call.p.remoteMarketplaceName, undefined);
  await f.call('extension/enable', { id: entry.id, revision: entry.revision, enabled: false }); assert.equal(f.calls.find(c => c.method === 'extension/kernel/uninstall').p.pluginId, `sample-plugin@knorvia-${entry.id}`);
});
test('Claude hooks remain unsupported while explicit Skill components activate', async () => {
  const f = fixture(); fs.mkdirSync(path.join(f.sourceDir, '.claude-plugin')); fs.writeFileSync(path.join(f.sourceDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'claude-sample' })); fs.mkdirSync(path.join(f.sourceDir, 'hooks')); fs.writeFileSync(path.join(f.sourceDir, 'hooks', 'stop.sh'), 'NEVER EXECUTE'); fs.mkdirSync(path.join(f.sourceDir, 'skills', 'sample'), { recursive: true }); fs.writeFileSync(path.join(f.sourceDir, 'skills', 'sample', 'SKILL.md'), skill('sample'));
  let entry = await f.install(); assert.equal(entry.report.status, 'convertible-partial'); assert.equal(entry.report.components.find(c => c.format === 'claude-hooks').status, 'unsupported');
  entry = await f.call('extension/enable', { id: entry.id, revision: entry.revision, enabled: true }); assert.equal(f.loaded.length, 1); assert.equal(f.calls.some(c => c.method === 'extension/kernel/install'), false);
});
test('ZIP extraction rejects traversal, duplicate case names and links', async () => {
  const f = fixture(), file = path.join(f.home, 'archive.zip');
  await zipFile(file, [['aa/test', 'sample']]); const unsafe = fs.readFileSync(file); for (let at = unsafe.indexOf('aa/test'); at >= 0; at = unsafe.indexOf('aa/test', at + 1)) unsafe.write('../test', at); fs.writeFileSync(file, unsafe);
  await assert.rejects(extractZip(file, path.join(f.home, 'unzip-1')));
  await zipFile(file, [['Test.txt', 'one'], ['test.txt', 'two']]); await assert.rejects(extractZip(file, path.join(f.home, 'unzip-2')));
  await zipFile(file, [['link', '../outside', { mode: 0o120777 }]]); await assert.rejects(extractZip(file, path.join(f.home, 'unzip-3')));
  for (const name of ['../file', '/file', 'C:/file', 'x\\file', 'nul.txt', 'a./b']) assert.throws(() => relative(name));
});
test('fixed GitHub commit download uses the same inspected ZIP content', async () => {
  const f = fixture(), file = path.join(f.home, 'github.zip'); await zipFile(file, [['repo-commit/SKILL.md', skill('github-sample')]]);
  let observed;
  const manager = createExtensionManager({ home: path.join(f.home, 'github-home'), rpc: f.rpc, fetchImpl: async (url, options) => { observed = { url, options }; return new Response(fs.readFileSync(file), { status: 200 }); } });
  const source = { type: 'github', repository: 'fixture/repository', commit: 'a'.repeat(40) };
  const inspection = await manager.handlers['extension/inspect']({ source });
  const entry = await manager.handlers['extension/install']({ source, expectedSha256: inspection.sha256 }); assert.equal(entry.name, 'github-sample'); assert.match(observed.url, /^https:\/\/codeload.github.com\//); assert.equal(observed.options.redirect, 'error');
  await assert.rejects(manager.handlers['extension/inspect']({ source: { ...source, commit: 'main' } }));
});
test('YAML multiline/BOM work and aliases/missing descriptions do not fake compatibility', () => {
  assert.equal(parseYamlFrontmatter(`\uFEFF${skill('yaml')}`).description.trim(), 'A useful skill for fixture work');
  assert.equal(parseYamlFrontmatter('---\nname: &x x\ndescription: *x\n---\n'), null);
  const f = fixture(); fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), '---\nname: missing-description\n---\n'); assert.equal(analyzeExtension({ dir: f.sourceDir }).status, 'unsupported');
});
test('interrupted activation restores the last committed state and a bad journal stays read-only', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('recovery'));
  const entry = await f.install(), file = path.join(f.home, 'extensions', 'catalog.json');
  const previous = JSON.parse(fs.readFileSync(file)).entries[0], next = { ...previous, enabled: true, revision: previous.revision + 1 };
  // Simulate a crash after the activation side effect but before catalog commit.
  const source = path.join(f.home, 'extensions', 'marketplaces', entry.id, 'packages', entry.activeVersion, 'plugin');
  const target = path.join(f.home, 'state', 'kernel', 'skills', `knorvia-${entry.id}-0`); fs.cpSync(source, target, { recursive: true });
  const journal = path.join(f.home, 'extensions', 'pending-transition.json'); fs.writeFileSync(journal, JSON.stringify({ version: 1, previous, next }));
  const recovered = createExtensionManager({ home: f.home, rpc: f.rpc }); assert.equal((await recovered.restore()).restored, true); assert.equal(fs.existsSync(target), false); assert.equal(fs.existsSync(journal), false);
  assert.equal((await recovered.handlers['extension/list']({})).entries[0].enabled, false);
  fs.writeFileSync(journal, '{broken'); const broken = createExtensionManager({ home: f.home, rpc: f.rpc }); assert.equal((await broken.restore()).restored, false);
  assert.ok((await broken.handlers['extension/list']({})).recoveryError); await assert.rejects(broken.handlers['extension/enable']({ id: entry.id, revision: entry.revision, enabled: true })); assert.equal(fs.readFileSync(journal, 'utf8'), '{broken');
});
test('one unavailable plugin does not block startup and disabling clears its recovery error', async () => {
  const f = fixture(); fs.mkdirSync(path.join(f.sourceDir, '.codex-plugin')); fs.writeFileSync(path.join(f.sourceDir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'unavailable' }));
  let entry = await f.install(); entry = await f.call('extension/enable', { id: entry.id, revision: entry.revision, enabled: true });
  const unavailable = createExtensionManager({ home: f.home, rpc: async (method, p) => { if (method === 'extension/kernel/install') throw new Error('fixture unavailable'); return f.rpc(method, p); } });
  assert.equal((await unavailable.restore()).failed, 1); assert.ok((await unavailable.handlers['extension/list']({})).entries[0].recoveryError);
  await unavailable.handlers['extension/enable']({ id: entry.id, revision: entry.revision, enabled: false }); assert.equal((await unavailable.handlers['extension/list']({})).entries[0].recoveryError, null);
});
test('legacy analysis is scoped to a registered project and GitHub traversal is rejected', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('scoped'));
  assert.equal((await f.call('workspace/extensions/analyze', { workspaceId: 'fixture', path: '' })).format, 'agent-skill');
  await assert.rejects(f.call('workspace/extensions/analyze', { dir: f.sourceDir }));
  await assert.rejects(f.call('workspace/extensions/analyze', { workspaceId: 'fixture', path: '..' }));
  await assert.rejects(f.call('extension/inspect', { source: { type: 'github', repository: '../..', commit: 'a'.repeat(40) } }));
});
test('provider switching awaits extension restoration on success and rollback, but not unchanged engines', async () => {
  const events = [], runtime = { engine: {}, async connectionUpdate() { this.engine = {}; events.push('switched'); return { ready: true }; }, async providerActivate() { this.engine = {}; events.push('rolled-back'); throw new Error('candidate failed'); } };
  const handlers = extensionConnectionHandlers(runtime, { async restore() { await new Promise(resolve => setTimeout(resolve, 5)); events.push('restored'); } });
  assert.deepEqual(await handlers['connection/update']({}), { ready: true }); assert.deepEqual(events, ['switched', 'restored']);
  await assert.rejects(handlers['connection/provider/activate']({}), /candidate failed/); assert.deepEqual(events.slice(-2), ['rolled-back', 'restored']);
  runtime.connectionUpdate = async () => ({ ready: true }); await handlers['connection/update']({}); assert.equal(events.length, 4);
});

// ---- C02 nightshift additions: multi-instance ownership, CAS, recovery ----

const { spawn } = require('node:child_process');
async function untilC(read, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('a stale sibling instance is refused by revision CAS instead of overwriting the winner', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('cas'));
  const entry = await f.install();
  const staleRevision = entry.revision;
  const sibling = createExtensionManager({ home: f.home, rpc: f.rpc });
  // The sibling re-reads the shared catalog under the lock and wins first.
  await sibling.handlers['extension/enable']({ id: entry.id, revision: staleRevision, enabled: true });
  // This manager still holds the pre-update revision and must be refused...
  await assert.rejects(
    f.call('extension/enable', { id: entry.id, revision: staleRevision, enabled: false }),
    e => e.rpc.code === -32005,
  );
  // ...the sibling's committed change stays intact, visible after refresh...
  const view = await f.call('extension/list');
  assert.equal(view.entries[0].enabled, true);
  assert.equal(view.entries[0].revision, staleRevision + 1);
  // ...and a retry with the refreshed revision succeeds.
  await f.call('extension/enable', { id: entry.id, revision: view.entries[0].revision, enabled: false });
  assert.equal(fs.existsSync(path.join(f.home, 'extensions', 'catalog.lock')), false, 'lock must be released after every transaction');
});

test('two instances installing different extensions under the same Home keep both entries', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('dual'));
  let releaseGate = null;
  const gatedRpc = async (method, p) => {
    if (method === 'skills/list' && releaseGate === 'armed') { releaseGate = 'held'; await new Promise(resolve => { globalThis.__c02gate = resolve; }); releaseGate = 'done'; }
    return f.rpc(method, p);
  };
  const managerA = createExtensionManager({ home: f.home, rpc: gatedRpc });
  const managerB = createExtensionManager({ home: f.home, rpc: f.rpc });
  const installWith = async manager => {
    const inspected = await manager.handlers['extension/inspect']({ source: f.source });
    return manager.handlers['extension/install']({ source: f.source, expectedSha256: inspected.sha256 });
  };
  const entryA = await installWith(managerA); // installs stay outside the gate
  releaseGate = 'armed';
  // A's enable holds the cross-instance lock while gated inside setActive.
  const pendingA = managerA.handlers['extension/enable']({ id: entryA.id, revision: entryA.revision, enabled: true });
  await untilC(() => releaseGate === 'held', 'A gated inside its locked transition');
  const pendingB = installWith(managerB);
  await new Promise(resolve => setTimeout(resolve, 300)); // B is blocked on the live lock
  globalThis.__c02gate();
  const [enabledA, entryB] = await Promise.all([pendingA, pendingB]);
  assert.equal(enabledA.enabled, true);
  assert.notEqual(enabledA.id, entryB.id);
  const onDisk = JSON.parse(fs.readFileSync(path.join(f.home, 'extensions', 'catalog.json'), 'utf8'));
  assert.equal(onDisk.entries.length, 2, 'both sibling installs must survive; neither may overwrite the other');
  assert.deepEqual(onDisk.entries.map(e => e.id).sort(), [enabledA.id, entryB.id].sort());
  assert.equal(onDisk.entries.find(e => e.id === enabledA.id).enabled, true);
  assert.equal(fs.existsSync(path.join(f.home, 'extensions', 'catalog.lock')), false);
});

test('a live sibling lock is respected, reported, and retried after it finishes', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('live-lock'));
  let releaseGate = null;
  const gatedRpc = async (method, p) => {
    if (method === 'skills/list' && releaseGate === 'armed') { releaseGate = 'held'; await new Promise(resolve => { globalThis.__c02gate2 = resolve; }); releaseGate = 'done'; }
    return f.rpc(method, p);
  };
  const managerA = createExtensionManager({ home: f.home, rpc: gatedRpc });
  const installWith = async manager => {
    const inspected = await manager.handlers['extension/inspect']({ source: f.source });
    return manager.handlers['extension/install']({ source: f.source, expectedSha256: inspected.sha256 });
  };
  const entry = await installWith(managerA);
  releaseGate = 'armed';
  const pendingA = managerA.handlers['extension/enable']({ id: entry.id, revision: entry.revision, enabled: true });
  await untilC(() => releaseGate === 'held', 'A gated while holding the lock');
  const sibling = createExtensionManager({ home: f.home, rpc: f.rpc, lockTimeoutMs: 800 });
  await assert.rejects(
    sibling.handlers['extension/enable']({ id: entry.id, revision: entry.revision, enabled: true }),
    e => { assert.equal(e.rpc.code, -32095); assert.match(e.rpc.message, /extension store lock/); return true; },
  );
  globalThis.__c02gate2();
  await pendingA;
  const view = await sibling.handlers['extension/list']();
  assert.equal(view.entries[0].enabled, true);
  await sibling.handlers['extension/enable']({ id: entry.id, revision: view.entries[0].revision, enabled: false });
});

test('a crashed holder lock is stolen and its interrupted enable is recovered by a sibling', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('crash-recovery'));
  const home = f.home, readyFile = path.join(home, 'crash-ready.txt');
  const childScript = path.join(home, 'crash-child.cjs');
  fs.writeFileSync(childScript, [
    `const { createExtensionManager } = require(${JSON.stringify(path.resolve(__dirname, '../extension-manager.js'))});`,
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const home = process.argv[2], sourceDir = process.argv[3], readyFile = process.argv[4];',
    'const rpc = async (method, p) => {',
    '  if (method === "workspace/path/resolve") { const target = path.join(sourceDir, p.path); return { workspace: { id: "fixture", cwd: sourceDir }, absolutePath: target, kind: fs.statSync(target).isDirectory() ? "directory" : "file" }; }',
    '  if (method === "skills/list") { fs.writeFileSync(readyFile, String(process.pid)); return new Promise(() => {}); }',
    '  return { ok: true };',
    '};',
    '(async () => {',
    '  const manager = createExtensionManager({ home, rpc });',
    '  const source = { type: "local", workspaceId: "fixture", path: "" };',
    '  const inspected = await manager.handlers["extension/inspect"]({ source });',
    '  const entry = await manager.handlers["extension/install"]({ source, expectedSha256: inspected.sha256 });',
    '  await manager.handlers["extension/enable"]({ id: entry.id, revision: entry.revision, enabled: true });',
    '})().catch(() => process.exit(1));',
  ].join('\n'));
  const child = spawn(process.execPath, [childScript, home, f.sourceDir, readyFile], { shell: false, stdio: 'ignore' });
  try {
    const holderPid = Number(await untilC(async () => { try { return fs.readFileSync(readyFile, 'utf8'); } catch { return null; } }, 'crash child gated mid-enable'));
    const journalFile = path.join(home, 'extensions', 'pending-transition.json');
    await untilC(() => fs.existsSync(journalFile), 'interrupted journal written');
    child.kill('SIGKILL');
    await untilC(async () => { try { process.kill(holderPid, 0); return false; } catch { return true; } }, 'crash child is dead');
    // The dead holder's lock is stolen immediately; recovery reconciles the
    // interrupted enable against the committed catalog.
    const recovered = createExtensionManager({ home, rpc: f.rpc, lockTimeoutMs: 30_000 });
    const result = await recovered.restore();
    assert.equal(result.restored, true);
    assert.equal(fs.existsSync(journalFile), false, 'recovered journal must be cleared');
    assert.equal(f.loaded.length, 0, 'the interrupted activation must not stay active');
    const view = await recovered.handlers['extension/list']();
    assert.equal(view.entries[0].enabled, false, 'catalog keeps the last committed (disabled) state');
    assert.equal(view.entries[0].revision, 1);
    assert.ok(fs.existsSync(path.join(home, 'extensions', 'marketplaces', view.entries[0].id, 'packages', view.entries[0].activeVersion, 'plugin')), 'installed package is preserved');
    // The store is usable again for a normal change after recovery.
    const entry = view.entries[0];
    await recovered.handlers['extension/enable']({ id: entry.id, revision: entry.revision, enabled: true });
    assert.equal(f.loaded.length, 1);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  }
});

test('a sibling cannot disable an extension whose active skill projection has user edits', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.sourceDir, 'SKILL.md'), skill('protected-cross'));
  const entry = await f.install();
  await f.call('extension/enable', { id: entry.id, revision: entry.revision, enabled: true });
  const sibling = createExtensionManager({ home: f.home, rpc: f.rpc });
  const view = await sibling.handlers['extension/list']();
  const projection = path.join(f.home, 'state', 'kernel', 'skills', `knorvia-${entry.id}-0`, 'SKILL.md');
  fs.appendFileSync(projection, '\nuser edit from the field');
  await assert.rejects(
    sibling.handlers['extension/enable']({ id: entry.id, revision: view.entries[0].revision, enabled: false }),
    e => { assert.ok([-32005, -32094].includes(e.rpc.code), `protection error expected, got ${e.rpc.code}`); return true; },
  );
  assert.match(fs.readFileSync(projection, 'utf8'), /user edit from the field/);
  const onDisk = JSON.parse(fs.readFileSync(path.join(f.home, 'extensions', 'catalog.json'), 'utf8'));
  assert.equal(onDisk.entries[0].enabled, true, 'the failed sibling transaction must not change the catalog');
});
