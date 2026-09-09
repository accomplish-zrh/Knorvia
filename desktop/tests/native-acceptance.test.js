'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertCompleted, poll } = require('../scripts/native-acceptance');

const valid = { id: 'turn_verified', status: 'completed', items: [
  { kind: 'userMessage' },
  { kind: 'agentMessage', status: 'completed', payload: { text: 'scripted native fixture response' } },
] };

test('acceptance rejects admitted, failed, cancelled and interrupted tasks', () => {
  for (const status of ['running', 'failed', 'cancelled', 'interrupted']) {
    assert.throws(() => assertCompleted({ ...valid, status }), /Turn turn_verified/);
  }
  assertCompleted(valid);
});
test('acceptance requires durable output and one user item', () => {
  assert.throws(() => assertCompleted({ ...valid, items: [{ kind: 'userMessage' }] }), /durable assistant/);
  assert.throws(() => assertCompleted({ ...valid, items: [...valid.items, { kind: 'userMessage' }] }), /duplicate/);
  assert.throws(() => assertCompleted({ ...valid, items: [valid.items[0], { ...valid.items[1], status: 'running' }] }), /durable assistant/);
});
test('acceptance cannot hang on a nonterminal task', async () => {
  await assert.rejects(poll(async () => ({ status: 'running' }), () => false, 1), /timed out/);
});
