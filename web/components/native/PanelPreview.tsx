"use client";
/* eslint-disable @next/next/no-img-element -- Local Blob media must keep intrinsic dimensions without a network image proxy. */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Code2, Download, Eye, FileText, Loader2, Plus, RefreshCw } from 'lucide-react';
import type { ProjectFile } from '@/lib/native-project-context';
import type { Artifact, ArtifactContent } from '@/lib/native-workbench-state';
import { previewUrl, type PanelTabView } from '@/lib/native-panel';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import { Markdown } from './TaskTimeline';
import { MediaOutputReader, parseMediaManifest } from './MediaOutputReader';
import { PanelContext, usePanel } from './PanelContext';
import { SaveToLibrary } from './SaveToLibrary';

type Media = { supported: boolean; tooLarge?: boolean; size: number; mime?: string; base64?: string };
export function FilePanelPreview({ threadId, path, artifact, onUseFile, view, updateView }: { threadId: string; path?: string; artifact?: Artifact; onUseFile: (path: string) => void; view?: PanelTabView; updateView?: (value: Partial<PanelTabView>) => void }) {
  const { request, t } = useWorkbench();
  const panel = usePanel();
  const [file, setFile] = useState<ProjectFile>();
  const [media, setMedia] = useState<Media>();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState(view?.source ?? false);
  const container = useRef<HTMLDivElement>(null);
  const reading = useRef({ top: view?.top ?? 0, left: view?.left ?? 0 });
  useLayoutEffect(() => {
    const el = container.current?.querySelector('.nw-preview-reading');
    if (!el) return;
    const restore = () => { if (el.clientHeight) el.scrollTo({ top: reading.current.top, left: reading.current.left, behavior: 'instant' }); };
    restore(); const observer = new ResizeObserver(restore); observer.observe(el);
    return () => observer.disconnect();
  }, [loading, source]);
  const [mediaUrl, setMediaUrl] = useState('');
  const reload = () => { setLoading(true); setError(''); setRevision(value => value + 1); };
  const name = artifact?.title ?? path ?? '';
  const html = /\.html?$/i.test(name) || ['html', 'text/html'].includes(artifact?.type ?? '');
  const markdown = Boolean(artifact) || /\.(md|mdx|markdown)$/i.test(name);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    void (async () => {
      if (artifact) {
        const value = await request<ArtifactContent>('artifact/content', { id: artifact.id });
        if (!cancelled) setText(value.content);
      } else {
        const value = await request<ProjectFile>('workspace/files/read', { threadId, path });
        const kind = /\.(png|jpe?g|gif|webp|svg|avif|bmp|pdf|mp3|wav|ogg|m4a|mp4|webm)$/i.test(path ?? '');
        const image = kind || value.kind === 'binary' ? await request<Media>('preview/read', { threadId, path }) : undefined;
        if (!cancelled) {
          if (image?.base64 && image.mime) { const bytes = Uint8Array.from(atob(image.base64), char => char.charCodeAt(0)); objectUrl = URL.createObjectURL(new Blob([bytes], { type: image.mime })); }
          setFile(value); setText(value.content ?? ''); setMedia(image); setMediaUrl(objectUrl ?? '');
        }
      }
    })().catch(caught => { if (!cancelled) setError(errorText(caught)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [request, threadId, path, artifact, revision]);
  const isText = !media && (!file || file.kind === 'text');
  const mediaManifest = parseMediaManifest(artifact?.type, text);
  return <PanelContext.Provider value={panel ? { ...panel, folder: path?.replaceAll('\\', '/').split('/').slice(0, -1).join('/') ?? '' } : null}><div ref={container} className="nw-preview" aria-label={t('内容预览', 'Content preview')} onScrollCapture={event => { const el = event.target as HTMLElement; if (!el.matches('.nw-preview-reading') || !el.clientHeight) return; reading.current = { top: el.scrollTop, left: el.scrollLeft }; updateView?.(reading.current); }}>
    <div className="nw-preview-toolbar"><span title={name}>{name}</span><div>
      {!loading && !error && <SaveToLibrary name={name} text={artifact ? text : undefined} threadId={threadId} path={path} compact />}
      {isText && (html || markdown) && <button className="nw-icon" aria-label={source ? t('显示预览', 'Show preview') : t('查看源文', 'Show source')} onClick={() => { setSource(value => !value); updateView?.({ source: !source }); }}>{source ? <Eye size={15} /> : <Code2 size={15} />}</button>}
      {path && <button className="nw-icon" aria-label={t('加入任务', 'Add to task')} title={t('加入任务', 'Add to task')} onClick={() => onUseFile(path)}><Plus size={15} /></button>}
      {mediaUrl && <a className="nw-icon" href={mediaUrl} download={name.split(/[\\/]/).at(-1)} aria-label={t('下载文件', 'Download file')}><Download size={15} /></a>}
      <button className="nw-icon" aria-label={t('刷新预览', 'Refresh preview')} onClick={reload}><RefreshCw size={15} /></button>
    </div></div>
    {loading ? <div className="nw-preview-empty"><Loader2 className="nw-spin" size={22} /></div> : error ? <div className="nw-preview-empty" role="alert"><p>{error}</p><button className="nw-button" onClick={reload}>{t('重试', 'Retry')}</button></div> : mediaManifest ? <MediaOutputReader manifest={mediaManifest} /> : media && (!media.supported || media.tooLarge) ? <div className="nw-preview-empty"><FileText size={28} /><p>{media.tooLarge ? t('文件超过 16 MB，暂时无法直接预览。', 'This file exceeds the 16 MB preview limit.') : t('此格式暂不支持直接预览。', 'This format cannot be previewed here yet.')}</p>{path && <button className="nw-button" onClick={() => onUseFile(path)}>{t('加入任务交给助手处理', 'Add to the task')}</button>}</div> : mediaUrl && media?.mime?.startsWith('image/') ? <div className="nw-preview-media"><img src={mediaUrl} alt={name} /></div> : mediaUrl && media?.mime === 'application/pdf' ? <iframe title={name} src={mediaUrl} className="nw-preview-frame" /> : mediaUrl && media?.mime?.startsWith('video/') ? <div className="nw-preview-media"><video controls src={mediaUrl} /></div> : mediaUrl && media?.mime?.startsWith('audio/') ? <div className="nw-preview-media"><audio controls src={mediaUrl} /></div> : html && !source ? <iframe title={name} className="nw-preview-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={text} /> : markdown && !source ? <div className="nw-preview-reading"><Markdown text={text} /></div> : <div className="nw-preview-reading"><pre className="nw-preview-code" aria-label={t('文件内容', 'File contents')}>{text}</pre></div>}
    {file?.truncated && <p className="nw-file-limit">{t('当前只显示文件的前一部分。', 'Only the beginning of this file is shown.')}</p>}
  </div></PanelContext.Provider>;
}

export function BrowserPanel({ initialUrl = '', view, updateView }: { initialUrl?: string; view?: PanelTabView; updateView?: (value: Partial<PanelTabView>) => void }) {
  const { t } = useWorkbench();
  const [history, setHistory] = useState<string[]>(view?.history ?? (initialUrl ? [initialUrl] : []));
  const [index, setIndex] = useState(view?.index ?? (initialUrl ? 0 : -1));
  const [input, setInput] = useState(view?.history?.[view.index ?? 0] ?? initialUrl);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const url = history[index];
  const navigate = (step: number) => { const next = index + step; setIndex(next); setInput(history[next]); setError(''); updateView?.({ history, index: next }); };
  return <div className="nw-browser-panel">
    <form className="nw-browser-toolbar" onSubmit={event => { event.preventDefault(); const next = previewUrl(input.includes('://') ? input : `https://${input}`); if (!next) { setError(t('请输入有效的 http 或 https 网址。', 'Enter a valid http or https address.')); return; } const nextHistory = [...history.slice(0, index + 1), next].slice(-40); setHistory(nextHistory); setIndex(nextHistory.length - 1); setInput(next); setError(''); updateView?.({ history: nextHistory, index: nextHistory.length - 1 }); }}>
      <button type="button" className="nw-icon" aria-label={t('后退网页', 'Go back')} disabled={index <= 0} onClick={() => navigate(-1)}><ArrowLeft size={14} /></button><button type="button" className="nw-icon" aria-label={t('前进网页', 'Go forward')} disabled={index >= history.length - 1} onClick={() => navigate(1)}><ArrowRight size={14} /></button>
      <button type="button" className="nw-icon" aria-label={t('刷新网页', 'Refresh page')} disabled={!url} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} /></button>
      <input autoFocus aria-label={t('网页地址', 'Web address')} placeholder={t('输入网址…', 'Enter a URL…')} value={input} onChange={event => setInput(event.target.value)} /><button className="nw-icon" aria-label={t('打开网页', 'Open web page')}><ArrowRight size={15} /></button>
      {url && <a className="nw-icon" href={url} target="_blank" rel="noopener noreferrer" aria-label={t('在浏览器中打开', 'Open in browser')}><ArrowUpRight size={15} /></a>}
    </form>
    {error && <p role="alert" className="nw-inline-error">{error}</p>}
    {url ? <><iframe key={`${url}:${revision}`} src={url} className="nw-preview-frame" title={t('网页预览', 'Web preview')} sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" /><div className="nw-browser-hint">{t('若网站不允许内嵌显示，可用右上角在浏览器中打开。', 'If a site blocks embedded viewing, open it in your browser using the top-right button.')}</div></> : <div className="nw-preview-empty"><p>{t('在这里打开网站或本地预览，主对话会保留在左侧。', 'Open a website or local preview while keeping your conversation beside it.')}</p></div>}
  </div>;
}
