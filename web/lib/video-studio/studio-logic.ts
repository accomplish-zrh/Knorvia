import {
  type VideoAsset,
  type VideoAudioMode,
  type VideoBoardEdgeRole,
  type VideoCharacter,
  type VideoJob,
  type VideoJobStatus,
  type VideoModelCapabilities,
  type VideoModelOption,
  type VideoOperation,
  type VideoStoryboardDocument,
  type VideoStoryboardShot,
} from '@/lib/video-studio-api'

export const VIDEO_MODEL_STORAGE_KEY = 'knorvia.video-studio.model'
export const VIDEO_OPERATION_STORAGE_KEY = 'knorvia.video-studio.operation'

type SubmissionRequestRef = { current: string | null }

export function invalidateVideoSubmissionRequest(ref: SubmissionRequestRef) {
  ref.current = null
}

export function ensureVideoSubmissionRequest(
  ref: SubmissionRequestRef,
  create: () => string = () => crypto.randomUUID()
) {
  if (!ref.current) ref.current = create()
  return ref.current
}

export function storyboardPatchAffectsSubmission(
  patch: Partial<Omit<VideoStoryboardShot, 'id' | 'order'>>
) {
  return (
    patch.prompt !== undefined ||
    patch.input_asset_ids !== undefined ||
    patch.duration !== undefined ||
      patch.camera !== undefined ||
      patch.director_camera_id !== undefined ||
      patch.director_camera_json !== undefined
  )
}

export function retryStoryboardShot(
  document: VideoStoryboardDocument,
  job: Pick<VideoJob, 'id' | 'storyboard_shot_id'>
) {
  return (
    document.shots.find(shot => shot.job_id === job.id) ||
    (job.storyboard_shot_id
      ? document.shots.find(shot => shot.id === job.storyboard_shot_id)
      : undefined)
  )
}

export type VideoSettings = {
  duration: number | ''
  aspectRatio: string
  resolution: string
  fps: number | ''
  audioMode: VideoAudioMode | ''
  seed: string
  referenceMode: string
  extra: Record<string, unknown>
}

// ── §Phase C4 camera control ────────────────────────────────────────

/**
 * Localized label source per camera enum value (preset vocabulary plus the
 * common motions plan_episode may emit). A `camera*` enum whose values are
 * all listed here renders as chips; anything else keeps the dropdown.
 */
export const CAMERA_VALUE_LABELS: Record<string, string> = {
  none: 'No camera control',
  simple: 'Simple camera control',
  custom: 'Custom camera control',
  fixed: 'Fixed camera',
  static: 'Static camera',
  push: 'Push in',
  pull: 'Pull out',
  pan: 'Pan',
  'pan-left': 'Pan left',
  'pan-right': 'Pan right',
  tilt: 'Tilt',
  'tilt-up': 'Tilt up',
  'tilt-down': 'Tilt down',
  follow: 'Follow',
  orbit: 'Orbit',
  dolly: 'Dolly',
  zoom: 'Zoom',
  'zoom-in': 'Zoom in',
  'zoom-out': 'Zoom out',
  roll: 'Roll',
}

/** Group label for one camera parameter key (i18n source string). */
export function cameraParameterLabel(name: string): string {
  if (name === 'camera_motion') return 'Camera movement'
  if (name === 'camera_control') return 'Camera control'
  return 'Camera'
}

/**
 * C4 chips branch: a `camera*` string-enum parameter renders as a chip group
 * when every enum value has a localized label; unknown vocabulary keeps the
 * original dropdown. Returns the enum values to chip, or null.
 */
export function cameraChipValues(
  schema: { type?: unknown; enum?: unknown } | undefined
): string[] | null {
  if (!schema) return null
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (!types.includes('string')) return null
  const values = Array.isArray(schema.enum)
    ? schema.enum.filter((value): value is string => typeof value === 'string')
    : []
  if (!values.length) return null
  return values.every(value => value in CAMERA_VALUE_LABELS) ? values : null
}

/**
 * Resolve a stored camera motion (board node / storyboard shot) onto the
 * model's own `camera*` enum parameter, so the value submits through the
 * schema-validated parameter channel. Null when the model has no slot for it.
 */
export function cameraParameterForKey(
  capabilities: VideoModelCapabilities | undefined,
  motion: string | undefined | null
): { key: string; value: string } | null {
  const wanted = String(motion || '').trim()
  if (!wanted) return null
  const properties = capabilities?.parameter_schema?.properties || {}
  for (const [name, schema] of Object.entries(properties)) {
    if (!name.startsWith('camera')) continue
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.includes('string')) continue
    if (Array.isArray(schema.enum) && schema.enum.includes(wanted as never)) {
      return { key: name, value: wanted }
    }
  }
  return null
}

export function videoModelKey(model: Pick<VideoModelOption, 'profile_id' | 'model_id'>) {
  return `${model.profile_id}:${model.model_id}`
}

export function preferredVideoModel(
  models: VideoModelOption[],
  stored?: string | null,
  selected?: string | null
) {
  return (
    models.find(model => videoModelKey(model) === stored) ||
    models.find(model => videoModelKey(model) === selected) ||
    models[0]
  )
}

export function advertisedVideoOperations(capabilities?: VideoModelCapabilities): VideoOperation[] {
  if (capabilities && 'operations' in capabilities) return capabilities.operations || []
  return ['text_to_video']
}

function firstAllowed<T>(requested: unknown, allowed: T[], fallback: T | ''): T | '' {
  if (allowed.includes(requested as T)) return requested as T
  if (allowed.includes(fallback as T)) return fallback as T
  return allowed[0] ?? fallback
}

export function settingsForVideoModel(
  model: VideoModelOption,
  previous?: Partial<VideoSettings>
): VideoSettings {
  const capabilities = model.capabilities || {}
  const defaults = model.defaults || {}
  const duration = firstAllowed(
    previous?.duration,
    capabilities.durations || [],
    (defaults.duration as number | undefined) ?? ''
  )
  const aspectRatio = firstAllowed(
    previous?.aspectRatio,
    capabilities.aspect_ratios || [],
    (defaults.aspect_ratio as string | undefined) ?? ''
  )
  const resolution = firstAllowed(
    previous?.resolution,
    capabilities.resolutions || [],
    (defaults.resolution as string | undefined) ?? ''
  )
  const fps = firstAllowed(
    previous?.fps,
    capabilities.fps || [],
    (defaults.fps as number | undefined) ?? ''
  )
  const audioModes = capabilities.audio_modes || []
  const audioMode = firstAllowed(
    previous?.audioMode,
    audioModes,
    audioModes.length ? ((defaults.audio_mode as VideoAudioMode | undefined) ?? audioModes[0]) : ''
  ) as VideoAudioMode | ''
  const referenceModes = capabilities.reference_modes || []
  const referenceMode = firstAllowed(
    previous?.referenceMode,
    referenceModes,
    referenceModes.length ? ((defaults.reference_mode as string | undefined) ?? referenceModes[0]) : ''
  ) as string
  const properties = capabilities.parameter_schema?.properties || {}
  const extra: Record<string, unknown> = {}
  for (const [name, schema] of Object.entries(properties)) {
    if (['duration', 'aspect_ratio', 'resolution', 'fps', 'audio_mode', 'seed'].includes(name)) continue
    const prior = previous?.extra?.[name]
    const candidate = prior ?? defaults[name] ?? schema.default
    if (candidate !== undefined) extra[name] = candidate
  }
  return {
    duration: duration as number | '',
    aspectRatio: aspectRatio as string,
    resolution: resolution as string,
    fps: fps as number | '',
    audioMode,
    seed: capabilities.supports_seed ? String(previous?.seed ?? defaults.seed ?? '') : '',
    referenceMode,
    extra,
  }
}

export function preferredVideoOperation(
  capabilities: VideoModelCapabilities | undefined,
  requested?: string | null
): VideoOperation | '' {
  const operations = advertisedVideoOperations(capabilities)
  return operations.includes(requested as VideoOperation)
    ? (requested as VideoOperation)
    : (operations[0] ?? '')
}

/**
 * §5.6 duration picker shape. A contiguous integer `durations` range renders a
 * continuous slider; a sparse list (e.g. 4/8/12) renders a slider that steps
 * through the advertised presets; a single value (or none) keeps the select.
 * The snapped value always stays inside what `settingsForVideoModel` allows.
 */
export type VideoDurationControl =
  | { kind: 'none' }
  | { kind: 'select'; durations: number[] }
  | { kind: 'range'; min: number; max: number; step: number; value: number }
  | { kind: 'steps'; durations: number[]; index: number }

export function videoDurationControl(
  capabilities: VideoModelCapabilities | undefined,
  current: number | ''
): VideoDurationControl {
  const durations = Array.from(
    new Set(
      (capabilities?.durations || [])
        .map(value => Number(value))
        .filter(value => Number.isFinite(value) && value > 0)
    )
  ).sort((left, right) => left - right)
  if (!durations.length) return { kind: 'none' }
  if (durations.length === 1) return { kind: 'select', durations }
  const contiguous = durations.every(
    (value, index) => index === 0 || value - durations[index - 1] === 1
  )
  const requested = typeof current === 'number' && Number.isFinite(current) ? current : durations[0]
  if (contiguous) {
    const min = durations[0]
    const max = durations[durations.length - 1]
    return {
      kind: 'range',
      min,
      max,
      step: 1,
      value: Math.min(max, Math.max(min, Math.round(requested))),
    }
  }
  let nearest = 0
  for (let index = 1; index < durations.length; index += 1) {
    if (Math.abs(durations[index] - requested) < Math.abs(durations[nearest] - requested)) {
      nearest = index
    }
  }
  return { kind: 'steps', durations, index: nearest }
}

function inputCaps(capabilities?: VideoModelCapabilities) {
  const limits = capabilities?.max_inputs || {}
  const image = Math.max(0, Number(limits.image ?? 0))
  const video = Math.max(0, Number(limits.video ?? 0))
  const audio = Math.max(0, Number(limits.audio ?? 0))
  return {
    image,
    video,
    audio,
    total: Math.max(0, Number(limits.total ?? image + video + audio)),
  }
}

/** §5.6 capacity hint: normalized `max_inputs` for the composer copy. */
export function videoInputLimits(capabilities?: VideoModelCapabilities) {
  return inputCaps(capabilities)
}

export function sanitizeVideoInputs(
  selected: string[],
  assets: VideoAsset[],
  operation: VideoOperation | '',
  capabilities?: VideoModelCapabilities,
  audioMode: VideoAudioMode | '' = 'none'
) {
  const limits = inputCaps(capabilities)
  const counts = { image: 0, video: 0, audio: 0 }
  const maxBytes = Math.max(0, Number(capabilities?.max_input_bytes ?? 0))
  let totalBytes = 0
  const result: string[] = []
  for (const id of selected) {
    const asset = assets.find(item => item.id === id)
    if (!asset || !['image', 'video', 'audio'].includes(asset.kind)) continue
    if (operation === 'text_to_video' && asset.kind !== 'audio') continue
    if (operation === 'image_to_video' && asset.kind !== 'image' && asset.kind !== 'audio') continue
    if ((operation === 'video_to_video' || operation === 'extend') && asset.kind !== 'video' && asset.kind !== 'audio') continue
    if (asset.kind === 'audio' && audioMode !== 'input') continue
    const kind = asset.kind as 'image' | 'video' | 'audio'
    if (counts[kind] >= limits[kind]) continue
    if (result.length >= limits.total) continue
    const assetBytes = Math.max(0, Number(asset.size_bytes) || 0)
    if (maxBytes > 0 && totalBytes + assetBytes > maxBytes) continue
    counts[kind] += 1
    totalBytes += assetBytes
    result.push(id)
  }
  return result
}

export function toggleVideoInput(
  selected: string[],
  asset: VideoAsset,
  assets: VideoAsset[],
  operation: VideoOperation | '',
  capabilities?: VideoModelCapabilities,
  audioMode: VideoAudioMode | '' = 'none'
) {
  const next = selected.includes(asset.id)
    ? selected.filter(id => id !== asset.id)
    : [...selected, asset.id]
  return sanitizeVideoInputs(next, assets, operation, capabilities, audioMode)
}

// ── §Phase B character library helpers ───────────────────────────────

/** Reference asset ids for one character, three-view sheet first, deduped. */
export function characterReferenceAssetIds(
  character: Pick<VideoCharacter, 'three_view_asset_id' | 'reference_asset_ids'>
): string[] {
  const ids: string[] = []
  const threeView = character.three_view_asset_id || ''
  if (threeView) ids.push(threeView)
  for (const id of character.reference_asset_ids || []) {
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * §Phase B2 composer injection: append a character's reference images to the
 * selected inputs. `sanitizeVideoInputs` enforces `max_inputs` for free.
 */
export function appendCharacterToVideoInputs(
  selected: string[],
  character: Pick<VideoCharacter, 'three_view_asset_id' | 'reference_asset_ids'>,
  assets: VideoAsset[],
  operation: VideoOperation | '',
  capabilities?: VideoModelCapabilities,
  audioMode: VideoAudioMode | '' = 'none'
) {
  const merged = [...selected, ...characterReferenceAssetIds(character)]
  return sanitizeVideoInputs(
    Array.from(new Set(merged)),
    assets,
    operation,
    capabilities,
    audioMode
  )
}

export function validateVideoSubmission(input: {
  projectId: string
  model?: VideoModelOption
  operation: VideoOperation | ''
  prompt: string
  selectedInputIds: string[]
  assets: VideoAsset[]
  settings: VideoSettings
  costConfirmed: boolean
}): { ok: boolean; reason?: string } {
  if (!input.projectId) return { ok: false, reason: 'project-required' }
  if (!input.model) return { ok: false, reason: 'model-required' }
  if (!input.operation) return { ok: false, reason: 'operation-required' }
  if (!advertisedVideoOperations(input.model.capabilities).includes(input.operation)) {
    return { ok: false, reason: 'operation-unsupported' }
  }
  const prompt = input.prompt.trim()
  if (!prompt) return { ok: false, reason: 'prompt-required' }
  const maxPrompt = Number(input.model.capabilities.max_prompt_length || 0)
  if (maxPrompt > 0 && prompt.length > maxPrompt) return { ok: false, reason: 'prompt-too-long' }
  const selectedAssetsBeforeSanitizing = input.selectedInputIds
    .map(id => input.assets.find(asset => asset.id === id))
    .filter((asset): asset is VideoAsset => Boolean(asset))
  const maxInputBytes = Math.max(0, Number(input.model.capabilities.max_input_bytes || 0))
  if (
    maxInputBytes > 0 &&
    selectedAssetsBeforeSanitizing.reduce(
      (total, asset) => total + Math.max(0, Number(asset.size_bytes) || 0),
      0
    ) > maxInputBytes
  ) {
    return { ok: false, reason: 'inputs-too-large' }
  }
  const selected = sanitizeVideoInputs(
    input.selectedInputIds,
    input.assets,
    input.operation,
    input.model.capabilities,
    input.settings.audioMode
  )
  if (selected.length !== input.selectedInputIds.length) {
    return { ok: false, reason: 'invalid-inputs' }
  }
  const selectedAssets = selected
    .map(id => input.assets.find(asset => asset.id === id))
    .filter((asset): asset is VideoAsset => Boolean(asset))
  if (input.operation === 'image_to_video' && !selectedAssets.some(asset => asset.kind === 'image')) {
    return { ok: false, reason: 'image-required' }
  }
  if (
    (input.operation === 'video_to_video' || input.operation === 'extend' || input.operation === 'remix') &&
    !selectedAssets.some(asset => asset.kind === 'video')
  ) {
    return { ok: false, reason: 'video-required' }
  }
  if (
    input.operation === 'edit' &&
    !selectedAssets.some(asset => asset.kind === 'image' || asset.kind === 'video')
  ) {
    return { ok: false, reason: 'reference-required' }
  }
  if (input.settings.audioMode === 'input' && !selectedAssets.some(asset => asset.kind === 'audio')) {
    return { ok: false, reason: 'audio-required' }
  }
  if (!input.costConfirmed) return { ok: false, reason: 'cost-confirmation-required' }
  return { ok: true }
}

function safeExtraParameters(model: VideoModelOption, extra: Record<string, unknown>) {
  const properties = model.capabilities.parameter_schema?.properties || {}
  const result: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(extra)) {
    const schema = properties[name]
    if (!schema || value === '' || value == null) continue
    if (schema.enum && !schema.enum.includes(value as never)) continue
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
    const typeAccepted = !types.length || types.some(type => {
      if (type === 'boolean') return typeof value === 'boolean'
      if (type === 'string') return typeof value === 'string'
      if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
      if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value)
      return value == null
    })
    if (!typeAccepted) continue
    if (typeof value === 'string' && schema.maxLength != null && value.length > schema.maxLength) continue
    if (typeof value === 'number') {
      if (schema.minimum != null && value < schema.minimum) continue
      if (schema.maximum != null && value > schema.maximum) continue
    }
    result[name] = value
  }
  return result
}

export function buildVideoJobPayload(input: {
  model: VideoModelOption
  operation: VideoOperation
  prompt: string
  selectedInputIds: string[]
  settings: VideoSettings
  clientRequestId: string
  storyboardShotId?: string | null
  /** Canvas submissions target a generate node and send role-tagged inputs. */
  boardNodeId?: string | null
  inputs?: Array<{ asset_id: string; role: VideoBoardEdgeRole }>
}) {
  const { model, settings } = input
  const parameters: Record<string, unknown> = safeExtraParameters(model, settings.extra)
  if (settings.duration !== '') parameters.duration = settings.duration
  if (settings.aspectRatio) parameters.aspect_ratio = settings.aspectRatio
  if (settings.resolution) parameters.resolution = settings.resolution
  if (settings.fps !== '') parameters.fps = settings.fps
  if (settings.audioMode) parameters.audio_mode = settings.audioMode
  if (settings.referenceMode) parameters.reference_mode = settings.referenceMode
  if (model.capabilities.supports_seed && settings.seed.trim()) {
    const seed = Number(settings.seed)
    if (Number.isSafeInteger(seed) && seed >= 0) parameters.seed = seed
  }
  const roleTaggedInputs = input.inputs?.length ? input.inputs : undefined
  return {
    client_request_id: input.clientRequestId,
    confirmed_cost: true as const,
    profile_id: model.profile_id,
    model_id: model.model_id,
    operation: input.operation,
    prompt: input.prompt.trim(),
    // The server rejects a body carrying both forms; role-tagged inputs win.
    input_asset_ids: roleTaggedInputs ? [] : [...input.selectedInputIds],
    ...(roleTaggedInputs ? { inputs: roleTaggedInputs } : {}),
    parameters,
    storyboard_shot_id: input.storyboardShotId || null,
    board_node_id: input.boardNodeId || null,
  }
}

export function isVideoJobFinal(status: VideoJobStatus | string) {
  return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)
}

export function normalizedJobProgress(job: Pick<VideoJob, 'status' | 'progress'>) {
  if (job.status === 'succeeded') return 100
  const value = Number(job.progress)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value <= 1 ? value * 100 : value))
}

export function jobErrorMessage(
  job: Pick<VideoJob, 'error' | 'error_code' | 'error_message'>
) {
  if (job.error) {
    return typeof job.error === 'string' ? job.error : job.error.message || job.error.code || ''
  }
  return job.error_message || job.error_code || ''
}

/**
 * §Phase 5 chat error taxonomy. The raw provider message is often an HTTP
 * transcript; the chat card needs a friendly, translated category line while
 * the studio queue keeps showing the verbatim detail.
 */
export type VideoJobErrorCategory = 'timeout' | 'rate-limit' | 'invalid-material' | 'other'

const VIDEO_TIMEOUT_ERROR = /provider_timeout|submission_interrupted|timeout|timed?[ -]?out|took too long|exceeded the (configured )?time limit|超时/i
const VIDEO_RATE_LIMIT_ERROR = /\b429\b|http\s*429|rate[ -]?limit|too many requests|请求过于频繁|频率限制|限流/i
const VIDEO_INVALID_MATERIAL_ERROR =
  /\bhttp\s*400\b|bad request|invalid (image|video|audio|media|material|reference|format)|unsupported (image|video|audio|media|material|reference|format)|cannot send a|素材|不支持的(格式|类型|素材)|(图片|视频|音频)(格式|文件)?(无效|不支持)/i

export function classifyVideoJobError(
  job: Pick<VideoJob, 'error' | 'error_code' | 'error_message'>
): VideoJobErrorCategory {
  const detail = jobErrorMessage(job)
  const structured = typeof job.error === 'object' && job.error ? job.error.code || '' : ''
  const code = `${job.error_code || ''} ${structured}`.trim()
  // A submit that never completed (lost response / stalled provider) reads as
  // a timeout to the user, whatever the underlying transport said.
  if (/provider_timeout|submission_interrupted/.test(code)) return 'timeout'
  const haystack = `${code} ${detail}`
  if (VIDEO_RATE_LIMIT_ERROR.test(haystack)) return 'rate-limit'
  if (VIDEO_TIMEOUT_ERROR.test(haystack)) return 'timeout'
  if (VIDEO_INVALID_MATERIAL_ERROR.test(haystack)) return 'invalid-material'
  return 'other'
}

/** i18n source key per category; `''` for `other` (fall back to raw detail). */
export function videoJobErrorLabelKey(category: VideoJobErrorCategory): string {
  if (category === 'timeout') return 'The video task timed out or stalled before finishing. You can retry it.'
  if (category === 'rate-limit') return 'The video provider is rate limiting requests. Wait a moment and try again.'
  if (category === 'invalid-material') return 'The provider rejected the reference material. Check its format, size, and duration.'
  return ''
}

export function formatVideoDuration(seconds?: number | null) {
  if (!Number.isFinite(Number(seconds))) return '—'
  const value = Math.max(0, Number(seconds))
  const minutes = Math.floor(value / 60)
  const rest = Math.round(value % 60)
  return minutes ? `${minutes}:${String(rest).padStart(2, '0')}` : `${rest}s`
}

export function storyboardJobs(jobs: VideoJob[]) {
  return [...jobs]
    .filter(job => job.status !== 'failed' || job.output_asset_ids.length)
    .sort((left, right) => Number(new Date(left.created_at)) - Number(new Date(right.created_at)))
}

// ── §E1/E3/E4 post-production helpers (parity with post_production.py) ──

export const SHOT_TRANSITION_OPTIONS = ['crossfade', 'fade-black', 'fade-white', 'wipe-left'] as const

export type ShotTransitionSelectValue = '' | (typeof SHOT_TRANSITION_OPTIONS)[number] | '__custom'

/** Stored transition → select value; free text (pre-E1 labels) maps to custom. */
export function transitionSelectValue(raw?: string | null): ShotTransitionSelectValue {
  const text = (raw || '').trim()
  if (!text || text.toLowerCase() === 'none') return ''
  if ((SHOT_TRANSITION_OPTIONS as readonly string[]).includes(text.toLowerCase())) {
    return text.toLowerCase() as ShotTransitionSelectValue
  }
  return '__custom'
}

/** A trimmed shot contributes trim_in→trim_out (default 0→duration). */
export function effectiveShotSeconds(shot: {
  duration?: number | null
  trim_in?: number | null
  trim_out?: number | null
}): number | null {
  if (shot.duration == null || !Number.isFinite(shot.duration) || shot.duration <= 0) return null
  const start = shot.trim_in ?? 0
  const end = shot.trim_out ?? shot.duration
  return Math.max(0, Math.min(end, shot.duration) - start)
}

/** 0 ≤ in < out ≤ duration; returns an i18n error key or null when usable. */
export function trimWindowError(
  trimIn: number | null,
  trimOut: number | null,
  duration: number | null
): 'Trim start must be before trim end.' | 'Trim window must stay inside the shot.' | null {
  if (trimIn != null && trimOut != null && !(trimIn < trimOut)) return 'Trim start must be before trim end.'
  if (duration == null || !Number.isFinite(duration)) return null
  if (trimIn != null && trimIn >= duration) return 'Trim window must stay inside the shot.'
  if (trimOut != null && trimOut > duration) return 'Trim window must stay inside the shot.'
  return null
}

/** Parses a trim input box; empty string → null (unset). */
export function parseTrimInput(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0 || value > 3600) return Number.NaN
  return Math.round(value * 1000) / 1000
}

export const VOICEOVER_VOLUME_MAX = 2

export function parseVolumeInput(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0 || value > VOICEOVER_VOLUME_MAX) return Number.NaN
  return Math.round(value * 100) / 100
}

export function emptyVideoStoryboard(): VideoStoryboardDocument {
  return { version: 1, revision: 0, shots: [] }
}

export function normalizeVideoStoryboard(value: unknown): VideoStoryboardDocument {
  if (!value || typeof value !== 'object') return emptyVideoStoryboard()
  const record = value as Partial<VideoStoryboardDocument>
  const revision = Number(record.revision)
  const shots = Array.isArray(record.shots)
    ? record.shots
        .filter((shot): shot is VideoStoryboardShot => Boolean(shot && typeof shot.id === 'string'))
        .map((shot, index) => ({
          id: shot.id,
          order: Number.isFinite(Number(shot.order)) ? Number(shot.order) : index,
          title: typeof shot.title === 'string' ? shot.title : '',
          prompt: typeof shot.prompt === 'string' ? shot.prompt : '',
          input_asset_ids: Array.isArray(shot.input_asset_ids)
            ? shot.input_asset_ids.filter(id => typeof id === 'string')
            : [],
          job_id: typeof shot.job_id === 'string' ? shot.job_id : null,
          output_asset_id: typeof shot.output_asset_id === 'string' ? shot.output_asset_id : null,
          duration:
            shot.duration == null || !Number.isFinite(Number(shot.duration)) || Number(shot.duration) <= 0
              ? null
              : Number(shot.duration),
          notes: typeof shot.notes === 'string' ? shot.notes : null,
          transition: typeof shot.transition === 'string' ? shot.transition : null,
          trim_in:
            typeof shot.trim_in === 'number' && Number.isFinite(shot.trim_in) && shot.trim_in >= 0
              ? shot.trim_in
              : null,
          trim_out:
            typeof shot.trim_out === 'number' && Number.isFinite(shot.trim_out) && shot.trim_out >= 0
              ? shot.trim_out
              : null,
          voiceover_volume:
            typeof shot.voiceover_volume === 'number' &&
            Number.isFinite(shot.voiceover_volume) &&
            shot.voiceover_volume >= 0 &&
            shot.voiceover_volume <= 2
              ? shot.voiceover_volume
              : null,
          camera:
            typeof shot.camera === 'string' && shot.camera.trim()
              ? shot.camera.trim().slice(0, 64)
              : null,
            director_camera_id:
              typeof shot.director_camera_id === 'string' && shot.director_camera_id.trim()
                ? shot.director_camera_id.trim().slice(0, 128)
                : null,
            director_camera_json:
              shot.director_camera_json && typeof shot.director_camera_json === 'object'
                ? shot.director_camera_json
                : null,
          keyframe_asset_id: typeof shot.keyframe_asset_id === 'string' ? shot.keyframe_asset_id : null,
          keyframe_prompt: typeof shot.keyframe_prompt === 'string' ? shot.keyframe_prompt : null,
          voiceover_text: typeof shot.voiceover_text === 'string' ? shot.voiceover_text : null,
          voiceover_asset_id: typeof shot.voiceover_asset_id === 'string' ? shot.voiceover_asset_id : null,
          voiceover_voice: typeof shot.voiceover_voice === 'string' ? shot.voiceover_voice : null,
          character_ids: Array.isArray(shot.character_ids)
            ? shot.character_ids.filter((id): id is string => typeof id === 'string' && Boolean(id))
            : [],
        }))
        .sort((left, right) => left.order - right.order)
        .map((shot, index) => ({ ...shot, order: index }))
    : []
  return {
    version: 1,
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    shots,
    updated_at: record.updated_at ?? null,
  }
}

export function addStoryboardShot(
  document: VideoStoryboardDocument,
  shot: Omit<VideoStoryboardShot, 'id' | 'order'> & { id?: string }
): VideoStoryboardDocument {
  return normalizeVideoStoryboard({
    ...document,
    shots: [
      ...document.shots,
      { ...shot, id: shot.id || crypto.randomUUID(), order: document.shots.length },
    ],
  })
}

export function reorderStoryboardShots(
  document: VideoStoryboardDocument,
  from: number,
  to: number
): VideoStoryboardDocument {
  if (from === to || from < 0 || to < 0 || from >= document.shots.length || to >= document.shots.length) {
    return document
  }
  const shots = [...document.shots]
  const [moved] = shots.splice(from, 1)
  shots.splice(to, 0, moved)
  return { ...document, shots: shots.map((shot, index) => ({ ...shot, order: index })) }
}

export function patchStoryboardShot(
  document: VideoStoryboardDocument,
  id: string,
  patch: Partial<Omit<VideoStoryboardShot, 'id' | 'order'>>
): VideoStoryboardDocument {
  return {
    ...document,
    shots: document.shots.map(shot => (shot.id === id ? { ...shot, ...patch } : shot)),
  }
}

export function bindJobToStoryboardShot(
  document: VideoStoryboardDocument,
  shotId: string,
  job: Pick<VideoJob, 'id' | 'prompt' | 'input_asset_ids' | 'output_asset_ids' | 'parameters'>
): VideoStoryboardDocument {
  if (!document.shots.some(shot => shot.id === shotId)) return document
  return patchStoryboardShot(document, shotId, {
    prompt: job.prompt,
    input_asset_ids: [...job.input_asset_ids],
    job_id: job.id,
    output_asset_id: job.output_asset_ids[0] || null,
    duration: Number(job.parameters.duration) > 0 ? Number(job.parameters.duration) : null,
  })
}

// ── §Phase C5 variants / reroll ─────────────────────────────────────

/** Variant history rows for one shot, newest first (id DESC breaks ties). */
export function sortVideoVariantJobs<T extends Pick<VideoJob, 'id' | 'created_at'>>(jobs: T[]): T[] {
  return [...jobs].sort((left, right) => {
    const leftTime = Number(new Date(left.created_at)) || 0
    const rightTime = Number(new Date(right.created_at)) || 0
    if (leftTime !== rightTime) return rightTime - leftTime
    return left.id < right.id ? 1 : left.id > right.id ? -1 : 0
  })
}

/** Seed badge for a variant row; models without a seed show a dash. */
export function variantJobSeedLabel(job: Pick<VideoJob, 'parameters'>): string {
  const seed = (job.parameters || {}).seed
  return typeof seed === 'number' && Number.isFinite(seed) ? String(Math.trunc(seed)) : '—'
}

/** Lightweight §Phase C5 board badge: how many takes this canvas card has run. */
export function boardNodeVariantCount(
  jobs: Pick<VideoJob, 'board_node_id'>[],
  nodeId: string
): number {
  return jobs.reduce((count, job) => (job.board_node_id === nodeId ? count + 1 : count), 0)
}

export type ArmedPaidAction = { id: string; key: string }

/**
 * §Phase C5 two-step paid-action guard (pure core of `useArmedPaidAction`):
 * the first click arms the button, the second click on the *same* id under
 * the *same* key fires the paid call. A stale armed record can never
 * authorize different work — the key pins the shot/job/node the arming
 * happened under, and a re-click under a changed key just disarms.
 */
export function nextArmedPaidAction(
  state: ArmedPaidAction | null,
  id: string,
  key: string
): { fires: boolean; next: ArmedPaidAction | null } {
  if (state && state.id === id) return { fires: state.key === key, next: null }
  return { fires: false, next: { id, key } }
}

// ── §Phase F5 price hints (display-only cost awareness) ────────────

/** Per-model unit prices live client-side: no wallet, no billing, display only. */
export const VIDEO_PRICE_HINTS_STORAGE_KEY = 'knorvia.video-studio.price-hints'
export const PRICE_HINT_MAX = 1000

/** §F5: accept a user-entered ¥/second; reject zero/negative/huge junk. */
export function parsePriceHint(raw: number | string): number | null {
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(value) || value <= 0 || value > PRICE_HINT_MAX) return null
  return Math.round(value * 10_000) / 10_000
}

/** §F5: ¥ hint × requested seconds — null when either side is unusable. */
export function estimateVideoCostYuan(
  priceHint: number | null | undefined,
  seconds: number | null | undefined
): number | null {
  if (priceHint == null || seconds == null || !(seconds > 0)) return null
  return Math.round(priceHint * seconds * 100) / 100
}

export function formatYuan(value: number): string {
  return `¥${value.toFixed(2)}`
}

export function loadVideoPriceHints(): Record<string, number> {
  if (typeof window === 'undefined') return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VIDEO_PRICE_HINTS_STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const hints: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const hint = parsePriceHint(value as number | string)
      if (hint !== null) hints[key] = hint
    }
    return hints
  } catch {
    return {}
  }
}

/** Persist one hint (null clears it) and return the next full map. */
export function saveVideoPriceHint(
  hints: Record<string, number>,
  modelKey: string,
  value: number | null
): Record<string, number> {
  const next = { ...hints }
  if (value === null) delete next[modelKey]
  else next[modelKey] = value
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(VIDEO_PRICE_HINTS_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // storage full/blocked — the in-memory map still drives this session
    }
  }
  return next
}

/** §F5: the seconds a job billed for (the requested duration parameter). */
export function jobBilledSeconds(job: Pick<VideoJob, 'parameters'>): number | null {
  const duration = (job.parameters || {}).duration
  const value = typeof duration === 'number' ? duration : Number(duration)
  return Number.isFinite(value) && value > 0 ? value : null
}

// ── §Phase F2 variant drawer details ───────────────────────────────

/** Wall-clock render seconds for a finished job; null while still running. */
export function variantRenderSeconds(
  job: Pick<VideoJob, 'created_at' | 'finished_at'>
): number | null {
  if (job.finished_at == null) return null
  const seconds = (Number(job.finished_at) - Number(job.created_at)) / 1000
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 10) / 10 : null
}

export type VariantParameterDiff = { key: string; current: string; other: string }

const DIFF_VALUE_STRINGIFY = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)

/**
 * §F2: parameter keys where a historical take differs from the current one —
 * seed included, since a reroll's only change is the seed. Only keys present
 * on either side are compared; equal values stay hidden.
 */
export function variantParameterDiff(
  current: Pick<VideoJob, 'parameters'> | null | undefined,
  other: Pick<VideoJob, 'parameters'>
): VariantParameterDiff[] {
  const left = (current?.parameters || {}) as Record<string, unknown>
  const right = (other.parameters || {}) as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  const diffs: VariantParameterDiff[] = []
  for (const key of keys) {
    const a = DIFF_VALUE_STRINGIFY(key in left ? left[key] : null)
    const b = DIFF_VALUE_STRINGIFY(key in right ? right[key] : null)
    if (a !== b) diffs.push({ key, current: a, other: b })
  }
  return diffs.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
}
