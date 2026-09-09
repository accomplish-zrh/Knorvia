'use strict';

// Night-shift Chrome audit stack: one isolated gateway (real daemon behind
// the native gateway with the studio media worker wired in), a loopback
// image-generation fixture, and the Next dev server bridged to the gateway.
// Manual QA launcher for web/tests/native-studio.audit.ts. No paid service.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { startNativeGatewayFixture } = require('./start-native-gateway-fixture');

// A real 1x1 PNG so the browser preview renders a decodable image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function generateVideoFixture(target) {
  // A tiny but real, decodable mp4 (H.264 color pattern) for the video
  // journey; ffmpeg is only used for this local test asset.
  const ffmpeg = `${process.env.USERPROFILE || process.env.HOME}\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe`;
  if (!fs.existsSync(ffmpeg)) throw new Error('ffmpeg fixture asset missing');
  const { execFileSync } = require('node:child_process');
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=0.4', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', target], { stdio: 'ignore', windowsHide: true, timeout: 60_000 });
  return fs.readFileSync(target);
}

function startMediaFixture(root) {
  let submits = 0; const receipts = [];
  const videoHits = { submit: 0, status: 0, cancel: 0, file: 0 };
  const pendingStatus = [];
  const mp4 = generateVideoFixture(path.join(root, 'fixture-video.mp4'));
  const server = http.createServer((req, res) => {
    if (req.url === '/__night/requests') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(receipts)); return; }
    if (req.method === 'POST' && (req.url === '/v1/images/generations' || req.url === '/v1/images/edits')) {
      submits += 1;
      const chunks = []; req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        if (String(req.headers['content-type']).includes('multipart')) {
          const form = await new Request('http://127.0.0.1/input', { method: 'POST', headers: req.headers, body }).formData();
          const fields = [];
          for (const [name, value] of form) fields.push(typeof value === 'string' ? { name, value } : { name, filename: value.name, base64: Buffer.from(await value.arrayBuffer()).toString('base64') });
          receipts.push({ url: req.url, fields });
        } else receipts.push({ url: req.url, body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
      });
      return;
    }
    // fal-style video queue: submit → status (held until released) → result.
    if (req.method === 'POST' && req.url === '/fal-ai/fixture/video') {
      videoHits.submit += 1;
      const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
        receipts.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks)) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ request_id: `r-${videoHits.submit}`, status: 'IN_PROGRESS', status_url: '/queue/r/status', response_url: '/queue/r/result', cancel_url: '/queue/r/cancel' }));
      });
      return;
    }
    if (req.method === 'PUT' && req.url === '/queue/r/cancel') {
      videoHits.cancel += 1;
      res.writeHead(200); res.end();
      return;
    }
    if (req.url === '/queue/r/status') {
      videoHits.status += 1;
      res.on('error', () => {});
      pendingStatus.push(res);
      return;
    }
    // Audit-only control hook: release the held video status polls.
    if (req.url === '/__night/release-video') {
      const released = pendingStatus.length;
      while (pendingStatus.length) {
        const pending = pendingStatus.shift();
        if (!pending.destroyed && !pending.writableEnded) {
          pending.writeHead(200, { 'content-type': 'application/json' });
          pending.end(JSON.stringify({ status: 'COMPLETED' }));
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ released }));
      return;
    }
    if (req.url === '/queue/r/result') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ video: { url: `http://127.0.0.1:${server.address().port}/fixture.mp4` } }));
      return;
    }
    if (req.url === '/fixture.mp4') {
      videoHits.file += 1;
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(mp4.length) });
      res.end(mp4);
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, '127.0.0.1');
  return {
    get submits() { return submits; },
    get videoHits() { return videoHits; },
    releaseVideoStatus() { while (pendingStatus.length) { const res = pendingStatus.shift(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'COMPLETED' })); } },
    originReady: new Promise(resolve => server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => { server.close(); server.closeAllConnections(); },
  };
}

async function waitForHttp(url, what, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch { /* not ready yet */ }
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  throw new Error(`${what} never became ready at ${url}`);
}

async function main() {
  const root = process.env.KNORVIA_NIGHT_EVIDENCE_ROOT
    || path.join(process.env.USERPROFILE || process.env.HOME, 'Knorvia-deliveries', 'nightshift-20260906-2300');
  const home = process.env.KNORVIA_ACCEPT_HOME || path.join(root, 'studio-audit-home', 'isolated-home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(home, 'workspace'), { recursive: true });

  const media = startMediaFixture(root);
  const imageOrigin = await media.originReady;

  const gatewayPort = Number(process.env.KNORVIA_NIGHT_GATEWAY_PORT || 4331);
  const webPort = Number(process.env.KNORVIA_NIGHT_WEB_PORT || 4330);
  const fixture = await startNativeGatewayFixture({ home, host: '127.0.0.1', port: gatewayPort });
  process.stderr.write(`[night-stack] gateway ${fixture.location.url}\n`);

  const packaged = process.env.KNORVIA_ACCEPT_WEB_ROOT;
  const web = spawn(process.execPath, packaged ? [path.join(packaged, 'server.js')] : ['./node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(webPort)], {
    cwd: packaged || path.resolve(__dirname, '../../../web'),
    env: { ...process.env, PORT: String(webPort), HOSTNAME: '127.0.0.1', KNORVIA_NATIVE_GATEWAY_URL: fixture.location.url },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let webLog = '';
  web.stdout.on('data', chunk => { webLog += chunk; process.stderr.write(`[next] ${chunk}`); });
  web.stderr.on('data', chunk => { webLog += chunk; process.stderr.write(`[next!] ${chunk}`); });
  const webBase = `http://127.0.0.1:${webPort}`;
  await Promise.all([
    once(web, 'spawn'),
    waitForHttp(webBase, 'next dev server'),
  ]);
  // Warm the audited routes so first navigation does not hit dev compilation.
  for (const route of ['/workbench', '/workbench/studio', '/workbench/artifacts', '/workbench/library']) {
    await waitForHttp(`${webBase}${route}`, `route ${route}`, 180_000).catch(() => {});
  }

  process.stdout.write(`${JSON.stringify({
    webBase,
    gatewayUrl: fixture.location.url,
    imageOrigin,
    home: fixture.home,
    workspace: fixture.workspace,
    providerUrl: fixture.providerUrl,
  })}\n`);

  const stop = () => {
    try { web.kill(); } catch {}
    fixture.close().finally(() => { media.close(); process.exit(0); });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once("exit", () => { try { media.close(); } catch {} });
}

main().catch(error => {
  process.stderr.write(`night studio stack failed: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
