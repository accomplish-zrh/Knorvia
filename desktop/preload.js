const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Map();
const nativeNotificationListeners = new Set();

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
  },
});
