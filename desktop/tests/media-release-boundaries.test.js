'use strict';

// Release review: exercise actual host handlers with bounded local stores.
// No provider requests, no GUI stack, no user files, and no paid calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTemplateStore } = require('../studio-templates');
const { createMediaStudio } = require('../media-studio');
const { validatePackage, exportPackage } = require('../pet-package');
const H = require('./fixtures/sequence-harness');
const MAX = 3 * 1024 * 1024;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const fixtureHome = name => fs.mkdtempSync(path.join(os.tmpdir(), `kn-release-${name}-`));
const limitError = error => error.rpc?.code === -32602 && /3 MiB/.test(error.message);

test('200-shot details remain intact while fifty queue summaries fit the response bound', async t => {
  const rpc = H.createFakeRpc(), studio = H.createFakeStudio(rpc);
  const { engine } = H.createEngine(rpc, studio); t.after(() => engine.close());
  const queue = await engine.handlers['studio/sequence/create']({
    title: '大队列', defaults: { profileId: 'video', seconds: 4 }, globalPrompt: '统一上下文',
    shots: Array.from({ length: 200 }, (_, order) => ({ prompt: `第${order}段 ${'角色和光影。'.repeat(100)}` })),
  });
  const stored = rpc.state.jobs.get(queue.id);
  // Populate fifty existing durable Jobs directly: this isolates list output
  // size from provider submission, which belongs to the production HTTP tests.
  for (let i = 1; i < 50; i++) rpc.state.jobs.set(`cloned-${i}`, { ...stored, id: `cloned-${i}` });
  const list = await engine.handlers['studio/sequence/list']({ limit: 50 });
  assert.equal(list.sequences.length, 50); assert.equal(list.total, 50);
  assert.ok(bytes(list) < MAX, `summary response ${bytes(list)} bytes`);
  assert.equal(list.sequences[0].shots.length, 200);
  assert.equal(list.sequences[0].shots[199].prompt, '');
  const full = await engine.handlers['studio/sequence/read']({ id: queue.id });
  assert.equal(full.shots[199].prompt, queue.shots[199].prompt);
  assert.equal(full.globalPrompt, '统一上下文'); assert.ok(bytes(full) < MAX);
});

test('queue content growth is rejected before persistence and old oversized details return a small typed error', async t => {
  const rpc = H.createFakeRpc(), studio = H.createFakeStudio(rpc);
  const { engine } = H.createEngine(rpc, studio); t.after(() => engine.close());
  const input = { title: '放大上下文', defaults: { profileId: 'video', seconds: 4 }, shots: Array.from({ length: 200 }, () => ({ prompt: '一段' })) };
  // The raw request is small; repeating a shared 12k CJK context into every
  // accepted prompt would otherwise grow the response beyond transport limits.
  await assert.rejects(engine.handlers['studio/sequence/create']({ ...input, globalPrompt: '中'.repeat(12000) }), limitError);
  assert.equal(rpc.state.jobs.size, 0, 'no Job or generation created for rejected content');
  const good = await engine.handlers['studio/sequence/create'](input);
  await assert.rejects(engine.handlers['studio/sequence/update']({ id: good.id, revision: good.revision, patch: { globalPrompt: '中'.repeat(12000) } }), limitError);
  assert.equal((await engine.handlers['studio/sequence/read']({ id: good.id })).revision, good.revision);
  rpc.state.jobs.get(good.id).checkpoint.shots[0].acceptedPrompt = '中'.repeat(1200000);
  await assert.rejects(engine.handlers['studio/sequence/read']({ id: good.id }), error => limitError(error) && bytes(error.rpc) < 1024);
  assert.equal((await engine.handlers['studio/sequence/list']({})).sequences.length, 1, 'old oversized detail does not break list');
  assert.equal(studio.submissions.length, 0);
});

test('large queue lists bound the internal Rust response before projecting public summaries', async t => {
  const inner = H.createFakeRpc(), frames = [];
  const rpc = async (method, params) => {
    const result = await inner(method, params);
    if (method === 'job/list') {
      const size = bytes(result); frames.push(size);
      assert.equal(params.limit, 1, 'daemon responses must contain at most one full sequence');
      assert.ok(size < 8 * 1024 * 1024, `internal Rust frame too large: ${size}`);
    }
    return result;
  };
  const studio = H.createFakeStudio(inner), { engine } = H.createEngine(rpc, studio); t.after(() => engine.close());
  const queue = await engine.handlers['studio/sequence/create']({
    title: '大型已接受队列', globalPrompt: 'x'.repeat(12000), defaults: { profileId: 'video', seconds: 4 },
    shots: Array.from({ length: 200 }, () => ({ prompt: 'shot' })),
  });
  const job = inner.state.jobs.get(queue.id);
  for (const shot of job.checkpoint.shots) shot.acceptedPrompt = `${'x'.repeat(12000)}\n\nshot`;
  for (let i = 1; i < 20; i++) inner.state.jobs.set(`large-${i}`, { ...job, id: `large-${i}` });
  const oldPage = await inner('job/list', { workspaceId: 'ws-1', typePrefix: 'studio.sequence', offset: 0, limit: 20 });
  assert.ok(bytes(oldPage) > 40 * 1024 * 1024, 'fixture proves the old single page would exceed Rust framing');
  const list = await engine.handlers['studio/sequence/list']({ limit: 20 });
  assert.equal(list.sequences.length, 20); assert.equal(frames.length, 20);
  assert.ok(frames.every(size => size > 2 * 1024 * 1024), 'these are genuinely large durable documents');
  assert.ok(bytes(list) < MAX);
  await engine.recover();
  assert.equal(frames.length, 40, 'restart recovery also reads one document per Rust frame');
  assert.equal(studio.submissions.length, 0, 'listing and recovery never start ready drafts');
});

test('media startup and gallery paging bound raw checkpoint frames without replaying completed Jobs', async t => {
  const inner = H.createFakeRpc(), frames = [];
  // Remote metadata can carry long signed output URLs independently from
  // configured prompt/custom limits. Public summaries only expose remote id.
  for (let i = 0; i < 200; i++) inner.state.jobs.set(`media-${i}`, {
    id: `media-${i}`, workspaceId: 'ws-1', type: 'media.video', status: 'succeeded',
    checkpoint: { kind: 'video', phase: 'completed', remote: { id: `remote-${i}`, outputs: [{ url: `https://fixture.invalid/output?sig=${'x'.repeat(180000)}` }] }, outputs: [] },
  });
  const rpc = async (method, params) => {
    assert.notEqual(method, 'job/create', 'completed history must never be regenerated');
    const result = await inner(method, params);
    if (method === 'job/list') { frames.push({ type: params.typePrefix, size: bytes(result) }); assert.equal(params.limit, 1); assert.ok(bytes(result) < 8 * 1024 * 1024); }
    return result;
  };
  const oldPage = await inner('job/list', { workspaceId: 'ws-1', typePrefix: 'media.', offset: 0, limit: 60 });
  assert.ok(bytes(oldPage) > 8 * 1024 * 1024, 'old raw gallery page exceeds the actual internal frame limit');
  const home = fixtureHome('media-raw'), studio = createMediaStudio({ home, rpc, library: H.fakeLibrary() }); t.after(() => studio.close());
  await studio.initialize(); await studio.initialize();
  assert.equal(frames.filter(frame => frame.type === 'media.').length, 200, 'second initialize does not repeat recovery');
  const page = await studio.handlers['studio/list']({ offset: 70, limit: 60 });
  assert.equal(page.jobs.length, 60); assert.equal(page.jobs[0].id, 'media-70'); assert.equal(page.total, 200);
  assert.ok(bytes(page) < MAX); assert.equal(page.jobs[0].remote.outputs, undefined);
  assert.equal(frames.filter(frame => frame.type === 'media.').length, 260);
});

test('template import and save reject an oversized public library without changing its durable bytes', () => {
  const home = fixtureHome('templates'), store = createTemplateStore({ home });
  store.handlers['studio/template/save']({ name: '保留', prompt: 'existing' });
  const file = path.join(store.root, 'templates.json'), before = fs.readFileSync(file);
  const oversized = Array.from({ length: 100 }, (_, i) => ({ name: `模板${i}`, prompt: '中'.repeat(12000) }));
  assert.throws(() => store.handlers['studio/template/import']({ templates: oversized }), limitError);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(store.handlers['studio/template/list']({}).templates.length, 1);
  // Simulate a valid legacy library whose individual documents meet the old
  // limits. Full list is visibly refused; single/search reads remain available.
  const legacy = { version: 1, templates: oversized.map((value, i) => ({ ...value, id: `legacy-${i}`, revision: 1, kind: 'any', variables: [], defaults: {}, history: [] })) };
  fs.writeFileSync(file, JSON.stringify(legacy)); const legacyBytes = fs.readFileSync(file);
  assert.throws(() => store.handlers['studio/template/list']({}), limitError);
  assert.equal(store.handlers['studio/template/read']({ id: 'legacy-99' }).prompt, oversized[99].prompt);
  assert.equal(store.handlers['studio/template/list']({ query: '模板99' }).templates.length, 1);
  assert.throws(() => store.handlers['studio/template/save']({ id: 'legacy-0', expectedRevision: 1, name: '仍过大', prompt: '中'.repeat(12000) }), limitError);
  assert.deepEqual(fs.readFileSync(file), legacyBytes);
});

test('Pet manifest and license limits are checked before parsing or exporting', () => {
  const root = fixtureHome('pet-size'), bad = path.join(root, 'bad'); fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'pet.json'), ' '.repeat(32 * 1024 + 1));
  assert.throws(() => validatePackage(bad), /32 KB/);
  const source = path.join(root, 'source'); fs.cpSync(path.join(__dirname, '..', 'assets', 'pets', 'hatchling'), source, { recursive: true });
  fs.writeFileSync(path.join(source, 'LICENSE.txt'), 'x'.repeat(256 * 1024 + 1));
  const target = path.join(root, 'must-not-exist');
  assert.throws(() => exportPackage({ sourceDir: source, targetDir: target }), /256 KB/);
  assert.equal(fs.existsSync(target), false);
});

test('Pet manifests and license files cannot escape the package via real file symlinks', () => {
  const root = fixtureHome('pet-symlink'), source = path.join(root, 'source');
  fs.cpSync(path.join(__dirname, '..', 'assets', 'pets', 'hatchling'), source, { recursive: true });
  const manifest = path.join(source, fs.existsSync(path.join(source, 'pet.json')) ? 'pet.json' : 'manifest.json');
  const outside = path.join(root, 'private-manifest.json'); fs.copyFileSync(manifest, outside); fs.unlinkSync(manifest);
  fs.symlinkSync(outside, manifest, 'file');
  assert.throws(() => validatePackage(source), /包内普通文件/);
  fs.unlinkSync(manifest); fs.copyFileSync(outside, manifest);
  const license = path.join(source, 'LICENSE.txt'); if (fs.existsSync(license)) fs.unlinkSync(license);
  const secret = path.join(root, 'private-note.txt'); fs.writeFileSync(secret, 'PRIVATE-PET-EXPORT-FIXTURE');
  fs.symlinkSync(secret, license, 'file');
  const target = path.join(root, 'must-not-exist');
  assert.throws(() => exportPackage({ sourceDir: source, targetDir: target }), /许可文件必须位于/);
  assert.equal(fs.existsSync(target), false);
});
