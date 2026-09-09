'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const F = require('./extension-files');

// Seed whole skill directories before Kernel discovery. Existing directories
// belong to the user: never overwrite edits or recreate disabled config entries.
const BUILTIN_SKILLS = ['remotion-best-practices', 'learning-pack'];
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const renameWait = new Int32Array(new SharedArrayBuffer(4));

function hasEntry(target) {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}

function ensureBuiltinSkills(home) {
  const root = path.join(home, 'state', 'kernel', 'skills');
  fs.mkdirSync(root, { recursive: true });
  const results = [];
  for (const name of BUILTIN_SKILLS) results.push(seedSkill(home, root, name));
  return results;
}

function seedSkill(home, root, name) {
  const source = path.join(__dirname, 'builtin-skills', name);
  const target = path.join(root, name);
  if (hasEntry(target)) return { installed: false, preserved: true };
  const staging = path.join(home, 'extensions', 'builtin-staging');
  const temp = path.join(staging, randomUUID());
  fs.mkdirSync(staging, { recursive: true });
  try {
    const manifest = F.copy(source, temp);
    for (let attempt = 0; ; attempt++) {
      // Another desktop/gateway may have seeded this Home while we copied or
      // waited. Preserve every existing entry, including a dangling symlink.
      if (hasEntry(target)) return { installed: false, preserved: true };
      try { fs.renameSync(temp, target); break; }
      catch (error) {
        if (hasEntry(target)) return { installed: false, preserved: true };
        // Windows scanners can briefly hold a freshly copied directory. Keep
        // the atomic rename and synchronous discovery contract; never fall
        // back to copying over the user's directory. Total wait is <= 400 ms.
        if (!RENAME_RETRY_CODES.has(error.code) || attempt >= 4) throw error;
        Atomics.wait(renameWait, 0, 0, 100);
      }
    }
    return { installed: true, name, sha256: manifest.sha256 };
  } finally {
    if (fs.existsSync(temp)) F.removeOwned(staging, temp);
  }
}
module.exports = { ensureBuiltinSkills };
