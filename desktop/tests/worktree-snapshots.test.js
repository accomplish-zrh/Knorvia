'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createWorktreeSnapshots, capture } = require('../worktree-snapshots');
const git = (cwd, args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-C', cwd, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-worktree-copy-')), repo = path.join(home, 'source'); fs.mkdirSync(repo);
  git(repo, ['init', '-q']); git(repo, ['config', 'user.name', 'Local fixture']); git(repo, ['config', 'user.email', 'fixture@example.invalid']); git(repo, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n'); fs.writeFileSync(path.join(repo, 'remove.txt'), 'remove later\n'); fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base']);
  const workspaces = new Map([['source', repo]]); let creations = 0;
  const rpc = async (method, p) => {
    if (method === 'workspace/path/resolve') { const cwd = workspaces.get(p.workspaceId); return { workspace: { id: p.workspaceId, cwd }, absolutePath: cwd, kind: 'directory' }; }
    if (method === 'workspace/worktree/create') { creations++; const id = randomUUID(), cwd = path.join(home, 'worktrees', id); git(repo, ['worktree', 'add', '-b', p.branch, cwd, p.baseRef]); workspaces.set(id, cwd); return { id, title: p.branch, cwd }; }
    throw Error(`Unexpected RPC ${method}`);
  };
  const manager = createWorktreeSnapshots({ home, rpc }), call = (method, p = {}) => manager.handlers[method]({ workspaceId: 'source', ...p });
  return { home, repo, workspaces, manager, call, creations: () => creations };
}
test('dirty snapshot preserves staged and unstaged changes, binary untracked files and the source index', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, 'tracked.txt'), 'staged\n'); git(f.repo, ['add', 'tracked.txt']); fs.appendFileSync(path.join(f.repo, 'tracked.txt'), 'unstaged\n');
  fs.unlinkSync(path.join(f.repo, 'remove.txt')); fs.mkdirSync(path.join(f.repo, 'new folder')); fs.writeFileSync(path.join(f.repo, 'new folder/图片.bin'), Buffer.from([0, 127, 255]));
  fs.mkdirSync(path.join(f.repo, 'ignored')); fs.writeFileSync(path.join(f.repo, 'ignored/private.txt'), 'ignored stays in source');
  const before = await capture(f.repo), inspected = await f.call('worktree/snapshot/inspect'); assert.equal(inspected.untrackedFiles, 1);
  const result = await f.call('worktree/snapshot/create', { snapshotId: inspected.snapshotId, branch: 'fixture/copy' }); assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.sourceUnchanged, true); assert.equal(fs.readFileSync(path.join(result.workspace.cwd, 'tracked.txt'), 'utf8'), 'staged\nunstaged\n');
  assert.equal(git(result.workspace.cwd, ['show', ':tracked.txt']).toString(), 'staged\n'); assert.equal(fs.existsSync(path.join(result.workspace.cwd, 'remove.txt')), false); assert.deepEqual(fs.readFileSync(path.join(result.workspace.cwd, 'new folder/图片.bin')), Buffer.from([0, 127, 255]));
  assert.equal(fs.existsSync(path.join(result.workspace.cwd, 'ignored')), false); assert.equal((await capture(f.repo)).fingerprint, before.fingerprint);
  assert.deepEqual(await f.call('worktree/snapshot/create', { snapshotId: inspected.snapshotId, branch: 'fixture/copy' }), result); assert.equal(f.creations(), 1);
});
test('changed source and foreign workspace snapshots stop before creating a worktree', async () => {
  const f = fixture(), inspected = await f.call('worktree/snapshot/inspect'); fs.writeFileSync(path.join(f.repo, 'tracked.txt'), 'later edit\n');
  await assert.rejects(f.call('worktree/snapshot/create', { snapshotId: inspected.snapshotId, branch: 'fixture/stale' }), e => e.rpc.code === -32005); assert.equal(f.creations(), 0);
  await assert.rejects(f.call('worktree/snapshot/create', { workspaceId: 'foreign', snapshotId: inspected.snapshotId, branch: 'fixture/foreign' }), e => e.rpc.code === -32088);
});
test('merge conflicts and oversized untracked files are refused', async () => {
  const f = fixture(); git(f.repo, ['checkout', '-qb', 'fixture/conflict']); fs.writeFileSync(path.join(f.repo, 'tracked.txt'), 'other side\n'); git(f.repo, ['commit', '-qam', 'other']);
  git(f.repo, ['checkout', '-q', '-']); fs.writeFileSync(path.join(f.repo, 'tracked.txt'), 'this side\n'); git(f.repo, ['commit', '-qam', 'this']);
  assert.throws(() => git(f.repo, ['merge', 'fixture/conflict'])); await assert.rejects(f.call('worktree/snapshot/inspect'), e => e.rpc.code === -32005);
  const large = fixture(); fs.writeFileSync(path.join(large.repo, 'large.bin'), ''); fs.truncateSync(path.join(large.repo, 'large.bin'), 17 * 1024 * 1024); await assert.rejects(large.call('worktree/snapshot/inspect'), e => e.rpc.code === -32082);
});
test('an interrupted creation cannot silently duplicate a branch', async () => {
  const f = fixture(), inspected = await f.call('worktree/snapshot/inspect'), file = path.join(f.home, 'worktree-snapshots', inspected.snapshotId, 'snapshot.json');
  const record = JSON.parse(fs.readFileSync(file)); record.state = 'creating'; record.branch = 'fixture/interrupted'; fs.writeFileSync(file, JSON.stringify(record));
  await assert.rejects(f.call('worktree/snapshot/create', { snapshotId: inspected.snapshotId, branch: 'fixture/interrupted' }), e => e.rpc.code === -32005); assert.equal(f.creations(), 0);
});

test('hidden index flags and submodule entries cannot silently omit local work from a snapshot', async () => {
  const f = fixture(); git(f.repo, ['update-index', '--assume-unchanged', 'tracked.txt']); fs.writeFileSync(path.join(f.repo, 'tracked.txt'), 'hidden edit\n');
  await assert.rejects(f.call('worktree/snapshot/inspect'), e => /hide local edits/.test(e.rpc.message)); assert.equal(f.creations(), 0);
  git(f.repo, ['update-index', '--no-assume-unchanged', 'tracked.txt']); git(f.repo, ['update-index', '--skip-worktree', 'tracked.txt']);
  await assert.rejects(f.call('worktree/snapshot/inspect'), e => /hide local edits/.test(e.rpc.message));
  git(f.repo, ['update-index', '--no-skip-worktree', 'tracked.txt']);
  const head = git(f.repo, ['rev-parse', 'HEAD']).toString().trim(); git(f.repo, ['update-index', '--add', '--cacheinfo', `160000,${head},nested-submodule`]);
  await assert.rejects(f.call('worktree/snapshot/inspect'), e => /Submodules require/.test(e.rpc.message)); assert.equal(f.creations(), 0);
});

test('low-space preflight refuses both checkout and snapshot before Git creation or snapshot writes', async () => {
  const f = fixture(); let forwarded = 0;
  const rpc = async (method, p) => {
    if (method === 'workspace/path/resolve') return { workspace: { id: p.workspaceId, cwd: f.repo }, absolutePath: f.repo, kind: 'directory' };
    if (method === 'workspace/worktree/create') { forwarded++; return {}; }
    throw Error(method);
  };
  const manager = createWorktreeSnapshots({ home: f.home, rpc, statfs: () => ({ bavail: 1, bsize: 4096 }) });
  const before = await capture(f.repo);
  await assert.rejects(manager.handlers['workspace/worktree/create']({ workspaceId: 'source', branch: 'fixture/no-space' }), e => e.rpc.code === -32082);
  await assert.rejects(manager.handlers['worktree/snapshot/inspect']({ workspaceId: 'source' }), e => e.rpc.code === -32082);
  assert.equal(forwarded, 0); assert.deepEqual(fs.readdirSync(path.join(f.home, 'worktree-snapshots')), []);
  assert.equal((await capture(f.repo)).fingerprint, before.fingerprint);
  const healthy = createWorktreeSnapshots({ home: f.home, rpc, statfs: () => ({ bavail: 1048576, bsize: 4096 }) });
  const report = await healthy.handlers['workspace/worktree/preflight']({ workspaceId: 'source' }); assert.equal(report.estimated, true); assert.ok(report.checkoutBytes > 0);
  await healthy.handlers['workspace/worktree/create']({ workspaceId: 'source', branch: 'fixture/space' }); assert.equal(forwarded, 1);
});
test('discard removes only a verified snapshot and preserves source and created worktree', async () => {
  const f = fixture(), inspected = await f.call('worktree/snapshot/inspect');
  const result = await f.call('worktree/snapshot/create', { snapshotId: inspected.snapshotId, branch: 'fixture/retained' }); assert.equal(result.status, 'completed');
  assert.equal((await f.call('worktree/snapshot/list')).snapshots.length, 1);
  const dir = path.join(f.home, 'worktree-snapshots', inspected.snapshotId); fs.writeFileSync(path.join(dir, 'user-added.txt'), 'preserve');
  await assert.rejects(f.call('worktree/snapshot/discard', { snapshotId: inspected.snapshotId })); assert.equal(fs.readFileSync(path.join(dir, 'user-added.txt'), 'utf8'), 'preserve');
  fs.unlinkSync(path.join(dir, 'user-added.txt')); await f.call('worktree/snapshot/discard', { snapshotId: inspected.snapshotId });
  assert.equal(fs.existsSync(dir), false); assert.equal(fs.existsSync(result.workspace.cwd), true); assert.equal(fs.existsSync(f.repo), true);
});
