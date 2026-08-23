'use client'

import Link from 'next/link'
import { Check, ChevronDown, Coins, Settings2, TriangleAlert, Video } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type VideoModelOption, type VideoOperation } from '@/lib/video-studio-api'
import { advertisedVideoOperations, parsePriceHint, videoModelKey } from '@/lib/video-studio/studio-logic'

function operationLabel(operation: VideoOperation, t: (key: string) => string) {
  const labels: Record<VideoOperation, string> = {
    text_to_video: 'Text to video',
    image_to_video: 'Image to video',
    video_to_video: 'Video to video',
    extend: 'Extend video',
    remix: 'Remix video',
    edit: 'Edit video',
  }
  return t(labels[operation])
}

export function VideoModelPicker({
  models,
  value,
  onChange,
  busy,
  priceHints,
  onPriceHint,
}: {
  models: VideoModelOption[]
  value: string
  onChange: (value: string) => void
  busy?: boolean
  /** §F5 user-entered ¥/s per model — display-only cost estimates. */
  priceHints?: Record<string, number>
  onPriceHint?: (modelKey: string, value: number | null) => void
}) {
  const { t } = useTranslation()
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({})
  const selected = models.find(model => videoModelKey(model) === value)

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!detailsRef.current?.contains(event.target as Node)) detailsRef.current?.removeAttribute('open')
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      detailsRef.current?.removeAttribute('open')
      detailsRef.current?.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  if (!models.length) {
    return (
      <Link
        href="/settings/video"
        className="inline-flex h-9 items-center gap-2 rounded-xl border border-[var(--border)] px-3 text-xs font-medium text-[var(--primary)] hover:bg-[var(--primary)]/[0.06]"
      >
        <Settings2 size={14} /> {t('Configure video model')}
      </Link>
    )
  }

  return (
    <details ref={detailsRef} className="group relative">
      <summary
        aria-label={t('Select video model')}
        className="flex h-9 max-w-[250px] cursor-pointer list-none items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-xs hover:bg-[var(--muted)]/45 [&::-webkit-details-marker]:hidden"
      >
        <Video size={14} className="shrink-0 text-[var(--primary)]" />
        <span className="min-w-0 flex-1 truncate text-left font-medium">
          {selected?.model_name || t('Select video model')}
        </span>
        {selected?.lifecycle?.status === 'deprecated' ? (
          <TriangleAlert size={13} className="shrink-0 text-amber-600" aria-label={t('Deprecated')} />
        ) : null}
        {priceHints?.[value] != null ? (
          <span className="shrink-0 rounded bg-[var(--muted)] px-1 py-px text-[9px] tabular-nums text-[var(--muted-foreground)]">
            {t('¥{{hint}}/s', { hint: priceHints[value] })}
          </span>
        ) : null}
        <ChevronDown size={13} className="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-[min(380px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--popover)] p-1.5 shadow-2xl">
        <div className="px-2.5 py-2">
          <p className="text-xs font-semibold">{t('Choose a video model')}</p>
          <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">
            {t('Only capabilities advertised by the model are shown.')}
          </p>
        </div>
        <div className="max-h-72 overflow-y-auto">
          {models.map(model => {
            const key = videoModelKey(model)
            const active = value === key
            const priceText =
              key in priceDrafts ? priceDrafts[key] : priceHints?.[key] != null ? String(priceHints[key]) : ''
            const commitPrice = () => {
              if (!onPriceHint) return
              const hint = parsePriceHint(priceText)
              onPriceHint(key, hint)
              setPriceDrafts(current => ({ ...current, [key]: hint == null ? '' : String(hint) }))
            }
            return (
              <div
                key={key}
                className={`rounded-xl ${active ? 'bg-[var(--primary)]/[0.08]' : 'hover:bg-[var(--muted)]/55'}`}
              >
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    onChange(key)
                    detailsRef.current?.removeAttribute('open')
                  }}
                  className="flex w-full items-start gap-2 rounded-xl px-2.5 py-2.5 text-left disabled:opacity-40"
                >
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--muted)]/60">
                    <Video size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{model.model_name}</span>
                    <span className="mt-0.5 block truncate text-[10.5px] text-[var(--muted-foreground)]">
                      {model.profile_name} · {model.provider}
                    </span>
                    <span className="mt-1.5 flex flex-wrap gap-1">
                      {model.lifecycle?.status === 'deprecated' ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[9.5px] text-amber-700 dark:text-amber-400">
                          <TriangleAlert size={9} /> {t('Deprecated')}
                          {model.lifecycle.shutdown_date ? ` · ${model.lifecycle.shutdown_date}` : ''}
                        </span>
                      ) : null}
                      {advertisedVideoOperations(model.capabilities).map(operation => (
                        <span
                          key={operation}
                          className="rounded-md bg-[var(--muted)]/70 px-1.5 py-0.5 text-[9.5px] text-[var(--muted-foreground)]"
                        >
                          {operationLabel(operation, t)}
                        </span>
                      ))}
                    </span>
                  </span>
                  <Check
                    size={14}
                    className={`mt-1 shrink-0 text-[var(--primary)] ${active ? 'opacity-100' : 'opacity-0'}`}
                  />
                </button>
                {onPriceHint ? (
                  <div className="flex items-center gap-1.5 px-2.5 pb-2">
                    <Coins size={9} className="shrink-0 text-[var(--muted-foreground)]" />
                    <span className="shrink-0 text-[9.5px] text-[var(--muted-foreground)]">
                      {t('Unit price (¥/s)')}
                    </span>
                    <input
                      data-price-hint={key}
                      value={priceText}
                      inputMode="decimal"
                      maxLength={12}
                      placeholder={t('Optional')}
                      onChange={event => setPriceDrafts(current => ({ ...current, [key]: event.target.value }))}
                      onBlur={commitPrice}
                      onKeyDown={event => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                      }}
                      className="ml-auto h-6 w-20 rounded-md border border-[var(--border)] bg-[var(--background)] px-1.5 text-right text-[9.5px] tabular-nums text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
                    />
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
        <Link
          href="/settings/video"
          className="mt-1 flex items-center gap-1.5 border-t border-[var(--border)] px-2.5 pt-2.5 pb-2 text-[11.5px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          <Settings2 size={13} /> {t('Manage video models')}
        </Link>
      </div>
    </details>
  )
}
