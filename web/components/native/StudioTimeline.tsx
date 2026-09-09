"use client";
import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Download, Film, Loader2, Save, Trash2 } from 'lucide-react';
import { editFrames, moveEditClip, type EditClip, type EditProject, type EditRender } from '@/lib/studio-edit';
import { Modal } from './WorkbenchShell';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import './studio-timeline.css';
import { StudioSubtitles } from './StudioSubtitles';
import { StudioRetake } from './StudioRetake';

export function StudioTimeline({ sequenceId, projectId: existingProjectId, close }: { sequenceId?: string; projectId?: string; close: () => void }) {
  const { request, t } = useWorkbench();
  const [project, setProject] = useState<EditProject>(), [render, setRender] = useState<EditRender>();
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState(''), [url, setUrl] = useState(''), [film, setFilm] = useState(false);
  const video = useRef<HTMLVideoElement>(null), exportKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void request<EditProject>(existingProjectId ? 'studio/edit/read' : 'studio/edit/create', existingProjectId ? { id: existingProjectId } : { sequenceId }).then(p => { if (live) { setProject(p); setSelected(p.edit.clips[0]?.id ?? ''); if (p.lastRenderId) void request<EditRender>('studio/edit/render/read', { id: p.lastRenderId }).then(r => { if (live) setRender(r); }).catch(e => { if (live) setError(errorText(e)); }); } }).catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [request, sequenceId, existingProjectId]);
  const renderId = render?.id, renderStatus = render?.status;
  useEffect(() => {
    if (!renderId || ['succeeded', 'failed', 'cancelled'].includes(renderStatus ?? '')) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const r = await request<EditRender>('studio/edit/render/read', { id: renderId }); if (live) setRender(r); } catch (e) { if (live) setError(errorText(e)); } if (live) timer = setTimeout(poll, 1200); };
    timer = setTimeout(poll, 1000);
    return () => { live = false; clearTimeout(timer); };
  }, [request, renderId, renderStatus]); // progress does not restart polling
  const source = project?.sources.find(s => s.id === selected), clip = project?.edit.clips.find(c => c.id === selected);
  const projectId = project?.id, sourceId = source?.id;
  useEffect(() => {
    let live = true;
    setUrl('');
    const method = film ? 'studio/edit/render/playback' : 'studio/edit/source/playback';
    const params = film ? renderStatus === 'succeeded' ? { id: renderId } : undefined : sourceId ? { id: projectId, sourceId } : undefined;
    if (params) void request<{ url: string }>(method, params).then(r => { if (live) setUrl(r.url); }).catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [request, projectId, sourceId, film, renderId, renderStatus]);
  const change = (next: EditProject) => { setProject(next); setDirty(true); exportKey.current = undefined; };
  const patch = (value: Partial<EditClip>) => {
    if (!project || !clip || !source) return;
    const next = { ...clip, ...value };
    next.endFrame = Math.max(clip.startFrame + 1, Math.min(source.frames, next.endFrame));
    next.startFrame = Math.max(0, Math.min(next.endFrame - 1, next.startFrame));
    next.fadeFrames = Math.min(next.fadeFrames, Math.floor((next.endFrame - next.startFrame) / 2));
    change({ ...project, edit: { ...project.edit, clips: project.edit.clips.map(c => c.id === clip.id ? next : c) } });
  };
  const previewVolume = clip?.volume;
  useEffect(() => { if (video.current && previewVolume !== undefined && !film) video.current.volume = Math.min(1, previewVolume); }, [previewVolume, film]);
  const renderedCaptions = render?.edit?.captions;
  useEffect(() => {
    if (!film || !url || !video.current || !renderedCaptions?.length) return;
    const track = video.current.addTextTrack('subtitles', t('字幕', 'Captions'));
    for (const c of renderedCaptions) track.addCue(new VTTCue(c.startFrame / 30, c.endFrame / 30, c.text.replace(/&/g, '&amp;').replace(/</g, '&lt;')));
    track.mode = 'showing';
    return () => { track.mode = 'disabled'; for (const cue of Array.from(track.cues ?? [])) track.removeCue(cue); };
  }, [url, film, renderedCaptions, t]);
  const action = async (name: string, fn: () => Promise<void>) => { if (busy) return; setBusy(name); setError(''); try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(''); } };
  const save = async () => {
    if (!project) throw new Error('Project loading');
    if (!dirty) return project;
    const next = await request<EditProject>('studio/edit/update', { id: project.id, revision: project.revision, edit: project.edit });
    setProject(next); setDirty(false); return next;
  };
  const accept = (p: EditProject) => { setProject(p); if (!p.edit.clips.some(c => c.id === selected)) setSelected(p.edit.clips[0]?.id ?? ''); setDirty(false); exportKey.current = undefined; };
  const running = render && !['succeeded', 'failed', 'cancelled'].includes(render.status);
  const closeEditor = async () => {
    if (!dirty) { close(); return; }
    setBusy('close');
    try { await save(); close(); }
    catch (e) { setError(errorText(e)); return false as const; }
    finally { setBusy(''); }
  };
  return <Modal title={t('剪辑成片', 'Edit film')} close={closeEditor} busy={!!busy}>
    <div className="ns-timeline">
      {error && <p role="alert" className="nw-inline-error">{error}</p>}
      {!project ? <p role="status"><Loader2 size={16} /> {t('正在读取分镜…', 'Reading shots…')}</p> : <>
        <header className="ns-timeline-heading"><div><strong>{project.title}</strong><p className="ns-hint">{project.edit.clips.length}{t(' 个镜头', ' shots')} · {(editFrames(project.edit) / 30).toFixed(2)}{t('秒', 's')} · {dirty ? t('未保存', 'Unsaved') : t('已保存', 'Saved')}</p></div><label>{t('成片画幅', 'Aspect ratio')}<select disabled={!!busy} value={project.edit.aspect} onChange={e => change({ ...project, edit: { ...project.edit, aspect: e.target.value } })}><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option></select></label></header>
        <div className="ns-timeline-preview">
          {url && <video key={url} ref={video} src={url} controls playsInline preload="auto" aria-label={film ? t('成片预览', 'Film preview') : t('镜头预览', 'Shot preview')} onError={() => setError(t('视频预览失败，请重新打开成片或检查浏览器解码支持', 'Video preview failed. Reopen the film or check browser codec support.'))} onLoadedMetadata={e => { if (!film && clip) { e.currentTarget.currentTime = clip.startFrame / 30; e.currentTarget.volume = Math.min(1, clip.volume); } }} onTimeUpdate={e => { if (!film && clip && e.currentTarget.currentTime >= clip.endFrame / 30) { e.currentTarget.pause(); e.currentTarget.currentTime = clip.startFrame / 30; } }} />}
          {!url && <Film size={28} />}
        </div>
        <p className="ns-hint">{film ? t('当前显示已导出的成片。', 'Showing the exported film.') : t('预览当前镜头的裁切范围。画幅、淡入淡出与声音处理在成片中查看。', 'Preview the trimmed shot. View framing, fades and audio processing in the exported film.')}</p>
        <ol className="ns-timeline-track" aria-label={t('镜头顺序', 'Shot order')}>
          {project.edit.clips.map((c, i) => <li key={c.id} className={selected === c.id && !film ? 'is-selected' : ''}>
            <button className="ns-timeline-shot" onClick={() => { setSelected(c.id); setFilm(false); }} aria-pressed={selected === c.id && !film}><span>{String(i + 1).padStart(2, '0')}</span><strong>{project.sources.find(s => s.id === c.id)?.title || t('镜头', 'Shot')}</strong><small>{((c.endFrame - c.startFrame) / 30).toFixed(2)}{t('秒', 's')}</small></button>
            <div className="ns-timeline-actions"><button className="nw-icon" disabled={!!busy || i === 0} aria-label={t('前移镜头', 'Move shot earlier')} onClick={() => change({ ...project, edit: moveEditClip(project.edit, i, -1) })}><ArrowUp size={14} /></button><button className="nw-icon" disabled={!!busy || i === project.edit.clips.length - 1} aria-label={t('后移镜头', 'Move shot later')} onClick={() => change({ ...project, edit: moveEditClip(project.edit, i, 1) })}><ArrowDown size={14} /></button><button className="nw-icon" disabled={!!busy || project.edit.clips.length === 1} aria-label={t('从成片移除镜头', 'Remove shot from film')} onClick={() => { const clips = project.edit.clips.filter(item => item.id !== c.id); change({ ...project, edit: { ...project.edit, clips } }); if (selected === c.id) setSelected(clips[0].id); }}><Trash2 size={14} /></button></div>
          </li>)}
        </ol>
        {clip && source && !film && <fieldset className="ns-timeline-fields" disabled={!!busy}>
          <label>{t('画面适配', 'Framing')}<select aria-label={t('画面适配', 'Framing')} value={clip.fit ?? 'contain'} onChange={e => patch({ fit: e.target.value as EditClip['fit'] })}><option value="contain">{t('完整显示', 'Fit entire frame')}</option><option value="cover">{t('填满画幅', 'Fill and crop')}</option></select></label>
          <label>{t('顺时针旋转', 'Clockwise rotation')}<select aria-label={t('顺时针旋转', 'Clockwise rotation')} value={clip.rotation ?? 0} onChange={e => patch({ rotation: Number(e.target.value) as EditClip['rotation'] })}>{[0, 90, 180, 270].map(degrees => <option key={degrees} value={degrees}>{degrees}°</option>)}</select></label>
          <label>{t('水平镜像', 'Horizontal mirror')}<select aria-label={t('水平镜像', 'Horizontal mirror')} value={clip.mirror ? 'on' : 'off'} onChange={e => patch({ mirror: e.target.value === 'on' })}><option value="off">{t('关闭', 'Off')}</option><option value="on">{t('开启', 'On')}</option></select></label>
          <label>{t('开始（秒）', 'Start (seconds)')}<input type="number" min={0} max={(clip.endFrame - 1) / 30} step={1 / 30} value={Number((clip.startFrame / 30).toFixed(3))} onChange={e => patch({ startFrame: Math.round(Number(e.target.value) * 30) })} /></label>
          <label>{t('结束（秒）', 'End (seconds)')}<input type="number" min={(clip.startFrame + 1) / 30} max={source.frames / 30} step={1 / 30} value={Number((clip.endFrame / 30).toFixed(3))} onChange={e => patch({ endFrame: Math.round(Number(e.target.value) * 30) })} /></label>
          <label>{t('音量', 'Volume')} · {Math.round(clip.volume * 100)}%<input type="range" min="0" max="2" step="0.05" value={clip.volume} onChange={e => patch({ volume: Number(e.target.value) })} /></label>
          <label>{t('淡入淡出', 'Fade in / out')} · {(clip.fadeFrames / 30).toFixed(2)}{t('秒', 's')}<input type="range" min="0" max={Math.max(0, Math.min(30, Math.floor((clip.endFrame - clip.startFrame) / 2)))} step="1" value={clip.fadeFrames} onChange={e => patch({ fadeFrames: Number(e.target.value) })} /></label>
        </fieldset>}
        <StudioSubtitles project={project} change={change} save={save} accept={accept} disabled={!!busy} onBusy={value => setBusy(value ? 'subtitles' : '')} />
        {source?.jobId && <StudioRetake project={project} selected={selected} save={save} accept={accept} disabled={!!busy} onBusy={value => setBusy(value ? 'retake' : '')} />}
        {render && <div className="ns-timeline-render" role="status">{running ? <><Loader2 size={16} /><span>{render.cancelRequested ? t('正在取消…', 'Cancelling…') : `${t('导出中', 'Exporting')} ${render.progress}%`}</span><progress max="100" value={render.progress} /><button className="nw-button" disabled={!!busy || render.cancelRequested} onClick={() => void action('cancel', async () => { setRender(await request<EditRender>('studio/edit/render/cancel', { id: render.id })); })}>{t('取消导出', 'Cancel export')}</button></> : render.status === 'succeeded' ? <><Check size={16} /><span>{t('成片已存入资料库', 'Film saved to library')} · {t('版本', 'v')}{render.revision}</span><button className="nw-button" onClick={() => setFilm(true)}>{t('查看成片', 'View film')}</button></> : <span>{render.error || t('导出已取消', 'Export cancelled')}</span>}</div>}
        <footer className="ns-timeline-footer"><span className="ns-hint">{t('保存后关闭，导出仍会继续', 'Exports continue after closing')}</span><button className="nw-button" disabled={!!busy || !dirty} onClick={() => void action('save', async () => { await save(); })}><Save size={15} />{t('保存剪辑', 'Save edit')}</button><button className="nw-button nw-primary" disabled={!!busy || !!running} onClick={() => void action('export', async () => { const p = await save(); exportKey.current ??= crypto.randomUUID(); const r = await request<EditRender>('studio/edit/export', { id: p.id, revision: p.revision, idempotencyKey: exportKey.current }); setRender(r); exportKey.current = undefined; setFilm(false); })}><Download size={15} />{t('导出 MP4', 'Export MP4')}</button></footer>
      </>}
    </div>
  </Modal>;
}
