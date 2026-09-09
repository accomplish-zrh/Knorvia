"use client";
import { useEffect, useState } from 'react';
import { Loader2, RotateCcw, WandSparkles } from 'lucide-react';
import type { EditProject } from '@/lib/studio-edit';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
type Retake = { id: string; status: string; phase: string; progress: number; error?: string; childId?: string; cancelRequested?: boolean };
type Model = { id: string; name: string; kind: string; inputCapabilities: { firstFrame: boolean; lastFrame: boolean } };
export function StudioRetake({ project, selected, save, accept, disabled, onBusy }: { project: EditProject; selected: string; save: () => Promise<EditProject>; accept: (p: EditProject) => void; disabled: boolean; onBusy: (value: boolean) => void }) {
  const { request, t } = useWorkbench();
  const [models, setModels] = useState<Model[]>([]), [profileId, setProfileId] = useState(''), [prompt, setPrompt] = useState('');
  const [start, setStart] = useState(''), [end, setEnd] = useState(''), [job, setJob] = useState<Retake>(), [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const clip = project.edit.clips.find(c => c.id === selected), first = clip?.startFrame, last = clip?.endFrame;
  useEffect(() => { setStart(first === undefined ? '' : String(Number((first / 30).toFixed(3)))); setEnd(last === undefined ? '' : String(Number((last / 30).toFixed(3)))); }, [selected, first, last]);
  useEffect(() => { let live = true; void request<{ profiles: Model[] }>('studio/models', {}).then(r => { if (live) { const models = r.profiles.filter(p => p.kind === 'video' && p.inputCapabilities.firstFrame && p.inputCapabilities.lastFrame); setModels(models); setProfileId(models[0]?.id ?? ''); } }).catch(e => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, [request]);
  const storedId = project.lastRetakeId, id = job?.id, status = job?.status;
  useEffect(() => { if (!storedId) return; let live = true; void request<Retake>('studio/edit/retake/read', { id: storedId }).then(j => { if (live) setJob(j); }).catch(e => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, [request, storedId]);
  useEffect(() => {
    if (!id || ['succeeded', 'failed', 'cancelled'].includes(status ?? '')) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const j = await request<Retake>('studio/edit/retake/read', { id }); if (live) setJob(j); } catch (e) { if (live) setError(errorText(e)); } if (live) timer = setTimeout(poll, 1500); };
    timer = setTimeout(poll, 1000); return () => { live = false; clearTimeout(timer); };
  }, [request, id, status]);
  const action = async (fn: () => Promise<void>) => { if (busy || disabled) return; setBusy(true); onBusy(true); setError(''); try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); onBusy(false); } };
  const running = job && !['succeeded', 'failed', 'cancelled'].includes(job.status);
  return <details className="ns-subtitles"><summary><WandSparkles size={16} />{t('局部重做', 'Retake a segment')}</summary><div className="ns-subtitles-body">
    <p className="ns-hint">{t('自动截取选定范围的首尾帧，交给视频模型生成替换片段。候选视频会匹配原片段时长，确认后才替换；原视频保留。此操作使用所选模型额度。', 'Extract the boundary frames and generate a replacement with your video model. The candidate is matched to the original duration and applied only after review. Originals are preserved. Uses the selected model’s credits.')}</p>
    {error && <p role="alert" className="nw-inline-error">{error}</p>}
    {!models.length && <p className="ns-hint">{t('请在模型连接中添加支持首尾帧的视频模型。', 'Add a video model supporting both boundary frames in model connections.')}</p>}
    <fieldset className="ns-subtitle-settings" disabled={busy || disabled || !!running}>
      <label>{t('重做模型', 'Retake model')}<select value={profileId} onChange={e => setProfileId(e.target.value)}><option value="">{t('选择模型', 'Choose a model')}</option>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <div className="ns-timeline-fields"><label>{t('重做开始（秒）', 'Retake start (seconds)')}<input type="number" min={(first ?? 0) / 30} step={1 / 30} value={start} onChange={e => setStart(e.target.value)} /></label><label>{t('重做结束（秒）', 'Retake end (seconds)')}<input type="number" max={(last ?? 0) / 30} step={1 / 30} value={end} onChange={e => setEnd(e.target.value)} /></label></div>
      <label>{t('修改要求', 'What should change?')}<textarea value={prompt} maxLength={8000} onChange={e => setPrompt(e.target.value)} placeholder={t('描述这一段想要的变化', 'Describe the change to this segment')} /></label>
      <button className="nw-button" disabled={!profileId || !prompt.trim() || !clip} onClick={() => void action(async () => { const p = await save(); const j = await request<Retake>('studio/edit/retake/start', { id: p.id, revision: p.revision, clipId: selected, startFrame: Math.round(Number(start) * 30), endFrame: Math.round(Number(end) * 30), profileId, prompt, idempotencyKey: crypto.randomUUID() }); setJob(j); setUrl(''); accept({ ...p, lastRetakeId: j.id }); })}><WandSparkles size={15} />{t('生成候选片段', 'Generate a candidate')}</button>
    </fieldset>
    {job && <div className="ns-timeline-render" role="status">{running ? <><Loader2 size={16} /><span>{job.error || (job.phase === 'preparing-candidate' ? t('正在合成候选片段…', 'Preparing candidate…') : t('正在局部重做…', 'Generating replacement…'))}</span><button className="nw-button" disabled={busy || disabled || job.cancelRequested} onClick={() => void action(async () => { setJob(await request<Retake>('studio/edit/retake/cancel', { id: job.id })); })}>{t('取消重做', 'Cancel retake')}</button></> : job.status === 'succeeded' ? <><span>{t('候选片段已就绪', 'Candidate ready')}</span><button className="nw-button" disabled={busy || disabled} onClick={() => void action(async () => { setUrl((await request<{ url: string }>('studio/edit/retake/playback', { id: job.id })).url); })}>{t('预览候选', 'Preview candidate')}</button><button className="nw-button" disabled={busy || disabled || project.appliedRetakeId === job.id} onClick={() => void action(async () => { const p = await save(); accept(await request<EditProject>('studio/edit/retake/apply', { id: job.id, revision: p.revision })); })}>{project.appliedRetakeId === job.id ? t('已应用', 'Applied') : t('应用候选', 'Apply candidate')}</button></> : <span>{job.error || t('重做已取消', 'Retake cancelled')}</span>}</div>}
    {url && <div className="ns-timeline-preview"><video src={url} controls playsInline preload="auto" aria-label={t('重做候选预览', 'Retake candidate preview')} /></div>}
    {project.retakeUndo?.revision === project.revision && <button className="nw-button" disabled={busy || disabled} onClick={() => void action(async () => { const p = await save(); accept(await request<EditProject>('studio/edit/retake/undo', { id: p.id, revision: p.revision })); })}><RotateCcw size={15} />{t('撤销这次替换', 'Undo replacement')}</button>}
  </div></details>;
}
