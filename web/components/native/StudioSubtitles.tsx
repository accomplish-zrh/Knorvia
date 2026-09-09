"use client";
import { useEffect, useRef, useState } from 'react';
import { Captions, Download, Loader2, Plus, Trash2, Upload } from 'lucide-react';
import { editFrames, type EditCaption, type EditProject } from '@/lib/studio-edit';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
type SubtitleJob = { id: string; status: string; revision: number; phase: string; progress: number; error?: string; cancelRequested?: boolean; captions?: EditCaption[] };
type Config = { executable: string; model: string; language: string };
export function StudioSubtitles({ project, change, save, accept, disabled, onBusy }: { project: EditProject; change: (p: EditProject) => void; save: () => Promise<EditProject>; accept: (p: EditProject) => void; disabled: boolean; onBusy: (value: boolean) => void }) {
  const { request, t } = useWorkbench();
  const [config, setConfig] = useState<Config>({ executable: '', model: '', language: 'auto' }), [job, setJob] = useState<SubtitleJob>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const jobId = job?.id, status = job?.status, storedId = project.lastSubtitleId;
  useEffect(() => { let live = true; void request<Config>('studio/edit/subtitles/config', {}).then(c => { if (live) setConfig(c); }).catch(e => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, [request]);
  useEffect(() => { if (!storedId) return; let live = true; void request<SubtitleJob>('studio/edit/subtitles/read', { id: storedId }).then(j => { if (live) setJob(j); }).catch(e => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, [request, storedId]);
  useEffect(() => {
    if (!jobId || ['succeeded', 'failed', 'cancelled'].includes(status ?? '')) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const j = await request<SubtitleJob>('studio/edit/subtitles/read', { id: jobId }); if (live) setJob(j); } catch (e) { if (live) setError(errorText(e)); } if (live) timer = setTimeout(poll, 1200); };
    timer = setTimeout(poll, 800); return () => { live = false; clearTimeout(timer); };
  }, [request, jobId, status]);
  const action = async (fn: () => Promise<void>) => { if (busy || disabled) return; setBusy(true); onBusy(true); setError(''); setMessage(''); try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); onBusy(false); } };
  const cues = project.edit.captions ?? [], frames = editFrames(project.edit), running = job && !['succeeded', 'failed', 'cancelled'].includes(job.status);
  const patch = (i: number, value: Partial<EditCaption>) => change({ ...project, edit: { ...project.edit, captions: cues.map((c, index) => index === i ? { ...c, ...value } : c) } });
  return <details className="ns-subtitles"><summary><Captions size={16} />{t('字幕', 'Captions')}{cues.length > 0 && <span>{cues.length}</span>}</summary><div className="ns-subtitles-body">
    <p className="ns-hint">{t('本地识别，支持修改和 SRT 导入导出。MP4 内嵌可切换字幕轨；播放器需支持字幕。', 'Transcribe locally, edit captions, or import/export SRT. MP4 includes a selectable caption track; player support is required.')}</p>
    {error && <p role="alert" className="nw-inline-error">{error}</p>}{message && <p role="status">{message}</p>}
    <details><summary>{t('本地识别设置', 'Local transcription settings')}</summary><fieldset className="ns-subtitle-settings" disabled={busy || disabled}>
      <label>{t('Whisper 程序路径', 'Whisper executable path')}<input value={config.executable} onChange={e => setConfig({ ...config, executable: e.target.value })} placeholder={t("whisper-cli.exe","whisper-cli.exe")} /></label>
      <label>{t('Whisper 模型路径', 'Whisper model path')}<input value={config.model} onChange={e => setConfig({ ...config, model: e.target.value })} placeholder={t("ggml-tiny.bin","ggml-tiny.bin")} /></label>
      <label>{t('语言代码', 'Language code')}<input value={config.language} onChange={e => setConfig({ ...config, language: e.target.value })} placeholder={t("auto / zh / en","auto / zh / en")} /></label>
      <a href="https://github.com/ggml-org/whisper.cpp" target="_blank" rel="noreferrer">{t('获取 Whisper 程序与模型', 'Get Whisper and a model')}</a>
      <button className="nw-button" onClick={() => void action(async () => { setConfig(await request<Config>('studio/edit/subtitles/config/save', config)); setMessage(t('设置已验证并保存', 'Settings validated and saved')); })}>{t('验证并保存', 'Validate and save')}</button>
    </fieldset></details>
    <div className="ns-timeline-actions ns-subtitle-toolbar">
      <button className="nw-button" disabled={busy || disabled || !!running} onClick={() => void action(async () => { const p = await save(); const j = await request<SubtitleJob>('studio/edit/subtitles/start', { id: p.id, revision: p.revision, idempotencyKey: crypto.randomUUID() }); setJob(j); accept({ ...p, lastSubtitleId: j.id }); })}><Captions size={15} />{t('自动识别字幕', 'Transcribe audio')}</button>
      <button className="nw-button" disabled={busy || disabled} onClick={() => upload.current?.click()}><Upload size={15} />{t('导入 SRT', 'Import SRT')}</button>
      <input ref={upload} type="file" accept=".srt" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void action(async () => { if (file.size > 2 * 1024 ** 2) throw new Error(t('字幕文件不能超过 2 MB', 'Caption file must be under 2 MB')); const p = await save(); accept(await request<EditProject>('studio/edit/subtitles/import', { id: p.id, revision: p.revision, content: await file.text() })); }); }} />
      <button className="nw-button" disabled={busy || disabled || !cues.length} onClick={() => void action(async () => { const p = await save(); await request('studio/edit/subtitles/export', { id: p.id, revision: p.revision }); setMessage(t('SRT 已存入资料库', 'SRT saved to library')); })}><Download size={15} />{t('导出 SRT', 'Export SRT')}</button>
    </div>
    {job && <div className="ns-timeline-render" role="status">{running ? <><Loader2 size={16} /><span>{job.phase === 'recognizing' ? t('正在识别语音…', 'Transcribing audio…') : t('正在准备音轨…', 'Preparing audio…')}</span><button className="nw-button" disabled={busy || disabled || job.cancelRequested} onClick={() => void action(async () => { setJob(await request<SubtitleJob>('studio/edit/subtitles/cancel', { id: job.id })); })}>{t('取消识别', 'Cancel transcription')}</button></> : job.status === 'succeeded' ? <><span>{job.captions?.length}{t(' 条字幕待检查', ' captions to review')}</span><button className="nw-button" disabled={busy || disabled || project.appliedSubtitleId === job.id} onClick={() => void action(async () => { const p = await save(); accept(await request<EditProject>('studio/edit/subtitles/apply', { id: job.id, revision: p.revision })); })}>{project.appliedSubtitleId === job.id ? t('已应用', 'Applied') : t('应用到剪辑', 'Apply to edit')}</button></> : <span>{job.error || t('识别已取消', 'Transcription cancelled')}</span>}</div>}
    <ol className="ns-caption-list">{cues.map((c, i) => <li key={i}><input aria-label={t('字幕开始（秒）', 'Caption start (seconds)')} type="number" min="0" step={1 / 30} value={Number((c.startFrame / 30).toFixed(3))} disabled={busy || disabled} onChange={e => patch(i, { startFrame: Math.round(Number(e.target.value) * 30) })} /><input aria-label={t('字幕结束（秒）', 'Caption end (seconds)')} type="number" min="0" step={1 / 30} value={Number((c.endFrame / 30).toFixed(3))} disabled={busy || disabled} onChange={e => patch(i, { endFrame: Math.round(Number(e.target.value) * 30) })} /><textarea aria-label={t('字幕内容', 'Caption text')} maxLength={500} value={c.text} disabled={busy || disabled} onChange={e => patch(i, { text: e.target.value })} /><button className="nw-icon" disabled={busy || disabled} aria-label={t('删除字幕', 'Remove caption')} onClick={() => change({ ...project, edit: { ...project.edit, captions: cues.filter((_, n) => n !== i) } })}><Trash2 size={14} /></button></li>)}</ol>
    <button className="nw-button" disabled={busy || disabled || (cues.at(-1)?.endFrame ?? 0) >= frames} onClick={() => { const startFrame = cues.at(-1)?.endFrame ?? 0; change({ ...project, edit: { ...project.edit, captions: [...cues, { startFrame, endFrame: Math.min(frames, startFrame + 60), text: t('新字幕', 'New caption') }] } }); }}><Plus size={15} />{t('添加字幕', 'Add caption')}</button>
  </div></details>;
}
