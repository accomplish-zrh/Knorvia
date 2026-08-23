/**
 * Video Studio timeline math — pure functions, no React.
 *
 * Mirrors the backend composition timeline (`post_production.py`:
 * `overlap_for_transition` / `composed_timeline`) so the storyboard-driven
 * track shows exactly what compose produces: block starts accumulate
 * `duration − overlap`, transitions eat 0.5s when both neighbours outlive the
 * crossfade window, and keyframe-only placeholder shots contribute the same
 * clamped `shot.duration || 5s` window the engine uses.
 */

import type { VideoStoryboardShot } from '@/lib/video-studio-api'

/** §E1 crossfade window shared with post_production.XFADE_DURATION. */
export const TIMELINE_XFADE_SECONDS = 0.5
/** Placeholder shots without a video clip (post_production defaults). */
export const TIMELINE_PLACEHOLDER_SECONDS = 5
export const TIMELINE_PLACEHOLDER_MIN = 0.5
export const TIMELINE_PLACEHOLDER_MAX = 30
/** Drag handles and minimum block footprint in pixels. */
export const TIMELINE_HANDLE_WIDTH = 8
export const TIMELINE_MIN_BLOCK_WIDTH = 48
/** A trimmed shot always keeps at least this much footage. */
export const TIMELINE_MIN_TRIM_WINDOW = 0.2

const XFADE_TRANSITIONS = new Set(['crossfade', 'fade-black', 'fade-white', 'wipe-left'])

export type TimelineBlock = {
  shotId: string
  index: number
  /** Timeline start in seconds (after transition overlaps). */
  start: number
  /** Trimmed duration in seconds. */
  duration: number
  /** Untrimmed source duration in seconds (null = no clip). */
  sourceDuration: number | null
  /** Overlap with the next block in seconds. */
  overlap: number
  /** Transition out of this shot ('' = hard cut, free text = custom). */
  transitionOut: string
  trimIn: number | null
  trimOut: number | null
  hasVoiceover: boolean
  hasCaption: boolean
  isPlaceholder: boolean
}

export type TimelineLayout = {
  blocks: TimelineBlock[]
  total: number
}

/** Mirror of post_production.overlap_for_transition. */
export function overlapForTransition(
  transition: string | null | undefined,
  leftDuration: number,
  rightDuration: number
): number {
  const kind = (transition || '').trim().toLowerCase()
  if (!XFADE_TRANSITIONS.has(kind)) return 0
  if (leftDuration <= TIMELINE_XFADE_SECONDS || rightDuration <= TIMELINE_XFADE_SECONDS) return 0
  return TIMELINE_XFADE_SECONDS
}

/** Source seconds this shot contributes before trimming (null = nothing yet). */
export function shotSourceDuration(shot: {
  duration?: number | null
  output_asset_id?: string | null
  keyframe_asset_id?: string | null
}): number | null {
  const requested = shot.duration != null && shot.duration > 0 ? shot.duration : null
  if (shot.output_asset_id) return requested
  if (shot.keyframe_asset_id) {
    return Math.min(
      TIMELINE_PLACEHOLDER_MAX,
      Math.max(TIMELINE_PLACEHOLDER_MIN, requested ?? TIMELINE_PLACEHOLDER_SECONDS)
    )
  }
  return null
}

/** Trimmed window [in, out] clamped to the source (effective_trim parity). */
export function shotTrimWindow(
  sourceDuration: number | null,
  trimIn: number | null,
  trimOut: number | null
): [number, number] | null {
  if (sourceDuration == null || sourceDuration <= 0) return null
  const start = Math.max(0, trimIn ?? 0)
  const end = Math.min(sourceDuration, trimOut ?? sourceDuration)
  if (end <= start) return [start, sourceDuration]
  return [start, end]
}

/** Storyboard shots → composed blocks with transition-aware starts. */
export function timelineLayout(shots: VideoStoryboardShot[]): TimelineLayout {
  const composable = shots.filter(shot => shot.output_asset_id || shot.keyframe_asset_id)
  const durations: number[] = []
  const staged = composable.map((shot, index) => {
    const sourceDuration = shotSourceDuration(shot)
    const window = shotTrimWindow(sourceDuration, shot.trim_in ?? null, shot.trim_out ?? null)
    const duration = window ? window[1] - window[0] : 0
    durations.push(duration)
    return {
      shot,
      index,
      sourceDuration,
      duration,
      trimIn: shot.trim_in ?? null,
      trimOut: shot.trim_out ?? null,
    }
  })

  const blocks: TimelineBlock[] = []
  let cursor = 0
  staged.forEach((item, position) => {
    const next = staged[position + 1]
    const overlap = next
      ? overlapForTransition(item.shot.transition, item.duration, next.duration)
      : 0
    blocks.push({
      shotId: item.shot.id,
      index: item.index,
      start: cursor,
      duration: item.duration,
      sourceDuration: item.sourceDuration,
      overlap,
      transitionOut: (item.shot.transition || '').trim(),
      trimIn: item.trimIn,
      trimOut: item.trimOut,
      hasVoiceover: Boolean(item.shot.voiceover_asset_id),
      hasCaption: Boolean(
        (item.shot.voiceover_text || '').trim() || (item.shot.notes || '').trim()
      ),
      isPlaceholder: !item.shot.output_asset_id,
    })
    cursor += item.duration - overlap
  })
  return { blocks, total: cursor }
}

// ── scale / geometry ─────────────────────────────────────────────────

export const TIMELINE_MIN_PX_PER_SECOND = 6
export const TIMELINE_MAX_PX_PER_SECOND = 160
export const TIMELINE_FIT_PADDING = 24

export function clampPxPerSecond(value: number): number {
  if (!Number.isFinite(value)) return TIMELINE_MIN_PX_PER_SECOND
  return Math.min(
    TIMELINE_MAX_PX_PER_SECOND,
    Math.max(TIMELINE_MIN_PX_PER_SECOND, Math.round(value * 10) / 10)
  )
}

/** px/s that fits the whole cut into the viewport width. */
export function fitPxPerSecond(totalSeconds: number, viewportWidth: number): number {
  if (totalSeconds <= 0 || viewportWidth <= TIMELINE_FIT_PADDING * 2) return TIMELINE_MIN_PX_PER_SECOND
  return clampPxPerSecond((viewportWidth - TIMELINE_FIT_PADDING * 2) / totalSeconds)
}

export function blockPixelWidth(block: TimelineBlock, pxPerSecond: number): number {
  return Math.max(TIMELINE_MIN_BLOCK_WIDTH, Math.round(block.duration * pxPerSecond))
}

export function blockPixelLeft(block: TimelineBlock, pxPerSecond: number): number {
  return Math.round(block.start * pxPerSecond)
}

/** Block-local x → seconds into the source clip (for thumbnail sampling). */
export function thumbnailSampleSeconds(block: TimelineBlock): number {
  const base = block.trimIn ?? 0
  return Math.max(0, base + block.duration / 2)
}

// ── ruler ────────────────────────────────────────────────────────────

const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

export type RulerTick = { at: number; label: string }

function formatRulerLabel(seconds: number): string {
  const value = Math.round(seconds * 10) / 10
  if (value < 60) return `${value}s`
  const minutes = Math.floor(value / 60)
  const rest = Math.round(value % 60)
  return rest ? `${minutes}:${String(rest).padStart(2, '0')}` : `${minutes}:00`
}

/** Nice tick marks spaced ≥48px apart for the current zoom. */
export function rulerTicks(totalSeconds: number, pxPerSecond: number): RulerTick[] {
  if (totalSeconds <= 0) return []
  const step =
    RULER_STEPS.find(candidate => candidate * pxPerSecond >= 48) ??
    RULER_STEPS[RULER_STEPS.length - 1]
  const ticks: RulerTick[] = []
  for (let at = 0; at <= totalSeconds + 1e-9; at += step) {
    ticks.push({ at: Math.round(at * 10) / 10, label: formatRulerLabel(at) })
  }
  return ticks
}

// ── trim drag (§E3 edge handles) ─────────────────────────────────────

export type TrimDrag = {
  kind: 'trim-in' | 'trim-out'
  blockIndex: number
  startClientX: number
  startTrim: number | null
}

/** Next trim value for a drag delta, honouring invariants + min window. */
export function trimFromDrag(
  drag: TrimDrag,
  deltaSeconds: number,
  sourceDuration: number | null
): number | null {
  const cap = sourceDuration ?? 3600
  const base = drag.startTrim ?? (drag.kind === 'trim-in' ? 0 : cap)
  const raw = base + deltaSeconds
  const clamped = Math.max(0, Math.min(cap, Math.round(raw * 1000) / 1000))
  return clamped
}

/** Final (in, out) pair after one handle drag, or null when unchanged. */
export function resolveTrimPatch(
  kind: 'trim-in' | 'trim-out',
  nextValue: number | null,
  trimIn: number | null,
  trimOut: number | null,
  sourceDuration: number | null
): { trim_in?: number | null; trim_out?: number | null } | null {
  const cap = sourceDuration ?? 3600
  let inValue = trimIn
  let outValue = trimOut
  if (kind === 'trim-in') {
    const ceiling = Math.min(cap, (trimOut ?? cap) - TIMELINE_MIN_TRIM_WINDOW)
    inValue = Math.min(nextValue ?? 0, Math.max(0, ceiling))
  } else {
    const floor = Math.max(0, (trimIn ?? 0) + TIMELINE_MIN_TRIM_WINDOW)
    outValue = Math.max(nextValue ?? cap, Math.min(cap, floor))
  }
  if (inValue === trimIn && outValue === trimOut) return null
  const patch: { trim_in?: number | null; trim_out?: number | null } = {}
  // null-out when the value equals the natural bound, so untouched ends stay unset.
  patch.trim_in = inValue && inValue > 0 ? inValue : null
  patch.trim_out = outValue != null && outValue < cap ? outValue : null
  return patch
}

// ── reorder (drag blocks) ────────────────────────────────────────────

/** Insertion index for a pointer at `seconds` on the composed timeline. */
export function reorderTarget(
  blocks: TimelineBlock[],
  dragIndex: number,
  pointerSeconds: number
): number | null {
  if (dragIndex < 0 || dragIndex >= blocks.length) return null
  let target = 0
  for (const block of blocks) {
    const center = block.start + block.duration / 2
    if (pointerSeconds > center) target = block.index + 1
  }
  if (target > dragIndex) target -= 1
  if (target === dragIndex) return null
  return Math.max(0, Math.min(blocks.length - 1, target))
}

/** x offset (px) of the pointer relative to the track, from a pointer event. */
export function trackOffsetX(clientX: number, trackLeft: number, scrollLeft: number): number {
  return clientX - trackLeft + scrollLeft
}
