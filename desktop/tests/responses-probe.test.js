'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { probeResponsesEndpoint } = require('../responses-probe');
const { startScriptedResponsesFixture } = require('./fixtures/scripted-responses-fixture');

test('provider probe sends one bounded request to the local scripted Responses fixture', async () => {
  const fixture = await startScriptedResponsesFixture({ host: '127.0.0.1', port: 0 });
  try {
    const result = await probeResponsesEndpoint({
      model: 'fixture-model',
      baseUrl: fixture.baseUrl,
      apiKey: 'local-fixture-only',
    });
    assert.equal(result.ok, true);
    assert.equal(result.providerVerified, true);
    assert.equal(result.status, 200);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].kind, 'message');
  } finally {
    await fixture.close();
  }
});

test('provider probe refuses a default OpenAI endpoint instead of spending a model request', async () => {
  const result = await probeResponsesEndpoint({
    model: 'fixture-model',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'not-used',
  });
  assert.equal(result.ok, false);
  assert.equal(result.providerVerified, false);
  assert.match(result.message, /custom Responses endpoint/);
});
