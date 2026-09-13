const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Map();
const nativeNotificationListeners = new Set();
// C06: OS notification click-through. The renderer subscribes through this
// bounded bridge; duplicate subscriptions collapse into one set entry per
// callback and every unsubscribe removes exactly its own listener.
const openThreadListeners = new Set();
let pendingOpenThread = null;
let openThreadFlushQueued = false;
function flushPendingOpenThread() {
  if (openThreadFlushQueued || pendingOpenThread === null || openThreadListeners.size === 0) return;
  openThreadFlushQueued = true;
  queueMicrotask(() => {
    openThreadFlushQueued = false;
    // React may unmount a subscriber before this microtask. Keep the click
    // pending for the next mounted shell instead of invoking a stale callback.
    if (pendingOpenThread === null || openThreadListeners.size === 0) return;
    const queued = pendingOpenThread;
    pendingOpenThread = null;
    for (const listener of [...openThreadListeners]) {
      if (openThreadListeners.has(listener)) {
        try { listener(queued); } catch {}
      }
    }
  });
}
ipcRenderer.on("knorvia:open-thread", (_event, threadId) => {
  if (openThreadListeners.size === 0) {
    pendingOpenThread = threadId;
    return;
  }
  // A newer live click supersedes any older click awaiting a mount flush.
  pendingOpenThread = null;
  for (const listener of [...openThreadListeners]) {
    if (openThreadListeners.has(listener)) {
      try { listener(threadId); } catch {}
    }
  }
});
ipcRenderer.on("knorvia:native-notification", (_event, notification) => {
  for (const listener of nativeNotificationListeners) {
    try { listener(notification); } catch {}
  }
});

contextBridge.exposeInMainWorld("knorviaDesktop", {
  fetch: (request) => ipcRenderer.invoke("knorvia:fetch", request),
  native: {
    // This is intentionally JSON-RPC envelope in/envelope out. The renderer
    // cannot select a child process or invoke an arbitrary daemon method.
    request: (message) => ipcRenderer.invoke("knorvia:native-request", message),
    onNotification: (callback) => {
      if (typeof callback !== "function") throw new Error("Native notification listener must be a function");
      nativeNotificationListeners.add(callback);
      return () => nativeNotificationListeners.delete(callback);
    },
  },
  notifications: {
    onOpenThread: (callback) => {
      if (typeof callback !== "function") throw new Error("Open-thread listener must be a function");
      openThreadListeners.add(callback);
      flushPendingOpenThread();
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        openThreadListeners.delete(callback);
      };
    },
  },
  migration: {
    retry: () => ipcRenderer.invoke("knorvia:migration-retry"),
    openLegacy: () => ipcRenderer.send("knorvia:migration-open-legacy"),
    exit: () => ipcRenderer.send("knorvia:migration-exit"),
  },
  wsOpen: (id, path) => ipcRenderer.send("knorvia:ws-open", { id, path }),
  wsSend: (id, data) => ipcRenderer.send("knorvia:ws-send", { id, data }),
  wsClose: (id) => ipcRenderer.send("knorvia:ws-close", { id }),
  onWsEvent: (id, callback) => {
    const channel = `knorvia:ws-event:${id}`;
    const listener = (_event, payload) => callback(payload);
    listeners.set(channel, listener);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
      listeners.delete(channel);
    };
  },
  chrome: {
    platform: process.platform,
    backdropSupported: process.argv.includes("--knorvia-backdrop-supported=true"),
    captionOverlay: process.platform === "win32",
    trafficLights: process.platform === "darwin",
    setTitleBarOverlay: (overlay) => ipcRenderer.send("knorvia:titlebar-overlay", overlay),
    setWindowMaterial: (payload) => ipcRenderer.send("knorvia:window-material", payload),
    windowMinimize: () => ipcRenderer.send("knorvia:window-minimize"),
    windowMaximize: () => ipcRenderer.send("knorvia:window-maximize"),
    windowClose: () => ipcRenderer.send("knorvia:window-close"),
    windowIsMaximized: () => ipcRenderer.invoke("knorvia:window-is-maximized"),
    onWindowState: (callback) => {
      const channel = "knorvia:window-state";
      const listener = (_event, payload) => callback(payload);
      listeners.set(channel, listener);
      ipcRenderer.on(channel, listener);
      return () => {
        ipcRenderer.removeListener(channel, listener);
        listeners.delete(channel);
      };
    },
  },
  wallpaper: {
    getState: () => ipcRenderer.invoke("knorvia:wallpaper-state"),
    setBuiltin: (id) => ipcRenderer.invoke("knorvia:wallpaper-set", id),
    importCustom: () => ipcRenderer.invoke("knorvia:wallpaper-import"),
    clear: () => ipcRenderer.invoke("knorvia:wallpaper-clear"),
  },
  update: {
    check: () => ipcRenderer.invoke("knorvia:update-check"),
    startDownload: (params) => ipcRenderer.invoke("knorvia:update-download-start", params),
    downloadStatus: () => ipcRenderer.invoke("knorvia:update-download-status"),
    cancelDownload: () => ipcRenderer.invoke("knorvia:update-download-cancel"),
    openDownload: () => ipcRenderer.invoke("knorvia:update-download-open"),
    chooseDownloadDir: () => ipcRenderer.invoke("knorvia:update-download-choose-dir"),
  },
});
