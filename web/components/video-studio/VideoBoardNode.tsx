'use client'

import { memo, useEffect, useRef, useState } from 'react'
import { Clapperboard, Dices, Film, History, ImageIcon, Loader2, Music2, Sparkles, Type, Video } from 'lucide-react'
import type { VideoBoardEdgeRole, VideoBoardNode as VideoBoardNodeModel } from '@/lib/video-studio/board-logic'
import { formatVideoDuration } from '@/lib/video-studio/studio-logic'
import type { VideoBoardLabels } from './VideoInfiniteBoard'
import { useArmedPaidAction } from './useArmedPaidAction'

export type VideoBoardJobState = { status: string; progress: number | null; stage: string | null }

export type VideoBoardNodeProps = {
  node: VideoBoardNodeModel
  selected: boolean
  connecting: boolean
  labels: VideoBoardLabels
  assetUrl: (assetId: string) => string
  job?: VideoBoardJobState | null
  onPointerDown?: (event: React.PointerEvent, nodeId: string) => void
  onConnectStart?: (event: React.PointerEvent, nodeId: string) => void
  onOpen?: (nodeId: string) => void
  readOnly?: boolean
  /** Additive (optional) wiring used by VideoInfiniteBoard. */
  incomingRoles?: VideoBoardEdgeRole[]
  connectTarget?: boolean
  onTextChange?: (nodeId: string, text: string) => void
  onGenerate?: (nodeId: string) => void
  /** §Phase C5: paid reroll of this card's latest take (two-step confirm). */
  onReroll?: (nodeId: string) => void
  /** §Phase C5: how many takes this card has already run. */
  variantCount?: number
}

export const VIDEO_ROLE_STROKE: Record<VideoBoardEdgeRole, string> = {
  reference: 'rgb(148 163 184 / 0.8)',
  'first-frame': 'rgb(52 211 153 / 0.9)',
  'last-frame': 'rgb(251 146 60 / 0.9)',
  audio: 'rgb(167 139 250 / 0.9)',
  'continue-from': 'rgb(56 189 248 / 0.9)',
}

const VIDEO_ROLE_DOT: Record<VideoBoardEdgeRole, string> = {
  reference: '#94a3b8',
  'first-frame': '#34d399',
  'last-frame': '#fb923c',
  audio: '#a78bfa',
  'continue-from': '#38bdf8',
}

export function videoBoardRoleLabel(role: VideoBoardEdgeRole, labels: VideoBoardLabels): string {
  if (role === 'first-frame') return labels.firstFrame
  if (role === 'last-frame') return labels.lastFrame
  if (role === 'audio') return labels.audioRole
  if (role === 'continue-from') return labels.continueFrom
  return labels.reference
}

type StatusTone = 'running' | 'queued' | 'failed' | 'succeeded' | 'unknown'

function statusTone(status: string): StatusTone {
  if (status === 'running' || status === 'submitting') return 'running'
  if (status === 'queued') return 'queued'
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') return 'failed'
  if (status === 'succeeded') return 'succeeded'
  return 'unknown'
}

function statusText(tone: StatusTone, labels: VideoBoardLabels): string {
  if (tone === 'running') return labels.running
  if (tone === 'queued') return labels.queued
  if (tone === 'failed') return labels.failed
  if (tone === 'succeeded') return labels.succeeded
  return labels.unknown
}

function waveHeights(seed: string, count = 26): number[] {
  let value = 7
  for (let index = 0; index < seed.length; index += 1) {
    value = (value * 31 + seed.charCodeAt(index)) >>> 0
  }
  const heights: number[] = []
  for (let index = 0; index < count; index += 1) {
    value = (value * 1103515245 + 12345) >>> 0
    heights.push(28 + ((value >>> 16) % 68))
  }
  return heights
}

function RoleBadges({ roles, labels }: { roles: VideoBoardEdgeRole[] | undefined; labels: VideoBoardLabels }) {
  const unique = Array.from(new Set(roles || []))
  if (!unique.length) return null
  return (
    <div className="pointer-events-none absolute top-1.5 left-1.5 z-10 flex max-w-[calc(100%-12px)] flex-wrap gap-1">
      {unique.map(role => (
        <span
          key={role}
          className="inline-flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[9px] leading-none whitespace-nowrap text-white backdrop-blur-sm"
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: VIDEO_ROLE_DOT[role] }} />
          {videoBoardRoleLabel(role, labels)}
        </span>
      ))}
    </div>
  )
}

function StatusPill({ tone, labels }: { tone: StatusTone; labels: VideoBoardLabels }) {
  const toneClass =
    tone === 'running'
      ? 'bg-sky-500/15 text-sky-500'
      : tone === 'succeeded'
        ? 'bg-emerald-500/15 text-emerald-500'
        : tone === 'failed'
          ? 'bg-red-500/15 text-red-400'
          : 'bg-[var(--muted)] text-[var(--muted-foreground)]'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] leading-none ${toneClass}`}>
      {tone === 'running' ? <Loader2 size={9} className="animate-spin" /> : null}
      {statusText(tone, labels)}
    </span>
  )
}

function VideoBoardNodeImpl({
  node,
  selected,
  connecting,
  connectTarget,
  labels,
  assetUrl,
  job,
  incomingRoles,
  readOnly,
  onPointerDown,
  onConnectStart,
  onOpen,
  onTextChange,
  onGenerate,
  onReroll,
  variantCount,
}: VideoBoardNodeProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const textRef = useRef<HTMLTextAreaElement | null>(null)
  // §Phase C5: each card owns its two-step reroll guard; the key pins the
  // job the arming happened under, so a regenerated jobId forces a re-confirm.
  const rerollGuard = useArmedPaidAction(`rr:${node.id}:${node.jobId || ''}`)

  useEffect(() => {
    if (editing) textRef.current?.focus()
  }, [editing])

  const status = job?.status || node.status || ''
  const tone = status ? statusTone(status) : 'unknown'
  const busy = tone === 'running'
  const canReroll = Boolean(onReroll && node.jobId && !readOnly && !busy)

  function beginEdit() {
    if (readOnly) return
    setDraft(node.text || '')
    setEditing(true)
  }

  function commitText() {
    setEditing(false)
    if (draft !== (node.text || '')) onTextChange?.(node.id, draft)
  }

  return (
    <div
      className="group/video-node relative h-full w-full"
      onPointerDown={event => onPointerDown?.(event, node.id)}
      onDoubleClick={event => {
        if ((event.target as HTMLElement).closest('[data-video-interactive]')) return
        onOpen?.(node.id)
      }}
    >
      <div
        className={`relative h-full w-full overflow-hidden rounded-2xl border bg-[var(--card)] shadow-[0_10px_24px_-20px_rgba(0,0,0,0.35)] transition-colors ${
          connectTarget
            ? 'border-sky-500 ring-2 ring-sky-500/30'
            : selected
              ? 'border-[var(--primary)] ring-2 ring-[var(--primary)]/25'
              : connecting
                ? 'border-dashed border-[var(--primary)]'
                : 'border-[var(--border)]'
        }`}
      >
        {node.kind === 'text' ? (
          editing ? (
            <textarea
              data-video-interactive=""
              ref={textRef}
              value={draft}
              maxLength={4000}
              onChange={event => setDraft(event.target.value)}
              onBlur={commitText}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  textRef.current?.blur()
                }
              }}
              onPointerDown={event => event.stopPropagation()}
              className="h-full w-full resize-none bg-[var(--background)]/50 p-2.5 text-[12px] leading-[1.5] text-[var(--foreground)] outline-none"
            />
          ) : (
            <div
              className="h-full w-full overflow-hidden p-2.5"
              onDoubleClick={event => {
                event.stopPropagation()
                beginEdit()
              }}
            >
              {node.text ? (
                <p className="h-full w-full overflow-hidden text-[12px] leading-[1.5] break-words whitespace-pre-wrap text-[var(--foreground)]">
                  {node.text}
                </p>
              ) : (
                <p className="flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]">
                  <Type size={12} /> {labels.addText}
                </p>
              )}
            </div>
          )
        ) : null}

        {node.kind === 'image' ? (
          node.assetId ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={assetUrl(node.assetId)}
                alt={node.title || ''}
                draggable={false}
                className="pointer-events-none h-full w-full object-cover"
              />
              <RoleBadges roles={incomingRoles} labels={labels} />
              {node.title ? (
                <p className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/75 to-transparent px-2 pt-6 pb-1.5 text-[10px] text-white">
                  {node.title}
                </p>
              ) : null}
            </>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-[var(--muted-foreground)]">
              <ImageIcon size={22} strokeWidth={1.4} />
              <span className="text-[10.5px]">{labels.addImage}</span>
            </div>
          )
        ) : null}

        {node.kind === 'video' ? (
          node.assetId ? (
            <>
              <video
                data-video-interactive=""
                src={assetUrl(node.assetId)}
                controls
                playsInline
                preload="metadata"
                className="h-full w-full bg-black object-cover"
              />
              <RoleBadges roles={incomingRoles} labels={labels} />
              {node.duration ? (
                <span className="pointer-events-none absolute right-1.5 bottom-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[9.5px] text-white backdrop-blur-sm">
                  {formatVideoDuration(node.duration)}
                </span>
              ) : null}
            </>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-[var(--muted-foreground)]">
              <Film size={22} strokeWidth={1.4} />
              <span className="text-[10.5px]">{labels.addVideo}</span>
            </div>
          )
        ) : null}

        {node.kind === 'audio' ? (
          node.assetId ? (
            <div className="flex h-full w-full flex-col gap-1 p-2">
              <div className="flex min-w-0 items-center gap-1.5 text-[var(--muted-foreground)]">
                <Music2 size={12} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--foreground)]">
                  {node.title || labels.addAudio}
                </span>
                {node.duration ? (
                  <span className="shrink-0 text-[9.5px]">{formatVideoDuration(node.duration)}</span>
                ) : null}
              </div>
              <div className="flex h-5 items-center gap-[2px]" aria-hidden="true">
                {waveHeights(node.id).map((height, index) => (
                  <span key={index} className="w-[3px] rounded-full bg-[var(--primary)]/45" style={{ height: `${height}%` }} />
                ))}
              </div>
              <audio data-video-interactive="" src={assetUrl(node.assetId)} controls preload="metadata" className="h-8 w-full" />
            </div>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-[var(--muted-foreground)]">
              <Music2 size={22} strokeWidth={1.4} />
              <span className="text-[10.5px]">{labels.addAudio}</span>
            </div>
          )
        ) : null}

        {node.kind === 'generate' ? (
          <div className="flex h-full w-full flex-col gap-1.5 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex min-w-0 items-center gap-1 text-[10px] font-medium tracking-wide text-[var(--muted-foreground)] uppercase">
                <Clapperboard size={11} className="shrink-0" />
                {labels.generate}
              </span>
              {status ? <StatusPill tone={tone} labels={labels} /> : null}
            </div>
            <p
              className={`min-h-8 line-clamp-2 text-[11.5px] leading-4 ${
                node.prompt ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)]/60'
              }`}
            >
              {node.prompt || ''}
            </p>
            <div className="flex flex-wrap gap-1">
              {node.camera ? (
                <span
                  key="camera"
                  title={`${labels.camera}: ${node.camera}`}
                  className="inline-flex max-w-full items-center gap-1 truncate rounded-full border border-[var(--primary)]/45 bg-[var(--primary)]/[0.08] px-1.5 py-0.5 text-[9px] text-[var(--primary)]"
                >
                  <Video size={9} className="shrink-0" />
                  <span className="truncate">
                    {labels.cameraMotions[node.camera] || node.camera}
                  </span>
                </span>
              ) : null}
              {[node.operation, node.ratio, node.resolution, node.seconds ? `${node.seconds}s` : '', node.modelKey]
                .filter(Boolean)
                .map((badge, index) => (
                  <span
                    key={index}
                    className="max-w-full truncate rounded-full border border-[var(--border)]/70 px-1.5 py-0.5 text-[9px] text-[var(--muted-foreground)]"
                  >
                    {badge}
                  </span>
                ))}
            </div>
            {busy && job?.progress != null ? (
              <div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--muted)]">
                  <div
                    className="h-full rounded-full bg-sky-500"
                    style={{ width: `${Math.max(2, Math.min(100, job.progress))}%` }}
                  />
                </div>
                <div className="mt-0.5 flex items-center justify-between text-[9px] text-[var(--muted-foreground)]">
                  <span className="truncate">{job.stage || labels.running}</span>
                  <span className="shrink-0 tabular-nums">{Math.round(Math.min(100, Math.max(0, job.progress)))}%</span>
                </div>
              </div>
            ) : null}
            {tone === 'failed' ? <p className="text-[10px] text-red-400">{labels.failed}</p> : null}
            {tone === 'succeeded' && node.outputAssetId ? (
              <video
                data-video-interactive=""
                src={assetUrl(node.outputAssetId)}
                controls
                playsInline
                preload="metadata"
                className="min-h-0 w-full flex-1 rounded-lg border border-[var(--border)]/60 bg-black object-cover"
              />
            ) : (
              <div className="min-h-0 flex-1 rounded-lg border border-dashed border-[var(--border)]/60 bg-[var(--muted)]/20" />
            )}
            <div className="mt-auto flex items-center justify-end gap-1.5">
              {node.jobId && variantCount != null && variantCount > 0 ? (
                <span
                  title={labels.variants}
                  className="mr-auto inline-flex items-center gap-1 rounded-full border border-[var(--border)]/70 px-1.5 py-0.5 text-[9px] text-[var(--muted-foreground)]"
                >
                  <History size={9} /> ×{variantCount}
                </span>
              ) : null}
              {canReroll ? (
                <button
                  type="button"
                  data-video-interactive=""
                  disabled={readOnly}
                  title={labels.rerollHint}
                  onClick={event => {
                    event.stopPropagation()
                    if (rerollGuard.armed(node.id)) {
                      rerollGuard.disarm()
                      onReroll?.(node.id)
                    } else {
                      rerollGuard.arm(node.id)
                    }
                  }}
                  className={`inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition-colors ${
                    rerollGuard.armed(node.id)
                      ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                      : 'border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--muted)]/45'
                  }`}
                >
                  <Dices size={12} />
                  {rerollGuard.armed(node.id) ? labels.rerollArmed : labels.reroll}
                </button>
              ) : null}
              <button
                type="button"
                data-video-interactive=""
                disabled={readOnly}
                onClick={event => {
                  event.stopPropagation()
                  onGenerate?.(node.id)
                }}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[var(--primary)] px-3 text-[11px] font-medium text-[var(--primary-foreground)] disabled:opacity-40"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                {busy ? labels.running : labels.generate}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {!readOnly ? (
        <button
          type="button"
          data-video-handle={node.id}
          aria-label={labels.reference}
          onPointerDown={event => {
            event.stopPropagation()
            onConnectStart?.(event, node.id)
          }}
          className={`absolute top-1/2 right-0 z-10 h-3.5 w-3.5 -translate-y-1/2 translate-x-1/2 cursor-crosshair rounded-full border-2 border-[var(--card)] bg-[var(--primary)] transition-opacity ${
            selected || connecting ? 'opacity-100' : 'opacity-0 group-hover/video-node:opacity-100'
          }`}
        />
      ) : null}
    </div>
  )
}

export const VideoBoardNode = memo(VideoBoardNodeImpl)
