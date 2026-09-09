'use strict';

// Local, bounded renderer. The caller owns durable Jobs; this module only
// probes immutable media and renders a frame-based edit manifest.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { resolveBinaries } = require('./media-frame-worker');
const { normalizeCaptions, toSrt } = require('./studio-subtitles');
const fail = message => { const e = new Error(message); e.rpc = { code: -32602, message }; throw e; };
const hash = file => new Promise((resolve, reject) => {
  const sum = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', bytes => sum.update(bytes)).on('error', reject).on('end', () => resolve(sum.digest('hex')));
});
function run(file, args, signal, timeout = 600000) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) reject(signal.reason ?? new Error('Cancelled'));
      else if (error) reject(error);
      else resolve(String(stdout));
    });
    const stop = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', stop, { once: true });
  });
}
const FPS = 30;
function normalizeEdit(value, sources) {
  if (!value || !Array.isArray(value.clips) || !value.clips.length || value.clips.length > 200) fail('请保留 1–200 个镜头');
  const byId = new Map(sources.map(s => [s.id, s]));
  const ids = new Set();
  const clips = value.clips.map(c => {
    const source = byId.get(c?.id);
    if (!source || ids.has(c.id)) fail('镜头不存在或重复');
    ids.add(c.id);
    const startFrame = c.startFrame ?? 0, endFrame = c.endFrame ?? source.frames;
    const volume = c.volume ?? 1, fadeFrames = c.fadeFrames ?? 0;
    if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || startFrame < 0 || endFrame > source.frames || endFrame <= startFrame) fail('裁切范围超出镜头长度');
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 2) fail('音量应在 0–200% 之间');
    if (!Number.isInteger(fadeFrames) || fadeFrames < 0 || fadeFrames > 30 || fadeFrames * 2 > endFrame - startFrame) fail('淡入淡出不能超过镜头时长的一半');
    if (c.fit !== undefined && !['contain', 'cover'].includes(c.fit)) fail('无效的画面适配方式');
    if (c.rotation !== undefined && ![0, 90, 180, 270].includes(c.rotation)) fail('旋转角度应为 0、90、180 或 270 度');
    if (c.mirror !== undefined && typeof c.mirror !== 'boolean') fail('镜像开关无效');
    return { id: c.id, startFrame, endFrame, volume, fadeFrames, ...(c.fit !== undefined ? { fit: c.fit } : {}), ...(c.rotation !== undefined ? { rotation: c.rotation } : {}), ...(c.mirror !== undefined ? { mirror: c.mirror } : {}) };
  });
  if (clips.reduce((n, c) => n + c.endFrame - c.startFrame, 0) > FPS * 1800) fail('单个成片最长支持 30 分钟，请分段导出');
  const aspect = value.aspect ?? '16:9';
  if (!['16:9', '9:16', '1:1'].includes(aspect)) fail('不支持此成片画幅');
  const captions = normalizeCaptions(value.captions, clips.reduce((n, c) => n + c.endFrame - c.startFrame, 0));
  return { fps: FPS, aspect, clips, ...(captions.length ? { captions } : {}) };
}
function createCompositionWorker(options = {}) {
  const binaries = resolveBinaries(options);
  async function probe(file, signal) {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || !stat.size || stat.size > 8 * 1024 ** 3) fail('视频文件为空、缺失或超过 8 GB');
    const info = JSON.parse(await run(binaries.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], signal, 30000));
    const video = info.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const duration = Number(video?.duration ?? info.format?.duration);
    if (!video || !(duration > 0) || !Number.isFinite(duration) || !video.width || !video.height || video.width * video.height > 7680 * 4320) fail('无法读取有效的视频长度与画面');
    return { duration, frames: Math.floor(duration * FPS + 0.0001), width: video.width, height: video.height, hasAudio: info.streams.some(s => s.codec_type === 'audio'), sha256: await hash(file), size: stat.size };
  }
  async function encoder(dir, signal) {
    const available = await run(binaries.ffmpeg, ['-hide_banner', '-encoders'], signal, 15000);
    // Probe a real frame; encoder enumeration alone does not prove availability.
    for (const name of ['libopenh264', 'libx264']) {
      if (!available.includes(` ${name} `)) continue;
      try {
        await run(binaries.ffmpeg, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=s=32x32:r=30', '-frames:v', '1', '-c:v', name, '-pix_fmt', 'yuv420p', '-y', path.join(dir, 'encoder.mp4')], signal, 15000);
        return name;
      } catch { signal?.throwIfAborted(); }
    }
    fail('没有可用的 H.264 软件编码器，请检查 FFmpeg 配置');
  }
  async function render({ edit, sources, directory, signal, progress = async () => {}, canvas }) {
    const plan = normalizeEdit(edit, sources);
    fs.mkdirSync(directory, { recursive: true });
    const codec = await encoder(directory, signal);
    const [width, height] = canvas ? [canvas.width, canvas.height] : plan.aspect === '9:16' ? [720, 1280] : plan.aspect === '1:1' ? [960, 960] : [1280, 720];
    if (![width, height].every(n => Number.isInteger(n) && n > 0 && n % 2 === 0) || width * height > 7680 * 4320) fail('无效的输出分辨率');
    const files = [];
    for (const [index, clip] of plan.clips.entries()) {
      signal?.throwIfAborted();
      const source = sources.find(s => s.id === clip.id);
      if (await hash(source.file) !== source.sha256) fail('源视频已发生变化，请重新导入分镜');
      const info = await probe(source.file, signal);
      const duration = (clip.endFrame - clip.startFrame) / FPS, fade = clip.fadeFrames / FPS;
      const vf = [`setpts=PTS-STARTPTS`, `fps=${FPS}`, `trim=start_frame=${clip.startFrame}:end_frame=${clip.endFrame}`, 'setpts=PTS-STARTPTS'];
      if (clip.rotation === 90) vf.push('transpose=clock');
      if (clip.rotation === 180) vf.push('hflip', 'vflip');
      if (clip.rotation === 270) vf.push('transpose=cclock');
      if (clip.mirror) vf.push('hflip');
      vf.push(...(clip.fit === 'cover' ? [`scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2`, `crop=${width}:${height}`] : [`scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`]), 'setsar=1', 'format=yuv420p');
      const af = [`atrim=start=${clip.startFrame / FPS}:end=${clip.endFrame / FPS}`, 'asetpts=PTS-STARTPTS', 'aresample=48000', 'aformat=channel_layouts=stereo', `volume=${clip.volume}`, `apad=whole_dur=${duration}`, `atrim=duration=${duration}`];
      if (fade) { vf.push(`fade=t=in:d=${fade}`, `fade=t=out:st=${duration - fade}:d=${fade}`); af.push(`afade=t=in:d=${fade}`, `afade=t=out:st=${duration - fade}:d=${fade}`); }
      const args = ['-v', 'error', '-nostdin', '-i', source.file];
      if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
      const name = `clip-${index}.mp4`;
      args.push('-map', '0:v:0', '-map', info.hasAudio ? '0:a:0' : '1:a:0', '-vf', vf.join(','), '-af', af.join(','), '-t', String(duration), '-c:v', codec, '-b:v', '3000k', '-threads', '2', '-filter_threads', '1', '-c:a', 'aac', '-b:a', '128k', '-video_track_timescale', '30000', '-y', path.join(directory, name));
      await run(binaries.ffmpeg, args, signal);
      if (await hash(source.file) !== source.sha256) fail('源视频在处理过程中变化，导出已停止');
      files.push(name);
      await progress(Math.round((index + 1) / plan.clips.length * 85));
    }
    const frames = plan.clips.reduce((sum, c) => sum + c.endFrame - c.startFrame, 0);
    // AAC packet padding must not shift every following picture. Explicit
    // frame durations keep cut positions identical to the edit manifest.
    fs.writeFileSync(path.join(directory, 'clips.txt'), files.map((name, i) => `file '${name}'\nduration ${(plan.clips[i].endFrame - plan.clips[i].startFrame) / FPS}`).join('\n'));
    const file = path.join(directory, 'film.mp4');
    const subtitleArgs = [];
    if (plan.captions?.length) {
      fs.writeFileSync(path.join(directory, 'captions.srt'), toSrt(plan.captions));
      subtitleArgs.push('-i', path.join(directory, 'captions.srt'), '-map', '0:v:0', '-map', '0:a:0', '-map', '1:s:0', '-c:s', 'mov_text', '-metadata:s:s:0', 'title=Captions', '-disposition:s:0', 'default');
    }
    await run(binaries.ffmpeg, ['-v', 'error', '-nostdin', '-f', 'concat', '-safe', '1', '-i', path.join(directory, 'clips.txt'), ...subtitleArgs, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-t', String(frames / FPS), '-movflags', '+faststart', '-y', file], signal);
    const output = await probe(file, signal);
    if (Math.abs(output.duration - frames / FPS) > 1 / FPS + 0.001) fail('成片时长与剪辑清单不一致，请重试');
    if (output.size > 256 * 1024 ** 2) fail('成片超过资料库的 256 MB 单文件上限，请缩短后导出');
    return { file, sha256: output.sha256, size: output.size, mime: 'video/mp4', frames, fps: FPS, width, height, encoder: codec };
  }
  async function renderAudio({ edit, sources, directory, signal, progress = async () => {} }) {
    const plan = normalizeEdit(edit, sources);
    if (!plan.clips.some(c => c.volume > 0 && sources.find(s => s.id === c.id)?.hasAudio)) fail('当前剪辑没有可识别的声音');
    fs.mkdirSync(directory, { recursive: true });
    const files = [];
    for (const [i, clip] of plan.clips.entries()) {
      const source = sources.find(s => s.id === clip.id);
      if (await hash(source.file) !== source.sha256) fail('源视频已发生变化，请重新导入分镜');
      const info = await probe(source.file, signal), duration = (clip.endFrame - clip.startFrame) / FPS, fade = clip.fadeFrames / FPS;
      const filter = [`atrim=start=${clip.startFrame / FPS}:end=${clip.endFrame / FPS}`, 'asetpts=PTS-STARTPTS', `volume=${clip.volume}`, `apad=whole_dur=${duration}`, `atrim=duration=${duration}`];
      if (fade) filter.push(`afade=t=in:d=${fade}`, `afade=t=out:st=${duration - fade}:d=${fade}`);
      const name = `audio-${i}.wav`;
      await run(binaries.ffmpeg, ['-v', 'error', '-nostdin', ...(info.hasAudio ? ['-i', source.file, '-map', '0:a:0'] : ['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono']), '-vn', '-af', filter.join(','), '-t', String(duration), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', path.join(directory, name)], signal);
      if (await hash(source.file) !== source.sha256) fail('源视频在处理过程中变化，识别已停止');
      files.push(name); await progress(Math.round((i + 1) / plan.clips.length * 30));
    }
    fs.writeFileSync(path.join(directory, 'audio.txt'), files.map(name => `file '${name}'`).join('\n'));
    const file = path.join(directory, 'speech.wav');
    await run(binaries.ffmpeg, ['-v', 'error', '-nostdin', '-f', 'concat', '-safe', '1', '-i', path.join(directory, 'audio.txt'), '-c:a', 'copy', '-y', file], signal);
    return file;
  }
  async function boundaryFrames({ source, startFrame, endFrame, directory, signal }) {
    fs.mkdirSync(directory, { recursive: true });
    if (await hash(source.file) !== source.sha256) fail('源视频已发生变化');
    const result = {};
    for (const [role, frame] of [['firstFrame', startFrame], ['lastFrame', endFrame - 1]]) {
      const file = path.join(directory, `${role}.png`);
      await run(binaries.ffmpeg, ['-v', 'error', '-nostdin', '-i', source.file, '-vf', `setpts=PTS-STARTPTS,fps=30,select=eq(n\\,${frame})`, '-frames:v', '1', '-y', file], signal);
      if (!fs.existsSync(file) || !fs.statSync(file).size) fail('无法提取重做片段的边界画面');
      result[role] = file;
    }
    if (await hash(source.file) !== source.sha256) fail('源视频在处理过程中变化');
    return result;
  }
  async function retime({ source, frames, directory, signal }) {
    fs.mkdirSync(directory, { recursive: true });
    const info = await probe(source.file, signal);
    if (info.sha256 !== source.sha256) fail('候选视频已变化');
    const duration = frames / FPS, ratio = duration / info.duration, codec = await encoder(directory, signal);
    let speed = 1 / ratio; const tempo = [];
    while (speed < .5) { tempo.push('atempo=0.5'); speed *= 2; }
    while (speed > 2) { tempo.push('atempo=2'); speed /= 2; }
    tempo.push(`atempo=${speed}`, `apad=whole_dur=${duration}`, `atrim=duration=${duration}`);
    const file = path.join(directory, 'replacement.mp4');
    await run(binaries.ffmpeg, ['-v', 'error', '-nostdin', '-i', source.file, '-map', '0:v:0', ...(info.hasAudio ? ['-map', '0:a:0', '-af', tempo.join(','), '-c:a', 'aac'] : ['-an']), '-vf', `setpts=(PTS-STARTPTS)*${ratio},fps=30,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frames},format=yuv420p`, '-c:v', codec, '-b:v', '3000k', '-threads', '2', '-filter_threads', '1', '-t', String(duration), '-y', file], signal);
    if (await hash(source.file) !== source.sha256) fail('候选视频在处理过程中变化');
    return { ...await probe(file, signal), file };
  }
  return { probe, render, renderAudio, boundaryFrames, retime };
}
module.exports = { createCompositionWorker, normalizeEdit, hash, FPS, run };
