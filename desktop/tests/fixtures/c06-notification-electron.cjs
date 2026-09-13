'use strict';

const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createTurnNotifier } = require('../../turn-notifications');
const { createOpenThreadBridge } = require('../../open-thread-bridge');

app.setPath('userData', process.env.KNORVIA_C06_ELECTRON_HOME);
let window, lastBanner, ready = false;
const notificationEvents = [];
class ObservedNotification extends Notification {
  constructor(options) {
    super(options);
    lastBanner = this;
    for (const event of ['show', 'click', 'close', 'failed']) this.on(event, (...args) => {
      notificationEvents.push({ event, at: new Date().toISOString(), detail: args.map(value => typeof value === 'string' ? value : null) });
    });
  }
}
class SyntheticBanner extends EventEmitter {
  constructor(options) { super(); this.options = options; lastBanner = this; }
  static isSupported() { return true; }
  show() {}
}
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1000, height: 780, webPreferences: { preload: path.resolve(__dirname, '../../preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  let activations = 0;
  const bridge = createOpenThreadBridge({
    isShellReady: () => ready,
    deliver: id => window.webContents.send('knorvia:open-thread', id),
    activate: () => { activations++; if (process.env.KNORVIA_C06_OS_CLICK === '1') { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } },
  });
  const notifier = createTurnNotifier({ Notification: process.env.KNORVIA_C06_OS_CLICK === '1' ? ObservedNotification : SyntheticBanner, deliverability: () => true, onClick: id => bridge.open(id) });
  window.webContents.on('did-start-loading', () => { ready = false; });
  window.webContents.on('did-finish-load', () => { ready = true; bridge.flush(); });
  globalThis.c06Electron = {
    send(id) { window.webContents.send('knorvia:open-thread', id); },
    notify(id, turnId) { return notifier.handle({ method: 'turn/event', params: { threadId: id, turnId, status: 'completed' } }); },
    click() { if (process.env.KNORVIA_C06_OS_CLICK === '1' || !lastBanner) throw new Error('Synthetic clicks are disabled in OS verification mode'); lastBanner.emit('click'); },
    setReady(value) { ready = value; },
    flush() { return bridge.flush(); },
    stats() { return { activations, pending: bridge.pending, ready, notificationEvents, visible: window.isVisible(), minimized: window.isMinimized() }; },
  };
  await window.loadFile(process.env.KNORVIA_C06_HTML);
});
app.on('window-all-closed', () => app.quit());
