'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createExtensionManager } = require('../extension-manager');
const { createExtensionConverter, skillNameFor } = require('../extension-convert');
const F = require('../extension-files');

async function makeHome(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-convert-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  return home;
}

function managerFor(home) {
  const rpc = async (method, p) => {
    if (method === 'workspace/path/resolve') {
      const target = path.join(home, 'input', p.path || '');
      return { workspace: { id: 'fixture', cwd: path.join(home, 'input') }, absolutePath: target, kind: fs.statSync(target).isDirectory() ? 'directory' : 'file' };
    }
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
    throw new Error(`Unexpected RPC ${method}`);
  };
  const manager = createExtensionManager({ home, rpc });
  return { manager, call: (method, params = {}) => manager.handlers[method](params) };
}

async function installClaudePlugin(t, home) {
  const source = path.join(home, 'input', 'claude-ext');
  await fsp.mkdir(path.join(source, '.claude-plugin'), { recursive: true });
  await fsp.mkdir(path.join(source, 'commands'), { recursive: true });
  await fsp.mkdir(path.join(source, 'hooks'), { recursive: true });
  await fsp.writeFile(path.join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'prompt-pack' }));
  await fsp.writeFile(path.join(source, 'commands', 'review.md'), '---\ndescription: Review the given text\nallowed-tools: Bash\n---\nPlease review the following text carefully.\n');
  await fsp.writeFile(path.join(source, 'commands', 'summarize.md'), 'Summarize this in one line for $ARGUMENTS.\n');
  await fsp.writeFile(path.join(source, 'commands', 'danger.md'), 'Run this: !`rm -rf /tmp/x`\n');
  await fsp.writeFile(path.join(source, 'hooks', 'stop.sh'), 'NEVER EXECUTE');
  const { call } = managerFor(home);
  const inspected = await call('extension/inspect', { source: { type: 'local', workspaceId: 'fixture', path: 'claude-ext' } });
  const entry = await call('extension/install', { source: { type: 'local', workspaceId: 'fixture', path: 'claude-ext' }, expectedSha256: inspected.sha256 });
  return { entry, source };
}

test('two pure-prompt commands convert and activate through the extension manager with a fixture RPC', async t => {
  const home = await makeHome(t);
  const { entry } = await installClaudePlugin(t, home);
  const originalSha = F.scan(path.join(home, 'extensions', 'marketplaces', entry.id, 'packages', entry.activeVersion, 'plugin')).sha256;
  const converter = createExtensionConvertor(home);
  const plan = await converter.plan({ entryId: entry.id });
  assert.deepEqual(plan.items.map((item) => item.status).sort(), ['convertible', 'convertible', 'refused']);
  const refused = plan.items.find((item) => item.command === 'danger.md');
  assert.match(refused.refusals.join(''), /shell 执行片段/);
  assert.ok(plan.items.find((item) => item.command === 'summarize.md').notes.some((note) => /ARGUMENTS/.test(note)), 'placeholder semantics flagged');
  assert.ok(plan.items.find((item) => item.command === 'review.md').notes.some((note) => /allowed-tools/.test(note)), 'permission semantics flagged');
  // Output into a project subdirectory of the same Home.
  const outputDir = path.join(home, 'input', 'converted-prompts');
  const result = await converter.perform({ entryId: entry.id, outputDir });
  assert.equal(result.results.filter((item) => item.status === 'converted').length, 2);
  // The generated package installs through the existing inspect/install chain.
  const { call } = managerFor(home);
  const inspected = await call('extension/inspect', { source: { type: 'local', workspaceId: 'fixture', path: 'converted-prompts' } });
  assert.equal(inspected.report.status, 'loadable');
  const imported = await call('extension/install', { source: { type: 'local', workspaceId: 'fixture', path: 'converted-prompts' }, expectedSha256: inspected.sha256 });
  assert.equal(imported.enabled, false);
  await call('extension/enable', { id: imported.id, revision: imported.revision, enabled: true });
  // Kernel skills/list fixture now sees both converted prompts.
  // Activation copies each component skill dir to knorvia-<id>-0, -1, …
  const skillsBase = path.join(home, 'state', 'kernel', 'skills');
  const projections = fs.readdirSync(skillsBase)
    .filter((name) => name.startsWith(`knorvia-${imported.id}-`))
    .map((name) => path.join(skillsBase, name, 'SKILL.md'))
    .filter((file) => fs.existsSync(file));
  assert.ok(projections.some((file) => /review the following text/.test(fs.readFileSync(file, 'utf8'))), 'converted review prompt is discoverable');
  // Original source stays locatable: verbatim copy + report entry.
  const report = JSON.parse(await fsp.readFile(path.join(outputDir, 'conversion-report.json'), 'utf8'));
  const reviewEntry = report.entries.find((item) => item.command === 'review.md');
  assert.equal(reviewEntry.sourceFile, 'commands/review.md');
  const copiedSource = await fsp.readFile(path.join(outputDir, 'skills', reviewEntry.skillName, 'sources', 'review.md'), 'utf8');
  assert.match(copiedSource, /Review the given text/);
  // The original package is untouched.
  assert.equal(F.scan(path.join(home, 'extensions', 'marketplaces', entry.id, 'packages', entry.activeVersion, 'plugin')).sha256, originalSha);
});

function createExtensionConvertor(home) {
  return createExtensionConverter({ home });
}

test('invalid or oversized metadata and invalid UTF-8 are refused without discarding their semantics', async t => {
  const home = await makeHome(t);
  const { entry } = await installClaudePlugin(t, home);
  const pluginDir = path.join(home, 'extensions', 'marketplaces', entry.id, 'packages', entry.activeVersion, 'plugin');
  const commandsDir = path.join(pluginDir, 'commands');
  await fsp.writeFile(path.join(commandsDir, 'duplicate-metadata.md'), '---\nhooks: one\nhooks: two\n---\nPrompt\n');
  await fsp.writeFile(path.join(commandsDir, 'large-metadata.md'), `---\ndescription: ${'x'.repeat(33000)}\nhooks: stop\n---\nPrompt\n`);
  await fsp.writeFile(path.join(commandsDir, 'unclosed-metadata.md'), '---\nhooks: stop\nPrompt\n');
  await fsp.writeFile(path.join(commandsDir, 'invalid-utf8.md'), Buffer.from([0x50, 0x72, 0x6f, 0xff, 0x0a]));
  const bomOriginal = Buffer.from('\uFEFF---\ndescription: Author\'s source\n---\nExact prompt\r\n');
  await fsp.writeFile(path.join(commandsDir, 'bom.md'), bomOriginal);
  const before = F.scan(pluginDir).sha256;
  const converter = createExtensionConverter({ home });
  const plan = await converter.plan({ entryId: entry.id });
  for (const name of ['duplicate-metadata', 'large-metadata', 'unclosed-metadata', 'invalid-utf8']) {
    const item = plan.items.find(item => item.command === `${name}.md`);
    assert.equal(item.status, 'refused', name);
    assert.match(item.refusals.join(''), /元数据|UTF-8/);
  }
  const outputDir = path.join(home, 'input', 'metadata-output');
  const outcome = await converter.perform({ entryId: entry.id, outputDir, expectedPackageSha256: plan.extension.packageSha256 });
  assert.equal(outcome.results.filter(item => item.status === 'refused').length, 5);
  assert.deepEqual(await fsp.readFile(path.join(outputDir, 'skills', 'bom', 'sources', 'bom.md')), bomOriginal);
  assert.match(await fsp.readFile(path.join(outputDir, 'skills', 'bom', 'SKILL.md'), 'utf8'), /Author's source/);
  assert.equal(F.scan(pluginDir).sha256, before);
});

test('a directory created between preflight and output claim is never overwritten or removed', async t => {
  const home = await makeHome(t);
  const { entry } = await installClaudePlugin(t, home);
  const outputDir = path.join(home, 'input', 'concurrent-output');
  const sentinel = path.join(outputDir, 'user-document.txt');
  const originalMkdir = fsp.mkdir;
  let injected = false;
  fsp.mkdir = async (dir, options) => {
    if (dir === outputDir && !injected) {
      injected = true;
      await originalMkdir(dir);
      await fsp.writeFile(sentinel, 'user-owned content');
    }
    return originalMkdir(dir, options);
  };
  try {
    await assert.rejects(createExtensionConverter({ home }).perform({ entryId: entry.id, outputDir }), error => error.rpc?.code === -32005);
    assert.equal(await fsp.readFile(sentinel, 'utf8'), 'user-owned content');
    assert.deepEqual(await fsp.readdir(outputDir), ['user-document.txt']);
  } finally { fsp.mkdir = originalMkdir; }
});

test('a reviewed package changed before confirmation is refused before claiming output', async t => {
  const home = await makeHome(t);
  const { entry } = await installClaudePlugin(t, home);
  const converter = createExtensionConverter({ home });
  const plan = await converter.plan({ entryId: entry.id });
  await fsp.appendFile(path.join(home, 'extensions', 'marketplaces', entry.id, 'packages', entry.activeVersion, 'plugin', 'commands', 'review.md'), '\nChanged prompt.\n');
  const outputDir = path.join(home, 'input', 'stale-preview');
  await assert.rejects(converter.perform({ entryId: entry.id, outputDir, expectedPackageSha256: plan.extension.packageSha256 }), error => error.rpc?.code === -32005);
  assert.equal(fs.existsSync(outputDir), false);
});

test('a command changed after preflight is not converted using stale semantics', async t => {
  const home = await makeHome(t);
  const { entry } = await installClaudePlugin(t, home);
  const converter = createExtensionConverter({ home });
  const plan = converter.plan.bind(converter);
  converter.plan = async args => {
    const result = await plan(args);
    await fsp.writeFile(path.join(home, 'extensions', 'marketplaces', entry.id, 'packages', entry.activeVersion, 'plugin', 'commands', 'review.md'), 'Execute !`a-new-command`\n');
    return result;
  };
  const outputDir = path.join(home, 'input', 'changed-source');
  await assert.rejects(converter.perform({ entryId: entry.id, outputDir }), error => error.rpc?.code === -32005 && error.rpc.data.partial === true);
  assert.equal(fs.existsSync(path.join(outputDir, 'skills', 'review', 'SKILL.md')), false);
  assert.equal(fs.existsSync(path.join(outputDir, 'conversion-report.json')), false);
});

test('converted prompts are discovered by the real Kernel after actual inspect/install/enable', { skip: !process.env.KNORVIA_DAEMON_BIN || !process.env.KNORVIA_KERNEL_BIN, timeout: 90000 }, async t => {
  const home = await makeHome(t);
  const { entry } = await installClaudePlugin(t, home);
  const sourceDir = path.join(home, 'extensions', 'marketplaces', entry.id, 'packages', entry.activeVersion, 'plugin');
  const before = F.scan(sourceDir).sha256;
  const outputDir = path.join(home, 'input', 'live-converted');
  const outcome = await createExtensionConverter({ home }).perform({ entryId: entry.id, outputDir });
  assert.equal(outcome.results.filter(item => item.status === 'converted').length, 2);
  const { createKernelEngine } = require('../kernel-engine');
  const { startScriptedResponsesFixture } = require('./fixtures/scripted-responses-fixture');
  const provider = await startScriptedResponsesFixture();
  let engine;
  try {
    engine = await createKernelEngine({ home, env: { ...process.env, ...provider.providerEnv }, legacyChatBridge: false });
    const workspace = await engine.rpc('workspace/create', { title: 'Converted prompt project', cwd: path.join(home, 'input') });
    const manager = createExtensionManager({ home, rpc: async (method, params) => {
      try { return await engine.rpc(method, params); }
      catch (error) { t.diagnostic(`${method}: ${error.message}`); throw error; }
    } });
    const source = { type: 'local', workspaceId: workspace.id, path: 'live-converted' };
    const inspected = await manager.handlers['extension/inspect']({ source });
    const installed = await manager.handlers['extension/install']({ source, expectedSha256: inspected.sha256 });
    assert.equal(installed.enabled, false);
    await manager.handlers['extension/enable']({ id: installed.id, revision: installed.revision, enabled: true });
    const listed = await engine.rpc('skills/list', { forceReload: true });
    const skills = listed.data.flatMap(group => group.skills);
    for (const name of ['review', 'summarize']) {
      const skill = skills.find(item => item.name === name);
      assert.ok(skill, JSON.stringify(listed));
      assert.ok(path.resolve(skill.path).startsWith(path.resolve(home) + path.sep));
      const report = JSON.parse(await fsp.readFile(path.join(outputDir, 'conversion-report.json'), 'utf8'));
      const provenance = report.entries.find(item => item.skillName === name);
      const copied = await fsp.readFile(path.join(outputDir, 'skills', name, 'sources', provenance.command));
      assert.equal(require('node:crypto').createHash('sha256').update(copied).digest('hex'), provenance.originalSha256);
    }
    assert.equal(F.scan(sourceDir).sha256, before);
  } finally { await engine?.shutdown(); await provider.close(); }
});

test('hooks, shell execution, duplicate slugs, and an existing output dir are refused without executing anything', async t => {
  const home = await makeHome(t);
  const { entry } = await installClaudePlugin(t, home);
  const converter = createExtensionConverter({ home });
  const plan = await converter.plan({ entryId: entry.id });
  assert.equal(plan.items.find((item) => item.command === 'danger.md').status, 'refused');
  // An existing output directory is refused before any write.
  const outputDir = path.join(home, 'input');
  await assert.rejects(converter.perform({ entryId: entry.id, outputDir }), error => /已存在/.test(error.message));
  // Duplicate slugs refuse the later command ('a-b.md' and 'a.b.md' both
  // slug to 'a-b-md'; a case-variant filename is impossible on Windows).
  const commandsDir = path.join(home, 'extensions', 'marketplaces', entry.id, 'packages', entry.activeVersion, 'plugin', 'commands');
  await fsp.writeFile(path.join(commandsDir, 'a-b.md'), 'first clashing name\n');
  await fsp.writeFile(path.join(commandsDir, 'a.b.md'), 'second clashing name\n');
  const plan2 = await converter.plan({ entryId: entry.id });
  const pair = plan2.items.filter((item) => ['a-b.md', 'a.b.md'].includes(item.command));
  assert.equal(pair.length, 2);
  assert.equal(pair.filter((item) => item.status === 'refused').length, 1, 'exactly one of the clashing pair converts');
  assert.equal(pair.filter((item) => item.status === 'convertible').length, 1);
  assert.ok(pair.every((item) => item.skillName === skillNameFor('a-b.md')));
});

test('the converter never mutates the source package, even when every command is refused', async t => {
  const home = await makeHome(t);
  const source = path.join(home, 'input', 'hooked');
  await fsp.mkdir(path.join(source, '.claude-plugin'), { recursive: true });
  await fsp.mkdir(path.join(source, 'commands'), { recursive: true });
  await fsp.writeFile(path.join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'hooked-pack' }));
  await fsp.writeFile(path.join(source, 'commands', 'only.md'), '---\nhooks: { stop: true }\n---\nbody with hooks\n');
  const { call } = managerFor(home);
  const inspected = await call('extension/inspect', { source: { type: 'local', workspaceId: 'fixture', path: 'hooked' } });
  const entry = await call('extension/install', { source: { type: 'local', workspaceId: 'fixture', path: 'hooked' }, expectedSha256: inspected.sha256 });
  const before = F.scan(path.join(home, 'extensions', 'marketplaces', entry.id, 'packages', entry.activeVersion, 'plugin')).sha256;
  const converter = createExtensionConverter({ home });
  const plan = await converter.plan({ entryId: entry.id });
  assert.equal(plan.items[0].status, 'refused');
  assert.match(plan.items[0].refusals.join(''), /hooks/);
  const outputDir = path.join(home, 'input', 'out');
  const result = await converter.perform({ entryId: entry.id, outputDir });
  assert.equal(result.results[0].status, 'refused');
  assert.equal(fs.readdirSync(outputDir).join(','), 'conversion-report.json', 'nothing but the report is written');
  assert.equal(F.scan(path.join(home, 'extensions', 'marketplaces', entry.id, 'packages', entry.activeVersion, 'plugin')).sha256, before, 'source package hash unchanged');
});

test('bash interpolation, path escape, agent behavior and escaping outputDir are refused', async t => {
  const home = await makeHome(t);
  const source = path.join(home, 'input', 'unsupported-pack');
  await fsp.mkdir(path.join(source, '.claude-plugin'), { recursive: true });
  await fsp.mkdir(path.join(source, 'commands'), { recursive: true });
  await fsp.writeFile(path.join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'unsupported-pack' }));
  await fsp.writeFile(path.join(source, 'commands', 'bash.md'), 'Run $(whoami) now.\n');
  await fsp.writeFile(path.join(source, 'commands', 'escape.md'), 'Read @../secret/file.txt\n');
  await fsp.writeFile(path.join(source, 'commands', 'agentic.md'), '---\nagent: auto-fixer\ncontext: project-state\npermissions: all\n---\nPrompt\n');
  const { call } = managerFor(home);
  const inspected = await call('extension/inspect', { source: { type: 'local', workspaceId: 'fixture', path: 'unsupported-pack' } });
  const entry = await call('extension/install', { source: { type: 'local', workspaceId: 'fixture', path: 'unsupported-pack' }, expectedSha256: inspected.sha256 });
  const converter = createExtensionConverter({ home });
  const plan = await converter.plan({ entryId: entry.id });

  const bashItem = plan.items.find(i => i.command === 'bash.md');
  assert.equal(bashItem.status, 'refused');
  assert.match(bashItem.refusals.join(''), /bash 插值/);

  const escapeItem = plan.items.find(i => i.command === 'escape.md');
  assert.equal(escapeItem.status, 'refused');
  assert.match(escapeItem.refusals.join(''), /逃逸路径/);

  const agentItem = plan.items.find(i => i.command === 'agentic.md');
  assert.equal(agentItem.status, 'refused');
  assert.match(agentItem.refusals.join(''), /agent 行为/);
  assert.ok(agentItem.notes.some(n => /context/.test(n)));
  assert.ok(agentItem.notes.some(n => /permissions/.test(n)));

  // OutputDir with .. path traversal
  const escapingOutputDir = `${home}${path.sep}input${path.sep}sub${path.sep}..${path.sep}..${path.sep}escaped-out`;
  await assert.rejects(
    converter.perform({ entryId: entry.id, outputDir: escapingOutputDir }),
    error => /有效|路径/.test(error.message),
  );
});
