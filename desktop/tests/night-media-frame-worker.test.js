'use strict';

// Real-ffmpeg tail-frame acceptance for the creation studio. Fixtures are
// generated locally with distinct per-frame colors; the decoded tail pixel
// must equal the LAST displayed frame's color — no duration arithmetic.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createFrameWorker } = require('../media-frame-worker');
const F = require('./fixtures/video-fixtures');

let available = true;
try { F.ffmpeg(); } catch { available = false; }

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const COLORS = ['0xFF0000', '0x00FF00', '0x0000FF', '0xFFFF00', '0xFF00FF', '0x00FFFF', '0xFFA500', '0xFFFFFF'];

test('frame worker: tail frame is the last displayed frame (CFR)', { skip: !available && 'ffmpeg unavailable' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-frame-cfr-'));
  const source = F.sequence(dir, 'cfr.mp4', COLORS);
  const worker = createFrameWorker({});
  const target = path.join(dir, 'tail.png');
  const result = await worker.exportTailFrame({ source, target });
  assert.ok(result.frameSize > 0);
  assert.equal(result.sourceSha256, sha256(source));
  assert.equal(result.frameSha256, sha256(target));
  F.expectColor(target, '0xFFFFFF');
  assert.ok(fs.existsSync(source), 'source must survive export');
});

test('frame worker: disk commit failure preserves source and cleans partial frame before local retry', { skip: !available && 'ffmpeg unavailable' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-frame-enospc-'));
  const source = F.sequence(dir, 'source.mp4', COLORS), target = path.join(dir, 'tail.png'), hash = sha256(source);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === target) throw Object.assign(new Error('fixture ENOSPC'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  t.after(() => { fs.renameSync = rename; });
  await assert.rejects(createFrameWorker().exportTailFrame({ source, target }), error => error.reason === 'write-failed' && /空间/.test(error.message));
  assert.equal(sha256(source), hash); assert.equal(fs.existsSync(target), false);
  assert.ok(fs.readdirSync(dir).every(name => !name.endsWith('.part')));
  fs.renameSync = rename;
  await createFrameWorker().exportTailFrame({ source, target });
  F.expectColor(target, '0xFFFFFF'); assert.equal(sha256(source), hash);
});

test('frame worker: VFR last pts frame wins', { skip: !available && 'ffmpeg unavailable' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-frame-vfr-'));
  const colors = ['0xFF0000', '0x00FF00', '0x0000FF', '0xFFFF00'];
  const source = F.vfr(dir, 'vfr.mp4', colors, [0.3, 0.08, 0.5, 0.12]);
  const worker = createFrameWorker({});
  const target = path.join(dir, 'tail.png');
  await worker.exportTailFrame({ source, target });
  F.expectColor(target, '0xFFFF00');
});

test('frame worker: rotated video exports display-oriented frame once', { skip: !available && 'ffmpeg unavailable' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-frame-rot-'));
  const source = F.rotated(dir, 'rot.mp4', ['0x0000FF', '0xFF0000'], 90);
  const worker = createFrameWorker({});
  const target = path.join(dir, 'tail.png');
  const result = await worker.exportTailFrame({ source, target });
  const raw = fs.readFileSync(target);
  assert.equal(raw.readUInt32BE(16), 90, 'PNG width must be the rotated 90');
  assert.equal(raw.readUInt32BE(20), 160, 'PNG height must be the rotated 160');
  F.expectColor(target, '0xFF0000');
  assert.ok(typeof result.rotation === 'number', 'rotation metadata recorded');
});

test('frame worker: B-frame reordering still lands on the final display frame', { skip: !available && 'ffmpeg unavailable' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-frame-b-'));
  const source = F.bFrames(dir, 'bframes.mp4', COLORS);
  const worker = createFrameWorker({});
  const target = path.join(dir, 'tail.png');
  await worker.exportTailFrame({ source, target });
  F.expectColor(target, '0xFFFFFF');
});

test('frame worker: audio longer than video does not move the tail frame', { skip: !available && 'ffmpeg unavailable' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-frame-aud-'));
  const source = F.withLongerAudio(dir, 'longaudio.mp4', ['0xFF0000', '0x00FF00', '0x0000FF']);
  const probe = await createFrameWorker({}).probe({ source });
  // The video STREAM is short even though the container carries ~3s of audio;
  // the worker must trust the stream, and still land on its final frame.
  assert.ok(probe.duration !== null && probe.duration <= 0.5, `video stream duration should stay short, got ${probe.duration}`);
  const worker = createFrameWorker({});
  const target = path.join(dir, 'tail.png');
  await worker.exportTailFrame({ source, target });
  F.expectColor(target, '0x0000FF');
});

test('frame worker: first video stream is selected when two exist', { skip: !available && 'ffmpeg unavailable' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-frame-dual-'));
  const source = F.dualVideo(dir, 'dual.mp4', ['0xFF0000', '0x00FF00'], ['0x0000FF', '0xFFFFFF']);
  const worker = createFrameWorker({});
  const target = path.join(dir, 'tail.png');
  await worker.exportTailFrame({ source, target });
  F.expectColor(target, '0x00FF00');
});

test('frame worker: non-zero start time does not shift the tail frame', { skip: !available && 'ffmpeg unavailable' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-frame-off-'));
  const source = F.nonzeroStart(dir, 'offset.mp4', ['0xFF0000', '0x00FF00', '0x0000FF', '0xFFFFFF']);
  const info = await createFrameWorker({}).probe({ source });
  assert.ok(info.startTime >= 1, `expected start_time ~1.25, got ${info.startTime}`);
  const worker = createFrameWorker({});
  const target = path.join(dir, 'tail.png');
  await worker.exportTailFrame({ source, target });
  F.expectColor(target, '0xFFFFFF');
});

test('frame worker: truncated file fails loudly', { skip: !available && 'ffmpeg unavailable' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-frame-bad-'));
  F.truncated(dir, 'broken.mp4', ['0xFF0000', '0x00FF00']);
  const worker = createFrameWorker({});
  await assert.rejects(() => worker.exportTailFrame({ source: path.join(dir, 'broken.mp4'), target: path.join(dir, 'tail.png') }), /损坏|视频/);
});

test('frame worker: audio-only file reports no video stream', { skip: !available && 'ffmpeg unavailable' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-frame-nov-'));
  const source = F.audioOnly(dir, 'audio.m4a');
  const worker = createFrameWorker({});
  await assert.rejects(() => worker.exportTailFrame({ source, target: path.join(dir, 'tail.png') }), /没有视频流/);
});

test('frame worker: missing file fails before any process spawns', { skip: !available && 'ffmpeg unavailable' }, async () => {
  const worker = createFrameWorker({});
  await assert.rejects(() => worker.exportTailFrame({ source: path.join(os.tmpdir(), 'does-not-exist.mp4'), target: path.join(os.tmpdir(), 'tail.png') }), /找不到源视频/);
});

test('frame worker: abort cancels export', { skip: !available && 'ffmpeg unavailable' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-frame-abort-'));
  const source = F.sequence(dir, 'abort.mp4', ['0xFF0000', '0x00FF00', '0x0000FF', '0xFFFFFF']);
  const worker = createFrameWorker({});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => worker.exportTailFrame({ source, target: path.join(dir, 'tail.png'), signal: controller.signal }), /cancelled|取消/);
  assert.ok(!fs.existsSync(path.join(dir, 'tail.png')));
});

test('frame worker: source bytes stay identical across export', { skip: !available && 'ffmpeg unavailable' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-frame-intact-'));
  const source = F.sequence(dir, 'intact.mp4', ['0xFF0000', '0xFFFFFF']);
  const before = sha256(source);
  const worker = createFrameWorker({});
  await worker.exportTailFrame({ source, target: path.join(dir, 'tail.png') });
  assert.equal(sha256(source), before);
});

test('frame worker: Chinese and spaced directory paths export cleanly', { skip: !available && 'ffmpeg unavailable' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-frame-path-'));
  const dir = path.join(base, '中文 目录', '分镜');
  fs.mkdirSync(dir, { recursive: true });
  const source = F.sequence(dir, '视频 作品.mp4', ['0xFF0000', '0x00FF00', '0x0000FF', '0xFFFFFF']);
  const worker = createFrameWorker({});
  const target = path.join(dir, '尾帧 导出.png');
  await worker.exportTailFrame({ source, target });
  F.expectColor(target, '0xFFFFFF');
});
