'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { resolveBinaries } = require('./media-frame-worker');
const { run, hash, createCompositionWorker } = require('./media-composition-worker');
const { toSrt } = require('./studio-subtitles');
const P = require('./studio-providers');
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function segments(text) {
  const items = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  if (!items.length || items.length > 80 || items.some(s => s.length > 180)) P.fail('请用空行分隔短口播段落，每段最多 180 字，共 1–80 段，保证字幕可读');
  return items;
}
function cliRun(node, cli, args, cwd, signal, temp) {
  return new Promise((resolve, reject) => {
    const bins = resolveBinaries();
    const cache = temp || path.resolve(path.dirname(cli), '../../../cache'); fs.mkdirSync(cache, { recursive: true });
    const chrome = process.env.HYPERFRAMES_BROWSER_PATH || [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean).map(p => path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(p => fs.existsSync(p));
    if (!chrome && process.platform === 'win32') { reject(Object.assign(new Error('请先安装 Google Chrome，再导出视频'), { expose: true })); return; }
    const child = execFile(node, [cli, ...args], { cwd, windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...(chrome ? { HYPERFRAMES_BROWSER_PATH: chrome } : {}), HYPERFRAMES_SKIP_SKILLS: '1', DO_NOT_TRACK: '1', FFMPEG_PATH: bins.ffmpeg, FFPROBE_PATH: bins.ffprobe, PATH: `${path.dirname(bins.ffmpeg)}${path.delimiter}${process.env.PATH || ''}`, TEMP: cache, TMP: cache } }, (error, stdout, stderr) => {
      signal?.removeEventListener('abort', stop);
      fs.writeFileSync(path.join(cwd, `${args[0]}-log.txt`), `${stdout || ''}\n${stderr || ''}`);
      if (signal?.aborted) reject(new Error('已取消'));
      else if (error) reject(Object.assign(new Error('HyperFrames 执行失败，请查看工程内的日志'), { expose: true }));
      else resolve(stdout);
    });
    const stop = () => {
      if (process.platform === 'win32' && child.pid) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else child.kill('SIGKILL');
    };
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  });
}
async function synthesize({ narration, voice, directory, signal, sample = false }) {
  if (process.platform !== 'win32') P.fail('当前本地配音使用 Windows 语音，请导入已有配音');
  fs.mkdirSync(directory, { recursive: true });
  const texts = segments(narration), chosen = sample ? texts.slice(0, 1) : texts;
  fs.writeFileSync(path.join(directory, 'speech-input.json'), JSON.stringify({ voice, segments: chosen }), 'utf8');
  // PowerShell cannot read a path inside Electron's app.asar. Materialize
  // this fixed product script beside the input; user prose remains JSON data.
  const script = path.join(directory, 'speech-worker.ps1');
  fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, 'article-voice.ps1')));
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-Directory', directory], signal);
  const bins = resolveBinaries(), captions = []; let frame = 0;
  for (let i = 0; i < chosen.length; i++) {
    const info = JSON.parse(await run(bins.ffprobe, ['-v', 'error', '-show_format', '-of', 'json', path.join(directory, `${i}.wav`)], signal));
    const duration = Number(info.format.duration);
    if (!Number.isFinite(duration) || duration <= 0 || frame / 30 + duration > 1800) P.fail('配音时长无效或超过 30 分钟');
    const endFrame = frame + Math.ceil(duration * 30);
    // Normalize every measured segment to the same frame boundary. Caption
    // timing comes from actual synthesized audio, never character estimates.
    await run(bins.ffmpeg, ['-v', 'error', '-nostdin', '-y', '-i', path.join(directory, `${i}.wav`), '-af', 'apad', '-t', String((endFrame - frame) / 30), '-ar', '48000', '-ac', '1', path.join(directory, `part-${i}.wav`)], signal);
    captions.push({ startFrame: frame, endFrame, text: chosen[i] }); frame = endFrame;
  }
  fs.writeFileSync(path.join(directory, 'concat.txt'), chosen.map((_, i) => `file 'part-${i}.wav'`).join('\n'));
  const file = path.join(directory, 'final.wav');
  await run(bins.ffmpeg, ['-v', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '1', '-i', path.join(directory, 'concat.txt'), ...(sample ? ['-t', '15'] : []), '-c:a', 'pcm_s16le', file], signal);
  fs.writeFileSync(path.join(directory, 'captions.srt'), toSrt(captions));
  return { file, sha256: await hash(file), frames: sample ? Math.min(frame, 450) : frame, captions, timing: 'measured-local-speech-segments' };
}
function composition({ title, aspect, scenes, audio, preview = false }) {
  const [width, height] = aspect === '9:16' ? [720, 1280] : aspect === '1:1' ? [960, 960] : [1280, 720];
  const duration = Math.min(audio.frames / 30, preview ? 15 : 1800);
  const clips = scenes.map((scene, i) => {
    const c = audio.captions[i], start = c.startFrame / 30, end = Math.min(c.endFrame / 30, duration);
    if (start >= duration) return '';
    return `<section class="clip" id="scene-${i}" data-start="${start}" data-duration="${end - start}" data-track-index="0"><div class="visual" id="visual-${i}">${scene.image ? `<img src="${escape(scene.image)}" alt="${escape(scene.heading)}">` : ''}<small>${String(i + 1).padStart(2, '0')} / ${scenes.length}</small><h1>${escape(scene.heading)}</h1><p>${escape(scene.detail)}</p></div><div class="caption">${escape(c.text)}</div></section>`;
  }).join('\n');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escape(title)}</title><script src="gsap.min.js"></script><style>@font-face{font-family:"Microsoft YaHei";src:local("Microsoft YaHei")}body{margin:0;background:#f6f5f2;color:#202124;font-family:"Microsoft YaHei",system-ui,sans-serif}#root{background:#f6f5f2;position:relative;width:${width}px;height:${height}px;overflow:hidden}.clip{position:absolute;inset:0;padding:7%;box-sizing:border-box}.visual{position:absolute;left:8%;right:8%;top:18%}.visual:has(img){top:9%}.visual img{width:100%;height:38%;max-height:260px;object-fit:contain;margin-bottom:12px}small{color:#68746b;font-size:22px}h1{font-size:${width < height ? 48 : 60}px;line-height:1.25;max-width:100%;overflow-wrap:anywhere;margin:26px 0}p{font-size:30px;line-height:1.6;white-space:pre-wrap;margin:0}.caption{position:absolute;bottom:6%;left:8%;right:8%;font-size:24px;line-height:1.5;background:#ffffffeb;border-radius:16px;padding:14px 20px;white-space:pre-wrap}</style></head><body><div id="root" data-composition-id="main" data-start="0" data-width="${width}" data-height="${height}" data-duration="${duration}"><div id="canvas-background" class="clip" data-start="0" data-duration="${duration}" data-track-index="-1" style="background:#f6f5f2"></div>${clips}<audio id="narration" class="clip" src="final.wav" data-start="0" data-duration="${duration}" data-track-index="1"></audio></div><script>const tl=gsap.timeline({paused:true});${audio.captions.map((c, i) => `tl.fromTo('#visual-${i}',{y:24,opacity:0},{y:0,opacity:1,duration:.5,ease:'power3.out'},${c.startFrame / 30});`).join('')}window.__timelines=window.__timelines||{};window.__timelines.main=tl;</script></body></html>`;
}
async function render({ directory, config, signal }) {
  const cli = path.join(config.runtime, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');
  await cliRun(config.node, cli, ['lint', directory], directory, signal, config.cache);
  // HyperFrames' software MP4 route assumes libx264. Keep the product's
  // existing LGPL FFmpeg: render WebM upstream, then encode with OpenH264.
  const intermediate = path.join(directory, 'render.webm');
  await cliRun(config.node, cli, ['render', directory, '--format', 'webm', '--output', intermediate, '--workers', '1', '--no-browser-gpu', '--no-best-effort', '--strict', '--frames-cache-dir', path.join(directory, 'frames')], directory, signal, config.cache);
  await run(resolveBinaries().ffmpeg, ['-v', 'error', '-nostdin', '-y', '-i', intermediate, '-c:v', 'libopenh264', '-b:v', '4M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', path.join(directory, 'final.mp4')], signal);
  const file = path.join(directory, 'final.mp4'), info = await createCompositionWorker().probe(file);
  if (!info.hasAudio || info.size > 256 * 1024 * 1024) P.fail('成片缺少音轨或超过资料库大小限制');
  return { file, ...info, mime: 'video/mp4' };
}
module.exports = { segments, composition, synthesize, render };
