'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const { createUpdateDownloadManager, parseDigest, safeFileName } = require('../update-download');

const PAYLOAD = Buffer.from('A'.repeat(64 * 1024) + 'Knorvia installer payload'.repeat(10));
const SHA = createHash('sha256').update(PAYLOAD).digest('hex');

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const destinationDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'knorvia-update-dl-'));
  t.after(() => fsp.rm(destinationDir, { recursive: true, force: true }));
  const port = server.address().port;
  const manager = createUpdateDownloadManager({ defaultDownloadDir: destinationDir });
  return { server, destinationDir, port, manager, url: (p = '/asset') => `http://127.0.0.1:${port}${p}` };
}

const settled = (task, state, ms = 5000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const poll = () => {
    const current = typeof task === 'function' ? task() : task;
    if (!current || current.state !== 'downloading' || (state && current.state === state)) return resolve(current);
    if (Date.now() - started > ms) return reject(new Error(`download did not settle: ${JSON.stringify(current)}`));
    setTimeout(poll, 25);
  };
  poll();
});

test('a slow download reports progress, verifies the digest and publishes atomically', async t => {
  const { manager, destinationDir, url } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
    let at = 0;
    const timer = setInterval(() => {
      if (at >= PAYLOAD.length) { clearInterval(timer); res.end(); return; }
      const slice = PAYLOAD.subarray(at, at + 4096); at += 4096;
      res.write(slice);
    }, 5);
    req.on('close', () => clearInterval(timer));
  });
  const updates = [];
  const start = manager.start({
    url: url(), name: 'Knorvia-2.0.0-setup.exe', version: '2.0.0', sha256: SHA, size: PAYLOAD.length,
    onProgress: (task) => updates.push(task.state),
  });
  assert.equal(start.ok, true);
  assert.equal(start.task.state, 'downloading');
  const final = await settled(() => manager.status(), 'published');
  assert.equal(final.state, 'published');
  assert.equal(final.verified, true, 'digest-verified download');
  assert.equal(final.receivedBytes, PAYLOAD.length);
  assert.match(final.publishedPath, /2\.0\.0-Knorvia-2\.0\.0-setup\.exe$/);
  const published = await fsp.readFile(final.publishedPath);
  assert.ok(published.equals(PAYLOAD), 'published bytes match the source');
  assert.equal(fs.existsSync(path.join(destinationDir, `.${final.id}.part`)), false, 'no temp file left behind');
  assert.equal(manager.revealTarget(), final.publishedPath, 'verified downloads expose the reveal action');
  assert.ok(updates.includes('downloading') && updates.includes('published'));
});

test('a missing digest completes but is explicitly unverified and gets no reveal action', async t => {
  const { manager, url } = await fixture(t, (req, res) => { res.writeHead(200); res.end(PAYLOAD); });
  manager.start({ url: url(), name: 'setup.exe', version: '2.0.0' });
  const final = await settled(() => manager.status(), 'published');
  assert.equal(final.state, 'published');
  assert.equal(final.verified, false, 'no claimed verification without a digest');
  assert.equal(manager.revealTarget(), '', 'unverified downloads get no reveal action');
  assert.match(final.publishedPath, /setup\.exe$/);
});

test('a digest mismatch refuses to publish and removes the temp file', async t => {
  const { manager, destinationDir, url } = await fixture(t, (req, res) => { res.writeHead(200); res.end(PAYLOAD); });
  manager.start({ url: url(), name: 'setup.exe', version: '2.0.0', sha256: '0'.repeat(64), size: PAYLOAD.length });
  const final = await settled(() => manager.status());
  assert.equal(final.state, 'failed');
  assert.match(final.error, /SHA-256/);
  assert.equal(final.publishedPath, '');
  const leftovers = (await fsp.readdir(destinationDir)).filter((name) => !name.startsWith('setup'));
  assert.deepEqual(leftovers, [], 'no temp or partial file remains');
});

test('cancelling mid-download removes only this task\'s temp file and allows a fresh download', async t => {
  let clients = 0;
  const huge = PAYLOAD.length * 200; // far more than we ever send during the test
  const { manager, destinationDir, url } = await fixture(t, (req, res) => {
    clients += 1;
    res.writeHead(200, { 'content-length': String(huge) });
    const timer = setInterval(() => res.write(PAYLOAD), 10);
    req.on('close', () => { clearInterval(timer); res.destroy(); });
  });
  manager.start({ url: url(), name: 'setup.exe', version: '2.0.0', sha256: SHA, size: huge });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(manager.status().state, 'downloading');
  const cancel = await manager.cancel();
  assert.equal(cancel.cancelled, true);
  const status = manager.status();
  assert.equal(status.state, 'cancelled');
  assert.equal((await fsp.readdir(destinationDir)).filter((name) => name.startsWith('.')).length, 0, 'temp file removed on cancel');
  assert.equal(clients, 1, 'no second download was started for the same request');
  // Retrying the same request after cancellation starts a real new attempt.
  const retry = manager.start({ url: url(), name: 'setup.exe', version: '2.0.0', sha256: SHA, size: huge });
  assert.equal(retry.ok, true);
  assert.notEqual(retry.task.id, status.id);
  assert.equal(retry.task.state, 'downloading');
  await manager.cancel();
});

test('retrying the same request while downloading never opens a second download', async t => {
  let connections = 0;
  const huge = PAYLOAD.length * 200;
  const { manager, url } = await fixture(t, (req, res) => {
    connections += 1;
    res.writeHead(200, { 'content-length': String(huge) });
    const timer = setInterval(() => res.write(PAYLOAD), 10);
    req.on('close', () => { clearInterval(timer); res.destroy(); });
  });
  const first = manager.start({ url: url(), name: 'setup.exe', version: '2.0.0', sha256: SHA, size: huge });
  await new Promise((resolve) => setTimeout(resolve, 150)); // let the fetch actually reach the server
  const second = manager.start({ url: url(), name: 'setup.exe', version: '2.0.0', sha256: SHA, size: huge });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.existing, true, 'same request returns the running task');
  assert.equal(second.task.id, first.task.id);
  const other = manager.start({ url: url('/other'), name: 'other.exe', version: '2.0.0' });
  assert.equal(other.ok, false, 'a different request is refused while busy');
  await manager.cancel();
  assert.equal(connections, 1);
});

test('an existing published file and an interrupted transfer both refuse to publish', async t => {
  const { manager, destinationDir, url } = await fixture(t, (req, res) => {
    // Declare more bytes than are ever sent, then drop the connection:
    // the transfer is interrupted mid-way and must not publish.
    res.writeHead(200, { 'content-length': String(PAYLOAD.length * 2) });
    res.write(PAYLOAD);
    setTimeout(() => res.destroy(), 30);
  });
  const existing = path.join(destinationDir, safeFileName('setup.exe', '2.0.0'));
  await fsp.writeFile(existing, 'previous download');
  const start = manager.start({ url: url(), name: 'setup.exe', version: '2.0.0', sha256: SHA, size: PAYLOAD.length * 2 });
  assert.equal(start.ok, true);
  const interrupted = await settled(() => manager.status());
  assert.equal(interrupted.state, 'failed');
  assert.equal(interrupted.publishedPath, '', 'incomplete transfer is not published');
  assert.equal(await fsp.readFile(existing, 'utf8'), 'previous download', 'existing file never overwritten');
  assert.equal((await fsp.readdir(destinationDir)).filter((name) => name.startsWith('.')).length, 0);
});

test('digest parsing and file-name sanitisation', () => {
  assert.equal(parseDigest('sha256:' + SHA), SHA);
  assert.equal(parseDigest('sha256:' + SHA.toUpperCase()), SHA);
  assert.equal(parseDigest('md5:abc'), '');
  assert.equal(parseDigest(''), '');
  assert.equal(safeFileName('../evil name<>.exe', '1.2.3'), '1.2.3-.._evil name__.exe');
  assert.equal(safeFileName('a'.repeat(300), ''), 'a'.repeat(120));
});
