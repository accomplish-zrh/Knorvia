"use client";
/* eslint-disable @next/next/no-img-element -- Local personal media is rendered from revocable Blob URLs. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronRight, Copy, Download, History, Loader2, PanelLeftClose, PanelLeftOpen, Pencil, Save, Sparkles, Upload, X } from 'lucide-react';
import { downloadLibraryBytes, libraryKind, libraryMime, MAX_OFFICE_BYTES, MAX_TEXT_BYTES, readLibraryFile, saveLibraryFile, type LibraryEntry, type LibraryVersion } from '@/lib/native-library';
import { cellAddress, parseCellInput } from '@/lib/xlsx-workbook';
import type { CellChange, OfficeDocument } from '@/lib/native-office';
import SpreadsheetGrid from '@/components/chat/preview/previewers/SpreadsheetGrid';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import { Markdown } from './TaskTimeline';
import { clearLibraryDraft, draftKey, keepLibraryDraft, readLibraryDraft, type LibraryDraft } from '@/lib/native-library-draft';
import { Modal } from './WorkbenchShell';

function editedGrid(office: OfficeDocument, cells: CellChange[]) {
  if (!office.grid || !cells.length) return office;
  return { ...office, grid: { ...office.grid, sheets: office.grid.sheets.map((sheet, sheetIndex) => ({ ...sheet, rows: sheet.rows.map((row, r) => row.map((cell, c) => { const change = cells.find(edit => edit.address.sheetIndex === sheetIndex && edit.address.row === r + 1 && edit.address.col === c + 1); return change ? { ...cell, text: change.raw, formula: change.raw.startsWith('=') ? change.raw.slice(1) : undefined } : cell; })) })) } };
}

function WordPreview({ bytes, office, changes }: { bytes: Uint8Array<ArrayBuffer>; office: OfficeDocument; changes: Record<string, string> }) {
  const { t } = useWorkbench(); const [html, setHtml] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    void (async () => {
      const { renderAsync } = await import('docx-preview'); const body = document.createElement('div'), styles = document.createElement('div');
      const preview = Object.keys(changes).length ? await (await import('@/lib/native-office')).saveOffice(office, changes, []) : bytes;
      await renderAsync(preview, body, styles, { inWrapper: true, ignoreWidth: false, useBase64URL: true, renderAltChunks: false, renderComments: false });
      if (!disposed) setHtml(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"><style>body{margin:0;background:#e9ecef}.docx-wrapper{padding:20px!important}section.docx{max-width:100%;box-sizing:border-box}img{max-width:100%}</style>${styles.innerHTML}</head><body>${body.innerHTML}</body></html>`);
    })().catch(error => { if (!disposed) setError(errorText(error)); });
    return () => { disposed = true; };
  }, [bytes, office, changes]);
  return error ? <p role="alert">{error}</p> : html ? <iframe className="nl-preview-frame" title={t('Word 文档预览', 'Word preview')} srcDoc={html} sandbox="" referrerPolicy="no-referrer" /> : <div className="nl-empty"><Loader2 className="nw-spin" /></div>;
}

export function LibraryEditor({ entry, close, changed, dirtyChange, busyChange, expanded, expand, assist }: { entry: LibraryEntry; close: () => void; changed: (entry?: LibraryEntry) => Promise<void>; dirtyChange: (dirty: boolean) => void; busyChange: (busy: boolean) => void; expanded: boolean; expand: () => void; assist: () => void }) {
  const { request, t, setNotice } = useWorkbench();
  const [loaded, setLoaded] = useState<{ bytes: Uint8Array<ArrayBuffer>; sha256: string }>();
  const [office, setOffice] = useState<OfficeDocument>();
  const [text, setText] = useState(''), [original, setOriginal] = useState('');
  const [changes, setChanges] = useState<Record<string, string>>({}), [cells, setCells] = useState<CellChange[]>([]);
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [error, setError] = useState(''), [busy, setBusy] = useState(''), [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<LibraryVersion[] | null>(null), [version, setVersion] = useState<string>();
  const [reload, setReload] = useState(0), [url, setUrl] = useState('');
  const [scope, setScope] = useState(''), [recovered, setRecovered] = useState<LibraryDraft>();
  const [draftState, setDraftState] = useState<'saving' | 'saved' | 'failed' | ''>('');
  const [copyName, setCopyName] = useState<string | null>(null);
  const loadingRef = useRef(true), translator = useRef(t); translator.current = t;
  const replace = useRef<HTMLInputElement>(null), current = useRef(entry); current.current = entry;
  const kind = libraryKind(entry.name); const dirty = text !== original || Object.keys(changes).length > 0 || cells.length > 0;
  const canEdit = !entry.trashedAt && !version && (kind === 'text' ? entry.size <= MAX_TEXT_BYTES && loaded !== undefined : office !== undefined);
  useEffect(() => { dirtyChange(dirty); }, [dirty, dirtyChange]);
  useEffect(() => { busyChange(Boolean(busy)); return () => busyChange(false); }, [busy, busyChange]);
  useEffect(() => {
    if (loadingRef.current || loading || !loaded || !scope || version) return;
    let current = true;
    if (!dirty) { void clearLibraryDraft(scope, entry.id, recovered).catch(() => { if (current) setDraftState('failed'); }); return () => { current = false; }; }
    setDraftState('saving');
    const draft: LibraryDraft = { key: draftKey(scope, entry.id), scope, fileId: entry.id, path: entry.path, baseSha256: loaded.sha256, ...(kind === 'text' ? { text } : {}), changes, cells, updatedAt: Date.now() };
    void keepLibraryDraft(draft).then(() => { if (current) setDraftState('saved'); }).catch(() => { if (current) setDraftState('failed'); });
    return () => { current = false; };
  }, [dirty, loading, loaded, scope, version, entry.id, entry.path, kind, text, changes, cells, recovered]);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const link = (event: MouseEvent) => { if (!(event.target instanceof Element) || !event.target.closest('a[href]') || event.defaultPrevented) return; if (!window.confirm(t('编辑还未保存，确定离开吗？', 'Leave without saving your edits?'))) { event.preventDefault(); event.stopImmediatePropagation(); } };
    window.addEventListener('beforeunload', unload); document.addEventListener('click', link, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', link, true); };
  }, [dirty, t]);
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = ''; const t = translator.current; loadingRef.current = true;
    setLoading(true); setError(''); setLoaded(undefined); setOffice(undefined); setText(''); setOriginal(''); setChanges({}); setCells([]); setUrl(''); setMode('preview');
    setRecovered(undefined); setDraftState('');
    void (async () => {
      if (kind === 'other' || (kind === 'text' && current.current.size > MAX_TEXT_BYTES) || (['docx', 'xlsx', 'pptx'].includes(kind) && current.current.size > MAX_OFFICE_BYTES)) return;
      const info = await request<{ root: string }>('library/info'); controller.signal.throwIfAborted(); setScope(info.root);
      const draft = !version ? await readLibraryDraft(info.root, current.current.id).catch(() => { setDraftState('failed'); return undefined; }) : undefined;
      controller.signal.throwIfAborted();
      const result = await readLibraryFile(request, current.current, version ?? draft?.baseSha256, controller.signal);
      setRecovered(draft);
      if (kind === 'text') {
        let value: string; try { value = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes); } catch { throw new Error(t('此文本不是 UTF-8 编码，请下载转换后替换。', 'This text is not UTF-8. Convert it before replacing the file.')); }
        if (value.includes('\u0000')) throw new Error(t('文件包含二进制内容，请下载查看。', 'This file contains binary content. Download it to view.'));
        setText(draft?.text ?? value); setOriginal(value);
      } else if (kind === 'docx' || kind === 'pptx' || kind === 'xlsx') {
        const { loadOffice } = await import('@/lib/native-office'); const value = await loadOffice(result.bytes, kind); controller.signal.throwIfAborted(); setOffice(editedGrid(value, draft?.cells ?? []));
      } else { objectUrl = URL.createObjectURL(new Blob([result.bytes], { type: libraryMime(current.current.name) })); setUrl(objectUrl); }
      setLoaded(result);
      if (draft) { setChanges(draft.changes); setCells(draft.cells); setMode('edit'); }
    })().catch(error => { if (!controller.signal.aborted) setError(errorText(error)); }).finally(() => { if (!controller.signal.aborted) { loadingRef.current = false; setLoading(false); } });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [entry.id, entry.sha256, kind, version, reload, request]);
  const saved = async (next: LibraryEntry) => {
    loadingRef.current = true;
    await clearLibraryDraft(scope, entry.id, recovered).catch(() => setDraftState('failed'));
    setChanges({}); setCells([]); setOriginal(text); dirtyChange(false); setVersion(undefined); setHistory(null); setRecovered(undefined);
    // The file is already committed. A later list refresh is not a failed save.
    await changed(next).catch(error => setError(errorText(error))); setReload(value => value + 1); setNotice(t('已保存，旧版本可在历史记录中找回', 'Saved. Previous versions are available in history.'));
  };
  const perform = async (label: string, action: () => Promise<void>) => { if (busy) return; setBusy(label); setError(''); try { await action(); } catch (error) { setError(errorText(error)); } finally { setBusy(''); } };
  const save = useCallback(async () => {
    if (!loaded || !dirty || busy || !canEdit) return;
    setBusy(t('正在保存…', 'Saving…')); setError('');
    try { const bytes = kind === 'text' ? new TextEncoder().encode(text) : await (await import('@/lib/native-office')).saveOffice(office!, changes, cells); await saved(await saveLibraryFile(request, entry.path, bytes, loaded.sha256)); }
    catch (error) { setError(errorText(error)); } finally { setBusy(''); }
  // The current edit snapshot is intentionally captured for a single save.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, dirty, busy, canEdit, text, office, changes, cells, entry.path, request, kind, t]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return; if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); } }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, [save]);
  const confirmDiscard = () => !dirty || window.confirm(t('编辑还未保存，放弃这些修改吗？', 'Discard unsaved edits?'));
  return <aside className={`nl-inspector ${expanded ? 'is-expanded' : ''}`} aria-label={t('资料预览与编辑', 'Library preview and editor')}>
    <header className="nl-inspector-heading"><button className="nw-icon" onClick={expand} aria-label={expanded ? t('展开资料目录', 'Show file directory') : t('收起资料目录', 'Hide file directory')}>{expanded ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button><div className="nl-document-breadcrumb"><button onClick={close}><BookOpen size={15} />{t('我的资料', 'My files')}</button><ChevronRight size={13} /><strong title={entry.path}>{entry.name}</strong>{dirty && <i title={t('有未保存的修改', 'Unsaved changes')} />}{version && <span>{t('历史版本', 'Previous version')}</span>}</div><div className="nl-document-actions">{canEdit && <button className="nw-icon" disabled={!!busy} aria-label={t("另存为", "Save a copy")} title={t("另存为", "Save a copy")} onClick={() => setCopyName(entry.path.replace(/(\.[^./]+)?$/, (_, ext = "") => `-copy${ext}`))}><Copy size={17} /></button>}{!entry.trashedAt && <button className="nw-icon" disabled={!!busy} aria-label={t("替换文件", "Replace file")} title={t("替换文件", "Replace file")} onClick={() => { if (confirmDiscard()) replace.current?.click(); }}><Upload size={17} /></button>}{canEdit && <button className="nw-icon" disabled={!!busy} aria-label={mode === 'edit' ? t('返回文档预览', 'Return to document preview') : t('编辑这份资料', 'Edit this file')} title={t('编辑这份资料', 'Edit this file')} aria-pressed={mode === 'edit'} onClick={() => setMode(current => current === 'edit' ? 'preview' : 'edit')}><Pencil size={17} /></button>}<button className="nw-icon" disabled={dirty || !!busy} aria-label={t('让助手处理当前资料', 'Ask assistant about this file')} title={t('让助手处理当前资料', 'Ask assistant about this file')} onClick={assist}><Sparkles size={17} /></button><button className="nw-icon" disabled={!!busy || dirty} aria-label={t('版本历史', 'Version history')} title={t('版本历史', 'Version history')} onClick={() => void perform('', async () => { setHistory(history ? null : await request<LibraryVersion[]>('library/versions', { id: entry.id })); })}><History size={17} /></button><button className="nw-icon" disabled={!!busy} aria-label={t('下载资料', 'Download file')} title={t('下载资料', 'Download file')} onClick={() => void perform(t('正在下载…', 'Downloading…'), async () => { const bytes = dirty && loaded ? kind === 'text' ? new TextEncoder().encode(text) : office ? await (await import('@/lib/native-office')).saveOffice(office, changes, cells) : loaded.bytes : loaded?.bytes ?? (await readLibraryFile(request, entry, version)).bytes; downloadLibraryBytes(entry.name, bytes); })}><Download size={17} /></button><button className="nw-icon" disabled={!!busy} onClick={close} aria-label={t('关闭资料预览', 'Close library preview')}><X size={17} /></button></div></header>
    <div className={`nl-editor-toolbar ${mode === "edit" ? "is-editing" : "is-preview"}`}><div className="nl-segments"><button aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>{t('预览', 'Preview')}</button>{canEdit && <button aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}><Pencil size={13} />{kind === 'docx' || kind === 'pptx' ? t('编辑文字', 'Edit text') : t('编辑', 'Edit')}</button>}</div><div>
      {canEdit && <button className="nw-button nw-button-primary" disabled={!dirty || !!busy} onClick={() => void save()}><Save size={14} />{t('保存', 'Save')}</button>}
    </div></div>
    <input ref={replace} type="file" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void perform(t('正在替换…', 'Replacing…'), async () => { if (file.name.split('.').at(-1)?.toLowerCase() !== entry.name.split('.').at(-1)?.toLowerCase()) throw new Error(t('请选择相同格式的文件，其他格式可作为新资料上传。', 'Choose the same format, or upload the file as a new item.')); await saved(await saveLibraryFile(request, entry.path, file, loaded?.sha256 ?? entry.sha256)); }); }} />
    {history && <div className="nl-history"><strong>{t('版本历史', 'Version history')}</strong>{history.map((item, i) => <button key={`${item.sha256}:${i}`} aria-pressed={version === item.sha256} onClick={() => { if (confirmDiscard()) setVersion(item.sha256); }}><History size={14} /><span>{new Date(item.at).toLocaleString()}<small>{i === 0 ? t('最新版本', 'Latest version') : t('历史版本', 'Previous version')}</small></span></button>)}</div>}
    {version && <div className="nl-version-bar"><span>{t('正在查看历史内容', 'Viewing a previous version')}</span><button className="nw-button" onClick={() => { setVersion(undefined); setHistory(null); }}>{t('返回当前', 'Back to current')}</button>{!entry.trashedAt && <button className="nw-button" disabled={!!busy} onClick={() => void perform(t('正在恢复…', 'Restoring…'), async () => saved(await request<LibraryEntry>('library/revert', { id: entry.id, version, expectedSha256: entry.sha256 })))}>{t('恢复此版本', 'Restore this version')}</button>}</div>}
    {error && <div className="nl-editor-error" role="alert"><span>{error}</span><button className="nw-button" onClick={() => { if (confirmDiscard()) setReload(value => value + 1); }}>{t('重新读取', 'Reload file')}</button>{dirty && kind === 'text' && <button className="nw-button" onClick={() => downloadLibraryBytes(`${entry.name}.draft.txt`, new TextEncoder().encode(text))}>{t('下载我的修改', 'Download my edits')}</button>}</div>}
    {busy && <div className="nl-progress" role="status"><Loader2 className="nw-spin" size={14} />{busy}</div>}
    {!loading && (dirty || draftState === 'failed') && <div className={`nl-draft-bar ${loaded?.sha256 !== entry.sha256 ? 'is-conflict' : ''}`} role="status"><span>{draftState === 'failed' ? t('草稿暂时无法保留，请保存文件或下载修改。', 'Draft storage is unavailable. Save the file or download your edits.') : loaded?.sha256 !== entry.sha256 ? t('原文件已有更新。你的修改已保留，可另存为副本。', 'The original file has changed. Your edits are kept; you can save a copy.') : draftState === 'saving' ? t('正在保留草稿…', 'Keeping your draft…') : recovered ? t('已恢复未保存的修改 · 原文件尚未更改', 'Unsaved edits restored · Original file unchanged') : t('草稿已保留 · 原文件尚未更改', 'Draft kept · Original file unchanged')}</span><button className="nw-button" disabled={!!busy} onClick={() => void perform(t('正在丢弃草稿…', 'Discarding draft…'), async () => { if (!window.confirm(t('丢弃这份资料未保存的修改？原文件会保留。', 'Discard unsaved edits to this file? The original will be kept.'))) return; loadingRef.current = true; await clearLibraryDraft(scope, entry.id, recovered); dirtyChange(false); setReload(value => value + 1); })}>{t('丢弃草稿', 'Discard draft')}</button></div>}
    <div className={`nl-editor-body ${mode === 'edit' ? 'is-editing' : ''}`}>
      {loading ? <div className="nl-empty"><Loader2 className="nw-spin" /><p>{t('正在读取资料…', 'Opening file…')}</p></div> : kind === 'text' && loaded ? mode === 'edit' ? <textarea disabled={!!busy} className="nl-text-editor" spellCheck={false} aria-label={t('资料内容', 'File contents')} value={text} onChange={event => setText(event.target.value)} /> : /\.html?$/i.test(entry.name) ? <iframe className="nl-preview-frame" title={entry.name} srcDoc={text} sandbox="allow-scripts" referrerPolicy="no-referrer" /> : /\.(md|markdown|mdx)$/i.test(entry.name) ? <div className="nl-reading"><Markdown text={text} /></div> : <pre className="nl-plain">{text}</pre> : office?.kind === 'xlsx' && office.grid ? <><div className="nl-editor-hint">{t('双击单元格编辑，Enter 确认；公式在 Excel 中打开后重新计算。', 'Double-click a cell to edit, then press Enter. Formulas recalculate when opened in Excel.')}</div><SpreadsheetGrid workbook={office.grid} editable={mode === 'edit' && canEdit && !busy} onCommit={(address, raw) => {
        const parsed = parseCellInput(raw); if (!parsed.ok) { setError(parsed.error); return; }
        setCells(current => [...current.filter(item => item.address.sheetIndex !== address.sheetIndex || item.address.row !== address.row || item.address.col !== address.col), { address, raw }]);
        setOffice(current => current ? editedGrid(current, [{ address, raw }]) : current);
      }} changedCells={cells.map(cell => `${office.grid!.sheets[cell.address.sheetIndex].name}!${cellAddress(cell.address.row, cell.address.col)}`)} />{(office.grid.truncated || office.grid.sheets.some(sheet => sheet.truncated)) && <p className="nl-editor-hint">{t('仅展示前 32 个工作表、每表 1000 行 / 60 列，未显示内容会保留。', 'Showing up to 32 sheets and 1,000 rows / 60 columns per sheet. Other content is preserved.')}</p>}</> : office && mode === 'edit' ? <div className="nl-office-text"><p className="nl-editor-hint">{t('按原文的文字片段编辑，保留其余格式、图片和布局。', 'Edit individual text runs while preserving other formatting, images and layout.')}</p>{office.blocks.map(block => <section key={block.id}><label>{block.label}</label>{block.values.map((value, i) => <textarea disabled={!!busy} key={i} aria-label={`${block.label} · ${i + 1}`} value={changes[`${block.id}:${i}`] ?? value} rows={Math.max(1, Math.min(6, Math.ceil((changes[`${block.id}:${i}`] ?? value).length / 70)))} onChange={event => setChanges(current => { const next = { ...current }; if (event.target.value === value) delete next[`${block.id}:${i}`]; else next[`${block.id}:${i}`] = event.target.value; return next; })} />)}</section>)}</div> : office?.kind === 'docx' && loaded ? <WordPreview bytes={loaded.bytes} office={office} changes={changes} /> : office?.kind === 'pptx' ? <div className="nl-slide-text"><p className="nl-editor-hint">{t('文字概览；完整排版和动画请下载后查看。', 'Text overview. Download for full slide layout and animations.')}</p>{Array.from(new Set(office.blocks.map(block => block.part))).map(part => <section key={part}><small>{t('幻灯片', 'Slide')} {part.match(/slide(\d+)\.xml/)?.[1]}</small>{office.blocks.filter(block => block.part === part).map(block => <p key={block.id}>{block.values.map((value, i) => changes[`${block.id}:${i}`] ?? value).join('')}</p>)}</section>)}</div> : url && kind === 'image' ? <div className="nl-media"><img src={url} alt={entry.name} /></div> : url && kind === 'pdf' ? <iframe className="nl-preview-frame" title={entry.name} src={url} /> : url && kind === 'video' ? <div className="nl-media"><video controls preload="metadata" src={url} onError={() => setError(t('无法播放这个视频，可下载后用本机播放器打开。', 'This video cannot be played here. Download it to open in a local player.'))} /></div> : url && kind === 'audio' ? <div className="nl-media"><audio controls preload="metadata" src={url} onError={() => setError(t('无法播放这个音频，可下载后用本机播放器打开。', 'This audio cannot be played here. Download it to open in a local player.'))} /></div> : <div className="nl-empty"><Download size={28} /><strong>{t('文件已保存在资料库', 'Your file is in the library')}</strong><p>{kind === 'other' ? t('这个格式可下载、替换，或交给助手处理。', 'Download, replace, or ask your assistant to work on this format.') : t('文本预览支持 4 MB、Office 预览支持 25 MB；较大的文件可下载查看。', 'Preview supports text up to 4 MB and Office up to 25 MB. Download larger files to view.')}</p></div>}
    </div>
    <footer className="nl-editor-footer"><span title={entry.path}>{entry.path}</span><span>{dirty ? t('Ctrl S 保存', 'Ctrl S to save') : t('保存在本机', 'Stored on this device')}</span></footer>
    {copyName !== null && <Modal title={t('另存为副本', 'Save a copy')} busy={!!busy} close={() => { if (!busy) setCopyName(null); }}><form onSubmit={event => { event.preventDefault(); if (!copyName.trim()) return; void perform(t('正在保存副本…', 'Saving copy…'), async () => { if (copyName.split('.').at(-1)?.toLowerCase() !== entry.name.split('.').at(-1)?.toLowerCase()) throw new Error(t('请保留原文件的格式后缀。', 'Keep the original file extension.')); const bytes = kind === 'text' ? new TextEncoder().encode(text) : await (await import('@/lib/native-office')).saveOffice(office!, changes, cells); const next = await saveLibraryFile(request, copyName.trim(), bytes); setCopyName(null); await saved(next); }); }}><label className="nw-field">{t('副本名称或路径', 'Copy name or path')}<input autoFocus required value={copyName} disabled={!!busy} onChange={event => setCopyName(event.target.value)} /></label><p className="nw-help">{t('副本包含当前修改，原文件保持原样。', 'The copy includes your current edits. The original file is preserved.')}</p>{error && <p className="nw-inline-error" role="alert">{error}</p>}<div className="nw-dialog-actions"><button type="button" className="nw-button" disabled={!!busy} onClick={() => setCopyName(null)}>{t('取消', 'Cancel')}</button><button className="nw-button nw-button-primary" disabled={!!busy || !copyName.trim()}>{busy ? <Loader2 className="nw-spin" size={14} /> : <Save size={14} />}{t('保存副本', 'Save copy')}</button></div></form></Modal>}
  </aside>;
}
