'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const moduleRoot = process.env.KNORVIA_TEST_DESKTOP_ROOT || path.resolve(__dirname, '..');
const { normalizeEdit, createCompositionWorker, hash } = require(path.join(moduleRoot, 'media-composition-worker'));
const { createMediaStudio } = require(path.join(moduleRoot, 'media-studio'));
const { createPersonalLibrary } = require(path.join(moduleRoot, 'personal-library'));
const { startKnorviaDaemon, initializeRequest } = require(path.join(moduleRoot, 'knorvia-protocol-client'));
const { inspectWorkflow, checkDependencies } = require(path.join(moduleRoot, 'studio-workflow'));
const { normalizeCaptions, parseSrt, toSrt } = require(path.join(moduleRoot, 'studio-subtitles'));
const base = path.resolve(__dirname, '../..');
const daemonBin = process.env.KNORVIA_DAEMON_BIN || path.resolve(base, '../knorvia-kernel/knorvia-rs/target/release/knorvia-daemon.exe');

test('frame-based edits reject stale ranges, duplicate clips and invalid fades', () => {
  const sources = [{ id: 's', frames: 60 }];
  const edit = normalizeEdit({ clips: [{ id: 's', startFrame: 15, endFrame: 45, fadeFrames: 10 }] }, sources);
  assert.equal(edit.fps, 30);
  for (const clips of [[{ id: 's', endFrame: 61 }], [{ id: 's', volume: NaN }], [{ id: 's', startFrame: 15.5 }], [{ id: 's' }, { id: 's' }], [{ id: 's', startFrame: 0, endFrame: 10, fadeFrames: 6 }]]) assert.throws(() => normalizeEdit({ clips }, sources));
});
test('subtitle parser preserves Unicode and frame timing and rejects overlaps or malformed imports', () => {
  const cues = [{ startFrame: 3, endFrame: 18, text: '你好，世界\nHello world' }, { startFrame: 30, endFrame: 45, text: '第二条' }];
  assert.deepEqual(parseSrt(toSrt(cues), 48), cues);
  assert.throws(() => normalizeCaptions([{ startFrame: 0, endFrame: 8, text: 'x' }, { startFrame: 7, endFrame: 10, text: 'y' }], 48), /不重叠/);
  assert.throws(() => parseSrt('1\n00:60:00,000 --> 00:61:00,000\nx', 999999), /时间/);
  assert.throws(() => parseSrt(toSrt(cues), 40), /成片范围/);
  assert.deepEqual(normalizeCaptions([], 48), []);
});

test('workflow importer distinguishes canvas, preserves graph edges, rejects conflicting bindings', async () => {
  assert.throws(() => inspectWorkflow({ nodes: [], links: [] }), /画布文件/);
  assert.throws(() => inspectWorkflow('{bad'), /解析/);
  const graph = { '6': { class_type: 'Text', inputs: { text: '景色' } }, '9': { class_type: 'Save', inputs: { text: ['6', 0] } } };
  const r = inspectWorkflow({ prompt: graph }, { prompt: { node: '6', input: 'text' } });
  assert.deepEqual(r.workflow['9'].inputs.text, ['6', 0]);
  assert.equal(r.sha256.length, 64);
  assert.throws(() => inspectWorkflow(graph, { prompt: { node: '9', input: 'text' } }), /节点连接/);
  assert.throws(() => inspectWorkflow(graph, { firstFrame: { node: '6', input: 'text' }, lastFrame: { node: '6', input: 'text' } }), /同一个字段/);
  const calls = [];
  const check = await checkDependencies({ custom: { workflow: graph, bindings: { prompt: { node: '6', input: 'text' } } } }, async (p, url) => { calls.push(url); return url.endsWith('Text') ? { Text: { input: { required: { text: ['STRING'] } } } } : {}; });
  assert.deepEqual(check.issues, ['缺少节点：Save']);
  assert.ok(calls.every(url => url.startsWith('object_info/')));
});

test('two API workflows bind image references and ordered video frames without changing their originals', async () => {
  const comfy = require(path.join(moduleRoot, 'studio-comfy'));
  const graph = {
    '1': { class_type: 'CheckpointLoader', inputs: { ckpt_name: 'missing.safetensors' } },
    '2': { class_type: 'LoadImage', inputs: { image: 'start.png' } },
    '3': { class_type: 'LoadImage', inputs: { image: 'end.png' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'original', clip: ['1', 0] } },
    '8': { class_type: 'Frames', inputs: { first: ['2', 0], last: ['3', 0], positive: ['6', 0] } },
    '9': { class_type: 'Save', inputs: { images: ['8', 0] } },
  };
  const original = JSON.stringify(graph), uploads = [];
  const video = { kind: 'video', custom: { workflow: graph, outputNode: '9', bindings: { prompt: { node: '6', input: 'text' }, firstFrame: { node: '2', input: 'image' }, lastFrame: { node: '3', input: 'image' } } } };
  const request = async (p, route, options) => { assert.equal(route, 'upload/image'); uploads.push(Buffer.from(await options.body.get('image').arrayBuffer()).toString()); return { name: `${uploads.length}.png`, subfolder: 'knorvia' }; };
  const result = await comfy.submit(video, { prompt: 'edited' }, [{ bytes: Buffer.from('FIRST'), mime: 'image/png', role: 'firstFrame' }, { bytes: Buffer.from('LAST'), mime: 'image/png', role: 'lastFrame' }], { request });
  assert.deepEqual(uploads, ['FIRST', 'LAST']); assert.equal(result.body.prompt['2'].inputs.image, 'knorvia/1.png'); assert.equal(result.body.prompt['3'].inputs.image, 'knorvia/2.png');
  assert.deepEqual(result.body.prompt['8'].inputs.first, ['2', 0]); assert.equal(JSON.stringify(graph), original);
  const imageGraph = { '4': { class_type: 'ImageEdit', inputs: { prompt: '', image: '' } }, '5': { class_type: 'SaveImage', inputs: { images: ['4', 0] } } };
  const image = { kind: 'image', custom: { workflow: imageGraph, bindings: { prompt: { node: '4', input: 'prompt' }, reference: { node: '4', input: 'image' } } } };
  const imageResult = await comfy.submit(image, { prompt: 'new image' }, [{ bytes: Buffer.from('REFERENCE'), mime: 'image/png' }], { request });
  assert.equal(imageResult.body.prompt['4'].inputs.image, 'knorvia/3.png'); assert.equal(imageGraph['4'].inputs.image, '');
  const deps = await checkDependencies(video, async (p, route) => { const type = decodeURIComponent(route.split('/').at(-1)); return { [type]: { input: { required: type === 'CheckpointLoader' ? { ckpt_name: [['installed.safetensors']] } : {} } } }; });
  assert.ok(deps.issues.some(i => i.includes('missing.safetensors')));
  const state = comfy.normalizeState(video, { accepted: { status: { completed: true }, outputs: { '7': { images: [{ filename: 'preview.png' }] }, '9': { videos: [{ filename: 'film.mp4' }] } } } }, { id: 'accepted' });
  assert.equal(state.outputs.length, 1); assert.ok(state.outputs[0].apiContent.includes('film.mp4')); assert.equal(state.cancelUrl, undefined);
});

test('real Rust store: trim mixed videos, export with packaged encoder, cancel and recover', { timeout: 180000, skip: !fs.existsSync(daemonBin) }, async () => {
  const home = fs.mkdtempSync(path.join(base, '.tmp-video-edit-'));
  let studio, session;
  const worker = createCompositionWorker();
  const binaries = require(path.join(moduleRoot, 'media-frame-worker')).resolveBinaries();
  const ENCODER = require('./fixtures/encoder').pickH264Encoder(binaries.ffmpeg);
  const generate = (file, vertical, audio) => execFileSync(binaries.ffmpeg, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', `color=c=${vertical ? 'blue' : 'red'}:s=${vertical ? '120x180' : '160x90'}:r=${vertical ? '24' : '25'}:d=1.2`, ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2'] : []), '-c:v', ENCODER, '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : ['-an']), '-y', file], { windowsHide: true, timeout: 30000 });
  try {
    session = startKnorviaDaemon({ daemonBin, home, env: { ...process.env, KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1' }, requestTimeoutMs: 30000 });
    let counter = 0;
    const rpc = async (method, params = {}) => { const r = await session.request({ jsonrpc: '2.0', id: `edit-${++counter}`, method, params }); if (r.error) throw Object.assign(new Error(r.error.message), { rpc: r.error }); return r.result; };
    const init = await session.request(initializeRequest('composition_test', '1'));
    assert.ok(!init.error, JSON.stringify(init));
    session.notify({ jsonrpc: '2.0', method: 'initialized' });
    const library = createPersonalLibrary({ home, rpc });
    studio = createMediaStudio({ home, rpc, library });
    await studio.initialize();
    const shots = [];
    for (let i = 0; i < 2; i++) {
      const job = await rpc('job/create', { workspaceId: studio.workspaceId(), type: 'media.video', idempotencyKey: `seed-${i}` });
      const name = `${job.id}-1.mp4`, file = path.join(studio.root, name);
      generate(file, i === 1, i === 0);
      const sha256 = await hash(file);
      await rpc('job/checkpoint', { jobId: job.id, checkpoint: { kind: 'video', outputs: [{ name, sha256, size: fs.statSync(file).size, mime: 'video/mp4' }] } });
      await rpc('job/finish', { jobId: job.id, status: 'succeeded' });
      shots.push({ id: `shot-${i}`, order: i, prompt: `中文 空格分镜 ${i}`, seconds: 1, status: 'completed', jobId: job.id, result: { outputIndex: 0, outputName: name, outputSha256: sha256 } });
    }
    const sequence = await rpc('job/create', { workspaceId: studio.workspaceId(), type: 'studio.sequence', idempotencyKey: 'seed-sequence' });
    await rpc('job/checkpoint', { jobId: sequence.id, checkpoint: { title: '中文 空格成片', state: 'completed', revision: 1, shots } });
    await rpc('job/finish', { jobId: sequence.id, status: 'succeeded' });
    let p = await studio.handlers['studio/edit/create']({ sequenceId: sequence.id });
    assert.equal((await studio.handlers['studio/edit/create']({ sequenceId: sequence.id })).id, p.id);
    p = await studio.handlers['studio/edit/update']({ id: p.id, revision: p.revision, edit: { aspect: '9:16', clips: [...p.edit.clips].reverse().map(c => ({ ...c, startFrame: 6, endFrame: 30, fadeFrames: 3, volume: 0.5 })) } });
    await assert.rejects(studio.handlers['studio/edit/update']({ id: p.id, revision: 1, edit: p.edit }), /其他窗口/);
    const r = await studio.handlers['studio/edit/export']({ id: p.id, revision: p.revision, idempotencyKey: 'export-1' });
    const duplicate = await studio.handlers['studio/edit/export']({ id: p.id, revision: p.revision, idempotencyKey: 'export-1' });
    assert.equal(duplicate.id, r.id);
    let final;
    for (let i = 0; i < 300; i++) { final = await studio.handlers['studio/edit/render/read']({ id: r.id }); if (['succeeded', 'failed', 'cancelled'].includes(final.status)) break; await delay(100); }
    assert.equal(final.status, 'succeeded', JSON.stringify(final));
    assert.equal(final.output.frames, 48);
    assert.equal(final.output.encoder, ENCODER);
    const output = path.join(studio.root, 'edits', final.output.name);
    const info = await worker.probe(output);
    assert.equal(info.width, 720); assert.equal(info.height, 1280); assert.ok(info.hasAudio);
    assert.ok(Math.abs(info.duration - 1.6) < .1, `${info.duration}`);
    const pixel = seconds => execFileSync(binaries.ffmpeg, ['-v', 'error', '-ss', String(seconds), '-i', output, '-vf', 'crop=2:2:iw/2:ih/2,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, timeout: 15000 });
    const firstPixel = pixel(.3), secondPixel = pixel(1.1);
    assert.ok(firstPixel[2] > firstPixel[0] + 100, 'reordered first shot is blue');
    assert.ok(secondPixel[0] > secondPixel[2] + 100, 'second shot is red');
    const stream = await studio.handlers['studio/edit/render/playback']({ id: r.id });
    const response = await fetch(stream.url, { headers: { Range: 'bytes=0-31' } });
    assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 32);
    assert.ok((await library.handlers['library/list']()).entries.some(e => e.id === final.libraryId));
    const cancel = await studio.handlers['studio/edit/export']({ id: p.id, revision: p.revision, idempotencyKey: 'cancel-1' });
    const cancelled = await studio.handlers['studio/edit/render/cancel']({ id: cancel.id });
    assert.equal(cancelled.status, 'cancelled');
    const resume = await studio.handlers['studio/edit/export']({ id: p.id, revision: p.revision, idempotencyKey: 'restart-1' });
    await studio.close();
    studio = createMediaStudio({ home, rpc, library }); await studio.initialize();
    let resumed;
    for (let i = 0; i < 300; i++) { resumed = await studio.handlers['studio/edit/render/read']({ id: resume.id }); if (['succeeded', 'failed', 'cancelled'].includes(resumed.status)) break; await delay(100); }
    assert.equal(resumed.status, 'succeeded', JSON.stringify(resumed));
    // Crash boundary: output and library publication survived, but the
    // terminal checkpoint did not. Recovery must reuse both, not overwrite.
    await studio.close();
    const orphan = await rpc('job/create', { workspaceId: p.workspaceId || (await rpc('job/read', { id: p.id })).workspaceId, type: 'studio.render', idempotencyKey: 'publication-crash' });
    const recoveredName = `${orphan.id}.mp4`, recoveredPath = path.join(studio.root, 'edits', recoveredName);
    fs.copyFileSync(output, recoveredPath);
    const entry = await library.put(recoveredPath, `成片/${orphan.id}.mp4`);
    await rpc('job/checkpoint', { jobId: orphan.id, checkpoint: { projectId: p.id, revision: p.revision, title: p.title, edit: p.edit, sources: p.sources, phase: 'publishing', output: { ...final.output, name: recoveredName } } });
    studio = createMediaStudio({ home, rpc, library }); await studio.initialize();
    let recovered;
    for (let i = 0; i < 150; i++) { recovered = await studio.handlers['studio/edit/render/read']({ id: orphan.id }); if (['succeeded', 'failed'].includes(recovered.status)) break; await delay(100); }
    assert.equal(recovered.status, 'succeeded', JSON.stringify(recovered));
    assert.equal(recovered.libraryId, entry.id);
    const damagedPath = path.join(studio.root, shots[0].result.outputName), original = fs.readFileSync(damagedPath);
    fs.appendFileSync(damagedPath, 'changed');
    const tampered = await studio.handlers['studio/edit/export']({ id: p.id, revision: p.revision, idempotencyKey: 'tamper' });
    let failed;
    for (let i = 0; i < 150; i++) { failed = await studio.handlers['studio/edit/render/read']({ id: tampered.id }); if (['succeeded', 'failed'].includes(failed.status)) break; await delay(100); }
    assert.equal(failed.status, 'failed'); assert.match(failed.error, /源视频已发生变化/);
    fs.writeFileSync(damagedPath, original);
    assert.equal((await studio.handlers['studio/edit/read']({ id: p.id })).revision, 2);
    for (const shot of shots) assert.equal(await hash(path.join(studio.root, shot.result.outputName)), shot.result.outputSha256);
    // Real PCM assembly and MP4 subtitle stream. The tiny command-line
    // fixture below tests process ownership, never speech recognition quality.
    p = await studio.handlers['studio/edit/subtitles/import']({ id: p.id, revision: p.revision, content: '1\n00:00:00,100 --> 00:00:00,600\n你好，世界\n' });
    const captions = p.edit.captions;
    assert.equal(captions[0].startFrame, 3);
    const srt = await studio.handlers['studio/edit/subtitles/export']({ id: p.id, revision: p.revision });
    assert.ok(srt.libraryId);
    const withCaptions = await studio.handlers['studio/edit/export']({ id: p.id, revision: p.revision, idempotencyKey: 'with-captions' });
    for (let i = 0; i < 150; i++) { final = await studio.handlers['studio/edit/render/read']({ id: withCaptions.id }); if (['succeeded', 'failed'].includes(final.status)) break; await delay(100); }
    assert.equal(final.status, 'succeeded', JSON.stringify(final));
    const captionFile = path.join(studio.root, 'edits', final.output.name);
    const streams = JSON.parse(execFileSync(binaries.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', captionFile], { windowsHide: true }));
    assert.ok(streams.streams.some(s => s.codec_name === 'mov_text'));
    const embedded = execFileSync(binaries.ffmpeg, ['-v', 'error', '-i', captionFile, '-map', '0:s:0', '-f', 'srt', '-'], { windowsHide: true, encoding: 'utf8' });
    assert.match(embedded, /你好，世界/);
    const fixture = path.join(home, 'whisper-cli.exe'), model = path.join(home, 'fixture-model.bin'), cs = path.join(home, 'fixture.cs');
    fs.writeFileSync(model, 'local-contract-fixture');
    fs.writeFileSync(cs, 'using System; using System.IO; using System.Threading; class Program { static int Main(string[] a) { if(Array.IndexOf(a,"--help")>=0) return 0; var wav=File.ReadAllBytes(a[Array.IndexOf(a,"-f")+1]); if(wav.Length<40000 || wav[0]!=82) return 2; Thread.Sleep(1200); File.WriteAllText(a[Array.IndexOf(a,"-of")+1]+".srt", "1\\n00:00:00,100 --> 00:00:00,600\\nRecognized fixture\\n"); return 0; } }');
    const csc = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(csc, ['/nologo', '/target:exe', `/out:${fixture}`, cs], { windowsHide: true });
    await studio.handlers['studio/edit/subtitles/config/save']({ executable: fixture, model, language: 'en' });
    const waitSub = async id => { for (let i = 0; i < 200; i++) { const j = await studio.handlers['studio/edit/subtitles/read']({ id }); if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j; await delay(100); } throw new Error('subtitle timeout'); };
    const transcription = await studio.handlers['studio/edit/subtitles/start']({ id: p.id, revision: p.revision, idempotencyKey: 'transcribe-1' });
    assert.equal((await studio.handlers['studio/edit/subtitles/start']({ id: p.id, revision: p.revision, idempotencyKey: 'transcribe-1' })).id, transcription.id);
    assert.equal((await waitSub(transcription.id)).status, 'succeeded');
    p = await studio.handlers['studio/edit/subtitles/apply']({ id: transcription.id, revision: p.revision });
    assert.equal(p.edit.captions[0].text, 'Recognized fixture');
    assert.equal((await studio.handlers['studio/edit/subtitles/apply']({ id: transcription.id, revision: p.revision })).revision, p.revision);
    const cancelling = await studio.handlers['studio/edit/subtitles/start']({ id: p.id, revision: p.revision, idempotencyKey: 'transcribe-cancel' });
    await delay(300); await studio.handlers['studio/edit/subtitles/cancel']({ id: cancelling.id });
    assert.equal((await waitSub(cancelling.id)).status, 'cancelled');
    const interrupted = await studio.handlers['studio/edit/subtitles/start']({ id: p.id, revision: p.revision, idempotencyKey: 'transcribe-restart' });
    await delay(300); await studio.close();
    studio = createMediaStudio({ home, rpc, library }); await studio.initialize();
    assert.equal((await waitSub(interrupted.id)).status, 'succeeded');
    p = await studio.handlers['studio/edit/update']({ id: p.id, revision: p.revision, edit: { ...p.edit, aspect: '16:9' } });
    await assert.rejects(studio.handlers['studio/edit/subtitles/apply']({ id: interrupted.id, revision: p.revision }), /剪辑已变化/);
    const submissions = [];
    const retakeServer = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); submissions.push(body);
      if (body.prompt === 'uncertain fixture') { req.socket.destroy(); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ base64: fs.readFileSync(path.join(studio.root, shots[1].result.outputName)).toString('base64') }] }));
    });
    await new Promise(resolve => retakeServer.listen(0, '127.0.0.1', resolve));
    try {
      studio.profiles.save({ id: 'retake-fixture', name: 'Local contract', kind: 'video', protocol: 'json', baseUrl: `http://127.0.0.1:${retakeServer.address().port}`, model: 'fixture', agentEnabled: true, custom: {} });
      const input = { id: p.id, revision: p.revision, clipId: 'shot-0', startFrame: 12, endFrame: 24, profileId: 'retake-fixture', prompt: 'make middle blue', idempotencyKey: 'local-retake', agentRequested: true };
      const retake = await studio.handlers['studio/edit/retake/start'](input);
      assert.equal((await studio.handlers['studio/edit/retake/start'](input)).id, retake.id);
      await assert.rejects(studio.handlers['studio/edit/retake/start']({ ...input, prompt: 'different' }), /不同的重做/);
      const waitRetake = async id => { for (let i = 0; i < 200; i++) { const j = await studio.handlers['studio/edit/retake/read']({ id }); if (['succeeded', 'failed', 'cancelled'].includes(j.status) || j.phase === 'needs-review') return j; await delay(100); } throw new Error('retake timeout'); };
      const ready = await waitRetake(retake.id);
      assert.equal(ready.status, 'succeeded', JSON.stringify(ready));
      assert.equal(submissions.length, 1); assert.match(submissions[0].first_frame, /^data:image\/png;base64,/); assert.match(submissions[0].last_frame, /^data:image\/png;base64,/);
      const candidate = path.join(studio.root, ready.candidate.name);
      const sample = seconds => execFileSync(binaries.ffmpeg, ['-v', 'error', '-ss', String(seconds), '-i', candidate, '-vf', 'crop=2:2:iw/2:ih/2,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { windowsHide: true });
      const a = sample(.1), b = sample(.4), d = sample(.7);
      assert.ok(a[0] > a[2] + 100 && b[2] > b[0] + 100 && d[0] > d[2] + 100, 'only the selected middle is replaced');
      const before = p.edit;
      p = await studio.handlers['studio/edit/retake/apply']({ id: ready.id, revision: p.revision });
      assert.equal(p.edit.clips.reduce((n, c) => n + c.endFrame - c.startFrame, 0), 48);
      assert.deepEqual(p.edit.clips[0], before.clips[0]); assert.deepEqual(p.edit.captions, before.captions);
      assert.equal((await studio.handlers['studio/edit/retake/apply']({ id: ready.id, revision: p.revision })).revision, p.revision);
      assert.equal((await fetch((await studio.handlers['studio/edit/source/playback']({ id: p.id, sourceId: ready.id })).url)).status, 200);
      p = await studio.handlers['studio/edit/retake/undo']({ id: p.id, revision: p.revision }); assert.deepEqual(p.edit, before);
      const uncertain = await studio.handlers['studio/edit/retake/start']({ ...input, revision: p.revision, prompt: 'uncertain fixture', idempotencyKey: 'unknown-retake' });
      assert.equal((await waitRetake(uncertain.id)).phase, 'needs-review');
      await studio.close(); studio = createMediaStudio({ home, rpc, library }); await studio.initialize();
      assert.equal((await waitRetake(uncertain.id)).phase, 'needs-review'); assert.equal(submissions.length, 2, 'uncertain generation is never replayed');
      await studio.handlers['studio/edit/retake/cancel']({ id: uncertain.id }); assert.equal((await waitRetake(uncertain.id)).status, 'cancelled');
      for (const shot of shots) assert.equal(await hash(path.join(studio.root, shot.result.outputName)), shot.result.outputSha256);
    } finally { retakeServer.closeAllConnections(); await new Promise(resolve => retakeServer.close(resolve)); }
    assert.equal(fs.readdirSync(path.join(studio.root, 'edits')).filter(n => n.startsWith('render-')).length, 0);
  } finally {
    await studio?.close();
    if (session?.child.exitCode === null) { session.child.stdin.end(); await Promise.race([once(session.child, 'close'), delay(5000).then(() => { if (session.child.exitCode === null) session.child.kill(); })]); }
    if (path.dirname(home) === base && path.basename(home).startsWith('.tmp-video-edit-')) fs.rmSync(home, { recursive: true, force: true });
  }
});
