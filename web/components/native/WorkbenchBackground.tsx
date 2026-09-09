"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { BACKGROUND_EVENT, BACKGROUND_KEY, backgroundPreference, prepareBackground, readBackground, writeBackground, type BackgroundImage } from '@/lib/native-background';
import { READING_KEY, readingPreference } from '@/lib/native-reading';
import { useLocalPreference } from './useLocalPreference';

type Asset = BackgroundImage & { src: string };
type BackgroundContext = {
  image: Asset | null; busy: boolean; ready: boolean; error: unknown;
  preference: ReturnType<typeof backgroundPreference>;
  update: (change: (current: ReturnType<typeof backgroundPreference>) => ReturnType<typeof backgroundPreference>) => void;
  upload: (file: File) => Promise<void>; remove: () => Promise<void>;
};
const Context = createContext<BackgroundContext | null>(null);
export function useBackground() {
  const value = useContext(Context);
  if (!value) throw new Error('Background provider missing');
  return value;
}

/** Appearance updates have their own context: a slider never updates task state. */
export function WorkbenchBackground({ children }: { children: React.ReactNode }) {
  const [preference, update] = useLocalPreference(BACKGROUND_KEY, backgroundPreference);
  const [reading] = useLocalPreference(READING_KEY, readingPreference);
  const systemReduced = useReducedMotion(), reduced = reading.reducedMotion || !!systemReduced;
  const [image, setImage] = useState<Asset | null>(null), [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [error, setError] = useState<unknown>(null);
  const mounted = useRef(false), working = useRef(false), generation = useRef(0), active = useRef<Asset | null>(null);
  const urls = useRef(new Set<string>()), channel = useRef<BroadcastChannel | null>(null);
  const pendingReload = useRef(false), reloadRef = useRef<() => Promise<void>>(async () => {});
  const install = useCallback(async (record: BackgroundImage | null, version: number) => {
    if (record?.revision === active.current?.revision) return;
    let next: Asset | null = null;
    if (record) {
      const src = URL.createObjectURL(record.blob); urls.current.add(src);
      try { const photo = new Image(); photo.src = src; await photo.decode(); }
      catch (error) { URL.revokeObjectURL(src); urls.current.delete(src); throw error; }
      next = { ...record, src };
    }
    if (!mounted.current || version !== generation.current) {
      if (next) { URL.revokeObjectURL(next.src); urls.current.delete(next.src); }
      return;
    }
    const previous = active.current; active.current = next; setImage(next);
    // Exiting photos keep their URLs until their short crossfade has finished.
    if (previous) setTimeout(() => { URL.revokeObjectURL(previous.src); urls.current.delete(previous.src); }, 600);
  }, []);
  useEffect(() => {
    mounted.current = true;
    const reload = async () => {
      const version = ++generation.current;
      try { await install(await readBackground(), version); if (mounted.current) setError(null); }
      catch (error) { if (mounted.current) setError(error); }
      finally { if (mounted.current) setReady(true); }
    };
    void reload();
    reloadRef.current = reload;
    const changed = () => { if (working.current) pendingReload.current = true; else void reload(); };
    if (typeof BroadcastChannel !== 'undefined') { channel.current = new BroadcastChannel(BACKGROUND_EVENT); channel.current.onmessage = changed; }
    const storage = (event: StorageEvent) => { if (event.key === BACKGROUND_EVENT) changed(); };
    window.addEventListener('storage', storage);
    const ownedUrls = urls.current;
    return () => {
      // This ref is a cancellation counter, not a captured DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      mounted.current = false; generation.current++; channel.current?.close(); channel.current = null;
      window.removeEventListener('storage', storage);
      ownedUrls.forEach(url => URL.revokeObjectURL(url)); ownedUrls.clear(); active.current = null;
    };
  }, [install]);

  const changeImage = async (file: File | null) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError(null);
    const version = ++generation.current;
    try {
      const record = file ? await prepareBackground(file) : null;
      await writeBackground(record);
      await install(record, version);
      if (record) update(current => ({ ...current, enabled: true }));
      channel.current?.postMessage(record?.revision ?? 'removed');
      if (!channel.current) { try { localStorage.setItem(BACKGROUND_EVENT, crypto.randomUUID()); } catch { /* The image is already durable in IndexedDB. */ } }
    } catch (error) { if (mounted.current) setError(error); }
    finally {
      working.current = false;
      if (mounted.current) {
        setBusy(false); setReady(true);
        if (pendingReload.current) { pendingReload.current = false; void reloadRef.current(); }
      }
    }
  };
  const visible = !!image && preference.enabled;
  return <Context.Provider value={{ image, busy, ready, error, preference, update, upload: file => changeImage(file), remove: () => changeImage(null) }}>
    <div className="nw-background-host" data-background={visible}>
      <motion.div className="nw-background-canvas" aria-hidden="true" style={{ '--nw-photo-blur': `${preference.blur}px`, '--nw-photo-fit': preference.fit } as CSSProperties} initial={false} animate={{ opacity: visible ? 1 - preference.transparency / 100 : 0 }} transition={{ duration: reduced ? 0 : .18, ease: [.16, 1, .3, 1] }}>
        <AnimatePresence initial={false}>
          {image && <motion.img key={image.revision} src={image.src} alt="" draggable={false} data-fit={preference.fit} className="nw-background-photo" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .32, ease: 'easeOut' }} />}
        </AnimatePresence>
      </motion.div>
      {children}
    </div>
  </Context.Provider>;
}
