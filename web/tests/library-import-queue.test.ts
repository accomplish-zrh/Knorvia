/** P05: import queue behavior — concurrency, cancel, retry, conflict, restore. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LibraryImportQueue,
  uniqueImportPath,
  type ImportSourceFile,
  type ImportSnapshot,
  type ImportUploaderContext,
} from '@/lib/library-import-queue';
import type { LibraryEntry } from '@/lib/native-library';

function files(count: number, size = 10): ImportSourceFile[] {
  return Array.from({ length: count }, (_, i) => ({ key: `k${i}`, name: `f${i}.txt`, path: `f${i}.txt`, size, handle: { blob: `data-${i}` } }));
}

const entry = (key: string): LibraryEntry => ({ id: `entry-${key}`, path: key, name: key, sha256: 'x', size: 1, modifiedAt: '', versions: 1 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

test('runs at most three uploads concurrently and completes all items', async () => {
  let inFlight = 0;
  let peak = 0;
  const queue = new LibraryImportQueue({
    uploader: async (file, context) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      context.onProgress(100);
      return entry(file.key);
    },
  });
  queue.enqueue(files(10));
  await waitFor(() => !queue.busy);
  assert.equal(peak, 3, 'bounded concurrency');
  assert.deepEqual(queue.list().map(item => item.status), Array.from({ length: 10 }, () => 'done'));
});

test('cancelling an item aborts only that upload and keeps finished work', async () => {
  const aborted: string[] = [];
  const queue = new LibraryImportQueue({
    uploader: async (file, context) => {
      context.signal.addEventListener('abort', () => aborted.push(file.key));
      if (file.key === 'k0') return entry(file.key);
      await new Promise(resolve => setTimeout(resolve, 50));
      return entry(file.key);
    },
  });
  queue.enqueue(files(5));
  await waitFor(() => queue.list().filter(item => item.status === 'done').length >= 1);
  const uploading = queue.list().find(item => item.status === 'uploading');
  assert.ok(uploading, 'an item is uploading');
  queue.cancelItem(uploading.key);
  await waitFor(() => !queue.busy);
  assert.ok(aborted.includes(uploading.key), 'abort signal reached the in-flight upload');
  assert.equal(queue.list().find(item => item.key === uploading.key)?.status, 'canceled');
  assert.equal(queue.list().find(item => item.key === 'k0')?.status, 'done', 'finished item untouched');
});

test('batch cancel stops pending items and aborts in-flight uploads', async () => {
  const started = new Set<string>();
  const queue = new LibraryImportQueue({
    uploader: async (file, context) => {
      started.add(file.key);
      await new Promise(resolve => setTimeout(resolve, 30));
      if (context.signal.aborted) throw new DOMException('aborted', 'AbortError');
      return entry(file.key);
    },
  });
  queue.enqueue(files(6));
  await waitFor(() => started.size >= 3);
  queue.cancelBatch();
  await waitFor(() => !queue.busy);
  const statuses = Object.fromEntries(queue.list().map(item => [item.key, item.status]));
  for (const key of ['k0', 'k1', 'k2']) assert.equal(statuses[key], 'canceled', `in-flight ${key} aborted, not published`);
  for (const key of ['k3', 'k4', 'k5']) assert.equal(statuses[key], 'canceled', `queued ${key} never started`);
  assert.ok(queue.list().every(item => item.status !== 'uploading'), 'nothing left uploading');
  assert.throws(() => queue.enqueue(files(1)), /canceled/, 'a canceled batch cannot silently continue');
});

test('failed items retry to success without duplicating entries', async () => {
  const failures = new Map<string, number>();
  const uploads: string[] = [];
  const queue = new LibraryImportQueue({
    uploader: async file => {
      uploads.push(file.key);
      const count = (failures.get(file.key) ?? 0) + 1;
      failures.set(file.key, count);
      if (file.key === 'k1' && count === 1) throw new Error('network dropped');
      return entry(file.key);
    },
  });
  queue.enqueue(files(4));
  await waitFor(() => !queue.busy);
  assert.equal(queue.list().find(item => item.key === 'k1')?.status, 'failed');
  await queue.retryItem('k1');
  await waitFor(() => !queue.busy);
  assert.equal(queue.list().find(item => item.key === 'k1')?.status, 'done');
  const done = queue.list().filter(item => item.status === 'done');
  assert.equal(done.length, 4, 'all four succeed exactly once');
  assert.equal(new Set(uploads).size, uploads.length - 1, 'only the failed item re-uploaded once');
});

test('conflicts are distinct and "keep both" retries under a fresh path', async () => {
  const uploadedPaths: string[] = [];
  const queue = new LibraryImportQueue({
    uploader: async file => {
      uploadedPaths.push(file.path);
      if (uploadedPaths.length === 1) throw conflictError('同名资料已存在');
      return entry(file.key);
    },
  });
  queue.enqueue(files(1));
  await waitFor(() => !queue.busy);
  assert.equal(queue.list()[0].status, 'conflict');
  const fresh = uniqueImportPath('notes.md', new Set(['notes.md']));
  assert.equal(fresh, 'notes (2).md');
  await queue.retryItem('k0', { path: 'notes (2).md' });
  await waitFor(() => !queue.busy);
  assert.equal(queue.list()[0].status, 'done');
  assert.deepEqual(uploadedPaths, ['f0.txt', 'notes (2).md']);
});

test('restored snapshots mark unfinished items stalled until files are re-selected', async () => {
  const snapshot: ImportSnapshot = {
    batchId: 'import-1',
    startedAt: new Date().toISOString(),
    items: [
      { key: 'k0', name: 'a.txt', path: 'a.txt', size: 1, status: 'done', progress: 100, attempts: 1 },
      { key: 'k1', name: 'b.txt', path: 'b.txt', size: 1, status: 'uploading', progress: 40, attempts: 1 },
      { key: 'k2', name: 'c.txt', path: 'c.txt', size: 1, status: 'queued', progress: 0, attempts: 0 },
    ],
  };
  const queue = new LibraryImportQueue({ uploader: async file => entry(file.key), restore: snapshot });
  assert.deepEqual(queue.list().map(item => item.status), ['done', 'stalled', 'stalled']);
  // Without re-selection nothing runs.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(queue.list().map(item => item.status), ['done', 'stalled', 'stalled']);
  queue.retryStalled([{ key: 'k1', name: 'b.txt', path: 'b.txt', size: 1, handle: { blob: 'b' } }]);
  await waitFor(() => !queue.busy);
  assert.equal(queue.list().find(item => item.key === 'k1')?.status, 'done');
  assert.equal(queue.list().find(item => item.key === 'k2')?.status, 'stalled', 'unre-selected item stays stalled');
});

test('persisted snapshots track every transition', async () => {
  const snapshots: ImportSnapshot[] = [];
  const queue = new LibraryImportQueue({
    uploader: async file => entry(file.key),
    persist: snapshot => { if (snapshot) snapshots.push(snapshot); },
  });
  queue.enqueue(files(2));
  await waitFor(() => !queue.busy);
  const last = snapshots.at(-1);
  assert.ok(last);
  assert.deepEqual(last.items.map(item => item.status), ['done', 'done']);
});

test('zero-byte and duplicate-name items queue with distinct keys', () => {
  const queue = new LibraryImportQueue({ uploader: async file => entry(file.key) });
  queue.enqueue([
    { key: 'a', name: 'empty.txt', path: 'empty.txt', size: 0, handle: { blob: '' } },
    { key: 'b', name: 'empty.txt', path: 'sub/empty.txt', size: 0, handle: { blob: '' } },
  ]);
  assert.equal(queue.list().length, 2);
  assert.equal(uniqueImportPath('sub/empty.txt', new Set(['sub/empty.txt', 'sub/empty (2).txt'])), 'sub/empty (3).txt');
});

function conflictError(message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code: -32005 });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// Keep the context type referenced so the uploader signatures stay checked.
type _Uploader = (file: ImportSourceFile, context: ImportUploaderContext) => Promise<LibraryEntry>;
const _check: null extends never ? _Uploader | null : null = null;
void _check;
