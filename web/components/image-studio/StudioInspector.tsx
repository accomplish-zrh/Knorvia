'use client'

import Link from 'next/link'
import { ChevronDown, Download, FolderPlus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  type ImageModelOption,
  type StudioJob,
  type StudioProject,
  type StudioUpscalerStatus,
  studioProjectExportUrl,
} from '@/lib/image-studio-api'
import { fieldIsVisible, jobFactStrip, type StudioDensity } from '@/lib/image-studio/studio-logic'

export function StudioInspector({
  density,
  projects,
  projectId,
  projectTitle,
  models,
  modelKey,
  selectedModel,
  onProjectId,
  onProjectTitle,
  onRename,
  onAddProject,
  onRemoveProject,
  onModelKey,
  style,
  onStyle,
  background,
  onBackground,
  outputFormat,
  onOutputFormat,
  compression,
  onCompression,
  upscalePreset,
  onUpscalePreset,
  resolution,
  upscaler,
  installingUpscaler,
  onInstallUpscaler,
  selectedJob,
  factsOpen,
  onFactsOpen,
}: {
  density: StudioDensity
  projects: StudioProject[]
  projectId: string
  projectTitle: string
  models: ImageModelOption[]
  modelKey: string
  selectedModel?: ImageModelOption
  onProjectId: (id: string) => void
  onProjectTitle: (title: string) => void
  onRename: () => void
  onAddProject: () => void
  onRemoveProject: () => void
  onModelKey: (key: string) => void
  style: string
  onStyle: (value: string) => void
  background: string
  onBackground: (value: string) => void
  outputFormat: string
  onOutputFormat: (value: string) => void
  compression: string
  onCompression: (value: string) => void
  upscalePreset: 'general' | 'illustration'
  onUpscalePreset: (value: 'general' | 'illustration') => void
  resolution: string
  upscaler: StudioUpscalerStatus | null
  installingUpscaler: boolean
  onInstallUpscaler: () => void
  selectedJob: StudioJob | null
  factsOpen: boolean
  onFactsOpen: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const capabilities = selectedModel?.capabilities
  const showPro = density === 'pro'
  const facts = selectedJob ? jobFactStrip(selectedJob) : null

  const field =
    'mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--foreground)] outline-none focus:border-[var(--ring)]'

  return (
    <aside
      data-studio-inspector=""
      className="flex h-full min-h-0 w-full max-w-[340px] min-w-[300px] flex-col overflow-y-auto border-l border-[var(--border)] bg-[var(--background)] px-4 py-5"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[12px] font-medium text-[var(--muted-foreground)]">{t('Project')}</h2>
        <button
          type="button"
          onClick={onAddProject}
          className="inline-flex items-center gap-1 text-[12px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          <FolderPlus size={13} strokeWidth={1.7} />
          {t('New')}
        </button>
      </div>

      <label className="mb-2 block text-[12px] text-[var(--muted-foreground)]">
        <span className="sr-only">{t('Project')}</span>
        <select
          value={projectId}
          onChange={event => onProjectId(event.target.value)}
          className={field}
        >
          {projects.map(project => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </select>
      </label>
      <div className="mb-3 flex gap-2">
        <input
          value={projectTitle}
          onChange={event => onProjectTitle(event.target.value)}
          onBlur={onRename}
          aria-label={t('Project name')}
          className={`min-w-0 flex-1 ${field}`}
        />
        <button
          type="button"
          onClick={onRemoveProject}
          title={t('Delete project')}
          className="rounded-lg border border-[var(--border)] px-2.5 text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
        >
          <Trash2 size={15} strokeWidth={1.7} />
        </button>
      </div>
      {projectId ? (
        <a
          href={studioProjectExportUrl(projectId)}
          download
          className="mb-5 inline-flex items-center gap-1 text-[12px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          <Download size={12} strokeWidth={1.7} />
          {t('Export project')}
        </a>
      ) : null}

      {showPro && fieldIsVisible('service_model', density, capabilities) ? (
        <label className="mb-4 block text-[12px] text-[var(--muted-foreground)]">
          {t('Service and model')}
          <select
            value={modelKey}
            onChange={event => onModelKey(event.target.value)}
            className={field}
          >
            {models.map(model => (
              <option
                key={`${model.profile_id}:${model.model_id}`}
                value={`${model.profile_id}:${model.model_id}`}
              >
                {model.profile_name} · {model.model_name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {showPro && fieldIsVisible('style', density, capabilities) ? (
        <label className="mb-4 block text-[12px] text-[var(--muted-foreground)]">
          {t('Style')}
          <input
            value={style}
            onChange={event => onStyle(event.target.value)}
            placeholder={t('Use model default')}
            className={field}
          />
        </label>
      ) : null}

      {showPro && fieldIsVisible('background', density, capabilities) ? (
        <fieldset className="mb-4 text-[12px] text-[var(--muted-foreground)]">
          <legend>{t('Background')}</legend>
          <div className="mt-1 grid grid-cols-3 gap-0.5 rounded-lg bg-[var(--muted)]/50 p-0.5">
            {[
              ['', t('Auto background')],
              ['opaque', t('Opaque background')],
              ['transparent', t('Transparent background')],
            ].map(([value, label]) => (
              <button
                key={value || 'auto'}
                type="button"
                onClick={() => onBackground(value)}
                className={`rounded-md px-2 py-1.5 text-[11px] ${
                  background === value
                    ? 'bg-[var(--background)] font-medium text-[var(--foreground)]'
                    : ''
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}

      {showPro && fieldIsVisible('output_format', density, capabilities) ? (
        <label className="mb-4 block text-[12px] text-[var(--muted-foreground)]">
          {t('Output format')}
          <select
            value={outputFormat}
            onChange={event => onOutputFormat(event.target.value)}
            className={field}
          >
            <option value="">{t('Model default')}</option>
            <option value="png">{t('PNG')}</option>
            <option value="jpeg">{t('JPEG')}</option>
            <option value="webp">{t('WebP')}</option>
          </select>
        </label>
      ) : null}

      {showPro && (selectedModel?.capabilities?.parameters || []).includes('compression') ? (
        <label className="mb-4 block text-[12px] text-[var(--muted-foreground)]">
          {t('Compression')}
          <input
            value={compression}
            onChange={event => onCompression(event.target.value)}
            inputMode="numeric"
            placeholder="80"
            className={field}
          />
        </label>
      ) : null}

      {showPro && resolution && resolution !== 'native' ? (
        <div className="mb-4 rounded-2xl border border-[var(--border)] p-3">
          <p className="text-[12.5px] font-medium text-[var(--foreground)]">{t('Local AI enhancement')}</p>
          <p className="mt-1 text-[12px] leading-5 text-[var(--muted-foreground)]">
            {upscaler?.installed
              ? t('Real-ESRGAN ready · no API fee')
              : upscaler?.supported === false
                ? t('No compatible Vulkan engine · basic resize fallback')
                : t('Downloads once when first needed · {{size}} MB', {
                    size: Math.ceil((upscaler?.download_bytes || 0) / 1048576),
                  })}
          </p>
          {upscaler?.supported && !upscaler.installed ? (
            <button
              type="button"
              disabled={installingUpscaler}
              onClick={onInstallUpscaler}
              className="mt-2 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[12px] disabled:opacity-40"
            >
              {installingUpscaler ? t('Installing…') : t('Install now')}
            </button>
          ) : null}
          <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg bg-[var(--muted)]/60 p-1">
            {(['general', 'illustration'] as const).map(preset => (
              <button
                key={preset}
                type="button"
                onClick={() => onUpscalePreset(preset)}
                className={`rounded-md px-2 py-1.5 text-[10px] ${
                  upscalePreset === preset ? 'bg-[var(--card)] font-medium shadow-sm' : ''
                }`}
              >
                {preset === 'general' ? t('General image') : t('Illustration / anime')}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {models.length === 0 ? (
        <div className="mb-4 text-[12.5px] leading-5 text-[var(--muted-foreground)]">
          <p className="font-medium text-[var(--foreground)]">{t('No image model configured')}</p>
          <p className="mt-1">
            {t('Add an image model and provider connection before creating.')}
          </p>
          <Link
            href="/settings/image"
            className="mt-2 inline-flex text-[var(--primary)] hover:underline"
          >
            {t('Configure image models')}
          </Link>
        </div>
      ) : null}

      {showPro && facts ? (
        <div className="mt-auto rounded-2xl border border-[var(--border)]">
          <button
            type="button"
            onClick={() => onFactsOpen(!factsOpen)}
            className="flex w-full items-center justify-between px-3 py-2 text-[12.5px]"
          >
            {t('Call details')}
            <ChevronDown size={13} className={factsOpen ? 'rotate-180' : ''} />
          </button>
          {factsOpen ? (
            <div className="space-y-1 border-t border-[var(--border)] px-3 py-2 text-[11px] text-[var(--muted-foreground)]">
              <p>
                {t('Service and model')}: {selectedJob?.model_id}
              </p>
              {facts.outputSize ? (
                <p>
                  {t('Output size')}: {facts.outputSize}
                </p>
              ) : null}
              <p>{facts.nativeOutput ? t('Native output') : facts.aiUpscaled ? t('AI upscaled') : t('Basic resize')}</p>
              {facts.device ? (
                <p>
                  {t('Device')}: {facts.device}
                </p>
              ) : null}
              {facts.durationMs ? (
                <p>
                  {t('Elapsed')}: {(facts.durationMs / 1000).toFixed(1)}s
                </p>
              ) : null}
              {facts.warnings.map(warning => (
                <p key={warning} className="text-amber-700 dark:text-amber-300">
                  {warning}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  )
}
