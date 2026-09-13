'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const webRoot = path.resolve(__dirname, '../../web');
const { _electron: electron } = require(path.join(webRoot, 'node_modules/playwright'));

const evidence = process.env.KNORVIA_C19_EVIDENCE || path.resolve('D:/tools/knorvia-completion-20260912/runtime/G/evidence');

test('C19: real Electron IPC streams >64MB video with Range seeking and 5MB image within IPC budget', { timeout: 60_000 }, async t => {
  fs.mkdirSync(evidence, { recursive: true });
  const electronBinary = require(path.join(__dirname, '../node_modules/electron'));
  const fixturePath = path.join(__dirname, 'fixtures/c19-preview-electron.cjs');

  const electronApp = await electron.launch({
    executablePath: electronBinary,
    args: [fixturePath],
    env: { ...process.env, KNORVIA_C19_EVIDENCE: evidence },
  });

  const observations = {};

  try {
    const page = await electronApp.firstWindow();
    await page.waitForSelector('#ready');

    // 1. Read >64MB video preview over IPC
    const videoIpcResult = await page.evaluate(async () => {
      const started = performance.now();
      const res = await window.ipcRenderer.invoke('knorvia:preview-read', {
        workspaceId: 'ws-electron',
        path: 'video-big.mp4',
      });
      const durationMs = performance.now() - started;
      const jsonLen = JSON.stringify(res).length;
      return { res, jsonLen, durationMs };
    });

    assert.equal(videoIpcResult.res.stream, true, 'large video must use stream URL');
    assert.equal(videoIpcResult.res.base64, undefined, 'large video must NOT be transferred as base64');
    assert.ok(videoIpcResult.jsonLen < 500, `IPC message must be tiny (<500B), got ${videoIpcResult.jsonLen}B`);
    assert.match(videoIpcResult.res.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}$/);

    observations.videoIpc = {
      stream: videoIpcResult.res.stream,
      ipcPayloadBytes: videoIpcResult.jsonLen,
      ipcDurationMs: videoIpcResult.durationMs,
      url: videoIpcResult.res.url,
    };

    // 2. Range seeking from Electron renderer: First frame / header (bytes 0-11)
    const rangeHeaderResult = await page.evaluate(async (url) => {
      const resp = await fetch(url, { headers: { Range: 'bytes=0-11' } });
      const buf = await resp.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      return {
        status: resp.status,
        contentRange: resp.headers.get('content-range'),
        acceptRanges: resp.headers.get('accept-ranges'),
        bytes,
      };
    }, videoIpcResult.res.url);

    assert.equal(rangeHeaderResult.status, 206, 'Range request must return HTTP 206');
    assert.equal(rangeHeaderResult.acceptRanges, 'bytes');
    assert.match(rangeHeaderResult.contentRange, /^bytes 0-11\/\d+$/);
    assert.deepEqual(rangeHeaderResult.bytes, [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

    observations.videoRangeFirstFrame = rangeHeaderResult;

    // 3. Range seeking from Electron renderer: Seek to 64MB offset (bytes 67108864 - 67108867)
    const rangeSeekResult = await page.evaluate(async (url) => {
      const resp = await fetch(url, { headers: { Range: 'bytes=67108864-67108867' } });
      const buf = await resp.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      return {
        status: resp.status,
        contentRange: resp.headers.get('content-range'),
        bytes,
      };
    }, videoIpcResult.res.url);

    assert.equal(rangeSeekResult.status, 206, 'Seek range request must return HTTP 206');
    assert.match(rangeSeekResult.contentRange, /^bytes 67108864-67108867\/\d+$/);
    assert.deepEqual(rangeSeekResult.bytes, [0xAA, 0xBB, 0xCC, 0xDD], 'Seek offset must match exact byte content');

    observations.videoRangeSeek64MB = rangeSeekResult;

    // 4. Read 5.2MB image preview over IPC (exceeds 2MiB inline budget)
    const hugeImageIpcResult = await page.evaluate(async () => {
      const res = await window.ipcRenderer.invoke('knorvia:preview-read', {
        workspaceId: 'ws-electron',
        path: 'image-huge.png',
      });
      const jsonLen = JSON.stringify(res).length;
      return { res, jsonLen };
    });

    assert.equal(hugeImageIpcResult.res.stream, true, '5MB image must use stream URL to protect IPC/gateway limits');
    assert.equal(hugeImageIpcResult.res.base64, undefined, '5MB image must NOT be base64');
    assert.ok(hugeImageIpcResult.jsonLen < 500, `IPC message must be tiny (<500B), got ${hugeImageIpcResult.jsonLen}B`);

    // Fetch full 5.2MB image from Electron renderer
    const hugeImageFetchResult = await page.evaluate(async (url) => {
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf.slice(0, 8)));
      return {
        status: resp.status,
        byteLength: buf.byteLength,
        pngHeader: bytes,
      };
    }, hugeImageIpcResult.res.url);

    assert.equal(hugeImageFetchResult.status, 200);
    assert.equal(hugeImageFetchResult.byteLength, Math.floor(5.2 * 1024 * 1024));
    assert.deepEqual(hugeImageFetchResult.pngHeader, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    observations.hugeImage = {
      ipcPayloadBytes: hugeImageIpcResult.jsonLen,
      fetchStatus: hugeImageFetchResult.status,
      byteLength: hugeImageFetchResult.byteLength,
    };

    // 5. Verify Gateway HTTP endpoint for 5.2MB image also stays < 500B (far below 4MiB RPC frame limit)
    const gatewayResult = await page.evaluate(async () => {
      const resp = await fetch(`http://127.0.0.1:${window.__GATEWAY_PORT}/rpc/preview/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws-electron', path: 'image-huge.png' }),
      });
      const text = await resp.text();
      return {
        status: resp.status,
        frameBytes: text.length,
        parsed: JSON.parse(text),
      };
    });

    assert.equal(gatewayResult.status, 200);
    assert.ok(gatewayResult.frameBytes < 500, `Gateway HTTP frame must be < 500B (got ${gatewayResult.frameBytes}B), well below 4MiB limit`);
    assert.equal(gatewayResult.parsed.stream, true);

    observations.gatewayParity = {
      gatewayFrameBytes: gatewayResult.frameBytes,
      stream: gatewayResult.parsed.stream,
    };

    // 6. Fast path verification: 1KB image uses inline base64
    const smallImageIpcResult = await page.evaluate(async () => {
      return window.ipcRenderer.invoke('knorvia:preview-read', {
        workspaceId: 'ws-electron',
        path: 'image-small.png',
      });
    });

    assert.equal(smallImageIpcResult.stream, undefined, 'small image uses fast path');
    assert.equal(typeof smallImageIpcResult.base64, 'string');

    observations.smallImageFastPath = {
      stream: false,
      hasBase64: Boolean(smallImageIpcResult.base64),
    };

    // 7. Revoke token (simulating panel close)
    const videoToken = videoIpcResult.res.url.split('/').pop();
    const revokeResult = await page.evaluate(async (token) => {
      const revoked = await window.ipcRenderer.invoke('knorvia:preview-revoke', { token });
      return revoked;
    }, videoToken);

    assert.equal(revokeResult.revoked, 1);

    // After revocation, fetching from Electron renderer must return HTTP 404
    const afterRevokeFetch = await page.evaluate(async (url) => {
      const resp = await fetch(url);
      return resp.status;
    }, videoIpcResult.res.url);

    assert.equal(afterRevokeFetch, 404, 'Revoked token must return 404 on subsequent fetch');
    observations.revocation = {
      token: videoToken,
      revoked: revokeResult.revoked,
      afterStatus: afterRevokeFetch,
    };

    // Write machine evidence
    const evidencePath = path.join(evidence, 'c19-electron-preview-result.json');
    fs.writeFileSync(evidencePath, JSON.stringify({
      mode: 'real Electron + real knorvia:// privileged scheme + workspace-media-preview loopback service + workspace-preview routing + browser gateway parity',
      passed: true,
      timestamp: new Date().toISOString(),
      observations,
    }, null, 2));

  } finally {
    await electronApp.close();
  }
});
