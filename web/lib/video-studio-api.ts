import { apiFetch, apiUrl } from '@/lib/api'
import { normalizeVideoBoard } from '@/lib/video-studio/board-logic'
import type { VideoBoardDocument, VideoBoardEdgeRole } from '@/lib/video-studio/board-logic'
import type { DirectorProjectResponse } from '@/lib/director-desk/protocol'
import { hashFileSha256 } from '@/lib/video-studio/sha256'

export type {
  VideoBoardDocument,
  VideoBoardNode,
  VideoBoardEdge,
  VideoBoardEdgeRole,
  VideoBoardGroup,
  VideoBoardViewport,
} from '@/lib/video-studio/board-logic'

const BASE = '/api/v1/video-studio'

export type VideoOperation =
  | 'text_to_video'
  | 'image_to_video'
  | 'video_to_video'
  | 'extend'
  | 'remix'
  | 'edit'
export type VideoJobStatus =
  | 'queued'
  | 'submitting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
export type VideoAudioMode = 'none' | 'generate' | 'input'

export type VideoParameterSchema = {
  type?: 'object'
  properties?: Record<
    string,
    {
      type?:
        | 'string'
        | 'number'
        | 'integer'
        | 'boolean'
        | Array<'string' | 'number' | 'integer' | 'boolean' | 'null'>
      title?: string
      description?: string
      enum?: Array<string | number>
      default?: unknown
      minimum?: number
      maximum?: number
      step?: number
      maxLength?: number
    }
  >
}

export type VideoModelCapabilities = {
  operations?: VideoOperation[]
  durations?: number[]
  aspect_ratios?: string[]
  resolutions?: string[]
  fps?: number[]
  audio_modes?: VideoAudioMode[]
  reference_modes?: string[]
  max_inputs?: { image?: number; video?: number; audio?: number; total?: number }
  max_input_bytes?: number
  supports_cancel?: boolean
  supports_seed?: boolean
  max_prompt_length?: number
  parameter_schema?: VideoParameterSchema
}

export type VideoModelOption = {
  profile_id: string
  model_id: string
  profile_name: string
  model_name: string
  model: string
  provider: string
  active?: boolean
  capabilities: VideoModelCapabilities
  defaults: Record<string, unknown>
  lifecycle?: {
    status?: 'active' | 'deprecated' | 'disabled' | string
    shutdown_date?: string | null
    message?: string | null
  } | null
}

export type VideoProject = {
  id: string
  title: string
  created_at: string | number
  updated_at: string | number
  deleted_at?: string | number | null
  /** §Phase D3 project-level BGM slot (absent fields = neutral defaults). */
  bgm_asset_id?: string | null
  bgm_volume?: number
  bgm_fade_in?: number
  bgm_fade_out?: number
}

export type VideoAsset = {
  id: string
  project_id: string
  kind: 'image' | 'video' | 'audio' | string
  mime_type: string
  filename: string
  size_bytes: number
  sha256: string
  created_at: string | number
  width?: number | null
  height?: number | null
  duration?: number | null
}

export type VideoJob = {
  id: string
  project_id: string
  operation: VideoOperation
  status: VideoJobStatus
  progress: number
  stage?: string | null
  prompt: string
  profile_id: string
  model_id: string
  parameters: Record<string, unknown>
  input_asset_ids: string[]
  output_asset_ids: string[]
  provider_task_id?: string | null
  error?: { code?: string; message?: string } | string | null
  error_code?: string | null
  error_message?: string | null
  created_at: string | number
  started_at?: string | number | null
  finished_at?: string | number | null
  retry_of_job_id?: string | null
  storyboard_shot_id?: string | null
  board_node_id?: string | null
  inputs?: VideoJobInput[]
}

export type VideoJobEvent = {
  job_id: string
  seq: number
  type: string
  status?: VideoJobStatus
  progress?: number
  stage?: string | null
  message?: string | null
  created_at: string | number
  payload?: Record<string, unknown> | null
}

/** §Phase B character library entry — one cross-shot identity anchor. */
export type VideoCharacter = {
  id: string
  project_id: string
  name: string
  description: string
  reference_asset_ids: string[]
  three_view_asset_id?: string | null
  voice_hint: string
  created_at: string | number
  updated_at: string | number
  deleted_at?: string | number | null
}

export type VideoStoryboardShot = {
  id: string
  order: number
  title: string
  prompt: string
  input_asset_ids: string[]
  job_id?: string | null
  output_asset_id?: string | null
  duration?: number | null
  notes?: string | null
  transition?: string | null
  /** §E3 trim window in source seconds: 0 ≤ trim_in < trim_out ≤ duration. */
  trim_in?: number | null
  trim_out?: number | null
  /** §E4 per-shot voiceover gain 0.0–2.0 (null = compose default 1.0). */
  voiceover_volume?: number | null
  /** C4 camera control: short motion label ("push", "pan-left") from planning. */
  camera?: string | null
  keyframe_asset_id?: string | null
  keyframe_prompt?: string | null
    director_camera_id?: string | null
    director_camera_json?: Record<string, unknown> | null
  voiceover_text?: string | null
  voiceover_asset_id?: string | null
  voiceover_voice?: string | null
  character_ids?: string[]
}

export type VideoFfmpegStatus = {
  available: boolean
  source?: string | null
  version?: string
  install_supported?: boolean
  download_bytes?: number
  engine?: string
}

export type VideoComposition = {
  job: Pick<VideoJob, 'id' | 'status' | 'progress' | 'created_at' | 'finished_at' | 'error_code' | 'error_message'>
  asset?: VideoAsset | null
}

export type VideoStoryboardDocument = {
  version: 1
  revision: number
  shots: VideoStoryboardShot[]
  updated_at?: string | number | null
}

/** One role-tagged job input (`role ∈ reference|first-frame|last-frame|audio|continue-from`). */
export type VideoJobInput = {
  asset_id: string
  role: VideoBoardEdgeRole
}

export class VideoStudioApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown
  ) {
    super(message)
    this.name = 'VideoStudioApiError'
  }
}

/**
 * Raised when a board PUT loses the optimistic-concurrency race (server 409
 * with `board_revision_conflict`). `serverRevision` is the board revision the
 * server currently holds — callers should reload the board and offer to retry
 * the edit on top of it.
 */
export class VideoBoardConflictError extends VideoStudioApiError {
  constructor(
    message: string,
    status: number,
    readonly serverRevision: number | null,
    detail?: unknown
  ) {
    super(message, status, detail)
    this.name = 'VideoBoardConflictError'
  }
}

export function normalizeVideoUploadMime(mime: string): string {
  const normalized = String(mime || '').split(';', 1)[0].trim().toLowerCase()
  // Chromium/Windows commonly reports .m4a as either alias while the server
  // deliberately stores its sniffed ISO-BMFF media type as audio/mp4.
  if (normalized === 'audio/x-m4a' || normalized === 'audio/m4a') return 'audio/mp4'
  return normalized
}

async function discardVideoUploadSession(uploadId: string): Promise<void> {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), 5_000)
  try {
    await apiFetch(apiUrl(`${BASE}/uploads/${encodeURIComponent(uploadId)}`), {
      method: 'DELETE',
      signal: controller.signal,
      skipAuthRedirect: true,
    })
  } catch {
    // Best effort only: the session is also expired server-side, and a lost
    // complete response may mean the server has already removed it.
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const detail = payload?.detail
    const message =
      (typeof detail === 'string' ? detail : detail?.message) ||
      payload?.error?.message ||
      `Request failed (${response.status})`
    throw new VideoStudioApiError(message, response.status, detail)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export async function listVideoModels(signal?: AbortSignal) {
  return json<{ options: VideoModelOption[]; selected?: string | null }>(
    await apiFetch(apiUrl(`${BASE}/models`), { cache: 'no-store', signal })
  )
}

export async function listVideoProjects(signal?: AbortSignal): Promise<VideoProject[]> {
  const payload = await json<{ projects: VideoProject[] }>(
    await apiFetch(apiUrl(`${BASE}/projects?limit=100`), { cache: 'no-store', signal })
  )
  return payload.projects || []
}

export async function createVideoProject(title: string): Promise<VideoProject> {
  return json(
    await apiFetch(apiUrl(`${BASE}/projects`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  )
}

/** Mark this project as the workspace current project so chat videogen binds to it. */
export async function activateVideoProject(projectId: string): Promise<VideoProject> {
  const payload = await json<{ project?: VideoProject }>(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/activate`), {
      method: 'POST',
    })
  )
  return (payload.project || payload) as VideoProject
}

export async function getVideoProject(id: string, signal?: AbortSignal): Promise<VideoProject> {
  return json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(id)}`), {
      cache: 'no-store',
      signal,
    })
  )
}

/** §Phase D3: the project-level BGM slot patch. Absent keys stay unchanged;
 * `bgm_asset_id: ''` clears the slot, a non-empty id points at a project audio asset. */
export type VideoProjectPatch = {
  title?: string
  bgm_asset_id?: string
  bgm_volume?: number
  bgm_fade_in?: number
  bgm_fade_out?: number
}

export async function updateVideoProject(
  id: string,
  patch: string | VideoProjectPatch
): Promise<VideoProject> {
  const body: VideoProjectPatch = typeof patch === 'string' ? { title: patch } : patch
  return json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(id)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
}

export type DirectorDeskSnapshot = {
  project_id: string
  director_desk: DirectorProjectResponse | null
}

/** Durable backup of the embedded 3D director-desk project (not the live scene). */
export async function getDirectorDeskSnapshot(
  projectId: string,
  signal?: AbortSignal
): Promise<DirectorDeskSnapshot> {
  return json<DirectorDeskSnapshot>(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/director-desk`), {
      cache: 'no-store',
      signal,
    })
  )
}

export async function saveDirectorDeskSnapshot(
  projectId: string,
  document: DirectorProjectResponse
): Promise<DirectorDeskSnapshot> {
  return json<DirectorDeskSnapshot>(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/director-desk`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ director_desk: document }),
    })
  )
}

export async function clearDirectorDeskSnapshot(projectId: string): Promise<void> {
  await json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/director-desk`), {
      method: 'DELETE',
    })
  )
}

export type VideoProductionPayload = {
  project_id: string
  production: import('./video-studio/production-logic').VideoProduction
  readiness: import('./video-studio/production-logic').ProductionReadiness
  storyboard?: VideoStoryboardDocument
  character_ids?: Record<string, string>
  board?: { imported: number; skipped: number }
}

export async function getVideoProduction(projectId: string, signal?: AbortSignal) {
  return json<VideoProductionPayload>(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/production`), {
      cache: 'no-store',
      signal,
    })
  )
}

export async function saveVideoProduction(
  projectId: string,
  production: import('./video-studio/production-logic').VideoProduction
) {
  return json<VideoProductionPayload>(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/production`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ production }),
    })
  )
}

export async function analyzeVideoProduction(projectId: string) {
  return json<VideoProductionPayload>(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/production/analyze`), {
      method: 'POST',
    })
  )
}

export async function confirmVideoProduction(projectId: string, notes = '') {
  return json<VideoProductionPayload>(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/production/confirm`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    })
  )
}

export async function reopenVideoProduction(projectId: string, notes = '') {
  return json<VideoProductionPayload>(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/production/reopen`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    })
  )
}

export async function applyVideoProduction(
  projectId: string,
  input: { replace?: boolean; place_on_board?: boolean } = {}
) {
  return json<VideoProductionPayload>(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/production/apply`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        replace: Boolean(input.replace),
        place_on_board: input.place_on_board !== false,
      }),
    })
  )
}
export async function deleteVideoProject(id: string): Promise<void> {
  await json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(id)}`), { method: 'DELETE' })
  )
}

export async function listVideoCharacters(
  projectId: string,
  signal?: AbortSignal
): Promise<VideoCharacter[]> {
  const payload = await json<{ characters: VideoCharacter[] }>(
    await apiFetch(
      apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/characters`),
      { cache: 'no-store', signal }
    )
  )
  return payload.characters || []
}

export async function createVideoCharacter(
  projectId: string,
  input: {
    name: string
    description?: string
    reference_asset_ids?: string[]
    voice_hint?: string
  }
): Promise<VideoCharacter> {
  const payload = await json<{ character: VideoCharacter }>(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/characters`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: input.name,
        description: input.description || '',
        reference_asset_ids: input.reference_asset_ids || [],
        voice_hint: input.voice_hint || '',
      }),
    })
  )
  return payload.character
}

export async function updateVideoCharacter(
  projectId: string,
  characterId: string,
  input: {
    name?: string
    description?: string
    reference_asset_ids?: string[]
    voice_hint?: string
  }
): Promise<VideoCharacter> {
  const payload = await json<{ character: VideoCharacter }>(
    await apiFetch(
      apiUrl(
        `${BASE}/projects/${encodeURIComponent(projectId)}/characters/${encodeURIComponent(characterId)}`
      ),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }
    )
  )
  return payload.character
}

export async function deleteVideoCharacter(
  projectId: string,
  characterId: string
): Promise<void> {
  await json(
    await apiFetch(
      apiUrl(
        `${BASE}/projects/${encodeURIComponent(projectId)}/characters/${encodeURIComponent(characterId)}`
      ),
      { method: 'DELETE' }
    )
  )
}

/** Paid imagegen call (two-step confirm on the UI side): three-view sheet. */
export async function generateVideoCharacterThreeView(
  projectId: string,
  characterId: string,
  input: { prompt?: string; confirmed_cost: boolean } = { confirmed_cost: false }
): Promise<{ asset: VideoAsset; character: VideoCharacter; image_job_id?: string | null }> {
  return json(
    await apiFetch(
      apiUrl(
        `${BASE}/projects/${encodeURIComponent(projectId)}/characters/${encodeURIComponent(characterId)}/three-view`
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: input.prompt || null,
          confirmed_cost: input.confirmed_cost,
        }),
      }
    )
  )
}

export async function getVideoStoryboard(
  projectId: string,
  signal?: AbortSignal
): Promise<VideoStoryboardDocument> {
  return json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/storyboard`), {
      cache: 'no-store',
      signal,
    })
  )
}

export async function saveVideoStoryboard(
  projectId: string,
  document: VideoStoryboardDocument,
  signal?: AbortSignal
): Promise<VideoStoryboardDocument> {
  return json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/storyboard`), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': `"${Math.max(0, Math.trunc(document.revision || 0))}"`,
      },
      body: JSON.stringify(document),
      signal,
    })
  )
}

/** Generate one shot's first-frame image (paid; requires explicit confirmation). */
export async function generateVideoShotKeyframe(
  projectId: string,
  shotId: string,
  body: {
    prompt?: string
    profile_id?: string
    model_id?: string
    size?: string
    aspect_ratio?: string
    confirmed_cost: boolean
  },
  signal?: AbortSignal
): Promise<{ asset: VideoAsset; image_job_id?: string; storyboard: VideoStoryboardDocument }> {
  return json(
    await apiFetch(
      apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/storyboard/shots/${encodeURIComponent(shotId)}/keyframe`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }
    )
  )
}

/** Synthesize one shot's TTS narration (paid; requires explicit confirmation). */
export async function generateVideoShotVoiceover(
  projectId: string,
  shotId: string,
  body: { text: string; voice?: string; format?: string; confirmed_cost: boolean },
  signal?: AbortSignal
): Promise<{ asset: VideoAsset; duration?: number | null; storyboard: VideoStoryboardDocument }> {
  return json(
    await apiFetch(
      apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/storyboard/shots/${encodeURIComponent(shotId)}/voiceover`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }
    )
  )
}

export type VideoComposeSubtitleRequest = {
  mode?: 'off' | 'from_notes' | 'from_asr' | 'from_asset'
  /** Phase D2 burn-in style: a preset key or raw ffmpeg force_style value. */
  style?: string
  /** Required by mode="from_asset": the saved subtitle document to burn. */
  srt_asset_id?: string
  /** §E2 custom burn-in size (12–72), overriding the style preset. */
  font_size?: number
  /** §E2 custom ASS colour ("&H00FFFFFF"), overriding the style preset. */
  primary_colour?: string
}

export type VideoComposeRequest = {
  shot_order?: string[] | null
  subtitle?: VideoComposeSubtitleRequest
  /**
   * §Phase D3: BGM keys left absent inherit the project's saved slot; an
   * explicit `bgm_asset_id: ''` composes without music; explicit values
   * override the slot for this composition only.
   */
  audio?: {
    voiceovers?: boolean
    bgm_asset_id?: string
    bgm_volume?: number
    bgm_fade_in?: number
    bgm_fade_out?: number
  }
  output?: {
    resolution?: '480p' | '720p' | '1080p'
    fps?: number
    format?: 'mp4'
    /** §E5 experimental: frame-by-frame 720p→1080p upscale before stitching. */
    upscale?: boolean
  }
  client_request_id: string
}

/** Queue the free local MP4 composition of the storyboard shots. */
export async function composeVideoProject(
  projectId: string,
  body: VideoComposeRequest,
  signal?: AbortSignal
): Promise<VideoJob> {
  return json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/compose`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  )
}

export async function listVideoCompositions(
  projectId: string,
  signal?: AbortSignal
): Promise<VideoComposition[]> {
  const payload = await json<{ compositions: VideoComposition[] }>(
    await apiFetch(
      apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/compositions`),
      { cache: 'no-store', signal }
    )
  )
  return payload.compositions || []
}

/** Phase D2 subtitle editor: save the SRT document as a project subtitle asset. */
export async function saveVideoSubtitleAsset(
  projectId: string,
  body: { content: string; filename?: string },
  signal?: AbortSignal
): Promise<VideoAsset> {
  const payload = await json<{ asset: VideoAsset }>(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/subtitle-assets`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  )
  return payload.asset
}

/** Phase D2 subtitle editor: overwrite a saved subtitle asset in place. */
export async function updateVideoSubtitleAsset(
  assetId: string,
  body: { content: string; filename?: string },
  signal?: AbortSignal
): Promise<VideoAsset> {
  const payload = await json<{ asset: VideoAsset }>(
    await apiFetch(apiUrl(`${BASE}/assets/${encodeURIComponent(assetId)}/subtitle`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  )
  return payload.asset
}

export async function getVideoFfmpegStatus(signal?: AbortSignal): Promise<VideoFfmpegStatus> {
  return json(await apiFetch(apiUrl(`${BASE}/ffmpeg/status`), { cache: 'no-store', signal }))
}

/** Download and install the pinned local ffmpeg build (admin action, ~80MB). */
export async function installVideoFfmpeg(signal?: AbortSignal): Promise<VideoFfmpegStatus> {
  return json(await apiFetch(apiUrl(`${BASE}/ffmpeg/install`), { method: 'POST', signal }))
}

function boardConflictFrom(error: unknown): VideoBoardConflictError | null {
  if (!(error instanceof VideoStudioApiError)) return null
  if (error.status !== 409 && error.status !== 412) return null
  const detail = error.detail
  if (!detail || typeof detail !== 'object') return null
  const record = detail as { code?: unknown; current_revision?: unknown }
  if (record.code !== 'board_revision_conflict') return null
  const revision = Number(record.current_revision)
  return new VideoBoardConflictError(
    error.message,
    error.status,
    Number.isInteger(revision) && revision >= 0 ? revision : null,
    detail
  )
}

export async function getVideoBoard(
  projectId: string,
  signal?: AbortSignal
): Promise<VideoBoardDocument> {
  return normalizeVideoBoard(
    await json<unknown>(
      await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/board`), {
        cache: 'no-store',
        signal,
      })
    )
  )
}

export async function saveVideoBoard(
  projectId: string,
  document: VideoBoardDocument,
  signal?: AbortSignal
): Promise<VideoBoardDocument> {
  try {
    return normalizeVideoBoard(
      await json<unknown>(
        await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/board`), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'If-Match': `"${Math.max(0, Math.trunc(document.revision || 0))}"`,
          },
          body: JSON.stringify(document),
          signal,
        })
      )
    )
  } catch (error) {
    const conflict = boardConflictFrom(error)
    if (conflict) throw conflict
    throw error
  }
}

/**
 * Place a §5.5 template fragment (shot-i2v / first-last / storyboard-6 /
 * character-episode / extend-chain / character-card plus the §F3 scaffolds —
 * vertical-series, product-triptych, talking-head, text-to-video, compare-ab,
 * tutorial-steps, grid-nine) on the canvas. The server positions the
 * nodes at the next free origin and bumps the board revision; templates never
 * create jobs. 404 = unknown template, 422 = board capacity exceeded.
 */
export async function placeVideoBoardTemplate(
  projectId: string,
  templateId: string,
  signal?: AbortSignal
): Promise<VideoBoardDocument> {
  return normalizeVideoBoard(
    await json<unknown>(
      await apiFetch(
        apiUrl(
          `${BASE}/projects/${encodeURIComponent(projectId)}/board/templates/${encodeURIComponent(templateId)}`
        ),
        { method: 'POST', cache: 'no-store', signal }
      )
    )
  )
}

/**
 * Turn storyboard strip shots into a row of generate nodes. With `force` the
 * title+prompt dedup is disabled, so already-imported shots are imported again.
 */
export async function importVideoStoryboardToBoard(
  projectId: string,
  options: { force?: boolean; signal?: AbortSignal } = {}
): Promise<{ board: VideoBoardDocument; imported: number; skipped: number }> {
  const payload = await json<{ board?: unknown; imported?: unknown; skipped?: unknown }>(
    await apiFetch(
      apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/board/import-storyboard`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: Boolean(options.force) }),
        cache: 'no-store',
        signal: options.signal,
      }
    )
  )
  return {
    board: normalizeVideoBoard(payload.board),
    imported: Math.max(0, Number(payload.imported) || 0),
    skipped: Math.max(0, Number(payload.skipped) || 0),
  }
}

/** Append canvas generate nodes as storyboard strip shots (§7.3, one-way). */
export async function exportVideoBoardToStoryboard(
  projectId: string,
  signal?: AbortSignal
): Promise<{ storyboard: VideoStoryboardDocument; exported: number }> {
  const payload = await json<{ storyboard?: unknown; exported?: unknown }>(
    await apiFetch(
      apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/board/export-storyboard`),
      { method: 'POST', cache: 'no-store', signal }
    )
  )
  return {
    storyboard: (payload.storyboard || {}) as VideoStoryboardDocument,
    exported: Math.max(0, Number(payload.exported) || 0),
  }
}

export async function listVideoAssets(
  projectId: string,
  cursor?: string | null,
  signal?: AbortSignal
): Promise<{ assets: VideoAsset[]; next_cursor: string | null }> {
  const search = new URLSearchParams({ limit: '80' })
  if (cursor) search.set('cursor', cursor)
  return json(
    await apiFetch(
      apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/assets?${search.toString()}`),
      { cache: 'no-store', signal }
    )
  )
}

export async function getVideoAsset(id: string, signal?: AbortSignal): Promise<VideoAsset> {
  return json(
    await apiFetch(apiUrl(`${BASE}/assets/${encodeURIComponent(id)}`), {
      cache: 'no-store',
      signal,
    })
  )
}

export function videoAssetUrl(id: string): string {
  return apiUrl(`${BASE}/assets/${encodeURIComponent(id)}/content`)
}

/** §F1 cached JPEG thumbnail; videos sample the frame at ``t`` seconds. */
export function videoAssetThumbnailUrl(id: string, t = 0): string {
  return apiUrl(`${BASE}/assets/${encodeURIComponent(id)}/thumbnail?t=${Math.max(0, t).toFixed(2)}`)
}

export function videoProjectExportUrl(id: string): string {
  return apiUrl(`${BASE}/projects/${encodeURIComponent(id)}/export`)
}

export async function deleteVideoAsset(id: string): Promise<void> {
  await json(await apiFetch(apiUrl(`${BASE}/assets/${encodeURIComponent(id)}`), { method: 'DELETE' }))
}

export async function uploadVideoAsset(
  projectId: string,
  file: File,
  onProgress?: (ratio: number) => void,
  signal?: AbortSignal
): Promise<VideoAsset> {
  const mime = normalizeVideoUploadMime(file.type)
  const sha256 = await hashFileSha256(file, signal, ratio => onProgress?.(ratio * 0.1))
  const init = await json<{
    id?: string
    upload_id?: string
    part_size?: number
    chunk_size?: number
    expires_at?: string | number
  }>(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/uploads`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, mime, size: file.size, sha256 }),
      signal,
    })
  )
  const uploadId = init.id || init.upload_id
  const partSize = init.part_size || init.chunk_size
  if (!uploadId) throw new Error('Upload session returned invalid data')
  let completed = false
  try {
    if (!partSize || !Number.isSafeInteger(partSize) || partSize <= 0) {
      throw new Error('Upload session returned invalid data')
    }
    let uploaded = 0
    for (let offset = 0, index = 0; offset < file.size; offset += partSize, index += 1) {
      if (signal?.aborted) throw new DOMException('Video upload cancelled', 'AbortError')
      const part = file.slice(offset, Math.min(file.size, offset + partSize))
      const response = await apiFetch(
        apiUrl(`${BASE}/uploads/${encodeURIComponent(uploadId)}/parts/${index}`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: part,
          signal,
        }
      )
      if (!response.ok) {
        throw new VideoStudioApiError(`Upload failed (${response.status})`, response.status)
      }
      uploaded += part.size
      onProgress?.(0.1 + (uploaded / Math.max(1, file.size)) * 0.9)
    }
    const asset = await json<VideoAsset>(
      await apiFetch(apiUrl(`${BASE}/uploads/${encodeURIComponent(uploadId)}/complete`), {
        method: 'POST',
        signal,
      })
    )
    completed = true
    return asset
  } finally {
    if (!completed) await discardVideoUploadSession(uploadId)
  }
}

export async function listVideoJobs(
  projectId: string,
  cursor?: string | null,
  signal?: AbortSignal
): Promise<{ jobs: VideoJob[]; next_cursor: string | null }> {
  const search = new URLSearchParams({ limit: '50' })
  if (cursor) search.set('cursor', cursor)
  return json(
    await apiFetch(
      apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/jobs?${search.toString()}`),
      { cache: 'no-store', signal }
    )
  )
}

export async function createVideoJob(
  projectId: string,
  payload: {
    client_request_id: string
    confirmed_cost: true
    profile_id: string
    model_id: string
    operation: VideoOperation
    prompt: string
    input_asset_ids: string[]
    parameters: Record<string, unknown>
    storyboard_shot_id?: string | null
    board_node_id?: string | null
    inputs?: VideoJobInput[]
  }
): Promise<VideoJob> {
  // The server rejects a request that carries both `input_asset_ids` and
  // `inputs`; board submissions send role-tagged `inputs` only.
  const body: Record<string, unknown> = { ...payload }
  if (payload.inputs?.length) {
    body.input_asset_ids = []
    body.inputs = payload.inputs
  } else {
    delete body.inputs
  }
  return json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/jobs`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
}

export async function getVideoJob(id: string, signal?: AbortSignal): Promise<VideoJob> {
  return json(
    await apiFetch(apiUrl(`${BASE}/jobs/${encodeURIComponent(id)}`), {
      cache: 'no-store',
      signal,
    })
  )
}

export async function getVideoJobEvents(
  id: string,
  afterSeq: number,
  signal?: AbortSignal
): Promise<{ events: VideoJobEvent[]; next_seq: number }> {
  const search = new URLSearchParams({ after_seq: String(afterSeq) })
  return json(
    await apiFetch(apiUrl(`${BASE}/jobs/${encodeURIComponent(id)}/events?${search.toString()}`), {
      cache: 'no-store',
      signal,
    })
  )
}

export type VideoJobFollowCursor = { job_id: string; after_seq: number }

export type VideoJobFollowBatch = {
  jobs: Record<string, VideoJob>
  events: Record<string, { events: VideoJobEvent[]; next_seq: number }>
}

/**
 * One batched poll for every active workbench job — snapshots and incremental
 * events ride a single request instead of two per running job.
 */
export async function followVideoJobs(
  projectId: string,
  cursors: VideoJobFollowCursor[],
  signal?: AbortSignal
): Promise<VideoJobFollowBatch> {
  if (!cursors.length) return { jobs: {}, events: {} }
  return json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/jobs:follow`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobs: cursors }),
      cache: 'no-store',
      signal,
    })
  )
}

export async function cancelVideoJob(id: string): Promise<VideoJob | null> {
  const payload = await json<VideoJob | { job?: VideoJob; cancelled?: boolean }>(
    await apiFetch(apiUrl(`${BASE}/jobs/${encodeURIComponent(id)}/cancel`), { method: 'POST' })
  )
  if ('id' in payload) return payload
  return payload.job || null
}

export async function retryVideoJob(
  id: string,
  payload: {
    client_request_id: string
    confirmed_cost: true
    storyboard_shot_id?: string | null
  }
): Promise<VideoJob> {
  return json(
    await apiFetch(apiUrl(`${BASE}/jobs/${encodeURIComponent(id)}/retry`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  )
}

/** §Phase C5: read-only variant history of one storyboard shot, newest first. */
export async function listVideoShotJobs(
  projectId: string,
  shotId: string,
  signal?: AbortSignal
): Promise<{ jobs: VideoJob[] }> {
  return json(
    await apiFetch(
      apiUrl(
        `${BASE}/projects/${encodeURIComponent(projectId)}/storyboard/shots/${encodeURIComponent(shotId)}/jobs`
      ),
      { cache: 'no-store', signal }
    )
  )
}

/**
 * §Phase C5 paid reroll: one new take of an existing job with the same
 * parameters (camera included) and a fresh seed. Every call is one paid
 * task and requires its own `confirmed_cost`.
 */
export async function rerollVideoJob(
  id: string,
  payload: {
    client_request_id: string
    confirmed_cost: true
    storyboard_shot_id?: string | null
    board_node_id?: string | null
  }
): Promise<VideoJob> {
  return json(
    await apiFetch(apiUrl(`${BASE}/jobs/${encodeURIComponent(id)}/reroll`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  )
}

/** §Phase C5 free action: make one historical variant the shot's current take. */
export async function bindVideoShotJob(
  projectId: string,
  shotId: string,
  jobId: string
): Promise<{ shot: VideoStoryboardShot }> {
  return json(
    await apiFetch(
      apiUrl(
        `${BASE}/projects/${encodeURIComponent(projectId)}/storyboard/shots/${encodeURIComponent(shotId)}/bind-job`
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId }),
      }
    )
  )
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Video job follow cancelled', 'AbortError'))
      return
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(new DOMException('Video job follow cancelled', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const FINAL_STATUSES = new Set<VideoJobStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
])

export async function followVideoJob(
  id: string,
  onJob: (job: VideoJob) => void,
  onEvent?: (event: VideoJobEvent) => void,
  afterSeq = 0,
  signal?: AbortSignal,
  onConnectionChange?: (connected: boolean) => void
): Promise<VideoJob> {
  if (signal?.aborted) throw new DOMException('Video job follow cancelled', 'AbortError')
  let seq = afterSeq
  let failures = 0
  for (;;) {
    try {
      const eventPayload = await getVideoJobEvents(id, seq, signal)
      for (const event of eventPayload.events || []) onEvent?.(event)
      seq = Math.max(seq, Number(eventPayload.next_seq) || seq)
      const job = await getVideoJob(id, signal)
      onConnectionChange?.(true)
      failures = 0
      onJob(job)
      if (FINAL_STATUSES.has(job.status)) return job
      await abortableDelay(1200, signal)
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      const retryable =
        !(error instanceof VideoStudioApiError) ||
        error.status === 408 ||
        error.status === 425 ||
        error.status === 429 ||
        error.status >= 500
      if (!retryable) throw error
      onConnectionChange?.(false)
      failures += 1
      // Keep following active paid jobs through transient outages. The delay is
      // exponentially backed off but capped, and AbortSignal still disposes it.
      await abortableDelay(Math.min(12_000, 750 * 2 ** Math.min(failures - 1, 4)), signal)
    }
  }
}
