"use client";
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { keepCanvasHandoff } from '@/lib/native-canvas-recovery';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, BookOpen, Camera, Clapperboard, Image as ImageIcon, Loader2, Search, Settings2, X } from 'lucide-react';
import { type LibraryEntry } from '@/lib/native-library';
import { readStudioFrame, studioFinished, type StudioFrameExport, type StudioInput, type StudioJob, type StudioProfile, type StudioReference, type StudioTemplate } from '@/lib/native-studio';
import { TailExportRunner, type TailExportHandle } from '@/lib/native-studio-tail';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import { Modal } from './WorkbenchShell';
import { useLocalPreference } from './useLocalPreference';
import { StudioConnections } from './StudioConnections';
import { StudioMedia } from './StudioMedia';
import { StudioReferenceInputs, type StudioReferenceHandle } from './StudioReferenceInputs';
import { StudioKindSwitch } from './StudioKindSwitch';
import { StudioGallery, studioStageLabel } from './StudioGallery';
import { StudioSequences } from './StudioSequence';
import { StudioEditLibrary } from './StudioEditLibrary';
import { StudioTemplateMenu } from './StudioTemplates';
import { StudioArticle } from './StudioArticle';

const CanvasWorkspace = dynamic(() => import('./CanvasWorkspace').then(m => m.CanvasWorkspace), { ssr: false });

type Draft = StudioInput & { kind: 'image' | 'video'; profileId: string; inputVersion: 2 };
const emptyDraft: Draft = { inputVersion: 2, kind: 'image', profileId: '', prompt: '', size: '1024x1024', aspect: '1:1', count: 1, seconds: 4, quality: 'auto', references: [] };
function parseDraft(raw: string): Draft {
  try {
    const p = JSON.parse(raw); if (!p || !['image', 'video'].includes(p.kind) || typeof p.prompt !== 'string') return emptyDraft;
    const valid = (r: StudioReference) => r && typeof r.id === 'string';
    const references = Array.isArray(p.references) ? p.references.filter(valid).slice(0, 6) : [];
    const legacyVideo = p.kind === 'video' && p.inputVersion !== 2;
    return { ...emptyDraft, ...p, inputVersion: 2, references: legacyVideo ? [] : references, firstFrame: valid(p.firstFrame) ? p.firstFrame : legacyVideo ? references[0] : undefined, lastFrame: valid(p.lastFrame) ? p.lastFrame : undefined };
  } catch { return emptyDraft; }
}
export function StudioView() {
  const { request, t, setNotice, connection, locale } = useWorkbench();
  const [draft, updateDraft] = useLocalPreference('knorvia-studio-draft-v1', parseDraft);
  const [profiles, setProfiles] = useState<StudioProfile[]>([]), [jobs, setJobs] = useState<StudioJob[]>([]), [total, setTotal] = useState(0), [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<StudioTemplate[]>([]);
  const [tailPreview, setTailPreview] = useState<{ url: string; frame: StudioFrameExport } | undefined>(undefined);
  // C17: the frame export is cancellable — one activation at a time, cancel sends at most once.
  const tailRunner = useRef<TailExportRunner | null>(null);
  const [tailActive, setTailActive] = useState<TailExportHandle | null>(null);
  useEffect(() => () => { if (tailPreview) URL.revokeObjectURL(tailPreview.url); }, [tailPreview]);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false); const router = useRouter();
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [selected, setSelected] = useState<StudioJob>(), [outputIndex, setOutputIndex] = useState(0);
  const submission = useRef<{ body: string; key: string } | undefined>(undefined), submitting = useRef(false), referenceInputs = useRef<StudioReferenceHandle>(null), prompt = useRef<HTMLTextAreaElement>(null), polling = useRef(false);
  const patch = (value: Partial<Draft>) => updateDraft(current => ({ ...current, ...value }));
  const available = profiles.filter(p => p.kind === draft.kind), profile = available.find(p => p.id === draft.profileId) ?? available[0];
  const refresh = useCallback(async () => {
    const result = await request<{ jobs: StudioJob[]; total: number }>('studio/list'); setJobs(current => [...result.jobs, ...current.filter(job => !result.jobs.some(fresh => fresh.id === job.id))]); setTotal(result.total);
    setSelected(current => current ? result.jobs.find(job => job.id === current.id) ?? current : current);
  }, [request]);
  const refreshProfiles = useCallback(async (saved?: StudioProfile) => { const result = await request<{ profiles: StudioProfile[] }>('studio/models'); setProfiles(result.profiles); if (saved) updateDraft(current => ({ ...current, kind: saved.kind, profileId: saved.id })); }, [request, updateDraft]);
  const refreshTemplates = useCallback(async () => { const result = await request<{ templates: StudioTemplate[] }>('studio/template/list', {}); setTemplates(result.templates); }, [request]);
  useEffect(() => {
    if (connection !== 'connected') return;
    let stopped = false;
    Promise.all([refreshProfiles(), refresh(), refreshTemplates().catch(() => { })]).catch(e => { if (!stopped) setError(errorText(e)); }).finally(() => { if (!stopped) setLoading(false); });
    const timer = setInterval(() => { if (document.hidden || polling.current) return; polling.current = true; refresh().catch(e => { if (!stopped) setError(errorText(e)); }).finally(() => { polling.current = false; }); }, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [connection, refresh, refreshProfiles, refreshTemplates]);
  useEffect(() => { const el = prompt.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(240, Math.max(90, el.scrollHeight))}px`; } }, [draft.prompt]);
  const caps = profile?.inputCapabilities;
  const inputIssue = draft.kind === 'image' ? (caps && draft.references.length > caps.maxReferences ? t(`此模型最多支持 ${caps.maxReferences} 张参考图，已选素材会保留，请调整后生成。`, `This model supports ${caps.maxReferences} references. Your images are kept; adjust them before creating.`) : '')
    : draft.lastFrame && !caps?.lastFrame ? t('当前模型未配置尾帧支持。请切换模型或在模型连接中设置。', 'This connection does not support a last frame. Choose another model or configure its input mapping.')
    : draft.firstFrame && caps && !caps.firstFrame ? t('当前模型未配置首帧支持。', 'This connection does not support a first frame.')
    : (draft.lastFrame || caps?.requiresFirstFrame) && !draft.firstFrame ? t('请添加视频首帧。', 'Add a first frame.')
    : caps?.requiresLastFrame && !draft.lastFrame ? t('此模型还需要一张尾帧。', 'This model also needs a last frame.') : '';
  const generate = async () => {
    if (submitting.current || busy || !draft.prompt.trim() || !profile || inputIssue) return;
    submitting.current = true; setBusy('generate'); setError('');
    const input = { ...draft, profileId: profile.id, references: draft.kind === 'image' ? draft.references : [], firstFrame: draft.kind === 'video' ? draft.firstFrame : undefined, lastFrame: draft.kind === 'video' ? draft.lastFrame : undefined };
    const body = JSON.stringify(input);
    if (submission.current?.body !== body) submission.current = { body, key: crypto.randomUUID() };
    try {
      const job = await request<StudioJob>('studio/create', { ...input, idempotencyKey: submission.current.key });
      setJobs(current => [job, ...current.filter(item => item.id !== job.id)]); setTotal(n => n + 1); submission.current = undefined;
      setNotice(t('已加入创作队列，进度会保留在这里', 'Added to your creation queue; progress is saved here'));
    } catch (e) { setError(errorText(e)); } finally { submitting.current = false; setBusy(''); }
  };
  const applyReference = (reference: StudioReference) => {
    if (draft.kind === 'image' && draft.references.length >= (caps?.maxReferences ?? 6)) { setError(t('参考图已达到此模型上限', 'The model reference limit has been reached')); return; }
    updateDraft(current => current.kind === 'video' ? { ...current, firstFrame: reference } : { ...current, references: [...current.references.filter(r => r.id !== reference.id), reference] });
  };
  const addReference = (entry: LibraryEntry) => applyReference({ id: entry.id, version: entry.sha256, name: entry.name });
  const changeKind = (kind: Draft['kind']) => patch({ kind, profileId: profiles.find(p => p.kind === kind)?.id ?? '', size: kind === 'image' ? '1024x1024' : '1280x720', aspect: kind === 'image' ? '1:1' : '16:9' });
  const stageLabel = (job: StudioJob) => studioStageLabel(job, t);
  const action = useCallback(async (job: StudioJob, method: string) => { setBusy(job.id); setError(''); try { const result = await request<StudioJob>(method, { id: job.id }); setSelected(current => current?.id === job.id ? result : current); await refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(''); } }, [request, refresh]);
  const continueFrom = useCallback((job: StudioJob) => { updateDraft(() => parseDraft(JSON.stringify({ ...emptyDraft, ...job.input, kind: job.kind, profileId: job.profileId, inputVersion: job.kind === 'video' && !job.input.firstFrame && job.input.references.length ? 1 : 2 }))); setSelected(undefined);
    // Wait for the preview dialog to release focus before returning to the form.
    requestAnimationFrame(() => {
      const field = prompt.current;
      if (!field) return;
      field.focus({ preventScroll: true });
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches || field.closest('[data-reduce-motion="true"]');
      field.scrollIntoView({ block: 'center', behavior: reduced ? 'instant' : 'smooth' });
    });
  }, [updateDraft]);
  const openJob = useCallback((job: StudioJob) => { setSelected(job); setOutputIndex(0); setTailPreview(current => { if (current) URL.revokeObjectURL(current.url); return undefined; }); }, []);
  const saveOutput = async (job: StudioJob, asReference = false) => {
    setBusy(job.id); setError('');
    try { const entry = await request<LibraryEntry>('studio/library', { id: job.id, index: outputIndex, path: `创作/${job.outputs[outputIndex].name}` }); if (asReference) { addReference(entry); setSelected(undefined); } setNotice(t('已保存到个人资料库', 'Saved to your personal library')); }
    catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  };
  // B03: decode the real last displayed frame, register it immutably, and
  // offer preview / download / continue-from-frame — the same derived image
  // the storyboard queue uses for continuity.
  const exportTail = async (job: StudioJob) => {
    if (tailActive) return;
    setError('');
    if (!tailRunner.current) tailRunner.current = new TailExportRunner((method, params) => request(method, params));
    const runner = tailRunner.current;
    setTailActive({ jobId: job.id, index: outputIndex });
    try {
      const outcome = await runner.run(job.id, outputIndex, async frame => {
        const { blob } = await readStudioFrame(request, job.id, outputIndex);
        const url = URL.createObjectURL(blob);
        setTailPreview(current => { if (current) URL.revokeObjectURL(current.url); return { url, frame }; });
      });
      if (outcome === 'done') setNotice(t('已导出真实尾帧并存入资料库', 'The real last frame was exported and saved to your library'));
      else if (outcome === 'cancelled') setNotice(t('已取消尾帧导出', 'The last-frame export was cancelled'));
    } catch (e) { setError(errorText(e)); } finally { setTailActive(null); }
  };
  const cancelTail = async () => {
    if (!tailRunner.current) return;
    const result = await tailRunner.current.cancel();
    const messages: Record<string, string> = {
      sent: t('已请求取消，等待确认…', 'Cancellation requested; waiting for confirmation'),
      'already-requested': t('已请求取消，等待确认…', 'Cancellation requested; waiting for confirmation'),
      confirmed: t('尾帧导出已取消。', 'The last-frame export was cancelled.'),
      declined: t('导出已经完成，无需取消；结果以最终输出为准。', 'The export already finished; the final output is authoritative.'),
      failed: t('取消请求失败，可重试。', 'The cancel request failed; you can retry.'),
      inactive: t('没有进行中的尾帧导出。', 'No last-frame export is running.'),
    };
    setNotice(messages[result] ?? t('取消状态未知。', 'Cancel status unknown.'));
  };
  const downloadTail = () => {
    if (!tailPreview) return;
    const anchor = document.createElement('a');
    anchor.href = tailPreview.url; anchor.download = tailPreview.frame.name;
    anchor.click();
  };
  const continueFromFrame = () => {
    if (!tailPreview || !selected) return;
    applyReference({ id: tailPreview.frame.libraryId, version: tailPreview.frame.libraryVersion, name: tailPreview.frame.name });
    setSelected(undefined);
    setNotice(t('已把尾帧放入创作输入，可继续编辑或作为下一段首帧', 'The last frame moved into your inputs; edit it or use it as the next first frame'));
  };
  // B09 image→video: save the chosen image output, then start a video draft
  // with that exact library version pinned as the first frame.
  const makeVideoFrom = async (job: StudioJob) => {
    setBusy('mkvideo'); setError('');
    try {
      const entry = await request<LibraryEntry>('studio/library', { id: job.id, index: outputIndex, path: `创作/${job.outputs[outputIndex].name}` });
      const firstFrame = { id: entry.id, version: entry.sha256, name: entry.name };
      const videoProfile = profiles.find(candidate => candidate.kind === 'video' && candidate.inputCapabilities?.firstFrame && !candidate.inputCapabilities.requiresLastFrame)
        ?? profiles.find(candidate => candidate.kind === 'video' && candidate.inputCapabilities?.firstFrame);
      updateDraft(current => ({ ...current, kind: 'video', profileId: videoProfile?.id ?? '', size: '1280x720', aspect: '16:9', firstFrame, lastFrame: undefined }));
      setSelected(undefined);
      setNotice(videoProfile ? t('已切换到视频创作，并以此图为首帧', 'Switched to video with this image as the first frame') : t('已保存首帧，请配置支持图生视频的模型', 'First frame saved. Configure a model that supports image-to-video.'));
    } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  };
  const deferredQuery = useDeferredValue(query);
  const visibleJobs = useMemo(() => {
    const search = deferredQuery.toLocaleLowerCase();
    return jobs.filter(job => (filter === 'all' || job.kind === filter) && `${job.input?.prompt ?? ''} ${job.provider?.name ?? ''}`.toLocaleLowerCase().includes(search));
  }, [jobs, filter, deferredQuery]);
  if (canvasOpen) return <CanvasWorkspace onClose={() => setCanvasOpen(false)} onAskAgent={(text, id) => { try { keepCanvasHandoff({ id, text }); router.push('/workbench'); } catch (e) { setNotice(errorText(e)); } }} />;
  return <div className="ns-studio">
    <div className="ns-topline"><button className="nw-button" onClick={() => setCanvasOpen(true)}><ImageIcon size={16} />{t('创作画布', 'Creative canvas')}</button><button className="nw-button" onClick={() => setConnectionsOpen(true)}><Settings2 size={16} />{t('模型连接', 'Model connections')}</button></div>
    <section className="ns-create" aria-label={t('图片和视频创作', 'Image and video creation')}>
      <div className="ns-heading"><h1>{draft.kind === 'image' ? t('把想象变成画面', 'Turn your ideas into images') : t('让画面动起来', 'Bring your ideas to life')}</h1><p>{t('描述你的想法，或放入参考图继续创作。', 'Describe an idea, or add a reference image and make it your own.')}</p></div>
      <form className="ns-composer" onSubmit={e => { e.preventDefault(); void generate(); }} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void referenceInputs.current?.importFiles(e.dataTransfer.files); }} onPaste={e => { const files = Array.from(e.clipboardData.files).filter(file => file.type.startsWith('image/')); if (files.length) { e.preventDefault(); void referenceInputs.current?.importFiles(files); } }}>
        <textarea ref={prompt} aria-label={t('创作描述', 'Creative prompt')} value={draft.prompt} maxLength={12000} onChange={e => patch({ prompt: e.target.value })} placeholder={draft.kind === 'image' ? t('你想创作怎样的画面？', 'What would you like to create?') : t('描述主体、场景和镜头运动…', 'Describe the subject, setting and camera movement…')} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void generate(); } }} />
        <StudioReferenceInputs ref={referenceInputs} kind={draft.kind} value={draft} capabilities={caps} disabled={!!busy} update={fn => updateDraft(current => ({ ...current, ...fn(current) }))} busy={value => setBusy(value ? 'upload' : '')} error={setError} />
        {inputIssue && <p role="status" className="ns-input-issue">{inputIssue}</p>}
        <div className="ns-composer-tools"><div className="ns-tool-group"><StudioKindSwitch value={draft.kind} change={changeKind} /></div>
          <div className="ns-tool-group">{connection === 'connected' && <StudioTemplateMenu request={request} t={t} kind={draft.kind} prompt={draft.prompt} onApply={text => patch({ prompt: text })} onNotice={setNotice} />}</div>
          <div className="ns-tool-group ns-submit-tools">{available.length ? <select aria-label={t('创作模型', 'Creative model')} value={profile?.id ?? ''} onChange={e => patch({ profileId: e.target.value })}>{available.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select> : <button type="button" className="ns-connect-link" onClick={() => setConnectionsOpen(true)}>{t('连接模型', 'Connect a model')}</button>}<button className="ns-submit" aria-label={t('开始创作', 'Start creating')} title={t('开始创作 · Ctrl+Enter', 'Create · Ctrl+Enter')} disabled={!profile || !draft.prompt.trim() || !!busy || !!inputIssue || connection !== 'connected'}>{busy === 'generate' ? <Loader2 size={19} className="nw-spin" /> : <ArrowUp size={21} />}</button></div>
        </div>
        <div className="ns-parameters"><label>{t('尺寸', 'Size')}<input aria-label={t('生成尺寸', 'Output dimensions')} value={draft.size} onChange={e => patch({ size: e.target.value })} list={`studio-sizes-${draft.kind}`} /><datalist id={`studio-sizes-${draft.kind}`}>{(draft.kind === 'image' ? ['1024x1024', '1536x1024', '1024x1536', '2048x2048'] : ['1280x720', '720x1280', '1920x1080', '1080x1920']).map(size => <option key={size} value={size} />)}</datalist></label>{draft.kind === 'image' ? <><label>{t('数量', 'Count')}<select value={draft.count} onChange={e => patch({ count: Number(e.target.value) })}>{[1, 2, 3, 4].map(count => <option key={count} value={count}>{count}</option>)}</select></label><label>{t('质量', 'Quality')}<select value={draft.quality} onChange={e => patch({ quality: e.target.value })}><option value="auto">{t('自动', 'Auto')}</option><option value="low">{t('低', 'Low')}</option><option value="medium">{t('中', 'Medium')}</option><option value="high">{t('高', 'High')}</option></select></label></> : <><label>{t('时长', 'Duration')}<input aria-label={t('视频秒数', 'Video seconds')} type="number" min={1} max={60} value={draft.seconds} onChange={e => patch({ seconds: Number(e.target.value) })} /><span>{t('秒', 's')}</span></label><label>{t('比例', 'Aspect ratio')}<select value={draft.aspect} onChange={e => patch({ aspect: e.target.value })}>{['16:9', '9:16', '1:1', '4:3', '3:4'].map(aspect => <option key={aspect}>{aspect}</option>)}</select></label></>}<span className="ns-parameter-note">{t('可用参数由所选模型决定', 'Supported values depend on your model')}</span></div>
      </form>
      {!available.length && !loading && <p className="ns-onboarding">{t('接入你自己的图片或视频模型，即可开始。', 'Connect your own image or video model to get started.')}</p>}
      <StudioSequences request={request} t={t} profiles={profiles} templates={templates} onNotice={setNotice} />
      <div className="ns-workflow-shortcuts" role="group" aria-label={t('更多创作方式', 'More ways to create')}>
        <StudioArticle />
        <StudioEditLibrary />
      </div>
    </section>
    {error && <div role="alert" className="ns-error"><span>{error}</span><button className="nw-icon" aria-label={t('关闭提示', 'Dismiss message')} onClick={() => setError('')}><X size={16} /></button></div>}
    <section className="ns-history" aria-label={t('个人创作记录', 'Personal creations')}><header><div><h2>{t('我的作品', 'My creations')}</h2><span>{total}</span></div><div className="ns-history-controls"><div className="ns-search"><Search size={15} /><input aria-label={t('搜索创作记录', 'Search creations')} placeholder={t('搜索作品', 'Search creations')} value={query} onChange={e => setQuery(e.target.value)} /></div><select aria-label={t('筛选作品类型', 'Filter media type')} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">{t('全部', 'All')}</option><option value="image">{t('图片', 'Images')}</option><option value="video">{t('视频', 'Videos')}</option></select></div></header>
      {loading ? <div className="ns-empty"><Loader2 size={19} className="nw-spin" />{t('正在读取创作记录…', 'Loading your creations…')}</div> : !visibleJobs.length ? <div className="ns-empty"><ImageIcon size={23} strokeWidth={1.4} /><p>{query || filter !== 'all' ? t('没有符合条件的作品', 'No matching creations') : t('你的第一份作品，会出现在这里', 'Your first creation will appear here')}</p></div> : <StudioGallery jobs={visibleJobs} busy={!!busy} locale={locale} t={t} open={openJob} action={action} continueFrom={continueFrom} />}
      {jobs.length < total && <button className="nw-button ns-load-more" disabled={!!busy} onClick={async () => { setBusy('more'); try { const result = await request<{ jobs: StudioJob[]; total: number }>('studio/list', { offset: jobs.length }); setJobs(current => [...current, ...result.jobs.filter(job => !current.some(item => item.id === job.id))]); setTotal(result.total); } catch (e) { setError(errorText(e)); } finally { setBusy(''); } }}>{t('加载更早的作品', 'Load earlier creations')}</button>}
    </section>
    {connectionsOpen && <StudioConnections profiles={profiles} kind={draft.kind} close={() => setConnectionsOpen(false)} saved={refreshProfiles} />}
    {selected && <Modal title={selected.kind === 'image' ? t('图片作品', 'Image creation') : t('视频作品', 'Video creation')} close={() => { setSelected(undefined); setTailPreview(current => { if (current) URL.revokeObjectURL(current.url); return undefined; }); }} busy={!!busy}><div className="ns-preview"><div className="ns-preview-canvas">{selected.outputs?.length ? <StudioMedia job={selected} index={outputIndex} /> : <div className="ns-empty"><Loader2 size={22} className={studioFinished(selected) ? '' : 'nw-spin'} /><p>{stageLabel(selected)}</p></div>}</div><div className="ns-preview-detail"><p className="ns-prompt-copy">{selected.input?.prompt}</p><p className="ns-hint">{selected.provider?.name} · {selected.input?.size}{selected.kind === 'video' ? ` · ${selected.input?.seconds}s` : ''}</p>{selected.error && <p className="nw-inline-error" role="alert">{selected.error}</p>}{selected.remoteMayContinue && <p className="ns-hint">{t('已停止本地任务；服务商可能仍在生成并计费。', 'Local tracking has stopped; the provider may still generate and charge for this job.')}</p>}{selected.outputs?.length > 1 && <div className="ns-output-selector">{selected.outputs.map((output, index) => <button className="nw-button" key={output.name} aria-pressed={outputIndex === index} onClick={() => setOutputIndex(index)}>{index + 1}</button>)}</div>}<div className="ns-preview-actions"><button className="nw-button" disabled={!!busy || !selected.input} onClick={() => continueFrom(selected)}>{t('继续创作', 'Create again')}</button>{!studioFinished(selected) && <button className="nw-button" disabled={!!busy} onClick={() => void action(selected, ['paused', 'needs-connection'].includes(selected.phase) ? 'studio/resume' : 'studio/cancel')}>{['paused', 'needs-connection'].includes(selected.phase) ? t('继续查询', 'Resume tracking') : t('停止', 'Stop')}</button>}{selected.outputs?.length > 0 && <><button className="nw-button" disabled={!!busy} onClick={() => void saveOutput(selected)}><BookOpen size={15} />{t('存入资料库', 'Save to library')}</button>{selected.kind === 'image' && <><button className="nw-button" disabled={!!busy} onClick={() => void saveOutput(selected, true)}>{t('用作参考图', 'Use as reference')}</button><button className="nw-button" disabled={!!busy} onClick={() => void makeVideoFrom(selected)}><Clapperboard size={15} />{t('以此图制作视频', 'Make a video from this')}</button></>}{selected.kind === 'video' && <button className="nw-button" disabled={!!busy} onClick={() => void exportTail(selected)}><Camera size={15} />{tailPreview ? t('重新导出尾帧', 'Re-export last frame') : t('导出尾帧', 'Export last frame')}</button>}{selected.kind === 'video' && tailActive && tailActive.jobId === selected.id && <button className="nw-button" onClick={() => void cancelTail()}>{t('取消导出', 'Cancel export')}</button>}</>}</div>
      {tailPreview && selected.kind === 'video' && <div className="ns-tail-preview">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={tailPreview.url} alt={t('视频尾帧预览', 'Video last frame preview')} />
        <p className="ns-hint">{t('按显示时间戳解码的最后显示帧', 'The last displayed frame, decoded by presentation timestamp')} · #{tailPreview.frame.streamIndex} · {Number(tailPreview.frame.pts).toFixed(3)}s</p>
        <div className="ns-preview-actions">
          <button className="nw-button" onClick={downloadTail}>{t('下载尾帧', 'Download')}</button>
          <button className="nw-button" onClick={continueFromFrame}>{t('接着这一帧创作', 'Continue from this frame')}</button>
        </div>
      </div>}
    </div></div></Modal>}
  </div>;
}
