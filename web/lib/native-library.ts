export type LibraryEntry = { id: string; path: string; name: string; sha256: string; size: number; modifiedAt: string; accessedAt?: string; trashedAt?: string | null; folder?: boolean; parentTrash?: string; versions: number };
export type LibraryIndex = { entries: LibraryEntry[]; folders: string[]; limited: boolean };
export type LibraryVersion = { sha256: string; size: number; at: string };
export type LibraryRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
export type LibraryKind = 'text' | 'docx' | 'xlsx' | 'pptx' | 'image' | 'pdf' | 'audio' | 'video' | 'other';
export const MAX_OFFICE_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export function libraryKind(name: string): LibraryKind {
  const ext = name.split('.').at(-1)?.toLowerCase() ?? '';
  if (['docx', 'xlsx', 'pptx', 'pdf'].includes(ext)) return ext as LibraryKind;
  if (/^(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/.test(ext)) return 'image';
  if (/^(mp3|wav|ogg|m4a|flac|aac)$/.test(ext)) return 'audio';
  if (/^(mp4|webm|mov|ogv)$/.test(ext)) return 'video';
  if (/^(txt|md|mdx|markdown|csv|tsv|html?|json|jsonl|xml|ya?ml|toml|ini|log|css|scss|js|jsx|ts|tsx|py|rs|go|java|c|cpp|h|sh|ps1|sql|r|tex|env)$/.test(ext) || !name.includes('.')) return 'text';
  return 'other';
}
export function libraryMime(name: string) {
  const ext = name.split('.').at(-1)?.toLowerCase() ?? '';
  return ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', html: 'text/html', htm: 'text/html', md: 'text/markdown', txt: 'text/plain' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}
const base64 = (bytes: Uint8Array) => { let raw = ''; for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(raw); };
export async function readLibraryFile(request: LibraryRequest, entry: LibraryEntry, version?: string, signal?: AbortSignal) {
  let offset = 0; let revision = version; let bytes: Uint8Array<ArrayBuffer> | undefined;
  do {
    signal?.throwIfAborted();
    const part = await request<{ entry: LibraryEntry; size: number; sha256: string; base64: string; nextOffset: number | null }>('library/read', { id: entry.id, offset, ...(revision ? { version: revision } : {}) });
    signal?.throwIfAborted(); revision ??= part.sha256;
    if (!bytes) { if (part.size > 256 * 1024 * 1024) throw new Error('文件超过 256 MB'); bytes = new Uint8Array(part.size); }
    const decoded = Uint8Array.from(atob(part.base64), char => char.charCodeAt(0)); bytes.set(decoded, offset);
    if (part.nextOffset === null) return { bytes, entry: part.entry, sha256: revision };
    if (part.nextOffset <= offset) throw new Error('资料读取未继续'); offset = part.nextOffset;
  } while (true);
}
export async function saveLibraryFile(request: LibraryRequest, path: string, file: Blob | Uint8Array, expectedSha256?: string, progress?: (percent: number) => void, options?: { signal?: AbortSignal; onUploadId?: (uploadId: string) => void }) {
  const signal = options?.signal;
  const size = file instanceof Blob ? file.size : file.byteLength;
  const upload = await request<{ id: string; chunkBytes: number }>('library/upload/start', { path, size, ...(expectedSha256 === undefined ? {} : { expectedSha256 }) });
  options?.onUploadId?.(upload.id);
  try {
    for (let offset = 0; offset < size; offset += upload.chunkBytes) {
      signal?.throwIfAborted();
      const bytes = file instanceof Blob ? new Uint8Array(await file.slice(offset, offset + upload.chunkBytes).arrayBuffer()) : file.subarray(offset, offset + upload.chunkBytes);
      await request('library/upload/chunk', { id: upload.id, offset, base64: base64(bytes) }); progress?.(Math.round(Math.min(size, offset + bytes.length) / size * 95));
    }
    signal?.throwIfAborted();
    const result = await request<LibraryEntry>('library/upload/finish', { id: upload.id }); progress?.(100); return result;
  } catch (error) {
    // A finished upload must not be undone: the daemon refuses to cancel an
    // uploaded record, and canceling only removes this upload's part file.
    await request('library/upload/cancel', { id: upload.id }).catch(() => {});
    throw error;
  }
}
export function downloadLibraryBytes(name: string, bytes: Uint8Array<ArrayBuffer>) {
  const url = URL.createObjectURL(new Blob([bytes], { type: libraryMime(name) }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
