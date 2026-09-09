'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const crc32 = require('node:zlib').crc32 || require('yauzl/crc32');
const { connectionError } = require('./connection-config');
const MAX_FILES = 2000, MAX_BYTES = 64 * 1024 * 1024, MAX_FILE = 16 * 1024 * 1024;
const fail = message => { throw connectionError(-32602, message); };
function relative(name) {
  if (typeof name !== 'string' || !name || name.length > 1024 || name.startsWith('/') || /[\\\0:]/.test(name)) fail('Invalid extension path');
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('Unsafe extension filename');
  return parts.join('/');
}
function scan(root) {
  const files = [], seen = new Set(); let bytes = 0;
  const walk = (folder, prefix = '', depth = 0) => {
    if (depth > 16) fail('Extension nesting exceeds 16 directories');
    if (fs.lstatSync(folder).isSymbolicLink()) fail('Extension links are not accepted');
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const name = relative(prefix ? `${prefix}/${entry.name}` : entry.name), file = path.join(root, ...name.split('/'));
      if (seen.has(name.toLowerCase()) || seen.size >= MAX_FILES) fail('Extension has duplicate names or too many entries');
      seen.add(name.toLowerCase()); const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail('Extension links are not accepted');
      if (stat.isDirectory()) walk(file, name, depth + 1);
      else if (stat.isFile()) {
        if (stat.size > MAX_FILE || (bytes += stat.size) > MAX_BYTES) fail('Extension exceeds its size limit');
        files.push({ name, size: stat.size, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
      } else fail('Only regular extension files are accepted');
    }
  };
  walk(root); files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return { files, bytes, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
function copy(source, destination) {
  const manifest = scan(source); fs.mkdirSync(destination, { recursive: true });
  for (const entry of manifest.files) { const target = path.join(destination, ...entry.name.split('/')); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(source, ...entry.name.split('/')), target, fs.constants.COPYFILE_EXCL); }
  if (scan(destination).sha256 !== manifest.sha256) fail('Extension changed while importing');
  return manifest;
}
function removeOwned(root, target) {
  if (!fs.existsSync(target)) return;
  const canonicalRoot = fs.realpathSync(root), canonicalTarget = fs.realpathSync(target), rel = path.relative(canonicalRoot, canonicalTarget);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || fs.lstatSync(target).isSymbolicLink()) fail('Refusing cleanup outside managed extension storage');
  scan(target); fs.rmSync(target, { recursive: true });
}
async function extractZip(file, destination) {
  const yauzl = require('yauzl');
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value)));
  fs.mkdirSync(destination, { recursive: true }); let total = 0; const seen = new Set();
  await new Promise((resolve, reject) => {
    let ended = false;
    const abort = error => { if (ended) return; ended = true; zip.close(); reject(error); };
    zip.on('error', abort); zip.on('end', () => { ended = true; resolve(); });
    zip.on('entry', async entry => {
      try {
        const name = relative(entry.fileName), mode = entry.externalFileAttributes >>> 16;
        if ((mode & 0xf000) === 0xa000 || entry.generalPurposeBitFlag & 1 || ![0, 8].includes(entry.compressionMethod)) fail('Encrypted, linked, or unsupported ZIP entry');
        if (seen.has(name.toLowerCase()) || seen.size >= MAX_FILES) fail('Duplicate ZIP path or too many entries');
        seen.add(name.toLowerCase());
        if (entry.uncompressedSize > MAX_FILE || (total += entry.uncompressedSize) > MAX_BYTES) fail('ZIP exceeds extraction limits');
        const target = path.join(destination, ...name.split('/'));
        if (entry.fileName.endsWith('/')) fs.mkdirSync(target, { recursive: true });
        else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const stream = await new Promise((res, rej) => zip.openReadStream(entry, (error, value) => error ? rej(error) : res(value)));
          let bytes = 0, checksum = 0;
          const bounded = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; checksum = crc32(chunk, checksum); callback(bytes > MAX_FILE || bytes > entry.uncompressedSize ? new Error('ZIP entry exceeded declared size') : null, chunk); } });
          await pipeline(stream, bounded, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
          if (checksum !== entry.crc32) fail('ZIP entry checksum does not match its content');
        }
        if (!ended) zip.readEntry();
      } catch (error) { abort(error); }
    });
    zip.readEntry();
  });
  return scan(destination);
}
module.exports = { relative, scan, copy, removeOwned, extractZip, MAX_BYTES, MAX_FILE };
