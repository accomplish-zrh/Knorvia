'use client'

import { ChevronDown, Coins, Download, Film, HardDriveDownload, Loader2, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type VideoAsset,
  type VideoComposition,
  type VideoFfmpegStatus,
  type VideoJob,
  type VideoStoryboardShot,
} from '@/lib/video-studio-api'
import {
  estimateVideoCostYuan,
  formatVideoDuration,
  formatYuan,
  jobBilledSeconds,
} from '@/lib/video-studio/studio-logic'
import {
  SUBTITLE_FONT_SIZE_MAX,
  SUBTITLE_FONT_SIZE_MIN,
  SUBTITLE_SOURCE_MODES,
  SUBTITLE_STYLE_OPTIONS,
  type SubtitleSourceMode,
  clampSubtitleFontSize,
  hexToAssColour,
} from '@/lib/video-studio/subtitle-logic'
import { SubtitleEditor } from './SubtitleEditor'

const RESOLUTIONS = ['480p', '720p', '1080p'] as const

/** §Phase D2 burn-in style presets (subtitle-logic keys → localized labels). */
const SUBTITLE_STYLE_LABELS: Record<string, string> = {
  clean: 'Clean white',
  yellow_box: 'Yellow on black',
  outline_large: 'Large outlined',
  high_contrast: 'High contrast',
}

/** §Phase D2 caption sources: off / from_notes (A3) / from_asr (D1 STT) / from_asset. */
const SUBTITLE_MODE_LABELS: Record<SubtitleSourceMode, string> = {
  off: 'Off',
  from_notes: 'From narration and notes',
  from_asr: 'From audio (ASR)',
  from_asset: 'From saved subtitle file',
}

export type VideoComposeConfig = {
  subtitle_mode: SubtitleSourceMode
  /** Preset key ('clean'…) or raw force_style; empty = filter defaults. */
  subtitle_style: string
  /** Required when subtitle_mode is from_asset. */
  srt_asset_id: string
  /** §E2 burn-in FontSize override (12–72); null = preset default. */
  subtitle_font_size: number | null
  /** §E2 burn-in PrimaryColour override (ASS &H format); '' = preset default. */
  subtitle_primary_colour: string
  resolution: '480p' | '720p' | '1080p'
  voiceovers: boolean
  bgm_asset_id: string
  /** §E5 experimental frame-by-frame upscale before stitching (forces 1080p). */
  upscale: boolean
}

function compositionLabel(job: VideoComposition['job'], t: (key: string, options?: Record<string, unknown>) => string) {
  const created = new Date(job.created_at)
  const stamp = Number.isNaN(created.getTime())
    ? ''
    : created.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const status =
    job.status === 'succeeded'
      ? t('succeeded')
      : job.status === 'failed'
        ? t('failed')
        : job.status === 'cancelled'
          ? t('Cancelled')
          : job.status
  return stamp ? `${stamp} · ${status}` : status
}

export function VideoComposePanel({
  projectId,
  shots,
  assets,
  jobs,
  compositions,
  ffmpeg,
  installingFfmpeg,
  busy,
  assetUrl,
  bgmAssetId,
  onBgmAssetId,
  onSubmit,
  onInstallFfmpeg,
  onAssetSaved,
  priceHints,
}: {
  projectId: string
  shots: VideoStoryboardShot[]
  assets: VideoAsset[]
  jobs: VideoJob[]
  compositions: VideoComposition[]
  ffmpeg: VideoFfmpegStatus | null
  installingFfmpeg: boolean
  busy: boolean
  assetUrl: (assetId: string) => string
  /** §F1 lifted state: the music bed also drives the timeline's BGM band. */
  bgmAssetId: string
  onBgmAssetId: (assetId: string) => void
  onSubmit: (config: VideoComposeConfig) => void
  onInstallFfmpeg: () => void
  onAssetSaved?: (asset: VideoAsset) => void
  /** §F5 per-model ¥/s hints for a display-only clip-cost estimate. */
  priceHints?: Record<string, number>
}) {
  const { t } = useTranslation()
  const [subtitleMode, setSubtitleMode] = useState<SubtitleSourceMode>('from_notes')
  const [subtitleStyle, setSubtitleStyle] = useState('')
  const [srtAssetId, setSrtAssetId] = useState('')
  const [subtitleFontSize, setSubtitleFontSize] = useState('')
  const [subtitleColour, setSubtitleColour] = useState('')
  const [resolution, setResolution] = useState<'480p' | '720p' | '1080p'>('720p')
  const [upscale, setUpscale] = useState(false)
  const [voiceovers, setVoiceovers] = useState(true)

  const audioAssets = assets.filter(asset => asset.kind === 'audio')
  const subtitleAssets = assets.filter(asset => asset.kind === 'subtitle')
  const composable = shots.filter(shot => shot.output_asset_id || shot.keyframe_asset_id)
  const totalSeconds = composable.reduce((sum, shot) => sum + (shot.duration || 0), 0)
  const composingJob = jobs.find(
    job => (job.operation as string) === 'compose' && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status)
  )
  const ffmpegReady = ffmpeg?.available === true
  const missingSrtAsset = subtitleMode === 'from_asset' && !srtAssetId
  const fontSizeValue = subtitleMode === 'off' ? null : clampSubtitleFontSize(subtitleFontSize)
  const fontSizeInvalid = subtitleMode !== 'off' && subtitleFontSize.trim() !== '' && fontSizeValue === null
  const colourOverride = subtitleMode === 'off' ? '' : subtitleColour ? hexToAssColour(subtitleColour) || '' : ''
  const canCompose =
    ffmpegReady &&
    composable.length > 0 &&
    !busy &&
    !composingJob &&
    !missingSrtAsset &&
    !fontSizeInvalid
  // §F5: sum of the per-shot generation estimates for takes whose model has a
  // user-entered unit price — the composition itself is always free/local.
  const clipCostTotal = priceHints
    ? composable.reduce((total, shot) => {
        if (!shot.job_id) return total
        const job = jobs.find(item => item.id === shot.job_id)
        if (!job) return total
        const estimate = estimateVideoCostYuan(
          priceHints[`${job.profile_id}:${job.model_id}`],
          jobBilledSeconds(job)
        )
        return total + (estimate ?? 0)
      }, 0)
    : null
  const clipCost = clipCostTotal != null && clipCostTotal > 0 ? Math.round(clipCostTotal * 100) / 100 : null

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--card)]" aria-label={t('Export composition')}>
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="text-[11.5px] font-semibold">{t('Export composition')}</h2>
            <span className="text-[9.5px] text-[var(--muted-foreground)]">
              {t('{{count}} shot(s) ready', { count: composable.length })}
              {totalSeconds > 0 ? ` · ${formatVideoDuration(totalSeconds)}` : ''}
            </span>
            {clipCost != null ? (
              <span
                data-compose-cost=""
                className="inline-flex items-center gap-1 rounded bg-[var(--muted)] px-1.5 py-0.5 text-[8.5px] text-[var(--muted-foreground)]"
              >
                <Coins size={9} />
                {t('Clip cost {{cost}} (at your unit price)', { cost: formatYuan(clipCost) })}
              </span>
            ) : null}
          </div>
          <p className="truncate text-[9px] text-[var(--muted-foreground)]">
            {t('Stitches every shot (video or keyframe placeholder) into one MP4 locally — free, no provider cost.')}
          </p>
        </div>
      </div>

      {!ffmpegReady ? (
        <div className="mx-3 mb-2.5 flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5 text-[10.5px]">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-medium text-amber-700">
              <HardDriveDownload size={13} /> {t('Local composition engine is not installed')}
            </div>
            <p className="mt-0.5 text-[9px] text-amber-700/85">
              {ffmpeg?.install_supported
                ? t('Install FFmpeg (about {{size}}MB, one-time download) to compose MP4s locally.', {
                    size: Math.max(1, Math.round((ffmpeg?.download_bytes || 0) / 1_000_000)),
                  })
                : t('Install FFmpeg on this machine (or set KNORVIA_FFMPEG_DIR) to enable local composition.')}
            </p>
          </div>
          {ffmpeg?.install_supported ? (
            <button
              type="button"
              disabled={installingFfmpeg}
              onClick={onInstallFfmpeg}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-2.5 text-[10.5px] font-medium text-white hover:bg-amber-700 disabled:opacity-60"
            >
              {installingFfmpeg ? <Loader2 size={13} className="animate-spin" /> : <HardDriveDownload size={13} />}
              {installingFfmpeg ? t('Installing…') : t('Install engine')}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-2 border-t border-[var(--border)]/55 px-3 py-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1 text-[9px] text-[var(--muted-foreground)]">
          {t('Subtitles')}
          <select
            data-subtitle-mode=""
            value={subtitleMode}
            onChange={event => setSubtitleMode(event.target.value as SubtitleSourceMode)}
            className="h-8 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[10.5px] text-[var(--foreground)] outline-none"
          >
            {SUBTITLE_SOURCE_MODES.map(mode => (
              <option key={mode} value={mode}>{t(SUBTITLE_MODE_LABELS[mode])}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[9px] text-[var(--muted-foreground)]">
          {t('Subtitle style')}
          <select
            data-subtitle-style=""
            value={subtitleStyle}
            onChange={event => setSubtitleStyle(event.target.value)}
            disabled={subtitleMode === 'off'}
            className="h-8 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[10.5px] text-[var(--foreground)] outline-none disabled:opacity-50"
          >
            <option value="">{t('Default')}</option>
            {SUBTITLE_STYLE_OPTIONS.map(style => (
              <option key={style} value={style}>{t(SUBTITLE_STYLE_LABELS[style])}</option>
            ))}
          </select>
        </label>
        {subtitleMode === 'from_asset' ? (
          <label className="flex flex-col gap-1 text-[9px] text-[var(--muted-foreground)]">
            {t('Subtitle file')}
            <select
              data-subtitle-asset=""
              value={srtAssetId}
              onChange={event => setSrtAssetId(event.target.value)}
              className="h-8 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[10.5px] text-[var(--foreground)] outline-none"
            >
              <option value="">{t('Select a subtitle file')}</option>
              {subtitleAssets.map(asset => (
                <option key={asset.id} value={asset.id}>{asset.filename}</option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-[9px] text-[var(--muted-foreground)]">
          {t('Resolution')}
          <select
            value={upscale ? '1080p' : resolution}
            onChange={event => {
              const next = event.target.value as '480p' | '720p' | '1080p'
              setResolution(next)
              if (upscale && next !== '1080p') setUpscale(false)
            }}
            disabled={upscale}
            className="h-8 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[10.5px] text-[var(--foreground)] outline-none disabled:opacity-50"
          >
            {RESOLUTIONS.map(item => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>
        {subtitleMode !== 'off' ? (
          <>
            <label className="flex flex-col gap-1 text-[9px] text-[var(--muted-foreground)]">
              {t('Subtitle size')}
              <input
                data-subtitle-font-size=""
                type="number"
                inputMode="numeric"
                min={SUBTITLE_FONT_SIZE_MIN}
                max={SUBTITLE_FONT_SIZE_MAX}
                step={1}
                value={subtitleFontSize}
                placeholder={t('Preset default')}
                onChange={event => setSubtitleFontSize(event.target.value)}
                className={`h-8 rounded-lg border bg-[var(--background)] px-2 text-[10.5px] text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]/70 ${
                  fontSizeInvalid ? 'border-red-500/70' : 'border-[var(--border)]'
                }`}
              />
            </label>
            <label className="flex flex-col gap-1 text-[9px] text-[var(--muted-foreground)]">
              {t('Subtitle colour')}
              <div className="flex items-center gap-1.5">
                <input
                  data-subtitle-colour=""
                  type="color"
                  value={subtitleColour || '#ffffff'}
                  onChange={event => setSubtitleColour(event.target.value)}
                  aria-label={t('Subtitle colour')}
                  className="h-8 w-9 shrink-0 cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--background)] p-0.5"
                />
                <span className="min-w-0 flex-1 truncate rounded-lg bg-[var(--muted)]/25 px-2 py-1 text-[9.5px] leading-none text-[var(--muted-foreground)]">
                  {subtitleColour ? subtitleColour.toUpperCase() : t('Preset default')}
                </span>
                {subtitleColour ? (
                  <button
                    type="button"
                    onClick={() => setSubtitleColour('')}
                    className="h-8 shrink-0 rounded-lg border border-[var(--border)] px-2 text-[9.5px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]/45"
                  >
                    {t('Reset')}
                  </button>
                ) : null}
              </div>
            </label>
          </>
        ) : null}
        <label className="flex flex-col gap-1 text-[9px] text-[var(--muted-foreground)]">
          {t('Background music')}
          <select
            value={bgmAssetId}
            onChange={event => onBgmAssetId(event.target.value)}
            className="h-8 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[10.5px] text-[var(--foreground)] outline-none"
          >
            <option value="">{t('None')}</option>
            {audioAssets.map(asset => (
              <option key={asset.id} value={asset.id}>{asset.filename}</option>
            ))}
          </select>
        </label>
        <div className="flex items-end justify-between gap-2">
          <div className="flex flex-col gap-1 pb-1.5">
            <label className="inline-flex items-center gap-1.5 text-[10px] leading-tight text-[var(--muted-foreground)]">
              <input
                type="checkbox"
                checked={voiceovers}
                onChange={event => setVoiceovers(event.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--primary)]"
              />
              {t('Include narrations')}
            </label>
            <label className="inline-flex items-center gap-1.5 text-[10px] leading-tight text-[var(--muted-foreground)]">
              <input
                data-upscale-toggle=""
                type="checkbox"
                checked={upscale}
                onChange={event => {
                  const next = event.target.checked
                  setUpscale(next)
                  if (next) setResolution('1080p')
                }}
                className="h-3.5 w-3.5 accent-[var(--primary)]"
              />
              <span>
                {t('Upscale to 1080p')}
                <span className="ml-1 rounded bg-amber-500/15 px-1 py-px text-[8.5px] text-amber-700">
                  {t('Experimental')}
                </span>
              </span>
            </label>
          </div>
          <button
            type="button"
            disabled={!canCompose}
            onClick={() =>
              onSubmit({
                subtitle_mode: subtitleMode,
                subtitle_style: subtitleMode === 'off' ? '' : subtitleStyle,
                srt_asset_id: subtitleMode === 'from_asset' ? srtAssetId : '',
                subtitle_font_size: fontSizeValue,
                subtitle_primary_colour: colourOverride,
                resolution: upscale ? '1080p' : resolution,
                voiceovers,
                bgm_asset_id: bgmAssetId,
                upscale,
              })
            }
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy || composingJob ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {composingJob ? t('Composing…') : t('Compose MP4')}
          </button>
        </div>
      </div>

      {fontSizeInvalid ? (
        <p className="mx-3 mb-2 rounded-lg border border-red-500/30 bg-red-500/[0.06] px-2.5 py-1.5 text-[9.5px] text-red-600">
          {t('Subtitle size must be a whole number between {{min}} and {{max}}.', {
            min: SUBTITLE_FONT_SIZE_MIN,
            max: SUBTITLE_FONT_SIZE_MAX,
          })}
        </p>
      ) : null}

      {upscale ? (
        <p className="mx-3 mb-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 text-[9.5px] text-amber-700">
          {t('Upscaling re-renders every sub-1080p shot frame by frame before stitching — much slower, output is locked to 1080p.')}
        </p>
      ) : null}

      {missingSrtAsset ? (
        <p className="mx-3 mb-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 text-[9.5px] text-amber-700">
          {t('Pick or save a subtitle file below, then compose.')}
        </p>
      ) : null}

      <details className="group border-t border-[var(--border)]/55 px-3 py-2">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-[10.5px] text-[var(--muted-foreground)] [&::-webkit-details-marker]:hidden">
          <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
          {t('Subtitle editor')}
          <span className="text-[9px]">
            {subtitleAssets.length
              ? t('{{count}} saved subtitle file(s)', { count: subtitleAssets.length })
              : t('Edit cues and save them as a project asset')}
          </span>
        </summary>
        <div className="mt-2">
          <SubtitleEditor
            projectId={projectId}
            assets={assets}
            onAssetSaved={asset => {
              setSrtAssetId(asset.id)
              onAssetSaved?.(asset)
            }}
          />
        </div>
      </details>

      {composingJob ? (
        <div className="mx-3 mb-2.5 rounded-xl border border-[var(--primary)]/25 bg-[var(--primary)]/[0.05] px-3 py-2">
          <div className="flex items-center justify-between text-[10px]">
            <span className="inline-flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> {composingJob.stage || t('Composing')}
            </span>
            <span className="text-[var(--muted-foreground)]">{Math.round((composingJob.progress || 0) * 100)}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--muted)]">
            <div
              className="h-full rounded-full bg-[var(--primary)] transition-[width]"
              style={{ width: `${Math.round((composingJob.progress || 0) * 100)}%` }}
            />
          </div>
        </div>
      ) : null}

      {compositions.length ? (
        <div className="border-t border-[var(--border)]/55 px-3 py-2.5">
          <h3 className="mb-1.5 text-[9.5px] font-medium text-[var(--muted-foreground)]">
            {t('Finished compositions')}
          </h3>
          <ul className="flex flex-col gap-2">
            {compositions.slice(0, 6).map(item => (
              <li
                key={item.job.id}
                className="flex flex-col gap-1.5 rounded-xl border border-[var(--border)]/60 bg-[var(--muted)]/15 p-2 sm:flex-row sm:items-center"
              >
                {item.asset ? (
                  <video
                    key={item.asset.id}
                    controls
                    preload="metadata"
                    src={assetUrl(item.asset.id)}
                    className="h-20 w-full rounded-lg bg-black sm:w-36"
                  />
                ) : (
                  <span className="flex h-20 w-full items-center justify-center rounded-lg bg-[var(--muted)]/40 text-[var(--muted-foreground)] sm:w-36">
                    <Film size={18} strokeWidth={1.4} />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[10.5px] font-medium">
                    {compositionLabel(item.job, t)}
                  </div>
                  <div className="truncate text-[9px] text-[var(--muted-foreground)]">
                    {item.asset
                      ? `${item.asset.filename} · ${formatVideoDuration(item.asset.duration || 0)}`
                      : item.job.error_message || item.job.error_code || ''}
                  </div>
                </div>
                {item.asset ? (
                  <a
                    href={assetUrl(item.asset.id)}
                    download={item.asset.filename}
                    aria-label={t('Download composition')}
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] px-2 text-[10px] hover:bg-[var(--muted)]/45"
                  >
                    <Download size={11} /> {t('Download')}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

export const COMPOSE_SUBTITLE_MODES = SUBTITLE_SOURCE_MODES
