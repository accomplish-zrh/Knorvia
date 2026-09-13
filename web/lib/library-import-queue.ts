import type { LibraryEntry } from './native-library';

/**
 * P05: batch import queue for the personal library. Per-item statuses,
 * bounded concurrency, batch/item cancel that only touches in-flight work,
 * finite retry of failed items, explicit same-name conflict handling, and a
 * restorable snapshot — the browser cannot re-read files it no longer has,
 * so restored-but-unreadable items become "stalled" and demand re-selection
 * instead of pretending an upload is still possible.
 */

export type ImportItemStatus = 'queued' | 'uploading' | 'done' | 'failed' | 'conflict' | 'canceled' | 'stalled';

export type ImportItem = {
  key: string;
  name: string;
  path: string;
  size: number;
  status: ImportItemStatus;
  progress: number;
  attempts: number;
  error?: string;
  uploadId?: string;
};

export type ImportSnapshot = { batchId: string; startedAt: string; items: ImportItem[] };

export type ImportSourceFile = { key: string; name: string; path: string; size: number; handle: unknown };

export type ImportUploaderContext = {
  signal: AbortSignal;
  onProgress: (percent: number) => void;
  onUploadId: (uploadId: string) => void;
  expectedSha256?: string;
};

export type ImportUploader = (file: ImportSourceFile, context: ImportUploaderContext) => Promise<LibraryEntry>;

export const IMPORT_CONCURRENCY = 3;
/** The daemon reports same-name/changed-target conflicts with this code. */
export const RPC_CONFLICT_CODE = -32005;

export function uniqueImportPath(path: string, taken: Set<string>): string {
  if (!taken.has(path)) return path;
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const name = path.slice(dir.length);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${dir}${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

type Runtime = {
  file: ImportSourceFile;
  controller?: AbortController;
  expectedSha256?: string;
};

export class LibraryImportQueue {
  private readonly uploader: ImportUploader;
  private readonly concurrency: number;
  private readonly persist: (snapshot: ImportSnapshot | null) => void;
  private readonly onChange: (queue: LibraryImportQueue) => void;
  private readonly items = new Map<string, ImportItem>();
  private readonly runtimes = new Map<string, Runtime>();
  private readonly finished = new Map<string, LibraryEntry>();
  private readonly batchId: string;
  private readonly startedAt: string;
  private pumping = false;
  private batchCanceled = false;

  constructor(options: {
    uploader: ImportUploader;
    concurrency?: number;
    persist?: (snapshot: ImportSnapshot | null) => void;
    onChange?: (queue: LibraryImportQueue) => void;
    restore?: ImportSnapshot | null;
  }) {
    this.uploader = options.uploader;
    this.concurrency = Math.max(1, options.concurrency ?? IMPORT_CONCURRENCY);
    this.persist = options.persist ?? (() => {});
    this.onChange = options.onChange ?? (() => {});
    const restored = options.restore;
    this.batchId = restored?.batchId ?? `import-${Date.now()}`;
    this.startedAt = restored?.startedAt ?? new Date().toISOString();
    if (restored) {
      for (const item of restored.items) {
        // The browser dropped the File handles: anything not already finished
        // can only be retried after the user re-selects the source files.
        const status: ImportItemStatus = item.status === 'done' ? 'done' : 'stalled';
        this.items.set(item.key, { ...item, status, progress: status === 'done' ? 100 : 0 });
      }
    }
  }

  get snapshot(): ImportSnapshot {
    return { batchId: this.batchId, startedAt: this.startedAt, items: [...this.items.values()] };
  }

  get busy(): boolean {
    return [...this.items.values()].some(item => item.status === 'uploading' || item.status === 'queued');
  }

  list(): ImportItem[] {
    return [...this.items.values()];
  }

  entry(key: string): LibraryEntry | undefined {
    return this.finished.get(key);
  }

  private emit() {
    this.persist(this.snapshot);
    this.onChange(this);
  }

  private update(key: string, patch: Partial<ImportItem>) {
    const item = this.items.get(key);
    if (!item) return;
    this.items.set(key, { ...item, ...patch });
    this.emit();
  }

  enqueue(files: ImportSourceFile[]) {
    if (this.batchCanceled) throw new Error('this import batch was canceled; start a new one');
    for (const file of files) {
      if (this.items.has(file.key)) continue;
      this.items.set(file.key, { ...file, status: 'queued', progress: 0, attempts: 0 });
      this.runtimes.set(file.key, { file });
    }
    this.emit();
    void this.pump();
  }

  /** Re-select source files for stalled items after an offline return. */
  retryStalled(files: ImportSourceFile[]) {
    this.batchCanceled = false;
    for (const file of files) {
      const item = this.items.get(file.key);
      if (!item || item.status !== 'stalled') continue;
      this.items.set(file.key, { ...item, path: file.path, size: file.size, status: 'queued', progress: 0, error: undefined });
      this.runtimes.set(file.key, { file });
    }
    this.emit();
    void this.pump();
  }

  /** Retry one failed/conflict/canceled item; "keep both" passes a new path. */
  async retryItem(key: string, overrides: { path?: string; expectedSha256?: string } = {}) {
    const item = this.items.get(key);
    if (!item) return;
    if (!['failed', 'conflict', 'canceled', 'stalled'].includes(item.status)) return;
    const runtime = this.runtimes.get(key) ?? { file: { key, name: item.name, path: item.path, size: item.size, handle: undefined } };
    this.runtimes.set(key, runtime);
    if (overrides.path) runtime.file = { ...runtime.file, path: overrides.path, size: item.size };
    runtime.expectedSha256 = overrides.expectedSha256;
    this.batchCanceled = false;
    this.update(key, { status: 'queued', progress: 0, error: undefined, path: runtime.file.path });
    await this.pump();
  }

  retryFailed() {
    this.batchCanceled = false;
    for (const item of this.items.values()) {
      if (item.status === 'failed' || item.status === 'conflict') {
        this.items.set(item.key, { ...item, status: 'queued', progress: 0, error: undefined });
      }
    }
    this.emit();
    void this.pump();
  }

  cancelItem(key: string) {
    const item = this.items.get(key);
    if (!item) return;
    if (item.status === 'uploading') this.runtimes.get(key)?.controller?.abort();
    if (item.status === 'queued' || item.status === 'uploading') this.update(key, { status: 'canceled', progress: 0 });
  }

  cancelBatch() {
    this.batchCanceled = true;
    for (const item of [...this.items.values()]) {
      if (item.status === 'uploading') this.runtimes.get(item.key)?.controller?.abort();
      if (item.status === 'queued' || item.status === 'uploading') this.update(item.key, { status: 'canceled', progress: 0 });
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.batchCanceled) {
        const inFlight = [...this.items.values()].filter(item => item.status === 'uploading').length;
        const next = [...this.items.values()].find(item => item.status === 'queued');
        if (!next || inFlight >= this.concurrency) return;
        // run() marks the item synchronously before its first await, so the
        // next loop iteration counts it as in-flight.
        void this.run(next.key);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async run(key: string) {
    const runtime = this.runtimes.get(key);
    const item = this.items.get(key);
    if (!runtime || !item) return;
    const controller = new AbortController();
    runtime.controller = controller;
    this.update(key, { status: 'uploading', attempts: item.attempts + 1, error: undefined });
    try {
      const entry = await this.uploader(runtime.file, {
        signal: controller.signal,
        expectedSha256: runtime.expectedSha256,
        onProgress: percent => {
          if (controller.signal.aborted) return;
          this.update(key, { progress: Math.min(99, percent) });
        },
        onUploadId: uploadId => this.update(key, { uploadId }),
      });
      if (controller.signal.aborted) return; // the cancel path owns the status
      this.finished.set(key, entry);
      this.update(key, { status: 'done', progress: 100, error: undefined });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        this.update(key, { status: 'canceled', progress: 0 });
        return;
      }
      const conflict = (error as { code?: number }).code === RPC_CONFLICT_CODE;
      this.update(key, { status: conflict ? 'conflict' : 'failed', error: error instanceof Error ? error.message : String(error) });
    } finally {
      runtime.controller = undefined;
      void this.pump().catch(() => {});
    }
  }
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError';
}
