'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileVideo, Loader2, Play, Sparkles } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import { Modal } from './WorkbenchShell';
import type { LibraryEntry } from '@/lib/native-library';
import {
  clearArticleDraft, draftFromProject, draftReplayDecision, draftToMarkdown, loadArticleDrafts,
  makeArticleDraft, storeArticleDraft, type ArticleDraft,
} from '@/lib/studio-article-draft';
import './studio-article.css';

type Scene = { heading: string; detail: string; reference?: { id: string; version: string } };
type Project = { id: string; title: string; article: string; narration: string; scenes: Scene[]; aspect: string; revision: number; busy?: string; phase: string; error?: string; guide: string; sample?: object; audio?: { frames: number; captions: { startFrame: number; endFrame: number; text: string }[] }; built?: { directory: string }; preview?: object; output?: { libraryId: string } };

const draftStore = () => (typeof localStorage === 'undefined' ? undefined : localStorage);

export function StudioArticle() {
  const { request, t, newTask, models, workspaceId } = useWorkbench();
  const [open, setOpen] = useState(false), [projects, setProjects] = useState<Project[]>([]), [project, setProject] = useState<Project>();
  const [article, setArticle] = useState(''), [title, setTitle] = useState(''), [audience, setAudience] = useState('');
  const [narration, setNarration] = useState(''), [scenes, setScenes] = useState<Scene[]>([]), [aspect, setAspect] = useState('16:9');
  const [error, setError] = useState(''), [working, setWorking] = useState(false), [url, setUrl] = useState(''), [audioPreview, setAudioPreview] = useState(false);
  const [voice, setVoice] = useState(''), [node, setNode] = useState(''), [runtime, setRuntime] = useState(''), [library, setLibrary] = useState<LibraryEntry[]>([]), [audioId, setAudioId] = useState(''), [srt, setSrt] = useState('');
  // P09: durable drafts and stale-response guards.
  const [drafts, setDrafts] = useState<ArticleDraft[]>([]);
  const [storageWarning, setStorageWarning] = useState('');
  const [restoredNote, setRestoredNote] = useState('');
  const [replay, setReplay] = useState<{ draft: ArticleDraft; serverRevision: number }>();
  const [pendingSwitch, setPendingSwitch] = useState<string | null>();
  const [saveKey, setSaveKey] = useState('');
  const generation = useRef(0);
  const hydrated = useRef(false);
  const dirty = !!project && (narration !== project.narration || JSON.stringify(scenes) !== JSON.stringify(project.scenes) || aspect !== project.aspect);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const busy = working || !!project?.busy;
  const applyProject = useCallback((p: Project) => {
    setProject(p); setNarration(p.narration); setScenes(p.scenes); setAspect(p.aspect);
  }, []);
  const load = async () => {
    setError(''); setOpen(true);
    const gen = ++generation.current;
    // Restore durable drafts before the network answers so a refresh never
    // shows an empty form over a recovered draft.
    const store = draftStore();
    const loaded = loadArticleDrafts(store, workspaceId);
    setDrafts(loaded.drafts);
    setStorageWarning(loaded.unwritable ? t('此浏览器无法保存草稿；请完成后立即保存到工程。', 'This browser cannot store drafts; save into the project as soon as you finish.') : '');
    if (!project) {
      const fresh = loaded.drafts.find(draft => draft.projectId === null);
      if (fresh && (fresh.article || fresh.title || fresh.audience)) {
        setTitle(fresh.title); setArticle(fresh.article); setAudience(fresh.audience);
        setRestoredNote(t('已恢复上次未创建的草稿。', 'Restored the draft you had not created yet.'));
      }
    }
    try {
      const [list, cfg, files] = await Promise.all([request<{ projects: Project[] }>('studio/article/list'), request<{ node: string; runtime: string }>('studio/article/config'), request<{ entries: LibraryEntry[] }>('library/list')]);
      if (generation.current !== gen) return;
      setProjects(list.projects); setNode(cfg.node); setRuntime(cfg.runtime); setLibrary(files.entries.filter(e => !e.trashedAt && /\.(wav|mp3|m4a|ogg|flac|png|jpe?g|webp)$/i.test(e.name)));
    } catch (e) { if (generation.current === gen) setError(errorText(e)); }
  };
  useEffect(() => {
    if (!open || !project?.busy) return;
    let stopped = false, reading = false;
    const timer = setInterval(async () => {
      if (reading) return; reading = true;
      const gen = generation.current;
      try { const p = await request<Project>('studio/article/read', { id: project.id }); if (!stopped && generation.current === gen) { if (dirtyRef.current) setProject(p); else applyProject(p); setUrl(''); } }
      catch (e) { if (!stopped && generation.current === gen) setError(errorText(e)); } finally { reading = false; }
    }, 1200);
    return () => { stopped = true; clearInterval(timer); };
  }, [open, project?.id, project?.busy, request, applyProject]);
  // Poll applies the full project only when the dialog is clean; dirty local
  // edits are never reverted by a background read.
  const action = async (name: string, params: Record<string, unknown> = {}) => {
    if (working) return undefined;
    setWorking(true); setError('');
    const gen = ++generation.current;
    try {
      const p = await request<Project>(`studio/article/${name}`, { id: project?.id, revision: project?.revision, ...params });
      if (generation.current !== gen) return p;
      applyProject(p);
      return p;
    } catch (e) { setError(errorText(e)); return undefined; } finally { if (generation.current === gen) setWorking(false); }
  };
  // The select and the 新建工程 button both funnel here with the dirty guard.
  const trySwitch = (target: string | null) => {
    if (busy) return;
    if (dirty) { setPendingSwitch(target); return; }
    void switchTo(target);
  };
  const switchTo = async (target: string | null) => {
    const gen = ++generation.current;
    setPendingSwitch(undefined); setUrl(''); setReplay(undefined); setRestoredNote(''); setError('');
    setSaveKey('');
    if (target === null) { setProject(undefined); return; }
    setWorking(true);
    try {
      const p = await request<Project>('studio/article/read', { id: target });
      if (generation.current !== gen) return;
      applyProject(p);
      const draft = loadArticleDrafts(draftStore(), workspaceId).drafts.find(item => item.projectId === target);
      if (draft) {
        const decision = draftReplayDecision(draft, p.revision);
        if (decision === 'fast-forward') {
          setNarration(draft.narration); setScenes(draft.scenes); setAspect(draft.aspect);
          if (draft.saveKey) setSaveKey(draft.saveKey);
          setRestoredNote(t('已恢复本工程未保存的本地修改。', 'Restored your unsaved changes for this project.'));
        } else if (decision === 'server-ahead') {
          setReplay({ draft, serverRevision: p.revision });
        }
      }
    } catch (e) { if (generation.current === gen) setError(errorText(e)); } finally { if (generation.current === gen) setWorking(false); }
  };
  const persist = async () => {
    if (!project) return;
    // A stable idempotency key survives a lost response: retrying this save
    // after a failure re-reads the project and can tell "landed" from "never
    // ran" instead of guessing.
    const key = saveKey || crypto.randomUUID();
    if (!saveKey) setSaveKey(key);
    const saved = await action('save', { narration, aspect, idempotencyKey: key, ...(project.audio && narration === project.narration ? { scenes } : {}) });
    if (saved) {
      setSaveKey('');
      clearArticleDraft(draftStore(), workspaceId, project.id);
      setDrafts(items => items.filter(item => item.projectId !== project.id));
      return;
    }
    // The save call failed: find out what the server actually has.
    const gen = generation.current;
    try {
      const truth = await request<Project>('studio/article/read', { id: project.id });
      if (generation.current !== gen) return;
      if (truth.narration === narration && truth.aspect === aspect) {
        setProject(truth); setSaveKey('');
        clearArticleDraft(draftStore(), workspaceId, project.id);
        setDrafts(items => items.filter(item => item.projectId !== project.id));
        setError(t('上次保存实际已成功，已同步到最新状态。', 'The previous save did land; the view is up to date now.'));
      }
    } catch { /* the original error stays visible */ }
  };
  const downloadDraft = (draft: ArticleDraft) => {
    const blob = new Blob([draftToMarkdown(draft)], { type: 'text/markdown;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = draft.projectId ? `article-draft-${draft.projectId}.md` : 'article-draft-new.md';
    link.click();
    URL.revokeObjectURL(link.href);
  };
  // Persist edit drafts (debounced) while the dialog is open.
  useEffect(() => {
    if (!open || !hydrated.current) return;
    const timer = setTimeout(() => {
      const store = draftStore();
      if (project) {
        if (dirty) {
          const result = storeArticleDraft(store, workspaceId, draftFromProject(workspaceId, project, { narration, aspect, scenes }, saveKey || undefined));
          if (result.unwritable) setStorageWarning(t('此浏览器无法保存草稿；请使用「保存修改」。', 'This browser cannot store drafts; use Save changes.'));
        } else {
          const result = clearArticleDraft(store, workspaceId, project.id);
          if (!result.unwritable) setDrafts(items => items.filter(item => item.projectId !== project.id));
        }
      } else {
        const hasInput = !!(title.trim() || article.trim() || audience.trim());
        const result = hasInput
          ? storeArticleDraft(store, workspaceId, makeArticleDraft(workspaceId, { title, article, audience }))
          : clearArticleDraft(store, workspaceId, null);
        if (result.unwritable) setStorageWarning(t('此浏览器无法保存草稿；请复制或导出文章内容。', 'This browser cannot store drafts; copy or export the article.'));
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [open, project, dirty, narration, aspect, scenes, title, article, audience, saveKey, workspaceId, t]);
  const view = async (kind: string) => {
    setError(''); try { const r = await request<{ url: string }>('studio/article/playback', { id: project?.id, kind }); setUrl(r.url); setAudioPreview(['sample', 'audio'].includes(kind)); } catch (e) { setError(errorText(e)); }
  };
  const replayEditable = replay && {
    narration: replay.draft.narration,
    scenes: replay.draft.scenes as Scene[],
    aspect: replay.draft.aspect,
  };
  return <>
    <button className="nw-button" onClick={() => { hydrated.current = true; void load(); }}><FileVideo size={16} />{t('文章转视频', 'Article to video')}</button>
    {open && <Modal title={t('文章转视频', 'Article to video')} close={async () => {
      if (working) return false;
      // Durable drafts make closing safe; only an unwritable store keeps the
      // old guardrail.
      if (dirty) {
        const stored = storeArticleDraft(draftStore(), workspaceId, draftFromProject(workspaceId, project!, { narration, aspect, scenes }, saveKey || undefined));
        if (stored.unwritable) { setError(t('请先保存修改，或重新打开当前工程放弃修改。', 'Save your changes, or reopen this project to discard them.')); return false; }
      }
      setOpen(false); setUrl('');
    }}>
      <div className="ns-article">
        <p className="nw-help">{t('文章 → 口播 → 配音 → 分镜 → 短预览 → 成片。每一步都能继续修改。', 'Article → narration → voice → storyboard → short preview → final video. Every step stays editable.')}</p>
        {restoredNote && <p role="status" className="nw-help">{restoredNote}</p>}
        {storageWarning && <p role="status" className="nw-inline-error">{storageWarning}</p>}
        <div className="ns-article-actions"><button className="nw-button" disabled={busy} onClick={() => trySwitch(null)}>{project ? (dirty ? t('保存或保留后新建', 'Resolve changes, then new') : t('新建工程', 'New project')) : t('新建工程', 'New project')}</button><select aria-label={t('文章视频工程', 'Article video project')} disabled={busy} value={project?.id || ''} onChange={e => { if (e.target.value) trySwitch(e.target.value); }}><option value="">{t('打开已有工程', 'Open project')}</option>{[...projects.filter(p => p.id !== project?.id), ...(project ? [project] : [])].map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></div>
        {pendingSwitch !== undefined && <div className="ns-article-actions" role="alertdialog" aria-label={t('未保存的修改', 'Unsaved changes')}>
          <span>{t('当前工程有未保存的修改。', 'This project has unsaved changes.')}</span>
          <button className="nw-button" disabled={working} onClick={async () => { const target = pendingSwitch; setPendingSwitch(undefined); await persist(); if (target !== undefined && (target === null || target !== project?.id)) await switchTo(target); }}>{t('保存并切换', 'Save, then switch')}</button>
          <button className="nw-button" onClick={() => { const target = pendingSwitch; setPendingSwitch(undefined); if (project) { storeArticleDraft(draftStore(), workspaceId, draftFromProject(workspaceId, project, { narration, aspect, scenes }, saveKey || undefined)); } void switchTo(target ?? null); }}>{t('保留草稿并切换', 'Keep draft, then switch')}</button>
          <button className="nw-button" onClick={() => { const target = pendingSwitch; setPendingSwitch(undefined); if (project) { clearArticleDraft(draftStore(), workspaceId, project.id); setDrafts(items => items.filter(item => item.projectId !== project.id)); } setSaveKey(''); void switchTo(target ?? null); }}>{t('放弃修改', 'Discard changes')}</button>
          <button className="nw-button" onClick={() => setPendingSwitch(undefined)}>{t('取消', 'Cancel')}</button>
        </div>}
        {!project ? <>
          <label className="nw-field">{t('标题', 'Title')}<input value={title} maxLength={100} onChange={e => setTitle(e.target.value)} /></label>
          <label className="nw-field">{t('给谁看，希望传达什么？', 'Audience and takeaway')}<input value={audience} maxLength={500} onChange={e => setAudience(e.target.value)} /></label>
          <label className="nw-field">{t('文章或主题', 'Article or topic')}<textarea rows={8} maxLength={60000} value={article} onChange={e => setArticle(e.target.value)} /></label>
          <input type="file" accept=".md,.txt" aria-label={t('导入文章', 'Import article')} onChange={async e => { const f = e.target.files?.[0]; if (f) { if (f.size > 180000) { setError(t('文章文件过大', 'Article file is too large')); return; } setArticle((await f.text()).slice(0, 60000)); if (!title) setTitle(f.name); } }} />
          <button className="nw-button primary" disabled={busy || !article.trim()} onClick={async () => {
            const key = crypto.randomUUID();
            const created = await action('create', { title, article, audience, idempotencyKey: key });
            if (created) {
              // The server now owns this content; the pre-create draft must not
              // resurrect stale text over the created project.
              clearArticleDraft(draftStore(), workspaceId, null);
              setDrafts(items => items.filter(item => item.projectId !== null));
              setTitle(''); setArticle(''); setAudience(''); setRestoredNote('');
            }
          }}>{t('创建工程', 'Create project')}</button>
          <button className="nw-button" disabled={!(title.trim() || article.trim() || audience.trim())} onClick={() => downloadDraft(makeArticleDraft(workspaceId, { title, article, audience }))}><Download size={14} />{t('导出草稿', 'Export draft')}</button>
        </> : <>
          <div className="ns-article-actions"><strong>{project.title}</strong><span>v{project.revision}</span><button className="nw-button" disabled={busy || dirty || !workspaceId} onClick={async () => {
            setWorking(true); try { await newTask(`${t('完善这个文章视频工程的口播和分镜', 'Improve this article video narration and storyboard')}\n${project.guide}\nProject ID: ${project.id}\n先调用 article_video read。先完成口播稿保存，不自动运行收费生成。`, { workspaceId, model: (models.find(m => m.isDefault) || models[0])?.id, write: true, submissionId: crypto.randomUUID() }); setOpen(false); } catch (e) { setError(errorText(e)); } finally { setWorking(false); }
          }}><Sparkles size={15} />{t('让助手完善', 'Ask assistant')}</button></div>
          <details><summary>{t('查看原文', 'Source article')}</summary><p className="ns-article-source">{project.article}</p></details>
          <label className="nw-field">{t('口播稿 · 空行分段', 'Narration · blank lines separate segments')}<textarea rows={7} value={narration} disabled={busy} onChange={e => setNarration(e.target.value)} /></label>
          <div className="ns-article-actions"><button className="nw-button" disabled={busy || !dirty} onClick={() => void persist()}>{t('保存修改', 'Save changes')}</button><label>{t('画幅', 'Aspect')}<select value={aspect} disabled={busy} onChange={e => setAspect(e.target.value)}><option>16:9</option><option>9:16</option><option>1:1</option></select></label></div>
          {replay && replayEditable && <div className="ns-article-actions" role="alertdialog" aria-label={t('服务器版本已更新', 'The server version moved ahead')}>
            <span>{t(`服务器已有 v${replay.serverRevision}（草稿基于 v${replay.draft.baseRevision}）。两份都保留：`, `The server is at v${replay.serverRevision}; this draft is based on v${replay.draft.baseRevision}. Both versions are kept:`)}</span>
            <button className="nw-button" onClick={() => { setNarration(replayEditable.narration); setScenes(replayEditable.scenes); setAspect(replayEditable.aspect); setReplay(undefined); }}>{t('应用我的草稿', 'Apply my draft')}</button>
            <button className="nw-button" onClick={() => { clearArticleDraft(draftStore(), workspaceId, replay.draft.projectId!); setDrafts(items => items.filter(item => item.projectId !== replay.draft.projectId)); setReplay(undefined); }}>{t('使用服务器版本', 'Use the server version')}</button>
            <button className="nw-button" onClick={() => downloadDraft(replay.draft)}><Download size={14} />{t('下载草稿', 'Download draft')}</button>
            <button className="nw-button" onClick={() => setReplay(undefined)}>{t('暂不处理', 'Decide later')}</button>
          </div>}
          <details open={!project.audio}><summary>{t('配音', 'Voice')}</summary><p className="nw-help">{t('本机 Windows 配音不产生模型费用。先试听，再生成全篇；时间按实际声音计算。', 'Local Windows speech has no model charges. Listen first, then generate the full voice. Timing follows actual audio.')}</p><label className="nw-field">{t('系统语音名称（留空使用默认）', 'System voice name (empty uses default)')}<input disabled={busy} value={voice} onChange={e => setVoice(e.target.value)} /></label>
            <div className="ns-article-actions"><button className="nw-button" disabled={busy || dirty || !narration} onClick={() => void action('voice', { voice, sample: true })}>{t('生成试听', 'Generate voice sample')}</button>{project.sample && <button className="nw-button" onClick={() => void view('sample')}><Play size={14} />{t('试听', 'Listen')}</button>}<button className="nw-button" disabled={busy || dirty || !narration} onClick={() => void action('voice', { voice, sample: false })}>{t('生成完整配音', 'Generate full voice')}</button>{project.audio && <button className="nw-button" onClick={() => void view('audio')}>{t('播放配音', 'Play voice')}</button>}</div>
            <details><summary>{t('使用已有配音与字幕', 'Use existing audio and subtitles')}</summary><select aria-label={t('资料库音频', 'Library audio')} value={audioId} onChange={e => setAudioId(e.target.value)}><option value="">{t('选择资料库音频', 'Choose library audio')}</option>{library.filter(e => /\.(wav|mp3|m4a|ogg|flac)$/i.test(e.name)).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select><label className="nw-field">{t('与此音频对齐的 SRT', 'SRT aligned with this audio')}<textarea rows={4} value={srt} onChange={e => setSrt(e.target.value)} /></label><button className="nw-button" disabled={busy || dirty || !audioId || !srt} onClick={() => void action('import-audio', { reference: { id: audioId, version: library.find(e => e.id === audioId)?.sha256 }, srt })}>{t('导入配音', 'Import audio')}</button></details>
          </details>
          {!!project.audio && <section><h3>{t('分镜', 'Storyboard')}</h3>{scenes.map((scene, i) => <div className="ns-article-scene" key={i}><small>{((project.audio?.captions[i].startFrame || 0) / 30).toFixed(1)}{'s — '}{((project.audio?.captions[i].endFrame || 0) / 30).toFixed(1)}{'s'}</small><input aria-label={t(`分镜 ${i + 1} 标题`, `Scene ${i + 1} title`)} disabled={busy} value={scene.heading} maxLength={100} onChange={e => setScenes(list => list.map((s, n) => n === i ? { ...s, heading: e.target.value } : s))} /><select aria-label={t(`分镜 ${i + 1} 图片`, `Scene ${i + 1} image`)} disabled={busy} value={scene.reference?.id || ''} onChange={e => { const file = library.find(f => f.id === e.target.value); setScenes(list => list.map((s, n) => n === i ? { ...s, reference: file ? { id: file.id, version: file.sha256 } : undefined } : s)); }}><option value="">{t('纯文字画面', 'Text scene')}</option>{library.filter(f => /.(png|jpe?g|webp)$/i.test(f.name)).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select><textarea aria-label={t(`分镜 ${i + 1} 画面文字`, `Scene ${i + 1} visual text`)} disabled={busy} value={scene.detail} maxLength={350} rows={2} onChange={e => setScenes(list => list.map((s, n) => n === i ? { ...s, detail: e.target.value } : s))} /></div>)}<div className="ns-article-actions"><button className="nw-button" disabled={busy || dirty} onClick={() => void action('build')}>{t('构建视频工程', 'Build video project')}</button><button className="nw-button" disabled={busy || dirty || !project.built} onClick={() => void action('render', { preview: true })}>{t('导出前 15 秒', 'Render first 15 seconds')}</button>{project.preview && <button className="nw-button" onClick={() => void view('preview')}>{t('观看预览', 'Watch preview')}</button>}<button className="nw-button primary" disabled={busy || dirty || !project.preview} onClick={() => void action('render', { preview: false })}>{t('导出完整视频', 'Render full video')}</button>{project.output && <button className="nw-button" onClick={() => void view('output')}>{t('观看成片', 'Watch final video')}</button>}</div>{project.built && <p className="ns-article-path">{project.built.directory}</p>}</section>}
          {project.busy && <div role="status" className="ns-article-actions"><Loader2 className="nw-spin" size={16} />{t('正在处理，关闭窗口后仍会继续', 'Working; continues after closing this window')}<button className="nw-button" onClick={() => void action('cancel')}>{t('取消', 'Cancel')}</button></div>}
          {url && (audioPreview ? <audio controls src={url} /> : <video controls playsInline src={url} />)}
        </>}
        {(error || project?.error) && <p role="alert" className="nw-inline-error">{error || project?.error}</p>}
        <details><summary>{t('运行组件', 'Runtime components')}</summary><p className="nw-help">{t('使用本机 HyperFrames 与 GSAP。此目录包含 node_modules；不会自动下载模型。', 'Uses local HyperFrames and GSAP. This directory contains node_modules; no models are downloaded automatically.')}</p><label className="nw-field">{t('Node 程序路径', 'Node executable path')}<input value={node} onChange={e => setNode(e.target.value)} /></label><label className="nw-field">{t('HyperFrames 安装目录', 'HyperFrames installation directory')}<input value={runtime} onChange={e => setRuntime(e.target.value)} /></label><button className="nw-button" disabled={busy} onClick={async () => { setWorking(true); try { await request('studio/article/config/save', { node, runtime }); setError(''); } catch (e) { setError(errorText(e)); } finally { setWorking(false); } }}>{t('保存运行组件', 'Save runtime settings')}</button></details>
      </div>
    </Modal>}
  </>;
}
