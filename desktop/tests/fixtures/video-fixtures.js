'use strict';

// Deterministic tiny video fixtures for frame-worker tests. Every fixture is
// generated with the locally installed FFmpeg; no network, no user media.
// Frames are solid-color PNGs joined through the concat DEMUXER so every
// frame keeps an explicit, ordered presentation timestamp — the filter-based
// variant collapses pts in ffmpeg 8.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let cachedFfmpeg;
function ffmpeg() {
  if (cachedFfmpeg) return cachedFfmpeg;
  const candidates = [];
  if (process.env.KNORVIA_TEST_FFMPEG) candidates.push(process.env.KNORVIA_TEST_FFMPEG);
  if (process.platform === 'win32' && process.env.USERPROFILE) candidates.push(`${process.env.USERPROFILE}\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe`);
  candidates.push('ffmpeg');
  cachedFfmpeg = candidates.find(candidate => { try { return candidate.includes(path.sep) ? fs.existsSync(candidate) : true; } catch { return false; } });
  if (!cachedFfmpeg) throw new Error('no ffmpeg fixture toolchain available');
  return cachedFfmpeg;
}
function run(args, options = {}) {
  execFileSync(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 120000, ...options });
}
function solidPng(dir, name, color) {
  const image = path.join(dir, name);
  run(['-f', 'lavfi', '-i', `color=c=${color}:s=160x90:d=0.02`, '-frames:v', '1', image]);
  return image;
}
// Join per-frame PNGs with explicit durations; the LAST image is the expected
// tail frame and carries the final presentation timestamp.
function joinImages(dir, images, durations, target, extra = []) {
  const listFile = path.join(dir, `concat-${path.basename(target)}.txt`);
  const lines = images.map((image, index) => `file '${image.split('\\').join('/')}'` + (durations[index] !== undefined ? `\nduration ${durations[index]}` : ''));
  fs.writeFileSync(listFile, `${lines.join('\n')}\n`);
  run(['-f', 'concat', '-safe', '0', '-i', listFile, '-fps_mode', 'passthrough', '-pix_fmt', 'yuv420p', ...extra, target]);
  return target;
}
function sequence(dir, name, colors, extra = []) {
  const images = colors.map((color, index) => solidPng(dir, `${name}-${index}.png`, color));
  return joinImages(dir, images, colors.map(() => 0.04), path.join(dir, name), extra);
}
function vfr(dir, name, colors, durations) {
  const images = colors.map((color, index) => solidPng(dir, `${name}-${index}.png`, color));
  return joinImages(dir, images, durations, path.join(dir, name));
}
function rotated(dir, name, colors, degrees) {
  const plain = sequence(dir, `${name}-plain.mp4`, colors);
  const target = path.join(dir, name);
  run(['-display_rotation', String(degrees), '-i', plain, '-map', '0', '-c', 'copy', target]);
  return target;
}
function bFrames(dir, name, colors) {
  const plain = sequence(dir, `${name}-plain.mp4`, colors);
  const target = path.join(dir, name);
  run(['-i', plain, '-c:v', 'libx264', '-bf', '3', '-g', '3', '-fps_mode', 'passthrough', '-pix_fmt', 'yuv420p', target]);
  return target;
}
function withLongerAudio(dir, name, colors) {
  const plain = sequence(dir, `${name}-plain.mp4`, colors);
  const target = path.join(dir, name);
  // No -shortest: the audio track honestly runs longer than the video stream,
  // which is exactly the container-duration trap a duration heuristic hits.
  run(['-i', plain, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=3', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', target]);
  return target;
}
function dualVideo(dir, name, front, back) {
  const frontFile = sequence(dir, `${name}-front.mp4`, front);
  const backFile = sequence(dir, `${name}-back.mp4`, back);
  const target = path.join(dir, name);
  run(['-i', frontFile, '-i', backFile, '-map', '0:v', '-map', '1:v', '-c', 'copy', target]);
  return target;
}
function audioOnly(dir, name) {
  const target = path.join(dir, name);
  run(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=0.5', '-c:a', 'aac', '-f', 'mp4', target]);
  return target;
}
function nonzeroStart(dir, name, colors) {
  return sequence(dir, name, colors, ['-output_ts_offset', '1.25']);
}
function truncated(dir, name, colors) {
  const plain = sequence(dir, `${name}-plain.mp4`, colors);
  const bytes = fs.readFileSync(plain);
  const target = path.join(dir, name);
  fs.writeFileSync(target, bytes.subarray(0, Math.floor(bytes.length * 0.4)));
  return target;
}
// Read the top-left pixel of a PNG through ffmpeg rawvideo (test-side only).
function pixelOf(image) {
  const raw = execFileSync(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-i', image, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
  return { r: raw[0], g: raw[1], b: raw[2] };
}
function expectColor(pngFile, hex, tolerance = 10) {
  const want = [parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), parseInt(hex.slice(6, 8), 16)];
  const got = pixelOf(pngFile);
  const delta = Math.max(Math.abs(want[0] - got.r), Math.abs(want[1] - got.g), Math.abs(want[2] - got.b));
  if (delta > tolerance) throw new Error(`tail pixel ${JSON.stringify(got)} too far from ${hex} (delta ${delta})`);
}
module.exports = { ffmpeg, run, sequence, vfr, rotated, bFrames, withLongerAudio, dualVideo, audioOnly, nonzeroStart, truncated, pixelOf, expectColor };
