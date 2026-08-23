'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Brush,
  Eraser,
  Expand,
  Hand,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  Redo2,
  RotateCcw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  CANVAS_TOOLS,
  canvasToolAvailability,
  shouldExportPaintedMask,
  type BackendOperation,
  type CanvasTool,
} from '@/lib/image-studio/studio-logic'
import { trimCanvasHistory } from '@/lib/image-studio/canvas-history'

const TOOL_LABEL: Record<CanvasTool, string> = {
  select: 'Select',
  move: 'Move',
  brush: 'Brush tool',
  eraser: 'Eraser tool',
  inpaint: 'Local redraw',
  outpaint: 'Expand canvas',
  erase: 'Remove objects',
  undo: 'Undo',
  redo: 'Redo',
  zoom: 'Zoom',
  fit: 'Fit to canvas',
}

type CanvasSnapshot = {
  frame: ImageData
  data: Uint8ClampedArray
  hasMask: boolean
}

export function StudioCanvas({
  sourceUrl,
  operations,
  hasSelection,
  busy,
  onUnavailable,
  onMaskReady,
  onInpaint,
}: {
  sourceUrl: string
  operations: BackendOperation[]
  hasSelection: boolean
  busy?: boolean
  onUnavailable: (message: string) => void
  onMaskReady: (file: File | null) => void
  onInpaint: (file: File | null) => void
}) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const drawing = useRef(false)
  const previous = useRef<{ x: number; y: number } | null>(null)
  const undoStack = useRef<CanvasSnapshot[]>([])
  const redoStack = useRef<CanvasSnapshot[]>([])
  const [tool, setTool] = useState<CanvasTool>('brush')
  const [zoom, setZoom] = useState(1)
  const [hasMask, setHasMask] = useState(false)
  const paintedRef = useRef(false)
  const [brushSize, setBrushSize] = useState(36)
  const [reason, setReason] = useState('')

  const onMaskReadyRef = useRef(onMaskReady)

  useEffect(() => {
    onMaskReadyRef.current = onMaskReady
  }, [onMaskReady])

  function availability(item: CanvasTool) {
    return canvasToolAvailability(item, {
      operations,
      hasSelection,
      hasMask,
    })
  }

  function remember() {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
    undoStack.current.push({ frame, data: frame.data, hasMask: paintedRef.current })
    redoStack.current = []
    trimCanvasHistory([undoStack.current, redoStack.current])
  }

  function canvasHasPaint(): boolean {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || canvas.width === 0 || canvas.height === 0) return false
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] !== 0) return true
    }
    return false
  }

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  function draw(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || (tool !== 'brush' && tool !== 'eraser')) return
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const next = point(event)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = brushSize
    if (tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.strokeStyle = 'rgba(0,0,0,1)'
    } else {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.62)'
    }
    const last = previous.current
    ctx.beginPath()
    if (last) ctx.moveTo(last.x, last.y)
    else ctx.moveTo(next.x, next.y)
    ctx.lineTo(next.x, next.y)
    ctx.stroke()
    previous.current = next
    if (tool === 'brush') {
      paintedRef.current = true
      setHasMask(true)
    }
  }

  async function exportMask() {
    const overlay = canvasRef.current
    if (!overlay || !canvasHasPaint()) return null
    const mask = document.createElement('canvas')
    mask.width = overlay.width
    mask.height = overlay.height
    const ctx = mask.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, mask.width, mask.height)
    ctx.globalCompositeOperation = 'destination-out'
    ctx.drawImage(overlay, 0, 0)
    const blob = await new Promise<Blob | null>(resolve => mask.toBlob(resolve, 'image/png'))
    return blob ? new File([blob], 'mask.png', { type: 'image/png' }) : null
  }

  function choose(next: CanvasTool) {
    const status = availability(next)
    if (!status.available) {
      const message =
        next === 'outpaint'
          ? t('Expand canvas is not connected yet. Use Create with a wider ratio instead.')
          : next === 'erase'
            ? t('Object removal is not connected yet. Paint a mask and use local redraw.')
            : next === 'inpaint' && status.reason === 'needs-inpaint'
              ? t('This model cannot inpaint. Choose a model that supports local redraw.')
              : next === 'inpaint' && status.reason === 'needs-mask'
                ? t('Paint a mask before local redraw.')
              : t('Select an image first')
      setReason(message)
      onUnavailable(message)
      return
    }
    setReason('')
    if (next === 'undo') {
      const ctx = canvasRef.current?.getContext('2d')
      const previousFrame = undoStack.current.pop()
      if (ctx && previousFrame && canvasRef.current) {
        const frame = ctx.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height)
        redoStack.current.push({ frame, data: frame.data, hasMask: paintedRef.current })
        trimCanvasHistory([undoStack.current, redoStack.current])
        ctx.putImageData(previousFrame.frame, 0, 0)
        paintedRef.current = previousFrame.hasMask
        setHasMask(paintedRef.current)
        if (!paintedRef.current) onMaskReadyRef.current(null)
      }
      return
    }
    if (next === 'redo') {
      const ctx = canvasRef.current?.getContext('2d')
      const frame = redoStack.current.pop()
      if (ctx && frame && canvasRef.current) {
        const currentFrame = ctx.getImageData(
          0,
          0,
          canvasRef.current.width,
          canvasRef.current.height
        )
        undoStack.current.push({
          frame: currentFrame,
          data: currentFrame.data,
          hasMask: paintedRef.current,
        })
        trimCanvasHistory([undoStack.current, redoStack.current])
        ctx.putImageData(frame.frame, 0, 0)
        paintedRef.current = frame.hasMask
        setHasMask(frame.hasMask)
        if (!frame.hasMask) onMaskReadyRef.current(null)
      }
      return
    }
    if (next === 'zoom') {
      setZoom(value => Math.min(3, Number((value + 0.25).toFixed(2))))
      return
    }
    if (next === 'fit') {
      setZoom(1)
      return
    }
    if (next === 'inpaint') {
      void exportMask().then(file => {
        if (!file) {
          const message = t('Paint a mask before local redraw.')
          paintedRef.current = false
          setHasMask(false)
          setReason(message)
          onUnavailable(message)
          onMaskReadyRef.current(null)
          return
        }
        onMaskReadyRef.current(file)
        onInpaint(file)
      })
      return
    }
    setTool(next)
  }

  const icons: Partial<Record<CanvasTool, ReactNode>> = {
    select: <MousePointer2 size={14} />,
    move: <Hand size={14} />,
    brush: <Brush size={14} />,
    eraser: <Eraser size={14} />,
    inpaint: <Sparkles size={14} />,
    outpaint: <Expand size={14} />,
    erase: <Trash2 size={14} />,
    undo: <RotateCcw size={14} />,
    redo: <Redo2 size={14} />,
    zoom: <Plus size={14} />,
    fit: <Maximize2 size={14} />,
  }

  return (
    <div data-studio-canvas="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] px-3 py-2">
        {CANVAS_TOOLS.filter(item => item !== 'outpaint' && item !== 'erase').map(item => {
          const status = availability(item)
          const active = tool === item
          return (
            <button
              key={item}
              type="button"
              disabled={busy}
              title={
                status.available
                  ? t(TOOL_LABEL[item])
                  : `${t(TOOL_LABEL[item])} · ${t('Not available yet')}`
              }
              onClick={() => choose(item)}
              className={`inline-flex h-8 items-center gap-1 rounded-[10px] px-2 text-[12px] ${
                !status.available
                  ? 'cursor-not-allowed text-[var(--muted-foreground)]/40'
                  : active
                    ? 'bg-[var(--muted)] font-medium text-[var(--foreground)]'
                    : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]'
              }`}
            >
              {icons[item]}
              <span className="sr-only">{t(TOOL_LABEL[item])}</span>
            </button>
          )
        })}
        <button
          type="button"
          onClick={() => setZoom(value => Math.max(0.4, Number((value - 0.25).toFixed(2))))}
          className="rounded-lg px-2 py-1.5 text-[var(--muted-foreground)]"
          title={t('Zoom out')}
        >
          <Minus size={14} />
        </button>
        {(tool === 'brush' || tool === 'eraser') && (
          <label className="ml-2 flex items-center gap-2 text-[11px] text-[var(--muted-foreground)]">
            {t('Brush size')}
            <input
              type="range"
              min={8}
              max={160}
              value={brushSize}
              onChange={event => setBrushSize(Number(event.target.value))}
            />
          </label>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--muted)]/35 p-4">
        <div
          className="relative mx-auto w-fit origin-center overflow-hidden rounded-[18px] border border-[var(--border)] bg-[var(--card)]"
          style={{ transform: `scale(${zoom})` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imageRef}
            src={sourceUrl}
            alt={t('Image preview')}
            className="block max-h-[58vh] max-w-full select-none"
            onLoad={event => {
              const image = event.currentTarget
              const canvas = canvasRef.current
              if (!canvas) return
              canvas.width = image.naturalWidth
              canvas.height = image.naturalHeight
              undoStack.current = []
              redoStack.current = []
              paintedRef.current = false
              setHasMask(false)
              onMaskReadyRef.current(null)
            }}
          />
          <canvas
            ref={canvasRef}
            className={`absolute inset-0 h-full w-full touch-none ${
              tool === 'move' ? 'cursor-grab' : 'cursor-crosshair'
            }`}
            onPointerDown={event => {
              if (tool !== 'brush' && tool !== 'eraser') return
              remember()
              drawing.current = true
              previous.current = null
              event.currentTarget.setPointerCapture(event.pointerId)
              draw(event)
            }}
            onPointerMove={draw}
            onPointerUp={() => {
              drawing.current = false
              previous.current = null
              if (tool === 'eraser') {
                paintedRef.current = canvasHasPaint()
                setHasMask(paintedRef.current)
                if (!paintedRef.current) onMaskReadyRef.current(null)
              }
              if (shouldExportPaintedMask(paintedRef.current)) {
                void exportMask().then(file => onMaskReadyRef.current(file))
              }
            }}
            onPointerCancel={() => {
              drawing.current = false
              previous.current = null
            }}
          />
        </div>
      </div>
      {hasMask ? (
        <div
          data-studio-context-edit=""
          className="border-t border-[var(--border)] bg-[var(--card)] px-4 py-3 text-xs"
        >
          <p className="font-medium">{t('Describe how to modify')}</p>
          <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
            {t('Describe how to change this area')}
          </p>
        </div>
      ) : null}
      {reason ? (
        <p role="status" className="px-4 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          {reason}
        </p>
      ) : null}
    </div>
  )
}
