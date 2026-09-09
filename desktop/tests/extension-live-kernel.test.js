'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createExtensionManager } = require('../extension-manager');
const { startKnorviaDaemon, initializeRequest } = require('../knorvia-protocol-client');
const evidence = path.resolve(__dirname, '../../release/codex-integration-20260908/workspace');
const daemonBin = process.env.KNORVIA_DAEMON_BIN || 'D:/tools/knorvia-kernel/knorvia-rs/target/release/knorvia-daemon.exe';
const kernelBin = process.env.KNORVIA_KERNEL_BIN || 'D:/tools/knorvia-kernel/codex-rs/target/release/codex-app-server.exe';
const skill = name => `---\nname: ${name}\ndescription: Local acceptance fixture only\n---\nUse this fixture when explicitly asked.\n`;

test('real Kernel discovers installed Skills and a local plugin MCP, then unloads them', { timeout: 120000, skip: !fs.existsSync(daemonBin) || !fs.existsSync(kernelBin) }, async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const home = fs.mkdtempSync(path.join(evidence, 'extensions-')), sourceDir = path.join(home, 'project'); fs.mkdirSync(sourceDir);
  const fixtureBin = path.join(home, 'knorvia-daemon.exe'); fs.copyFileSync(daemonBin, fixtureBin);
  const trace = path.join(home, 'mcp-trace.jsonl'), observations = [], modelRequests = [];
  let diagnostics = '', seq = 0, stage = 0;
  const provider = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
    modelRequests.push({ tools: body.tools, input: body.input });
    const tools = (body.tools || []).flatMap(tool => tool.type === 'namespace' ? (tool.tools || []).map(fn => ({ ...fn, namespace: tool.name })) : [tool]);
    const echo = tools.find(tool => /fixture_echo/.test(tool.name || ''));
    let items;
    if (stage === 0 && !echo && (body.tools || []).some(t => t.type === 'tool_search')) { items = [{ type: 'tool_search_call', execution: 'client', call_id: 'find-extension-tool', arguments: { query: 'fixture_echo', limit: 2 } }]; stage++; }
    else if (stage < 2 && echo) { items = [{ type: 'function_call', name: echo.name, ...(echo.namespace ? { namespace: echo.namespace } : {}), arguments: JSON.stringify({ text: 'extension-verified' }), call_id: 'call-extension-fixture' }]; stage = 2; }
    else items = [{ type: 'message', role: 'assistant', id: 'fixture-final', content: [{ type: 'output_text', text: 'Local extension fixture complete.' }] }];
    const events = [{ type: 'response.created', response: { id: `resp-${modelRequests.length}` } }, ...items.map(item => ({ type: 'response.output_item.done', item })), { type: 'response.completed', response: { id: `resp-${modelRequests.length}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, KNORVIA_KERNEL_BIN: kernelBin, KNORVIA_PROVIDER_MODEL: 'local-extension-fixture', KNORVIA_PROVIDER_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, KNORVIA_PROVIDER_API_KEY: 'local-fixture-only', KNORVIA_KERNEL_TURN_TIMEOUT_SECS: '45' };
  delete env.KNORVIA_TEST_DISABLE_PLUGIN_SYNC;
  const session = startKnorviaDaemon({ daemonBin: fixtureBin, home, env, requestTimeoutMs: 45000 });
  session.child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-15000); });
  const rpc = async (method, params = {}) => { const response = await session.request({ jsonrpc: '2.0', id: String(++seq), method, params }); if (response.error) { const error = new Error(response.error.message); error.rpc = response.error; throw error; } observations.push({ method, result: response.result }); return response.result; };
  const manager = createExtensionManager({ home, rpc });
  const call = (method, params = {}) => manager.handlers[method](params);
  let turn;
  try {
    const initialized = await session.request(initializeRequest('extension_fixture', '1')); assert.ok(!initialized.error, JSON.stringify(initialized)); session.notify({ jsonrpc: '2.0', method: 'initialized' });
    const ws = await rpc('workspace/create', { cwd: sourceDir, title: 'Extension acceptance' });
    fs.mkdirSync(path.join(sourceDir, 'plain')); fs.writeFileSync(path.join(sourceDir, 'plain', 'SKILL.md'), skill('plain-fixture'));
    const install = async source => { const inspected = await call('extension/inspect', { source }); return call('extension/install', { source, expectedSha256: inspected.sha256 }); };
    let plain = await install({ type: 'local', workspaceId: ws.id, path: 'plain' });
    plain = await call('extension/enable', { id: plain.id, revision: plain.revision, enabled: true });
    let discovered = await rpc('skills/list', { cwds: [sourceDir], forceReload: true }); assert.ok(discovered.data.flatMap(d => d.skills).some(s => s.name === 'plain-fixture'), JSON.stringify(discovered));
    plain = await call('extension/enable', { id: plain.id, revision: plain.revision, enabled: false });
    discovered = await rpc('skills/list', { cwds: [sourceDir], forceReload: true }); assert.ok(!discovered.data.flatMap(d => d.skills).some(s => s.name === 'plain-fixture'));

    const plugin = path.join(sourceDir, 'plugin'); fs.mkdirSync(path.join(plugin, '.codex-plugin'), { recursive: true }); fs.mkdirSync(path.join(plugin, 'skills', 'plugin-fixture'), { recursive: true });
    fs.writeFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'local-fixture', version: '1.0.0', description: 'Local fixture' }));
    fs.writeFileSync(path.join(plugin, 'skills', 'plugin-fixture', 'SKILL.md'), skill('plugin-fixture'));
    const mcpScript = path.join(plugin, 'fixture-mcp.cjs');
    fs.writeFileSync(mcpScript, `const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const p=JSON.parse(line);fs.appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify({method:p.method,params:p.params})+'\\n');if(p.id===undefined)return;let result;if(p.method==='initialize')result={protocolVersion:p.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'extension-fixture',version:'1'}};else if(p.method==='tools/list')result={tools:[{name:'fixture_echo',description:'Local fixture echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};else if(p.method==='tools/call')result={content:[{type:'text',text:p.params.arguments.text}]};else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:p.id,result})+'\\n');});`);
    fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [mcpScript], env: { FIXTURE_TRACE: trace }, startup_timeout_sec: 10 } } }));
    let entry = await install({ type: 'local', workspaceId: ws.id, path: 'plugin' }); entry = await call('extension/enable', { id: entry.id, revision: entry.revision, enabled: true });
    const marketplacePath = path.join(home, 'extensions', 'marketplaces', entry.id, '.agents', 'plugins', 'marketplace.json');
    const read = await rpc('extension/kernel/read', { marketplacePath, pluginName: 'local-fixture' }); assert.equal(read.installed, true, JSON.stringify(read));
    discovered = await rpc('skills/list', { cwds: [sourceDir], forceReload: true }); assert.ok(discovered.data.flatMap(d => d.skills).some(s => s.name === 'local-fixture:plugin-fixture'), JSON.stringify(discovered));
    const thread = await rpc('thread/start', { workspaceId: ws.id, cwd: sourceDir, title: 'Local MCP' }); const admitted = await rpc('turn/start', { threadId: thread.id, cwd: sourceDir, input: 'Call the fixture_echo extension tool with extension-verified.', tools: { write: true } });
    const id = admitted.turn?.id || admitted.id, deadline = Date.now() + 60000;
    const approvals = new Set();
    do { await delay(100); turn = await rpc('turn/read', { id }); for (const approval of turn.pendingApprovals || []) if (!approvals.has(approval.id)) { approvals.add(approval.id); await rpc('approval/respond', { id: approval.id, decision: 'allow' }); } } while (!['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.status) && Date.now() < deadline);
    assert.equal(turn.status, 'completed', JSON.stringify(turn));
    const calls = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse) : [];
    assert.ok(calls.some(c => c.method === 'initialize'), 'plugin MCP initialize must reach a real child process'); assert.ok(calls.some(c => c.method === 'tools/list')); assert.ok(calls.some(c => c.method === 'tools/call' && c.params.arguments.text === 'extension-verified'));
    entry = await call('extension/enable', { id: entry.id, revision: entry.revision, enabled: false });
    discovered = await rpc('skills/list', { cwds: [sourceDir], forceReload: true }); assert.ok(!discovered.data.flatMap(d => d.skills).some(s => s.name === 'local-fixture:plugin-fixture'));
    const after = await rpc('extension/kernel/read', { marketplacePath, pluginName: 'local-fixture' }); assert.equal(after.installed, false);
    await call('extension/uninstall', { id: entry.id, revision: entry.revision });
  } finally {
    fs.writeFileSync(path.join(evidence, 'extension-live-result.json'), JSON.stringify({ home, daemonBin, kernelBin, observations, modelRequests, turn, diagnostics }, null, 2));
    await manager.close(); const closed = once(session.child, 'close'); session.child.stdin.end(); const timer = setTimeout(() => session.child.kill(), 5000); await closed; clearTimeout(timer); provider.close(); provider.closeAllConnections();
  }
});
