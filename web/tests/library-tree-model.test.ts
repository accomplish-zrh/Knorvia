/** P06: pure tree-model behavior for the APG library tree. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLibraryTree,
  childrenOfRoot,
  flattenVisibleTree,
  parentOf,
  typeaheadRow,
  TREE_RENDER_LIMIT,
} from '@/components/native/library-tree-model';
import type { LibraryEntry } from '@/lib/native-library';

function entry(path: string): LibraryEntry {
  return {
    id: `id-${path}`,
    path,
    name: path.split('/').at(-1)!,
    size: 1,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  } as unknown as LibraryEntry;
}

test('build sorts folders before files, both by name, and skips trash', () => {
  const nodes = buildLibraryTree(
    ['b', 'a/c', 'a'],
    [entry('z.txt'), entry('a/draft.md'), { ...entry('gone.txt'), trashedAt: 'x' } as LibraryEntry],
  );
  assert.deepEqual(nodes.map(node => node.path), ['a', 'a/c', 'b', 'a/draft.md', 'z.txt']);
  assert.equal(nodes[0].kind, 'folder');
  assert.equal(nodes.at(-1)!.kind, 'file');
});

test('flatten follows DOM order: expanded folders expose children, collapsed do not', () => {
  const roots = buildLibraryTree(['a/b', 'a', 'c'], [entry('a/one.txt'), entry('top.txt')]);
  const collapsed = flattenVisibleTree(roots, new Set(), TREE_RENDER_LIMIT);
  assert.deepEqual(collapsed.map(row => row.node.path), ['a', 'c', 'top.txt']);
  assert.deepEqual(collapsed.map(row => row.depth), [0, 0, 0]);

  const expanded = flattenVisibleTree(roots, new Set(['a']), TREE_RENDER_LIMIT);
  assert.deepEqual(expanded.map(row => row.node.path), ['a', 'a/b', 'a/one.txt', 'c', 'top.txt']);
  assert.deepEqual(expanded.map(row => row.depth), [0, 1, 1, 0, 0]);
});

test('childrenOfRoot truncates per level and reports it', () => {
  const roots = Array.from({ length: 5 }, (_, i) => ({ kind: 'folder', path: `f${i}`, label: `f${i}` }) as const);
  const { children, truncated } = childrenOfRoot(roots as never, '', 3);
  assert.equal(children.length, 3);
  assert.equal(truncated, true);
});

test('typeahead matches forward, wraps, ignores case, and misses cleanly', () => {
  const roots = buildLibraryTree(['notes', 'archive'], [
    entry('alpha.txt'),
    entry('beta.txt'),
    entry('gamma.txt'),
  ]);
  const rows = flattenVisibleTree(roots, new Set(['notes', 'archive']), TREE_RENDER_LIMIT);
  const indexOf = (path: string) => rows.findIndex(row => row.node.path === path);
  assert.equal(typeaheadRow(rows, 'b', 0), indexOf('beta.txt'));
  // Wrap-around: searching from the last row finds an earlier match.
  assert.equal(typeaheadRow(rows, 'be', indexOf('gamma.txt') + 1), indexOf('beta.txt'));
  assert.equal(typeaheadRow(rows, 'GAM', 0), indexOf('gamma.txt'));
  assert.equal(typeaheadRow(rows, 'zzz', 0), -1);
});

test('parentOf splits nested paths', () => {
  assert.equal(parentOf('a/b/c'), 'a/b');
  assert.equal(parentOf('top.txt'), '');
});
