"use client";

import { useRef } from 'react';
import { useWorkbench } from './NativeWorkbenchProvider';

export const sidebarWidth = (raw: string) => {
  const value = Number(raw);
  return raw && Number.isFinite(value) ? Math.max(220, Math.min(400, value)) : 260;
};
export function SidebarResize({ width, change }: { width: number; change: (width: number) => void }) {
  const { t } = useWorkbench();
  const drag = useRef<{ x: number; width: number } | null>(null);
  const clamp = (value: number) => Math.max(220, Math.min(400, value));
  return <div className="nw-sidebar-resize" role="separator" aria-orientation="vertical" aria-label={t('调整左侧栏宽度', 'Resize left sidebar')} title={t('拖动调整宽度 · 双击还原', 'Drag to resize · Double-click to reset')} tabIndex={0} aria-valuemin={220} aria-valuemax={400} aria-valuenow={width}
    onDoubleClick={() => change(260)} onKeyDown={event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); change(event.key === 'Home' ? 220 : event.key === 'End' ? 400 : clamp(width + (event.key === 'ArrowRight' ? 20 : -20))); }
    }} onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, width }; }}
    onPointerMove={event => { if (drag.current) change(clamp(drag.current.width + event.clientX - drag.current.x)); }}
    onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = null; }} />;
}
