"use client";

import { useEffect, useLayoutEffect, useRef } from 'react';
import { motion, useReducedMotion, useSpring } from 'framer-motion';
import { Film, Image as ImageIcon } from 'lucide-react';
import { READING_KEY, readingPreference } from '@/lib/native-reading';
import { useLocalPreference } from './useLocalPreference';
import { useWorkbench } from './NativeWorkbenchProvider';

/** One continuous selection surface. Retargeting a spring preserves its velocity
 * when the user changes direction before the previous selection has settled. */
export function StudioKindSwitch({ value, change }: { value: 'image' | 'video'; change: (value: 'image' | 'video') => void }) {
  const { t, locale } = useWorkbench();
  const [reading] = useLocalPreference(READING_KEY, readingPreference);
  const systemReduced = useReducedMotion(), reduced = reading.reducedMotion || systemReduced;
  const root = useRef<HTMLDivElement>(null), initialized = useRef(false);
  const spring = { stiffness: 520, damping: 39, mass: .72, restDelta: .1, restSpeed: .1 };
  const x = useSpring(0, spring), width = useSpring(0, spring);
  useLayoutEffect(() => {
    const active = root.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (!active) return;
    if (!initialized.current || reduced) { x.jump(active.offsetLeft); width.jump(active.offsetWidth); }
    else { x.set(active.offsetLeft); width.set(active.offsetWidth); }
    initialized.current = true;
  }, [value, locale, reduced, x, width]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const active = root.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
      if (active) { x.jump(active.offsetLeft); width.jump(active.offsetWidth); }
    });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, [x, width]);
  return <div ref={root} className="ns-kind" role="group" aria-label={t('创作类型', 'Creation type')}>
    <motion.span className="ns-kind-highlight" aria-hidden="true" style={{ x, width }} />
    <button type="button" aria-pressed={value === 'image'} onClick={() => change('image')}><ImageIcon size={16} />{t('图片', 'Image')}</button>
    <button type="button" aria-pressed={value === 'video'} onClick={() => change('video')}><Film size={16} />{t('视频', 'Video')}</button>
  </div>;
}
