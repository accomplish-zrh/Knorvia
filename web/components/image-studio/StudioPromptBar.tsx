'use client'

import { Loader2, Plus, Sparkles, Square, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { StudioReferences } from './StudioReferences'
import { StudioModelPicker } from './StudioModelPicker'
import { type ImageModelOption } from '@/lib/image-studio-api'
import {
  ASPECT_PRESETS,
  RESOLUTION_PRESETS,
  type GenerateButtonAppearance,
  type GenerateButtonState,
  type ReferenceRole,
  type ResolutionPreset,
  type StudioReference,
} from '@/lib/image-studio/studio-logic'

function generateClasses(state: GenerateButtonState) {
  if (state === 'queued') return 'bg-amber-500/90 text-white hover:bg-amber-500'
  if (state === 'generating') return 'bg-amber-600 text-white'
  if (state === 'failed') return 'bg-[var(--destructive)] text-[var(--destructive-foreground)]'
  return 'bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90'
}

export function StudioPromptBar({
  prompt,
  onPrompt,
  references,
  maxInputs,
  busy,
  onAddReference,
  onChangeRole,
  onRemoveReference,
  onPreviewReference,
  aspectRatio,
  onAspectRatio,
  resolution,
  onResolution,
  count,
  onCount,
  showCount,
  maxOutputs,
  showAspectRatio,
  generate,
  onGenerate,
  onCancel,
  canCancel,
  statusLabel,
  models,
  modelKey,
  onModelKey,
  placeholder,
}: {
  prompt: string
  onPrompt: (value: string) => void
  references: StudioReference[]
  maxInputs: number
  busy?: boolean
  onAddReference: () => void
  onChangeRole: (assetId: string, role: ReferenceRole) => void
  onRemoveReference: (assetId: string) => void
  onPreviewReference: (assetId: string) => void
  aspectRatio: string
  onAspectRatio: (value: string) => void
  resolution: ResolutionPreset
  onResolution: (value: ResolutionPreset) => void
  count: number
  onCount: (value: number) => void
  showCount: boolean
  maxOutputs: number
  showAspectRatio: boolean
  generate: GenerateButtonAppearance
  onGenerate: () => void
  onCancel: () => void
  canCancel: boolean
  statusLabel?: string
  models: ImageModelOption[]
  modelKey: string
  onModelKey: (value: string) => void
  placeholder?: string
}) {
  const { t } = useTranslation()
  return (
    <div
      data-studio-prompt-bar=""
      className="pointer-events-auto w-full rounded-[26px] border border-[var(--border)]/55 bg-[var(--card)] shadow-[0_1px_2px_rgba(0,0,0,0.025),0_10px_28px_-10px_rgba(0,0,0,0.08)]"
    >
      {references.length ? (
        <div className="rounded-t-[26px] border-b border-[var(--border)]/30 bg-[var(--muted)]/30 px-3.5 pt-2.5 pb-2">
          <StudioReferences
            references={references}
            maxInputs={maxInputs}
            busy={busy}
            onAdd={onAddReference}
            onChangeRole={onChangeRole}
            onRemove={onRemoveReference}
            onPreview={onPreviewReference}
          />
        </div>
      ) : null}
      <div className="relative px-3.5 pt-2.5">
        <textarea
          data-studio-prompt=""
          value={prompt}
          maxLength={20000}
          rows={3}
          onChange={event => onPrompt(event.target.value)}
          onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault()
              onGenerate()
            }
          }}
          placeholder={placeholder || t('Describe the image you want to create or change…')}
          className="w-full resize-none bg-transparent pr-14 text-[14px] leading-6 text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
        />
        {prompt ? (
          <button
            type="button"
            onClick={() => onPrompt('')}
            aria-label={t('Clear prompt')}
            className="absolute top-2 right-3 rounded-[10px] p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55"
          >
            <X size={13} />
          </button>
        ) : (
          <span className="pointer-events-none absolute right-4 bottom-1 text-[10px] text-[var(--muted-foreground)]">
            {t('Submit shortcut')}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 px-2.5 pt-0.5 pb-2">
        <StudioModelPicker
          models={models}
          value={modelKey}
          onChange={onModelKey}
          busy={busy}
        />
        <button
          type="button"
          disabled={busy || maxInputs <= 0}
          onClick={onAddReference}
          title={t('Add reference')}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)] disabled:opacity-40"
        >
          <Plus size={16} strokeWidth={1.7} />
        </button>
        {showAspectRatio ? (
          <div className="flex min-w-0 flex-wrap items-center">
            {ASPECT_PRESETS.map(ratio => (
            <button
              key={ratio}
              type="button"
              onClick={() => onAspectRatio(aspectRatio === ratio ? '' : ratio)}
              aria-pressed={aspectRatio === ratio}
              className={`h-8 rounded-lg px-2 text-[12.5px] transition-colors ${
                aspectRatio === ratio
                  ? 'bg-[var(--primary)]/[0.08] font-medium text-[var(--primary)]'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]'
              }`}
            >
              {ratio}
            </button>
            ))}
          </div>
        ) : null}
        <div
          className="flex flex-wrap rounded-lg bg-[var(--muted)]/45 p-0.5"
          aria-label={t('Clarity')}
        >
          {RESOLUTION_PRESETS.map(preset => (
            <button
              key={preset}
              type="button"
              onClick={() => onResolution(preset)}
              aria-pressed={resolution === preset}
              className={`h-7 rounded-md px-2 text-[12px] transition-colors ${
                resolution === preset
                  ? 'bg-[var(--background)] font-medium text-[var(--foreground)]'
                  : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
              }`}
            >
              {preset === 'native' ? t('Native') : preset}
            </button>
          ))}
        </div>
        {showCount ? (
          <label className="ml-1 flex h-8 items-center gap-1 text-[12px] text-[var(--muted-foreground)]">
            {t('Count')}
            <select
              value={count}
              onChange={event => onCount(Number(event.target.value))}
              className="h-7 rounded-md border-0 bg-transparent text-[12.5px] text-[var(--foreground)] outline-none"
            >
              {Array.from({ length: maxOutputs }, (_, index) => index + 1).map(value => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {statusLabel ? (
            <span className="max-w-full truncate text-[11px] text-[var(--muted-foreground)]">
              {statusLabel}
            </span>
          ) : null}
          {canCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex h-8 items-center gap-1 rounded-[10px] px-2.5 text-[12.5px] text-[var(--destructive)] hover:bg-[var(--muted)]/55"
            >
              <Square size={11} />
              {t('Cancel generation')}
            </button>
          ) : null}
          <button
            type="button"
            data-studio-generate={generate.state}
            disabled={generate.disabled}
            onClick={onGenerate}
            className={`inline-flex h-8 items-center gap-1.5 rounded-[10px] px-3 text-[12.5px] font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${generateClasses(generate.state)}`}
          >
            {generate.state === 'queued' || generate.state === 'generating' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} strokeWidth={1.7} />
            )}
            {t(generate.labelKey)}
          </button>
        </div>
      </div>
    </div>
  )
}
