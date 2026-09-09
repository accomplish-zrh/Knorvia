'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createKernelEngine } = require('../kernel-engine');

const kernelRoot = path.resolve(__dirname, '../../../knorvia-kernel');
const daemon = process.env.KNORVIA_DAEMON_BIN || path.join(kernelRoot, 'knorvia-rs/target/debug/knorvia-daemon.exe');
const appServer = process.env.KNORVIA_KERNEL_BIN || path.join(kernelRoot, 'codex-rs/target/debug/codex-app-server.exe');

function waitFor(predicate, description, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${description}`));
      setTimeout(check, 20);
    };
    check();
  });
}

// Real daemon and real forked App Server, local scripted provider only: no
// paid API calls, credentials, or user home. This is not a GUI acceptance test.
test('desktop chat uses the real kernel, resumes a thread after restart, and never replays old answers', {
  skip: !fs.existsSync(daemon) || !fs.existsSync(appServer), timeout: 120000,
}, async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    const n = ++hits;
    const events = [
      { type: 'response.created', response: { id: `resp-${n}` } },
      { type: 'response.output_item.done', item: {
        type: 'message', role: 'assistant', id: `msg-${n}`,
        content: [{ type: 'output_text', text: `verified-answer-${n}` }],
      } },
      { type: 'response.completed', response: { id: `resp-${n}`, usage: {
        input_tokens: 0, output_tokens: 0, total_tokens: 0,
        input_tokens_details: null, output_tokens_details: null,
      } } },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Keep the local model deliberately slow enough to prove that desktop
    // turn/start admits the turn and exposes its id before model completion.
    setTimeout(() => {
      res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    }, 800);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-live-chat-'));
  const options = { home, env: { ...process.env,
    KNORVIA_DAEMON_BIN: daemon,
    KNORVIA_KERNEL_BIN: appServer,
    KNORVIA_PROVIDER_MODEL: 'gpt-5.2',
    KNORVIA_PROVIDER_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    KNORVIA_PROVIDER_API_KEY: 'local-test-only',
    KNORVIA_KERNEL_TURN_TIMEOUT_SECS: '30',
  } };
  let engine;
  const stop = async () => {
    if (!engine) return;
    const closed = once(engine.child, 'close');
    engine.kill();
    await closed;
    engine = null;
  };
  try {
    engine = await createKernelEngine(options);
    let threadId;
    for (let n = 1; n <= 3; n++) {
      if (n === 3) {
        await stop();
        engine = await createKernelEngine(options);
      }
      const events = [];
      const admittedAt = Date.now();
      await engine.handleWsSend({ id: 'live', data: {
        type: 'start_turn', content: `question-${n}`, session_id: threadId,
      } }, msg => events.push(JSON.parse(msg.data)));
      assert.ok(Date.now() - admittedAt < 500, `turn/start waited for model: ${Date.now() - admittedAt}ms`);
      const admitted = events.find(e => e.type === 'session' && e.turn_id);
      assert.ok(admitted?.turn_id, JSON.stringify(events));
      assert.ok(!events.some(e => e.type === 'done'), JSON.stringify(events));
      await waitFor(() => events.some(e => e.type === 'done'), `turn ${n} terminal notification`);
      assert.equal(events.at(-1).metadata.status, 'completed', JSON.stringify(events));
      assert.deepEqual(events.filter(e => e.type === 'content').map(e => e.content), [`verified-answer-${n}`]);
      const session = admitted;
      if (threadId) assert.equal(session.session_id, threadId);
      threadId = session.session_id;
      const threads = await engine.rpc('thread/list', { workspaceId: engine.workspace.id });
      assert.equal(threads.length, 1);
    }
    assert.equal(hits, 3);
  } finally {
    await stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
