import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTaskView, emptyTaskView } from '../lib/native-task-view';
import { openPanelTab } from '../lib/native-panel';
import { conversationMatches, conversationMessages } from '../lib/native-conversation';
import type { Item } from '../lib/native-workbench-state';

const id = '11111111-2222-4333-8444-555555555555';
test('restores navigation metadata without converting restored terminals into new executions', () => {
  const value = parseTaskView(JSON.stringify({ version: 1, panel: { open: true, content: { active: `chat:${id}`, tabs: [
    { target: { kind: 'terminal', id, restore: false } },
    { target: { kind: 'chat', id, threadId: 'thr_1a0767f8a9497f8efe8fc33ff0a' } },
    { target: { kind: 'file', path: '中文 文档.md' }, view: { top: 520, source: true } },
  ] } }, contextFiles: ['a.md', 'a.md'], reading: { top: 300, anchor: id, offset: -10, bottom: false } }));
  assert.deepEqual(value.panel.content.tabs[0].target, { kind: 'terminal', id, restore: true });
  assert.deepEqual(value.panel.content.tabs[1].target, { kind: 'chat', id, threadId: 'thr_1a0767f8a9497f8efe8fc33ff0a' });
  assert.equal(value.panel.content.tabs[2].view?.top, 520);
  assert.equal(value.panel.content.active, `chat:${id}`);
  assert.deepEqual(value.contextFiles, ['a.md']);
  assert.equal(value.reading?.offset, -10);
});
test('malformed or unsafe view state cannot restore executable URLs or unbounded history', () => {
  for (const raw of ['', 'null', '{', '{"version":2}']) assert.deepEqual(parseTaskView(raw), emptyTaskView());
  const value = parseTaskView(JSON.stringify({ version: 1, panel: { open: true, content: { active: 'browser:javascript:alert(1)', tabs: [
    { target: { kind: 'browser', url: 'javascript:alert(1)' } },
    { target: { kind: 'terminal', id: '../invalid' } },
    { target: { kind: 'browser' }, view: { history: ['https://user:secret@example.com/', 'javascript:alert(1)', 'http://127.0.0.1:3030/'], index: 999, top: -10 } },
    { target: { kind: 'files' } }, { target: { kind: 'files' } },
  ] } } }));
  assert.equal(value.panel.content.tabs.length, 2);
  assert.equal(value.panel.content.active, null);
  assert.deepEqual(value.panel.content.tabs[0].view?.history, ['http://127.0.0.1:3030/']);
  assert.equal(value.panel.content.tabs[0].view?.index, 0);
  assert.equal(value.panel.content.tabs[0].view?.top, 0);
});
test('reopening an existing tab retains its reading state and side conversation association', () => {
  const view = { tabs: [{ id: `chat:${id}`, target: { kind: 'chat' as const, id, threadId: id }, view: { top: 200 } }], active: null };
  assert.equal(openPanelTab(view, { kind: 'chat', id }).tabs[0].target.kind, 'chat');
  assert.deepEqual(openPanelTab(view, { kind: 'chat', id }).tabs[0], view.tabs[0]);
});
test('conversation search handles literal punctuation, Chinese and case without searching hidden tool payloads', () => {
  const items = [{ id: 'a', kind: 'userMessage', payload: { text: '中文 Needle [a+b]' } }, { id: 'b', kind: 'agentMessage', payload: { text: 'needle reply' } }, { id: 'c', kind: 'commandExecution', payload: { text: 'needle internal' } }].map((item, seq) => ({ ...item, seq, threadId: id, turnId: id, status: 'completed' })) as Item[];
  const messages = conversationMessages(items);
  assert.deepEqual(conversationMatches(messages, 'NEEDLE').map(item => item.id), ['a', 'b']);
  assert.equal(conversationMatches(messages, '[a+b]')[0]?.id, 'a');
  assert.equal(conversationMatches(messages, '中文')[0]?.id, 'a');
  assert.deepEqual(conversationMatches(messages, '   '), []);
});
