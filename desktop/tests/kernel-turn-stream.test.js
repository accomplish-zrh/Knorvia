'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TurnStreamState,
  isTerminalStatus,
  normalizedTurn,
  rendererStatus,
} = require('../kernel-turn-stream');

const THREAD = 'thread-1';
const TURN = 'turn-1';

function agent(id, seq, text, kernelItemId = id) {
  return {
    id, seq, threadId: THREAD, turnId: TURN,
    kind: 'agentMessage', payload: { text, kernelItemId },
  };
}

test('TurnStreamState joins delta text to its matching durable item without duplicate output', () => {
  const state = new TurnStreamState(TURN);
  assert.deepEqual(state.acceptDelta({ itemId: 'kernel-1', text: 'hello' }), {
    type: 'content',
    content: 'hello',
    metadata: { kernelItemId: 'kernel-1', kind: 'agentMessage.delta', transient: true },
    emit: true,
  });
  const durable = state.acceptItem(agent('persisted-1', 2, 'hello', 'kernel-1'), { threadId: THREAD });
  assert.equal(durable.type, 'content');
  assert.equal(durable.emit, false);
  assert.equal(state.acceptItem(agent('persisted-1', 2, 'hello', 'kernel-1'), { threadId: THREAD }), null);
  assert.equal(state.acceptDelta({ itemId: 'kernel-1', text: 'late' }), null);
});

test('TurnStreamState de-duplicates durable ids but preserves equal content from distinct items', () => {
  const state = new TurnStreamState(TURN);
  const first = state.acceptItem(agent('persisted-a', 2, 'same', 'kernel-a'), { threadId: THREAD });
  const second = state.acceptItem(agent('persisted-b', 3, 'same', 'kernel-b'), { threadId: THREAD });
  assert.equal(first.content, 'same');
  assert.equal(second.content, 'same');
  assert.equal(state.acceptItem(agent('persisted-a', 2, 'same', 'kernel-a'), { threadId: THREAD }), null);
});

test('TurnStreamState rejects other Thread/Turn Items and suppresses replayed snapshot entries', () => {
  const state = new TurnStreamState(TURN);
  assert.equal(state.acceptItem({ ...agent('wrong-thread', 2, 'no'), threadId: 'other' }, { threadId: THREAD }), null);
  assert.equal(state.acceptItem({ ...agent('wrong-turn', 2, 'no'), turnId: 'other' }, { threadId: THREAD }), null);
  const replayed = agent('snapshot-1', 2, 'already rendered', 'kernel-snapshot');
  state.rememberSnapshotItem(replayed);
  assert.equal(state.acceptItem(replayed, { threadId: THREAD }), null);
  assert.equal(state.acceptDelta({ itemId: 'kernel-snapshot', text: 'late' }), null);
});

test('turn helper normalization preserves the protocol terminal contract', () => {
  const read = normalizedTurn({
    id: TURN, threadId: THREAD, status: 'interrupted', items: [],
  });
  assert.deepEqual(read, { id: TURN, threadId: THREAD, status: 'interrupted', items: [], error: undefined });
  assert.equal(isTerminalStatus('interrupted'), true);
  assert.equal(isTerminalStatus('running'), false);
  assert.equal(rendererStatus('interrupted'), 'cancelled');
  assert.equal(rendererStatus('completed'), 'completed');
});
