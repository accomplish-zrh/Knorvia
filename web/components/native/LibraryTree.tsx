"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, File, FileText, Folder, FolderOpen, Image } from 'lucide-react';
import { libraryKind, type LibraryEntry } from '@/lib/native-library';
import { useWorkbench } from './NativeWorkbenchProvider';
import { buildLibraryTree, childrenOfRoot, flattenVisibleTree, parentOf, typeaheadRow, TREE_RENDER_LIMIT, type LibraryTreeNode } from './library-tree-model';
import './library-tree-accessibility.css';

const TYPEAHEAD_RESET_MS = 500;

/**
 * P06: APG tree view. One roving-focus tab stop, full arrow/Home/End/
 * typeahead navigation over the visible rows, selection kept separate from
 * focus, and focus recovery when the focused node disappears (delete, move,
 * trash). The actions menu keeps its own keyboard support; Shift+F10 or the
 * ContextMenu key opens it for the focused row.
 */
export function LibraryTree({ entries, folders, selected, currentFolder, openFile, openFolder, actions }: { entries: LibraryEntry[]; folders: string[]; selected?: LibraryEntry; currentFolder: string; openFile: (entry: LibraryEntry) => void; openFolder: (folder: string) => void; actions: (path: string, entry?: LibraryEntry) => React.ReactNode }) {
  const { t } = useWorkbench();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(TREE_RENDER_LIMIT);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef({ query: '', at: 0 });
  const lastVisiblePathsRef = useRef<string[]>([]);

  const roots = useMemo(() => buildLibraryTree(folders, entries), [folders, entries]);
  const visible = useMemo(() => flattenVisibleTree(roots, expanded, limit), [roots, expanded, limit]);
  const visiblePaths = useMemo(() => visible.map(row => row.node.path), [visible]);

  const focusRow = useCallback((path: string) => {
    const row = containerRef.current?.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(path)}"]`);
    row?.focus();
  }, []);

  // Keep ancestors of the browsed/selected folder expanded (previous
  // behavior, as an effect instead of render-phase setState).
  const folder = selected?.path.includes('/') ? selected.path.slice(0, selected.path.lastIndexOf('/')) : currentFolder;
  useEffect(() => {
    if (!folder) return;
    setExpanded(current => {
      const next = new Set(current);
      const parts = folder.split('/');
      for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join('/'));
      return next;
    });
  }, [folder]);

  const openRowMenu = useCallback((path?: string) => {
    if (!path) return;
    const trigger = containerRef.current?.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(path)}"] [aria-haspopup="menu"]`);
    trigger?.click();
  }, []);

  const moveFocus = useCallback((index: number) => {
    const row = visible[index];
    if (!row) return;
    setFocusedPath(row.node.path);
    requestAnimationFrame(() => focusRow(row.node.path));
  }, [visible, focusRow]);

  const toggleFolder = useCallback((folderPath: string) => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(folderPath)) next.delete(folderPath); else next.add(folderPath);
      return next;
    });
  }, []);

  // Focus recovery: when the focused node disappears (delete/move/trash),
  // land on its parent folder, else the current folder, else the first row.
  useEffect(() => {
    const previous = lastVisiblePathsRef.current;
    lastVisiblePathsRef.current = visiblePaths;
    if (!focusedPath || visiblePaths.includes(focusedPath)) return;
    if (!previous.length) return;
    const fallback = parentOf(focusedPath) || currentFolder;
    const next = visiblePaths.includes(fallback) ? fallback : visiblePaths[0] ?? null;
    setFocusedPath(next);
    if (next) requestAnimationFrame(() => focusRow(next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePaths]);

  const onTreeKeyDown = useCallback((event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    const currentPath = target.closest<HTMLElement>('[data-tree-path]')?.dataset.treePath;
    // Menu triggers inside a row keep their own ArrowDown/ArrowUp handling.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (target.getAttribute('aria-haspopup') === 'menu') return;
      event.preventDefault();
      const index = visiblePaths.indexOf(currentPath ?? '');
      moveFocus(event.key === 'ArrowDown' ? index + 1 : index - 1);
      return;
    }
    const node = visible.find(row => row.node.path === currentPath)?.node;
    switch (event.key) {
      case 'ArrowRight':
        if (node?.kind !== 'folder') return;
        event.preventDefault();
        if (!expanded.has(node.path)) toggleFolder(node.path);
        else moveFocus(visiblePaths.indexOf(node.path) + 1);
        return;
      case 'ArrowLeft':
        if (!node) return;
        event.preventDefault();
        if (node.kind === 'folder' && expanded.has(node.path)) toggleFolder(node.path);
        else {
          const parent = parentOf(node.path);
          if (parent) { setFocusedPath(parent); requestAnimationFrame(() => focusRow(parent)); }
        }
        return;
      case 'Home':
        event.preventDefault(); moveFocus(0); return;
      case 'End':
        event.preventDefault(); moveFocus(visiblePaths.length - 1); return;
      case 'Enter':
      case ' ':
        if (!node) return;
        event.preventDefault();
        if (node.kind === 'folder') { setExpanded(current => new Set(current).add(node.path)); openFolder(node.path); }
        else openFile(node.entry);
        return;
      case 'ContextMenu':
        event.preventDefault(); openRowMenu(currentPath); return;
      default:
        break;
    }
    if (event.key === 'F10' && event.shiftKey) { event.preventDefault(); openRowMenu(currentPath); return; }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const index = visiblePaths.indexOf(currentPath ?? '');
      const now = Date.now();
      const state = typeaheadRef.current;
      state.query = now - state.at <= TYPEAHEAD_RESET_MS ? state.query + event.key.toLowerCase() : event.key.toLowerCase();
      state.at = now;
      const match = typeaheadRow(visible, state.query, index + 1 >= visible.length ? 0 : index + 1);
      if (match >= 0) { event.preventDefault(); moveFocus(match); }
    }
  }, [expanded, openFile, openFolder, moveFocus, openRowMenu, toggleFolder, visible, visiblePaths, focusRow]);

  const renderRow = (node: LibraryTreeNode, depth: number) => {
    const rowFocused = focusedPath === node.path || (focusedPath === null && visiblePaths[0] === node.path);
    if (node.kind === 'folder') {
      return <div data-tree-path={node.path} role="treeitem" tabIndex={rowFocused ? 0 : -1} aria-level={depth + 1} aria-expanded={expanded.has(node.path)} aria-label={node.label} style={{ paddingInlineStart: 7 + depth * 13 }} className={`nl-tree-row nl-tree-item ${currentFolder === node.path && !selected ? 'is-active' : ''}`}>
        <span className="nl-tree-chevron" aria-hidden onClick={() => toggleFolder(node.path)}><ChevronRight size={13} /></span>
        <button className="nl-tree-name" title={node.path} tabIndex={-1} onClick={() => { setExpanded(current => new Set(current).add(node.path)); openFolder(node.path); }}>
          {expanded.has(node.path) ? <FolderOpen size={16} /> : <Folder size={16} />}<span>{node.label}</span>
        </button>
        {actions(node.path)}
      </div>;
    }
    const isSelected = selected?.id === node.entry.id;
    const kind = libraryKind(node.entry.name);
    const Icon = kind === 'image' ? Image : ['text', 'docx'].includes(kind) ? FileText : File;
    return <div data-tree-path={node.path} role="treeitem" tabIndex={rowFocused ? 0 : -1} aria-level={depth + 1} aria-selected={isSelected} aria-label={node.label} style={{ paddingInlineStart: 28 + depth * 13 }} className={`nl-tree-row nl-tree-item is-file ${isSelected ? 'is-active' : ''}`}>
      <button className="nl-tree-name" title={node.entry.path} tabIndex={-1} onClick={() => openFile(node.entry)}>
        <Icon size={15} /><span>{node.label}</span>
      </button>
      {actions(node.entry.path, node.entry)}
    </div>;
  };

  function branch(root: string, depth = 0): React.ReactNode {
    const { children, truncated } = childrenOfRoot(roots, root, limit);
    return <>
      {children.map((node, index) => <div key={node.path}>
        {renderRow(node, depth)}
        {node.kind === 'folder' && expanded.has(node.path) && <div role="group" aria-label={node.label}>{branch(node.path, depth + 1)}</div>}
        {truncated && index === children.length - 1 && <button className="nl-tree-more" onClick={() => setLimit(value => value + TREE_RENDER_LIMIT)}>{t('显示更多', 'Show more')}</button>}
      </div>)}
    </>;
  }

  return <div ref={containerRef} className="nl-folder-tree" role="tree" aria-label={t('我的资料目录', 'My file directory')} onKeyDown={onTreeKeyDown}>{branch('')}{!visible.length && <p>{t('添加的资料会出现在这里', 'Your files will appear here')}</p>}</div>;
}
