"use client";

import { useEffect } from 'react';
import { READING_KEY, readingPreference } from '@/lib/native-reading';

/** One non-blocking entrance per document, never a route-change curtain. */
export function WorkbenchArrival() {
  useEffect(() => {
    const root = document.documentElement;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => { root.removeAttribute('data-workbench-arriving'); clearTimeout(timer); };
    const prefersLess = () => {
      if (reduced.matches) return true;
      try { return readingPreference(localStorage.getItem(READING_KEY) ?? '').reducedMotion; } catch { return false; }
    };
    const preference = () => { if (prefersLess()) finish(); };
    if (!prefersLess()) { root.setAttribute('data-workbench-arriving', ''); timer = setTimeout(finish, 640); }
    reduced.addEventListener('change', preference);
    window.addEventListener('knorvia-ui-preference', preference);
    return () => { finish(); reduced.removeEventListener('change', preference); window.removeEventListener('knorvia-ui-preference', preference); };
  }, []);
  return null;
}
