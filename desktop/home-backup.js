'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');

// Full offline Home backup and verified restore.
//
// Consistency contract: a Home contains SQLite databases, WAL sidecars,
// library indexes and extension catalogs. Copying while writers are running
// can produce an inconsistent set, so v1 exports ONLY after the desktop
// shell confirmed every writer has exited (main.js runs the export at the
// very end of stopServices) and the known cross-module lock files are gone.
// While the app is running, the settings surface shows the plan and waits
// for a safe shutdown instead of pretending a hot copy is a snapshot.
//
// Restore never touches the running Home: it verifies the whole backup
// first, then requires a brand-new, non-existing target directory. The
// override back into the app is explicit and only honours a directory that
// carries a restore receipt written by a verified restore.

const BACKUP_MANIFEST = 'backup.json';
const BACKUP_FILES = 'files.jsonl';
const RESTORE_RECEIPT_DIR = '.knorvia-backup';
const RESTORE_RECEIPT = 'restore.json';
const OVERRIDE_FILE = 'pending-home-override.json';
const OVERRIDE_VERSION = 1;

// Components that make up the durable user Home. Caches, staging areas,
// uploads-in-flight and lock files are excluded on purpose; encrypted
// connection settings are copied as opaque ciphertext and flagged.
const COMPONENTS = [
  { name: 'data', note: 'settings and encrypted credentials', requiresReloginOnOtherMachine: true },
  { name: 'personal-library', note: 'library files, version history, trash and catalog' },
  { name: 'state', note: 'durable native state, WAL, thread items, events and kernel store' },
  { name: 'extensions', note: 'extension catalog and retained packages' },
  { name: 'workspaces', note: 'task workspaces and project roots' },
  { name: 'artifacts', note: 'task artifacts' },
  { name: 'packs', note: 'installed capability packs' },
  { name: 'config', note: 'user configuration' },
  { name: 'settings', note: 'desktop media and studio preferences' },
  { name: 'worktree-snapshots', note: 'recoverable worktree patches and metadata' },
  { name: 'exports', note: 'user-created export packages' },
];

function fail(message, code = -32602) { const error = new Error(message); error.rpc = { code, message }; throw error; }
function abortError(message = '备份操作已被超时中止') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}
const sha256File = async (file, signal) => {
  if (signal?.aborted) throw abortError();
  const hash = createHash('sha256');
  const stream = fs.createReadStream(file);
  const onAbort = () => stream.destroy(abortError());
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw abortError();
      hash.update(chunk);
    }
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
  return hash.digest('hex');
};

async function copyFileAbortable(source, target, signal) {
  if (signal?.aborted) throw abortError();
  await pipeline(
    fs.createReadStream(source),
    fs.createWriteStream(target, { flags: 'wx' }),
    { signal },
  );
}

function componentFilter(relativePath) {
  const norm = relativePath.replaceAll('\\', '/');
  // User library names are data, even when they happen to end in .lock,
  // .tmp or '~'. Exclusions are limited to product-owned transient paths.
  if (/^personal-library\/files\//i.test(norm)) return true;
  if (/^personal-library\/\.knorvia-library\/(write\.lock|uploads|tools)(\/|$)/i.test(norm)) return false;
  if (/^extensions\/(catalog\.lock(?:\.steal)?|pending-transition\.json|staging|builtin-staging)(\/|$)/i.test(norm)) return false;
  if (/^config\/ssh-hosts\.json\.lock(?:\.|$)/i.test(norm)) return false;
  if (/^state\/(daemon\.lock|logs|temp)(\/|$)/i.test(norm)) return false;
  return true;
}

async function walkFiles(root, prefix = '', out = [], warnings = [], topology = [], signal) {
  throwIfAborted(signal);
  let stat;
  try { stat = await fsp.lstat(root); } catch (error) {
    if (error.code === 'ENOENT') {
      topology.push(`missing:${prefix || root}`);
      return { files: out, warnings, topology };
    }
    throw error;
  }
  throwIfAborted(signal);
  // A component root that is a symbolic link or junction must be skipped, never traversed!
  if (stat.isSymbolicLink()) {
    topology.push(`link:${prefix || root}`);
    warnings.push(`跳过符号链接：${prefix || root}`);
    return { files: out, warnings, topology };
  }
  // A component may be a single file (e.g. the library index.json).
  if (stat.isFile()) {
    topology.push(`file:${prefix || root}`);
    if (componentFilter(prefix)) out.push({ relativePath: prefix, full: root });
    return { files: out, warnings, topology };
  }
  if (!stat.isDirectory()) {
    topology.push(`other:${prefix || root}`);
    return { files: out, warnings, topology };
  }
  topology.push(`dir:${prefix || root}`);
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') {
      topology.push(`removed:${prefix || root}`);
      return { files: out, warnings, topology };
    }
    throw error;
  }
  throwIfAborted(signal);
  for (const entry of entries) {
    throwIfAborted(signal);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(root, entry.name);
    if (!componentFilter(relativePath)) continue;
    // Re-lstat each entry instead of trusting the earlier Dirent. This catches
    // a directory-to-junction replacement made between readdir and traversal.
    await walkFiles(full, relativePath, out, warnings, topology, signal);
  }
  return { files: out, warnings, topology };
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 800) fail('备份清单中的文件路径无效', -32004);
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /^[a-zA-Z]:/.test(part))) {
    fail('备份清单中的文件路径无效（疑似路径穿越）', -32004);
  }
  return parts.join('/');
}

async function freeDiskBytes(candidate) {
  if (typeof fs.statfs !== 'function') return Number.POSITIVE_INFINITY;
  let dir = candidate;
  for (;;) {
    try { const stats = await fsp.statfs(dir); return stats.bsize * stats.bavail; } catch (error) {
      if (error.code === 'ENOENT') { const parent = path.dirname(dir); if (parent !== dir) { dir = parent; continue; } return Number.POSITIVE_INFINITY; }
      return Number.POSITIVE_INFINITY;
    }
  }
}

// True when `target` is `root` itself or anywhere beneath it.
function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalCandidate(target) {
  let cursor = path.resolve(target);
  const missing = [];
  for (;;) {
    try {
      await fsp.lstat(cursor);
      const real = await fsp.realpath(cursor);
      return path.resolve(real, ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function assertOutsideRoots(target, roots, message) {
  const candidate = await canonicalCandidate(target);
  for (const root of roots) {
    let canonicalRoot;
    try { canonicalRoot = await fsp.realpath(root); } catch { canonicalRoot = path.resolve(root); }
    if (isInside(canonicalRoot, candidate) || isInside(candidate, canonicalRoot)) fail(message, -32005);
  }
  return candidate;
}

async function containedRegularFile(root, relativePath) {
  const rootStat = await fsp.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('备份根目录不是普通目录');
  const canonicalRoot = await fsp.realpath(root);
  let cursor = root;
  const parts = relativePath.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    const stat = await fsp.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error(`备份包含符号链接或 junction：${relativePath}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`备份路径祖先不是目录：${relativePath}`);
    if (index === parts.length - 1 && !stat.isFile()) throw new Error(`备份条目不是普通文件：${relativePath}`);
  }
  const canonicalFile = await fsp.realpath(cursor);
  if (!isInside(canonicalRoot, canonicalFile) || path.resolve(canonicalFile) === path.resolve(canonicalRoot)) {
    throw new Error(`备份文件逃逸根目录：${relativePath}`);
  }
  return canonicalFile;
}

async function mkdirTracked(root, relativeDirectory, createdDirectories) {
  let cursor = root;
  for (const segment of relativeDirectory.split('/').filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      await fsp.mkdir(cursor);
      createdDirectories.push(cursor);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fsp.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`暂存路径已被替换：${relativeDirectory}`);
    }
  }
}

async function cleanupOwnedStaging(root, tokenFile, token, writtenFiles, createdDirectories) {
  let tokenOnDisk = null;
  try { tokenOnDisk = await fsp.readFile(tokenFile, 'utf8'); } catch {}
  if (tokenOnDisk !== token) return;
  for (const file of [...writtenFiles].reverse()) await fsp.unlink(file).catch(() => {});
  await fsp.unlink(tokenFile).catch(() => {});
  for (const directory of [...createdDirectories].reverse()) await fsp.rmdir(directory).catch(() => {});
  await fsp.rmdir(root).catch(() => {});
}

function acquireOsDaemonLockLease(lockFile, { signal, timeoutMs = 5_000 } = {}) {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      try { fs.mkdirSync(path.dirname(lockFile), { recursive: true }); } catch {}
      const escapedPath = lockFile.replace(/'/g, "''");
      const script = `
        try {
          $stream = [System.IO.File]::Open('${escapedPath}', [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
          Write-Output "LOCKED"
          [Console]::ReadLine() | Out-Null
          $stream.Close()
        } catch {
          Write-Output "BUSY"
          exit 1
        }
      `;
      let resolved = false;
      let helperExited = false;
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
      let stdout = "";
      const finish = (value) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => { try { child.kill(); } catch {} finish(null); };
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, Math.max(1, timeoutMs));
      timer.unref?.();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.stdout.on("data", (data) => {
        stdout += data.toString();
        if (stdout.includes("LOCKED") && !resolved) {
          finish({
            held: true,
            isAlive: () => !helperExited,
            release() {
              return new Promise((res) => {
                child.on("close", () => res());
                try { child.stdin.write("\n"); } catch {}
                setTimeout(() => { try { child.kill(); } catch {} res(); }, 500);
              });
            },
          });
        } else if (stdout.includes("BUSY") && !resolved) {
          finish(null);
        }
      });
      child.on("error", () => {
        helperExited = true;
        finish(null);
      });
      child.on("close", () => {
        helperExited = true;
        finish(null);
      });
    });
  } else {
    return new Promise((resolve) => {
      try { fs.mkdirSync(path.dirname(lockFile), { recursive: true }); } catch {}
      const pyScript = `import sys, fcntl
try:
    f = open(sys.argv[1], 'w+')
    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print('LOCKED')
    sys.stdout.flush()
    sys.stdin.readline()
    f.close()
except Exception:
    print('BUSY')
    sys.exit(1)
`;
      let resolved = false;
      let helperExited = false;
      const child = spawn("python3", ["-c", pyScript, lockFile], { windowsHide: true });
      let stdout = "";
      const finish = (value) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => { try { child.kill(); } catch {} finish(null); };
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, Math.max(1, timeoutMs));
      timer.unref?.();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.stdout.on("data", (data) => {
        stdout += data.toString();
        if (stdout.includes("LOCKED") && !resolved) {
          finish({
            held: true,
            isAlive: () => !helperExited,
            release() {
              return new Promise((res) => {
                child.on("close", () => res());
                try { child.stdin.write("\n"); } catch {}
                setTimeout(() => { try { child.kill(); } catch {} res(); }, 500);
              });
            },
          });
        } else if (stdout.includes("BUSY") && !resolved) {
          finish(null);
        }
      });
      child.on("error", () => {
        helperExited = true;
        finish(null);
      });
      child.on("close", () => {
        helperExited = true;
        finish(null);
      });
    });
  }
}

function createHomeBackup({
  home,
  appVersion = '',
  lockPaths = [],
  now = () => new Date().toISOString(),
  freeSpace = freeDiskBytes,
  acquireLease = (options) => acquireOsDaemonLockLease(path.join(home, 'state', 'daemon.lock'), options),
} = {}) {
  if (!path.isAbsolute(home || '')) throw new Error('home-backup requires an absolute Home');

  async function collectComponents(signal) {
    const components = [];
    const allFiles = [];
    const warnings = [];
    const topology = [];
    for (const component of COMPONENTS) {
      throwIfAborted(signal);
      const root = path.join(home, component.name);
      const files = [];
      const skipped = [];
      await walkFiles(root, component.name, files, skipped, topology, signal);
      warnings.push(...skipped);
      let bytes = 0;
      const entries = [];
      for (const file of files) {
        throwIfAborted(signal);
        const stat = await fsp.lstat(file.full);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          fail(`Home 文件在扫描期间被替换（${file.relativePath}）；本次快照未发布`, -32040);
        }
        bytes += stat.size;
        entries.push({ relativePath: file.relativePath, size: stat.size });
        file.size = stat.size;
      }
      components.push({ ...component, files: entries.length, bytes });
      allFiles.push(...files);
    }
    throwIfAborted(signal);
    const generation = createHash('sha256')
      .update(topology.slice().sort().join('\n'))
      .update('\n--files--\n')
      .update(allFiles.map(file => `${file.relativePath}\0${file.size}`).sort().join('\n'))
      .digest('hex');
    return { components, allFiles, warnings, generation };
  }

  function assertLeaseAlive(lease, phase) {
    if (lease && typeof lease.isAlive === 'function' && !lease.isAlive()) {
      fail(`OS daemon lock lease was lost unexpectedly ${phase}; the snapshot was not published`, -32040);
    }
  }

  async function revalidateSourceGeneration(initial, signal, lease) {
    throwIfAborted(signal);
    assertLeaseAlive(lease, 'before source revalidation');
    const current = await collectComponents(signal);
    if (current.generation !== initial.generation) {
      fail('Home 文件目录在复制期间发生变化；本次快照未发布', -32040);
    }
    const expected = new Map(initial.allFiles.map(file => [file.relativePath, file.sourceSha256]));
    for (const file of current.allFiles) {
      throwIfAborted(signal);
      const digest = await sha256File(file.full, signal);
      if (digest !== expected.get(file.relativePath)) {
        fail(`复制后重新校验发现源文件发生变化（${file.relativePath}）；本次快照未发布`, -32040);
      }
    }
    throwIfAborted(signal);
    assertLeaseAlive(lease, 'after source revalidation');
  }

  return {
    // Read-only preview: components, sizes, exclusions, lock status. Safe to
    // call any time; it never claims a hot copy would be consistent.
    async plan() {
      const { components, allFiles, warnings } = await collectComponents();
      let totalBytes = 0;
      for (const file of allFiles) totalBytes += file.size;
      const busyLocks = [];
      for (const lockPath of lockPaths) {
        try { await fsp.stat(lockPath); busyLocks.push(lockPath); } catch { /* lock absent */ }
      }
      return {
        version: 1,
        components: components.map(({ name, files, bytes, note, requiresReloginOnOtherMachine }) => ({ name, files, bytes, note, requiresReloginOnOtherMachine: Boolean(requiresReloginOnOtherMachine) })),
        totalFiles: allFiles.length,
        totalBytes,
        warnings,
        busyLocks,
        // While any writer is alive, only the plan is available; the export
        // itself happens at bounded shutdown.
        canExportNow: busyLocks.length === 0,
        requiresSafeShutdown: true,
      };
    },

    // Offline export. Runs after all writers exited; refuses when a known
    // lock is still held. The destination must not exist; on failure the
    // partial destination is marked uncommitted and only exact written files
    // are cleaned up so unrelated user files are never deleted.
    async export({ destination, blockedWriters = [], signal }) {
      if (signal?.aborted) fail('备份操作已被超时中止', -32040);
      if (!destination || !path.isAbsolute(destination)) fail('请选择一个绝对路径作为备份位置');
      const blocked = (Array.isArray(blockedWriters) ? blockedWriters : []).map(name => String(name).slice(0, 120)).filter(Boolean);
      if (blocked.length) {
        fail(`仍有 Home 写入者未确认退出（${blocked.join('；')}）；为避免复制不一致的数据库，备份未开始，可在全部退出后重试`, -32040);
      }
      if (isInside(home, destination) || isInside(destination, home)) {
        fail('备份位置不能位于应用数据（Home）内部或其父目录，请选择一个独立目录', -32005);
      }
      // Never treat an existing directory as debris or remove it!
      let exists = true;
      try { await fsp.stat(destination); } catch { exists = false; }
      if (exists) {
        fail('备份位置已存在，请选择一个新目录', -32005);
      }

      // Check and hold desktop writer locks (write.lock, catalog.lock) across the copy
      const heldDesktopLocks = [];
      try {
        for (const lockPath of (Array.isArray(lockPaths) ? lockPaths : [])) {
          let lockExists = true;
          try { await fsp.stat(lockPath); } catch { lockExists = false; }
          if (lockExists) {
            fail(`仍有服务持有写入锁（${path.basename(lockPath)}），备份未开始，请在全部退出后重试`, -32040);
          }
          await fsp.mkdir(path.dirname(lockPath), { recursive: true });
          const token = 'backup_' + process.pid + '_' + randomUUID();
          if (path.basename(lockPath) === 'write.lock') {
            try {
              await fsp.mkdir(lockPath);
              const ownerFile = path.join(lockPath, 'owner.json');
              await fsp.writeFile(ownerFile, JSON.stringify({ token, pid: process.pid, at: Date.now() }), 'utf8');
              heldDesktopLocks.push({ lockPath, ownerFile, isDir: true, expectedToken: token });
            } catch {
              fail(`无法取得写入互斥锁（${path.basename(lockPath)}），备份未开始，请在全部退出后重试`, -32040);
            }
          } else {
            try {
              const handle = await fsp.open(lockPath, 'wx');
              const payload = JSON.stringify({ token, pid: process.pid, at: Date.now(), gen: 1 });
              await handle.writeFile(payload, 'utf8');
              heldDesktopLocks.push({ lockPath, handle, isDir: false, expectedToken: token });
            } catch {
              fail(`无法取得写入互斥锁（${path.basename(lockPath)}），备份未开始，请在全部退出后重试`, -32040);
            }
          }
        }
      } catch (err) {
        for (const held of heldDesktopLocks) {
          try {
            if (held.isDir) {
              await fsp.unlink(held.ownerFile).catch(() => {});
              await fsp.rmdir(held.lockPath).catch(() => {});
            } else {
              await held.handle.close().catch(() => {});
              await fsp.unlink(held.lockPath).catch(() => {});
            }
          } catch {}
        }
        throw err;
      }

      // Acquire exclusive OS lock lease on state/daemon.lock
      let lease = null;
      if (typeof acquireLease === 'function') {
        try { lease = await acquireLease({ signal }); } catch { lease = null; }
        if (!lease || !lease.held) {
          for (const held of heldDesktopLocks) {
            try {
              if (held.isDir) {
                await fsp.unlink(held.ownerFile).catch(() => {});
                await fsp.rmdir(held.lockPath).catch(() => {});
              } else {
                await held.handle.close().catch(() => {});
                await fsp.unlink(held.lockPath).catch(() => {});
              }
            } catch {}
          }
          fail('Home 正在被运行中的服务使用，无法获得排他锁；请在全部退出后重试', -32040);
        }
      }

      // Build in a random sibling and publish by one directory rename. The
      // user-selected path is never a partially written backup.
      const destinationParent = path.dirname(destination);
      await fsp.mkdir(destinationParent, { recursive: true });
      await assertOutsideRoots(destination, [home], '备份位置不能通过符号链接或 junction 指向应用 Home');
      try {
        await fsp.lstat(destination);
        fail('备份位置已存在，请选择一个新目录', -32005);
      } catch (error) {
        if (error?.rpc || error.code !== 'ENOENT') throw error;
      }
      const stagingToken = randomUUID();
      const stagingDir = path.join(destinationParent, `.${path.basename(destination)}.knorvia-staging-${stagingToken}`);
      const stagingTokenFile = path.join(stagingDir, '.knorvia-export-staging');
      const writtenFiles = [];
      const createdDirectories = [];
      let published = false;
      try {
        await fsp.mkdir(stagingDir);
        await fsp.writeFile(stagingTokenFile, stagingToken, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        for (const held of heldDesktopLocks) {
          try {
            if (held.isDir) {
              await fsp.unlink(held.ownerFile).catch(() => {});
              await fsp.rmdir(held.lockPath).catch(() => {});
            } else {
              await held.handle.close().catch(() => {});
              await fsp.unlink(held.lockPath).catch(() => {});
            }
          } catch {}
        }
        if (lease && typeof lease.release === 'function') {
          try { await lease.release(); } catch {}
        }
        if (error.code === 'EEXIST') fail('无法创建唯一备份暂存目录，请重试', -32005);
        throw error;
      }

      try {
        const sourceSnapshot = await collectComponents(signal);
        const { components, allFiles, warnings } = sourceSnapshot;
        let totalBytes = 0;
        for (const file of allFiles) totalBytes += file.size;
        throwIfAborted(signal);
        const needed = totalBytes * 2 + 10 * 1024 * 1024;
        const available = await freeSpace(stagingDir);
        throwIfAborted(signal);
        if (available < needed) {
          fail(`目标磁盘空间不足：需要约 ${(needed / 1024 / 1024).toFixed(0)} MB，可用 ${(available / 1024 / 1024).toFixed(0)} MB`, -32006);
        }

        const manifest = {
          version: 1,
          tool: 'knorvia-home-backup',
          appVersion,
          createdAt: now(),
          components: components.map(({ name, files, bytes }) => ({ name, files, bytes })),
          totalFiles: allFiles.length,
          totalBytes,
          warnings,
          contentHash: '',
        };

        const fileLines = [];
        let hashTotal = createHash('sha256');
        for (const file of allFiles) {
          throwIfAborted(signal);
          assertLeaseAlive(lease, 'during copy');
          const relativePath = safeRelative(file.relativePath);
          const digest = await sha256File(file.full, signal);
          file.sourceSha256 = digest;
          const target = path.join(stagingDir, ...relativePath.split('/'));
          await mkdirTracked(stagingDir, path.posix.dirname(relativePath), createdDirectories);
          // Register before opening the output: pipeline may leave a partial
          // file when a stream fails or is aborted.
          writtenFiles.push(target);
          await copyFileAbortable(file.full, target, signal);
          const size = (await fsp.stat(target)).size;
          const copiedDigest = await sha256File(target, signal);
          if (copiedDigest !== digest) {
            fail(`复制期间源文件发生变化（${file.relativePath}）；本次快照未发布`, -32040);
          }
          fileLines.push(JSON.stringify({ p: file.relativePath, s: size, h: digest }));
          hashTotal = hashTotal.update(digest);
        }
        throwIfAborted(signal);

        // A second inventory and full source hash pass detects generation
        // changes from any writer that did not participate in the declared
        // lock protocol. The staged copy is never published on drift.
        await revalidateSourceGeneration(sourceSnapshot, signal, lease);

        // Verify held desktop locks before committing manifest
        for (const held of heldDesktopLocks) {
          throwIfAborted(signal);
          let content;
          try {
            content = await fsp.readFile(held.isDir ? held.ownerFile : held.lockPath, 'utf8');
          } catch {
            content = null;
          }
          let parsed;
          try { parsed = JSON.parse(content); } catch { parsed = null; }
          if (!parsed || parsed.token !== held.expectedToken) {
            fail('备份期间检测到写入者进入或修改了锁定状态；本次快照不可信', -32040);
          }
        }
        assertLeaseAlive(lease, 'before manifest commit');
        throwIfAborted(signal);

        const filesManifest = path.join(stagingDir, BACKUP_FILES);
        writtenFiles.push(filesManifest);
        await fsp.writeFile(filesManifest, fileLines.length ? `${fileLines.join('\n')}\n` : '', { encoding: 'utf8', flag: 'wx' });
        manifest.contentHash = hashTotal.digest('hex');
        const backupManifest = path.join(stagingDir, BACKUP_MANIFEST);
        writtenFiles.push(backupManifest);
        await fsp.writeFile(backupManifest, JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' });
        const stagedVerification = await this.verify(stagingDir, { signal });
        if (!stagedVerification.ok) {
          fail(`备份暂存副本未通过发布前校验：${stagedVerification.problems.slice(0, 3).join('；')}`, -32040);
        }
        throwIfAborted(signal);
        assertLeaseAlive(lease, 'before atomic publish');
        try {
          await fsp.lstat(destination);
          fail('备份位置在导出期间被占用；完整暂存副本未覆盖该位置', -32005);
        } catch (error) {
          if (error?.rpc || error.code !== 'ENOENT') throw error;
        }
        // lstat is asynchronous. Re-check immediately before the irreversible
        // directory rename so a deadline that fired in that window cannot be
        // acknowledged as a successful backup.
        throwIfAborted(signal);
        assertLeaseAlive(lease, 'before atomic publish');
        await fsp.rename(stagingDir, destination).catch((error) => {
          if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) {
            fail('备份位置在发布期间被占用；未覆盖已有内容', -32005);
          }
          throw error;
        });
        published = true;
        await fsp.unlink(path.join(destination, '.knorvia-export-staging')).catch(() => {});
        // A successful directory rename is the commit point. The complete
        // manifest was verified before this operation, so an abort becoming
        // observable while rename completes cannot turn the committed backup
        // into a retryable request whose destination is already occupied.
        return {
          ok: true,
          committed: true,
          verified: true,
          completedAfterDeadline: Boolean(signal?.aborted),
          destination,
          totalFiles: manifest.totalFiles,
          totalBytes,
          warnings,
        };
      } catch (error) {
        if (!published) await cleanupOwnedStaging(stagingDir, stagingTokenFile, stagingToken, writtenFiles, createdDirectories);
        if (signal?.aborted && !error?.rpc) fail('备份操作已被超时中止', -32040);
        throw error;
      } finally {
        for (const held of heldDesktopLocks) {
          try {
            if (held.isDir) {
              await fsp.unlink(held.ownerFile).catch(() => {});
              await fsp.rmdir(held.lockPath).catch(() => {});
            } else {
              await held.handle.close().catch(() => {});
              await fsp.unlink(held.lockPath).catch(() => {});
            }
          } catch {}
        }
        if (lease && typeof lease.release === 'function') {
          try { await lease.release(); } catch {}
        }
      }
    },

    // Full verification: manifest present, every listed file present with the
    // recorded hash, content hash over the file list matches.
    async verify(backupDir, { signal } = {}) {
      const problems = [];
      throwIfAborted(signal);
      try {
        const rootStat = await fsp.lstat(backupDir);
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { ok: false, problems: ['备份根目录不能是符号链接或 junction'] };
      } catch {
        return { ok: false, problems: ['备份目录不存在或无法读取'] };
      }
      throwIfAborted(signal);
      let manifest;
      try {
        const manifestFile = await containedRegularFile(backupDir, BACKUP_MANIFEST);
        manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
      } catch {
        return { ok: false, problems: ['backup.json 缺失或损坏'] };
      }
      throwIfAborted(signal);
      if (manifest?.version !== 1 || manifest?.tool !== 'knorvia-home-backup') return { ok: false, problems: ['备份清单版本不受支持'] };
      let lines;
      try {
        const filesFile = await containedRegularFile(backupDir, BACKUP_FILES);
        lines = (await fsp.readFile(filesFile, 'utf8')).split('\n').filter(Boolean);
      } catch {
        return { ok: false, problems: ['files.jsonl 缺失或损坏'] };
      }
      throwIfAborted(signal);
      const files = [];
      const seen = new Set();
      let totalBytes = 0;
      const listedHashes = [];
      for (const line of lines) {
        throwIfAborted(signal);
        let parsed;
        try { parsed = JSON.parse(line); } catch { problems.push('files.jsonl 中有一行损坏'); continue; }
        let rel;
        try { rel = safeRelative(parsed.p); } catch { problems.push(`清单路径无效（疑似路径穿越）：${String(parsed.p).slice(0, 80)}`); continue; }
        if (seen.has(rel)) { problems.push(`清单包含重复路径：${rel}`); continue; }
        seen.add(rel);
        if (!Number.isSafeInteger(parsed.s) || parsed.s < 0 || !/^[a-f\d]{64}$/i.test(parsed.h || '')) {
          problems.push(`清单元数据无效：${rel}`);
          continue;
        }
        let full;
        try { full = await containedRegularFile(backupDir, rel); }
        catch (error) { problems.push(String(error?.message || `缺失：${rel}`)); continue; }
        let digest = '';
        let actualSize = -1;
        try { actualSize = (await fsp.stat(full)).size; digest = await sha256File(full, signal); }
        catch (error) {
          if (signal?.aborted || error?.name === 'AbortError') throw error;
          problems.push(`缺失：${rel}`);
          continue;
        }
        if (actualSize !== parsed.s) problems.push(`大小不符：${rel}`);
        if (digest !== parsed.h) problems.push(`哈希不符：${rel}`);
        totalBytes += parsed.s;
        listedHashes.push(parsed.h);
        files.push({ relativePath: rel, size: parsed.s, sha256: parsed.h });
      }
      throwIfAborted(signal);
      const hashTotal = createHash('sha256').update(listedHashes.join(''));
      if (manifest.contentHash && hashTotal.digest('hex') !== manifest.contentHash) {
        problems.push('文件清单内容哈希与备份清单不一致');
      }
      if (manifest.totalFiles !== files.length) problems.push('文件总数与备份清单不一致');
      if (manifest.totalBytes !== totalBytes) problems.push('文件总大小与备份清单不一致');
      return { ok: problems.length === 0, problems, manifest, files };
    },

    // Verified preview of what a restore would create. Read-only.
    async previewRestore(backupDir) {
      const verification = await this.verify(backupDir);
      if (!verification.ok) {
        return { ok: false, problems: verification.problems, components: [] };
      }
      return {
        ok: true,
        components: verification.manifest.components,
        totalFiles: verification.manifest.totalFiles,
        totalBytes: verification.manifest.totalBytes,
        createdAt: verification.manifest.createdAt,
        appVersion: verification.manifest.appVersion,
        warnings: verification.manifest.warnings || [],
        requiresNewEmptyTarget: true,
      };
    },

    // Restores a verified backup into a brand-new directory. The target is
    // never an existing Home; a failure removes the partial target so no
    // half-restored Home can ever be switched into.
    async restore({ backupDir, targetHome, signal }) {
      throwIfAborted(signal);
      if (!targetHome || !path.isAbsolute(targetHome)) fail('请选择一个绝对路径作为新 Home');
      const resolvedTarget = path.resolve(targetHome);
      if (path.resolve(resolvedTarget).toLowerCase() === path.resolve(home).toLowerCase()) {
        fail('不能恢复到当前正在使用的 Home', -32005);
      }
      await assertOutsideRoots(resolvedTarget, [home, backupDir], '新 Home 不能位于当前 Home、备份目录或其符号链接路径中');
      const verification = await this.verify(backupDir, { signal });
      if (!verification.ok) fail(`备份未通过校验：${verification.problems.slice(0, 3).join('；')}`, -32004);
      let exists = true;
      try { await fsp.lstat(resolvedTarget); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
      if (exists) fail('目标目录已存在；请选择一个空的新位置，现有 Home 不会被覆盖', -32005);
      const targetParent = path.dirname(resolvedTarget);
      await fsp.mkdir(targetParent, { recursive: true });
      await assertOutsideRoots(resolvedTarget, [home, backupDir], '新 Home 不能通过符号链接或 junction 指向当前 Home 或备份目录');
      const token = randomUUID();
      const stagingDir = path.join(targetParent, `.${path.basename(resolvedTarget)}.knorvia-restore-${token}`);
      const tokenFile = path.join(stagingDir, '.knorvia-restore-staging');
      await fsp.mkdir(stagingDir);
      await fsp.writeFile(tokenFile, token, { encoding: 'utf8', flag: 'wx' });
      const restoredFiles = [];
      const createdDirectories = [];
      let published = false;
      try {
        for (const file of verification.files) {
          throwIfAborted(signal);
          const source = await containedRegularFile(backupDir, file.relativePath);
          const target = path.join(stagingDir, ...file.relativePath.split('/'));
          await mkdirTracked(stagingDir, path.posix.dirname(file.relativePath), createdDirectories);
          restoredFiles.push(target);
          await copyFileAbortable(source, target, signal);
          if (await sha256File(target, signal) !== file.sha256) fail(`恢复复制校验失败：${file.relativePath}`, -32004);
        }
        throwIfAborted(signal);
        await mkdirTracked(stagingDir, RESTORE_RECEIPT_DIR, createdDirectories);
        const receiptPath = path.join(stagingDir, RESTORE_RECEIPT_DIR, RESTORE_RECEIPT);
        restoredFiles.push(receiptPath);
        await fsp.writeFile(
          receiptPath,
          JSON.stringify({ version: OVERRIDE_VERSION, restoredAt: now(), source: path.basename(backupDir), appVersion }, null, 2),
          { encoding: 'utf8', flag: 'wx' },
        );
        throwIfAborted(signal);
        try {
          await fsp.lstat(resolvedTarget);
          fail('目标目录在恢复期间被占用；完整暂存副本未覆盖该位置', -32005);
        } catch (error) {
          if (error?.rpc || error.code !== 'ENOENT') throw error;
        }
        throwIfAborted(signal);
        await fsp.rename(stagingDir, resolvedTarget).catch((error) => {
          if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) {
            fail('目标目录在发布期间被占用；未覆盖已有内容', -32005);
          }
          throw error;
        });
        published = true;
        await fsp.unlink(path.join(resolvedTarget, '.knorvia-restore-staging')).catch(() => {});
        return {
          ok: true,
          committed: true,
          verified: true,
          completedAfterDeadline: Boolean(signal?.aborted),
          targetHome: resolvedTarget,
          files: verification.files.length,
        };
      } catch (error) {
        if (!published) await cleanupOwnedStaging(stagingDir, tokenFile, token, restoredFiles, createdDirectories);
        throw error;
      }
    },
  };
}

// A restart override is honoured only for a directory that carries a restore
// receipt from a verified restore — never for an arbitrary path.
function resolvePendingHomeOverride(userDataDir, fsImpl = fs) {
  let parsed;
  try { parsed = JSON.parse(fsImpl.readFileSync(path.join(userDataDir, OVERRIDE_FILE), 'utf8')); } catch { return null; }
  if (parsed?.version !== OVERRIDE_VERSION || typeof parsed.root !== 'string' || !path.isAbsolute(parsed.root)) return null;
  const receipt = path.join(parsed.root, RESTORE_RECEIPT_DIR, RESTORE_RECEIPT);
  let restored;
  try { restored = JSON.parse(fsImpl.readFileSync(receipt, 'utf8')); } catch { return null; }
  if (restored?.version !== OVERRIDE_VERSION) return null;
  return { version: parsed.version, root: parsed.root, restoredAt: restored.restoredAt };
}

function recordPendingHomeOverride(userDataDir, root, fsImpl = fs) {
  if (!root || !path.isAbsolute(root)) throw new Error('pending home override requires an absolute path');
  fsImpl.mkdirSync(userDataDir, { recursive: true });
  const file = path.join(userDataDir, OVERRIDE_FILE);
  const temp = `${file}.${randomUUID()}.tmp`;
  fsImpl.writeFileSync(temp, JSON.stringify({ version: OVERRIDE_VERSION, root, at: new Date().toISOString() }), 'utf8');
  fsImpl.renameSync(temp, file);
}

function clearPendingHomeOverride(userDataDir, fsImpl = fs) {
  try { fsImpl.unlinkSync(path.join(userDataDir, OVERRIDE_FILE)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// Pending-backup orchestration called during shutdown.
// blockedWriters are the writer-exit receipts; ANY non-empty list refuses
// the copy before the Home is read, keeps the pending request retryable
// and records the outcome. Only a successful export clears the pending
// request; every failure (blocked writers, busy locks, nesting, disk)
// preserves it for the next full shutdown.
async function runPendingBackupRequest({
  home, userDataDir, appVersion, pendingFile, resultFile, lockPaths = [],
  blockedWriters = [], now, freeSpace, acquireLease, fsImpl = fs,
  signal,
} = {}) {
  let pending = null;
  try { pending = JSON.parse(fsImpl.readFileSync(pendingFile, 'utf8')); } catch { return null; }
  if (!pending || typeof pending !== 'object' || typeof pending.destination !== 'string'
    || !path.isAbsolute(pending.destination)) return null;
  const blocked = (Array.isArray(blockedWriters) ? blockedWriters : []).map(name => String(name).slice(0, 120)).filter(Boolean);
  const backup = createHomeBackup({ home, appVersion, lockPaths, now, freeSpace, acquireLease });
  let result;
  if (blocked.length) {
    result = { ok: false, retryable: true, blockedWriters: blocked, error: `仍有 Home 写入者未确认退出（${blocked.join('；')}）；备份未开始，可在全部退出后重试` };
  } else {
    try {
      const outcome = await backup.export({ destination: pending.destination, signal });
      // export() holds every declared writer lock and the daemon's OS lease
      // through the manifest commit. A writer may legitimately acquire its
      // lock after this return; it cannot alter the completed snapshot and
      // must never trigger recursive deletion of the chosen destination.
      result = { ...outcome, retryable: false };
    } catch (error) {
      result = { ok: false, retryable: true, error: String(error?.rpc?.message || error?.message || error).slice(0, 300) };
    }
  }
  try {
    fsImpl.mkdirSync(path.dirname(resultFile), { recursive: true });
    fsImpl.writeFileSync(resultFile, JSON.stringify({ version: 1, at: new Date().toISOString(), destination: pending.destination, ...result }, null, 2), 'utf8');
  } catch { /* result stays unreported rather than failing shutdown */ }
  // Atomic rename is the commit point. Once the verified destination exists,
  // clear the request even if its completion callback and the deadline raced.
  if (result.ok === true && result.committed === true) {
    try { fsImpl.unlinkSync(pendingFile); } catch { /* keep for retry */ }
  }
  return result;
}

module.exports = {
  COMPONENTS,
  BACKUP_MANIFEST,
  BACKUP_FILES,
  RESTORE_RECEIPT,
  OVERRIDE_FILE,
  createHomeBackup,
  acquireOsDaemonLockLease,
  resolvePendingHomeOverride,
  recordPendingHomeOverride,
  writePendingHomeOverride: recordPendingHomeOverride,
  clearPendingHomeOverride,
  runPendingBackupRequest,
};
