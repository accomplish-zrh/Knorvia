"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { BookOpen, ChevronRight, Clock3, File, FileText, Folder, FolderPlus, Image, Loader2, MoreHorizontal, Plus, RefreshCw, Search, Sparkles, Trash2, Upload } from 'lucide-react';
import { libraryKind, saveLibraryFile, type LibraryEntry, type LibraryIndex } from '@/lib/native-library';
import { fileSize } from '@/lib/native-project-context';
import type { Workspace } from '@/lib/native-workbench-state';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import { Modal } from './WorkbenchShell';
import { LibraryEditor } from './LibraryEditor';
import { LibraryTree } from './LibraryTree';

type Dialog = { kind: 'folder' | 'new' | 'move' | 'trash' | 'restore' | 'agent'; path?: string; entry?: LibraryEntry };
type LibraryContentHit = { id: string; path: string; name: string; sha256: string; totalLines: number; snippets: { line: number; text: string }[] };
export function LibraryView() {
  const { request, t, connection, setNotice, refresh: refreshWorkbench, newTask, models } = useWorkbench();
  const [index, setIndex] = useState<LibraryIndex>({ entries: [], folders: [], limited: false });
  const [section, setSection] = useState('recent'), [query, setQuery] = useState(''), [type, setType] = useState('all');
  const [contentHits, setContentHits] = useState<LibraryContentHit[] | null>(null);
  const [contentSearchError, setContentSearchError] = useState('');
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
  const fileInput = useRef<HTMLInputElement>(null), search = useRef<HTMLInputElement>(null), dialogInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusSearch && !selected) { search.current?.focus(); setFocusSearch(false); } }, [focusSearch, selected]);
  const refresh = useCallback(async (entry?: LibraryEntry) => {
    const next = await request<LibraryIndex>('library/list'); setIndex(next); setLoading(false);
    if (entry) setSelected(next.entries.find(item => item.id === entry.id) ?? entry);
    else setSelected(current => current ? next.entries.find(item => item.id === current.id && !item.trashedAt) : undefined);
    return next;
  }, [request]);
  useEffect(() => {
    setContentHits(null); setContentSearchError('');
    if (!query.trim() || section === 'trash' || (type !== 'all' && type !== 'text')) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void request<{ hits: LibraryContentHit[] }>('library/search', { query, limit: 20 }).then(result => { if (!cancelled) setContentHits(result.hits); }).catch(error => { if (!cancelled) { setContentHits([]); setContentSearchError(errorText(error)); } });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, section, type, request, refresh, connection]);
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
    void run(t('正在导入…', 'Importing…'), async () => {
      let count = 0; const failures: string[] = [];
      for (const file of batch) {
        try { await saveLibraryFile(request, destination(file.name), file, undefined, progress => setBusy(`${t('正在导入', 'Importing')} ${count + 1}/${batch.length} · ${progress}%`)); count++; }
        catch (error) { failures.push(`${file.name}: ${errorText(error)}`); }
      }
      await refresh(); setNotice(t(`已导入 ${count} 份资料`, `Imported ${count} files`)); if (failures.length) throw new Error(failures.join('\n'));
    });
  };
  const active = index.entries.filter(item => !item.trashedAt);
  const searchContent = Boolean(query.trim()) && section !== 'trash' && (type === 'all' || type === 'text');
  const visibleContentHits = searchContent ? contentHits ?? [] : [];
  const contentSearchPending = searchContent && contentHits === null;
  const label = section === 'recent' ? t('最近', 'Recent') : section === 'trash' ? t('回收站', 'Trash') : prefix ? prefix.split('/').at(-1) : t('我的资料', 'My files');
  const entries = index.entries.filter(item => section === 'trash' ? Boolean(item.trashedAt) && !item.parentTrash : !item.trashedAt && (!prefix || query || item.path.slice(0, item.path.lastIndexOf('/')) === prefix)).filter(item => (!query || item.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (type === 'all' || libraryKind(item.name) === type)).sort((a, b) => (section === 'recent' ? b.accessedAt ?? b.modifiedAt : b.modifiedAt).localeCompare(section === 'recent' ? a.accessedAt ?? a.modifiedAt : a.modifiedAt));
  const folders = section === 'all' || prefix ? index.folders.filter(folder => (folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '') === prefix && (!query || folder.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) : [];
  const submit = async () => {
    if (!dialog || busy) return; setBusy(t('正在处理…', 'Working…')); setDialogError('');
    try {
      let created: LibraryEntry | undefined;
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
  const actions = (path: string, entry?: LibraryEntry, place = "list") => <div className="nl-row-actions"><button className="nw-icon" aria-label={`${t('资料操作', 'File actions')}: ${path}`} aria-haspopup="menu" aria-controls={menu === `${place}:${path}` ? menuId : undefined} aria-expanded={menu === `${place}:${path}`} onClick={event => { event.stopPropagation(); if (menu === `${place}:${path}`) closeMenu(true); else openMenu(event.currentTarget, `${place}:${path}`); }} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openMenu(event.currentTarget, `${place}:${path}`, event.key === 'ArrowUp'); } }}><MoreHorizontal size={16} /></button>{menu === `${place}:${path}` && <div ref={menuRef} id={menuId} popover="auto" role="menu" aria-label={`${t('资料操作', 'File actions')}: ${path}`} className="nl-menu" onToggle={event => { if (!event.currentTarget.matches(':popover-open')) closeMenu(); }} onClick={event => event.stopPropagation()}>{entry?.trashedAt ? <button role="menuitem" onClick={() => { closeMenu(true); openDialog({ kind: 'restore', entry }); }}>{t('恢复', 'Restore')}</button> : <><button role="menuitem" onClick={() => { closeMenu(true); openDialog({ kind: 'move', path }); }}>{t('重命名或移动', 'Rename or move')}</button>{entry && <button role="menuitem" disabled={dirty} onClick={() => { closeMenu(true); openDialog({ kind: 'agent', entry }); }}>{t('让助手处理', 'Ask assistant')}</button>}<button role="menuitem" onClick={() => { closeMenu(true); openDialog({ kind: 'trash', path }); }}>{t('移入回收站', 'Move to trash')}</button></>}</div>}</div>;
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
      {index.limited && <p className="nl-editor-hint">{t('当前展示范围为 10,000 项、24 层文件夹；更深目录的原文件仍保留在本机。', 'Displaying up to 10,000 items and 24 folder levels. Other files remain on this device.')}</p>}
      {searchContent && contentSearchError && <p className="nl-error" role="alert">{t('资料内容搜索失败：', 'Content search failed: ')}{contentSearchError}</p>}
      {contentSearchPending && <p className="nl-progress" role="status"><Loader2 className="nw-spin" size={15} />{t('正在搜索资料内容…', 'Searching file contents…')}</p>}
      {visibleContentHits.length > 0 && <section className="nl-content-hits" aria-label={t('内容命中', 'Content matches')}><h3>{t('内容命中', 'Content matches')} · {visibleContentHits.length}</h3>{visibleContentHits.map(hit => <button key={hit.id} className="nl-content-hit" title={hit.path} onClick={() => { const entry = index.entries.find(item => item.id === hit.id && !item.trashedAt); if (entry) choose(entry); }}><span className="nl-content-hit-path"><FileText size={14} />{hit.path}</span>{hit.snippets.map(snippet => <span key={snippet.line} className="nl-content-hit-line"><code>{snippet.line}</code>{snippet.text}</span>)}</button>)}</section>}
      <div className="nl-file-list"><div className="nl-list-columns"><span>{t('名称', 'Name')}</span><span>{t('位置', 'Location')}</span><span>{section === 'recent' ? t('最近访问', 'Last opened') : t('修改时间', 'Modified')}</span><span /></div>
        {folders.map(folder => <div className="nl-file-row" key={folder}><button className="nl-file-name" onClick={() => navigate(`folder:${folder}`)}><span className="nl-file-icon is-folder"><Folder size={18} /></span><span>{folder.split('/').at(-1)}<small>{t('文件夹', 'Folder')}</small></span></button><span className="nl-location">{prefix || t('我的资料', 'My files')}</span><span className="nl-date">—</span>{actions(folder)}</div>)}
        {entries.slice(0, shown).map(entry => { const kind = libraryKind(entry.name), Icon = entry.folder ? Folder : kind === 'image' ? Image : kind === 'text' || kind === 'docx' ? FileText : File; return <div className={`nl-file-row ${selected?.id === entry.id ? 'is-selected' : ''}`} key={entry.id}><button className="nl-file-name" title={entry.path} onClick={() => entry.trashedAt ? openDialog({ kind: 'restore', entry }) : choose(entry)}><span className={`nl-file-icon is-${kind}`}><Icon size={18} /></span><span>{entry.name}<small>{entry.folder ? t('文件夹', 'Folder') : fileSize(entry.size)}</small></span></button><span className="nl-location" title={entry.path}>{entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : t('我的资料', 'My files')}</span><time className="nl-date">{new Date(section === 'recent' ? entry.accessedAt ?? entry.modifiedAt : entry.modifiedAt).toLocaleDateString()}</time>{actions(entry.path, entry)}</div>; })}
        {entries.length > shown && <button className="nw-button nl-load-more" onClick={() => setShown(value => value + 100)}>{t("显示更多资料", "Show more files")} ({entries.length - shown})</button>}{loading ? <div className="nl-empty"><Loader2 className="nw-spin" /><p>{t('正在打开资料库…', 'Opening your library…')}</p></div> : !entries.length && !folders.length && !visibleContentHits.length && !contentSearchPending && !(searchContent && contentSearchError) ? <div className="nl-empty"><div className="nl-empty-symbol"><BookOpen size={32} /></div><h3>{query ? t('没有找到资料', 'No matching files') : section === 'trash' ? t('回收站是空的', 'Trash is empty') : t('把需要的资料放在一起', 'Keep your useful files together')}</h3><p>{query ? t('换一个名称、路径、内容关键词或类型试试。', 'Try a different name, path, keyword or file type.') : section === 'trash' ? t('移除的资料会保留在这里，随时可以恢复。', 'Removed files stay here so you can restore them.') : t('拖入文档、表格、图片或其他文件，也可以新建一份笔记。', 'Drop documents, spreadsheets, images or other files here, or create a note.')}</p>{section !== 'trash' && !query && <button className="nw-button" onClick={() => fileInput.current?.click()}><Upload size={15} />{t('添加第一份资料', 'Add your first file')}</button>}</div> : null}
      </div>
      {section !== 'trash' && <footer className="nl-assistant-bar"><Sparkles size={19} /><div><strong>{t('让资料继续发挥作用', 'Keep working with your files')}</strong><span>{t('让助手整理、修改，或把新成果放进来。', 'Ask your assistant to organize, edit, or add new work.')}</span></div><button className="nw-button" disabled={!!busy || dirty} onClick={() => openDialog({ kind: 'agent', entry: selected })}>{t('让助手处理', 'Ask assistant')}</button></footer>}
    </section>
    {selected && !selected.trashedAt && <LibraryEditor key={selected.id} entry={selected} close={() => choose(undefined)} changed={async entry => { if (entry) { setSelected(entry); const url = new URL(location.href); url.searchParams.set('file', entry.id); history.replaceState(history.state, '', url); } await refresh(entry); }} dirtyChange={setDirty} busyChange={setEditorBusy} expanded={expanded} expand={() => setExpanded(value => !value)} assist={() => openDialog({ kind: "agent", entry: selected })} />}
    {dialog && <Modal busy={!!busy} title={dialog.kind === 'folder' ? t('新建文件夹', 'New folder') : dialog.kind === 'new' ? t('新建资料', 'New file') : dialog.kind === 'move' ? t('重命名或移动', 'Rename or move') : dialog.kind === 'trash' ? t('移入回收站', 'Move to trash') : dialog.kind === 'restore' ? t('恢复资料', 'Restore file') : t('让助手处理资料', 'Ask your assistant')} close={() => { if (!busy) setDialog(undefined); }}><form onSubmit={event => { event.preventDefault(); void submit(); }}>
      {dialog.kind === 'trash' ? <p>{t(`将“${dialog.path}”移入回收站，之后可以恢复。`, `Move “${dialog.path}” to trash. You can restore it later.`)}</p> : dialog.kind === 'agent' ? <><p className="nw-help">{dialog.entry?.path ?? (prefix || t('我的资料', 'My files'))}</p><label className="nw-field">{t('你想怎么处理？', 'What would you like to do?')}<textarea autoFocus required rows={5} value={value} onChange={event => setValue(event.target.value)} placeholder={t('例如：整理这些资料，修改摘要，再生成一份汇总表', 'For example: organize these files, edit the summary, and create a spreadsheet')} /></label><p className="nw-help">{t('会打开一个资料库对话，助手可以读取、创建、修改资料，并把删除的文件移入回收站。', 'Opens a library conversation where the assistant can read, create and edit files, and move removed files to trash.')}</p></> : <><label className="nw-field">{dialog.kind === 'restore' ? t('恢复到', 'Restore to') : t('名称或资料库内路径', 'Name or path within the library')}<input ref={dialogInput} autoFocus required value={value} onChange={event => setValue(event.target.value)} /></label><p className="nw-help">{t('用 / 分隔文件夹与文件名。移动前请先创建目标文件夹。', 'Separate folders and names with /. Create the destination folder before moving a file.')}</p></>}
      {dialogError && <p role="alert" className="nw-inline-error">{dialogError}</p>}<div className="nw-dialog-actions"><button type="button" className="nw-button" disabled={!!busy} onClick={() => setDialog(undefined)}>{t('取消', 'Cancel')}</button><button className="nw-button nw-button-primary" disabled={!!busy || (dialog.kind !== 'trash' && !value.trim())}>{busy ? <Loader2 className="nw-spin" size={14} /> : dialog.kind === 'folder' ? <FolderPlus size={14} /> : null}{dialog.kind === 'trash' ? t('移入回收站', 'Move to trash') : dialog.kind === 'agent' ? t('开始对话', 'Start conversation') : t('保存', 'Save')}</button></div>
    </form></Modal>}
  </div>;
}
