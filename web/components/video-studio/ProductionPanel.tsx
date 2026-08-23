'use client'

import { CheckCircle2, Loader2, ScrollText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  PRODUCTION_STAGE_LABELS,
  PRODUCTION_STAGES,
  nextProductionAction,
  stageReady,
  type ProductionReadiness,
  type ProductionStage,
  type VideoProduction,
} from '@/lib/video-studio/production-logic'

export function ProductionStageRail({
  stage,
  readiness,
  onSelect,
}: {
  stage: ProductionStage
  readiness: ProductionReadiness | null
  onSelect: (stage: ProductionStage) => void
}) {
  const { t } = useTranslation()
  return (
    <nav data-production-rail="" className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {PRODUCTION_STAGES.map((item, index) => {
        const ready = stageReady(item, readiness)
        const current = item === stage
        return (
          <button
            key={item}
            type="button"
            data-production-stage={item}
            aria-current={current ? 'step' : undefined}
            onClick={() => onSelect(item)}
            className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[10.5px] ${
              current
                ? 'border-[var(--primary)] bg-[var(--primary)]/[0.1] text-[var(--primary)]'
                : ready
                  ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300'
                  : 'border-[var(--border)] text-[var(--muted-foreground)]'
            }`}
          >
            <span className="tabular-nums opacity-60">{index + 1}</span>
            {t(PRODUCTION_STAGE_LABELS[item])}
          </button>
        )
      })}
    </nav>
  )
}

export function ProductionPanel({
  production,
  readiness,
  busy,
  onScript,
  onAnalyze,
  onConfirm,
  onReopen,
  onApply,
  onJump,
}: {
  production: VideoProduction
  readiness: ProductionReadiness | null
  busy?: boolean
  onScript: (patch: { title?: string; text?: string }) => void
  onAnalyze: () => void
  onConfirm: () => void
  onReopen: () => void
  onApply: (replace: boolean) => void
  onJump: (stage: ProductionStage) => void
}) {
  const { t } = useTranslation()
  const next = nextProductionAction(readiness)
  const confirmed = readiness?.review
  const shotCount = production.analysis.shots.length
  return (
    <section
      data-production-panel=""
      className="mx-auto flex w-full max-w-[1180px] flex-1 flex-col gap-3 p-3 md:p-4"
    >
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-3">
        <div>
          <div className="flex items-center gap-2">
            <ScrollText size={15} className="shrink-0 text-[var(--primary)]" />
            <h2 className="text-[13.5px] font-semibold">{t('Episode production')}</h2>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-[var(--muted-foreground)]">
            {t('Grows on this project’s storyboard, cast, voice and export.')}
          </p>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-[160px_1fr]">
          <input
            value={production.script.title}
            onChange={event => onScript({ title: event.target.value })}
            placeholder={t('Episode title')}
            className="h-9 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-[13px] outline-none"
          />
          <p className="self-center text-[11px] text-[var(--muted-foreground)]">
            {confirmed
              ? t('Review confirmed. Apply writes shots into the existing strip.')
              : t('Paste a script, analyze it, then confirm before applying.')}
          </p>
        </div>
        <textarea
          data-production-script=""
          value={production.script.text}
          onChange={event => onScript({ text: event.target.value })}
          rows={12}
          placeholder={t('Paste the episode script. Scene headings and character cues become shots.')}
          className="mt-3 w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[13px] leading-6 outline-none"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || !production.script.text.trim()}
            onClick={onAnalyze}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--primary)] px-3 text-[12px] text-[var(--primary-foreground)] disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : null}
            {t('Analyze script')}
          </button>
          {confirmed ? (
            <button
              type="button"
              disabled={busy}
              onClick={onReopen}
              className="h-8 rounded-full border border-[var(--border)] px-3 text-[12px]"
            >
              {t('Reopen review')}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || !shotCount}
              onClick={onConfirm}
              className="h-8 rounded-full border border-[var(--border)] px-3 text-[12px] disabled:opacity-50"
            >
              {t('Confirm review')}
            </button>
          )}
          <button
            type="button"
            disabled={busy || !confirmed}
            onClick={() => onApply(false)}
            className="h-8 rounded-full border border-[var(--border)] px-3 text-[12px] disabled:opacity-50"
          >
            {t('Apply to storyboard')}
          </button>
          <button
            type="button"
            disabled={busy || !confirmed}
            onClick={() => onApply(true)}
            className="h-8 rounded-full border border-[var(--border)] px-3 text-[12px] disabled:opacity-50"
          >
            {t('Replace unused shots')}
          </button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
        <article className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-3">
          <h3 className="text-[12.5px] font-medium">{t('Analysis')}</h3>
          {shotCount ? (
            <div className="mt-2 space-y-2 text-[12px]">
              <p className="text-[var(--muted-foreground)]">{production.analysis.logline}</p>
              <p>
                {t('{{scenes}} scenes · {{cast}} characters · {{shots}} shots', {
                  scenes: production.analysis.scenes.length,
                  cast: production.analysis.characters.length,
                  shots: shotCount,
                })}
              </p>
              <ol className="max-h-64 space-y-1 overflow-auto">
                {production.analysis.shots.map((shot, index) => (
                  <li key={shot.id} className="rounded-lg bg-[var(--muted)]/40 px-2 py-1.5">
                    <div className="truncate font-medium">
                      {index + 1}. {shot.title}
                    </div>
                    {shot.prompt ? (
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--muted-foreground)]">
                        {shot.prompt}
                      </p>
                    ) : null}
                    {shot.dialogue ? (
                      <div className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">
                        {shot.dialogue}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="mt-2 text-[12px] text-[var(--muted-foreground)]">{t('No analysis yet.')}</p>
          )}
        </article>
        <article className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-3">
          <h3 className="text-[12.5px] font-medium">{t('Readiness')}</h3>
          <ul className="mt-2 space-y-1.5 text-[12px]">
            <ReadyRow ok={Boolean(readiness?.script)} label={t('Script')} />
            <ReadyRow ok={Boolean(readiness?.analysis)} label={t('Analyzed shots')} />
            <ReadyRow ok={Boolean(readiness?.review)} label={t('Review confirmed')} />
            <ReadyRow
              ok={Boolean(readiness?.cast.ready)}
              label={t('Cast bound ({{bound}}/{{needed}})', {
                bound: readiness?.cast.bound.length || 0,
                needed: readiness?.cast.needed.length || 0,
              })}
            />
            <ReadyRow
              ok={Boolean(readiness?.storyboard.ready)}
              label={t('Storyboard shots ({{count}})', { count: readiness?.storyboard.shots || 0 })}
            />
            <ReadyRow
              ok={Boolean(readiness?.videos.ready)}
              label={t('Shot videos ({{ready}}/{{total}})', {
                ready: readiness?.videos.ready || 0,
                total: readiness?.videos.total || 0,
              })}
            />
            <ReadyRow
              ok={Boolean(readiness?.voice.ready)}
              label={t('Voice or captions ({{ready}}/{{total}})', {
                ready: readiness?.voice.ready || 0,
                total: readiness?.voice.total || 0,
              })}
            />
            <ReadyRow ok={Boolean(readiness?.compose)} label={t('Ready to export')} />
          </ul>
          <button
            type="button"
            onClick={() => onJump(next)}
            className="mt-3 h-8 rounded-full border border-[var(--border)] px-3 text-[12px]"
          >
            {t('Continue to {{stage}}', { stage: t(PRODUCTION_STAGE_LABELS[next]) })}
          </button>
        </article>
      </div>
    </section>
  )
}

function ReadyRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <CheckCircle2 size={13} className={ok ? 'text-emerald-500' : 'text-[var(--muted-foreground)]/40'} />
      <span className={ok ? '' : 'text-[var(--muted-foreground)]'}>{label}</span>
    </li>
  )
}
