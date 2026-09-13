"use client";

import { useRouter } from 'next/navigation';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BookOpen, ChevronRight, Clock3, File, FileText, Folder, FolderPlus, Image, Loader2, MoreHorizontal, Plus, RefreshCw, Search, Sparkles, Trash2, Upload } from 'lucide-react';
import { libraryKind, saveLibraryFile, type LibraryEntry, type LibraryIndex } from '@/lib/native-library';
import { LibraryImportQueue, uniqueImportPath, type ImportItem, type ImportSnapshot } from '@/lib/library-import-queue';
import { EMPTY_CONTENT_SEARCH, LibraryContentSearch, type ContentSearchState } from '@/lib/library-content-search';
import { LibraryBulkOperation, type BulkKind, type BulkState } from '@/lib/native-library-bulk';
import { fileSize } from '@/lib/native-project-context';
import type { Workspace } from '@/lib/native-workbench-state';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import { Modal } from './WorkbenchShell';
import { LibraryEditor } from './LibraryEditor';
import { LibraryTree } from './LibraryTree';
import { LibraryImportQueuePanel } from './LibraryImportQueue';

const IMPORT_STORAGE_KEY = 'knorvia-library-import';

type Dialog = { kind: 'folder' | 'new' | 'move' | 'trash' | 'restore' | 'agent' | 'bulk-move' | 'bulk-restore'; path?: string; entry?: LibraryEntry };
export function LibraryView() {
  const router = useRouter();
  const { request, t, connection, setNotice, refresh: refreshWorkbench, newTask, models } = useWorkbench();
  const [index, setIndex] = useState<LibraryIndex>({ entries: [], folders: [], limited: false });
  const [section, setSection] = useState('recent'), [query, setQuery] = useState(''), [type, setType] = useState('all');
  // B01: content search walks every server page (dedupe + generation guards)
  // instead of keeping only the first 20 hits, and surfaces index coverage.
  const contentSearchRef = useRef<LibraryContentSearch | null>(null);
  if (!contentSearchRef.current) contentSearchRef.current = new LibraryContentSearch(params => request('library/search', params as unknown as Record<string, unknown>));
  const contentSearch = useSyncExternalStore(contentSearchRef.current.subscribe, contentSearchRef.current.getSnapshot, () => EMPTY_CONTENT_SEARCH);
  const [selected, setSelected] = useState<LibraryEntry>(), [expanded, setExpanded] = useState(false), [dirty, setDirty] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(), [value, setValue] = useState(''), [dialogError, setDialogError] = useState('');
  const [menu, setMenu] = useState<string>();
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const focusLastMenuItem = useRef(false);
  const closeMenu = useCallback((restoreFocus = false) => {
    if (restoreFocus && menuTrigger.current?.isConnected) menuTrigger.current.focus({ preventScroll: true });
    setMenu(undefined);
  }, []);
  const openMenu = (trigger: HTMLButtonElement, key: string, last = false) => {
    menuTrigger.current = trigger;
    focusLastMenuItem.current = last;
    setMenu(key);
  };
  const [shown, setShown] = useState(100);
  const [focusSearch, setFocusSearch] = useState(false);
  useEffect(() => { setShown(100); }, [section, query, type]);
  // B02: multi-select batch organize. The selection freezes id/path/sha at
  // check time so the daemon identity guards can catch drift; results and
  // retries are per item.
  const [checked, setChecked] = useState<Map<string, LibraryEntry>>(new Map());
  const [bulk, setBulk] = useState<LibraryBulkOperation | null>(null);
  const [bulkState, setBulkState] = useState<BulkState | null>(null);
  const [bulkRetryDestination, setBulkRetryDestination] = useState('');
  const bulkUnsubscribe = useRef<(() => void) | null>(null);
  useEffect(() => () => bulkUnsubscribe.current?.(), []);
  const toggleChecked = (entry: LibraryEntry, on: boolean) => {
    setChecked(current => {
      const next = new Map(current);
      if (on) next.set(entry.id, entry); else next.delete(entry.id);
      return next;
    });
  };
  const toggleAllChecked = (on: boolean, list: LibraryEntry[]) => {
    setChecked(current => {
      const next = on ? new Map(current) : new Map();
      if (on) for (const entry of list) if (!entry.folder) next.set(entry.id, entry);
      return next;
    });
  };
  const startBulk = (kind: BulkKind, destination: string) => {
    if (!checked.size) return;
    const op = new LibraryBulkOperation(request, kind, [...checked.values()], destination);
    bulkUnsubscribe.current?.();
    bulkUnsubscribe.current = op.subscribe(() => setBulkState(op.getSnapshot()));
    setBulk(op); setBulkState(op.getSnapshot());
    void op.run().catch(() => {}).finally(() => { void refresh().catch(() => {}); });
  };
  const closeBulk = () => { bulkUnsubscribe.current?.(); bulkUnsubscribe.current = null; setBulk(null); setBulkState(null); };
  const fileInput = useRef<HTMLInputElement>(null), search = useRef<HTMLInputElement>(null), dialogInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusSearch && !selected) { search.current?.focus(); setFocusSearch(false); } }, [focusSearch, selected]);
  const refresh = useCallback(async (entry?: LibraryEntry) => {
    const next = await request<LibraryIndex>('library/list'); setIndex(next); setLoading(false);
    if (entry) setSelected(next.entries.find(item => item.id === entry.id) ?? entry);
    else setSelected(current => current ? next.entries.find(item => item.id === current.id && !item.trashedAt) : undefined);
    return next;
  }, [request]);
  // P05: batch import queue — per-item states, cancel, retry, conflict
  // choice, and offline restore through sessionStorage metadata.
  const importQueueRef = useRef<LibraryImportQueue | null>(null);
  const importHandlesRef = useRef(new Map<string, File>());
  const importSeqRef = useRef(0);
  const importDoneRef = useRef(0);
  const [importItems, setImportItems] = useState<ImportItem[]>([]);
  const [importVisible, setImportVisible] = useState(false);
  const persistImport = useCallback((snapshot: ImportSnapshot | null) => {
    try { if (snapshot) sessionStorage.setItem(IMPORT_STORAGE_KEY, JSON.stringify(snapshot)); else sessionStorage.removeItem(IMPORT_STORAGE_KEY); } catch { /* storage optional */ }
  }, []);
  const ensureImportQueue = useCallback(() => {
    if (importQueueRef.current) return importQueueRef.current;
    let restore: ImportSnapshot | null = null;
    try { restore = JSON.parse(sessionStorage.getItem(IMPORT_STORAGE_KEY) ?? 'null') as ImportSnapshot | null; } catch { restore = null; }
    if (restore) importDoneRef.current = restore.items.filter(item => item.status === 'done').length;
    importQueueRef.current = new LibraryImportQueue({
      uploader: (file, context) => saveLibraryFile(request, file.path, file.handle as File, context.expectedSha256, context.onProgress, { signal: context.signal, onUploadId: context.onUploadId }),
      persist: persistImport,
      onChange: queue => {
        setImportItems(queue.list());
        const done = queue.list().filter(item => item.status === 'done').length;
        if (done > importDoneRef.current) { importDoneRef.current = done; void refresh().catch(() => {}); }
      },
      restore,
    });
    setImportItems(importQueueRef.current.list());
    if (restore?.items.some(item => item.status !== 'done')) setImportVisible(true);
    return importQueueRef.current;
  }, [request, refresh, persistImport]);
  useEffect(() => { ensureImportQueue(); }, [ensureImportQueue]);
  useEffect(() => {
    // The controller cancels the previous query by request id and starts a
    // new generation, so a stale backend traversal cannot mix into results.
    const active = query.trim() && section !== 'trash' && (type === 'all' || type === 'text');
    contentSearchRef.current!.reset();
    if (!active) return;
    const timer = setTimeout(() => contentSearchRef.current!.begin(query), 350);
    return () => clearTimeout(timer);
  }, [query, section, type]);
  useEffect(() => {
    if (connection !== 'connected') return;
    let disposed = false;
    void request<LibraryIndex>('library/list').then(next => {
      if (disposed) return; setIndex(next); setLoading(false);
      const id = new URLSearchParams(location.search).get('file'); if (id) setSelected(next.entries.find(item => item.id === id && !item.trashedAt));
    }).catch(error => { if (!disposed) { setError(errorText(error)); setLoading(false); } });
    return () => { disposed = true; };
  }, [connection, request]);
  useEffect(() => {
    const focus = () => { if (!dirty && !busy && !editorBusy && !dialog) void refresh().catch(() => {}); };
    window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus);
  }, [refresh, dirty, busy, editorBusy, dialog]);
  useLayoutEffect(() => {
    const popup = menuRef.current, trigger = menuTrigger.current;
    if (!menu || !popup || !trigger) return;
    popup.showPopover();
    const position = () => {
      const anchor = trigger.getBoundingClientRect();
      popup.style.maxHeight = `${Math.max(40, window.innerHeight - 16)}px`;
      popup.style.width = `${Math.min(200, window.innerWidth - 16)}px`;
      const height = popup.getBoundingClientRect().height;
      const top = anchor.bottom + 5 + height <= window.innerHeight - 8 ? anchor.bottom + 5 : Math.max(8, anchor.top - height - 5);
      popup.style.left = `${Math.max(8, Math.min(anchor.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 8))}px`;
      popup.style.top = `${top}px`;
    };
    position();
    const items = () => [...popup.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    (focusLastMenuItem.current ? items().at(-1) : items()[0])?.focus({ preventScroll: true });
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
      if (!popup.contains(event.target as Node)) return;
      if (event.key === 'Tab') { closeMenu(true); return; }
      const buttons = items(), current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (buttons.length && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    document.addEventListener('keydown', keyboard, true);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      document.removeEventListener('keydown', keyboard, true);
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      if (popup.matches(':popover-open')) popup.hidePopover();
    };
  }, [menu, closeMenu]);
  const guard = () => !editorBusy && (!dirty || window.confirm(t('原文件尚未保存，确定离开吗？', 'The original file has not been saved. Leave this file?')));
  const choose = (entry?: LibraryEntry) => {
    if (entry?.id === selected?.id || !guard()) return; setDirty(false); setSelected(entry); setExpanded(false);
    const url = new URL(location.href); if (entry) url.searchParams.set('file', entry.id); else url.searchParams.delete('file'); history.replaceState(history.state, '', url);
  };
  const navigate = (next: string) => { if (!guard()) return; setDirty(false); setSelected(undefined); setSection(next); setQuery(''); setError(''); history.replaceState(history.state, '', '/workbench/library'); };
  const prefix = section.startsWith('folder:') ? section.slice(7) : '';
  const destination = (name: string) => prefix ? `${prefix}/${name}` : name;
  const openDialog = (next: Dialog) => {
    if (next.kind !== 'agent' && !guard()) return;
    setDialog(next); setDialogError(''); setValue(next.kind === 'new' ? destination(t('未命名.md', 'Untitled.md')) : next.kind === 'folder' ? destination(t('新文件夹', 'New folder')) : next.kind === 'agent' ? '' : next.path ?? next.entry?.path ?? '');
  };
  const run = async (label: string, action: () => Promise<void>) => { if (busy) return; setBusy(label); setError(''); try { await action(); } catch (error) { setError(errorText(error)); } finally { setBusy(''); } };
  const upload = (files: FileList | File[]) => {
    const batch = Array.from(files); if (!batch.length) return;
    const queue = ensureImportQueue();
    const taken = new Set(index.entries.map(item => item.path));
    const sources = batch.map(file => {
      const key = `import-${++importSeqRef.current}:${file.name}:${file.size}`;
      importHandlesRef.current.set(key, file);
      const path = destination(uniqueImportPath(file.name, taken));
      taken.add(path);
      return { key, name: file.name, path, size: file.size, handle: file };
    });
    setImportVisible(true); setError('');
    queue.enqueue(sources);
  };
  const active = index.entries.filter(item => !item.trashedAt);
  const searchContent = Boolean(query.trim()) && section !== 'trash' && (type === 'all' || type === 'text');
  const visibleContentHits = searchContent ? contentSearch.hits : [];
  const contentSearchPending = searchContent && contentSearch.loading && !contentSearch.hits.length;
  // A partial index must never present itself as a definitive "no matches".
  const contentSearchInconclusive = searchContent && contentSearch.partial && !contentSearch.hits.length && !contentSearchPending && !contentSearch.error;
  const label = section === 'recent' ? t('最近', 'Recent') : section === 'trash' ? t('回收站', 'Trash') : prefix ? prefix.split('/').at(-1) : t('我的资料', 'My files');
  const entries = index.entries.filter(item => section === 'trash' ? Boolean(item.trashedAt) && !item.parentTrash : !item.trashedAt && (!prefix || query || item.path.slice(0, item.path.lastIndexOf('/')) === prefix)).filter(item => (!query || item.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (type === 'all' || libraryKind(item.name) === type)).sort((a, b) => (section === 'recent' ? b.accessedAt ?? b.modifiedAt : b.modifiedAt).localeCompare(section === 'recent' ? a.accessedAt ?? a.modifiedAt : a.modifiedAt));
  const folders = section === 'all' || prefix ? index.folders.filter(folder => (folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '') === prefix && (!query || folder.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) : [];
  const submit = async () => {
    if (!dialog || busy) return; setBusy(t('正在处理…', 'Working…')); setDialogError('');
    try {
      let created: LibraryEntry | undefined;
      if (dialog.kind === 'bulk-move') { const destinationFolder = value.trim(); setDialog(undefined); startBulk('move', destinationFolder); return; }
      if (dialog.kind === 'bulk-restore') { const destinationFolder = value.trim(); setDialog(undefined); startBulk('restore', destinationFolder); return; }
      if (dialog.kind === 'folder') await request('library/folder', { path: value.trim() });
      if (dialog.kind === 'new') { if (libraryKind(value.trim()) !== 'text') throw new Error(t('新建资料请使用文本格式，例如 .md、.txt、.csv 或 .html。', 'Use a text format such as .md, .txt, .csv or .html for new files.')); created = await saveLibraryFile(request, value.trim(), new TextEncoder().encode('')); }
      if (dialog.kind === 'move') await request('library/move', { from: dialog.path, to: value.trim() });
      if (dialog.kind === 'trash') await request('library/trash', { path: dialog.path });
      if (dialog.kind === 'restore') await request('library/restore', { id: dialog.entry?.id, path: value.trim() });
      if (dialog.kind === 'agent') {
        if (!value.trim()) return;
        const workspace = await request<Workspace>('library/workspace'); await refreshWorkbench(); setDialog(undefined);
        const model = models.find(item => item.isDefault) ?? models[0];
        const input = `${value.trim()}\n\n[个人资料库上下文]\n这是个人资料库任务。请先阅读工作目录中的 AGENTS.md。资料文件在 files/；使用 .knorvia-library/tools/personal-library-cli.js（Node）操作可保留历史版本和回收站。${dialog.entry ? `\n选中的资料：${JSON.stringify(`files/${dialog.entry.path}`)}，当前版本：${dialog.entry.sha256}。` : prefix ? `\n当前文件夹：${JSON.stringify(`files/${prefix}`)}。` : ''}\n完成后报告资料库内的相对路径。`;
        await newTask(input, { workspaceId: workspace.id, cwd: workspace.cwd ?? undefined, model: model?.model ?? model?.id, write: true }); return;
      }
      setDirty(false); setDialog(undefined); await refresh(created); if (created) choose(created);
      setNotice(dialog.kind === 'trash' ? t('已移入回收站', 'Moved to trash') : t('资料库已更新', 'Library updated'));
    } catch (error) { setDialogError(errorText(error)); } finally { setBusy(''); }
  };
  const actions = (path: string, entry?: LibraryEntry, place = "list") => <div className="nl-row-actions"><button className="nw-icon" aria-label={`${t('资料操作', 'File actions')}: ${path}`} aria-haspopup="menu" aria-controls={menu === `${place}:${path}` ? menuId : undefined} aria-expanded={menu === `${place}:${path}`} onClick={event => { event.stopPropagation(); if (menu === `${place}:${path}`) closeMenu(true); else openMenu(event.currentTarget, `${place}:${path}`); }} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openMenu(event.currentTarget, `${place}:${path}`, event.key === 'ArrowUp'); } }}><MoreHorizontal size={16} /></button>{menu === `${place}:${path}` && <div ref={menuRef} id={menuId} popover="auto" role="menu" aria-label={`${t('资料操作', 'File actions')}: ${path}`} className="nl-menu" onToggle={event => { if (!event.currentTarget.matches(':popover-open')) closeMenu(); }} onClick={event => event.stopPropagation()}>{entry?.trashedAt ? <button role="menuitem" onClick={() => { closeMenu(true); openDialog({ kind: 'restore', entry }); }}>{t('恢复', 'Restore')}</button> : <><button role="menuitem" onClick={() => { closeMenu(true); openDialog({ kind: 'move', path }); }}>{t('重命名或移动', 'Rename or move')}</button>{entry && libraryKind(entry.path) === 'text' && entry.size <= 1024 * 1024 && <button role="menuitem" disabled={dirty || !!busy || connection !== 'connected'} onClick={() => { closeMenu(); router.push(`/workbench/learning?source=${encodeURIComponent(entry.id)}`); }}>{t('用这份资料学习', 'Study this source')}</button>}{entry && <button role="menuitem" disabled={dirty} onClick={() => { closeMenu(true); openDialog({ kind: 'agent', entry }); }}>{t('让助手处理', 'Ask assistant')}</button>}<button role="menuitem" onClick={() => { closeMenu(true); openDialog({ kind: 'trash', path }); }}>{t('移入回收站', 'Move to trash')}</button></>}</div>}</div>;
  return <div className={`nl-library ${selected ? 'has-preview' : ''} ${expanded ? 'preview-expanded' : ''}`}>
    <aside className="nl-rail" aria-label={t('资料库导航', 'Library navigation')}><h1><BookOpen size={21} />{t('资料库', 'Library')}</h1><nav><button onClick={() => { if (!guard()) return; setDirty(false); setSelected(undefined); setExpanded(false); setFocusSearch(true); history.replaceState(history.state, '', '/workbench/library'); }}><Search size={16} />{t('搜索', 'Search')}</button><button className={section === 'recent' ? 'is-active' : ''} onClick={() => navigate('recent')}><Clock3 size={16} />{t('最近', 'Recent')}</button><button className={section === 'all' ? 'is-active' : ''} onClick={() => navigate('all')}><BookOpen size={16} />{t('我的资料', 'My files')}</button><button className={section === 'trash' ? 'is-active' : ''} onClick={() => navigate('trash')}><Trash2 size={16} />{t('回收站', 'Trash')}</button></nav>
      <div className="nl-folder-heading"><span>{t('我的资料', 'My files')}</span><button className="nw-icon" disabled={!!busy} aria-label={t('新建资料文件夹', 'New library folder')} onClick={() => openDialog({ kind: 'folder' })}><Plus size={15} /></button></div>
      <LibraryTree entries={index.entries} folders={index.folders} selected={selected} currentFolder={prefix} openFile={choose} openFolder={folder => navigate(`folder:${folder}`)} actions={(path, entry) => actions(path, entry, "tree")} />
      <footer><span>{t('仅供个人使用 · 本机存储', 'Personal · On this device')}</span><small>{active.length} {t('份资料', 'files')} · {fileSize(active.reduce((sum, item) => sum + item.size, 0))}</small></footer>
    </aside>
    <section className="nl-list-area" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (!busy && section !== 'trash') upload(event.dataTransfer.files); }} aria-label={t('个人资料列表', 'Personal files')}>
      <header className="nl-page-heading"><div><p>{t('个人资料库', 'Personal library')}{prefix && <><ChevronRight size={12} />{prefix}</>}</p><h2>{query ? t('搜索结果', 'Search results') : label}</h2></div><div><button className="nw-icon" disabled={!!busy || dirty} onClick={() => void run(t('正在刷新…', 'Refreshing…'), async () => { await refresh(); })} aria-label={t('刷新资料库', 'Refresh library')}><RefreshCw size={17} /></button>{section !== 'trash' && <><button className="nw-icon nl-new-folder" disabled={!!busy} aria-label={t('新建文件夹', 'New folder')} onClick={() => openDialog({ kind: 'folder' })}><FolderPlus size={17} /></button><button className="nw-button" disabled={!!busy} onClick={() => openDialog({ kind: 'new' })}><Plus size={16} />{t('新建', 'New')}</button><button className="nw-button nw-button-primary" disabled={!!busy} onClick={() => fileInput.current?.click()}><Upload size={15} />{t('上传资料', 'Upload')}</button></>}</div></header>
      <input ref={fileInput} type="file" multiple hidden onChange={event => { if (event.target.files) upload(event.target.files); event.target.value = ''; }} />
      <div className="nl-filters"><label><Search size={16} /><input ref={search} aria-label={t('搜索资料名称或路径', 'Search file names or paths')} placeholder={t('搜索资料名称或路径', 'Search file names or paths')} value={query} onChange={event => setQuery(event.target.value)} /></label><select aria-label={t('资料类型', 'File type')} value={type} onChange={event => setType(event.target.value)}>{[['all', t('全部类型', 'All types')], ['text', t('文本与代码', 'Text and code')], ['docx', 'Word'], ['xlsx', 'Excel'], ['pptx', 'PowerPoint'], ['pdf', 'PDF'], ['image', t('图片', 'Images')], ['audio', t('音频', 'Audio')], ['video', t('视频', 'Video')], ['other', t('其他', 'Other')]].map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
      {error && <p className="nl-error" role="alert">{error}</p>}{busy && <div className="nl-progress" role="status"><Loader2 className="nw-spin" size={15} />{busy}</div>}
      <LibraryImportQueuePanel items={importItems} visible={importVisible} onCancelItem={key => importQueueRef.current?.cancelItem(key)} onCancelBatch={() => importQueueRef.current?.cancelBatch()} onRetryItem={key => void importQueueRef.current?.retryItem(key)} onRetryFailed={() => importQueueRef.current?.retryFailed()} onKeepBoth={item => { const taken = new Set(index.entries.map(entry => entry.path)); void importQueueRef.current?.retryItem(item.key, { path: uniqueImportPath(item.path, taken) }); }} onOverwrite={item => {
        // The daemon requires the current version's sha to accept an
        // overwrite; the result becomes a new version on top of the original.
        const sha = index.entries.find(entry => entry.path === item.path)?.sha256;
        void importQueueRef.current?.retryItem(item.key, { expectedSha256: sha });
      }} onRequeueFiles={picked => {
        const queue = ensureImportQueue();
        const byName = new Map(queue.list().filter(item => item.status === 'stalled').map(item => [item.name, item] as const));
        const sources = picked.flatMap(file => {
          const item = byName.get(file.name); if (!item) return [];
          importHandlesRef.current.set(item.key, file);
          return [{ key: item.key, name: item.name, path: item.path, size: file.size, handle: file }];
        });
        if (sources.length) queue.retryStalled(sources);
      }} onDismiss={() => { setImportVisible(false); persistImport(null); importQueueRef.current = null; importDoneRef.current = 0; }} />
      {index.limited && <p className="nl-editor-hint">{t('当前展示范围为 10,000 项、24 层文件夹；更深目录的原文件仍保留在本机。', 'Displaying up to 10,000 items and 24 folder levels. Other files remain on this device.')}</p>}
      {searchContent && contentSearch.error && <p className="nl-error" role="alert">{t('资料内容搜索失败：', 'Content search failed: ')}{contentSearch.error}</p>}
      {contentSearchPending && <p className="nl-progress" role="status"><Loader2 className="nw-spin" size={15} />{t('正在搜索资料内容…', 'Searching file contents…')}</p>}
      {searchContent && contentSearch.coverage && (contentSearch.coverage.tooLarge > 0 || contentSearch.coverage.unreadable > 0) && <p className="nl-editor-hint" role="note">{t(`部分资料未纳入内容搜索：${contentSearch.coverage.tooLarge} 个超出大小限制，${contentSearch.coverage.unreadable} 个无法读取。`, `Some files were not searched: ${contentSearch.coverage.tooLarge} over the size limit, ${contentSearch.coverage.unreadable} unreadable.`)}</p>}
      {contentSearchInconclusive && <p className="nl-editor-hint" role="note">{t('索引尚未完全刷新，暂时不能确认资料库中有没有其他匹配；稍后可重新搜索。', 'The index has not fully refreshed, so remaining matches cannot be ruled out yet; search again shortly.')}</p>}
      {visibleContentHits.length > 0 && <section className="nl-content-hits" aria-label={t('内容命中', 'Content matches')}><h3>{t('内容命中', 'Content matches')} · {visibleContentHits.length}{contentSearch.partial ? t('（部分索引）', ' (partial index)') : ''}</h3>{visibleContentHits.map(hit => <button key={hit.id} className="nl-content-hit" title={`${hit.path}${hit.stale ? t(' · 内容已更新', ' · content changed') : ''}`} onClick={() => { const entry = index.entries.find(item => item.id === hit.id && !item.trashedAt); if (entry) choose(entry); }}><span className="nl-content-hit-path"><FileText size={14} />{hit.path}</span>{hit.snippets.map(snippet => <span key={snippet.line} className="nl-content-hit-line"><code>{snippet.line}</code>{snippet.text}</span>)}</button>)}{contentSearch.hasMore && <button className="nw-button nl-load-more" disabled={contentSearch.loading} onClick={() => contentSearchRef.current!.more()}>{contentSearch.loading ? t('正在加载…', 'Loading…') : t('显示更多内容命中', 'Show more content matches')}</button>}{contentSearch.capped && <p className="nl-editor-hint">{t('已显示前 1000 条内容命中，请继续用更具体的关键词缩小范围。', 'Showing the first 1000 content matches; narrow the query to see more specific results.')}</p>}</section>}
      {checked.size > 0 && !bulkState && <div className="nl-bulk-bar" role="toolbar" aria-label={t('批量整理所选资料', 'Bulk organize selection')}>
        <span>{t(`已选 ${checked.size} 个文件`, `${checked.size} files selected`)}</span>
        {section !== 'trash' ? <><button className="nw-button" disabled={!!busy || dirty} onClick={() => openDialog({ kind: 'bulk-move' })}>{t('移动到…', 'Move to…')}</button><button className="nw-button" disabled={!!busy || dirty} onClick={() => startBulk('trash', '')}>{t('移入回收站', 'Move to trash')}</button></> : <button className="nw-button" disabled={!!busy || dirty} onClick={() => openDialog({ kind: 'bulk-restore' })}>{t('恢复…', 'Restore…')}</button>}
        <button className="nw-button" onClick={() => setChecked(new Map())}>{t('清除选择', 'Clear selection')}</button>
      </div>}
      {bulkState && bulk && <div className="nl-bulk-progress" role="status">
        <div className="nl-bulk-progress-head">
          <strong>{bulkState.running ? t('正在整理资料…', 'Organizing files…') : bulkState.failed ? t('整理完成，部分未成功', 'Finished; some files need attention') : t('整理完成', 'Finished')}</strong>
          <span>{t(`${bulkState.done}/${bulkState.items.length} 项完成`, `${bulkState.done}/${bulkState.items.length} done`)}{bulkState.failed ? t(`，${bulkState.failed} 项未成功`, `, ${bulkState.failed} failed`) : ''}</span>
          {bulkState.running ? <button className="nw-button" onClick={() => bulk.cancel()}>{t('停止', 'Stop')}</button> : bulkState.failed > 0 ? <>
            {(bulkState.kind === 'move' || bulkState.kind === 'restore') && <label className="nl-bulk-retry">{t('重试目标文件夹', 'Retry destination')}<input value={bulkRetryDestination} onChange={event => setBulkRetryDestination(event.target.value)} placeholder={t('留空沿用原目标', 'Empty keeps the original target')} /></label>}
            <button className="nw-button" onClick={() => void bulk.retryFailed(bulkState.kind === 'trash' || !bulkRetryDestination.trim() ? undefined : bulkRetryDestination.trim())}>{t('仅重试未成功项', 'Retry failed only')}</button>
          </> : null}
          <button className="nw-button" disabled={bulkState.running} onClick={closeBulk}>{t('关闭', 'Close')}</button>
        </div>
        {bulkState.items.some(item => item.status === 'conflict' || item.status === 'failed') && <ul className="nl-bulk-failures">{bulkState.items.filter(item => item.status === 'conflict' || item.status === 'failed').map(item => <li key={item.entry.id}><span>{item.entry.path}</span><small>{item.status === 'conflict' ? t('冲突：目标已存在或文件已变化，未覆盖', 'Conflict: target exists or the file changed; nothing was overwritten') : item.detail}</small></li>)}</ul>}
      </div>}
      <div className="nl-file-list"><div className="nl-list-columns"><span className="nl-name-cell">{entries.length > 0 && <input type="checkbox" aria-label={t('选择全部文件', 'Select all files')} checked={entries.some(entry => !entry.folder) && entries.filter(entry => !entry.folder).every(entry => checked.has(entry.id))} onChange={event => toggleAllChecked(event.target.checked, entries)} />}{t('名称', 'Name')}</span><span>{t('位置', 'Location')}</span><span>{section === 'recent' ? t('最近访问', 'Last opened') : t('修改时间', 'Modified')}</span><span /></div>
        {folders.map(folder => <div className="nl-file-row" key={folder}><button className="nl-file-name" onClick={() => navigate(`folder:${folder}`)}><span className="nl-file-icon is-folder"><Folder size={18} /></span><span>{folder.split('/').at(-1)}<small>{t('文件夹', 'Folder')}</small></span></button><span className="nl-location">{prefix || t('我的资料', 'My files')}</span><span className="nl-date">—</span>{actions(folder)}</div>)}
        {entries.slice(0, shown).map(entry => { const kind = libraryKind(entry.name), Icon = entry.folder ? Folder : kind === 'image' ? Image : kind === 'text' || kind === 'docx' ? FileText : File; return <div className={`nl-file-row ${selected?.id === entry.id ? 'is-selected' : ''}`} key={entry.id}><span className="nl-name-cell">{!entry.folder && <input type="checkbox" className="nl-bulk-check" aria-label={`${t('选择资料', 'Select file')}: ${entry.path}`} checked={checked.has(entry.id)} onChange={event => toggleChecked(entry, event.target.checked)} />}<button className="nl-file-name" title={entry.path} onClick={() => entry.trashedAt ? openDialog({ kind: 'restore', entry }) : choose(entry)}><span className={`nl-file-icon is-${kind}`}><Icon size={18} /></span><span>{entry.name}<small>{entry.folder ? t('文件夹', 'Folder') : fileSize(entry.size)}</small></span></button></span><span className="nl-location" title={entry.path}>{entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : t('我的资料', 'My files')}</span><time className="nl-date">{new Date(section === 'recent' ? entry.accessedAt ?? entry.modifiedAt : entry.modifiedAt).toLocaleDateString()}</time>{actions(entry.path, entry)}</div>; })}
        {entries.length > shown && <button className="nw-button nl-load-more" onClick={() => setShown(value => value + 100)}>{t("显示更多资料", "Show more files")} ({entries.length - shown})</button>}{loading ? <div className="nl-empty"><Loader2 className="nw-spin" /><p>{t('正在打开资料库…', 'Opening your library…')}</p></div> : !entries.length && !folders.length && !visibleContentHits.length && !contentSearchPending && !contentSearchInconclusive && !(searchContent && contentSearch.error) ? <div className="nl-empty"><div className="nl-empty-symbol"><BookOpen size={32} /></div><h3>{query ? t('没有找到资料', 'No matching files') : section === 'trash' ? t('回收站是空的', 'Trash is empty') : t('把需要的资料放在一起', 'Keep your useful files together')}</h3><p>{query ? t('换一个名称、路径、内容关键词或类型试试。', 'Try a different name, path, keyword or file type.') : section === 'trash' ? t('移除的资料会保留在这里，随时可以恢复。', 'Removed files stay here so you can restore them.') : t('拖入文档、表格、图片或其他文件，也可以新建一份笔记。', 'Drop documents, spreadsheets, images or other files here, or create a note.')}</p>{section !== 'trash' && !query && <button className="nw-button" onClick={() => fileInput.current?.click()}><Upload size={15} />{t('添加第一份资料', 'Add your first file')}</button>}</div> : null}
      </div>
      {section !== 'trash' && <footer className="nl-assistant-bar"><Sparkles size={19} /><div><strong>{t('让资料继续发挥作用', 'Keep working with your files')}</strong><span>{t('让助手整理、修改，或把新成果放进来。', 'Ask your assistant to organize, edit, or add new work.')}</span></div><button className="nw-button" disabled={!!busy || dirty} onClick={() => openDialog({ kind: 'agent', entry: selected })}>{t('让助手处理', 'Ask assistant')}</button></footer>}
    </section>
    {selected && !selected.trashedAt && <LibraryEditor key={selected.id} entry={selected} close={() => choose(undefined)} changed={async entry => { if (entry) { setSelected(entry); const url = new URL(location.href); url.searchParams.set('file', entry.id); history.replaceState(history.state, '', url); } await refresh(entry); }} dirtyChange={setDirty} busyChange={setEditorBusy} expanded={expanded} expand={() => setExpanded(value => !value)} assist={() => openDialog({ kind: "agent", entry: selected })} />}
    {dialog && <Modal busy={!!bulkState?.running} title={dialog.kind === 'folder' ? t('新建文件夹', 'New folder') : dialog.kind === 'new' ? t('新建资料', 'New file') : dialog.kind === 'move' ? t('重命名或移动', 'Rename or move') : dialog.kind === 'trash' ? t('移入回收站', 'Move to trash') : dialog.kind === 'restore' ? t('恢复资料', 'Restore file') : dialog.kind === 'bulk-move' ? t('批量移动到文件夹', 'Batch move to folder') : dialog.kind === 'bulk-restore' ? t('批量恢复资料', 'Batch restore files') : t('让助手处理资料', 'Ask your assistant')} close={() => { if (!busy) setDialog(undefined); }}><form onSubmit={event => { event.preventDefault(); void submit(); }}>
      {dialog.kind === 'trash' ? <p>{t(`将“${dialog.path}”移入回收站，之后可以恢复。`, `Move “${dialog.path}” to trash. You can restore it later.`)}</p> : dialog.kind === 'agent' ? <><p className="nw-help">{dialog.entry?.path ?? (prefix || t('我的资料', 'My files'))}</p><label className="nw-field">{t('你想怎么处理？', 'What would you like to do?')}<textarea autoFocus required rows={5} value={value} onChange={event => setValue(event.target.value)} placeholder={t('例如：整理这些资料，修改摘要，再生成一份汇总表', 'For example: organize these files, edit the summary, and create a spreadsheet')} /></label><p className="nw-help">{t('会打开一个资料库对话，助手可以读取、创建、修改资料，并把删除的文件移入回收站。', 'Opens a library conversation where the assistant can read, create and edit files, and move removed files to trash.')}</p></> : dialog.kind === 'bulk-move' || dialog.kind === 'bulk-restore' ? <><p className="nw-help">{t(`将为选中的 ${checked.size} 个文件逐项执行；某一项失败不会影响其他文件，结果可逐项重试。`, `Runs once per selected file (${checked.size}). One failure never blocks the rest, and each file can be retried.`)}</p><label className="nw-field">{dialog.kind === 'bulk-move' ? t('目标文件夹', 'Destination folder') : t('恢复到文件夹（留空恢复到原位置）', 'Restore to folder (empty restores in place)')}<input autoFocus required={dialog.kind === 'bulk-move'} value={value} onChange={event => setValue(event.target.value)} placeholder={t('例如：整理/2026', 'e.g. organized/2026')} /></label><p className="nw-help">{dialog.kind === 'bulk-move' ? t('请先创建目标文件夹。目标已有同名资料时该文件会标记冲突，不会覆盖。', 'Create the destination folder first. A name conflict marks that file as conflicted instead of overwriting.') : t('目标已有同名资料时该文件会标记冲突，不会覆盖。', 'A name conflict marks that file as conflicted instead of overwriting.')}</p></> : <><label className="nw-field">{dialog.kind === 'restore' ? t('恢复到', 'Restore to') : t('名称或资料库内路径', 'Name or path within the library')}<input ref={dialogInput} autoFocus required value={value} onChange={event => setValue(event.target.value)} /></label><p className="nw-help">{t('用 / 分隔文件夹与文件名。移动前请先创建目标文件夹。', 'Separate folders and names with /. Create the destination folder before moving a file.')}</p></>}
      {dialogError && <p role="alert" className="nw-inline-error">{dialogError}</p>}<div className="nw-dialog-actions"><button type="button" className="nw-button" disabled={!!busy} onClick={() => setDialog(undefined)}>{t('取消', 'Cancel')}</button><button className="nw-button nw-button-primary" disabled={!!busy || (dialog.kind !== 'trash' && dialog.kind !== 'bulk-restore' && !value.trim())}>{busy ? <Loader2 className="nw-spin" size={14} /> : dialog.kind === 'folder' ? <FolderPlus size={14} /> : null}{dialog.kind === 'trash' ? t('移入回收站', 'Move to trash') : dialog.kind === 'agent' ? t('开始对话', 'Start conversation') : dialog.kind === 'bulk-move' ? t('开始移动', 'Move files') : dialog.kind === 'bulk-restore' ? t('开始恢复', 'Restore files') : t('保存', 'Save')}</button></div>
    </form></Modal>}
  </div>;
}
