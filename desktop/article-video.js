'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('./studio-providers');
const W = require('./article-video-worker');
const { withLock, tryLock } = require('./media-lock');
const { hash, run } = require('./media-composition-worker');
const { resolveBinaries } = require('./media-frame-worker');
const { parseSrt, toSrt } = require('./studio-subtitles');
const actions = ['create', 'list', 'read', 'save', 'voice', 'import-audio', 'build', 'render', 'cancel', 'playback', 'config', 'config/save'];
const METHODS = actions.map(a => `studio/article/${a}`);
const guide = '文章转视频：读取 article 与受众，保留事实和观点，把内容改成自然口播，用空行分段。save 写入 narration（不得编造口播已获认可）。先 voice sample=true 试听，再 voice sample=false 生成全篇。每段时间取实际音频。也可 import-audio 使用资料库音频和对齐该音频的 SRT。按 captions 数量 save scenes（每段一个标题和视觉说明），不得估算音频时间。build 生成可编辑 HyperFrames 工程，render preview=true 看前 15 秒，审核后 render preview=false 导出。每次变更使用最新 revision；口播修改使配音和分镜失效。无需另起代理循环。未经用户允许不得调用收费配音、生图或视频服务。';
function createArticleEngine({ studio, rpc, library, playback }) {
  const root = path.join(studio.root, 'article-video'); fs.mkdirSync(root, { recursive: true });
  const configFile = path.join(root, 'runtime.json');
  const active = new Map(); let closed = false;
  const config = () => fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : { node: process.env.KNORVIA_HYPERFRAMES_NODE || (process.resourcesPath ? path.join(process.resourcesPath, 'runtime', 'node', 'node.exe') : ''), runtime: process.env.KNORVIA_HYPERFRAMES_ROOT || (process.resourcesPath ? path.join(process.resourcesPath, 'runtime', 'hyperframes') : '') };
  const lock = (id, fn) => withLock(path.join(root, `${P.id(id)}.lock`), fn);
  const read = async id => { const j = await rpc('job/read', { id: P.id(id) }); if (j.type !== 'studio.article' || j.workspaceId !== studio.workspaceId()) P.fail('找不到文章视频工程'); return j; };
  const visible = j => ({ id: j.id, ...j.checkpoint, guide });
  const save = (id, c) => rpc('job/checkpoint', { jobId: id, checkpoint: c });
  // P09: a save whose response was lost must be safely retryable. Remembering
  // the last result per (project, idempotency key) turns a duplicate submit
  // into a replay of the stored result instead of a revision conflict or a
  // second mutation. In-memory is enough: after a daemon restart the client
  // recovers through read-back.
  const saveMemo = new Map();
  const memoKey = (p) => {
    const key = typeof p.idempotencyKey === 'string' ? p.idempotencyKey.slice(0, 128) : '';
    return key && P.id(p.id) ? `${P.id(p.id)}:${key}` : '';
  };
  const checked = (j, p) => { if (j.checkpoint.revision !== p.revision) P.fail('工程已被其他窗口修改，请刷新后重试'); if (j.checkpoint.busy) P.fail('当前步骤尚未结束，请等待或取消'); return j.checkpoint; };
  const directory = (id, revision) => path.join(root, P.id(id), `v${revision}`);
  const audioFile = (id, audio) => { if (!Number.isSafeInteger(audio?.revision)) P.fail('配音记录无效'); return path.join(directory(id, audio.revision), 'voice', 'final.wav'); };
  async function task(p, kind, work) {
    let owner;
    const result = await lock(p.id, async () => {
      const j = await read(p.id), c = checked(j, p), token = crypto.randomUUID();
      owner = tryLock(path.join(root, `${P.id(p.id)}.owner`));
      if (!owner) P.fail('另一个窗口正在处理此工程');
      const next = { ...c, ...(kind === 'preview' ? { preview: null, output: null } : kind === 'render' ? { output: null } : {}), busy: kind, taskToken: token, error: null };
      try { await save(j.id, next); } catch (e) { owner.release(); throw e; } return { id: j.id, ...next };
    });
    const controller = new AbortController();
    const item = { controller, promise: null }; active.set(p.id, item);
    item.promise = (async () => {
      try {
        const patch = await work(result, controller.signal);
        if (!patch.output) controller.signal.throwIfAborted();
        await lock(p.id, async () => {
          const j = await read(p.id);
          if (j.checkpoint.taskToken !== result.taskToken) return;
          await save(p.id, { ...j.checkpoint, ...patch, busy: null, taskToken: null });
        });
      } catch (e) {
        if (!closed) await lock(p.id, async () => {
          const j = await read(p.id);
          if (j.checkpoint.taskToken === result.taskToken) await save(p.id, { ...j.checkpoint, busy: null, taskToken: null, error: controller.signal.aborted ? '操作已取消，可重新执行当前步骤' : e.rpc?.message || (e.expose ? e.message : '此步骤失败，请检查运行组件、输入文件和磁盘空间') });
        }).catch(console.error);
        if (!controller.signal.aborted) console.error('[article-video]', e);
      } finally { active.delete(p.id); owner.release(); }
    })();
    return result;
  }
  async function copyReference(ref, file) {
    if (!ref?.id || !/^[a-f0-9]{64}$/.test(ref.version || '')) P.fail('请选择资料库中的固定版本');
    let offset = 0; const fd = fs.openSync(file, 'wx');
    try { for (;;) {
      const part = await library.handlers['library/read']({ id: ref.id, version: ref.version, offset });
      if (part.size > 128 * 1024 * 1024 || part.sha256 !== ref.version) P.fail('音频过大或版本不一致');
      const bytes = Buffer.from(part.base64, 'base64'); fs.writeSync(fd, bytes);
      if (part.nextOffset === null) break;
      if (part.nextOffset <= offset) P.fail('读取素材未取得进展'); offset = part.nextOffset;
    } } finally { fs.closeSync(fd); }
    if (await hash(file) !== ref.version) P.fail('音频校验失败');
  }
  const handlers = {
    'studio/article/create': async p => {
      await studio.initialize();
      const article = P.text(p.article, 60000), title = P.text(p.title || '文章视频', 100), audience = P.text(p.audience || '', 500);
      if (!article) P.fail('请放入文章或主题');
      const key = P.id(p.idempotencyKey), fingerprint = crypto.createHash('sha256').update(JSON.stringify({ article, title, audience })).digest('hex');
      return lock(`create-${key}`, async () => {
        const j = await rpc('job/create', { workspaceId: studio.workspaceId(), type: 'studio.article', idempotencyKey: `article-${key}` });
        const old = await read(j.id);
        if (old.checkpoint) { if (old.checkpoint.fingerprint !== fingerprint) P.fail('此创建请求已用于不同内容'); return visible(old); }
        return visible(await save(j.id, { title, article, audience, fingerprint, narration: '', scenes: [], aspect: '16:9', revision: 1, phase: 'script' }));
      });
    },
    'studio/article/list': async () => {
      await studio.initialize(); const projects = []; let total = 0;
      for (let offset = 0; offset < 100; offset++) {
        const page = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: 'studio.article', limit: 1, offset }); total = page.total;
        for (const j of page.jobs) projects.push({ id: j.id, title: j.checkpoint?.title, revision: j.checkpoint?.revision, phase: j.checkpoint?.phase, busy: j.checkpoint?.busy });
        if (!page.jobs.length || offset + 1 >= total) break;
      }
      return { projects, total };
    },
    'studio/article/read': async p => { await studio.initialize(); return visible(await read(p.id)); },
    'studio/article/save': async p => {
      await studio.initialize();
      const memo = memoKey(p);
      if (memo && saveMemo.has(memo)) return saveMemo.get(memo);
      return lock(p.id, async () => {
        if (memo && saveMemo.has(memo)) return saveMemo.get(memo);
        const j = await read(p.id), c = checked(j, p), patch = {};
        if (p.narration !== undefined) { patch.narration = P.text(p.narration, 30000); if (patch.narration) W.segments(patch.narration); }
        if (p.aspect !== undefined) { if (!['16:9', '9:16', '1:1'].includes(p.aspect)) P.fail('画幅不支持'); patch.aspect = p.aspect; }
        if (p.scenes !== undefined) {
          if (!Array.isArray(p.scenes) || p.scenes.length > 80 || p.scenes.length !== c.audio?.captions?.length) P.fail('分镜数量必须与已生成配音段落一致');
          patch.scenes = p.scenes.map(s => {
            const value = { heading: P.text(s.heading, 100), detail: P.text(s.detail || '', 350) };
            if (s.reference) { if (!/^[a-f0-9]{64}$/.test(s.reference.version || '')) P.fail('分镜图片必须固定资料库版本'); value.reference = { id: P.id(s.reference.id), version: s.reference.version }; }
            return value;
          });
        }
        const changed = patch.narration !== undefined && patch.narration !== c.narration;
        const result = visible(await save(j.id, { ...c, ...patch, revision: c.revision + 1, built: null, preview: null, output: null, ...(changed ? { audio: null, sample: null, scenes: [], phase: 'script' } : {}), error: null }));
        if (memo) { saveMemo.set(memo, result); if (saveMemo.size > 200) saveMemo.delete(saveMemo.keys().next().value); }
        return result;
      });
    },
    'studio/article/voice': async p => {
      await studio.initialize(); return task(p, p.sample ? 'sample' : 'voice', async (c, signal) => {
        if (!c.narration) P.fail('请先保存口播稿');
        const voice = P.text(p.voice || '', 100), dest = path.join(directory(p.id, c.revision), p.sample ? `sample-${c.taskToken}` : 'voice');
        const result = await W.synthesize({ narration: c.narration, voice, directory: dest, signal, sample: p.sample === true });
        const { file, ...audio } = result;
        if (p.sample) return { sample: { ...audio, relative: path.relative(root, file) } };
        return { revision: c.revision + 1, audio: { ...audio, voice, revision: c.revision }, scenes: result.captions.map((cue, i) => ({ heading: `${i + 1}. ${cue.text.slice(0, 32)}`, detail: '' })), built: null, preview: null, output: null, phase: 'storyboard' };
      });
    },
    'studio/article/import-audio': async p => {
      await studio.initialize(); return task(p, 'voice', async (c, signal) => {
        const dest = path.join(directory(p.id, c.revision), 'voice'); fs.mkdirSync(dest, { recursive: true });
        const input = path.join(dest, `import-${c.taskToken}`); await copyReference(p.reference, input);
        const bins = resolveBinaries(), file = path.join(dest, 'final.wav');
        const info = JSON.parse(await run(bins.ffprobe, ['-v', 'error', '-show_format', '-of', 'json', input], signal));
        const seconds = Number(info.format.duration); if (!(seconds > 0 && seconds <= 1800)) P.fail('音频必须在 30 分钟以内');
        const frames = Math.ceil(seconds * 30), captions = parseSrt(P.text(p.srt, 200000), frames);
        if (!captions.length || captions.length > 80) P.fail('请提供与此音频对齐的 1–80 段字幕');
        if (captions.some(cue => cue.text.length > 180)) P.fail('为保证画面可读，请先将超过 180 字的字幕拆成更短的有时间标记的字幕段');
        await run(bins.ffmpeg, ['-v', 'error', '-nostdin', '-y', '-i', input, '-vn', '-ar', '48000', '-ac', '1', file], signal);
        return { revision: c.revision + 1, audio: { revision: c.revision, frames, captions, sha256: await hash(file), timing: 'imported-audio-srt', reference: p.reference }, scenes: captions.map(cue => ({ heading: cue.text.slice(0, 32), detail: '' })), built: null, preview: null, output: null, phase: 'storyboard' };
      });
    },
    'studio/article/build': async p => {
      await studio.initialize(); return task(p, 'build', async c => {
        if (!c.audio || c.scenes.length !== c.audio.captions.length) P.fail('请先准备配音和对应分镜');
        const cfg = config(), gsap = path.join(cfg.runtime, 'node_modules', 'gsap', 'dist', 'gsap.min.js');
        if (!fs.existsSync(gsap)) P.fail('请先在运行组件中设置 HyperFrames 和 GSAP 所在目录');
        const dir = path.join(directory(p.id, c.revision), `project-${c.taskToken}`); fs.mkdirSync(dir, { recursive: true });
        const audio = audioFile(p.id, c.audio); if (await hash(audio) !== c.audio.sha256) P.fail('配音内容已变化，请重新生成');
        fs.copyFileSync(audio, path.join(dir, 'final.wav')); fs.copyFileSync(gsap, path.join(dir, 'gsap.min.js'));
        const images = [], prepared = [];
        for (let i = 0; i < c.scenes.length; i++) {
          const scene = c.scenes[i];
          if (!scene.reference) { prepared.push(scene); continue; }
          const name = `image-${i}.png`, file = path.join(dir, name); await copyReference(scene.reference, file);
          const fd = fs.openSync(file, 'r'), header = Buffer.alloc(12); try { fs.readSync(fd, header); } finally { fs.closeSync(fd); }
          if (!(header[0] === 137 && header.toString('ascii', 1, 4) === 'PNG') && !(header[0] === 255 && header[1] === 216) && !(header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP')) P.fail('分镜图片仅支持 PNG、JPEG、WebP');
          images.push({ name, sha256: scene.reference.version }); prepared.push({ ...scene, image: name });
        }
        fs.writeFileSync(path.join(dir, 'index.html'), W.composition({ ...c, scenes: prepared }));
        fs.writeFileSync(path.join(dir, 'article.md'), c.article); fs.writeFileSync(path.join(dir, 'narration.md'), c.narration);
        fs.writeFileSync(path.join(dir, 'captions.srt'), toSrt(c.audio.captions));
        fs.writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify({ scenes: c.scenes, captions: c.audio.captions }, null, 2));
        fs.writeFileSync(path.join(dir, 'BRIEF.md'), `# ${c.title}\nworkflow: faceless-explainer\nflow: companion\n受众：${c.audience}\n\n${guide}\n`);
        return { built: { directory: dir, revision: c.revision, sourceSha256: await hash(path.join(dir, 'index.html')), assets: [{ name: 'final.wav', sha256: c.audio.sha256 }, { name: 'gsap.min.js', sha256: await hash(gsap) }, ...images] }, preview: null, output: null, phase: 'preview' };
      });
    },
    'studio/article/render': async p => {
      await studio.initialize(); return task(p, p.preview ? 'preview' : 'render', async (c, signal) => {
        if (!c.built || c.built.revision !== c.revision) P.fail('请先构建当前版本的工程');
        if (!p.preview && !c.preview) P.fail('请先导出并查看当前版本的 15 秒预览');
        const source = c.built.directory;
        const sourceSha256 = await hash(path.join(source, 'index.html'));
        if (!p.preview && c.preview.sourceSha256 !== sourceSha256) P.fail('工程已修改，请重新导出预览');
        const cache = path.join(path.dirname(path.dirname(studio.root)), 'hf-cache');
        const dir = path.join(cache, c.taskToken.replaceAll('-', '')); fs.mkdirSync(dir, { recursive: true });
        for (const asset of c.built.assets) { if (await hash(path.join(source, asset.name)) !== asset.sha256) P.fail('工程素材已变化，请重新构建'); fs.copyFileSync(path.join(source, asset.name), path.join(dir, asset.name)); }
        let html = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
        if (p.preview) html = html.replace(/(<div id="root"[^>]*data-duration=")[^"]+/, `$1${Math.min(c.audio.frames / 30, 15)}`);
        fs.writeFileSync(path.join(dir, 'index.html'), html);
        try {
        const result = await W.render({ directory: dir, config: { ...config(), cache }, signal });
        const expected = Math.min(c.audio.frames / 30, p.preview ? 15 : 1800);
        if (Math.abs(result.duration - expected) > .15) P.fail('导出时长与配音不一致');
        const { file: renderedFile, ...meta } = result;
        const file = path.join(directory(p.id, c.revision), `${c.taskToken}.mp4`);
        fs.copyFileSync(renderedFile, file, fs.constants.COPYFILE_EXCL);
        if (p.preview) return { preview: { ...meta, file, sourceSha256 }, phase: 'review' };
        signal.throwIfAborted();
        const entry = await library.put(file, `文章视频/${p.id}-${c.revision}-${c.taskToken}.mp4`);
        return { output: { ...meta, file, libraryId: entry.id }, phase: 'completed' };
        } finally {
          for (const log of ['lint-log.txt', 'render-log.txt']) if (fs.existsSync(path.join(dir, log))) fs.copyFileSync(path.join(dir, log), path.join(directory(p.id, c.revision), `${c.taskToken}-${log}`));
          if (path.dirname(path.resolve(dir)) === path.resolve(cache) && /^[a-f0-9]{32}$/.test(path.basename(dir))) fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    },
    'studio/article/cancel': async p => { await studio.initialize(); const item = active.get(p.id); if (item) { item.controller.abort(); await item.promise; } return visible(await read(p.id)); },
    'studio/article/playback': async p => {
      await studio.initialize(); const c = (await read(p.id)).checkpoint;
      const value = p.kind === 'sample' ? c.sample : p.kind === 'audio' ? c.audio : p.kind === 'preview' ? c.preview : c.output;
      if (!value) P.fail('此内容尚未准备好');
      const file = p.kind === 'sample' ? path.join(root, value.relative) : p.kind === 'audio' ? audioFile(p.id, value) : value.file;
      if (await hash(file) !== value.sha256) P.fail('内容校验失败');
      return playback.issue({ file, sha256: value.sha256, mime: ['sample', 'audio'].includes(p.kind) ? 'audio/wav' : 'video/mp4' });
    },
    'studio/article/config': async () => ({ ...config(), guide }),
    'studio/article/config/save': async p => {
      const node = P.text(p.node, 2000), runtime = P.text(p.runtime, 2000);
      if (!path.isAbsolute(node) || !/^node(\.exe)?$/i.test(path.basename(node)) || !fs.statSync(node).isFile() || !path.isAbsolute(runtime)) P.fail('请选择 Node 程序与 HyperFrames 安装目录');
      const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'node_modules', 'hyperframes', 'package.json'), 'utf8'));
      if (manifest.name !== 'hyperframes' || !fs.existsSync(path.join(runtime, 'node_modules', 'gsap', 'dist', 'gsap.min.js'))) P.fail('此目录缺少 HyperFrames 或 GSAP');
      P.atomic(configFile, { node, runtime, version: manifest.version }); return config();
    },
  };
  // C20 activity contract: outstanding article render tasks.
  return { handlers, get pendingCount() { return active.size; }, async recover() {
    let offset = 0;
    for (;;) {
      const page = await rpc('job/list', { workspaceId: studio.workspaceId(), typePrefix: 'studio.article', offset, limit: 1 });
      for (const j of page.jobs) if (j.checkpoint?.busy) {
        const owner = tryLock(path.join(root, `${j.id}.owner`));
        if (owner) try { await lock(j.id, async () => { const fresh = await read(j.id); if (fresh.checkpoint.busy) await save(j.id, { ...fresh.checkpoint, busy: null, taskToken: null, error: '上次运行被中断，请检查结果后重新执行当前步骤' }); }); } finally { owner.release(); }
      }
      offset += page.jobs.length; if (!page.jobs.length || offset >= page.total) break;
    }
  }, async close() { closed = true; for (const item of active.values()) item.controller.abort(); await Promise.allSettled([...active.values()].map(x => x.promise)); } };
}
module.exports = { createArticleEngine, METHODS, guide };
