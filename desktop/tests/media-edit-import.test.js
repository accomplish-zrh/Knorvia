'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createCompositionWorker, normalizeEdit, hash } = require('../media-composition-worker');
const { createMediaStudio } = require('../media-studio');
const { createPersonalLibrary } = require('../personal-library');
const { createStudioMcp } = require('../studio-mcp');
const { startKnorviaDaemon, initializeRequest } = require('../knorvia-protocol-client');
const { resolveBinaries } = require('../media-frame-worker');
const { pickH264Encoder } = require('./fixtures/encoder');

test('framing rejects unsupported settings and retains legacy manifests', () => {
  const sources = [{ id: 'a', frames: 30 }];
  assert.deepEqual(normalizeEdit({ clips: [{ id: 'a' }] }, sources).clips[0], { id: 'a', startFrame: 0, endFrame: 30, volume: 1, fadeFrames: 0 });
  for (const settings of [{ rotation: 45 }, { fit: 'stretch' }, { mirror: 'true' }]) assert.throws(() => normalizeEdit({ clips: [{ id: 'a', ...settings }] }, sources));
});

test('real store and FFmpeg: pinned library import, MCP discovery, framing, export and restart', { timeout: 120000, skip: !process.env.KNORVIA_DAEMON_BIN }, async () => {
  const parent = path.resolve(__dirname, '../../..', '.knorvia-creative-20260908');
  fs.mkdirSync(parent, { recursive: true });
  const home = fs.mkdtempSync(path.join(parent, 'import-test-'));
  let session, studio, mcp;
  try {
    session = startKnorviaDaemon({ daemonBin: process.env.KNORVIA_DAEMON_BIN, home, env: { ...process.env, KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1' } });
    let counter = 0;
    const rpc = async (method, params = {}) => { const result = await session.request({ jsonrpc: '2.0', id: `import-${++counter}`, method, params }); if (result.error) throw Object.assign(new Error(result.error.message), { rpc: result.error }); return result.result; };
    const init = await session.request(initializeRequest('library_edit_test', '1')); assert.ok(!init.error);
    session.notify({ jsonrpc: '2.0', method: 'initialized' });
    const library = createPersonalLibrary({ home, rpc });
    studio = createMediaStudio({ home, rpc, library }); await studio.initialize();
    const binaries = resolveBinaries(), worker = createCompositionWorker();
    const ENCODER = pickH264Encoder(binaries.ffmpeg);
    const file = path.join(home, '双色 原片.mp4');
    execFileSync(binaries.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x80:r=30:d=1', '-vf', 'drawbox=x=80:y=0:w=80:h=80:color=blue:t=fill', '-c:v', ENCODER, '-an', '-y', file], { windowsHide: true, timeout: 30000 });
    const entry = await library.put(file, '素材/双色 原片.mp4');
    mcp = await createStudioMcp({ getStudio: () => studio, getLibrary: () => library });
    const tool = async args => {
      const response = await fetch(mcp.env.KNORVIA_STUDIO_MCP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mcp.env.KNORVIA_STUDIO_MCP_TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++counter, method: 'tools/call', params: { name: 'media_edit', arguments: args } }) });
      const result = (await response.json()).result;
      assert.equal(result.isError, false, JSON.stringify(result)); return JSON.parse(result.content[0].text);
    };
    assert.equal((await tool({ action: 'sources' })).sources[0].version, entry.sha256);
    const input = { action: 'import', title: '个人素材成片', references: [{ id: entry.id, version: entry.sha256 }, { id: entry.id, version: entry.sha256 }], idempotencyKey: 'first-import' };
    let project = await tool(input);
    assert.equal((await tool(input)).id, project.id);
    assert.equal(project.sources.length, 2); assert.notEqual(project.sources[0].id, project.sources[1].id);
    await assert.rejects(studio.handlers['studio/edit/import']({ ...input, title: 'changed' }), /其他素材/);
    assert.ok((await tool({ action: 'list' })).projects.some(p => p.id === project.id));
    // Modifying the external original does not affect the pinned studio copy.
    fs.writeFileSync(file, 'external original changed');
    assert.equal(await hash(path.join(studio.root, project.sources[0].name)), entry.sha256);
    project = await tool({ action: 'update', id: project.id, revision: project.revision, edit: { aspect: '1:1', clips: [{ ...project.edit.clips[0], rotation: 90, mirror: true, fit: 'cover' }], captions: [{ startFrame: 0, endFrame: 20, text: '中文字幕' }] } });
    // A clockwise turn maps red-left to red-top; cover must remove black bars.
    const rendered = await worker.render({ edit: project.edit, sources: project.sources.map(s => ({ ...s, file: path.join(studio.root, s.name) })), directory: path.join(home, 'framing'), canvas: { width: 80, height: 80 } });
    const pixels = execFileSync(binaries.ffmpeg, ['-v', 'error', '-i', rendered.file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
    const top = (10 * 80 + 5) * 3, bottom = (70 * 80 + 5) * 3;
    assert.ok(pixels[top] > pixels[top + 2] + 100, 'rotated red top fills the edge');
    assert.ok(pixels[bottom + 2] > pixels[bottom] + 100, 'rotated blue bottom fills the edge');
    const mirrored = await worker.render({ edit: { clips: [{ id: project.sources[0].id, mirror: true }] }, sources: project.sources.map(s => ({ ...s, file: path.join(studio.root, s.name) })), directory: path.join(home, 'mirror'), canvas: { width: 160, height: 80 } });
    const mirroredPixels = execFileSync(binaries.ffmpeg, ['-v', 'error', '-i', mirrored.file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
    const left = (40 * 160 + 10) * 3, right = (40 * 160 + 150) * 3;
    assert.ok(mirroredPixels[left + 2] > mirroredPixels[left] + 100 && mirroredPixels[right] > mirroredPixels[right + 2] + 100, 'mirror swaps blue and red horizontally');
    const render = await tool({ action: 'export', id: project.id, revision: project.revision, idempotencyKey: 'export-1' });
    let final;
    for (let i = 0; i < 400; i++) { final = await studio.handlers['studio/edit/render/read']({ id: render.id }); if (['succeeded', 'failed', 'cancelled'].includes(final.status)) break; await delay(100); }
    assert.equal(final.status, 'succeeded', JSON.stringify(final)); assert.ok(final.libraryId);
    const resultFile = path.join(studio.root, 'edits', final.output.name);
    const streams = JSON.parse(execFileSync(binaries.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', resultFile], { windowsHide: true }));
    assert.ok(streams.streams.some(s => s.codec_type === 'subtitle'));
    await studio.close(); studio = createMediaStudio({ home, rpc, library }); await studio.initialize();
    assert.deepEqual((await studio.handlers['studio/edit/read']({ id: project.id })).edit, project.edit);
    const playback = await studio.handlers['studio/edit/source/playback']({ id: project.id, sourceId: project.sources[0].id });
    assert.equal((await fetch(playback.url)).status, 200);
    const webm = path.join(home, '来源.webm');
    execFileSync(binaries.ffmpeg, ['-v', 'error', '-i', path.join(studio.root, project.sources[0].name), '-c:v', 'libvpx-vp9', '-an', '-y', webm], { windowsHide: true });
    const webmEntry = await library.put(webm, '素材/来源.webm');
    const webmProject = await studio.handlers['studio/edit/import']({ references: [{ id: webmEntry.id, version: webmEntry.sha256 }], idempotencyKey: 'webm-import' });
    const webmUrl = await studio.handlers['studio/edit/source/playback']({ id: webmProject.id, sourceId: webmProject.sources[0].id });
    assert.equal((await fetch(webmUrl.url)).headers.get('content-type'), 'video/webm');
    const invalid = await library.put(file, '素材/损坏.mp4');
    await assert.rejects(studio.handlers['studio/edit/import']({ references: [{ id: invalid.id, version: invalid.sha256 }], idempotencyKey: 'broken' }));
    assert.equal(fs.readdirSync(studio.root).filter(n => /^import-.*\.tmp$/.test(n)).length, 0, 'failed import closes and removes temporary copies');
  } finally {
    await mcp?.close(); await studio?.close();
    if (session?.child.exitCode === null) { session.child.stdin.end(); await delay(300); if (session.child.exitCode === null) session.child.kill(); }
    // Retain this small isolated fixture for browser inspection and evidence.
  }
});
