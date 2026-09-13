'use strict';

// Isolated tests for the creative-brief tool. They use an in-memory fake
// library that hashes real bytes and enforces compare-and-swap exactly like
// the personal library, so no real runtime, model or user data is involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createCreativeBrief } = require('../creative-brief');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const code = expected => error => error.rpc?.code === expected;
const nowIso = () => new Date().toISOString();

function rpc(codeValue, message) { const error = new Error(message); error.rpc = { code: codeValue, message }; return error; }

function createFakeLibrary() {
  const files = new Map();
  let seq = 0;
  const publicEntry = entry => ({ id: entry.id, path: entry.path, name: entry.name, sha256: entry.sha256, size: entry.size, modifiedAt: entry.modifiedAt, trashedAt: entry.trashedAt, folder: false });
  const findById = id => [...files.values()].find(entry => entry.id === id);
  const handlers = {
    'library/list': async () => ({ entries: [...files.values()].map(publicEntry) }),
    'library/read': async ({ id, version, offset = 0 }) => {
      const entry = findById(id);
      if (!entry) throw rpc(-32004, '找不到这份资料');
      const digest = version ?? entry.sha256;
      const revision = entry.versions.find(item => item.sha256 === digest);
      if (!revision) throw rpc(-32004, '找不到这个版本');
      const chunk = revision.bytes.subarray(offset);
      return { entry: publicEntry(entry), sha256: digest, size: revision.bytes.length, base64: chunk.toString('base64'), nextOffset: offset + chunk.length < revision.bytes.length ? offset + chunk.length : null };
    },
    'library/versions': async ({ id }) => {
      const entry = findById(id);
      if (!entry) throw rpc(-32004, '找不到这份资料');
      return [...entry.versions].reverse().map(item => ({ sha256: item.sha256, size: item.size, createdAt: item.createdAt }));
    },
    'library/write': async ({ path: target, text: body, expectedSha256 }) => {
      const bytes = Buffer.from(body, 'utf8');
      const digest = sha256(bytes);
      const entry = files.get(target);
      if (entry) { if (!expectedSha256 || entry.sha256 !== expectedSha256) throw rpc(-32005, '文件已有更新，请重新读取后再保存'); }
      else if (expectedSha256) throw rpc(-32005, '原文件已被移走或删除');
      const record = entry ?? { id: `file-${++seq}`, path: target, name: target.split('/').pop(), versions: [], trashedAt: null };
      record.versions.push({ sha256: digest, size: bytes.length, bytes, createdAt: nowIso() });
      record.sha256 = digest; record.size = bytes.length; record.modifiedAt = nowIso();
      files.set(target, record);
      return publicEntry(record);
    },
  };
  return {
    handlers, files,
    put: (path, text) => handlers['library/write']({ path, text }),
    update: (path, text, expectedSha256) => handlers['library/write']({ path, text, expectedSha256 }),
    trash: path => { const entry = files.get(path); if (entry) entry.trashedAt = nowIso(); },
  };
}

async function setup(overrides = {}) {
  const lib = createFakeLibrary();
  const source = await lib.put('资料/来源.md', '# 报告\n\n第一段原文\n第二段原文\n');
  const output = await lib.put('创作/成稿.md', '这是最终成稿的内容');
  const tool = createCreativeBrief({ library: lib });
  const params = {
    action: 'create', requestId: 'brief-0001', title: '简报标题', audience: '产品团队',
    objective: '整理来源要点', format: '文章', authorship: 'agent',
    sourceRefs: [{ id: source.id }],
    claims: [{ id: 'k1', text: '要点一', evidence: { libraryId: source.id, line: 3, quote: '第一段原文' } }],
    criteria: [{ id: 'c1', description: '覆盖第一段原文' }],
    outline: [{ title: '开头', summary: '引入', claimIds: ['k1'] }],
    ...overrides,
  };
  const brief = await tool.callTool('creative_brief', params);
  return { lib, tool, source, output, params, brief, briefPath: brief.path, sourceId: source.id, outputId: output.id };
}
const reviewParams = (briefPath, outputId, evaluations, extra = {}) => ({
  action: 'review', path: briefPath, reviewId: extra.reviewId ?? 'rev-0001', reviewer: extra.reviewer ?? 'agent',
  outputRefs: extra.outputRefs ?? [{ id: outputId }], evaluations,
});
const onePass = criterionId => ({ criterionId, outcome: 'pass', note: '已满足' });

test('exposes the creative_brief tool, descriptors and commands', async () => {
  const tool = createCreativeBrief({ library: createFakeLibrary() });
  assert.deepEqual(Object.keys(tool.commands).sort(), ['creative/brief/create', 'creative/brief/read', 'creative/brief/review']);
  const [descriptor] = tool.toolDescriptors();
  assert.equal(descriptor.name, 'creative_brief');
  assert.deepEqual(descriptor.inputSchema.properties.action.enum, ['create', 'read', 'review']);
  assert.equal(await tool.callTool('other_tool', {}), undefined);
  await assert.rejects(tool.callTool('creative_brief', {}), code(-32602));
});

test('create pins the source, verifies the claim quote and returns the full brief', async () => {
  const { brief, source } = await setup();
  assert.equal(brief.kind, 'creative-brief');
  assert.equal(brief.path, 'creative/简报/brief-0001.json');
  assert.equal(brief.revision, 1);
  assert.equal(brief.status, 'draft');
  assert.match(brief.sha256, /^[0-9a-f]{64}$/);
  assert.equal(brief.authorship, 'agent');
  assert.equal(brief.sourceRefs[0].libraryId, source.id);
  assert.equal(brief.sourceRefs[0].evidenceStatus, 'current');
  assert.equal(brief.claims[0].id, 'k1');
  assert.equal(brief.claims[0].evidence.version, source.sha256);
  assert.equal(brief.claims[0].evidence.quote, '第一段原文');
  assert.equal(brief.learningNote, undefined);
  assert.deepEqual(brief.reviews, []);
});

test('create is idempotent per requestId and rejects a different payload', async () => {
  const { tool, params, brief } = await setup();
  const again = await tool.callTool('creative_brief', params);
  assert.equal(again.duplicate, true);
  assert.equal(again.sha256, brief.sha256);
  assert.equal(again.revision, 1);
  await assert.rejects(tool.callTool('creative_brief', { ...params, title: '换了个标题' }), code(-32602));
});

test('create rejects evidence whose quote or line does not match the source', async () => {
  const { tool, params, source } = await setup();
  const claim = (evidence, requestId) => ({ ...params, requestId, claims: [{ id: 'k1', text: '要点', evidence }] });
  await assert.rejects(tool.callTool('creative_brief', claim({ libraryId: source.id, line: 3, quote: '并不存在的引用' }, 'brief-bad1')), /引用内容/);
  await assert.rejects(tool.callTool('creative_brief', claim({ libraryId: source.id, line: 1, quote: '第一段原文' }, 'brief-bad2')), /引用内容/);
  await assert.rejects(tool.callTool('creative_brief', claim({ libraryId: 'ghost', line: 3, quote: '第一段原文' }, 'brief-bad3')), code(-32602));
});

test('create enforces required boundaries without silent truncation', async () => {
  const { tool, params } = await setup();
  await assert.rejects(tool.callTool('creative_brief', { ...params, requestId: 'brief-e1', sourceRefs: [] }), /sourceRefs/);
  await assert.rejects(tool.callTool('creative_brief', { ...params, requestId: 'brief-e2', sourceRefs: Array.from({ length: 11 }, (unused, index) => ({ id: `s-${index}` })) }), /最多 10/);
  await assert.rejects(tool.callTool('creative_brief', { ...params, requestId: 'brief-e3', criteria: [] }), /criteria/);
  await assert.rejects(tool.callTool('creative_brief', { ...params, requestId: 'brief-e4', claims: [{ id: 'k1', text: 'a', evidence: params.claims[0].evidence }, { id: 'k1', text: 'b', evidence: params.claims[0].evidence }] }), /id 不能重复/);
  await assert.rejects(tool.callTool('creative_brief', { ...params, requestId: 'brief-e5', outline: [{ title: 'x', summary: 'y', claimIds: ['ghost'] }] }), /不存在的主张/);
  await assert.rejects(tool.callTool('creative_brief', { ...params, requestId: 'bad id!' }), /requestId/);
});

test('create only links to real learning artifacts and never claims mastery', async () => {
  const { lib, tool, params } = await setup();
  const lecture = await lib.put('learning/讲座/傅里叶.json', JSON.stringify({ kind: 'lecture', title: '傅里叶' }));
  const notes = await lib.put('资料/笔记.md', '普通笔记');
  const linked = await tool.callTool('creative_brief', { ...params, requestId: 'brief-L1', learningRefs: [{ id: lecture.id }] });
  assert.equal(linked.learningRefs[0].kind, 'lecture');
  assert.equal(linked.learningRefs[0].mastery, 'not-assessed');
  assert.equal(linked.learningNote, '关联学习资料不等于已掌握');
  await assert.rejects(tool.callTool('creative_brief', { ...params, requestId: 'brief-L2', learningRefs: [{ id: notes.id }] }), /不是真实学习成果|找不到引用的学习资料/);
  await assert.rejects(tool.callTool('creative_brief', { ...params, requestId: 'brief-L3', learningRefs: [{ id: 'ghost' }] }), code(-32004));
});

test('read re-checks source pins so a changed source shows as superseded', async () => {
  const { lib, tool, briefPath, source } = await setup();
  const before = await tool.callTool('creative_brief', { action: 'read', path: briefPath });
  assert.equal(before.sourceRefs[0].evidenceStatus, 'current');
  await lib.update(source.path, '# 报告\n\n第一段原文已更新\n第二段原文\n', source.sha256);
  const after = await tool.callTool('creative_brief', { action: 'read', path: briefPath });
  assert.equal(after.sourceRefs[0].evidenceStatus, 'superseded');
  assert.equal(after.claims[0].evidence.version, source.sha256, 'the pinned old version is retained');
  await assert.rejects(tool.callTool('creative_brief', { action: 'read', path: 'other/x.json' }), code(-32602));
});

test('review rejects missing, empty, self-referential and source outputs', async () => {
  const { lib, tool, briefPath, source, output } = await setup();
  const evaluations = [onePass('c1')];
  await assert.rejects(tool.callTool('creative_brief', reviewParams(briefPath, output.id, evaluations, { reviewId: 'rev-miss', outputRefs: [{ id: 'ghost' }] })), code(-32004));
  const empty = await lib.put('创作/空.md', '');
  await assert.rejects(tool.callTool('creative_brief', reviewParams(briefPath, output.id, evaluations, { reviewId: 'rev-empty', outputRefs: [{ id: empty.id }] })), /空文件/);
  const briefId = lib.files.get(briefPath).id;
  await assert.rejects(tool.callTool('creative_brief', reviewParams(briefPath, output.id, evaluations, { reviewId: 'rev-self', outputRefs: [{ id: briefId }] })), /简报自身/);
  await assert.rejects(tool.callTool('creative_brief', reviewParams(briefPath, output.id, evaluations, { reviewId: 'rev-src', outputRefs: [{ id: source.id }] })), /来源/);
});

test('review evaluations must cover every criterion exactly once with valid outcomes', async () => {
  const { tool, briefPath, output } = await setup({ criteria: [{ id: 'c1', description: 'a' }, { id: 'c2', description: 'b' }] });
  const base = reviewParams(briefPath, output.id, []);
  await assert.rejects(tool.callTool('creative_brief', { ...base, reviewId: 'r1', evaluations: [onePass('c1')] }), /覆盖/);
  await assert.rejects(tool.callTool('creative_brief', { ...base, reviewId: 'r2', evaluations: [onePass('c1'), onePass('c1')] }), /重复/);
  await assert.rejects(tool.callTool('creative_brief', { ...base, reviewId: 'r3', evaluations: [onePass('c1'), onePass('cx')] }), /未知验收项/);
  await assert.rejects(tool.callTool('creative_brief', { ...base, reviewId: 'r4', evaluations: [{ criterionId: 'c1', outcome: 'maybe', note: 'x' }, onePass('c2')] }), /outcome/);
  await assert.rejects(tool.callTool('creative_brief', { ...base, reviewId: 'r5', evaluations: [{ criterionId: 'c1', outcome: 'pass' }, onePass('c2')] }), /note/);
  await assert.rejects(tool.callTool('creative_brief', { ...base, reviewId: 'r6', reviewer: undefined, evaluations: [onePass('c1'), onePass('c2')] }), /reviewer/);
  await assert.rejects(tool.callTool('creative_brief', { ...base, reviewId: 'r7', evaluations: [onePass('c1'), { criterionId: 'c2', outcome: 'pass', note: 'x', outputId: 'ghost' }] }), /不在本次成果/);
});

test('partial review stays revision-needed; a full pass becomes ready and survives a re-read', async () => {
  const { tool, briefPath, output } = await setup({ criteria: [{ id: 'c1', description: 'a' }, { id: 'c2', description: 'b' }] });
  const partial = await tool.callTool('creative_brief', reviewParams(briefPath, output.id, [onePass('c1'), { criterionId: 'c2', outcome: 'needs-work', note: '还需补' }], { reviewId: 'rv-p', reviewer: 'user' }));
  assert.equal(partial.status, 'revision-needed');
  assert.equal(partial.reviews.at(-1).reviewer, 'user');
  const full = await tool.callTool('creative_brief', reviewParams(briefPath, output.id, [onePass('c1'), onePass('c2')], { reviewId: 'rv-f' }));
  assert.equal(full.status, 'ready');
  assert.equal(full.reviews.length, 2);
  const reread = await tool.callTool('creative_brief', { action: 'read', path: briefPath });
  assert.equal(reread.status, 'ready');
  assert.equal(reread.reviews.at(-1).effectiveStatus, 'ready');
});

test('a reviewId retried with the same payload is not appended twice; a different payload is rejected', async () => {
  const { tool, briefPath, output } = await setup();
  const payload = reviewParams(briefPath, output.id, [onePass('c1')], { reviewId: 'rev-idem' });
  const first = await tool.callTool('creative_brief', payload);
  assert.equal(first.status, 'ready');
  assert.equal(first.reviews.length, 1);
  const second = await tool.callTool('creative_brief', payload);
  assert.equal(second.duplicate, true);
  assert.equal(second.reviews.length, 1);
  await assert.rejects(tool.callTool('creative_brief', { ...payload, evaluations: [{ criterionId: 'c1', outcome: 'needs-work', note: '改了' }] }), code(-32602));
});

test('read re-checks output currency and never keeps ready after a change or deletion', async () => {
  const { lib, tool, briefPath, output } = await setup();
  await tool.callTool('creative_brief', reviewParams(briefPath, output.id, [onePass('c1')], { reviewId: 'rev-cur' }));
  await lib.update(output.path, '成稿的第二版内容', output.sha256);
  const superseded = await tool.callTool('creative_brief', { action: 'read', path: briefPath });
  assert.equal(superseded.reviews[0].outputRefs[0].status, 'superseded');
  assert.equal(superseded.reviews[0].effectiveStatus, 'needs-review');
  assert.equal(superseded.status, 'needs-review');
  lib.trash(output.path);
  const missing = await tool.callTool('creative_brief', { action: 'read', path: briefPath });
  assert.equal(missing.reviews[0].outputRefs[0].status, 'missing');
  assert.equal(missing.status, 'needs-review');
});

test('concurrent reviews use CAS without losing either write', async () => {
  const { tool, briefPath, output } = await setup();
  const make = reviewId => reviewParams(briefPath, output.id, [onePass('c1')], { reviewId });
  await Promise.all([tool.callTool('creative_brief', make('rev-a')), tool.callTool('creative_brief', make('rev-b'))]);
  const read = await tool.callTool('creative_brief', { action: 'read', path: briefPath });
  assert.equal(read.reviews.length, 2);
  assert.deepEqual(read.reviews.map(item => item.reviewId).sort(), ['rev-a', 'rev-b']);
});

test('a failed persist never reports a completed review', async () => {
  const { lib, tool, briefPath, output } = await setup();
  const original = lib.handlers['library/write'];
  lib.handlers['library/write'] = async () => { throw new Error('disk full'); };
  await assert.rejects(tool.callTool('creative_brief', reviewParams(briefPath, output.id, [onePass('c1')], { reviewId: 'rev-fail' })), /disk full/);
  lib.handlers['library/write'] = original;
  const read = await tool.callTool('creative_brief', { action: 'read', path: briefPath });
  assert.equal(read.reviews.length, 0);
  assert.equal(read.status, 'draft');
});

test('replaying creation preserves the effective reviewed status and source changes require review', async () => {
  const { lib, tool, source, output, params, briefPath } = await setup();
  await tool.callTool('creative_brief', reviewParams(briefPath, output.id, [onePass('c1')]));
  assert.equal((await tool.callTool('creative_brief', params)).status, 'ready');
  await lib.update(source.path, '# 来源更新\n新的依据', source.sha256);
  const current = await tool.callTool('creative_brief', { action: 'read', path: briefPath });
  assert.equal(current.status, 'needs-review');
  assert.equal(current.sourceRefs[0].evidenceStatus, 'superseded');
});

test('blank text is not a deliverable and review history is retained at capacity', async () => {
  const { lib, tool, output, briefPath } = await setup();
  const blank = await lib.put('创作/blank.md', ' \r\n\t');
  await assert.rejects(tool.callTool('creative_brief', reviewParams(briefPath, blank.id, [onePass('c1')])), /空文件/);
  const first = await tool.callTool('creative_brief', reviewParams(briefPath, output.id, [onePass('c1')]));
  const entry = lib.files.get(briefPath);
  const saved = JSON.parse(entry.versions.at(-1).bytes.toString());
  saved.reviews = Array.from({ length: 100 }, (_, index) => ({ ...saved.reviews[0], reviewId: `history-${index}` }));
  await lib.update(briefPath, JSON.stringify(saved), first.sha256);
  await assert.rejects(tool.callTool('creative_brief', reviewParams(briefPath, output.id, [onePass('c1')], { reviewId: 'new-review' })), /100 条/);
  assert.equal((await tool.callTool('creative_brief', { action: 'read', path: briefPath })).reviews.length, 100);
});
