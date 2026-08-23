'use client'

import { useEffect, useRef, useState } from 'react'
import { Brush, Check, RotateCcw, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { trimCanvasHistory } from '@/lib/image-studio/canvas-history'

type MaskSnapshot = {
  frame: ImageData
  data: Uint8ClampedArray
  hasMask: boolean
}

export function MaskEditor({
  sourceUrl,
  busy,
  onCancel,
  onSave,
}: {
  sourceUrl: string
  busy: boolean
  onCancel: () => void
  onSave: (file: File) => Promise<void>
}) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const snapshots = useRef<MaskSnapshot[]>([])
  const previousPoint = useRef<{ x: number; y: number } | null>(null)
  const [brushSize, setBrushSize] = useState(48)
  const [ready, setReady] = useState(false)
  const [hasMask, setHasMask] = useState(false)
  const [historyDepth, setHistoryDepth] = useState(0)

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onCancel])

  function context() {
    return canvasRef.current?.getContext('2d') || null
  }

  function remember() {
    const canvas = canvasRef.current
    const ctx = context()
    if (!canvas || !ctx) return
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
    snapshots.current.push({ frame, data: frame.data, hasMask })
    trimCanvasHistory([snapshots.current])
    setHistoryDepth(snapshots.current.length)
  }

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
      scale: canvas.width / rect.width,
    }
  }

  function draw(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    const ctx = context()
    if (!ctx) return
    const { x, y, scale } = point(event)
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.62)'
    ctx.fillStyle = 'rgba(239, 68, 68, 0.62)'
    ctx.lineWidth = brushSize * scale
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const previous = previousPoint.current
    if (previous) {
      ctx.beginPath()
      ctx.moveTo(previous.x, previous.y)
      ctx.lineTo(x, y)
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.arc(x, y, (brushSize * scale) / 2, 0, Math.PI * 2)
      ctx.fill()
    }
    previousPoint.current = { x, y }
    setHasMask(true)
  }

  function begin(event: React.PointerEvent<HTMLCanvasElement>) {
    remember()
    drawing.current = true
    previousPoint.current = null
    event.currentTarget.setPointerCapture(event.pointerId)
    draw(event)
  }

  function undo() {
    const ctx = context()
    const previous = snapshots.current.pop()
    if (ctx && previous) {
      ctx.putImageData(previous.frame, 0, 0)
      setHasMask(previous.hasMask)
      setHistoryDepth(snapshots.current.length)
    }
  }

  function clear() {
    const canvas = canvasRef.current
    const ctx = context()
    if (!canvas || !ctx) return
    remember()
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    setHasMask(false)
  }

  async function save() {
    const overlay = canvasRef.current
    if (!overlay) return
    const mask = document.createElement('canvas')
    mask.width = overlay.width
    mask.height = overlay.height
    const ctx = mask.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, mask.width, mask.height)
    ctx.globalCompositeOperation = 'destination-out'
    ctx.drawImage(overlay, 0, 0)
    const blob = await new Promise<Blob | null>(resolve => mask.toBlob(resolve, 'image/png'))
    if (blob) await onSave(new File([blob], 'mask.png', { type: 'image/png' }))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-[var(--card)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold">{t('Inpaint mask')}</h2>
            <p className="text-xs text-[var(--muted-foreground)]">
              {t('Paint the area that the model should redraw.')}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label={t('Close')}
            className="rounded-lg p-2 hover:bg-[var(--muted)]"
          >
            <X size={18} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto bg-black/5 p-4">
          <div className="relative mx-auto w-fit max-w-full overflow-hidden rounded-xl shadow-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={sourceUrl}
              alt={t('Inpaint source')}
              className="block max-h-[68vh] max-w-full select-none"
              onLoad={event => {
                const image = event.currentTarget
                const canvas = canvasRef.current
                if (!canvas) return
                canvas.width = image.naturalWidth
                canvas.height = image.naturalHeight
                snapshots.current = []
                setHasMask(false)
                setHistoryDepth(0)
                setReady(true)
              }}
            />
            <canvas
              ref={canvasRef}
              className="absolute inset-0 h-full w-full touch-none cursor-crosshair"
              onPointerDown={begin}
              onPointerMove={draw}
              onPointerUp={() => {
                drawing.current = false
                previousPoint.current = null
              }}
              onPointerCancel={() => {
                drawing.current = false
                previousPoint.current = null
              }}
            />
          </div>
        </div>
        <footer className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] px-5 py-3">
          <Brush size={16} />
          <input
            aria-label={t('Brush size')}
            type="range"
            min={8}
            max={180}
            value={brushSize}
            onChange={event => setBrushSize(Number(event.target.value))}
          />
          <span className="text-xs text-[var(--muted-foreground)]">
            {brushSize} {t('pixels')}
          </span>
          <span
            className={`rounded-full px-2 py-1 text-[10px] ${hasMask ? 'bg-red-500/10 text-red-500' : 'bg-[var(--muted)] text-[var(--muted-foreground)]'}`}
          >
            {hasMask ? t('Mask ready') : t('Paint an area')}
          </span>
          <button
            type="button"
            onClick={undo}
            disabled={historyDepth === 0 || busy}
            className="ml-2 flex items-center gap-1 rounded-lg border border-[var(--border)] px-3 py-2 text-xs"
          >
            <RotateCcw size={14} />
            {t('Undo')}
          </button>
          <button
            type="button"
            onClick={clear}
            disabled={!hasMask || busy}
            className="flex items-center gap-1 rounded-lg border border-[var(--border)] px-3 py-2 text-xs"
          >
            <Trash2 size={14} />
            {t('Clear')}
          </button>
          <div className="flex-1" />
          <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm">
            {t('Cancel')}
          </button>
          <button
            type="button"
            disabled={!ready || !hasMask || busy}
            onClick={() => void save()}
            className="flex items-center gap-2 rounded-lg bg-[var(--foreground)] px-4 py-2 text-sm text-[var(--background)] disabled:opacity-40"
          >
            <Check size={15} />
            {busy ? t('Saving…') : t('Use mask')}
          </button>
        </footer>
      </div>
    </div>
  )
}
