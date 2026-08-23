'use client'

import { Download, Film, ImageIcon, Music2, Play, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type VideoAsset, type VideoJob, videoAssetUrl } from '@/lib/video-studio-api'
import { formatVideoDuration } from '@/lib/video-studio/studio-logic'

export function VideoPreview({ asset, job }: { asset?: VideoAsset; job?: VideoJob }) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)

  if (!asset) {
    return (
      <div className="flex h-full min-h-[260px] flex-col items-center justify-center overflow-hidden rounded-2xl border border-[var(--border)] bg-[radial-gradient(circle_at_50%_30%,var(--muted),transparent_65%)] text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--background)] shadow-sm">
          <Play size={22} className="ml-1 text-[var(--primary)]" />
        </span>
        <h2 className="mt-4 text-base font-semibold">{t('Your next shot starts here')}</h2>
        <p className="mt-1 max-w-sm px-6 text-xs leading-5 text-[var(--muted-foreground)]">
          {t('Describe a scene, choose a model, and keep every result organized in the storyboard.')}
        </p>
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-h-[260px] items-center justify-center overflow-hidden rounded-2xl border border-[var(--border)] bg-black shadow-sm">
      {failed ? (
        <div className="flex flex-col items-center text-center text-white/75">
          <TriangleAlert size={24} />
          <p className="mt-2 text-xs">{t('This media could not be loaded.')}</p>
        </div>
      ) : asset.kind === 'video' ? (
        <video
          key={asset.id}
          src={videoAssetUrl(asset.id)}
          controls
          playsInline
          preload="metadata"
          onError={() => setFailed(true)}
          className="h-full max-h-full w-full object-contain"
        />
      ) : asset.kind === 'image' ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={videoAssetUrl(asset.id)}
          alt={asset.filename}
          onError={() => setFailed(true)}
          className="h-full max-h-full w-full object-contain"
        />
      ) : (
        <div className="flex flex-col items-center text-white/70">
          <Music2 size={30} />
          <audio
            key={asset.id}
            src={videoAssetUrl(asset.id)}
            controls
            onError={() => setFailed(true)}
            className="mt-4"
          />
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 bg-gradient-to-b from-black/60 to-transparent p-3 text-white">
        <div className="min-w-0 flex-1 pr-2">
          <p className="truncate text-xs font-medium">{asset.filename}</p>
          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-white/65">
            {asset.kind === 'video' ? <Film size={11} /> : asset.kind === 'image' ? <ImageIcon size={11} /> : <Music2 size={11} />}
            {asset.duration ? formatVideoDuration(asset.duration) : t(asset.kind)}
            {job?.parameters?.resolution ? ` · ${String(job.parameters.resolution)}` : ''}
          </p>
        </div>
        <a
          href={videoAssetUrl(asset.id)}
          download={asset.filename}
          className="pointer-events-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-black/40 px-2.5 text-[11px] backdrop-blur hover:bg-black/60"
        >
          <Download size={13} /> {t('Download')}
        </a>
      </div>
    </div>
  )
}
