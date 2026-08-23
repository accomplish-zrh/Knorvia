'use client'

import Link from 'next/link'
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  CheckCircle2,
  Clapperboard,
  Download,
  Film,
  FolderOpen,
  FolderPlus,
  Layers3,
  LayoutList,
  LayoutTemplate,
  ScrollText,
  Loader2,
  PanelRight,
  Settings2,
  Sparkles,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { VideoAssetsPanel } from '@/components/video-studio/VideoAssetsPanel'
import type { VideoBoardJobState } from '@/components/video-studio/VideoBoardNode'
import { CharacterLibrary, type CharacterDraft } from '@/components/video-studio/CharacterLibrary'
import { ProductionPanel, ProductionStageRail } from '@/components/video-studio/ProductionPanel'
import { DirectorDeskPanel } from '@/components/video-studio/DirectorDeskPanel'
import {
  directorCameraLabel,
  directorCameraShotPatch,
} from '@/lib/director-desk/camera-mapping'
import type { DirectorCamera } from '@/lib/director-desk/protocol'
import { VideoComposePanel, type VideoComposeConfig } from '@/components/video-studio/VideoComposePanel'
import { VideoComposer } from '@/components/video-studio/VideoComposer'
import { VideoInfiniteBoard, type VideoBoardLabels } from '@/components/video-studio/VideoInfiniteBoard'
import { VideoJobQueue } from '@/components/video-studio/VideoJobQueue'
import { VideoPreview } from '@/components/video-studio/VideoPreview'
import { VideoStoryboard } from '@/components/video-studio/VideoStoryboard'
import { VideoTimeline } from '@/components/video-studio/VideoTimeline'
import {
  cancelVideoJob,
  bindVideoShotJob,
  composeVideoProject,
  createVideoCharacter,
  createVideoJob,
  createVideoProject,
  deleteVideoAsset,
  deleteVideoCharacter,
  deleteVideoProject,
  exportVideoBoardToStoryboard,
  followVideoJobs,
  generateVideoCharacterThreeView,
  generateVideoShotKeyframe,
  generateVideoShotVoiceover,
  getVideoAsset,
  getVideoBoard,
  getVideoFfmpegStatus,
  getVideoJob,
  getVideoProject,
  getVideoStoryboard,
  importVideoStoryboardToBoard,
  installVideoFfmpeg,
  listVideoAssets,
  listVideoCharacters,
  listVideoCompositions,
  listVideoJobs,
  listVideoModels,
  listVideoProjects,
  activateVideoProject,
  listVideoShotJobs,
  getVideoProduction,
  saveVideoProduction,
  analyzeVideoProduction,
  confirmVideoProduction,
  reopenVideoProduction,
  applyVideoProduction,
  placeVideoBoardTemplate,
  rerollVideoJob,
  retryVideoJob,
  saveVideoBoard,
  saveVideoStoryboard,
  updateVideoCharacter,
  updateVideoProject,
  uploadVideoAsset,
  videoAssetThumbnailUrl,
  videoAssetUrl,
  videoProjectExportUrl,
  VideoBoardConflictError,
  VideoStudioApiError,
  type VideoAsset,
  type VideoCharacter,
  type VideoComposition,
  type VideoFfmpegStatus,
  type VideoJob,
  type VideoModelOption,
  type VideoOperation,
  type VideoProject,
  type VideoStoryboardDocument,
  type VideoStoryboardShot,
} from '@/lib/video-studio-api'
import { loadFromStorage, saveToStorage } from '@/lib/persistence'
import {
  applyVideoJobToBoard,
  BOARD_TEMPLATE_IDS,
  collectVideoNodePrompt,
  emptyVideoBoard,
  normalizeVideoBoard,
  seedVideoAssetOnBoard,
  videoInputSpecs,
  type BoardTemplateId,
  type VideoBoardDocument,
  type VideoBoardPoint,
} from '@/lib/video-studio/board-logic'
import {
  addStoryboardShot,
  advertisedVideoOperations,
  appendCharacterToVideoInputs,
  bindJobToStoryboardShot,
  boardNodeVariantCount,
  buildVideoJobPayload,
  CAMERA_VALUE_LABELS,
  cameraParameterForKey,
  emptyVideoStoryboard,
  ensureVideoSubmissionRequest,
  invalidateVideoSubmissionRequest,
  isVideoJobFinal,
  loadVideoPriceHints,
  normalizedJobProgress,
  normalizeVideoStoryboard,
  patchStoryboardShot,
  preferredVideoModel,
  preferredVideoOperation,
  reorderStoryboardShots,
  retryStoryboardShot,
  sanitizeVideoInputs,
  saveVideoPriceHint,
  settingsForVideoModel,
  storyboardPatchAffectsSubmission,
  toggleVideoInput,
  validateVideoSubmission,
  VIDEO_MODEL_STORAGE_KEY,
  VIDEO_OPERATION_STORAGE_KEY,
  videoModelKey,
  type VideoSettings,
} from '@/lib/video-studio/studio-logic'
import { injectCharacterOnBoard } from '@/lib/video-studio/character-logic'
import {
  emptyVideoProduction,
  isProductionStage,
  stageWorkbenchView,
  type ProductionReadiness,
  type ProductionStage,
  type VideoProduction,
} from '@/lib/video-studio/production-logic'
import { StudioAgentPanel } from '@/components/library/StudioAgentPanel'
import { CreationDeskSwitch } from '@/components/sidebar/CreationDeskSwitch'
import { StudioLibraryPicker } from '@/components/library/StudioLibraryPicker'
import { libraryAssetUrl } from '@/lib/creative-library-api'

/** Persisted `storyboard | board` workbench view (§5.2). */
const VIDEO_VIEW_STORAGE_KEY = 'knorvia.video-studio.view'
/** §5.5 template menu — values are i18n keys, placement is server-side. */
const BOARD_TEMPLATE_LABELS: Record<BoardTemplateId, string> = {
  'shot-i2v': 'Image to video',
  'first-last': 'First & last frame',
  'storyboard-6': 'Six-shot storyboard',
  'character-episode': 'Character episode',
  'extend-chain': 'Extend a clip',
  'character-card': 'Character card',
  'vertical-series': 'Vertical series',
  'product-triptych': 'Product triptych',
  'talking-head': 'Talking head',
  'text-to-video': 'Narration video',
  'compare-ab': 'Compare A/B',
  'tutorial-steps': 'Tutorial steps',
  'grid-nine': 'Nine-frame grid',
}

const EMPTY_SETTINGS: VideoSettings = {
  duration: '',
  aspectRatio: '',
  resolution: '',
  fps: '',
  audioMode: 'none',
  seed: '',
  referenceMode: '',
  extra: {},
}

function replaceJob(items: VideoJob[], job: VideoJob) {
  const found = items.some(item => item.id === job.id)
  return found ? items.map(item => (item.id === job.id ? job : item)) : [job, ...items]
}

function validationLabel(reason: string | undefined, t: (key: string) => string) {
  const labels: Record<string, string> = {
    'project-required': 'Choose a project first.',
    'model-required': 'Configure and choose a video model.',
    'operation-required': 'Choose a generation mode.',
    'operation-unsupported': 'This model does not support the selected mode.',
    'prompt-required': 'Describe the shot before generating.',
    'prompt-too-long': 'The prompt is longer than this model allows.',
    'inputs-too-large': 'The selected inputs exceed this model’s size limit.',
    'invalid-inputs': 'Some selected inputs are not supported by this model.',
    'image-required': 'Select at least one image for image-to-video.',
    'video-required': 'Select a video input for this mode.',
    'reference-required': 'Select an image or video reference.',
    'audio-required': 'Select an audio asset or change the audio mode.',
    'cost-confirmation-required': 'Confirm possible provider credit usage.',
  }
  return reason ? t(labels[reason] || 'Review the generation settings.') : ''
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

export default function VideoStudioPage() {
  const { t, i18n } = useTranslation()
  const mountedRef = useRef(true)
  const projectIdRef = useRef('')
  const projectEpochRef = useRef(0)
  const initialControllerRef = useRef<AbortController | null>(null)
  const projectControllerRef = useRef<AbortController | null>(null)
  const refreshControllersRef = useRef(new Set<AbortController>())
  const previewControllerRef = useRef<AbortController | null>(null)
  const uploadControllerRef = useRef<AbortController | null>(null)
  const followLoopRef = useRef<{ controller: AbortController; timer: number | null } | null>(null)
  const followCursorsRef = useRef(new Map<string, number>())
  const followFailuresRef = useRef(0)
  const jobsRef = useRef<VideoJob[]>([])
  const terminalRefreshRef = useRef(new Set<string>())
  const submissionIdRef = useRef<string | null>(null)
  const submissionGuardRef = useRef<symbol | null>(null)
  const retryRequestIdsRef = useRef(new Map<string, string>())
  const storyboardRef = useRef<VideoStoryboardDocument>(emptyVideoStoryboard())
  const storyboardReadyRef = useRef(false)
  const storyboardSaveTimerRef = useRef<number | null>(null)
  const storyboardSaveControllerRef = useRef<AbortController | null>(null)
  const storyboardSaveRunningRef = useRef(false)
  const storyboardSavePendingRef = useRef(false)
  const storyboardSaveErrorRef = useRef<Error | null>(null)
  const storyboardDirtyRef = useRef(false)
  const boardRef = useRef<VideoBoardDocument>(emptyVideoBoard())
  const boardReadyRef = useRef(false)
  const boardDirtyRef = useRef(false)
  const boardSaveTimerRef = useRef<number | null>(null)
  const boardSaveControllerRef = useRef<AbortController | null>(null)
  const boardSaveRunningRef = useRef(false)
  const boardSavePendingRef = useRef(false)
  const boardSaveErrorRef = useRef<Error | null>(null)
  const boardFocusNodeRef = useRef<{ focus: (nodeId: string) => void } | null>(null)
  const pendingBoardFocusRef = useRef<string | null>(null)
  const deepLinkProjectIdRef = useRef('')
  const deepLinkJobIdRef = useRef('')
  const deepLinkViewRef = useRef('')
  const deepLinkShotIdRef = useRef('')

  const [projects, setProjects] = useState<VideoProject[]>([])
  const [projectId, setProjectId] = useState('')
  const [projectTitle, setProjectTitle] = useState('')
  const [models, setModels] = useState<VideoModelOption[]>([])
  const [modelKey, setModelKey] = useState('')
  const [operation, setOperation] = useState<VideoOperation | ''>('')
  const [settings, setSettings] = useState<VideoSettings>(EMPTY_SETTINGS)
  const [prompt, setPrompt] = useState('')
  const [assets, setAssets] = useState<VideoAsset[]>([])
  const [jobs, setJobs] = useState<VideoJob[]>([])
  const [selectedInputIds, setSelectedInputIds] = useState<string[]>([])
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null)
  const [previewJobId, setPreviewJobId] = useState<string | null>(null)
  const [focusedJobId, setFocusedJobId] = useState<string | null>(null)
  const [storyboard, setStoryboard] = useState<VideoStoryboardDocument>(emptyVideoStoryboard)
  const [storyboardReady, setStoryboardReady] = useState(false)
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null)
  const [board, setBoard] = useState<VideoBoardDocument>(emptyVideoBoard)
  const [boardReady, setBoardReady] = useState(false)
  const [boardSelection, setBoardSelection] = useState<string[]>([])
  const [viewMode, setViewMode] = useState<'storyboard' | 'board' | 'director' | 'production'>('storyboard')
  const [directorMounted, setDirectorMounted] = useState(false)
  const [production, setProduction] = useState<VideoProduction>(emptyVideoProduction)
  const [productionReadiness, setProductionReadiness] = useState<ProductionReadiness | null>(null)
  const [productionStage, setProductionStage] = useState<ProductionStage>('script')
  const [productionBusy, setProductionBusy] = useState(false)
  const productionSaveTimer = useRef<number | null>(null)
  const productionRef = useRef(production)
  productionRef.current = production
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [composeOpen, setComposeOpen] = useState(false)
  const libraryImportRef = useRef('')
  const libraryImportedRef = useRef('')
  const [boardBusy, setBoardBusy] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [nextAssetCursor, setNextAssetCursor] = useState<string | null>(null)
  const [nextJobCursor, setNextJobCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [projectLoading, setProjectLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [busyJobId, setBusyJobId] = useState<string | null>(null)
  const [costConfirmed, setCostConfirmed] = useState(false)
  const [message, setMessage] = useState('')
  const [offline, setOffline] = useState(false)
  const [assetsDrawerOpen, setAssetsDrawerOpen] = useState(false)
  const [queueDrawerOpen, setQueueDrawerOpen] = useState(false)
  const [shotBusyId, setShotBusyId] = useState<string | null>(null)
  /** §Phase C5: variant history of the selected shot + reroll busy state. */
  const [shotVariantJobs, setShotVariantJobs] = useState<VideoJob[]>([])
  const [shotVariantsLoading, setShotVariantsLoading] = useState(false)
  const [rerollBusyShotId, setRerollBusyShotId] = useState<string | null>(null)
  const variantsControllerRef = useRef<AbortController | null>(null)
  const selectedShotIdRef = useRef<string | null>(null)
  const [ffmpeg, setFfmpeg] = useState<VideoFfmpegStatus | null>(null)
  const [installingFfmpeg, setInstallingFfmpeg] = useState(false)
  const [compositions, setCompositions] = useState<VideoComposition[]>([])
  const [composing, setComposing] = useState(false)
  /** §F1 lifted from the compose panel so the timeline's music bed band tracks it. */
  const [bgmAssetId, setBgmAssetId] = useState('')
  const [characters, setCharacters] = useState<VideoCharacter[]>([])
  const [characterBusyId, setCharacterBusyId] = useState<string | null>(null)
  const [characterCreating, setCharacterCreating] = useState(false)
  const [leftTab, setLeftTab] = useState<'assets' | 'characters'>('assets')
  /** §F5 per-model ¥/s hints: display-only cost estimates, persisted locally. */
  const [priceHints, setPriceHints] = useState<Record<string, number>>({})

  useEffect(() => {
    // IIFE keeps the setState call out of the synchronous effect body
    // (`react-hooks/set-state-in-effect`, house pattern, see MemoryPicker).
    void (async () => {
      setPriceHints(loadVideoPriceHints())
    })()
  }, [])

  const changePriceHint = useCallback((modelKeyValue: string, value: number | null) => {
    setPriceHints(current => saveVideoPriceHint(current, modelKeyValue, value))
  }, [])

  useEffect(() => {
    const assetsBreakpoint = window.matchMedia('(min-width: 1280px)')
    const queueBreakpoint = window.matchMedia('(min-width: 1536px)')
    const closeResponsiveDrawers = () => {
      setAssetsDrawerOpen(false)
      setQueueDrawerOpen(false)
    }
    assetsBreakpoint.addEventListener('change', closeResponsiveDrawers)
    queueBreakpoint.addEventListener('change', closeResponsiveDrawers)
    return () => {
      assetsBreakpoint.removeEventListener('change', closeResponsiveDrawers)
      queueBreakpoint.removeEventListener('change', closeResponsiveDrawers)
    }
  }, [])

  const selectedModel = useMemo(
    () => models.find(model => videoModelKey(model) === modelKey),
    [models, modelKey]
  )
  const selectedAssets = useMemo(
    () => selectedInputIds.map(id => assets.find(asset => asset.id === id)).filter((asset): asset is VideoAsset => Boolean(asset)),
    [assets, selectedInputIds]
  )
  const previewAsset = assets.find(asset => asset.id === previewAssetId)
  const previewJob = jobs.find(job => job.id === previewJobId)
  const runningCount = jobs.filter(job => !isVideoJobFinal(job.status)).length
  const validation = validateVideoSubmission({
    projectId,
    model: selectedModel,
    operation,
    prompt,
    selectedInputIds,
    assets,
    settings,
    costConfirmed,
  })

  const boardLabels = useMemo<VideoBoardLabels>(
    () => ({
      canvas: t('Canvas'),
      addText: t('Add note'),
      addImage: t('Add image'),
      addVideo: t('Add video'),
      addAudio: t('Add audio'),
      addGenerate: t('New shot'),
      generate: t('Generate'),
      delete: t('Delete'),
      zoomIn: t('Zoom in'),
      zoomOut: t('Zoom out'),
      fitView: t('Fit view'),
      firstFrame: t('First frame'),
      lastFrame: t('Last frame'),
      reference: t('Reference'),
      audioRole: t('Audio'),
      continueFrom: t('Continue from'),
      emptyCanvas: t('Empty canvas'),
      running: t('Running'),
      queued: t('Queued'),
      failed: t('failed'),
      succeeded: t('succeeded'),
      unknown: t('Unknown'),
      camera: t('Camera movement'),
      cameraMotions: Object.fromEntries(
        Object.entries(CAMERA_VALUE_LABELS).map(([value, label]) => [value, t(label)])
      ),
      reroll: t('Generate another version'),
      rerollArmed: t('Confirm — paid'),
      rerollHint: t('Same prompt and parameters (camera included) with a fresh seed — one paid task.'),
      variants: t('Versions run from this card'),
    }),
    [t]
  )

  const jobsById = useMemo(() => {
    const map: Record<string, VideoBoardJobState> = {}
    for (const job of jobs) {
      map[job.id] = {
        status: job.status,
        progress: normalizedJobProgress(job),
        stage: job.stage || null,
      }
    }
    return map
  }, [jobs])

  /** §Phase C5: lightweight per-card take count for canvas generate cards. */
  const boardVariantCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const node of boardRef.current.nodes) {
      if (node.kind !== 'generate') continue
      const count = boardNodeVariantCount(jobs, node.id)
      if (count > 0) counts[node.id] = count
    }
    return counts
  }, [jobs])

  const abortFollowers = useCallback(() => {
    const loop = followLoopRef.current
    if (loop) {
      loop.controller.abort()
      if (loop.timer) window.clearTimeout(loop.timer)
    }
    followLoopRef.current = null
    followCursorsRef.current.clear()
    followFailuresRef.current = 0
    terminalRefreshRef.current.clear()
  }, [])

  const activateProject = useCallback(
    (id: string, title: string) => {
      projectEpochRef.current += 1
      projectIdRef.current = id
      projectControllerRef.current?.abort()
      for (const controller of refreshControllersRef.current) controller.abort()
      refreshControllersRef.current.clear()
      previewControllerRef.current?.abort()
      uploadControllerRef.current?.abort()
      storyboardSaveControllerRef.current?.abort()
      if (storyboardSaveTimerRef.current) window.clearTimeout(storyboardSaveTimerRef.current)
      boardSaveControllerRef.current?.abort()
      if (boardSaveTimerRef.current) window.clearTimeout(boardSaveTimerRef.current)
      abortFollowers()
      storyboardReadyRef.current = false
      storyboardSavePendingRef.current = false
      storyboardSaveRunningRef.current = false
      storyboardSaveErrorRef.current = null
      storyboardDirtyRef.current = false
      boardReadyRef.current = false
      boardSavePendingRef.current = false
      boardSaveRunningRef.current = false
      boardSaveErrorRef.current = null
      boardDirtyRef.current = false
      pendingBoardFocusRef.current = null
      retryRequestIdsRef.current.clear()
      const blank = emptyVideoStoryboard()
      storyboardRef.current = blank
      setStoryboard(blank)
      setStoryboardReady(false)
      const blankBoard = emptyVideoBoard()
      boardRef.current = blankBoard
      setBoard(blankBoard)
      setBoardReady(false)
      setBoardSelection([])
      setProjectId(id)
      setProjectTitle(title)
      setAssets([])
      setJobs([])
      setCharacters([])
      setCharacterBusyId(null)
      setSelectedInputIds([])
      setPreviewAssetId(null)
      setPreviewJobId(null)
      setFocusedJobId(null)
      setSelectedShotId(null)
      setNextAssetCursor(null)
      setNextJobCursor(null)
      setProjectLoading(Boolean(id))
      setSubmitting(false)
      setMessage('')
      setAssetsDrawerOpen(false)
      setQueueDrawerOpen(false)
      setShotBusyId(null)
      setCompositions([])
      setComposing(false)
      invalidateVideoSubmissionRequest(submissionIdRef)
      submissionGuardRef.current = null
      if (id) void activateVideoProject(id).catch(() => undefined)
    },
    [abortFollowers]
  )

  const loadProjectData = useCallback(async (id: string, epoch: number) => {
    projectControllerRef.current?.abort()
    const controller = new AbortController()
    projectControllerRef.current = controller
    try {
      const [project, assetPayload, jobPayload, storyboardPayload, boardPayload, compositionItems, characterItems, productionPayload] = await Promise.all([
        getVideoProject(id, controller.signal),
        listVideoAssets(id, null, controller.signal),
        listVideoJobs(id, null, controller.signal),
        getVideoStoryboard(id, controller.signal),
        getVideoBoard(id, controller.signal),
        listVideoCompositions(id, controller.signal),
        listVideoCharacters(id, controller.signal),
        getVideoProduction(id, controller.signal).catch(() => null),
      ])
      if (!mountedRef.current || controller.signal.aborted || projectEpochRef.current !== epoch || projectIdRef.current !== id) return
      const normalizedStoryboard = normalizeVideoStoryboard(storyboardPayload)
      const normalizedBoard = normalizeVideoBoard(boardPayload)
      setProjectTitle(project.title)
      setProjects(current => current.map(item => (item.id === project.id ? project : item)))
      let loadedAssets = assetPayload.assets || []
      let loadedJobs = jobPayload.jobs || []
      let deepLinkedJob: VideoJob | undefined
      let deepLinkWarning = ''
      const requestedJobId = deepLinkJobIdRef.current
      if (requestedJobId && deepLinkProjectIdRef.current === id) {
        deepLinkedJob = loadedJobs.find(job => job.id === requestedJobId)
        if (!deepLinkedJob) {
          try {
            const requestedJob = await getVideoJob(requestedJobId, controller.signal)
            if (requestedJob.project_id === id) {
              deepLinkedJob = requestedJob
              loadedJobs = [requestedJob, ...loadedJobs]
            } else {
              deepLinkWarning = t('The linked video task belongs to another project.')
            }
          } catch (error) {
            if (isAbort(error)) throw error
            deepLinkWarning = t('Could not load the linked video task.')
          }
        }
        const linkedOutputId = deepLinkedJob?.output_asset_ids?.[0]
        if (linkedOutputId && !loadedAssets.some(asset => asset.id === linkedOutputId)) {
          try {
            const linkedAsset = await getVideoAsset(linkedOutputId, controller.signal)
            if (linkedAsset.project_id === id) loadedAssets = [linkedAsset, ...loadedAssets]
          } catch (error) {
            if (isAbort(error)) throw error
          }
        }
      }
      if (!mountedRef.current || controller.signal.aborted || projectEpochRef.current !== epoch || projectIdRef.current !== id) return
      setAssets(loadedAssets)
      setJobs(loadedJobs)
      setCharacters(characterItems || [])
      setCompositions(compositionItems || [])
      setNextAssetCursor(assetPayload.next_cursor || null)
      setNextJobCursor(jobPayload.next_cursor || null)
      storyboardRef.current = normalizedStoryboard
      storyboardDirtyRef.current = false
      storyboardReadyRef.current = true
      setStoryboard(normalizedStoryboard)
      setStoryboardReady(true)
      boardRef.current = normalizedBoard
      boardDirtyRef.current = false
      boardReadyRef.current = true
      setBoard(normalizedBoard)
      setBoardReady(true)
      // §5.2 default: a board with content opens the canvas view; the user's
      // last explicit toggle (persisted) wins over the content heuristic.
      // Agent deep links (`view=`, `shot=`) then override the stored default.
      setViewMode(current => {
        const requestedView = deepLinkViewRef.current
        if (
          requestedView === 'board' ||
          requestedView === 'storyboard' ||
          requestedView === 'director' ||
          requestedView === 'production'
        ) {
          return requestedView
        }
        const stored = loadFromStorage(VIDEO_VIEW_STORAGE_KEY, '' as string)
        if (stored === 'board' || stored === 'storyboard' || stored === 'director' || stored === 'production') return stored
        return normalizedBoard.nodes.length > 0 ? 'board' : current === 'board' ? 'board' : 'storyboard'
      })
      const requestedShotId = deepLinkShotIdRef.current
      if (requestedShotId && normalizedStoryboard.shots.some(shot => shot.id === requestedShotId)) {
        setSelectedShotId(requestedShotId)
      }
      setOffline(false)
      if (deepLinkedJob) {
        setFocusedJobId(deepLinkedJob.id)
        setQueueDrawerOpen(true)
      }
      if (deepLinkedJob?.board_node_id) {
        // §5.8: a canvas job link must land on its node, not the strip.
        pendingBoardFocusRef.current = deepLinkedJob.board_node_id
        setViewMode('board')
      }
      if (productionPayload?.production) {
        setProduction(productionPayload.production)
        setProductionReadiness(productionPayload.readiness || null)
        if (isProductionStage(productionPayload.production.stage)) {
          setProductionStage(productionPayload.production.stage)
        }
      } else {
        setProduction(emptyVideoProduction())
        setProductionReadiness(null)
        setProductionStage('script')
      }
      if (deepLinkWarning) setMessage(deepLinkWarning)
      const firstOutput = deepLinkedJob?.output_asset_ids?.[0]
        || loadedJobs.find(job => job.output_asset_ids.length)?.output_asset_ids[0]
      if (firstOutput && loadedAssets.some(asset => asset.id === firstOutput)) {
        setPreviewAssetId(firstOutput)
        setPreviewJobId(loadedJobs.find(job => job.output_asset_ids.includes(firstOutput))?.id || null)
      }
    } catch (error) {
      if (!isAbort(error) && mountedRef.current && projectEpochRef.current === epoch) {
        setMessage(error instanceof Error ? error.message : t('Could not load the video project.'))
      }
    } finally {
      if (mountedRef.current && projectEpochRef.current === epoch) setProjectLoading(false)
    }
  }, [t])

  const refreshProjectAssetsAndJobs = useCallback(async (id: string, epoch: number) => {
    const controller = new AbortController()
    refreshControllersRef.current.add(controller)
    try {
      const [assetPayload, jobPayload, compositionItems] = await Promise.all([
        listVideoAssets(id, null, controller.signal),
        listVideoJobs(id, null, controller.signal),
        listVideoCompositions(id, controller.signal),
      ])
      if (!mountedRef.current || projectEpochRef.current !== epoch || projectIdRef.current !== id) return
      setAssets(assetPayload.assets || [])
      setJobs(jobPayload.jobs || [])
      setCompositions(compositionItems || [])
      setNextAssetCursor(assetPayload.next_cursor || null)
      setNextJobCursor(jobPayload.next_cursor || null)
      setOffline(false)
    } catch (error) {
      if (!isAbort(error) && mountedRef.current && projectEpochRef.current === epoch) setOffline(true)
    } finally {
      refreshControllersRef.current.delete(controller)
    }
  }, [])

  /** §Phase C5: read-only variant history for one shot, newest first. */
  const refreshShotVariants = useCallback(
    async (shotId: string | null) => {
      const id = projectIdRef.current
      const epoch = projectEpochRef.current
      if (!id || !shotId) {
        setShotVariantJobs([])
        return
      }
      variantsControllerRef.current?.abort()
      const controller = new AbortController()
      variantsControllerRef.current = controller
      setShotVariantsLoading(true)
      try {
        const payload = await listVideoShotJobs(id, shotId, controller.signal)
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          projectIdRef.current !== id ||
          projectEpochRef.current !== epoch
        ) {
          return
        }
        setShotVariantJobs(payload.jobs || [])
      } catch (error) {
        if (
          !isAbort(error) &&
          mountedRef.current &&
          projectIdRef.current === id &&
          projectEpochRef.current === epoch
        ) {
          setMessage(t('Could not load the variant history.'))
        }
      } finally {
        if (!controller.signal.aborted) setShotVariantsLoading(false)
      }
    },
    [t]
  )

  // Selected shot drives the variant panel; keep a ref so terminal job
  // callbacks can refresh the list for the shot the user is looking at.
  useEffect(() => {
    selectedShotIdRef.current = selectedShotId
    void refreshShotVariants(selectedShotId)
  }, [selectedShotId, refreshShotVariants])

  const persistStoryboard = useCallback(async () => {
    if (!storyboardReadyRef.current || !projectIdRef.current) return
    if (!storyboardDirtyRef.current && !storyboardSaveRunningRef.current) return
    if (storyboardSaveRunningRef.current) {
      storyboardSavePendingRef.current = true
      return
    }
    storyboardSaveRunningRef.current = true
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    try {
      do {
        storyboardSavePendingRef.current = false
        const snapshot = storyboardRef.current
        const controller = new AbortController()
        storyboardSaveControllerRef.current = controller
        const saved = normalizeVideoStoryboard(await saveVideoStoryboard(id, snapshot, controller.signal))
        storyboardSaveErrorRef.current = null
        if (projectIdRef.current !== id || projectEpochRef.current !== epoch) return
        if (storyboardRef.current === snapshot) {
          storyboardRef.current = saved
          storyboardDirtyRef.current = false
          if (mountedRef.current) setStoryboard(saved)
        } else {
          const rebased = { ...storyboardRef.current, revision: saved.revision, updated_at: saved.updated_at }
          storyboardRef.current = rebased
          storyboardDirtyRef.current = true
          if (mountedRef.current) setStoryboard(rebased)
          storyboardSavePendingRef.current = true
        }
      } while (storyboardSavePendingRef.current)
    } catch (error) {
      if (isAbort(error) || projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      storyboardSaveErrorRef.current = error instanceof Error ? error : new Error('Storyboard save failed')
      if (error instanceof VideoStudioApiError && error.status === 409) {
        try {
          const latest = normalizeVideoStoryboard(await getVideoStoryboard(id))
          if (projectIdRef.current === id && projectEpochRef.current === epoch) {
            storyboardRef.current = latest
            storyboardDirtyRef.current = false
            if (mountedRef.current) {
              setStoryboard(latest)
              setSelectedShotId(current => latest.shots.some(shot => shot.id === current) ? current : null)
              invalidateVideoSubmissionRequest(submissionIdRef)
              setMessage(t('The storyboard changed elsewhere. The latest version was loaded; repeat your last edit.'))
            }
          }
        } catch {
          if (mountedRef.current) setMessage(t('The storyboard changed elsewhere and could not be reloaded.'))
        }
      } else {
        if (mountedRef.current) setMessage(error instanceof Error ? error.message : t('Could not save the storyboard.'))
      }
    } finally {
      storyboardSaveRunningRef.current = false
      storyboardSaveControllerRef.current = null
      if (storyboardSavePendingRef.current && projectIdRef.current === id) {
        storyboardSaveTimerRef.current = window.setTimeout(() => void persistStoryboard(), 300)
      }
    }
  }, [t])

  const queueStoryboardSave = useCallback(() => {
    if (!storyboardReadyRef.current) return
    if (storyboardSaveTimerRef.current) window.clearTimeout(storyboardSaveTimerRef.current)
    storyboardSaveTimerRef.current = window.setTimeout(() => void persistStoryboard(), 150)
  }, [persistStoryboard])

  const flushStoryboard = useCallback(async () => {
    if (!storyboardDirtyRef.current && !storyboardSaveRunningRef.current) return
    if (storyboardSaveTimerRef.current) {
      window.clearTimeout(storyboardSaveTimerRef.current)
      storyboardSaveTimerRef.current = null
    }
    storyboardSavePendingRef.current = true
    await persistStoryboard()
    for (let attempt = 0; attempt < 240 && storyboardSaveRunningRef.current; attempt += 1) {
      await new Promise<void>(resolve => window.setTimeout(resolve, 25))
    }
    if (storyboardSaveRunningRef.current) throw new Error(t('Storyboard save timed out.'))
    if (storyboardSaveErrorRef.current) throw storyboardSaveErrorRef.current
  }, [persistStoryboard, t])

  const updateStoryboard = useCallback((next: VideoStoryboardDocument) => {
    storyboardRef.current = next
    storyboardDirtyRef.current = true
    setStoryboard(next)
    queueStoryboardSave()
  }, [queueStoryboardSave])

  /** §Director-desk 联动：把导演台导出的帧设为当前选中镜头关键帧。 */
  const applyDirectorFrameToShot = useCallback((assetId: string) => {
    if (!selectedShotId) return
    updateStoryboard(
      patchStoryboardShot(storyboardRef.current, selectedShotId, {
        keyframe_asset_id: assetId,
        keyframe_prompt: null,
      })
    )
  }, [selectedShotId, updateStoryboard])

    /** §Director-desk 联动：把导演台机位映射到当前选中镜头。 */
    const applyDirectorCameraToShot = useCallback((camera: DirectorCamera) => {
      if (!selectedShotId) return
      updateStoryboard(
        patchStoryboardShot(
          storyboardRef.current,
          selectedShotId,
          directorCameraShotPatch(camera)
        )
      )
        invalidateVideoSubmissionRequest(submissionIdRef)
      setMessage(t('Applied the director camera to the selected shot.'))
    }, [selectedShotId, t, updateStoryboard])

    /** §Director-desk 联动：机位按顺序覆盖已有镜头，多出的机位追加为新镜头。 */
    const syncDirectorCamerasToStoryboard = useCallback((cameras: DirectorCamera[]) => {
      if (!cameras.length) {
        setMessage(t('The director desk has no cameras to sync.'))
        return
      }
      let next = storyboardRef.current
      cameras.forEach((camera, index) => {
        const patch = directorCameraShotPatch(camera)
        if (index < next.shots.length) {
          next = patchStoryboardShot(next, next.shots[index].id, patch)
          return
        }
        const label = directorCameraLabel(camera)
        next = addStoryboardShot(next, {
          title: label,
          prompt: '',
          input_asset_ids: [],
          job_id: null,
          output_asset_id: null,
          duration: null,
          notes: null,
          transition: null,
        })
        const created = next.shots[next.shots.length - 1]
        next = patchStoryboardShot(next, created.id, patch)
      })
      updateStoryboard(next)
        invalidateVideoSubmissionRequest(submissionIdRef)
      setMessage(t('Synced {{count}} director camera(s) to the storyboard.', { count: cameras.length }))
    }, [t, updateStoryboard])

  // ── board persistence (mirrors the storyboard CAS save chain) ────────

  const persistBoard = useCallback(async () => {
    if (!boardReadyRef.current || !projectIdRef.current) return
    if (!boardDirtyRef.current && !boardSaveRunningRef.current) return
    if (boardSaveRunningRef.current) {
      boardSavePendingRef.current = true
      return
    }
    boardSaveRunningRef.current = true
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    try {
      do {
        boardSavePendingRef.current = false
        const snapshot = boardRef.current
        const controller = new AbortController()
        boardSaveControllerRef.current = controller
        const saved = normalizeVideoBoard(await saveVideoBoard(id, snapshot, controller.signal))
        boardSaveErrorRef.current = null
        if (projectIdRef.current !== id || projectEpochRef.current !== epoch) return
        if (boardRef.current === snapshot) {
          boardRef.current = saved
          boardDirtyRef.current = false
          if (mountedRef.current) setBoard(saved)
        } else {
          const rebased = { ...boardRef.current, revision: saved.revision, updated_at: saved.updated_at }
          boardRef.current = rebased
          boardDirtyRef.current = true
          if (mountedRef.current) setBoard(rebased)
          boardSavePendingRef.current = true
        }
      } while (boardSavePendingRef.current)
    } catch (error) {
      if (isAbort(error) || projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      boardSaveErrorRef.current = error instanceof Error ? error : new Error('Board save failed')
      if (error instanceof VideoBoardConflictError) {
        try {
          const latest = normalizeVideoBoard(await getVideoBoard(id))
          if (projectIdRef.current === id && projectEpochRef.current === epoch) {
            boardRef.current = latest
            boardDirtyRef.current = false
            if (mountedRef.current) {
              setBoard(latest)
              setBoardSelection(current =>
                current.length && latest.nodes.some(node => node.id === current[0]) ? current : []
              )
              setMessage(t('The video canvas changed elsewhere. The latest version was loaded; repeat your last edit.'))
            }
          }
        } catch {
          if (mountedRef.current) setMessage(t('The video canvas changed elsewhere and could not be reloaded.'))
        }
      } else if (mountedRef.current) {
        setMessage(error instanceof Error ? error.message : t('Could not save the canvas.'))
      }
    } finally {
      boardSaveRunningRef.current = false
      boardSaveControllerRef.current = null
      if (boardSavePendingRef.current && projectIdRef.current === id) {
        boardSaveTimerRef.current = window.setTimeout(() => void persistBoard(), 300)
      }
    }
  }, [t])

  const queueBoardSave = useCallback((delay = 150) => {
    if (!boardReadyRef.current) return
    if (boardSaveTimerRef.current) window.clearTimeout(boardSaveTimerRef.current)
    boardSaveTimerRef.current = window.setTimeout(() => void persistBoard(), delay)
  }, [persistBoard])

  const flushBoard = useCallback(async () => {
    if (!boardDirtyRef.current && !boardSaveRunningRef.current) return
    if (boardSaveTimerRef.current) {
      window.clearTimeout(boardSaveTimerRef.current)
      boardSaveTimerRef.current = null
    }
    boardSavePendingRef.current = true
    await persistBoard()
    for (let attempt = 0; attempt < 240 && boardSaveRunningRef.current; attempt += 1) {
      await new Promise<void>(resolve => window.setTimeout(resolve, 25))
    }
    if (boardSaveRunningRef.current) throw new Error(t('Canvas save timed out.'))
    if (boardSaveErrorRef.current) throw boardSaveErrorRef.current
  }, [persistBoard, t])

  /** Adopt a server-authored board (templates, imports, job patches). */
  const adoptBoard = useCallback((next: VideoBoardDocument) => {
    boardRef.current = next
    boardDirtyRef.current = false
    boardReadyRef.current = true
    setBoard(next)
    setBoardReady(true)
  }, [])

  const updateBoard = useCallback((next: VideoBoardDocument) => {
    boardRef.current = next
    boardDirtyRef.current = true
    setBoard(next)
    queueBoardSave()
  }, [queueBoardSave])

  const changeViewMode = useCallback((mode: 'storyboard' | 'board' | 'director' | 'production') => {
    setViewMode(mode)
    if (mode === 'director') setDirectorMounted(true)
    saveToStorage(VIDEO_VIEW_STORAGE_KEY, mode)
  }, [])

  useEffect(() => {
    if (viewMode === 'director') setDirectorMounted(true)
  }, [viewMode])

  const applyProductionPayload = useCallback((payload: { production: VideoProduction; readiness?: ProductionReadiness | null }) => {
    setProduction(payload.production)
    setProductionReadiness(payload.readiness || null)
    if (isProductionStage(payload.production.stage)) setProductionStage(payload.production.stage)
  }, [])

  const persistProduction = useCallback(async (next: VideoProduction) => {
    const id = projectIdRef.current
    if (!id) return
    try {
      const payload = await saveVideoProduction(id, next)
      applyProductionPayload(payload)
    } catch (error) {
      if (mountedRef.current) setMessage(error instanceof Error ? error.message : t('Could not save the episode script.'))
    }
  }, [applyProductionPayload, t])

  const patchProductionScript = useCallback((patch: { title?: string; text?: string }) => {
    setProduction(current => {
      const next: VideoProduction = {
        ...current,
        script: { ...current.script, ...patch },
        review:
          patch.text !== undefined && patch.text !== current.script.text
            ? { ...current.review, status: 'draft', confirmed_at: null }
            : current.review,
      }
      if (productionSaveTimer.current) window.clearTimeout(productionSaveTimer.current)
      productionSaveTimer.current = window.setTimeout(() => {
        void persistProduction(next)
      }, 700)
      return next
    })
  }, [persistProduction])

  const jumpProductionStage = useCallback((stage: ProductionStage) => {
    setProductionStage(stage)
    changeViewMode(stageWorkbenchView(stage))
  }, [changeViewMode])

  const runProduction = useCallback(async (action: 'analyze' | 'confirm' | 'reopen' | 'apply', replace = false) => {
    const id = projectIdRef.current
    if (!id) return
    setProductionBusy(true)
    try {
      if (productionSaveTimer.current) {
        window.clearTimeout(productionSaveTimer.current)
        await persistProduction(productionRef.current)
      }
      const payload =
        action === 'analyze'
          ? await analyzeVideoProduction(id)
          : action === 'confirm'
            ? await confirmVideoProduction(id, productionRef.current.review.notes)
            : action === 'reopen'
              ? await reopenVideoProduction(id, productionRef.current.review.notes)
              : await applyVideoProduction(id, { replace, place_on_board: true })
      applyProductionPayload(payload)
      if (payload.storyboard) {
        const normalized = normalizeVideoStoryboard(payload.storyboard)
        storyboardRef.current = normalized
        setStoryboard(normalized)
      }
      if (action === 'apply') {
        const [boardPayload, characterItems] = await Promise.all([
          getVideoBoard(id),
          listVideoCharacters(id),
        ])
        const normalizedBoard = normalizeVideoBoard(boardPayload)
        boardRef.current = normalizedBoard
        setBoard(normalizedBoard)
        setCharacters(characterItems || [])
        changeViewMode('storyboard')
        setProductionStage('storyboard')
        setMessage(t('Episode plan applied to the storyboard and cast.'))
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Episode production failed'))
    } finally {
      setProductionBusy(false)
    }
  }, [applyProductionPayload, changeViewMode, persistProduction, t])

  const flushBeforeProjectChange = useCallback(async () => {
    try {
      await flushStoryboard()
      await flushBoard()
      return true
    } catch (error) {
      if (mountedRef.current) {
        setMessage(error instanceof Error ? error.message : t('Could not save the storyboard.'))
      }
      return false
    }
  }, [flushStoryboard, flushBoard, t])

  // §5.8: focus a deep-linked canvas node once its view is live.
  useEffect(() => {
    if (viewMode !== 'board' || !boardReady) return
    const nodeId = pendingBoardFocusRef.current
    if (!nodeId) return
    if (!boardRef.current.nodes.some(node => node.id === nodeId)) return
    pendingBoardFocusRef.current = null
    boardFocusNodeRef.current?.focus(nodeId)
  }, [viewMode, boardReady, board])

  const handleBoardViewportChange = useCallback(
    (viewport: VideoBoardDocument['viewport']) => {
      const next = { ...boardRef.current, viewport }
      boardRef.current = next
      boardDirtyRef.current = true
      setBoard(next)
      // Pan/zoom persists with a longer debounce so scrubbing the canvas does
      // not issue a CAS save per frame.
      queueBoardSave(500)
    },
    [queueBoardSave]
  )

  const handleBoardSelectionChange = useCallback((ids: string[]) => {
    setBoardSelection(ids)
    if (ids.length === 1) {
      const node = boardRef.current.nodes.find(item => item.id === ids[0])
      if (node?.kind === 'generate') setPrompt(node.prompt || '')
    }
  }, [])

  const dropAssetOnBoard = useCallback(
    (assetId: string, kind: 'image' | 'video' | 'audio', worldPoint: VideoBoardPoint) => {
      const asset = assets.find(item => item.id === assetId)
      const nodeKind =
        asset?.kind === 'image' || asset?.kind === 'video' || asset?.kind === 'audio'
          ? asset.kind
          : kind
      updateBoard(
        seedVideoAssetOnBoard(
          boardRef.current,
          { id: assetId, kind: nodeKind, filename: asset?.filename, duration: asset?.duration ?? null },
          worldPoint
        )
      )
    },
    [assets, updateBoard]
  )

  const openBoardNode = useCallback(
    (nodeId: string) => {
      const node = boardRef.current.nodes.find(item => item.id === nodeId)
      if (!node) return
      if (node.kind === 'generate') {
        if (node.outputAssetId) {
          const job = node.jobId ? jobs.find(item => item.id === node.jobId) : undefined
          void previewOutput(node.outputAssetId, job)
        }
        return
      }
      if (node.assetId) void previewOutput(node.assetId)
    },
    // previewOutput is re-created every render; refs keep this stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobs]
  )

  const placeTemplate = async (templateId: BoardTemplateId) => {
    const id = projectIdRef.current
    if (!id || boardBusy) return
    setBoardBusy(true)
    try {
      await flushBoard()
      const next = await placeVideoBoardTemplate(id, templateId)
      if (!mountedRef.current || projectIdRef.current !== id) return
      adoptBoard(next)
      setViewMode('board')
      setMessage('')
    } catch (error) {
      if (mountedRef.current) {
        setMessage(error instanceof Error ? error.message : t('Could not place the template.'))
      }
    } finally {
      setBoardBusy(false)
    }
  }

  const importShotsToBoard = async () => {
    const id = projectIdRef.current
    if (!id || boardBusy) return
    setBoardBusy(true)
    try {
      await flushBoard()
      const result = await importVideoStoryboardToBoard(id)
      if (!mountedRef.current || projectIdRef.current !== id) return
      adoptBoard(result.board)
      setViewMode('board')
      setMessage(
        t('{{count}} shot(s) placed on the canvas, {{skipped}} skipped.', {
          count: result.imported,
          skipped: result.skipped,
        })
      )
    } catch (error) {
      if (mountedRef.current) {
        setMessage(error instanceof Error ? error.message : t('Could not place the storyboard on the canvas.'))
      }
    } finally {
      setBoardBusy(false)
    }
  }

  const exportBoardToStrip = async () => {
    const id = projectIdRef.current
    if (!id || boardBusy) return
    setBoardBusy(true)
    try {
      await flushBoard()
      await flushStoryboard()
      const result = await exportVideoBoardToStoryboard(id)
      if (!mountedRef.current || projectIdRef.current !== id) return
      const next = normalizeVideoStoryboard(result.storyboard)
      storyboardRef.current = next
      storyboardDirtyRef.current = false
      storyboardReadyRef.current = true
      setStoryboard(next)
      setStoryboardReady(true)
      setMessage(t('{{count}} shot(s) exported to the storyboard.', { count: result.exported }))
    } catch (error) {
      if (mountedRef.current) {
        setMessage(error instanceof Error ? error.message : t('Could not export the canvas to the storyboard.'))
      }
    } finally {
      setBoardBusy(false)
    }
  }

  // Keep a mirror of the jobs list so the single follow loop always reads the
  // latest set of active jobs without being recreated on every render.
  useEffect(() => {
    jobsRef.current = jobs
  }, [jobs])

  const followSeqStorageKey = (projectId: string, jobId: string) =>
    `knorvia-video-follow-seq:${projectId}:${jobId}`

  const handleFinishedJob = useCallback(
    async (finished: VideoJob, id: string, epoch: number) => {
      if (!mountedRef.current || projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      setJobs(current => replaceJob(current, finished))
      const outputId = finished.output_asset_ids[0]
      if (outputId) {
        const shot = storyboardRef.current.shots.find(item => item.job_id === finished.id)
        if (shot) {
          const next = patchStoryboardShot(storyboardRef.current, shot.id, {
            output_asset_id: outputId,
            duration: Number(finished.parameters.duration) || shot.duration || null,
          })
          storyboardRef.current = next
          storyboardDirtyRef.current = true
          setStoryboard(next)
          queueStoryboardSave()
        }
      }
      if (!terminalRefreshRef.current.has(finished.id)) {
        terminalRefreshRef.current.add(finished.id)
        await refreshProjectAssetsAndJobs(id, epoch)
      }
      // §Phase C5: a finished take updates the variant list of its shot.
      if (finished.storyboard_shot_id && finished.storyboard_shot_id === selectedShotIdRef.current) {
        void refreshShotVariants(finished.storyboard_shot_id)
      }
      if (outputId) {
        setPreviewAssetId(outputId)
        setPreviewJobId(finished.id)
      }
    },
    [queueStoryboardSave, refreshProjectAssetsAndJobs, refreshShotVariants]
  )

  /**
   * One poller for the whole workbench: every cycle sends a single batched
   * request carrying all active job ids plus their event cursors. The old
   * design ran a private 1.2 s loop per running job (two requests each), so
   * N parallel generations meant ~2N requests per tick.
   * Event cursors persist in sessionStorage so a page reload resumes where
   * it left off instead of replaying a finished job's history once.
   */
  const startFollowLoop = useCallback(
    (id: string, epoch: number) => {
      if (followLoopRef.current && !followLoopRef.current.controller.signal.aborted) return
      const controller = new AbortController()
      followLoopRef.current = { controller, timer: null }

      const stop = () => {
        const loop = followLoopRef.current
        if (loop && loop.timer) window.clearTimeout(loop.timer)
        followLoopRef.current = null
      }

      const tick = async (): Promise<void> => {
        const alive =
          mountedRef.current && projectIdRef.current === id && projectEpochRef.current === epoch
        const active = jobsRef.current.filter(job => !isVideoJobFinal(job.status))
        if (!alive || !active.length || controller.signal.aborted) {
          stop()
          return
        }
        try {
          const cursors = active.map(job => {
            const inMemory = followCursorsRef.current.get(job.id)
            if (inMemory !== undefined) return { job_id: job.id, after_seq: inMemory }
            const stored = Number(window.sessionStorage.getItem(followSeqStorageKey(id, job.id)))
            return { job_id: job.id, after_seq: Number.isFinite(stored) && stored > 0 ? stored : 0 }
          })
          const batch = await followVideoJobs(id, cursors, controller.signal)
          if (controller.signal.aborted) return
          followFailuresRef.current = 0
          if (
            mountedRef.current &&
            projectIdRef.current === id &&
            projectEpochRef.current === epoch
          ) {
            setOffline(false)
          }
          for (const [jobId, payload] of Object.entries(batch.events)) {
            const nextSeq = Math.max(followCursorsRef.current.get(jobId) ?? 0, payload.next_seq || 0)
            followCursorsRef.current.set(jobId, nextSeq)
            try {
              window.sessionStorage.setItem(followSeqStorageKey(id, jobId), String(nextSeq))
            } catch {
              /* storage full/blocked — cursor stays in memory */
            }
            for (const event of payload.events) {
              if (!event.message) continue
              if (
                !mountedRef.current ||
                projectIdRef.current !== id ||
                projectEpochRef.current !== epoch
              ) {
                break
              }
              setMessage(event.message)
            }
          }
          const finishedJobs: VideoJob[] = []
          for (const job of Object.values(batch.jobs)) {
            if (!mountedRef.current || projectIdRef.current !== id || projectEpochRef.current !== epoch) {
              break
            }
            setJobs(current => replaceJob(current, job))
            if (isVideoJobFinal(job.status)) finishedJobs.push(job)
          }
          for (const finished of finishedJobs) {
            followCursorsRef.current.delete(finished.id)
            try {
              window.sessionStorage.removeItem(followSeqStorageKey(id, finished.id))
            } catch {
              /* ignore */
            }
            await handleFinishedJob(finished, id, epoch)
          }
        } catch (error) {
          if (controller.signal.aborted || isAbort(error)) return
          followFailuresRef.current += 1
          if (
            mountedRef.current &&
            projectIdRef.current === id &&
            projectEpochRef.current === epoch
          ) {
            setOffline(true)
          }
        }
        const loop = followLoopRef.current
        if (!loop || loop.controller.signal.aborted) return
        const backoff = Math.min(12_000, 750 * 2 ** Math.min(followFailuresRef.current - 1, 4))
        loop.timer = window.setTimeout(() => void tick(), followFailuresRef.current > 0 ? backoff : 1200)
      }

      void tick()
    },
    [handleFinishedJob]
  )

  useEffect(() => {
    if (!projectId) return
    const hasActive = jobs.some(job => !isVideoJobFinal(job.status))
    if (hasActive) startFollowLoop(projectId, projectEpochRef.current)
  }, [jobs, projectId, startFollowLoop])

  // Mirror the newest job per canvas node onto the board (§5.7 step 4–5):
  // jobId/status while running, outputAssetId when the clip lands. Retries
  // win over their predecessor via created_at so pills never flip back.
  useEffect(() => {
    if (!boardReadyRef.current) return
    const latest = new Map<string, VideoJob>()
    for (const job of jobs) {
      if (!job.board_node_id) continue
      const previous = latest.get(job.board_node_id)
      if (!previous || Number(new Date(job.created_at)) >= Number(new Date(previous.created_at))) {
        latest.set(job.board_node_id, job)
      }
    }
    if (!latest.size) return
    let next = boardRef.current
    let changed = false
    for (const [nodeId, job] of latest) {
      const node = next.nodes.find(item => item.id === nodeId)
      if (!node || node.kind !== 'generate') continue
      const outputAssetId = job.output_asset_ids[0] || undefined
      if (node.jobId === job.id && node.status === job.status && node.outputAssetId === outputAssetId) {
        continue
      }
      next = applyVideoJobToBoard(next, {
        nodeId,
        jobId: job.id,
        status: job.status,
        prompt: node.prompt,
        outputAssetId: outputAssetId || null,
        duration: Number(job.parameters.duration) > 0 ? Number(job.parameters.duration) : null,
      })
      changed = true
    }
    if (changed) updateBoard(next)
  }, [jobs, updateBoard])

  useEffect(() => {
    const warnAboutUnsavedDocuments = (event: BeforeUnloadEvent) => {
      const dirty =
        storyboardDirtyRef.current ||
        storyboardSaveRunningRef.current ||
        boardDirtyRef.current ||
        boardSaveRunningRef.current
      if (!dirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    const flushWhenHidden = () => {
      if (document.visibilityState !== 'hidden') return
      if (storyboardDirtyRef.current) void flushStoryboard().catch(() => undefined)
      if (boardDirtyRef.current) void flushBoard().catch(() => undefined)
    }
    window.addEventListener('beforeunload', warnAboutUnsavedDocuments)
    document.addEventListener('visibilitychange', flushWhenHidden)
    return () => {
      window.removeEventListener('beforeunload', warnAboutUnsavedDocuments)
      document.removeEventListener('visibilitychange', flushWhenHidden)
    }
  }, [flushStoryboard, flushBoard])

  useEffect(() => {
    mountedRef.current = true
    const controller = new AbortController()
    initialControllerRef.current = controller
    const syncOnline = () => {
      const isOffline = !navigator.onLine
      setOffline(isOffline)
      if (!isOffline && projectIdRef.current) {
        void refreshProjectAssetsAndJobs(projectIdRef.current, projectEpochRef.current)
      }
    }
    window.addEventListener('online', syncOnline)
    window.addEventListener('offline', syncOnline)
    syncOnline()
    void getVideoFfmpegStatus(controller.signal)
      .then(status => {
        if (mountedRef.current && !controller.signal.aborted) setFfmpeg(status)
      })
      .catch(error => {
        // FFmpeg status is supplementary — an older backend must not block the page.
        if (!isAbort(error) && mountedRef.current) setFfmpeg(null)
      })
    void Promise.all([listVideoModels(controller.signal), listVideoProjects(controller.signal)])
      .then(async ([modelPayload, projectItems]) => {
        if (!mountedRef.current || controller.signal.aborted) return
        setOffline(false)
        const storedModel = loadFromStorage(VIDEO_MODEL_STORAGE_KEY, '')
        const model = preferredVideoModel(modelPayload.options || [], storedModel, modelPayload.selected)
        setModels(modelPayload.options || [])
        if (model) {
          const key = videoModelKey(model)
          const storedOperation = loadFromStorage(VIDEO_OPERATION_STORAGE_KEY, '')
          setModelKey(key)
          setSettings(settingsForVideoModel(model))
          setOperation(preferredVideoOperation(model.capabilities, storedOperation))
        }
        let availableProjects = projectItems
        if (!availableProjects.length) {
          const created = await createVideoProject(t('Untitled video project'))
          availableProjects = [created]
        }
        if (!mountedRef.current || controller.signal.aborted) return
        setProjects(availableProjects)
        const deepLink = new URLSearchParams(window.location.search)
        const requestedProjectId = deepLink.get('project')
        const requestedJobId = deepLink.get('job')
        const requestedView = deepLink.get('view')
        const requestedShot = deepLink.get('shot')
        const incomingPrompt = deepLink.get('prompt')
        const incomingLibraryAsset = deepLink.get('libraryAsset')
        if (incomingPrompt) setPrompt(incomingPrompt)
        if (incomingLibraryAsset) libraryImportRef.current = incomingLibraryAsset
        const initial = availableProjects.find(project => project.id === requestedProjectId) || availableProjects[0]
        deepLinkProjectIdRef.current = requestedProjectId || initial.id
        deepLinkJobIdRef.current = requestedJobId || ''
        deepLinkViewRef.current = requestedView || ''
        deepLinkShotIdRef.current = requestedShot || ''
        activateProject(initial.id, initial.title)
        const epoch = projectEpochRef.current
        await loadProjectData(initial.id, epoch)
      })
      .catch(error => {
        if (!isAbort(error) && mountedRef.current) setMessage(error instanceof Error ? error.message : t('Could not start Video Studio.'))
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false)
      })
    return () => {
      mountedRef.current = false
      controller.abort()
      projectControllerRef.current?.abort()
      // Abort iterates the live controller set at cleanup time; the ref
      // itself is stable and intentionally not listed as a dependency.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const refreshController of refreshControllersRef.current) refreshController.abort()
      refreshControllersRef.current.clear()
      previewControllerRef.current?.abort()
      uploadControllerRef.current?.abort()
      if (storyboardSaveTimerRef.current) window.clearTimeout(storyboardSaveTimerRef.current)
      if (boardSaveTimerRef.current) window.clearTimeout(boardSaveTimerRef.current)
      // SPA navigation does not fire beforeunload. Let the already-versioned
      // saves finish in the background instead of cancelling the user's edit.
      if (storyboardDirtyRef.current || storyboardSaveRunningRef.current) {
        void flushStoryboard().catch(() => undefined)
      } else {
        storyboardSaveControllerRef.current?.abort()
      }
      if (boardDirtyRef.current || boardSaveRunningRef.current) {
        void flushBoard().catch(() => undefined)
      } else {
        boardSaveControllerRef.current?.abort()
      }
      abortFollowers()
      window.removeEventListener('online', syncOnline)
      window.removeEventListener('offline', syncOnline)
    }
  }, [abortFollowers, activateProject, flushBoard, flushStoryboard, loadProjectData, refreshProjectAssetsAndJobs, t])

  useEffect(() => {
    const assetId = libraryImportRef.current
    if (!assetId || !projectId || libraryImportedRef.current === assetId) return
    libraryImportedRef.current = assetId
    void (async () => {
      try {
        const response = await fetch(libraryAssetUrl(assetId))
        if (!response.ok) throw new Error(t('Import failed'))
        const blob = await response.blob()
        const file = new File([blob], 'library-media', { type: blob.type || 'application/octet-stream' })
        const uploaded = await uploadVideoAsset(projectId, file)
        setAssets(current => [uploaded, ...current.filter(item => item.id !== uploaded.id)])
        setSelectedInputIds(current => current.includes(uploaded.id) ? current : [...current, uploaded.id])
      } catch (error) {
        setMessage(error instanceof Error ? error.message : t('Import failed'))
      }
    })()
  }, [projectId, t])

  const chooseProject = async (id: string) => {
    const project = projects.find(item => item.id === id)
    if (!project || id === projectIdRef.current) return
    if (!(await flushBeforeProjectChange())) return
    activateProject(project.id, project.title)
    void loadProjectData(project.id, projectEpochRef.current)
  }

  const createProject = async () => {
    try {
      if (!(await flushBeforeProjectChange())) return
      const project = await createVideoProject(t('Untitled video project'))
      if (!mountedRef.current) return
      setProjects(current => [project, ...current])
      activateProject(project.id, project.title)
      void loadProjectData(project.id, projectEpochRef.current)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not create the project.'))
    }
  }

  const renameProject = async () => {
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    const title = projectTitle.trim()
    const current = projects.find(project => project.id === id)
    if (!id || !title || current?.title === title) return
    try {
      const updated = await updateVideoProject(id, title)
      if (projectIdRef.current === id && projectEpochRef.current === epoch) {
        setProjectTitle(updated.title)
        setProjects(items => items.map(item => (item.id === id ? updated : item)))
      }
    } catch (error) {
      if (projectIdRef.current === id) {
        setProjectTitle(current?.title || title)
        setMessage(error instanceof Error ? error.message : t('Could not rename the project.'))
      }
    }
  }

  const removeProject = async () => {
    const id = projectIdRef.current
    if (!id || !window.confirm(t('Delete this video project and its workspace data?'))) return
    try {
      if (!(await flushBeforeProjectChange())) return
      await deleteVideoProject(id)
      let remaining = projects.filter(project => project.id !== id)
      if (!remaining.length) remaining = [await createVideoProject(t('Untitled video project'))]
      setProjects(remaining)
      activateProject(remaining[0].id, remaining[0].title)
      void loadProjectData(remaining[0].id, projectEpochRef.current)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not delete the project.'))
    }
  }

  const changeModel = (key: string) => {
    const model = models.find(item => videoModelKey(item) === key)
    if (!model) return
    const nextSettings = settingsForVideoModel(model, settings)
    const nextOperation = preferredVideoOperation(model.capabilities, operation)
    setModelKey(key)
    setSettings(nextSettings)
    setOperation(nextOperation)
    setSelectedInputIds(current => sanitizeVideoInputs(current, assets, nextOperation, model.capabilities, nextSettings.audioMode))
    saveToStorage(VIDEO_MODEL_STORAGE_KEY, key)
    if (nextOperation) saveToStorage(VIDEO_OPERATION_STORAGE_KEY, nextOperation)
    invalidateVideoSubmissionRequest(submissionIdRef)
  }

  const changeOperation = (next: VideoOperation) => {
    setOperation(next)
    setSelectedInputIds(current => sanitizeVideoInputs(current, assets, next, selectedModel?.capabilities, settings.audioMode))
    saveToStorage(VIDEO_OPERATION_STORAGE_KEY, next)
    invalidateVideoSubmissionRequest(submissionIdRef)
  }

  const changeSettings = (next: VideoSettings) => {
    setSettings(next)
    setSelectedInputIds(current => sanitizeVideoInputs(current, assets, operation, selectedModel?.capabilities, next.audioMode))
    invalidateVideoSubmissionRequest(submissionIdRef)
  }

  const uploadFiles = async (files: File[]) => {
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    if (!id || !files.length || uploading) return
    const controller = new AbortController()
    uploadControllerRef.current?.abort()
    uploadControllerRef.current = controller
    setUploading(true)
    setUploadProgress(0)
    try {
      for (let index = 0; index < files.length; index += 1) {
        const asset = await uploadVideoAsset(
          id,
          files[index],
          ratio => setUploadProgress((index + ratio) / files.length),
          controller.signal
        )
        if (projectIdRef.current !== id || projectEpochRef.current !== epoch) return
        setAssets(current => [asset, ...current.filter(item => item.id !== asset.id)])
      }
      setMessage(t('Assets uploaded.'))
    } catch (error) {
      if (!isAbort(error) && projectIdRef.current === id) setMessage(error instanceof Error ? error.message : t('Upload failed.'))
    } finally {
      if (projectIdRef.current === id && projectEpochRef.current === epoch) {
        setUploading(false)
        setUploadProgress(0)
      }
    }
  }

  const toggleAsset = (asset: VideoAsset) => {
    const next = toggleVideoInput(selectedInputIds, asset, assets, operation, selectedModel?.capabilities, settings.audioMode)
    if (!selectedInputIds.includes(asset.id) && !next.includes(asset.id)) {
      setMessage(t('This asset is not accepted by the current model and mode.'))
    }
    setSelectedInputIds(next)
    invalidateVideoSubmissionRequest(submissionIdRef)
  }

  const removeAsset = async (asset: VideoAsset) => {
    if (!window.confirm(t('Delete {{name}} from this project?', { name: asset.filename }))) return
    try {
      await deleteVideoAsset(asset.id)
      if (projectIdRef.current !== asset.project_id) return
      setAssets(current => current.filter(item => item.id !== asset.id))
      setSelectedInputIds(current => current.filter(id => id !== asset.id))
      invalidateVideoSubmissionRequest(submissionIdRef)
      if (previewAssetId === asset.id) setPreviewAssetId(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not delete the asset.'))
    }
  }

  const previewOutput = async (assetId: string, job?: VideoJob) => {
    const epoch = projectEpochRef.current
    const ownerProjectId = job?.project_id || projectIdRef.current
    let asset = assets.find(item => item.id === assetId)
    if (!asset) {
      const controller = new AbortController()
      previewControllerRef.current?.abort()
      previewControllerRef.current = controller
      try {
        asset = await getVideoAsset(assetId, controller.signal)
        if (controller.signal.aborted || projectIdRef.current !== ownerProjectId || projectEpochRef.current !== epoch) return
        setAssets(current => [asset as VideoAsset, ...current.filter(item => item.id !== assetId)])
      } catch (error) {
        if (!isAbort(error) && projectIdRef.current === ownerProjectId && projectEpochRef.current === epoch) {
          setMessage(error instanceof Error ? error.message : t('Could not load the result.'))
        }
        return
      } finally {
        if (previewControllerRef.current === controller) previewControllerRef.current = null
      }
    }
    setPreviewAssetId(assetId)
    setPreviewJobId(job?.id || null)
  }

  const observeSubmittedJob = (job: VideoJob, id: string, epoch: number) => {
    if (!isVideoJobFinal(job.status)) {
      // Merge the fresh job into state first — the follow loop picks up
      // whatever is active at its next tick.
      setJobs(current => replaceJob(current, job))
      startFollowLoop(id, epoch)
      return
    }
    // An idempotent replay can return a task that finished while the original
    // response was lost. There is nothing to follow in that case, but its
    // output still has to be pulled into the current workspace immediately.
    void refreshProjectAssetsAndJobs(id, epoch).then(() => {
      if (!mountedRef.current || projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      const outputId = job.output_asset_ids[0]
      if (outputId) void previewOutput(outputId, job)
    })
  }

  /** §5.7: generate straight from a canvas node with its edge inputs+roles. */
  const handleGenerateBoardNode = async (nodeId: string) => {
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    if (!id) return
    const node = boardRef.current.nodes.find(item => item.id === nodeId)
    if (!node || node.kind !== 'generate') return
    if (!selectedModel) {
      setMessage(t('Configure and choose a video model.'))
      return
    }
    const capabilities = selectedModel.capabilities
    const nodeOperation = advertisedVideoOperations(capabilities).includes(node.operation as VideoOperation)
      ? (node.operation as VideoOperation)
      : preferredVideoOperation(capabilities, operation)
    if (!nodeOperation) {
      setMessage(t('Choose a generation mode.'))
      return
    }
    const specs = videoInputSpecs(boardRef.current, nodeId)
    const nodePrompt = collectVideoNodePrompt(boardRef.current, nodeId)
    // §Phase C4: the card's camera badge resolves onto the model's own
    // camera* enum parameter, so the motion rides the schema-validated
    // parameter channel instead of the prompt text.
    const nodeCamera = cameraParameterForKey(capabilities, node.camera)
    const nodeSettings = settingsForVideoModel(selectedModel, {
      ...settings,
      aspectRatio: node.ratio && (capabilities.aspect_ratios || []).includes(node.ratio) ? node.ratio : settings.aspectRatio,
      resolution:
        node.resolution && (capabilities.resolutions || []).includes(node.resolution)
          ? node.resolution
          : settings.resolution,
      duration: node.seconds && node.seconds > 0 ? node.seconds : settings.duration,
      // An audio edge means the clip carries a soundtrack/voice reference.
      ...(specs.some(spec => spec.role === 'audio') && (capabilities.audio_modes || []).includes('input')
        ? { audioMode: 'input' as const }
        : {}),
      ...(nodeCamera ? { extra: { ...settings.extra, [nodeCamera.key]: nodeCamera.value } } : {}),
    })
    const check = validateVideoSubmission({
      projectId: id,
      model: selectedModel,
      operation: nodeOperation,
      prompt: nodePrompt,
      selectedInputIds: specs.map(spec => spec.assetId),
      assets,
      settings: nodeSettings,
      costConfirmed,
    })
    if (!check.ok) {
      setMessage(validationLabel(check.reason, t))
      return
    }
    try {
      const job = await createVideoJob(
        id,
        buildVideoJobPayload({
          model: selectedModel,
          operation: nodeOperation,
          prompt: nodePrompt,
          selectedInputIds: [],
          settings: nodeSettings,
          clientRequestId: crypto.randomUUID(),
          boardNodeId: nodeId,
          inputs: specs.map(spec => ({ asset_id: spec.assetId, role: spec.role })),
        })
      )
      if (!mountedRef.current || projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      setJobs(current => replaceJob(current, job))
      updateBoard(
        applyVideoJobToBoard(boardRef.current, {
          nodeId,
          jobId: job.id,
          status: job.status,
          prompt: nodePrompt,
          outputAssetId: job.output_asset_ids[0] || null,
        })
      )
      setQueueDrawerOpen(true)
      observeSubmittedJob(job, id, epoch)
    } catch (error) {
      if (mountedRef.current && projectIdRef.current === id && projectEpochRef.current === epoch) {
        setMessage(error instanceof Error ? error.message : t('Could not submit the video task.'))
      }
    }
  }

  const submit = async () => {
    if (!validation.ok || !selectedModel || !operation) {
      setMessage(validationLabel(validation.reason, t))
      return
    }
    if (submissionGuardRef.current) return
    const submissionToken = Symbol('video-submission')
    submissionGuardRef.current = submissionToken
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    const clientRequestId = ensureVideoSubmissionRequest(submissionIdRef)
    setSubmitting(true)
    setMessage('')
    try {
      let targetShot = storyboardRef.current.shots.find(shot => shot.id === selectedShotId)
      if (!targetShot) {
        const prepared = addStoryboardShot(storyboardRef.current, {
          title: t('Shot {{n}}', { n: storyboardRef.current.shots.length + 1 }),
          prompt: prompt.trim(),
          input_asset_ids: [...selectedInputIds],
          job_id: null,
          output_asset_id: null,
          duration: settings.duration === '' ? null : settings.duration,
          notes: null,
          transition: null,
        })
        targetShot = prepared.shots[prepared.shots.length - 1]
        updateStoryboard(prepared)
        setSelectedShotId(targetShot.id)
      } else {
        updateStoryboard(
          patchStoryboardShot(storyboardRef.current, targetShot.id, {
            prompt: prompt.trim(),
            input_asset_ids: [...selectedInputIds],
            duration: settings.duration === '' ? null : settings.duration,
          })
        )
      }
      await flushStoryboard()

      const job = await createVideoJob(
        id,
        buildVideoJobPayload({
          model: selectedModel,
          operation,
          prompt,
          selectedInputIds,
          settings,
          clientRequestId,
          storyboardShotId: targetShot.id,
        })
      )
      if (!mountedRef.current || projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      invalidateVideoSubmissionRequest(submissionIdRef)
      setJobs(current => replaceJob(current, job))
      const nextStoryboard = bindJobToStoryboardShot(storyboardRef.current, targetShot.id, job)
      updateStoryboard(nextStoryboard)
      setSelectedShotId(targetShot.id)
      setQueueDrawerOpen(true)
      observeSubmittedJob(job, id, epoch)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not submit the video task.'))
    } finally {
      if (submissionGuardRef.current === submissionToken) submissionGuardRef.current = null
      if (mountedRef.current && projectIdRef.current === id && projectEpochRef.current === epoch) setSubmitting(false)
    }
  }

  const cancelJob = async (job: VideoJob) => {
    setBusyJobId(job.id)
    try {
      const updated = await cancelVideoJob(job.id)
      if (projectIdRef.current !== job.project_id) return
      if (updated) setJobs(current => replaceJob(current, updated))
      else await refreshProjectAssetsAndJobs(job.project_id, projectEpochRef.current)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not cancel the task.'))
    } finally {
      setBusyJobId(null)
    }
  }

  const retryJob = async (job: VideoJob) => {
    if (!costConfirmed) {
      setMessage(t('Confirm possible provider credit usage.'))
      return
    }
    setBusyJobId(job.id)
    try {
      const shot = retryStoryboardShot(storyboardRef.current, job)
      const requestId = retryRequestIdsRef.current.get(job.id) || crypto.randomUUID()
      retryRequestIdsRef.current.set(job.id, requestId)
      const retried = await retryVideoJob(job.id, {
        client_request_id: requestId,
        confirmed_cost: true,
        storyboard_shot_id: shot?.id ?? null,
      })
      if (projectIdRef.current !== job.project_id) return
      retryRequestIdsRef.current.delete(job.id)
      setJobs(current => replaceJob(current, retried))
      if (shot) {
        updateStoryboard(bindJobToStoryboardShot(storyboardRef.current, shot.id, retried))
        setSelectedShotId(shot.id)
      }
      observeSubmittedJob(retried, job.project_id, projectEpochRef.current)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not retry the task.'))
    } finally {
      setBusyJobId(null)
    }
  }

  /** §Phase C5: paid reroll of a shot's current take — same parameters, fresh seed. */
  const handleRerollShot = async (shot: VideoStoryboardShot) => {
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    if (!id || !shot.job_id) return
    if (!costConfirmed) {
      setMessage(t('Confirm possible provider credit usage.'))
      return
    }
    setRerollBusyShotId(shot.id)
    try {
      const rerolled = await rerollVideoJob(shot.job_id, {
        client_request_id: crypto.randomUUID(),
        confirmed_cost: true,
        storyboard_shot_id: shot.id,
      })
      if (!mountedRef.current || projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      setJobs(current => replaceJob(current, rerolled))
      updateStoryboard(bindJobToStoryboardShot(storyboardRef.current, shot.id, rerolled))
      setSelectedShotId(shot.id)
      setQueueDrawerOpen(true)
      void refreshShotVariants(shot.id)
      observeSubmittedJob(rerolled, id, epoch)
    } catch (error) {
      if (mountedRef.current && projectIdRef.current === id && projectEpochRef.current === epoch) {
        setMessage(error instanceof Error ? error.message : t('Could not reroll the task.'))
      }
    } finally {
      if (mountedRef.current) setRerollBusyShotId(null)
    }
  }

  /** §Phase C5 free action: make one historical variant the shot's current take. */
  const handleBindVariant = async (shot: VideoStoryboardShot, job: VideoJob) => {
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    if (!id) return
    setRerollBusyShotId(shot.id)
    try {
      const { shot: bound } = await bindVideoShotJob(id, shot.id, job.id)
      if (!mountedRef.current || projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      // Optimistic local patch; the queued CAS save reconciles with the
      // server revision the bind already bumped (same path as retry).
      updateStoryboard(
        patchStoryboardShot(storyboardRef.current, shot.id, {
          job_id: bound?.job_id ?? job.id,
          output_asset_id: bound?.output_asset_id ?? job.output_asset_ids[0] ?? null,
        })
      )
      void refreshShotVariants(shot.id)
      const outputId = bound?.output_asset_id ?? job.output_asset_ids[0]
      if (outputId) void previewOutput(outputId, job)
    } catch (error) {
      if (mountedRef.current && projectIdRef.current === id && projectEpochRef.current === epoch) {
        setMessage(error instanceof Error ? error.message : t('Could not switch the current version.'))
      }
    } finally {
      if (mountedRef.current) setRerollBusyShotId(null)
    }
  }

  /** §Phase C5: paid reroll of a canvas generate card's latest take. */
  const handleRerollBoardNode = async (nodeId: string) => {
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    if (!id) return
    const node = boardRef.current.nodes.find(item => item.id === nodeId)
    if (!node || node.kind !== 'generate' || !node.jobId) return
    if (!costConfirmed) {
      setMessage(t('Confirm possible provider credit usage.'))
      return
    }
    setBusyJobId(node.jobId)
    try {
      const rerolled = await rerollVideoJob(node.jobId, {
        client_request_id: crypto.randomUUID(),
        confirmed_cost: true,
        board_node_id: nodeId,
      })
      if (!mountedRef.current || projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      setJobs(current => replaceJob(current, rerolled))
      updateBoard(
        applyVideoJobToBoard(boardRef.current, {
          nodeId,
          jobId: rerolled.id,
          status: rerolled.status,
          prompt: rerolled.prompt,
          outputAssetId: rerolled.output_asset_ids[0] || null,
        })
      )
      setQueueDrawerOpen(true)
      observeSubmittedJob(rerolled, id, epoch)
    } catch (error) {
      if (mountedRef.current && projectIdRef.current === id && projectEpochRef.current === epoch) {
        setMessage(error instanceof Error ? error.message : t('Could not reroll the task.'))
      }
    } finally {
      if (mountedRef.current) setBusyJobId(null)
    }
  }

  const loadMoreAssets = async () => {
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    if (!nextAssetCursor) return
    try {
      const payload = await listVideoAssets(id, nextAssetCursor)
      if (projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      setAssets(current => [...current, ...payload.assets.filter(asset => !current.some(item => item.id === asset.id))])
      setNextAssetCursor(payload.next_cursor)
      setOffline(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not load more assets.'))
    }
  }

  const loadMoreJobs = async () => {
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    if (!nextJobCursor) return
    try {
      const payload = await listVideoJobs(id, nextJobCursor)
      if (projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      setJobs(current => [...current, ...payload.jobs.filter(job => !current.some(item => item.id === job.id))])
      setNextJobCursor(payload.next_cursor)
      setOffline(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not load more tasks.'))
    }
  }

  const selectShot = (shot: VideoStoryboardShot) => {
    setSelectedShotId(shot.id)
    setPrompt(shot.prompt)
    setSelectedInputIds(
      sanitizeVideoInputs(
        shot.input_asset_ids,
        assets,
        operation,
        selectedModel?.capabilities,
        settings.audioMode
      )
    )
    if (shot.duration) {
      setSettings(current =>
        selectedModel
          ? settingsForVideoModel(selectedModel, { ...current, duration: shot.duration || current.duration })
          : current
      )
    }
    invalidateVideoSubmissionRequest(submissionIdRef)
    if (shot.output_asset_id) {
      const job = jobs.find(item => item.id === shot.job_id)
      void previewOutput(shot.output_asset_id, job)
    }
  }

  /** A1: paid first-frame image for the selected shot (UI already confirmed cost). */
  const generateShotKeyframe = async (shot: VideoStoryboardShot, promptOverride: string) => {
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    if (!id || shotBusyId) return
    setShotBusyId(shot.id)
    setMessage('')
    try {
      const override = promptOverride.trim()
      if (override) {
        updateStoryboard(patchStoryboardShot(storyboardRef.current, shot.id, { keyframe_prompt: override }))
        await flushStoryboard()
      }
      const result = await generateVideoShotKeyframe(id, shot.id, {
        prompt: override || undefined,
        confirmed_cost: true,
      })
      if (!mountedRef.current || projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      const next = normalizeVideoStoryboard(result.storyboard)
      storyboardRef.current = next
      storyboardDirtyRef.current = false
      setStoryboard(next)
      setAssets(current => [result.asset, ...current.filter(item => item.id !== result.asset.id)])
      setMessage(t('Keyframe generated and bound to the shot.'))
    } catch (error) {
      if (mountedRef.current) {
        setMessage(error instanceof Error ? error.message : t('Could not generate the keyframe.'))
      }
    } finally {
      setShotBusyId(null)
    }
  }

  /** A2: paid TTS narration for the selected shot (UI already confirmed cost). */
  const generateShotVoiceover = async (shot: VideoStoryboardShot, text: string, voice: string) => {
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    if (!id || shotBusyId || !text.trim()) return
    setShotBusyId(shot.id)
    setMessage('')
    try {
      updateStoryboard(patchStoryboardShot(storyboardRef.current, shot.id, {
        voiceover_text: text.trim(),
        voiceover_voice: voice.trim(),
      }))
      await flushStoryboard()
      const result = await generateVideoShotVoiceover(id, shot.id, {
        text: text.trim(),
        voice: voice.trim() || undefined,
        confirmed_cost: true,
      })
      if (!mountedRef.current || projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      const next = normalizeVideoStoryboard(result.storyboard)
      storyboardRef.current = next
      storyboardDirtyRef.current = false
      setStoryboard(next)
      setAssets(current => [result.asset, ...current.filter(item => item.id !== result.asset.id)])
      setMessage(t('Narration synthesized and bound to the shot.'))
    } catch (error) {
      if (mountedRef.current) {
        setMessage(error instanceof Error ? error.message : t('Could not synthesize the narration.'))
      }
    } finally {
      setShotBusyId(null)
    }
  }

  // ── §Phase B2 character library actions ────────────────────────────
  const createCharacter = async (draft: CharacterDraft) => {
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    if (!id || characterCreating) return
    setCharacterCreating(true)
    setMessage('')
    try {
      const character = await createVideoCharacter(id, draft)
      if (!mountedRef.current || projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      setCharacters(current => [...current, character])
      setMessage(t('Character created.'))
    } catch (error) {
      if (mountedRef.current) {
        setMessage(error instanceof Error ? error.message : t('Could not create the character.'))
      }
    } finally {
      if (mountedRef.current) setCharacterCreating(false)
    }
  }

  const patchCharacter = async (
    character: VideoCharacter,
    patch: { name?: string; description?: string; voice_hint?: string }
  ) => {
    const id = projectIdRef.current
    if (!id) return
    try {
      const updated = await updateVideoCharacter(id, character.id, patch)
      setCharacters(current => current.map(item => (item.id === updated.id ? updated : item)))
    } catch (error) {
      if (mountedRef.current) {
        setMessage(error instanceof Error ? error.message : t('Could not update the character.'))
      }
    }
  }

  const removeCharacter = async (character: VideoCharacter) => {
    const id = projectIdRef.current
    if (!id) return
    try {
      await deleteVideoCharacter(id, character.id)
      if (!mountedRef.current) return
      setCharacters(current => current.filter(item => item.id !== character.id))
    } catch (error) {
      if (mountedRef.current) {
        setMessage(error instanceof Error ? error.message : t('Could not delete the character.'))
      }
    }
  }

  /** B1: paid three-view sheet via the shared imagegen pipeline (two-step confirmed in the panel). */
  const generateCharacterThreeView = async (character: VideoCharacter) => {
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    if (!id || characterBusyId) return
    setCharacterBusyId(character.id)
    setMessage('')
    try {
      const result = await generateVideoCharacterThreeView(id, character.id, { confirmed_cost: true })
      if (!mountedRef.current || projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      setCharacters(current =>
        current.map(item => (item.id === result.character.id ? result.character : item))
      )
      setAssets(current => [result.asset, ...current.filter(item => item.id !== result.asset.id)])
      setMessage(t('Three-view sheet generated and bound to the character.'))
    } catch (error) {
      if (mountedRef.current) {
        setMessage(error instanceof Error ? error.message : t('Could not generate the three-view sheet.'))
      }
    } finally {
      if (mountedRef.current) setCharacterBusyId(null)
    }
  }

  /** B2 injection ①: seed the character reference on the canvas, wiring it into selected generate cards. */
  const addCharacterToBoard = (character: VideoCharacter) => {
    const { board: next, nodeId } = injectCharacterOnBoard(boardRef.current, character, boardSelection)
    if (next === boardRef.current) {
      setMessage(
        nodeId
          ? t('{{name}} is already on the canvas.', { name: character.name })
          : t('Add a reference image to {{name}} before placing it on the canvas.', { name: character.name })
      )
      return
    }
    updateBoard(next)
    if (nodeId) {
      pendingBoardFocusRef.current = nodeId
      changeViewMode('board')
    }
  }

  /** B2 injection ②: batch the character's reference images into the composer inputs. */
  const addCharacterToComposer = (character: VideoCharacter) => {
    setSelectedInputIds(current =>
      appendCharacterToVideoInputs(
        current,
        character,
        assets,
        operation,
        selectedModel?.capabilities,
        settings.audioMode
      )
    )
    invalidateVideoSubmissionRequest(submissionIdRef)
    setMessage(t('Character references added to the composer inputs.'))
  }

  /** A3: free local MP4 composition — no cost confirmation needed. */
  const submitComposition = async (config: VideoComposeConfig) => {
    const id = projectIdRef.current
    const epoch = projectEpochRef.current
    if (!id || composing) return
    setComposing(true)
    setMessage('')
    try {
      await flushStoryboard()
      const job = await composeVideoProject(id, {
        subtitle: {
          mode: config.subtitle_mode,
          ...(config.subtitle_style ? { style: config.subtitle_style } : {}),
          ...(config.subtitle_mode === 'from_asset' && config.srt_asset_id
            ? { srt_asset_id: config.srt_asset_id }
            : {}),
          ...(config.subtitle_font_size !== null ? { font_size: config.subtitle_font_size } : {}),
          ...(config.subtitle_primary_colour ? { primary_colour: config.subtitle_primary_colour } : {}),
        },
        audio: {
          voiceovers: config.voiceovers,
          bgm_asset_id: config.bgm_asset_id || undefined,
        },
        output: {
          resolution: config.resolution,
          ...(config.upscale ? { upscale: true } : {}),
        },
        client_request_id: crypto.randomUUID(),
      })
      if (!mountedRef.current || projectIdRef.current !== id || projectEpochRef.current !== epoch) return
      setJobs(current => replaceJob(current, job))
      observeSubmittedJob(job, id, epoch)
      setMessage(t('Composition queued — stitching shots locally.'))
    } catch (error) {
      if (mountedRef.current) {
        setMessage(error instanceof Error ? error.message : t('Could not start the composition.'))
      }
    } finally {
      if (mountedRef.current) setComposing(false)
    }
  }

  const installFfmpegEngine = async () => {
    if (installingFfmpeg) return
    setInstallingFfmpeg(true)
    setMessage('')
    try {
      const status = await installVideoFfmpeg()
      if (!mountedRef.current) return
      setFfmpeg(status)
      setMessage(status.available ? t('Local composition engine installed.') : t('FFmpeg installation failed.'))
    } catch (error) {
      if (mountedRef.current) {
        setMessage(error instanceof Error ? error.message : t('Could not install FFmpeg.'))
      }
    } finally {
      if (mountedRef.current) setInstallingFfmpeg(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--muted-foreground)]">
        <Loader2 size={20} className="animate-spin" />
      </div>
    )
  }

  const assetsPanel = (
    <VideoAssetsPanel
      assets={assets}
      selectedIds={selectedInputIds}
      loading={projectLoading}
      uploading={uploading}
      uploadProgress={uploadProgress}
      onUpload={files => void uploadFiles(files)}
      onToggle={toggleAsset}
      onPreview={asset => {
        setPreviewAssetId(asset.id)
        setPreviewJobId(null)
      }}
      onDelete={asset => void removeAsset(asset)}
      canLoadMore={Boolean(nextAssetCursor)}
      onLoadMore={() => void loadMoreAssets()}
    />
  )
  const charactersPanel = (
    <CharacterLibrary
      characters={characters}
      assets={assets}
      loading={projectLoading}
      busyCharacterId={characterBusyId}
      creating={characterCreating}
      onCreate={draft => void createCharacter(draft)}
      onUpdate={(character, patch) => void patchCharacter(character, patch)}
      onDelete={character => void removeCharacter(character)}
      onGenerateThreeView={character => void generateCharacterThreeView(character)}
      onAddToBoard={addCharacterToBoard}
      onAddToComposer={addCharacterToComposer}
    />
  )
  // §Phase B2: assets and characters share the left rail behind a tab switch.
  const leftPanel = (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label={t('Project assets and characters')}
        className="flex shrink-0 items-center gap-0.5 border-b border-[var(--border)] px-3 pt-2.5"
      >
        {([['assets', t('Assets')], ['characters', t('Characters')]] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={leftTab === key}
            onClick={() => setLeftTab(key)}
            className={`-mb-px rounded-t-lg border-x border-t px-3 py-1.5 text-[11px] font-medium ${
              leftTab === key
                ? 'border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]'
                : 'border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{leftTab === 'characters' ? charactersPanel : assetsPanel}</div>
    </div>
  )
  const queuePanel = (
    <VideoJobQueue
      jobs={jobs}
      models={models}
      busyJobId={busyJobId}
      focusedJobId={focusedJobId}
      onCancel={job => void cancelJob(job)}
      onRetry={job => void retryJob(job)}
      onPreviewOutput={(assetId, job) => void previewOutput(assetId, job)}
      canLoadMore={Boolean(nextJobCursor)}
      onLoadMore={() => void loadMoreJobs()}
      priceHints={priceHints}
    />
  )

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--background)]">
      <header className="flex h-14 shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--border)] px-3 md:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--primary)]/[0.1] text-[var(--primary)]">
            <Film size={17} />
          </span>
          <div className="hidden min-w-0 sm:block">
            <h1 className="truncate text-sm font-semibold">{t('Video Studio')}</h1>
            <p className="text-[9.5px] text-[var(--muted-foreground)]">{t('Storyboard and generation workspace')}</p>
          </div>
        </div>
        <CreationDeskSwitch />
        <select
          value={projectId}
          onChange={event => chooseProject(event.target.value)}
          aria-label={t('Video project')}
          className="ml-1 h-8 min-w-0 max-w-44 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[11px] outline-none"
        >
          {projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
        </select>
        <input
          value={projectTitle}
          maxLength={120}
          onChange={event => setProjectTitle(event.target.value)}
          onBlur={() => void renameProject()}
          onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          aria-label={t('Project title')}
          className="hidden h-8 min-w-0 max-w-48 flex-1 rounded-lg border border-transparent bg-transparent px-2 text-xs outline-none hover:border-[var(--border)] focus:border-[var(--primary)] lg:block"
        />
        <button type="button" onClick={() => void createProject()} aria-label={t('New video project')} className="rounded-lg p-2 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]">
          <FolderPlus size={15} />
        </button>
        {projectId ? (
          <a
            href={videoProjectExportUrl(projectId)}
            download
            aria-label={t('Export video project')}
            className="hidden rounded-lg p-2 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)] sm:block"
          >
            <Download size={14} />
          </a>
        ) : null}
        <button type="button" onClick={() => void removeProject()} aria-label={t('Delete video project')} className="hidden rounded-lg p-2 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--destructive)] sm:block">
          <Trash2 size={14} />
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          {offline ? (
            <span className="hidden items-center gap-1 rounded-lg bg-amber-500/10 px-2 py-1 text-[10px] text-amber-600 sm:inline-flex">
              <WifiOff size={11} /> {t('Offline')}
            </span>
          ) : runningCount ? (
            <span className="hidden items-center gap-1 rounded-lg bg-[var(--primary)]/[0.08] px-2 py-1 text-[10px] text-[var(--primary)] sm:inline-flex">
              <Loader2 size={11} className="animate-spin" /> {t('{{count}} running', { count: runningCount })}
            </span>
          ) : (
            <span className="hidden items-center gap-1 text-[10px] text-emerald-600 sm:inline-flex">
              <CheckCircle2 size={11} /> {t('Ready')}
            </span>
          )}
          <button type="button" onClick={() => setAssetsDrawerOpen(true)} aria-label={t('Open project assets')} className="rounded-lg p-2 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 xl:hidden">
            <Layers3 size={16} />
          </button>
          <button type="button" onClick={() => setLibraryOpen(true)} aria-label={t('Library')} className="rounded-lg p-2 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55">
            <FolderOpen size={16} />
          </button>
          {viewMode === 'board' ? (
            <button type="button" onClick={() => setAgentOpen(true)} aria-label={t('Canvas Agent')} className="rounded-lg p-2 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55">
              <Sparkles size={16} />
            </button>
          ) : null}
          <button type="button" onClick={() => setQueueDrawerOpen(true)} aria-label={t('Open generation queue')} className="rounded-lg p-2 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 2xl:hidden">
            <PanelRight size={16} />
          </button>
        </div>
      </header>

      {message ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-[var(--border)] bg-amber-500/[0.08] px-4 py-2 text-[10.5px] text-amber-700" role="status" aria-live="polite">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{message}</span>
          <button type="button" onClick={() => setMessage('')} aria-label={t('Dismiss')} className="rounded p-0.5 hover:bg-black/5"><X size={12} /></button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className={`hidden w-64 shrink-0 border-r border-[var(--border)] xl:block ${viewMode === 'director' ? '!hidden' : ''}`}>{leftPanel}</aside>
        <main className={`flex min-w-0 flex-1 flex-col ${viewMode === 'board' || viewMode === 'director' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
          {/* §5.2 workbench mode toggle + §5.5 templates + storyboard ⇄ canvas */}
          <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--border)] px-3 py-2 md:px-4">
            <div className="flex min-w-0 items-center gap-2">
            <div
              role="tablist"
              aria-label={t('Storyboard and generation workspace')}
              className="flex min-w-0 items-center overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--muted)]/35 p-0.5"
            >
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'storyboard'}
                onClick={() => changeViewMode('storyboard')}
                className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[10px] px-3 text-[11.5px] font-medium transition-colors ${
                  viewMode === 'storyboard'
                    ? 'bg-[var(--background)] text-[var(--foreground)] shadow-sm'
                    : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                }`}
              >
                <LayoutList size={13} /> {t('Storyboard')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'board'}
                onClick={() => changeViewMode('board')}
                className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[10px] px-3 text-[11.5px] font-medium transition-colors ${
                  viewMode === 'board'
                    ? 'bg-[var(--background)] text-[var(--foreground)] shadow-sm'
                    : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                }`}
              >
                <Clapperboard size={13} /> {t('Canvas')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'production'}
                onClick={() => changeViewMode('production')}
                className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[10px] px-3 text-[11.5px] font-medium transition-colors ${
                  viewMode === 'production'
                    ? 'bg-[var(--background)] text-[var(--foreground)] shadow-sm'
                    : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                }`}
              >
                <ScrollText size={13} /> {t('Episode')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'director'}
                onClick={() => changeViewMode('director')}
                className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[10px] px-3 text-[11.5px] font-medium transition-colors ${
                  viewMode === 'director'
                    ? 'bg-[var(--background)] text-[var(--foreground)] shadow-sm'
                    : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                }`}
              >
                <Boxes size={13} />
                <span className="hidden xl:inline">{t('White-model Previs')}</span>
                <span className="xl:hidden">{t('Previs')}</span>
              </button>
            </div>
            {viewMode === 'director' ? (
              <p className="hidden min-w-0 truncate text-[11px] text-[var(--muted-foreground)] 2xl:block">
                {t('Lock scene space, character blocking and camera movement before generation.')}
              </p>
            ) : null}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {viewMode === 'board' ? (
                <label
                  className="mr-1 hidden max-w-72 items-center gap-1.5 text-[10.5px] leading-tight text-[var(--muted-foreground)] 2xl:inline-flex"
                  title={t('I understand this request may use paid provider credits.')}
                >
                  <input
                    type="checkbox"
                    checked={costConfirmed}
                    onChange={event => setCostConfirmed(event.target.checked)}
                    className="h-3.5 w-3.5 shrink-0 accent-[var(--primary)]"
                  />
                  {t('I understand this request may use paid provider credits.')}
                </label>
              ) : null}
              {viewMode !== 'director' ? (
                <>
                  <details
                    className="relative"
                    open={templatesOpen}
                    onToggle={event => setTemplatesOpen(event.currentTarget.open)}
                  >
                    <summary className="inline-flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 text-[11.5px] hover:bg-[var(--muted)]/45 [&::-webkit-details-marker]:hidden">
                      {boardBusy ? <Loader2 size={13} className="animate-spin" /> : <LayoutTemplate size={13} />}
                      {t('Templates')}
                    </summary>
                    <div className="absolute right-0 z-50 mt-1.5 max-h-[min(24rem,calc(100vh-8rem))] w-60 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)] p-1 shadow-xl">
                      {BOARD_TEMPLATE_IDS.map(templateId => (
                        <button
                          key={templateId}
                          type="button"
                          disabled={boardBusy || projectLoading}
                          onClick={() => {
                            setTemplatesOpen(false)
                            void placeTemplate(templateId)
                          }}
                          className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[11.5px] hover:bg-[var(--muted)]/50 disabled:opacity-50"
                        >
                          {t(BOARD_TEMPLATE_LABELS[templateId])}
                        </button>
                      ))}
                    </div>
                  </details>
                  <button
                    type="button"
                    disabled={boardBusy || projectLoading}
                    onClick={() => void importShotsToBoard()}
                    title={t('Import storyboard')}
                    aria-label={t('Import storyboard')}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 text-[11.5px] hover:bg-[var(--muted)]/45 disabled:opacity-50"
                  >
                    <ArrowDownToLine size={13} /> <span className="hidden sm:inline">{t('Import storyboard')}</span>
                  </button>
                  <button
                    type="button"
                    disabled={boardBusy || projectLoading}
                    onClick={() => void exportBoardToStrip()}
                    title={t('Export to storyboard')}
                    aria-label={t('Export to storyboard')}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 text-[11.5px] hover:bg-[var(--muted)]/45 disabled:opacity-50"
                  >
                    <ArrowUpFromLine size={13} /> <span className="hidden sm:inline">{t('Export to storyboard')}</span>
                  </button>
                </>
              ) : null}
              {viewMode === 'storyboard' ? (
                <button
                  type="button"
                  onClick={() => setComposeOpen(open => !open)}
                  aria-pressed={composeOpen}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] ${
                    composeOpen
                      ? 'border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]'
                      : 'border-[var(--border)] hover:bg-[var(--muted)]/45'
                  }`}
                >
                  <Film size={13} /> {t('Compose and subtitles')}
                </button>
              ) : null}
            </div>
            </div>
            {viewMode !== 'director' ? (
              <ProductionStageRail
                stage={productionStage}
                readiness={productionReadiness}
                onSelect={jumpProductionStage}
              />
            ) : null}
          </div>
          <div className="relative min-h-0 flex-1">
          {viewMode === 'production' ? (
            <ProductionPanel
              production={production}
              readiness={productionReadiness}
              busy={productionBusy}
              onScript={patchProductionScript}
              onAnalyze={() => void runProduction('analyze')}
              onConfirm={() => void runProduction('confirm')}
              onReopen={() => void runProduction('reopen')}
              onApply={replace => void runProduction('apply', replace)}
              onJump={jumpProductionStage}
            />
          ) : viewMode === 'board' ? (
            boardReady ? (
              <div className="relative flex min-h-0 flex-1 flex-col">
              <VideoInfiniteBoard
                board={board}
                labels={boardLabels}
                assetUrl={videoAssetUrl}
                selectedIds={boardSelection}
                jobsById={jobsById}
                readOnly={offline}
                className="min-h-0 flex-1"
                variantCounts={boardVariantCounts}
                onRerollRequest={nodeId => void handleRerollBoardNode(nodeId)}
                onSelectionChange={handleBoardSelectionChange}
                onBoardChange={updateBoard}
                onViewportChange={handleBoardViewportChange}
                onGenerateRequest={nodeId => void handleGenerateBoardNode(nodeId)}
                onNodeOpen={openBoardNode}
                focusNodeRef={boardFocusNodeRef}
                onDropAsset={dropAssetOnBoard}
              />
              <StudioAgentPanel
                open={agentOpen}
                onClose={() => setAgentOpen(false)}
                studio="video"
                projectId={projectId}
                prompt={prompt}
                modelKey={modelKey}
                selectedIds={boardSelection}
                language={i18n.language}
                onStarted={() => {
                  void getVideoBoard(projectId).then(document => {
                    setBoard(normalizeVideoBoard(document))
                  })
                }}
              />
              </div>
            ) : (
              <div role="status" className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]">
                <Loader2 size={16} className="animate-spin" /> {t('Loading')}
              </div>
            )
          ) : viewMode !== 'director' ? (
          <div className="relative mx-auto flex min-h-0 w-full max-w-[1180px] flex-1 flex-col overflow-hidden">
          <div className="mx-auto flex min-h-0 w-full flex-1 flex-col gap-3 overflow-y-auto p-3 md:p-4">
            {!models.length ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5 text-xs">
                <span>{t('No video model is configured yet.')}</span>
                <Link href="/settings/video" className="inline-flex shrink-0 items-center gap-1 text-[var(--primary)] hover:underline">
                  <Settings2 size={13} /> {t('Configure video model')}
                </Link>
              </div>
            ) : null}
            <div className="min-h-[280px] flex-1">
              <VideoPreview key={previewAsset?.id || 'empty'} asset={previewAsset} job={previewJob} />
            </div>
            <VideoStoryboard
              document={storyboard}
              selectedShotId={selectedShotId}
              assetUrl={videoAssetUrl}
              busyShotId={shotBusyId}
              onSelect={selectShot}
              onAdd={() => {
                const next = addStoryboardShot(storyboardRef.current, {
                  title: t('Shot {{n}}', { n: storyboardRef.current.shots.length + 1 }),
                  prompt,
                  input_asset_ids: [...selectedInputIds],
                  duration: settings.duration === '' ? null : settings.duration,
                  job_id: null,
                  output_asset_id: null,
                  notes: null,
                  transition: null,
                })
                updateStoryboard(next)
                setSelectedShotId(next.shots[next.shots.length - 1].id)
                invalidateVideoSubmissionRequest(submissionIdRef)
              }}
              onDelete={shot => {
                const next = { ...storyboardRef.current, shots: storyboardRef.current.shots.filter(item => item.id !== shot.id).map((item, index) => ({ ...item, order: index })) }
                updateStoryboard(next)
                if (selectedShotId === shot.id) setSelectedShotId(null)
                invalidateVideoSubmissionRequest(submissionIdRef)
              }}
              onMove={(from, to) => updateStoryboard(reorderStoryboardShots(storyboardRef.current, from, to))}
              onPatch={(shot, patch) => {
                if (selectedShotId === shot.id && storyboardPatchAffectsSubmission(patch)) {
                  if (patch.prompt !== undefined) setPrompt(patch.prompt)
                  if (patch.input_asset_ids !== undefined) {
                    setSelectedInputIds(
                      sanitizeVideoInputs(
                        patch.input_asset_ids,
                        assets,
                        operation,
                        selectedModel?.capabilities,
                        settings.audioMode
                      )
                    )
                  }
                  if (patch.duration !== undefined) {
                    setSettings(current => ({
                      ...current,
                      duration: typeof patch.duration === 'number' ? patch.duration : '',
                    }))
                  }
                  invalidateVideoSubmissionRequest(submissionIdRef)
                }
                updateStoryboard(patchStoryboardShot(storyboardRef.current, shot.id, patch))
              }}
              onGenerateKeyframe={(shot, promptOverride) => void generateShotKeyframe(shot, promptOverride)}
              onGenerateVoiceover={(shot, text, voice) => void generateShotVoiceover(shot, text, voice)}
              variantJobs={shotVariantJobs}
              variantBusyShotId={rerollBusyShotId}
              variantLoading={shotVariantsLoading}
              priceHints={priceHints}
              onRerollShot={shot => void handleRerollShot(shot)}
              onBindVariant={(shot, job) => void handleBindVariant(shot, job)}
            />
            <VideoTimeline
              document={storyboard}
              selectedShotId={selectedShotId}
              thumbnailUrl={videoAssetThumbnailUrl}
              bgmAssetId={bgmAssetId || null}
              onSelect={selectShot}
              onMove={(from, to) => updateStoryboard(reorderStoryboardShots(storyboardRef.current, from, to))}
              onPatch={(shot, patch) => {
                updateStoryboard(patchStoryboardShot(storyboardRef.current, shot.id, patch))
              }}
            />
            <VideoComposer
              models={models}
              modelKey={modelKey}
              onModelKey={changeModel}
              operation={operation}
              onOperation={changeOperation}
              prompt={prompt}
              onPrompt={value => {
                setPrompt(value)
                invalidateVideoSubmissionRequest(submissionIdRef)
              }}
              settings={settings}
              onSettings={changeSettings}
              selectedAssets={selectedAssets}
              onRemoveAsset={assetId => {
                setSelectedInputIds(current => current.filter(id => id !== assetId))
                invalidateVideoSubmissionRequest(submissionIdRef)
              }}
              characters={characters}
              onAddCharacter={addCharacterToComposer}
              costConfirmed={costConfirmed}
              onCostConfirmed={setCostConfirmed}
              submitting={submitting}
              disabled={!validation.ok || offline || projectLoading || !storyboardReady}
              validationMessage={validation.ok ? '' : validationLabel(validation.reason, t)}
              onSubmit={() => void submit()}
              priceHints={priceHints}
              onPriceHint={changePriceHint}
            />
          </div>
          {composeOpen ? (
            <div className="absolute inset-0 z-20 flex min-h-0">
              <button
                type="button"
                aria-label={t('Close')}
                className="h-full flex-1 bg-black/25"
                onClick={() => setComposeOpen(false)}
              />
              <aside className="flex h-full w-[min(440px,100%)] shrink-0 flex-col overflow-y-auto border-l border-[var(--border)] bg-[var(--background)] p-3 shadow-2xl">
                <VideoComposePanel
                  projectId={projectId}
                  shots={storyboard.shots}
                  assets={assets}
                  jobs={jobs}
                  compositions={compositions}
                  ffmpeg={ffmpeg}
                  installingFfmpeg={installingFfmpeg}
                  busy={composing || projectLoading}
                  assetUrl={videoAssetUrl}
                  bgmAssetId={bgmAssetId}
                  onBgmAssetId={setBgmAssetId}
                  onSubmit={config => void submitComposition(config)}
                  onInstallFfmpeg={() => void installFfmpegEngine()}
                  priceHints={priceHints}
                  onAssetSaved={asset => {
                    setAssets(current => [asset, ...current.filter(item => item.id !== asset.id)])
                  }}
                />
              </aside>
            </div>
          ) : null}
          </div>
          ) : null}
          {directorMounted ? (
            <div
              data-director-embed=""
              className={
                viewMode === 'director'
                  ? 'absolute inset-0 z-10 flex min-h-0 flex-col bg-[var(--background)]'
                  : 'pointer-events-none invisible absolute inset-0 -z-10 flex min-h-0 flex-col'
              }
              aria-hidden={viewMode !== 'director'}
            >
              <DirectorDeskPanel
                active={viewMode === 'director'}
                projectId={projectId}
                selectedShotId={selectedShotId}
                selectedShot={selectedShotId ? storyboard.shots.find(shot => shot.id === selectedShotId) ?? null : null}
                shots={storyboard.shots}
                assets={assets}
                characters={characters}
                onAssetUploaded={asset => {
                  setAssets(current => [asset, ...current.filter(item => item.id !== asset.id)])
                }}
                onApplyFrameToShot={assetId => applyDirectorFrameToShot(assetId)}
                onApplyCameraToShot={camera => applyDirectorCameraToShot(camera)}
                onSyncCamerasToStoryboard={cameras => syncDirectorCamerasToStoryboard(cameras)}
                onSelectShot={selectShot}
                onNotify={setMessage}
              />
            </div>
          ) : null}
          </div>
        </main>
        <aside className={`hidden w-80 shrink-0 border-l border-[var(--border)] 2xl:block ${viewMode === 'director' ? '!hidden' : ''}`}>{queuePanel}</aside>
      </div>

      {assetsDrawerOpen ? (
        <div className="absolute inset-0 z-40 xl:hidden">
          <button type="button" aria-label={t('Close project assets')} onClick={() => setAssetsDrawerOpen(false)} className="absolute inset-0 bg-black/35" />
          <aside className="absolute inset-y-0 left-0 w-[min(320px,88vw)] border-r border-[var(--border)] bg-[var(--background)] shadow-2xl">
            <button type="button" onClick={() => setAssetsDrawerOpen(false)} aria-label={t('Close')} className="absolute top-3 -right-11 z-10 rounded-xl border border-white/20 bg-[var(--background)] p-2 text-[var(--foreground)] shadow-xl hover:bg-[var(--muted)]"><X size={15} /></button>
            {leftPanel}
          </aside>
        </div>
      ) : null}
      <StudioLibraryPicker
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        kinds={['image', 'video', 'text']}
        onPickPrompt={item => setPrompt(item.body)}
        onPickAsset={asset => {
          if (asset.kind === 'text' && asset.content) {
            setPrompt(current => (current ? `${current}\n${asset.content}` : asset.content))
            return
          }
          if (!projectId || (asset.kind !== 'image' && asset.kind !== 'video')) return
          void (async () => {
            const response = await fetch(libraryAssetUrl(asset.id))
            const blob = await response.blob()
            const file = new File([blob], asset.title || 'library-media', { type: blob.type || asset.mime })
            const uploaded = await uploadVideoAsset(projectId, file)
            setAssets(current => [uploaded, ...current.filter(item => item.id !== uploaded.id)])
            setSelectedInputIds(current => current.includes(uploaded.id) ? current : [...current, uploaded.id])
          })().catch(error => setMessage(error instanceof Error ? error.message : t('Import failed')))
        }}
      />
      {queueDrawerOpen ? (
        <div className="absolute inset-0 z-40 2xl:hidden">
          <button type="button" aria-label={t('Close generation queue')} onClick={() => setQueueDrawerOpen(false)} className="absolute inset-0 bg-black/35" />
          <aside className="absolute inset-y-0 right-0 w-[min(360px,92vw)] border-l border-[var(--border)] bg-[var(--background)] shadow-2xl">
            <button type="button" onClick={() => setQueueDrawerOpen(false)} aria-label={t('Close')} className="absolute top-3 -left-11 z-10 rounded-xl border border-white/20 bg-[var(--background)] p-2 text-[var(--foreground)] shadow-xl hover:bg-[var(--muted)]"><X size={15} /></button>
            {queuePanel}
          </aside>
        </div>
      ) : null}
    </div>
  )
}
