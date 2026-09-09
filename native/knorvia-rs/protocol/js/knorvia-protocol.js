/**
 * Knorvia Protocol v1 client (Node). Desktop/Web share this module.
 * Framing is LSP Content-Length. Identity is Knorvia, never Codex.
 */
'use strict';

const PROTOCOL_MAJOR = 1;
const PROTOCOL_MINOR = 0;

function encodeFrame(body) {
  const buf = Buffer.from(body, 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${buf.length}\r\n\r\n`, 'ascii'),
    buf,
  ]);
}

function tryDecode(buffer) {
  const sep = buffer.indexOf('\r\n\r\n');
  if (sep < 0) return null;
  const header = buffer.slice(0, sep).toString('ascii');
  const match = /content-length:\s*(\d+)/i.exec(header);
  if (!match) throw new Error('missing Content-Length');
  const length = Number(match[1]);
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
      capabilities: ['thread', 'artifact', 'job', 'approval', 'reconnect', 'workspace'],
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
