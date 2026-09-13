'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Legacy workspace migration with a recoverable failure state. The historical
// behaviour lost to a bare rename error: startup died and the user had no way
// back to their old data. Now a blocked rename keeps the legacy directory
// untouched, records a bounded code-only pending state (never user content),
// and lets the startup recovery screen retry idempotently. The migration
// stays rename-only and atomic: no unverified partial copies, and an existing
// target is never overwritten.

const MIGRATION_STATE_VERSION = 1;
const STATE_FILE_NAME = 'pending-workspace-migration.json';
const LEGACY_PRODUCT = ['Deep', 'Tutor'].join('');

function legacyCandidates(parent) {
  return [
    path.join(parent, `${LEGACY_PRODUCT}-data`),
    path.join(parent, LEGACY_PRODUCT, 'workspace'),
  ];
}

function migrationStatePath(userDataDir) {
  return path.join(userDataDir, STATE_FILE_NAME);
}

function readPendingMigration(userDataDir, fsImpl = fs) {
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(migrationStatePath(userDataDir), 'utf8'));
  } catch {
    return null;
  }
  if (parsed?.version !== MIGRATION_STATE_VERSION
    || typeof parsed.parent !== 'string'
    || typeof parsed.target !== 'string') return null;
  return parsed;
}

function writePendingMigration(userDataDir, state, fsImpl = fs) {
  fsImpl.mkdirSync(userDataDir, { recursive: true });
  const file = migrationStatePath(userDataDir);
  const temp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(temp, JSON.stringify({ version: MIGRATION_STATE_VERSION, ...state }, null, 2), 'utf8');
  try {
    fsImpl.renameSync(temp, file);
  } catch {
    fsImpl.copyFileSync(temp, file);
    fsImpl.unlinkSync(temp);
  }
}

function clearPendingMigration(userDataDir, fsImpl = fs) {
  try { fsImpl.unlinkSync(migrationStatePath(userDataDir)); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

// One bounded migration attempt. Rename-only: on failure the legacy directory
// is exactly where it was, and an existing target is never touched.
function attemptMigration({ parent, target, fsImpl = fs }) {
  if (fsImpl.existsSync(target)) return { status: 'ready', root: target, migrated: [] };
  const existing = legacyCandidates(parent).filter((legacy) => fsImpl.existsSync(legacy));
  if (!existing.length) return { status: 'ready', root: target, migrated: [] };
  try {
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
  } catch (error) {
    return { status: 'blocked', root: null, legacy: existing[0], target, code: error?.code || 'UNKNOWN', operation: 'prepare' };
  }
  const legacy = existing[0];
  try {
    fsImpl.renameSync(legacy, target);
    return { status: 'ready', root: target, migrated: [path.basename(legacy)] };
  } catch (error) {
    return { status: 'blocked', root: null, legacy, target, code: error?.code || 'UNKNOWN', operation: 'rename' };
  }
}

// Mirrors the historical workspaceRoot() decision tree, but reports a typed
// blocked outcome instead of throwing past startup with no recovery entry.
function resolveWorkspaceRoot({
  envRoot,
  packaged,
  devFallbackRoot,
  portableDir,
  exeDir,
  appDataPath,
  userDataPath,
  fsImpl = fs,
} = {}) {
  if (envRoot) {
    if (!path.isAbsolute(envRoot)) return { status: 'invalid-env' };
    return { status: 'ready', root: path.resolve(envRoot), migrated: [] };
  }
  if (!packaged) return { status: 'ready', root: devFallbackRoot, migrated: [] };
  let parent;
  let target;
  if (portableDir) {
    parent = portableDir;
    target = path.join(parent, 'Knorvia-data');
  } else if (exeDir && fsImpl.existsSync(path.join(exeDir, 'portable.marker'))) {
    parent = exeDir;
    target = path.join(parent, 'Knorvia-data');
  } else {
    parent = appDataPath;
    target = path.join(userDataPath, 'workspace');
  }
  return { parent, target, ...attemptMigration({ parent, target, fsImpl }) };
}

// Recovery-screen entry: idempotent retry driven by the persisted pending
// state. Success (including "target already exists") clears the state; a
// repeat failure refreshes the recorded code and keeps the state.
function retryPendingMigration(userDataDir, fsImpl = fs) {
  const pending = readPendingMigration(userDataDir, fsImpl);
  if (!pending) return { status: 'idle' };
  const outcome = attemptMigration({ parent: pending.parent, target: pending.target, fsImpl });
  if (outcome.status === 'ready') {
    clearPendingMigration(userDataDir, fsImpl);
    return { ...outcome, retried: true };
  }
  writePendingMigration(userDataDir, {
    parent: pending.parent,
    target: pending.target,
    code: outcome.code,
    operation: outcome.operation,
    at: new Date().toISOString(),
  }, fsImpl);
  return { ...outcome, retried: true };
}

module.exports = {
  MIGRATION_STATE_VERSION,
  STATE_FILE_NAME,
  attemptMigration,
  clearPendingMigration,
  legacyCandidates,
  readPendingMigration,
  resolveWorkspaceRoot,
  retryPendingMigration,
  writePendingMigration,
};
