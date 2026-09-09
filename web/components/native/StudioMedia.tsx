"use client";
/* eslint-disable @next/next/no-img-element -- Private Blob URLs are already local and cannot use the image optimizer. */
import { useEffect, useRef, useState } from 'react';
import { Download, Image as ImageIcon, Loader2, Play, RefreshCw } from 'lucide-react';
import { readStudioOutput, type StudioJob } from '@/lib/native-studio';
import { useWorkbench, errorText } from './NativeWorkbenchProvider';
export function StudioMedia({ job, index = 0, thumbnail = false }: { job: StudioJob; index?: number; thumbnail?: boolean }) {
  const { request, t } = useWorkbench(); const [url, setUrl] = useState(''), [error, setError] = useState(''), [attempt, setAttempt] = useState(0), [visible, setVisible] = useState(!thumbnail);
  const host = useRef<HTMLDivElement>(null), output = job.outputs[index];
  useEffect(() => { if (!thumbnail) return; const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }); if (host.current) observer.observe(host.current); return () => observer.disconnect(); }, [thumbnail]);
  useEffect(() => {
    if (!visible || !output || thumbnail && job.kind === 'video') return;
    const abort = new AbortController(); let objectUrl = '';
    const load = async () => {
      await Promise.resolve(); if (abort.signal.aborted) return; setUrl(''); setError('');
      if (job.kind === 'video') {
        const result = await request<{ url: string }>('studio/playback', { id: job.id, index });
        if (!abort.signal.aborted) setUrl(result.url);
      } else {
        const blob = await readStudioOutput(request, job, index, abort.signal);
        if (!abort.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }
      }
    };
    void load().catch(e => { if (!abort.signal.aborted) setError(errorText(e)); });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [request, job.id, output?.sha256, index, visible, thumbnail, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className={`ns-media ${thumbnail ? 'is-thumbnail' : ''}`} ref={host}>{thumbnail && job.kind === 'video' ? <Play size={28} /> : url ? job.kind === 'video' ? <video controls playsInline preload="metadata" src={url} onError={() => { setUrl(''); setError(t('播放地址已过期或媒体暂不可用，请重新加载', 'The playback link expired or the media is unavailable. Reload to try again.')); }} /> : <img src={url} alt={job.input.prompt} /> : error ? <div role="alert"><ImageIcon size={22} /><span>{t('预览暂不可用', 'Preview unavailable')}</span>{!thumbnail && <><p>{error}</p><button className="nw-button" onClick={() => setAttempt(n => n + 1)}><RefreshCw size={14} />{t('重新加载', 'Reload')}</button></>}</div> : <Loader2 className="nw-spin" size={20} />}{url && !thumbnail && <a className="ns-media-download nw-icon" href={job.kind === 'video' ? `${url}?download=1` : url} download={output.name} aria-label={t('下载原文件', 'Download original')}><Download size={18} /></a>}</div>;
}
