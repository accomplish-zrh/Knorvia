/**
 * Knorvia Protocol v1 framing (bundled copy for packaged Desktop).
 * stdout frames only. Identity is Knorvia, never Codex.
 */
'use strict';

const PROTOCOL_MAJOR = 1;
const PROTOCOL_MINOR = 0;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 8192;

function encodeFrame(body) {
  const buf = Buffer.from(body, 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${buf.length}\r\n\r\n`, 'ascii'),
    buf,
  ]);
}

function tryDecode(buffer) {
  const sep = buffer.indexOf('\r\n\r\n');
  if (sep < 0) {
    if (buffer.length > MAX_HEADER_BYTES) throw new Error('protocol header too large');
    return null;
  }
  if (sep > MAX_HEADER_BYTES) throw new Error('protocol header too large');
  const header = buffer.slice(0, sep).toString('ascii');
  const matches = [...header.matchAll(/^content-length:[ \t]*(\d+)[ \t]*$/gim)];
  if (matches.length !== 1) throw new Error('expected one Content-Length');
  const length = Number(matches[0][1]);
  if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) throw new Error('protocol frame too large');
  const start = sep + 4;
  if (buffer.length < start + length) return null;
  const body = buffer.slice(start, start + length).toString('utf8');
  const rest = buffer.slice(start + length);
  return { message: JSON.parse(body), rest };
}

function initializeRequest(clientName, version) {
  return {
    jsonrpc: '2.0',
    id: 'req_01',
    method: 'initialize',
    params: {
      protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
      client: { name: clientName, version, platform: process.platform },
      capabilities: ['thread', 'artifact', 'job', 'approval', 'reconnect', 'workspace', 'model', 'skills'],
    },
  };
}

module.exports = {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  encodeFrame,
  tryDecode,
  initializeRequest,
};
