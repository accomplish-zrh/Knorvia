'use strict';

// Resolve a self-contained Next standalone renderer for source Electron runs.
// The old staged Python package remains a release compatibility fallback; a
// developer can now point KNORVIA_WEB_DIR at web/.next/standalone directly.

const fs = require('fs');
const path = require('path');

function directory(value) {
  try { return value && fs.statSync(value).isDirectory() ? value : null; } catch { return null; }
}

function hostableRoot(candidate) {
  if (!directory(candidate)) return null;
  const distCandidates = ['.next', '.next-knorvia'];
  for (const distDir of distCandidates) {
    const required = path.join(candidate, distDir, 'required-server-files.json');
    if (fs.existsSync(required) && fs.existsSync(path.join(candidate, 'node_modules', 'next'))) {
      return { webRoot: candidate, distDir, source: 'standalone' };
    }
  }
  return null;
}

function expandWebDir(candidate) {
  if (!candidate || typeof candidate !== 'string') return [];
  const root = path.resolve(candidate);
  return [
    root,
    path.join(root, '.next', 'standalone'),
    path.join(root, '.next-knorvia', 'standalone'),
  ];
}

function resolveWebRenderer({ webDir, runtimeRoot } = {}) {
  const preferred = expandWebDir(webDir);
  const fallbacks = runtimeRoot
    ? [path.join(runtimeRoot, 'web'), path.join(runtimeRoot, 'python', 'Lib', 'site-packages', 'knorvia_web')] : [];
  for (const candidate of [...preferred, ...fallbacks]) {
    const resolved = hostableRoot(candidate);
    if (!resolved) continue;
    resolved.source = preferred.includes(candidate) ? 'KNORVIA_WEB_DIR' : 'staged-runtime';
    return resolved;
  }
  throw new Error('Desktop renderer resources were not found. Set KNORVIA_WEB_DIR to a built Next standalone directory or prepare the staged runtime.');
}

function resolveNodeLauncher({ runtimeRoot, env = process.env, electronExecPath = process.execPath } = {}) {
  const configured = typeof env.KNORVIA_NODE_BIN === 'string' && env.KNORVIA_NODE_BIN.trim()
    ? path.resolve(env.KNORVIA_NODE_BIN) : null;
  const staged = runtimeRoot ? path.join(runtimeRoot, 'node', process.platform === 'win32' ? 'node.exe' : 'node') : null;
  for (const candidate of [configured, staged]) {
    if (candidate && fs.existsSync(candidate)) return { command: candidate, useElectronAsNode: false };
  }
  // Electron can run a regular CommonJS host with this environment flag. It
  // keeps a source workbench independent from the old staged Node/Python tree.
  if (electronExecPath && fs.existsSync(electronExecPath)) {
    return { command: electronExecPath, useElectronAsNode: true };
  }
  throw new Error('No Node runtime is available for the desktop renderer. Set KNORVIA_NODE_BIN.');
}

module.exports = {
  expandWebDir,
  hostableRoot,
  resolveNodeLauncher,
  resolveWebRenderer,
};
