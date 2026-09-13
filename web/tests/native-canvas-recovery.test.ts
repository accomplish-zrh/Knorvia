import assert from 'node:assert/strict';
import test from 'node:test';
import { validCanvasDraft } from '../lib/native-canvas-recovery';
import { canvasConnectionIssue } from '../lib/native-canvas-graph';
import { parseTaskView } from '../lib/native-task-view';
import type { CanvasDocument } from '../lib/native-canvas';

const id = '11111111-2222-4333-8444-555555555555';
const doc: CanvasDocument = { schemaVersion: 1, id, title: '中文画布', revision: 3, globalPrompt: '自然光', createdAt: '', updatedAt: '', nodes: [
  { id: 'brief', kind: 'text', title: '场景', prompt: '午后', x: 0, y: 0 },
  { id: 'image', kind: 'image', title: '首帧', x: 360, y: 0 },
  { id: 'image2', kind: 'image', title: '备选', x: 360, y: 300 },
  { id: 'video', kind: 'video', title: '片段', x: 720, y: 0 },
], edges: [{ id: 'e1', from: 'brief', to: 'image', role: 'context' }, { id: 'e2', from: 'image', to: 'video', role: 'firstFrame' }] };

test('only a renderable bounded graph can replace a saved document during draft recovery', () => {
  assert.equal(validCanvasDraft(JSON.parse(JSON.stringify(doc))), true);
  for (const value of [null, {}, { ...doc, nodes: [null] }, { ...doc, nodes: [{ ...doc.nodes[0], kind: 'unknown' }] }, { ...doc, nodes: [{ ...doc.nodes[0], x: Infinity }] }, { ...doc, edges: [{ id: 'e', from: 'brief', to: 'missing', role: 'context' }] }, { ...doc, nodes: [{ ...doc.nodes[0], title: {} }] }, { ...doc, revision: 0 }]) assert.equal(validCanvasDraft(value), false);
});
test('a second boundary frame is rejected rather than silently shadowing the first', () => {
  assert.match(canvasConnectionIssue(doc.nodes, doc.edges, { from: 'image2', to: 'video', role: 'firstFrame' }) || '', /一张首帧/);
  assert.equal(canvasConnectionIssue(doc.nodes, doc.edges, { from: 'image2', to: 'video', role: 'lastFrame' }), null);
});
test('a conversation restores its canvas reference and panel without executing anything', () => {
  const result = parseTaskView(JSON.stringify({ version: 1, canvasContext: '当前画布 id=' + id, panel: { open: true, content: { active: 'canvas:' + id, tabs: [{ target: { kind: 'canvas', id } }, { target: { kind: 'canvas', id: '../../invalid' } }] } } }));
  assert.deepEqual(result.panel.content.tabs.map(t => t.target), [{ kind: 'canvas', id }]);
  assert.equal(result.panel.content.active, 'canvas:' + id);
  assert.equal(result.canvasContext, '当前画布 id=' + id);
});
