'use strict';

// Local behavior tests for the studio provider adapter. All HTTP traffic stays
// on a loopback fixture server; no external or paid service is contacted.
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { request, submit, poll, createProfiles, inputCapabilities, validateInputs } = require('../studio-providers');

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

const profile = overrides => ({
  id: 'p1', name: 'fixture', kind: 'image', protocol: 'openai',
  baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-model',
  authHeader: 'Authorization', authPrefix: 'Bearer', agentEnabled: true,
  extra: {}, custom: {}, apiKey: 'fixture-key', ...overrides,
});

test('control requests carry credentials only to the configured origin', async () => {
  let seen;
  const { server, origin } = await startServer((req, res) => {
    seen = { auth: req.headers.authorization, url: req.url };
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const result = await request(profile({ baseUrl: `${origin}/v1` }), 'models');
    assert.equal(result.ok, true);
    assert.equal(seen.auth, 'Bearer fixture-key');
    assert.equal(seen.url, '/v1/models');
  } finally { server.close(); server.closeAllConnections(); }
});

test('control redirects are rejected instead of followed with credentials', async () => {
  const { server, origin } = await startServer((req, res) => {
    res.writeHead(302, { location: 'http://127.0.0.1:9/steal' });
    res.end();
  });
  try {
    await assert.rejects(
      () => request(profile({ baseUrl: `${origin}/v1` }), 'models'),
      /HTTP 302/,
    );
  } finally { server.close(); server.closeAllConnections(); }
});

test('control requests to another origin are refused before any connection', async () => {
  await assert.rejects(
    () => request(profile({ baseUrl: 'http://127.0.0.1:1/v1' }), 'http://127.0.0.1:2/v1/models'),
    /another origin/,
  );
});

test('output downloads follow redirects but never attach credentials', async () => {
  let redirectAuth; let finalAuth;
  const { server, origin } = await startServer((req, res) => {
    if (req.url === '/v1/files/1') {
      redirectAuth = req.headers.authorization ?? null;
      res.writeHead(302, { location: `${origin}/payload` });
      res.end();
      return;
    }
    finalAuth = req.headers.authorization ?? null;
    res.setHeader('content-type', 'image/png');
    res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]));
  });
  try {
    const { bytes, mime } = await request(profile({ baseUrl: `${origin}/v1` }), 'files/1', { binary: true, output: true });
    assert.equal(mime, 'image/png');
    assert.equal(bytes[0], 137);
    assert.equal(redirectAuth, null, 'redirect hop must not carry API credentials');
    assert.equal(finalAuth, null);
  } finally { server.close(); server.closeAllConnections(); }
});

test('an empty success body is an accepted cancel with emptyOk and unknown otherwise', async () => {
  const { server, origin } = await startServer((req, res) => { res.writeHead(200); res.end(); });
  try {
    assert.deepEqual(await request(profile({ baseUrl: `${origin}` }), 'cancel/1', { method: 'PUT', emptyOk: true }), {});
    await assert.rejects(
      () => request(profile({ baseUrl: `${origin}` }), 'cancel/1', { method: 'PUT' }),
      error => (assert.equal(error.uncertain, true), true),
    );
  } finally { server.close(); server.closeAllConnections(); }
});

test('oversized declared responses are rejected without buffering them', async () => {
  for (const options of [{}, { binary: true }]) {
    const { server, origin } = await startServer((req, res) => {
      res.writeHead(200, { 'content-length': String((options.binary ? 256 : 64) * 1024 * 1024 + 1) });
      res.end('x');
    });
    try {
      await assert.rejects(() => request(profile({ baseUrl: `${origin}` }), 'big', options), /size limit/);
    } finally { server.close(); server.closeAllConnections(); }
  }
});

test('interrupted requests are reported as unknown remote outcomes', async () => {
  const { server, origin } = await startServer((req, res) => {
    req.resume();
    req.on('end', () => req.socket.destroy());
  });
  try {
    await assert.rejects(
      () => request(profile({ baseUrl: `${origin}` }), 'submit', { method: 'POST', body: {} }),
      error => (assert.equal(error.uncertain, true), true),
    );
  } finally { server.close(); server.closeAllConnections(); }
});

test('openai image submit completes immediately and maps provider outputs', async () => {
  let seen;
  const { server, origin } = await startServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      seen = { url: req.url, body: JSON.parse(raw) };
      res.end(JSON.stringify({ data: [{ b64_json: 'x', url: 'http://127.0.0.1:1/a.png' }] }));
    });
  });
  try {
    const state = await submit(
      profile({ baseUrl: `${origin}/v1` }),
      { prompt: 'p', size: '64x64', count: 2, quality: 'high', seconds: 4, references: [] },
      [],
    );
    assert.equal(seen.url, '/v1/images/generations');
    assert.equal(seen.body.n, 2);
    assert.equal(seen.body.quality, 'high');
    assert.equal(seen.body.model, 'fixture-model');
    assert.equal(state.done, true);
    assert.deepEqual(state.outputs, [{ b64_json: 'x', url: 'http://127.0.0.1:1/a.png' }]);
  } finally { server.close(); server.closeAllConnections(); }
});

test('openai video submits, polls and reports content output on completion', async () => {
  const { server, origin } = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/videos') {
      res.end(JSON.stringify({ id: 'v9', status: 'queued', progress: 0 }));
      return;
    }
    if (req.url === '/v1/videos/v9') {
      res.end(JSON.stringify({ id: 'v9', status: 'completed', progress: 100 }));
      return;
    }
    if (req.url === '/v1/videos/v9/content') {
      res.setHeader('content-type', 'video/mp4');
      res.end(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]));
      return;
    }
    res.writeHead(404); res.end();
  });
  try {
    const p = profile({ baseUrl: `${origin}/v1`, kind: 'video', protocol: 'openai' });
    const submitted = await submit(p, { prompt: 'p', size: '1280x720', count: 1, quality: 'auto', seconds: 4, references: [] }, []);
    assert.equal(submitted.done, false);
    assert.equal(submitted.id, 'v9');
    const done = await poll(p, submitted);
    assert.equal(done.done, true);
    assert.deepEqual(done.outputs, [{ apiContent: 'videos/v9/content' }]);
  } finally { server.close(); server.closeAllConnections(); }
});

test('fal queue polls status then the result endpoint, and cancel accepts an empty body', async () => {
  let cancelled = false;
  const { server, origin } = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/fal-ai/fixture/video') {
      res.end(JSON.stringify({ request_id: 'r1', status: 'IN_PROGRESS', status_url: '/queue/r1', response_url: '/result/r1', cancel_url: '/queue/r1/cancel' }));
      return;
    }
    if (req.url === '/queue/r1') {
      res.end(JSON.stringify({ status: 'COMPLETED' }));
      return;
    }
    if (req.url === '/result/r1') {
      res.end(JSON.stringify({ video: { url: `${origin}/file.mp4` } }));
      return;
    }
    if (req.url === '/queue/r1/cancel') {
      cancelled = true;
      res.writeHead(200); res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
  try {
    const p = profile({ baseUrl: origin, kind: 'video', protocol: 'fal', model: 'fal-ai/fixture/video' });
    const submitted = await submit(p, { prompt: 'p', size: '1280x720', aspect: '16:9', count: 1, seconds: 4, references: [] }, []);
    assert.equal(submitted.id, 'r1');
    assert.equal(submitted.done, false);
    assert.equal(submitted.progress, 50);
    assert.equal(await request(p, submitted.cancelUrl, { method: 'PUT', emptyOk: true }) && cancelled, true);
    const done = await poll(p, submitted);
    assert.equal(done.done, true);
    assert.deepEqual(done.outputs, [{ url: `${origin}/file.mp4` }]);
  } finally { server.close(); server.closeAllConnections(); }
});

test('custom JSON protocol maps id/status/output paths and pins endpoints to the API origin', async () => {
  const { server, origin } = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/gen') {
      res.end(JSON.stringify({ job: { id: 'j7' }, status: 'RUNNING' }));
      return;
    }
    if (req.url === '/api/jobs/j7') {
      res.end(JSON.stringify({ job: { id: 'j7', pct: 80 }, status: 'DONE', result: { files: [{ url: `${origin}/f.png` }] } }));
      return;
    }
    res.writeHead(404); res.end();
  });
  try {
    const p = profile({
      baseUrl: `${origin}/api`, kind: 'image', protocol: 'json',
      custom: { createPath: 'gen', statusPathTemplate: 'jobs/{{id}}', successValues: ['DONE'], idPath: 'job.id', outputPath: 'result.files', progressPath: 'job.pct' },
    });
    const submitted = await submit(p, { prompt: 'p', size: '64x64', count: 1, quality: 'auto', seconds: 4, references: [] }, []);
    assert.equal(submitted.id, 'j7');
    assert.equal(submitted.statusUrl, 'jobs/j7');
    assert.equal(submitted.done, false);
    const done = await poll(p, submitted);
    assert.equal(done.done, true);
    assert.deepEqual(done.outputs, [{ url: `${origin}/f.png` }]);
  } finally { server.close(); server.closeAllConnections(); }
});

test('custom endpoints pointing away from the configured origin are rejected at save time', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-studio-profiles-'));
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`enc:${value}`),
    decryptString: value => Buffer.from(value).toString('utf8').slice(4),
  };
  const profiles = createProfiles({ home: root, safeStorage: fakeSafeStorage });
  assert.throws(
    () => profiles.save({
      name: 'a', kind: 'image', protocol: 'json', baseUrl: 'http://127.0.0.1:1/api', model: 'm',
      apiKey: 'k', agentEnabled: false, extra: {}, custom: { createPath: 'http://127.0.0.1:2/gen' },
    }),
    /configured API origin/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('openai image edits switch to the multipart endpoint when references exist', async () => {
  let body;
  const { server, origin } = await startServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      body = { url: req.url, type: req.headers['content-type'] };
      res.end(JSON.stringify({ data: [] }));
    });
  });
  try {
    await submit(
      profile({ baseUrl: `${origin}/v1` }),
      { prompt: 'p', size: '64x64', count: 1, quality: 'auto', seconds: 4, references: [] },
      [{ bytes: Buffer.from('png-bytes'), name: 'ref.png', mime: 'image/png' }],
    );
    assert.equal(body.url, '/v1/images/edits');
    assert.match(body.type, /multipart\/form-data/);
  } finally { server.close(); server.closeAllConnections(); }
});

test('profile stores survive corrupt files with a warning and preserve the original', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knorvia-studio-profiles-'));
  const file = path.join(root, 'config', 'studio', 'profiles.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{corrupt');
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`enc:${value}`),
    decryptString: value => Buffer.from(value).toString('utf8').slice(4),
  };
  const profiles = createProfiles({ home: root, safeStorage: fakeSafeStorage });
  assert.match(profiles.warning, /could not be read/);
  profiles.save({ name: 'a', kind: 'image', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKey: 'k', agentEnabled: false, extra: {}, custom: {} });
  const preserved = fs.readdirSync(path.dirname(file)).some(name => name.startsWith('profiles.json.unreadable-'));
  assert.equal(preserved, true, 'unreadable original must be preserved beside the new file');
  assert.equal(profiles.warning, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('image edits transmit every reference byte in order using multipart image fields', async () => {
  let received;
  const { server, origin } = await startServer((req, res) => {
    const chunks = []; req.on('data', part => chunks.push(part));
    req.on('end', async () => {
      const form = await new Request(`${origin}/edits`, { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }).formData();
      received = await Promise.all(form.getAll('image[]').map(async file => ({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()).toString('hex') })));
      res.end(JSON.stringify({ data: [] }));
    });
  });
  try {
    const refs = [1, 2].map(n => ({ bytes: Buffer.from([137, n, 0, 255]), name: `ref-${n}.png`, mime: 'image/png' }));
    await submit(profile({ baseUrl: origin }), { prompt: 'blend', size: '64x64', count: 1, quality: 'auto' }, refs);
    assert.deepEqual(received, refs.map(ref => ({ name: ref.name, bytes: ref.bytes.toString('hex') })));
  } finally { server.close(); server.closeAllConnections(); }
});

test('video frame mappings preserve first and last bytes for fal endpoints and nested JSON templates', async () => {
  let received;
  const { server, origin } = await startServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { received = JSON.parse(Buffer.concat(chunks)); res.end(JSON.stringify({ status: 'completed', data: [] })); });
  });
  const refs = [{ role: 'firstFrame', name: 'first.png', mime: 'image/png', bytes: Buffer.from('first-bytes') }, { role: 'lastFrame', name: 'last.png', mime: 'image/png', bytes: Buffer.from('last-bytes') }];
  const data = refs.map(ref => `data:image/png;base64,${ref.bytes.toString('base64')}`);
  try {
    for (const [model, field] of [['fal-ai/wan-flf2v', 'start_image_url'], ['fal-ai/wan/v2.7/image-to-video', 'image_url'], ['fal-ai/kling-video/v3/standard/image-to-video', 'start_image_url']]) {
      await submit(profile({ kind: 'video', protocol: 'fal', baseUrl: origin, model }), { prompt: 'move', seconds: 5, aspect: '16:9' }, refs);
      assert.equal(received[field], data[0]); assert.equal(received.end_image_url, data[1]);
    }
    await submit(profile({ kind: 'video', protocol: 'fal', baseUrl: origin, custom: { firstFrameField: 'begin_image', lastFrameField: 'finish_image' } }), { prompt: 'move', seconds: 5 }, refs);
    assert.equal(received.begin_image, data[0]); assert.equal(received.finish_image, data[1]);
    await submit(profile({ kind: 'video', protocol: 'json', baseUrl: origin, custom: { requestTemplate: { frames: { start: '{{first_frame}}', end: '{{last_frame}}' } } } }), { prompt: 'move' }, refs);
    assert.deepEqual(received, { frames: { start: data[0], end: data[1] } });
  } finally { server.close(); server.closeAllConnections(); }
});

test('unsupported or incomplete frame inputs are rejected before any provider call', async () => {
  const input = { references: [], firstFrame: { id: 'first' }, lastFrame: { id: 'last' } };
  for (const p of [profile({ kind: 'video' }), profile({ kind: 'video', protocol: 'fal' }), profile({ kind: 'video', protocol: 'json', custom: { requestTemplate: { image: '{{first_frame}}' } } })]) {
    assert.equal(inputCapabilities(p).lastFrame, false);
    assert.throws(() => validateInputs(p, input), /尾帧/);
  }
  const p = profile({ kind: 'video', protocol: 'fal', model: 'fal-ai/wan-flf2v' });
  assert.throws(() => validateInputs(p, { references: [], lastFrame: input.lastFrame }), /首帧/);
  assert.throws(() => validateInputs(p, { references: [], firstFrame: input.firstFrame }), /尾帧/);
  const textOnly = profile({ protocol: 'json', custom: { requestTemplate: { prompt: '{{prompt}}' } } });
  assert.throws(() => validateInputs(textOnly, { references: [{ id: 'first' }] }), /0/);
});

test('fal multi-reference connections transmit the complete array instead of dropping all but the first', async () => {
  let received;
  const { server, origin } = await startServer((req, res) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { received = JSON.parse(Buffer.concat(chunks)); res.end(JSON.stringify({ images: [] })); }); });
  try {
    const p = profile({ protocol: 'fal', baseUrl: origin, custom: { referenceMode: 'multiple' } });
    const refs = ['one', 'two'].map(name => ({ name, mime: 'image/png', bytes: Buffer.from(name) }));
    assert.equal(inputCapabilities(p).maxReferences, 6);
    await submit(p, { prompt: 'blend', size: '64x64', count: 1 }, refs);
    assert.deepEqual(received.image_urls, refs.map(ref => `data:image/png;base64,${ref.bytes.toString('base64')}`));
    assert.equal(received.image_url, undefined);
  } finally { server.close(); server.closeAllConnections(); }
});
