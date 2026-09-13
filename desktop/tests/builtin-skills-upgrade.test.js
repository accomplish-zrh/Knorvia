'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureBuiltinSkills, recoverBuiltinUpdates } = require('../builtin-skills');
const F = require('../extension-files');

const SKILL_ROOT = (home) => path.join(home, 'state', 'kernel', 'skills');
const ORIGINS = (home) => JSON.parse(fs.readFileSync(path.join(home, 'extensions', 'builtin', 'origins.json'), 'utf8'));

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-builtin-upgrade-'));
}

test('a pristine install is atomically upgraded to the new distribution content', () => {
  const home = tempHome();
  try {
    const first = ensureBuiltinSkills(home);
    assert.equal(first.every((r) => r.installed), true);
    const origins = ORIGINS(home);
    const sha = origins.skills['remotion-best-practices'].installedSha256;
    assert.match(sha, /^[0-9a-f]{64}$/);

    // Simulate a new app version shipping changed skill content.
    const source = path.join(__dirname, '..', 'builtin-skills', 'remotion-best-practices', 'SKILL.md');
    const original = fs.readFileSync(source, 'utf8');
    fs.writeFileSync(source, original + '\n<!-- distribution v2 -->\n');
    try {
      const second = ensureBuiltinSkills(home);
      const upgrade = second.find((r) => r.name === 'remotion-best-practices');
      assert.equal(upgrade.installed, true);
      assert.equal(upgrade.updated, true);
      assert.equal(upgrade.previousSha256, sha);
      assert.match(ORIGINS(home).skills['remotion-best-practices'].installedSha256, /^[0-9a-f]{64}$/);
      assert.notEqual(ORIGINS(home).skills['remotion-best-practices'].installedSha256, sha);
      assert.match(fs.readFileSync(path.join(SKILL_ROOT(home), 'remotion-best-practices', 'SKILL.md'), 'utf8'), /distribution v2/);
      assert.deepEqual(fs.readdirSync(path.join(home, 'extensions', 'builtin-staging')), [], 'no staging leftovers');
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(home, 'extensions', 'builtin', 'journal.json'), 'utf8')).updates,
        [], 'journal has no pending updates after a clean update',
      );
      // The other two skills are pristine but unchanged: reported as preserved.
      const untouched = second.find((r) => r.name === 'short-drama');
      assert.equal(untouched.preserved, true);
      assert.equal(untouched.pristine, true);
    } finally {
      fs.writeFileSync(source, original);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('user-modified skills are never overwritten and carry update-available info', () => {
  const home = tempHome();
  const sourceSkill = path.join(__dirname, '..', 'builtin-skills', 'short-drama', 'SKILL.md');
  const originalSource = fs.readFileSync(sourceSkill, 'utf8');
  try {
    ensureBuiltinSkills(home);
    const skillFile = path.join(SKILL_ROOT(home), 'short-drama', 'SKILL.md');
    fs.writeFileSync(skillFile, fs.readFileSync(skillFile, 'utf8') + '\n用户自定义改动\n');
    // A newer distribution also ships, so the preserved skill must be
    // reported as updatable.
    fs.writeFileSync(sourceSkill, originalSource + '\n<!-- distribution v4 -->\n');
    const results = ensureBuiltinSkills(home);
    const entry = results.find((r) => r.name === 'short-drama');
    assert.equal(entry.preserved, true);
    assert.equal(entry.installed, false);
    assert.equal(entry.userModified, true);
    assert.equal(entry.updateAvailable, true);
    assert.match(fs.readFileSync(skillFile, 'utf8'), /用户自定义改动/, 'user content survives');
    assert.equal(ORIGINS(home).skills['short-drama'].installedSha256, entry.installedSha256);
  } finally {
    fs.writeFileSync(sourceSkill, originalSource);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('legacy installs without a registry entry are preserved conservatively', () => {
  const home = tempHome();
  try {
    // Simulate an old installation that predates the origin registry.
    const target = path.join(SKILL_ROOT(home), 'learning-pack');
    fs.cpSync(path.join(__dirname, '..', 'builtin-skills', 'learning-pack'), target, { recursive: true });
    const results = ensureBuiltinSkills(home);
    const entry = results.find((r) => r.name === 'learning-pack');
    assert.equal(entry.preserved, true);
    assert.equal(entry.legacy, true);
    assert.equal(entry.installed, false);
    // The seeded skills alongside it still install and register normally.
    assert.equal(results.find((r) => r.name === 'short-drama').installed, true);
    assert.ok(fs.statSync(path.join(target, 'SKILL.md')).isFile());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an update interrupted between renames rolls back to the previous pristine version', () => {
  const home = tempHome();
  try {
    ensureBuiltinSkills(home);
    const origins = ORIGINS(home);
    const from = origins.skills['remotion-best-practices'].installedSha256;
    // Simulate the crash window: target renamed to backup, new content staged,
    // journal written, then the process died before the new rename.
    const target = path.join(SKILL_ROOT(home), 'remotion-best-practices');
    const backup = path.join(home, 'extensions', 'builtin', 'backup', `remotion-best-practices-interrupted`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.renameSync(target, backup);
    // Between the two atomic directory renames, the target does not exist.
    // An existing unknown target cannot be distinguished from a user edit.
    const journal = { version: 1, updates: [{ version: 1, name: 'remotion-best-practices', target, backup, from, to: 'deadbeef'.repeat(8), at: new Date().toISOString() }] };
    fs.writeFileSync(path.join(home, 'extensions', 'builtin', 'journal.json'), JSON.stringify(journal));
    const recovered = recoverBuiltinUpdates(home);
    assert.deepEqual(recovered, [{ name: 'remotion-best-practices', outcome: 'rolled-back' }]);
    // The restored directory is exactly the previous pristine distribution.
    assert.equal(F.scan(target).sha256, from);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'extensions', 'builtin', 'journal.json'), 'utf8')).updates.length, 0);
    // Existing skills (short-drama) remain discoverable after recovery.
    const results = ensureBuiltinSkills(home);
    assert.equal(results.find((r) => r.name === 'short-drama').preserved, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('recovery preserves a modified replacement at its original skill path across repeated restarts', () => {
  const home = tempHome();
  try {
    ensureBuiltinSkills(home);
    const name = 'short-drama';
    const target = path.join(SKILL_ROOT(home), name);
    const from = ORIGINS(home).skills[name].installedSha256;
    const backup = path.join(home, 'extensions', 'builtin', 'backup', 'before-upgrade');
    fs.cpSync(target, backup, { recursive: true });
    const skill = path.join(target, 'SKILL.md');
    fs.appendFileSync(skill, '\n用户在升级后修改的重要内容\n');
    const edited = fs.readFileSync(skill, 'utf8');
    const journalFile = path.join(home, 'extensions', 'builtin', 'journal.json');
    fs.writeFileSync(journalFile, JSON.stringify({ version: 1, updates: [{ version: 1, name, target, backup, from, to: '1'.repeat(64) }] }));
    for (let restart = 0; restart < 2; restart++) {
      assert.deepEqual(recoverBuiltinUpdates(home), []);
      const results = ensureBuiltinSkills(home);
      assert.equal(results.find(entry => entry.name === name).userModified, true);
      assert.equal(fs.readFileSync(skill, 'utf8'), edited);
      assert.equal(F.scan(backup).sha256, from);
      assert.equal(JSON.parse(fs.readFileSync(journalFile, 'utf8')).updates.length, 1);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('an update interrupted after the final rename is completed instead of rolled back', () => {
  const home = tempHome();
  try {
    ensureBuiltinSkills(home);
    const target = path.join(SKILL_ROOT(home), 'remotion-best-practices');
    const source = path.join(__dirname, '..', 'builtin-skills', 'remotion-best-practices', 'SKILL.md');
    const original = fs.readFileSync(source, 'utf8');
    fs.writeFileSync(source, original + '\n<!-- distribution v3 -->\n');
    try {
      ensureBuiltinSkills(home);
      const to = ORIGINS(home).skills['remotion-best-practices'].installedSha256;
      // Recreate the journal entry that a crash could have left behind even
      // though the new content is fully in place.
      const journal = { version: 1, updates: [{ version: 1, name: 'remotion-best-practices', target, backup: path.join(home, 'extensions', 'builtin', 'backup', 'missing'), from: 'a'.repeat(64), to, at: new Date().toISOString() }] };
      fs.writeFileSync(path.join(home, 'extensions', 'builtin', 'journal.json'), JSON.stringify(journal));
      const recovered = recoverBuiltinUpdates(home);
      assert.deepEqual(recovered, [{ name: 'remotion-best-practices', outcome: 'completed' }]);
      assert.equal(F.scan(target).sha256, to, 'the verified new version stays in place');
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'extensions', 'builtin', 'journal.json'), 'utf8')).updates.length, 0);
    } finally {
      fs.writeFileSync(source, original);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// X (06:18 item 2): the crash window between the final rename and
// saveOrigins leaves target=v2 with durable origins=v1 - recovery must
// repair the ledger so the pristine target is not misclassified forever.
test('a crash after the final rename repairs the origins ledger on recovery', t => {
  const home = tempHome();
  ensureBuiltinSkills(home);
  const source = path.join(__dirname, '..', 'builtin-skills', 'remotion-best-practices', 'SKILL.md');
  const original = fs.readFileSync(source, 'utf8');
  t.after(() => fs.writeFileSync(source, original));
  fs.writeFileSync(source, original + String.fromCharCode(10) + '<!-- distribution v5 -->' + String.fromCharCode(10));
  ensureBuiltinSkills(home);
  const v2 = ORIGINS(home).skills['remotion-best-practices'].installedSha256;
  const originsFile = path.join(home, 'extensions', 'builtin', 'origins.json');
  const stale = JSON.parse(fs.readFileSync(originsFile, 'utf8'));
  const target = path.join(SKILL_ROOT(home), 'remotion-best-practices');
  const staleHash = F.scan(target).sha256;
  stale.skills['remotion-best-practices'].installedSha256 = '0'.repeat(64);
  fs.writeFileSync(originsFile, JSON.stringify(stale));
  const journal = { version: 1, updates: [{ version: 1, name: 'remotion-best-practices', target, backup: path.join(home, 'extensions', 'builtin', 'backup', 'gone'), from: staleHash, to: v2, at: new Date().toISOString() }] };
  fs.writeFileSync(path.join(home, 'extensions', 'builtin', 'journal.json'), JSON.stringify(journal));
  const results = ensureBuiltinSkills(home);
  const entry = results.find((r) => r.name === 'remotion-best-practices');
  assert.equal(entry.userModified, undefined, 'the repaired ledger recognizes the pristine target');
  assert.equal(ORIGINS(home).skills['remotion-best-practices'].installedSha256, v2, 'the durable ledger was repaired to v2');
  assert.match(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), /distribution v5/, 'the recovered target stays');
  // A v3 upgrade then proceeds normally (not skipped as user-modified).
  fs.writeFileSync(source, original + String.fromCharCode(10) + '<!-- distribution v6 -->' + String.fromCharCode(10));
  const third = ensureBuiltinSkills(home);
  const upgraded = third.find((r) => r.name === 'remotion-best-practices');
  assert.equal(upgraded.installed, true);
  assert.equal(upgraded.updated, true);
  assert.match(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), /distribution v6/, 'the repaired ledger allows the next upgrade');
});

// X (07:34 review): restart at EVERY commit breakpoint of an interrupted
// v1->v2 upgrade. Where the journal survives, recovery must durably repair
// the ledger so the next upgrade (v3) still succeeds; where the journal is
// already gone (old-version crash state), the on-disk target must be
// protected like user content — never clobbered.
test('restart at each commit breakpoint: ledger repaired or content protected, user modifications always preserved', t => {
  const source = path.join(__dirname, '..', 'builtin-skills', 'remotion-best-practices', 'SKILL.md');
  const original = fs.readFileSync(source, 'utf8');
  const dramaSource = path.join(__dirname, '..', 'builtin-skills', 'short-drama', 'SKILL.md');
  const dramaOriginal = fs.readFileSync(dramaSource, 'utf8');
  t.after(() => { fs.writeFileSync(source, original); fs.writeFileSync(dramaSource, dramaOriginal); });

  // A reference Home upgraded v1 -> v2 for real, keeping the v1 backup copy.
  const reference = tempHome();
  try {
    ensureBuiltinSkills(reference);
    const from = ORIGINS(reference).skills['remotion-best-practices'].installedSha256;
    const v1Copy = path.join(reference, 'extensions', 'builtin', 'backup', 'v1-copy');
    fs.cpSync(path.join(SKILL_ROOT(reference), 'remotion-best-practices'), v1Copy, { recursive: true });
    fs.writeFileSync(source, `${original}\n<!-- distribution v2 -->\n`);
    ensureBuiltinSkills(reference);
    const to = ORIGINS(reference).skills['remotion-best-practices'].installedSha256;

    const originsFile = (home) => path.join(home, 'extensions', 'builtin', 'origins.json');
    const journalFile = (home) => path.join(home, 'extensions', 'builtin', 'journal.json');
    const remotionTarget = (home) => path.join(SKILL_ROOT(home), 'remotion-best-practices');

    const buildBreakpoint = (variant) => {
      const home = tempHome();
      fs.cpSync(reference, home, { recursive: true });
      // Rewind the durable ledger to v1, as every pre-saveOrigins crash leaves it.
      const origins = JSON.parse(fs.readFileSync(originsFile(home), 'utf8'));
      origins.skills['remotion-best-practices'].installedSha256 = from;
      fs.writeFileSync(originsFile(home), JSON.stringify(origins, null, 2));
      // A genuine user modification that must survive every restart.
      const dramaFile = path.join(SKILL_ROOT(home), 'short-drama', 'SKILL.md');
      fs.writeFileSync(dramaFile, `${fs.readFileSync(dramaFile, 'utf8')}\n用户自定义改动\n`);
      const backupDir = path.join(home, 'extensions', 'builtin', 'backup', 'bp-backup');
      const missingBackup = path.join(home, 'extensions', 'builtin', 'backup', 'deleted-before-crash');
      const entry = { version: 1, name: 'remotion-best-practices', target: remotionTarget(home), backup: missingBackup, from, to, at: new Date().toISOString() };
      if (variant === 'journal+backup' || variant === 'journal-only') {
        fs.writeFileSync(journalFile(home), JSON.stringify({ version: 1, updates: [entry] }));
        if (variant === 'journal+backup') {
          fs.mkdirSync(path.dirname(backupDir), { recursive: true });
          fs.cpSync(v1Copy, backupDir, { recursive: true });
          entry.backup = backupDir;
          fs.writeFileSync(journalFile(home), JSON.stringify({ version: 1, updates: [entry] }));
        }
      } else if (variant === 'no-journal-backup-present') {
        fs.mkdirSync(path.dirname(backupDir), { recursive: true });
        fs.cpSync(v1Copy, backupDir, { recursive: true });
      }
      return { home, dramaFile };
    };

    for (const variant of ['journal+backup', 'journal-only', 'no-journal-backup-present', 'no-journal-no-backup']) {
      const { home, dramaFile } = buildBreakpoint(variant);
      try {
        // Each iteration restarts against the v2 distribution; a previous
        // iteration must not leak its v3 source into this restart.
        fs.writeFileSync(source, `${original}\n<!-- distribution v2 -->\n`);
        const restarted = ensureBuiltinSkills(home);
        const entry = restarted.find((r) => r.name === 'remotion-best-practices');
        const withJournal = variant.startsWith('journal');
        if (withJournal) {
          // Recovery repaired the ledger durably before the journal cleared.
          assert.equal(ORIGINS(home).skills['remotion-best-practices'].installedSha256, to, `[${variant}] ledger repaired to v2`);
          assert.equal(JSON.parse(fs.readFileSync(journalFile(home), 'utf8')).updates.length, 0, `[${variant}] journal cleared`);
          assert.equal(entry.userModified, undefined, `[${variant}] pristine target not misclassified`);
        } else {
          // The journal is gone (old-version crash): content is protected.
          assert.equal(entry.userModified, true, `[${variant}] unrecorded target treated as user content`);
          assert.equal(entry.installed, false, `[${variant}] never auto-upgraded over unrecorded content`);
        }
        assert.match(fs.readFileSync(dramaFile, 'utf8'), /用户自定义改动/, `[${variant}] user modification survives the restart`);
        assert.match(fs.readFileSync(path.join(remotionTarget(home), 'SKILL.md'), 'utf8'), /distribution v2/, `[${variant}] the v2 target content stays`);

        // The next distribution (v3): journal-surviving breakpoints upgrade;
        // unrecorded ones keep protecting the content.
        fs.writeFileSync(source, `${original}\n<!-- distribution v2 -->\n<!-- distribution v3 -->\n`);
        const third = ensureBuiltinSkills(home);
        const upgraded = third.find((r) => r.name === 'remotion-best-practices');
        if (withJournal) {
          assert.equal(upgraded.installed, true, `[${variant}] v3 upgrade proceeds`);
          assert.equal(upgraded.updated, true, `[${variant}] v3 upgrade recorded`);
          assert.match(fs.readFileSync(path.join(remotionTarget(home), 'SKILL.md'), 'utf8'), /distribution v3/, `[${variant}] target is v3`);
          assert.equal(ORIGINS(home).skills['remotion-best-practices'].installedSha256, F.scan(remotionTarget(home)).sha256, `[${variant}] ledger matches disk after v3`);
        } else {
          assert.equal(upgraded.preserved, true, `[${variant}] v3 still preserves unrecorded content`);
        }
        assert.match(fs.readFileSync(dramaFile, 'utf8'), /用户自定义改动/, `[${variant}] user modification survives v3 cycle`);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(reference, { recursive: true, force: true });
  }
});
