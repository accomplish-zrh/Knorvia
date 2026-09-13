/** A cancelled IPC request still owns its slot until the transport settles. */
export class MediaReadPool {
  private active = 0;
  private pending: Array<() => void> = [];

  constructor(private readonly limit = 2) {}

  async run<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener('abort', cancel);
        this.active += 1;
        resolve();
      };
      const cancel = () => {
        this.pending = this.pending.filter(item => item !== start);
        reject(signal.reason);
      };
      if (this.active < this.limit) start();
      else {
        this.pending.push(start);
        signal.addEventListener('abort', cancel, { once: true });
      }
    });
    try { signal.throwIfAborted(); return await read(); }
    finally { this.active -= 1; this.pending.shift()?.(); }
  }
}

// Shared across reader remounts: switching artifacts cannot bypass the bound.
export const mediaReadPool = new MediaReadPool();
