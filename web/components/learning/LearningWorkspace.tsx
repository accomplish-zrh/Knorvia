"use client";

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, useWorkbench } from '@/components/native/NativeWorkbenchProvider';
import { LearningPracticePanel } from './LearningPracticePanel';
import './learning-workspace.css';

type Source = { id: string; name: string; path: string; version: string };
type Entry = { id: string; path: string; name: string; modifiedAt?: string; trashedAt?: string };
type ReviewItem = { quizPath: string; questionId: string; dueAt: string; quizStatus?: string };
type ReviewQueue = { due: ReviewItem[]; wrong: ReviewItem[]; truncated?: boolean };
type Evidence = { libraryId: string; line: number; quote: string };
type Document = { title: string; path: string; kind: string; revision: number; authorship: string; sourceRefs: { name: string; evidenceStatus: string }[]; sections?: { heading: string; evidence: Evidence; points: { quote: string }[] }[]; questions?: { id: string; prompt: string; options?: string[]; answerIndex?: number; explanation?: string; evidence: Evidence }[] };
type Topic = { attemptCount: number; correctCount: number; correctAttempts: number; reviewAt: string };

export function LearningWorkspace() {
  const { request, t, connection, newTask, workspaceId } = useWorkbench();
  const [sources, setSources] = useState<Source[]>([]), [entries, setEntries] = useState<Entry[]>([]);
  const [topics, setTopics] = useState<Record<string, Topic>>({});
  const [selected, setSelected] = useState(''), [topic, setTopic] = useState('');
  const [document, setDocument] = useState<Document | null>(null);
  const [practice, setPractice] = useState<{ quizPath?: string; sessionPath?: string } | null>(null);
  const [reviewQueue, setReviewQueue] = useState<ReviewQueue>({ due: [], wrong: [] });
  const preselected = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const refresh = useCallback(async () => {
    const [materials, library, mastery, queue] = await Promise.all([
      request<{ sources: Source[] }>('learning/sources'), request<{ entries: Entry[] }>('library/list'), request<{ topics: Record<string, Topic> }>('learning/mastery/read'), request<ReviewQueue>('learning/practice/due'),
    ]);
    setSources(materials.sources); setEntries(library.entries.filter(e => !e.trashedAt && /^learning\/(讲座|练习|练习会话)\//.test(e.path))); setTopics(mastery.topics); setReviewQueue(queue);
  }, [request]);
  useEffect(() => { if (connection === 'connected') void refresh().catch(e => setError(errorText(e))); }, [connection, refresh]);
  async function action(run: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await run(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  async function open(entry: Entry) { await action(async () => {
    if (entry.path.includes('/练习会话/')) { setDocument(null); setPractice({ sessionPath: entry.path }); return; }
    if (entry.path.includes('/练习/')) { setDocument(null); setPractice({ quizPath: entry.path }); return; }
    setDocument(await request<Document>('learning/lecture/read', { path: entry.path })); setPractice(null);
  }); }
  useEffect(() => {
    const sourceId = new URLSearchParams(window.location.search).get('source');
    if (!preselected.current && sourceId && sources.some(item => item.id === sourceId)) { setSelected(sourceId); preselected.current = true; }
  }, [sources]);
  const source = sources.find(s => s.id === selected);
  async function createOutline() { await action(async () => { if (!source) return; const doc = await request<Document>('learning/lecture/create', { topic: topic.trim() || source.name, sourceRefs: [{ id: source.id, version: source.version }], authorship: 'deterministic' }); setDocument(doc); setPractice(null); await refresh(); }); }
  async function tutor() { await action(async () => { if (!source) return; await newTask(`请使用 learning_sources、learning_lecture 和 learning_quiz 帮我学习「${topic.trim() || source.name}」。资料 ID：${source.id}，固定版本：${source.version}。先读取原文，以逐行引用保存讲义，然后编写有依据的练习。不要把未经测试的理解记为掌握度。`, { workspaceId, write: true }); }); }
  return <main className="learning-workspace">
    <header><div><p className="learning-eyebrow">{t('从资料到理解', 'From material to understanding')}</p><h1>{t('学习', 'Learning')}</h1><p>{t('讲义、练习与复习，都保留你的资料依据。', 'Lectures, practice and review, connected to your sources.')}</p></div><Link href="/workbench/library">{t('资料库', 'Library')} ↗</Link></header>
    {error && <p role="alert" className="learning-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <section className="learning-start" aria-label={t('开始学习', 'Start learning')}>
      <label>{t('选择资料', 'Material')}<select aria-label={t('选择资料', 'Material')} value={selected} onChange={e => setSelected(e.target.value)}><option value="">{t('从资料库选择文本', 'Choose a text from your library')}</option>{sources.map(s => <option key={s.id} value={s.id}>{s.path}</option>)}</select></label>
      <label>{t('想学什么', 'Learning topic')}<input value={topic} onChange={e => setTopic(e.target.value)} placeholder={t('例如：把这章的核心概念讲明白', 'For example: understand this chapter')} /></label>
      <div className="learning-actions"><button disabled={busy || connection !== 'connected' || !source} onClick={createOutline}>{t('整理原文大纲', 'Outline source')}</button><button disabled={busy || connection !== 'connected' || !source || !workspaceId} onClick={tutor}>{t('让助手讲解与出题', 'Learn with an assistant')}</button></div>
      <small>{t('原文大纲直接整理材料；助手讲解会使用当前模型连接。', 'Source outlines organize your material directly. Tutoring uses your configured model.')}</small>
    </section>
    <div className="learning-columns"><aside><h2>{t('我的学习资料', 'My study materials')}</h2>{entries.length ? entries.map(e => <button className={(document?.path ?? practice?.quizPath ?? practice?.sessionPath) === e.path ? 'selected' : ''} key={e.id} disabled={busy} onClick={() => open(e)}>{e.path.includes('/练习会话/') ? t('继续练习', 'Resume practice') + (e.modifiedAt ? ` · ${new Date(e.modifiedAt).toLocaleString()}` : '') : e.name.replace(/-[a-f0-9]+\.json$/, '')}</button>) : <p>{t('选择一份资料，创建第一份讲义。', 'Choose a source to create your first lecture.')}</p>}<h2>{t('逐题复习', 'Question review')}</h2><p>{reviewQueue.due.length} {t('题到期', 'due')} · {reviewQueue.wrong.length} {t('道错题', 'mistakes')}</p>{reviewQueue.truncated && <p role="status">{t('统计只覆盖部分记录。', 'Statistics cover part of your history.')}</p>}{Array.from(new Set([...reviewQueue.due, ...reviewQueue.wrong].filter(item => !item.quizStatus || item.quizStatus === 'current').map(item => item.quizPath))).map(quizPath => <button key={quizPath} disabled={busy} onClick={() => { setDocument(null); setPractice({ quizPath }); }}>{t('继续复习', 'Continue review')} · {quizPath.split('/').at(-1)?.replace(/-[a-f0-9]+\.json$/, '')}</button>)}{[...reviewQueue.due, ...reviewQueue.wrong].some(item => item.quizStatus && item.quizStatus !== 'current') && <p className="learning-source">{t('部分记录属于旧版或已移除题库，重新出题后可开始新练习。', 'Some records belong to older or removed quizzes. Start fresh practice from an updated quiz.')}</p>}<h2>{t('以前的整卷记录', 'Earlier whole-quiz records')}</h2>{Object.entries(topics).length ? Object.entries(topics).map(([name, state]) => <div className="learning-review" key={name}><strong>{name}</strong><span>{state.correctAttempts} / {state.attemptCount} {t('次练习完成正确', 'practices correct')}</span><small>{t('下次复习', 'Next review')} · {new Date(state.reviewAt).toLocaleDateString()}</small></div>) : <p>{t('完成练习后，这里会记录复习进度。', 'Your review progress appears after practice.')}</p>}</aside>
    <article>{practice ? <LearningPracticePanel key={practice.quizPath ?? practice.sessionPath} {...practice} onSaved={refresh} /> : document ? <><p className="learning-eyebrow">{document.authorship === 'deterministic' ? t('原文结构大纲', 'Source outline') : t('助手编写', 'Assistant authored')} · {t('版本', 'Revision')} {document.revision}</p><h2>{document.title}</h2>{document.sourceRefs?.map((ref, i) => <p className="learning-source" key={i}>{ref.name} {ref.evidenceStatus === 'superseded' ? t('· 来源已更新，当前内容引用旧版本', '· Source updated; this content cites an older version') : ''}</p>)}{document.sections?.map((section, i) => <section key={i}><h3>{section.heading}</h3><blockquote>{section.evidence.quote}<small>{t('原文第', 'Source line')} {section.evidence.line} {t('行', '')}</small></blockquote>{section.points.map((p, n) => <p key={n}>{p.quote}</p>)}</section>)}</> : <div className="learning-empty"><h2>{t('让知识留下来', 'Make learning last')}</h2><p>{t('从左侧打开讲义或练习。每份成果都保存到资料库，随时回来继续。', 'Open a lecture or practice. Everything is saved in your library so you can return anytime.')}</p></div>}</article></div>
  </main>;
}
