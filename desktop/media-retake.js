'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const P = require('./studio-providers');
const { withLock, tryLock } = require('./media-lock');
const { hash, normalizeEdit } = require('./media-composition-worker');
const METHODS = ['studio/edit/retake/start', 'studio/edit/retake/read', 'studio/edit/retake/cancel', 'studio/edit/retake/playback', 'studio/edit/retake/apply', 'studio/edit/retake/undo'];
const terminal = j => ['succeeded', 'failed', 'cancelled'].includes(j.status);
function createRetakeEngine({ rpc, studio, library, playback, root, readProject, sourceFile, worker, projectLock, checkpoint }) {
  const active = new Map(); let closed = false;
  const lock = (id, fn) => withLock(path.join(root, `${P.id(id)}.retake`), fn);
  const visible = j => ({ id: j.id, status: j.status, ...j.checkpoint });
  async function read(id) { const j = await rpc('job/read', { id: P.id(id) }); if (j.workspaceId !== studio.workspaceId() || j.type !== 'studio.retake') P.fail('找不到局部重做任务'); return j; }
  async function work(id, signal) {
    const owner = tryLock(path.join(root, `${id}.retake-owner`)); if (!owner) return;
    const directory = path.join(root, `retake-${id}`);
    const clean = () => { if (path.dirname(path.resolve(directory)) !== path.resolve(root) || path.basename(directory) !== `retake-${P.id(id)}`) throw new Error('Invalid retake directory'); fs.rmSync(directory, { recursive: true, force: true }); };
    const update = async fn => lock(id, async () => { const j = await read(id); if (j.checkpoint.cancelRequested) throw new Error('cancelled'); return checkpoint(id, fn(j.checkpoint)); });
    try {
      let j = await read(id), c = j.checkpoint;
      if (terminal(j)) return;
      if (c.cancelRequested) throw new Error('cancelled');
      const source = { ...c.source, file: sourceFile(c.source) };
      if (await hash(source.file) !== source.sha256) P.fail('原视频已变化，重做已停止');
      if (!c.references) {
        const images = await worker().boundaryFrames({ source, startFrame: c.startFrame, endFrame: c.endFrame, directory, signal });
        const references = {};
        for (const role of ['firstFrame', 'lastFrame']) {
          const destination = `重做参考/${id}-${role}.png`, sha256 = await hash(images[role]);
          const index = await library.handlers['library/list']();
          let entry = index.entries.find(e => !e.trashedAt && e.path === destination);
          if (entry && entry.sha256 !== sha256) P.fail('边界参考图已修改，请新建重做任务');
          if (!entry) entry = await library.put(images[role], destination);
          references[role] = { id: entry.id, version: entry.sha256 };
        }
        c = (await update(value => ({ ...value, references }))).checkpoint;
      }
      // The child generation owns submission uncertainty and provider recovery.
      // Retake always reuses one stable key, including a crash before recording
      // the returned child id. No second remote request is manufactured here.
      if (!c.childId) {
        await lock(id, async () => {
          const latest = await read(id); if (latest.checkpoint.cancelRequested) throw new Error('cancelled');
          const child = await studio.create({ profileId: c.profileId, prompt: c.prompt, seconds: Math.ceil((c.endFrame - c.startFrame) / 30), aspect: c.aspect, ...c.references, idempotencyKey: `retake-${id}` }, c.agentRequested);
          c = (await checkpoint(id, { ...latest.checkpoint, childId: child.id, phase: 'generating' })).checkpoint;
        });
      }
      let child;
      for (;;) {
        signal.throwIfAborted();
        if ((await read(id)).checkpoint.cancelRequested) throw new Error('cancelled');
        child = await studio.handlers['studio/read']({ id: c.childId });
        if (child.status === 'succeeded') break;
        if (['unknown', 'needs-connection', 'paused'].includes(child.phase) || child.status === 'paused') { await update(value => ({ ...value, phase: 'needs-review', error: child.error || '请先在创作台检查已有生成任务，然后重新打开重做结果' })); return; }
        if (['failed', 'cancelled'].includes(child.status)) P.fail(child.error || '重做片段生成未完成');
        await update(value => ({ ...value, phase: 'generating', progress: child.progress ?? 0 }));
        await delay(1500, undefined, { signal });
      }
      await withLock(path.join(root, 'renderer.slot'), async () => {
        await update(value => ({ ...value, phase: 'preparing-candidate', error: undefined }));
        const latest = (await read(id)).checkpoint;
        let candidate = latest.candidate;
        if (!candidate) {
          const output = child.outputs?.[0]; if (!output) P.fail('模型没有返回视频');
          const adjusted = await worker().retime({ source: { ...output, file: sourceFile(output) }, frames: c.endFrame - c.startFrame, directory: path.join(directory, 'adjusted'), signal });
          const sources = [{ ...source, id: 'before' }, { ...adjusted, id: 'replacement' }, { ...source, id: 'after' }];
          const clips = [
            ...(c.clip.startFrame < c.startFrame ? [{ id: 'before', startFrame: c.clip.startFrame, endFrame: c.startFrame }] : []),
            { id: 'replacement', startFrame: 0, endFrame: c.endFrame - c.startFrame },
            ...(c.endFrame < c.clip.endFrame ? [{ id: 'after', startFrame: c.endFrame, endFrame: c.clip.endFrame }] : []),
          ];
          const info = await worker().probe(source.file, signal);
          const rendered = await worker().render({ edit: { aspect: c.aspect, clips }, sources, directory: path.join(directory, 'candidate'), signal, canvas: { width: Math.ceil(info.width / 2) * 2, height: Math.ceil(info.height / 2) * 2 } });
          signal.throwIfAborted();
          const name = `${id}-candidate.mp4`, file = path.join(studio.root, name);
          if (fs.existsSync(file)) { if (await hash(file) !== rendered.sha256) P.fail('已存在不同的候选视频，原文件已保留'); }
          else fs.copyFileSync(rendered.file, file, fs.constants.COPYFILE_EXCL);
          candidate = { name, sha256: rendered.sha256, size: rendered.size, mime: 'video/mp4', frames: rendered.frames, hasAudio: true };
        }
        await update(value => ({ ...value, candidate, phase: 'ready', progress: 100 }));
        await lock(id, async () => { const latest = await read(id); if (latest.checkpoint.cancelRequested) throw new Error('cancelled'); await rpc('job/finish', { jobId: id, status: 'succeeded' }); });
      }, { signal, timeoutMs: 24 * 60 * 60 * 1000 });
    } catch (e) {
      if (closed) return;
      await lock(id, async () => {
        const j = await read(id); if (terminal(j)) return;
        const cancelled = j.checkpoint.cancelRequested || signal.aborted;
        if (!cancelled) console.error('[studio-retake]', id, e);
        await checkpoint(id, { ...j.checkpoint, phase: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : e.rpc?.message || '局部重做失败，请检查原视频和生成结果' });
        await rpc('job/finish', { jobId: id, status: cancelled ? 'cancelled' : 'failed' });
      });
    } finally { clean(); owner.release(); }
  }
  function schedule(id) {
    if (closed || active.has(id)) return;
    const controller = new AbortController(), item = { controller };
    active.set(id, item); item.promise = work(id, controller.signal).catch(e => console.error('[studio-retake] recovery pending', e)).finally(() => active.delete(id));
  }
  const handlers = {
    'studio/edit/retake/start': async p => {
      await studio.initialize();
      return projectLock(p.id, async () => {
        const project = await readProject(p.id), c = project.checkpoint;
        if (p.revision !== c.revision) P.fail('请保存最新剪辑后再局部重做');
        const clip = c.edit.clips.find(clip => clip.id === p.clipId), source = c.sources.find(source => source.id === p.clipId);
        if (!clip || !source) P.fail('找不到选定镜头');
        if (!Number.isSafeInteger(p.startFrame) || !Number.isSafeInteger(p.endFrame) || p.startFrame < clip.startFrame || p.endFrame > clip.endFrame || p.endFrame <= p.startFrame || p.endFrame - p.startFrame > 1800) P.fail('重做范围需在当前镜头内，最长 60 秒');
        const profile = studio.profiles.get(p.profileId), caps = P.inputCapabilities(profile);
        if (profile.kind !== 'video' || !caps.firstFrame || !caps.lastFrame) P.fail('请选择同时支持首帧和尾帧的视频模型');
        if (p.agentRequested && !profile.agentEnabled) P.fail('此模型未启用 Agent 调用');
        const prompt = P.text(p.prompt, 8000); if (!prompt) P.fail('请输入局部重做要求');
        const input = { revision: c.revision, clipId: p.clipId, startFrame: p.startFrame, endFrame: p.endFrame, profileId: profile.id, prompt, agentRequested: p.agentRequested === true };
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
        const job = await rpc('job/create', { workspaceId: studio.workspaceId(), type: 'studio.retake', idempotencyKey: `retake-${project.id}-${P.id(p.idempotencyKey)}` });
        let existing = await read(job.id);
        if (existing.checkpoint && existing.checkpoint.fingerprint !== fingerprint) P.fail('此请求已经用于不同的重做内容');
        if (!existing.checkpoint) existing = await checkpoint(job.id, { ...input, fingerprint, projectId: project.id, source, clip, aspect: c.edit.aspect, phase: 'preparing', progress: 0 });
        await checkpoint(project.id, { ...c, lastRetakeId: job.id });
        if (!terminal(existing)) schedule(job.id);
        return visible(existing);
      });
    },
    'studio/edit/retake/read': async p => { await studio.initialize(); const j = await read(p.id); if (!terminal(j)) schedule(j.id); return visible(j); },
    'studio/edit/retake/cancel': async p => {
      await studio.initialize(); let childId;
      await lock(p.id, async () => { const j = await read(p.id); if (!terminal(j)) { childId = j.checkpoint.childId; await checkpoint(j.id, { ...j.checkpoint, phase: 'cancelling', cancelRequested: true }); active.get(j.id)?.controller.abort(); } });
      if (childId) await studio.handlers['studio/cancel']({ id: childId });
      if (active.has(p.id)) await active.get(p.id).promise; else schedule(p.id);
      return visible(await read(p.id));
    },
    'studio/edit/retake/playback': async p => { await studio.initialize(); const j = await read(p.id); if (j.status !== 'succeeded' || !j.checkpoint.candidate) P.fail('候选片段尚未完成'); const c = j.checkpoint.candidate; return playback.issue({ ...c, file: sourceFile(c) }); },
    'studio/edit/retake/apply': async p => {
      await studio.initialize(); const job = await read(p.id), c = job.checkpoint;
      if (job.status !== 'succeeded' || !c.candidate) P.fail('候选片段尚未完成');
      return projectLock(c.projectId, async () => {
        const project = await readProject(c.projectId), current = project.checkpoint;
        if (current.appliedRetakeId === job.id) return { id: project.id, ...current };
        if (current.revision !== p.revision || current.revision !== c.revision) P.fail('剪辑已变化，候选片段已保留；请重新检查当前工程');
        if (await hash(sourceFile(c.candidate)) !== c.candidate.sha256) P.fail('候选文件已变化');
        const source = { ...c.candidate, id: job.id, title: c.prompt.slice(0, 100), jobId: c.childId, index: 0 };
        const sources = [...current.sources, source];
        const clips = current.edit.clips.map(clip => clip.id === c.clip.id ? { ...clip, id: source.id, startFrame: 0, endFrame: c.candidate.frames } : clip);
        const edit = normalizeEdit({ ...current.edit, clips }, sources);
        const result = await checkpoint(project.id, { ...current, sources, edit, revision: current.revision + 1, appliedRetakeId: job.id, retakeUndo: { id: job.id, revision: current.revision + 1, edit: current.edit } });
        return { id: project.id, ...result.checkpoint };
      });
    },
    'studio/edit/retake/undo': async p => {
      await studio.initialize();
      return projectLock(p.id, async () => {
        const project = await readProject(p.id), c = project.checkpoint;
        if (!c.retakeUndo || p.revision !== c.revision || c.retakeUndo.revision !== c.revision) P.fail('剪辑已继续修改，请通过原素材重新编辑');
        return { id: project.id, ...(await checkpoint(project.id, { ...c, edit: c.retakeUndo.edit, revision: c.revision + 1, appliedRetakeId: null, retakeUndo: null })).checkpoint };
      });
    },
  };
  return { handlers, async recover() { let offset = 0; for (;;) { const page = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: 'studio.retake', offset, limit: 1 }); if (!page.jobs.length) break; for (const j of page.jobs) if (!terminal(j) && j.checkpoint) schedule(j.id); offset += page.jobs.length; if (offset >= page.total) break; } }, async close() { closed = true; for (const item of active.values()) item.controller.abort(); await Promise.allSettled([...active.values()].map(i => i.promise)); } };
}
module.exports = { createRetakeEngine, METHODS };
