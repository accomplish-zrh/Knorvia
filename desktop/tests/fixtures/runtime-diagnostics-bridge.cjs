'use strict';
// C05 acceptance bridge: starts the REAL loopback dev gateway fixture (real
// knorvia-daemon + fixed Kernel + scripted Responses) and serves the bundled
// RuntimeDiagnosticsPanel harness plus a one-time session endpoint, so the
// page in Chrome connects to the real gateway exactly like the product does.
// Usage: node runtime-diagnostics-bridge.cjs <harnessDir> <port>
// readiness line on stdout: BRIDGE_READY {"port":...}

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const harnessDir = process.argv[2];
const port = Number(process.argv[3] || 4504);

async function main() {
  const { startNativeGatewayFixture } = require('./start-native-gateway-fixture');
  const fixture = await startNativeGatewayFixture({
    home: process.env.KNORVIA_C05_HOME || undefined,
    port: 0,
    daemonBin: process.env.KNORVIA_DAEMON_BIN || undefined,
    kernelBin: process.env.KNORVIA_KERNEL_BIN || undefined,
    // The page connects straight to the gateway (no Next proxy in front), so
    // the advertised public path must be the gateway's own WS route.
    publicPath: '/knorvia/native',
  });
  const location = fixture.location;
  const gatewayOrigin = new URL(location.url).origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(harnessDir, 'harness.html')));
      return;
    }
    if (req.method === 'GET' && req.url === '/session') {
      // Mirror the product's session bootstrap (GET + page origin): the
      // gateway issues a one-time token bound to that origin, then the page
      // opens the real WebSocket itself with the same origin.
      try {
        const response = await fetch(`${gatewayOrigin}${location.nativeSessionPath}`, {
          headers: { origin: 'http://127.0.0.1:4504' },
        });
        const session = await response.json();
        const wsBase = gatewayOrigin.replace(/^http/, 'ws');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...session, url: `${wsBase}${session.url}` }));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message || error) }));
      }
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  process.stdout.write(`BRIDGE_READY ${JSON.stringify({ port, gateway: gatewayOrigin })}\n`);
  const shutdown = () => {
    server.close();
    fixture.close().catch(() => {}).finally?.(() => {});
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(error => { console.error('BRIDGE_FAILED', error); process.exit(1); });
