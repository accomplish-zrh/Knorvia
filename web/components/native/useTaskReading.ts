"use client";

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { readTaskView, saveTaskView } from '@/lib/native-task-view';

export function useTaskReading(id: string, revision: unknown) {
  const scroll = useRef<HTMLDivElement>(null);
  const [nearBottom, setNearBottom] = useState(() => readTaskView(id).reading?.bottom ?? true);
  const following = useRef(nearBottom);
  const restored = useRef(false);
  const ready = revision !== undefined;
  const capture = useCallback(() => {
    const el = scroll.current;
    if (!el || !restored.current) return;
    const bounds = el.getBoundingClientRect();
    const anchor = [...el.querySelectorAll<HTMLElement>('[data-item-id]')].find(node => node.getBoundingClientRect().bottom > bounds.top + 1);
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    following.current = bottom; setNearBottom(bottom);
    saveTaskView(id, { reading: { top: el.scrollTop, bottom, ...(anchor ? { anchor: anchor.dataset.itemId, offset: anchor.getBoundingClientRect().top - bounds.top } : {}) } });
  }, [id]);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    if (!restored.current) {
      const saved = readTaskView(id).reading;
      const anchor = saved?.anchor ? el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(saved.anchor)}"]`) : null;
      el.scrollTo({ top: !saved || saved.bottom ? el.scrollHeight : anchor ? el.scrollTop + anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - (saved.offset ?? 0) : saved.top, behavior: 'instant' });
      restored.current = true;
    } else if (following.current) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
  }, [id, revision]);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(capture); };
    el.addEventListener('scroll', onScroll, { passive: true });
    const content = el.firstElementChild;
    const observer = new ResizeObserver(() => { if (following.current) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }); });
    if (content) observer.observe(content);
    return () => { capture(); cancelAnimationFrame(frame); observer.disconnect(); el.removeEventListener('scroll', onScroll); };
  }, [id, capture, ready]);
  const jump = useCallback(() => {
    following.current = true; setNearBottom(true);
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, []);
  const pauseFollowing = useCallback(() => { following.current = false; setNearBottom(false); }, []);
  return { scroll, nearBottom, jump, pauseFollowing };
}
