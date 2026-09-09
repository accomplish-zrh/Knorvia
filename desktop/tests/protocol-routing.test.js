'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { attachProtocol, encodeFrame, tryDecode } = require('../knorvia-protocol-client');

function fixture(options) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null, 'SIGTERM');
  const session = attachProtocol(child, options);
  const send = (message) => child.stdout.write(encodeFrame(JSON.stringify(message)));
  return { child, session, send };
}

test('notifications and reversed responses do not steal another request result', async () => {
  const { session, send } = fixture();
  const notifications = [];
  const unsubscribe = session.onNotification((message) => notifications.push(message));
  const first = session.request({ id: 'one', method: 'turn/start' });
  const second = session.request({ id: 'two', method: 'workspace/list' });
  const event = { method: 'turn/event', params: { kind: 'agentMessage.delta', payload: { text: '你好' } } };
  send(event);
  send({ id: 'two', result: ['workspace'] });
  send({ id: 'one', result: { turn: { status: 'failed' } } });
  assert.deepEqual(await second, { id: 'two', result: ['workspace'] });
  assert.deepEqual(await first, { id: 'one', result: { turn: { status: 'failed' } } });
  assert.deepEqual(notifications, [event]);
  unsubscribe();
  send(event);
  assert.equal(notifications.length, 1);
});

test('split UTF-8 frames and coalesced responses preserve ID types', async () => {
  const { child, session } = fixture();
  const a = session.request({ id: 1, method: 'a' });
  const b = session.request({ id: '1', method: 'b' });
  const bytes = Buffer.concat([
    encodeFrame(JSON.stringify({ id: '1', result: '你好' })),
    encodeFrame(JSON.stringify({ id: 1, result: 'numeric' })),
  ]);
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  assert.equal((await a).result, 'numeric');
  assert.equal((await b).result, '你好');
});

test('process failure rejects every outstanding request and future calls', async () => {
  const { child, session } = fixture();
  const a = assert.rejects(session.request({ id: 'a', method: 'a' }), /closed/);
  const b = assert.rejects(session.request({ id: 'b', method: 'b' }), /closed/);
  child.kill();
  await Promise.all([a, b]);
  await assert.rejects(session.request({ id: 'c', method: 'c' }), /closed/);
});

test('spawn and framing errors reject pending requests without hanging', async () => {
  const first = fixture();
  const error = assert.rejects(first.session.request({ id: 1, method: 'a' }), /ENOENT/);
  first.child.emit('error', new Error('ENOENT'));
  await error;
  const second = fixture();
  const malformed = assert.rejects(second.session.request({ id: 1, method: 'a' }), /Content-Length/);
  second.child.stdout.write('garbage\r\n\r\n');
  await malformed;
});

test('deadline removes the request and ignores its late response', async () => {
  const { session, send } = fixture({ requestTimeoutMs: 20 });
  await assert.rejects(session.request({ id: 'late', method: 'slow' }), /timed out/);
  const next = session.request({ id: 'next', method: 'next' });
  send({ id: 'late', result: 'obsolete' });
  send({ id: 'next', result: 'current' });
  assert.equal((await next).result, 'current');
});

test('a cold-start deadline does not relax ordinary control request deadlines', async () => {
  const { session, send } = fixture({ requestTimeoutMs: 20 });
  const startup = session.request({ id: 'startup', method: 'initialize' }, { timeoutMs: 1000 });
  await assert.rejects(session.request({ id: 'ordinary', method: 'turn/read' }), /timed out/);
  send({ id: 'startup', result: 'recovered' });
  assert.equal((await startup).result, 'recovered');
  await assert.rejects(session.request({ id: 'invalid', method: 'initialize' }, { timeoutMs: -1 }), /positive/);
});

test('duplicate IDs are rejected without displacing the first request', async () => {
  const { session, send } = fixture();
  const first = session.request({ id: 'same', method: 'first' });
  await assert.rejects(session.request({ id: 'same', method: 'second' }), /duplicate/);
  send({ id: 'same', result: 'first' });
  assert.equal((await first).result, 'first');
});

test('oversized and duplicate frame lengths are rejected before buffering bodies', () => {
  assert.throws(() => tryDecode(Buffer.from('Content-Length: 999999999\r\n\r\n')), /too large/);
  assert.throws(() => tryDecode(Buffer.from('Content-Length: 2\r\nContent-Length: 3\r\n\r\n{}')), /one Content-Length/);
  assert.throws(() => tryDecode(Buffer.alloc(8193, 'x')), /header too large/);
});
