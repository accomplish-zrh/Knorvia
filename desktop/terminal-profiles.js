'use strict';

// C18: host-managed terminal profiles. Detection only ever offers shells the
// host knows how to launch, from fixed well-known locations or PATH lookups
// performed by the host itself - the renderer keeps naming a profile ID and
// can never supply an executable, arguments, environment or cwd. The user's
// default choice persists in a small config file under the application Home.

const fs = require('node:fs');
const path = require('node:path');
const { connectionError } = require('./connection-config');

const fail = (code, message) => { throw connectionError(code, message); };
const VALID_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;

// `exists` is injectable for tests; a bare name (on PATH) cannot be checked
// synchronously and is trusted to the OS spawn-time resolution.
function detectProfiles({ platform = process.platform, env = process.env, exists = candidate => candidate.includes(path.sep) || candidate.includes('/') ? fs.existsSync(candidate) : true } = {}) {
  const profiles = [];
  const add = (id, name, executable, args) => {
    if (!VALID_ID.test(id)) return;
    if (executable && exists(executable)) profiles.push({ id, name, executable, args });
  };
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || 'C:\\Windows';
    const programFiles = env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    add('windows-powershell', 'Windows PowerShell', path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile']);
    add('powershell', 'PowerShell 7', path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'), ['-NoLogo', '-NoProfile']);
    add('powershell-preview', 'PowerShell 7 (preview)', path.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'), ['-NoLogo', '-NoProfile']);
    add('git-bash', 'Git Bash', path.join(programFiles, 'Git', 'bin', 'bash.exe'), ['--noprofile', '--norc', '-i']);
    add('git-bash', 'Git Bash (x86)', path.join(programFilesX86, 'Git', 'bin', 'bash.exe'), ['--noprofile', '--norc', '-i']);
  } else {
    for (const [id, name, executable, args] of [
      ['bash', 'Bash', '/bin/bash', ['--noprofile', '--norc']],
      ['bash', 'Bash', '/usr/bin/bash', ['--noprofile', '--norc']],
      ['zsh', 'Zsh', '/bin/zsh', ['-f']],
      ['zsh', 'Zsh', '/usr/bin/zsh', ['-f']],
      ['fish', 'Fish', '/bin/fish', ['--no-config']],
      ['fish', 'Fish', '/usr/bin/fish', ['--no-config']],
    ]) add(id, name, executable, args);
  }
  // Later duplicates of one id (x86 fallback) only win if the first is gone.
  const unique = new Map();
  for (const profile of profiles) if (!unique.has(profile.id)) unique.set(profile.id, profile);
  return [...unique.values()];
}

function createTerminalProfiles({ home, platform = process.platform, env = process.env, exists } = {}) {
  const file = home ? path.join(home, 'config', 'terminal-profile.json') : null;
  const detectOptions = { platform, env, ...(exists ? { exists } : {}) };
  function readDefault() {
    if (!file) return undefined;
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      return undefined; // an unreadable preference degrades to "no default"
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version !== 1 || typeof parsed.defaultProfileId !== 'string' || !VALID_ID.test(parsed.defaultProfileId)) return undefined;
      return parsed.defaultProfileId;
    } catch { return undefined; }
  }
  function writeDefault(id) {
    if (!file) fail(-32013, 'Terminal profile preferences need the application Home');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, defaultProfileId: id }, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
    } finally { try { fs.unlinkSync(temp); } catch { /* best effort */ } }
  }
  return {
    detect() {
      const profiles = detectProfiles(detectOptions);
      const defaultProfileId = readDefault();
      const defaultProfile = profiles.find(profile => profile.id === defaultProfileId);
      return { profiles, defaultProfileId: defaultProfile ? defaultProfileId : undefined, defaultMissing: Boolean(defaultProfileId) && !defaultProfile, defaultProfile };
    },
    // resolve() never falls back silently: an explicitly chosen profile that
    // is not installed is an error, and only an unconfigured default yields
    // the platform fallback.
    resolve(requestedProfileId) {
      const detection = this.detect();
      if (requestedProfileId !== undefined) {
        if (typeof requestedProfileId !== 'string' || !VALID_ID.test(requestedProfileId)) fail(-32602, 'Terminal profile ids are short alphanumeric strings');
        const profile = detection.profiles.find(candidate => candidate.id === requestedProfileId);
        if (!profile) fail(-32046, `The terminal profile "${requestedProfileId}" is not installed on this host; pick another shell`);
        return profile;
      }
      if (detection.defaultProfile) return detection.defaultProfile;
      if (detection.defaultMissing) fail(-32046, `The default terminal profile is no longer installed; pick another shell in settings`);
      return undefined;
    },
    setDefault(profileId) {
      const detection = this.detect();
      if (profileId === null || profileId === undefined || profileId === '') { writeDefault(''); return { profiles: detection.profiles, defaultProfileId: undefined }; }
      const profile = detection.profiles.find(candidate => candidate.id === profileId);
      if (!profile) fail(-32602, `The terminal profile "${profileId}" is not installed on this host`);
      writeDefault(profile.id);
      return { profiles: detection.profiles, defaultProfileId: profile.id };
    },
  };
}

module.exports = { createTerminalProfiles, detectProfiles, VALID_ID };
