'use client'

import {
  AlertCircle,
  Camera,
  CheckCircle2,
  ChevronDown,
  Clapperboard,
  FileJson,
  Film,
  Image as ImageIcon,
  Loader2,
  MonitorPlay,
  Upload,
  Wand2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useDirectorDesk } from '@/lib/director-desk/use-director-desk'
import { directorResultToFile } from '@/lib/director-desk/client'
import {
  directorCameraLabel,
  type DirectorCamera,
  type DirectorProjectResponse,
} from '@/lib/director-desk/camera-mapping'
import type {
  DirectorCapture,
  DirectorCapabilities,
  DirectorFrameResult,
  DirectorTimeline,
  DirectorVideoResult,
} from '@/lib/director-desk/protocol'
import { apiFetch } from '@/lib/api'
import {
  uploadVideoAsset,
  getDirectorDeskSnapshot,
  saveDirectorDeskSnapshot,
  videoAssetUrl,
  type VideoAsset,
  type VideoStoryboardShot,
  type VideoCharacter,
} from '@/lib/video-studio-api'

type Busy = 'frame' | 'video' | 'project' | null

export interface DirectorDeskPanelProps {
  active: boolean
  projectId: string
  selectedShotId: string | null
  selectedShot?: VideoStoryboardShot | null
  shots?: VideoStoryboardShot[]
  assets: VideoAsset[]
  characters: VideoCharacter[]
  onAssetUploaded: (asset: VideoAsset) => void
  onApplyFrameToShot: (assetId: string) => void
  onApplyCameraToShot: (camera: DirectorCamera) => void
  onSyncCamerasToStoryboard: (cameras: DirectorCamera[]) => void
  onSelectShot?: (shot: VideoStoryboardShot) => void
  onNotify: (message: string) => void
}

function triggerDownload(url: string, fileName: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  triggerDownload(url, fileName)
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function captureKey(capture: DirectorCapture, index: number): string {
  return capture.fileName || `director-capture-${index}`
}

const TOOL_BTN =
  'inline-flex h-7 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 text-[11px] text-[var(--foreground)] hover:bg-[var(--muted)]/55 disabled:opacity-50'

export function DirectorDeskPanel({
  active,
  projectId,
  selectedShot,
  selectedShotId,
  shots = [],
  assets,
  characters,
  onAssetUploaded,
  onApplyFrameToShot,
  onApplyCameraToShot,
  onSyncCamerasToStoryboard,
  onSelectShot,
  onNotify,
}: DirectorDeskPanelProps) {
  const { t } = useTranslation()
  const instanceId = projectId ? `knorvia-video-${projectId}` : 'knorvia-director'
  const { iframeRef, client, ready, src, theme, captures, reload } = useDirectorDesk({
    instanceId,
    hostOrigin: typeof window !== 'undefined' ? window.location.origin : undefined,
  })

  const [busy, setBusy] = useState<Busy>(null)
  const [caps, setCaps] = useState<DirectorCapabilities | null>(null)
  const [timeline, setTimeline] = useState<DirectorTimeline | null>(null)
  const [lastFrame, setLastFrame] = useState<DirectorFrameResult | null>(null)
  const [lastVideo, setLastVideo] = useState<DirectorVideoResult | null>(null)
  const [directorProject, setDirectorProject] = useState<DirectorProjectResponse | null>(null)
  const [snapshotSaving, setSnapshotSaving] = useState(false)
  const [snapshotSaved, setSnapshotSaved] = useState(false)
  const savedFingerprintRef = useRef('')
  const [captureBusy, setCaptureBusy] = useState<string | null>(null)
  const latestProjectRef = useRef<DirectorProjectResponse | null>(null)
  const [loadStalled, setLoadStalled] = useState(false)
  const projectIdRef = useRef(projectId)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDetailsElement | null>(null)

  useEffect(() => {
    if (!client || !ready) return
    client.setVisibility(active)
  }, [active, client, ready])

  useEffect(() => {
    projectIdRef.current = projectId
  }, [projectId])

  useEffect(() => {
    setCaps(null)
    setDirectorProject(null)
    setSnapshotSaving(false)
    setSnapshotSaved(false)
    savedFingerprintRef.current = ''
    latestProjectRef.current = null
    setTimeline(null)
    setLastFrame(null)
    setLastVideo(null)
    setCaptureBusy(null)
    setLoadStalled(false)
  }, [src])

  useEffect(() => {
    if (ready) return
    const timer = window.setTimeout(() => setLoadStalled(true), 30_000)
    return () => window.clearTimeout(timer)
  }, [ready, src])

  useEffect(() => {
    if (!moreOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (moreRef.current && target && !moreRef.current.contains(target)) {
        setMoreOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [moreOpen])

  useEffect(() => {
    if (!ready || !client) return
    let cancelled = false
    const poll = () => {
      // Hidden tabs keep the iframe alive but nobody is watching — skip the
      // round-trip and the 1 Hz setTimeline churn until the tab returns.
      if (document.hidden) return
      client
        .getTimeline()
        .then(next => {
          if (cancelled) return
          // Same payload every second was re-rendering the desk for nothing.
          setTimeline(prev =>
            JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
          )
        })
        .catch(() => {})
    }
    client
      .capabilities()
      .then(next => {
        if (!cancelled) setCaps(next)
      })
      .catch(() => {})
    poll()
    const timer = window.setInterval(poll, 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [ready, client])

  useEffect(() => {
    if (!ready || !client || !projectId) return
    let cancelled = false
    let saving = false

    const refresh = async () => {
      if (cancelled || saving) return
      try {
        const response = await client.getProject()
        if (cancelled || projectIdRef.current !== projectId) return
        latestProjectRef.current = response
        setDirectorProject(response)
        if (savedFingerprintRef.current === response.projectFingerprint) return
        saving = true
        setSnapshotSaving(true)
        try {
          await saveDirectorDeskSnapshot(projectId, response)
          if (cancelled || projectIdRef.current !== projectId) return
          savedFingerprintRef.current = response.projectFingerprint
          setSnapshotSaved(true)
        } catch (error) {
          if (!cancelled && projectIdRef.current === projectId) {
            onNotify(error instanceof Error ? error.message : t('Could not save the director desk project.'))
            setSnapshotSaved(false)
          }
        } finally {
          saving = false
          if (!cancelled) setSnapshotSaving(false)
        }
      } catch {
        /* next poll retries */
      }
    }

    void getDirectorDeskSnapshot(projectId)
      .then(snapshot => {
        if (cancelled || projectIdRef.current !== projectId) return
        const savedDirectorDesk = snapshot.director_desk
        if (savedDirectorDesk) {
          savedFingerprintRef.current = savedDirectorDesk.projectFingerprint || ''
          setSnapshotSaved(true)
          setDirectorProject(current => current ?? savedDirectorDesk)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) void refresh()
      })

    const timer = window.setInterval(() => void refresh(), 20_000)
    return () => {
      cancelled = true
      const latest = latestProjectRef.current
      if (latest && savedFingerprintRef.current !== latest.projectFingerprint) {
        void saveDirectorDeskSnapshot(projectId, latest).catch(() => {})
      }
      window.clearInterval(timer)
    }
  }, [ready, client, projectId, onNotify, t])

  const uploadFile = useCallback(
    async (file: File): Promise<VideoAsset | null> => {
      if (!projectId) {
        onNotify(t('The 3D director desk needs a video project first.'))
        return null
      }
      try {
        const ownerProjectId = projectId
        const asset = await uploadVideoAsset(projectId, file)
        if (projectIdRef.current !== ownerProjectId) return null
        onAssetUploaded(asset)
        onNotify(t('Uploaded to project assets: {{name}}', { name: asset.filename }))
        return asset
      } catch (error) {
        onNotify(error instanceof Error ? error.message : t('Upload failed'))
        return null
      }
    },
    [projectId, onAssetUploaded, onNotify, t],
  )

  const exportFrame = useCallback(async () => {
    if (!client) return
    const ownerProjectId = projectId
    setBusy('frame')
    try {
      const result = await client.exportFrame({ position: 'current', quality: '720p' })
      if (projectIdRef.current !== ownerProjectId) return
      setLastFrame(result)
      triggerDownload(result.dataUrl, result.fileName || 'director-frame.png')
      onNotify(t('Exported the current frame.'))
    } catch (error) {
      onNotify(error instanceof Error ? error.message : t('Failed to export the current frame'))
    } finally {
      setBusy(null)
    }
  }, [client, onNotify, projectId, t])

  const exportFrameToKeyframe = useCallback(async () => {
    if (!client || !projectId || !selectedShotId) return
    const ownerProjectId = projectId
    setBusy('frame')
    try {
      const result = await client.exportFrame({ position: 'current', quality: '720p' })
      if (projectIdRef.current !== ownerProjectId) return
      setLastFrame(result)
      const file = directorResultToFile(result, 'director-keyframe.png', 'image/png')
      const asset = await uploadVideoAsset(ownerProjectId, file)
      if (projectIdRef.current !== ownerProjectId) return
      onAssetUploaded(asset)
      onApplyFrameToShot(asset.id)
      onNotify(t('Exported the current frame and set it as the current shot keyframe.'))
    } catch (error) {
      onNotify(error instanceof Error ? error.message : t('Failed to set the keyframe'))
    } finally {
      setBusy(null)
    }
  }, [client, projectId, selectedShotId, onAssetUploaded, onApplyFrameToShot, onNotify, t])

  const uploadFrame = useCallback(async () => {
    if (!lastFrame) return
    setBusy('frame')
    try {
      await uploadFile(directorResultToFile(lastFrame, 'director-frame.png', 'image/png'))
    } finally {
      setBusy(null)
    }
  }, [lastFrame, uploadFile])

  const frameToKeyframe = useCallback(async () => {
    if (!lastFrame) return
    setBusy('frame')
    try {
      const file = directorResultToFile(lastFrame, 'director-keyframe.png', 'image/png')
      if (!projectId) {
        onNotify(t('The 3D director desk needs a video project first.'))
        return
      }
      const ownerProjectId = projectId
      const asset = await uploadVideoAsset(projectId, file)
      if (projectIdRef.current !== ownerProjectId) return
      onAssetUploaded(asset)
      onApplyFrameToShot(asset.id)
      onNotify(t('Set as the current shot keyframe.'))
    } catch (error) {
      onNotify(error instanceof Error ? error.message : t('Failed to set the keyframe'))
    } finally {
      setBusy(null)
    }
  }, [lastFrame, projectId, onAssetUploaded, onApplyFrameToShot, onNotify, t])

  const exportVideo = useCallback(async () => {
    if (!client) return
    const ownerProjectId = projectId
    setBusy('video')
    try {
      const result = await client.exportVideo({ fps: 30, quality: '720p' })
      if (projectIdRef.current !== ownerProjectId) return
      setLastVideo(result)
      const file = directorResultToFile(result, 'director-reference.mp4', 'video/mp4')
      const url = result.blob
        ? URL.createObjectURL(result.blob)
        : file.size > 0
          ? URL.createObjectURL(file)
          : ''
      if (url) {
        triggerDownload(url, result.fileName || 'director-reference.mp4')
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
      }
      onNotify(t('Exported the reference video.'))
    } catch (error) {
      onNotify(error instanceof Error ? error.message : t('Failed to export the reference video'))
    } finally {
      setBusy(null)
    }
  }, [client, onNotify, projectId, t])

  const exportVideoToAssets = useCallback(async () => {
    if (!client || !projectId) return
    const ownerProjectId = projectId
    setBusy('video')
    try {
      const result = await client.exportVideo({ fps: 30, quality: '720p' })
      if (projectIdRef.current !== ownerProjectId) return
      setLastVideo(result)
      const file = directorResultToFile(result, 'white-model-previs.mp4', 'video/mp4')
      const asset = await uploadVideoAsset(ownerProjectId, file)
      if (projectIdRef.current !== ownerProjectId) return
      onAssetUploaded(asset)
      onNotify(t('White-model previs video added to project assets.'))
    } catch (error) {
      onNotify(error instanceof Error ? error.message : t('Failed to export the white-model previs video'))
    } finally {
      setBusy(null)
    }
  }, [client, projectId, onAssetUploaded, onNotify, t])

  const uploadVideo = useCallback(async () => {
    if (!lastVideo) return
    setBusy('video')
    try {
      await uploadFile(directorResultToFile(lastVideo, 'director-reference.mp4', 'video/mp4'))
    } finally {
      setBusy(null)
    }
  }, [lastVideo, uploadFile])

  const exportProject = useCallback(async () => {
    if (!client) return
    const ownerProjectId = projectId
    setBusy('project')
    try {
      const response = await client.getProject()
      if (projectIdRef.current !== ownerProjectId) return
      setDirectorProject(response)
      latestProjectRef.current = response
      if (savedFingerprintRef.current !== response.projectFingerprint) {
        setSnapshotSaving(true)
        try {
          await saveDirectorDeskSnapshot(ownerProjectId, response)
          savedFingerprintRef.current = response.projectFingerprint
          setSnapshotSaved(true)
        } catch (error) {
          onNotify(error instanceof Error ? error.message : t('Could not save the director desk project.'))
        } finally {
          setSnapshotSaving(false)
        }
      }
      const blob = new Blob([JSON.stringify(response, null, 2)], { type: 'application/json' })
      downloadBlob(blob, `director-project-${response.projectFingerprint}.json`)
      onNotify(t('Exported the director desk project JSON.'))
    } catch (error) {
      onNotify(error instanceof Error ? error.message : t('Failed to export the project'))
    } finally {
      setBusy(null)
    }
  }, [client, onNotify, projectId, t])

  const sceneReferenceSources = useMemo(() => {
    const labels = new Map<string, string>()
    const selectedIds = [
      selectedShot?.keyframe_asset_id,
      ...(selectedShot?.input_asset_ids || []),
    ].filter((id): id is string => Boolean(id))

    for (const id of selectedIds) labels.set(id, t('Current shot reference'))
    for (const character of characters) {
      for (const id of character.reference_asset_ids || []) {
        if (!labels.has(id)) labels.set(id, t('{{name}} character reference', { name: character.name || id }))
      }
    }
    for (const asset of assets) {
      if (asset.kind === 'image' && !labels.has(asset.id)) labels.set(asset.id, asset.filename)
    }

    return Array.from(labels, ([id, label]) => ({ id, label })).slice(0, 24)
  }, [assets, characters, selectedShot, t])

  const injectSceneReference = useCallback(
    async (assetId: string) => {
      if (!client || !ready) return
      const ownerProjectId = projectId
      try {
        const response = await apiFetch(videoAssetUrl(assetId), { skipAuthRedirect: true })
        if (!response.ok) throw new Error(t('Failed to read the character reference image'))
        const blob = await response.blob()
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(new Error(t('Failed to read the character reference image')))
          reader.readAsDataURL(blob)
        })
        if (projectIdRef.current !== ownerProjectId) return
        client.injectPanorama({
          edgeId: `knorvia-${assetId}`,
          sourceNodeId: `character-ref-${assetId}`,
          imageUrl: dataUrl,
          fileName: `character-ref-${assetId}.jpg`,
        })
        onNotify(t('Scene reference sent to the white-model previs.'))
      } catch (error) {
        onNotify(error instanceof Error ? error.message : t('Failed to send the scene reference'))
      }
    },
    [client, ready, projectId, onNotify, t],
  )

  const uploadCapture = useCallback(
    async (capture: DirectorCapture, index: number) => {
      const key = captureKey(capture, index)
      setCaptureBusy(key)
      try {
        await uploadFile(
          directorResultToFile(capture, capture.fileName || `director-capture-${index}.png`, 'image/png'),
        )
      } finally {
        setCaptureBusy(null)
      }
    },
    [uploadFile],
  )

  const applyCaptureToShot = useCallback(
    async (capture: DirectorCapture, index: number) => {
      const key = captureKey(capture, index)
      if (!projectId || !selectedShotId) {
        onNotify(t('Pick a storyboard shot first.'))
        return
      }
      setCaptureBusy(key)
      try {
        const asset = await uploadFile(
          directorResultToFile(capture, capture.fileName || `director-capture-${index}.png`, 'image/png'),
        )
        if (asset) {
          onApplyFrameToShot(asset.id)
          onNotify(t('Set as the current shot keyframe.'))
        }
      } finally {
        setCaptureBusy(null)
      }
    },
    [projectId, selectedShotId, uploadFile, onApplyFrameToShot, onNotify, t],
  )

  const progress = timeline ? Math.round((timeline.progress || 0) * 100) : 0
  const directorCameras = directorProject?.project?.cameras || []

  return (
    <div data-director-embed="" className="flex h-full min-h-0 flex-col bg-[var(--background)]">
      <div
        data-director-toolbar
        className="relative z-30 flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--border)] bg-[var(--card)]/90 px-3 py-1.5 backdrop-blur-sm"
      >
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${
            ready
              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
              : 'bg-[var(--muted)] text-[var(--muted-foreground)]'
          }`}
        >
          {ready ? <CheckCircle2 size={10} /> : <Loader2 size={10} className="animate-spin" />}
          {ready ? t('Ready') : t('Loading')}
        </span>
        {timeline ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--muted)]/70 px-2 py-0.5 text-[10px] text-[var(--muted-foreground)]">
            <MonitorPlay size={10} />
            {timeline.playing ? t('Playing') : t('Paused')} · {progress}% · {timeline.timeSeconds.toFixed(1)}s
          </span>
        ) : null}
        {snapshotSaving ? (
          <span className="hidden items-center gap-1 text-[10px] text-[var(--muted-foreground)] sm:inline-flex">
            <Loader2 size={9} className="animate-spin" /> {t('Saving director desk…')}
          </span>
        ) : snapshotSaved ? (
          <span className="hidden items-center gap-1 text-[10px] text-emerald-600 sm:inline-flex dark:text-emerald-400">
            <CheckCircle2 size={9} /> {t('Director desk saved')}
          </span>
        ) : null}

        <label className="ml-1 flex min-w-0 items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
          <Camera size={11} className="shrink-0" />
          <select
            aria-label={t('Target shot')}
            title={selectedShot?.prompt || selectedShot?.title || t('Target shot')}
            value={selectedShotId || ''}
            onChange={event => {
              const shot = shots.find(item => item.id === event.target.value)
              if (shot) onSelectShot?.(shot)
            }}
            className="h-7 max-w-[220px] rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[11px] text-[var(--foreground)] outline-none"
          >
            <option value="">{t('No shot selected')}</option>
            {shots.map((shot, index) => (
              <option key={shot.id} value={shot.id}>
                {index + 1}. {shot.title || t('Untitled shot')}
              </option>
            ))}
          </select>
        </label>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={!ready || !projectId || busy !== null}
            onClick={() => void exportVideoToAssets()}
            title={t('Export the full white-model previs and add it to this project.')}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 text-[11px] text-violet-700 hover:bg-violet-500/20 disabled:opacity-50 dark:text-violet-300"
          >
            {busy === 'video' ? <Loader2 size={12} className="animate-spin" /> : <Film size={12} />}
            {t('Previs video to assets')}
          </button>
          <button type="button" disabled={!ready || busy !== null} onClick={() => void exportFrame()} className={TOOL_BTN}>
            {busy === 'frame' ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />}
            {t('Export current frame')}
          </button>
          {selectedShotId ? (
            <button
              type="button"
              disabled={!ready || busy !== null}
              onClick={() => void exportFrameToKeyframe()}
              title={t('Export the current frame and set it as the selected shot keyframe.')}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 text-[11px] text-emerald-700 hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-300"
            >
              {busy === 'frame' ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              {t('Frame to shot keyframe')}
            </button>
          ) : null}

          <details
            ref={moreRef}
            className="relative"
            open={moreOpen}
            onToggle={event => setMoreOpen(event.currentTarget.open)}
          >
            <summary className={`${TOOL_BTN} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
              {t('More')}
              <ChevronDown size={11} />
            </summary>
            <div className="absolute right-0 z-40 mt-1.5 max-h-[min(24rem,calc(100vh-8rem))] w-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)] p-1.5 shadow-xl">
              <button
                type="button"
                disabled={!ready || busy !== null}
                onClick={() => {
                  setMoreOpen(false)
                  void exportVideo()
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] hover:bg-[var(--muted)]/50 disabled:opacity-50"
              >
                <Film size={12} /> {t('Export reference video')}
              </button>
              <button
                type="button"
                disabled={!ready || busy !== null}
                onClick={() => {
                  setMoreOpen(false)
                  void exportProject()
                }}
                title={t('Export project JSON (cameras and camera moves)')}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] hover:bg-[var(--muted)]/50 disabled:opacity-50"
              >
                <FileJson size={12} /> {t('Project JSON')}
              </button>
              {directorCameras.length ? (
                <button
                  type="button"
                  disabled={!ready || busy !== null}
                  onClick={() => {
                    setMoreOpen(false)
                    onSyncCamerasToStoryboard(directorCameras)
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] hover:bg-[var(--muted)]/50 disabled:opacity-50"
                >
                  <Clapperboard size={12} /> {t('Sync cameras to storyboard')}
                </button>
              ) : null}
              {sceneReferenceSources.length ? (
                <label className="mt-1 block border-t border-[var(--border)] px-2 pt-2 text-[10px] text-[var(--muted-foreground)]">
                  {t('Scene reference image')}
                  <select
                    className="mt-1 h-7 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[11px] text-[var(--foreground)]"
                    value=""
                    disabled={!ready || busy !== null}
                    onChange={event => {
                      if (event.target.value) {
                        void injectSceneReference(event.target.value)
                        setMoreOpen(false)
                      }
                    }}
                    aria-label={t('Send a reference image to the white-model previs')}
                  >
                    <option value="" disabled>
                      {t('Choose a scene or shot reference')}
                    </option>
                    {sceneReferenceSources.map(source => (
                      <option key={source.id} value={source.id}>
                        {source.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {caps ? (
                <p className="mt-1 border-t border-[var(--border)] px-2 pt-1.5 text-[9.5px] text-[var(--muted-foreground)]">
                  {t('{{theme}} theme', { theme })} · {t('Protocol v{{v}}', { v: caps.protocolVersion })}
                </p>
              ) : null}
            </div>
          </details>
        </div>
      </div>

      <div className="hidden shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--border)] bg-[var(--card)]/55 px-3 py-1 text-[10px] text-[var(--muted-foreground)] lg:flex">
        <span className="font-medium text-[var(--foreground)]">{t('Previs workflow')}</span>
        {[t('1 Scene reference'), t('2 Character blocking'), t('3 Camera path'), t('4 Previs video')].map((step, index) => (
          <span key={step} className="inline-flex shrink-0 items-center gap-2">
            {index ? <span className="opacity-40">→</span> : null}
            <span className="rounded-full bg-[var(--muted)]/70 px-2 py-0.5">{step}</span>
          </span>
        ))}
        <span className="ml-auto shrink-0">{t('Use the white model to lock space, movement and camera timing before generation.')}</span>
      </div>

      {directorCameras.length ? (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--border)] bg-[var(--card)]/70 px-3 py-1">
          <span className="shrink-0 text-[10px] text-[var(--muted-foreground)]">{t('Director cameras')}</span>
          {directorCameras.map(camera => {
            const key = camera.id || directorCameraLabel(camera)
            return (
              <button
                key={key}
                type="button"
                disabled={!selectedShotId || !ready}
                title={selectedShotId ? t('Apply camera to selected shot') : t('Pick a storyboard shot first.')}
                onClick={() => onApplyCameraToShot(camera)}
                className="h-6 shrink-0 rounded-full border border-[var(--border)] px-2 text-[10px] hover:border-[var(--primary)]/50 hover:text-[var(--primary)] disabled:opacity-40"
              >
                {directorCameraLabel(camera)}
              </button>
            )
          })}
        </div>
      ) : null}

      {lastFrame || lastVideo ? (
        <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--border)] bg-[var(--card)]/70 px-3 py-1 text-[10.5px] text-[var(--muted-foreground)]">
          {lastFrame ? (
            <span className="inline-flex items-center gap-1.5">
              <ImageIcon size={11} /> {t('Current frame ready')}
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void uploadFrame()}
                className="inline-flex items-center gap-1 rounded-md bg-[var(--primary)]/15 px-1.5 py-0.5 text-[var(--primary)] hover:bg-[var(--primary)]/25 disabled:opacity-50"
              >
                <Upload size={10} /> {t('Upload as asset')}
              </button>
              {selectedShotId ? (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void frameToKeyframe()}
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-emerald-600 hover:bg-emerald-500/25 disabled:opacity-50 dark:text-emerald-400"
                >
                  <Wand2 size={10} /> {t('Set as shot keyframe')}
                </button>
              ) : null}
            </span>
          ) : null}
          {lastVideo ? (
            <span className="inline-flex items-center gap-1.5">
              <Film size={11} /> {t('Reference video ready')}
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void uploadVideo()}
                className="inline-flex items-center gap-1 rounded-md bg-[var(--primary)]/15 px-1.5 py-0.5 text-[var(--primary)] hover:bg-[var(--primary)]/25 disabled:opacity-50"
              >
                <Upload size={10} /> {t('Upload as asset')}
              </button>
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 bg-[var(--background)]">
        <iframe
          ref={iframeRef}
          src={src}
          title={t('White-model Previs')}
          allow="autoplay; fullscreen"
          className="h-full w-full border-0 bg-[var(--background)]"
          style={{ colorScheme: theme }}
        />
        {!ready ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--background)]">
            <div className="flex max-w-sm flex-col items-center gap-2 text-center">
              {loadStalled ? (
                <AlertCircle size={18} className="text-amber-500" />
              ) : (
                <Loader2 size={18} className="animate-spin text-[var(--muted-foreground)]" />
              )}
              <span className="text-[12px] text-[var(--muted-foreground)]">
                {loadStalled
                  ? t('The white-model previs is taking too long to load.')
                  : t('Opening the white-model previs for this project…')}
              </span>
              {loadStalled ? (
                <button
                  type="button"
                  onClick={() => {
                    setLoadStalled(false)
                    reload()
                  }}
                  className={TOOL_BTN}
                >
                  {t('Reload White-model Previs')}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {captures.length ? (
        <div
          data-director-captures=""
          className="flex shrink-0 items-end gap-2 overflow-x-auto border-t border-[var(--border)] bg-[var(--card)]/80 px-3 py-2"
        >
          <span className="mb-1 shrink-0 text-[10px] text-[var(--muted-foreground)]">{t('Director captures')}</span>
          {captures.slice(0, 8).map((capture, index) => {
            const key = captureKey(capture, index)
            return (
              <span key={key} className="inline-flex shrink-0 flex-col items-center gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={capture.dataUrl}
                  alt={capture.fileName || t('Director captures')}
                  className="h-14 w-[88px] rounded-md border border-[var(--border)] object-cover"
                />
                <span className="flex gap-1">
                  <button
                    type="button"
                    disabled={captureBusy !== null}
                    onClick={() => void uploadCapture(capture, index)}
                    className="rounded bg-[var(--background)] px-1.5 py-0.5 text-[9.5px] text-[var(--primary)] ring-1 ring-[var(--border)] disabled:opacity-50"
                  >
                    {captureBusy === key ? <Loader2 size={9} className="animate-spin" /> : t('Upload as asset')}
                  </button>
                  {selectedShotId ? (
                    <button
                      type="button"
                      disabled={captureBusy !== null}
                      onClick={() => void applyCaptureToShot(capture, index)}
                      className="rounded bg-[var(--background)] px-1.5 py-0.5 text-[9.5px] text-emerald-600 ring-1 ring-[var(--border)] disabled:opacity-50 dark:text-emerald-400"
                    >
                      {t('Set as shot keyframe')}
                    </button>
                  ) : null}
                </span>
              </span>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export default DirectorDeskPanel
