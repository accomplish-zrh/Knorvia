const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Map();

contextBridge.exposeInMainWorld("knorviaDesktop", {
  fetch: (request) => ipcRenderer.invoke("knorvia:fetch", request),
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
});
