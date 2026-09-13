import type { LibraryEntry } from '@/lib/native-library';

/**
 * P06 tree model: pure helpers that turn flat folder/file lists into the
 * APG tree structure (folders sorted before files, both name-sorted) and the
 * flat "visible rows" list the roving-focus keyboard navigation walks.
 */

export type LibraryTreeNode =
  | { kind: 'folder'; path: string; label: string }
  | { kind: 'file'; path: string; label: string; entry: LibraryEntry };

export type LibraryTreeRow = {
  node: LibraryTreeNode;
  depth: number;
  /** Folder paths whose children are truncated by the render limit. */
  truncated: boolean;
};

export const TREE_RENDER_LIMIT = 80;

export function buildLibraryTree(folders: string[], entries: LibraryEntry[]): LibraryTreeNode[] {
  const nodes: LibraryTreeNode[] = [];
  const sortedFolders = [...folders].sort((a, b) => a.localeCompare(b));
  const sortedFiles = entries
    .filter(entry => !entry.trashedAt)
    .sort((a, b) => a.name.localeCompare(b.name));
  const folderSet = new Set(sortedFolders);
  for (const folder of sortedFolders) nodes.push({ kind: 'folder', path: folder, label: folder.split('/').at(-1) ?? folder });
  for (const entry of sortedFiles) {
    if (folderSet.has(entry.path)) continue; // a folder and a file cannot share one path slot
    nodes.push({ kind: 'file', path: entry.path, label: entry.name, entry });
  }
  return nodes;
}

export function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/** Children of `root` in model order, per-level render limit applied. */
export function childrenOfRoot(roots: LibraryTreeNode[], root: string, limit: number): { children: LibraryTreeNode[]; truncated: boolean } {
  const children = roots.filter(node => parentOf(node.path) === root);
  return { children: children.slice(0, limit), truncated: children.length > limit };
}

/**
 * Depth-first list of rendered rows: folders appear before their children
 * (only when expanded), matching the DOM order the arrow keys must follow.
 */
export function flattenVisibleTree(roots: LibraryTreeNode[], expanded: Set<string>, limit: number): { node: LibraryTreeNode; depth: number }[] {
  const rows: { node: LibraryTreeNode; depth: number }[] = [];
  const walk = (root: string, level: number) => {
    const { children } = childrenOfRoot(roots, root, limit);
    for (const node of children) {
      rows.push({ node, depth: level });
      if (node.kind === 'folder' && expanded.has(node.path)) walk(node.path, level + 1);
    }
  };
  walk('', 0);
  return rows;
}

/**
 * Typeahead: first visible row at-or-after `startIndex` whose label starts
 * with `query` (case-insensitive); wraps around once. Returns -1 when no
 * row matches.
 */
export function typeaheadRow(rows: { node: LibraryTreeNode }[], query: string, startIndex: number): number {
  if (!rows.length || !query) return -1;
  const needle = query.toLowerCase();
  const match = (row: { node: LibraryTreeNode }) => row.node.label.toLowerCase().startsWith(needle);
  for (let i = startIndex; i < rows.length; i++) if (match(rows[i])) return i;
  for (let i = 0; i < startIndex; i++) if (match(rows[i])) return i;
  return -1;
}
