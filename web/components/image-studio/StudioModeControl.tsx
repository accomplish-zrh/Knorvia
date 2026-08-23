'use client'

import { useTranslation } from 'react-i18next'
import { STUDIO_UI_MODES, type StudioUiMode } from '@/lib/image-studio/studio-logic'

const MODE_KEYS: Record<StudioUiMode, string> = {
  create: 'Compose',
  edit: 'Edit',
  canvas: 'Canvas',
  enhance: 'Enhance',
}

export function StudioModeControl({
  value,
  onChange,
}: {
  value: StudioUiMode
  onChange: (mode: StudioUiMode) => void
}) {
  const { t } = useTranslation()
  return (
    <div
      data-studio-mode-control=""
      className="inline-flex max-w-full min-w-0 flex-wrap gap-0.5 rounded-lg bg-[var(--muted)]/50 p-0.5"
      role="tablist"
      aria-label={t('Image Studio')}
    >
      {STUDIO_UI_MODES.map(mode => {
        const active = value === mode
        return (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={active}
            data-studio-mode={mode}
            onClick={() => onChange(mode)}
            className={`rounded-md px-2.5 py-1 text-[12.5px] whitespace-nowrap transition-colors ${
              active
                ? 'bg-[var(--background)] font-medium text-[var(--foreground)]'
                : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            }`}
          >
            {t(MODE_KEYS[mode])}
          </button>
        )
      })}
    </div>
  )
}
