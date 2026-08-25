const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Map();

contextBridge.exposeInMainWorld("knorviaDesktop", {
  translucencySupport: () =>
    ipcRenderer.sendSync("knorvia:translucency:support"),
  setTranslucency: (state) =>
    ipcRenderer.send("knorvia:translucency:set", state),
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
});
