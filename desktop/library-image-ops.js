'use strict';

// Library image local processing (KNORVIA-NIGHT B15): crop, scale and format
// conversion through the bundled FFmpeg, always writing a NEW library entry
// that records its immutable source (id+version). No paid or cloud tools.

const path = require('node:path');
const { resolveBinaries } = require('./media-frame-worker');

const fail = (message, code = -32602) => { const error = new Error(message); error.rpc = { code, message }; throw error; };

const FORMATS = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const SOURCE_SUFFIX = /\.(png|jpe?g|webp|gif)$/i;

function intArg(value, name, min = 1) {
  if (!Number.isSafeInteger(value) || value < min) fail(`参数 ${name} 必须是 ≥${min} 的整数`);
  return value;
}

function buildFilter(ops) {
  const filters = [];
  if (ops.crop) {
    const x = intArg(ops.crop.x, 'crop.x', 0), y = intArg(ops.crop.y, 'crop.y', 0);
    const w = intArg(ops.crop.width, 'crop.width'), h = intArg(ops.crop.height, 'crop.height');
    filters.push(`crop=w=${w}:h=${h}:x=${x}:y=${y}`);
  }
  if (ops.scale) {
    if (ops.scale.width && ops.scale.height) filters.push(`scale=w=${intArg(ops.scale.width, 'scale.width')}:h=${intArg(ops.scale.height, 'scale.height')}`);
    else if (ops.scale.width) filters.push(`scale=w=${intArg(ops.scale.width, 'scale.width')}:h=-1`);
    else if (ops.scale.height) filters.push(`scale=w=-1:h=${intArg(ops.scale.height, 'scale.height')}`);
    else fail('scale 需要 width 或 height');
  }
  if (!filters.length) fail('至少需要一个加工操作（crop 或 scale）');
  return filters.join(',');
}

const { execFile } = require('node:child_process');
const run = (file, args, timeoutMs = 120000) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8192 * 1024 }, (error, stdout, stderr) => {
    if (error) { error.stderrText = String(stderr || ''); reject(error); return; }
    resolve({ stdout: String(stdout || '') });
  });
});

function createLibraryImageOps({ library } = {}) {
  if (!library?.handlers) throw new Error('Image ops require the personal library');
  const { createFrameWorker } = require('./media-frame-worker');
  const frameWorker = createFrameWorker({});
  const fs = require('node:fs');
  const VIDEO_SUFFIX = /\.(mp4|webm)$/i;

  // Read a pinned version of a library entry into a temp file, run a local
  // op on it, publish the result as a NEW library entry, clean up.
  async function withPinnedVersion(entry, version, extension, op) {
    const temp = path.join(library.root, '.knorvia-library', 'uploads', `op-${entry.id}-${version.slice(0, 12)}${extension}`);
    const handle = fs.openSync(temp, 'wx');
    try {
      let offset = 0; let size; let sha256;
      for (;;) {
        const part = await library.handlers['library/read']({ id: entry.id, version, offset });
        if (size === undefined) { size = part.size; sha256 = part.sha256; }
        fs.writeFileSync(handle, Buffer.from(part.base64, 'base64'));
        offset = part.nextOffset ?? offset;
        if (part.nextOffset === null) break;
      }
      if (sha256 !== version) fail('素材版本校验失败');
      fs.closeSync(handle);
      return await op(temp);
    } finally {
      try { fs.closeSync(handle); } catch {}
      fs.rmSync(temp, { force: true });
    }
  }

  const commands = {
    'library/image/process': async params => {
      const suffix = /\.([a-z0-9]+)$/i;
      const format = String(params.format ?? 'png').toLowerCase();
      if (!FORMATS[format]) fail(`不支持的输出格式 ${format}；支持 ${Object.keys(FORMATS).join('/')}`);
      const filter = buildFilter({ crop: params.crop, scale: params.scale });
      const index = await library.handlers['library/list']();
      const entry = index.entries.find(item => !item.trashedAt && item.id === params.libraryId);
      if (!entry) fail('找不到源图片', -32004);
      if (!SOURCE_SUFFIX.test(entry.name)) fail('图片加工只支持库内 PNG/JPEG/WebP/GIF');
      const version = params.version ?? entry.sha256;
      const { ffmpeg } = resolveBinaries();
      const base = entry.name.replace(suffix, '');
      const outputName = `${base}-加工-${Date.now()}.${format}`;
      const temp = path.join(library.root, '.knorvia-library', 'uploads', `${outputName}.tmp`);
      await run(ffmpeg, ['-v', 'error', '-i', path.join(library.root, '.knorvia-library', 'versions', entry.id, version), '-frames:v', '1', '-vf', filter, '-f', 'image2', '-y', temp], 120000);
      try {
        const written = await library.put(temp, `素材加工/${outputName}`);
        return {
          entry: written,
          source: { libraryId: entry.id, version, path: entry.path },
          ops: JSON.parse(JSON.stringify({ crop: params.crop, scale: params.scale, format })),
        };
      } finally {
        fs.rmSync(temp, { force: true });
      }
    },

    'library/video/extract-frame': async params => {
      const index = await library.handlers['library/list']();
      const entry = index.entries.find(item => !item.trashedAt && item.id === params.libraryId);
      if (!entry) fail('找不到源视频', -32004);
      if (!VIDEO_SUFFIX.test(entry.name)) fail('尾帧提取只支持库内 MP4/WebM');
      const version = params.version ?? entry.sha256;
      const target = path.join(library.root, '.knorvia-library', 'uploads', `tail-${entry.id}-${Date.now()}.png`);
      try {
        const result = await withPinnedVersion(entry, version, path.extname(entry.name), async source => {
          await frameWorker.exportTailFrame({ source, target });
          return null;
        });
        const written = await library.put(target, `素材加工/${entry.name.replace(VIDEO_SUFFIX, '')}-尾帧-${Date.now()}.png`);
        return { entry: written, provenance: { sourceLibraryId: entry.id, sourceVersion: version, sourceName: entry.name, decodedByPts: true } };
      } finally {
        fs.rmSync(target, { force: true });
      }
    },
  };

  const toolDescriptors = () => [
    {
      name: 'library_image_process', source: 'catalog',
      description: 'Locally crop/scale/format-convert a pinned library image version into a NEW library entry that records its source. No cloud or paid tools are used.',
      inputSchema: {
        type: 'object',
        properties: {
          libraryId: { type: 'string' },
          version: { type: 'string' },
          format: { type: 'string', enum: ['png', 'jpg', 'webp', 'gif'] },
          crop: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } }, required: ['x', 'y', 'width', 'height'], additionalProperties: false },
          scale: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } }, additionalProperties: false },
        },
        required: ['libraryId'],
        additionalProperties: false,
      },
    },
    {
      name: 'library_video_extract_frame', source: 'catalog',
      description: 'Extract the real last displayed frame (decoded by PTS) of a pinned library MP4/WebM version into a NEW library image with provenance. Local FFmpeg only.',
      inputSchema: {
        type: 'object',
        properties: { libraryId: { type: 'string' }, version: { type: 'string' } },
        required: ['libraryId'],
        additionalProperties: false,
      },
    },
  ];

  async function callTool(name, params = {}) {
    if (name === 'library_image_process') return commands['library/image/process'](params);
    if (name === 'library_video_extract_frame') return commands['library/video/extract-frame'](params);
    return undefined;
  }

  return { commands, toolDescriptors, callTool };
}

module.exports = { createLibraryImageOps, FORMATS };
