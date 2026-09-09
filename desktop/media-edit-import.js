'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('./studio-providers');
const { hash, normalizeEdit } = require('./media-composition-worker');

// Copy a pinned library version into the studio's immutable source cache.
// User paths never become renderer paths, and retries reuse verified bytes.
function createLibraryImport({ rpc, studio, library, lock, read, checkpoint, visible, worker }) {
  return async params => {
    await studio.initialize();
    const title = String(params.title || '素材剪辑').trim().slice(0, 100);
    const token = P.id(params.idempotencyKey);
    if (!Array.isArray(params.references) || !params.references.length || params.references.length > 40) P.fail('请选择 1–40 个视频');
    const references = params.references.map(ref => {
      const id = P.id(ref?.id);
      if (!/^[a-f0-9]{64}$/.test(ref?.version)) P.fail('请选择明确版本的视频素材');
      return { id, version: ref.version };
    });
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ title, references })).digest('hex');
    return lock(`library-${token}`, async () => {
      const job = await rpc('job/create', { workspaceId: studio.workspaceId(), type: 'studio.edit', idempotencyKey: `edit-library-${token}` });
      const existing = await read(job.id);
      if (existing.checkpoint) {
        if (existing.checkpoint.importFingerprint !== fingerprint) P.fail('此导入请求已用于其他素材');
        if (existing.checkpoint.edit) return visible(existing);
      }
      await checkpoint(job.id, { title, phase: 'importing', importFingerprint: fingerprint });
      const sources = [];
      let total = 0;
      for (const [index, ref] of references.entries()) {
        const temp = path.join(studio.root, `import-${crypto.randomUUID()}.tmp`);
        try {
          const fd = fs.openSync(temp, 'wx');
          let offset = 0, size, entry, extension;
          try {
            for (;;) {
              const part = await library.handlers['library/read']({ ...ref, offset });
              if (size === undefined) {
                size = part.size; entry = part.entry;
                extension = path.extname(entry.name).toLowerCase();
                if (!['.mp4', '.webm'].includes(extension)) P.fail('剪辑素材目前支持 MP4 和 WebM');
                if (!Number.isSafeInteger(size) || size <= 0 || size > 256 * 1024 ** 2 || (total += size) > 1024 ** 3) P.fail('单个视频最多 256 MB，一次导入最多 1 GB');
              }
              const bytes = Buffer.from(part.base64, 'base64');
              if (part.sha256 !== ref.version || part.size !== size || !bytes.length || offset + bytes.length > size) P.fail('素材版本或长度校验失败');
              fs.writeFileSync(fd, bytes); offset += bytes.length;
              if (part.nextOffset === null) { if (offset !== size) P.fail('素材读取不完整'); break; }
              if (part.nextOffset !== offset) P.fail('素材分块顺序不一致');
            }
          } finally { fs.closeSync(fd); }
          const info = await worker().probe(temp);
          if (info.sha256 !== ref.version) P.fail('素材内容校验失败');
          const name = `import-${info.sha256}${extension}`, destination = path.join(studio.root, name);
          try { fs.copyFileSync(temp, destination, fs.constants.COPYFILE_EXCL); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
          if (await hash(destination) !== info.sha256) P.fail('已缓存素材校验失败');
          sources.push({ id: `import-${index}`, origin: 'library', libraryId: ref.id, index, name, sha256: info.sha256, frames: info.frames, hasAudio: info.hasAudio, title: entry.name.slice(0, 100) });
        } finally { fs.rmSync(temp, { force: true }); }
      }
      const edit = normalizeEdit({ clips: sources.map(s => ({ id: s.id })) }, sources);
      return visible(await checkpoint(job.id, { title, revision: 1, sources, edit, phase: 'editing', importFingerprint: fingerprint }));
    });
  };
}
module.exports = { createLibraryImport };
