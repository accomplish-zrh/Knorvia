/** A device preference, separate from the agent's files and conversation data.
 * Only one normalized image is retained; replacing it is one atomic transaction. */
export const BACKGROUND_KEY = 'knorvia-background-v1';
export const BACKGROUND_EVENT = 'knorvia-background-image-v1';
export const BACKGROUND_LIMIT = 20 * 1024 * 1024;
export type BackgroundPreference = { enabled: boolean; transparency: number; blur: number; fit: 'cover' | 'contain' };
export type BackgroundImage = { revision: string; blob: Blob; name: string; width: number; height: number };

export function backgroundPreference(raw: string): BackgroundPreference {
  let value: Partial<BackgroundPreference> = {};
  try { value = JSON.parse(raw) ?? {}; } catch { /* Default for a new device. */ }
  const clamp = (n: unknown, max: number, fallback: number) => typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : fallback;
  return { enabled: value.enabled !== false, transparency: clamp(value.transparency, 100, 72), blur: clamp(value.blur, 24, 6), fit: value.fit === 'contain' ? 'contain' : 'cover' };
}

export class BackgroundError extends Error {
  constructor(public code: 'format' | 'size' | 'decode' | 'dimensions' | 'storage') { super(code); }
}

/** Decode and downsample once, not on every animation frame or route change. */
export async function prepareBackground(file: File): Promise<BackgroundImage> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new BackgroundError('format');
  if (!file.size || file.size > BACKGROUND_LIMIT) throw new BackgroundError('size');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new BackgroundError('decode'); }
  try {
    if (bitmap.width * bitmap.height > 48_000_000) throw new BackgroundError('dimensions');
    const ratio = Math.min(1, 3200 / Math.max(bitmap.width, bitmap.height), Math.sqrt(8_000_000 / (bitmap.width * bitmap.height)));
    const width = Math.max(1, Math.round(bitmap.width * ratio)), height = Math.max(1, Math.round(bitmap.height * ratio));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new BackgroundError('decode');
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: .9 });
    return { revision: crypto.randomUUID(), blob, name: file.name.slice(0, 240), width, height };
  } catch (error) { throw error instanceof BackgroundError ? error : new BackgroundError('decode'); }
  finally { bitmap.close(); }
}

async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('knorvia-appearance-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('background');
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = request.onblocked = () => reject(new BackgroundError('storage'));
  });
}

export async function readBackground(): Promise<BackgroundImage | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('background').objectStore('background').get('image');
      request.onsuccess = () => {
        const value = request.result as BackgroundImage | undefined;
        resolve(value?.blob instanceof Blob && typeof value.revision === 'string' && typeof value.name === 'string' ? value : null);
      };
      request.onerror = () => reject(new BackgroundError('storage'));
    });
  } catch { throw new BackgroundError('storage'); }
  finally { db.close(); }
}

export async function writeBackground(image: BackgroundImage | null) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('background', 'readwrite'), store = transaction.objectStore('background');
      if (image) store.put(image, 'image'); else store.delete('image');
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new BackgroundError('storage'));
    });
  } catch { throw new BackgroundError('storage'); }
  finally { db.close(); }
}
