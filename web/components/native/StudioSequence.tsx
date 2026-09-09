"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Copy, Film, ListChecks, LockKeyhole, Pause, Play, Plus, RotateCcw, Save, Square, Trash2, X } from 'lucide-react';
import { composePreview, sequenceFinished, sequenceStateLabel, shotStateLabel, type StudioProfile, type StudioSequence, type StudioSequencePreviewShot, type StudioTemplate } from '@/lib/native-studio';
import { draftFromSequence, makeSequenceDraft, makeSequenceShot, MAX_SEQUENCE_SHOTS, moveSequenceShot, readSequenceDraft, renderSequenceTemplate, SEQUENCE_PAGE_SIZE, sequenceShotInput, type SequenceDraft, type SequenceShotDraft } from '@/lib/studio-sequence-draft';
import { errorText } from './NativeWorkbenchProvider';
import { SequenceFramePicker } from './SequenceFramePicker';
import { StudioTimeline } from './StudioTimeline';
import './studio-sequence-polish.css';

type Translater = (zh: string, en: string) => string;
type EditSession = { id: string; revision: number; draft: SequenceDraft };
type PendingSubmission = { idempotencyKey: string; start: boolean; draft: SequenceDraft };
const STORAGE_KEY = 'knorvia.studio.sequence.editor.v2';
const pageCount = (count: number) => Math.max(1, Math.ceil(count / SEQUENCE_PAGE_SIZE));
const normalizeFirst = (shots: SequenceShotDraft[]) => shots.map((shot, index) => index === 0 && !shot.locked ? { ...shot, continuity: 'none' as const } : shot);

export function StudioSequences({ request, t, profiles, templates, onNotice }: {
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>; t: Translater;
  profiles: StudioProfile[]; templates: StudioTemplate[]; onNotice: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editingFilm, setEditingFilm] = useState<string>();
  const [draft, setDraft] = useState<SequenceDraft>(makeSequenceDraft);
  const [editing, setEditing] = useState<EditSession>();
  const [pending, setPending] = useState<PendingSubmission>();
  const [hydrated, setHydrated] = useState(false);
  const [storageWarning, setStorageWarning] = useState('');
  const [sequences, setSequences] = useState<StudioSequence[]>([]);
  const [total, setTotal] = useState(0);
  const [expanded, setExpanded] = useState<string>();
  const [details, setDetails] = useState<Record<string, StudioSequence>>({});
  const [previews, setPreviews] = useState<Record<string, StudioSequencePreviewShot[]>>({});
  const [shotPage, setShotPage] = useState(0);
  const [detailPages, setDetailPages] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState('');
  const operation = useRef(false);
  const [error, setError] = useState('');
  const [live, setLive] = useState('');
  const [retryConfirmation, setRetryConfirmation] = useState<{ sequenceId: string; shotId: string }>();
  const [library, setLibrary] = useState<StudioTemplate[]>(templates);
  const [versions, setVersions] = useState<Record<string, StudioTemplate>>({});
  const editorRef = useRef<HTMLFormElement>(null);
  const sequenceListRef = useRef<StudioSequence[]>([]);
  const refreshInFlight = useRef(false);
  const restoredOnce = useRef(false);
  const current = editing?.draft ?? draft;
  const videoProfiles = useMemo(() => profiles.filter(profile => profile.kind === 'video'), [profiles]);
  const profile = videoProfiles.find(item => item.id === current.profileId) ?? videoProfiles[0];
  const frozen = !!pending && !editing;
  const actualShotPage = Math.min(shotPage, pageCount(current.shots.length) - 1);

  useEffect(() => { setLibrary(templates); }, [templates]);
  useEffect(() => { sequenceListRef.current = sequences; }, [sequences]);
  useEffect(() => {
    if (restoredOnce.current) return;
    restoredOnce.current = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw), restored = readSequenceDraft(saved.draft);
        if (restored) setDraft(restored);
        const editDraft = readSequenceDraft(saved.editing?.draft);
        if (editDraft && typeof saved.editing.id === 'string' && Number.isInteger(saved.editing.revision)) setEditing({ ...saved.editing, draft: editDraft });
        const pendingDraft = readSequenceDraft(saved.pending?.draft);
        if (pendingDraft && typeof saved.pending.idempotencyKey === 'string' && typeof saved.pending.start === 'boolean') setPending({ ...saved.pending, draft: pendingDraft });
      }
    } catch { setStorageWarning(t('无法恢复浏览器中的草稿；已保存的队列仍在。', 'The local draft could not be restored. Saved queues remain available.')); }
    setHydrated(true);
  }, [t]);
  useEffect(() => {
    if (!hydrated) return;
    const timer = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ draft, editing, pending })); }
      catch { setStorageWarning(t('草稿无法保存在此浏览器中，请使用「保存队列」。', 'Draft storage is unavailable. Use Save queue to keep your work.')); }
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, editing, pending, hydrated, t]);

  const remember = useCallback((sequence: StudioSequence) => {
    setDetails(items => ({ ...items, [sequence.id]: sequence }));
    setSequences(items => items.some(item => item.id === sequence.id) ? items.map(item => item.id === sequence.id ? sequence : item) : [sequence, ...items]);
  }, []);
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const page = await request<{ sequences: StudioSequence[]; total: number }>('studio/sequence/list', { offset: 0, limit: SEQUENCE_PAGE_SIZE });
      setTotal(page.total);
      setSequences(items => { const ids = new Set(page.sequences.map(item => item.id)); return [...page.sequences, ...items.filter(item => !ids.has(item.id))]; });
      if (expanded) {
        const detail = await request<StudioSequence>('studio/sequence/read', { id: expanded });
        setDetails(items => ({ ...items, [detail.id]: detail }));
      }
    } finally { refreshInFlight.current = false; }
  }, [request, expanded]);
  useEffect(() => {
    if (open) {
      void refresh().catch(e => setError(errorText(e)));
      void request<{ templates: StudioTemplate[] }>('studio/template/list', {}).then(result => setLibrary(result.templates)).catch(e => setError(errorText(e)));
    }
  }, [open, refresh, request]);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      if (document.hidden || operation.current || !sequenceListRef.current.some(sequence => sequence.state === 'running')) return;
      void refresh().catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  const run = async (key: string, work: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(key); setError('');
    try { await work(); } catch (e) { setError(errorText(e)); }
    finally { operation.current = false; setBusy(''); }
  };
  const change = (update: (value: SequenceDraft) => SequenceDraft) => {
    if (frozen || operation.current) return;
    if (editing) setEditing(value => value ? { ...value, draft: update(value.draft) } : value);
    else setDraft(update);
  };
  const patchShot = (id: string, patch: Partial<SequenceShotDraft>) => change(value => ({ ...value, shots: value.shots.map(shot => shot.id === id && !shot.locked ? { ...shot, ...patch } : shot) }));
  const templateFor = (shot: SequenceShotDraft) => versions[`${shot.templateId}:${shot.templateRevision}`] ?? library.find(template => template.id === shot.templateId && (!shot.templateRevision || template.revision === shot.templateRevision));
  const templateResult = (shot: SequenceShotDraft) => renderSequenceTemplate(shot, templateFor(shot));
  const draftIssue = (() => {
    if (!hydrated) return t('正在恢复草稿…', 'Restoring draft…');
    if (!videoProfiles.length) return t('先在「模型连接」里接入视频模型。', 'Connect a video model first.');
    for (let index = 0; index < current.shots.length; index++) {
      const shot = current.shots[index]; if (shot.locked) continue;
      if (!videoProfiles.some(item => item.id === (shot.profileId || profile?.id))) return t(`分镜 ${index + 1} 的模型连接已不存在，请重新选择。`, `Choose a valid model for shot ${index + 1}.`);
      const shotProfile = videoProfiles.find(item => item.id === (shot.profileId || profile?.id));
      if (shot.continuity === 'none' && shotProfile?.inputCapabilities?.requiresFirstFrame && !shot.firstFrame) return t(`分镜 ${index + 1} 的模型需要首帧图片。`, `The model for shot ${index + 1} requires a first frame.`);
      if (!shot.prompt.trim() && !shot.templateId) return t(`请填写分镜 ${index + 1} 的描述。`, `Describe shot ${index + 1}.`);
      if (templateResult(shot).missing.length) return t(`分镜 ${index + 1} 的模板版本或变量尚未完整。`, `Complete the template version and variables for shot ${index + 1}.`);
    }
    return '';
  })();
  const submit = async (start: boolean) => run(editing ? 'save-edit' : 'create', async () => {
    if (editing) {
      if (draftIssue) return;
      const result = await request<StudioSequence>('studio/sequence/update', { id: editing.id, revision: editing.revision, patch: {
        title: current.title, globalPrompt: current.globalPrompt, shots: current.shots.map(shot => sequenceShotInput({ ...shot, profileId: shot.profileId || profile?.id || '' })),
      } });
      remember(result); setExpanded(result.id); setEditing(undefined); setShotPage(0);
      onNotice(t('队列修改已保存，已提交分镜保持原样', 'Queue changes saved; submitted shots retain their inputs')); return;
    }
    if (!pending && draftIssue) return;
    const submission = pending ?? { idempotencyKey: crypto.randomUUID(), start, draft: { ...draft, profileId: profile?.id || '', shots: draft.shots.map(shot => ({ ...shot, profileId: shot.profileId || profile?.id || '' })) } };
    // Persist the exact request before dispatch. Retries after timeout or
    // reload use the same identity and content, avoiding a second queue.
    setPending(submission);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ draft, pending: submission })); }
    catch { setStorageWarning(t('此浏览器无法保存提交状态，请保持页面打开。', 'This browser cannot persist submission state. Keep the page open.')); }
    const result = await request<StudioSequence>('studio/sequence/create', {
      title: submission.draft.title.trim() || t('未命名分镜', 'Untitled sequence'), globalPrompt: submission.draft.globalPrompt,
      defaults: { profileId: submission.draft.profileId, seconds: submission.draft.seconds }, start: submission.start,
      idempotencyKey: submission.idempotencyKey, shots: submission.draft.shots.map(sequenceShotInput),
    });
    const fresh = makeSequenceDraft(); fresh.profileId = submission.draft.profileId; fresh.seconds = submission.draft.seconds; fresh.shots = [makeSequenceShot('', fresh.seconds)];
    setPending(undefined); setDraft(fresh); setShotPage(0); remember(result); setExpanded(result.id); await refresh();
    onNotice(result.state === 'ready' ? t('队列已保存，随时可以开始', 'Queue saved; start whenever you are ready') : t('分镜队列已开始', 'Storyboard queue started'));
  });
  const control = (sequence: StudioSequence, action: 'start' | 'pause' | 'resume' | 'cancel') => run(sequence.id, async () => {
    const result = await request<StudioSequence>(`studio/sequence/${action}`, { id: sequence.id }); remember(result); await refresh();
  });
  const retry = (sequenceId: string, shotId: string, confirmRegenerate = false) => run(sequenceId, async () => {
    try { await request('studio/sequence/retry', { id: sequenceId, shotId, ...(confirmRegenerate ? { confirmRegenerate: true } : {}) }); setRetryConfirmation(undefined); await refresh(); }
    catch (e) { if (!confirmRegenerate && errorText(e).includes('重新生成')) setRetryConfirmation({ sequenceId, shotId }); else throw e; }
  });
  const beginEdit = (sequence: StudioSequence) => run('edit-load', async () => {
    const latest = await request<StudioSequence>('studio/sequence/read', { id: sequence.id });
    if (!['ready', 'paused', 'needs-attention'].includes(latest.state)) throw new Error(t('请先暂停队列，再调整分镜。', 'Pause the queue before editing shots.'));
    const value = draftFromSequence(latest); setEditing({ id: latest.id, revision: latest.revision, draft: value }); setShotPage(0);
    await Promise.all(value.shots.filter(shot => shot.templateId && shot.templateRevision && !shot.locked).map(async shot => {
      try { const template = await request<StudioTemplate>('studio/template/read', { id: shot.templateId, revision: shot.templateRevision }); setVersions(items => ({ ...items, [`${template.id}:${template.revision}`]: template })); }
      catch { /* A saved rendered snapshot remains valid when the template is gone. */ }
    }));
    editorRef.current?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  });
  const move = (id: string, delta: number) => {
    const next = moveSequenceShot(current.shots, id, delta); if (next === current.shots) return;
    change(value => ({ ...value, shots: next }));
    const index = next.findIndex(shot => shot.id === id); setShotPage(Math.floor(index / SEQUENCE_PAGE_SIZE));
    setLive(t(`分镜已移到第 ${index + 1} 位`, `Shot moved to position ${index + 1}`));
    requestAnimationFrame(() => editorRef.current?.querySelector<HTMLElement>(`[data-shot-id="${id}"] textarea, [data-shot-id="${id}"] button`)?.focus());
  };
  const selectTemplate = (shot: SequenceShotDraft, id: string) => {
    const template = library.find(item => item.id === id);
    patchShot(shot.id, { templateId: template?.id, templateRevision: template?.revision, templateParams: template ? Object.fromEntries(Object.entries(template.defaults).map(([name, value]) => [name, String(value)])) : undefined, templateSnapshot: undefined });
  };
  const pager = (count: number, page: number, setPage: (page: number) => void, label: string) => count > SEQUENCE_PAGE_SIZE && <nav className="ns-sequence-pager" aria-label={label}>
    <button type="button" className="nw-button" disabled={page === 0} onClick={() => setPage(page - 1)}>{t('上一页', 'Previous')}</button><span>{page * SEQUENCE_PAGE_SIZE + 1}–{Math.min((page + 1) * SEQUENCE_PAGE_SIZE, count)} / {count}</span>
    <button type="button" className="nw-button" disabled={page + 1 >= pageCount(count)} onClick={() => setPage(page + 1)}>{t('下一页', 'Next')}</button>
  </nav>;

  return <section className="ns-sequence" aria-label={t('分镜队列', 'Storyboard sequences')}>
    <header className="ns-sequence-header"><button className="nw-button ns-sequence-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}><Film size={16} />{t('分镜队列', 'Storyboard sequences')}<span className="ns-hint">{t('逐段生成，自动续接真实尾帧', 'Generate in order, continuing from each real last frame')}</span>{open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button></header>
    {open && <div className="ns-sequence-body">
      <span className="ns-sequence-announcement" aria-live="polite">{live}</span>
      {error && <div role="alert" className="ns-error"><span>{error}</span><button className="nw-icon" aria-label={t('关闭提示', 'Dismiss message')} onClick={() => setError('')}><X size={16} /></button></div>}
      {storageWarning && <p className="nw-inline-error" role="status">{storageWarning}</p>}
      {pending && !editing && <div className="ns-sequence-pending" role="status"><p>{t('正在确认上次提交。重试将使用同一个请求，避免重复创建队列。', 'Confirming the previous submission. Retrying uses the same request to avoid a duplicate queue.')}</p><button className="nw-button" disabled={!!busy} onClick={() => void submit(pending.start)}><RotateCcw size={14} />{t('确认提交结果', 'Check submission')}</button></div>}
      <form ref={editorRef} className="ns-sequence-editor" onSubmit={event => { event.preventDefault(); void submit(true); }}>
        <div className="ns-sequence-editor-heading"><strong>{editing ? t('编辑已保存队列', 'Edit saved queue') : t('新建分镜队列', 'New storyboard queue')}</strong><span className="ns-hint">{editing ? `v${editing.revision}` : t('草稿自动保留', 'Draft saved automatically')}</span>{editing && <button type="button" className="nw-button" disabled={!!busy} onClick={() => { setEditing(undefined); setShotPage(0); }}>{t('返回新建草稿', 'Back to new draft')}</button>}</div>
        <fieldset disabled={!!busy || frozen} className="ns-sequence-fieldset">
          <div className="ns-sequence-fields">
            <label>{t('队列名称', 'Queue name')}<input value={current.title} maxLength={200} onChange={event => change(value => ({ ...value, title: event.target.value }))} placeholder={t('给这组分镜起个名字', 'Name this storyboard')} /></label>
            <label>{t('通用提示词', 'Shared prompt')}<textarea value={current.globalPrompt} maxLength={12000} rows={2} onChange={event => change(value => ({ ...value, globalPrompt: event.target.value }))} placeholder={t('角色、风格、场景……所有后续分镜都会继承', 'Characters, style, setting… inherited by subsequent shots')} /></label>
            {editing && <p className="ns-hint">{t('已提交分镜锁定原始输入；通用提示词只影响后续未提交段。', 'Submitted shots keep their inputs. The shared prompt applies to remaining unsubmitted shots.')}</p>}
            <div className="ns-sequence-defaults">
              <label>{t('默认模型', 'Default model')}<select aria-label={t('队列默认模型', 'Default model')} value={profile?.id ?? ''} onChange={event => change(value => ({ ...value, profileId: event.target.value }))}>{videoProfiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label>{t('新增分镜时长', 'New shot duration')}<span className="ns-duration-input"><input aria-label={t('默认秒数', 'Default seconds')} type="number" min={1} max={60} value={current.seconds} onChange={event => change(value => ({ ...value, seconds: Math.max(1, Math.min(60, Math.round(Number(event.target.value) || 4))) }))} /><span>{t('秒', 's')}</span></span></label>
            </div>
          </div>
          {pager(current.shots.length, actualShotPage, setShotPage, t('分镜编辑分页', 'Shot editor pages'))}
          <ol className="ns-shot-editor" start={actualShotPage * SEQUENCE_PAGE_SIZE + 1} aria-label={t('分镜列表', 'Shot list')}>
            {current.shots.slice(actualShotPage * SEQUENCE_PAGE_SIZE, (actualShotPage + 1) * SEQUENCE_PAGE_SIZE).map((shot, visibleIndex) => {
              const index = actualShotPage * SEQUENCE_PAGE_SIZE + visibleIndex, template = templateFor(shot), rendered = templateResult(shot), lockedAfter = current.shots.slice(index + 1).some(item => item.locked);
              return <li key={shot.id} data-shot-id={shot.id} className={`ns-shot-row ${shot.locked ? 'is-locked' : ''}`} onKeyDown={event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(shot.id, event.key === 'ArrowUp' ? -1 : 1); } }}>
                <span className="ns-shot-order" aria-hidden>{index + 1}</span><div className="ns-shot-main">
                  {shot.locked && <p className="ns-hint"><LockKeyhole size={12} />{t('已提交 · 输入已固定', 'Submitted · input pinned')}</p>}
                  {shot.templateId ? <><p className="ns-shot-prompt">{rendered.text || t('此模板版本不可用，请重新选择模板。', 'This template version is unavailable. Choose a template again.')}</p><div className="ns-shot-variables">{template?.variables.map(name => <label key={name}>{name}<input aria-label={t(`分镜 ${index + 1} 变量 ${name}`, `Shot ${index + 1} variable ${name}`)} disabled={shot.locked} value={shot.templateParams?.[name] ?? String(template.defaults[name] ?? '')} onChange={event => patchShot(shot.id, { templateSnapshot: undefined, templateParams: { ...shot.templateParams, [name]: event.target.value } })} /></label>)}</div><span className="ns-hint">{t('模板固定版本', 'Pinned template version')} v{shot.templateRevision}</span></> :
                    <textarea aria-label={t(`分镜 ${index + 1} 提示词`, `Shot ${index + 1} prompt`)} value={shot.prompt} disabled={shot.locked} maxLength={12000} rows={2} onChange={event => patchShot(shot.id, { prompt: event.target.value })} placeholder={t('这一幕发生什么？', 'What happens in this shot?')} />}
                  <div className="ns-shot-meta">
                    <select disabled={shot.locked} aria-label={t(`分镜 ${index + 1} 模型`, `Shot ${index + 1} model`)} value={shot.profileId} onChange={event => patchShot(shot.id, { profileId: event.target.value })}><option value="">{t('使用默认模型', 'Default model')}</option>{shot.profileId && !videoProfiles.some(item => item.id === shot.profileId) && <option value={shot.profileId}>{t('原模型已移除', 'Original model removed')}</option>}{videoProfiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
                    <label className="ns-shot-duration"><input aria-label={t(`分镜 ${index + 1} 秒数`, `Shot ${index + 1} seconds`)} type="number" min={1} max={60} disabled={shot.locked} value={shot.seconds} onChange={event => patchShot(shot.id, { seconds: Math.max(1, Math.min(60, Math.round(Number(event.target.value) || 4))) })} />{t('秒', 's')}</label>
                    <select disabled={shot.locked} aria-label={t(`分镜 ${index + 1} 模板`, `Shot ${index + 1} template`)} value={shot.templateId ?? ''} onChange={event => selectTemplate(shot, event.target.value)}><option value="">{t('不用模板', 'No template')}</option>{shot.templateId && !library.some(item => item.id === shot.templateId) && <option value={shot.templateId}>{t('已保存的模板内容', 'Saved template content')}</option>}{library.filter(item => item.kind !== 'image').map(item => <option key={item.id} value={item.id}>{`${item.name} · v${item.revision}`}</option>)}</select>
                    {index > 0 && <label className="ns-shot-continuity"><input type="checkbox" disabled={shot.locked} checked={shot.continuity === 'previous-tail'} onChange={event => patchShot(shot.id, { continuity: event.target.checked ? 'previous-tail' : 'none' })} />{t('续接上一段尾帧', 'Continue from previous last frame')}</label>}
                  </div>
                  {shot.continuity === 'none' && <SequenceFramePicker request={request} t={t} value={shot.firstFrame} disabled={shot.locked || !!busy || frozen} onChange={firstFrame => patchShot(shot.id, { firstFrame })} />}
                  {shot.templateId && !shot.locked && library.some(item => item.id === shot.templateId && item.revision !== shot.templateRevision) && <button type="button" className="nw-button" onClick={() => selectTemplate(shot, shot.templateId!)}>{t('改用模板最新版本', 'Use latest template version')}</button>}
                  <details className="ns-shot-composed"><summary>{t('查看组合提示词', 'View composed prompt')}</summary><p>{shot.acceptedPrompt ?? composePreview(current.globalPrompt, rendered.text)}</p></details>
                </div><div className="ns-shot-tools">
                  <button type="button" className="nw-icon" aria-label={t('上移分镜', 'Move shot up')} title={t('Alt + ↑', 'Alt + ↑')} disabled={shot.locked || index === 0 || current.shots[index - 1]?.locked} onClick={() => move(shot.id, -1)}><ChevronUp size={15} /></button>
                  <button type="button" className="nw-icon" aria-label={t('下移分镜', 'Move shot down')} title={t('Alt + ↓', 'Alt + ↓')} disabled={shot.locked || index === current.shots.length - 1 || current.shots[index + 1]?.locked} onClick={() => move(shot.id, 1)}><ChevronDown size={15} /></button>
                  <button type="button" className="nw-icon" aria-label={t('复制分镜', 'Duplicate shot')} disabled={lockedAfter || current.shots.length >= MAX_SEQUENCE_SHOTS} onClick={() => change(value => ({ ...value, shots: [...value.shots.slice(0, index + 1), { ...shot, id: crypto.randomUUID(), locked: false, continuity: 'previous-tail' }, ...value.shots.slice(index + 1)] }))}><Copy size={15} /></button>
                  <button type="button" className="nw-icon" aria-label={t('删除分镜', 'Remove shot')} disabled={shot.locked || lockedAfter || current.shots.length <= 1} onClick={() => change(value => ({ ...value, shots: normalizeFirst(value.shots.filter(item => item.id !== shot.id)) }))}><Trash2 size={15} /></button>
                </div>
              </li>;
            })}
          </ol>
          {pager(current.shots.length, actualShotPage, setShotPage, t('分镜编辑分页底部', 'Shot editor pages bottom'))}
          <div className="ns-sequence-actions"><button type="button" className="nw-button" disabled={current.shots.length >= MAX_SEQUENCE_SHOTS} onClick={() => { change(value => ({ ...value, shots: [...value.shots, makeSequenceShot('', value.seconds, value.shots.length)] })); setShotPage(Math.floor(current.shots.length / SEQUENCE_PAGE_SIZE)); }}><Plus size={15} />{t('添加分镜', 'Add shot')}</button><span className="ns-hint">{current.shots.length} / {MAX_SEQUENCE_SHOTS}</span>
            {!editing && <button type="button" className="nw-button" disabled={!!draftIssue} onClick={() => void submit(false)}><Save size={15} />{t('保存队列', 'Save queue')}</button>}<button className="ns-submit ns-sequence-submit" disabled={!!draftIssue} aria-label={editing ? t('保存分镜修改', 'Save shot changes') : t('开始生成整个队列', 'Start the whole queue')}>{editing ? t('保存修改', 'Save changes') : t('开始生成', 'Start')}</button>
          </div>{draftIssue && <p role="status" className="ns-input-issue">{draftIssue}</p>}
        </fieldset>
        {editing && <p className="ns-hint">{t('其他客户端更新此队列后，保存会保留你的编辑并提示冲突；重新打开队列可读取最新版本。', 'If another client updated this queue, saving keeps your edits and reports the conflict. Reopen the queue to load its latest version.')}</p>}
      </form>
      <div className="ns-sequence-list" aria-label={t('已有队列', 'Existing sequences')}>
        <div className="ns-sequence-editor-heading"><strong>{t('已保存队列', 'Saved queues')}</strong><span className="ns-hint">{sequences.length} / {total}</span><button className="nw-button" disabled={!!busy} onClick={() => void run('refresh', refresh)}><RotateCcw size={14} />{t('刷新', 'Refresh')}</button></div>
        {!sequences.length && <p className="ns-hint">{t('还没有分镜队列。', 'No storyboard queues yet.')}</p>}
        {sequences.map(summary => {
          const isOpen = expanded === summary.id, sequence = isOpen ? details[summary.id] ?? summary : summary, done = sequence.shots.filter(shot => shot.status === 'completed').length;
          const page = Math.min(detailPages[sequence.id] ?? 0, pageCount(sequence.shots.length) - 1);
          return <div key={sequence.id} className={`ns-sequence-item is-${sequence.state}`}>
            <button className="ns-sequence-summary" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? undefined : sequence.id)}><span className="ns-sequence-title">{sequence.title}</span><span className="ns-sequence-progress">{done}/{sequence.shots.length}</span><span className={`ns-state-badge is-${sequence.state}`}>{sequenceStateLabel(sequence.state, t)}</span></button>
            {isOpen && <div className="ns-sequence-detail">
              {sequence.blockedReason && <p className="nw-inline-error" role="alert">{sequence.blockedReason}</p>}{sequence.globalPrompt && <p className="ns-hint">{t('通用提示词', 'Shared prompt')}：{sequence.globalPrompt}</p>}
              {pager(sequence.shots.length, page, value => setDetailPages(items => ({ ...items, [sequence.id]: value })), t('队列详情分页', 'Queue detail pages'))}
              <ol className="ns-shot-list" start={page * SEQUENCE_PAGE_SIZE + 1}>{sequence.shots.slice(page * SEQUENCE_PAGE_SIZE, (page + 1) * SEQUENCE_PAGE_SIZE).map(shot => {
                const preview = previews[sequence.id]?.find(item => item.shotId === shot.id);
                return <li key={shot.id} className={`ns-shot-state is-${shot.status}`}><span className="ns-shot-order" aria-hidden>{shot.order + 1}</span><div className="ns-shot-main">
                  <p className="ns-shot-prompt">{shot.acceptedPrompt || shot.templateSnapshot || shot.prompt}</p>
                  <p className="ns-hint">{shotStateLabel(shot.status, t)} · {profiles.find(item => item.id === shot.profileId)?.name ?? t('原模型', 'Original model')} · {shot.seconds}{t('秒', 's')}{shot.continuity === 'previous-tail' && ` · ${t('续接尾帧', 'continues previous')}`}{shot.job?.progress !== undefined ? ` · ${shot.job.progress}%` : ''}{shot.result?.tailFrame && ` · ${t('尾帧已入库', 'tail frame saved')}`}{shot.templateRevision && ` · v${shot.templateRevision}`}</p>
                  {(shot.error || shot.job?.error) && <p className="nw-inline-error" role="alert">{shot.error || shot.job?.error}</p>}{preview?.prompt && <details><summary>{t('组合提示词快照', 'Composed prompt snapshot')}</summary><p className="ns-shot-prompt">{preview.prompt}</p></details>}{preview?.warnings?.map(warning => <p key={warning} className="ns-hint">{warning}</p>)}
                  {retryConfirmation?.sequenceId === sequence.id && retryConfirmation.shotId === shot.id && <div className="ns-sequence-confirm" role="alert"><p>{t('此操作会重新生成这一段。此前提交仍可能计费。', 'This creates a new generation for this shot. The previous submission may still be billed.')}</p><button className="nw-button" disabled={!!busy} onClick={() => void retry(sequence.id, shot.id, true)}>{t('确认重新生成', 'Generate again')}</button><button className="nw-button" onClick={() => setRetryConfirmation(undefined)}>{t('取消', 'Cancel')}</button></div>}
                </div>{['failed', 'blocked', 'cancelled'].includes(shot.status) && !sequenceFinished(sequence) && <button className="nw-button" disabled={!!busy} onClick={() => void retry(sequence.id, shot.id)}><RotateCcw size={14} />{t('恢复或重试', 'Recover or retry')}</button>}</li>;
              })}</ol>
              {pager(sequence.shots.length, page, value => setDetailPages(items => ({ ...items, [sequence.id]: value })), t('队列详情分页底部', 'Queue detail pages bottom'))}
              <div className="ns-sequence-controls">
                {sequence.shots.some(shot => shot.status === 'completed') && <button className="nw-button" disabled={!!busy} onClick={() => setEditingFilm(sequence.id)}><Film size={14} />{t('剪辑成片', 'Edit film')}</button>}
                {['ready', 'paused', 'needs-attention'].includes(sequence.state) && <button className="nw-button" disabled={!!busy || !!pending} onClick={() => void beginEdit(sequence)}>{t('编辑分镜', 'Edit shots')}</button>}
                {sequence.state === 'ready' && <button className="nw-button" disabled={!!busy} onClick={() => void control(sequence, 'start')}><Play size={14} />{t('开始', 'Start')}</button>}{sequence.state === 'running' && <button className="nw-button" disabled={!!busy} onClick={() => void control(sequence, 'pause')}><Pause size={14} />{t('暂停派发', 'Pause')}</button>}{['paused', 'needs-attention'].includes(sequence.state) && <button className="nw-button" disabled={!!busy} onClick={() => void control(sequence, 'resume')}><Play size={14} />{t('继续', 'Resume')}</button>}{!sequenceFinished(sequence) && <button className="nw-button" disabled={!!busy} onClick={() => void control(sequence, 'cancel')}><Square size={14} />{t('取消队列', 'Cancel')}</button>}
                <button className="nw-button" disabled={!!busy} onClick={() => void run(sequence.id, async () => { const result = await request<{ shots: StudioSequencePreviewShot[] }>('studio/sequence/preview', { id: sequence.id }); setPreviews(items => ({ ...items, [sequence.id]: result.shots })); })}><ListChecks size={14} />{t('组合预览', 'Prompt preview')}</button>
              </div>
            </div>}
          </div>;
        })}
        {sequences.length < total && <button className="nw-button ns-sequence-load" disabled={!!busy} onClick={() => void run('more', async () => {
          const page = await request<{ sequences: StudioSequence[]; total: number }>('studio/sequence/list', { offset: sequences.length, limit: SEQUENCE_PAGE_SIZE });
          setTotal(page.total); setSequences(items => { const ids = new Set(items.map(item => item.id)); return [...items, ...page.sequences.filter(item => !ids.has(item.id))]; });
        })}>{busy === 'more' ? t('加载中…', 'Loading…') : t('加载更多队列', 'Load more queues')}</button>}
      </div>
    </div>}
    {editingFilm && <StudioTimeline sequenceId={editingFilm} close={() => setEditingFilm(undefined)} />}
  </section>;
}
