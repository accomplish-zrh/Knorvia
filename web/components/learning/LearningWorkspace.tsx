"use client";

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, useWorkbench } from '@/components/native/NativeWorkbenchProvider';
import './learning-workspace.css';

type Source = { id: string; name: string; path: string; version: string };
type Entry = { id: string; path: string; name: string; trashedAt?: string };
type Evidence = { libraryId: string; line: number; quote: string };
type Document = { title: string; path: string; kind: string; revision: number; authorship: string; sourceRefs: { name: string; evidenceStatus: string }[]; sections?: { heading: string; evidence: Evidence; points: { quote: string }[] }[]; questions?: { id: string; prompt: string; options?: string[]; answerIndex?: number; explanation?: string; evidence: Evidence }[] };
type Topic = { attemptCount: number; correctCount: number; correctAttempts: number; reviewAt: string };

export function LearningWorkspace() {
  const { request, t, connection, newTask, workspaceId } = useWorkbench();
  const [sources, setSources] = useState<Source[]>([]), [entries, setEntries] = useState<Entry[]>([]);
  const [topics, setTopics] = useState<Record<string, Topic>>({});
  const [selected, setSelected] = useState(''), [topic, setTopic] = useState('');
  const [document, setDocument] = useState<Document | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const attemptRef = useRef<string | null>(null);
  const [revealed, setRevealed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const refresh = useCallback(async () => {
    const [materials, library, mastery] = await Promise.all([
      request<{ sources: Source[] }>('learning/sources'), request<{ entries: Entry[] }>('library/list'), request<{ topics: Record<string, Topic> }>('learning/mastery/read'),
    ]);
    setSources(materials.sources); setEntries(library.entries.filter(e => !e.trashedAt && /^learning\/(讲座|练习)\//.test(e.path))); setTopics(mastery.topics);
  }, [request]);
  useEffect(() => { if (connection === 'connected') void refresh().catch(e => setError(errorText(e))); }, [connection, refresh]);
  async function action(run: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await run(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  async function open(entry: Entry) { await action(async () => { const kind = entry.path.includes('/练习/') ? 'quiz' : 'lecture'; setDocument(await request<Document>(`learning/${kind}/read`, { path: entry.path })); setAnswers({}); attemptRef.current = null; setRevealed(false); }); }
  const source = sources.find(s => s.id === selected);
  async function createOutline() { await action(async () => { if (!source) return; const doc = await request<Document>('learning/lecture/create', { topic: topic.trim() || source.name, sourceRefs: [{ id: source.id, version: source.version }], authorship: 'deterministic' }); setDocument(doc); setAnswers({}); setRevealed(false); await refresh(); }); }
  async function tutor() { await action(async () => { if (!source) return; await newTask(`请使用 learning_sources、learning_lecture 和 learning_quiz 帮我学习「${topic.trim() || source.name}」。资料 ID：${source.id}，固定版本：${source.version}。先读取原文，以逐行引用保存讲义，然后编写有依据的练习。不要把未经测试的理解记为掌握度。`, { workspaceId, write: true }); }); }
  async function grade() { await action(async () => { if (!document?.questions) return; await request('learning/attempt/record', { path: document.path, attemptId: (attemptRef.current ??= crypto.randomUUID()), results: document.questions.map(q => ({ questionId: q.id, outcome: answers[q.id] === q.answerIndex ? 'correct' : 'wrong' })) }); setRevealed(true); setNotice(t('本次练习已保存，可在复习中继续。', 'Practice saved. Continue in review.')); await refresh(); }); }
  const gradable = document?.questions?.every(q => Array.isArray(q.options) && Number.isInteger(q.answerIndex) && answers[q.id] !== undefined);
  return <main className="learning-workspace">
    <header><div><p className="learning-eyebrow">{t('从资料到理解', 'From material to understanding')}</p><h1>{t('学习', 'Learning')}</h1><p>{t('讲义、练习与复习，都保留你的资料依据。', 'Lectures, practice and review, connected to your sources.')}</p></div><Link href="/workbench/library">{t('资料库', 'Library')} ↗</Link></header>
    {error && <p role="alert" className="learning-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <section className="learning-start" aria-label={t('开始学习', 'Start learning')}>
      <label>{t('选择资料', 'Material')}<select aria-label={t('选择资料', 'Material')} value={selected} onChange={e => setSelected(e.target.value)}><option value="">{t('从资料库选择文本', 'Choose a text from your library')}</option>{sources.map(s => <option key={s.id} value={s.id}>{s.path}</option>)}</select></label>
      <label>{t('想学什么', 'Learning topic')}<input value={topic} onChange={e => setTopic(e.target.value)} placeholder={t('例如：把这章的核心概念讲明白', 'For example: understand this chapter')} /></label>
      <div className="learning-actions"><button disabled={busy || !source} onClick={createOutline}>{t('整理原文大纲', 'Outline source')}</button><button disabled={busy || !source || !workspaceId} onClick={tutor}>{t('让助手讲解与出题', 'Learn with an assistant')}</button></div>
      <small>{t('原文大纲直接整理材料；助手讲解会使用当前模型连接。', 'Source outlines organize your material directly. Tutoring uses your configured model.')}</small>
    </section>
    <div className="learning-columns"><aside><h2>{t('我的学习资料', 'My study materials')}</h2>{entries.length ? entries.map(e => <button className={document?.path === e.path ? 'selected' : ''} key={e.id} disabled={busy} onClick={() => open(e)}>{e.name.replace(/-[a-f0-9]+\.json$/, '')}</button>) : <p>{t('选择一份资料，创建第一份讲义。', 'Choose a source to create your first lecture.')}</p>}<h2>{t('复习', 'Review')}</h2>{Object.entries(topics).length ? Object.entries(topics).map(([name, state]) => <div className="learning-review" key={name}><strong>{name}</strong><span>{state.correctAttempts} / {state.attemptCount} {t('次练习完成正确', 'practices correct')}</span><small>{t('下次复习', 'Next review')} · {new Date(state.reviewAt).toLocaleDateString()}</small></div>) : <p>{t('完成练习后，这里会记录复习进度。', 'Your review progress appears after practice.')}</p>}</aside>
    <article>{document ? <><p className="learning-eyebrow">{document.authorship === 'deterministic' ? t('原文结构大纲', 'Source outline') : t('助手编写', 'Assistant authored')} · {t('版本', 'Revision')} {document.revision}</p><h2>{document.title}</h2>{document.sourceRefs?.map((ref, i) => <p className="learning-source" key={i}>{ref.name} {ref.evidenceStatus === 'superseded' ? t('· 来源已更新，当前内容引用旧版本', '· Source updated; this content cites an older version') : ''}</p>)}{document.sections?.map((section, i) => <section key={i}><h3>{section.heading}</h3><blockquote>{section.evidence.quote}<small>{t('原文第', 'Source line')} {section.evidence.line} {t('行', '')}</small></blockquote>{section.points.map((p, n) => <p key={n}>{p.quote}</p>)}</section>)}{document.questions?.map((q, i) => <section key={q.id}><h3>{i + 1}. {q.prompt}</h3>{q.options?.map((option, n) => <label className="learning-option" key={n}><input type="radio" name={q.id} checked={answers[q.id] === n} disabled={revealed || busy} onChange={() => setAnswers(a => ({ ...a, [q.id]: n }))} />{option}</label>)}{revealed && <div><p>{q.answerIndex === answers[q.id] ? t('回答正确', 'Correct') : t('再看一遍原文', 'Review the source')}</p><p>{q.explanation}</p><blockquote>{q.evidence.quote}</blockquote></div>}</section>)}{document.questions && <button disabled={busy || revealed || !gradable} onClick={grade}>{revealed ? t('已保存结果', 'Results saved') : t('提交练习', 'Submit practice')}</button>}</> : <div className="learning-empty"><h2>{t('让知识留下来', 'Make learning last')}</h2><p>{t('从左侧打开讲义或练习。每份成果都保存到资料库，随时回来继续。', 'Open a lecture or practice. Everything is saved in your library so you can return anytime.')}</p></div>}</article></div>
  </main>;
}
