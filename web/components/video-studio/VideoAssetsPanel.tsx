'use client'

import { Check, FileImage, Film, Loader2, Music2, Plus, Trash2, Upload } from 'lucide-react'
import { useCallback, useRef, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { type VideoAsset } from '@/lib/video-studio-api'
import { videoAssetUrl } from '@/lib/video-studio-api'
import { useClipboardImagePaste } from '@/lib/clipboard-image-paste'
import { VIDEO_ASSET_DRAG_MIME } from '@/components/video-studio/VideoInfiniteBoard'

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function AssetVisual({ asset }: { asset: VideoAsset }) {
  if (asset.kind === 'image') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={videoAssetUrl(asset.id)}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover"
      />
    )
  }
  const Icon = asset.kind === 'audio' ? Music2 : asset.kind === 'video' ? Film : FileImage
  return (
    <span className="flex h-full w-full items-center justify-center bg-[var(--muted)]/45 text-[var(--muted-foreground)]">
      <Icon size={24} strokeWidth={1.4} />
    </span>
  )
}

export function VideoAssetsPanel({
  assets,
  selectedIds,
  loading,
  uploading,
  uploadProgress,
  onUpload,
  onToggle,
  onPreview,
  onDelete,
  canLoadMore,
  onLoadMore,
}: {
  assets: VideoAsset[]
  selectedIds: string[]
  loading?: boolean
  uploading?: boolean
  uploadProgress?: number
  onUpload: (files: File[]) => void
  onToggle: (asset: VideoAsset) => void
  onPreview: (asset: VideoAsset) => void
  onDelete: (asset: VideoAsset) => void
  canLoadMore?: boolean
  onLoadMore?: () => void
}) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handlePaste = useCallback(
    (files: File[]) => {
      if (!uploading) onUpload(files)
    },
    [onUpload, uploading]
  )
  useClipboardImagePaste(handlePaste)

  const acceptFiles = (files: FileList | null) => {
    const accepted = Array.from(files || []).filter(file =>
      /^(image\/(png|jpeg|webp)|video\/(mp4|webm)|audio\/(mpeg|wav|mp4|x-m4a))$/i.test(file.type)
    )
    if (accepted.length) onUpload(accepted)
  }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    acceptFiles(event.dataTransfer.files)
  }

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t('Project assets')}>
      <div className="flex items-center justify-between px-3.5 py-3">
        <div>
          <h2 className="text-xs font-semibold">{t('Project assets')}</h2>
          <p className="mt-0.5 text-[10.5px] text-[var(--muted-foreground)]">
            {t('{{count}} asset(s)', { count: assets.length })}
          </p>
        </div>
        <button
          type="button"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-2.5 text-[11.5px] font-medium text-[var(--primary-foreground)] disabled:opacity-50"
        >
          {uploading ? <Loader2 size={13} className="animate-spin" /> : <Plus size={14} />}
          {t('Add')}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/mp4,audio/x-m4a"
          className="hidden"
          onChange={event => {
            acceptFiles(event.target.files)
            event.target.value = ''
          }}
        />
      </div>
      <div
        onDragEnter={event => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragOver={event => event.preventDefault()}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={onDrop}
        className={`mx-3 mb-3 flex min-h-16 items-center justify-center rounded-xl border border-dashed px-3 text-center text-[10.5px] transition-colors ${
          dragging
            ? 'border-[var(--primary)] bg-[var(--primary)]/[0.06] text-[var(--primary)]'
            : 'border-[var(--border)] text-[var(--muted-foreground)]'
        }`}
      >
        <span className="inline-flex items-center gap-2">
          <Upload size={14} /> {t('Drop images, videos, or audio here')} · {t('Ctrl+V pastes images')}
        </span>
      </div>
      {uploading ? (
        <div className="mx-3 mb-3" role="status" aria-live="polite">
          <div className="mb-1 flex justify-between text-[10px] text-[var(--muted-foreground)]">
            <span>{t('Uploading and verifying')}</span>
            <span>{Math.round((uploadProgress || 0) * 100)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--muted)]">
            <div
              className="h-full rounded-full bg-[var(--primary)] transition-[width]"
              style={{ width: `${Math.round((uploadProgress || 0) * 100)}%` }}
            />
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {loading ? (
          <div className="flex h-32 items-center justify-center text-[var(--muted-foreground)]">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : assets.length ? (
          <div className="grid grid-cols-2 gap-2">
            {assets.map(asset => {
              const selected = selectedIds.includes(asset.id)
              return (
                <div
                  key={asset.id}
                  draggable
                  onDragStart={event => {
                    // Canvas drop target (§5.6): role-tagged payload, plain id fallback.
                    event.dataTransfer.setData(
                      VIDEO_ASSET_DRAG_MIME,
                      JSON.stringify({ assetId: asset.id, kind: asset.kind })
                    )
                    event.dataTransfer.setData('text/plain', asset.id)
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                  className={`group relative overflow-hidden rounded-xl border bg-[var(--card)] ${
                    selected ? 'border-[var(--primary)] ring-2 ring-[var(--primary)]/15' : 'border-[var(--border)]'
                  }`}
                >
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-label={t('Use {{name}} as input', { name: asset.filename })}
                    onClick={() => onToggle(asset)}
                    onDoubleClick={() => onPreview(asset)}
                    className="block w-full text-left"
                  >
                    <span className="relative block aspect-video overflow-hidden">
                      <AssetVisual asset={asset} />
                      {selected ? (
                        <span className="absolute top-1.5 left-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)]">
                          <Check size={12} />
                        </span>
                      ) : null}
                    </span>
                    <span className="block px-2 py-1.5">
                      <span className="block truncate text-[10.5px] font-medium">{asset.filename}</span>
                      <span className="mt-0.5 block text-[9.5px] text-[var(--muted-foreground)]">
                        {t(asset.kind === 'audio' ? 'Audio' : asset.kind === 'video' ? 'Video' : 'Image')} · {formatBytes(asset.size_bytes)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(asset)}
                    aria-label={t('Delete {{name}}', { name: asset.filename })}
                    className="absolute top-1.5 right-1.5 rounded-md bg-black/55 p-1 text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex h-40 flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border)] text-center text-[var(--muted-foreground)]">
            <Film size={22} strokeWidth={1.4} />
            <p className="mt-2 text-[11px]">{t('No project assets yet')}</p>
          </div>
        )}
        {canLoadMore ? (
          <button
            type="button"
            onClick={onLoadMore}
            className="mt-3 w-full rounded-lg border border-[var(--border)] py-2 text-[11px] hover:bg-[var(--muted)]/45"
          >
            {t('Load more')}
          </button>
        ) : null}
      </div>
    </section>
  )
}
