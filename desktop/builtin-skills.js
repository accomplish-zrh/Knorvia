'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { randomUUID } = require('node:crypto');
const F = require('./extension-files');

// Seed whole skill directories before Kernel discovery, and upgrade only
// pristine installs. The distribution hash of every seeded skill is recorded
// in an origin registry next to the skills tree; a later startup may replace
// the directory atomically ONLY when its current content still matches the
// recorded install hash. User-modified skills and legacy installs without a
// registry entry are always preserved and only reported as updatable. An
// interrupted upgrade is recovered from a journal on the next startup, so no
// half-installed package is ever left behind.

const BUILTIN_SKILLS = ['remotion-best-practices', 'learning-pack', 'creative-brief', 'short-drama'];
const ORIGINS_VERSION = 1;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const renameWait = new Int32Array(new SharedArrayBuffer(4));

function hasEntry(target) {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}

function renameWithRetry(source, target) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(source, target);
      return;
    } catch (error) {
      // Windows scanners can briefly hold a freshly copied directory. Keep
      // the atomic rename; never fall back to copying over user content.
      // Total wait is <= 400 ms.
      if (!RENAME_RETRY_CODES.has(error.code) || attempt >= 4) throw error;
      Atomics.wait(renameWait, 0, 0, 100);
    }
  }
}

function builtinDir(home) {
  return path.join(home, 'extensions', 'builtin');
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temp, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    // A failed atomic replace must leave the prior complete ledger intact.
    // Copying over it would introduce a second crash window in recovery.
    renameWithRetry(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function loadOrigins(home) {
  const parsed = readJson(path.join(builtinDir(home), 'origins.json'));
  if (parsed?.version !== ORIGINS_VERSION || typeof parsed.skills !== 'object') return { version: ORIGINS_VERSION, skills: {} };
  return parsed;
}

function saveOrigins(home, origins) {
  writeJsonAtomic(path.join(builtinDir(home), 'origins.json'), origins);
}

function readJournal(home) {
  const parsed = readJson(path.join(builtinDir(home), 'journal.json'));
  return Array.isArray(parsed?.updates) ? parsed : { version: ORIGINS_VERSION, updates: [] };
}

function saveJournal(home, journal) {
  writeJsonAtomic(path.join(builtinDir(home), 'journal.json'), journal);
}

// Complete or roll back an update that was interrupted between its renames.
// Only verifiable states are acted on; anything ambiguous keeps the user's
// current directory untouched.
function recoverBuiltinUpdates(home, origins = null) {
  const journal = readJournal(home);
  if (!journal.updates.length) return [];
  const ownsOrigins = !origins;
  const store = origins ?? loadOrigins(home);
  const recovered = [];
  const remaining = [];
  for (const entry of journal.updates) {
    const targetValid = (() => {
      try { return hasEntry(entry.target) && F.scan(entry.target).sha256 === entry.to; } catch { return false; }
    })();
    const backupValid = (() => {
      try { return entry.backup && hasEntry(entry.backup) && F.scan(entry.backup).sha256 === entry.from; } catch { return false; }
    })();
    if (targetValid) {
      if (store.skills[entry.name]) {
        store.skills[entry.name] = { ...store.skills[entry.name], installedSha256: entry.to, updatedAt: new Date().toISOString() };
      } else {
        store.skills[entry.name] = { installedSha256: entry.to, installedAt: new Date().toISOString() };
      }
      saveOrigins(home, store);
      if (entry.backup && hasEntry(entry.backup)) {
        try { F.removeOwned(builtinDir(home), entry.backup); } catch { /* keep for manual cleanup */ }
      }
      recovered.push({ name: entry.name, outcome: 'completed' });
      continue;
    }
    if (backupValid && !hasEntry(entry.target)) {
      try {
        fs.mkdirSync(builtinDir(home), { recursive: true });
        renameWithRetry(entry.backup, entry.target);
        store.skills[entry.name] = { ...store.skills[entry.name], installedSha256: entry.from };
        saveOrigins(home, store);
        recovered.push({ name: entry.name, outcome: 'rolled-back' });
        continue;
      } catch { /* fall through: keep the journal entry for the next start */ }
    }
    // An existing target with an unexpected digest can be a user's edit
    // after the final rename. Keep it at its discoverable path; neither a
    // valid old backup nor a stale journal authorizes replacing that edit.
    remaining.push(entry);
  }
  saveJournal(home, { version: ORIGINS_VERSION, updates: remaining });
  if (ownsOrigins) saveOrigins(home, store);
  return recovered;
}

function seedSkill(home, root, name, origins) {
  const source = path.join(__dirname, 'builtin-skills', name);
  const target = path.join(root, name);
  const staging = path.join(home, 'extensions', 'builtin-staging');
  const temp = path.join(staging, randomUUID());
  fs.mkdirSync(staging, { recursive: true });
  try {
    const manifest = F.copy(source, temp);
    const sourceSha256 = manifest.sha256;
    const origin = origins.skills[name];

    if (!hasEntry(target)) {
      for (let attempt = 0; ; attempt++) {
        // Another desktop/gateway may have seeded this Home while we copied
        // or waited. Preserve every existing entry, including a symlink.
        if (hasEntry(target)) break;
        try {
          // Plain rename here: this loop already implements the bounded
          // retry (5 attempts, <= 400 ms) and must not multiply with the
          // helper's own retries.
          fs.renameSync(temp, target);
          origins.skills[name] = { installedSha256: sourceSha256, installedAt: new Date().toISOString() };
          saveOrigins(home, origins);
          return { installed: true, name, sha256: sourceSha256 };
        } catch (error) {
          if (hasEntry(target)) break;
          if (!RENAME_RETRY_CODES.has(error.code) || attempt >= 4) throw error;
          Atomics.wait(renameWait, 0, 0, 100);
        }
      }
      return { installed: false, preserved: true };
    }

    if (!origin || typeof origin.installedSha256 !== 'string') {
      // First legacy install without a registry entry: conservative — never
      // upgraded in place, only reported.
      return { installed: false, preserved: true, legacy: true, name, sourceSha256 };
    }

    let currentSha256;
    try { currentSha256 = F.scan(target).sha256; } catch { currentSha256 = null; }
    if (currentSha256 !== origin.installedSha256) {
      return {
        installed: false,
        preserved: true,
        userModified: true,
        name,
        updateAvailable: sourceSha256 !== origin.installedSha256,
        sourceSha256,
        installedSha256: origin.installedSha256,
      };
    }

    if (sourceSha256 === origin.installedSha256) {
      return { installed: false, preserved: true, pristine: true, name, sha256: sourceSha256 };
    }

    return atomicUpdate(home, { name, target, temp, from: origin.installedSha256, to: sourceSha256, origins });
  } finally {
    if (fs.existsSync(temp)) F.removeOwned(staging, temp);
  }
}

function atomicUpdate(home, { name, target, temp, from, to, origins }) {
  const dir = builtinDir(home);
  const backup = path.join(dir, 'backup', `${name}-${randomUUID()}`);
  const journal = readJournal(home);
  journal.updates.push({ version: ORIGINS_VERSION, name, target, backup, from, to, at: new Date().toISOString() });
  saveJournal(home, journal);
  try {
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    renameWithRetry(target, backup);
    renameWithRetry(temp, target);
    if (F.scan(target).sha256 !== to) throw new Error('Seeded skill content does not match its distribution manifest');
    origins.skills[name] = { installedSha256: to, installedAt: origins.skills[name]?.installedAt, updatedAt: new Date().toISOString() };
    saveOrigins(home, origins);
    const updatedJournal = readJournal(home);
    updatedJournal.updates = updatedJournal.updates.filter((entry) => entry.target !== target || entry.to !== to);
    saveJournal(home, updatedJournal);
    try { if (hasEntry(backup)) F.removeOwned(dir, backup); } catch { /* keep for manual cleanup */ }
    return { installed: true, updated: true, name, sha256: to, previousSha256: from };
  } catch (error) {
    // The journal stays until the origins ledger is durably updated; the
    // next startup either completes or rolls the update back, so no
    // half-installed package and no unrecorded upgrade is left behind.
    try {
      const updatedJournal = readJournal(home);
      if (hasEntry(target) && !hasEntry(temp)) {
        const finished = updatedJournal.updates.find((entry) => entry.target === target && entry.to === to);
        if (finished && F.scan(target).sha256 === to) {
          origins.skills[name] = { installedSha256: to, updatedAt: new Date().toISOString() };
          saveOrigins(home, origins);
          updatedJournal.updates = updatedJournal.updates.filter((entry) => entry !== finished);
          saveJournal(home, updatedJournal);
          try { if (hasEntry(backup)) F.removeOwned(dir, backup); } catch { /* keep for manual cleanup */ }
          return { installed: true, updated: true, name, sha256: to, previousSha256: from };
        }
      }
    } catch { /* fall through to the original failure */ }
    throw error;
  }
}

function ensureBuiltinSkills(home) {
  const root = path.join(home, 'state', 'kernel', 'skills');
  fs.mkdirSync(root, { recursive: true });
  const origins = loadOrigins(home);
  recoverBuiltinUpdates(home, origins);
  const results = [];
  for (const name of BUILTIN_SKILLS) results.push(seedSkill(home, root, name, origins));
  saveOrigins(home, origins);
  return results;
}

module.exports = { ensureBuiltinSkills, recoverBuiltinUpdates };
