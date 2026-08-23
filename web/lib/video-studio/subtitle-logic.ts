/**
 * Phase D2 subtitle editor pure logic — SRT parse/serialize/edit helpers.
 *
 * Mirrors the backend `knorvia/services/video_studio/subtitles.py` contract so
 * a document saved here round-trips through the composition burner unchanged:
 * tolerant parsing (BOM, blank lines, `,`/`.` millis separators, missing
 * indexes), deterministic serialization, cue table edits (add/remove/split),
 * and the four burn-in style presets accepted by `compose.subtitle.style`.
 */

export type SubtitleCue = {
  index: number
  start: number
  end: number
  text: string
}

/** Stable preset keys → `compose` request `subtitle.style` values. */
export const SUBTITLE_STYLE_OPTIONS = ['clean', 'yellow_box', 'outline_large', 'high_contrast'] as const
export type SubtitleStyleKey = (typeof SUBTITLE_STYLE_OPTIONS)[number]

export type SubtitleSourceMode = 'off' | 'from_notes' | 'from_asr' | 'from_asset'

export const SUBTITLE_SOURCE_MODES: readonly SubtitleSourceMode[] = [
  'off',
  'from_notes',
  'from_asr',
  'from_asset',
]

/** §E2 burn-in font size bounds (post_production.SUBTITLE_FONT_SIZE_RANGE). */
export const SUBTITLE_FONT_SIZE_MIN = 12
export const SUBTITLE_FONT_SIZE_MAX = 72

const ASS_COLOUR_PATTERN = /^&H[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/
const HTML_COLOUR_PATTERN = /^#([0-9A-Fa-f]{6})$/

/** §E2 `#RRGGBB` picker value → ASS `&HAABBGGRR` (opaque alpha 00). */
export function hexToAssColour(raw: string): string | null {
  const match = HTML_COLOUR_PATTERN.exec(String(raw || '').trim())
  if (!match) return null
  const [rr, gg, bb] = [match[1].slice(0, 2), match[1].slice(2, 4), match[1].slice(4, 6)]
  return `&H00${bb.toUpperCase()}${gg.toUpperCase()}${rr.toUpperCase()}`
}

/** §E2 ASS `&H[AABB]GGRR` → `#RRGGBB` for the colour input; null when invalid. */
export function assColourToHex(raw: string): string | null {
  const text = String(raw || '').trim()
  if (!ASS_COLOUR_PATTERN.test(text)) return null
  const digits = text.slice(2)
  const bgr = digits.length === 8 ? digits.slice(2) : digits
  const [bb, gg, rr] = [bgr.slice(0, 2), bgr.slice(2, 4), bgr.slice(4, 6)]
  return `#${rr}${gg}${bb}`.toLowerCase()
}

/** §E2 clamp a typed font size into the accepted 12–72 window. */
export function clampSubtitleFontSize(raw: number | string): number | null {
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(value)) return null
  const rounded = Math.round(value)
  if (rounded < SUBTITLE_FONT_SIZE_MIN || rounded > SUBTITLE_FONT_SIZE_MAX) return null
  return rounded
}

const TIMECODE_PATTERN = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/
const SENTENCE_BOUNDARY = /(?<=[。！？!?])|(?<=[.；;])(?=\s|$)/g

/** Seconds → `HH:MM:SS,mmm` (the SRT wire format; millis kept, never re-rounded to seconds). */
export function formatTimecode(totalSeconds: number): string {
  const totalMs = Math.max(0, Math.round((Number.isFinite(totalSeconds) ? totalSeconds : 0) * 1000))
  const hours = Math.floor(totalMs / 3_600_000)
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000)
  const seconds = Math.floor((totalMs % 60_000) / 1000)
  const millis = totalMs % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

/** `HH:MM:SS,mmm` (or `.` millis) → seconds; `null` when unparsable. */
export function parseTimecode(text: string): number | null {
  const match = TIMECODE_PATTERN.exec(String(text ?? '').trim())
  if (!match) return null
  const [, hours, minutes, seconds, millis] = match
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(millis.padEnd(3, '0')) / 1000
  )
}

/** Parse an SRT document into cues; unparseable blocks are skipped, never thrown. */
export function parseSrt(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const blocks = String(content ?? '')
    .replace(/^\ufeff/, '')
    .trim()
    .split(/\r?\n\r?\n/)
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter(line => line.trim())
    if (lines.length < 2) continue
    let rest = lines
    const maybeIndex = Number.parseInt(rest[0].trim(), 10)
    let index = cues.length + 1
    if (Number.isInteger(maybeIndex) && String(maybeIndex) === rest[0].trim()) {
      index = maybeIndex
      rest = rest.slice(1)
    }
    const timing = /^(\S+)\s*-->\s*(\S+)/.exec(rest[0]?.trim() ?? '')
    if (!timing) continue
    const start = parseTimecode(timing[1])
    const end = parseTimecode(timing[2])
    if (start === null || end === null || end <= start) continue
    const text = rest
      .slice(1)
      .map(line => line.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    cues.push({ index, start, end, text })
  }
  return cues
}

/** Cues → a canonical SRT document (renumbered 1..n, one text line each). */
export function serializeSrt(cues: readonly SubtitleCue[]): string {
  const blocks: string[] = []
  let position = 0
  for (const cue of cues) {
    const text = cue.text.replace(/\s+/g, ' ').trim()
    if (!text || !(cue.end > cue.start)) continue
    position += 1
    blocks.push(`${position}\n${formatTimecode(cue.start)} --> ${formatTimecode(cue.end)}\n${text}`)
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : ''
}

export function renumberCues(cues: readonly SubtitleCue[]): SubtitleCue[] {
  return cues.map((cue, position) => ({ ...cue, index: position + 1 }))
}

export function cueDuration(cue: Pick<SubtitleCue, 'start' | 'end'>): number {
  return Math.max(0, cue.end - cue.start)
}

/** Localized-agnostic cue problem for inline row errors; `null` = healthy. */
export function cueIssue(cue: Pick<SubtitleCue, 'start' | 'end' | 'text'>): 'text' | 'timing' | null {
  if (!cue.text.trim()) return 'text'
  if (!(cue.start >= 0) || !(cue.end > cue.start)) return 'timing'
  return null
}

export function cuesHaveIssues(cues: readonly SubtitleCue[]): boolean {
  return cues.some(cue => cueIssue(cue) !== null)
}

function clampSeconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.round(value * 1000) / 1000
}

/** Move every cue by `deltaSeconds` (clamped at zero) — global fine-tuning. */
export function shiftCues(cues: readonly SubtitleCue[], deltaSeconds: number): SubtitleCue[] {
  const delta = Number(deltaSeconds) || 0
  return cues.map(cue => ({
    ...cue,
    start: clampSeconds(cue.start + delta),
    end: clampSeconds(cue.end + delta),
  }))
}

/** Nudge one bound of one cue by `deltaSeconds`, keeping end > start. */
export function adjustCueBound(
  cues: readonly SubtitleCue[],
  index: number,
  field: 'start' | 'end',
  deltaSeconds: number
): SubtitleCue[] {
  return cues.map((cue, position) => {
    if (position !== index) return cue
    const next = clampSeconds(cue[field] + (Number(deltaSeconds) || 0))
    if (field === 'start') {
      return { ...cue, start: Math.min(next, cue.end - 0.001) }
    }
    return { ...cue, end: Math.max(next, cue.start + 0.001) }
  })
}

/**
 * 自动断句微调: split one cue's text into two cues at the sentence boundary
 * closest to its midpoint; the time span is divided by text weight. Falls back
 * to comma/space boundaries, then a hard midpoint for unbroken CJK runs.
 */
export function splitCue(cues: readonly SubtitleCue[], index: number): SubtitleCue[] {
  const target = cues[index]
  if (!target) return [...cues]
  const text = target.text.trim()
  const cut = splitPoint(text)
  if (cut === null) return [...cues]
  const head = text.slice(0, cut).trim()
  const tail = text.slice(cut).trim()
  if (!head || !tail) return [...cues]
  const duration = cueDuration(target)
  const weight = head.length / (head.length + tail.length)
  const splitAt = target.start + duration * weight
  const first: SubtitleCue = { ...target, end: clampSeconds(splitAt), text: head }
  const second: SubtitleCue = { ...target, start: clampSeconds(splitAt), text: tail }
  return renumberCues([...cues.slice(0, index), first, second, ...cues.slice(index + 1)])
}

function splitPoint(text: string): number | null {
  if (text.length < 2) return null
  const middle = text.length / 2
  // Zero-width lookbehind matches sit *after* the boundary character, so the
  // match index itself is the slice offset that keeps the punctuation on the
  // head side. Sentence boundaries win outright (sentences stay intact, per
  // the backend `split_caption_lines` philosophy); soft boundaries and a hard
  // midpoint are only fallbacks for unbroken runs.
  const collect = (pattern: RegExp) => {
    const offsets: number[] = []
    for (const match of text.matchAll(pattern)) {
      if (match.index !== undefined) offsets.push(match.index)
    }
    return offsets.filter(offset => offset > 0 && offset < text.length)
  }
  const closest = (offsets: number[]) =>
    offsets.reduce((best, offset) => (Math.abs(offset - middle) < Math.abs(best - middle) ? offset : best))
  const sentences = collect(SENTENCE_BOUNDARY)
  if (sentences.length) return closest(sentences)
  const soft = collect(/(?<=[，,、])|(?<= )/g)
  if (soft.length) return closest(soft)
  return Math.floor(middle) || null
}

/** Insert an empty-ish cue after `index` (or at the end), 1 s long. */
export function addCueAfter(cues: readonly SubtitleCue[], index: number): SubtitleCue[] {
  const inRange = index >= 0 && index < cues.length
  const anchor = inRange ? cues[index] : undefined
  const start = anchor ? anchor.end : (cues[cues.length - 1]?.end ?? 0)
  const cue: SubtitleCue = { index: 0, start: clampSeconds(start), end: clampSeconds(start + 1), text: '' }
  const position = inRange ? index + 1 : cues.length
  return renumberCues([...cues.slice(0, position), cue, ...cues.slice(position)])
}

export function removeCue(cues: readonly SubtitleCue[], index: number): SubtitleCue[] {
  if (index < 0 || index >= cues.length) return [...cues]
  return renumberCues([...cues.slice(0, index), ...cues.slice(index + 1)])
}

/** A fresh document seed: one placeholder cue so the file stays burnable. */
export function draftCues(): SubtitleCue[] {
  return [{ index: 1, start: 0, end: 1, text: '' }]
}

/** Normalize edited raw rows (time strings already parsed) into saveable cues. */
export function sanitizeCues(cues: readonly SubtitleCue[]): SubtitleCue[] {
  return renumberCues(
    cues
      .filter(cue => cueIssue(cue) === null)
      .slice()
      .sort((a, b) => a.start - b.start || a.end - b.end)
  )
}
