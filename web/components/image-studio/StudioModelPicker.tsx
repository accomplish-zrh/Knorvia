'use client'

import Link from 'next/link'
import { Check, ChevronDown, ImageIcon, Settings2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { type ImageModelOption } from '@/lib/image-studio-api'
import { advertisedOperations, studioModelKey } from '@/lib/image-studio/studio-logic'

function operationLabel(operation: string, t: (key: string) => string) {
  if (operation === 'edit') return t('Edit')
  if (operation === 'inpaint') return t('Local redraw')
  return t('Create')
}

export function StudioModelPicker({
  models,
  value,
  onChange,
  busy,
}: {
  models: ImageModelOption[]
  value: string
  onChange: (value: string) => void
  busy?: boolean
}) {
  const { t } = useTranslation()
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const selected = models.find(model => studioModelKey(model) === value)

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!detailsRef.current?.contains(event.target as Node)) {
        detailsRef.current?.removeAttribute('open')
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        detailsRef.current?.removeAttribute('open')
        detailsRef.current?.querySelector('summary')?.focus()
      }
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
        href="/settings/image"
        data-studio-model-picker="empty"
        className="inline-flex h-8 max-w-[190px] shrink-0 items-center gap-1.5 rounded-[10px] px-2 text-[12.5px] font-medium text-[var(--primary)] hover:bg-[var(--primary)]/[0.07]"
      >
        <Settings2 size={14} strokeWidth={1.7} />
        <span className="truncate">{t('Select image model')}</span>
      </Link>
    )
  }

  return (
    <details ref={detailsRef} data-studio-model-picker="ready" className="group relative shrink-0">
      <summary
        aria-label={t('Select image model')}
        className="flex h-8 max-w-[210px] cursor-pointer list-none items-center gap-1.5 rounded-[10px] px-2 text-[12.5px] hover:bg-[var(--muted)]/55 [&::-webkit-details-marker]:hidden"
      >
        <ImageIcon size={14} strokeWidth={1.7} className="shrink-0 text-[var(--primary)]" />
        <span className="min-w-0 truncate font-medium">
          {selected?.model_name || t('Select image model')}
        </span>
        <ChevronDown
          size={13}
          className="shrink-0 text-[var(--muted-foreground)] transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="absolute bottom-[calc(100%+10px)] left-0 z-50 w-[min(340px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--popover)] p-1.5 text-[var(--popover-foreground)] shadow-xl">
        <div className="px-2.5 py-2">
          <p className="text-[12px] font-medium">{t('Choose a model')}</p>
          <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">
            {t('Available image models are managed in Settings.')}
          </p>
        </div>
        <div className="max-h-72 overflow-y-auto">
          {models.map(model => {
            const key = studioModelKey(model)
            const active = key === value
            return (
              <button
                key={key}
                type="button"
                disabled={busy}
                onClick={() => {
                  onChange(key)
                  detailsRef.current?.removeAttribute('open')
                }}
                className={`flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left disabled:opacity-40 ${
                  active ? 'bg-[var(--primary)]/[0.08]' : 'hover:bg-[var(--muted)]/55'
                }`}
              >
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--muted)]/65">
                  <ImageIcon size={14} strokeWidth={1.6} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[12.5px] font-medium">{model.model_name}</span>
                    {model.is_active_default ? (
                      <span className="rounded bg-[var(--muted)] px-1 py-0.5 text-[9px] text-[var(--muted-foreground)]">
                        {t('Default')}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-[10.5px] text-[var(--muted-foreground)]">
                    {model.profile_name} · {model.provider}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {advertisedOperations(model.capabilities).map(operation => (
                      <span
                        key={operation}
                        className="rounded-md bg-[var(--muted)]/65 px-1.5 py-0.5 text-[9.5px] text-[var(--muted-foreground)]"
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
            )
          })}
        </div>
        <Link
          href="/settings/image"
          className="mt-1 flex items-center gap-1.5 border-t border-[var(--border)] px-2.5 pt-2.5 pb-2 text-[11.5px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          <Settings2 size={13} /> {t('Manage image models')}
        </Link>
      </div>
    </details>
  )
}
