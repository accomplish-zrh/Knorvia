'use strict';

// Local behavior tests for the studio MCP endpoint the Kernel talks to.
// Everything runs against the in-process HTTP server on loopback.
const assert = require('node:assert/strict');
const test = require('node:test');
const { createStudioMcp, TOOLS } = require('../studio-mcp');
const { createPersonalLibrary } = require('../personal-library');
const { createLearningPack } = require('../learning-pack');
const { createCuratedCatalog } = require('../curated-catalog');
const fs = require('node:fs');
const path = require('node:path');

async function call(url, token, message, { headers = {}, method = 'POST' } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: message === undefined ? undefined : JSON.stringify(message),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

function fakeStudio({ profiles = [], failWith } = {}) {
  const calls = [];
  const profilesMap = new Map(profiles.map(p => [p.id, p]));
  const error = failWith ?? (() => { throw new Error('ENOENT: no such file or directory, open C:\\Users\\secret\\path\\file.png'); });
  return {
    calls,
    profiles: { get: id => { const p = profilesMap.get(id); if (!p) { const e = new Error('Model connection not found'); e.rpc = { code: -32602, message: 'Model connection not found' }; throw e; } return p; } },
    create: async params => { calls.push(['create', params]); return { id: 'job-1', status: 'running' }; },
    handlers: {
      'studio/models': async () => { calls.push(['models']); return { profiles: [] }; },
      'studio/read': async params => { calls.push(['read', params]); if (failWith) error(); return { id: params.id, status: 'running' }; },
      'studio/cancel': async params => { calls.push(['cancel', params]); return { id: params.id, status: 'cancelled' }; },
      'studio/library': async params => { calls.push(['library', params]); if (failWith) error(); return { path: '创作/x.png' }; },
    },
  };
}

test('tools/list exposes generation, status, cancel, save and references tools', async () => {
  const names = TOOLS.map(tool => tool.name);
  assert.deepEqual(names.sort(), ['article_video', 'imagegen', 'media_cancel', 'media_canvas', 'media_edit', 'media_extract_frame', 'media_models', 'media_references', 'media_retake', 'media_save', 'media_sequence_control', 'media_sequence_create', 'media_sequence_status', 'media_status', 'media_subtitles', 'media_templates', 'pet_create', 'pet_status', 'videogen'].sort());
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown arguments`);
  }
  const imagegen = TOOLS.find(tool => tool.name === 'imagegen');
  assert.deepEqual(imagegen.inputSchema.required, ['profileId', 'prompt', 'idempotencyKey']);
});

test('the endpoint rejects wrong paths, missing bearer tokens and browser origins', async () => {
  const { env, close } = await createStudioMcp({ getStudio: () => null, getLibrary: () => null });
  try {
    assert.equal((await call(env.KNORVIA_STUDIO_MCP_URL.replace('/mcp', '/other'), env.KNORVIA_STUDIO_MCP_TOKEN, {})).status, 403);
    assert.equal((await call(env.KNORVIA_STUDIO_MCP_URL, 'wrong-token', {})).status, 403);
    assert.equal((await call(env.KNORVIA_STUDIO_MCP_URL, null, {})).status, 403);
    assert.equal((await call(env.KNORVIA_STUDIO_MCP_URL, env.KNORVIA_STUDIO_MCP_TOKEN, {}, { headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await call(env.KNORVIA_STUDIO_MCP_URL, env.KNORVIA_STUDIO_MCP_TOKEN, undefined, { method: 'GET' })).status, 405);
  } finally { await close(); }
});

test('Agent edits use the same native project revision and export request', async () => {
  const seen = [];
  const studio = { handlers: Object.fromEntries(['create', 'update', 'export', 'render/read', 'render/cancel'].map(method => [`studio/edit/${method}`, async p => { seen.push({ method, p }); return { id: p.id || 'project-1' }; }])) };
  const server = await createStudioMcp({ getStudio: () => studio });
  try {
    for (const action of ['create', 'update', 'export', 'status', 'cancel']) {
      const result = await call(server.env.KNORVIA_STUDIO_MCP_URL, server.env.KNORVIA_STUDIO_MCP_TOKEN, { id: action, method: 'tools/call', params: { name: 'media_edit', arguments: { action, id: 'project-1', revision: 4, idempotencyKey: 'same-request' } } });
      assert.equal(result.json.result.isError, false);
    }
    assert.deepEqual(seen.map(s => s.method), ['create', 'update', 'export', 'render/read', 'render/cancel']);
    assert.equal(seen[2].p.revision, 4); assert.equal(seen[2].p.idempotencyKey, 'same-request');
  } finally { await server.close(); }
});

test('subtitle and retake tools preserve revisions and force agent permissions', async () => {
  const seen = [];
  const studio = { handlers: { 'studio/edit/subtitles/start': async p => { seen.push(p); return { id: 'subtitle' }; }, 'studio/edit/retake/start': async p => { seen.push(p); return { id: 'retake' }; } } };
  const server = await createStudioMcp({ getStudio: () => studio });
  try {
    for (const name of ['media_subtitles', 'media_retake']) {
      const result = await call(server.env.KNORVIA_STUDIO_MCP_URL, server.env.KNORVIA_STUDIO_MCP_TOKEN, { id: name, method: 'tools/call', params: { name, arguments: { action: 'start', id: 'project', revision: 7, idempotencyKey: 'stable' } } });
      assert.equal(result.json.result.isError, false);
    }
    assert.equal(seen[0].revision, 7); assert.equal(seen[1].agentRequested, true); assert.equal(seen[1].idempotencyKey, 'stable');
    assert.equal(TOOLS.find(t => t.name === 'media_subtitles').inputSchema.properties.executable, undefined);
  } finally { await server.close(); }
});

test('media_canvas tool exposes list, create, read, save and generate with agentRequested', async () => {
  const seen = [];
  const studio = {
    handlers: {
      'studio/canvas/list': async p => { seen.push(['list', p]); return { items: [] }; },
      'studio/canvas/create': async p => { seen.push(['create', p]); return { id: 'c1', revision: 1 }; },
      'studio/canvas/read': async p => { seen.push(['read', p]); return { id: p.id, revision: 1 }; },
      'studio/canvas/save': async p => { seen.push(['save', p]); return { id: p.id, revision: 2 }; },
      'studio/canvas/generate': async p => { seen.push(['generate', p]); return { ok: true, node: { id: p.nodeId, jobId: 'job-1' } }; },
    },
  };
  const server = await createStudioMcp({ getStudio: () => studio });
  try {
    for (const [action, args] of [
      ['list', { query: 'test' }],
      ['create', { name: 'Canvas 1' }],
      ['read', { id: 'c1' }],
      ['save', { id: 'c1', expectedRevision: 1, name: 'Canvas 2' }],
      ['generate', { id: 'c1', nodeId: 'node-1', idempotencyKey: 'idemp-1' }],
    ]) {
      const result = await call(server.env.KNORVIA_STUDIO_MCP_URL, server.env.KNORVIA_STUDIO_MCP_TOKEN, {
        id: action,
        method: 'tools/call',
        params: { name: 'media_canvas', arguments: { action, ...args } },
      });
      assert.equal(result.json.result.isError, false, `action ${action} failed: ${result.json.result?.content?.[0]?.text}`);
    }
    assert.equal(seen.length, 5);
    assert.deepEqual(seen[0], ['list', { query: 'test' }]);
    assert.deepEqual(seen[1], ['create', { name: 'Canvas 1' }]);
    assert.deepEqual(seen[2], ['read', { id: 'c1' }]);
    assert.deepEqual(seen[3], ['save', { id: 'c1', expectedRevision: 1, name: 'Canvas 2' }]);
    assert.deepEqual(seen[4], ['generate', { id: 'c1', nodeId: 'node-1', idempotencyKey: 'idemp-1', agentRequested: true }]);
  } finally { await server.close(); }
});

test('malformed envelopes are rejected without touching the studio', async () => {
  const studio = fakeStudio();
  const { env, close } = await createStudioMcp({ getStudio: () => studio, getLibrary: () => null });
  try {
    const tooBig = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { blob: 'x'.repeat(4 * 1024 * 1024) } });
    const big = await fetch(env.KNORVIA_STUDIO_MCP_URL, { method: 'POST', headers: { authorization: `Bearer ${env.KNORVIA_STUDIO_MCP_TOKEN}` }, body: tooBig });
    assert.equal(big.status, 413);
    const invalid = await fetch(env.KNORVIA_STUDIO_MCP_URL, { method: 'POST', headers: { authorization: `Bearer ${env.KNORVIA_STUDIO_MCP_TOKEN}` }, body: '{broken' });
    assert.equal(invalid.status, 400);
    assert.equal(studio.calls.length, 0);
  } finally { await close(); }
});

test('initialize, ping and tools/list answer; notifications are accepted', async () => {
  const { env, close } = await createStudioMcp({ getStudio: () => fakeStudio(), getLibrary: () => null });
  try {
    const init = await call(env.KNORVIA_STUDIO_MCP_URL, env.KNORVIA_STUDIO_MCP_TOKEN, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(init.json.result.protocolVersion, '2024-11-05');
    assert.equal(init.json.result.serverInfo.name, 'knorvia-media');
    const ping = await call(env.KNORVIA_STUDIO_MCP_URL, env.KNORVIA_STUDIO_MCP_TOKEN, { jsonrpc: '2.0', id: 2, method: 'ping' });
    assert.deepEqual(ping.json.result, {});
    const list = await call(env.KNORVIA_STUDIO_MCP_URL, env.KNORVIA_STUDIO_MCP_TOKEN, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.equal(list.json.result.tools.length, TOOLS.length);
    const notification = await call(env.KNORVIA_STUDIO_MCP_URL, env.KNORVIA_STUDIO_MCP_TOKEN, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notification.status, 202);
    const unknown = await call(env.KNORVIA_STUDIO_MCP_URL, env.KNORVIA_STUDIO_MCP_TOKEN, { jsonrpc: '2.0', id: 4, method: 'resources/list' });
    assert.equal(unknown.json.error.code, -32601);
  } finally { await close(); }
});

test('imagegen requires a kind-matching, agent-enabled route into the same studio service', async () => {
  const studio = fakeStudio({ profiles: [{ id: 'p-img', kind: 'image', agentEnabled: true }, { id: 'p-vid', kind: 'video', agentEnabled: true }] });
  const { env, close } = await createStudioMcp({ getStudio: () => studio, getLibrary: () => null });
  try {
    const ok = await call(env.KNORVIA_STUDIO_MCP_URL, env.KNORVIA_STUDIO_MCP_TOKEN, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'imagegen', arguments: { profileId: 'p-img', prompt: 'a red cube', idempotencyKey: 'agent-tok-1' } },
    });
    assert.equal(ok.json.result.isError, false);
    assert.deepEqual(JSON.parse(ok.json.result.content[0].text), { id: 'job-1', status: 'running' });
    assert.deepEqual(studio.calls[0], ['create', { profileId: 'p-img', prompt: 'a red cube', idempotencyKey: 'agent-tok-1' }]);

    const mismatch = await call(env.KNORVIA_STUDIO_MCP_URL, env.KNORVIA_STUDIO_MCP_TOKEN, {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'videogen', arguments: { profileId: 'p-img', prompt: 'p', idempotencyKey: 't' } },
    });
    assert.equal(mismatch.json.result.isError, true);
    assert.equal(mismatch.json.result.content[0].text, 'Choose a matching media model');
  } finally { await close(); }
});

test('unexpected handler failures are sanitized and never leak local paths', async () => {
  const studio = fakeStudio({ failWith: true });
  const { env, close } = await createStudioMcp({ getStudio: () => studio, getLibrary: () => null });
  try {
    const leak = await call(env.KNORVIA_STUDIO_MCP_URL, env.KNORVIA_STUDIO_MCP_TOKEN, {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'media_save', arguments: { id: 'job-9' } },
    });
    assert.equal(leak.json.result.isError, true);
    assert.match(leak.json.result.content[0].text, /failed unexpectedly/);
    assert.doesNotMatch(leak.json.result.content[0].text, /secret/);
    assert.doesNotMatch(leak.json.result.content[0].text, /ENOENT/);
  } finally { await close(); }
});

test('rpc-typed failures keep their user-facing wording', async () => {
  const studio = fakeStudio();
  const { env, close } = await createStudioMcp({ getStudio: () => studio, getLibrary: () => null });
  try {
    const missing = await call(env.KNORVIA_STUDIO_MCP_URL, env.KNORVIA_STUDIO_MCP_TOKEN, {
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'imagegen', arguments: { profileId: 'does-not-exist', prompt: 'p', idempotencyKey: 't' } },
    });
    assert.equal(missing.json.result.isError, true);
    assert.equal(missing.json.result.content[0].text, 'Model connection not found');
  } finally { await close(); }
});

test('media_references only lists non-trashed images with pinned versions', async () => {
  const library = {
    handlers: {
      'library/list': async () => ({ entries: [
        { id: 'a', name: 'photo.PNG', sha256: 'a'.repeat(64), trashedAt: null },
        { id: 'b', name: 'notes.txt', sha256: 'b'.repeat(64), trashedAt: null },
        { id: 'c', name: 'clip.mp4', sha256: 'c'.repeat(64), trashedAt: null },
        { id: 'd', name: 'old.png', sha256: 'd'.repeat(64), trashedAt: '2026-09-06T00:00:00Z' },
      ] }),
    },
  };
  const { env, close } = await createStudioMcp({ getStudio: () => fakeStudio(), getLibrary: () => library });
  try {
    const refs = await call(env.KNORVIA_STUDIO_MCP_URL, env.KNORVIA_STUDIO_MCP_TOKEN, {
      jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'media_references', arguments: {} },
    });
    const listed = JSON.parse(refs.json.result.content[0].text);
    assert.deepEqual(listed, [{ id: 'a', name: 'photo.PNG', version: 'a'.repeat(64) }]);
  } finally { await close(); }
});

test('closing the MCP endpoint twice is idempotent', async () => {
  const { close } = await createStudioMcp({ getStudio: () => fakeStudio(), getLibrary: () => null });
  await close();
  await close();
});

test('learning and catalog packs opt into the Kernel tool surface', async () => {
  const os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-packs-'));
  const library = createPersonalLibrary({ home });
  const learning = createLearningPack({ home, library });
  const catalog = createCuratedCatalog({ home, library, studio: null });
  const server = await createStudioMcp({ getStudio: () => null, getLibrary: () => library, getLearning: () => learning, getCatalog: () => catalog });
  try {
    const call = async message => {
      const response = await fetch(server.env.KNORVIA_STUDIO_MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${server.env.KNORVIA_STUDIO_MCP_TOKEN}` }, body: JSON.stringify(message) });
      return (await response.json()).result;
    };
    const list = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const names = list.tools.map(tool => tool.name);
    for (const expected of ['learning_sources', 'learning_lecture', 'learning_quiz', 'learning_review', 'catalog_list', 'catalog_preflight']) {
      assert.ok(names.includes(expected), expected);
      assert.equal(list.tools.find(tool => tool.name === expected).inputSchema.additionalProperties, false);
    }
    const sources = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'learning_sources', arguments: {} } });
    assert.equal(sources.isError, false);
    assert.deepEqual(JSON.parse(sources.content[0].text), { sources: [] });
    const mediaOnly = await createStudioMcp({ getStudio: () => null, getLibrary: () => null });
    try {
      const plain = await fetch(mediaOnly.env.KNORVIA_STUDIO_MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${mediaOnly.env.KNORVIA_STUDIO_MCP_TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }) });
      const plainTools = (await plain.json()).result.tools.map(tool => tool.name);
      assert.equal(plainTools.includes('learning_sources'), false, 'packs stay out unless the host opts in');
    } finally { await mediaOnly.close(); }
  } finally { await server.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
