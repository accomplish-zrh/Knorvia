'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPersonalLibrary } = require('../personal-library');
const { createDomainArtifacts, recordPath } = require('../domain-artifacts');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-domain-artifacts-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('knorvia-domain-artifacts-'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const library = createPersonalLibrary({ home });
  return { library, store: createDomainArtifacts(library) };
}

test('domain records use the real library versions and refuse a stale writer', async t => {
  const { library, store } = fixture(t);
  const first = await store.write('creative/简报/example.json', { kind: 'test', value: 1 });
  const second = await store.write(first.path, { ...first, value: 2 }, first.sha256);
  assert.equal(second.revision, 2);
  await assert.rejects(store.write(first.path, { ...first, value: 3 }, first.sha256), e => e.rpc?.code === -32005);
  assert.equal((await createDomainArtifacts(library).read(first.path, 'test')).value, 2);
  assert.equal((await library.handlers['library/versions']({ id: (await store.list())[0].id })).length, 2);
});

test('evidence is checked against the actual text and fixed version, including multiline quotes', async t => {
  const { library, store } = fixture(t);
  const source = await library.handlers['library/write']({ path: 'sources/lesson.md', text: '# 光\r\n光在真空中的传播速度是常数。\r\n测量有误差。\r\n' });
  const refs = await store.pinSources([{ id: source.id }]);
  const evidence = { libraryId: source.id, line: 2, quote: '光在真空中的传播速度是常数。\n测量有误差。' };
  assert.equal((await store.verifyEvidence(evidence, refs)).version, source.sha256);
  await assert.rejects(store.verifyEvidence({ ...evidence, line: 1 }, refs), /原文不符/);
  await assert.rejects(store.verifyEvidence({ ...evidence, quote: '没有写在原文里的事实' }, refs), /原文不符/);
  await library.handlers['library/write']({ path: source.path, text: '# 新版\n新的材料。', expectedSha256: source.sha256 });
  assert.equal((await store.currency(refs))[0].evidenceStatus, 'superseded');
  assert.equal((await store.verifyEvidence(evidence, refs)).version, source.sha256);
  await library.handlers['library/trash']({ path: source.path });
  assert.equal((await store.currency(refs))[0].evidenceStatus, 'missing');
  await assert.rejects(store.pinSources([{ id: source.id }]), /找不到/);
});

test('domain read refuses corrupted bytes, incorrect type and over-limit records', async t => {
  const { library, store } = fixture(t);
  const saved = await store.write('learning/test.json', { kind: 'study', value: 1 });
  await assert.rejects(store.read(saved.path, 'creative-brief'), /类型不匹配/);
  const realRead = library.handlers['library/read'];
  library.handlers['library/read'] = async p => ({ ...await realRead(p), base64: Buffer.from('tampered').toString('base64') });
  await assert.rejects(store.read(saved.path), /校验失败/);
  await assert.rejects(store.write('learning/huge.json', { body: '字'.repeat(1024 * 1024) }), /超过 2 MB/);
});

test('domain paths reject traversal and evidence pins reject duplicate sources', async t => {
  for (const candidate of ['learning/../private.json', 'learning//x.json', 'learning/./x.json', 'learning/x\\y.json']) assert.throws(() => recordPath(candidate, 'learning/'), /路径无效/);
  const { library, store } = fixture(t);
  const source = await library.handlers['library/write']({ path: 'sources/a.md', text: 'A' });
  await assert.rejects(store.pinSources([{ id: source.id }, { id: source.id }]), /重复/);
  await assert.rejects(store.pinSources([{ id: source.id, version: 'does-not-exist' }]), /版本不存在/);
});
