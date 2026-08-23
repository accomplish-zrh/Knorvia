/**
 * Pure Image Studio workbench helpers.
 * UI modes, field visibility, job payloads, and tool availability live here
 * so Node tests can drive the same functions the page uses.
 */

export const STUDIO_UI_MODES = ['create', 'edit', 'canvas', 'enhance'] as const
export type StudioUiMode = (typeof STUDIO_UI_MODES)[number]

export const STUDIO_DENSITIES = ['simple', 'pro'] as const
export type StudioDensity = (typeof STUDIO_DENSITIES)[number]

export const STUDIO_DENSITY_STORAGE_KEY = 'image_studio_density'
export const STUDIO_MODEL_STORAGE_KEY = 'image_studio_model_key'

export type StudioModelIdentity = {
  profile_id: string
  model_id: string
  is_active_default?: boolean
}

export function studioModelKey(model: StudioModelIdentity): string {
  return `${model.profile_id}:${model.model_id}`
}

export function preferredStudioModel<T extends StudioModelIdentity>(
  models: T[],
  storedKey?: string | null
): T | undefined {
  return (
    models.find(model => studioModelKey(model) === storedKey) ||
    models.find(model => model.is_active_default) ||
    models[0]
  )
}

export const REFERENCE_ROLES = [
  'subject',
  'style',
  'composition',
  'color',
  'edit',
  'mask',
] as const
export type ReferenceRole = (typeof REFERENCE_ROLES)[number]

export const CANVAS_TOOLS = [
  'select',
  'move',
  'brush',
  'eraser',
  'inpaint',
  'outpaint',
  'erase',
  'undo',
  'redo',
  'zoom',
  'fit',
] as const
export type CanvasTool = (typeof CANVAS_TOOLS)[number]

export type BackendOperation = 'generate' | 'edit' | 'inpaint'

export type GenerateButtonState = 'idle' | 'queued' | 'generating' | 'failed'

export type StudioJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | string

/** Parameters the Image Studio job API already accepts. */
export const STUDIO_BACKEND_PARAMETERS = [
  'n',
  'size',
  'quality',
  'style',
  'output_format',
  'aspect_ratio',
  'image_size',
  'background',
  'compression',
  'target_resolution',
  'upscale_model',
] as const

export type StudioBackendParameter = (typeof STUDIO_BACKEND_PARAMETERS)[number]

/** Always valid studio-level post-processing keys (not provider-specific). */
export const STUDIO_LEVEL_PARAMETERS = ['target_resolution', 'upscale_model'] as const

export const RESOLUTION_PRESETS = ['native', '1K', '2K', '4K'] as const
export type ResolutionPreset = (typeof RESOLUTION_PRESETS)[number]

export const ASPECT_PRESETS = [
  '1:1',
  '3:2',
  '2:3',
  '4:3',
  '3:4',
  '16:9',
  '9:16',
  '21:9',
  '4:5',
  '5:4',
] as const

export const SIMPLE_PROMPT_FIELDS = [
  'prompt',
  'references',
  'aspect_ratio',
  'resolution',
  'generate',
] as const

export const PRO_PROMPT_FIELDS = [
  ...SIMPLE_PROMPT_FIELDS,
  'service_model',
  'negative_prompt',
  'style',
  'count',
  'background',
  'output_format',
  'reference_strength',
  'upscale_model',
  'call_facts',
] as const

export type PromptField = (typeof PRO_PROMPT_FIELDS)[number]

export type StudioReference = {
  assetId: string
  role: ReferenceRole
}

export type StudioModelCapabilities = {
  operations?: BackendOperation[]
  max_inputs?: number
  max_outputs?: number
  supports_mask?: boolean
  parameters?: string[]
}

export type BuildJobInput = {
  uiMode: StudioUiMode
  prompt: string
  references: StudioReference[]
  selectedAssetId?: string | null
  parentJobId?: string | null
  profileId: string
  modelId: string
  capabilities: StudioModelCapabilities
  density: StudioDensity
  aspectRatio?: string
  resolution?: ResolutionPreset | ''
  count?: number
  size?: string
  quality?: string
  style?: string
  outputFormat?: string
  background?: string
  compression?: string | number
  upscaleModel?: 'general' | 'illustration'
  /** Never sent unless advertised by the model and listed in the backend allow-list. */
  negativePrompt?: string
  referenceStrength?: number
}

export type StudioJobPayload = {
  operation: BackendOperation
  image_profile_id: string
  model_id: string
  prompt: string
  input_asset_ids: string[]
  mask_asset_id?: string | null
  parent_job_id?: string | null
  parameters: Record<string, unknown>
}

export type ToolAvailability = {
  available: boolean
  reason?: 'needs-selection' | 'needs-mask' | 'unsupported-backend' | 'needs-inpaint'
}

export type GenerateButtonAppearance = {
  state: GenerateButtonState
  disabled: boolean
  labelKey: string
}

const BACKEND_PARAMETER_SET = new Set<string>(STUDIO_BACKEND_PARAMETERS)

export function parseStudioDensity(value: unknown): StudioDensity {
  return value === 'pro' ? 'pro' : 'simple'
}

export function isStudioUiMode(value: unknown): value is StudioUiMode {
  return STUDIO_UI_MODES.includes(value as StudioUiMode)
}

export function isReferenceRole(value: unknown): value is ReferenceRole {
  return REFERENCE_ROLES.includes(value as ReferenceRole)
}

export function defaultRoleForMode(mode: StudioUiMode): ReferenceRole {
  if (mode === 'edit' || mode === 'enhance') return 'edit'
  if (mode === 'canvas') return 'edit'
  return 'subject'
}

export function advertisedParameters(capabilities?: StudioModelCapabilities | null): string[] {
  return Array.isArray(capabilities?.parameters)
    ? [...capabilities.parameters]
    : ['n', 'size', 'quality', 'style', 'output_format']
}

export function advertisedOperations(
  capabilities?: StudioModelCapabilities | null
): BackendOperation[] {
  const operations = Array.isArray(capabilities?.operations)
    ? capabilities.operations
    : ['generate']
  return operations.filter(
    (item): item is BackendOperation =>
      item === 'generate' || item === 'edit' || item === 'inpaint'
  )
}

export function allowedJobParameters(capabilities?: StudioModelCapabilities | null): Set<string> {
  const allowed = new Set<string>(STUDIO_LEVEL_PARAMETERS)
  for (const name of advertisedParameters(capabilities)) {
    if (BACKEND_PARAMETER_SET.has(name)) allowed.add(name)
  }
  return allowed
}

export function visiblePromptFields(
  density: StudioDensity,
  capabilities?: StudioModelCapabilities | null
): PromptField[] {
  if (density === 'simple') return [...SIMPLE_PROMPT_FIELDS]
  const advertised = new Set(advertisedParameters(capabilities))
  const allowed = allowedJobParameters(capabilities)
  return PRO_PROMPT_FIELDS.filter(field => {
    if ((SIMPLE_PROMPT_FIELDS as readonly string[]).includes(field)) return true
    if (field === 'service_model' || field === 'call_facts') return true
    if (field === 'count') return advertised.has('n')
    if (field === 'style') return advertised.has('style')
    if (field === 'background') return advertised.has('background')
    if (field === 'output_format')
      return advertised.has('output_format') || advertised.has('compression')
    if (field === 'upscale_model') return true
    if (field === 'negative_prompt')
      return advertised.has('negative_prompt') && allowed.has('negative_prompt')
    if (field === 'reference_strength')
      return advertised.has('reference_strength') && allowed.has('reference_strength')
    return false
  })
}

export function fieldIsVisible(
  field: PromptField,
  density: StudioDensity,
  capabilities?: StudioModelCapabilities | null
): boolean {
  return visiblePromptFields(density, capabilities).includes(field)
}

export function shouldShowFirstVisitEmpty(hasResults: boolean): boolean {
  return !hasResults
}

export type StudioHeaderStatus = 'hidden' | 'unconfigured' | 'busy'

/** Header chip: only surface problems or live work — never a idle Ready badge. */
export function studioHeaderStatus(input: {
  loading?: boolean
  hasModel: boolean
  runningCount: number
}): StudioHeaderStatus {
  if (input.runningCount > 0) return 'busy'
  if (input.loading) return 'hidden'
  if (!input.hasModel) return 'unconfigured'
  return 'hidden'
}

export function generateButtonState(
  currentJobStatus?: StudioJobStatus | null,
  lastError?: string | null
): GenerateButtonState {
  if (currentJobStatus === 'queued') return 'queued'
  if (currentJobStatus === 'running') return 'generating'
  if (currentJobStatus === 'failed' || (lastError && !currentJobStatus)) return 'failed'
  return 'idle'
}

export function generateButtonAppearance(input: {
  status?: StudioJobStatus | null
  lastError?: string | null
  hasModel: boolean
  hasPrompt: boolean
  canSubmit: boolean
  submitting?: boolean
}): GenerateButtonAppearance {
  const liveStatus = input.submitting
    ? input.status === 'queued'
      ? 'queued'
      : input.status === 'failed'
        ? 'failed'
        : 'running'
    : input.status
  const state = generateButtonState(liveStatus, input.lastError)
  const labelKey =
    state === 'queued'
      ? 'Queued'
      : state === 'generating'
        ? 'Creating'
        : state === 'failed'
          ? 'Retry generation'
          : 'Start creating'
  return {
    state,
    disabled: !input.hasModel || !input.hasPrompt || !input.canSubmit || state === 'generating' || state === 'queued',
    labelKey,
  }
}

export function resolveBackendOperation(input: {
  uiMode: StudioUiMode
  references: StudioReference[]
  capabilities?: StudioModelCapabilities | null
}): BackendOperation {
  const operations = advertisedOperations(input.capabilities)
  const hasMask = input.references.some(item => item.role === 'mask')
  const imageRefs = input.references.filter(item => item.role !== 'mask')

  // A painted/uploaded mask is local redraw. Prefer inpaint in every UI mode
  // whenever the model advertises it — including 编辑 / 增强 + MaskEditor.
  if (hasMask && operations.includes('inpaint')) return 'inpaint'

  if (input.uiMode === 'canvas') {
    if (imageRefs.length && operations.includes('edit')) return 'edit'
    return operations.includes('generate') ? 'generate' : operations[0] || 'generate'
  }

  if (input.uiMode === 'edit' || input.uiMode === 'enhance') {
    if (operations.includes('edit')) return 'edit'
  }

  if (imageRefs.length && operations.includes('edit')) return 'edit'

  return operations.includes('generate') ? 'generate' : operations[0] || 'generate'
}

/** Pointer-up must read the painted ref, not React `hasMask` (first stroke is stale). */
export function shouldExportPaintedMask(painted: boolean): boolean {
  return painted
}

/** Prefer the File passed into generate over a held ref; never wait for setState. */
export function takeMaskFile<T>(explicit?: T | null, held?: T | null): T | null {
  return explicit ?? held ?? null
}

export function collectInputAssetIds(references: StudioReference[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const item of references) {
    if (item.role === 'mask') continue
    if (seen.has(item.assetId)) continue
    seen.add(item.assetId)
    ids.push(item.assetId)
  }
  return ids
}

export function collectMaskAssetId(references: StudioReference[]): string | null {
  return references.find(item => item.role === 'mask')?.assetId || null
}

export function assignReferenceRole(
  references: StudioReference[],
  assetId: string,
  role: ReferenceRole
): StudioReference[] {
  if (!isReferenceRole(role)) return references
  return references.map(item => (item.assetId === assetId ? { ...item, role } : item))
}

export function addReference(
  references: StudioReference[],
  assetId: string,
  role: ReferenceRole,
  maxInputs: number
): StudioReference[] {
  if (!assetId) return references
  const existing = references.find(item => item.assetId === assetId)
  if (existing) return assignReferenceRole(references, assetId, role)
  const nonMask = references.filter(item => item.role !== 'mask')
  if (role !== 'mask' && nonMask.length >= Math.max(0, maxInputs)) return references
  if (role === 'mask') {
    const withoutMask = references.filter(item => item.role !== 'mask')
    return [...withoutMask, { assetId, role }]
  }
  return [...references, { assetId, role }]
}

export function removeReference(references: StudioReference[], assetId: string): StudioReference[] {
  return references.filter(item => item.assetId !== assetId)
}

export function canvasToolAvailability(
  tool: CanvasTool,
  input: {
    operations: BackendOperation[]
    hasSelection: boolean
    hasMask: boolean
  }
): ToolAvailability {
  if (tool === 'outpaint' || tool === 'erase') {
    return { available: false, reason: 'unsupported-backend' }
  }
  if (tool === 'inpaint') {
    if (!input.operations.includes('inpaint')) {
      return { available: false, reason: 'needs-inpaint' }
    }
    if (!input.hasSelection) return { available: false, reason: 'needs-selection' }
    if (!input.hasMask) return { available: false, reason: 'needs-mask' }
    return { available: true }
  }
  if ((tool === 'brush' || tool === 'eraser') && !input.hasSelection) {
    return { available: false, reason: 'needs-selection' }
  }
  if ((tool === 'undo' || tool === 'redo') && !input.hasSelection) {
    return { available: false, reason: 'needs-selection' }
  }
  return { available: true }
}

export function modeRequiresSelection(mode: StudioUiMode): boolean {
  return mode === 'edit' || mode === 'enhance'
}

export function canSubmitStudioJob(input: {
  uiMode: StudioUiMode
  prompt: string
  references: StudioReference[]
  selectedAssetId?: string | null
  capabilities?: StudioModelCapabilities | null
}): { ok: boolean; reason?: string } {
  if (!input.prompt.trim()) return { ok: false, reason: 'prompt' }
  const operations = advertisedOperations(input.capabilities)
  const operation = resolveBackendOperation(input)
  if (!operations.includes(operation)) return { ok: false, reason: 'operation' }

  const inputs = collectInputAssetIds(input.references)
  const maskId = collectMaskAssetId(input.references)
  const selected = input.selectedAssetId || null
  const maxInputs = Math.max(0, Number(input.capabilities?.max_inputs ?? 4) || 0)

  if (operation === 'generate' && (inputs.length > 0 || maskId)) {
    return { ok: false, reason: 'generate-rejects-inputs' }
  }
  if (operation !== 'generate' && inputs.length === 0 && !selected) {
    return { ok: false, reason: 'needs-image' }
  }
  if (inputs.length > maxInputs) return { ok: false, reason: 'too-many-inputs' }
  if (operation === 'inpaint' && !maskId) return { ok: false, reason: 'needs-mask' }
  if (modeRequiresSelection(input.uiMode) && !selected && inputs.length === 0) {
    return { ok: false, reason: 'needs-selection' }
  }
  return { ok: true }
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || value === '') continue
    next[key] = value
  }
  return next
}

export function buildJobParameters(
  input: BuildJobInput,
  allowed = allowedJobParameters(input.capabilities)
): Record<string, unknown> {
  const advertised = new Set(advertisedParameters(input.capabilities))
  const draft: Record<string, unknown> = {}

  if (allowed.has('n') && advertised.has('n') && input.density === 'pro' && input.count) {
    const maxOutputs = Math.max(1, Math.min(4, Number(input.capabilities.max_outputs ?? 4) || 1))
    draft.n = Math.max(1, Math.min(maxOutputs, Number(input.count) || 1))
  }
  if (allowed.has('size') && advertised.has('size') && input.size) draft.size = input.size
  if (allowed.has('quality') && advertised.has('quality') && input.quality) {
    draft.quality = input.quality
  }
  if (allowed.has('style') && advertised.has('style') && input.density === 'pro' && input.style) {
    draft.style = input.style
  }
  if (allowed.has('aspect_ratio') && advertised.has('aspect_ratio') && input.aspectRatio) {
    draft.aspect_ratio = input.aspectRatio
  }
  if (allowed.has('output_format') && advertised.has('output_format') && input.density === 'pro') {
    if (input.outputFormat) draft.output_format = input.outputFormat
  }
  if (allowed.has('background') && advertised.has('background') && input.density === 'pro') {
    if (input.background) draft.background = input.background
  }
  if (allowed.has('compression') && advertised.has('compression') && input.density === 'pro') {
    if (input.compression !== undefined && input.compression !== '') {
      draft.compression = input.compression
    }
  }

  const resolution = input.resolution && input.resolution !== 'native' ? input.resolution : ''
  if (resolution && allowed.has('target_resolution')) {
    draft.target_resolution = resolution
    if (allowed.has('upscale_model')) {
      draft.upscale_model = input.upscaleModel || 'general'
    }
  }

  if (
    input.density === 'pro' &&
    input.negativePrompt &&
    advertised.has('negative_prompt') &&
    allowed.has('negative_prompt')
  ) {
    draft.negative_prompt = input.negativePrompt
  }
  if (
    input.density === 'pro' &&
    input.referenceStrength != null &&
    advertised.has('reference_strength') &&
    allowed.has('reference_strength')
  ) {
    draft.reference_strength = input.referenceStrength
  }

  const cleaned = compactRecord(draft)
  for (const key of Object.keys(cleaned)) {
    if (!allowed.has(key)) delete cleaned[key]
  }
  return cleaned
}

export function buildStudioJobPayload(input: BuildJobInput): StudioJobPayload {
  const operation = resolveBackendOperation(input)
  let references = input.references

  if (
    (input.uiMode === 'edit' || input.uiMode === 'enhance' || input.uiMode === 'canvas') &&
    input.selectedAssetId &&
    !references.some(item => item.assetId === input.selectedAssetId && item.role !== 'mask')
  ) {
    references = addReference(
      references,
      input.selectedAssetId,
      'edit',
      Math.max(1, input.capabilities.max_inputs || 4)
    )
  }

  const inputIds = collectInputAssetIds(references)
  const maskId = collectMaskAssetId(references)

  if (operation === 'generate') {
    return {
      operation,
      image_profile_id: input.profileId,
      model_id: input.modelId,
      prompt: input.prompt.trim(),
      input_asset_ids: [],
      mask_asset_id: null,
      parent_job_id: input.parentJobId || null,
      parameters: buildJobParameters(input),
    }
  }

  return {
    operation,
    image_profile_id: input.profileId,
    model_id: input.modelId,
    prompt: input.prompt.trim(),
    input_asset_ids: inputIds,
    mask_asset_id: operation === 'inpaint' ? maskId : null,
    parent_job_id: input.parentJobId || null,
    parameters: buildJobParameters(input),
  }
}

export function resultActionIds(): readonly string[] {
  return [
    'edit',
    'vary',
    'reference',
    'canvas',
    'enhance',
    'download',
    'favorite',
    'more',
  ] as const
}

export type JobFactStrip = {
  modelLabel?: string
  outputSize?: string
  nativeOutput: boolean
  aiUpscaled: boolean
  upscaleModel?: string
  device?: string
  durationMs?: number
  warnings: string[]
  fallbackReason?: string
}

export function jobFactStrip(job: {
  profile_id?: string
  model_id?: string
  requested_params?: Record<string, unknown>
  actual_params?: {
    target_resolution?: string
    image_size?: string
    size?: string
    upscale_model?: string
    warnings?: string[]
    upscale?: Array<{
      method?: string
      width?: number
      height?: number
      source_width?: number
      source_height?: number
      device?: string
      duration_ms?: number
      model?: string
    }>
  }
  outputs?: Array<{ asset_id: string }>
}): JobFactStrip {
  const actual = job.actual_params || {}
  const upscale = actual.upscale?.[0]
  const aiUpscaled = upscale?.method === 'real-esrgan-ncnn-vulkan'
  const resized = Boolean(upscale) && !aiUpscaled
  const warnings = Array.isArray(actual.warnings) ? actual.warnings.map(String) : []
  const outputSize =
    upscale?.width && upscale?.height
      ? `${upscale.width} × ${upscale.height}`
      : actual.size
        ? String(actual.size)
        : undefined
  return {
    modelLabel: job.model_id,
    outputSize,
    nativeOutput: !upscale,
    aiUpscaled,
    upscaleModel: upscale?.model || (typeof actual.upscale_model === 'string' ? actual.upscale_model : undefined),
    device: upscale?.device,
    durationMs: upscale?.duration_ms,
    warnings,
    fallbackReason: resized
      ? warnings.find(item => /resize|vulkan|upscal/i.test(item)) || warnings[0]
      : warnings[0],
  }
}

export function activeJobOf(jobs: Array<{ status: string }>): { status: string } | undefined {
  return jobs.find(job => job.status === 'running') || jobs.find(job => job.status === 'queued')
}

export function hasStudioResults(
  jobs: Array<{ outputs?: Array<{ asset_id: string }> }>,
  assets: Array<{ id: string; kind?: string }>
): boolean {
  if (assets.some(asset => asset.kind === 'output')) return true
  return jobs.some(job => (job.outputs || []).length > 0)
}
