'use strict';

// C17 studio-level acceptance: tail-frame exports run through the shared
// operations registry. Real FFmpeg fixtures prove (a) two concurrent exports
// of one video share a single decode with identical results and a single
// publish, and (b) cancelling mid-run stops the owned decode, publishes
// nothing and leaves the source untouched. A controllable fake worker makes
// cancellation timing deterministic; the real-ffmpeg case bounds it.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FW = require('../media-frame-worker');
const { createMediaStudio } = require('../media-studio');
const F = require('./fixtures/video-fixtures');

let ffmpegAvailable = true;
try { F.ffmpeg(); } catch { ffmpegAvailable = false; }

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fakeSafeStorage = () => ({ isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`enc:${value}`), decryptString: buffer => buffer.toString().slice(4) });

function makeVideoStudio(home, videoFile) {
  const videoJobId = 'job-video-1';
  const name = `${videoJobId}-1.mp4`;
  const root = path.join(home, 'artifacts', 'media-studio');
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(videoFile, path.join(root, name));
  const output = { name, mime: 'video/mp4', size: fs.statSync(path.join(root, name)).size, sha256: sha256(path.join(root, name)) };
  const job = { id: videoJobId, workspaceId: 'ws-ops', type: 'media.video', status: 'succeeded', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), checkpoint: { kind: 'video', outputs: [output] } };
  let workspaceCreated = false;
  const rpc = async (method, params = {}) => {
    if (method === 'workspace/create') { workspaceCreated = true; return { id: 'ws-ops' }; }
    if (method === 'job/list') return { jobs: [], total: 0 };
    if (method === 'job/read') {
      if (params.id !== videoJobId) { const e = new Error('Job not found'); e.rpc = { code: -32004, message: 'Job not found' }; throw e; }
      return job;
    }
    throw new Error(`fake rpc: unexpected method ${method}`);
  };
  const libraryPuts = [];
  const library = {
    handlers: {
      'library/list': async () => ({ entries: libraryPuts.map(put => ({ id: `lib-${libraryPuts.indexOf(put) + 1}`, name: path.basename(put.destination), path: put.destination, sha256: put.sha256, trashedAt: null })) }),
      'library/read': async () => { throw new Error('not used here'); },
    },
    async put(source, destination) {
      const record = { source, destination, sha256: sha256(source) };
      libraryPuts.push(record);
      return { id: `lib-${libraryPuts.length}`, name: path.basename(destination), path: destination, sha256: record.sha256 };
    },
  };
  const studio = createMediaStudio({ home, rpc, library, safeStorage: fakeSafeStorage(), pollMs: 5 });
  return { studio, libraryPuts, job };
}

test('two concurrent tail-frame exports of one video share one decode and publish once', { skip: !ffmpegAvailable && 'ffmpeg unavailable' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ops-dedup-'));
  const video = F.sequence(dir, 'shared.mp4', ['0xFF0000', '0x00FF00', '0x0000FF', '0xFFFFFF']);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ops-home-'));
  const { studio, libraryPuts } = makeVideoStudio(home, video);
  t.after(() => studio.close());
  await studio.initialize();
  const [a, b] = await Promise.all([
    studio.handlers['studio/frame/export']({ id: 'job-video-1' }),
    studio.handlers['studio/frame/export']({ id: 'job-video-1' }),
  ]);
  assert.equal(a.sha256, b.sha256, 'both callers see the identical frame');
  assert.equal(a.libraryId, b.libraryId);
  assert.equal(a.frame.ptsTime, b.frame.ptsTime);
  assert.equal(libraryPuts.length, 1, 'exactly one library publish');
  const operations = studio.handlers['studio/operations/list']().operations.filter(op => op.kind === 'studio.tail-frame');
  assert.equal(operations.length, 1, 'one shared execution, not two decodes');
  assert.equal(operations[0].callers, 2);
  assert.equal(operations[0].status, 'completed');
});

test('cancelling an in-flight export stops the work and publishes nothing', { skip: !ffmpegAvailable && 'ffmpeg unavailable' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ops-cancel-'));
  const video = F.sequence(dir, 'cancellable.mp4', ['0xFF0000', '0xFFFFFF']);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ops-cancel-home-'));
  const { studio, libraryPuts } = makeVideoStudio(home, video);
  t.after(() => studio.close());
  await studio.initialize();
  // Deterministic slow decode: the fake worker observes the signal exactly
  // like the real FFmpeg worker (which kills its child on abort).
  const realCreate = FW.createFrameWorker;
  let kills = 0;
  FW.createFrameWorker = () => ({
    binaries: realCreate({}).binaries,
    decoderVersion: async () => 'fixture-decoder',
    exportTailFrame: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { kills += 1; reject(Object.assign(new Error('帧导出已取消'), { rpc: { code: -32602, message: '帧导出已取消', reason: 'cancelled' } })); }, { once: true });
    }),
  });
  try {
    const exportPromise = studio.handlers['studio/frame/export']({ id: 'job-video-1' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const cancel = await studio.handlers['studio/frame/cancel']({ id: 'job-video-1' });
    assert.equal(cancel.canceled, true);
    await assert.rejects(exportPromise, error => /取消/.test(error.rpc?.message || ''));
    assert.equal(kills, 1, 'the owned decode process was told to terminate');
    assert.equal(libraryPuts.length, 0, 'a cancelled operation registers no result');
    const root = studio.root;
    assert.ok(!fs.existsSync(path.join(root, 'job-video-1-tail-1.png')), 'no derived frame is published');
    assert.ok(fs.readdirSync(root).every(name => !name.endsWith('.part')), 'no staging part file survives');
    assert.equal(sha256(video), sha256(path.join(root, 'job-video-1-1.mp4')), 'source video stays untouched');
    const operations = studio.handlers['studio/operations/list']().operations;
    assert.equal(operations[0].status, 'canceled');
  } finally {
    FW.createFrameWorker = realCreate;
  }
});

test('a real FFmpeg decode cancelled mid-run leaves no artifact and the source intact', { skip: !ffmpegAvailable && 'ffmpeg unavailable' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ops-real-'));
  // A single keyframe at 0 forces the tail scan to decode from the start:
  // cancelling at 200ms deterministically lands inside the decode.
  const video = path.join(dir, 'long.mp4');
  F.run(['-f', 'lavfi', '-i', 'testsrc2=duration=20:size=1280x720:rate=60', '-g', '100000', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', video]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ops-real-home-'));
  const { studio, libraryPuts } = makeVideoStudio(home, video);
  t.after(() => studio.close());
  await studio.initialize();
  const before = sha256(path.join(studio.root, 'job-video-1-1.mp4'));
  const exportPromise = studio.handlers['studio/frame/export']({ id: 'job-video-1' });
  await new Promise(resolve => setTimeout(resolve, 200));
  const cancel = await studio.handlers['studio/frame/cancel']({ id: 'job-video-1' });
  assert.equal(cancel.canceled, true);
  await assert.rejects(exportPromise, error => /取消/.test(error.rpc?.message || ''));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(!fs.existsSync(path.join(studio.root, 'job-video-1-tail-1.png')), 'no frame is published after cancel');
  assert.ok(fs.readdirSync(studio.root).every(name => !name.endsWith('.part')), 'no staging part file survives');
  assert.equal(sha256(path.join(studio.root, 'job-video-1-1.mp4')), before, 'source bytes unchanged');
  assert.equal(libraryPuts.length, 0);
  const operations = studio.handlers['studio/operations/list']().operations;
  assert.equal(operations[0].status, 'canceled');
});
