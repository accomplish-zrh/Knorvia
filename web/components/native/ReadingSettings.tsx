"use client";

import { RotateCcw } from 'lucide-react';
import type { CSSProperties } from 'react';
import { READING_KEY, readingPreference, type ReadingPreference } from '@/lib/native-reading';
import { useLocalPreference } from './useLocalPreference';
import { useWorkbench } from './NativeWorkbenchProvider';

export function ReadingSettings() {
  const { t } = useWorkbench(); const [reading, update] = useLocalPreference(READING_KEY, readingPreference);
  return <section className="nw-preference-section"><div className="nw-appearance-heading"><h2>{t('阅读体验', 'Reading comfort')}</h2><button className="nw-button nw-button-small" disabled={reading.size === 15 && reading.width === 'standard' && !reading.reducedMotion} onClick={() => update(() => readingPreference(''))}><RotateCcw size={13} />{t('恢复默认', 'Reset')}</button></div><div className="nw-reading-settings">
    <div className="nw-reading-sample" style={{ fontSize: reading.size }}><strong>{t('留出空间，把一件事做好。', 'Make room to do something well.')}</strong><p>{t('对话和资料中的文字，应该读起来轻松。调整字号后，回到工作台即可沿用。', 'Reading should feel comfortable. Your text size follows you back into conversations and documents.')}</p></div>
    <label className="nw-appearance-slider"><span><strong>{t('阅读字号', 'Reading text size')}</strong><output>{`${reading.size} px`}</output></span><input type="range" min={13} max={20} step={1} style={{ "--range-value": `${(reading.size - 13) / 7 * 100}%` } as CSSProperties} aria-label={t('阅读字号', 'Reading text size')} aria-valuetext={`${reading.size} px`} value={reading.size} onChange={event => update(current => ({ ...current, size: Number(event.target.value) }))} /><small>{t('用于对话、输入框与文本资料；文档自带的排版保持原样。', 'Applies to conversations, composers and text previews. Documents keep their own layout.')}</small></label>
    <div className="nw-reading-width"><span>{t('对话宽度', 'Conversation width')}</span><div className="nw-segmented" role="group" aria-label={t('对话宽度', 'Conversation width')}>{[['focused', t('专注', 'Focused')], ['standard', t('标准', 'Standard')], ['wide', t('宽松', 'Wide')]].map(([width, title]) => <button key={width} className={reading.width === width ? 'is-active' : ''} aria-pressed={reading.width === width} onClick={() => update(current => ({ ...current, width: width as ReadingPreference['width'] }))}>{title}</button>)}</div></div>
    <div className="nw-reading-motion"><div><strong>{t('减少动效', 'Reduce motion')}</strong><p>{t('减少界面切换中的动画和移动。', 'Reduce animations and movement when navigating.')}</p></div><button role="switch" className="nw-appearance-switch" aria-label={t('减少动效', 'Reduce motion')} aria-checked={reading.reducedMotion} onClick={() => update(current => ({ ...current, reducedMotion: !current.reducedMotion }))}><span /></button></div>
  </div></section>;
}
