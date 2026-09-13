'use strict';

// C19: scoped, revocable capability URLs for workspace media. Tokens are
// bound to one daemon-resolved file identity, serve Range/HEAD over loopback
// with bounded chunks, and are revoked by expiry, panel close (revokeScope),
// file replacement and symlink switches.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceMediaPreview } = require('../workspace-media-preview');
const { createWorkspacePreview } = require('../workspace-preview');

const fetchBody = async (url, headers = {}) => new Promise((resolve, reject) => {
  const { request } = require('node:http');
  const req = request(url, { method: 'GET', headers }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), chunks: chunks.length }));
  });
  req.on('error', reject);
  req.end();
});
const headRequest = async (url, headers = {}) => new Promise((resolve, reject) => {
  const { request } = require('node:http');
  const req = request(url, { method: 'HEAD', headers }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })); });
  req.on('error', reject);
  req.end();
});
const postRequest = async url => new Promise((resolve, reject) => {
  const { request } = require('node:http');
  const req = request(url, { method: 'POST' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject);
  req.end();
});

test('issued tokens serve full, HEAD and ranged reads with correct bytes', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-wmedia-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = createWorkspaceMediaPreview({});
  t.after(() => service.close());
  const content = Buffer.from(Array.from({ length: 100000 }, (_, i) => i % 251));
  fs.writeFileSync(path.join(home, 'clip.bin'), content);
  const issued = await service.issue({ threadId: 'thread-1', file: path.join(home, 'clip.bin'), mime: 'video/mp4' });
  assert.match(issued.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}$/);
  const full = await fetchBody(issued.url);
  assert.equal(full.status, 200);
  assert.deepEqual(full.body, content);
  assert.equal(full.headers['accept-ranges'], 'bytes');
  const head = await headRequest(issued.url);
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers['content-length']), content.length);
  const headRange = await headRequest(issued.url, { Range: 'bytes=0-99' });
  assert.equal(headRange.status, 206);
  assert.equal(headRange.headers['content-range'], `bytes 0-99/${content.length}`);
  const first = await fetchBody(issued.url, { Range: 'bytes=0-99' });
  assert.equal(first.status, 206);
  assert.deepEqual(first.body, content.subarray(0, 100));
  const tail = await fetchBody(issued.url, { Range: `bytes=-100` });
  assert.deepEqual(tail.body, content.subarray(content.length - 100));
  const middle = await fetchBody(issued.url, { Range: 'bytes=50000-50099' });
  assert.deepEqual(middle.body, content.subarray(50000, 50100));
  // Re-issuing the same identity inside the TTL reuses the capability.
  const again = await service.issue({ threadId: 'thread-1', file: path.join(home, 'clip.bin'), mime: 'video/mp4' });
  assert.equal(again.token, issued.token);
});

test('a large media file streams from both ends in bounded chunks', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-wmedia-big-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = createWorkspaceMediaPreview({});
  t.after(() => service.close());
  const big = path.join(home, 'big.mp4');
  const handle = fs.openSync(big, 'w');
  fs.truncateSync(big, 64 * 1024 * 1024 + 777);
  const seed = Buffer.from([1, 2, 3, 4]);
  fs.writeSync(handle, seed, 0, seed.length, 0);
  fs.writeSync(handle, seed, 0, seed.length, 64 * 1024 * 1024);
  fs.closeSync(handle);
  const size = fs.statSync(big).size;
  assert.ok(size > 64 * 1024 * 1024);
  const issued = await service.issue({ workspaceId: 'ws-big', file: big, mime: 'video/mp4' });
  const firstFourMB = await fetchBody(issued.url, { Range: 'bytes=0-4194303' });
  assert.equal(firstFourMB.status, 206);
  assert.equal(firstFourMB.body.length, 4 * 1024 * 1024);
  const tailRange = await fetchBody(issued.url, { Range: `bytes=${size - 1024}-` });
  assert.equal(tailRange.status, 206);
  // The seed sits 247 bytes into this window (file offset 64 MiB).
  assert.equal(tailRange.body[247], 1);
  assert.equal(tailRange.body[250], 4);
  // "First frame then seek" pattern: two independent ranged reads.
  const seek = await fetchBody(issued.url, { Range: `bytes=${size - 4194304}-${size - 4194304 + 1023}` });
  assert.equal(seek.status, 206);
  assert.equal(seek.body.length, 1024);
});

test('expiry, revoke, revokeScope and unknown tokens are all refused', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-wmedia-exp-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = createWorkspaceMediaPreview({ ttlMs: 40 });
  t.after(() => service.close());
  fs.writeFileSync(path.join(home, 'a.mp4'), 'content-a');
  fs.writeFileSync(path.join(home, 'b.mp4'), 'content-b');
  const expired = await service.issue({ threadId: 't', file: path.join(home, 'a.mp4'), mime: 'video/mp4' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal((await fetchBody(expired.url)).status, 404);
  const first = await service.issue({ threadId: 'thread-1', file: path.join(home, 'a.mp4'), mime: 'video/mp4' });
  const second = await service.issue({ threadId: 'thread-2', file: path.join(home, 'b.mp4'), mime: 'video/mp4' });
  assert.equal((await fetchBody(first.url)).status, 200);
  // Panel close: revoke only thread-1's capabilities.
  assert.equal(service.revokeScope({ threadId: 'thread-1' }), 1);
  assert.equal((await fetchBody(first.url)).status, 404);
  assert.equal((await fetchBody(second.url)).status, 200, 'another thread stays unaffected');
  service.revoke(second.token);
  assert.equal((await fetchBody(second.url)).status, 404);
  assert.equal((await fetchBody(`http://127.0.0.1:${new URL(first.url).port}/deadbeef`)).status, 404);
  assert.equal(await postRequest(first.url), 405);
});

test('file replacement and symlink switches revoke the capability', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-wmedia-switch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = createWorkspaceMediaPreview({});
  t.after(() => service.close());
  const target = path.join(home, 'real-a.bin');
  fs.writeFileSync(target, 'aaaa');
  const link = path.join(home, 'link.bin');
  fs.symlinkSync(target, link);
  const issued = await service.issue({ threadId: 't', file: link, mime: 'video/mp4' });
  assert.equal((await fetchBody(issued.url)).status, 200);
  // Replacement with a different size is a version change: 409 + revoked.
  fs.writeFileSync(path.join(home, 'real-a.bin'), 'longer-content');
  assert.equal((await fetchBody(issued.url)).status, 409);
  assert.equal(service.stat(issued.token), null);
  // Same content but a switched symlink target is an identity change: 404.
  const other = path.join(home, 'real-b.bin');
  fs.writeFileSync(other, 'same-size!');
  fs.writeFileSync(target, 'same-size!');
  const rebound = await service.issue({ threadId: 't', file: link, mime: 'video/mp4' });
  assert.equal((await fetchBody(rebound.url)).status, 200);
  fs.rmSync(link);
  fs.symlinkSync(other, link);
  assert.equal((await fetchBody(rebound.url)).status, 404, 'the token never follows a new realpath');
  assert.equal(service.stat(rebound.token), null);
});

test('invalid ranges answer 416 with the full-size Content-Range', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-wmedia-range-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = createWorkspaceMediaPreview({});
  t.after(() => service.close());
  fs.writeFileSync(path.join(home, 'v.mp4'), '12345');
  const issued = await service.issue({ threadId: 't', file: path.join(home, 'v.mp4'), mime: 'video/mp4' });
  for (const range of ['bytes=abc', 'bytes=-', 'bytes=99-98', `bytes=${Number.MAX_SAFE_INTEGER}-`]) {
    const res = await fetchBody(issued.url, { Range: range });
    assert.equal(res.status, 416, range);
    assert.equal(res.headers['content-range'], 'bytes */5');
  }
  // An If-Range mismatch falls back to the full body instead of a partial.
  const stale = await fetchBody(issued.url, { Range: 'bytes=0-1', 'If-Range': '"stale-etag"' });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.length, 5);
});

test('preview/read routes media through scoped URLs while text and small images keep the fast path', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-wmedia-preview-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = createWorkspaceMediaPreview({});
  t.after(() => service.close());
  fs.writeFileSync(path.join(home, 'clip.mp4'), 'tiny-video');
  fs.writeFileSync(path.join(home, 'small.png'), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  const bigImage = path.join(home, 'huge.png');
  const bigHandle = fs.openSync(bigImage, 'w'); fs.truncateSync(bigImage, 5 * 1024 * 1024); fs.closeSync(bigHandle);
  fs.writeFileSync(path.join(home, 'note.txt'), 'plain text');
  const preview = createWorkspacePreview({
    rpc: async (method, params) => ({ workspace: { id: 'ws', cwd: home }, absolutePath: path.join(home, params.path), kind: 'file' }),
    mediaPreview: service,
  })['preview/read'];
  const video = await preview({ workspaceId: 'ws', path: 'clip.mp4' });
  assert.equal(video.stream, true);
  assert.match(video.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}$/);
  assert.equal(video.base64, undefined);
  const small = await preview({ workspaceId: 'ws', path: 'small.png' });
  assert.equal(small.stream, undefined);
  assert.equal(small.base64, Buffer.from([137, 80, 78, 71, 1, 2, 3]).toString('base64'));
  const huge = await preview({ workspaceId: 'ws', path: 'huge.png' });
  assert.equal(huge.stream, true, 'an over-budget image must not be pushed through a base64 frame');
  assert.equal(huge.base64, undefined);
  assert.equal(huge.size, 5 * 1024 * 1024);
  // The URL serves the exact image bytes.
  const fetched = await fetchBody(huge.url);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.length, 5 * 1024 * 1024);
  await assert.rejects(preview({ workspaceId: 'ws', path: '../escape.mp4' }));
  // Without the service the legacy behaviour is preserved.
  const legacy = createWorkspacePreview({ rpc: async (method, params) => ({ workspace: { id: 'ws', cwd: home }, absolutePath: path.join(home, params.path), kind: 'file' }) })['preview/read'];
  const legacyVideo = await legacy({ workspaceId: 'ws', path: 'clip.mp4' });
  assert.equal(legacyVideo.base64, Buffer.from('tiny-video').toString('base64'));
});

test('preview/revoke revokes by token or by scope through the handler surface', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-wmedia-revoke-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = createWorkspaceMediaPreview({});
  t.after(() => service.close());
  fs.writeFileSync(path.join(home, 'a.mp4'), 'aa');
  fs.writeFileSync(path.join(home, 'b.mp4'), 'bb');
  const preview = createWorkspacePreview({
    rpc: async (method, params) => ({ workspace: { id: 'ws', cwd: home }, absolutePath: path.join(home, params.path), kind: 'file' }),
    mediaPreview: service,
  });
  const first = await preview['preview/read']({ workspaceId: 'ws', path: 'a.mp4' });
  const second = await preview['preview/read']({ workspaceId: 'ws', path: 'b.mp4' });
  const token = first.url.split('/').pop();
  await assert.rejects(preview['preview/revoke']({ token: 'not-hex' }), e => e.rpc.code === -32602);
  const byToken = await preview['preview/revoke']({ token });
  assert.equal(byToken.revoked, 1);
  const byScope = await preview['preview/revoke']({ workspaceId: 'ws' });
  assert.equal(byScope.revoked, 1);
  const { request } = require('node:http');
  const status = url => new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(await status(first.url), 404);
  assert.equal(await status(second.url), 404);
  // Without the service wired, revocation is an honest no-op.
  const legacy = createWorkspacePreview({ rpc: async () => ({ workspace: { id: 'ws', cwd: home }, absolutePath: home, kind: 'file' }) });
  assert.deepEqual(await legacy['preview/revoke']({ workspaceId: 'ws' }), { revoked: 0 });
});
