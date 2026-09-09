'use strict';
// Frame-based captions shared by the editor, local transcription and export.
const fail = message => { throw Object.assign(new Error(message), { rpc: { code: -32602, message } }); };
function normalizeCaptions(captions = [], frames) {
  if (!Array.isArray(captions) || captions.length > 3000) fail('字幕最多支持 3000 条');
  let end = 0;
  return captions.map(c => {
    if (!c || !Number.isSafeInteger(c.startFrame) || !Number.isSafeInteger(c.endFrame) || c.startFrame < end || c.endFrame <= c.startFrame || c.endFrame > frames) fail('字幕时间需按顺序排列、不重叠，且位于成片范围内');
    const text = typeof c.text === 'string' ? c.text.trim() : '';
    if (!text || text.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail('每条字幕请输入 1–500 个有效字符');
    end = c.endFrame;
    return { startFrame: c.startFrame, endFrame: c.endFrame, text };
  });
}
const timestamp = frame => {
  const ms = Math.round(frame * 1000 / 30);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};
const toSrt = captions => captions.map((c, i) => `${i + 1}\n${timestamp(c.startFrame)} --> ${timestamp(c.endFrame)}\n${c.text.replace(/\r/g, '').replace(/\n\s*\n/g, '\n')}`).join('\n\n') + '\n';
function parseSrt(text, frames) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 ** 2) fail('SRT 字幕文件不能超过 2 MB');
  const time = s => { const m = /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(s); if (!m || +m[2] > 59 || +m[3] > 59) fail('无效的 SRT 时间'); return Math.round((+m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000) * 30); };
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r/g, '').trim().split(/\n\s*\n/).filter(Boolean);
  const captions = blocks.map(block => {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0])) lines.shift();
    const match = /^(\S+)\s+-->\s+(\S+)\s*$/.exec(lines.shift() ?? '');
    if (!match) fail('无法读取 SRT 字幕，请检查时间行');
    return { startFrame: time(match[1]), endFrame: time(match[2]), text: lines.join('\n') };
  });
  return normalizeCaptions(captions, frames);
}
module.exports = { normalizeCaptions, toSrt, parseSrt };
