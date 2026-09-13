"use client";

import { useEffect, useRef, useState } from 'react';
import { errorText, useWorkbench } from '@/components/native/NativeWorkbenchProvider';

type Feedback = {
  questionId: string; submissionId: string; outcome: string; grading: string;
  answerIndex?: number; answerText?: string; selfRating?: string;
  explanation?: string; feedback?: string; evidence?: { quote: string; line: number };
};
export type PracticeSession = {
  path: string; sessionId: string; quizPath: string; status: string; revision: number;
  progress: { answered: number; total: number; remaining: number };
  current: { questionId: string; prompt: string; options?: string[] } | null;
  submitted: Feedback[]; lastFeedback?: Feedback;
  sourceRefs: { name: string; evidenceStatus: string }[];
  truncated?: boolean; message?: string;
};

export function LearningPracticePanel({ quizPath, sessionPath, onSaved }: {
  quizPath?: string; sessionPath?: string; onSaved: () => Promise<void>;
}) {
  const { request, t, connection } = useWorkbench();
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [choice, setChoice] = useState<number | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const generation = useRef(0);
  const createKey = useRef<{ mode: string; id: string } | null>(null);
  const assessmentKey = useRef<{ questionId: string; rating: string; id: string } | null>(null);

  useEffect(() => {
    const current = ++generation.current;
    setSession(null); setPending(null); setChoice(null); setAnswer(''); setError(''); createKey.current = null;
    setBusy(Boolean(sessionPath));
    if (sessionPath) void request<PracticeSession>('learning/practice/read', { path: sessionPath }).then(value => {
      if (generation.current === current) setSession(value);
    }).catch(cause => { if (generation.current === current) setError(errorText(cause)); }).finally(() => { if (generation.current === current) setBusy(false); });
    return () => { generation.current += 1; };
  }, [sessionPath, quizPath, request]);

  async function run(task: () => Promise<PracticeSession>) {
    const current = generation.current;
    setBusy(true); setError('');
    try {
      const value = await task();
      if (current !== generation.current) return;
      setSession(value); setPending(null);
      if (value.current?.questionId !== session?.current?.questionId) { setChoice(null); setAnswer(''); }
      try { await onSaved(); } catch { /* The session write succeeded; keep its confirmed state visible. */ }
    } catch (cause) { if (current === generation.current) setError(errorText(cause)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  function start(mode: 'all' | 'wrong' | 'due') {
    if (!quizPath) return;
    if (createKey.current?.mode !== mode) createKey.current = { mode, id: crypto.randomUUID() };
    const sessionId = createKey.current.id;
    void run(() => request<PracticeSession>('learning/practice/start', { quizPath, mode, sessionId }));
  }
  function submit() {
    if (!session?.current || (!pending && choice === null && !answer.trim())) return;
    const payload = pending ?? {
      path: session.path, questionId: session.current.questionId, submissionId: crypto.randomUUID(),
      ...(session.current.options ? { answerIndex: choice } : { answerText: answer.trim() }),
    };
    setPending(payload);
    void run(async () => (await request<{ session: PracticeSession }>('learning/practice/answer', payload)).session);
  }
  const enabled = connection === 'connected' && !busy;
  function assess(questionId: string, rating: 'correct' | 'wrong') {
    if (!session) return;
    if (assessmentKey.current?.questionId !== questionId || assessmentKey.current.rating !== rating) assessmentKey.current = { questionId, rating, id: crypto.randomUUID() };
    const assessmentId = assessmentKey.current.id;
    void run(async () => (await request<{ session: PracticeSession }>('learning/practice/assess', { path: session.path, questionId, selfRating: rating, assessmentId })).session);
  }
  return <section className="learning-practice" aria-label={t('逐题练习', 'Question practice')}>
    <h2>{t('先试着回答，再看反馈', 'Try first, then review feedback')}</h2>
    <p className="learning-source">{t('每次作答都会保存，可从左侧的练习记录继续。开放题保存你的原话，暂不自动评分。', 'Every answer is saved. Resume from your practice history. Written answers are recorded without automatic grading.')}</p>
    {error && <p role="alert" className="learning-error">{error}</p>}
    {!session && sessionPath && <button disabled={!enabled} onClick={() => void run(() => request<PracticeSession>('learning/practice/read', { path: sessionPath }))}>{t('重新读取进度', 'Reload progress')}</button>}
    {pending && !busy && <p role="status">{t('这次作答尚未确认保存。可重试，或重新读取进度后继续。', 'Saving this answer has not been confirmed. Retry or reload your progress.')}</p>}
    {(!session || session.status === 'empty') && quizPath && <div className="learning-actions">
      <button disabled={!enabled} onClick={() => start('all')}>{t('开始逐题练习', 'Start practice')}</button>
      <button disabled={!enabled} onClick={() => start('wrong')}>{t('只练错题', 'Practice mistakes')}</button>
      <button disabled={!enabled} onClick={() => start('due')}>{t('复习到期题目', 'Review due questions')}</button>
    </div>}
    {session?.status === 'empty' && <p role="status">{t('当前没有符合条件的待练题目。', 'There are no questions to practice in this mode.')}</p>}
    {session?.truncated && <p role="status">{t('复习统计只覆盖部分练习记录，请缩小资料范围后核对。', 'Review statistics cover only part of your history. Check the coverage before continuing.')}</p>}
    {session?.path && <>
      <div className="learning-practice-progress"><span>{session.progress.answered} / {session.progress.total} {t('题已作答', 'answered')}</span><button disabled={!enabled} onClick={() => void run(() => request<PracticeSession>('learning/practice/read', { path: session.path }))}>{t('重新读取进度', 'Reload progress')}</button></div>
      {session.sourceRefs.filter(ref => ref.evidenceStatus !== 'current').map((ref, index) => <p className="learning-source" key={index}>{ref.name} · {ref.evidenceStatus === 'missing' ? t('来源已移除，练习保留历史版本', 'Source removed; practice retains its historical version') : t('来源已更新，本次练习使用原版本', 'Source updated; this practice uses its original version')}</p>)}
      {session.current && <div key={session.current.questionId} className="learning-question">
        <h3>{session.current.prompt}</h3>
        {session.current.options ? <fieldset disabled={!enabled || Boolean(pending)}><legend className="sr-only">{t('选择答案', 'Choose an answer')}</legend>{session.current.options.map((option, index) => <label className="learning-option" key={index}><input type="radio" name={`practice-${session.sessionId}`} checked={choice === index} onChange={() => setChoice(index)} />{option}</label>)}</fieldset> : <label>{t('用自己的话回答', 'Answer in your own words')}<textarea rows={5} maxLength={4000} value={answer} disabled={!enabled || Boolean(pending)} onChange={event => setAnswer(event.target.value)} /></label>}
        <button disabled={!enabled || (!pending && (session.current.options ? choice === null : !answer.trim()))} onClick={submit}>{pending ? t('重试保存', 'Retry saving') : t('提交作答', 'Submit answer')}</button>
      </div>}
      {session.status === 'completed' && <p role="status">{t('本次作答已全部保存。可以查看反馈，或在复习队列中继续。', 'All answers in this practice are saved. Review your feedback or continue from the review queue.')}</p>}
      {session.submitted.length > 0 && <div className="learning-feedback"><h3>{t('已作答的反馈', 'Feedback on your answers')}</h3>{session.submitted.map((item, index) => <section key={item.submissionId}>
        <strong>{index + 1}. {item.grading === 'server' ? item.outcome === 'correct' ? t('回答正确', 'Correct') : t('需要复习', 'Review needed') : item.grading === 'self-reported' ? t('已记录自评', 'Self-assessment saved') : t('回答已保存，待评估', 'Answer saved, awaiting assessment')}</strong>
        {item.answerText && <p>{item.answerText}</p>}{item.explanation && <p>{item.explanation}</p>}{item.evidence && <blockquote>{item.evidence.quote}<small>{t('原文行号', 'Source line')} {item.evidence.line}</small></blockquote>}
        {item.grading !== 'server' && <div className="learning-actions"><span>{item.selfRating ? item.selfRating === 'correct' ? t('你的自评：答对了', 'Your assessment: correct') : t('你的自评：还需练习', 'Your assessment: needs practice') : t('对照原文后，记录你的自评：', 'Compare with the source, then assess your answer:')}</span><button disabled={!enabled || Boolean(pending)} onClick={() => assess(item.questionId, 'correct')}>{t('自评：答对了', 'Self-assess: correct')}</button><button disabled={!enabled || Boolean(pending)} onClick={() => assess(item.questionId, 'wrong')}>{t('自评：还需练习', 'Self-assess: needs practice')}</button></div>}
      </section>)}</div>}
    </>}
  </section>;
}
