"use client";

import { useState } from 'react';
import { BookPlus, Loader2 } from 'lucide-react';
import { saveLibraryFile } from '@/lib/native-library';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import { Modal } from './WorkbenchShell';

export function SaveToLibrary({ name, text, threadId, path, compact = false }: { name: string; text?: string; threadId?: string; path?: string; compact?: boolean }) {
  const { t, request, setNotice } = useWorkbench(); const [open, setOpen] = useState(false), [destination, setDestination] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const start = () => { setDestination(path ? path.split(/[\\/]/).at(-1)! : `${name.replace(/[\x00-\x1f<>:"/\\|?*]/g, '-').slice(0, 60) || '笔记'}-${Date.now()}.md`); setError(''); setOpen(true); };
  return <><button className={compact ? 'nw-icon' : 'nw-save-result'} aria-label={t('存入资料库', 'Save to library')} title={t('存入资料库', 'Save to library')} onClick={start}><BookPlus size={14} />{!compact && t('存入资料库', 'Save to library')}</button>{open && <Modal title={t('存入个人资料库', 'Save to personal library')} busy={busy} close={() => { if (!busy) setOpen(false); }}><form onSubmit={async event => {
    event.preventDefault(); if (busy || !destination.trim()) return; setBusy(true); setError('');
    try { if (path && threadId) await request('library/import-project', { threadId, path, destination: destination.trim() }); else await saveLibraryFile(request, destination.trim(), new TextEncoder().encode(text ?? '')); setOpen(false); setNotice(t('已存入个人资料库', 'Saved to your personal library')); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }}><label className="nw-field">{t('名称或资料库内路径', 'Name or path within the library')}<input autoFocus required value={destination} onChange={event => setDestination(event.target.value)} /></label><p className="nw-help">{t('保存一份副本。已有同名资料时，请换一个名称。', 'Saves a copy. Choose a different name if the file already exists.')}</p>{error && <p className="nw-inline-error" role="alert">{error}</p>}<div className="nw-dialog-actions"><button type="button" className="nw-button" disabled={busy} onClick={() => setOpen(false)}>{t('取消', 'Cancel')}</button><button className="nw-button nw-button-primary" disabled={busy || !destination.trim()}>{busy && <Loader2 className="nw-spin" size={14} />}{t('保存到资料库', 'Save to library')}</button></div></form></Modal>}</>;
}
