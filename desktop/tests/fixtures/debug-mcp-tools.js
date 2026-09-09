'use strict';
// Temporary debug: what tools does the running studio MCP server expose?
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { startKnorviaDaemon, initializeRequest } = require('../../knorvia-protocol-client');
const { createMediaStudio } = require('../../media-studio');
const { createStudioMcp } = require('../../studio-mcp');
const { createPersonalLibrary } = require('../../personal-library');

const daemonBin = 'D:\\tools\\knorvia-kernel\\knorvia-rs\\target\\release\\knorvia-daemon.exe';
const fakeSafeStorage = () => ({ isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v), decryptString: v => Buffer.from(v) });
(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-agent-dbg-'));
  let daemonRpc = async () => { throw new Error('no'); };
  const lazy = (...a) => daemonRpc(...a);
  const library = createPersonalLibrary({ home, rpc: lazy });
  const studio = createMediaStudio({ home, rpc: lazy, library, safeStorage: fakeSafeStorage(), pollMs: 50 });
  const studioMcp = await createStudioMcp({ getStudio: () => studio, getLibrary: () => library });
  const env = { ...process.env, KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1', KNORVIA_DAEMON_BIN: daemonBin, ...studioMcp.env };
  const session = startKnorviaDaemon({ daemonBin, home, env, requestTimeoutMs: 30_000 });
  let seq = 0;
  const rpc = async (method, params = {}) => { const r = await session.request({ jsonrpc: '2.0', id: String(++seq), method, params }); if (r.error) throw new Error(JSON.stringify(r.error)); return r.result; };
  const init = await session.request(initializeRequest('dbg', '1'), { timeoutMs: 60_000 });
  session.notify({ jsonrpc: '2.0', method: 'initialized' });
  daemonRpc = rpc;
  await studio.initialize();
  const res = await fetch(studioMcp.env.KNORVIA_STUDIO_MCP_URL, { method: 'POST', headers: { authorization: 'Bearer ' + studioMcp.env.KNORVIA_STUDIO_MCP_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const data = await res.json();
  console.log('MCP tools:', data.result.tools.map(t => t.name).join(','));
  const kernelConfig = fs.readFileSync(path.join(home, 'state', 'kernel', 'config.toml'), 'utf8').catch?.(() => '') ?? '';
  try { console.log('kernel config has media section:', kernelConfig.includes('knorvia_media')); } catch { }
  await studio.close().catch(() => { });
  await studioMcp.close().catch(() => { });
  session.child.stdin.end();
  await Promise.race([once(session.child, 'close'), delay(10_000).then(() => session.child.kill())]);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { }
  process.exit(0);
})().catch(e => { console.error('DBG-ERR', e.message); process.exit(1); });
