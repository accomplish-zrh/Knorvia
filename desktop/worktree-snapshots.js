'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const { connectionError } = require('./connection-config');
const { verifyResolvedPath } = require('./desktop-path-actions');
const { relative } = require('./extension-files');
const execute = promisify(execFile), MAX_BYTES = 64 * 1024 * 1024;
const METHODS = ['workspace/worktree/preflight', 'workspace/worktree/create', 'worktree/snapshot/list', 'worktree/snapshot/discard', 'worktree/snapshot/inspect', 'worktree/snapshot/create'];
const fail = (code, message) => { throw connectionError(code, message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const idValid = id => typeof id === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/.test(id);
function atomic(file, value) { const temp = `${file}.${randomUUID()}.tmp`; try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); } }
async function git(cwd, args, { read = true, maximum = 16 * 1024 * 1024 } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }; if (read) env.GIT_OPTIONAL_LOCKS = '0';
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  try { return (await execute('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', cwd, ...args], { env, windowsHide: true, timeout: 30000, maxBuffer: maximum, encoding: 'buffer' })).stdout; }
  catch { fail(-32096, 'Git could not complete the worktree operation. Check the repository state and retry'); }
}
function fileWithin(root, name) {
  const rel = relative(name), target = path.join(root, ...rel.split('/'));
  let walk = root;
  for (const segment of rel.split('/')) { walk = path.join(walk, segment); if (fs.lstatSync(walk).isSymbolicLink()) fail(-32088, 'Linked files cannot be copied into a worktree snapshot'); }
  const canonical = fs.realpathSync(target), fromRoot = path.relative(root, canonical);
  if (!fromRoot || fromRoot.startsWith(`..${path.sep}`) || fromRoot === '..' || path.isAbsolute(fromRoot)) fail(-32088, 'Snapshot file escaped the project');
  return target;
}
async function capture(root) {
  const repository = fs.realpathSync((await git(root, ['rev-parse', '--show-toplevel'])).toString().trim());
  if (repository !== root) fail(-32088, 'Open the repository root project to copy uncommitted changes');
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).toString().trim();
  if (!/^[a-f\d]{40,64}$/.test(head)) fail(-32096, 'A committed starting revision is required');
  if ((await git(root, ['ls-files', '--unmerged', '-z'])).length) fail(-32005, 'Resolve merge conflicts before copying a worktree');
  const flags = (await git(root, ['ls-files', '-v', '-z'])).toString().split('\0').filter(Boolean);
  if (flags.some(entry => /^[a-zS] /.test(entry))) fail(-32005, 'Remove assume-unchanged and skip-worktree flags before copying; they may hide local edits');
  if ((await git(root, ['ls-files', '--stage', '-z'])).toString().split('\0').some(entry => entry.startsWith('160000 '))) fail(-32005, 'Submodules require separate snapshots; this copy cannot preserve their working directories');
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const staged = await git(root, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.']);
  const unstaged = await git(root, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--', '.']);
  const names = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).toString('utf8').split('\0').filter(Boolean);
  if (names.length > 2000) fail(-32082, 'Snapshot has more than 2,000 untracked files');
  let bytes = staged.length + unstaged.length;
  const untracked = names.map(name => {
    const source = fileWithin(root, name), stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || (bytes += stat.size) > MAX_BYTES) fail(-32082, 'Worktree snapshot exceeds its file or 64 MB total limit');
    return { name, size: stat.size, sha256: hash(fs.readFileSync(source)) };
  });
  const indexName = (await git(root, ['rev-parse', '--git-path', 'index'])).toString().trim();
  const indexHash = hash(fs.readFileSync(path.resolve(root, indexName)));
  const summary = { head, stagedHash: hash(staged), unstagedHash: hash(unstaged), statusHash: hash(status), indexHash, untracked };
  return { ...summary, fingerprint: hash(JSON.stringify(summary)), staged, unstaged, bytes, changedFiles: status.toString().split('\0').filter(line => /^[ MADRCU?!]{2} /.test(line)).length };
}
function createWorktreeSnapshots({ home, rpc, statfs = fs.statfsSync }) {
  if (!path.isAbsolute(home || '') || typeof rpc !== 'function') throw new Error('Worktree snapshots require application Home and RPC');
  const root = path.join(home, 'worktree-snapshots'); fs.mkdirSync(root, { recursive: true });
  let queue = Promise.resolve();
  const serial = work => { const next = queue.then(work); queue = next.catch(() => {}); return next; };
  const scopeFor = p => ({ workspaceId: p.workspaceId, ...(p.threadId ? { threadId: p.threadId } : {}), path: '' });
  const resolve = async scope => { const value = verifyResolvedPath(await rpc('workspace/path/resolve', scope), scope); if (value.kind !== 'directory') fail(-32602, 'Select a project directory'); return value.target; };
  const checkSpace = required => {
    let available;
    try { const info = statfs(home); available = Number(BigInt(info.bavail) * BigInt(info.bsize)); }
    catch { fail(-32082, 'Cannot check free space in the application data folder'); }
    if (!Number.isSafeInteger(available) || available < required) fail(-32082, `Not enough free space for this worktree. At least ${Math.ceil(required / 1048576)} MB is required`);
    return available;
  };
  const preflight = async (p, extraBytes = 0) => {
    const source = await resolve(scopeFor(p)), baseRef = p.baseRef || 'HEAD';
    if (typeof baseRef !== 'string' || baseRef.length > 256 || baseRef.startsWith('-') || /[\r\n\0]/.test(baseRef)) fail(-32602, 'Choose a valid starting revision');
    const commit = (await git(source, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])).toString().trim();
    const rows = (await git(source, ['ls-tree', '--full-tree', '-r', '-l', '-z', commit])).toString().split('\0').filter(Boolean);
    let checkoutBytes = 0;
    for (const row of rows) { const match = /^\d+\s+\S+\s+[a-f\d]+\s+(\d+|-)\t/.exec(row); if (!match) fail(-32096, 'Cannot estimate the new worktree size'); if (match[1] !== '-') checkoutBytes += Number(match[1]); }
    const requiredBytes = Math.ceil(checkoutBytes * 1.2) + rows.length * 8192 + extraBytes * 2 + 32 * 1024 * 1024;
    if (!Number.isSafeInteger(requiredBytes)) fail(-32082, 'This repository is too large for a bounded worktree estimate');
    return { baseCommit: commit, checkoutBytes, requiredBytes, availableBytes: checkSpace(requiredBytes), estimated: true };
  };
  const publicSnapshot = record => ({ snapshotId: record.id, head: record.head, changedFiles: record.changedFiles, untrackedFiles: record.untracked.length, bytes: record.bytes, expiresAt: record.expiresAt, ignoredFilesIncluded: false });
  const clearIncomplete = dir => {
    const owner = fs.realpathSync(root), target = fs.realpathSync(dir);
    if (!target.startsWith(`${owner}${path.sep}`) || fs.lstatSync(dir).isSymbolicLink()) return;
    const check = folder => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const child = path.join(folder, entry.name); if (fs.lstatSync(child).isSymbolicLink()) fail(-32088, 'Incomplete snapshot has linked files and was preserved'); if (entry.isDirectory()) check(child); } };
    check(target); fs.rmSync(target, { recursive: true });
  };
  const handlers = {
    'workspace/worktree/preflight': p => serial(() => preflight(p)),
    'workspace/worktree/create': p => serial(async () => { const checked = await preflight(p); return rpc('workspace/worktree/create', { ...p, baseRef: checked.baseCommit }); }),
    'worktree/snapshot/list': p => serial(async () => {
      await resolve(scopeFor(p)); const snapshots = [];
      for (const id of fs.readdirSync(root).filter(idValid)) {
        try { const record = JSON.parse(fs.readFileSync(path.join(root, id, 'snapshot.json'), 'utf8')); if (record.version === 1 && record.id === id && record.scope.workspaceId === p.workspaceId) snapshots.push({ ...publicSnapshot(record), state: record.state, branch: record.branch || '', result: record.result || null }); } catch {}
      }
      return { snapshots };
    }),
    'worktree/snapshot/discard': p => serial(async () => {
      if (!idValid(p.snapshotId)) fail(-32602, 'Choose a snapshot');
      const dir = path.join(root, p.snapshotId), canonicalRoot = fs.realpathSync(root), canonical = fs.realpathSync(dir);
      if (!canonical.startsWith(`${canonicalRoot}${path.sep}`) || fs.lstatSync(dir).isSymbolicLink()) fail(-32088, 'Snapshot escaped managed storage');
      const record = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
      if (record.version !== 1 || record.id !== p.snapshotId || record.scope.workspaceId !== p.workspaceId || !['completed', 'inspected'].includes(record.state)) fail(-32005, 'Only inspected or completed snapshots from this project can be discarded');
      const expected = new Map([['snapshot.json', null], ['staged.patch', record.stagedHash], ['unstaged.patch', record.unstagedHash], ...record.untracked.map(entry => [`untracked/${relative(entry.name)}`, entry.sha256])]);
      const check = (folder, prefix = '') => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const name = prefix ? `${prefix}/${entry.name}` : entry.name, target = path.join(folder, entry.name), stat = fs.lstatSync(target); if (stat.isSymbolicLink()) fail(-32088, 'Linked snapshot files are protected'); if (stat.isDirectory()) check(target, name); else if (!expected.has(name) || (expected.get(name) && hash(fs.readFileSync(target)) !== expected.get(name))) fail(-32005, 'Snapshot has local edits; preserve them before discarding it'); } };
      check(dir); fs.rmSync(canonical, { recursive: true }); return { discarded: true, sourceRetained: true, worktreeRetained: true };
    }),
    'worktree/snapshot/inspect': p => serial(async () => {
      if (fs.readdirSync(root).filter(idValid).length >= 20) fail(-32082, 'Twenty worktree snapshots are already retained; discard completed snapshots before adding more');
      const scope = scopeFor(p), source = await resolve(scope), captured = await capture(source), id = randomUUID(), dir = path.join(root, id);
      checkSpace(captured.bytes + 32 * 1024 * 1024);
      try {
      fs.mkdirSync(path.join(dir, 'untracked'), { recursive: true }); fs.writeFileSync(path.join(dir, 'staged.patch'), captured.staged); fs.writeFileSync(path.join(dir, 'unstaged.patch'), captured.unstaged);
      for (const entry of captured.untracked) { const destination = path.join(dir, 'untracked', ...relative(entry.name).split('/')); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(fileWithin(source, entry.name), destination, fs.constants.COPYFILE_EXCL); if (hash(fs.readFileSync(destination)) !== entry.sha256) fail(-32005, 'Source files changed while making the snapshot'); }
      const verified = await capture(source); if (verified.fingerprint !== captured.fingerprint) fail(-32005, 'Project changed while preparing the snapshot; inspect again');
      const { staged, unstaged, ...metadata } = captured;
      const record = { version: 1, id, state: 'inspected', scope, source, ...metadata, expiresAt: new Date(Date.now() + 3600000).toISOString() };
      atomic(path.join(dir, 'snapshot.json'), record); return publicSnapshot(record);
      } catch (error) { if (fs.existsSync(dir)) clearIncomplete(dir); throw error; }
    }),
    'worktree/snapshot/create': p => serial(async () => {
      if (!idValid(p.snapshotId) || typeof p.branch !== 'string' || !p.branch.trim()) fail(-32602, 'Choose a snapshot and a new branch');
      const dir = path.join(root, p.snapshotId), file = path.join(dir, 'snapshot.json'), record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (record.version !== 1 || record.id !== p.snapshotId || record.scope.workspaceId !== p.workspaceId || (record.scope.threadId || '') !== (p.threadId || '')) fail(-32088, 'Snapshot belongs to another project');
      if (record.state !== 'inspected') { if (record.branch === p.branch && record.result) return record.result; fail(-32005, 'This snapshot has an unfinished creation; inspect its retained worktree before retrying'); }
      if (new Date(record.expiresAt).getTime() < Date.now()) fail(-32005, 'Snapshot expired; inspect the current project again');
      const source = await resolve(record.scope); if (source !== record.source || (await capture(source)).fingerprint !== record.fingerprint) fail(-32005, 'The source project changed after inspection; create a fresh snapshot');
      const staged = fs.readFileSync(path.join(dir, 'staged.patch')), unstaged = fs.readFileSync(path.join(dir, 'unstaged.patch'));
      if (hash(staged) !== record.stagedHash || hash(unstaged) !== record.unstagedHash) fail(-32005, 'Snapshot files changed; create a fresh snapshot');
      for (const entry of record.untracked) { if (hash(fs.readFileSync(fileWithin(path.join(dir, 'untracked'), entry.name))) !== entry.sha256) fail(-32005, 'Snapshot file changed'); }
      await preflight({ ...record.scope, baseRef: record.head }, record.bytes);
      record.state = 'creating'; record.branch = p.branch; atomic(file, record);
      let workspace;
      try {
        workspace = await rpc('workspace/worktree/create', { ...record.scope, path: undefined, branch: p.branch, baseRef: record.head });
        record.workspace = workspace; atomic(file, record);
        const target = await resolve({ workspaceId: workspace.id, path: '' });
        if ((await git(target, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length) fail(-32005, 'New worktree is not clean; copying stopped');
        if (staged.length) { await git(target, ['apply', '--check', '--index', path.join(dir, 'staged.patch')], { read: false }); await git(target, ['apply', '--index', path.join(dir, 'staged.patch')], { read: false }); }
        if (unstaged.length) { await git(target, ['apply', '--check', path.join(dir, 'unstaged.patch')], { read: false }); await git(target, ['apply', path.join(dir, 'unstaged.patch')], { read: false }); }
        for (const entry of record.untracked) {
          const destination = path.join(target, ...relative(entry.name).split('/')); fs.mkdirSync(path.dirname(destination), { recursive: true });
          const parent = fs.realpathSync(path.dirname(destination)); if (parent !== target && !parent.startsWith(`${target}${path.sep}`)) fail(-32088, 'New worktree path escaped its root');
          fs.copyFileSync(fileWithin(path.join(dir, 'untracked'), entry.name), destination, fs.constants.COPYFILE_EXCL);
        }
        const copied = await capture(target), after = await capture(source);
        if (copied.stagedHash !== record.stagedHash || copied.unstagedHash !== record.unstagedHash || JSON.stringify(copied.untracked) !== JSON.stringify(record.untracked) || after.fingerprint !== record.fingerprint) fail(-32005, 'Source or target changed during copying; inspect the preserved snapshot and worktree');
        record.state = 'completed'; record.result = { status: 'completed', workspace, snapshotId: record.id, sourceUnchanged: true }; atomic(file, record); return record.result;
      } catch (error) {
        record.state = 'needs-recovery'; record.result = { status: 'needs-recovery', workspace: workspace || null, snapshotId: record.id, error: error.rpc?.message || 'Worktree creation needs recovery. Original files and the snapshot are preserved' }; atomic(file, record); return record.result;
      }
    }),
  };
  return { handlers, async close() { await queue; } };
}
module.exports = { createWorktreeSnapshots, METHODS, capture };
