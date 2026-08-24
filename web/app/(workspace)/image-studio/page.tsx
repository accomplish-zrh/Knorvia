'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  FolderOpen,
  Images,
  Loader2,
  PanelRight,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react'
import Link from 'next/link'
import {
  cancelStudioJob,
  createStudioJob,
  createStudioProject,
  deleteStudioAsset,
  deleteStudioProject,
  followStudioJob,
  getStudioJob,
  getStudioProject,
  getStudioUpscalerStatus,
  installStudioUpscaler,
  listImageModels,
  listStudioJobs,
  listStudioProjects,
  retryStudioJob,
  restoreStudioAsset,
  restoreStudioProject,
  studioAssetUrl,
  getStudioBoard,
  saveStudioBoard,
  setStudioAssetFavorite,
  uploadStudioAsset,
  updateStudioProject,
  type ImageModelOption,
  ImageStudioApiError,
  type StudioAsset,
  type StudioJob,
  type StudioProject,
  type StudioUpscalerStatus,
} from '@/lib/image-studio-api'
import { MaskEditor } from '@/components/image-studio/MaskEditor'
import { StudioCanvas } from '@/components/image-studio/StudioCanvas'
import { StudioInfiniteBoard } from '@/components/image-studio/StudioInfiniteBoard'
import { StudioInspector } from '@/components/image-studio/StudioInspector'
import { StudioModeControl } from '@/components/image-studio/StudioModeControl'
import { StudioPromptBar } from '@/components/image-studio/StudioPromptBar'
import { StudioResultGrid } from '@/components/image-studio/StudioResultGrid'
import { StudioAgentPanel } from '@/components/library/StudioAgentPanel'
import { StudioLibraryPicker } from '@/components/library/StudioLibraryPicker'
import { CreationDeskSwitch } from '@/components/sidebar/CreationDeskSwitch'
import { libraryAssetUrl } from '@/lib/creative-library-api'
import { apiFetch, apiUrl } from '@/lib/api'
import { loadFromStorage, saveToStorage } from '@/lib/persistence'
import {
  addReference,
  advertisedOperations,
  advertisedParameters,
  assignReferenceRole,
  buildStudioJobPayload,
  canSubmitStudioJob,
  fieldIsVisible,
  generateButtonAppearance,
  hasStudioResults,
  parseStudioDensity,
  removeReference,
  shouldShowFirstVisitEmpty,
  studioHeaderStatus,
  preferredStudioModel,
  studioModelKey,
  takeMaskFile,
  STUDIO_DENSITY_STORAGE_KEY,
  STUDIO_MODEL_STORAGE_KEY,
  type ReferenceRole,
  type ResolutionPreset,
  type StudioDensity,
  type StudioReference,
  type StudioUiMode,
} from '@/lib/image-studio/studio-logic'
import {
  addBoardNode,
  applyJobToBoard,
  collectBoardPrompt,
  createBoardNode,
  emptyBoard,
  incomingBoardRefs,
  nextToContent,
  normalizeBoard,
  seedAssetOnBoard,
  updateBoardNode,
  type BoardDocument,
  type BoardNode,
  type BoardPoint,
} from '@/lib/image-studio/board-logic'
import { useTranslation } from 'react-i18next'

const FINAL_JOB_STATUSES = ['succeeded', 'partial', 'failed', 'cancelled', 'interrupted']

async function pollStudioJob(
  id: string,
  onUpdate: (job: StudioJob) => void,
  signal?: AbortSignal
): Promise<StudioJob> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('Image job poll cancelled', 'AbortError')
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, 1200)
      const onAbort = () => {
        window.clearTimeout(timer)
        reject(new DOMException('Image job poll cancelled', 'AbortError'))
      }
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
    const job = await getStudioJob(id, signal)
    onUpdate(job)
    if (FINAL_JOB_STATUSES.includes(job.status)) return job
  }
}

export default function ImageStudioPage() {
  const { t, i18n } = useTranslation()
  const importedSource = useRef(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const followingJobs = useRef(new Set<string>())
  const followControllers = useRef(new Map<string, AbortController>())
  const mounted = useRef(true)
  const projectIdRef = useRef('')
  const projectEpochRef = useRef(0)
  const projectBoardLoadController = useRef<AbortController | null>(null)
  const projectDataLoadController = useRef<AbortController | null>(null)
  const projectDataRequestRef = useRef(0)
  const [projects, setProjects] = useState<StudioProject[]>([])
  const [projectId, setProjectId] = useState('')
  const [projectTitle, setProjectTitle] = useState('')
  const [deletedProject, setDeletedProject] = useState<StudioProject | null>(null)
  const [models, setModels] = useState<ImageModelOption[]>([])
  const [modelKey, setModelKey] = useState('')
  const [uiMode, setUiMode] = useState<StudioUiMode>('create')
  const [density, setDensity] = useState<StudioDensity>('simple')
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [narrow, setNarrow] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState('')
  const [aspectRatio, setAspectRatio] = useState('')
  const [resolution, setResolution] = useState<ResolutionPreset>('native')
  const [upscalePreset, setUpscalePreset] = useState<'general' | 'illustration'>('general')
  const [upscaler, setUpscaler] = useState<StudioUpscalerStatus | null>(null)
  const [installingUpscaler, setInstallingUpscaler] = useState(false)
  const [outputFormat, setOutputFormat] = useState('')
  const [background, setBackground] = useState('')
  const [compression, setCompression] = useState('')
  const [style, setStyle] = useState('')
  const [count, setCount] = useState(1)
  const [assets, setAssets] = useState<StudioAsset[]>([])
  const [jobs, setJobs] = useState<StudioJob[]>([])
  const [nextJobCursor, setNextJobCursor] = useState<number | null>(null)
  const [references, setReferences] = useState<StudioReference[]>([])
  const [parentJobId, setParentJobId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [maskOpen, setMaskOpen] = useState(false)
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null)
  const [deletedAsset, setDeletedAsset] = useState<StudioAsset | null>(null)
  const [factsOpen, setFactsOpen] = useState(false)
  const [offline, setOffline] = useState(false)
  const pendingMaskRef = useRef<File | null>(null)
  const generationTokens = useRef(new Set<symbol>())
  const [board, setBoard] = useState<BoardDocument>(emptyBoard)
  const [boardReady, setBoardReady] = useState(false)
  const boardRef = useRef<BoardDocument>(emptyBoard())
  const [boardMaskNode, setBoardMaskNode] = useState<BoardNode | null>(null)
  const [boardFocusId, setBoardFocusId] = useState<string | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const libraryImportRef = useRef('')
  const boardSaveTimer = useRef<number | null>(null)
  const boardSavePending = useRef(false)
  const boardSaveRunning = useRef(false)
  const boardSaveController = useRef<AbortController | null>(null)

  const selectedModel = useMemo(
    () => models.find(item => `${item.profile_id}:${item.model_id}` === modelKey),
    [models, modelKey]
  )
  const operations = advertisedOperations(selectedModel?.capabilities)
  const maxInputs = Math.max(0, Math.min(4, selectedModel?.capabilities?.max_inputs ?? 4))
  const maxOutputs = Math.max(1, Math.min(4, selectedModel?.capabilities?.max_outputs ?? 4))

  const abortJobFollowers = useCallback(() => {
    for (const controller of followControllers.current.values()) controller.abort()
    followControllers.current.clear()
    followingJobs.current.clear()
  }, [])

  const activateProject = useCallback(
    (id: string, title: string) => {
      projectEpochRef.current += 1
      projectIdRef.current = id
      projectBoardLoadController.current?.abort()
      projectDataLoadController.current?.abort()
      projectBoardLoadController.current = null
      projectDataLoadController.current = null
      projectDataRequestRef.current += 1
      abortJobFollowers()
      if (boardSaveTimer.current) window.clearTimeout(boardSaveTimer.current)
      boardSaveController.current?.abort()
      boardSaveController.current = null
      boardSaveTimer.current = null
      boardSavePending.current = false
      const blank = emptyBoard()
      boardRef.current = blank
      setBoard(blank)
      setBoardReady(false)
      setProjectId(id)
      setProjectTitle(title)
      setAssets([])
      setJobs([])
      setNextJobCursor(null)
      setReferences([])
      setParentJobId(null)
      setSelectedAssetId(null)
      setPreviewAssetId(null)
      setDeletedAsset(null)
      setBoardMaskNode(null)
      setBoardFocusId(null)
      pendingMaskRef.current = null
      generationTokens.current.clear()
      setBusy(false)
      setFactsOpen(false)
      setMessage('')
      setUiMode('create')
    },
    [abortJobFollowers]
  )

  useEffect(() => {
    mounted.current = true
    const media = window.matchMedia('(max-width: 1279px)')
    const sync = () => {
      setNarrow(media.matches)
      if (media.matches) setInspectorOpen(false)
    }
    sync()
    media.addEventListener('change', sync)
    setDensity(parseStudioDensity(loadFromStorage(STUDIO_DENSITY_STORAGE_KEY, 'simple')))
    const onOnline = () => setOffline(!navigator.onLine)
    onOnline()
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOnline)
    return () => {
      mounted.current = false
      projectBoardLoadController.current?.abort()
      projectDataLoadController.current?.abort()
      abortJobFollowers()
      if (boardSaveTimer.current) window.clearTimeout(boardSaveTimer.current)
      boardSaveController.current?.abort()
      media.removeEventListener('change', sync)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOnline)
    }
  }, [abortJobFollowers])

  const flushBoardSave = useCallback(async () => {
    if (boardSaveRunning.current) return
    boardSaveRunning.current = true
    try {
      while (boardSavePending.current) {
        boardSavePending.current = false
        const activeProjectId = projectIdRef.current
        const epoch = projectEpochRef.current
        if (!activeProjectId) break
        const snapshot = boardRef.current
        const controller = new AbortController()
        boardSaveController.current = controller
        try {
          const saved = normalizeBoard(
            await saveStudioBoard(activeProjectId, snapshot, controller.signal)
          )
          if (
            !mounted.current ||
            projectEpochRef.current !== epoch ||
            projectIdRef.current !== activeProjectId
          )
            continue
          // Mutations may have arrived while this PUT was in flight. Keep their
          // content, but advance them onto the revision acknowledged by CAS.
          const current = boardRef.current
          const next = { ...current, revision: saved.revision }
          boardRef.current = next
          setBoard(next)
        } catch (error) {
          if (
            error instanceof ImageStudioApiError &&
            error.status === 409 &&
            mounted.current &&
            projectEpochRef.current === epoch &&
            projectIdRef.current === activeProjectId
          ) {
            try {
              const latest = normalizeBoard(
                await getStudioBoard(activeProjectId, controller.signal)
              )
              if (
                projectEpochRef.current !== epoch ||
                projectIdRef.current !== activeProjectId
              ) {
                continue
              }
              boardSavePending.current = false
              boardRef.current = latest
              setBoard(latest)
              setMessage(
                  t('This canvas changed elsewhere. The latest version was reloaded; repeat your last edit.')
                )
            } catch (reloadError) {
              if (
                projectEpochRef.current !== epoch ||
                projectIdRef.current !== activeProjectId
              ) {
                continue
              }
              boardSavePending.current = false
              setMessage(
                reloadError instanceof Error ? reloadError.message : t('Failed to reload canvas')
              )
            }
          } else if (
            projectEpochRef.current !== epoch ||
            projectIdRef.current !== activeProjectId
          ) {
            // Project activation aborts the old PUT. If the new board was
            // edited while it was unwinding, keep the loop alive for it.
            continue
          } else if (mounted.current) {
            boardSavePending.current = false
            setMessage(error instanceof Error ? error.message : t('Failed to save canvas'))
          }
          break
        } finally {
          if (boardSaveController.current === controller) boardSaveController.current = null
        }
      }
    } finally {
      boardSaveRunning.current = false
    }
  }, [t])

  const persistBoard = useCallback(
    (
      value: BoardDocument | ((current: BoardDocument) => BoardDocument),
      immediate = false
    ) => {
      const current = boardRef.current
      const updated = typeof value === 'function' ? value(current) : value
      const next = { ...updated, revision: current.revision }
      boardRef.current = next
      setBoard(next)
      if (!projectIdRef.current) return
      boardSavePending.current = true
      if (boardSaveTimer.current) window.clearTimeout(boardSaveTimer.current)
      const write = () => {
        boardSaveTimer.current = null
        void flushBoardSave()
      }
      if (immediate) write()
      else boardSaveTimer.current = window.setTimeout(write, 350)
    },
    [flushBoardSave]
  )

  const refreshProject = useCallback(async (id: string, includeBoard = false) => {
    const epoch = projectEpochRef.current
    const controllerRef = includeBoard ? projectBoardLoadController : projectDataLoadController
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const dataRequest = ++projectDataRequestRef.current
    try {
      const [detail, jobPage, upscalerStatus, rawBoard] = await Promise.all([
        getStudioProject(id, controller.signal),
        listStudioJobs(id, undefined, controller.signal),
        getStudioUpscalerStatus().catch(() => null),
        includeBoard ? getStudioBoard(id, controller.signal) : Promise.resolve(null),
      ])
      if (
        !mounted.current ||
        controller.signal.aborted ||
        projectEpochRef.current !== epoch ||
        projectIdRef.current !== id
      )
        return
      if (rawBoard) {
        const nextBoard = normalizeBoard(rawBoard)
        boardRef.current = nextBoard
        setBoard(nextBoard)
        setBoardReady(true)
      }
      // A board bootstrap and a later asset/job refresh may overlap. Always
      // accept the project-scoped board, but only the newest data response may
      // replace asset/job lists.
      if (projectDataRequestRef.current === dataRequest) {
        setAssets(detail.assets || [])
        setJobs(jobPage.jobs || [])
        setNextJobCursor(jobPage.next_cursor)
      }
      if (upscalerStatus) setUpscaler(upscalerStatus)
    } catch (error) {
      if (!controller.signal.aborted) throw error
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      listStudioProjects(),
      listImageModels(),
      getStudioUpscalerStatus().catch(() => null),
    ])
      .then(([nextProjects, nextModels, upscalerStatus]) => {
        if (cancelled) return
        setProjects(nextProjects)
        setModels(nextModels)
        if (upscalerStatus) setUpscaler(upscalerStatus)
        const wanted = new URLSearchParams(window.location.search).get('project')
        const chosen =
          (wanted && nextProjects.find(project => project.id === wanted)) || nextProjects[0]
        if (chosen) {
          activateProject(chosen.id, chosen.title)
        }
        const preferred = preferredStudioModel(
          nextModels,
          loadFromStorage(STUDIO_MODEL_STORAGE_KEY, '')
        )
        if (preferred) {
          setModelKey(studioModelKey(preferred))
          setSize(preferred.defaults.size || preferred.defaults.image_size || '1024x1024')
          setQuality(preferred.defaults.quality || '')
          setAspectRatio(preferred.defaults.aspect_ratio || '')
          setOutputFormat(preferred.defaults.response_format || '')
          setStyle(preferred.defaults.style || '')
          setBackground(preferred.defaults.background || '')
          setCompression(preferred.defaults.compression || '')
        }
      })
      .catch(error => {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : t('Failed to load Image Studio'))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activateProject, t])

  useEffect(() => {
    if (!projectId) return
    void refreshProject(projectId, true).catch(error => {
      if (mounted.current && projectIdRef.current === projectId) {
        setMessage(error instanceof Error ? error.message : t('Failed to load Image Studio'))
      }
    })
  }, [projectId, refreshProject, t])

  useEffect(() => {
    for (const job of jobs) {
      if (!['queued', 'running'].includes(job.status) || followingJobs.current.has(job.id)) continue
      followingJobs.current.add(job.id)
      const epoch = projectEpochRef.current
      const controller = new AbortController()
      followControllers.current.set(job.id, controller)
      void followStudioJob(job.id, event => {
        const status = event.payload?.status
        if (status && mounted.current && projectEpochRef.current === epoch)
          setJobs(current => current.map(item => (item.id === job.id ? { ...item, status } : item)))
      }, 0, controller.signal)
        .catch(error => {
          if (controller.signal.aborted) throw error
          return (
          pollStudioJob(
            job.id,
            next => {
              if (mounted.current && projectEpochRef.current === epoch)
                setJobs(current => current.map(item => (item.id === next.id ? next : item)))
            },
            controller.signal
          ).then(() => undefined)
          )
        })
        .then(() => getStudioJob(job.id, controller.signal))
        .then(completed => {
          if (
            !mounted.current ||
            controller.signal.aborted ||
            projectEpochRef.current !== epoch ||
            projectIdRef.current !== completed.project_id
          )
            return
          setJobs(current => current.map(item => (item.id === completed.id ? completed : item)))
          void refreshProject(completed.project_id)
        })
        .catch(() => undefined)
        .finally(() => {
          followingJobs.current.delete(job.id)
          if (followControllers.current.get(job.id) === controller) {
            followControllers.current.delete(job.id)
          }
        })
    }
  }, [jobs, projectId, refreshProject])

  useEffect(() => {
    const source = new URLSearchParams(window.location.search).get('source')
    if (!source || !source.startsWith('/api/outputs/') || !projectId || importedSource.current)
      return
    importedSource.current = true
    const epoch = projectEpochRef.current
    const controller = new AbortController()
    setBusy(true)
    apiFetch(apiUrl(source), { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(t('Could not import the generated image'))
        const blob = await response.blob()
        const file = new File([blob], 'chat-image.png', { type: blob.type || 'image/png' })
        const asset = await uploadStudioAsset(projectId, file)
        if (projectEpochRef.current !== epoch || projectIdRef.current !== projectId) return
        setReferences([{ assetId: asset.id, role: 'edit' }])
        setSelectedAssetId(asset.id)
        setUiMode('edit')
        await refreshProject(projectId)
      })
      .catch(error => {
        if (!controller.signal.aborted && projectEpochRef.current === epoch) {
          setMessage(error instanceof Error ? error.message : t('Import failed'))
        }
      })
      .finally(() => {
        if (projectEpochRef.current === epoch) setBusy(false)
      })
    return () => controller.abort()
  }, [projectId, refreshProject, t])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const incomingPrompt = params.get('prompt')
    if (incomingPrompt) setPrompt(incomingPrompt)
  }, [])

  useEffect(() => {
    const assetId = new URLSearchParams(window.location.search).get('libraryAsset')
    if (!assetId || !projectId || libraryImportRef.current === assetId) return
    libraryImportRef.current = assetId
    const epoch = projectEpochRef.current
    void (async () => {
      try {
        const response = await fetch(libraryAssetUrl(assetId))
        if (!response.ok) throw new Error(t('Import failed'))
        const blob = await response.blob()
        const file = new File([blob], 'library-image.png', { type: blob.type || 'image/png' })
        const asset = await uploadStudioAsset(projectId, file)
        if (projectEpochRef.current !== epoch) return
        setReferences(current => addReference(current, asset.id, 'subject', 4))
        setSelectedAssetId(asset.id)
        await refreshProject(projectId)
      } catch (error) {
        if (projectEpochRef.current === epoch) {
          setMessage(error instanceof Error ? error.message : t('Import failed'))
        }
      }
    })()
  }, [projectId, refreshProject, t])

  function persistDensity(next: StudioDensity) {
    setDensity(next)
    saveToStorage(STUDIO_DENSITY_STORAGE_KEY, next)
  }

  async function addProject() {
    const project = await createStudioProject()
    setProjects(current => [project, ...current])
    activateProject(project.id, project.title)
  }

  async function renameProject() {
    if (!projectId || !projectTitle.trim()) return
    const activeProjectId = projectId
    const epoch = projectEpochRef.current
    try {
      const updated = await updateStudioProject(activeProjectId, projectTitle.trim())
      setProjects(current =>
        current.map(project => (project.id === updated.id ? updated : project))
      )
      if (projectEpochRef.current === epoch && projectIdRef.current === activeProjectId) {
        setProjectTitle(updated.title)
      }
    } catch (error) {
      if (projectEpochRef.current === epoch && projectIdRef.current === activeProjectId) {
        setMessage(error instanceof Error ? error.message : t('Failed to rename project'))
      }
    }
  }

  async function removeProject() {
    const current = projects.find(project => project.id === projectId)
    if (!current) return
    const epoch = projectEpochRef.current
    try {
      await deleteStudioProject(current.id)
      setDeletedProject(current)
      const remaining = projects.filter(project => project.id !== current.id)
      setProjects(remaining)
      if (projectEpochRef.current !== epoch || projectIdRef.current !== current.id) return
      if (remaining[0]) {
        activateProject(remaining[0].id, remaining[0].title)
      } else {
        const replacement = await createStudioProject()
        setProjects(items => [replacement, ...items.filter(item => item.id !== replacement.id)])
        if (projectEpochRef.current === epoch && projectIdRef.current === current.id) {
          activateProject(replacement.id, replacement.title)
        }
      }
    } catch (error) {
      if (projectEpochRef.current === epoch && projectIdRef.current === current.id) {
        setMessage(error instanceof Error ? error.message : t('Failed to delete project'))
      }
    }
  }

  async function undoProjectDelete() {
    if (!deletedProject) return
    try {
      const restored = await restoreStudioProject(deletedProject.id)
      setProjects(current => [restored, ...current])
      activateProject(restored.id, restored.title)
      setDeletedProject(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Failed to restore project'))
    }
  }

  async function upload(files: FileList | null, role: ReferenceRole = 'subject') {
    const activeProjectId = projectIdRef.current
    const epoch = projectEpochRef.current
    const isCurrentProject = () =>
      projectEpochRef.current === epoch && projectIdRef.current === activeProjectId
    if (!files?.length || !activeProjectId) return
    setBusy(true)
    setMessage('')
    try {
      const uploaded: StudioAsset[] = []
      for (const file of Array.from(files).slice(0, role === 'mask' ? 1 : maxInputs))
        uploaded.push(await uploadStudioAsset(activeProjectId, file))
      if (!isCurrentProject()) return
      setReferences(current => {
        let next = current
        for (const asset of uploaded) next = addReference(next, asset.id, role, maxInputs)
        return next
      })
      setParentJobId(null)
      await refreshProject(activeProjectId)
    } catch (error) {
      if (isCurrentProject()) {
        setMessage(error instanceof Error ? error.message : t('Upload failed'))
      }
    } finally {
      if (isCurrentProject()) setBusy(false)
    }
  }

  async function saveDrawnMask(file: File) {
    const activeProjectId = projectIdRef.current
    const epoch = projectEpochRef.current
    const isCurrentProject = () =>
      projectEpochRef.current === epoch && projectIdRef.current === activeProjectId
    if (!activeProjectId) return
    setBusy(true)
    try {
      const asset = await uploadStudioAsset(activeProjectId, file)
      if (!isCurrentProject()) return
      setReferences(current => addReference(current, asset.id, 'mask', maxInputs))
      setMaskOpen(false)
      await refreshProject(activeProjectId)
    } catch (error) {
      if (isCurrentProject()) {
        setMessage(error instanceof Error ? error.message : t('Mask upload failed'))
      }
    } finally {
      if (isCurrentProject()) setBusy(false)
    }
  }

  async function installUpscaler() {
    setInstallingUpscaler(true)
    setMessage('')
    try {
      setUpscaler(await installStudioUpscaler())
    } catch (error) {
      const text = error instanceof Error ? error.message : t('Failed to install local AI enhancer')
      setMessage(
        offline || /network|fetch|download|failed to fetch/i.test(text)
          ? t('Could not reach the enhancer download. Check the network and try again.')
          : text
      )
    } finally {
      setInstallingUpscaler(false)
    }
  }

  function submitReasonMessage(reason?: string) {
    if (reason === 'prompt') return t('Write a prompt first.')
    if (reason === 'generate-rejects-inputs')
      return t('This model cannot use reference images. Remove them or choose another model.')
    if (reason === 'needs-image' || reason === 'needs-selection')
      return t('Add a reference image or select a result first.')
    if (reason === 'needs-mask') return t('Paint a mask before local redraw.')
    if (reason === 'too-many-inputs')
      return t('This model supports fewer reference images. Remove some references and try again.')
    if (reason === 'operation') return t('No image model is available.')
    return t('Write a prompt first.')
  }

  function jobInput(overrides: Partial<ReturnType<typeof currentJobInput>> = {}) {
    return { ...currentJobInput(), ...overrides }
  }

  function currentJobInput() {
    const effectivePrompt =
      prompt.trim() ||
      (uiMode === 'enhance' ? t('Enhance this image, keep the original details.') : '')
    return {
      uiMode,
      prompt: effectivePrompt,
      references,
      selectedAssetId,
      parentJobId,
      profileId: selectedModel?.profile_id || '',
      modelId: selectedModel?.model_id || '',
      capabilities: selectedModel?.capabilities || { operations: ['generate'] },
      density,
      aspectRatio,
      resolution,
      count,
      size,
      quality,
      style,
      outputFormat,
      background,
      compression,
      upscaleModel: upscalePreset,
    }
  }

  async function generate(
    overrides: Partial<ReturnType<typeof currentJobInput>> = {},
    maskFile?: File | null,
    targetNodeId?: string | null
  ) {
    const activeProjectId = projectIdRef.current
    const epoch = projectEpochRef.current
    const isCurrentProject = () =>
      mounted.current &&
      projectEpochRef.current === epoch &&
      projectIdRef.current === activeProjectId
    if (!activeProjectId || !selectedModel) {
      setMessage(t('No image model is available.'))
      return
    }
    if (offline) {
      setMessage(t('You are offline. Reconnect to generate or download the enhancer.'))
      return
    }
    let nextReferences = overrides.references || references
    const file = takeMaskFile(maskFile, pendingMaskRef.current)
    const effectiveMaxInputs = Math.max(
      0,
      Math.min(4, overrides.capabilities?.max_inputs ?? selectedModel.capabilities?.max_inputs ?? 4)
    )
    if (file) {
      try {
        const asset = await uploadStudioAsset(activeProjectId, file)
        if (!isCurrentProject()) return
        nextReferences = addReference(nextReferences, asset.id, 'mask', effectiveMaxInputs)
        setReferences(nextReferences)
        pendingMaskRef.current = null
      } catch (error) {
        if (isCurrentProject()) {
          setMessage(error instanceof Error ? error.message : t('Mask upload failed'))
        }
        return
      }
    }
    const input = jobInput({ ...overrides, references: nextReferences })
    const guard = canSubmitStudioJob(input)
    if (!guard.ok) {
      setMessage(submitReasonMessage(guard.reason))
      return
    }
    const generationToken = Symbol('image-generation')
    generationTokens.current.add(generationToken)
    let followedJobId: string | null = null
    let followController: AbortController | null = null
    setBusy(true)
    setMessage('')
    try {
      const payload = buildStudioJobPayload(input)
      const job = await createStudioJob(activeProjectId, payload)
      if (!isCurrentProject()) return
      followingJobs.current.add(job.id)
      followedJobId = job.id
      setJobs(current => [job, ...current])
      if (targetNodeId) {
        persistBoard(
          current =>
            updateBoardNode(current, targetNodeId, {
              jobId: job.id,
              status: 'running',
              prompt: input.prompt,
            }),
          true
        )
      }
      const controller = new AbortController()
      followController = controller
      followControllers.current.set(job.id, controller)
      try {
        await followStudioJob(job.id, event => {
          const status = event.payload?.status
          if (status && isCurrentProject())
            setJobs(current =>
              current.map(item => (item.id === job.id ? { ...item, status } : item))
            )
        }, 0, controller.signal)
      } catch (error) {
        if (controller.signal.aborted) throw error
        await pollStudioJob(
          job.id,
          next => {
            if (isCurrentProject())
              setJobs(current => current.map(item => (item.id === next.id ? next : item)))
          },
          controller.signal
        )
      }
      if (!isCurrentProject()) return
      const completed = await getStudioJob(job.id, controller.signal)
      if (!isCurrentProject()) return
      setJobs(current => current.map(item => (item.id === completed.id ? completed : item)))
      if (completed.error_message) setMessage(completed.error_message)
      followingJobs.current.delete(job.id)
      if (targetNodeId || input.uiMode === 'canvas') {
        persistBoard(
          current =>
            applyJobToBoard(current, {
              nodeId: targetNodeId || undefined,
              jobId: completed.id,
              prompt: input.prompt,
              status: completed.status,
              outputs: (completed.outputs || []).map(output => ({ assetId: output.asset_id })),
            }),
          true
        )
      }
      await refreshProject(activeProjectId)
    } catch (error) {
      if (isCurrentProject() && !(error instanceof DOMException && error.name === 'AbortError')) {
        setMessage(error instanceof Error ? error.message : t('Generation failed'))
      }
    } finally {
      followController?.abort()
      if (followedJobId) {
        followingJobs.current.delete(followedJobId)
        if (followControllers.current.get(followedJobId) === followController) {
          followControllers.current.delete(followedJobId)
        }
      }
      generationTokens.current.delete(generationToken)
      if (isCurrentProject()) setBusy(generationTokens.current.size > 0)
    }
  }

  function generateFromBoardNode(node: BoardNode) {
    const currentBoard = boardRef.current
    const refs = incomingBoardRefs(currentBoard, node.id)
      .filter(item => item.node.assetId)
      .map(item => ({
        assetId: item.node.assetId as string,
        role: (item.role === 'mask' ? 'mask' : 'subject') as ReferenceRole,
      }))
    for (const assetId of mentionedAssetIdsFromNode(node)) {
      if (!refs.some(item => item.assetId === assetId)) refs.push({ assetId, role: 'subject' })
    }
    if (node.assetId && !refs.some(item => item.assetId === node.assetId)) {
      refs.unshift({ assetId: node.assetId, role: 'edit' })
    }
    const promptText = collectBoardPrompt(currentBoard, node.id) || node.prompt || prompt
    const picked = models.find(model => studioModelKey(model) === (node.modelKey || modelKey)) || selectedModel
    const customSize =
      node.customWidth && node.customHeight ? `${node.customWidth}x${node.customHeight}` : undefined
    persistBoard(current =>
      updateBoardNode(current, node.id, { status: 'running', prompt: node.prompt || promptText })
    )
    void generate({
      uiMode: refs.some(item => item.role !== 'mask') ? 'edit' : 'create',
      prompt: promptText,
      references: refs,
      selectedAssetId: refs.find(item => item.role !== 'mask')?.assetId || null,
      profileId: picked?.profile_id || selectedModel?.profile_id || '',
      modelId: picked?.model_id || selectedModel?.model_id || '',
      capabilities: picked?.capabilities || selectedModel?.capabilities || { operations: ['generate'] },
      aspectRatio: node.ratio || aspectRatio,
      quality: node.quality || quality,
      size: customSize || size,
    }, undefined, node.id)
  }

  function mentionedAssetIdsFromNode(node: BoardNode): string[] {
    const matches = (node.prompt || '').matchAll(/@\[([^\]]+)\]/g)
    const ids: string[] = []
    for (const match of matches) {
      const assetId = boardRef.current.nodes.find(item => item.id === match[1])?.assetId
      if (assetId && !ids.includes(assetId)) ids.push(assetId)
    }
    return ids
  }

  function generateOnBoardFromPrompt() {
    const current = boardRef.current
    const node = createBoardNode('generate', nextToContent(current), current.nodes, { prompt })
    persistBoard(boardState => addBoardNode(boardState, node), true)
    generateFromBoardNode({ ...node, prompt })
  }

  async function uploadToBoard(files: File[], origin: BoardPoint, nodeId?: string) {
    const activeProjectId = projectIdRef.current
    const epoch = projectEpochRef.current
    if (!activeProjectId || !files.length) return
    let point = origin
    try {
      for (const [index, file] of files.slice(0, 4).entries()) {
        const asset = await uploadStudioAsset(activeProjectId, file)
        if (projectEpochRef.current !== epoch || projectIdRef.current !== activeProjectId) return
        setAssets(current => [asset, ...current.filter(item => item.id !== asset.id)])
        if (index === 0 && nodeId) {
          persistBoard(current =>
            updateBoardNode(current, nodeId, { assetId: asset.id, kind: 'image' })
          )
        } else {
          const assetPoint = point
          persistBoard(current => seedAssetOnBoard(current, asset.id, assetPoint))
          point = { x: point.x + 300, y: point.y }
        }
      }
      persistBoard(current => current, true)
    } catch (error) {
      if (projectEpochRef.current === epoch && projectIdRef.current === activeProjectId) {
        setMessage(error instanceof Error ? error.message : t('Upload failed'))
      }
    }
  }

  async function cancelJob(jobId: string) {
    const activeProjectId = projectIdRef.current
    const epoch = projectEpochRef.current
    try {
      await cancelStudioJob(jobId)
      if (projectEpochRef.current !== epoch || projectIdRef.current !== activeProjectId) return
      followControllers.current.get(jobId)?.abort()
      const updated = await getStudioJob(jobId)
      if (projectEpochRef.current !== epoch || projectIdRef.current !== activeProjectId) return
      setJobs(current => current.map(job => (job.id === updated.id ? updated : job)))
    } catch (error) {
      if (projectEpochRef.current === epoch && projectIdRef.current === activeProjectId) {
        setMessage(error instanceof Error ? error.message : t('Failed to cancel job'))
      }
    }
  }

  async function retryJob(jobId: string) {
    const epoch = projectEpochRef.current
    const activeProjectId = projectIdRef.current
    const isCurrentProject = () =>
      projectEpochRef.current === epoch && projectIdRef.current === activeProjectId
    let controller: AbortController | null = null
    let nextJobId: string | null = null
    try {
      const job = await retryStudioJob(jobId)
      if (projectEpochRef.current !== epoch || projectIdRef.current !== activeProjectId) return
      nextJobId = job.id
      followingJobs.current.add(job.id)
      controller = new AbortController()
      followControllers.current.set(job.id, controller)
      setJobs(current => [job, ...current])
      await followStudioJob(
        job.id,
        event => {
          const status = event.payload?.status
          if (status && isCurrentProject()) {
            setJobs(current =>
              current.map(item => (item.id === job.id ? { ...item, status } : item))
            )
          }
        },
        0,
        controller.signal
      ).catch(error => {
        if (controller?.signal.aborted) throw error
        return pollStudioJob(
          job.id,
          next => {
            if (isCurrentProject()) {
              setJobs(current => current.map(item => (item.id === next.id ? next : item)))
            }
          },
          controller?.signal
        ).then(() => undefined)
      })
      if (isCurrentProject()) await refreshProject(activeProjectId)
    } catch (error) {
      if (isCurrentProject() && !(error instanceof DOMException && error.name === 'AbortError')) {
        setMessage(error instanceof Error ? error.message : t('Failed to retry job'))
      }
    } finally {
      controller?.abort()
      if (nextJobId) {
        followingJobs.current.delete(nextJobId)
        if (followControllers.current.get(nextJobId) === controller) {
          followControllers.current.delete(nextJobId)
        }
      }
    }
  }

  function addAsReference(assetId: string, role: ReferenceRole = 'subject') {
    setReferences(current => addReference(current, assetId, role, maxInputs))
    const parent = jobs.find(job => (job.outputs || []).some(output => output.asset_id === assetId))
    setParentJobId(parent?.id || null)
  }

  function enterFromAsset(assetId: string, mode: StudioUiMode) {
    pendingMaskRef.current = null
    setSelectedAssetId(assetId)
    setUiMode(mode)
    if (mode === 'edit' || mode === 'enhance' || mode === 'canvas') {
      addAsReference(assetId, 'edit')
    }
    if (mode === 'canvas') {
      persistBoard(current => seedAssetOnBoard(current, assetId))
      setBoardFocusId(assetId)
    }
    if (mode === 'enhance' && resolution === 'native') setResolution('2K')
  }

  // Parameter replay: restore a job's prompt + requested params into the
  // composer so the user can tweak-and-rerun any past generation.
  function reuseJobParams(job: StudioJob) {
    const requested = (job.requested_params || {}) as Record<string, unknown>
    if (job.prompt) setPrompt(job.prompt)
    const size = requested.size || requested.image_size
    if (typeof size === 'string' && size) setSize(size)
    if (typeof requested.quality === 'string') setQuality(requested.quality)
    if (typeof requested.style === 'string') setStyle(requested.style)
    if (typeof requested.output_format === 'string') setOutputFormat(requested.output_format)
    if (typeof job.profile_id === 'string' && typeof job.model_id === 'string' && job.model_id) {
      const key = `${job.profile_id}:${job.model_id}`
      if (models.some(model => studioModelKey(model) === key)) setModelKey(key)
    }
    setUiMode('create')
    setMessage(t('Parameters restored from a previous generation.'))
  }

  function varyFromAsset(assetId: string) {
    const parent = jobs.find(job => (job.outputs || []).some(output => output.asset_id === assetId))
    const nextPrompt = parent?.prompt || prompt
    setParentJobId(parent?.id || null)
    if (parent?.prompt) setPrompt(parent.prompt)
    setUiMode('create')
    void generate({
      uiMode: 'create',
      parentJobId: parent?.id || null,
      prompt: nextPrompt,
      references: [],
    })
  }

  async function toggleFavorite(asset: StudioAsset) {
    const activeProjectId = projectIdRef.current
    const epoch = projectEpochRef.current
    try {
      const updated = await setStudioAssetFavorite(asset.id, !asset.favorite)
      if (projectEpochRef.current !== epoch || projectIdRef.current !== activeProjectId) return
      setAssets(current => current.map(item => (item.id === updated.id ? updated : item)))
    } catch (error) {
      if (projectEpochRef.current === epoch && projectIdRef.current === activeProjectId) {
        setMessage(error instanceof Error ? error.message : t('Failed to update favorite'))
      }
    }
  }

  async function removeAsset(assetId: string) {
    const activeProjectId = projectIdRef.current
    const epoch = projectEpochRef.current
    try {
      const removed = assets.find(asset => asset.id === assetId) || null
      await deleteStudioAsset(assetId)
      if (projectEpochRef.current !== epoch || projectIdRef.current !== activeProjectId) return
      setDeletedAsset(removed)
      setAssets(current => current.filter(asset => asset.id !== assetId))
      setReferences(current => removeReference(current, assetId))
      if (selectedAssetId === assetId) setSelectedAssetId(null)
    } catch (error) {
      if (projectEpochRef.current === epoch && projectIdRef.current === activeProjectId) {
        setMessage(error instanceof Error ? error.message : t('Failed to delete image'))
      }
    }
  }

  async function undoAssetDelete() {
    if (!deletedAsset) return
    const target = deletedAsset
    const activeProjectId = projectIdRef.current
    const epoch = projectEpochRef.current
    try {
      const restored = await restoreStudioAsset(target.id)
      if (projectEpochRef.current !== epoch || projectIdRef.current !== activeProjectId) return
      setAssets(current => [restored, ...current.filter(asset => asset.id !== restored.id)])
      setDeletedAsset(null)
    } catch (error) {
      if (projectEpochRef.current === epoch && projectIdRef.current === activeProjectId) {
        setMessage(error instanceof Error ? error.message : t('Failed to restore image'))
      }
    }
  }

  async function loadMoreJobs() {
    const activeProjectId = projectIdRef.current
    const epoch = projectEpochRef.current
    const cursor = nextJobCursor
    if (!activeProjectId || cursor == null) return
    try {
      const page = await listStudioJobs(activeProjectId, cursor)
      if (projectEpochRef.current !== epoch || projectIdRef.current !== activeProjectId) return
      setJobs(current => {
        const known = new Set(current.map(job => job.id))
        return [...current, ...page.jobs.filter(job => !known.has(job.id))]
      })
      setNextJobCursor(page.next_cursor)
    } catch (error) {
      if (projectEpochRef.current === epoch && projectIdRef.current === activeProjectId) {
        setMessage(error instanceof Error ? error.message : t('Failed to load more tasks'))
      }
    }
  }

  const resultIds = new Set(jobs.flatMap(job => job.outputs || []).map(item => item.asset_id))
  const outputAssets = assets.filter(item => resultIds.has(item.id) || item.kind === 'output')
  const visibleAssets = favoriteOnly ? outputAssets.filter(item => item.favorite) : outputAssets
  const runningJobs = jobs.filter(job => ['queued', 'running'].includes(job.status))
  const activeJob = runningJobs.find(job => job.status === 'running') || runningJobs[0]
  const headerStatus = studioHeaderStatus({
    loading,
    hasModel: Boolean(selectedModel) || models.length > 0,
    runningCount: runningJobs.length,
  })
  const latestJob = jobs[0]
  const selectedAsset = assets.find(asset => asset.id === selectedAssetId) || null
  const previewAsset = assets.find(asset => asset.id === previewAssetId) || null
  const selectedJob =
    jobs.find(job => (job.outputs || []).some(output => output.asset_id === selectedAssetId)) ||
    jobs[0] ||
    null
  const hasResults = hasStudioResults(jobs, assets)
  const showEmpty = shouldShowFirstVisitEmpty(hasResults)
  const submit = canSubmitStudioJob(jobInput())
  const generateUi = generateButtonAppearance({
    status: activeJob?.status || (latestJob?.status === 'failed' ? 'failed' : undefined),
    lastError: latestJob?.status === 'failed' ? latestJob.error_message : undefined,
    hasModel: Boolean(selectedModel),
    hasPrompt: Boolean(jobInput().prompt.trim()),
    canSubmit: submit.ok,
    submitting: busy,
  })

  function statusLabel(status: string) {
    const labels: Record<string, string> = {
      queued: t('Queued'),
      running: t('Creating'),
      succeeded: t('Completed'),
      partial: t('Partially completed'),
      failed: t('Failed'),
      cancelled: t('Cancelled'),
      interrupted: t('Interrupted'),
    }
    return labels[status] || status
  }

  function modelName(job: StudioJob) {
    const match = models.find(
      item => item.profile_id === job.profile_id && item.model_id === job.model_id
    )
    return match?.model_name || job.model_id
  }

  function selectModel(nextKey: string) {
    const next = models.find(model => studioModelKey(model) === nextKey)
    if (!next) return
    setModelKey(nextKey)
    saveToStorage(STUDIO_MODEL_STORAGE_KEY, nextKey)
    setSize(next.defaults.size || next.defaults.image_size || '1024x1024')
    setQuality(next.defaults.quality || '')
    setAspectRatio(next.defaults.aspect_ratio || '')
    setOutputFormat(next.defaults.response_format || '')
    setStyle(next.defaults.style || '')
    setBackground(next.defaults.background || '')
    setCompression(next.defaults.compression || '')
    setCount(current => Math.min(current, Math.max(1, Math.min(4, next.capabilities.max_outputs ?? 4))))
  }

  const editSource = selectedAsset || assets.find(asset => asset.id === references[0]?.assetId)
  const showInspectorDocked = inspectorOpen && !narrow
  const showInspectorDrawer = inspectorOpen && narrow

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--border)] px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Images
            size={16}
            strokeWidth={1.7}
            className="shrink-0 text-[var(--muted-foreground)]"
          />
          <h1 className="truncate text-[13.5px] font-semibold tracking-tight">
            {t('Image Studio')}
            {projectTitle ? (
              <span className="font-normal text-[var(--muted-foreground)]">
                {' · '}
                {projectTitle}
              </span>
            ) : null}
          </h1>
        </div>
        <CreationDeskSwitch />
        <StudioModeControl
          value={uiMode}
          onChange={mode => {
            setUiMode(mode)
            if (mode !== 'create' && mode !== 'canvas' && !selectedAssetId && outputAssets[0]) {
              setSelectedAssetId(outputAssets[0].id)
            }
          }}
        />
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <div className="hidden rounded-lg bg-[var(--muted)]/50 p-0.5 sm:flex">
            <button
              type="button"
              onClick={() => persistDensity('simple')}
              title={t('Switch to simple mode')}
              className={`rounded-md px-2.5 py-1 text-[12px] ${density === 'simple' ? 'bg-[var(--background)] font-medium' : 'text-[var(--muted-foreground)]'}`}
            >
              {t('Simple mode')}
            </button>
            <button
              type="button"
              onClick={() => persistDensity('pro')}
              title={t('Switch to pro mode')}
              className={`rounded-md px-2.5 py-1 text-[12px] ${density === 'pro' ? 'bg-[var(--background)] font-medium' : 'text-[var(--muted-foreground)]'}`}
            >
              {t('Pro mode')}
            </button>
          </div>
          {headerStatus === 'busy' ? (
            <span className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-amber-800 sm:inline-flex dark:text-amber-200">
              <Loader2 size={12} className="animate-spin" />
              {t('{{count}} active tasks', { count: runningJobs.length })}
            </span>
          ) : headerStatus === 'unconfigured' ? (
            <span className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[var(--muted-foreground)] sm:inline-flex">
              <AlertCircle size={12} /> {t('Not configured')}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setLibraryOpen(true)}
            title={t('Library')}
            className="rounded-[10px] p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]"
          >
            <FolderOpen size={15} strokeWidth={1.7} />
          </button>
          {uiMode === 'canvas' ? (
            <button
              type="button"
              onClick={() => setAgentOpen(true)}
              title={t('Canvas Agent')}
              className="rounded-[10px] p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]"
            >
              <Sparkles size={15} strokeWidth={1.7} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setInspectorOpen(value => !value)}
            aria-pressed={inspectorOpen}
            title={inspectorOpen ? t('Hide inspector') : t('Show inspector')}
            className="rounded-[10px] p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]"
          >
            <PanelRight size={15} strokeWidth={1.7} />
          </button>
          <Link
            href="/settings/image"
            className="inline-flex h-8 items-center gap-1.5 rounded-[10px] px-2 text-[12.5px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]"
          >
            <Settings2 size={14} strokeWidth={1.7} />
            <span className="hidden sm:inline">{t('Image models')}</span>
          </Link>
        </div>
      </header>

      {offline ? (
        <p role="status" className="bg-amber-500/15 px-4 py-2 text-xs text-amber-800 dark:text-amber-200">
          {t('You are offline. Reconnect to generate or download the enhancer.')}
        </p>
      ) : null}
      {message &&
      !activeJob &&
      !(
        headerStatus === 'unconfigured' && /500|Failed to load Image Studio|Request failed/i.test(message)
      ) ? (
        <p
          role="alert"
          className="shrink-0 px-4 py-2 text-[12.5px] text-[var(--destructive)]"
        >
          {message}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <section className="relative flex min-h-0 min-w-0 flex-[1_1_72%] flex-col">
          {uiMode === 'create' ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-44">
              {!showEmpty ? (
                <div className="mb-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setFavoriteOnly(value => !value)}
                    className={`rounded-[10px] px-2.5 py-1 text-[12px] ${favoriteOnly ? 'bg-[var(--muted)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55'}`}
                  >
                    {t('Favorites only')}
                  </button>
                </div>
              ) : null}
              {loading ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                  {[0, 1, 2, 3].map(item => (
                    <div key={item} className="aspect-square animate-pulse rounded-[18px] bg-[var(--muted)]" />
                  ))}
                </div>
              ) : showEmpty ? (
                <div className="flex min-h-[48vh] flex-col items-center justify-center px-6 text-center">
                  <p className="text-[15px] font-medium tracking-tight">{t('Your next idea starts here')}</p>
                  <p className="mt-2 max-w-sm text-[12.5px] leading-5 text-[var(--muted-foreground)]">
                    {models.length
                      ? t('Type a prompt below to create your first image.')
                      : t('Configure an image model first, then return here to create.')}
                  </p>
                  {!models.length ? (
                    <Link
                      href="/settings/image"
                      className="mt-4 text-[12.5px] font-medium text-[var(--primary)] hover:underline"
                    >
                      {t('Configure image models')}
                    </Link>
                  ) : null}
                </div>
              ) : visibleAssets.length ? (
                <StudioResultGrid
                  assets={visibleAssets}
                  jobs={jobs}
                  selectedId={selectedAssetId}
                  onSelect={setSelectedAssetId}
                  onEdit={id => enterFromAsset(id, 'edit')}
                  onVary={varyFromAsset}
                  onReuseParams={reuseJobParams}
                  onReference={id => addAsReference(id, 'subject')}
                  onCanvas={id => enterFromAsset(id, 'canvas')}
                  onEnhance={id => enterFromAsset(id, 'enhance')}
                  onFavorite={asset => void toggleFavorite(asset)}
                  onDelete={id => void removeAsset(id)}
                  onRetry={id => void retryJob(id)}
                  modelName={modelName}
                />
              ) : (
                <p className="text-sm text-[var(--muted-foreground)]">{t('No results yet')}</p>
              )}
              {nextJobCursor != null ? (
                <button
                  type="button"
                  onClick={() => void loadMoreJobs()}
                  className="mt-4 w-full rounded-xl border border-[var(--border)] py-2 text-xs"
                >
                  {t('Load more')}
                </button>
              ) : null}
            </div>
          ) : null}

          {uiMode === 'edit' ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {editSource ? (
                <div className="min-h-0 flex-1 overflow-auto bg-[var(--muted)]/30 p-4 pb-44">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={studioAssetUrl(editSource.id)}
                    alt={t('Image to edit')}
                    className="mx-auto max-h-[62vh] max-w-full rounded-[18px] object-contain"
                  />
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                    <p className="text-xs text-[var(--muted-foreground)]">{t('Describe how to modify')}</p>
                    <button
                      type="button"
                      onClick={() => setMaskOpen(true)}
                      className="rounded-full border border-[var(--border)] px-3 py-1 text-[11px]"
                    >
                      {t('Local redraw')}
                    </button>
                  </div>
                </div>
              ) : (
                <ModeNeedSelection
                  title={t('Select an image to edit')}
                  assets={outputAssets}
                  onPick={id => enterFromAsset(id, 'edit')}
                />
              )}
            </div>
          ) : null}

          {uiMode === 'canvas' ? (
            <div className="relative flex min-h-0 flex-1 flex-col pb-44">
              {boardReady ? (
                <StudioInfiniteBoard
                board={board}
                onChange={persistBoard}
                assetUrl={studioAssetUrl}
                libraryIds={outputAssets.map(asset => asset.id)}
                busyNodeIds={new Set(board.nodes.filter(node => node.status === 'running').map(node => node.id))}
                onGenerateNode={generateFromBoardNode}
                onUploadFiles={(files, origin, nodeId) => void uploadToBoard(files, origin, nodeId)}
                onRetryNode={node => generateFromBoardNode(node)}
                onOpenInpaint={node => {
                  if (node.assetId) {
                    setSelectedAssetId(node.assetId)
                    setBoardMaskNode(node)
                  }
                }}
                onSelectAsset={id => {
                  setSelectedAssetId(id)
                  setBoardFocusId(null)
                }}
                focusAssetId={boardFocusId}
                models={models}
                modelKey={modelKey}
                language={i18n.language}
                onDownloadAssets={ids => {
                  for (const id of ids) {
                    const link = document.createElement('a')
                    link.href = studioAssetUrl(id)
                    link.download = ''
                    link.target = '_blank'
                    link.rel = 'noreferrer'
                    link.click()
                  }
                }}
                />
              ) : (
                <div
                  role="status"
                  className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]"
                >
                  <Loader2 size={16} className="animate-spin" />
                  {t('Loading canvas…')}
                </div>
              )}
              <StudioAgentPanel
                open={agentOpen}
                onClose={() => setAgentOpen(false)}
                studio="image"
                projectId={projectId}
                prompt={prompt}
                modelKey={modelKey}
                language={i18n.language}
                onStarted={() => {
                  void getStudioBoard(projectId).then(document => {
                    setBoard(normalizeBoard(document))
                    boardRef.current = normalizeBoard(document)
                  })
                  if (projectId) void refreshProject(projectId)
                }}
              />
              {boardMaskNode?.assetId ? (
                <div className="absolute inset-0 z-20 flex flex-col bg-[var(--background)]">
                  <StudioCanvas
                    key={boardMaskNode.assetId}
                    sourceUrl={studioAssetUrl(boardMaskNode.assetId)}
                    operations={operations}
                    hasSelection
                    busy={busy}
                    onUnavailable={setMessage}
                    onMaskReady={file => {
                      pendingMaskRef.current = file
                    }}
                    onInpaint={file => {
                      void generate({ uiMode: 'canvas' }, file, boardMaskNode.id)
                      setBoardMaskNode(null)
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setBoardMaskNode(null)}
                    className="absolute top-3 right-4 rounded-full border border-[var(--border)]/70 bg-[var(--card)]/95 px-3 py-1.5 text-[12px] shadow-sm backdrop-blur-sm"
                  >
                    {t('Back to board')}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {uiMode === 'enhance' ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4 pb-44">
              {editSource ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={studioAssetUrl(editSource.id)}
                    alt={t('HD enhance')}
                    className="mx-auto max-h-[52vh] max-w-full rounded-2xl object-contain"
                  />
                  <div className="mx-auto mt-4 max-w-lg px-1 text-center">
                    <p className="text-[13.5px] font-medium tracking-tight">{t('HD enhance')}</p>
                    {upscaler?.supported === false ? (
                      <p className="mt-2 text-[12.5px] text-amber-800 dark:text-amber-200">
                        {t('Vulkan is unavailable, so enhancement will use basic resizing.')}
                      </p>
                    ) : upscaler && !upscaler.installed ? (
                      <p className="mt-2 text-[12.5px] text-[var(--muted-foreground)]">
                        {t('Install the local enhancer or generation will fall back to basic resizing.')}
                      </p>
                    ) : (
                      <p className="mt-2 text-[12.5px] text-[var(--muted-foreground)]">
                        {t('Native output is preferred; smaller results are enhanced to the target size.')}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <ModeNeedSelection
                  title={t('Select an image to enhance')}
                  assets={outputAssets}
                  onPick={id => enterFromAsset(id, 'enhance')}
                />
              )}
            </div>
          ) : null}

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4 sm:px-6">
            <div className="pointer-events-none absolute inset-x-0 -top-10 h-10 bg-gradient-to-t from-[var(--background)] to-transparent" />
            <div
              className={`pointer-events-auto w-full ${hasResults ? 'max-w-[920px]' : 'max-w-[768px]'}`}
            >
            <StudioPromptBar
              prompt={prompt}
              onPrompt={setPrompt}
              placeholder={
                uiMode === 'canvas'
                  ? t('Describe what to place on the board…')
                  : undefined
              }
              references={references}
              maxInputs={maxInputs}
              busy={busy}
              onAddReference={() => fileRef.current?.click()}
              onChangeRole={(id, role) =>
                setReferences(current => assignReferenceRole(current, id, role))
              }
              onRemoveReference={id => setReferences(current => removeReference(current, id))}
              onPreviewReference={setPreviewAssetId}
              aspectRatio={aspectRatio}
              onAspectRatio={setAspectRatio}
              resolution={resolution}
              onResolution={setResolution}
              count={count}
              onCount={setCount}
              showCount={fieldIsVisible('count', density, selectedModel?.capabilities)}
              maxOutputs={maxOutputs}
              showAspectRatio={advertisedParameters(selectedModel?.capabilities).includes('aspect_ratio')}
              generate={{
                ...generateUi,
                disabled: generateUi.disabled || (uiMode === 'canvas' && !boardReady),
              }}
              onGenerate={() => {
                if (uiMode === 'canvas') {
                  if (boardReady) generateOnBoardFromPrompt()
                  return
                }
                void generate()
              }}
              onCancel={() => activeJob && void cancelJob(activeJob.id)}
              canCancel={Boolean(activeJob)}
              statusLabel={
                activeJob ? `${statusLabel(activeJob.status)} · ${modelName(activeJob)}` : undefined
              }
              models={models}
              modelKey={modelKey}
              onModelKey={selectModel}
            />
            </div>
          </div>
        </section>

        {showInspectorDocked ? (
          <StudioInspector
            density={density}
            projects={projects}
            projectId={projectId}
            projectTitle={projectTitle}
            models={models}
            modelKey={modelKey}
            selectedModel={selectedModel}
            onProjectId={id => {
              activateProject(id, projects.find(project => project.id === id)?.title || '')
            }}
            onProjectTitle={setProjectTitle}
            onRename={() => void renameProject()}
            onAddProject={() => void addProject()}
            onRemoveProject={() => void removeProject()}
            onModelKey={selectModel}
            style={style}
            onStyle={setStyle}
            background={background}
            onBackground={setBackground}
            outputFormat={outputFormat}
            onOutputFormat={setOutputFormat}
            compression={compression}
            onCompression={setCompression}
            upscalePreset={upscalePreset}
            onUpscalePreset={setUpscalePreset}
            resolution={resolution}
            upscaler={upscaler}
            installingUpscaler={installingUpscaler}
            onInstallUpscaler={() => void installUpscaler()}
            selectedJob={selectedJob}
            factsOpen={factsOpen}
            onFactsOpen={setFactsOpen}
          />
        ) : null}
      </div>

      {showInspectorDrawer ? (
        <div className="fixed inset-0 z-40 flex justify-end">
          <button
            type="button"
            aria-label={t('Hide inspector')}
            className="h-full flex-1 bg-[var(--overlay)]"
            onClick={() => setInspectorOpen(false)}
          />
          <StudioInspector
            density={density}
            projects={projects}
            projectId={projectId}
            projectTitle={projectTitle}
            models={models}
            modelKey={modelKey}
            selectedModel={selectedModel}
            onProjectId={id => {
              activateProject(id, projects.find(project => project.id === id)?.title || '')
            }}
            onProjectTitle={setProjectTitle}
            onRename={() => void renameProject()}
            onAddProject={() => void addProject()}
            onRemoveProject={() => void removeProject()}
            onModelKey={selectModel}
            style={style}
            onStyle={setStyle}
            background={background}
            onBackground={setBackground}
            outputFormat={outputFormat}
            onOutputFormat={setOutputFormat}
            compression={compression}
            onCompression={setCompression}
            upscalePreset={upscalePreset}
            onUpscalePreset={setUpscalePreset}
            resolution={resolution}
            upscaler={upscaler}
            installingUpscaler={installingUpscaler}
            onInstallUpscaler={() => void installUpscaler()}
            selectedJob={selectedJob}
            factsOpen={factsOpen}
            onFactsOpen={setFactsOpen}
          />
        </div>
      ) : null}

      <input
        ref={fileRef}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        onChange={event => {
          const files = event.currentTarget.files
          void upload(files, uiMode === 'create' ? 'subject' : 'edit')
          event.currentTarget.value = ''
        }}
      />
      <StudioLibraryPicker
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        kinds={['image', 'text']}
        onPickPrompt={item => setPrompt(item.body)}
        onPickAsset={asset => {
          if (asset.kind === 'text' && asset.content) {
            setPrompt(current => (current ? `${current}\n${asset.content}` : asset.content))
            return
          }
          if (!projectId || asset.kind !== 'image') return
          void (async () => {
            const response = await fetch(libraryAssetUrl(asset.id))
            const blob = await response.blob()
            const file = new File([blob], `${asset.title || 'library'}.png`, { type: blob.type || 'image/png' })
            const uploaded = await uploadStudioAsset(projectId, file)
            setReferences(current => addReference(current, uploaded.id, 'subject', 4))
            setSelectedAssetId(uploaded.id)
            await refreshProject(projectId)
          })().catch(error => setMessage(error instanceof Error ? error.message : t('Import failed')))
        }}
      />

      {deletedProject ? (
        <button
          onClick={() => void undoProjectDelete()}
          className="fixed bottom-24 left-5 z-40 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-xs"
        >
          {t('Project deleted — Undo')}
        </button>
      ) : null}

      {deletedAsset ? (
        <div className="fixed right-5 bottom-5 z-40 flex items-center gap-4 rounded-xl bg-[var(--foreground)] px-4 py-3 text-xs text-[var(--background)]">
          <span>{t('Image deleted')}</span>
          <button type="button" onClick={() => void undoAssetDelete()} className="font-semibold underline">
            {t('Undo')}
          </button>
          <button type="button" aria-label={t('Dismiss')} onClick={() => setDeletedAsset(null)}>
            <X size={14} />
          </button>
        </div>
      ) : null}

      {previewAsset ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-[var(--overlay)] p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setPreviewAssetId(null)}
        >
          <div
            className="relative max-h-full max-w-5xl overflow-hidden rounded-[20px] bg-[var(--card)]"
            onClick={event => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setPreviewAssetId(null)}
              aria-label={t('Close preview')}
              className="absolute top-3 right-3 rounded-full bg-black/60 p-2 text-white"
            >
              <X size={16} />
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={studioAssetUrl(previewAsset.id)}
              alt={t('Image preview')}
              className="max-h-[80vh] max-w-full object-contain"
            />
          </div>
        </div>
      ) : null}

      {maskOpen && editSource ? (
        <MaskEditor
          key={editSource.id}
          sourceUrl={studioAssetUrl(editSource.id)}
          busy={busy}
          onCancel={() => setMaskOpen(false)}
          onSave={saveDrawnMask}
        />
      ) : null}
    </main>
  )
}

function ModeNeedSelection({
  title,
  assets,
  onPick,
}: {
  title: string
  assets: StudioAsset[]
  onPick: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-36 text-center">
      <p className="text-[15px] font-medium tracking-tight">{title}</p>
      <p className="mt-2 text-[12.5px] text-[var(--muted-foreground)]">
        {t('Choose a result, then edit, paint, or enhance it.')}
      </p>
      {assets.length ? (
        <div className="mt-4 grid max-w-3xl grid-cols-3 gap-3 sm:grid-cols-4">
          {assets.slice(0, 8).map(asset => (
            <button
              key={asset.id}
              type="button"
              onClick={() => onPick(asset.id)}
              className="overflow-hidden rounded-2xl border border-[var(--border)]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={studioAssetUrl(asset.id)} alt="" className="aspect-square w-full object-cover" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
