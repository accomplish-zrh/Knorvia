'use strict';

// Optional domain worker. The Rust store owns Jobs and Artifacts; this worker
// owns provider I/O and immutable media bytes, never another Agent loop.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('./studio-providers');
const FW = require('./media-frame-worker');
const SEQ = require('./media-sequence');
const EDIT = require('./media-composition');
const ARTICLE = require('./article-video');
const WORKFLOW = require('./studio-workflow');
const TPL = require('./studio-templates');
const { createMediaPlayback } = require('./media-playback');
const PET = require('./pet-service');
const BASE_METHODS = ['studio/models', 'studio/model/save', 'studio/model/remove', 'studio/model/test', 'studio/list', 'studio/create', 'studio/read', 'studio/cancel', 'studio/resume', 'studio/content', 'studio/library'];
const METHODS = [...BASE_METHODS, ...SEQ.METHODS, ...EDIT.METHODS, ...ARTICLE.METHODS, ...TPL.METHODS, ...PET.METHODS, 'studio/frame/export', 'studio/frame/content', 'studio/playback', 'studio/workflow/inspect'];
const terminal = job => ['succeeded', 'failed', 'cancelled'].includes(job.status);
const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' };
const OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,120}\.(png|jpg|webp|gif|mp4|webm)$/;
// Provider-facing messages already carry a deliberate user-facing wording;
// anything else is sanitized before it reaches the UI or the Agent.
const expose = error => error.rpc?.message || (error.expose === true ? error.message : 'The media request failed unexpectedly; details were written to the application log');
function extension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'gif';
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (bytes.subarray(0, 4).equals(Buffer.from([26,69,223,163]))) return 'webm';
  P.fail('The response is not a supported image or video file');
}
function createMediaStudio({ home, rpc, library, safeStorage, pollMs = 2500, maxActiveJobs = 3 }) {
  const root = path.join(home, 'artifacts', 'media-studio');
  fs.mkdirSync(root, { recursive: true });
  const playback = createMediaPlayback({ root });
  const profiles = P.createProfiles({ home, safeStorage });
  const active = new Map(); const waiting = []; const pendingCreates = new Map();
  let workspace; let initializing; let closed = false;
  // FFmpeg is resolved lazily so a machine without it still boots the studio;
  // frame export then reports a clear, actionable dependency state.
  let frameWorker;
  const getFrameWorker = () => { if (!frameWorker) frameWorker = FW.createFrameWorker({}); return frameWorker; };
  const read = async jobId => {
    const job = await rpc('job/read', { id: P.id(jobId) });
    if (job.workspaceId !== workspace || !job.type.startsWith('media.')) P.fail('Not a personal creation job');
    return job;
  };
  const checkpoint = (job, value) => rpc('job/checkpoint', { jobId: job.id, checkpoint: value });
  const responseFile = jobId => path.join(root, `${jobId}-response.json`);
  const publicJob = job => ({ id: job.id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt, ...job.checkpoint, provider: job.checkpoint?.provider ? { name: job.checkpoint.provider.name, model: job.checkpoint.provider.model } : undefined, remote: job.checkpoint?.remote ? { id: job.checkpoint.remote.id } : undefined });
  async function* all() {
    let offset = 0;
    // A media checkpoint includes provider configuration and remote metadata.
    // Bound each internal Rust frame, and do not retain the whole job history
    // in memory merely to find unfinished work during restart.
    do { const page = await rpc('job/list', { workspaceId: workspace, typePrefix: 'media.', offset, limit: 1 }); for (const job of page.jobs) yield job; offset += page.jobs.length; if (offset >= page.total || !page.jobs.length) return; } while (true);
  }
  async function initialize() {
    if (!initializing) initializing = (async () => {
      const ws = await rpc('workspace/create', { title: '个人创作', idempotencyKey: 'media-studio-workspace-v1' }); workspace = ws.id;
      for await (const job of all()) if (!terminal(job)) schedule(job.id);
      // Sequence roots use their own type prefix and explicit dispatch; the
      // legacy media.* scan above never sees them.
      await sequenceEngine.recover();
      await compositionEngine.recover();
      await articleEngine.recover();
    })().catch(error => { initializing = undefined; throw error; });
    return initializing;
  }
  // A bounded scheduler keeps one slow video queue or a stuck download from
  // occupying every worker slot.
  function schedule(jobId) {
    if (closed || active.has(jobId) || waiting.includes(jobId)) return;
    if (active.size >= maxActiveJobs) { waiting.push(jobId); return; }
    start(jobId);
  }
  function start(jobId) {
    const controller = new AbortController();
    const task = { controller, promise: undefined };
    active.set(jobId, task);
    task.promise = new Promise(resolve => setTimeout(resolve, 10)).then(() => run(jobId, controller.signal)).finally(() => {
      active.delete(jobId);
      const next = waiting.shift();
      if (next && !closed && !active.has(next)) start(next);
    });
    // A lost control transport leaves a durable checkpoint for restart.
    task.promise.catch(() => {});
  }
  function unschedule(jobId) {
    const index = waiting.indexOf(jobId);
    if (index >= 0) waiting.splice(index, 1);
  }
  async function references(input) {
    const result = [];
    const inputs = [...input.references.map(ref => ({ ...ref, role: undefined })), ...['firstFrame', 'lastFrame'].flatMap(role => input[role] ? [{ ...input[role], role }] : [])];
    for (const reference of inputs) {
      // Versions were pinned when the job was accepted; the worker never
      // silently resolves a later edit of the file.
      const version = reference.version || P.fail('This job predates reference pinning; create a new submission to use the current reference');
      let offset = 0, length = 0; const chunks = []; let name;
      do {
        const part = await library.handlers['library/read']({ id: reference.id, version, offset });
        if (part.size > 20 * 1024 * 1024) P.fail('Reference image exceeds 20 MB');
        const bytes = Buffer.from(part.base64, 'base64'); length += bytes.length;
        if (length > 20 * 1024 * 1024 || (part.nextOffset !== null && (!Number.isInteger(part.nextOffset) || part.nextOffset <= offset))) P.fail('Invalid reference image data');
        name = part.entry.name; chunks.push(bytes); offset = part.nextOffset;
      } while (offset !== null);
      const bytes = Buffer.concat(chunks), ext = extension(bytes);
      if (!mimeTypes[ext].startsWith('image/')) P.fail('Reference must be an image');
      result.push({ bytes, name, mime: mimeTypes[ext], role: reference.role });
    }
    return result;
  }
  // Pin every accepted reference to an immutable library version before the
  // first provider submission so resumed jobs read exactly what was accepted.
  async function pinReferences(references) {
    const index = await library.handlers['library/list']();
    return references.map(ref => {
      const entry = index.entries.find(item => item.id === ref.id && !item.trashedAt);
      if (!entry) P.fail('A reference is missing from the personal library');
      return { id: ref.id, version: ref.version || entry.sha256, name: entry.name };
    });
  }
  // Frozen usage schema (night-shift contract v1): one attempts[] slot per
  // Rust job attempt. A silent provider still records known:false with empty
  // units — absence is information, never fabricated zeros.
  function mergeUsage(c, p, remote, attemptNo) {
    const record = P.normalizeUsage(p, remote, { requestId: remote.id });
    if (!record.attempts[0].known && c.usage) return c.usage; // never downgrade a known record
    const slot = Math.max(0, (Number(attemptNo) || 1) - 1);
    const attempts = [...(c.usage?.attempts ?? [])];
    if (attempts[slot]?.known === record.attempts[0].known && JSON.stringify(attempts[slot]?.units) === JSON.stringify(record.attempts[0].units)) return { ...c.usage, requestId: record.requestId ?? c.usage.requestId };
    attempts[slot] = record.attempts[0];
    return { providerId: record.providerId, protocol: record.protocol, model: record.model, requestId: record.requestId, attempts: attempts.filter(Boolean) };
  }
  async function run(jobId, signal) {
    let job = await read(jobId); if (terminal(job) || closed) return;
    let c = job.checkpoint;
    try {
      if (!c) { await rpc('job/finish', { jobId, status: 'failed' }); return; }
      let current;
      try { current = profiles.get(c.profileId); }
      catch { await checkpoint(job, { ...c, phase: 'needs-connection', error: 'The model connection for this job no longer exists. Recreate a connection with the same address and model, then resume.' }); return; }
      if (current.baseUrl !== c.provider.baseUrl || current.model !== c.provider.model || (c.hadKey && !current.apiKey)) {
        await checkpoint(job, { ...c, phase: 'needs-connection', error: 'Restore the original model connection and resume this job.' }); return;
      }
      const p = { ...c.provider, apiKey: current.apiKey };
      if (c.refreshOutcome && c.remote?.id) {
        // Renew an expired delivery URL by querying the accepted job, never
        // by issuing another generation. Keep the old URL record for audit.
        const refreshed = await P.poll(p, c.remote, signal);
        if (!refreshed.done || refreshed.failed || !refreshed.outputs?.length) throw Object.assign(new Error('The existing generation output is unavailable; no new generation was submitted'), { expose: true });
        if (fs.existsSync(responseFile(jobId))) fs.copyFileSync(responseFile(jobId), `${responseFile(jobId)}.${crypto.randomUUID()}.expired`);
        P.atomic(responseFile(jobId), refreshed.outputs); c = { ...c, refreshOutcome: false, outcomeFile: true, phase: 'downloading' }; await checkpoint(job, c);
      }
      // A crash after the provider response reached disk is recovered from
      // that immutable file instead of resubmitting an unknown request.
      if (!c.outcomeFile && fs.existsSync(responseFile(jobId))) {
        c = { ...c, outcomeFile: true }; await checkpoint(job, c);
      }
      if (c.phase === 'submitting' && !c.remote?.id && !c.outcomeFile) throw Object.assign(new Error('The app stopped during submission. The remote outcome is unknown; no duplicate request was sent.'), { uncertain: true, expose: true });
      if (!c.remote?.id && !c.outcomeFile) {
        const refs = await references(c.input); signal.throwIfAborted();
        c = { ...c, phase: 'submitting' }; await checkpoint(job, c);
        const remote = await P.submit(p, c.input, refs, signal);
        if (remote.outputs?.length) { P.atomic(responseFile(jobId), remote.outputs); c.outcomeFile = true; }
        const { outputs: _outputs, ...tracking } = remote;
        const usage = mergeUsage(c, p, remote, job.attempt);
        c = { ...c, remote: tracking, ...(usage ? { usage } : {}), phase: remote.done ? 'downloading' : 'queued' }; await checkpoint(job, c);
        if (remote.failed) throw Object.assign(new Error('The provider reported a failed generation'), { expose: true });
        if (remote.done && !remote.outputs?.length) throw Object.assign(new Error('The provider completed without media outputs'), { expose: true });
      }
      while (!c.outcomeFile) {
        signal.throwIfAborted();
        const remote = await P.poll(p, c.remote, signal);
        if (remote.failed) throw Object.assign(new Error('The provider reported a failed generation'), { expose: true });
        if (remote.done) {
          if (!remote.outputs?.length) throw Object.assign(new Error('The provider completed without media outputs'), { expose: true });
          P.atomic(responseFile(jobId), remote.outputs); c.outcomeFile = true;
        }
        const { outputs: _outputs, ...tracking } = remote;
        const usage = mergeUsage(c, p, remote, job.attempt);
        c = { ...c, remote: tracking, ...(usage ? { usage } : {}), phase: remote.done ? 'downloading' : 'generating', progress: Math.max(0, Math.min(99, Number(remote.progress) || 0)) }; await checkpoint(job, c);
        if (!remote.done) await new Promise((resolve, reject) => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
          const abort = () => { clearTimeout(timer); reject(new Error('Request stopped')); };
          const timer = setTimeout(done, pollMs); signal.addEventListener('abort', abort, { once: true });
        });
      }
      // Publishing resumes from the already saved immutable outputs; the
      // provider response file is only re-read when bytes are missing.
      let saved = Array.isArray(c.outputs) && c.outputs.length && c.outputs.every(o => OUTPUT_NAME.test(o.name) && fs.existsSync(path.join(root, o.name))) ? c.outputs : null;
      if (!saved) {
        let outputs;
        try { outputs = JSON.parse(fs.readFileSync(responseFile(jobId), 'utf8')); }
        catch { throw Object.assign(new Error('The saved provider response could not be read'), { expose: true }); }
        if (!Array.isArray(outputs) || !outputs.length || outputs.length > 8) P.fail('Invalid output count');
        saved = [];
        for (const [index, value] of outputs.entries()) {
          signal.throwIfAborted(); let bytes, streamed;
          const temp = path.join(root, `${jobId}-${index + 1}-${crypto.randomUUID()}.part`);
          const output = typeof value === 'string' ? { url: value } : value;
          if (output.b64_json || output.base64) bytes = Buffer.from(output.b64_json || output.base64, 'base64');
          else if (output.apiContent) streamed = await P.request(p, output.apiContent, { binary: true, signal, downloadTo: temp });
          else if (output.url) streamed = await P.request(p, output.url, { binary: true, output: true, signal, downloadTo: temp });
          else P.fail('Provider output does not contain a media URL or base64 data');
          try {
          if (bytes && bytes.length > 256 * 1024 * 1024) P.fail('Media exceeds 256 MB');
          const ext = extension(streamed?.head ?? bytes), mime = mimeTypes[ext];
          if (!mime.startsWith(`${c.kind}/`)) P.fail('Provider returned the wrong media type');
          const name = `${jobId}-${index + 1}.${ext}`, file = path.join(root, name);
          if (!streamed) fs.writeFileSync(temp, bytes, { flag: 'wx' }); fs.renameSync(temp, file);
          saved.push({ name, mime, size: streamed?.size ?? bytes.length, sha256: streamed?.sha256 ?? crypto.createHash('sha256').update(bytes).digest('hex') });
          } finally { try { fs.unlinkSync(temp); } catch {} }
        }
        c = { ...c, outputs: saved }; await checkpoint(job, c);
      }
      signal.throwIfAborted();
      c = { ...c, phase: 'publishing', error: undefined }; await checkpoint(job, c);
      const artifact = await rpc('artifact/create', { workspaceId: workspace, title: c.input.prompt.slice(0, 60), type: 'application/vnd.knorvia.media+json', idempotencyKey: `${jobId}-artifact` });
      // Provenance travels with the artifact: source job, model connection
      // identity, accepted parameters and pinned references. Never secrets.
      const provenance = { prompt: c.input.prompt, provider: c.provider ? { name: c.provider.name, model: c.provider.model, baseUrl: c.provider.baseUrl } : undefined, input: { size: c.input.size, aspect: c.input.aspect, count: c.input.count, seconds: c.input.seconds, quality: c.input.quality }, references: c.input.references, firstFrame: c.input.firstFrame, lastFrame: c.input.lastFrame, via: c.source };
      await rpc('artifact/stage', { id: artifact.id, content: JSON.stringify({ studioJobId: jobId, kind: c.kind, outputs: saved, source: provenance }), idempotencyKey: `${jobId}-stage` });
      await rpc('artifact/commit', { id: artifact.id, idempotencyKey: `${jobId}-commit` });
      signal.throwIfAborted(); await checkpoint(job, { ...c, phase: 'completed', progress: 100, artifactId: artifact.id });
      await rpc('job/finish', { jobId, status: 'succeeded' });
      fs.unlinkSync(responseFile(jobId));
    } catch (error) {
      // Cancel and shutdown own the durable transition; an aborted worker
      // must never race the cancel handler's checkpoint.
      if (closed || signal.aborted) return;
      job = await read(jobId); if (terminal(job)) return;
      const message = expose(error);
      console.error('[media-studio] job failed', jobId, error);
      const recoverable = Boolean(c?.remote?.id || c?.outcomeFile) && !/failed generation|without media|wrong media type|not a supported|Invalid output count|could not be read/.test(message);
      const phase = error.uncertain && !c?.remote?.id ? 'unknown' : recoverable ? 'paused' : 'failed';
      await checkpoint(job, { ...job.checkpoint, phase, error: message, recoverable, ...([403,404,410].includes(error.httpStatus) && c?.remote?.id && c?.outcomeFile ? { refreshOutcome: true } : {}) });
      if (!recoverable) await rpc('job/finish', { jobId, status: 'failed' });
    }
  }
  async function accept({ token, fingerprint, input, profile, agent }) {
    const job = await rpc('job/create', { workspaceId: workspace, type: `media.${profile.kind}`, idempotencyKey: `studio-${token}` });
    const existing = await read(job.id);
    if (existing.checkpoint) {
      if (existing.checkpoint.fingerprint !== fingerprint) P.fail('This submission key belongs to different inputs');
      return publicJob(existing);
    }
    const pinned = await pinReferences(input.references);
    const frames = {};
    for (const role of ['firstFrame', 'lastFrame']) if (input[role]) frames[role] = (await pinReferences([input[role]]))[0];
    const { apiKey, ...provider } = profile;
    const saved = await checkpoint(job, { kind: profile.kind, profileId: profile.id, provider, hadKey: Boolean(apiKey), input: { ...input, references: pinned, ...frames }, fingerprint, phase: 'queued', outputs: [], usage: P.normalizeUsage(profile, {}), source: agent ? 'agent' : 'studio' });
    schedule(job.id); return publicJob(saved);
  }
  async function create(params, agent = false) {
    await initialize();
    const p = profiles.get(params.profileId);
    if (agent && !p.agentEnabled) P.fail('Agent access is disabled for this model connection');
    const input = { prompt: P.text(params.prompt, 12000), size: P.text(params.size || (p.kind === 'image' ? '1024x1024' : '1280x720'), 30), aspect: P.text(params.aspect || '16:9', 20), count: params.count ?? 1, seconds: params.seconds ?? 4, quality: P.text(params.quality || 'auto', 40), references: P.safeObject(params.references || []) };
    if (!input.prompt || !/^\d{2,5}x\d{2,5}$/.test(input.size) || !Number.isInteger(input.count) || input.count < 1 || input.count > 4 || !Number.isInteger(input.seconds) || input.seconds < 1 || input.seconds > 60 || !Array.isArray(input.references) || input.references.length > 6) P.fail('Invalid prompt, dimensions, count, duration or references');
    const reference = ref => {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) P.fail('Invalid reference image');
      P.id(ref.id); if (ref.version !== undefined && (typeof ref.version !== 'string' || !/^[a-f0-9]{64}$/.test(ref.version))) P.fail('Invalid reference version');
      return { id: ref.id, ...(ref.version ? { version: ref.version } : {}) };
    };
    input.references = input.references.map(reference);
    if (p.kind === 'video') {
      if (input.references.length > 1 || (input.references.length && params.firstFrame)) P.fail('请使用独立的 firstFrame 和 lastFrame 指定视频首尾帧');
      if (params.firstFrame || input.references.length) input.firstFrame = reference(params.firstFrame || input.references[0]);
      if (params.lastFrame) input.lastFrame = reference(params.lastFrame);
      input.references = [];
    } else if (params.firstFrame || params.lastFrame) P.fail('图片创作请使用 references，首尾帧仅用于视频');
    P.validateInputs(p, input);
    const token = P.id(params.idempotencyKey || crypto.randomUUID());
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ profileId: p.id, input })).digest('hex');
    // Serialize duplicate submissions of one key so concurrent creates cannot
    // both observe a missing checkpoint and overwrite each other's inputs.
    let pending = pendingCreates.get(token);
    if (pending && pending.fingerprint !== fingerprint) P.fail('This submission key belongs to different inputs');
    if (!pending) {
      pending = { fingerprint, promise: accept({ token, fingerprint, input, profile: p, agent }).finally(() => pendingCreates.delete(token)) };
      pendingCreates.set(token, pending);
    }
    return pending.promise;
  }
  const handlers = {
    'studio/workflow/inspect': p => WORKFLOW.inspectWorkflow(p?.workflow, p?.bindings),
    'studio/models': () => ({ profiles: profiles.list(), ...(profiles.warning ? { warning: profiles.warning } : {}) }),
    'studio/model/save': p => {
      if (p.protocol === 'comfyui' && p.custom?.workflow) {
        const report = WORKFLOW.inspectWorkflow(p.custom.workflow, p.custom.bindings);
        if (!p.custom.bindings?.prompt) P.fail('请选择工作流的提示词字段');
        if (p.custom.outputNode && !report.workflow[p.custom.outputNode]) P.fail('输出节点不存在');
        p = { ...p, custom: { ...p.custom, workflow: report.workflow, workflowSha256: report.sha256 } };
      }
      return profiles.save(p);
    },
    'studio/model/remove': p => profiles.remove(p.id),
    'studio/model/test': async params => {
      const p = profiles.get(params.id);
      if (p.protocol === 'comfyui') return WORKFLOW.checkDependencies(p, P.request);
      if (p.protocol !== 'openai') return { checked: 'configuration', reachable: null };
      await P.request(p, 'models'); return { checked: 'models', reachable: true };
    },
    'studio/list': async params => {
      await initialize(); const offset = Math.max(0, Number(params?.offset) || 0), limit = Math.max(1, Math.min(60, Number(params?.limit) || 60));
      const jobs = []; let total = 0;
      for (let index = 0; index < limit; index++) {
        const page = await rpc('job/list', { workspaceId: workspace, typePrefix: 'media.', offset: offset + index, limit: 1 }); total = page.total;
        if (!page.jobs.length) break;
        jobs.push(publicJob(page.jobs[0]));
        if (offset + jobs.length >= total) break;
      }
      const result = { jobs, total };
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 3 * 1024 * 1024) P.fail('作品列表超过 3 MiB 上限，请减少每页数量');
      return result;
    },
    'studio/create': params => create(params),
    'studio/read': async p => { await initialize(); return publicJob(await read(p.id)); },
    'studio/playback': async p => {
      await initialize(); const job = await read(p.id), output = job.checkpoint?.outputs?.[p.index ?? 0];
      if (!output || !OUTPUT_NAME.test(output.name)) P.fail('Output not found');
      return playback.issue({ file: path.join(root, output.name), ...output });
    },
    'studio/resume': async p => { await initialize(); const job = await read(p.id); if (terminal(job)) P.fail('Create a new job to generate again'); schedule(job.id); return publicJob(job); },
    'studio/cancel': async params => {
      await initialize(); let job = await read(params.id); if (terminal(job)) return publicJob(job);
      unschedule(job.id);
      const task = active.get(job.id);
      if (task) { task.controller.abort(); await task.promise.catch(() => {}); }
      job = await read(job.id); if (terminal(job)) return publicJob(job);
      // A stopped worker never writes its own checkpoint after this point;
      // the cancel path below owns the durable state.
      let remoteCancelRequested = false; let remoteCancelNote;
      if (job.checkpoint?.remote?.cancelUrl) {
        let provider = null;
        try { provider = profiles.get(job.checkpoint.profileId); } catch { }
        if (provider && provider.baseUrl === job.checkpoint.provider.baseUrl) {
          try { await P.request(provider, job.checkpoint.remote.cancelUrl, { method: job.checkpoint.remote.cancelMethod ?? 'PUT', headers: job.checkpoint.remote.cancelHeaders, emptyOk: true }); remoteCancelRequested = true; }
          catch (error) { remoteCancelNote = expose(error); }
        } else remoteCancelNote = 'The original model connection changed, so the provider was not asked to stop the remote job';
      }
      await checkpoint(job, { ...job.checkpoint, phase: 'stopped', remoteMayContinue: true, remoteCancelRequested, ...(remoteCancelNote ? { remoteCancelNote } : {}) });
      return publicJob(await rpc('job/cancel', { id: job.id }));
    },
    'studio/content': async p => {
      await initialize(); const job = await read(p.id); const output = job.checkpoint?.outputs?.[p.index ?? 0]; if (!output) P.fail('Output not found');
      if (!OUTPUT_NAME.test(output.name) || output.name !== path.basename(output.name)) P.fail('Invalid output record');
      const offset = p.offset ?? 0; if (!Number.isSafeInteger(offset) || offset < 0 || offset >= output.size && offset !== 0) P.fail('Invalid offset');
      const file = path.join(root, output.name);
      let stat; try { stat = fs.statSync(file); } catch { P.fail('The generated file is missing'); }
      if (!stat.isFile() || stat.size < output.size) P.fail('The generated file is incomplete');
      const handle = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(512 * 1024, Math.max(0, output.size - offset)));
        const length = fs.readSync(handle, buffer, 0, buffer.length, offset);
        if (!length && offset < output.size) P.fail('The generated file could not be read');
        return { ...output, base64: buffer.subarray(0, length).toString('base64'), nextOffset: offset + length < output.size ? offset + length : null };
      }
      finally { fs.closeSync(handle); }
    },
    'studio/library': async p => { await initialize(); const job = await read(p.id), output = job.checkpoint?.outputs?.[p.index ?? 0]; if (!output) P.fail('Output not found'); return library.put(path.join(root, output.name), p.path || `创作/${output.name}`); },
  };
  // Derived tail frames: decode the real last displayed frame, register it
  // immutably in the personal library, and record provenance in a sidecar
  // next to the frame — the job is already terminal here, so the Rust
  // checkpoint API (which requires a running job) is off the table.
  const tailSidecar = file => `${file}.json`;
  async function exportTailFrameForJob(jobId, index = 0, signal) {
    const job = await read(jobId);
    const c = job.checkpoint;
    if (c?.kind !== 'video') P.fail('尾帧导出仅支持视频作品');
    const output = c?.outputs?.[index];
    if (!output) P.fail('Output not found');
    if (!OUTPUT_NAME.test(output.name) || output.name !== path.basename(output.name)) P.fail('Invalid output record');
    const source = path.join(root, output.name);
    let stat; try { stat = fs.statSync(source); } catch { P.fail('The generated file is missing'); }
    if (!stat.isFile() || stat.size < output.size) P.fail('The generated file is incomplete');
    const file = `${job.id}-tail-${index + 1}.png`;
    if (!OUTPUT_NAME.test(file)) P.fail('Invalid derived frame name');
    const sidecar = path.join(root, tailSidecar(file));
    try {
      const existing = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      if (existing.file === file && existing.sourceSha256 === output.sha256 && fs.existsSync(path.join(root, existing.file))) return existing;
    } catch { }
    const result = await getFrameWorker().exportTailFrame({ source, target: path.join(root, file), signal, timeoutMs: 120000 });
    // Library registration is idempotent by path + content hash via the
    // pre-check above (put's sha argument is an overwrite CAS, not for new
    // files), so a crash between put and sidecar never duplicates the entry.
    const destination = `创作/尾帧/${file}`;
    let entry = (await library.handlers['library/list']()).entries.find(item => !item.trashedAt && item.path === destination && item.sha256 === result.frameSha256);
    if (!entry) entry = await library.put(path.join(root, file), destination);
    const record = { file, libraryId: entry.id, libraryVersion: entry.sha256, libraryName: entry.name, libraryPath: entry.path, sourceSha256: result.sourceSha256, frameSha256: result.frameSha256, frameSize: result.frameSize, ptsTime: result.ptsTime, timeBase: result.timeBase, streamIndex: result.streamIndex, codec: result.codec, rotation: result.rotation, width: result.width, height: result.height, usedFullScan: result.usedFullScan, decoder: await getFrameWorker().decoderVersion(), exportedAt: new Date().toISOString() };
    P.atomic(sidecar, record);
    return record;
  }
  function readTailRecord(jobId, index) {
    const candidates = [`${jobId}-tail-${index + 1}.png`];
    for (const file of candidates) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(root, tailSidecar(file)), 'utf8'));
        if (record.file === file && fs.existsSync(path.join(root, file))) return record;
      } catch { }
    }
    return null;
  }
  const tailHandlers = {
    'studio/frame/export': async p => {
      await initialize();
      const outputIndex = p?.index ?? p?.outputIndex ?? 0;
      let record;
      try { record = await exportTailFrameForJob(P.id(p?.id), outputIndex); }
      catch (error) {
        if (error.rpc && !error.rpc.reason && error.rpc.code === -32602) error.rpc.reason = 'decode-failed';
        throw error;
      }
      // Both key styles: the contract-agreed flat keys and the nested B-v1
      // shapes the studio UI consumes.
      return {
        jobId: P.id(p?.id), outputIndex,
        path: record.libraryPath, sha256: record.frameSha256, sourceVideoSha256: record.sourceSha256,
        streamIndex: record.streamIndex, pts: record.ptsTime, timeBase: record.timeBase, width: record.width, height: record.height,
        libraryId: record.libraryId, libraryVersion: record.libraryVersion, name: record.libraryName, file: record.file,
        decoder: record.decoder, usedFullScan: record.usedFullScan,
        library: { id: record.libraryId, version: record.libraryVersion, name: record.libraryName, path: record.libraryPath },
        frame: { sourceSha256: record.sourceSha256, frameSha256: record.frameSha256, ptsTime: record.ptsTime, streamIndex: record.streamIndex, rotation: record.rotation, decoder: record.decoder, usedFullScan: record.usedFullScan },
      };
    },
    'studio/frame/content': async p => {
      await initialize(); const jobId = P.id(p?.id);
      await read(jobId);
      const index = p?.index ?? 0;
      const record = readTailRecord(jobId, index);
      if (!record) P.fail('尾帧尚未导出');
      if (!OUTPUT_NAME.test(record.file) || record.file !== path.basename(record.file)) P.fail('Invalid derived frame record');
      const offset = p.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= record.frameSize && offset !== 0) P.fail('Invalid offset');
      const file = path.join(root, record.file);
      let stat; try { stat = fs.statSync(file); } catch { P.fail('导出的尾帧文件缺失'); }
      if (!stat.isFile() || stat.size !== record.frameSize) P.fail('导出的尾帧文件不完整');
      const handle = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(512 * 1024, Math.max(0, record.frameSize - offset)));
        const length = fs.readSync(handle, buffer, 0, buffer.length, offset);
        if (!length && offset < record.frameSize) P.fail('导出的尾帧文件无法读取');
        return { name: record.file, size: record.frameSize, mime: 'image/png', sha256: record.frameSha256, base64: buffer.subarray(0, length).toString('base64'), nextOffset: offset + length < record.frameSize ? offset + length : null };
      } finally { fs.closeSync(handle); }
    },
  };
  const templateStore = TPL.createTemplateStore({ home });
  const api = { handlers: { ...handlers, ...templateStore.handlers }, create, profiles, initialize, exportTailFrameForJob, workspaceId: () => { if (!workspace) P.fail('Media service is starting'); return workspace; }, root };
  const sequenceEngine = SEQ.createSequenceEngine({ home, rpc, library, studio: api, templates: templateStore });
  const compositionEngine = EDIT.createCompositionEngine({ rpc, studio: api, library, playback });
  const articleEngine = ARTICLE.createArticleEngine({ rpc, studio: api, library, playback });
  const pets = PET.createPetService({ home, rpc, studio: api, playback });
  api.handlers = { ...api.handlers, ...sequenceEngine.handlers, ...compositionEngine.handlers, ...articleEngine.handlers, ...tailHandlers, ...pets.handlers };
  return {
    handlers: api.handlers, create, profiles, initialize, exportTailFrameForJob, workspaceId: api.workspaceId, sequence: sequenceEngine, pets,
    async close() { closed = true; await articleEngine.close(); await compositionEngine.close(); await pets.close(); waiting.length = 0; for (const task of active.values()) task.controller.abort(); await Promise.allSettled([...active.values()].map(t => t.promise)); await sequenceEngine.close(); await playback.close(); },
    root,
  };
}
module.exports = { createMediaStudio, METHODS, extension };
