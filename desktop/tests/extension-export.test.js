'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createExtensionManager } = require('../extension-manager');
const { createExtensionExport } = require('../extension-export');
const F = require('../extension-files');

const skill = (name, body = 'Use the fixture') => `---\nname: ${name}\ndescription: >-\n  A fixture skill\n  for export work\n---\n${body}\n`;

async function makeHome(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-extexp-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  return home;
}

function managerFor(home) {
  const rpc = async (method, p) => {
    if (method === 'skills/list') {
      const skillsRoot = path.join(home, 'state', 'kernel', 'skills');
      const loaded = [];
      for (const item of fs.existsSync(skillsRoot) ? fs.readdirSync(skillsRoot) : []) {
        const file = path.join(skillsRoot, item, 'SKILL.md');
        if (fs.existsSync(file)) loaded.push(fs.readFileSync(file, 'utf8'));
      }
      return { data: [{ skills: loaded.map((value, index) => ({ name: `skill-${index}`, body: value, enabled: true })) }] };
    }
    if (method.startsWith('extension/kernel/')) return { ok: true };
    if (method === 'workspace/path/resolve') {
      const target = path.join(home, 'input', p.path || '');
      return { workspace: { id: 'fixture', cwd: path.join(home, 'input') }, absolutePath: target, kind: fs.statSync(target).isDirectory() ? 'directory' : 'file' };
    }
    throw new Error(`Unexpected RPC ${method}`);
  };
  const manager = createExtensionManager({ home, rpc });
  return { manager, call: (method, params = {}) => manager.handlers[method](params) };
}

async function installSkill(home, { dirName, name, body }) {
  const input = path.join(home, 'input');
  const target = path.join(input, dirName);
  await fsp.mkdir(target, { recursive: true });
  await fsp.writeFile(path.join(target, 'SKILL.md'), skill(name, body));
  const { call } = managerFor(home);
  const inspected = await call('extension/inspect', { source: { type: 'local', workspaceId: 'fixture', path: dirName } });
  return call('extension/install', { source: { type: 'local', workspaceId: 'fixture', path: dirName }, expectedSha256: inspected.sha256 });
}

test('two exported extensions rebuild into an empty Home with identical hashes, skills and disabled state', async t => {
  const homeA = await makeHome(t);
  await fsp.mkdir(path.join(homeA, 'input'), { recursive: true });
  const first = await installSkill(homeA, { dirName: 'alpha', name: 'alpha-skill', body: 'alpha content' });
  const second = await installSkill(homeA, { dirName: 'beta', name: 'beta-skill', body: 'beta content' });
  const exporterA = createExtensionExport({ home: homeA });
  const destination = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-exp-out-')), 'export-one');
  t.after(() => fsp.rm(destination, { recursive: true, force: true }));
  const exported = await exporterA.exportExtensions({ destination, ids: [first.id, second.id] });
  assert.equal(exported.exported, 2);
  assert.deepEqual(exported.results.map((item) => item.status), ['exported', 'exported']);

  // The container must not carry Home content or absolute paths.
  const manifestText = await fsp.readFile(path.join(destination, 'manifest.json'), 'utf8');
  assert.doesNotMatch(manifestText, /os\.tmpdir|homeA|C:\\\\Users/, 'no absolute paths in the container');
  assert.ok(!manifestText.includes(homeA));

  // Empty Home B: plan shows both as new, then installs them disabled.
  const homeB = await makeHome(t);
  await fsp.mkdir(path.join(homeB, 'input'), { recursive: true });
  const { call, manager } = managerFor(homeB);
  const exporterB = createExtensionExport({ home: homeB });
  const plan = await exporterB.planImport({ exportDir: destination, manager });
  assert.deepEqual(plan.items.map((item) => item.status), ['new', 'new']);
  const result = await exporterB.performImport({ exportDir: destination, manager, items: plan.items.filter((item) => item.status === 'new').map((item) => item.id) });
  assert.equal(result.results.filter((item) => item.status === 'installed').length, 2);
  const list = await call('extension/list');
  assert.equal(list.entries.length, 2);
  assert.equal(list.entries.every((entry) => entry.enabled === false), true, 'imports start disabled');
  // Package hashes are identical to the source packages.
  for (const [source, imported] of [[first, list.entries.find((entry) => entry.name === 'alpha-skill')], [second, list.entries.find((entry) => entry.name === 'beta-skill')]]) {
    const hashA = F.scan(path.join(homeA, 'extensions', 'marketplaces', source.id, 'packages', source.activeVersion, 'plugin')).sha256;
    const hashB = F.scan(path.join(homeB, 'extensions', 'marketplaces', imported.id, 'packages', imported.activeVersion, 'plugin')).sha256;
    assert.equal(hashB, hashA, 'package content hash identical');
    assert.equal(F.scan(path.join(homeB, 'extensions', 'marketplaces', imported.id, 'packages', imported.activeVersion, 'plugin')).sha256, imported.versions.find((v) => v.id === imported.activeVersion).sha256);
  }
  // Enabling in B discovers the same skills by content.
  const imported = list.entries.find((entry) => entry.name === 'alpha-skill');
  await call('extension/enable', { id: imported.id, revision: imported.revision, enabled: true });
  const projection = path.join(homeB, 'state', 'kernel', 'skills', `knorvia-${imported.id}-0`, 'SKILL.md');
  assert.match(await fsp.readFile(projection, 'utf8'), /alpha content/, 'skill discoverability preserved');
  const retryPlan = await exporterB.planImport({ exportDir: destination, manager });
  assert.deepEqual(retryPlan.items.map(item => item.status), ['already-installed', 'already-installed']);
  const retry = await exporterB.performImport({ exportDir: destination, manager });
  assert.deepEqual(retry.results.map(item => item.status), ['already-installed', 'already-installed']);
  assert.equal((await call('extension/list')).entries.length, 2, 'retry does not create new imported identities');
});

test('same-name different-source and already-installed imports are refused without duplicating', async t => {
  const homeA = await makeHome(t);
  await fsp.mkdir(path.join(homeA, 'input'), { recursive: true });
  const first = await installSkill(homeA, { dirName: 'alpha', name: 'shared-name', body: 'source one' });
  const exporterA = createExtensionExport({ home: homeA });
  const destination = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-exp-out2-')), 'export-two');
  t.after(() => fsp.rm(destination, { recursive: true, force: true }));
  await exporterA.exportExtensions({ destination, ids: [first.id] });

  const homeB = await makeHome(t);
  await fsp.mkdir(path.join(homeB, 'input'), { recursive: true });
  await installSkill(homeB, { dirName: 'other', name: 'shared-name', body: 'different source' });
  const { call, manager } = managerFor(homeB);
  const exporterB = createExtensionExport({ home: homeB });
  const plan = await exporterB.planImport({ exportDir: destination, manager });
  assert.deepEqual(plan.items.map((item) => item.status), ['conflict-same-name']);
  const result = await exporterB.performImport({ exportDir: destination, manager });
  assert.equal(result.results[0].status, 'conflict-same-name');
  assert.equal((await call('extension/list')).entries.length, 1, 'nothing installed for a name conflict');
});

test('a tampered container and a manifest path traversal fail per item without installing', async t => {
  const homeA = await makeHome(t);
  await fsp.mkdir(path.join(homeA, 'input'), { recursive: true });
  const first = await installSkill(homeA, { dirName: 'alpha', name: 'tamper-me', body: 'original bytes' });
  const exporterA = createExtensionExport({ home: homeA });
  const destination = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-exp-out3-')), 'export-three');
  t.after(() => fsp.rm(destination, { recursive: true, force: true }));
  await exporterA.exportExtensions({ destination, ids: [first.id] });
  const pluginFile = path.join(destination, 'packages', first.id, first.activeVersion, 'plugin', 'SKILL.md');
  await fsp.writeFile(pluginFile, '---\nname: tampered\n---\nchanged');
  const homeB = await makeHome(t);
  const exporterB = createExtensionExport({ home: homeB });
  const plan = await exporterB.planImport({ exportDir: destination, manager: managerFor(homeB).manager });
  assert.equal(plan.items[0].status, 'invalid');
  assert.match(plan.items[0].detail, /篡改|缺失/);
  const result = await exporterB.performImport({ exportDir: destination, manager: managerFor(homeB).manager });
  assert.equal(result.results[0].status, 'invalid');
  const marketplaces = path.join(homeB, 'extensions', 'marketplaces');
  assert.equal(!fs.existsSync(marketplaces) || fs.readdirSync(marketplaces).length === 0, true, 'nothing installed from a tampered container');
});

test('user-modified packages and credential-bearing packages are blocked from export with local guidance', async t => {
  const homeA = await makeHome(t);
  await fsp.mkdir(path.join(homeA, 'input'), { recursive: true });
  const modified = await installSkill(homeA, { dirName: 'mod', name: 'modified-skill', body: 'untouched' });
  // The secret ships as original package content, so only the secret guard
  // (not the user-modification guard) applies to it.
  const secretInput = path.join(homeA, 'input', 'sec');
  await fsp.mkdir(secretInput, { recursive: true });
  await fsp.writeFile(path.join(secretInput, 'SKILL.md'), skill('secret-skill', 'ok'));
  await fsp.writeFile(path.join(secretInput, 'NOTES.md'), 'key: sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
  const { call: callA } = managerFor(homeA);
  const inspected = await callA('extension/inspect', { source: { type: 'local', workspaceId: 'fixture', path: 'sec' } });
  const secret = await callA('extension/install', { source: { type: 'local', workspaceId: 'fixture', path: 'sec' }, expectedSha256: inspected.sha256 });
  // Simulate a user edit that bypassed the manager on the first package.
  await fsp.writeFile(path.join(homeA, 'extensions', 'marketplaces', modified.id, 'packages', modified.activeVersion, 'plugin', 'SKILL.md'), '---' + String.fromCharCode(10) + 'name: modified-skill' + String.fromCharCode(10) + '---' + String.fromCharCode(10) + 'user edit');
  const exporterA = createExtensionExport({ home: homeA });
  const destination = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-exp-out4-')), 'export-four');
  const results = await exporterA.exportExtensions({ destination, ids: [modified.id, secret.id] }).catch((error) => error.results);
  assert.ok(results, 'per-item results survive full rejection');
  assert.deepEqual(results.map((item) => item.status).sort(), ['blocked-secret', 'blocked-user-modified']);
  assert.match(results.find((item) => item.status === 'blocked-user-modified').detail, /未导出/);
  assert.match(results.find((item) => item.status === 'blocked-secret').detail, /凭据/);
  assert.equal(fs.existsSync(destination), false, 'a fully rejected export leaves no container');
});

test('dotenv variants are blocked and every refusal survives the desktop RPC error data', async t => {
  const home = await makeHome(t);
  const { manager, call } = managerFor(home);
  const ids = [];
  for (const [index, filename] of ['.env', '.env.production'].entries()) {
    const dirName = `dotenv-${index}`, input = path.join(home, 'input', dirName);
    await fsp.mkdir(input, { recursive: true });
    await fsp.writeFile(path.join(input, 'SKILL.md'), skill(`dotenv-skill-${index}`));
    await fsp.writeFile(path.join(input, filename), 'API_KEY=sk-TESTONLYABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
    const source = { type: 'local', workspaceId: 'fixture', path: dirName };
    const inspected = await call('extension/inspect', { source });
    ids.push((await call('extension/install', { source, expectedSha256: inspected.sha256 })).id);
  }
  const exporter = createExtensionExport({ home });
  const destination = path.join(home, 'export-dotenv');
  const { createNativeRpcRouter, NATIVE_METHODS, LOCAL_METHODS } = require('../native-rpc-router');
  NATIVE_METHODS.add('extension/export'); LOCAL_METHODS.add('extension/export');
  const router = createNativeRpcRouter({ rpc: async () => { throw new Error('export must stay in the host'); }, handlers: {
    'extension/export': params => exporter.exportExtensions({ destination: params.destination, ids: params.ids }),
  } });
  const response = await router.handle({ jsonrpc: '2.0', id: 'dotenv-export', method: 'extension/export', params: { destination, ids } });
  assert.equal(response.error.code, -32093);
  assert.deepEqual(response.error.data.results.map(row => row.status), ['blocked-secret', 'blocked-secret']);
  assert.deepEqual(response.error.data.results.map(row => row.id), ids);
  assert.ok(response.error.data.results.every(row => /凭据/.test(row.detail)));
  assert.equal(fs.existsSync(destination), false);
  router.dispose(); await manager.close();
});

test('partial imports retry only failed entries and recognize already rebuilt content', async t => {
  const homeA = await makeHome(t);
  const first = await installSkill(homeA, { dirName: 'first', name: 'partial-first', body: 'first' });
  const second = await installSkill(homeA, { dirName: 'second', name: 'partial-second', body: 'second' });
  const destination = path.join(homeA, 'partial-export');
  await createExtensionExport({ home: homeA }).exportExtensions({ destination, ids: [first.id, second.id] });
  const homeB = await makeHome(t), { manager, call } = managerFor(homeB), exporter = createExtensionExport({ home: homeB });
  const install = manager.handlers['extension/install'];
  let firstAttempt = true; const installAttempts = [];
  manager.handlers['extension/install'] = params => {
    installAttempts.push(params.source.entryId);
    if (params.source.entryId === first.id && firstAttempt) { firstAttempt = false; throw new Error('injected first item failure'); }
    return install(params);
  };
  const initial = await exporter.performImport({ exportDir: destination, manager });
  assert.deepEqual(initial.results.map(row => row.status), ['failed', 'installed']);
  const repeated = await exporter.performImport({ exportDir: destination, manager });
  assert.deepEqual(repeated.results.map(row => row.status), ['installed', 'already-installed']);
  assert.deepEqual(installAttempts, [first.id, second.id, first.id]);
  assert.equal((await call('extension/list')).entries.length, 2);
});


test('import planning recomputes missing dependencies for the receiving platform without installing', async t => {
  const homeA = await makeHome(t);
  const input = path.join(homeA, 'input', 'portable', 'scripts');
  await fsp.mkdir(input, { recursive: true });
  await fsp.writeFile(path.join(input, process.platform === 'win32' ? 'needs-bash.sh' : 'needs-powershell.ps1'), '# Fixture text only; never execute.');
  const source = { type: 'local', workspaceId: 'fixture', path: 'portable' };
  await fsp.writeFile(path.join(path.dirname(input), 'SKILL.md'), skill('portable-dependency'));
  const original = managerFor(homeA);
  t.after(() => original.manager.close());
  const inspected = await original.call('extension/inspect', { source });
  const installed = await original.call('extension/install', { source, expectedSha256: inspected.sha256 });
  const destination = path.join(homeA, 'portable-export');
  await createExtensionExport({ home: homeA }).exportExtensions({ destination, ids: [installed.id] });
  // The source platform's report is advisory: import must recompute it locally.
  const manifestFile = path.join(destination, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
  manifest.entries[0].versions[0].report = { status: 'loadable', components: [] };
  await fsp.writeFile(manifestFile, JSON.stringify(manifest));
  const homeB = await makeHome(t), target = managerFor(homeB);
  t.after(() => target.manager.close());
  const exporter = createExtensionExport({ home: homeB });
  const plan = await exporter.planImport({ exportDir: destination, manager: target.manager });
  assert.equal(plan.ok, false);
  assert.equal(plan.items[0].status, 'missing-dependency');
  assert.match(plan.items[0].detail, /requires (bash|powershell)/);
  assert.ok(plan.items[0].report.components.some(item => item.status === 'missing-dependency'));
  const result = await exporter.performImport({ exportDir: destination, manager: target.manager });
  assert.equal(result.results[0].status, 'missing-dependency');
  assert.equal((await target.call('extension/list')).entries.length, 0);
});
