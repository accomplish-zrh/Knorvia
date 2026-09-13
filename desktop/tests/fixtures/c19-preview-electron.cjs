'use strict';

const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createWorkspaceMediaPreview } = require('../../workspace-media-preview');
const { createWorkspacePreview } = require('../../workspace-preview');

protocol.registerSchemesAsPrivileged([
  { scheme: 'knorvia', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

const evidence = process.env.KNORVIA_C19_EVIDENCE || path.resolve('D:/tools/knorvia-completion-20260912/runtime/G/evidence');
const testHome = path.join(evidence, 'c19-electron-home');
fs.mkdirSync(testHome, { recursive: true });

// Create 68 MB video file
const videoPath = path.join(testHome, 'video-big.mp4');
const vHandle = fs.openSync(videoPath, 'w');
const vHeader = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
fs.writeSync(vHandle, vHeader, 0, vHeader.length, 0);
fs.truncateSync(videoPath, 68 * 1024 * 1024);
const seekMarker = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
fs.writeSync(vHandle, seekMarker, 0, seekMarker.length, 64 * 1024 * 1024);
fs.closeSync(vHandle);

// Create 5.2 MB image file
const imgPath = path.join(testHome, 'image-huge.png');
const imgHandle = fs.openSync(imgPath, 'w');
const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
fs.writeSync(imgHandle, pngHeader, 0, pngHeader.length, 0);
fs.truncateSync(imgPath, Math.floor(5.2 * 1024 * 1024));
fs.closeSync(imgHandle);

// Create small 1 KB image
const smallPath = path.join(testHome, 'image-small.png');
fs.writeFileSync(smallPath, Buffer.concat([pngHeader, Buffer.alloc(1000, 0x55)]));

const mediaPreview = createWorkspaceMediaPreview({});

const preview = createWorkspacePreview({
  rpc: async (method, params) => {
    return {
      workspace: { id: 'ws-electron', cwd: testHome },
      absolutePath: path.join(testHome, params.path),
      kind: 'file',
    };
  },
  mediaPreview,
});

ipcMain.handle('knorvia:preview-read', async (event, params) => {
  return preview['preview/read'](params);
});

ipcMain.handle('knorvia:preview-revoke', async (event, params) => {
  return preview['preview/revoke'](params);
});

// Mock browser gateway HTTP endpoint
const gatewayServer = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method === 'POST' && req.url === '/rpc/preview/read') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const params = JSON.parse(body || '{}');
        const result = await preview['preview/read'](params);
        const resp = JSON.stringify(result);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(resp), ...cors });
        res.end(resp);
      } catch (e) {
        res.writeHead(500, cors);
        res.end(String(e));
      }
    });
    return;
  }
  res.writeHead(404, cors);
  res.end();
});

app.whenReady().then(async () => {
  await new Promise(resolve => gatewayServer.listen(0, '127.0.0.1', resolve));
  const gatewayPort = gatewayServer.address().port;

  protocol.handle('knorvia', (req) => {
    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>C19 Electron Preview Test</title></head>
<body>
  <div id="ready">ELECTRON_READY</div>
  <script>
    window.__GATEWAY_PORT = ${gatewayPort};
  </script>
</body>
</html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  });

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'c19-preview-preload.cjs'),
      contextIsolation: false,
      nodeIntegration: true,
    },
  });

  win.loadURL('knorvia://app/index.html');
});

app.on('will-quit', () => {
  mediaPreview.close();
  gatewayServer.close();
});
