'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureBuiltinSkills } = require('../builtin-skills');
const { createKernelEngine } = require('../kernel-engine');
const { startScriptedResponsesFixture } = require('./fixtures/scripted-responses-fixture');

test('bundled router references are complete and startup preserves user edits', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-builtin-test-'));
  try {
    const seeded = ensureBuiltinSkills(home);
    assert.deepEqual(seeded.map(result => result.name).sort(), ['learning-pack', 'remotion-best-practices']);
    assert.equal(seeded.every(result => result.installed), true);
    const root = path.join(home, 'state/kernel/skills/remotion-best-practices');
    const skill = path.join(root, 'SKILL.md'), text = fs.readFileSync(skill, 'utf8');
    const links = [...text.matchAll(/\]\((\.\/[^)]+)\)/g)];
    assert.equal(new Set(links.map(m => m[1])).size, 11);
    for (const link of links) assert.ok(fs.statSync(path.join(root, link[1])).isFile(), link[1]);
    assert.ok(fs.statSync(path.join(home, 'state/kernel/skills/learning-pack', 'SKILL.md')).isFile());
    assert.ok(fs.statSync(path.join(home, 'state/kernel/skills/learning-pack', 'references', 'evidence.md')).isFile());
    fs.writeFileSync(skill, text + '\nUser customization must survive restart.\n');
    const reseeded = ensureBuiltinSkills(home);
    assert.equal(reseeded.every(result => result.preserved), true);
    assert.match(fs.readFileSync(skill, 'utf8'), /User customization/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'))).build.files.includes('builtin-skills/**/*'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('transient Windows directory locks retry atomic skill installation', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-builtin-retry-'));
  const rename = fs.renameSync;
  let attempts = 0;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (path.basename(target) === 'remotion-best-practices' && ++attempts <= 2) {
      throw Object.assign(new Error('Directory temporarily locked'), { code: 'EPERM' });
    }
    return rename(source, target);
  });
  try {
    assert.equal(ensureBuiltinSkills(home).every(result => result.installed), true);
    assert.equal(attempts, 3);
    assert.ok(fs.statSync(path.join(home, 'state/kernel/skills/remotion-best-practices/SKILL.md')).isFile());
    assert.deepEqual(fs.readdirSync(path.join(home, 'extensions/builtin-staging')), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('permanent directory lock stops after five attempts and cleans staging', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-builtin-locked-'));
  let attempts = 0;
  t.mock.method(fs, 'renameSync', () => {
    attempts++;
    throw Object.assign(new Error('Permanent lock'), { code: 'EPERM' });
  });
  try {
    assert.throws(() => ensureBuiltinSkills(home), { code: 'EPERM' });
    assert.equal(attempts, 5);
    assert.equal(fs.existsSync(path.join(home, 'state/kernel/skills/remotion-best-practices')), false);
    assert.deepEqual(fs.readdirSync(path.join(home, 'extensions/builtin-staging')), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a concurrent installer owns its target even when rename reports a lock', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-builtin-concurrent-'));
  const rename = fs.renameSync;
  let attempts = 0;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (path.basename(target) === 'remotion-best-practices') {
      attempts++;
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'SKILL.md'), 'User-owned skill');
      throw Object.assign(new Error('Concurrent target'), { code: 'EPERM' });
    }
    return rename(source, target);
  });
  try {
    assert.deepEqual(ensureBuiltinSkills(home)[0], { installed: false, preserved: true });
    assert.equal(attempts, 1);
    assert.equal(fs.readFileSync(path.join(home, 'state/kernel/skills/remotion-best-practices/SKILL.md'), 'utf8'), 'User-owned skill');
    assert.deepEqual(fs.readdirSync(path.join(home, 'extensions/builtin-staging')), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('real Kernel discovers bundled Remotion and advertises it to a local model', { skip: !process.env.KNORVIA_DAEMON_BIN || !process.env.KNORVIA_KERNEL_BIN, timeout: 90000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-builtin-live-'));
  let advertised = false;
  const provider = await startScriptedResponsesFixture({ onRequest: body => { advertised ||= body.includes('remotion-best-practices') && body.includes('SKILL.md'); } });
  let engine;
  try {
    engine = await createKernelEngine({ home, env: { ...process.env, ...provider.providerEnv }, legacyChatBridge: false });
    const result = await engine.rpc('skills/list', { forceReload: true });
    const entry = result.data.flatMap(group => group.skills).find(s => s.name === 'remotion-best-practices');
    assert.ok(entry, JSON.stringify(result));
    assert.ok(entry.path.replaceAll('\\', '/').startsWith(home.replaceAll('\\', '/')));
    const thread = await engine.rpc('thread/start', { workspaceId: engine.workspace.id, title: 'Builtin skill discovery' });
    const admitted = await engine.rpc('turn/start', { threadId: thread.id, input: 'Explain the available Remotion skill; do not render or install anything.', tools: { write: false } });
    const id = admitted.turn?.id || admitted.id;
    let turn;
    const deadline = Date.now() + 60000;
    do {
      await new Promise(resolve => setTimeout(resolve, 150));
      turn = await engine.rpc('turn/read', { id });
    } while (!['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.status) && Date.now() < deadline);
    assert.equal(turn.status, 'completed', JSON.stringify(turn));
    assert.equal(advertised, true, 'The model must receive the skill name and entry path');
  } finally {
    await engine?.shutdown(); await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
