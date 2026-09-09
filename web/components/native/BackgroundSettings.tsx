"use client";
/* eslint-disable @next/next/no-img-element -- Device-local Blob URLs are already resized and must never reach the image proxy. */

import { useRef, useState, type CSSProperties } from 'react';
import { ImagePlus, Loader2, RotateCcw, Trash2, Upload } from 'lucide-react';
import { BackgroundError, backgroundPreference } from '@/lib/native-background';
import { useWorkbench } from './NativeWorkbenchProvider';
import { useBackground } from './WorkbenchBackground';

export function BackgroundSettings() {
  const { t } = useWorkbench();
  const { image, busy, ready, error, preference, update, upload, remove } = useBackground();
  const input = useRef<HTMLInputElement>(null), dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const defaults = backgroundPreference('');
  const problems = {
    format: t('请选择 JPG、PNG 或 WebP 图片。', 'Choose a JPG, PNG or WebP image.'),
    size: t('请选择小于 20 MB 的非空图片。', 'Choose a non-empty image under 20 MB.'),
    decode: t('无法读取这张图片，请换一张试试。', 'This image could not be read. Try another one.'),
    dimensions: t('图片尺寸过大，请使用不超过 4800 万像素的图片。', 'Choose an image with no more than 48 megapixels.'),
    storage: t('背景未能保存，请检查此设备的可用空间或重试。', 'The background could not be saved. Check available storage or try again.'),
  };
  const errorText = error ? problems[error instanceof BackgroundError ? error.code : 'decode'] : '';
  return <section className="nw-preference-section nw-background-settings" aria-label={t('背景图片', 'Background image')}>
    <div className="nw-appearance-heading"><h2>{t('背景图片', 'Background image')}</h2><span>{t('给工作台一点自己的风格', 'Make the space your own')}</span></div>
    <div className={`nw-background-card ${dragging ? 'is-dragging' : ''}`} aria-busy={busy}
      onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; } }}
      onDragLeave={event => { event.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
      onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); const file = event.dataTransfer.files[0]; if (file && ready && !busy) void upload(file); }}>
      <input ref={input} className="nw-sr-only" tabIndex={-1} type="file" accept="image/jpeg,image/png,image/webp" aria-label={t('上传背景图片', 'Upload background image')} disabled={busy || !ready} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file); }} />
      <div className="nw-background-overview">
        <button type="button" className="nw-background-thumbnail" aria-label={image ? t('更换背景图片', 'Replace background image') : t('选择背景图片', 'Choose background image')} disabled={busy || !ready} onClick={() => input.current?.click()}>
          {image ? <img src={image.src} alt={image.name} /> : <ImagePlus size={26} strokeWidth={1.3} />}
          <span className="nw-background-thumbnail-action">{busy ? <Loader2 size={17} className="nw-spin" /> : <Upload size={17} />}</span>
        </button>
        <div className="nw-background-description"><strong title={image?.name}>{image?.name || t('选择喜欢的风景', 'A view you enjoy')}</strong><p>{image ? t('背景跟随你在各个页面之间切换。', 'Your background follows you from page to page.') : t('上传或拖入图片，所有主题均可使用。', 'Upload or drop an image. Works with every theme.')}</p>
          <div className="nw-background-actions"><button className="nw-button nw-button-small" disabled={busy || !ready} onClick={() => input.current?.click()}>{busy ? <Loader2 size={14} className="nw-spin" /> : <Upload size={14} />}{busy ? t('正在处理…', 'Processing…') : image ? t('更换图片', 'Replace image') : t('上传图片', 'Upload image')}</button>{image && <button className="nw-icon" disabled={busy} aria-label={t('移除背景图片', 'Remove background image')} onClick={() => void remove()}><Trash2 size={15} /></button>}</div>
        </div>
        <button type="button" role="switch" className="nw-appearance-switch" aria-label={t('显示背景图片', 'Show background image')} aria-checked={!!image && preference.enabled} disabled={!image || busy} onClick={() => update(current => ({ ...current, enabled: !current.enabled }))}><span /></button>
      </div>
      {image && <fieldset className="nw-background-controls" disabled={busy}>
        <legend className="nw-sr-only">{t('背景参数', 'Background controls')}</legend>
        <label className="nw-appearance-slider"><span><strong>{t('背景透明度', 'Background transparency')}</strong><output>{preference.transparency}%</output></span><input aria-label={t('背景透明度', 'Background transparency')} type="range" min={0} max={100} value={preference.transparency} aria-valuetext={`${preference.transparency}%`} style={{ '--range-value': `${preference.transparency}%` } as CSSProperties} onChange={event => update(current => ({ ...current, transparency: Number(event.target.value) }))} /><small>{t('越高，背景越淡。', 'Higher values soften the image.')}</small></label>
        <label className="nw-appearance-slider"><span><strong>{t('背景模糊', 'Background blur')}</strong><output>{`${preference.blur} px`}</output></span><input aria-label={t('背景模糊', 'Background blur')} type="range" min={0} max={24} value={preference.blur} aria-valuetext={`${preference.blur} px`} style={{ '--range-value': `${preference.blur / 24 * 100}%` } as CSSProperties} onChange={event => update(current => ({ ...current, blur: Number(event.target.value) }))} /><small>{t('柔化细节，减少阅读干扰。', 'Soften details for easier reading.')}</small></label>
        <div className="nw-background-fit"><span>{t('图片铺放', 'Image placement')}</span><div className="nw-segmented" role="group" aria-label={t('图片铺放', 'Image placement')}>{(['cover', 'contain'] as const).map(fit => <button type="button" key={fit} aria-pressed={preference.fit === fit} className={preference.fit === fit ? 'is-active' : ''} onClick={() => update(current => ({ ...current, fit }))}>{fit === 'cover' ? t('填满', 'Fill') : t('完整显示', 'Fit')}</button>)}</div><button type="button" className="nw-icon" aria-label={t('重置背景参数', 'Reset background controls')} disabled={preference.transparency === defaults.transparency && preference.blur === defaults.blur && preference.fit === defaults.fit} onClick={() => update(current => ({ ...current, transparency: defaults.transparency, blur: defaults.blur, fit: defaults.fit }))}><RotateCcw size={14} /></button></div>
      </fieldset>}
      <footer className="nw-background-footnote"><span>{t('JPG、PNG、WebP · 最大 20 MB', 'JPG, PNG, WebP · Up to 20 MB')}</span><span>{t('只保存在本机，不随对话发送', 'Saved locally, never attached to chats')}</span></footer>
    </div>
    {errorText && <p className="nw-background-error" role="alert">{errorText}</p>}
  </section>;
}
