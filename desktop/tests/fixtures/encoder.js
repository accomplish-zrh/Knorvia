'use strict';

// Pick an H.264 encoder the local FFmpeg actually ships. The packaged runtime
// uses libopenh264; developer machines with a WinGet/Gyan build only have
// libx264. Fixtures must follow the machine, the product already probes both.
function pickH264Encoder(ffmpeg) {
  const list = require('node:child_process').execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { windowsHide: true, timeout: 15000 }).toString();
  for (const name of ['libopenh264', 'libx264']) {
    if (new RegExp(`\\s${name}\\s`).test(list)) return name;
  }
  throw new Error('本地 FFmpeg 没有 libopenh264/libx264 编码器，无法生成测试视频');
}

module.exports = { pickH264Encoder };
