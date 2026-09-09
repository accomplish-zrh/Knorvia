'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspacePreview, MAX_PREVIEW_BYTES } = require('../workspace-preview');

test('project media preview reads exact bytes but rejects escapes and excessive files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-preview-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from([0, 128, 255, 10, 20]);
  fs.writeFileSync(path.join(root, 'image.png'), bytes);
  fs.writeFileSync(path.join(root, 'file.unknown'), bytes);
  const large = fs.openSync(path.join(root, 'large.pdf'), 'w'); fs.ftruncateSync(large, MAX_PREVIEW_BYTES + 1); fs.closeSync(large);
  const read = createWorkspacePreview({ rpc: async (method, params) => {
    assert.equal(method, 'workspace/path/resolve');
    return { workspace: { id: 'ws', cwd: root }, absolutePath: path.join(root, params.path), kind: 'file' };
  } })['preview/read'];
  const result = await read({ workspaceId: 'ws', path: 'image.png' });
  assert.equal(result.mime, 'image/png'); assert.deepEqual(Buffer.from(result.base64, 'base64'), bytes);
  assert.equal((await read({ workspaceId: 'ws', path: 'file.unknown' })).supported, false);
  const tooLarge = await read({ workspaceId: 'ws', path: 'large.pdf' }); assert.equal(tooLarge.tooLarge, true); assert.equal(tooLarge.base64, undefined);
  for (const escape of ['../secret.png', 'C:\\private.png', 'C:private.png']) await assert.rejects(read({ workspaceId: 'ws', path: escape }));
  await assert.rejects(read({ workspaceId: 'ws', path: 'image.png', arbitrary: true }));
  const wrong = createWorkspacePreview({ rpc: async () => ({ workspace: { id: 'other', cwd: root }, absolutePath: path.join(root, 'image.png'), kind: 'file' }) })['preview/read'];
  await assert.rejects(wrong({ workspaceId: 'ws', path: 'image.png' }));
});
