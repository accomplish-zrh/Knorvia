import assert from 'node:assert/strict';
import test from 'node:test';
import { closePanelTab, openPanelTab, previewUrl, workspaceLink } from '../lib/native-panel';

test('opening the same file reuses its tab without dropping other reading sessions', () => {
  const first = openPanelTab({ tabs: [], active: null }, { kind: 'file', path: 'docs/a.md' });
  const second = openPanelTab(first, { kind: 'browser', url: 'http://localhost:3001/' });
  const again = openPanelTab(second, { kind: 'file', path: 'docs\\a.md' });
  assert.equal(again.tabs.length, 2);
  assert.equal(again.active, 'file:docs/a.md');
  assert.equal(first.tabs.length, 1);
});
test('closing active or background tabs selects the neighbor, then returns to the launcher', () => {
  const a = openPanelTab({ tabs: [], active: null }, { kind: 'files' });
  const b = openPanelTab(a, { kind: 'changes' });
  assert.equal(closePanelTab(b, 'files').active, 'changes');
  assert.equal(closePanelTab(b, 'changes').active, 'files');
  assert.deepEqual(closePanelTab(a, 'files'), { tabs: [], active: null });
});
test('preview links reject active schemes and out-of-project local paths', () => {
  for (const value of ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,hi', 'https://user:password@example.com']) assert.equal(previewUrl(value), null);
  assert.equal(previewUrl('http://127.0.0.1:3001'), 'http://127.0.0.1:3001/');
  assert.equal(workspaceLink('D:/project/docs/read%20me.md:24', 'D:\\project'), 'docs/read me.md');
  assert.equal(workspaceLink('D:/project2/private.txt', 'D:/project'), null);
  assert.equal(workspaceLink('../secret', 'D:/project'), null);
  assert.equal(workspaceLink('%2e%2e/private', 'D:/project'), null);
  assert.equal(workspaceLink('docs/a.md', 'D:/project'), 'docs/a.md');
  assert.equal(workspaceLink('demo.html', 'D:/project', 'docs'), 'docs/demo.html');
  assert.equal(workspaceLink('../image.png', 'D:/project', 'docs'), 'image.png');
  assert.equal(workspaceLink('../../private', 'D:/project', 'docs'), null);
});
