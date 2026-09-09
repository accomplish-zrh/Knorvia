import type { CellChange } from './native-office';

export type LibraryDraft = { key: string; scope: string; fileId: string; path: string; baseSha256: string; text?: string; changes: Record<string, string>; cells: CellChange[]; updatedAt: number };
let database: Promise<IDBDatabase> | undefined;
let memoryOwner: string | undefined;
export function draftOwner() {
  try { const key = 'knorvia-library-draft-owner'; const owner = sessionStorage.getItem(key) || crypto.randomUUID(); sessionStorage.setItem(key, owner); return owner; }
  catch { return memoryOwner ??= crypto.randomUUID(); }
}
export const draftKey = (scope: string, fileId: string) => JSON.stringify([scope, fileId, draftOwner()]);
function open() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('knorvia-personal-library-drafts-v1', 1);
    request.onupgradeneeded = () => { const store = request.result.createObjectStore('drafts', { keyPath: 'key' }); store.createIndex('file', ['scope', 'fileId']); };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
    request.onerror = () => { database = undefined; reject(request.error ?? new Error('Draft storage unavailable')); };
    request.onblocked = () => { database = undefined; reject(new Error('Draft storage is busy')); };
  });
  return database;
}

export async function readLibraryDraft(scope: string, fileId: string): Promise<LibraryDraft | undefined> {
  await writes.get(draftKey(scope, fileId))?.catch(() => {});
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction('drafts').objectStore('drafts').index('file').getAll([scope, fileId]);
    request.onsuccess = () => { const drafts = (request.result as LibraryDraft[]).filter(item => /^[0-9a-f]{64}$/.test(item.baseSha256) && typeof item.updatedAt === 'number' && Array.isArray(item.cells) && item.changes && typeof item.changes === 'object'); resolve(drafts.find(item => item.key === draftKey(scope, fileId)) ?? drafts.sort((a, b) => b.updatedAt - a.updatedAt)[0]); };
    request.onerror = () => reject(request.error);
  });
}

const writes = new Map<string, Promise<void>>();
function serialize(key: string, operation: () => Promise<void>) {
  const next = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  writes.set(key, next);
  void next.finally(() => { if (writes.get(key) === next) writes.delete(key); }).catch(() => {});
  return next;
}

export function keepLibraryDraft(draft: LibraryDraft) {
  return serialize(draft.key, async () => {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite'); transaction.objectStore('drafts').put(draft);
      transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Draft could not be saved'));
    });
  });
}

/** Discard only this window's draft and an unchanged copy that it recovered. */
export function clearLibraryDraft(scope: string, fileId: string, recovered?: LibraryDraft) {
  const ownKey = draftKey(scope, fileId);
  return serialize(ownKey, async () => {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite'), store = transaction.objectStore('drafts');
      store.delete(ownKey);
      if (recovered && recovered.key !== ownKey) { const request = store.get(recovered.key); request.onsuccess = () => { if (request.result?.updatedAt === recovered.updatedAt) store.delete(recovered.key); }; }
      transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  });
}
