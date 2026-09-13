'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');

const backupModule = require('../home-backup');
const shutdownModule = require('../shutdown-controller');
const { startKnorviaDaemon } = require('../knorvia-protocol-client');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const stopSource = mainSource.slice(
  mainSource.indexOf('async function stopServices() {'),
  mainSource.indexOf('\nlet migrationRecoveryActive')
);
const lockSource = mainSource.slice(
  mainSource.indexOf('function homeBackupLockPaths(home) {'),
  mainSource.indexOf('\nfunction pendingHomeBackupFile')
);

const daemonBin = 'D:/tools/knorvia-nightshift-20260911/runtime/I/runtime-native-source-0807/bin/knorvia-daemon.exe';
const python = 'python';

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function tempDir(t, prefix = 'c09-c15-test-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

const homeLocks = vm.runInNewContext(`${lockSource}\nhomeBackupLockPaths`, { path });

function stopContext(overrides = {}) {
  const calls = [];
  const captures = [];
  const taskkill = [];
  const closing = name => async () => { calls.push(name); return { confirmed: true }; };
  const context = {
    console, Promise, Date, Number, Boolean, String, Error, setTimeout, clearInterval, clearTimeout, AbortController,
    process: { env: { KNORVIA_SHUTDOWN_BUDGET_MS: '100' }, kill: process.kill.bind(process) },
    ...shutdownModule,
    frontendSupervisor: { stop() {} },
    powerReconcileTimer: null,
    powerPolicy: { reset() {} },
    cliDispatch: { close: closing('cli-dispatch') },
    creativeCliService: { close: closing('creative-cli-service') },
    studioMcp: { close: closing('studio-mcp') },
    mediaStudio: { close: closing('media-studio') },
    workspaceTerminals: { dispose: closing('workspace-terminals') },
    cliBackendHost: { host: { closeAll: async () => { calls.push('cli-backends'); return { exitedWithinTimeout: true }; } } },
    sshSessions: { dispose: closing('ssh-sessions') },
    worktreeSnapshots: { close: closing('worktree-snapshots') },
    extensionManager: { close: closing('extension-manager') },
    personalLibrary: { close: closing('personal-library') },
    nativeRuntime: { close: closing('native-runtime') },
    kernelEngine: undefined,
    diagnosticsErrors: { record() {} },
    capture: value => captures.push(value),
    workspaceMediaPreview: { close: closing('workspace-media-preview') },
    runtimeDiagnostics: undefined,
    engine: undefined,
    domainWorker: undefined,
    frontend: undefined,
    resolvePendingRequests() {},
    assetStreamBroker: undefined,
    removeNativeRpcNotification: undefined,
    nativeRpc: { beginClose: closing('native-rpc-router'), dispose() {} },
    removeRuntimeEngine: undefined,
    ENGINE_SHUTDOWN_GRACE_MS: 10,
    currentWorkspaceRoot: null,
    readPendingHomeBackup: () => null,
    runPendingHomeBackup: async () => null,
    spawn,
    spawnSync: (...args) => { taskkill.push(args); return { status: 0 }; },
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(`${stopSource}\nthis.reviewStop = stopServices;`, context, { filename: 'main-stopServices.js' });
  return { context, calls, captures, taskkill };
}

async function connectDaemon(home) {
  await fsp.mkdir(home, { recursive: true });
  const client = startKnorviaDaemon({ daemonBin, home, requestTimeoutMs: 10000 });
  const initial = await client.request(client.initializeRequest('c09-review-fixture', '1'));
  if (initial.error) throw new Error(JSON.stringify(initial.error));
  client.notify({ jsonrpc: '2.0', method: 'initialized', params: {} });
  let id = 0;
  return {
    client,
    rpc: (method, params) => client.request({ jsonrpc: '2.0', id: `review-${++id}`, method, params }),
    close: async () => {
      const finished = once(client.child, 'close');
      client.child.stdin.end();
      await Promise.race([
        finished,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Fixture daemon did not close')), 10000);
          timer.unref();
        }),
      ]);
    },
  };
}

test('Counterexample 3: destinationOwnership - pre-existing destination is refused with -32005 and sentinel preserved', async t => {
  const base = await tempDir(t, 'dest-own-');
  const home = path.join(base, 'home');
  const destination = path.join(base, 'backup');
  await fsp.mkdir(path.join(home, 'data'), { recursive: true });
  await fsp.writeFile(path.join(home, 'data', 'f.json'), '{}');
  await fsp.mkdir(destination);
  const sentinel = path.join(destination, 'unrelated-user-document.txt');
  await fsp.writeFile(sentinel, 'This preexisting directory was never a backup staging directory.');
  const lock = path.join(home, 'catalog.lock');
  await fsp.writeFile(lock, 'fixture busy writer');

  let error;
  try {
    await backupModule.createHomeBackup({ home, lockPaths: [lock] }).export({ destination });
  } catch (caught) {
    error = caught.rpc;
  }
  assert.ok(error, 'export must throw');
  assert.equal(error.code, -32005, 'error code must be -32005 for pre-existing destination');
  assert.equal(fs.existsSync(sentinel), true, 'unrelated user file must be preserved');
  assert.equal(fs.existsSync(destination), true, 'pre-existing directory must be preserved');
});

test('Counterexample 4: componentJunction - component root junction is skipped, external file not copied', async t => {
  const base = await tempDir(t, 'comp-junc-');
  const home = path.join(base, 'home');
  const outside = path.join(base, 'external-files');
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, 'outside.txt'), 'Fixture outside selected Home');
  fs.symlinkSync(outside, path.join(home, 'data'), 'junction');
  const destination = path.join(base, 'backup');

  const outcome = await backupModule.createHomeBackup({ home }).export({ destination });
  assert.equal(outcome.ok, true);
  assert.equal(fs.existsSync(path.join(destination, 'data', 'outside.txt')), false, 'external file must not be copied');
  assert.ok(outcome.warnings.some(w => w.includes('符号链接')), 'warning must be recorded');
});

test('Counterexample 5: shutdownWiring - every request gate and Home writer close callback is called, owned child confirmed', async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  await once(child, 'spawn');
  try {
    const fixture = stopContext({
      mediaStudio: {
        close: async () => {
          child.kill();
          return { confirmed: true };
        },
      },
    });
    const report = await fixture.context.reviewStop();
    const mediaStep = report.steps.find(step => step.name === 'media-studio');
    assert.notEqual(mediaStep.detail, 'step has no close function', 'media-studio must have close function');
    assert.equal(mediaStep.status, 'confirmed', 'media-studio must be confirmed');
    assert.equal(alive(child.pid), false, 'owned media child must be closed');
    assert.deepEqual(report.unconfirmed, [], 'a clean production shutdown does not fabricate failed steps');

    // Verify all 11 services were called
    const expectedServices = [
      'cli-dispatch',
      'creative-cli-service',
      'studio-mcp',
      'workspace-terminals',
      'cli-backends',
      'ssh-sessions',
      'worktree-snapshots',
      'extension-manager',
      'personal-library',
      'workspace-media-preview',
      'native-runtime',
      'native-rpc-router',
    ];
    for (const name of expectedServices) {
      assert.ok(fixture.calls.includes(name), `Service ${name} must be called during shutdown`);
    }
  } finally {
    if (child.exitCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
  }
});

test('Counterexample 6: shutdown timing - hanging preview close respects budget and withinBudget is true', async t => {
  const fixture = stopContext({
    process: { env: { KNORVIA_SHUTDOWN_BUDGET_MS: '200' }, kill: process.kill.bind(process) },
    workspaceMediaPreview: { close: () => new Promise(() => {}) },
  });
  const started = Date.now();
  const report = await fixture.context.reviewStop();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `shutdown took ${elapsed}ms, should be bounded around 200ms`);
  assert.equal(report.withinBudget, true, 'withinBudget must be true within host budget');
  const previewStep = report.steps.find(step => step.name === 'workspace-media-preview');
  assert.notEqual(previewStep.detail, 'step has no close function');
  assert.equal(previewStep.status, 'unconfirmed');
});

test('C15 production reaper closes only the real owned process tree within the host deadline', { timeout: 15_000 }, async t => {
  const base = await tempDir(t, 'shutdown-tree-');
  const childPidFile = path.join(base, 'child.pid');
  const managed = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process'),fs=require('node:fs');
    const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    fs.writeFileSync(${JSON.stringify(childPidFile)},String(c.pid)); setInterval(()=>{},1000);
  `], { windowsHide: true, stdio: 'ignore' });
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  const cleanup = pid => { if (!pid) return; try { spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch {} };
  t.after(() => { cleanup(managed.pid); cleanup(bystander.pid); });
  const until = Date.now() + 5000;
  while (!fs.existsSync(childPidFile) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(childPidFile), true, 'managed descendant started');
  const descendantPid = Number(fs.readFileSync(childPidFile, 'utf8'));
  const fixture = stopContext({
    process: { env: { KNORVIA_SHUTDOWN_BUDGET_MS: '1200' }, kill: process.kill.bind(process), platform: process.platform },
    workspaceTerminals: { activePids: () => [managed.pid], dispose: () => new Promise(() => {}) },
  });
  const report = await fixture.context.reviewStop();
  const terminal = report.steps.find(step => step.name === 'workspace-terminals');
  assert.equal(terminal.status, 'unconfirmed');
  assert.ok(report.reaped.some(item => item.pid === managed.pid), 'exact owned root has a verified exit receipt');
  assert.equal(alive(managed.pid), false, 'owned parent exited');
  assert.equal(alive(descendantPid), false, 'owned descendant exited through taskkill /T');
  assert.equal(alive(bystander.pid), true, 'unrelated process survives');
  assert.equal(report.withinBudget, true);
});

test('Counterexample 1: nativeBackup - real knorvia-daemon store survives full Home restore', async t => {
  if (!fs.existsSync(daemonBin)) {
    t.skip('knorvia-daemon.exe not found');
    return;
  }
  const base = await tempDir(t, 'native-store-');
  const home = path.join(base, 'home');
  const pendingFile = path.join(base, 'pending.json');
  const resultFile = path.join(base, 'result.json');
  const destination = path.join(base, 'backup');
  await fsp.writeFile(pendingFile, JSON.stringify({ version: 1, destination }));

  const connection = await connectDaemon(home);
  let workspace, thread;
  try {
    workspace = await connection.rpc('workspace/create', { title: 'Backup native fixture', cwd: base });
    assert.ok(workspace.result?.id, JSON.stringify(workspace));
    thread = await connection.rpc('thread/start', { workspaceId: workspace.result.id, title: 'Must survive full Home restore' });
    assert.ok(thread.result?.id, JSON.stringify(thread));
    const before = await connection.rpc('thread/read', { id: thread.result.id });
    assert.ok(before.result, JSON.stringify(before));
  } finally {
    await connection.close();
  }

  // Export offline backup
  const backup = backupModule.createHomeBackup({ home });
  const offline = path.join(base, 'offline-backup');
  const exportResult = await backup.export({ destination: offline });
  assert.equal(exportResult.ok, true);

  // Restore to brand new target
  const restored = path.join(base, 'restored');
  const restoreResult = await backup.restore({ backupDir: offline, targetHome: restored });
  assert.equal(restoreResult.ok, true);

  // Re-connect daemon to restored Home and read the thread
  const restoredConnection = await connectDaemon(restored);
  try {
    const read = await restoredConnection.rpc('thread/read', { id: thread.result.id });
    assert.ok(read.result, `Restored daemon must read the thread; error: ${JSON.stringify(read.error)}`);
    assert.equal(read.result.title, 'Must survive full Home restore');
    const listing = await restoredConnection.rpc('workspace/list', {});
    assert.ok(Array.isArray(listing.result) && listing.result.some(ws => ws.id === workspace.result.id), 'Restored workspace must be listed');
  } finally {
    await restoredConnection.close();
  }
});

test('Counterexample 1b: a real running knorvia-daemon holds state/daemon.lock and blocks export', async t => {
  if (!fs.existsSync(daemonBin)) {
    t.skip('knorvia-daemon.exe not found');
    return;
  }
  const base = await tempDir(t, 'native-lock-');
  const home = path.join(base, 'home');
  const destination = path.join(base, 'backup');
  const connection = await connectDaemon(home);
  try {
    await assert.rejects(
      backupModule.createHomeBackup({ home }).export({ destination }),
      error => error?.rpc?.code === -32040 && /排他锁|正在被/.test(error.message),
    );
    assert.equal(fs.existsSync(destination), false, 'no final backup is published while the real daemon owns Home');
  } finally {
    await connection.close();
  }
  const outcome = await backupModule.createHomeBackup({ home }).export({ destination });
  assert.equal(outcome.ok, true, 'export succeeds after the real daemon releases its OS lock');
});

test('Counterexample 2 & 7: heldLockWriterAdmission - concurrent desktop writer is excluded during backup export', async t => {
  const base = await tempDir(t, 'writer-admiss-');
  const home = path.join(base, 'home');
  const catalogLock = path.join(home, 'extensions', 'catalog.lock');
  const writeLock = path.join(home, 'personal-library', '.knorvia-library', 'write.lock');
  await fsp.mkdir(path.join(home, 'data'), { recursive: true });
  await fsp.writeFile(path.join(home, 'data', 'doc.json'), '{}');

  const destination = path.join(base, 'backup');
  const backup = backupModule.createHomeBackup({
    home,
    lockPaths: [catalogLock, writeLock],
    freeSpace: async () => {
      for (const lock of [catalogLock, writeLock]) {
        try {
          const handle = await fsp.open(lock, 'wx');
          await handle.close();
          await fsp.unlink(lock).catch(() => {});
        } catch (error) {
          if (['EEXIST', 'EBUSY', 'EPERM', 'EACCES'].includes(error.code)) writerBlocked = true;
        }
      }
      return Number.POSITIVE_INFINITY;
    },
  });

  // freeSpace runs after both guards are held and before any source read.
  let writerBlocked = false;
  const outcome = await backup.export({ destination });
  assert.equal(outcome.ok, true);
  assert.equal(writerBlocked, true, 'concurrent writer must be blocked by held lock during export');
  assert.equal(fs.existsSync(catalogLock), false, 'lock must be released after export');
});

test('Counterexample 3: hostDeadlineAndLateBackup - absolute monotonic stop deadline bounds shutdown', async t => {
  const lateFile = path.join(await tempDir(t, 'late-backup-'), 'late.txt');
  const fixture = stopContext({
    process: {
      env: { KNORVIA_SHUTDOWN_BUDGET_MS: '150', KNORVIA_BACKUP_BUDGET_MS: '50' },
      kill: process.kill.bind(process),
    },
    currentWorkspaceRoot: 'fixture-home',
    readPendingHomeBackup: () => ({ destination: 'fixture-only' }),
    runPendingHomeBackup: async (_ws, _writers, signal) => {
      // Simulate cooperative abort signal handling
      const deadline = Date.now() + 200;
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          throw new Error('aborted by signal');
        }
        await new Promise(r => setTimeout(r, 20));
      }
      await fsp.writeFile(lateFile, 'committed after host stop returned');
      return { ok: true };
    },
  });

  const started = Date.now();
  const report = await fixture.context.reviewStop();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400, `shutdown took ${elapsed}ms, should be bounded around 150ms`);
  assert.equal(report.withinBudget, true);
  assert.equal(report.steps.find(step => step.name === 'pending-home-backup')?.status, 'unconfirmed');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(lateFile), false, 'cancelled backup must not commit late file');
});

test('an atomic backup commit racing the deadline is reported confirmed and committed', async () => {
  const fixture = stopContext({
    process: {
      env: { KNORVIA_SHUTDOWN_BUDGET_MS: '300', KNORVIA_BACKUP_BUDGET_MS: '20' },
      kill: process.kill.bind(process),
    },
    currentWorkspaceRoot: 'fixture-home',
    readPendingHomeBackup: () => ({ destination: 'fixture-only' }),
    runPendingHomeBackup: async (_ws, _writers, signal) => {
      await new Promise(resolve => setTimeout(resolve, 35));
      assert.equal(signal.aborted, true, 'fixture completion crosses the backup deadline');
      return {
        ok: true,
        committed: true,
        verified: true,
        completedAfterDeadline: true,
        destination: 'fixture-backup',
      };
    },
  });
  const report = await fixture.context.reviewStop();
  const backup = report.steps.find(step => step.name === 'pending-home-backup');
  assert.equal(backup.status, 'confirmed');
  assert.equal(backup.committed, true);
  assert.match(backup.detail, /committed atomically/);
  assert.equal(report.unconfirmed.includes('pending-home-backup'), false);
});
