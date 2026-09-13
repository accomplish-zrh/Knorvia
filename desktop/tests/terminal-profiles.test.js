'use strict';

// C18: selectable, host-detected terminal profiles. Detection lists only
// well-known installed shells, the saved default is applied to new terminals
// without touching running ones, a missing chosen shell fails explicitly, and
// renderer-supplied executables stay rejected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createTerminalProfiles, detectProfiles } = require('../terminal-profiles');
const { createWorkspaceTerminal } = require('../workspace-terminal');

const fakePty = () => {
  const writes = []; let onData;
  const pty = { pid: 1, writes, write: data => writes.push(data), resize: () => {}, onData: fn => { onData = fn; }, onExit: () => {}, startedWith: null, kills: 0, kill() { this.kills++; } };
  pty.output = data => onData(data);
  return pty;
};

test('detection lists only shells that exist, with stable ids and launch args', () => {
  const windows = detectProfiles({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
    exists: candidate => !candidate.includes('7-preview') && !candidate.includes('(x86)'),
  });
  assert.deepEqual(windows.map(p => p.id), ['windows-powershell', 'powershell', 'git-bash']);
  assert.equal(windows[0].executable, path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.deepEqual(windows[0].args, ['-NoLogo', '-NoProfile']);
  const linux = detectProfiles({
    platform: 'linux',
    env: {},
    exists: candidate => candidate === '/bin/bash' || candidate === '/usr/bin/zsh',
  });
  assert.deepEqual(linux.map(p => `${p.id}@${p.executable}`), ['bash@/bin/bash', 'zsh@/usr/bin/zsh']);
});

test('the default choice persists atomically, validates against detection and degrades read-only on corruption', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-term-profiles-'));
  t_cleanup.push(home);
  const service = createTerminalProfiles({
    home,
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
    exists: candidate => candidate.includes('WindowsPowerShell') || candidate.includes('PowerShell\\7'),
  });
  assert.equal(service.detect().defaultProfileId, undefined);
  const saved = service.setDefault('powershell');
  assert.equal(saved.defaultProfileId, 'powershell');
  assert.equal(service.detect().defaultProfileId, 'powershell');
  assert.equal(service.resolve().id, 'powershell', 'the saved default is applied');
  assert.equal(service.resolve('windows-powershell').id, 'windows-powershell', 'an explicit id wins over the default');
  assert.throws(() => service.setDefault('fish'), e => e.rpc.code === -32602);
  assert.throws(() => service.resolve('fish'), e => e.rpc.code === -32046);
  // A corrupted preference file degrades to "no default" instead of breaking
  // terminal startup, and the next save heals it.
  const file = path.join(home, 'config', 'terminal-profile.json');
  fs.writeFileSync(file, '{broken');
  assert.equal(service.detect().defaultProfileId, undefined);
  service.setDefault('windows-powershell');
  assert.equal(service.detect().defaultProfileId, 'windows-powershell');
});
const t_cleanup = [];
process.on('exit', () => { for (const dir of t_cleanup) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
test('a saved default that is no longer installed is an explicit error, never a silent switch', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-term-missing-'));
  t_cleanup.push(home);
  let fishInstalled = true;
  const service = createTerminalProfiles({ home, platform: 'linux', env: {}, exists: () => fishInstalled });
  service.setDefault('fish');
  // The shell is later uninstalled: the saved default dangles.
  fishInstalled = false;
  const detection = service.detect();
  assert.equal(detection.defaultMissing, true);
  assert.equal(detection.defaultProfileId, undefined);
  assert.throws(() => service.resolve(), e => /no longer installed/.test(e.message) && e.rpc.code === -32046);
});

function terminalFixture(profilesService, spawnLog) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-term-int-'));
  t_cleanup.push(cwd);
  const spawn = (executable, args, options) => {
    const pty = fakePty();
    pty.startedWith = { executable, args, cwd: options.cwd };
    spawnLog.push(pty.startedWith);
    return pty;
  };
  const manager = createWorkspaceTerminal({
    spawn,
    profiles: profilesService,
    rpc: async (method, params) => ({ workspace: { id: 'test-project', cwd }, absolutePath: cwd, kind: 'directory' }),
  });
  const scope = { threadId: 'profiles-task', sessionId: randomUUID() };
  const call = (method, params = {}) => manager.handlers[`terminal/${method}`]({ ...scope, ...params });
  return { call, scope, manager };
}

test('terminal/open applies the chosen profile and a missing one fails explicitly', async () => {
  const picked = [];
  const service = {
    detect: () => ({ available: true, profiles: [{ id: 'git-bash', name: 'Git Bash', executable: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--noprofile', '--norc', '-i'] }], defaultProfileId: undefined }),
    resolve(requested) {
      if (requested === 'missing-shell') { const e = new Error('The terminal profile "missing-shell" is not installed on this host; pick another shell'); e.rpc = { code: -32046, message: e.message }; throw e; }
      const profile = requested === 'git-bash' ? { id: 'git-bash', name: 'Git Bash', executable: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--noprofile', '--norc', '-i'] } : undefined;
      picked.push(requested);
      return profile;
    },
    setDefault: id => ({ profiles: service.detect().profiles, defaultProfileId: id }),
  };
  const spawnLog = [];
  const f = terminalFixture(service, spawnLog);
  const opened = await f.call('open', { cols: 80, rows: 24, profileId: 'git-bash' });
  assert.equal(opened.shell, 'Git Bash', 'the terminal reports the actual shell');
  assert.equal(opened.profileId, 'git-bash');
  assert.equal(spawnLog[0].executable, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.deepEqual(spawnLog[0].args, ['--noprofile', '--norc', '-i']);
  assert.ok(spawnLog[0].cwd.includes('knorvia-term-int'), 'cwd still comes from the daemon scope');
  await assert.rejects(f.call('open', { sessionId: randomUUID(), cols: 80, rows: 24, profileId: 'missing-shell' }), e => e.rpc.code === -32046);
  // Without a requested profile and without a default, the platform fallback runs.
  await f.call('open', { sessionId: randomUUID(), cols: 80, rows: 24 });
  const platformDefault = spawnLog.at(-1);
  assert.ok(/powershell\.exe$/i.test(platformDefault.executable), 'no profile configured: platform default');
  // profile catalog handlers exist and report through the same service.
  const catalog = await f.call('profiles/list');
  assert.equal(catalog.available, true);
  assert.equal(catalog.profiles[0].id, 'git-bash');
  const saved = await f.call('profiles/default', { profileId: 'git-bash' });
  assert.equal(saved.defaultProfileId, 'git-bash');
});

test('changing the default never switches already-opened terminals; renderer executables stay rejected', async () => {
  let defaultProfile;
  const service = {
    detect: () => ({ available: true, profiles: [], defaultProfileId: defaultProfile, defaultProfile }),
    resolve: requested => (requested === undefined ? defaultProfile : undefined),
    setDefault: id => { defaultProfile = { id: id, name: 'New default', executable: 'C:\\new\\shell.exe', args: [] }; return { defaultProfileId: id }; },
  };
  const spawnLog = [];
  const f = terminalFixture(service, spawnLog);
  const first = await f.call('open', { cols: 80, rows: 24 });
  assert.equal(first.shell, 'PowerShell', 'started with the platform default');
  service.setDefault('git-bash');
  const second = await f.call('open', { sessionId: randomUUID(), cols: 80, rows: 24 });
  assert.equal(second.shell, 'New default');
  const firstAfter = await f.call('read', { sessionId: first.sessionId, cursor: 0 });
  assert.equal(firstAfter.sessionId, first.sessionId);
  assert.equal(firstAfter.profileId, undefined, 'the old terminal keeps its original shell identity');
  for (const extra of [{ executable: 'C:\\evil.exe' }, { shell: 'cmd.exe' }, { cwd: 'C:\\' }, { env: { PATH: 'bad' } }, { command: 'bad' }]) {
    await assert.rejects(f.call('open', { sessionId: randomUUID(), cols: 80, rows: 24, ...extra }), e => e.rpc.code === -32602);
  }
});

test('without host wiring the catalog reports unavailable and terminals keep working', async () => {
  const spawnLog = [];
  const f = terminalFixture(undefined, spawnLog);
  const catalog = await f.call('profiles/list');
  assert.equal(catalog.available, false);
  await assert.rejects(f.call('profiles/default', { profileId: 'git-bash' }), e => e.rpc.code === -32013);
  const opened = await f.call('open', { cols: 80, rows: 24 });
  assert.equal(opened.shell, 'PowerShell');
  assert.equal(spawnLog.length, 1);
});
