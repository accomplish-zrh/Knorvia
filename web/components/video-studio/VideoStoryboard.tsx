'use client'

import {
  ChevronLeft,
  ChevronRight,
  Dices,
  Film,
  GripVertical,
  History,
  ImagePlus,
  Loader2,
  Mic,
  Plus,
  Scissors,
  Trash2,
} from 'lucide-react'
import { useEffect, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type VideoJob,
  type VideoStoryboardDocument,
  type VideoStoryboardShot,
} from '@/lib/video-studio-api'
import {
  SHOT_TRANSITION_OPTIONS,
  effectiveShotSeconds,
  formatVideoDuration,
  parseTrimInput,
  sortVideoVariantJobs,
  transitionSelectValue,
  trimWindowError,
  variantJobSeedLabel,
} from '@/lib/video-studio/studio-logic'
import { ShotVariantDrawer } from './ShotVariantDrawer'
import { useArmedPaidAction } from './useArmedPaidAction'

/** Lowercase status keys already exist for every terminal/active state. */
function variantStatusLabelKey(status: string): string {
  if (status === 'running' || status === 'submitting') return 'Running'
  if (['queued', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)) return status
  return 'Unknown'
}

/** §E1 i18n label keys for the four xfade transitions. */
const TRANSITION_LABEL_KEYS: Record<string, string> = {
  crossfade: 'Crossfade',
  'fade-black': 'Fade to black',
  'fade-white': 'Fade to white',
  'wipe-left': 'Wipe left',
}

function transitionOptionLabel(option: string, t: (key: string) => string) {
  return t(TRANSITION_LABEL_KEYS[option] || option)
}

function variantStatusTone(status: string): string {
  if (status === 'succeeded') return 'text-emerald-600'
  if (['failed', 'cancelled', 'interrupted'].includes(status)) return 'text-red-400'
  if (status === 'running' || status === 'submitting') return 'text-sky-500'
  return 'text-[var(--muted-foreground)]'
}

function variantTimeLabel(value: string | number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function VideoStoryboard({
  document,
  selectedShotId,
  assetUrl,
  busyShotId,
  variantJobs,
  variantBusyShotId,
  variantLoading,
  onSelect,
  onAdd,
  onDelete,
  onMove,
  onPatch,
  onGenerateKeyframe,
  onGenerateVoiceover,
  onRerollShot,
  onBindVariant,
  priceHints,
}: {
  document: VideoStoryboardDocument
  selectedShotId?: string | null
  assetUrl: (assetId: string) => string
  busyShotId?: string | null
  /** §Phase C5 variant history of the selected shot (server-scoped). */
  variantJobs?: VideoJob[]
  variantBusyShotId?: string | null
  variantLoading?: boolean
  onSelect: (shot: VideoStoryboardShot) => void
  onAdd: () => void
  onDelete: (shot: VideoStoryboardShot) => void
  onMove: (from: number, to: number) => void
  onPatch: (shot: VideoStoryboardShot, patch: Partial<VideoStoryboardShot>) => void
  onGenerateKeyframe: (shot: VideoStoryboardShot, promptOverride: string) => void
  onGenerateVoiceover: (shot: VideoStoryboardShot, text: string, voice: string) => void
  /** §Phase C5: paid reroll of the shot's current take (confirmed upstream). */
  onRerollShot: (shot: VideoStoryboardShot) => void
  /** §Phase C5: free action — make one variant the shot's current output. */
  onBindVariant: (shot: VideoStoryboardShot, job: VideoJob) => void
  /** §F5 per-model ¥/s hints (display-only estimates; missing key = hidden). */
  priceHints?: Record<string, number>
}) {
  const { t } = useTranslation()
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [keyframePrompt, setKeyframePrompt] = useState('')
  const [voiceoverText, setVoiceoverText] = useState('')
  const [voiceoverVoice, setVoiceoverVoice] = useState('')
  const [trimInText, setTrimInText] = useState('')
  const [trimOutText, setTrimOutText] = useState('')
  const [variantDrawerOpen, setVariantDrawerOpen] = useState(false)
  const selected = document.shots.find(shot => shot.id === selectedShotId)
  const selectedIsLast = Boolean(
    selected && document.shots.length && document.shots[document.shots.length - 1].id === selected.id
  )
  const transitionValue = transitionSelectValue(selected?.transition)
  const keyframeGuard = useArmedPaidAction(`kf:${selectedShotId || ''}:${keyframePrompt}`)
  const voiceoverGuard = useArmedPaidAction(`vo:${selectedShotId || ''}:${voiceoverText}:${voiceoverVoice}`)
  const rerollGuard = useArmedPaidAction(`rr:${selectedShotId || ''}:${selected?.job_id || ''}`)
  const busy = Boolean(selected && busyShotId === selected.id)
  const variants = sortVideoVariantJobs(variantJobs || [])
  const rerollBusy = Boolean(selected && variantBusyShotId === selected.id)

  // IIFE keeps the setState calls out of the synchronous effect body to
  // satisfy `react-hooks/set-state-in-effect` (house pattern, see MemoryPicker).
  useEffect(() => {
    void (async () => {
      setKeyframePrompt('')
      setVoiceoverText(selected?.voiceover_text || '')
      setVoiceoverVoice(selected?.voiceover_voice || '')
      setTrimInText(selected?.trim_in == null ? '' : String(selected.trim_in))
      setTrimOutText(selected?.trim_out == null ? '' : String(selected.trim_out))
      // §F2: the drawer describes one shot — switching selection closes it.
      setVariantDrawerOpen(false)
    })()
  }, [
    selectedShotId,
    selected?.voiceover_text,
    selected?.voiceover_voice,
    selected?.trim_in,
    selected?.trim_out,
  ])

  /** §E3: parse one trim box, then only persist a window that passes the
   * shared invariants (0 ≤ in < out ≤ duration). */
  const applyTrim = (field: 'trim_in' | 'trim_out', raw: string) => {
    if (!selected) return
    if (field === 'trim_in') setTrimInText(raw)
    else setTrimOutText(raw)
    if (!raw.trim()) {
      onPatch(selected, { [field]: null })
      return
    }
    const parsed = parseTrimInput(raw)
    if (Number.isNaN(parsed)) return
    const otherRaw = field === 'trim_in' ? trimOutText : trimInText
    const other = parseTrimInput(otherRaw)
    const nextIn = field === 'trim_in' ? parsed : other
    const nextOut = field === 'trim_out' ? parsed : other
    if (trimWindowError(
      Number.isNaN(nextIn) ? null : nextIn,
      Number.isNaN(nextOut) ? null : nextOut,
      selected.duration ?? null
    )) return
    onPatch(selected, { [field]: parsed })
  }

  const dropAt = (event: DragEvent, index: number) => {
    event.preventDefault()
    if (dragIndex != null) onMove(dragIndex, index)
    setDragIndex(null)
  }

  return (
    <section className="relative rounded-2xl border border-[var(--border)] bg-[var(--card)]" aria-label={t('Storyboard')}>
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[11.5px] font-semibold">{t('Storyboard')}</h2>
            <span className="text-[9.5px] text-[var(--muted-foreground)]">
              {t('{{count}} shot(s)', { count: document.shots.length })}
            </span>
          </div>
          <p className="truncate text-[9px] text-[var(--muted-foreground)]">
            {t('Shot planning and ordering; the final cut is composed in the export panel.')}
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] text-[var(--primary)] hover:bg-[var(--muted)]/55"
        >
          <Plus size={12} /> {t('Add shot')}
        </button>
      </div>
      <div className="flex gap-2 overflow-x-auto border-y border-[var(--border)]/55 bg-[var(--muted)]/20 px-3 py-2.5">
        {document.shots.length ? (
          document.shots.map((shot, index) => (
            <article
              key={shot.id}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragEnd={() => setDragIndex(null)}
              onDragOver={event => event.preventDefault()}
              onDrop={event => dropAt(event, index)}
              className={`group relative w-40 shrink-0 overflow-hidden rounded-xl border bg-[var(--background)] ${
                selectedShotId === shot.id ? 'border-[var(--primary)] ring-2 ring-[var(--primary)]/15' : 'border-[var(--border)]'
              } ${dragIndex === index ? 'opacity-50' : ''}`}
            >
              <button
                type="button"
                onClick={() => onSelect(shot)}
                className="block w-full text-left"
                aria-pressed={selectedShotId === shot.id}
              >
                <span className="relative flex aspect-video items-center justify-center bg-[var(--muted)]/40 text-[var(--muted-foreground)]">
                  {shot.keyframe_asset_id ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={assetUrl(shot.keyframe_asset_id)}
                      alt={shot.title || t('Keyframe')}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <Film size={20} strokeWidth={1.4} />
                  )}
                  {shot.voiceover_asset_id ? (
                    <span className="absolute bottom-1 left-1 inline-flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[8.5px] text-white">
                      <Mic size={9} /> {t('Voiced')}
                    </span>
                  ) : null}
                  {shot.keyframe_asset_id ? (
                    <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 py-0.5 text-[8.5px] text-white">
                      {t('Keyframe')}
                    </span>
                  ) : null}
                </span>
                <span className="block px-2 py-1.5">
                  <span className="flex items-center gap-1 text-[9px] text-[var(--muted-foreground)]">
                    <GripVertical size={10} /> {t('Shot {{n}}', { n: index + 1 })}
                    <span className="ml-auto flex items-center gap-1">
                      {shot.trim_in != null || shot.trim_out != null ? (
                        <Scissors size={9} aria-label={t('Trimmed')} />
                      ) : null}
                      {formatVideoDuration(effectiveShotSeconds(shot) ?? shot.duration)}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[10.5px] font-medium">
                    {shot.title || shot.prompt || t('Untitled shot')}
                  </span>
                  {shot.transition && index < document.shots.length - 1 ? (
                    <span className="mt-1 inline-block truncate rounded bg-[var(--muted)] px-1 py-0.5 text-[8.5px] text-[var(--muted-foreground)]">
                      ⤳ {shot.transition}
                    </span>
                  ) : null}
                </span>
              </button>
              <div className="absolute top-1.5 right-1.5 hidden items-center gap-0.5 rounded-lg bg-black/60 p-0.5 text-white backdrop-blur group-hover:flex group-focus-within:flex">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => onMove(index, index - 1)}
                  aria-label={t('Move shot left')}
                  className="rounded p-1 disabled:opacity-30"
                >
                  <ChevronLeft size={11} />
                </button>
                <button
                  type="button"
                  disabled={index === document.shots.length - 1}
                  onClick={() => onMove(index, index + 1)}
                  aria-label={t('Move shot right')}
                  className="rounded p-1 disabled:opacity-30"
                >
                  <ChevronRight size={11} />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(shot)}
                  aria-label={t('Delete shot')}
                  className="rounded p-1 text-red-300"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </article>
          ))
        ) : (
          <button
            type="button"
            onClick={onAdd}
            className="flex h-24 w-full min-w-64 items-center justify-center rounded-xl border border-dashed border-[var(--border)] text-[10.5px] text-[var(--muted-foreground)] hover:border-[var(--primary)] hover:text-[var(--primary)]"
          >
            <Plus size={13} className="mr-1.5" /> {t('Add the first shot')}
          </button>
        )}
      </div>
      {selected ? (
        <div className="flex flex-col gap-2.5 px-3 py-2.5">
          <div className="grid gap-2 md:grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)]">
            <label className="flex flex-col gap-1 text-[9px] text-[var(--muted-foreground)]">
              {t('Shot title')}
              <input
                value={selected.title}
                maxLength={120}
                onChange={event => onPatch(selected, { title: event.target.value })}
                className="h-8 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[10.5px] text-[var(--foreground)] outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-[9px] text-[var(--muted-foreground)]">
              {t('Shot prompt')}
              <input
                value={selected.prompt}
                maxLength={20000}
                onChange={event => onPatch(selected, { prompt: event.target.value })}
                className="h-8 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[10.5px] text-[var(--foreground)] outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-[9px] text-[var(--muted-foreground)]">
              {t('Notes')}
              <input
                value={selected.notes || ''}
                maxLength={2000}
                onChange={event => onPatch(selected, { notes: event.target.value })}
                className="h-8 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[10.5px] text-[var(--foreground)] outline-none"
              />
            </label>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded-xl border border-[var(--border)]/60 bg-[var(--muted)]/15 p-2">
              <div className="flex items-center gap-1.5 text-[9.5px] font-medium">
                <ImagePlus size={11} /> {t('First-frame keyframe')}
                {selected.keyframe_asset_id ? (
                  <span className="rounded bg-emerald-500/10 px-1 py-0.5 text-[8.5px] text-emerald-600">
                    {t('Bound as first-frame input')}
                  </span>
                ) : null}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  value={keyframePrompt}
                  maxLength={20000}
                  placeholder={t('Optional image prompt override')}
                  onChange={event => setKeyframePrompt(event.target.value)}
                  className="h-7 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[10px] text-[var(--foreground)] outline-none"
                />
                <button
                  type="button"
                  disabled={busy}
                  title={t('Paid image generation')}
                  onClick={() => {
                    if (keyframeGuard.armed(selected.id)) {
                      keyframeGuard.disarm()
                      onGenerateKeyframe(selected, keyframePrompt)
                    } else {
                      keyframeGuard.arm(selected.id)
                    }
                  }}
                  className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] font-medium transition-colors ${
                    keyframeGuard.armed(selected.id)
                      ? 'bg-[var(--primary)] text-white'
                      : 'border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--muted)]/45'
                  } disabled:opacity-50`}
                >
                  {busy && busyShotId === selected.id ? <Loader2 size={11} className="animate-spin" /> : null}
                  {keyframeGuard.armed(selected.id)
                    ? t('Confirm — paid')
                    : selected.keyframe_asset_id
                      ? t('Regenerate keyframe')
                      : t('Generate keyframe')}
                </button>
              </div>
              <p className="mt-1 text-[8.5px] leading-relaxed text-[var(--muted-foreground)]">
                {t('Uses the shot prompt (or the override above) through the image model; the result becomes this shot\u2019s first-frame input.')}
              </p>
            </div>
            <div className="rounded-xl border border-[var(--border)]/60 bg-[var(--muted)]/15 p-2">
              <div className="flex items-center gap-1.5 text-[9.5px] font-medium">
                <Mic size={11} /> {t('Narration (TTS)')}
                {selected.voiceover_asset_id ? (
                  <span className="rounded bg-emerald-500/10 px-1 py-0.5 text-[8.5px] text-emerald-600">
                    {t('Bound')}
                  </span>
                ) : null}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  value={voiceoverText}
                  maxLength={20000}
                  placeholder={t('Narration text for this shot')}
                  onChange={event => setVoiceoverText(event.target.value)}
                  className="h-7 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[10px] text-[var(--foreground)] outline-none"
                />
                <input
                  value={voiceoverVoice}
                  maxLength={160}
                  placeholder={t('Voice')}
                  onChange={event => setVoiceoverVoice(event.target.value)}
                  className="h-7 w-24 shrink-0 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[10px] text-[var(--foreground)] outline-none"
                />
                <button
                  type="button"
                  disabled={busy || !voiceoverText.trim()}
                  title={t('Paid voice synthesis')}
                  onClick={() => {
                    if (voiceoverGuard.armed(selected.id)) {
                      voiceoverGuard.disarm()
                      onGenerateVoiceover(selected, voiceoverText.trim(), voiceoverVoice.trim())
                    } else {
                      voiceoverGuard.arm(selected.id)
                    }
                  }}
                  className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] font-medium transition-colors ${
                    voiceoverGuard.armed(selected.id)
                      ? 'bg-[var(--primary)] text-white'
                      : 'border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--muted)]/45'
                  } disabled:opacity-50`}
                >
                  {busy && busyShotId === selected.id ? <Loader2 size={11} className="animate-spin" /> : null}
                  {voiceoverGuard.armed(selected.id)
                    ? t('Confirm — paid')
                    : selected.voiceover_asset_id
                      ? t('Regenerate narration')
                      : t('Generate narration')}
                </button>
              </div>
              {selected.voiceover_asset_id ? (
                <audio
                  key={selected.voiceover_asset_id}
                  controls
                  preload="none"
                  src={assetUrl(selected.voiceover_asset_id)}
                  className="mt-1.5 h-8 w-full"
                />
              ) : (
                <p className="mt-1 text-[8.5px] leading-relaxed text-[var(--muted-foreground)]">
                  {t('Synthesizes this text through the shared TTS pipeline; compositions align it to this shot automatically.')}
                </p>
              )}
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            <div className="rounded-xl border border-[var(--border)]/60 bg-[var(--muted)]/15 p-2">
              <div className="flex items-center gap-1.5 text-[9.5px] font-medium">
                <Scissors size={11} /> {t('Transition into next shot')}
              </div>
              <select
                value={transitionValue}
                disabled={selectedIsLast}
                onChange={event => {
                  const value = event.target.value
                  if (value === '__custom') return
                  onPatch(selected, { transition: value })
                }}
                className="mt-1.5 h-7 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-1.5 text-[10px] text-[var(--foreground)] outline-none disabled:opacity-50"
              >
                <option value="">{t('Hard cut')}</option>
                {SHOT_TRANSITION_OPTIONS.map(option => (
                  <option key={option} value={option}>
                    {transitionOptionLabel(option, t)}
                  </option>
                ))}
                {transitionValue === '__custom' ? (
                  <option value="__custom">
                    {t('Custom — {{label}} (kept)', { label: selected.transition || '' })}
                  </option>
                ) : null}
              </select>
              <p className="mt-1 text-[8.5px] leading-relaxed text-[var(--muted-foreground)]">
                {selectedIsLast
                  ? t('The last shot ends the cut — no transition needed.')
                  : t('Transitions cross 0.5s of overlap with the next shot at compose time.')}
              </p>
            </div>
            <div className="rounded-xl border border-[var(--border)]/60 bg-[var(--muted)]/15 p-2">
              <div className="flex items-center gap-1.5 text-[9.5px] font-medium">
                <Scissors size={11} /> {t('Trim (seconds)')}
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                <label className="flex flex-col gap-0.5 text-[8.5px] text-[var(--muted-foreground)]">
                  {t('In')}
                  <input
                    value={trimInText}
                    placeholder="0"
                    inputMode="decimal"
                    disabled={selected.duration == null}
                    onChange={event => applyTrim('trim_in', event.target.value)}
                    className="h-7 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[10px] text-[var(--foreground)] outline-none disabled:opacity-50"
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-[8.5px] text-[var(--muted-foreground)]">
                  {t('Out')}
                  <input
                    value={trimOutText}
                    placeholder={selected.duration == null ? '—' : String(selected.duration)}
                    inputMode="decimal"
                    disabled={selected.duration == null}
                    onChange={event => applyTrim('trim_out', event.target.value)}
                    className="h-7 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[10px] text-[var(--foreground)] outline-none disabled:opacity-50"
                  />
                </label>
              </div>
              <p className="mt-1 text-[8.5px] leading-relaxed text-[var(--muted-foreground)]">
                {(() => {
                  const parseIn = parseTrimInput(trimInText)
                  const parseOut = parseTrimInput(trimOutText)
                  if (Number.isNaN(parseIn) || Number.isNaN(parseOut)) {
                    return t('Trim values must be seconds between 0 and 3600.')
                  }
                  const error = trimWindowError(
                    parseIn,
                    parseOut,
                    selected.duration ?? null
                  )
                  if (error) return t(error)
                  if (selected.duration != null) {
                    return t('Source {{total}}s → keeps {{kept}}s in the cut', {
                      total: selected.duration,
                      kept: effectiveShotSeconds({
                        duration: selected.duration,
                        trim_in: parseIn,
                        trim_out: parseOut,
                      }),
                    })
                  }
                  return t('Available once the shot has a generated clip.')
                })()}
              </p>
            </div>
            <div className="rounded-xl border border-[var(--border)]/60 bg-[var(--muted)]/15 p-2">
              <div className="flex items-center gap-1.5 text-[9.5px] font-medium">
                <Mic size={11} /> {t('Voiceover volume')}
                {selected.voiceover_volume != null ? (
                  <button
                    type="button"
                    onClick={() => onPatch(selected, { voiceover_volume: null })}
                    className="ml-auto rounded border border-[var(--border)] px-1.5 py-0.5 text-[8.5px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]/45"
                  >
                    {t('Reset')}
                  </button>
                ) : null}
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={selected.voiceover_volume ?? 1}
                  onChange={event => onPatch(selected, { voiceover_volume: Number(event.target.value) })}
                  className="h-1.5 flex-1 accent-[var(--primary)]"
                  aria-label={t('Voiceover volume')}
                />
                <span className="w-14 shrink-0 text-right text-[9.5px] tabular-nums text-[var(--muted-foreground)]">
                  {(selected.voiceover_volume ?? 1).toFixed(2)}×
                </span>
              </div>
              <p className="mt-1 text-[8.5px] leading-relaxed text-[var(--muted-foreground)]">
                {selected.voiceover_volume == null
                  ? t('Default 1.0× — applied to this shot\u2019s narration in compositions.')
                  : t('Applied to this shot\u2019s narration in compositions.')}
              </p>
            </div>
          </div>
          <div className="rounded-xl border border-[var(--border)]/60 bg-[var(--muted)]/15 p-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1.5 text-[9.5px] font-medium">
                <History size={11} /> {t('Variant history')}
              </span>
              <span className="rounded bg-[var(--muted)] px-1 py-0.5 text-[8.5px] text-[var(--muted-foreground)]">
                {t('{{count}} version(s)', { count: variants.length })}
              </span>
              <button
                type="button"
                data-variant-details=""
                onClick={() => setVariantDrawerOpen(true)}
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-[var(--border)] px-2 text-[9.5px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]/45 hover:text-[var(--foreground)]"
              >
                <History size={10} /> {t('Version details')}
              </button>
              <button
                type="button"
                disabled={!selected.job_id || rerollBusy}
                title={t('Same prompt and parameters (camera included) with a fresh seed — one paid task.')}
                onClick={() => {
                  if (rerollGuard.armed(selected.id)) {
                    rerollGuard.disarm()
                    onRerollShot(selected)
                  } else {
                    rerollGuard.arm(selected.id)
                  }
                }}
                className={`ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] font-medium transition-colors ${
                  rerollGuard.armed(selected.id)
                    ? 'bg-[var(--primary)] text-white'
                    : 'border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--muted)]/45'
                } disabled:opacity-50`}
              >
                {rerollBusy ? <Loader2 size={11} className="animate-spin" /> : <Dices size={11} />}
                {rerollGuard.armed(selected.id) ? t('Confirm — paid') : t('Generate another version')}
              </button>
            </div>
            {variants.length ? (
              <ul className="mt-1.5 flex max-h-44 flex-col gap-1 overflow-y-auto pr-0.5">
                {variants.map(job => {
                  const current = selected.job_id === job.id
                  const outputId = job.output_asset_ids[0]
                  return (
                    <li
                      key={job.id}
                      className={`flex items-center gap-2 rounded-lg border px-1.5 py-1 ${
                        current
                          ? 'border-[var(--primary)]/60 bg-[var(--primary)]/[0.07]'
                          : 'border-[var(--border)]/60 bg-[var(--background)]'
                      }`}
                    >
                      <span className="h-9 w-16 shrink-0 overflow-hidden rounded bg-black/85">
                        {outputId ? (
                          <video
                            src={assetUrl(outputId)}
                            muted
                            playsInline
                            preload="metadata"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center text-[var(--muted-foreground)]">
                            <Film size={13} strokeWidth={1.4} />
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`text-[9.5px] font-medium ${variantStatusTone(job.status)}`}>
                          {t(variantStatusLabelKey(job.status))}
                        </span>
                        <span className="mt-0.5 block truncate text-[8.5px] text-[var(--muted-foreground)]">
                          {variantTimeLabel(job.created_at)} · {t('Seed')} {variantJobSeedLabel(job)}
                        </span>
                      </span>
                      {current ? (
                        <span className="shrink-0 rounded bg-[var(--primary)]/10 px-1.5 py-0.5 text-[8.5px] text-[var(--primary)]">
                          {t('Current')}
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={variantBusyShotId === selected.id}
                          onClick={() => onBindVariant(selected, job)}
                          className="shrink-0 rounded-lg border border-[var(--border)] px-1.5 py-0.5 text-[8.5px] hover:bg-[var(--muted)]/45 disabled:opacity-50"
                        >
                          {t('Set as current')}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="mt-1.5 text-[8.5px] leading-relaxed text-[var(--muted-foreground)]">
                {variantLoading
                  ? t('Loading variant history…')
                  : t('No versions yet — generate this shot first.')}
              </p>
            )}
            <p className="mt-1 text-[8.5px] leading-relaxed text-[var(--muted-foreground)]">
              {t('Each reroll is one paid task and is confirmed separately; switching versions is free.')}
            </p>
          </div>

          <ShotVariantDrawer
            open={variantDrawerOpen}
            shot={selected}
            jobs={variantJobs || []}
            currentJobId={selected.job_id}
            assetUrl={assetUrl}
            priceHints={priceHints || {}}
            busy={rerollBusy}
            loading={variantLoading}
            onClose={() => setVariantDrawerOpen(false)}
            onBind={(shot, job) => onBindVariant(shot, job)}
          />
        </div>
      ) : null}
    </section>
  )
}
