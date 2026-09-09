'use client';
import { useCallback, useEffect, useState } from 'react';
import { FileVideo, Loader2, Play, Sparkles } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import { Modal } from './WorkbenchShell';
import type { LibraryEntry } from '@/lib/native-library';
import './studio-article.css';

type Scene = { heading: string; detail: string; reference?: { id: string; version: string } };
type Project = { id: string; title: string; article: string; narration: string; scenes: Scene[]; aspect: string; revision: number; busy?: string; phase: string; error?: string; guide: string; sample?: object; audio?: { frames: number; captions: { startFrame: number; endFrame: number; text: string }[] }; built?: { directory: string }; preview?: object; output?: { libraryId: string } };
export function StudioArticle() {
  const { request, t, newTask, models, workspaceId } = useWorkbench();
  const [open, setOpen] = useState(false), [projects, setProjects] = useState<Project[]>([]), [project, setProject] = useState<Project>();
  const [article, setArticle] = useState(''), [title, setTitle] = useState(''), [audience, setAudience] = useState('');
  const [narration, setNarration] = useState(''), [scenes, setScenes] = useState<Scene[]>([]), [aspect, setAspect] = useState('16:9');
  const [error, setError] = useState(''), [working, setWorking] = useState(false), [url, setUrl] = useState(''), [audioPreview, setAudioPreview] = useState(false);
  const [voice, setVoice] = useState(''), [node, setNode] = useState(''), [runtime, setRuntime] = useState(''), [library, setLibrary] = useState<LibraryEntry[]>([]), [audioId, setAudioId] = useState(''), [srt, setSrt] = useState('');
  const busy = working || !!project?.busy;
  const dirty = !!project && (narration !== project.narration || JSON.stringify(scenes) !== JSON.stringify(project.scenes) || aspect !== project.aspect);
  const accept = useCallback((p: Project) => { setProject(p); setNarration(p.narration); setScenes(p.scenes); setAspect(p.aspect); }, []);
  const load = async () => {
    setError(''); setOpen(true);
    try {
      const [list, cfg, files] = await Promise.all([request<{ projects: Project[] }>('studio/article/list'), request<{ node: string; runtime: string }>('studio/article/config'), request<{ entries: LibraryEntry[] }>('library/list')]);
      setProjects(list.projects); setNode(cfg.node); setRuntime(cfg.runtime); setLibrary(files.entries.filter(e => !e.trashedAt && /\.(wav|mp3|m4a|ogg|flac|png|jpe?g|webp)$/i.test(e.name)));
    } catch (e) { setError(errorText(e)); }
  };
  useEffect(() => {
    if (!open || !project?.busy) return;
    let stopped = false, reading = false;
    const timer = setInterval(async () => {
      if (reading) return; reading = true;
      try { const p = await request<Project>('studio/article/read', { id: project.id }); if (!stopped) accept(p); }
      catch (e) { if (!stopped) setError(errorText(e)); } finally { reading = false; }
    }, 1200);
    return () => { stopped = true; clearInterval(timer); };
  }, [open, project?.id, project?.busy, request, accept]);
  const action = async (name: string, params: Record<string, unknown> = {}) => {
    if (working) return; setWorking(true); setError('');
    try { accept(await request<Project>(`studio/article/${name}`, { id: project?.id, revision: project?.revision, ...params })); }
    catch (e) { setError(errorText(e)); } finally { setWorking(false); }
  };
  const persist = () => action('save', { narration, aspect, ...(project?.audio && narration === project.narration ? { scenes } : {}) });
  const view = async (kind: string) => {
    setError(''); try { const r = await request<{ url: string }>('studio/article/playback', { id: project?.id, kind }); setUrl(r.url); setAudioPreview(['sample', 'audio'].includes(kind)); } catch (e) { setError(errorText(e)); }
  };
  return <>
    <button className="nw-button" onClick={() => void load()}><FileVideo size={16} />{t('文章转视频', 'Article to video')}</button>
    {open && <Modal title={t('文章转视频', 'Article to video')} close={async () => {
      if (working) return false;
      if (dirty) { setError(t('请先保存修改，或重新打开当前工程放弃修改。', 'Save your changes, or reopen this project to discard them.')); return false; }
      setOpen(false); setUrl('');
    }}>
      <div className="ns-article">
        <p className="nw-help">{t('文章 → 口播 → 配音 → 分镜 → 短预览 → 成片。每一步都能继续修改。', 'Article → narration → voice → storyboard → short preview → final video. Every step stays editable.')}</p>
        <div className="ns-article-actions"><button className="nw-button" disabled={busy || dirty} onClick={() => { setProject(undefined); setUrl(''); }}>{t('新建工程', 'New project')}</button><select aria-label={t('文章视频工程', 'Article video project')} disabled={busy} value={project?.id || ''} onChange={e => { if (e.target.value) void action('read', { id: e.target.value }); }}><option value="">{t('打开已有工程', 'Open project')}</option>{[...projects.filter(p => p.id !== project?.id), ...(project ? [project] : [])].map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></div>
        {!project ? <>
          <label className="nw-field">{t('标题', 'Title')}<input value={title} maxLength={100} onChange={e => setTitle(e.target.value)} /></label>
          <label className="nw-field">{t('给谁看，希望传达什么？', 'Audience and takeaway')}<input value={audience} maxLength={500} onChange={e => setAudience(e.target.value)} /></label>
          <label className="nw-field">{t('文章或主题', 'Article or topic')}<textarea rows={8} maxLength={60000} value={article} onChange={e => setArticle(e.target.value)} /></label>
          <input type="file" accept=".md,.txt" aria-label={t('导入文章', 'Import article')} onChange={async e => { const f = e.target.files?.[0]; if (f) { if (f.size > 180000) { setError(t('文章文件过大', 'Article file is too large')); return; } setArticle((await f.text()).slice(0, 60000)); if (!title) setTitle(f.name); } }} />
          <button className="nw-button primary" disabled={busy || !article.trim()} onClick={() => void action('create', { title, article, audience, idempotencyKey: crypto.randomUUID() })}>{t('创建工程', 'Create project')}</button>
        </> : <>
          <div className="ns-article-actions"><strong>{project.title}</strong><span>v{project.revision}</span><button className="nw-button" disabled={busy || dirty || !workspaceId} onClick={async () => {
            setWorking(true); try { await newTask(`${t('完善这个文章视频工程的口播和分镜', 'Improve this article video narration and storyboard')}\n${project.guide}\nProject ID: ${project.id}\n先调用 article_video read。先完成口播稿保存，不自动运行收费生成。`, { workspaceId, model: (models.find(m => m.isDefault) || models[0])?.id, write: true, submissionId: crypto.randomUUID() }); setOpen(false); } catch (e) { setError(errorText(e)); } finally { setWorking(false); }
          }}><Sparkles size={15} />{t('让助手完善', 'Ask assistant')}</button></div>
          <details><summary>{t('查看原文', 'Source article')}</summary><p className="ns-article-source">{project.article}</p></details>
          <label className="nw-field">{t('口播稿 · 空行分段', 'Narration · blank lines separate segments')}<textarea rows={7} value={narration} disabled={busy} onChange={e => setNarration(e.target.value)} /></label>
          <div className="ns-article-actions"><button className="nw-button" disabled={busy || !dirty} onClick={() => void persist()}>{t('保存修改', 'Save changes')}</button><label>{t('画幅', 'Aspect')}<select value={aspect} disabled={busy} onChange={e => setAspect(e.target.value)}><option>16:9</option><option>9:16</option><option>1:1</option></select></label></div>
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
