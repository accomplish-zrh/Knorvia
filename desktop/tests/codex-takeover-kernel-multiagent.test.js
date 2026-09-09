'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { startKnorviaDaemon, initializeRequest } = require('../knorvia-protocol-client');
const evidence = path.resolve(__dirname, '../../release/codex-integration-20260908/runtime');
const kernelBin = process.env.KNORVIA_KERNEL_BIN || 'D:/tools/knorvia-kernel/codex-rs/target/release/codex-app-server.exe';
const daemonBin = process.env.KNORVIA_DAEMON_BIN || 'D:/tools/knorvia-kernel/knorvia-rs/target/release/knorvia-daemon.exe';
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

for (const protocol of ['responses', 'chat-completions', 'anthropic-messages']) test(`real Kernel ${protocol}: isolated children, approvals, wait, close, resume and reuse`, { timeout: 180000, skip: !fs.existsSync(kernelBin) || !fs.existsSync(daemonBin) }, async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const home = fs.mkdtempSync(path.join(evidence, 'multiagent-'));
  const requests = [], approved = new Set(), childIds = [], errors = [];
  let rootStage = 0, serial = 0, diagnostics = '';
  function fc(name, args, callId, namespace) { return { type: 'function_call', name, ...(namespace ? { namespace } : {}), arguments: JSON.stringify(args), call_id: callId }; }
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const upstream = JSON.parse(Buffer.concat(chunks));
      const body = protocol === 'responses' ? upstream : { tools: [], input: [] };
      assert.equal(protocol === 'anthropic-messages' ? req.headers['x-api-key'] : req.headers.authorization, protocol === 'anthropic-messages' ? 'runtime-local-fixture' : 'Bearer runtime-local-fixture', 'custom provider must send its authentication header');
      const aliases = {};
      if (protocol !== 'responses') {
        assert.equal(req.url, protocol === 'anthropic-messages' ? '/v1/messages' : '/v1/chat/completions', 'version path must not be duplicated');
        for (const item of upstream.messages || []) {
          if (typeof item.content === 'string' && item.role !== 'tool') body.input.push({ type: 'message', role: item.role, content: [{ type: 'input_text', text: item.content }] });
          if (item.role === 'tool') body.input.push({ type: 'function_call_output', call_id: item.tool_call_id, output: item.content });
          for (const block of Array.isArray(item.content) ? item.content : []) {
            if (block.type === 'text') body.input.push({ type: 'message', role: item.role, content: [{ type: 'input_text', text: block.text }] });
            if (block.type === 'tool_result') body.input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: block.content });
          }
        }
        for (const entry of upstream.tools || []) {
          const tool = entry.function || entry;
          const description = tool.description || '';
          for (const [name, match] of Object.entries({ spawn_agent: /Spawn a sub-agent/, wait_agent: /Wait for agents/, close_agent: /Close an agent/, resume_agent: /Resume a previously closed agent/, send_input: /Send a message to an existing agent/ })) if (match.test(description)) aliases[name] = tool.name;
        }
        if (aliases.spawn_agent) body.tools.push({ type: 'namespace', name: 'multi_agent_v1', tools: Object.keys(aliases).map(name => ({ name })) });
      }
      const input = Array.isArray(body.input) ? body.input : [];
      const users = input.filter(i => i.type === 'message' && i.role === 'user').flatMap(i => i.content || []).map(c => c.text || '');
      const leaf = users.findLast(text => /^LEAF:/.test(text));
      const outputs = input.filter(i => i.type === 'function_call_output');
      const multi = (body.tools || []).find(t => t.type === 'namespace' && t.tools?.some(f => f.name === 'spawn_agent'));
      let items;
      if (leaf) {
        const marker = leaf.split(':')[1];
        const id = `exec-${marker}`;
        if (!outputs.some(o => o.call_id === id)) {
          const file = path.join(home, marker + '.txt').replaceAll("'", "''");
          items = [fc('exec_command', { cmd: `Set-Content -LiteralPath '${file}' -Value '${marker}'`, shell: 'powershell', login: false, sandbox_permissions: 'require_escalated', justification: 'Write the explicitly authorized isolated fixture marker.', max_output_tokens: 100 }, id)];
        } else items = [{ type: 'message', role: 'assistant', id: `message-${marker}`, content: [{ type: 'output_text', text: `${marker} done` }] }];
      } else if (!multi && rootStage === 0) {
        assert.ok((body.tools || []).some(t => t.type === 'tool_search'), 'multi-agent namespace or discovery tool must be exposed');
        items = [{ type: 'tool_search_call', execution: 'client', call_id: 'discover-agents', arguments: { query: 'spawn_agent wait_agent close_agent resume_agent send_input', limit: 5 } }];
      } else {
        for (const output of outputs.filter(o => ['spawn-alpha', 'spawn-beta'].includes(o.call_id))) {
          const value = typeof output.output === 'string' ? JSON.parse(output.output) : output.output;
          const id = value.agent_id || value.agentId;
          if (id && !childIds.includes(id)) childIds.push(id);
        }
        const namespace = multi?.name || 'multi_agent_v1';
        // A wait timeout is a progress snapshot, not permission to close a
        // running child. The fixture must collect each completed child first.
        const childCompleted = (prefix, id) => outputs.some(output => {
          if (!output.call_id.startsWith(prefix)) return false;
          const value = typeof output.output === 'string' ? JSON.parse(output.output) : output.output;
          return Object.hasOwn(value.status?.[id] || {}, 'completed');
        });
        switch (rootStage++) {
          case 0: items = ['alpha', 'beta'].map(marker => fc('spawn_agent', { message: `LEAF:${marker}`, fork_context: false }, `spawn-${marker}`, namespace)); break;
          case 1: assert.equal(childIds.length, 2, 'both real child identities must be returned'); items = childIds.map((id, n) => fc('wait_agent', { targets: [id], timeout_ms: 10000 }, `wait-first-${n}`, namespace)); break;
          case 2: {
            const pending = childIds.filter(id => !childCompleted('wait-first-', id));
            if (pending.length) {
              rootStage--;
              items = pending.map((id, n) => fc('wait_agent', { targets: [id], timeout_ms: 10000 }, `wait-first-retry-${serial}-${n}`, namespace));
            } else items = childIds.map((id, n) => fc('close_agent', { target: id }, `close-first-${n}`, namespace));
            break;
          }
          case 3: items = [fc('resume_agent', { id: childIds[0] }, 'resume-alpha', namespace)]; break;
          case 4: items = [fc('send_input', { target: childIds[0], message: 'LEAF:alpha-reused' }, 'reuse-alpha', namespace)]; break;
          case 5: items = [fc('wait_agent', { targets: [childIds[0]], timeout_ms: 10000 }, 'wait-reused', namespace)]; break;
          case 6:
            if (!childCompleted('wait-reused', childIds[0])) {
              rootStage--;
              items = [fc('wait_agent', { targets: [childIds[0]], timeout_ms: 10000 }, `wait-reused-retry-${serial}`, namespace)];
            } else items = [fc('close_agent', { target: childIds[0] }, 'close-final', namespace)];
            break;
          default: items = [{ type: 'message', role: 'assistant', id: 'root-final', content: [{ type: 'output_text', text: 'All delegated work collected.' }] }];
        }
      }
      requests.push({ leaf: leaf || null, rootStage, authorizationPresent: true, outputs: outputs.slice(-3), emitted: items.map(i => ({ type: i.type, name: i.name, namespace: i.namespace })) });
      const id = `resp-${++serial}`;
      let frames;
      if (protocol === 'responses') {
        const events = [{ type: 'response.created', response: { id } }, ...items.map(item => ({ type: 'response.output_item.done', item })), { type: 'response.completed', response: { id, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } }];
        frames = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
      } else if (protocol === 'chat-completions') {
        const calls = items.filter(i => i.type === 'function_call');
        const text = items.filter(i => i.type === 'message').flatMap(i => i.content).map(c => c.text).join('');
        const chunks = [{ id, choices: [{ index: 0, delta: { content: text || null, tool_calls: calls.map((call, index) => ({ index, id: call.call_id, type: 'function', function: { name: call.namespace ? aliases[call.name] : call.name, arguments: call.arguments } })) } }] }, { id, choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }, { id, choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } }];
        frames = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
      } else {
        const events = [{ type: 'message_start', message: { id, usage: { input_tokens: 10 } } }];
        for (const [index, item] of items.entries()) {
          const call = item.type === 'function_call';
          events.push({ type: 'content_block_start', index, content_block: call ? { type: 'tool_use', id: item.call_id, name: item.namespace ? aliases[item.name] : item.name, input: {} } : { type: 'text', text: '' } });
          events.push({ type: 'content_block_delta', index, delta: call ? { type: 'input_json_delta', partial_json: item.arguments } : { type: 'text_delta', text: item.content.map(c => c.text).join('') } });
          events.push({ type: 'content_block_stop', index });
        }
        events.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' });
        frames = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frames);
    } catch (error) { errors.push(String(error)); res.writeHead(500); res.end(JSON.stringify({ error: { message: String(error) } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const session = startKnorviaDaemon({ daemonBin, home, env: { ...process.env, KNORVIA_KERNEL_BIN: kernelBin, KNORVIA_PROVIDER_PROTOCOL: protocol, KNORVIA_PROVIDER_PROFILE_ID: 'fixture-profile', KNORVIA_PROVIDER_MODEL: 'knorvia-fixture-model', KNORVIA_PROVIDER_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, KNORVIA_PROVIDER_API_KEY: 'runtime-local-fixture', KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1', KNORVIA_KERNEL_TURN_TIMEOUT_SECS: '120' }, requestTimeoutMs: 60000 });
  session.child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-30000); });
  let counter = 0, turn;
  const rpc = async (method, params = {}) => { const response = await session.request({ jsonrpc: '2.0', id: String(++counter), method, params }); if (response.error) throw Error(JSON.stringify(response.error)); return response.result; };
  try {
    await session.request(initializeRequest('takeover_multiagent', '1')); session.notify({ jsonrpc: '2.0', method: 'initialized' });
    const ws = await rpc('workspace/create', { cwd: home, title: 'Local multi-agent acceptance' });
    const thread = await rpc('thread/start', { workspaceId: ws.id, cwd: home, title: 'Parent' });
    const admitted = await rpc('turn/start', { threadId: thread.id, input: 'Use two independent subagents, wait for both, close them, then resume and reuse the first.', cwd: home, tools: { write: true } });
    const id = admitted.turn?.id || admitted.id;
    const deadline = Date.now() + 140000;
    do {
      await delay(80); turn = await rpc('turn/read', { id });
      for (const approval of turn.pendingApprovals || []) {
        if (!approved.has(approval.id)) { approved.add(approval.id); await rpc('approval/respond', { id: approval.id, decision: 'allow' }); }
      }
    } while (!terminal.has(turn.status) && Date.now() < deadline);
    assert.deepEqual(errors, []);
    assert.equal(turn.status, 'completed');
    for (const marker of ['alpha', 'beta', 'alpha-reused']) assert.equal(fs.readFileSync(path.join(home, marker + '.txt'), 'utf8').trim(), marker);
    assert.equal(childIds.length, 2);
    assert.ok(approved.size >= 3, 'all child escalation requests must reach the parent product approval owner');
    assert.ok(turn.items.some(item => item.kind === 'subAgent'), 'child lifecycle must be durable in parent history');
    assert.ok(requests.filter(r => r.leaf).every(r => !r.leaf.includes('Use two independent')), 'children have distinct context');
    // Turn termination and the derived usage ledger have separate durable
    // writes. Wait for the ledger boundary, without weakening count/sum checks.
    const usageDeadline = Date.now() + 10_000;
    let records;
    do {
      await rpc('usage/summary', { limit: 100 });
      const usageDir = path.join(home, 'state/product/usage', thread.id);
      records = fs.existsSync(usageDir) ? fs.readdirSync(usageDir).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(usageDir, name)))) : [];
      if (records.length >= 4) break;
      await delay(80);
    } while (Date.now() < usageDeadline);
    assert.equal(records.length, 4, 'one parent and three child-turn usage records');
    assert.equal(records.reduce((sum, r) => sum + r.totalTokens, 0), requests.length * 13, 'all requests count once across parent and children');
    assert.ok(records.every(r => r.providerId === 'fixture-profile'));
    assert.equal(records.filter(r => r.parentTurnId === id).length, 3);
  } finally {
    fs.writeFileSync(path.join(evidence, `multiagent-${protocol}-result.json`), JSON.stringify({ kernelBin, daemonBin, home, approved: [...approved], childIds, errors, turn, requests, diagnostics }, null, 2));
    const closed = new Promise(resolve => session.child.once('close', resolve));
    session.child.stdin.end();
    const shutdownTimer = setTimeout(() => session.child.kill(), 5000);
    await closed; clearTimeout(shutdownTimer);
    server.close(); server.closeAllConnections();
  }
});
