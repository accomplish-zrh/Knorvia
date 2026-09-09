'use client';
import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Film, Loader2, Upload, X } from 'lucide-react';
import { saveLibraryFile, type LibraryEntry, type LibraryIndex } from '@/lib/native-library';
import type { EditProject } from '@/lib/studio-edit';
import { Modal } from './WorkbenchShell';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import { StudioTimeline } from './StudioTimeline';
import './studio-edit-library.css';

type ProjectPage = { projects: { id: string; title: string }[]; nextOffset: number | null };
export function StudioEditLibrary() {
  const { request, t } = useWorkbench();
  const [open, setOpen] = useState(false), [projectId, setProjectId] = useState<string>();
  const [entries, setEntries] = useState<LibraryEntry[]>([]), [selected, setSelected] = useState<LibraryEntry[]>([]);
  const [projects, setProjects] = useState<ProjectPage>({ projects: [], nextOffset: null });
  const [title, setTitle] = useState(''), [query, setQuery] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const upload = useRef<HTMLInputElement>(null), importKey = useRef<string | undefined>(undefined);
  const action = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const load = async () => {
    const [library, page] = await Promise.all([request<LibraryIndex>('library/list'), request<ProjectPage>('studio/edit/list')]);
    setEntries(library.entries.filter(e => !e.trashedAt && !e.folder && /\.(mp4|webm)$/i.test(e.name))); setProjects(page);
    if (library.limited) setError(t('资料库列表已达上限，部分素材可能未显示。', 'Library listing reached its limit; some files may not be shown.'));
  };
  const choose = (items: LibraryEntry[]) => { setSelected(items); importKey.current = undefined; };
  const visible = entries.filter(e => e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <>
    <button className="nw-button ns-edit-entry" onClick={() => { setOpen(true); void action(load); }}><Film size={16} />{t('剪辑已有素材', 'Edit existing videos')}</button>
    {projectId && <StudioTimeline key={projectId} projectId={projectId} close={() => setProjectId(undefined)} />}
    {open && <Modal title={t('剪辑已有素材', 'Edit existing videos')} close={() => setOpen(false)} busy={busy}>
      <div className="ns-edit-library">
        <p className="ns-hint">{t('从资料库选择视频，按顺序组装成片。原文件会保留。支持 MP4 / WebM，单个文件最多 256 MB。', 'Choose library videos in order. Originals are preserved. MP4 / WebM, up to 256 MB per file.')}</p>
        {error && <p role="alert" className="nw-inline-error">{error}</p>}
        <label>{t('成片名称', 'Film title')}<input value={title} maxLength={100} disabled={busy} placeholder={t('素材剪辑', 'Video edit')} onChange={e => { setTitle(e.target.value); importKey.current = undefined; }} /></label>
        <div className="ns-edit-library-toolbar"><input aria-label={t('搜索视频素材', 'Search video sources')} placeholder={t('搜索视频素材', 'Search video sources')} value={query} onChange={e => setQuery(e.target.value)} /><button className="nw-button" disabled={busy} onClick={() => upload.current?.click()}><Upload size={15} />{t('上传视频', 'Upload videos')}</button></div>
        <input ref={upload} type="file" multiple accept=".mp4,.webm" hidden aria-label={t('选择本地视频', 'Choose local videos')} onChange={e => {
          const files = Array.from(e.target.files ?? []); e.target.value = '';
          void action(async () => {
            if (!files.length) return;
            if (files.length + selected.length > 40 || files.some(f => !/\.(mp4|webm)$/i.test(f.name) || !f.size || f.size > 256 * 1024 ** 2)) throw new Error(t('最多选择 40 个 MP4 / WebM 视频，每个不超过 256 MB。', 'Select up to 40 MP4 / WebM files, each under 256 MB.'));
            const added = [...selected];
            for (const file of files) {
              const entry = await saveLibraryFile(request, `剪辑素材/${crypto.randomUUID()}/${file.name.replace(/[\\/:*?"<>|]/g, '_').slice(-140)}`, file);
              added.push(entry); choose([...added]);
              setEntries(current => [...current, entry]);
            }
          });
        }} />
        <div className="ns-edit-library-files" aria-label={t('可用视频', 'Available videos')}>
          {!visible.length && <p className="ns-hint">{busy ? t('正在读取…', 'Loading…') : t('暂无匹配的视频，可以先上传。', 'No matching videos. Upload one to start.')}</p>}
          {visible.map(entry => <label key={entry.id}><input type="checkbox" disabled={busy || (selected.length >= 40 && !selected.some(e => e.id === entry.id))} checked={selected.some(e => e.id === entry.id)} onChange={e => choose(e.target.checked ? [...selected, entry] : selected.filter(s => s.id !== entry.id))} /><span title={entry.name}>{entry.name}</span><small>{(entry.size / 1024 ** 2).toFixed(1)} MB</small></label>)}
        </div>
        {!!selected.length && <><strong>{t('成片顺序', 'Film order')} · {selected.length}/40</strong><ol className="ns-edit-library-order">{selected.map((entry, i) => <li key={entry.id}><span>{i + 1}. {entry.name}</span><button className="nw-icon" aria-label={t('前移素材', 'Move source earlier')} disabled={busy || i === 0} onClick={() => { const items = [...selected]; [items[i - 1], items[i]] = [items[i], items[i - 1]]; choose(items); }}><ArrowUp size={14} /></button><button className="nw-icon" aria-label={t('后移素材', 'Move source later')} disabled={busy || i === selected.length - 1} onClick={() => { const items = [...selected]; [items[i + 1], items[i]] = [items[i], items[i + 1]]; choose(items); }}><ArrowDown size={14} /></button><button className="nw-icon" aria-label={t('移除素材', 'Remove source')} disabled={busy} onClick={() => choose(selected.filter(s => s.id !== entry.id))}><X size={14} /></button></li>)}</ol></>}
        <button className="nw-button nw-primary" disabled={busy || !selected.length} onClick={() => void action(async () => {
          importKey.current ??= crypto.randomUUID();
          const p = await request<EditProject>('studio/edit/import', { title: title.trim() || t('素材剪辑', 'Video edit'), references: selected.map(e => ({ id: e.id, version: e.sha256 })), idempotencyKey: importKey.current });
          setProjectId(p.id); setOpen(false); choose([]); setTitle('');
        })}>{busy ? <Loader2 size={15} className="nw-spin" /> : <Film size={15} />}{t('开始剪辑', 'Start editing')}</button>
        {!!projects.projects.length && <details><summary>{t('继续已有剪辑', 'Continue an existing edit')}</summary><div className="ns-edit-library-projects">{projects.projects.map(p => <button key={p.id} className="nw-button" disabled={busy} onClick={() => { setProjectId(p.id); setOpen(false); }}>{p.title}</button>)}</div></details>}
        {projects.nextOffset !== null && <button className="nw-button" disabled={busy} onClick={() => void action(async () => { const page = await request<ProjectPage>('studio/edit/list', { offset: projects.nextOffset }); setProjects(current => ({ ...page, projects: [...current.projects, ...page.projects.filter(p => !current.projects.some(old => old.id === p.id))] })); })}>{t('更多剪辑', 'More edits')}</button>}
      </div>
    </Modal>}
  </>;
}
