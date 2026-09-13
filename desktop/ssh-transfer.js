'use strict';

// Streaming SFTP transfers (C16): each operation gets a stable identity,
// bounded memory, monotonic progress and an independent cancellation path.
// Uploads stage into a unique remote temporary name, re-verify the staged
// bytes and publish with a no-overwrite rename; downloads stage into a unique
// local temporary file and publish with a no-overwrite link/copy. A transfer
// that loses its connection is reported as detached ("incomplete"), never as
// a success, and is restarted explicitly by the user — there is no claimed
// cross-connection resume. No remote shell command is ever run.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { connectionError } = require('./connection-config');

const fail = (code, message) => { throw connectionError(code, message); };
const call = (object, method, ...args) => new Promise((resolve, reject) => object[method](...args, (error, result) => error ? reject(error) : resolve(result)));

const CHUNK_BYTES = 1024 * 1024;
// A generous but finite per-file cap; the 16 MB legacy endpoints stay for
// small files, these endpoints add large-file coverage on top.
const MAX_TRANSFER_BYTES = 8 * 1024 * 1024 * 1024;
const HISTORY_MAX = 200;
const RECORD_TTL_MS = 10 * 60 * 1000;
const TERMINAL = ['completed', 'failed', 'canceled', 'detached'];
const cancelError = () => Object.assign(new Error('Transfer cancelled'), { rpc: { code: -32012, message: 'Transfer cancelled' } });
const publicRecord = record => {
  const { runtime, settled, ...rest } = record;
  return { ...rest, stats: { maxInFlightBytes: record.maxInFlight || 0 } };
};

function createSshTransfers({ chunkSize = CHUNK_BYTES, maxTransferBytes = MAX_TRANSFER_BYTES, historyMax = HISTORY_MAX, recordTtlMs = RECORD_TTL_MS } = {}) {
  const transfers = new Map();
  const bySession = new Map();
  const track = record => {
    transfers.set(record.transferId, record);
    if (!bySession.has(record.sessionId)) bySession.set(record.sessionId, new Set());
    bySession.get(record.sessionId).add(record.transferId);
  };
  const untrack = record => { transfers.delete(record.transferId); bySession.get(record.sessionId)?.delete(record.transferId); };
  function evictFinished(now = Date.now()) {
    for (const record of [...transfers.values()]) {
      if (TERMINAL.includes(record.status) && now - record.finishedAt > recordTtlMs) untrack(record);
    }
    const finished = [...transfers.values()].filter(record => TERMINAL.includes(record.status)).sort((a, b) => a.finishedAt - b.finishedAt);
    for (const record of finished.slice(0, Math.max(0, finished.length - historyMax))) untrack(record);
  }
  function finalize(record, status, error, sha256) {
    if (TERMINAL.includes(record.status)) return;
    record.status = status;
    record.error = error || '';
    if (sha256) record.sha256 = sha256;
    record.finishedAt = Date.now();
    record.settled.resolve();
    evictFinished();
  }
  // Drains one chunk into a writable stream, abortable mid-backpressure.
  function pump(record, stream, chunk) {
    const runtime = record.runtime;
    return new Promise((resolve, reject) => {
      if (runtime.controller.signal.aborted) return reject(cancelError());
      const done = () => { detach(); resolve(); };
      const failed = error => { detach(); reject(error); };
      const abort = () => { detach(); stream.destroy(); reject(cancelError()); };
      const detach = () => {
        stream.off('drain', done);
        stream.off('error', failed);
        stream.off('close', failed);
        runtime.controller.signal.removeEventListener('abort', abort);
      };
      stream.once('drain', done);
      stream.once('error', failed);
      stream.once('close', failed);
      runtime.controller.signal.addEventListener('abort', abort, { once: true });
      // Without backpressure there is no 'drain'; resolve immediately.
      if (stream.write(chunk)) { detach(); resolve(); }
    });
  }
  // A fs.WriteStream that has not opened yet accepts a write() but never
  // emits the 'drain' the caller then waits on. Every staged stream is
  // therefore awaited to its open event before the copy loop starts.
  function awaitOpen(record, stream) {
    if (!stream.pending) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const runtime = record.runtime;
      const ok = () => { detach(); resolve(); };
      const bad = error => { detach(); reject(error); };
      const abort = () => { detach(); reject(cancelError()); };
      const detach = () => {
        stream.off('open', ok);
        stream.off('ready', ok);
        stream.off('error', bad);
        runtime.controller.signal.removeEventListener('abort', abort);
      };
      stream.once('open', ok);
      stream.once('ready', ok);
      stream.once('error', bad);
      runtime.controller.signal.addEventListener('abort', abort, { once: true });
    });
  }
  // 'finish' fires when bytes left the client; the remote handle may still be
  // open, and renaming an open file fails on Windows. 'close' is emitted only
  // after the handle was really released on both sides.
  function ended(record, stream) {
    return new Promise((resolve, reject) => {
      const runtime = record.runtime;
      if (runtime.controller.signal.aborted) return reject(cancelError());
      const done = () => { detach(); resolve(); };
      const failed = error => { detach(); reject(error); };
      const abort = () => { detach(); stream.destroy(); reject(cancelError()); };
      const detach = () => {
        stream.off('close', done);
        stream.off('error', failed);
        runtime.controller.signal.removeEventListener('abort', abort);
      };
      stream.once('close', done);
      stream.once('error', failed);
      runtime.controller.signal.addEventListener('abort', abort, { once: true });
      stream.end();
    });
  }
  function watchStreams(record, streams) {
    const runtime = record.runtime;
    const measure = () => {
      const inFlight = streams.reduce((total, stream) => total + (stream.writableLength || stream.readableLength || 0), 0);
      record.maxInFlight = Math.max(record.maxInFlight, inFlight);
    };
    runtime.sampler = setInterval(measure, 20);
    runtime.sampler.unref?.();
  }
  async function remoteDigest(sftp, file, signal) {
    const stream = sftp.createReadStream(file, { highWaterMark: chunkSize });
    const hash = createHash('sha256'); let size = 0;
    try {
      for await (const chunk of stream) {
        signal.throwIfAborted();
        hash.update(chunk);
        size += chunk.length;
      }
    } catch (error) {
      stream.destroy();
      throw signal.aborted ? cancelError() : error;
    }
    return { size, sha256: hash.digest('hex') };
  }
  function settleFailure(record, error) {
    if (record.runtime?.controller.signal.aborted) return finalize(record, 'canceled', 'Transfer cancelled');
    if (TERMINAL.includes(record.status)) return;
    // fail() messages are host-authored constants, safe to surface verbatim;
    // everything else (OS or protocol noise) is reported generically.
    if (error?.rpc?.message) return finalize(record, 'failed', error.rpc.message);
    const unavailable = error?.code === 2 || error?.code === 'ENOENT';
    finalize(record, 'failed', unavailable ? 'The file is no longer available at this path' : 'The transfer failed; both sides were left unchanged');
  }
  async function runUpload(record, { s, fd, total, temp, target, localPath }) {
    const runtime = record.runtime;
    const sftp = s.sftp;
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(chunkSize);
    let write;
    try {
      // Fast rejection of an obviously occupied destination: the authoritative
      // no-overwrite guarantee is still the rename at publish time.
      let existing = false;
      try { await call(sftp, 'lstat', target); existing = true; } catch (error) { if (error.code !== 2) throw error; }
      if (existing) fail(-32005, 'Remote file already exists; choose a new name');
      record.stage = 'copying';
      write = sftp.createWriteStream(temp, { flags: 'wx', mode: 0o600 });
      watchStreams(record, [write]);
      await awaitOpen(record, write);
      let offset = 0;
      while (offset < total) {
        runtime.controller.signal.throwIfAborted();
        const { bytesRead } = await fd.read(buffer, 0, Math.min(chunkSize, total - offset), offset);
        if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        const next = offset + bytesRead;
        await pump(record, write, chunk);
        // Progress advances only after the chunk was accepted for writing:
        // bytesDone never claims bytes that were not handed to the socket.
        offset = next;
        record.bytesDone = offset;
      }
      // The transfer is bound to the opened descriptor; a local edit or
      // replacement during the run fails the transfer instead of publishing
      // mixed bytes. The size check uses a fresh path stat because an fd's
      // cached metadata may not reflect another writer's append on Windows.
      const finalStat = fs.lstatSync(localPath, { throwIfNoEntry: false });
      if (!finalStat || !finalStat.isFile() || offset !== total || finalStat.size !== total) fail(-32005, 'The local file changed during the transfer');
      record.stage = 'verifying';
      runtime.controller.signal.throwIfAborted();
      await ended(record, write);
      // Re-read the staged remote bytes in bounded chunks and compare hashes
      // before anything the user can see changes.
      const localSha256 = hash.digest('hex');
      const staged = await remoteDigest(sftp, temp, runtime.controller.signal);
      if (staged.size !== total || staged.sha256 !== localSha256) fail(-32005, 'The staged remote file failed verification');
      record.stage = 'publishing';
      existing = false;
      try { await call(sftp, 'lstat', target); existing = true; } catch (error) { if (error.code !== 2) throw error; }
      if (existing) fail(-32005, 'Remote file already exists; choose a new name');
      await call(sftp, 'rename', temp, target);
      record.bytesDone = total;
      finalize(record, 'completed', '', localSha256);
    } catch (error) {
      write?.destroy();
      settleFailure(record, error);
    } finally {
      clearInterval(runtime.sampler);
      try { await fd.close(); } catch { /* already closed */ }
      // Only this transfer's unique temporary name is ever cleaned.
      try { await call(sftp, 'unlink', temp); } catch { /* renamed away or session gone */ }
    }
  }
  async function runDownload(record, { s, destination, temp, total }) {
    const runtime = record.runtime;
    const sftp = s.sftp;
    const hash = createHash('sha256');
    const read = sftp.createReadStream(record.remotePath, { highWaterMark: chunkSize });
    const write = fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 });
    record.stage = 'copying';
    watchStreams(record, [read, write]);
    try {
      await awaitOpen(record, write);
      for await (const chunk of read) {
        runtime.controller.signal.throwIfAborted();
        hash.update(chunk);
        await pump(record, write, chunk);
        record.bytesDone += chunk.length;
      }
      record.stage = 'verifying';
      await ended(record, write);
      if (fs.statSync(temp).size !== total) fail(-32005, 'The remote file changed during the transfer');
      record.stage = 'publishing';
      // No-overwrite publish: link first (atomic, fails if the destination
      // exists), copy-with-EXCL as the portable fallback. The user's file at
      // the same name is never replaced.
      if (fs.existsSync(destination)) fail(-32005, 'Local file already exists; choose a new name');
      try { fs.linkSync(temp, destination); }
      catch (error) {
        if (error.code === 'EEXIST') fail(-32005, 'Local file already exists; choose a new name');
        fs.copyFileSync(temp, destination, fs.constants.COPYFILE_EXCL);
      }
      record.bytesDone = total;
      finalize(record, 'completed', '', hash.digest('hex'));
    } catch (error) {
      read.destroy();
      settleFailure(record, error);
    } finally {
      clearInterval(runtime.sampler);
      read.destroy();
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
    }
  }
  function begin(record) {
    evictFinished();
    let resolve;
    const settled = new Promise(resolvePromise => { resolve = resolvePromise; });
    record.settled = { promise: settled, resolve };
    record.runtime = { controller: new AbortController(), sampler: null };
    record.maxInFlight = 0;
    track(record);
    return record;
  }
  return {
    startUpload({ sessionId, hostId, s, target, localPath }) {
      // Validate synchronously so the caller's snapshot already carries the
      // transfer size and an invalid request never creates a record.
      let stat;
      try { stat = fs.lstatSync(localPath); } catch { fail(-32602, 'Select a local file'); }
      if (!stat.isFile() || stat.isSymbolicLink()) fail(-32602, 'Select a regular local file');
      if (stat.size > maxTransferBytes) fail(-32082, `Transfers support files up to ${Math.floor(maxTransferBytes / (1024 * 1024 * 1024))} GB`);
      const record = begin({ transferId: randomUUID(), sessionId, hostId, direction: 'upload', remotePath: target, localPath,
        name: path.posix.basename(target), bytesTotal: stat.size, bytesDone: 0, status: 'running', stage: 'preparing',
        error: '', sha256: undefined, startedAt: Date.now(), finishedAt: 0 });
      (async () => {
        let fd;
        try {
          fd = await fs.promises.open(localPath, 'r');
          const opened = await fd.stat();
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) fail(-32005, 'Local file changed before the transfer');
          await runUpload(record, { s, fd, total: stat.size, temp: `${target}.knorvia-${record.transferId}.tmp`, target, localPath });
        } catch (error) {
          if (fd !== undefined) { try { await fd.close(); } catch { /* already closed */ } }
          settleFailure(record, error);
        }
      })();
      return publicRecord(record);
    },
    startDownload({ sessionId, hostId, s, target, directory, name, total }) {
      const record = begin({ transferId: randomUUID(), sessionId, hostId, direction: 'download', remotePath: target, localPath: path.join(directory, name),
        name, bytesTotal: total, bytesDone: 0, status: 'running', stage: 'preparing', error: '', sha256: undefined, startedAt: Date.now(), finishedAt: 0 });
      void runDownload(record, { s, destination: path.join(directory, name), temp: path.join(directory, `.knorvia-download-${record.transferId}`), total }).catch(() => {});
      return publicRecord(record);
    },
    list(sessionId) {
      evictFinished();
      return [...(bySession.get(sessionId) ?? [])].map(id => transfers.get(id)).filter(Boolean).map(publicRecord);
    },
    get(sessionId, transferId) {
      const record = transfers.get(transferId);
      if (!record || record.sessionId !== sessionId) fail(-32004, 'Transfer not found');
      return publicRecord(record);
    },
    async cancel(sessionId, transferId) {
      const record = transfers.get(transferId);
      if (!record || record.sessionId !== sessionId) fail(-32004, 'Transfer not found');
      if (TERMINAL.includes(record.status)) return { transfer: publicRecord(record), canceled: false };
      record.runtime.controller.abort();
      await record.settled.promise;
      return { transfer: publicRecord(record), canceled: record.status === 'canceled' };
    },
    // The session lost its transport: every still-running transfer is honestly
    // incomplete ("detached"), its staging cleaned, and the user starts over
    // explicitly. Nothing is reported as finished.
    detachSession(sessionId, message = 'The SSH connection ended before the transfer finished') {
      for (const id of [...(bySession.get(sessionId) ?? [])]) {
        const record = transfers.get(id);
        if (!record || TERMINAL.includes(record.status)) continue;
        record.runtime.controller.abort();
        finalize(record, 'detached', message);
      }
    },
    dispose(message = 'The SSH service is shutting down; transfers did not finish') {
      for (const sessionId of [...bySession.keys()]) this.detachSession(sessionId, message);
    },
  };
}

module.exports = { createSshTransfers, CHUNK_BYTES, MAX_TRANSFER_BYTES };
