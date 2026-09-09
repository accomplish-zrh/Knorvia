'use strict';

// Controlled ffprobe/ffmpeg worker for the creation studio. Owns process
// lifecycle only — decoding stays in the native FFmpeg binaries. The worker
// reads verified local files and writes derived frames; the source video is
// never modified and no shell is involved (argument arrays everywhere).
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_SOURCE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_PIXELS = 7680 * 4320;
const SCAN_BUFFER = 32 * 1024 * 1024;
// Tail windows shrink work on long files; the final fallback decodes the
// whole stream once rather than trusting any duration arithmetic.
const WINDOWS = [3, 12, 48, Infinity];
// Structured failure reasons agreed in the night-shift contract (A-v1):
// no-video-stream / decode-failed / zero-frames / timeout / dependency-missing.
const fail = (message, reason) => { const e = new Error(message); e.rpc = { code: -32602, message, ...(reason ? { reason } : {}) }; if (reason) e.reason = reason; throw e; };
const run = (file, args, { timeoutMs, signal } = {}) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: SCAN_BUFFER, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
    if (signal?.aborted) { const e = new Error('Frame export was cancelled'); e.expose = true; reject(e); return; }
    if (error) { error.stderrText = String(stderr || ''); reject(error); return; }
    resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
  });
  signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
});
const sha256 = file => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', data => hash.update(data)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});
const seconds = value => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
// Locate the native binaries without baking any user-specific install path
// into the product: explicit env/config dir first, then PATH lookup.
function resolveBinaries({ ffmpegPath, ffprobePath } = {}) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const pick = (explicit, name) => {
    const candidates = [];
    if (explicit) candidates.push(explicit);
    if (process.env.KNORVIA_FFMPEG_DIR) candidates.push(path.join(process.env.KNORVIA_FFMPEG_DIR, name + suffix));
    if (process.env.KNORVIA_MEDIA_BIN_DIR) candidates.push(path.join(process.env.KNORVIA_MEDIA_BIN_DIR, name + suffix));
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'runtime', 'bin', name + suffix));
    candidates.push(name);
    return candidates.find(candidate => {
      if (candidate.includes(path.sep) || candidate.includes('/')) return fs.existsSync(candidate);
      return true; // bare name: resolved via PATH by the OS at spawn time
    }) ?? null;
  };
  const ffmpeg = pick(ffmpegPath, 'ffmpeg');
  const ffprobe = pick(ffprobePath, 'ffprobe');
  if (!ffmpeg || !ffprobe) fail('未找到 FFmpeg/ffprobe。请在设置中指定 FFmpeg 目录，或安装 FFmpeg 后重试。', 'dependency-missing');
  return { ffmpeg, ffprobe };
}
function parseProbe(stdout) {
  let parsed; try { parsed = JSON.parse(stdout); } catch { fail('无法解析视频流信息（ffprobe 输出异常）', 'decode-failed'); }
  const streams = (parsed.streams || []).filter(stream => stream.codec_type === 'video');
  if (!streams.length) fail('该文件没有视频流，无法导出帧', 'no-video-stream');
  const stream = streams[0];
  if (!stream.codec_name) fail('未知视频编码，无法导出帧', 'decode-failed');
  const width = Number(stream.width) || 0, height = Number(stream.height) || 0;
  if (!width || !height) fail('视频分辨率信息缺失，无法导出帧', 'decode-failed');
  if (width * height > MAX_PIXELS) fail('视频分辨率过大，无法导出帧', 'decode-failed');
  const rotationEntry = (stream.side_data_list || []).find(entry => entry && entry.rotation !== undefined);
  const displaymatrix = (stream.side_data_list || []).find(entry => entry && /displaymatrix/i.test(entry.side_data_type || ''));
  const rotation = rotationEntry ? Number(rotationEntry.rotation) : displaymatrix ? Number(displaymatrix.rotation) : 0;
  const start = seconds(stream.start_time ?? parsed.format?.start_time) ?? 0;
  let duration = seconds(stream.duration);
  if (duration === null) {
    const formatDuration = seconds(parsed.format?.duration);
    const formatStart = seconds(parsed.format?.start_time) ?? 0;
    duration = formatDuration === null ? null : Math.max(0, formatDuration - formatStart);
  }
  return { streamIndex: Number(stream.index) || 0, codec: stream.codec_name, width, height, rotation, startTime: start, duration, timeBase: typeof stream.time_base === 'string' ? stream.time_base : undefined, nbFrames: Number(stream.nb_frames) || null };
}
// The last displayed frame is the highest-PTS decodable frame of the selected
// video stream — never `duration - 1/fps`, which VFR, B-frames, a longer audio
// track, non-zero start time or a wrong container duration all break.
async function extractTailFrame(binaries, source, target, { signal, timeoutMs = 120000 } = {}) {
  const info = await probeVideo(binaries, source, { signal, timeoutMs });
  const end = info.duration === null ? null : info.startTime + info.duration;
  let lastPts = null; let usedFullScan = false;
  for (const window of WINDOWS) {
    const full = window === Infinity;
    const windowStart = full ? null : Math.max(info.startTime, (end ?? info.startTime) - window);
    let scanned;
    try {
      scanned = await scanTail(binaries, source, windowStart, { signal, timeoutMs });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (full) throw error;
      continue; // seek past EOF / demuxer error: widen the window
    }
    if (scanned.pts !== null) {
      // With -copyts pts are original; a build that strips copyts reports
      // window-relative values, detectable because they fall before winStart.
      lastPts = windowStart === null || scanned.pts >= windowStart - 0.001 ? scanned.pts : windowStart + scanned.pts;
      usedFullScan = full;
      break;
    }
  }
  if (lastPts === null) fail('无法解码出有效视频帧（文件可能损坏、截断或不含可显示画面）', 'zero-frames');
  await grabFrame(binaries, source, target, lastPts, { signal, timeoutMs });
  const exported = await statFile(target);
  return { ...info, lastPts, usedFullScan, exported: { path: target, ...exported } };
}
// Decode the tail window to null with showinfo; the final logged frame is the
// last display frame (ffmpeg reorders B-frames before filters run).
let legacyVsync = false; // ffmpeg < 5.1 has no -fps_mode; -vsync 0 is equivalent here
async function decodeRun(binaries, args, options) {
  try { return await run(binaries.ffmpeg, args, options); }
  catch (error) {
    if (legacyVsync || !/Unrecognized option ['"]?-?fps_mode|Invalid.*['"]fps_mode['"]/.test(error.stderrText)) throw error;
    legacyVsync = true;
    const legacy = args.map((arg, index) => (arg === '-fps_mode' ? '-vsync' : arg === 'passthrough' && args[index - 1] === '-fps_mode' ? '0' : arg));
    return run(binaries.ffmpeg, legacy, options);
  }
}
async function scanTail(binaries, source, seekPoint, { signal, timeoutMs }) {
  // showinfo logs at info level; only its lines carry frame timestamps. A
  // full scan passes no -ss at all: files with edit lists can reject every
  // positive seek, and the unseeked path always decodes.
  const args = ['-nostdin', '-v', 'info', '-i', source,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-fps_mode', 'passthrough', '-vf', 'showinfo', '-f', 'null', '-'];
  if (seekPoint !== null) { args.splice(2, 0, '-copyts', '-ss', String(seekPoint)); }
  let result;
  try { result = await decodeRun(binaries, args, { timeoutMs, signal }); }
  catch (error) {
    // showinfo never ran (no frames): distinguish "no output" from failure.
    if (/Output file is empty|does not contain any stream|Output stream/.test(error.stderrText) && !signal?.aborted) return { pts: null };
    throw error;
  }
  // %f prints 6 decimals and may round up; floor back so a later exact seek
  // cannot land past the final frame.
  const stamps = [...result.stderr.matchAll(/Parsed_showinfo.*?pts_time:(-?[\d.]+)/g)]
    .map(match => Math.floor(Number(match[1]) * 1e6) / 1e6).filter(Number.isFinite);
  return { pts: stamps.length ? Math.max(...stamps) : null };
}
// Accurate input seek to the exact PTS decodes forward from the previous
// keyframe and emits exactly that frame, rotated once by ffmpeg autorotate.
async function grabFrame(binaries, source, target, pts, { signal, timeoutMs }) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomUUID()}.part`;
  const write = ['-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1', '-fps_mode', 'passthrough',
    // image2 picks the encoder from the filename extension; a .part temp
    // name would silently produce MJPEG, so pin the PNG encoder.
    '-f', 'image2', '-c:v', 'png', '-y', temp];
  try {
    await decodeRun(binaries, ['-nostdin', '-v', 'error', '-ss', String(pts), '-i', source, ...write], { timeoutMs, signal });
    if (!fs.existsSync(temp) || !fs.statSync(temp).size) {
      // Some containers (edit lists, unusual start offsets) reject every
      // positive seek. Decode without seeking and keep the first frame at or
      // past the target timestamp instead.
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
      await decodeRun(binaries, ['-nostdin', '-v', 'error', '-i', source, '-vf', `select=gte(t\\,${pts})`, ...write], { timeoutMs, signal });
    }
    const size = fs.existsSync(temp) ? fs.statSync(temp).size : 0;
    if (!size) fail('定位尾帧失败：目标时间点没有可解码帧', 'zero-frames');
    fs.renameSync(temp, target);
  } finally { try { fs.unlinkSync(temp); } catch { } }
}
async function statFile(file) {
  const stat = fs.statSync(file);
  return { size: stat.size, sha256: await sha256(file) };
}
async function probeVideo(binaries, source, { signal, timeoutMs = 30000 } = {}) {
  let result;
  try { result = await run(binaries.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', source], { timeoutMs, signal }); }
  catch (error) {
    if (signal?.aborted) throw error;
    fail('无法读取视频信息：文件可能损坏、截断或不是受支持的视频', 'decode-failed');
  }
  return parseProbe(result.stdout);
}
function validateSource(source) {
  let stat; try { stat = fs.statSync(source); } catch { fail('找不到源视频文件'); }
  if (!stat.isFile()) fail('源视频路径不是普通文件');
  if (stat.size === 0) fail('源视频文件为空');
  if (stat.size > MAX_SOURCE_BYTES) fail('源视频超出可处理大小');
}
function createFrameWorker(options = {}) {
  const binaries = resolveBinaries(options);
  let decoderVersion;
  return {
    binaries,
    async decoderVersion(signal) {
      if (!decoderVersion) decoderVersion = (await run(binaries.ffmpeg, ['-version'], { timeoutMs: 15000, signal })).stdout.match(/ffmpeg version (\S+)/)?.[1] ?? 'unknown';
      return decoderVersion;
    },
    async exportTailFrame({ source, target, signal, timeoutMs }) {
      validateSource(source);
      const before = await statFile(source);
      let result;
      try { result = await extractTailFrame(binaries, source, target, { signal, timeoutMs }); }
      catch (error) {
        if (error.reason) throw error;
        if (signal?.aborted) { console.error('[media-frame-worker] export cancelled', error); fail('帧导出已取消', 'cancelled'); }
        if (error.killed || /timed out|TIMEOUT/i.test(String(error.message || ''))) { console.error('[media-frame-worker] export timed out', error); fail('帧导出超时，已中止', 'timeout'); }
        if (['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS'].includes(error.code) || /No space left on device|Disk quota exceeded|Permission denied|Read-only file system/i.test(error.stderrText || '')) fail('无法保存尾帧：请检查可用空间和目录写入权限，再重试导出', 'write-failed');
        console.error('[media-frame-worker] export failed', error);
        fail('帧导出失败：视频处理出现问题', 'decode-failed');
      }
      const after = await statFile(source);
      if (before.sha256 !== after.sha256) fail('源视频在校验前后不一致，已中止', 'decode-failed');
      const png = fs.readFileSync(target);
      if (!(png[0] === 137 && png[1] === 80 && png[2] === 78 && png[3] === 71)) fail('导出的帧不是有效 PNG', 'decode-failed');
      return {
        sourceSha256: after.sha256,
        frameSha256: crypto.createHash('sha256').update(png).digest('hex'),
        frameSize: png.length,
        ptsTime: result.lastPts,
        timeBase: result.timeBase,
        streamIndex: result.streamIndex,
        codec: result.codec,
        rotation: result.rotation,
        width: result.width,
        height: result.height,
        usedFullScan: result.usedFullScan,
      };
    },
    async probe({ source, signal, timeoutMs } = {}) { validateSource(source); return probeVideo(binaries, source, { signal, timeoutMs }); },
  };
}
module.exports = { createFrameWorker, resolveBinaries, parseProbe };
