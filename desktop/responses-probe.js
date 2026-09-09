'use strict';

// A deliberately tiny, user-triggered protocol probe. It is not a model
// runner: one bounded POST confirms that a custom endpoint accepted the saved
// model/base URL/key, with no redirects and no provider response copied back.

const http = require('http');
const https = require('https');
const { normalizeProtocol } = require('./connection-config');

const PROBE_TIMEOUT_MS = 10_000;
const MAX_PROBE_RESPONSE_BYTES = 16 * 1024;

function isCustomResponsesEndpoint(baseUrl) {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    // The product deliberately does not turn a settings click into a paid
    // probe of the default OpenAI service. A user can test a configured custom
    // Responses-compatible endpoint (including a local fixture) explicitly.
    return !host.endsWith('.openai.com') && host !== 'openai.com';
  } catch {
    return false;
  }
}

function responsesEndpoint(baseUrl, protocol = 'responses') {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const suffix = { responses: 'responses', 'chat-completions': 'chat/completions', 'anthropic-messages': 'messages' }[normalizeProtocol(protocol)];
  const target = base.pathname.replace(/\/$/, '').endsWith(`/${suffix}`)
    ? new URL(base.toString().replace(/\/$/, '')) : new URL(suffix, base);
  if (!['http:', 'https:'].includes(target.protocol)
    || target.username || target.password || target.search || target.hash) {
    throw new Error('invalid Responses endpoint');
  }
  return target;
}

function safeProbeFailure(message, status) {
  return {
    ok: false,
    message,
    providerVerified: false,
    ...(Number.isInteger(status) ? { status } : {}),
  };
}

function validProbeResponse(body, protocol) {
  const valid = value => {
    if (!value || typeof value !== 'object' || value.error) return false;
    if (protocol === 'chat-completions') return typeof value.id === 'string' && Array.isArray(value.choices) && value.choices.some(choice => choice?.message && typeof choice.message.content === 'string');
    if (protocol === 'anthropic-messages') return value.type === 'message' && typeof value.id === 'string' && Array.isArray(value.content) && value.content.some(part => part?.type === 'text' && typeof part.text === 'string');
    return typeof value.id === 'string' && Array.isArray(value.output) && ['completed', 'incomplete'].includes(value.status);
  };
  try { return valid(JSON.parse(body)); } catch {}
  // Some compatible providers stream despite stream:false. Require an actual
  // completed Responses event; an HTTP 200 HTML page is not a working model.
  if (protocol !== 'responses') return false;
  return body.split(/\r?\n/).some(line => {
    if (!line.startsWith('data:')) return false;
    try { const value = JSON.parse(line.slice(5).trim()); return value.type === 'response.completed' && typeof value.response?.id === 'string' && !value.response.error; } catch { return false; }
  });
}

function probeResponsesEndpoint({ model, baseUrl, apiKey, protocol = 'responses', timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (typeof model !== 'string' || !model || typeof baseUrl !== 'string' || !baseUrl || typeof apiKey !== 'string' || !apiKey) {
    return Promise.resolve(safeProbeFailure('The model connection is incomplete'));
  }
  if (!isCustomResponsesEndpoint(baseUrl)) {
    return Promise.resolve(safeProbeFailure('Provider probing is supported only for a custom Responses endpoint'));
  }
  let endpoint;
  try {
    protocol = normalizeProtocol(protocol);
    endpoint = responsesEndpoint(baseUrl, protocol);
  } catch {
    return Promise.resolve(safeProbeFailure('The configured Responses endpoint is invalid'));
  }
  const body = JSON.stringify(protocol === 'responses' ? {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly OK.' }] }],
    max_output_tokens: 8,
    stream: false,
    store: false,
  } : {
    model, messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
    max_tokens: 8, stream: false,
  });
  const transport = endpoint.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const request = transport.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port || undefined,
      path: `${endpoint.pathname}${endpoint.search}`,
      method: 'POST',
      // Node's core clients do not follow redirects. Keeping it explicit in
      // both behavior and result prevents credentials crossing a new origin.
      headers: {
        ...(protocol === 'anthropic-messages'
          ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
          : { authorization: `Bearer ${apiKey}` }),
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body, 'utf8')),
        accept: 'application/json, text/event-stream',
        connection: 'close',
      },
    }, (response) => {
      const status = Number(response.statusCode || 0);
      let bytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_PROBE_RESPONSE_BYTES) {
          try { request.destroy(); } catch {}
          finish(safeProbeFailure('The provider probe response exceeded its safety limit', status));
        } else chunks.push(Buffer.from(chunk));
      });
      response.once('error', () => finish(safeProbeFailure('The provider probe response could not be read', status)));
      response.once('end', () => {
        if (status >= 200 && status < 300) {
          if (!validProbeResponse(Buffer.concat(chunks).toString('utf8'), protocol)) {
            finish(safeProbeFailure('The endpoint returned an invalid model response for the selected protocol', status));
            return;
          }
          finish({
            ok: true,
            message: 'The configured model endpoint accepted the minimal test request.',
            providerVerified: true,
            status,
          });
        } else if (status >= 300 && status < 400) {
          finish(safeProbeFailure('The provider probe was redirected and was not followed', status));
        } else {
          // Deliberately omit response body and request details. Provider error
          // payloads can contain sensitive diagnostics or echoed headers.
          finish(safeProbeFailure('The custom Responses endpoint rejected the test request', status));
        }
      });
    });
    const timer = setTimeout(() => {
      try { request.destroy(); } catch {}
      finish(safeProbeFailure('The provider probe timed out'));
    }, Math.max(1_000, Math.min(PROBE_TIMEOUT_MS, Number(timeoutMs) || PROBE_TIMEOUT_MS)));
    timer.unref?.();
    request.once('error', () => finish(safeProbeFailure('The custom Responses endpoint could not be reached')));
    try { request.end(body); } catch { finish(safeProbeFailure('The custom Responses endpoint could not be reached')); }
  });
}

module.exports = {
  MAX_PROBE_RESPONSE_BYTES,
  PROBE_TIMEOUT_MS,
  isCustomResponsesEndpoint,
  probeResponsesEndpoint,
  responsesEndpoint,
};
