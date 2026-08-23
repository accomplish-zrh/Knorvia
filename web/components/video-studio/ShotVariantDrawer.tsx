'use client'

import { Clock3, Coins, Film, History, Loader2, X } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { type VideoJob, type VideoStoryboardShot } from '@/lib/video-studio-api'
import {
  estimateVideoCostYuan,
  formatVideoDuration,
  formatYuan,
  jobBilledSeconds,
  sortVideoVariantJobs,
  variantJobSeedLabel,
  variantParameterDiff,
  variantRenderSeconds,
  videoModelKey,
} from '@/lib/video-studio/studio-logic'

/** §F2 friendly labels for the diff keys that actually appear in parameters. */
const DIFF_KEY_LABELS: Record<string, string> = {
  duration: 'Duration',
  resolution: 'Resolution',
  fps: 'FPS',
  aspect_ratio: 'Aspect ratio',
  seed: 'Seed',
  audio_mode: 'Audio',
  camera_motion: 'Camera movement',
  camera_control: 'Camera control',
}

function diffKeyLabel(key: string): string {
  return DIFF_KEY_LABELS[key] || key
}

function statusLabelKey(status: string): string {
  if (status === 'succeeded') return 'succeeded'
  if (status === 'failed') return 'failed'
  if (status === 'running' || status === 'submitting') return 'Running'
  if (['queued', 'cancelled', 'interrupted'].includes(status)) return status
  return 'Unknown'
}

function statusTone(status: string): string {
  if (status === 'succeeded') return 'text-emerald-600'
  if (['failed', 'cancelled', 'interrupted'].includes(status)) return 'text-red-400'
  if (status === 'running' || status === 'submitting') return 'text-sky-500'
  return 'text-[var(--muted-foreground)]'
}

function timeLabel(value: string | number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * §Phase F2 shot detail drawer: the C5 variant list expanded into a slide-over
 * where every take shows its thumbnail, wall-clock render time, a parameter
 * diff against the current take, and (when the §F5 unit price is filled in)
 * a display-only cost estimate.
 */
export function ShotVariantDrawer({
  open,
  shot,
  jobs,
  currentJobId,
  assetUrl,
  priceHints,
  busy,
  loading,
  onClose,
  onBind,
}: {
  open: boolean
  shot: VideoStoryboardShot | null
  jobs: VideoJob[]
  currentJobId?: string | null
  assetUrl: (assetId: string) => string
  /** §F5 per-model ¥/s hints; missing key = no estimate row. */
  priceHints: Record<string, number>
  busy?: boolean
  loading?: boolean
  onClose: () => void
  onBind: (shot: VideoStoryboardShot, job: VideoJob) => void
}) {
  const { t } = useTranslation()
  const variants = shot ? sortVideoVariantJobs(jobs) : []
  const currentJob = currentJobId ? variants.find(job => job.id === currentJobId) : undefined

  useEffect(() => {
    if (!open) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [open, onClose])

  if (!open || !shot) return null

  return (
    <div className="absolute inset-0 z-40" role="dialog" aria-label={t('Variant history')}>
      <button
        type="button"
        aria-label={t('Close variant drawer')}
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/35 backdrop-blur-[1px]"
      />
      <div
        data-variant-drawer=""
        className="absolute inset-y-0 right-0 flex w-[min(430px,calc(100%-16px))] flex-col border-l border-[var(--border)] bg-[var(--card)] shadow-2xl"
      >
        <div className="flex items-start justify-between gap-2 border-b border-[var(--border)]/60 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold">
              <History size={13} /> {t('Variant history')}
            </p>
            <p className="mt-0.5 truncate text-[9.5px] text-[var(--muted-foreground)]">
              {shot.title || shot.prompt || t('Untitled shot')} ·{' '}
              {t('{{count}} version(s)', { count: variants.length })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('Close variant drawer')}
            className="shrink-0 rounded-lg border border-[var(--border)] p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/45"
          >
            <X size={13} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3.5 py-2.5">
          {loading && !variants.length ? (
            <p className="flex items-center gap-1.5 py-6 text-[10px] text-[var(--muted-foreground)]">
              <Loader2 size={12} className="animate-spin" /> {t('Loading variant history…')}
            </p>
          ) : null}
          {!loading && !variants.length ? (
            <p className="py-6 text-center text-[10px] text-[var(--muted-foreground)]">
              {t('No versions yet — generate this shot first.')}
            </p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {variants.map(job => {
              const current = job.id === currentJobId
              const outputId = job.output_asset_ids[0]
              const renderSeconds = variantRenderSeconds(job)
              const diff = current ? [] : variantParameterDiff(currentJob, job)
              const hint = priceHints[videoModelKey(job)]
              const estimate = estimateVideoCostYuan(hint, jobBilledSeconds(job))
              return (
                <li
                  key={job.id}
                  data-variant-row={job.id}
                  className={`rounded-xl border p-2 ${
                    current
                      ? 'border-[var(--primary)]/60 bg-[var(--primary)]/[0.06]'
                      : 'border-[var(--border)]/60 bg-[var(--background)]'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span className="h-12 w-20 shrink-0 overflow-hidden rounded-lg bg-black/85">
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
                          <Film size={15} strokeWidth={1.4} />
                        </span>
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[10px] font-medium ${statusTone(job.status)}`}>
                          {t(statusLabelKey(job.status))}
                        </span>
                        {current ? (
                          <span className="rounded bg-[var(--primary)]/10 px-1.5 py-px text-[8.5px] text-[var(--primary)]">
                            {t('Current')}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-[8.5px] text-[var(--muted-foreground)]">
                        {timeLabel(job.created_at)} · {t('Seed')} {variantJobSeedLabel(job)}
                      </p>
                      <p
                        data-variant-render-time=""
                        className="mt-0.5 inline-flex items-center gap-1 text-[8.5px] text-[var(--muted-foreground)]"
                      >
                        <Clock3 size={9} />
                        {renderSeconds != null
                          ? t('Rendered in {{duration}}', { duration: formatVideoDuration(renderSeconds) })
                          : t('Render time pending')}
                      </p>
                    </div>
                    {!current ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onBind(shot, job)}
                        className="shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 text-[9px] hover:bg-[var(--muted)]/45 disabled:opacity-50"
                      >
                        {t('Set as current')}
                      </button>
                    ) : null}
                  </div>

                  {diff.length ? (
                    <div data-variant-diff="" className="mt-1.5 flex flex-wrap gap-1">
                      {diff.map(item => (
                        <span
                          key={item.key}
                          className="rounded-md bg-[var(--muted)]/60 px-1.5 py-0.5 text-[8.5px] text-[var(--muted-foreground)]"
                        >
                          {t(diffKeyLabel(item.key))}: {item.current === 'null' ? '—' : item.current}
                          <span className="mx-0.5">→</span>
                          {item.other === 'null' ? '—' : item.other}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {estimate != null ? (
                    <p
                      data-variant-cost=""
                      className="mt-1.5 inline-flex items-center gap-1 text-[8.5px] text-[var(--muted-foreground)]"
                    >
                      <Coins size={9} />
                      {t('Estimated {{cost}} (at your unit price)', { cost: formatYuan(estimate) })}
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>

        <p className="border-t border-[var(--border)]/60 px-3.5 py-2 text-[8.5px] leading-relaxed text-[var(--muted-foreground)]">
          {t('Each reroll is one paid task and is confirmed separately; switching versions is free.')}
        </p>
      </div>
    </div>
  )
}
