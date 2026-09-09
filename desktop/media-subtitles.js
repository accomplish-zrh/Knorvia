'use strict';
const fs = require('node:fs');
const path = require('node:path');
const P = require('./studio-providers');
const { withLock, tryLock } = require('./media-lock');
const { run, hash } = require('./media-composition-worker');
const { parseSrt, toSrt } = require('./studio-subtitles');
const METHODS = ['studio/edit/subtitles/config', 'studio/edit/subtitles/config/save', 'studio/edit/subtitles/start', 'studio/edit/subtitles/read', 'studio/edit/subtitles/cancel', 'studio/edit/subtitles/apply', 'studio/edit/subtitles/import', 'studio/edit/subtitles/export'];
const terminal = j => ['succeeded', 'cancelled', 'failed'].includes(j.status);
function createSubtitleEngine({ rpc, studio, library, root, readProject, sourceFile, worker, projectLock, checkpoint }) {
  const configFile = path.join(root, 'transcription.json'), active = new Map();
  let closed = false;
  const lock = (id, fn) => withLock(path.join(root, `${P.id(id)}.subtitles`), fn);
  const visible = j => { const { config, ...c } = j.checkpoint ?? {}; return { id: j.id, status: j.status, ...c }; };
  const config = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return { executable: '', model: '', language: 'auto' }; } };
  async function validate(value) {
    for (const key of ['executable', 'model']) {
      if (typeof value[key] !== 'string' || !path.isAbsolute(value[key]) || !fs.existsSync(value[key]) || !fs.statSync(value[key]).isFile()) P.fail(key === 'executable' ? '请选择本地 whisper-cli 程序' : '请选择本地 Whisper 模型文件');
    }
    if (!/^whisper-cli(?:\.exe)?$/i.test(path.basename(value.executable))) P.fail('请选择 whisper.cpp 的 whisper-cli 程序');
    if (!/^(auto|[a-z]{2,3})$/.test(value.language ?? 'auto')) P.fail('语言应为 auto 或语言代码，例如 zh、en');
    const help = await run(value.executable, ['--help'], undefined, 15000);
    // Some whisper.cpp versions print help to stderr; executable validation
    // relies on its exit status and the pinned executable/model hashes.
    void help;
    return { executable: path.resolve(value.executable), model: path.resolve(value.model), language: value.language || 'auto', executableSha256: await hash(value.executable), modelSha256: await hash(value.model) };
  }
  async function read(id) {
    const j = await rpc('job/read', { id: P.id(id) });
    if (j.workspaceId !== studio.workspaceId() || j.type !== 'studio.subtitle') P.fail('找不到字幕识别任务');
    return j;
  }
  async function publish(id, captions) {
    const file = path.join(root, `${id}.srt`), content = toSrt(captions);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== content) P.fail('字幕文件已经变化，原文件已保留');
    if (!fs.existsSync(file)) fs.writeFileSync(file, content, { flag: 'wx' });
    const sha256 = await hash(file), destination = `字幕/${id}.srt`;
    const index = await library.handlers['library/list']();
    let entry = index.entries.find(e => !e.trashedAt && e.path === destination);
    if (entry && entry.sha256 !== sha256) P.fail('资料库中的字幕已修改，原文件已保留');
    if (!entry) entry = await library.put(file, destination);
    return { libraryId: entry.id, sha256 };
  }
  async function work(id, signal) {
    const owner = tryLock(path.join(root, `${id}.subtitle-owner`));
    if (!owner) return;
    const directory = path.join(root, `subtitle-${id}`);
    const clean = () => { if (path.dirname(path.resolve(directory)) !== path.resolve(root) || path.basename(directory) !== `subtitle-${P.id(id)}`) throw new Error('Invalid subtitle directory'); fs.rmSync(directory, { recursive: true, force: true }); };
    try {
      await withLock(path.join(root, 'transcription.slot'), async () => {
        const j = await read(id), c = j.checkpoint;
        if (terminal(j)) return;
        if (c.cancelRequested) throw new Error('cancelled');
        const progress = async value => lock(id, async () => { const latest = await read(id); if (latest.checkpoint.cancelRequested) throw new Error('cancelled'); await checkpoint(id, { ...latest.checkpoint, phase: value >= 35 ? 'recognizing' : 'preparing', progress: value }); });
        let captions = c.captions;
        if (!captions) {
          if (await hash(c.config.executable) !== c.config.executableSha256 || await hash(c.config.model) !== c.config.modelSha256) P.fail('识别程序或模型已经变化，请重新创建识别任务');
          clean();
          const wav = await worker().renderAudio({ edit: c.edit, sources: c.sources.map(s => ({ ...s, file: sourceFile(s) })), directory, signal, progress });
          await progress(35);
          const prefix = path.join(directory, 'recognized');
          await run(c.config.executable, ['-m', c.config.model, '-f', wav, '-l', c.config.language, '-osrt', '-of', prefix, '-t', '4'], signal, 2 * 60 * 60 * 1000);
          signal.throwIfAborted();
          const file = `${prefix}.srt`;
          if (!fs.existsSync(file) || fs.statSync(file).size > 2 * 1024 ** 2) P.fail('识别程序没有返回有效字幕');
          // Clamp only recognizer rounding at the media boundary; never silently
          // repair arbitrary user-imported timelines.
          const frames = c.edit.clips.reduce((n, clip) => n + clip.endFrame - clip.startFrame, 0);
          // Whisper may emit a ten-second [BLANK_AUDIO] sentinel even for
          // shorter silence. It is not a spoken caption or a timing failure.
          const recognized = fs.readFileSync(file, 'utf8').replace(/\r/g, '').split(/\n\s*\n/).filter(block => !/\n\s*\[BLANK_AUDIO\]\s*$/.test(block)).join('\n\n');
          captions = parseSrt(recognized, frames + 3).filter(cue => cue.startFrame < frames).map(cue => ({ ...cue, endFrame: Math.min(cue.endFrame, frames) }));
          if (!captions.length) P.fail('没有识别到语音，可检查音轨或手动添加字幕');
        }
        signal.throwIfAborted();
        await lock(id, async () => {
          const latest = await read(id);
          if (latest.checkpoint.cancelRequested) throw new Error('cancelled');
          await checkpoint(id, { ...latest.checkpoint, captions, phase: 'publishing', progress: 95 });
          const output = await publish(id, captions);
          await checkpoint(id, { ...latest.checkpoint, captions, ...output, phase: 'completed', progress: 100 });
          await rpc('job/finish', { jobId: id, status: 'succeeded' });
        });
      }, { signal, timeoutMs: 24 * 60 * 60 * 1000 });
    } catch (e) {
      if (closed) return;
      await lock(id, async () => {
        const j = await read(id); if (terminal(j)) return;
        const cancelled = j.checkpoint.cancelRequested || signal.aborted;
        if (!cancelled) console.error('[studio-subtitles]', id, e);
        await checkpoint(id, { ...j.checkpoint, phase: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : e.rpc?.message || '字幕识别失败，请检查本地程序、模型与音轨' });
        await rpc('job/finish', { jobId: id, status: cancelled ? 'cancelled' : 'failed' });
      });
    } finally { clean(); owner.release(); }
  }
  function schedule(id) {
    if (closed || active.has(id)) return;
    const controller = new AbortController(), item = { controller };
    active.set(id, item);
    item.promise = work(id, controller.signal).catch(e => console.error('[studio-subtitles] recovery pending', e)).finally(() => active.delete(id));
  }
  const handlers = {
    'studio/edit/subtitles/config': async () => config(),
    'studio/edit/subtitles/config/save': async p => { const value = await validate(p); P.atomic(configFile, value); return value; },
    'studio/edit/subtitles/start': async p => {
      await studio.initialize();
      return projectLock(p.id, async () => {
        const project = await readProject(p.id), c = project.checkpoint;
        if (c.revision !== p.revision) P.fail('请保存最新剪辑后再识别字幕');
        const job = await rpc('job/create', { workspaceId: studio.workspaceId(), type: 'studio.subtitle', idempotencyKey: `subtitle-${project.id}-${P.id(p.idempotencyKey)}` });
        let existing = await read(job.id);
        if (existing.checkpoint && existing.checkpoint.revision !== p.revision) P.fail('此识别请求已用于另一个工程版本');
        if (!existing.checkpoint) {
          const settings = await validate(config());
          existing = await checkpoint(job.id, { projectId: project.id, revision: c.revision, edit: c.edit, sources: c.sources, config: settings, phase: 'queued', progress: 0 });
        }
        await checkpoint(project.id, { ...c, lastSubtitleId: job.id });
        if (!terminal(existing)) schedule(job.id);
        return visible(existing);
      });
    },
    'studio/edit/subtitles/read': async p => { await studio.initialize(); return visible(await read(p.id)); },
    'studio/edit/subtitles/cancel': async p => {
      await studio.initialize();
      await lock(p.id, async () => { const j = await read(p.id); if (!terminal(j)) { await checkpoint(j.id, { ...j.checkpoint, phase: 'cancelling', cancelRequested: true }); active.get(j.id)?.controller.abort(); } });
      if (active.has(p.id)) await active.get(p.id).promise;
      else schedule(p.id);
      return visible(await read(p.id));
    },
    'studio/edit/subtitles/apply': async p => {
      await studio.initialize();
      const job = await read(p.id), c = job.checkpoint;
      if (job.status !== 'succeeded') P.fail('字幕尚未识别完成');
      return projectLock(c.projectId, async () => {
        const project = await readProject(c.projectId), edit = project.checkpoint;
        if (edit.appliedSubtitleId === job.id) return { id: project.id, ...edit };
        if (edit.revision !== c.revision || edit.revision !== p.revision) P.fail('剪辑已变化，字幕保留在资料库中；请重新识别或手动导入');
        return { id: project.id, ...(await checkpoint(project.id, { ...edit, edit: { ...edit.edit, captions: c.captions }, revision: edit.revision + 1, appliedSubtitleId: job.id })).checkpoint };
      });
    },
    'studio/edit/subtitles/import': async p => {
      await studio.initialize();
      return projectLock(p.id, async () => {
        const project = await readProject(p.id), c = project.checkpoint;
        if (p.revision !== c.revision) P.fail('工程已更新，请重新打开');
        const frames = c.edit.clips.reduce((n, clip) => n + clip.endFrame - clip.startFrame, 0);
        return { id: project.id, ...(await checkpoint(project.id, { ...c, revision: c.revision + 1, edit: { ...c.edit, captions: parseSrt(p.content, frames) } })).checkpoint };
      });
    },
    'studio/edit/subtitles/export': async p => {
      await studio.initialize();
      const project = await readProject(p.id), c = project.checkpoint;
      if (p.revision !== c.revision) P.fail('请保存最新字幕后再导出');
      if (!c.edit.captions?.length) P.fail('还没有字幕');
      return publish(`${project.id}-v${c.revision}`, c.edit.captions);
    },
  };
  return { handlers, async recover() {
    let offset = 0;
    for (;;) {
      const page = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: 'studio.subtitle', offset, limit: 1 });
      if (!page.jobs.length) break;
      for (const j of page.jobs) if (!terminal(j) && j.checkpoint) schedule(j.id);
      offset += page.jobs.length; if (offset >= page.total) break;
    }
  }, async close() { closed = true; for (const item of active.values()) item.controller.abort(); await Promise.allSettled([...active.values()].map(i => i.promise)); } };
}
module.exports = { createSubtitleEngine, METHODS };
