'use client'

import { useState, type ReactNode } from 'react'
import {
  Download,
  Heart,
  Images,
  MoreHorizontal,
  Paintbrush,
  RefreshCw,
  Sparkles,
  Trash2,
  WandSparkles,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { studioAssetUrl, type StudioAsset, type StudioJob } from '@/lib/image-studio-api'
import { BOARD_ASSET_MIME } from '@/lib/image-studio/board-logic'
import { jobFactStrip } from '@/lib/image-studio/studio-logic'

export function StudioResultGrid({
  assets,
  jobs,
  selectedId,
  onSelect,
  onEdit,
  onVary,
  onReference,
  onCanvas,
  onEnhance,
  onFavorite,
  onDelete,
  onRetry,
  onReuseParams,
  modelName,
}: {
  assets: StudioAsset[]
  jobs: StudioJob[]
  selectedId: string | null
  onSelect: (assetId: string) => void
  onEdit: (assetId: string) => void
  onVary: (assetId: string) => void
  onReference: (assetId: string) => void
  onCanvas: (assetId: string) => void
  onEnhance: (assetId: string) => void
  onFavorite: (asset: StudioAsset) => void
  onDelete: (assetId: string) => void
  onRetry: (jobId: string) => void
  /** Restore this job's prompt + requested params into the composer. */
  onReuseParams: (job: StudioJob) => void
  modelName: (job: StudioJob) => string
}) {
  const { t } = useTranslation()
  const [openMore, setOpenMore] = useState<string | null>(null)
  const [factsId, setFactsId] = useState<string | null>(null)
  const jobByAsset = new Map<string, StudioJob>()
  for (const job of jobs) {
    for (const output of job.outputs || []) jobByAsset.set(output.asset_id, job)
  }

  return (
    <div
      data-studio-result-grid=""
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
    >
      {assets.map(asset => {
        const job = jobByAsset.get(asset.id)
        const selected = selectedId === asset.id
        const facts = job ? jobFactStrip(job) : null
        return (
          <article
            key={asset.id}
            data-studio-result=""
            data-selected={selected ? 'true' : 'false'}
            className={`group relative overflow-hidden rounded-2xl border bg-[var(--card)] transition-colors ${
              selected ? 'border-[var(--ring)]' : 'border-[var(--border)] hover:border-[var(--ring)]'
            }`}
          >
            <button
              type="button"
              draggable
              onDragStart={event => event.dataTransfer.setData(BOARD_ASSET_MIME, asset.id)}
              onClick={() => onSelect(asset.id)}
              className="block w-full overflow-hidden bg-[var(--muted)]/40"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={studioAssetUrl(asset.id)}
                alt={t('Generated result')}
                className="aspect-square w-full object-cover"
              />
            </button>
            <div
              data-studio-result-actions=""
              className={`absolute top-2 right-2 flex items-center gap-0.5 rounded-xl bg-[var(--card)]/92 p-0.5 backdrop-blur-sm transition ${
                selected
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
              }`}
            >
              <Action icon={<Paintbrush size={13} />} label={t('Edit')} onClick={() => onEdit(asset.id)} />
              <Action
                icon={<Sparkles size={13} />}
                label={t('Generate variations')}
                onClick={() => onVary(asset.id)}
              />
              <Action
                icon={<Images size={13} />}
                label={t('Use as reference')}
                onClick={() => onReference(asset.id)}
              />
              <Action
                icon={<Paintbrush size={13} />}
                label={t('Enter canvas')}
                onClick={() => onCanvas(asset.id)}
              />
              <Action
                icon={<WandSparkles size={13} />}
                label={t('HD enhance')}
                onClick={() => onEnhance(asset.id)}
              />
              <a
                href={studioAssetUrl(asset.id)}
                download
                title={t('Download')}
                className="rounded-lg p-1.5 text-[var(--foreground)] hover:bg-[var(--muted)]/60"
              >
                <Download size={13} />
              </a>
              <Action
                icon={<Heart size={13} fill={asset.favorite ? 'currentColor' : 'none'} />}
                label={t('Favorite')}
                onClick={() => onFavorite(asset)}
              />
              <div className="relative">
                <Action
                  icon={<MoreHorizontal size={13} />}
                  label={t('More actions')}
                  onClick={() => setOpenMore(current => (current === asset.id ? null : asset.id))}
                />
                {openMore === asset.id ? (
                  <div className="absolute top-full right-0 z-10 mt-1 w-36 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--popover)] py-1 shadow-lg">
                    <button
                      type="button"
                      disabled={!job}
                      onClick={() => {
                        if (job) onReuseParams(job)
                        setOpenMore(null)
                      }}
                      className="block w-full rounded-lg px-2 py-1.5 text-left text-[11px] hover:bg-[var(--muted)] disabled:opacity-40"
                    >
                      {t('Reuse parameters')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setFactsId(asset.id)
                        setOpenMore(null)
                      }}
                      className="block w-full rounded-lg px-2 py-1.5 text-left text-[11px] hover:bg-[var(--muted)]"
                    >
                      {t('Show technical details')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onDelete(asset.id)
                        setOpenMore(null)
                      }}
                      className="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left text-[11px] text-red-600 hover:bg-red-500/10"
                    >
                      <Trash2 size={12} />
                      {t('Delete image')}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
            {job ? (
              <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 text-[10px] text-[var(--muted-foreground)]">
                <span className="max-w-[8rem] truncate">{modelName(job)}</span>
                {facts?.outputSize ? <span>{facts.outputSize}</span> : null}
                {facts?.nativeOutput ? <span>{t('Native output')}</span> : null}
                {facts?.aiUpscaled ? <span className="text-amber-700 dark:text-amber-300">{t('AI upscaled')}</span> : null}
                {job.status === 'failed' ? (
                  <button
                    type="button"
                    onClick={() => onRetry(job.id)}
                    className="ml-auto inline-flex items-center gap-1 text-red-600"
                  >
                    <RefreshCw size={10} />
                    {t('Retry task')}
                  </button>
                ) : null}
              </div>
            ) : null}
            {factsId === asset.id && facts ? (
              <div className="border-t border-[var(--border)] px-2 py-2 text-[10px] text-[var(--muted-foreground)]">
                {facts.upscaleModel ? (
                  <p>
                    {t('Upscale model')}: {facts.upscaleModel}
                  </p>
                ) : null}
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
                <button type="button" onClick={() => setFactsId(null)} className="mt-1 underline">
                  {t('Hide technical details')}
                </button>
              </div>
            ) : null}
          </article>
        )
      })}
    </div>
  )
}

function Action({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className="rounded-lg p-1.5 text-[var(--foreground)] hover:bg-[var(--muted)]/60"
    >
      {icon}
      <span className="sr-only">{label}</span>
    </button>
  )
}
