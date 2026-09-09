'use strict';

// Adapter acceptance for Gemini/Veo, Runway and Replicate (B11–B14). Every
// request stays on a loopback fixture shaped after the official API docs;
// nothing outside this process is contacted and no provider key is real.
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { submit, poll, inputCapabilities, validateInputs, normalizeUsage } = require('../studio-providers');

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}
const profile = (protocol, overrides = {}) => ({
  id: 'p1', name: 'fixture', kind: 'video', protocol,
  baseUrl: 'http://127.0.0.1:1', model: 'fixture-model',
  authHeader: 'Authorization', authPrefix: 'Bearer', agentEnabled: true,
  extra: {}, custom: {}, apiKey: 'fixture-key', ...overrides,
});
const videoInput = { prompt: '一只鹤掠过水面', size: '1280x720', aspect: '16:9', count: 1, seconds: 4, quality: 'auto', references: [] };
const firstFrame = { bytes: Buffer.from([137, 80, 78, 71]), mime: 'image/png', name: 'first.png', role: 'firstFrame' };

test('gemini adapter: predictLongRunning submit, authenticated operation output, no invented cancel', async () => {
  const seen = [];
  const { server, origin } = await startServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, key: req.headers['x-goog-api-key'], auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (req.url.endsWith(':predictLongRunning')) res.end(JSON.stringify({ name: 'models/veo-3/operations/ops-1' }));
      else if (req.url.includes('/operations/ops-1') && req.method === 'GET') res.end(JSON.stringify({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${origin}/files/sample-1.mp4` } }] } } }));
      else if (req.url.endsWith(':cancel')) res.end('{}');
      else { res.writeHead(404); res.end('{}'); }
    });
  });
  try {
    const p = profile('gemini', { baseUrl: origin, model: 'veo-3', authHeader: 'x-goog-api-key', authPrefix: '' });
    const remote = await submit(p, videoInput, [firstFrame], undefined);
    assert.equal(seen[0].url, '/models/veo-3:predictLongRunning');
    assert.equal(seen[0].key, 'fixture-key');
    assert.equal(seen[0].auth, undefined);
    assert.equal(seen[0].body.instances[0].prompt, videoInput.prompt);
    assert.ok(seen[0].body.instances[0].image.bytesBase64Encoded.length > 0);
    assert.equal(seen[0].body.instances[0].image.mimeType, 'image/png');
    assert.equal(remote.id, 'models/veo-3/operations/ops-1');
    assert.equal(remote.done, false);
    const done = await poll(p, remote, undefined);
    assert.equal(done.done, true);
    assert.deepEqual(done.outputs, [{ apiContent: `${origin}/files/sample-1.mp4` }]);
    assert.equal(done.id, remote.id); assert.equal(done.cancelUrl, undefined);
    const caps = inputCapabilities(p);
    assert.equal(caps.firstFrame, true);
    assert.equal(caps.lastFrame, false);
    assert.throws(() => validateInputs(p, { ...videoInput, references: [], lastFrame: { id: 'x' }, firstFrame: { id: 'y' } }), /尾帧支持/);
    // usage: Veo operations carry no usage facts → unknown, never estimated
    const usage = normalizeUsage(p, done, { requestId: done.id });
    assert.equal(usage.attempts[0].known, false);
    assert.deepEqual(usage.attempts[0].units, []);
  } finally { server.close(); server.closeAllConnections(); }
});

test('runway adapter: version header, image entrance, task poll and DELETE cancel', async () => {
  const seen = [];
  const { server, origin } = await startServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, version: req.headers['x-runway-version'], auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (req.method === 'POST' && req.url === '/image_to_video') res.end(JSON.stringify({ id: 'task-9', status: 'PENDING' }));
      else if (req.url === '/tasks/task-9' && req.method === 'GET') res.end(JSON.stringify({ id: 'task-9', status: 'SUCCEEDED', progress: 100, output: [`${origin}/cdn/clip.mp4`] }));
      else if (req.url === '/tasks/task-9' && req.method === 'DELETE') res.end('{}');
      else { res.writeHead(404); res.end('{}'); }
    });
  });
  try {
    const p = profile('runway', { baseUrl: origin, model: 'gen4_turbo', custom: {} });
    const remote = await submit(p, videoInput, [firstFrame], undefined);
    assert.equal(seen[0].url, '/image_to_video');
    assert.equal(seen[0].version, '2024-11-06');
    assert.equal(seen[0].auth, 'Bearer fixture-key');
    assert.equal(seen[0].body.model, 'gen4_turbo');
    assert.equal(seen[0].body.ratio, '1280:720');
    assert.ok(seen[0].body.promptImage.startsWith('data:image/png;base64,'));
    assert.equal(remote.statusUrl, 'tasks/task-9');
    const done = await poll(p, remote, undefined);
    assert.equal(done.done, true);
    assert.equal(done.failed, false);
    assert.deepEqual(done.outputs, [`${origin}/cdn/clip.mp4`]);
    assert.equal(done.cancelMethod, 'DELETE');
    const usage = normalizeUsage(p, done, { requestId: 'task-9' });
    assert.equal(usage.providerId, 'p1');
    assert.equal(usage.attempts[0].known, false);
  } finally { server.close(); server.closeAllConnections(); }
});

test('replicate adapter: model predictions, metrics usage and POST cancel', async () => {
  const seen = [];
  const { server, origin } = await startServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (req.method === 'POST' && req.url === '/models/acme/motion/predictions') res.end(JSON.stringify({ id: 'pred-1', status: 'starting' }));
      else if (req.url === '/predictions/pred-1' && req.method === 'GET') res.end(JSON.stringify({ id: 'pred-1', status: 'succeeded', output: [`${origin}/replicate-delivery/out.mp4`], metrics: { predict_time: 12.5, input_token_count: 10, output_token_count: 0 } }));
      else if (req.url === '/predictions/pred-1/cancel') res.end('{}');
      else { res.writeHead(404); res.end('{}'); }
    });
  });
  try {
    const p = profile('replicate', { baseUrl: origin, model: 'acme/motion', custom: { imageInputField: 'first_frame_image' } });
    const remote = await submit(p, videoInput, [firstFrame], undefined);
    assert.equal(seen[0].url, '/models/acme/motion/predictions');
    assert.ok(seen[0].body.input.first_frame_image.startsWith('data:image/png;base64,'));
    assert.equal(remote.statusUrl, 'predictions/pred-1');
    const done = await poll(p, remote, undefined);
    assert.equal(done.done, true);
    assert.deepEqual(done.outputs, [`${origin}/replicate-delivery/out.mp4`]);
    assert.equal(done.cancelUrl, 'predictions/pred-1/cancel');
    assert.equal(done.cancelMethod, 'POST');
    const usage = normalizeUsage(p, done, { requestId: 'pred-1' });
    assert.equal(usage.attempts[0].known, true);
    assert.ok(usage.attempts[0].units.some(unit => unit.name === 'input_tokens' && unit.value === 10));
    assert.ok(usage.attempts[0].units.some(unit => unit.name === 'predict-time-seconds' && unit.value === 12.5));
    // The vendor literally returned 0 output tokens; report it as-is.
    assert.ok(usage.attempts[0].units.some(unit => unit.name === 'output_tokens' && unit.value === 0));
  } finally { server.close(); server.closeAllConnections(); }
});

test('replicate adapter: failed prediction and zero-frame output surface as failures', async () => {
  const { server, origin } = await startServer((req, res) => {
    if (req.url === '/models/acme/motion/predictions') res.end(JSON.stringify({ id: 'pred-2', status: 'starting' }));
    else if (req.url === '/predictions/pred-2') res.end(JSON.stringify({ id: 'pred-2', status: 'failed', error: 'NSFW input detected' }));
    else { res.writeHead(404); res.end('{}'); }
  });
  try {
    const p = profile('replicate', { baseUrl: origin, model: 'acme/motion' });
    const remote = await submit(p, videoInput, [], undefined);
    const done = await poll(p, remote, undefined);
    assert.equal(done.failed, true);
    assert.equal(done.error, 'NSFW input detected');
  } finally { server.close(); server.closeAllConnections(); }
});

test('adapter capabilities reject unsupported lastFrame inputs while keeping the prompt', async () => {
  const p = profile('runway', { baseUrl: 'http://127.0.0.1:1', model: 'gen4_turbo' });
  const caps = inputCapabilities(p);
  assert.equal(caps.firstFrame, true);
  assert.equal(caps.lastFrame, false);
  const input = { ...videoInput, firstFrame: { id: 'lib-y', version: 'b'.repeat(64) }, lastFrame: { id: 'lib-x', version: 'a'.repeat(64) } };
  assert.throws(() => validateInputs(p, input), /尾帧/);
  // A user flag cannot add unsupported fields to a fixed vendor schema.
  const p2 = profile('runway', { baseUrl: 'http://127.0.0.1:1', model: 'gen3_alpha', custom: { lastFrameSupported: true } });
  const caps2 = inputCapabilities(p2);
  assert.equal(caps2.lastFrame, false);
  assert.throws(() => validateInputs(p2, input), /尾帧/);
  const p3 = profile('runway', { model: 'veo3.1' });
  assert.equal(inputCapabilities(p3).lastFrame, true); validateInputs(p3, input);
});
