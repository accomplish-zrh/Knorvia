'use client'

import { CircleAlert, Clock3, Coins, Loader2, Play, RotateCcw, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type VideoJob, type VideoModelOption } from '@/lib/video-studio-api'
import {
  estimateVideoCostYuan,
  formatYuan,
  isVideoJobFinal,
  jobBilledSeconds,
  jobErrorMessage,
  normalizedJobProgress,
  videoModelKey,
} from '@/lib/video-studio/studio-logic'

/** Beyond this the task is flagged as probably stuck so the user can cancel+retry. */
const STALE_HINT_MS = 10 * 60 * 1000
const CANCEL_CONFIRM_RESET_MS = 4000

function statusTone(status: string) {
  if (status === 'succeeded') return 'bg-emerald-500/10 text-emerald-600'
  if (status === 'failed' || status === 'interrupted') return 'bg-red-500/10 text-red-600'
  if (status === 'cancelled') return 'bg-[var(--muted)] text-[var(--muted-foreground)]'
  return 'bg-amber-500/10 text-amber-600'
}

function jobStartMs(job: VideoJob): number | null {
  const raw = job.started_at ?? job.created_at
  const ms = typeof raw === 'number' ? raw : Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

function formatElapsed(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function VideoJobQueue({
  jobs,
  models,
  busyJobId,
  focusedJobId,
  onCancel,
  onRetry,
  onPreviewOutput,
  canLoadMore,
  onLoadMore,
  priceHints,
}: {
  jobs: VideoJob[]
  models: VideoModelOption[]
  busyJobId?: string | null
  focusedJobId?: string | null
  onCancel: (job: VideoJob) => void
  onRetry: (job: VideoJob) => void
  onPreviewOutput: (assetId: string, job: VideoJob) => void
  canLoadMore?: boolean
  onLoadMore?: () => void
  /** §F5 user-entered ¥/s per model; missing key = estimate stays hidden. */
  priceHints?: Record<string, number>
}) {
  const { t } = useTranslation()
  const focusedRef = useRef<HTMLElement | null>(null)
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null)
  const confirmCancelTimer = useRef<number | null>(null)
  const hasActive = jobs.some(job => !isVideoJobFinal(job.status))
  const [nowTick, setNowTick] = useState(() => Date.now())

  useEffect(() => {
    focusedRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusedJobId, jobs])

  useEffect(() => {
    if (!hasActive) return
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasActive])

  useEffect(
    () => () => {
      if (confirmCancelTimer.current !== null) window.clearTimeout(confirmCancelTimer.current)
    },
    []
  )

  const requestCancel = (job: VideoJob) => {
    if (confirmCancelId === job.id) {
      if (confirmCancelTimer.current !== null) window.clearTimeout(confirmCancelTimer.current)
      setConfirmCancelId(null)
      onCancel(job)
      return
    }
    setConfirmCancelId(job.id)
    confirmCancelTimer.current = window.setTimeout(() => setConfirmCancelId(null), CANCEL_CONFIRM_RESET_MS)
  }

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t('Generation queue')}>
      <div className="px-4 py-3">
        <h2 className="text-xs font-semibold">{t('Generation queue')}</h2>
        <p className="mt-0.5 text-[10.5px] text-[var(--muted-foreground)]">
          {t('{{count}} task(s)', { count: jobs.length })}
        </p>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {jobs.length ? (
          jobs.map(job => {
            const progress = normalizedJobProgress(job)
            const model = models.find(item => videoModelKey(item) === `${job.profile_id}:${job.model_id}`)
            const active = !isVideoJobFinal(job.status)
            // A historical task can outlive its catalog entry. In that case we
            // no longer know whether upstream cancellation is supported, so do
            // not offer a button that may only abandon the local task.
            const supportsCancel = Boolean(model) && model?.capabilities.supports_cancel !== false
            const error = jobErrorMessage(job)
            return (
              <article
                key={job.id}
                ref={job.id === focusedJobId ? focusedRef : undefined}
                data-focused={job.id === focusedJobId ? 'true' : undefined}
                className={`rounded-xl border bg-[var(--card)] p-3 transition-shadow ${
                  job.id === focusedJobId
                    ? 'border-[var(--primary)] ring-2 ring-[var(--primary)]/15'
                    : 'border-[var(--border)]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[11.5px] font-medium">{job.prompt}</p>
                    <p className="mt-0.5 truncate text-[9.5px] text-[var(--muted-foreground)]">
                      {model?.model_name || job.model_id} · {t(job.operation)}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9px] ${statusTone(job.status)}`}>
                    {t(job.status)}
                  </span>
                </div>
                {priceHints
                  ? (() => {
                      const estimate = estimateVideoCostYuan(
                        priceHints[`${job.profile_id}:${job.model_id}`],
                        jobBilledSeconds(job)
                      )
                      if (estimate == null) return null
                      return (
                        <p
                          data-job-cost=""
                          className="mt-1 inline-flex items-center gap-1 text-[9px] text-[var(--muted-foreground)]"
                        >
                          <Coins size={9} />
                          {t('Estimated {{cost}} (at your unit price)', { cost: formatYuan(estimate) })}
                        </p>
                      )
                    })()
                  : null}
                {active ? (
                  (() => {
                    const startMs = jobStartMs(job)
                    const elapsedMs = startMs === null ? null : Math.max(0, nowTick - startMs)
                    return (
                      <div className="mt-2.5">
                        <div className="mb-1 flex justify-between text-[9.5px] text-[var(--muted-foreground)]">
                          <span className="truncate">{job.stage ? t(job.stage) : t('Preparing')}</span>
                          <span>
                            {Math.round(progress)}%
                            {elapsedMs !== null ? ` · ${formatElapsed(elapsedMs)}` : ''}
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--muted)]">
                          <div
                            className="h-full rounded-full bg-[var(--primary)] transition-[width] duration-500"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        {elapsedMs !== null && elapsedMs >= STALE_HINT_MS ? (
                          <p data-job-stale="" className="mt-1.5 flex items-start gap-1 text-[9px] leading-4 text-amber-600">
                            <CircleAlert size={10} className="mt-0.5 shrink-0" />
                            {t('Taking longer than usual. You can cancel and retry.')}
                          </p>
                        ) : null}
                      </div>
                    )
                  })()
                ) : null}
                {error ? (
                  <p className="mt-2 flex items-start gap-1 text-[9.5px] leading-4 text-[var(--destructive)]">
                    <CircleAlert size={11} className="mt-0.5 shrink-0" /> {error}
                  </p>
                ) : null}
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {job.output_asset_ids.map((assetId, index) => (
                    <button
                      key={assetId}
                      type="button"
                      onClick={() => onPreviewOutput(assetId, job)}
                      className="inline-flex h-7 items-center gap-1 rounded-lg bg-[var(--muted)]/60 px-2 text-[10px] hover:bg-[var(--muted)]"
                    >
                      <Play size={10} /> {t('Result {{n}}', { n: index + 1 })}
                    </button>
                  ))}
                  {active && supportsCancel ? (
                    (() => {
                      const confirming = confirmCancelId === job.id
                      return (
                        <button
                          type="button"
                          data-cancel-confirming={confirming ? 'true' : undefined}
                          disabled={busyJobId === job.id}
                          onClick={() => requestCancel(job)}
                          className={`inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[10px] disabled:opacity-40 ${
                            confirming
                              ? 'bg-[var(--destructive)] font-medium text-[var(--destructive-foreground)]'
                              : 'text-[var(--destructive)] hover:bg-[var(--muted)]'
                          }`}
                        >
                          {busyJobId === job.id ? <Loader2 size={10} className="animate-spin" /> : <Square size={9} />}
                          {confirming ? t('Confirm cancel') : t('Cancel')}
                        </button>
                      )
                    })()
                  ) : null}
                  {!active && job.status !== 'succeeded' ? (
                    <button
                      type="button"
                      disabled={busyJobId === job.id}
                      onClick={() => onRetry(job)}
                      className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[10px] text-[var(--primary)] hover:bg-[var(--muted)] disabled:opacity-40"
                    >
                      {busyJobId === job.id ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
                      {t('Retry')}
                    </button>
                  ) : null}
                </div>
              </article>
            )
          })
        ) : (
          <div className="flex h-44 flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border)] text-center text-[var(--muted-foreground)]">
            <Clock3 size={21} strokeWidth={1.4} />
            <p className="mt-2 text-[11px]">{t('No generation tasks yet')}</p>
          </div>
        )}
        {canLoadMore ? (
          <button
            type="button"
            onClick={onLoadMore}
            className="w-full rounded-lg border border-[var(--border)] py-2 text-[11px] hover:bg-[var(--muted)]/45"
          >
            {t('Load more')}
          </button>
        ) : null}
      </div>
    </section>
  )
}
