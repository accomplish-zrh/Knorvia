'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalizePlan, compileCanvas, compileSequence } = require('../builtin-skills/short-drama/scripts/compile-story.cjs');
const { validateGraph } = require('../studio-canvas');
const { TOOLS } = require('../studio-mcp');
const script = path.join(__dirname, '../builtin-skills/short-drama/scripts/compile-story.cjs');
const ref = { id: 'library-photo-1', version: 'AB'.repeat(32) };
const shot = (id, extra = {}) => ({ id, title: id, prompt: '修伞师把伞递给客人。', seconds: 6, ...extra });
const plan = () => ({ schemaVersion: 1, id: 'umbrella', title: '修伞铺', shots: [shot('one')] });

// Enforce the real MCP schema vocabulary, including additionalProperties.
function accepts(value, schema, at = '$') {
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), at);
    for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), `${at}.${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.additionalProperties === false) assert.ok(Object.hasOwn(schema.properties, key), `${at}.${key}`);
      if (schema.properties?.[key]) accepts(child, schema.properties[key], `${at}.${key}`);
    }
  } else if (schema.type === 'array') {
    assert.ok(Array.isArray(value), at);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, at);
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, at);
    value.forEach((v, i) => accepts(v, schema.items, `${at}[${i}]`));
  } else if (schema.type === 'integer') assert.ok(Number.isInteger(value), at);
  else if (schema.type) assert.equal(typeof value, schema.type, at);
  if (schema.enum) assert.ok(schema.enum.includes(value), at);
  if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, at);
  if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, at);
}

test('normalization is repeatable, preserves the input, and uses opt-in continuity', () => {
  const input = plan(), before = structuredClone(input), first = normalizePlan(input);
  assert.deepEqual(input, before);
  assert.deepEqual(normalizePlan(first), first);
  assert.equal(first.aspect, '16:9');
  assert.equal(first.shots[0].continuity, 'none');
  assert.deepEqual(first.characters, []);
  assert.throws(() => normalizePlan({ ...input, characters: new Date() }));
});

test('example compiles to the actual native graph and both actual MCP schemas', () => {
  const input = JSON.parse(fs.readFileSync(path.join(path.dirname(script), '../assets/example-story.json')));
  const canvas = compileCanvas(input, { imageProfileId: 'image-model', videoProfileId: 'video-model', threadId: 'thread-1' });
  const queue = compileSequence(input, { videoProfileId: 'video-model' });
  const graph = validateGraph(canvas.nodes, canvas.edges);
  assert.equal(graph.nodes.length, canvas.nodes.length);
  for (const [name, value] of [['media_canvas', canvas], ['media_sequence_create', queue]]) accepts(value, TOOLS.find(t => t.name === name).inputSchema);
  assert.equal(canvas.nodes.filter(n => n.kind === 'video').length, input.shots.length);
  assert.equal(canvas.nodes.some(n => 'jobId' in n || 'job' in n), false);
  assert.equal(queue.start, false);
  assert.ok(queue.shots[0].prompt.includes(input.characters[1].description));
});

test('frame and identity references are pinned; shared images are deduplicated', () => {
  const input = plan();
  input.characters = [{ id: 'a', name: '修伞师', description: '蓝围裙', reference: ref }, { id: 'b', name: '客人', description: '灰风衣', reference: ref }];
  input.shots[0].characterIds = ['a', 'b'];
  input.shots[0].firstFrame = ref;
  input.shots[0].lastFrame = { id: 'end', version: 'CD'.repeat(32) };
  const canvas = compileCanvas(input);
  validateGraph(canvas.nodes, canvas.edges);
  assert.equal(canvas.nodes.filter(n => n.kind === 'asset').length, 2);
  assert.equal(canvas.edges.filter(e => e.role === 'reference').length, 1);
  assert.equal(canvas.edges.filter(e => e.role === 'firstFrame').length, 1);
  assert.equal(canvas.edges.filter(e => e.role === 'lastFrame').length, 1);
  assert.equal(canvas.nodes.find(n => n.reference?.id === ref.id).reference.version, ref.version.toLowerCase());
  assert.equal(input.characters[0].reference.version, ref.version);
});

test('same-scene continuation links video to video and retains the new shot content', () => {
  const input = plan();
  input.scenes = [{ id: 'shop', name: '店内', description: '暖黄灯光' }];
  input.shots = [shot('one', { sceneId: 'shop' }), shot('two', { sceneId: 'shop', continuity: 'previous-tail', dialogue: '路上小心。' })];
  const canvas = compileCanvas(input), videoNodes = canvas.nodes.filter(n => n.kind === 'video');
  validateGraph(canvas.nodes, canvas.edges);
  assert.ok(canvas.edges.some(e => e.from === videoNodes[0].id && e.to === videoNodes[1].id && e.role === 'firstFrame'));
  const queue = compileSequence(input, { videoProfileId: 'v' });
  assert.equal(queue.shots[1].continuity, 'previous-tail');
  assert.ok(queue.shots[1].prompt.includes('路上小心。'));
  assert.equal('firstFrame' in queue.shots[1], false);
});

test('bad fields, associations, numbers and asset versions are rejected', () => {
  const changes = [
    p => p.apiKey = 'not-a-plan-field',
    p => p.title = ' ',
    p => p.shots = [],
    p => p.shots[0].seconds = 1.5,
    p => p.shots[0].seconds = 61,
    p => p.shots[0].sceneId = 'missing',
    p => p.shots[0].characterIds = [undefined],
    p => p.shots[0].firstFrame = { id: 'https://example.test/image.png', version: ref.version },
    p => p.shots[0].firstFrame = { id: 'valid-id' },
    p => p.shots[0].firstFrame = { ...ref, version: 'not-a-hash' },
    p => p.shots[0].firstFrame = { ...ref, path: 'extra' },
    p => p.shots[0].continuity = 'automatic',
    p => p.globalPrompt = 'x'.repeat(6001),
    p => p.characters = null,
  ];
  for (const change of changes) { const input = plan(); change(input); assert.throws(() => normalizePlan(input)); }
});

test('duplicates and wrong entity roles cannot pass as valid associations', () => {
  const input = plan();
  input.characters = [{ id: 'a', name: '客人', description: '灰风衣' }];
  input.shots[0].characterIds = ['a', 'a'];
  assert.throws(() => normalizePlan(input), /重复/);
  input.shots[0].characterIds = [];
  input.shots[0].sceneId = 'a';
  assert.throws(() => normalizePlan(input), /类型/);
  delete input.shots[0].sceneId;
  input.scenes = [{ id: 'a', name: '店内', description: '木工作台' }];
  assert.throws(() => normalizePlan(input), /重复/);
  delete input.scenes;
  input.shots.push(structuredClone(input.shots[0]));
  assert.throws(() => normalizePlan(input), /重复/);
});

test('a first shot, scene change or explicit first frame cannot be chained accidentally', () => {
  const input = plan();
  input.shots[0].continuity = 'previous-tail';
  assert.throws(() => normalizePlan(input), /首镜/);
  input.shots[0].continuity = 'none';
  input.shots.push(shot('two', { continuity: 'previous-tail', firstFrame: ref }));
  assert.throws(() => normalizePlan(input), /冲突/);
  delete input.shots[1].firstFrame;
  input.scenes = [{ id: 'street', name: '街口', description: '雨中街口' }];
  input.shots[1].sceneId = 'street';
  assert.throws(() => normalizePlan(input), /跨场景/);
});

test('queue cannot silently drop end frames, identity images, or canvas-only options', () => {
  const input = plan();
  input.shots[0].lastFrame = ref;
  assert.throws(() => compileSequence(input, { videoProfileId: 'v' }), /lastFrame.*画布/);
  delete input.shots[0].lastFrame;
  input.characters = [{ id: 'a', name: '修伞师', description: '蓝围裙', reference: ref }];
  input.shots[0].characterIds = ['a'];
  assert.throws(() => compileSequence(input, { videoProfileId: 'v' }), /firstFrame/);
  input.shots[0].firstFrame = ref;
  assert.deepEqual(compileSequence(input, { videoProfileId: 'v' }).shots[0].firstFrame, { id: ref.id, version: ref.version.toLowerCase() });
  for (const opts of [{}, { videoProfileId: 'v', threadId: 'thread' }, { videoProfileId: 'v', imageProfileId: 'i' }, { videoProfileId: 'v', secret: 'x' }]) assert.throws(() => compileSequence(input, opts));
});

test('IDs are stable across edits while the submission key changes with content or profiles', () => {
  const input = plan(), first = compileCanvas(input);
  assert.deepEqual(compileCanvas(input), first);
  assert.ok(first.idempotencyKey.length <= 90);
  input.shots[0].prompt += '客人微笑。';
  const changed = compileCanvas(input);
  assert.notEqual(changed.idempotencyKey, first.idempotencyKey);
  assert.deepEqual(changed.nodes.map(n => n.id), first.nodes.map(n => n.id));
  assert.notEqual(compileCanvas(input, { videoProfileId: 'v' }).idempotencyKey, changed.idempotencyKey);
});

test('real graph and provider prompt budgets fail with actionable split instructions', () => {
  const input = plan();
  input.characters = [{ id: 'a', name: '主角', description: '蓝围裙' }];
  input.shots = Array.from({ length: 40 }, (_, i) => shot(`shot-${i}`));
  assert.throws(() => compileCanvas(input), /80\/200.*分批/);
  input.shots = [shot('one')];
  input.characters = Array.from({ length: 7 }, (_, i) => ({ id: `c-${i}`, name: `角色${i}`, description: '同场景', reference: { id: `ref-${i}`, version: 'ab'.repeat(32) } }));
  input.shots[0].characterIds = input.characters.map(c => c.id);
  assert.throws(() => compileCanvas(input), /6 张/);
  input.characters = [{ id: 'a', name: '主角', description: 'x'.repeat(1800) }, { id: 'b', name: '客人', description: 'x'.repeat(1800) }];
  input.shots[0].characterIds = ['a', 'b']; input.shots[0].prompt = 'p'.repeat(4000); input.globalPrompt = 'g'.repeat(6000);
  assert.throws(() => compileCanvas(input), /提示词过长/);
  assert.throws(() => compileSequence(input, { videoProfileId: 'v' }), /12000/);
});

test('portable CLI handles Unicode paths, strict arguments, bounded input and no-overwrite output', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-drama-cli-'));
  try {
    const input = path.join(home, '剧本 空格.json'), output = path.join(home, '画布.json');
    fs.writeFileSync(input, '\uFEFF' + JSON.stringify(plan()));
    const run = (...args) => spawnSync(process.execPath, [script, input, ...args], { cwd: home, encoding: 'utf8', timeout: 10000 });
    assert.equal(JSON.parse(run().stdout).schemaVersion, 1);
    assert.equal(run('--mode', 'canvas', '--output', output).status, 0);
    const original = fs.readFileSync(output);
    assert.notEqual(run('--mode', 'canvas', '--output', output).status, 0);
    assert.deepEqual(fs.readFileSync(output), original);
    for (const args of [['--unknown', 'x'], ['--mode'], ['--mode', 'canvas', '--mode', 'canvas'], ['--video-profile', 'v']]) assert.notEqual(run(...args).status, 0);
    fs.writeFileSync(input, JSON.stringify({ ...plan(), aspect: '9:16' }));
    const portrait = run('--mode', 'sequence', '--video-profile', 'v');
    assert.equal(portrait.status, 0);
    assert.equal(JSON.parse(portrait.stdout).start, false);
    assert.match(portrait.stderr, /aspect/);
    fs.writeFileSync(input, ' '.repeat(512 * 1024 + 1));
    assert.match(run().stderr, /512 KiB/);
  } finally {
    const rel = path.relative(os.tmpdir(), path.resolve(home));
    assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel) && path.basename(home).startsWith('knorvia-drama-cli-'));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
