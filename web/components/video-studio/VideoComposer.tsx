'use client'

import { ChevronDown, Loader2, Paperclip, Sparkles, TriangleAlert, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  type VideoAsset,
  type VideoAudioMode,
  type VideoCharacter,
  type VideoModelCapabilities,
  type VideoModelOption,
  type VideoOperation,
} from '@/lib/video-studio-api'
import {
  CAMERA_VALUE_LABELS,
  advertisedVideoOperations,
  cameraChipValues,
  cameraParameterLabel,
  type VideoSettings,
  videoDurationControl,
  videoInputLimits,
  videoModelKey,
} from '@/lib/video-studio/studio-logic'
import {
  AUDIO_MODE_CHIP_LABELS,
  AUDIO_TRACK_CAPTIONS,
  audioModeChips,
  audioTrackCaption,
} from '@/lib/video-studio/audio-logic'
import { VideoModelPicker } from './VideoModelPicker'

const OPERATION_KEYS: Record<VideoOperation, string> = {
  text_to_video: 'Text to video',
  image_to_video: 'Image to video',
  video_to_video: 'Video to video',
  extend: 'Extend video',
  remix: 'Remix video',
  edit: 'Edit video',
}

function audioLabel(mode: VideoAudioMode) {
  return AUDIO_MODE_CHIP_LABELS[mode]
}

function FieldSelect({
  label,
  value,
  values,
  onChange,
  format,
}: {
  label: string
  value: string | number
  values: Array<string | number>
  onChange: (value: string) => void
  format?: (value: string | number) => string
}) {
  return (
    <label className="flex min-w-[110px] flex-1 flex-col gap-1 text-[9.5px] text-[var(--muted-foreground)]">
      {label}
      <select
        value={value}
        onChange={event => onChange(event.target.value)}
        className="h-8 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[11px] text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
      >
        {values.map(option => (
          <option key={String(option)} value={option}>
            {format?.(option) || option}
          </option>
        ))}
      </select>
    </label>
  )
}

/** §5.6 duration slider: range input + live seconds readout. */
function DurationSlider({
  label,
  seconds,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string
  seconds: number
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
}) {
  return (
    <div className="flex min-w-[150px] flex-1 flex-col gap-1 text-[9.5px] text-[var(--muted-foreground)]">
      <span aria-hidden="true">{label}</span>
      <span className="flex h-8 items-center gap-2">
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={event => onChange(Number(event.target.value))}
          className="h-8 min-w-0 flex-1 accent-[var(--primary)]"
        />
        <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-[var(--foreground)]">
          {seconds}s
        </span>
      </span>
    </div>
  )
}

/**
 * §Phase D5: audio-mode chips. Single-select (exactly one mode goes on the
 * wire), rendered as chips instead of a select so the dual-track distinction —
 * "the model performs the audio" vs "reference my attached clip" vs "silent" —
 * is visible before the paid generation fires. The §2.1 caption underneath
 * tracks the selection.
 */
function AudioModeChips({
  capabilities,
  value,
  onValue,
}: {
  capabilities: VideoModelCapabilities
  value: VideoAudioMode | ''
  onValue: (mode: VideoAudioMode) => void
}) {
  const { t } = useTranslation()
  const modes = audioModeChips(capabilities)
  if (!modes.length) return null
  const caption = audioTrackCaption(capabilities, value)
  return (
    <div
      data-audio-mode-chips=""
      className="flex min-w-[150px] flex-1 flex-col gap-1 text-[9.5px] text-[var(--muted-foreground)]"
    >
      <span aria-hidden="true">{t('Audio track')}</span>
      <span className="flex min-h-8 flex-wrap items-center gap-1">
        {modes.map(mode => (
          <button
            key={mode}
            type="button"
            data-audio-mode={mode}
            aria-pressed={value === mode}
            onClick={() => onValue(mode)}
            className={`h-7 rounded-full border px-2.5 text-[10.5px] transition-colors ${
              value === mode
                ? 'border-[var(--primary)] bg-[var(--primary)]/[0.12] font-medium text-[var(--primary)]'
                : 'border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50 hover:text-[var(--foreground)]'
            }`}
          >
            {t(AUDIO_MODE_CHIP_LABELS[mode])}
          </button>
        ))}
      </span>
      <span data-audio-track-caption="" className="max-w-[420px] text-[8.5px] leading-relaxed">
        {t(AUDIO_TRACK_CAPTIONS[caption])}
      </span>
    </div>
  )
}

/** §Phase C4: single-select, clearable camera chip group for one enum. */
function CameraChips({
  name,
  values,
  value,
  onValue,
}: {
  name: string
  values: string[]
  value: string
  onValue: (value: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div
      data-camera-chips={name}
      className="flex min-w-[150px] flex-1 flex-col gap-1 text-[9.5px] text-[var(--muted-foreground)]"
    >
      <span aria-hidden="true">{t(cameraParameterLabel(name))}</span>
      <span className="flex min-h-8 flex-wrap items-center gap-1">
        {values.map(option => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            onClick={() => onValue(value === option ? '' : option)}
            className={`h-7 rounded-full border px-2.5 text-[10.5px] transition-colors ${
              value === option
                ? 'border-[var(--primary)] bg-[var(--primary)]/[0.12] font-medium text-[var(--primary)]'
                : 'border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50 hover:text-[var(--foreground)]'
            }`}
          >
            {t(CAMERA_VALUE_LABELS[option])}
          </button>
        ))}
        {value ? (
          <button
            type="button"
            aria-label={t('Clear camera selection')}
            onClick={() => onValue('')}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)]"
          >
            <X size={11} />
          </button>
        ) : null}
      </span>
    </div>
  )
}

export function VideoComposer({
  models,
  modelKey,
  onModelKey,
  operation,
  onOperation,
  prompt,
  onPrompt,
  settings,
  onSettings,
  selectedAssets,
  onRemoveAsset,
  characters,
  onAddCharacter,
  costConfirmed,
  onCostConfirmed,
  submitting,
  disabled,
  validationMessage,
  onSubmit,
  priceHints,
  onPriceHint,
}: {
  models: VideoModelOption[]
  modelKey: string
  onModelKey: (key: string) => void
  operation: VideoOperation | ''
  onOperation: (operation: VideoOperation) => void
  prompt: string
  onPrompt: (prompt: string) => void
  settings: VideoSettings
  onSettings: (settings: VideoSettings) => void
  selectedAssets: VideoAsset[]
  onRemoveAsset: (assetId: string) => void
  characters?: VideoCharacter[]
  onAddCharacter?: (character: VideoCharacter) => void
  costConfirmed: boolean
  onCostConfirmed: (confirmed: boolean) => void
  submitting?: boolean
  disabled?: boolean
  validationMessage?: string
  onSubmit: () => void
  /** §F5 per-model ¥/s hints threaded to the model picker. */
  priceHints?: Record<string, number>
  onPriceHint?: (modelKey: string, value: number | null) => void
}) {
  const { t } = useTranslation()
  const model = models.find(item => videoModelKey(item) === modelKey)
  const capabilities = model?.capabilities || {}
  const operations = advertisedVideoOperations(capabilities)
  const durationControl = videoDurationControl(capabilities, settings.duration)
  const limits = videoInputLimits(capabilities)
  const maxPromptLength = Math.max(1, Number(capabilities.max_prompt_length || 20000))
  const properties = capabilities.parameter_schema?.properties || {}
  const referenceModes = (capabilities.reference_modes || properties.reference_mode?.enum || []).filter(
    (value): value is string => typeof value === 'string'
  )
  // §Phase C4 camera control: camera* string enums with fully known labels
  // render as chip groups in the main row; anything else stays below.
  const cameraGroups = Object.entries(properties).filter(
    ([name, schema]) => name.startsWith('camera') && cameraChipValues(schema) !== null
  )
  const extraProperties = Object.entries(properties).filter(
    ([name]) =>
      !['duration', 'aspect_ratio', 'resolution', 'fps', 'audio_mode', 'seed', 'reference_mode'].includes(name) &&
      !cameraGroups.some(([cameraName]) => cameraName === name)
  )
  const deprecated = model?.lifecycle?.status === 'deprecated'
  const shutdownDate = model?.lifecycle?.shutdown_date
    ? new Date(model.lifecycle.shutdown_date)
    : null
  const readableShutdownDate = shutdownDate && Number.isFinite(shutdownDate.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(shutdownDate)
    : model?.lifecycle?.shutdown_date || ''

  const patchSettings = (patch: Partial<VideoSettings>) => onSettings({ ...settings, ...patch })

  // §5.6 capacity copy: only the input kinds the model actually accepts are
  // listed; a total below the per-kind sum is the real constraint, so it is
  // appended only then.
  const capacityParts: string[] = []
  if (limits.image > 0) capacityParts.push(t('Up to {{count}} image(s)', { count: limits.image }))
  if (limits.video > 0) capacityParts.push(t('Up to {{count}} video(s)', { count: limits.video }))
  if (limits.audio > 0) capacityParts.push(t('Up to {{count}} audio clip(s)', { count: limits.audio }))
  if (limits.total > 0 && limits.total < limits.image + limits.video + limits.audio) {
    capacityParts.push(t('{{count}} input(s) in total', { count: limits.total }))
  }

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-[0_12px_34px_-18px_rgba(0,0,0,0.22)]" aria-label={t('Video prompt composer')}>
      <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border)]/60 px-3 py-2">
        {operations.map(item => (
          <button
            key={item}
            type="button"
            disabled={submitting}
            onClick={() => onOperation(item)}
            aria-pressed={operation === item}
            className={`h-8 rounded-lg px-2.5 text-[11px] transition-colors disabled:opacity-40 ${
              operation === item
                ? 'bg-[var(--primary)]/[0.1] font-medium text-[var(--primary)]'
                : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]'
            }`}
          >
            {t(OPERATION_KEYS[item])}
          </button>
        ))}
        {!operations.length ? (
          <span className="px-2 text-[11px] text-[var(--destructive)]">{t('This model advertises no video operations.')}</span>
        ) : null}
      </div>
      {deprecated ? (
        <div className="flex items-start gap-2 border-b border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-[10.5px] leading-4 text-amber-800 dark:text-amber-300" role="status">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>
            {model?.lifecycle?.message || (readableShutdownDate
              ? t('This model is deprecated and is scheduled to stop working on {{date}}.', { date: readableShutdownDate })
              : t('This model is deprecated.'))}
          </span>
          <span className="mt-1 block">
            {t('Migrating? Volcengine Ark and Kling adapters are drop-in replacements.')}
          </span>
        </div>
      ) : null}
      {selectedAssets.length || (characters?.length && onAddCharacter) ? (
        <div className="flex items-center gap-2 overflow-x-auto border-b border-[var(--border)]/50 bg-[var(--muted)]/25 px-3 py-2">
          {selectedAssets.map(asset => (
            <span
              key={asset.id}
              className="inline-flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[10px]"
            >
              <span className="truncate">{asset.filename}</span>
              <button
                type="button"
                onClick={() => onRemoveAsset(asset.id)}
                aria-label={t('Remove {{name}}', { name: asset.filename })}
                className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {characters?.length && onAddCharacter ? (
            <label className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] bg-[var(--background)] px-2 text-[10px] text-[var(--muted-foreground)]">
              <Paperclip size={10} />
              <span className="sr-only">{t('Add from character library')}</span>
              <select
                value=""
                onChange={event => {
                  const character = characters.find(item => item.id === event.target.value)
                  if (character) onAddCharacter(character)
                  event.target.value = ''
                }}
                aria-label={t('Add from character library')}
                className="max-w-36 cursor-pointer truncate bg-transparent text-[10px] text-[var(--foreground)] outline-none"
              >
                <option value="">{t('Add from character library')}</option>
                {characters.map(character => (
                  <option key={character.id} value={character.id}>{character.name}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
      {capacityParts.length ? (
        <div
          className="flex items-center gap-1.5 border-b border-[var(--border)]/50 bg-[var(--muted)]/25 px-3 py-1.5 text-[9.5px] text-[var(--muted-foreground)]"
          data-capacity-hint=""
        >
          <Paperclip size={11} className="shrink-0" />
          <span className="truncate">{capacityParts.join(' · ')}</span>
        </div>
      ) : null}
      <div className="relative px-3 pt-2.5">
        <textarea
          value={prompt}
          maxLength={maxPromptLength}
          rows={3}
          onChange={event => onPrompt(event.target.value)}
          onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault()
              onSubmit()
            }
          }}
          placeholder={t(
            operation === 'image_to_video'
              ? 'Describe how the image should move, how the camera behaves, and the mood…'
              : 'Describe the shot, subject motion, camera movement, lighting, and pacing…'
          )}
          aria-label={t('Video prompt')}
          className="w-full resize-none bg-transparent pr-12 text-[13px] leading-5 outline-none placeholder:text-[var(--muted-foreground)]"
        />
        <span className="absolute right-3 bottom-2 text-[9px] text-[var(--muted-foreground)]">
          {prompt.length}/{maxPromptLength}
        </span>
      </div>
      <div className="flex flex-wrap gap-2 px-3 pb-2.5">
        {durationControl.kind === 'range' ? (
          <DurationSlider
            label={t('Duration')}
            seconds={durationControl.value}
            min={durationControl.min}
            max={durationControl.max}
            step={durationControl.step}
            value={durationControl.value}
            onChange={value => patchSettings({ duration: value })}
          />
        ) : null}
        {durationControl.kind === 'steps' ? (
          <DurationSlider
            label={t('Duration')}
            seconds={durationControl.durations[durationControl.index]}
            min={0}
            max={durationControl.durations.length - 1}
            step={1}
            value={durationControl.index}
            onChange={index => patchSettings({ duration: durationControl.durations[index] })}
          />
        ) : null}
        {durationControl.kind === 'select' ? (
          <FieldSelect
            label={t('Duration')}
            value={settings.duration}
            values={durationControl.durations}
            onChange={value => patchSettings({ duration: Number(value) })}
            format={value => `${value}s`}
          />
        ) : null}
        {(capabilities.aspect_ratios || []).length ? (
          <FieldSelect
            label={t('Aspect ratio')}
            value={settings.aspectRatio}
            values={capabilities.aspect_ratios || []}
            onChange={value => patchSettings({ aspectRatio: value })}
          />
        ) : null}
        {(capabilities.resolutions || []).length ? (
          <FieldSelect
            label={t('Resolution')}
            value={settings.resolution}
            values={capabilities.resolutions || []}
            onChange={value => patchSettings({ resolution: value })}
          />
        ) : null}
        {(capabilities.fps || []).length ? (
          <FieldSelect
            label={t('Frame rate')}
            value={settings.fps}
            values={capabilities.fps || []}
            onChange={value => patchSettings({ fps: Number(value) })}
            format={value => `${value} fps`}
          />
        ) : null}
        {(capabilities.audio_modes || []).length ? (
          <FieldSelect
            label={t('Audio')}
            value={settings.audioMode}
            values={capabilities.audio_modes || []}
            onChange={value => patchSettings({ audioMode: value as VideoAudioMode })}
            format={value => t(audioLabel(value as VideoAudioMode))}
          />
        ) : null}
        {operation !== 'text_to_video' && referenceModes.length ? (
          <FieldSelect
            label={t('Reference mode')}
            value={settings.referenceMode}
            values={referenceModes}
            onChange={value => patchSettings({ referenceMode: value })}
            format={value => t(String(value))}
          />
        ) : null}
        {cameraGroups.map(([name, schema]) => {
          const values = cameraChipValues(schema)
          if (!values) return null
          const value = settings.extra[name]
          return (
            <CameraChips
              key={name}
              name={name}
              values={values}
              value={typeof value === 'string' ? value : ''}
              onValue={next => patchSettings({ extra: { ...settings.extra, [name]: next } })}
            />
          )
        })}
      </div>
      {capabilities.supports_seed || extraProperties.length ? (
        <details className="group border-t border-[var(--border)]/55 px-3 py-2">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[10.5px] text-[var(--muted-foreground)] [&::-webkit-details-marker]:hidden">
            <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
            {t('Advanced parameters')}
          </summary>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {capabilities.supports_seed ? (
              <label className="flex flex-col gap-1 text-[9.5px] text-[var(--muted-foreground)]">
                {t('Seed')}
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={settings.seed}
                  onChange={event => patchSettings({ seed: event.target.value })}
                  className="h-8 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[11px] text-[var(--foreground)] outline-none"
                />
              </label>
            ) : null}
            {extraProperties.map(([name, schema]) => {
              const value = settings.extra[name] ?? ''
              const patchExtra = (next: unknown) =>
                patchSettings({ extra: { ...settings.extra, [name]: next } })
              return (
                <label key={name} className="flex flex-col gap-1 text-[9.5px] text-[var(--muted-foreground)]">
                  {schema.title || name}
                  {schema.enum?.length ? (
                    <select
                      value={String(value)}
                      onChange={event => {
                        const selected = schema.enum?.find(item => String(item) === event.target.value)
                        patchExtra(selected)
                      }}
                      className="h-8 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[11px] text-[var(--foreground)] outline-none"
                    >
                      {schema.enum.map(option => <option key={String(option)} value={String(option)}>{option}</option>)}
                    </select>
                  ) : schema.type === 'boolean' ? (
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      onChange={event => patchExtra(event.target.checked)}
                      className="h-4 w-4 accent-[var(--primary)]"
                    />
                  ) : (
                    <input
                      type={schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text'}
                      min={schema.minimum}
                      max={schema.maximum}
                      step={schema.step || (schema.type === 'integer' ? 1 : undefined)}
                      value={String(value)}
                      onChange={event =>
                        patchExtra(
                          schema.type === 'number' || schema.type === 'integer'
                            ? Number(event.target.value)
                            : event.target.value
                        )
                      }
                      className="h-8 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[11px] text-[var(--foreground)] outline-none"
                    />
                  )}
                </label>
              )
            })}
          </div>
        </details>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)]/55 px-3 py-2.5">
        <VideoModelPicker
          models={models}
          value={modelKey}
          onChange={onModelKey}
          busy={submitting}
          priceHints={priceHints}
          onPriceHint={onPriceHint}
        />
        <label className="flex min-w-0 items-start gap-2 text-[9.5px] leading-4 text-[var(--muted-foreground)]">
          <input
            type="checkbox"
            checked={costConfirmed}
            onChange={event => onCostConfirmed(event.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--primary)]"
          />
          <span>{t('I understand this request may use paid provider credits.')}</span>
        </label>
        <div className="ml-auto flex items-center gap-2">
          {validationMessage ? (
            <span className="max-w-56 text-right text-[9.5px] text-[var(--destructive)]" role="status">
              {validationMessage}
            </span>
          ) : null}
          <button
            type="button"
            disabled={disabled || submitting}
            onClick={onSubmit}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[var(--primary)] px-3.5 text-xs font-medium text-[var(--primary-foreground)] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {t(submitting ? 'Submitting' : 'Generate shot')}
          </button>
        </div>
      </div>
    </section>
  )
}
