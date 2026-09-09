'use client';
import { useCallback, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronDown, FileText, GraduationCap, ListChecks, Quote } from 'lucide-react';
import './learning.css';

// Learning classroom (KNORVIA-NIGHT B14). Renders a saved course/lecture
// artifact view (openmaic-course.js `view` structure) with a citation
// sidebar. Presentation only: it never fabricates content and shows evidence
// currency exactly as the artifact reports it. This component is opt-in and
// is NOT wired into the default home navigation.

export type EvidenceStatus = 'current' | 'superseded' | 'missing' | 'unknown';
export type CourseBlock =
  | { kind: 'text'; text: string }
  | { kind: 'quote'; quote: string; evidence: { libraryId: string; version: string; line?: number } }
  | { kind: 'quiz'; path: string }
  | { kind: 'lecture'; path: string }
  | { kind: 'video'; libraryId: string; version: string };
export type CourseSection = { module: string; lesson: string; blocks: CourseBlock[] };
export type CourseView = {
  title: string;
  topic?: string;
  sections: CourseSection[];
  evidenceStatuses?: EvidenceStatus[];
  missingRefs?: string[];
};

const blockKey = (section: number, index: number) => `b${section}-${index}`;

export function LearningClassroom({ course }: { course: CourseView }) {
  const [activeCitation, setActiveCitation] = useState<{ quote: string; libraryId: string; version: string; line?: number } | null>(null);
  const [progress, setProgress] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLOListElement>(null);
  const citations = useMemo(
    () => course.sections.flatMap((section, s) => section.blocks.flatMap((block, i) => block.kind === 'quote' ? [{ key: blockKey(s, i), quote: block.quote, libraryId: block.evidence.libraryId, version: block.evidence.version, line: block.evidence.line }] : [])),
    [course],
  );
  const toggleDone = useCallback((key: string) => {
    setProgress(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'j' && event.key !== 'k') return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('li[data-block-key]') ?? []);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.key === 'j' ? Math.min(items.length - 1, current + 1) : Math.max(0, current - 1);
    items[nextIndex]?.focus();
  }, []);
  const worstStatus: EvidenceStatus = course.missingRefs?.length ? 'missing' : course.evidenceStatuses?.includes('superseded') ? 'superseded' : course.evidenceStatuses?.includes('missing') ? 'missing' : 'current';
  return (
    <section className="lc-classroom" aria-label={course.title}>
      <header className="lc-heading">
        <GraduationCap size={22} aria-hidden />
        <div>
          <h2>{course.title}</h2>
          {course.topic && <p className="lc-topic">{course.topic}</p>}
        </div>
        <span className="lc-evidence-badge" data-status={worstStatus}>
          {worstStatus === 'current' ? '证据与当前资料一致' : worstStatus === 'superseded' ? '部分证据对应旧版本资料' : '部分引用的资料已不存在'}
        </span>
      </header>
      <div className="lc-body">
        <ol className="lc-sections" ref={listRef} onKeyDown={onKeyDown}>
          {course.sections.map((section, s) => (
            <li key={`${section.module}-${s}`} className="lc-module">
              <h3><BookOpen size={16} aria-hidden />{section.module}</h3>
              <p className="lc-lesson">{section.lesson}</p>
              <ul className="lc-blocks">
                {section.blocks.map((block, i) => {
                  const key = blockKey(s, i);
                  const done = progress.has(key);
                  return (
                    <li key={key} data-block-key={key} className="lc-block" tabIndex={0} data-done={done || undefined}>
                      <label className="lc-block-done">
                        <input type="checkbox" checked={done} onChange={() => toggleDone(key)} aria-label={`完成：${section.lesson} 第 ${i + 1} 块`} />
                      </label>
                      {block.kind === 'text' && <p className="lc-text">{block.text}</p>}
                      {block.kind === 'quote' && (
                        <button type="button" className="lc-quote" onClick={() => setActiveCitation({ quote: block.quote, libraryId: block.evidence.libraryId, version: block.evidence.version, line: block.evidence.line })}>
                          <Quote size={14} aria-hidden />
                          <span>{block.quote}</span>
                          <small>{block.evidence.line ? `第 ${block.evidence.line} 行` : ''}</small>
                        </button>
                      )}
                      {block.kind === 'quiz' && <span className="lc-ref"><ListChecks size={14} aria-hidden />练习：{block.path}</span>}
                      {block.kind === 'lecture' && <span className="lc-ref"><FileText size={14} aria-hidden />讲义：{block.path}</span>}
                      {block.kind === 'video' && <span className="lc-ref">视频资料：{block.libraryId.slice(0, 8)} @ {block.version.slice(0, 8)}</span>}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
        <aside className="lc-citations" aria-label="引用来源">
          <h3>引用来源（{citations.length}）</h3>
          {activeCitation ? (
            <figure className="lc-citation-active">
              <blockquote>{activeCitation.quote}</blockquote>
              <figcaption>
                资料库条目 {activeCitation.libraryId.slice(0, 8)} · 版本 {activeCitation.version.slice(0, 10)}
                {activeCitation.line ? ` · 第 ${activeCitation.line} 行` : ''}
              </figcaption>
              <button type="button" className="lc-close" onClick={() => setActiveCitation(null)}>关闭</button>
            </figure>
          ) : (
            <p className="lc-citation-empty">点击正文中的引用查看原文出处。</p>
          )}
          {course.missingRefs?.length ? (
            <details className="lc-missing">
              <summary><ChevronDown size={14} aria-hidden />缺失引用（{course.missingRefs.length}）</summary>
              <ul>{course.missingRefs.map(ref => <li key={ref}>{ref}</li>)}</ul>
            </details>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
