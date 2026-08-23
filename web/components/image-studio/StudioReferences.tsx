'use client'

import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { studioAssetUrl } from '@/lib/image-studio-api'
import {
  REFERENCE_ROLES,
  type ReferenceRole,
  type StudioReference,
} from '@/lib/image-studio/studio-logic'

export const ROLE_LABEL_KEYS: Record<ReferenceRole, string> = {
  subject: 'Subject reference',
  style: 'Style reference',
  composition: 'Composition reference',
  color: 'Color reference',
  edit: 'Image to edit',
  mask: 'Mask',
}

export function StudioReferences({
  references,
  maxInputs,
  busy,
  onAdd,
  onChangeRole,
  onRemove,
  onPreview,
}: {
  references: StudioReference[]
  maxInputs: number
  busy?: boolean
  onAdd: () => void
  onChangeRole: (assetId: string, role: ReferenceRole) => void
  onRemove: (assetId: string) => void
  onPreview: (assetId: string) => void
}) {
  const { t } = useTranslation()
  const [openId, setOpenId] = useState<string | null>(null)
  const canAdd = references.filter(item => item.role !== 'mask').length < maxInputs

  return (
    <div data-studio-references="" className="flex min-w-0 flex-wrap items-end gap-2">
      {references.map(item => (
        <div key={`${item.assetId}:${item.role}`} className="group relative">
          <button
            type="button"
            onClick={() => onPreview(item.assetId)}
            title={t('Preview reference')}
            className="relative block h-14 w-14 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={studioAssetUrl(item.assetId)}
              alt={t(ROLE_LABEL_KEYS[item.role])}
              className="h-full w-full object-cover"
            />
          </button>
          <button
            type="button"
            data-reference-role={item.role}
            onClick={() => setOpenId(current => (current === item.assetId ? null : item.assetId))}
            title={t('Change reference role')}
            className="mt-1 block max-w-14 truncate text-left text-[10px] leading-4 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            {t(ROLE_LABEL_KEYS[item.role])}
          </button>
          <button
            type="button"
            onClick={() => onRemove(item.assetId)}
            aria-label={t('Remove reference')}
            className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--foreground)] text-[var(--background)] opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
          >
            <X size={10} />
          </button>
          {openId === item.assetId ? (
            <div className="absolute bottom-full left-0 z-20 mb-1.5 w-40 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--popover)] py-1 shadow-lg">
              {REFERENCE_ROLES.map(role => (
                <button
                  key={role}
                  type="button"
                  onClick={() => {
                    onChangeRole(item.assetId, role)
                    setOpenId(null)
                  }}
                  className={`block w-full px-3 py-1.5 text-left text-[12.5px] ${
                    item.role === role
                      ? 'bg-[var(--primary)]/[0.06] font-medium'
                      : 'hover:bg-[var(--muted)]/45'
                  }`}
                >
                  {t(ROLE_LABEL_KEYS[role])}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        disabled={!canAdd || busy}
        onClick={onAdd}
        className="mb-5 inline-flex h-14 items-center gap-1 rounded-lg border border-dashed border-[var(--border)] px-2.5 text-[12px] text-[var(--muted-foreground)] transition-colors hover:border-[var(--primary)]/40 hover:text-[var(--foreground)] disabled:opacity-40"
      >
        <Plus size={14} strokeWidth={1.7} />
        {t('Add reference')}
      </button>
    </div>
  )
}
