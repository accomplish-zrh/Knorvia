'use strict';
// Opt-in real whisper.cpp acceptance. No mocked recognizer or remote model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const root = process.env.KNORVIA_TEST_DESKTOP_ROOT || path.resolve(__dirname, '..');
const { createMediaStudio } = require(path.join(root, 'media-studio'));
const { createPersonalLibrary } = require(path.join(root, 'personal-library'));
const { startKnorviaDaemon, initializeRequest } = require(path.join(root, 'knorvia-protocol-client'));
const { createCompositionWorker, hash } = require(path.join(root, 'media-composition-worker'));
const evidence = process.env.KNORVIA_WHISPER_EVIDENCE;
test('real whisper: English, Chinese, silence, cancel, restart and export', { skip: !evidence || !process.env.KNORVIA_WHISPER_CLI, timeout: 240000 }, async () => {
  const home = fs.mkdtempSync(path.join(evidence, 'home-'));
  const session = startKnorviaDaemon({ home, daemonBin: process.env.KNORVIA_DAEMON_BIN, env: { ...process.env, KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1' }, requestTimeoutMs: 30000 });
  let counter = 0, studio; const results = {};
  const rpc = async (method, params = {}) => { const r = await session.request({ jsonrpc: '2.0', id: `real-${++counter}`, method, params }); if (r.error) throw new Error(r.error.message); return r.result; };
  const worker = createCompositionWorker();
  const ffmpeg = require(path.join(root, 'media-frame-worker')).resolveBinaries().ffmpeg;
  try {
    assert.ok(!(await session.request(initializeRequest('real_whisper', '1'))).error);
    session.notify({ jsonrpc: '2.0', method: 'initialized' });
    const library = createPersonalLibrary({ home, rpc });
    studio = createMediaStudio({ home, rpc, library }); await studio.initialize();
    const seed = async language => {
      const media = await rpc('job/create', { workspaceId: studio.workspaceId(), type: 'media.video', idempotencyKey: `voice-${language}` });
      const name = `${media.id}-1.mp4`, file = path.join(studio.root, name);
      const input = language === 'silence' ? ['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3'] : ['-i', path.join(evidence, `${language}.wav`), '-shortest'];
      execFileSync(ffmpeg, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=navy:s=160x90:r=30', ...input, '-c:v', require('./fixtures/encoder').pickH264Encoder(ffmpeg), '-c:a', 'aac', '-y', file], { windowsHide: true, timeout: 30000 });
      const info = await worker.probe(file);
      await rpc('job/checkpoint', { jobId: media.id, checkpoint: { kind: 'video', outputs: [{ name, size: info.size, sha256: info.sha256, mime: 'video/mp4' }] } });
      await rpc('job/finish', { jobId: media.id, status: 'succeeded' });
      const sequence = await rpc('job/create', { workspaceId: studio.workspaceId(), type: 'studio.sequence', idempotencyKey: `sequence-${language}` });
      await rpc('job/checkpoint', { jobId: sequence.id, checkpoint: { title: `Real ${language}`, revision: 1, state: 'completed', shots: [{ id: `shot-${language}`, prompt: language, jobId: media.id, status: 'completed', result: { outputIndex: 0, outputSha256: info.sha256 } }] } });
      await rpc('job/finish', { jobId: sequence.id, status: 'succeeded' });
      return studio.handlers['studio/edit/create']({ sequenceId: sequence.id });
    };
    const configure = language => studio.handlers['studio/edit/subtitles/config/save']({ executable: process.env.KNORVIA_WHISPER_CLI, model: process.env.KNORVIA_WHISPER_MODEL, language });
    const wait = async (id, phase) => { for (let i = 0; i < 900; i++) { const j = await studio.handlers['studio/edit/subtitles/read']({ id }); if (phase && j.phase === phase || ['succeeded', 'failed', 'cancelled'].includes(j.status)) return j; await delay(50); } throw new Error('Real transcription timed out'); };
    for (const language of ['english', 'chinese', ...(fs.existsSync(path.join(evidence, 'jfk.wav')) ? ['jfk'] : []), 'silence']) {
      let p = await seed(language); await configure(language === 'chinese' ? 'zh' : 'en');
      const accepted = await studio.handlers['studio/edit/subtitles/start']({ id: p.id, revision: p.revision, idempotencyKey: language });
      const j = await wait(accepted.id); results[language] = j;
      if (language === 'silence') { assert.equal(j.status, 'failed', JSON.stringify(j)); assert.match(j.error, /没有识别到语音/); continue; }
      assert.equal(j.status, 'succeeded', JSON.stringify(j));
      const text = j.captions.map(c => c.text).join(' ');
      assert.match(text, language === 'chinese' ? /天气.*公园/ : language === 'jfk' ? /country.*country/i : /fox.*captions/i);
      p = await studio.handlers['studio/edit/subtitles/apply']({ id: j.id, revision: p.revision });
      assert.deepEqual(p.edit.captions, j.captions);
      const render = await studio.handlers['studio/edit/export']({ id: p.id, revision: p.revision, idempotencyKey: language });
      let film; for (let i = 0; i < 500; i++) { film = await studio.handlers['studio/edit/render/read']({ id: render.id }); if (['succeeded', 'failed'].includes(film.status)) break; await delay(50); }
      assert.equal(film.status, 'succeeded', JSON.stringify(film));
      const file = path.join(studio.root, 'edits', film.output.name);
      fs.copyFileSync(file, path.join(evidence, `${language}-captioned.mp4`));
      if (language === 'english') {
        const cancel = await studio.handlers['studio/edit/subtitles/start']({ id: p.id, revision: p.revision, idempotencyKey: 'cancel' });
        assert.equal((await wait(cancel.id, 'recognizing')).phase, 'recognizing');
        await studio.handlers['studio/edit/subtitles/cancel']({ id: cancel.id }); results.cancel = await wait(cancel.id); assert.equal(results.cancel.status, 'cancelled');
        const restart = await studio.handlers['studio/edit/subtitles/start']({ id: p.id, revision: p.revision, idempotencyKey: 'restart' });
        assert.equal((await wait(restart.id, 'recognizing')).phase, 'recognizing');
        await studio.close(); studio = createMediaStudio({ home, rpc, library }); await studio.initialize();
        results.restart = await wait(restart.id); assert.equal(results.restart.status, 'succeeded', JSON.stringify(results.restart));
      }
    }
    results.passed = true;
  } finally {
    results.executableSha256 = await hash(process.env.KNORVIA_WHISPER_CLI); results.modelSha256 = await hash(process.env.KNORVIA_WHISPER_MODEL);
    results.home = home; results.at = new Date().toISOString();
    fs.writeFileSync(path.join(evidence, 'real-result.json'), JSON.stringify(results, null, 2));
    await studio?.close(); session.child.stdin.end(); await Promise.race([once(session.child, 'close'), delay(5000).then(() => { if (session.child.exitCode === null) session.child.kill(); })]);
  }
});
