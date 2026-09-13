'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('./studio-providers');
const { withLock, tryLock } = require('./media-lock');
const { createCompositionWorker, normalizeEdit, hash } = require('./media-composition-worker');
const SUB = require('./media-subtitles');
const RETAKE = require('./media-retake');
const { createLibraryImport } = require('./media-edit-import');
const METHODS = ['studio/edit/import', 'studio/edit/list', 'studio/edit/create', 'studio/edit/read', 'studio/edit/update', 'studio/edit/export', 'studio/edit/source/playback', 'studio/edit/render/read', 'studio/edit/render/cancel', 'studio/edit/render/playback', ...SUB.METHODS, ...RETAKE.METHODS];
const finished = job => ['succeeded', 'failed', 'cancelled'].includes(job.status);
function createCompositionEngine({ rpc, studio, library, playback }) {
  const root = path.join(studio.root, 'edits');
  fs.mkdirSync(root, { recursive: true });
  const active = new Map();
  let closed = false, worker;
  const getWorker = () => worker ??= createCompositionWorker();
  const lock = (id, action, options) => withLock(path.join(root, `${P.id(id)}.mutation`), action, options);
  const read = async (id, type = 'studio.edit') => {
    const job = await rpc('job/read', { id: P.id(id) });
    if (job.workspaceId !== studio.workspaceId() || job.type !== type) P.fail('找不到这个剪辑工程');
    return job;
  };
  const checkpoint = (id, value) => rpc('job/checkpoint', { jobId: id, checkpoint: value });
  const visible = job => ({ id: job.id, status: job.status, updatedAt: job.updatedAt, ...job.checkpoint });
  const sourceFile = source => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,120}\.(mp4|webm)$/.test(source.name)) P.fail('无效的视频素材记录');
    return path.join(studio.root, source.name);
  };
  async function create(params) {
    await studio.initialize();
    const sequence = await studio.handlers['studio/sequence/read']({ id: params.sequenceId });
    return lock(`sequence-${sequence.id}`, async () => {
      const job = await rpc('job/create', { workspaceId: studio.workspaceId(), type: 'studio.edit', idempotencyKey: `edit-sequence-${sequence.id}` });
      const existing = await read(job.id);
      if (existing.checkpoint) return visible(existing);
      const shots = sequence.shots.filter(s => s.status === 'completed' && s.jobId && s.result);
      if (!shots.length) P.fail('至少完成一个分镜后才能剪辑成片');
      const sources = [];
      for (const shot of shots) {
        const media = await studio.handlers['studio/read']({ id: shot.jobId });
        const index = shot.result.outputIndex ?? 0, output = media.outputs[index];
        if (media.status !== 'succeeded' || !output || output.sha256 !== shot.result.outputSha256) P.fail('分镜输出记录不一致');
        const info = await getWorker().probe(sourceFile(output));
        if (info.sha256 !== output.sha256 || info.size !== output.size) P.fail('分镜源文件校验失败');
        sources.push({ id: shot.id, jobId: shot.jobId, index, name: output.name, sha256: output.sha256, frames: info.frames, hasAudio: info.hasAudio, title: shot.prompt.slice(0, 100) });
      }
      const edit = normalizeEdit({ clips: sources.map(s => ({ id: s.id })) }, sources);
      return visible(await checkpoint(job.id, { title: sequence.title, sequenceId: sequence.id, revision: 1, sources, edit, phase: 'editing' }));
    });
  }
  async function run(id, signal) {
    const owner = tryLock(path.join(root, `${id}.owner`));
    if (!owner) return;
    // Only one FFmpeg renderer per personal home, including multiple hosts.
    const directory = path.join(root, `render-${P.id(id)}`);
    const clean = () => {
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(root) || path.basename(resolved) !== `render-${id}`) throw new Error('Invalid renderer directory');
      fs.rmSync(resolved, { recursive: true, force: true });
    };
    try {
      await withLock(path.join(root, 'renderer.slot'), async () => {
        let job = await read(id, 'studio.render');
        if (finished(job)) return;
        const c = job.checkpoint;
        if (!c || c.cancelRequested) { await rpc('job/finish', { jobId: id, status: 'cancelled' }); return; }
        clean();
        const output = c.output ? { ...c.output, file: path.join(root, `${id}.mp4`) } : await getWorker().render({ edit: c.edit, sources: c.sources.map(s => ({ ...s, file: sourceFile(s) })), directory, signal, progress: progress => lock(id, async () => {
          const latest = await read(id, 'studio.render');
          if (latest.checkpoint.cancelRequested) throw Object.assign(new Error('导出已取消'), { cancelled: true });
          await checkpoint(id, { ...latest.checkpoint, phase: 'rendering', progress });
        }) });
        signal.throwIfAborted();
        await lock(id, async () => {
          job = await read(id, 'studio.render');
          if (job.checkpoint.cancelRequested) throw Object.assign(new Error('导出已取消'), { cancelled: true });
          // Publication is a short critical section. Unique output path and
          // content-addressed library writes make restart publication idempotent.
          const name = `${id}.mp4`, file = path.join(root, name);
          if (fs.existsSync(file)) {
            if (await hash(file) !== output.sha256) P.fail('已存在不同内容的成片，请新建导出');
          } else fs.copyFileSync(output.file, file, fs.constants.COPYFILE_EXCL);
          const { file: unused, ...metadata } = output;
          await checkpoint(id, { ...job.checkpoint, phase: 'publishing', output: { ...metadata, name } });
          const destination = `成片/${id}.mp4`;
          const index = await library.handlers['library/list']();
          let entry = index.entries.find(e => !e.trashedAt && e.path === destination);
          if (entry && entry.sha256 !== output.sha256) P.fail('资料库中的成片已经被修改，原文件已保留');
          if (!entry) entry = await library.put(file, destination);
          const artifact = await rpc('artifact/create', { workspaceId: studio.workspaceId(), title: c.title, type: 'application/vnd.knorvia.edit+json', idempotencyKey: `${id}-artifact` });
          await rpc('artifact/stage', { id: artifact.id, content: JSON.stringify({ projectId: c.projectId, revision: c.revision, edit: c.edit, sources: c.sources, output: { name, sha256: output.sha256 }, libraryId: entry.id }), idempotencyKey: `${id}-stage` });
          await rpc('artifact/commit', { id: artifact.id, idempotencyKey: `${id}-commit` });
          await checkpoint(id, { ...job.checkpoint, phase: 'completed', progress: 100, output: { ...metadata, name }, libraryId: entry.id, artifactId: artifact.id });
          await rpc('job/finish', { jobId: id, status: 'succeeded' });
        });
      }, { signal, timeoutMs: 24 * 60 * 60 * 1000 });
    } catch (error) {
      if (closed) return; // interruption remains durable and can resume locally
      await lock(id, async () => {
        const job = await read(id, 'studio.render');
        if (finished(job)) return;
        const cancelled = job.checkpoint.cancelRequested || error.cancelled || signal.aborted;
        if (!cancelled) console.error('[studio-edit] render failed', id, error);
        await checkpoint(id, { ...job.checkpoint, phase: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : error.rpc?.message || '导出失败，请检查 FFmpeg、源文件与磁盘空间后重试' });
        await rpc('job/finish', { jobId: id, status: cancelled ? 'cancelled' : 'failed' });
      });
    } finally { clean(); owner.release(); }
  }
  function schedule(id) {
    if (closed || active.has(id)) return;
    const controller = new AbortController();
    const item = { controller, promise: null };
    active.set(id, item);
    item.promise = run(id, controller.signal).catch(error => console.error('[studio-edit] deferred to recovery', error)).finally(() => active.delete(id));
  }
  const handlers = {
    'studio/edit/import': createLibraryImport({ rpc, studio, library, lock, read, checkpoint, visible, worker: getWorker }),
    'studio/edit/list': async (p = {}) => {
      await studio.initialize();
      let offset = Number.isSafeInteger(p.offset) && p.offset >= 0 ? p.offset : 0, total = 0;
      const projects = [];
      for (let count = 0; count < 30; count++) {
        const page = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: 'studio.edit', offset, limit: 1 });
        total = page.total;
        if (!page.jobs.length) break;
        for (const job of page.jobs) if (job.type === 'studio.edit' && job.checkpoint?.edit) projects.push({ id: job.id, title: job.checkpoint.title, updatedAt: job.updatedAt });
        offset += page.jobs.length;
        if (offset >= total) break;
      }
      return { projects, nextOffset: offset < total ? offset : null };
    },
    'studio/edit/create': create,
    'studio/edit/read': async p => { await studio.initialize(); return visible(await read(p.id)); },
    'studio/edit/source/playback': async p => { await studio.initialize(); const j = await read(p.id); const source = j.checkpoint.sources.find(s => s.id === p.sourceId); if (!source) P.fail('找不到视频素材'); const file = sourceFile(source); if (await hash(file) !== source.sha256) P.fail('视频素材已变化'); return playback.issue({ ...source, file, size: fs.statSync(file).size, mime: source.name.endsWith('.webm') ? 'video/webm' : 'video/mp4' }); },
    'studio/edit/update': async p => {
      await studio.initialize();
      return lock(p.id, async () => {
        const job = await read(p.id), c = job.checkpoint;
        if (p.revision !== c.revision) P.fail('工程已在其他窗口更新，请重新打开后编辑');
        const edit = normalizeEdit(p.edit, c.sources);
        return visible(await checkpoint(job.id, { ...c, edit, revision: c.revision + 1 }));
      });
    },
    'studio/edit/export': async p => {
      await studio.initialize();
      return lock(p.id, async () => {
        const project = await read(p.id), c = project.checkpoint;
        const token = P.id(p.idempotencyKey);
        if (p.revision !== c.revision) P.fail('请保存最新剪辑后再导出');
        const job = await rpc('job/create', { workspaceId: studio.workspaceId(), type: 'studio.render', idempotencyKey: `edit-export-${project.id}-${token}` });
        const existing = await read(job.id, 'studio.render');
        if (existing.checkpoint && existing.checkpoint.revision !== p.revision) P.fail('此导出请求已用于另一个工程版本');
        const accepted = existing.checkpoint ? existing : await checkpoint(job.id, { projectId: project.id, revision: c.revision, title: c.title, edit: c.edit, sources: c.sources, phase: 'queued', progress: 0 });
        await checkpoint(project.id, { ...c, lastRenderId: job.id });
        if (!finished(accepted)) schedule(job.id);
        return visible(accepted);
      });
    },
    'studio/edit/render/read': async p => { await studio.initialize(); const job = await read(p.id, 'studio.render'); return visible(job); },
    'studio/edit/render/cancel': async p => {
      await studio.initialize();
      await lock(p.id, async () => {
        const job = await read(p.id, 'studio.render');
        if (finished(job)) return;
        await checkpoint(job.id, { ...job.checkpoint, cancelRequested: true });
        active.get(job.id)?.controller.abort();
      });
      if (active.has(p.id)) await active.get(p.id).promise;
      return visible(await read(p.id, 'studio.render'));
    },
    'studio/edit/render/playback': async p => {
      await studio.initialize(); const job = await read(p.id, 'studio.render'), output = job.checkpoint?.output;
      if (job.status !== 'succeeded' || !output || output.name !== `${job.id}.mp4`) P.fail('成片尚未完成');
      return playback.issue({ ...output, file: path.join(root, output.name) });
    },
  };
  const subtitles = SUB.createSubtitleEngine({ rpc, studio, library, root, readProject: read, sourceFile, worker: getWorker, projectLock: lock, checkpoint });
  const retake = RETAKE.createRetakeEngine({ rpc, studio, library, playback, root, readProject: read, sourceFile, worker: getWorker, projectLock: lock, checkpoint });
  Object.assign(handlers, subtitles.handlers, retake.handlers);
  // C20 activity contract: outstanding edit renders (scheduled to settled).
  return { handlers, get pendingCount() { return active.size; }, async recover() {
    await subtitles.recover();
    await retake.recover();
    let offset = 0;
    for (;;) {
      const page = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: 'studio.render', offset, limit: 1 });
      if (!page.jobs.length) break;
      for (const job of page.jobs) if (!finished(job)) schedule(job.id);
      offset += page.jobs.length;
      if (offset >= page.total) break;
    }
  }, async close() { closed = true; await retake.close(); await subtitles.close(); for (const item of active.values()) item.controller.abort(); await Promise.allSettled([...active.values()].map(item => item.promise)); } };
}
module.exports = { createCompositionEngine, METHODS };
