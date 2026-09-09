'use strict';

// Pet slice acceptance (B18/B19/B21/B22): package layouts (official 8x9 and
// community 8x11), import/export hash roundtrip, the pure animation state
// machine, and the imagegen creation pipeline over a loopback fixture.
// The generated atlas is real ffmpeg output; nothing third-party or paid.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validatePackage, exportPackage, pngSize, LAYOUTS } = require('../pet-package');
const { createPetRuntime, STATE_ROWS } = require('../pet-runtime');
const { createPetWorkflow } = require('../pet-workflow');
const F = require('./fixtures/video-fixtures');

let ffmpegAvailable = true;
try { process.env.KNORVIA_FFMPEG_DIR ??= path.dirname(F.ffmpeg()); } catch { ffmpegAvailable = false; }
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const BUILTIN_PET = path.join(__dirname, '..', 'assets', 'pets', 'hatchling');

function makePackage(dir, { schemaVersion = 1, id = 'test-pet', spriteName = 'spritesheet.png', manifest } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const layout = LAYOUTS[schemaVersion];
  const sizeSpec = layout ? `${layout.atlasWidth}x${layout.atlasHeight}` : '64x64';
  F.run(['-f', 'lavfi', '-i', `color=c=0x5B8C5A:s=${sizeSpec}:d=0.02`, '-frames:v', '1', path.join(dir, spriteName)]);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest ?? { schemaVersion, id, displayName: '测试宠物', description: 'fixture', spritesheetPath: spriteName }));
  return dir;
}

test('pet package: built-in hatchling validates against the official 8x9 layout', () => {
  const validated = validatePackage(BUILTIN_PET);
  assert.equal(validated.manifest.schemaVersion, 1);
  assert.equal(validated.layout.columns, 8);
  assert.equal(validated.layout.rows, 9);
  assert.equal(validated.atlasSha256, sha256(fs.readFileSync(path.join(BUILTIN_PET, 'spritesheet.png'))));
});

test('pet package: community 8x11 layout is accepted, unknown versions rejected', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-pet-')), 'v2');
  makePackage(dir, { schemaVersion: 2, id: 'community-pet' });
  const validated = validatePackage(dir);
  assert.equal(validated.layout.rows, 11);
  assert.throws(() => validatePackage(makePackage(path.join(path.dirname(dir), 'v3'), { schemaVersion: 3, id: 'future-pet' })), /版本/);
});

test('pet package: path traversal and missing sprite fail with structured reasons', () => {
  const dir = makePackage(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-pet-')), 'evil'), { id: 'evil' });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'evil', displayName: 'x', spritesheetPath: '../../escape.png' }));
  assert.throws(() => validatePackage(dir), /目录内|相对文件名/);
  const missing = makePackage(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-pet-')), 'gone'), { id: 'gone' });
  fs.unlinkSync(path.join(missing, 'spritesheet.png'));
  try { validatePackage(missing); assert.fail('should have thrown'); } catch (e) { assert.match(e.message, /缺失/); assert.equal(e.reason, 'invalid-pet-package'); }
});

test('pet package: export roundtrip keeps the atlas hash identical (B22)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-pet-roundtrip-'));
  const source = makePackage(path.join(base, 'src'), { id: 'roundtrip' });
  const target = path.join(base, 'out');
  const result = exportPackage({ sourceDir: source, targetDir: target });
  assert.equal(result.atlasSha256, validatePackage(source).atlasSha256);
  assert.equal(validatePackage(target).atlasSha256, result.atlasSha256);
  // Normalized export adds the content hash to the manifest copy.
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8')).atlasSha256, result.atlasSha256);
});

test('pet runtime: task states map to rows; reduced motion pins; hidden yields nothing (B19)', () => {
  const layout = { columns: 8, rows: 9, cellWidth: 192, cellHeight: 208 };
  const runtime = createPetRuntime({ layout, fps: 8 });
  assert.equal(runtime.state, 'idle');
  runtime.setState('working', 0);
  const a = runtime.frame(10_000);
  const b = runtime.frame(10_250);
  assert.equal(a.row, STATE_ROWS.working);
  assert.notEqual(a.column, b.column, 'working animates through columns');
  assert.equal(a.x, a.column * 192);
  assert.equal(a.y, STATE_ROWS.working * 208);
  runtime.setState('succeeded', 19_000);
  const pinned = runtime.frame(20_000);
  assert.equal(pinned.column, 0, 'outcomes hold a single representative frame');
  assert.equal(runtime.frame(25_000).state, 'idle', 'outcome returns to idle after the hold');
  const quiet = createPetRuntime({ layout, reducedMotion: true });
  quiet.setState('working', 0);
  const still1 = quiet.frame(30_000);
  const still2 = quiet.frame(30_250);
  assert.equal(still1.index, still2.index, 'reduced motion never animates');
  assert.equal(quiet.frame(30_500, { visible: false }), null, 'hidden surfaces draw nothing');
  assert.equal(quiet.setState('dancing'), false, 'unknown states are refused, not guessed');
});
