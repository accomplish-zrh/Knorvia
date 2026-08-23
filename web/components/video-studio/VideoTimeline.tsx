'use client'

import { Captions, Film, Music2, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type VideoStoryboardDocument,
  type VideoStoryboardShot,
} from '@/lib/video-studio-api'
import {
  TIMELINE_HANDLE_WIDTH,
  blockPixelLeft,
  blockPixelWidth,
  clampPxPerSecond,
  fitPxPerSecond,
  reorderTarget,
  resolveTrimPatch,
  rulerTicks,
  thumbnailSampleSeconds,
  timelineLayout,
  trackOffsetX,
  trimFromDrag,
  type TimelineBlock,
} from '@/lib/video-studio/timeline-logic'
import { formatVideoDuration } from '@/lib/video-studio/studio-logic'

type TrimDragState = {
  kind: 'trim-in' | 'trim-out'
  blockIndex: number
  startClientX: number
  startTrim: number | null
  preview: number | null
}

type BlockDragState = {
  index: number
  startClientX: number
  moved: boolean
  target: number | null
}

/**
 * §F1 storyboard-driven timeline: one horizontal track of thumbnail blocks
 * (width ∝ trimmed duration), transition overlaps shown as bridged right
 * edges, caption/voiceover bands per shot plus a full-length music bed, drag
 * to reorder, edge handles to trim (§E3), a composed-duration ruler and click
 * to open the shot card. The data model stays `shots` — this is a view.
 */
export function VideoTimeline({
  document,
  selectedShotId,
  thumbnailUrl,
  bgmAssetId,
  onSelect,
  onMove,
  onPatch,
}: {
  document: VideoStoryboardDocument
  selectedShotId?: string | null
  thumbnailUrl: (assetId: string, t: number) => string
  bgmAssetId?: string | null
  onSelect: (shot: VideoStoryboardShot) => void
  onMove: (from: number, to: number) => void
  onPatch: (shot: VideoStoryboardShot, patch: Partial<VideoStoryboardShot>) => void
}) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [pxPerSecond, setPxPerSecond] = useState(24)
  const [trimDrag, setTrimDrag] = useState<TrimDragState | null>(null)
  const [blockDrag, setBlockDrag] = useState<BlockDragState | null>(null)
  const layout = timelineLayout(document.shots)
  const total = layout.total
  const ticks = rulerTicks(total, pxPerSecond)
  const contentWidth = Math.max(
    320,
    Math.round(total * pxPerSecond) + TIMELINE_HANDLE_WIDTH * 4
  )

  useLayoutEffect(() => {
    const measure = () => setViewportWidth(scrollRef.current?.clientWidth || 0)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // Re-fit the zoom whenever the cut's total changes (shots added/trimmed).
  useEffect(() => {
    void (async () => {
      if (total > 0 && viewportWidth > 0) {
        setPxPerSecond(fitPxPerSecond(total, viewportWidth))
      }
    })()
  }, [total, viewportWidth])

  const shotByIndex = useCallback(
    (index: number) => document.shots.find(shot => shot.order === index),
    [document.shots]
  )

  const blockTrimPreview = (block: TimelineBlock): { in: number | null; out: number | null } => {
    if (!trimDrag || trimDrag.blockIndex !== block.index) {
      return { in: block.trimIn, out: block.trimOut }
    }
    return trimDrag.kind === 'trim-in'
      ? { in: trimDrag.preview, out: block.trimOut }
      : { in: block.trimIn, out: trimDrag.preview }
  }

  /** Live pointer tracking for both drag kinds. */
  useEffect(() => {
    if (!trimDrag && !blockDrag) return
    const onMovePointer = (event: PointerEvent) => {
      if (trimDrag) {
        const block = layout.blocks.find(item => item.index === trimDrag.blockIndex)
        if (!block) return
        const deltaSeconds = (event.clientX - trimDrag.startClientX) / pxPerSecond
        setTrimDrag(current =>
          current
            ? {
                ...current,
                preview: trimFromDrag(current, deltaSeconds, block.sourceDuration),
              }
            : current
        )
      } else if (blockDrag) {
        const track = scrollRef.current
        if (!track) return
        const seconds =
          trackOffsetX(event.clientX, track.getBoundingClientRect().left, track.scrollLeft) /
          pxPerSecond
        setBlockDrag(current =>
          current
            ? {
                ...current,
                moved:
                  current.moved || Math.abs(event.clientX - current.startClientX) > 6,
                target: reorderTarget(layout.blocks, current.index, seconds),
              }
            : current
        )
      }
    }
    const onUp = () => {
      if (trimDrag) {
        const block = layout.blocks.find(item => item.index === trimDrag.blockIndex)
        const shot = shotByIndex(trimDrag.blockIndex)
        if (block && shot) {
          const patch = resolveTrimPatch(
            trimDrag.kind,
            trimDrag.preview,
            block.trimIn,
            block.trimOut,
            block.sourceDuration
          )
          if (patch) onPatch(shot, patch)
        }
        setTrimDrag(null)
      }
      if (blockDrag) {
        const shot = shotByIndex(blockDrag.index)
        if (blockDrag.moved) {
          if (blockDrag.target != null) {
            onMove(blockDrag.index, blockDrag.target)
          }
        } else if (shot) {
          onSelect(shot)
        }
        setBlockDrag(null)
      }
    }
    window.addEventListener('pointermove', onMovePointer)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMovePointer)
      window.removeEventListener('pointerup', onUp)
    }
  }, [trimDrag, blockDrag, layout.blocks, pxPerSecond, onMove, onPatch, onSelect, shotByIndex])

  /** Keyboard trim: ±0.1s (±1s with Shift) on a focused handle. */
  const nudgeTrim = (block: TimelineBlock, kind: 'trim-in' | 'trim-out', delta: number) => {
    const shot = shotByIndex(block.index)
    if (!shot) return
    const base = kind === 'trim-in' ? block.trimIn : block.trimOut
    const next =
      base == null
        ? kind === 'trim-in'
          ? delta > 0
            ? delta
            : null
          : block.sourceDuration != null && delta < 0
            ? block.sourceDuration + delta
            : null
        : Math.round((base + delta) * 1000) / 1000
    const patch = resolveTrimPatch(kind, next, block.trimIn, block.trimOut, block.sourceDuration)
    if (patch) onPatch(shot, patch)
  }

  return (
    <section
      className="rounded-2xl border border-[var(--border)] bg-[var(--card)]"
      aria-label={t('Timeline')}
    >
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-[11.5px] font-semibold">{t('Timeline')}</h2>
          <span className="text-[9.5px] text-[var(--muted-foreground)]">
            {t('Total')} {formatVideoDuration(total)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={t('Zoom out')}
            onClick={() => setPxPerSecond(current => clampPxPerSecond(current / 1.5))}
            className="rounded-lg border border-[var(--border)] p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/45"
          >
            <ZoomOut size={12} />
          </button>
          <button
            type="button"
            aria-label={t('Zoom in')}
            onClick={() => setPxPerSecond(current => clampPxPerSecond(current * 1.5))}
            className="rounded-lg border border-[var(--border)] p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/45"
          >
            <ZoomIn size={12} />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="overflow-x-auto border-t border-[var(--border)]/55 px-3 py-2.5"
      >
        {layout.blocks.length ? (
          <div className="relative" style={{ width: contentWidth, minWidth: '100%' }}>
            {/* ruler */}
            <div className="relative h-4 select-none" aria-hidden="true">
              {ticks.map(tick => (
                <span
                  key={tick.at}
                  className="absolute top-0 flex h-full flex-col justify-between text-[8px] tabular-nums text-[var(--muted-foreground)]"
                  style={{ left: Math.round(tick.at * pxPerSecond) }}
                >
                  <span className="h-1 w-px bg-[var(--border)]" />
                  {tick.label}
                </span>
              ))}
              <span className="absolute top-0 right-0 h-1 w-px bg-[var(--border)]" />
            </div>

            {/* track */}
            <div className="relative mt-1 h-20">
              {layout.blocks.map(block => {
                const shot = shotByIndex(block.index)
                if (!shot) return null
                const dragging = blockDrag?.index === block.index && blockDrag.moved
                const dropTarget = blockDrag?.target === block.index && blockDrag.moved
                const preview = blockTrimPreview(block)
                const previewDuration = Math.max(
                  0,
                  (preview.out ?? block.sourceDuration ?? 0) - (preview.in ?? 0)
                )
                const width = Math.max(48, Math.round(previewDuration * pxPerSecond))
                const left = blockPixelLeft(block, pxPerSecond)
                const selected = selectedShotId === shot.id
                const thumbnailAsset = shot.output_asset_id || shot.keyframe_asset_id
                return (
                  <div
                    key={block.shotId}
                    className={`group absolute top-0 h-20 overflow-hidden rounded-lg border bg-[var(--muted)]/40 ${
                      selected
                        ? 'border-[var(--primary)] ring-2 ring-[var(--primary)]/15'
                        : 'border-[var(--border)]'
                    } ${dragging ? 'opacity-40' : ''} ${dropTarget ? 'ring-2 ring-sky-400/40' : ''}`}
                    style={{ left, width, zIndex: selected ? 20 : block.index + 1 }}
                    role="button"
                    tabIndex={0}
                    aria-label={t('Shot {{n}} — {{duration}}', {
                      n: block.index + 1,
                      duration: formatVideoDuration(previewDuration || block.duration),
                    })}
                    onPointerDown={event => {
                      if (event.button !== 0) return
                      event.preventDefault()
                      setBlockDrag({ index: block.index, startClientX: event.clientX, moved: false, target: null })
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onSelect(shot)
                      }
                    }}
                  >
                    {thumbnailAsset ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumbnailUrl(thumbnailAsset, thumbnailSampleSeconds(block))}
                        alt=""
                        loading="lazy"
                        draggable={false}
                        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
                      />
                    ) : (
                      <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[var(--muted-foreground)]">
                        <Film size={16} strokeWidth={1.4} />
                      </span>
                    )}
                    <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
                    {block.isPlaceholder ? (
                      <span className="pointer-events-none absolute top-1 left-1 rounded bg-black/60 px-1 py-0.5 text-[8px] text-white">
                        {t('Placeholder')}
                      </span>
                    ) : null}
                    <span className="pointer-events-none absolute bottom-3 left-1.5 right-1.5 flex items-center gap-1 truncate text-[8.5px] text-white/95">
                      <span className="truncate">{shot.title || shot.prompt || t('Untitled shot')}</span>
                    </span>
                    {/* caption / voiceover bands */}
                    <span className="pointer-events-none absolute bottom-1 left-1.5 right-1.5 flex items-center gap-1 text-white/90">
                      {block.hasCaption ? (
                        <Captions size={10} aria-label={t('Captions')} />
                      ) : null}
                      {block.hasVoiceover ? (
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400" aria-label={t('Narration (TTS)')} />
                      ) : null}
                      <span className="ml-auto tabular-nums">
                        {formatVideoDuration(previewDuration || block.duration)}
                      </span>
                    </span>
                    {block.overlap > 0 ? (
                      <span
                        className="pointer-events-none absolute top-0 right-0 h-full w-2 bg-gradient-to-l from-[var(--primary)]/40 to-transparent"
                        title={block.transitionOut}
                      />
                    ) : null}
                    {/* trim handles (§E3) */}
                    <span
                      role="slider"
                      tabIndex={0}
                      aria-label={t('Trim start')}
                      aria-valuenow={preview.in ?? 0}
                      className="absolute inset-y-0 left-0 cursor-ew-resize bg-white/0 transition-colors group-hover:bg-white/20 focus-visible:bg-white/30"
                      style={{ width: TIMELINE_HANDLE_WIDTH }}
                      onPointerDown={event => {
                        if (event.button !== 0) return
                        event.preventDefault()
                        event.stopPropagation()
                        setTrimDrag({
                          kind: 'trim-in',
                          blockIndex: block.index,
                          startClientX: event.clientX,
                          startTrim: block.trimIn,
                          preview: block.trimIn,
                        })
                      }}
                      onKeyDown={event => {
                        if (event.key === 'ArrowLeft') {
                          event.preventDefault()
                          nudgeTrim(block, 'trim-in', event.shiftKey ? -1 : -0.1)
                        } else if (event.key === 'ArrowRight') {
                          event.preventDefault()
                          nudgeTrim(block, 'trim-in', event.shiftKey ? 1 : 0.1)
                        }
                      }}
                    />
                    <span
                      role="slider"
                      tabIndex={0}
                      aria-label={t('Trim end')}
                      aria-valuenow={preview.out ?? block.sourceDuration ?? 0}
                      className="absolute inset-y-0 right-0 cursor-ew-resize bg-white/0 transition-colors group-hover:bg-white/20 focus-visible:bg-white/30"
                      style={{ width: TIMELINE_HANDLE_WIDTH }}
                      onPointerDown={event => {
                        if (event.button !== 0) return
                        event.preventDefault()
                        event.stopPropagation()
                        setTrimDrag({
                          kind: 'trim-out',
                          blockIndex: block.index,
                          startClientX: event.clientX,
                          startTrim: block.trimOut,
                          preview: block.trimOut,
                        })
                      }}
                      onKeyDown={event => {
                        if (event.key === 'ArrowLeft') {
                          event.preventDefault()
                          nudgeTrim(block, 'trim-out', event.shiftKey ? -1 : -0.1)
                        } else if (event.key === 'ArrowRight') {
                          event.preventDefault()
                          nudgeTrim(block, 'trim-out', event.shiftKey ? 1 : 0.1)
                        }
                      }}
                    />
                  </div>
                )
              })}
            </div>

            {/* music bed band */}
            <div
              className={`mt-1 flex h-3 items-center gap-1 rounded ${
                bgmAssetId
                  ? 'bg-violet-500/20 text-violet-500'
                  : 'border border-dashed border-[var(--border)] text-[var(--muted-foreground)]/70'
              }`}
            >
              <Music2 size={9} className="ml-1 shrink-0" />
              <span className="truncate text-[8px]">
                {bgmAssetId ? t('Music bed') : t('No music bed selected')}
              </span>
            </div>
          </div>
        ) : (
          <p className="py-3 text-center text-[10px] text-[var(--muted-foreground)]">
            {t('Generate or bind a clip to see the timeline.')}
          </p>
        )}
      </div>
      <p className="px-3 pb-2 text-[8.5px] text-[var(--muted-foreground)]">
        {t('Drag blocks to reorder, drag edges to trim, click a block to open its shot.')}
      </p>
    </section>
  )
}
