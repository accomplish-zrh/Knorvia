'use strict';

// Electron-specific filesystem affordances. They never receive an absolute
// target chosen by the renderer: a persistent workspace/thread scope is
// resolved by the daemon first, then re-canonicalized before shell is called.

const fs = require('fs');
const path = require('path');
const { connectionError } = require('./connection-config');

function pathError(code, message, data) {
  return connectionError(code, message, data);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalExisting(candidate, fsImpl = fs) {
  try {
    return fsImpl.realpathSync.native ? fsImpl.realpathSync.native(candidate) : fsImpl.realpathSync(candidate);
  } catch {
    throw pathError(-32042, 'The selected workspace item no longer exists');
  }
}

function scopeParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw pathError(-32602, 'Desktop path params must be an object');
  }
  for (const key of Object.keys(params)) {
    if (!['workspaceId', 'threadId', 'path'].includes(key)) {
      throw pathError(-32602, `Desktop path action does not accept ${key}`);
    }
  }
  const out = {};
  for (const key of ['workspaceId', 'threadId']) {
    if (params[key] === undefined) continue;
    if (typeof params[key] !== 'string' || !params[key]) {
      throw pathError(-32602, `${key} must be a non-empty string`);
    }
    out[key] = params[key];
  }
  if (!out.workspaceId && !out.threadId) {
    throw pathError(-32602, 'workspaceId or threadId is required');
  }
  // The daemon treats an empty relative path as the persisted workspace root.
  // It remains scoped because the caller must still supply workspaceId or
  // threadId, and it is never an arbitrary absolute shell target.
  // `C:relative` is not `path.isAbsolute()` on Windows, yet it is still
  // drive-qualified and must never reach a scoped resolver as a relative
  // renderer path. `win32.parse(...).root` also catches UNC/device roots.
  if (typeof params.path !== 'string' || params.path.includes('\0')
    || path.isAbsolute(params.path) || path.win32.parse(params.path).root) {
    throw pathError(-32602, 'path must be a relative workspace path');
  }
  // Do not accept an escape attempt even before the daemon's canonical
  // resolver sees it.
  if (params.path.split(/[\\/]+/).includes('..')) {
    throw pathError(-32602, 'path must stay inside the selected workspace');
  }
  out.path = params.path;
  return out;
}

function verifyResolvedPath(resolved, requested = {}, fsImpl = fs) {
  if (!resolved || typeof resolved !== 'object'
    || !resolved.workspace || typeof resolved.workspace.cwd !== 'string'
    || typeof resolved.workspace.id !== 'string'
    || typeof resolved.absolutePath !== 'string') {
    throw pathError(-32041, 'The workspace path resolver returned an invalid scope');
  }
  if (requested.workspaceId && resolved.workspace.id !== requested.workspaceId) {
    throw pathError(-32041, 'The workspace path resolver returned a different persistent scope');
  }
  // The daemon's stable `absolutePath` field is already the canonical target.
  // Never use an input path or a symlink path supplied by the renderer.
  if (!['file', 'directory', 'symlink'].includes(resolved.kind)) {
    throw pathError(-32041, 'The selected workspace item cannot be opened safely');
  }
  const root = canonicalExisting(resolved.workspace.cwd, fsImpl);
  const target = canonicalExisting(resolved.absolutePath, fsImpl);
  if (!isInside(root, target)) {
    throw pathError(-32041, 'The selected workspace item is outside its persistent scope');
  }
  let stats;
  try { stats = fsImpl.statSync(target); } catch {
    throw pathError(-32042, 'The selected workspace item no longer exists');
  }
  if (stats.isDirectory()) return { root, target, kind: 'directory' };
  if (stats.isFile()) return { root, target, kind: 'file' };
  throw pathError(-32041, 'The selected workspace item cannot be opened safely');
}

function desktopUnavailable() {
  throw pathError(-32040, 'This file action is available only in the Knorvia desktop app', {
    transport: 'browser',
    restricted: true,
  });
}

function createDesktopPathActions({ rpc, dialog, shell, getWindow, fsImpl = fs } = {}) {
  if (typeof rpc !== 'function') throw new Error('desktop path actions require a scoped daemon RPC function');
  if (!dialog || typeof dialog.showOpenDialog !== 'function' || !shell) {
    throw new Error('desktop path actions require Electron dialog and shell');
  }

  async function resolve(params) {
    const scoped = scopeParams(params);
    const result = await rpc('workspace/path/resolve', scoped);
    return verifyResolvedPath(result, scoped, fsImpl);
  }

  async function selectFolder(params = {}) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw pathError(-32602, 'desktop/select-folder params must be an object');
    }
    for (const key of Object.keys(params)) {
      if (key !== 'defaultPath') throw pathError(-32602, `desktop/select-folder does not accept ${key}`);
    }
    let defaultPath;
    if (params.defaultPath !== undefined) {
      if (typeof params.defaultPath !== 'string' || params.defaultPath.includes('\0') || params.defaultPath.length > 4096) {
        throw pathError(-32602, 'defaultPath must be a local folder path');
      }
      try {
        const candidate = canonicalExisting(params.defaultPath, fsImpl);
        if (fsImpl.statSync(candidate).isDirectory()) defaultPath = candidate;
      } catch {
        // A stale starting folder should not make a user-driven chooser fail.
      }
    }
    // This is the one intentional path-selection exception: Electron displays
    // the native chooser, so the user—not renderer input—chooses the folder.
    const options = {
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath ? { defaultPath } : {}),
    };
    const owner = getWindow?.();
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    const selected = Array.isArray(result?.filePaths) ? result.filePaths[0] : undefined;
    if (result?.canceled || !selected) return { cancelled: true };
    const selectedPath = canonicalExisting(selected, fsImpl);
    try {
      if (!fsImpl.statSync(selectedPath).isDirectory()) {
        throw pathError(-32042, 'The selected location is not a folder');
      }
    } catch (error) {
      if (error?.rpc) throw error;
      throw pathError(-32042, 'The selected folder no longer exists');
    }
    return { cancelled: false, path: selectedPath };
  }

  async function openPath(params) {
    const selected = await resolve(params);
    const failure = await shell.openPath(selected.target);
    if (failure) throw pathError(-32043, 'The selected workspace item could not be opened');
    return { opened: true, kind: selected.kind };
  }

  async function openLocation(params = {}) {
    if (!params || typeof params !== 'object' || Array.isArray(params)
      || Object.keys(params).some(key => key !== 'location')
      || !['home', 'defaultTaskLocation', 'state', 'artifacts'].includes(params.location)) {
      throw pathError(-32602, 'Choose an application file location');
    }
      const locations = await rpc('system/paths', {});
      const root = canonicalExisting(locations.home, fsImpl);
      // On a fresh Home there may not be a projectless task yet. Materialize
      // only this daemon-defined immediate child, after checking its parent.
      if (params.location === 'defaultTaskLocation' && !fsImpl.existsSync(locations.defaultTaskLocation)) {
        const parent = canonicalExisting(path.dirname(locations.defaultTaskLocation), fsImpl);
        if (parent !== root) throw pathError(-32041, 'Application location is outside its data root');
        try { fsImpl.mkdirSync(path.join(parent, path.basename(locations.defaultTaskLocation))); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const target = canonicalExisting(locations[params.location], fsImpl);
    if (!isInside(root, target) || !fsImpl.statSync(target).isDirectory()) throw pathError(-32041, 'Application location is outside its data root');
    if (await shell.openPath(target)) throw pathError(-32043, 'This application folder could not be opened');
    return { opened: true };
  }

  async function revealPath(params) {
    const selected = await resolve(params);
    try {
      shell.showItemInFolder(selected.target);
    } catch {
      throw pathError(-32043, 'The selected workspace item could not be revealed');
    }
    return { revealed: true, kind: selected.kind };
  }

  return {
    handlers: {
      'desktop/select-folder': selectFolder,
      'desktop/open-path': openPath,
      'desktop/reveal-path': revealPath,
      'desktop/open-location': openLocation,
    },
    openPath,
    revealPath,
    selectFolder,
  };
}

function browserDesktopPathHandlers() {
  return {
    'desktop/select-folder': desktopUnavailable,
    'desktop/open-path': desktopUnavailable,
    'desktop/reveal-path': desktopUnavailable,
    'desktop/open-location': desktopUnavailable,
  };
}

module.exports = {
  browserDesktopPathHandlers,
  canonicalExisting,
  createDesktopPathActions,
  desktopUnavailable,
  isInside,
  scopeParams,
  verifyResolvedPath,
};
