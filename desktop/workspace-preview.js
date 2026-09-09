'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scopeParams, verifyResolvedPath } = require('./desktop-path-actions');
const { connectionError } = require('./connection-config');

const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

// UI media bytes use the same daemon-owned project scope as the file explorer.
// Never accept absolute renderer paths or fetch a remote URL on its behalf.
function createWorkspacePreview({ rpc }) {
  return { 'preview/read': async (params) => {
    const scoped = scopeParams(params);
    const selected = verifyResolvedPath(await rpc('workspace/path/resolve', scoped), scoped);
    if (selected.kind !== 'file') throw connectionError(-32602, 'Choose a file to preview');
    const mime = MIME[path.extname(selected.target).toLowerCase()];
    const handle = await fs.promises.open(selected.target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw connectionError(-32602, 'Choose a regular file to preview');
      if (!mime) return { supported: false, size: stats.size };
      if (stats.size > MAX_PREVIEW_BYTES) return { supported: true, tooLarge: true, size: stats.size, mime };
      // A growing file cannot turn the bounded read into an unbounded allocation.
      const buffer = Buffer.alloc(stats.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > stats.size) throw connectionError(-32042, 'The file changed while reading; refresh its preview');
      return { supported: true, size: length, mime, base64: buffer.subarray(0, length).toString('base64') };
    } finally { await handle.close(); }
  } };
}

module.exports = { createWorkspacePreview, MAX_PREVIEW_BYTES };
