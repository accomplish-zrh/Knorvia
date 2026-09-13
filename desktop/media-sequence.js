'use strict';

// Durable storyboard sequences for the creation studio. Each sequence is one
// Rust job of type `studio.sequence` (never matched by the legacy `media.`
// recovery scan); its shots are ordinary media.video jobs driven through the
// single media-studio engine. A completed shot's real tail frame becomes the
// next shot's pinned first frame — the chain is serial, one remote generation
// in flight per sequence, and an unknown submission blocks everything below.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const P = require('./studio-providers');
const { tryLock, withLock } = require('./media-lock');

const METHODS = [
  'studio/sequence/create', 'studio/sequence/read', 'studio/sequence/list', 'studio/sequence/update',
  'studio/sequence/start', 'studio/sequence/pause', 'studio/sequence/resume', 'studio/sequence/cancel',
  'studio/sequence/preview', 'studio/sequence/retry',
];
const PREFIX = 'studio.sequence';
const TERMINAL_JOB = job => ['succeeded', 'failed', 'cancelled'].includes(job.status);
const MAX_SHOTS = 200;
const MAX_DETAIL_BYTES = 3 * 1024 * 1024;
const now = () => new Date().toISOString();

function createSequenceEngine({ home, rpc, library, studio, templates, pollMs = 2500, heartbeatMs = 5000, staleMs = 25000 }) {
  const root = path.join(studio.root);
  const lockDir = path.join(root, 'sequence-locks');
  fs.mkdirSync(lockDir, { recursive: true });
  const dispatchLocks = new Map();
  const runners = new Map(); // sequence jobId -> {controller, promise}
  let closed = false;

  // Never steal dispatch from a live process, even during a long generation.
  const lockFile = jobId => path.join(lockDir, `${P.id(jobId)}.json`);
  function acquire(jobId) {
    const lock = tryLock(lockFile(jobId), { staleMs });
    if (!lock) return false;
    dispatchLocks.set(jobId, lock); return true;
  }
  function heartbeat(jobId) {
    if (!dispatchLocks.get(jobId)?.owns()) throw new Error('Sequence dispatch ownership lost');
  }
  function release(jobId) {
    dispatchLocks.get(jobId)?.release(); dispatchLocks.delete(jobId);
  }

  const readSeq = async jobId => {
    const job = await rpc('job/read', { id: P.id(jobId) });
    if (job.type !== PREFIX) P.fail('Not a storyboard sequence');
    return job;
  };
  const checkpoint = async (jobId, value) => (await rpc('job/checkpoint', { jobId, checkpoint: value })).checkpoint;
  const mutate = (jobId, action) => withLock(path.join(lockDir, `${P.id(jobId)}.mutation`), action, { staleMs });
  const patchCheckpoint = async (jobId, patch) => mutate(jobId, async () => {
    const job = await readSeq(jobId);
    if (TERMINAL_JOB(job)) P.fail('This sequence is already finished');
    return checkpoint(jobId, { ...job.checkpoint, ...patch, updatedAt: now() });
  });
  const mutateShot = async (jobId, shotId, patch) => mutate(jobId, async () => {
    const job = await readSeq(jobId);
    const c = job.checkpoint;
    const shots = c.shots.map(shot => shot.id === shotId ? { ...shot, ...(typeof patch === 'function' ? patch(shot) : patch) } : shot);
    return checkpoint(jobId, { ...c, shots, updatedAt: now() });
  });
  const findShot = (c, shotId) => c.shots.find(shot => shot.id === shotId);

  // Template revision pinned on the shot; accepted prompts are never
  // recomposed from a newer revision.
  function compose(shot, globalPrompt) {
    let prompt = shot.prompt;
    if (shot.templateId) {
      const rendered = typeof shot.templateSnapshot === 'string' ? shot.templateSnapshot : templates.renderRevision(shot.templateId, shot.templateRevision, shot.templateParams || {});
      prompt = rendered;
    }
    prompt = prompt.trim();
    const head = (globalPrompt || '').trim();
    return head ? `${head}\n\n${prompt}` : prompt;
  }
  function pinTemplate(shot, previous) {
    if (!shot.templateId) return;
    if (previous?.templateId === shot.templateId && previous.templateRevision === shot.templateRevision && JSON.stringify(previous.templateParams || {}) === JSON.stringify(shot.templateParams || {}) && typeof previous.templateSnapshot === 'string') {
      shot.templateSnapshot = previous.templateSnapshot; return;
    }
    shot.templateRevision ??= templates.get(shot.templateId).revision;
    shot.templateSnapshot = templates.renderRevision(shot.templateId, shot.templateRevision, shot.templateParams || {});
  }
  function normalizeShots(inputs, defaults) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > MAX_SHOTS) P.fail(`分镜数量需在 1–${MAX_SHOTS} 之间`);
    const ids = new Set();
    return inputs.map((raw, order) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) P.fail('Invalid shot');
      const prompt = P.text(raw.prompt, 12000);
      if (!prompt && !raw.templateId) P.fail('每个分镜需要提示词或模板');
      const profileId = P.id(raw.profileId || defaults.profileId);
      const continuity = raw.continuity === undefined ? (order > 0 ? 'previous-tail' : 'none') : P.text(raw.continuity, 20);
      if (!['previous-tail', 'none'].includes(continuity)) P.fail("continuity 需为 'previous-tail' 或 'none'");
      if (continuity === 'previous-tail' && order === 0) P.fail('第一个分镜不能续接前一段');
      if (raw.templateId !== undefined) { P.id(raw.templateId); }
      if (raw.templateRevision !== undefined && !Number.isInteger(raw.templateRevision)) P.fail('Invalid template revision');
      const params = raw.templateParams === undefined ? undefined : P.safeObject(raw.templateParams);
      let firstFrame;
      if (raw.firstFrame && continuity === 'none') {
        const ref = raw.firstFrame;
        if (!ref || typeof ref !== 'object' || Array.isArray(ref) || typeof ref.version !== 'string' || !/^[a-f0-9]{64}$/i.test(ref.version)) P.fail('首帧需要资料库图片及其固定版本');
        firstFrame = { id: P.id(ref.id), version: ref.version.toLowerCase(), ...(ref.name ? { name: P.text(ref.name, 500) } : {}) };
      }
      const shotId = raw.id ? P.id(raw.id) : `shot-${crypto.randomBytes(6).toString('hex')}`;
      if (ids.has(shotId)) P.fail('Duplicate shot id');
      ids.add(shotId);
      return {
        id: shotId,
        order,
        prompt,
        ...(raw.templateId ? { templateId: raw.templateId, templateRevision: raw.templateRevision, ...(params ? { templateParams: params } : {}) } : {}),
        profileId,
        seconds: Number.isInteger(raw.seconds ?? defaults.seconds) && (raw.seconds ?? defaults.seconds) >= 1 && (raw.seconds ?? defaults.seconds) <= 60 ? raw.seconds ?? defaults.seconds : P.fail('Invalid shot seconds'),
        continuity,
        ...(firstFrame ? { firstFrame } : {}),
        status: order > 0 && continuity === 'previous-tail' ? 'waiting-dependency' : 'ready',
        attempt: 0,
      };
    });
  }
  async function validateVideoProfiles(shots, defaults) {
    for (const shot of shots) {
      if (shot.jobId || shot.acceptedPrompt) continue;
      const profile = studio.profiles.get(shot.profileId || defaults.profileId);
      if (profile.kind !== 'video') P.fail('分镜队列目前只支持视频模型连接');
      // A continuation will obtain its real first frame from the predecessor.
      // Check capabilities before creating the durable queue, but leave byte
      // pinning/availability to the single media engine at actual submission.
      if (profile.protocol) P.validateInputs(profile, { references: [], count: 1, firstFrame: shot.continuity === 'previous-tail' ? { id: 'previous-tail' } : shot.firstFrame });
    }
  }
  function publicShot(shot, job) {
    return {
      id: shot.id, order: shot.order, prompt: shot.prompt, profileId: shot.profileId,
      ...(shot.templateId ? { templateId: shot.templateId, templateRevision: shot.templateRevision, templateParams: shot.templateParams || {}, ...(typeof shot.templateSnapshot === 'string' ? { templateSnapshot: shot.templateSnapshot } : {}) } : {}),
      seconds: shot.seconds, continuity: shot.continuity, status: shot.status, attempt: shot.attempt,
      ...(shot.acceptedPrompt ? { acceptedPrompt: shot.acceptedPrompt } : {}),
      ...(shot.firstFrame ? { firstFrame: shot.firstFrame } : {}),
      ...(shot.jobId ? { jobId: shot.jobId } : {}),
      ...(job ? { job: { id: job.id, status: job.status, phase: job.phase, progress: job.progress, error: job.error, outputs: job.outputs, remoteMayContinue: job.remoteMayContinue } } : {}),
      ...(shot.result ? { result: shot.result } : {}),
      ...(shot.error ? { error: shot.error } : {}),
      ...(shot.submittedAt ? { submittedAt: shot.submittedAt } : {}),
      ...(shot.completedAt ? { completedAt: shot.completedAt } : {}),
    };
  }
  function checkDocumentLimit(title, globalPrompt, shots) {
    const projected = { title, globalPrompt, shots: shots.map(shot => publicShot({ ...shot, acceptedPrompt: shot.acceptedPrompt || compose(shot, globalPrompt) })) };
    // Reserve space for per-shot output/first-frame/error metadata that arrives
    // after generation. Quantity and total content are independent limits.
    if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > MAX_DETAIL_BYTES - 512 * 1024) P.fail('队列总内容超出 3 MiB 详情上限，请减少提示词或拆分队列');
  }
  async function publicSequence(job, details = true) {
    const c = job.checkpoint || {};
    const shots = await Promise.all(c.shots?.map(async shot => {
      let jobPublic;
      if (details && shot.jobId && shot.status !== 'completed') { try { const raw = await rpc('job/read', { id: shot.jobId }); jobPublic = { ...raw, ...raw.checkpoint }; } catch { jobPublic = undefined; } }
      return details ? publicShot(shot, jobPublic) : { id: shot.id, order: shot.order, status: shot.status, prompt: '', profileId: shot.profileId, seconds: shot.seconds, continuity: shot.continuity, attempt: shot.attempt };
    })) ?? [];
    const result = {
      id: job.id, title: c.title, state: c.state, revision: c.revision,
      globalPrompt: details ? c.globalPrompt : '', defaults: c.defaults,
      shots,
      ...(c.blockedReason ? { blockedReason: c.blockedReason } : {}),
      createdAt: job.createdAt, updatedAt: job.updatedAt,
      progress: c.shots?.length ? Math.round(c.shots.filter(s => s.status === 'completed').length / c.shots.length * 100) : 0,
    };
    if (details && Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_DETAIL_BYTES) P.fail('此旧队列详情超过 3 MiB 上限，请拆分内容后读取');
    return result;
  }
  const getSequence = async jobId => publicSequence(await readSeq(jobId));

  // One runner per sequence. Shots dispatch strictly in order; the current
  // remote generation keeps being tracked through a pause, and only a cancel
  // (or shutdown) abandons tracking.
  async function runSequence(jobId, signal) {
    if (!acquire(jobId)) return; // another live owner dispatches this sequence
    try {
      let job = await readSeq(jobId);
      if (TERMINAL_JOB(job)) return;
      let c = job.checkpoint;
      if (!c || ['completed', 'failed', 'cancelled', 'paused', 'needs-attention'].includes(c.state)) return;
      if (c.state === 'ready') c = await patchCheckpoint(jobId, { state: 'running', startedAt: c.startedAt ?? now() });
      const shots = () => c.shots;
      for (let index = 0; index < shots().length; index++) {
        heartbeat(jobId);
        if (signal.aborted || closed) return;
        job = await readSeq(jobId);
        if (TERMINAL_JOB(job)) return;
        c = job.checkpoint;
        const shot = shots()[index];
        if (shot.status === 'completed') continue;
        if (c.state !== 'running') {
          // Paused: keep tracking an already-submitted shot to its durable
          // outcome, but stop before dispatching anything new. Anything else
          // (cancelled, ready) just ends the runner here.
          if (!(c.state === 'paused' && shot.status === 'submitted' && shot.jobId)) return;
        }
        if (['failed', 'cancelled', 'blocked'].includes(shot.status)) {
          await patchCheckpoint(jobId, { state: 'needs-attention', blockedReason: `分镜 ${index + 1} 未完成（${shot.status}），后续分镜已停止派发` });
          return;
        }
        // 1. Pin the dependency: the previous shot's real tail frame.
        if (shot.continuity === 'previous-tail') {
          const prev = shots()[index - 1];
          if (prev?.status !== 'completed') {
            await mutateShot(jobId, shot.id, { status: 'blocked', error: '前一段尚未完成' });
            await patchCheckpoint(jobId, { state: 'needs-attention', blockedReason: `分镜 ${index + 1} 的前一段未完成` });
            return;
          }
          let tail = prev.result?.tailFrame;
          if (!tail) {
            tail = await studio.exportTailFrameForJob(prev.jobId, prev.result?.outputIndex ?? 0, signal);
            await mutateShot(jobId, prev.id, s => ({ ...s, result: { ...s.result, tailFrame: tail } }));
          }
          await mutateShot(jobId, shot.id, s => ({
            ...s,
            firstFrame: { id: tail.libraryId, version: tail.libraryVersion, name: tail.libraryName },
            ...(s.status === 'waiting-dependency' ? { status: 'ready' } : {}),
          }));
        }
        // 2. Compose once per attempt and persist the accepted prompt before
        // any submission, so a restart never recomposes from changed inputs.
        let fresh = (await readSeq(jobId)).checkpoint;
        let me = findShot(fresh, shot.id);
        if (!me.acceptedPrompt) {
          let composed;
          try { composed = compose(me, fresh.globalPrompt); }
          catch (error) {
            await mutateShot(jobId, shot.id, { status: 'blocked', error: error.rpc?.message || error.message });
            await patchCheckpoint(jobId, { state: 'needs-attention', blockedReason: `分镜 ${index + 1} 的提示词模板不可用` });
            return;
          }
          if (!composed) {
            await mutateShot(jobId, shot.id, { status: 'blocked', error: '提示词为空' });
            await patchCheckpoint(jobId, { state: 'needs-attention', blockedReason: `分镜 ${index + 1} 的提示词为空` });
            return;
          }
          await mutateShot(jobId, shot.id, { acceptedPrompt: composed });
          me = findShot((await readSeq(jobId)).checkpoint, shot.id);
        }
        // 3. Submit through the one idempotent studio path. A crash before
        // this create simply re-runs it with the same key and inputs.
        let shotJobId = me.jobId;
        if (!shotJobId) {
          // Recheck after input preparation: pause/cancel may have arrived
          // while reading a template or extracting a dependency frame.
          if ((await readSeq(jobId)).checkpoint.state !== 'running') return;
          const key = `seq-${jobId}-${me.id}-${me.attempt}`;
          let created;
          try {
            created = await studio.create({
              profileId: me.profileId, prompt: me.acceptedPrompt, seconds: me.seconds,
              size: fresh.defaults?.size ?? '1280x720', aspect: fresh.defaults?.aspect ?? '16:9',
              firstFrame: me.firstFrame, idempotencyKey: key,
            }, fresh.agentRequested === true);
          } catch (error) {
            await mutateShot(jobId, shot.id, { status: 'blocked', error: error.rpc?.message || error.message });
            await patchCheckpoint(jobId, { state: 'needs-attention', blockedReason: `分镜 ${index + 1} 提交失败：${error.rpc?.message || error.message}` });
            return;
          }
          shotJobId = created.id;
          await mutateShot(jobId, me.id, s => ({ ...s, jobId: created.id, status: 'submitted', submittedAt: now() }));
        }
        // 4. Track the remote generation to a durable outcome.
        const outcome = await waitShot(shotJobId, signal);
        if (signal.aborted || closed) return;
        if (outcome.status === 'stalled') {
          const reason = outcome.phase === 'needs-connection' ? '模型连接不可用'
            : outcome.phase === 'unknown' ? '提交结果未知，不能自动重发'
              : outcome.phase === 'stopped' ? '分镜已被手动停止'
                : '分镜已暂停';
          await mutateShot(jobId, me.id, { status: 'blocked', error: outcome.error || reason });
          await patchCheckpoint(jobId, { state: 'needs-attention', blockedReason: `分镜 ${index + 1} ${reason}；请在创作记录中处理后再继续队列` });
          return;
        }
        if (outcome.status === 'succeeded') {
          const outputs = outcome.outputs || [];
          if (!outputs.length) {
            await mutateShot(jobId, me.id, { status: 'failed', error: '生成完成但没有输出' });
            await patchCheckpoint(jobId, { state: 'failed', blockedReason: `分镜 ${index + 1} 没有输出` });
            await rpc('job/finish', { jobId, status: 'failed' });
            return;
          }
          let tail;
          try { tail = await studio.exportTailFrameForJob(shotJobId, 0, signal); }
          catch (error) {
            await mutateShot(jobId, me.id, { status: 'blocked', error: `尾帧提取失败：${error.rpc?.message || error.message}` });
            await patchCheckpoint(jobId, { state: 'needs-attention', blockedReason: `分镜 ${index + 1} 的尾帧提取失败` });
            return;
          }
          await mutateShot(jobId, me.id, s => ({
            ...s, status: 'completed', completedAt: now(),
            result: { outputIndex: 0, outputName: outputs[0].name, outputSha256: outputs[0].sha256, artifactId: outcome.artifactId, ...(outcome.usage ? { usage: outcome.usage } : {}), tailFrame: tail },
          }));
          continue;
        }
        if (outcome.status === 'failed' && outcome.phase === 'unknown') {
          // The remote outcome is unknown; nothing may be resubmitted or
          // dispatched below until a human resolves this shot.
          await mutateShot(jobId, me.id, { status: 'blocked', error: outcome.error || '提交结果未知，不能自动重发' });
          await patchCheckpoint(jobId, { state: 'needs-attention', blockedReason: `分镜 ${index + 1} 提交结果未知；请先在创作记录中查询或重建该任务` });
          return;
        }
        if (outcome.status === 'cancelled') {
          await mutateShot(jobId, me.id, { status: 'cancelled' });
          await patchCheckpoint(jobId, { state: 'needs-attention', blockedReason: `分镜 ${index + 1} 已取消` });
          return;
        }
        await mutateShot(jobId, me.id, { status: 'failed', error: outcome.error || '生成失败' });
        await patchCheckpoint(jobId, { state: 'needs-attention', blockedReason: `分镜 ${index + 1} 生成失败，后续分镜已停止派发` });
        return;
      }
      // 5. Every shot completed.
      await patchCheckpoint(jobId, { state: 'completed', completedAt: now(), blockedReason: undefined });
      await rpc('job/finish', { jobId, status: 'succeeded' });
    } catch (error) {
      if (closed || signal.aborted) return;
      console.error('[media-sequence] runner failed', jobId, error);
      try { await patchCheckpoint(jobId, { state: 'needs-attention', blockedReason: '队列执行中断，可安全继续' }); } catch { }
    } finally { release(jobId); }
  }
  async function waitShot(shotJobId, signal) {
    for (;;) {
      signal.throwIfAborted();
      const job = await rpc('job/read', { id: shotJobId });
      if (TERMINAL_JOB(job)) {
        return { status: job.status, phase: job.checkpoint?.phase, error: job.checkpoint?.error, outputs: job.checkpoint?.outputs, artifactId: job.checkpoint?.artifactId, usage: job.checkpoint?.usage };
      }
      // The single-shot worker stops tracking in these phases and only a
      // human resumes it; the chain must not spin forever behind it.
      if (['paused', 'needs-connection', 'stopped', 'unknown'].includes(job.checkpoint?.phase)) {
        return { status: 'stalled', phase: job.checkpoint.phase, error: job.checkpoint?.error };
      }
      await new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { clearTimeout(timer); reject(new Error('Sequence cancelled')); };
        const timer = setTimeout(done, pollMs);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }
  function schedule(jobId) {
    if (closed || runners.has(jobId)) return;
    const controller = new AbortController();
    const task = { controller, promise: undefined };
    runners.set(jobId, task);
    task.promise = new Promise(resolve => setTimeout(resolve, 10))
      .then(() => runSequence(jobId, controller.signal))
      .catch(error => console.error('[media-sequence] runner crashed', jobId, error))
      .finally(() => runners.delete(jobId));
    task.promise.catch(() => { });
  }
  async function stopRunner(jobId) {
    const task = runners.get(jobId);
    if (task) { task.controller.abort(); await task.promise.catch(() => { }); }
  }
  async function resumeExisting(jobId, shot) {
    if (!shot.jobId) {
      await mutateShot(jobId, shot.id, { status: shot.continuity === 'previous-tail' ? 'waiting-dependency' : 'ready', error: undefined });
      return true;
    }
    const child = await rpc('job/read', { id: shot.jobId });
    if (child.status === 'succeeded') {
      // A local extraction/download failure never requires another paid
      // generation: keep the completed child and repeat only publication.
      await mutateShot(jobId, shot.id, { status: 'submitted', error: undefined });
      return true;
    }
    if (!TERMINAL_JOB(child) && !['unknown', 'stopped'].includes(child.checkpoint?.phase)) {
      if (['paused', 'needs-connection'].includes(child.checkpoint?.phase)) await studio.handlers['studio/resume']({ id: child.id });
      await mutateShot(jobId, shot.id, { status: 'submitted', error: undefined });
      return true;
    }
    return false;
  }

  const handlers = {
    'studio/sequence/create': async params => {
      await studio.initialize();
      const title = P.text(params?.title, 200) || '未命名分镜';
      const globalPrompt = params?.globalPrompt === undefined ? '' : P.text(params.globalPrompt, 12000);
      const defaults = P.safeObject(params?.defaults ?? {});
      const profileId = defaults.profileId ? P.id(defaults.profileId) : P.fail('分镜队列需要默认模型连接');
      const seconds = defaults.seconds ?? 4;
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) P.fail('Invalid default seconds');
      if (defaults.size !== undefined && !/^\d{2,5}x\d{2,5}$/.test(P.text(defaults.size, 30))) P.fail('Invalid default size');
      if (defaults.aspect !== undefined && !P.text(defaults.aspect, 20)) P.fail('Invalid default aspect');
      const shots = normalizeShots(params?.shots, { profileId, seconds });
      const clientKey = P.id(params?.idempotencyKey || crypto.randomUUID());
      const acceptedDefaults = { profileId, seconds, ...(defaults.size ? { size: defaults.size } : {}), ...(defaults.aspect ? { aspect: defaults.aspect } : {}) };
      const identity = () => ({ title, globalPrompt, defaults: acceptedDefaults, start: params?.start === true, shots: shots.map(({ id, status, attempt, ...input }) => input) });
      const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify(identity())).digest('hex');
      const keyHash = crypto.createHash('sha256').update(clientKey).digest('hex');
      const indexFile = path.join(lockDir, `create-${keyHash}.index.json`);
      const conflict = () => { const e = new Error('此提交标识已用于不同的队列内容，请刷新后重试'); e.rpc = { code: -32005, message: e.message }; throw e; };
      return withLock(path.join(lockDir, `create-${keyHash}.lock`), async () => {
        let index;
        try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { }
        if (index?.clientKey === clientKey) {
          if (index.requestFingerprint !== requestFingerprint) conflict();
          const known = await readSeq(index.id);
          if (known.checkpoint) {
            if (known.checkpoint.clientKey !== clientKey || known.checkpoint.requestFingerprint !== requestFingerprint) conflict();
            return publicSequence(known);
          }
        }
        await validateVideoProfiles(shots, { profileId });
        // Resolve dependencies only for a new request. An accepted retry must
        // remain readable after its template or provider connection is removed.
        for (const shot of shots) pinTemplate(shot);
        checkDocumentLimit(title, globalPrompt, shots);
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify(identity())).digest('hex');
        const created = await rpc('job/create', { workspaceId: studio.workspaceId(), type: PREFIX, idempotencyKey: `sequence-${clientKey}` });
        const job = await readSeq(created.id);
        if (job.checkpoint) {
          if (job.checkpoint.requestFingerprint ? job.checkpoint.requestFingerprint !== requestFingerprint : job.checkpoint.fingerprint !== fingerprint) conflict();
          return publicSequence(job);
        }
        // This is only a lookup index: all sequence state remains in the Rust
        // Job. Write before checkpoint/scheduling closes the lost-response gap.
        P.atomic(indexFile, { clientKey, requestFingerprint, id: job.id });
        const checkpointValue = { v: 3, clientKey, fingerprint, requestFingerprint, title, revision: 1, globalPrompt, defaults: acceptedDefaults, agentRequested: params?.agentRequested === true, state: params?.start ? 'running' : 'ready', shots, createdAt: now(), updatedAt: now() };
        await checkpoint(job.id, checkpointValue);
        if (params?.start) schedule(job.id);
        return publicSequence(await readSeq(job.id));
      }, { staleMs });
    },
    'studio/sequence/read': async params => { await studio.initialize(); return getSequence(P.id(params?.id)); },
    'studio/sequence/list': async params => {
      await studio.initialize();
      const offset = Math.max(0, Number(params?.offset) || 0), limit = Math.max(1, Math.min(50, Number(params?.limit) || 20));
      // Rust's internal framing limit applies before this public projection.
      // Fetch one bounded document at a time; a page of twenty full 3 MiB
      // checkpoints would already break the daemon transport before mapping.
      const sequences = []; let total = 0;
      for (let index = 0; index < limit; index++) {
        const page = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: PREFIX, offset: offset + index, limit: 1 });
        total = page.total;
        if (!page.jobs.length) break;
        sequences.push(await publicSequence(page.jobs[0], false));
        if (offset + sequences.length >= total) break;
      }
      const result = { sequences, total };
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_DETAIL_BYTES) P.fail('队列列表超过 3 MiB 上限，请减少每页数量');
      return result;
    },
    'studio/sequence/update': async params => {
      await studio.initialize();
      const jobId = P.id(params?.id);
      return mutate(jobId, async () => {
      const job = await readSeq(jobId);
      const c = job.checkpoint;
      if (TERMINAL_JOB(job)) P.fail('This sequence is already finished');
      if (!Number.isInteger(params?.revision) || params.revision !== c.revision) P.fail('分镜队列已被其他修改更新，请刷新后重试');
      // The shared provider-custom limit is 32 KB, while a real 200-shot
      // edit includes prompts, parameters and immutable snapshots per row.
      const patch = P.safeObject(params?.patch ?? {}, 3 * 1024 * 1024);
      const next = { ...c, revision: c.revision + 1, updatedAt: now() };
      if (patch.title !== undefined) next.title = P.text(patch.title, 200) || next.title;
      if (patch.globalPrompt !== undefined) next.globalPrompt = P.text(patch.globalPrompt, 12000);
      if (Array.isArray(patch.shots)) {
        if (c.state === 'running') P.fail('请先暂停队列，再调整未提交分镜');
        const shots = normalizeShots(patch.shots, c.defaults);
        const fixed = c.shots.filter(shot => shot.jobId || shot.acceptedPrompt);
        for (const shot of fixed) {
          const nextShot = shots[shot.order];
          const frameKey = value => value ? `${value.id}:${value.version}` : '';
          if (!nextShot || nextShot.id !== shot.id || nextShot.prompt !== shot.prompt || nextShot.profileId !== shot.profileId || nextShot.seconds !== shot.seconds || nextShot.continuity !== shot.continuity || (shot.continuity === 'none' && frameKey(nextShot.firstFrame) !== frameKey(shot.firstFrame))) P.fail('已接受分镜及其依赖顺序不可更改');
          shots[shot.order] = shot;
        }
        await validateVideoProfiles(shots, c.defaults);
        for (const shot of shots) pinTemplate(shot, c.shots.find(previous => previous.id === shot.id));
        next.shots = shots;
      } else {
        // Per-shot content edits for shots that have not been submitted.
        const edits = Array.isArray(patch.shotEdits) ? patch.shotEdits : [];
        const shots = c.shots.map(shot => ({ ...shot }));
        for (const edit of edits) {
          const target = shots.find(shot => shot.id === edit?.shotId);
          if (!target) P.fail('Shot not found');
          if (target.jobId || target.acceptedPrompt || ['submitted', 'completed', 'failed', 'cancelled'].includes(target.status)) P.fail('该分镜已接受，不能修改；重试会建立新的 attempt');
          if (edit.prompt !== undefined) target.prompt = P.text(edit.prompt, 12000);
          if (edit.profileId !== undefined) { target.profileId = P.id(edit.profileId); const profile = studio.profiles.get(target.profileId); if (profile.kind !== 'video') P.fail('分镜队列目前只支持视频模型连接'); }
          if (edit.seconds !== undefined) { if (!Number.isInteger(edit.seconds) || edit.seconds < 1 || edit.seconds > 60) P.fail('Invalid seconds'); target.seconds = edit.seconds; }
          if (edit.continuity !== undefined) {
            const continuity = P.text(edit.continuity, 20);
            if (!['previous-tail', 'none'].includes(continuity)) P.fail('Invalid continuity');
            if (continuity === 'previous-tail' && target.order === 0) P.fail('第一个分镜不能续接前一段');
            target.continuity = continuity;
            target.status = continuity === 'previous-tail' ? 'waiting-dependency' : 'ready';
          }
          if (edit.templateId !== undefined) {
            if (edit.templateId === null) { delete target.templateId; delete target.templateRevision; delete target.templateParams; delete target.templateSnapshot; }
            else { const template = templates.get(edit.templateId); target.templateId = template.id; target.templateRevision = template.revision; delete target.templateParams; }
          }
          if (edit.templateParams !== undefined) target.templateParams = P.safeObject(edit.templateParams);
          if (edit.firstFrame !== undefined) {
            if (edit.firstFrame === null) delete target.firstFrame;
            else target.firstFrame = normalizeShots([{ ...target, firstFrame: edit.firstFrame, continuity: 'none' }], c.defaults)[0].firstFrame;
          }
          if (target.continuity === 'previous-tail' && !target.jobId) delete target.firstFrame;
          pinTemplate(target, c.shots.find(previous => previous.id === target.id));
        }
        next.shots = shots;
      }
      await validateVideoProfiles(next.shots, c.defaults);
      checkDocumentLimit(next.title, next.globalPrompt, next.shots);
      await checkpoint(jobId, next);
      return getSequence(jobId);
      });
    },
    'studio/sequence/start': async params => {
      await studio.initialize();
      const jobId = P.id(params?.id);
      const job = await readSeq(jobId);
      if (TERMINAL_JOB(job)) P.fail('This sequence is already finished');
      if (!['ready', 'paused'].includes(job.checkpoint.state)) P.fail(`当前状态 ${job.checkpoint.state} 不能开始`);
      await patchCheckpoint(jobId, { state: 'running', blockedReason: undefined, ...(params.agentRequested === true ? { agentRequested: true } : {}) });
      schedule(jobId);
      return getSequence(jobId);
    },
    'studio/sequence/pause': async params => {
      await studio.initialize();
      const jobId = P.id(params?.id);
      const job = await readSeq(jobId);
      if (TERMINAL_JOB(job)) P.fail('This sequence is already finished');
      if (!['running', 'ready'].includes(job.checkpoint.state)) P.fail(`当前状态 ${job.checkpoint.state} 不能暂停`);
      // Durable pause first: the runner finishes tracking the current remote
      // job, then stops before dispatching anything new.
      await patchCheckpoint(jobId, { state: 'paused' });
      return getSequence(jobId);
    },
    'studio/sequence/resume': async params => {
      await studio.initialize();
      const jobId = P.id(params?.id);
      const job = await readSeq(jobId);
      if (TERMINAL_JOB(job)) P.fail('This sequence is already finished');
      const state = job.checkpoint.state;
      if (['running', 'ready'].includes(state)) return getSequence(jobId);
      if (state === 'completed') P.fail('This sequence is already completed');
      await stopRunner(jobId);
      const fresh = await readSeq(jobId);
      for (const shot of fresh.checkpoint.shots) {
        if (!['blocked', 'failed', 'cancelled'].includes(shot.status)) continue;
        if (!await resumeExisting(jobId, shot)) P.fail('该分镜无法继续原任务；如需重新生成，请明确选择“重新生成”');
      }
      await patchCheckpoint(jobId, { state: 'running', blockedReason: undefined, ...(params.agentRequested === true ? { agentRequested: true } : {}) });
      schedule(jobId);
      return getSequence(jobId);
    },
    'studio/sequence/cancel': async params => {
      await studio.initialize();
      const jobId = P.id(params?.id);
      const job = await readSeq(jobId);
      if (TERMINAL_JOB(job)) return getSequence(jobId);
      await stopRunner(jobId);
      // Cancel the in-flight shot like a studio job: the provider cancel is
      // attempted, and remote continuation stays visible on the shot job.
      const c = (await readSeq(jobId)).checkpoint;
      const active = c.shots.find(shot => shot.jobId && ['submitted'].includes(shot.status));
      if (active) {
        try { await studio.handlers['studio/cancel']({ id: active.jobId }); } catch { }
        await mutateShot(jobId, active.id, { status: 'cancelled' });
      }
      await patchCheckpoint(jobId, { state: 'cancelled', blockedReason: undefined });
      await rpc('job/finish', { jobId, status: 'cancelled' });
      release(jobId);
      return getSequence(jobId);
    },
    'studio/sequence/preview': async params => {
      await studio.initialize();
      const job = await readSeq(P.id(params?.id));
      const c = job.checkpoint;
      const shots = c.shots.map((shot, index) => {
        const warnings = [];
        let prompt;
        try { prompt = shot.acceptedPrompt ?? compose(shot, c.globalPrompt); }
        catch (error) { warnings.push(error.rpc?.message || error.message); prompt = null; }
        if (shot.continuity === 'previous-tail') {
          try {
            const profile = studio.profiles.get(shot.profileId);
            if (!P.inputCapabilities(profile).firstFrame) warnings.push('该模型连接未声明首帧支持，续接提交会被拒绝');
          } catch { warnings.push('模型连接不存在'); }
        }
        const prev = c.shots[index - 1];
        return { shotId: shot.id, order: index, status: shot.status, prompt, ...(shot.acceptedPrompt ? { accepted: true } : {}), ...(shot.templateId ? { templateId: shot.templateId, templateRevision: shot.templateRevision } : {}), firstFrame: shot.firstFrame ?? (shot.continuity === 'previous-tail' && prev?.result?.tailFrame ? { id: prev.result.tailFrame.libraryId, version: prev.result.tailFrame.libraryVersion } : null), warnings };
      });
      return { id: job.id, title: c.title, revision: c.revision, globalPrompt: c.globalPrompt, shots };
    },
    'studio/sequence/retry': async params => {
      await studio.initialize();
      const jobId = P.id(params?.id);
      const job = await readSeq(jobId);
      if (TERMINAL_JOB(job)) P.fail('This sequence is already finished');
      const c = job.checkpoint;
      const shot = findShot(c, P.id(params?.shotId));
      if (!shot) P.fail('Shot not found');
      if (!['failed', 'blocked', 'cancelled'].includes(shot.status)) P.fail('只有失败或被阻塞的分镜可以重试');
      await stopRunner(jobId);
      if (await resumeExisting(jobId, shot)) {
        await patchCheckpoint(jobId, { state: 'running', blockedReason: undefined });
        schedule(jobId); return getSequence(jobId);
      }
      if (params?.confirmRegenerate !== true) P.fail('重新生成会创建新的提交，之前的请求仍可能计费；确认后再试');
      // An unknown-outcome shot may only be retried by this explicit user
      // action — never automatically. The new attempt gets a new submission
      // key, and the UI warns that the earlier request may still have landed
      // and could be billed twice.
      await mutateShot(jobId, shot.id, s => ({
        ...s,
        status: shot.continuity === 'previous-tail' ? 'waiting-dependency' : 'ready',
        attempt: shot.attempt + 1,
        error: undefined,
        jobId: undefined,
        acceptedPrompt: undefined,
        submittedAt: undefined,
        priorAttempts: [...(s.priorAttempts || []), { jobId: s.jobId, attempt: s.attempt, acceptedPrompt: s.acceptedPrompt, error: s.error }],
        // the pinned firstFrame stays: it points at the same immutable
        // library version the previous attempt used
      }));
      await patchCheckpoint(jobId, { state: 'running', blockedReason: undefined });
      schedule(jobId);
      return getSequence(jobId);
    },
  };

  // Crash/restart recovery: sequence roots the store still marks running are
  // re-claimed and continue. Paused and needs-attention sequences wait for
  // an explicit user action, by design.
  async function recover() {
    let offset = 0;
    for (;;) {
      const page = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: PREFIX, offset, limit: 1 });
      for (const job of page.jobs) {
        if (TERMINAL_JOB(job) || !job.checkpoint) continue;
        if (job.checkpoint.state === 'running') schedule(job.id);
      }
      offset += page.jobs.length;
      if (offset >= page.total || !page.jobs.length) return;
    }
  }

  // C20 activity contract: a sequence runner counts as outstanding work from
  // schedule until its runner settles; paused sequences contribute nothing.
  return { handlers, METHODS, recover, schedule, get pendingCount() { return runners.size; }, async close() { closed = true; await Promise.allSettled([...runners.keys()].map(jobId => stopRunner(jobId))); } };
}

module.exports = { createSequenceEngine, METHODS, PREFIX };
