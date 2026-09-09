'use strict';

// A local OpenAI Responses SSE fixture for manual workbench QA and integration
// tests. It never implements a fake agent: Knorvia still drives the real
// daemon, forked Kernel App Server, approval bridge, and workspace tools.

const http = require('node:http');
const { once } = require('node:events');

const FIXTURE_MODEL = 'gpt-5.2';
const DEFAULT_SLOW_DELAY_MS = 45_000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const RESPONSES_PATH = '/v1/responses';
const STATUS_PATH = '/__knorvia_fixture/status';
const RELEASE_SLOW_PATH = '/__knorvia_fixture/release-slow';

function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function completed(responseId, seq = 0) {
  // Deterministic non-zero usage so the product's durable usage ledger has a
  // verifiable provider-reported fact to attribute (previously all zeros,
  // which could not distinguish "provider reported zero" from "not tested").
  const input = 120 * seq + 40;
  const output = 30 * seq + 10;
  return {
    type: 'response.completed',
    response: {
      id: responseId,
      usage: {
        input_tokens: input,
        input_tokens_details: null,
        output_tokens: output,
        output_tokens_details: null,
        total_tokens: input + output,
      },
    },
  };
}

function messageSse(responseId, text, sequence) {
  return sse([
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.done',
      item: {
        type: 'message', role: 'assistant', id: `message-${responseId}`,
        content: [{ type: 'output_text', text }],
      },
    },
    completed(responseId, sequence),
  ]);
}

function approvalSse(responseId, callId, sequence) {
  // The command writes only inside the product-selected fixture cwd. Asking
  // for elevated sandbox permission makes the real Kernel surface its native
  // approval before it executes; no network call is involved.
  const command = [
    "$fixture = Join-Path (Get-Location) 'knorvia-fixture-approved.txt'",
    "Set-Content -LiteralPath $fixture -Value 'approved by Knorvia fixture'",
  ].join('; ');
  return sse([
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call', name: 'exec_command', call_id: callId,
        arguments: JSON.stringify({
          cmd: command,
          justification: 'Allow the isolated Knorvia test file write?',
          sandbox_permissions: 'require_escalated',
        }),
      },
    },
    completed(responseId, sequence),
  ]);
}

function cwdProbeSse(responseId, callId, sequence) {
  // Writes a cwd-relative probe file through the real Kernel sandbox so a
  // caller can observe which directory a projectless thread actually runs in.
  const command = "Set-Content -LiteralPath (Join-Path (Get-Location) 'knorvia-cwd-probe.txt') -Value 'cwd probe'";
  return sse([
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'exec_command', call_id: callId, arguments: JSON.stringify({ cmd: command }) },
    },
    completed(responseId, sequence),
  ]);
}

function spawnTwoSse(responseId, sequence) {
  const spawn = (callId, marker, file) => ({
    type: 'response.output_item.done',
    item: {
      type: 'function_call', name: 'multi_agent_v1.spawn_agent', call_id: callId,
      arguments: JSON.stringify({
        message: `[${marker}] Create a file named ${file} in your current working directory containing "${marker} was here", then report a final message that includes the exact text "${marker} done".`,
        fork_context: false,
      }),
    },
  });
  return sse([
    { type: 'response.created', response: { id: responseId } },
    spawn('fixture-spawn-alpha', 'knorvia-sub-alpha', 'alpha-probe.txt'),
    spawn('fixture-spawn-beta', 'knorvia-sub-beta', 'beta-probe.txt'),
    completed(responseId, sequence),
  ]);
}

function subAgentSse(responseId, callId, file, marker, sequence) {
  const command = `Set-Content -LiteralPath (Join-Path (Get-Location) '${file}') -Value '${marker} was here'`;
  return sse([
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'exec_command', call_id: callId, arguments: JSON.stringify({ cmd: command }) },
    },
    completed(responseId, sequence),
  ]);
}

function spawnWaitSse(responseId, callId, agentIds, sequence) {
  return sse([
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call', name: 'multi_agent_v1.wait_agent', call_id: callId,
        arguments: JSON.stringify({ targets: agentIds, timeout_ms: 60000 }),
      },
    },
    completed(responseId, sequence),
  ]);
}

function userInputSse(responseId, callId, sequence) {
  return sse([
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call', name: 'request_user_input', call_id: callId,
        arguments: JSON.stringify({
          questions: [{
            id: 'mode',
            header: 'Mode',
            question: 'Choose mode',
            options: [
              { label: 'Safe (Recommended)', description: 'Use the isolated safe mode.' },
              { label: 'Fast', description: 'Use the faster mode.' },
            ],
          }],
        }),
      },
    },
    completed(responseId, sequence),
  ]);
}

function librarySse(responseId, callId, sequence) {
  // Execute actual file-library operations through the real Kernel. All paths
  // are fixed test files in the dedicated fixture library, never user assets.
  const script = "(async()=>{const p=require('node:path');if(!process.cwd().includes('isolated-home')||p.basename(process.cwd())!=='personal-library')throw Error('isolated library required');const l=require('./.knorvia-library/tools/personal-library.js').createPersonalLibrary({home:p.dirname(process.cwd())});const h=l.handlers;const list=await h['library/list']();const entry=list.entries.find(e=>e.path==='agent-edit.md'&&!e.trashedAt);await h['library/write']({path:'agent-created.md',text:'created by actual Kernel'});await h['library/write']({path:'agent-edit.md',text:'edited by actual Kernel',expectedSha256:entry.sha256});await h['library/trash']({path:'agent-remove.md'});console.log('library kernel operations completed')})().catch(e=>{console.error(e);process.exitCode=1})";
  const cmd = `& '${process.execPath.replaceAll("'", "''")}' -e '${script.replaceAll("'", "''")}'`;
  return sse([{ type: 'response.created', response: { id: responseId } }, { type: 'response.output_item.done', item: { type: 'function_call', name: 'exec_command', call_id: callId, arguments: JSON.stringify({ cmd }) } }, completed(responseId)]);
}

function readRequestText(request, limit = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('fixture request is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', reject);
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function writeJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(body.length),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function currentInputText(body) {
  try {
    const parsed = JSON.parse(body);
    const input = parsed?.input;
    if (Array.isArray(input)) return JSON.stringify(input.at(-1) || {});
    return JSON.stringify(input || {});
  } catch {
    return body;
  }
}

function requestedModel(body) {
  try {
    const model = JSON.parse(body)?.model;
    return typeof model === 'string' ? model : undefined;
  } catch {
    return undefined;
  }
}

function requestedTools(body) {
  try {
    const tools = JSON.parse(body)?.tools;
    if (!Array.isArray(tools)) return undefined;
    return tools.map((tool) => {
      if (typeof tool?.name === 'string') {
        return tool.type === 'namespace' ? `${tool.name}.*` : tool.name;
      }
      if (tool?.namespace && typeof tool.namespace?.name === 'string') return `${tool.namespace.name}.*`;
      if (typeof tool?.type === 'string') return tool.type;
      return typeof tool;
    });
  } catch {
    return undefined;
  }
}

function inputSummary(body) {
  try {
    const input = JSON.parse(body)?.input;
    const entries = Array.isArray(input) ? input : input ? [input] : [];
    return entries.slice(-8).map((entry) => {
      if (!entry || typeof entry !== 'object') return { type: typeof entry };
      const output = typeof entry.output === 'string' ? entry.output : undefined;
      return {
        type: typeof entry.type === 'string' ? entry.type : undefined,
        name: typeof entry.name === 'string' ? entry.name : undefined,
        callId: typeof entry.call_id === 'string' ? entry.call_id : undefined,
        outputBytes: output === undefined ? undefined : Buffer.byteLength(output, 'utf8'),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Start a loopback-only scripted Responses API.
 *
 * `[approval]` returns an exec_command that writes a fixture file only after
 * the real Kernel approval decision. `[user-input]` invokes the real
 * request_user_input bridge. `[slow]` sends response.created and holds the
 * actual SSE response open for cancellation/steer QA. All other turns receive
 * a short durable assistant message.
 */
async function startScriptedResponsesFixture({
  host = '127.0.0.1',
  port = 0,
  slowDelayMs = DEFAULT_SLOW_DELAY_MS,
  expectedApiKey,
  onRequest,
} = {}) {
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error('scripted Responses fixture may bind only a loopback host');
  }
  if (!Number.isSafeInteger(slowDelayMs) || slowDelayMs < 1) {
    throw new Error('slowDelayMs must be a positive integer');
  }

  let sequence = 0;
  let started = false;
  const requests = [];
  const slowResponses = new Set();

  function releaseSlowTurns() {
    let released = 0;
    for (const pending of [...slowResponses]) {
      slowResponses.delete(pending);
      clearTimeout(pending.timer);
      if (!pending.response.destroyed && !pending.response.writableEnded) {
        pending.response.end(messageSse(pending.responseId, 'slow fixture released', 0));
      }
      released += 1;
    }
    return released;
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://knorvia.fixture');
    if (request.method === 'GET' && url.pathname === STATUS_PATH) {
      writeJson(response, 200, {
        ok: true,
        requests: requests.map(({ bodyBytes, kind, responseId }) => ({ bodyBytes, kind, responseId })),
        slowPending: slowResponses.size,
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === RELEASE_SLOW_PATH) {
      writeJson(response, 200, { released: releaseSlowTurns() });
      return;
    }
    if (request.method !== 'POST' || url.pathname !== RESPONSES_PATH) {
      writeJson(response, 404, { error: 'not_found' });
      return;
    }
    if (expectedApiKey && request.headers.authorization !== `Bearer ${expectedApiKey}`) {
      writeJson(response, 401, { error: 'fixture_key_mismatch' });
      return;
    }

    let body;
    try {
      body = await readRequestText(request);
      onRequest?.(body);
    } catch (error) {
      if (!response.destroyed) writeJson(response, 413, { error: error.message });
      return;
    }
    const responseId = `fixture-response-${++sequence}`;
    const input = currentInputText(body);
    // A continuation includes the prior call id even when the App Server
    // serializes its answer in a provider-specific input item rather than a
    // literal `function_call_output` object.
    const hasToolOutput = input.includes('function_call_output')
      || input.includes('fixture-approval-')
      || body.includes('fixture-user-input-') || input.includes('fixture-library-')
      || input.includes('fixture-spawn-alpha') || input.includes('fixture-spawn-beta');
    const spawnOutputs = [...body.matchAll(/"agent_id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
    const kind = input.includes('[approval]') && !hasToolOutput
      ? 'approval'
      : input.includes('[user-input]') && !hasToolOutput
        ? 'user-input'
      : input.includes('[cwd-probe]') && !hasToolOutput
        ? 'cwd-probe'
      : input.includes('[spawn-two]') && !hasToolOutput
        ? 'spawn-two'
      : input.includes('[knorvia-sub-alpha]') && !hasToolOutput
        ? 'sub-alpha'
      : input.includes('[knorvia-sub-beta]') && !hasToolOutput
        ? 'sub-beta'
      : body.includes('[spawn-two]') && hasToolOutput && spawnOutputs.length >= 2 && !body.includes('wait_agent')
        ? 'spawn-wait'
      : input.includes('[slow]') && !hasToolOutput
        ? 'slow'
      : input.includes('[library-write]') && !hasToolOutput ? 'library' : 'message';
    {
      const dumpDir = process.env.KNORVIA_FIXTURE_DUMP_DIR;
      if (dumpDir) {
        try {
          require('node:fs').mkdirSync(dumpDir, { recursive: true });
          require('node:fs').writeFileSync(
            require('node:path').join(dumpDir, `request-${String(sequence).padStart(3, '0')}-${kind}.json`),
            body,
          );
        } catch { /* diagnostics only */ }
      }
    }
    requests.push({
      at: new Date().toISOString(),
      bodyBytes: Buffer.byteLength(body, 'utf8'),
      input: inputSummary(body),
      kind,
      model: requestedModel(body),
      reasoning: JSON.parse(body).reasoning ?? null,
      tools: requestedTools(body),
      responseId,
      spawnOutputs,
    });

    if (kind === 'library') {
      response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' });
      response.end(librarySse(responseId, `fixture-library-${sequence}`, sequence)); return;
    }
    if (kind === 'approval') {
      response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' });
      response.end(approvalSse(responseId, `fixture-approval-${sequence}`, sequence));
      return;
    }
    if (kind === 'cwd-probe') {
      response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' });
      response.end(cwdProbeSse(responseId, `fixture-cwd-probe-${sequence}`, sequence));
      return;
    }
    if (kind === 'spawn-two') {
      response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' });
      response.end(spawnTwoSse(responseId, sequence));
      return;
    }
    if (kind === 'sub-alpha') {
      response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' });
      response.end(subAgentSse(responseId, `fixture-sub-alpha-${sequence}`, 'alpha-probe.txt', 'knorvia-sub-alpha', sequence));
      return;
    }
    if (kind === 'sub-beta') {
      response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' });
      response.end(subAgentSse(responseId, `fixture-sub-beta-${sequence}`, 'beta-probe.txt', 'knorvia-sub-beta', sequence));
      return;
    }
    if (kind === 'spawn-wait') {
      response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' });
      response.end(spawnWaitSse(responseId, `fixture-spawn-wait-${sequence}`, spawnOutputs, sequence));
      return;
    }
    if (kind === 'user-input') {
      response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' });
      response.end(userInputSse(responseId, `fixture-user-input-${sequence}`, sequence));
      return;
    }
    if (kind === 'slow') {
      response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' });
      response.write(sse([{ type: 'response.created', response: { id: responseId } }]));
      const pending = { response, responseId, timer: null };
      const finish = () => {
        if (!slowResponses.delete(pending)) return;
        clearTimeout(pending.timer);
        if (!response.destroyed && !response.writableEnded) {
          response.end(messageSse(responseId, 'slow fixture completed', sequence));
        }
      };
      pending.timer = setTimeout(finish, slowDelayMs);
      slowResponses.add(pending);
      response.once('close', () => {
        clearTimeout(pending.timer);
        slowResponses.delete(pending);
      });
      return;
    }

    const text = input.includes('fixture-approval-')
      ? 'approval fixture completed; inspect knorvia-fixture-approved.txt in the selected workspace'
      : input.includes('fixture-user-input-') || body.includes('fixture-user-input-')
        ? 'user input fixture completed'
        : body.includes('[knorvia-sub-alpha]')
          ? 'knorvia-sub-alpha done: file written'
          : body.includes('[knorvia-sub-beta]')
            ? 'knorvia-sub-beta done: file written'
            : body.includes('[spawn-two]') && input.includes('wait_agent')
              ? 'both sub-agents reported completion'
              : 'scripted native fixture response';
    response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' });
    response.end(messageSse(responseId, text, sequence));
  });

  server.listen(port, host);
  await once(server, 'listening');
  started = true;
  const address = server.address();
  const boundHost = typeof address === 'object' && address ? address.address : host;
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const hostForUrl = String(boundHost).includes(':') ? `[${boundHost}]` : boundHost;
  const baseUrl = `http://${hostForUrl}:${boundPort}/v1`;

  return {
    baseUrl,
    controlUrl: `http://${hostForUrl}:${boundPort}`,
    providerEnv: {
      KNORVIA_TEST_DISABLE_PLUGIN_SYNC: '1',
      KNORVIA_KERNEL_TURN_TIMEOUT_SECS: '90',
      KNORVIA_PROVIDER_API_KEY: 'local-fixture-only',
      KNORVIA_PROVIDER_BASE_URL: baseUrl,
      KNORVIA_PROVIDER_MODEL: FIXTURE_MODEL,
    },
    releaseSlowTurns,
    requests,
    async close() {
      releaseSlowTurns();
      server.closeAllConnections?.();
      if (started) await new Promise((resolve) => server.close(() => resolve()));
      started = false;
    },
  };
}

module.exports = {
  DEFAULT_SLOW_DELAY_MS,
  FIXTURE_MODEL,
  RELEASE_SLOW_PATH,
  RESPONSES_PATH,
  STATUS_PATH,
  currentInputText,
  inputSummary,
  requestedModel,
  userInputSse,
  startScriptedResponsesFixture,
};
