"use strict";

const DIRECT_FILE_PATHS = [
  /^\/api\/v1\/(?:image-studio|video-studio)\/assets\/[^/?]+\/content$/,
  /^\/api\/v1\/(?:image-studio|video-studio)\/projects\/[^/?]+\/export$/,
];

function isDesktopDirectFilePath(pathname) {
  const value = String(pathname || "");
  return DIRECT_FILE_PATHS.some((pattern) => pattern.test(value));
}

class DesktopAssetStreamBroker {
  constructor(send, { startTimeoutMs = 30_000, idleTimeoutMs = 30_000 } = {}) {
    this.send = send;
    this.startTimeoutMs = startTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.sequence = 0;
    this.pending = new Map();
  }

  open(request, path) {
    const id = `stream-${++this.sequence}`;
    if (request.signal?.aborted) {
      return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
    }
    let controller;
    let responseStarted = false;
    let abortListener;
    const stream = new ReadableStream({
      start(value) {
        controller = value;
      },
      cancel: () => {
        this.send({ kind: "http_stream_cancel", id });
        this.#finish(id);
      },
      pull: () => this.#pull(id),
    });

    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.send({ kind: "http_stream_cancel", id });
        this.#fail(id, new Error("Desktop media stream did not start in time"));
      }, this.startTimeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        controller,
        method: request.method,
        resolve,
        reject,
        timer,
        request,
        get responseStarted() {
          return responseStarted;
        },
        set responseStarted(value) {
          responseStarted = value;
        },
        get abortListener() {
          return abortListener;
        },
        set abortListener(value) {
          abortListener = value;
        },
        stream,
        pendingChunk: null,
        unackedEnqueued: false,
        ended: false,
      });
    });

    abortListener = () => {
      this.send({ kind: "http_stream_cancel", id });
      const error = new DOMException("The operation was aborted", "AbortError");
      this.#fail(id, error);
    };
    request.signal?.addEventListener("abort", abortListener, { once: true });
    if (
      !this.send({
        kind: "http_stream",
        id,
        method: request.method,
        path,
        headers: Object.fromEntries(request.headers.entries()),
      })
    ) {
      this.#fail(id, new Error("Knorvia engine is not ready"));
    }
    return response;
  }

  handle(message) {
    const entry = this.pending.get(String(message?.id || ""));
    if (!entry) return false;
    if (message.kind === "http_stream_start") {
      this.#armIdleTimer(message.id, entry);
      entry.responseStarted = true;
      entry.resolve(
        new Response(entry.method === "HEAD" ? null : entry.stream, {
          status: Number(message.status) || 500,
          headers: message.headers || {},
        }),
      );
      return true;
    }
    if (message.kind === "http_stream_chunk") {
      if (!entry.responseStarted) {
        this.#fail(message.id, new Error("Desktop media stream sent data before headers"));
        return true;
      }
      this.#armIdleTimer(message.id, entry);
      const chunk = Buffer.from(String(message.body || ""), "base64");
      if (!entry.unackedEnqueued && entry.controller.desiredSize > 0) {
        entry.controller.enqueue(chunk);
        entry.unackedEnqueued = true;
      } else if (entry.pendingChunk === null) {
        entry.pendingChunk = chunk;
      } else {
        this.send({ kind: "http_stream_cancel", id: message.id });
        this.#fail(message.id, new Error("Desktop media stream exceeded its flow-control window"));
      }
      return true;
    }
    if (message.kind === "http_stream_end") {
      if (!entry.responseStarted) {
        this.#fail(message.id, new Error("Desktop media stream ended before headers"));
      } else {
        entry.ended = true;
        if (entry.pendingChunk === null) {
          entry.controller.close();
          this.#finish(message.id);
        }
      }
      return true;
    }
    if (message.kind === "http_stream_error" || message.kind === "error") {
      this.#fail(message.id, new Error(message.error || "Desktop media stream failed"));
      return true;
    }
    return false;
  }

  failAll(error) {
    for (const id of [...this.pending.keys()]) {
      this.send({ kind: "http_stream_cancel", id });
      this.#fail(id, error);
    }
  }

  #pull(id) {
    const entry = this.pending.get(String(id));
    if (!entry) return;
    if (entry.unackedEnqueued) {
      entry.unackedEnqueued = false;
      if (!this.send({ kind: "http_stream_ack", id })) {
        this.#fail(id, new Error("Knorvia engine is not ready"));
        return;
      }
    }
    if (entry.pendingChunk !== null) {
      const chunk = entry.pendingChunk;
      entry.pendingChunk = null;
      entry.controller.enqueue(chunk);
      entry.unackedEnqueued = true;
    }
    if (entry.ended && entry.pendingChunk === null) {
      entry.controller.close();
      this.#finish(id);
    }
  }

  #armIdleTimer(id, entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this.send({ kind: "http_stream_cancel", id });
      this.#fail(id, new Error("Desktop media stream became idle"));
    }, this.idleTimeoutMs);
    entry.timer.unref?.();
  }

  #finish(id) {
    const entry = this.pending.get(String(id));
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.abortListener) {
      entry.request.signal?.removeEventListener("abort", entry.abortListener);
    }
    this.pending.delete(String(id));
  }

  #fail(id, error) {
    const entry = this.pending.get(String(id));
    if (!entry) return;
    if (entry.responseStarted) entry.controller.error(error);
    else entry.reject(error);
    this.#finish(id);
  }
}

module.exports = {
  DesktopAssetStreamBroker,
  isDesktopAssetContentPath: isDesktopDirectFilePath,
  isDesktopDirectFilePath,
};
