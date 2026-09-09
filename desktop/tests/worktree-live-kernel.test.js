'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { startKnorviaDaemon, initializeRequest } = require('../knorvia-protocol-client');
const { createWorktreeSnapshots, capture } = require('../worktree-snapshots');
const evidence = path.resolve(__dirname, '../../release/codex-integration-20260908/workspace');
const daemonBin = process.env.KNORVIA_DAEMON_BIN || 'D:/tools/knorvia-kernel/knorvia-rs/target/release/knorvia-daemon.exe';
const kernelBin = process.env.KNORVIA_KERNEL_BIN || 'D:/tools/knorvia-kernel/codex-rs/target/release/codex-app-server.exe';
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
test('real daemon creates a dirty-copy worktree and guarded removal preserves branch and task history', { timeout: 60000, skip: !fs.existsSync(daemonBin) || !fs.existsSync(kernelBin) }, async () => {
  fs.mkdirSync(evidence, { recursive: true }); const home = fs.mkdtempSync(path.join(evidence, 'worktree-')), repo = path.join(home, 'project'); fs.mkdirSync(repo);
  const fixtureBin = path.join(home, 'knorvia-daemon.exe'); fs.copyFileSync(daemonBin, fixtureBin);
  git(repo, ['init', '-q']); git(repo, ['config', 'user.name', 'Local worktree fixture']); git(repo, ['config', 'user.email', 'fixture@example.invalid']); git(repo, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, 'sample.txt'), 'base\n'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base']);
  fs.writeFileSync(path.join(repo, 'sample.txt'), 'staged\n'); git(repo, ['add', 'sample.txt']); fs.appendFileSync(path.join(repo, 'sample.txt'), 'unstaged\n'); fs.writeFileSync(path.join(repo, '新文件.bin'), Buffer.from([0, 64, 255]));
  const session = startKnorviaDaemon({ daemonBin: fixtureBin, home, env: { ...process.env, KNORVIA_KERNEL_BIN: kernelBin, KNORVIA_PROVIDER_BASE_URL: 'http://127.0.0.1:4899/v1', KNORVIA_PROVIDER_API_KEY: 'no-provider-called', KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1' }, requestTimeoutMs: 30000 });
  let seq = 0, diagnostics = ''; const observations = [];
  session.child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-12000); });
  const rpc = async (method, params = {}) => { const response = await session.request({ jsonrpc: '2.0', id: String(++seq), method, params }); observations.push({ method, response }); if (response.error) { const e = new Error(response.error.message); e.rpc = response.error; throw e; } return response.result; };
  const manager = createWorktreeSnapshots({ home, rpc });
  try {
    const init = await session.request(initializeRequest('worktree_fixture', '1')); assert.ok(!init.error); session.notify({ jsonrpc: '2.0', method: 'initialized' });
    const source = await rpc('workspace/create', { title: 'Source fixture', cwd: repo });
    const before = await capture(repo), inspected = await manager.handlers['worktree/snapshot/inspect']({ workspaceId: source.id });
    const result = await manager.handlers['worktree/snapshot/create']({ workspaceId: source.id, snapshotId: inspected.snapshotId, branch: 'fixture/carry-changes' }); assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal((await capture(repo)).fingerprint, before.fingerprint); assert.equal(git(result.workspace.cwd, ['show', ':sample.txt']).toString(), 'staged\n'); assert.deepEqual(fs.readFileSync(path.join(result.workspace.cwd, '新文件.bin')), Buffer.from([0, 64, 255]));
    const list = await rpc('workspace/worktree/list', { workspaceId: source.id }); const entry = list.worktrees.find(e => e.branch === 'refs/heads/fixture/carry-changes'); assert.equal(entry.managed, true);
    await assert.rejects(rpc('workspace/worktree/remove', { workspaceId: source.id, path: entry.path }), e => e.rpc.code === -32005);
    git(result.workspace.cwd, ['add', '.']); git(result.workspace.cwd, ['commit', '-qm', 'preserve copied work']);
    const thread = await rpc('thread/start', { workspaceId: result.workspace.id, title: 'Retained history', cwd: result.workspace.cwd });
    await rpc('workspace/worktree/lock', { workspaceId: source.id, path: entry.path, reason: 'fixture retained' });
    await assert.rejects(rpc('workspace/worktree/remove', { workspaceId: source.id, path: entry.path })); await rpc('workspace/worktree/unlock', { workspaceId: source.id, path: entry.path });
    const removed = await rpc('workspace/worktree/remove', { workspaceId: source.id, path: entry.path }); assert.equal(removed.removed, true); assert.equal(removed.branchRetained, true); assert.equal(fs.existsSync(result.workspace.cwd), false);
    assert.ok(git(repo, ['branch', '--list', 'fixture/carry-changes']).toString().includes('fixture/carry-changes'));
    const retained = await rpc('thread/read', { id: thread.id }); assert.ok(retained.thread?.id === thread.id || retained.id === thread.id);
    await assert.rejects(rpc('thread/start', { workspaceId: result.workspace.id, title: 'Must refuse', cwd: repo }), /worktree/i);
    await assert.rejects(rpc('turn/start', { threadId: thread.id, input: 'Do not run', cwd: repo, tools: { write: false } }), /worktree/i);
    await manager.handlers['worktree/snapshot/discard']({ workspaceId: source.id, snapshotId: inspected.snapshotId }); assert.equal(fs.readFileSync(path.join(repo, 'sample.txt'), 'utf8'), 'staged\nunstaged\n');
  } finally {
    fs.writeFileSync(path.join(evidence, 'worktree-live-result.json'), JSON.stringify({ home, fixtureBin, observations, diagnostics }, null, 2));
    await manager.close(); const closed = once(session.child, 'close'); session.child.stdin.end(); const timeout = setTimeout(() => session.child.kill(), 5000); await closed; clearTimeout(timeout);
  }
});
