'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { startKnorviaDaemon, initializeRequest } = require('../knorvia-protocol-client');
const evidence = path.resolve(__dirname, '../../release/codex-integration-20260908/runtime');
const daemonBin = process.env.KNORVIA_DAEMON_BIN || 'D:/tools/knorvia-kernel/knorvia-rs/target/release/knorvia-daemon.exe';
const kernelBin = process.env.KNORVIA_KERNEL_BIN || 'D:/tools/knorvia-kernel/codex-rs/target/release/codex-app-server.exe';
for (const single of [false, true]) test(single ? 'stopping one verified child preserves its peer and rejects foreign identities' : 'interrupting parent cancels executing child and next turn remains usable', { timeout: 60000, skip: !fs.existsSync(daemonBin) || !fs.existsSync(kernelBin) }, async () => {
  fs.mkdirSync(evidence, { recursive: true }); const home = fs.mkdtempSync(path.join(evidence, 'cancel-'));
  const started = path.join(home, 'child-started.txt'), late = path.join(home, 'child-must-not-finish.txt'), peerStarted = path.join(home, 'peer-started.txt'), peerFinished = path.join(home, 'peer-finished.txt');
  let serial = 0, diagnostics = '', observed = [], childId, childInterruptAccepted = false;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks));
    const input = body.input || []; const user = input.filter(i => i.role === 'user').flatMap(i => i.content || []).map(c => c.text || '').findLast(t => ['CANCEL_LEAF','PEER_LEAF','AFTER_CANCEL','SPAWN_CANCEL_ROOT'].includes(t));
    const call = (name, args, id, namespace) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id, ...(namespace ? { namespace } : {}) });
    let item;
    if (user === 'CANCEL_LEAF' && !input.some(i => i.call_id === 'long-command')) {
      item = call('exec_command', { cmd: `Set-Content -LiteralPath '${started}' -Value started; Start-Sleep -Seconds 8; Set-Content -LiteralPath '${late}' -Value failed`, shell: 'powershell', login: false, sandbox_permissions: 'require_escalated', justification: 'Run the explicitly authorized cancellable local fixture.', yield_time_ms: 10000, max_output_tokens: 100 }, 'long-command');
    } else if (user === 'PEER_LEAF' && !input.some(i => i.call_id === 'peer-command')) {
      item = call('exec_command', { cmd: `Set-Content -LiteralPath '${peerStarted}' -Value started; Start-Sleep -Seconds 3; Set-Content -LiteralPath '${peerFinished}' -Value complete`, shell:'powershell',login:false,sandbox_permissions:'require_escalated',justification:'Run the authorized sibling isolation fixture.',yield_time_ms:10000,max_output_tokens:100 }, 'peer-command');
    } else if (user === 'SPAWN_CANCEL_ROOT') {
      const result = input.find(i => i.type === 'function_call_output' && i.call_id === 'spawn-cancel');
      if (result) {
        childId = JSON.parse(result.output).agent_id;
        const waitFinished = prefix => input.some(i => {
          if (i.type !== 'function_call_output' || !i.call_id.startsWith(prefix)) return false;
          const result = typeof i.output === 'string' ? JSON.parse(i.output) : i.output;
          return result.timed_out === false && Object.values(result.status || {}).some(status =>
            status === 'interrupted' || (status && typeof status === 'object' && Object.hasOwn(status, 'completed')));
        });
        // The pinned Kernel keeps interrupted agents resumable; wait_agent
        // therefore times out for them. The explicit user stop is the fixture's
        // cue to collect the peer. Assert the real child interruption below.
        const alphaDone = childInterruptAccepted && input.some(i =>
          i.type === 'function_call_output' && i.call_id.startsWith('wait-alpha'));
        const peerDone = waitFinished('wait-peer');
        if (single && alphaDone && peerDone) item = { type:'message',role:'assistant',id:'root-finished',content:[{type:'output_text',text:'Stopped child; peer finished.'}] };
        else {
          const peer = input.find(i => i.type === 'function_call_output' && i.call_id === 'spawn-peer');
          const target = single && alphaDone ? JSON.parse(peer.output).agent_id : childId;
          item = call('wait_agent', { targets: [target], timeout_ms: 10000 }, `${single && alphaDone ? 'wait-peer' : 'wait-alpha'}-${serial}`, 'multi_agent_v1');
        }
      } else {
        item = [call('spawn_agent', { message:'CANCEL_LEAF',fork_context:false }, 'spawn-cancel','multi_agent_v1')];
        if (single) item.push(call('spawn_agent',{message:'PEER_LEAF',fork_context:false},'spawn-peer','multi_agent_v1'));
      }
    } else item = { type: 'message', role: 'assistant', id: `msg-${serial}`, content: [{ type: 'output_text', text: user === 'AFTER_CANCEL' ? 'New turn is healthy.' : 'Child stopped.' }] };
    observed.push({ user, call: item.name || 'message' }); const id = `r-${++serial}`;
    const events = [{ type:'response.created',response:{id} }, ...(Array.isArray(item) ? item : [item]).map(item=>({type:'response.output_item.done',item})), { type:'response.completed',response:{id,usage:{input_tokens:5,output_tokens:2,total_tokens:7}} }];
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const session = startKnorviaDaemon({ daemonBin, home, env: { ...process.env, KNORVIA_KERNEL_BIN: kernelBin, KNORVIA_PROVIDER_PROTOCOL: 'responses', KNORVIA_PROVIDER_MODEL: 'knorvia-fixture-model', KNORVIA_PROVIDER_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, KNORVIA_PROVIDER_API_KEY: 'local-only', KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1' } });
  session.child.stderr.on('data', c => diagnostics = (diagnostics + c).slice(-10000)); let seq = 0, cancelled, followup, stopMs;
  const rpc = async (method, params = {}) => { const result = await session.request({ jsonrpc: '2.0', id: String(++seq), method, params }); if (result.error) throw Error(JSON.stringify(result.error)); return result.result; };
  try {
    await session.request(initializeRequest('takeover_cancel', '1')); session.notify({ jsonrpc: '2.0', method: 'initialized' });
    const ws = await rpc('workspace/create', { cwd: home, title: 'Cancellation' }); const thread = await rpc('thread/start', { workspaceId: ws.id, cwd: home });
    const admitted = await rpc('turn/start', { threadId: thread.id, input: 'SPAWN_CANCEL_ROOT', tools: { write: true }, cwd: home }); const id = admitted.turn?.id || admitted.id;
    const deadline = Date.now() + 20000;
    while ((!fs.existsSync(started) || (single && !fs.existsSync(peerStarted))) && Date.now() < deadline) {
      await delay(100); const turn = await rpc('turn/read', { id });
      for (const approval of turn.pendingApprovals || []) await rpc('approval/respond', { id: approval.id, decision: 'allow' });
    }
    assert.ok(fs.existsSync(started), 'the child command must actually start before cancellation');
    const t0 = Date.now();
    if (single) {
      await assert.rejects(rpc('turn/agent/interrupt',{threadId:thread.id,turnId:id,kernelThreadId:'unrelated-thread'}));
      const result = await rpc('turn/agent/interrupt',{threadId:thread.id,turnId:id,kernelThreadId:childId}); assert.equal(result.accepted,true);
      childInterruptAccepted = true;
    } else await rpc('turn/interrupt', { threadId: thread.id, turnId: id });
    const waitBound = single ? 15000 : 5000; // wait_agent may observe interruption at its 10s deadline.
    do { await delay(80); cancelled = await rpc('turn/read', { id }); } while (!['cancelled', 'failed', 'completed'].includes(cancelled.status) && Date.now() - t0 < waitBound);
    stopMs = Date.now() - t0; assert.equal(cancelled.status, single ? 'completed' : 'cancelled'); assert.ok(stopMs < waitBound);
    if (single) {
      assert.ok(fs.existsSync(peerFinished), 'peer must be allowed to finish its write');
      assert.ok(cancelled.items.some(item => item.kind === 'subAgent'
        && item.payload.kernelThreadId === childId
        && item.payload.event === 'turn/completed'
        && item.payload.data?.turn?.status === 'interrupted'), 'the selected child must durably report interruption');
    }
    const next = await rpc('turn/start', { threadId: thread.id, input: 'AFTER_CANCEL', tools: { write: true }, cwd: home }); const nextId = next.turn?.id || next.id;
    const followDeadline = Date.now() + 10000;
    do { await delay(80); followup = await rpc('turn/read', { id: nextId }); } while (followup.status === 'running' && Date.now() < followDeadline);
    assert.equal(followup.status, 'completed');
    await delay(Math.max(0, 8500 - (Date.now() - t0))); assert.equal(fs.existsSync(late), false, 'cancelled child must not perform its delayed write');
  } finally {
    fs.writeFileSync(path.join(evidence, single ? 'child-isolation-result.json' : 'cancellation-result.json'), JSON.stringify({ home, childId, stopMs, observed, cancelled, followup, diagnostics }, null, 2));
    const closed = new Promise(resolve => session.child.once('close', resolve));
    session.child.stdin.end();
    const shutdownTimer = setTimeout(() => session.child.kill(), 5000);
    await closed; clearTimeout(shutdownTimer);
    server.close(); server.closeAllConnections();
  }
});
