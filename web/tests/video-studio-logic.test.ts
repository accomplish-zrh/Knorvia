import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addStoryboardShot,
  advertisedVideoOperations,
  boardNodeVariantCount,
  buildVideoJobPayload,
  bindJobToStoryboardShot,
  CAMERA_VALUE_LABELS,
  cameraChipValues,
  cameraParameterForKey,
  cameraParameterLabel,
  classifyVideoJobError,
  emptyVideoStoryboard,
  ensureVideoSubmissionRequest,
  invalidateVideoSubmissionRequest,
  jobErrorMessage,
  normalizeVideoStoryboard,
  normalizedJobProgress,
  preferredVideoModel,
  preferredVideoOperation,
  reorderStoryboardShots,
  retryStoryboardShot,
  sanitizeVideoInputs,
  settingsForVideoModel,
  storyboardPatchAffectsSubmission,
  toggleVideoInput,
  validateVideoSubmission,
  videoDurationControl,
  videoInputLimits,
  videoJobErrorLabelKey,
  videoModelKey,
  nextArmedPaidAction,
  sortVideoVariantJobs,
  variantJobSeedLabel,
  estimateVideoCostYuan,
  formatYuan,
  jobBilledSeconds,
  parsePriceHint,
  saveVideoPriceHint,
  variantParameterDiff,
  variantRenderSeconds,
  type VideoSettings,
} from '../lib/video-studio/studio-logic'
import type { VideoAsset, VideoModelOption } from '../lib/video-studio-api'

const model: VideoModelOption = {
  profile_id: 'profile',
  model_id: 'veo',
  profile_name: 'Google',
  model_name: 'Veo',
  model: 'veo-3',
  provider: 'google',
  capabilities: {
    operations: ['text_to_video', 'image_to_video'],
    durations: [4, 8],
    aspect_ratios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p'],
    fps: [24, 30],
    audio_modes: ['none', 'generate', 'input'],
    reference_modes: ['first', 'last', 'multi'],
    max_inputs: { image: 2, video: 0, audio: 1, total: 3 },
    supports_cancel: true,
    supports_seed: true,
    max_prompt_length: 100,
    parameter_schema: {
      type: 'object',
      properties: {
        camera_motion: { type: 'string', enum: ['static', 'dolly'], default: 'static' },
        guidance: { type: 'number', minimum: 1, maximum: 10, default: 4 },
      },
    },
  },
  defaults: {
    duration: 8,
    aspect_ratio: '16:9',
    resolution: '1080p',
    fps: 24,
    audio_mode: 'generate',
    seed: 42,
  },
}

const assets: VideoAsset[] = [
  { id: 'i1', project_id: 'p1', kind: 'image', mime_type: 'image/png', filename: 'one.png', size_bytes: 1, sha256: 'a', created_at: 1 },
  { id: 'i2', project_id: 'p1', kind: 'image', mime_type: 'image/png', filename: 'two.png', size_bytes: 1, sha256: 'b', created_at: 2 },
  { id: 'i3', project_id: 'p1', kind: 'image', mime_type: 'image/png', filename: 'three.png', size_bytes: 1, sha256: 'c', created_at: 3 },
  { id: 'v1', project_id: 'p1', kind: 'video', mime_type: 'video/mp4', filename: 'clip.mp4', size_bytes: 1, sha256: 'd', created_at: 4 },
  { id: 'a1', project_id: 'p1', kind: 'audio', mime_type: 'audio/mpeg', filename: 'sound.mp3', size_bytes: 1, sha256: 'e', created_at: 5 },
]

test('model selection and explicit capability lists are deterministic', () => {
  const other = { ...model, profile_id: 'other', model_id: 'other' }
  assert.equal(videoModelKey(model), 'profile:veo')
  assert.equal(preferredVideoModel([model, other], 'other:other'), other)
  assert.equal(preferredVideoModel([model], 'gone:model'), model)
  assert.deepEqual(advertisedVideoOperations({ operations: [] }), [])
  assert.deepEqual(advertisedVideoOperations(undefined), ['text_to_video'])
  assert.equal(preferredVideoOperation(model.capabilities, 'image_to_video'), 'image_to_video')
  assert.equal(preferredVideoOperation(model.capabilities, 'video_to_video'), 'text_to_video')
})

test('switching models resets every unsupported capability parameter', () => {
  const previous: VideoSettings = {
    duration: 12,
    aspectRatio: '1:1',
    resolution: '4K',
    fps: 60,
    audioMode: 'input',
    seed: '99',
    referenceMode: 'multi',
    extra: { camera_motion: 'dolly', removed: true },
  }
  const settings = settingsForVideoModel(model, previous)
  assert.equal(settings.duration, 8)
  assert.equal(settings.aspectRatio, '16:9')
  assert.equal(settings.resolution, '1080p')
  assert.equal(settings.fps, 24)
  assert.equal(settings.audioMode, 'input')
  assert.equal(settings.seed, '99')
  assert.equal(settings.referenceMode, 'multi')
  assert.deepEqual(settings.extra, { camera_motion: 'dolly', guidance: 4 })
})

test('switching models clamps stale reference mode and drops schema values outside constraints', () => {
  const settings = settingsForVideoModel(model, {
    referenceMode: 'universal',
    extra: { camera_motion: 'invalid', guidance: 99 },
  })
  assert.equal(settings.referenceMode, 'first')
  const payload = buildVideoJobPayload({
    model,
    operation: 'image_to_video',
    prompt: 'move',
    selectedInputIds: ['i1'],
    settings,
    clientRequestId: 'bounded',
  })
  assert.equal(payload.parameters.camera_motion, undefined)
  assert.equal(payload.parameters.guidance, undefined)
})

test('input selection enforces operation, per-kind, and total limits', () => {
  assert.deepEqual(
    sanitizeVideoInputs(['i1', 'i2', 'i3', 'v1', 'a1'], assets, 'image_to_video', model.capabilities, 'input'),
    ['i1', 'i2', 'a1']
  )
  assert.deepEqual(
    sanitizeVideoInputs(['i1', 'a1'], assets, 'text_to_video', model.capabilities, 'input'),
    ['a1']
  )
  assert.deepEqual(
    toggleVideoInput(['i1', 'i2'], assets[2], assets, 'image_to_video', model.capabilities, 'none'),
    ['i1', 'i2']
  )
})

test('input byte limits are enforced before a provider request is submitted', () => {
  const boundedModel: VideoModelOption = {
    ...model,
    capabilities: {
      ...model.capabilities,
      max_input_bytes: 1,
    },
  }
  const settings = settingsForVideoModel(boundedModel)
  assert.deepEqual(
    sanitizeVideoInputs(['i1', 'i2'], assets, 'image_to_video', boundedModel.capabilities, 'none'),
    ['i1']
  )
  assert.equal(
    validateVideoSubmission({
      projectId: 'p1',
      model: boundedModel,
      operation: 'image_to_video',
      prompt: 'move',
      selectedInputIds: ['i1', 'i2'],
      assets,
      settings,
      costConfirmed: true,
    }).reason,
    'inputs-too-large'
  )
})

test('submission guard covers inputs, prompt limits, and paid-credit confirmation', () => {
  const settings = settingsForVideoModel(model)
  assert.equal(
    validateVideoSubmission({ projectId: 'p1', model, operation: 'image_to_video', prompt: 'move', selectedInputIds: [], assets, settings, costConfirmed: true }).reason,
    'image-required'
  )
  assert.equal(
    validateVideoSubmission({ projectId: 'p1', model, operation: 'text_to_video', prompt: 'move', selectedInputIds: [], assets, settings, costConfirmed: false }).reason,
    'cost-confirmation-required'
  )
  assert.equal(
    validateVideoSubmission({ projectId: 'p1', model, operation: 'text_to_video', prompt: 'x'.repeat(101), selectedInputIds: [], assets, settings, costConfirmed: true }).reason,
    'prompt-too-long'
  )
  assert.equal(
    validateVideoSubmission({ projectId: 'p1', model, operation: 'image_to_video', prompt: 'move', selectedInputIds: ['i1'], assets, settings, costConfirmed: true }).ok,
    true
  )
})

test('remix requires a video even when the model also accepts image references', () => {
  const remixModel: VideoModelOption = {
    ...model,
    capabilities: {
      ...model.capabilities,
      operations: ['remix'],
      max_inputs: { image: 2, video: 1, audio: 0, total: 3 },
    },
  }
  const settings = settingsForVideoModel(remixModel)
  assert.equal(
    validateVideoSubmission({ projectId: 'p1', model: remixModel, operation: 'remix', prompt: 'remix', selectedInputIds: ['i1'], assets, settings, costConfirmed: true }).reason,
    'video-required'
  )
  assert.equal(
    validateVideoSubmission({ projectId: 'p1', model: remixModel, operation: 'remix', prompt: 'remix', selectedInputIds: ['i1', 'v1'], assets, settings, costConfirmed: true }).ok,
    true
  )
})

test('union JSON schema types accept any matching branch and still apply value constraints', () => {
  const unionModel: VideoModelOption = {
    ...model,
    capabilities: {
      ...model.capabilities,
      parameter_schema: {
        type: 'object',
        properties: {
          hybrid: { type: ['number', 'string'], minimum: 1, maximum: 10, maxLength: 4 },
        },
      },
    },
  }
  const numeric = settingsForVideoModel(unionModel)
  numeric.extra.hybrid = 3
  assert.equal(buildVideoJobPayload({ model: unionModel, operation: 'text_to_video', prompt: 'x', selectedInputIds: [], settings: numeric, clientRequestId: 'numeric' }).parameters.hybrid, 3)
  const tooLong = settingsForVideoModel(unionModel)
  tooLong.extra.hybrid = 'longer'
  assert.equal(buildVideoJobPayload({ model: unionModel, operation: 'text_to_video', prompt: 'x', selectedInputIds: [], settings: tooLong, clientRequestId: 'string' }).parameters.hybrid, undefined)
})

test('job payload is provider-neutral, idempotent, cost-confirmed, and capability filtered', () => {
  const settings = settingsForVideoModel(model)
  settings.seed = '7'
  settings.extra = { camera_motion: 'dolly', guidance: 5, unadvertised: 'drop' }
  const payload = buildVideoJobPayload({
    model,
    operation: 'image_to_video',
    prompt: '  move through the light  ',
    selectedInputIds: ['i1'],
    settings,
    clientRequestId: 'request-1',
  })
  assert.equal(payload.client_request_id, 'request-1')
  assert.equal(payload.confirmed_cost, true)
  assert.equal(payload.operation, 'image_to_video')
  assert.equal(payload.prompt, 'move through the light')
  assert.equal(payload.parameters.seed, 7)
  assert.equal(payload.parameters.camera_motion, 'dolly')
  assert.equal(payload.parameters.guidance, 5)
  assert.equal(payload.parameters.unadvertised, undefined)
  assert.equal(payload.storyboard_shot_id, null)
})

test('storyboard normalization, append, and reorder preserve revision and stable shot ids', () => {
  const empty = emptyVideoStoryboard()
  assert.equal(empty.revision, 0)
  const first = addStoryboardShot(empty, { title: 'A', prompt: 'a', input_asset_ids: [] })
  const second = addStoryboardShot(first, { title: 'B', prompt: 'b', input_asset_ids: [] })
  const reversed = reorderStoryboardShots(second, 1, 0)
  assert.deepEqual(reversed.shots.map(shot => shot.title), ['B', 'A'])
  assert.deepEqual(reversed.shots.map(shot => shot.order), [0, 1])
  const normalized = normalizeVideoStoryboard({ ...reversed, revision: 9 })
  assert.equal(normalized.revision, 9)
  assert.deepEqual(new Set(normalized.shots.map(shot => shot.id)).size, 2)
  assert.equal(
    normalizeVideoStoryboard({
      revision: 1,
      shots: [{ id: 'empty-duration', order: 0, title: '', prompt: '', input_asset_ids: [], duration: null }],
    }).shots[0].duration,
    null
  )
})

test('only selected-shot fields that feed generation invalidate a pending submission', () => {
  assert.equal(storyboardPatchAffectsSubmission({ prompt: 'new prompt' }), true)
  assert.equal(storyboardPatchAffectsSubmission({ input_asset_ids: ['i1'] }), true)
  assert.equal(storyboardPatchAffectsSubmission({ duration: null }), true)
  assert.equal(storyboardPatchAffectsSubmission({ title: 'Display only' }), false)
  assert.equal(storyboardPatchAffectsSubmission({ notes: 'Planning only' }), false)
})

test('retry only reuses a storyboard shot that still exists in the current document', () => {
  const current = addStoryboardShot(emptyVideoStoryboard(), {
    id: 'shot-1',
    title: 'Opening',
    prompt: 'move',
    input_asset_ids: [],
    job_id: 'job-1',
  })
  const job = { id: 'job-1', storyboard_shot_id: 'shot-1' }
  assert.equal(retryStoryboardShot(current, job)?.id, 'shot-1')
  assert.equal(retryStoryboardShot(emptyVideoStoryboard(), job), undefined)

  const restored = addStoryboardShot(emptyVideoStoryboard(), {
    id: 'shot-1',
    title: 'Opening',
    prompt: 'move',
    input_asset_ids: [],
  })
  assert.equal(retryStoryboardShot(restored, job)?.id, 'shot-1')
})

test('binding a generated job patches the selected shot instead of duplicating it', () => {
  const draft = addStoryboardShot(emptyVideoStoryboard(), {
    id: 'shot-1',
    title: 'Opening',
    prompt: 'draft',
    input_asset_ids: [],
  })
  const bound = bindJobToStoryboardShot(draft, 'shot-1', {
    id: 'job-1',
    prompt: 'final prompt',
    input_asset_ids: ['i1'],
    output_asset_ids: ['o1'],
    parameters: { duration: 8 },
  })
  assert.equal(bound.shots.length, 1)
  assert.equal(bound.shots[0].job_id, 'job-1')
  assert.equal(bound.shots[0].output_asset_id, 'o1')
  assert.equal(bound.shots[0].prompt, 'final prompt')
})

test('job progress accepts either ratios or percentages and clamps corrupt values', () => {
  assert.equal(normalizedJobProgress({ status: 'running', progress: 0.42 }), 42)
  assert.equal(normalizedJobProgress({ status: 'running', progress: 0.5 }), 50)
  assert.equal(normalizedJobProgress({ status: 'running', progress: 64 }), 64)
  assert.equal(normalizedJobProgress({ status: 'running', progress: 500 }), 100)
  assert.equal(normalizedJobProgress({ status: 'succeeded', progress: 0 }), 100)
})

test('failed jobs display both structured and legacy public error fields', () => {
  assert.equal(jobErrorMessage({ error: { code: 'provider_error', message: 'Provider rejected the task' } }), 'Provider rejected the task')
  assert.equal(jobErrorMessage({ error: null, error_code: 'quota_exceeded', error_message: 'Quota exceeded' }), 'Quota exceeded')
  assert.equal(jobErrorMessage({ error: null, error_code: 'quota_exceeded', error_message: null }), 'quota_exceeded')
})

test('chat error taxonomy recognizes timeout, rate limit, and invalid material jobs', () => {
  assert.equal(
    classifyVideoJobError({ error: null, error_code: 'provider_timeout', error_message: 'Video generation exceeded the configured time limit.' }),
    'timeout'
  )
  assert.equal(
    classifyVideoJobError({ error: { code: 'submission_interrupted' }, error_code: null, error_message: null }),
    'timeout'
  )
  assert.equal(
    classifyVideoJobError({ error: null, error_code: 'provider_error', error_message: 'Video task status error: HTTP 429 Too Many Requests' }),
    'rate-limit'
  )
  assert.equal(
    classifyVideoJobError({ error: null, error_code: null, error_message: '服务商返回 rate limit，请求过于频繁' }),
    'rate-limit'
  )
  assert.equal(
    classifyVideoJobError({ error: { code: 'provider_error', message: 'Video task submission error: HTTP 400 invalid image reference' } }),
    'invalid-material'
  )
  assert.equal(
    classifyVideoJobError({ error: null, error_code: null, error_message: 'The video adapter cannot send a document reference.' }),
    'invalid-material'
  )
  assert.equal(
    classifyVideoJobError({ error: null, error_code: null, error_message: '不支持的格式：素材无效' }),
    'invalid-material'
  )
  assert.equal(
    classifyVideoJobError({ error: null, error_code: 'authorization_error', error_message: 'Upstream credentials were revoked.' }),
    'other'
  )
  assert.equal(
    classifyVideoJobError({ error: null, error_code: null, error_message: null }),
    'other'
  )
  // 429 wins over wording that also mentions waiting/timeouts in the detail.
  assert.equal(
    classifyVideoJobError({ error: null, error_code: 'provider_error', error_message: 'Rate limited while polling; timed out after retries' }),
    'rate-limit'
  )
})

test('chat error taxonomy maps each category to a translatable key', () => {
  assert.ok(videoJobErrorLabelKey('timeout').length > 0)
  assert.ok(videoJobErrorLabelKey('rate-limit').length > 0)
  assert.ok(videoJobErrorLabelKey('invalid-material').length > 0)
  assert.equal(videoJobErrorLabelKey('other'), '')
})

test('duration control renders a continuous slider for contiguous integer ranges', () => {
  const control = videoDurationControl({ durations: [3, 4, 5, 6] }, 5)
  assert.deepEqual(control, { kind: 'range', min: 3, max: 6, step: 1, value: 5 })
  // Values outside the advertised range snap back inside it.
  assert.deepEqual(videoDurationControl({ durations: [3, 4, 5, 6] }, 99), { kind: 'range', min: 3, max: 6, step: 1, value: 6 })
  assert.deepEqual(videoDurationControl({ durations: [3, 4, 5, 6] }, ''), { kind: 'range', min: 3, max: 6, step: 1, value: 3 })
})

test('duration control steps through sparse presets and keeps the select fallbacks', () => {
  // Sparse presets (e.g. 4/8/12) become an index slider over the presets.
  assert.deepEqual(videoDurationControl({ durations: [4, 8, 12] }, 8), { kind: 'steps', durations: [4, 8, 12], index: 1 })
  // A value between presets snaps to the nearest advertised one; ties snap down.
  assert.deepEqual(videoDurationControl({ durations: [4, 8, 12] }, 10), { kind: 'steps', durations: [4, 8, 12], index: 1 })
  assert.deepEqual(videoDurationControl({ durations: [4, 8, 12] }, 30), { kind: 'steps', durations: [4, 8, 12], index: 2 })
  // Single preset or no presets keep the legacy select / hidden control.
  assert.deepEqual(videoDurationControl({ durations: [6] }, ''), { kind: 'select', durations: [6] })
  assert.deepEqual(videoDurationControl({}, 4), { kind: 'none' })
  // Duplicates and noise are normalized away.
  assert.deepEqual(videoDurationControl({ durations: [8, 4, 4, 0, Number.NaN] }, 4), { kind: 'steps', durations: [4, 8], index: 0 })
})

test('duration slider values stay compatible with settingsForVideoModel defaults', () => {
  const sparse: VideoModelOption = {
    ...model,
    capabilities: { ...model.capabilities, durations: [4, 8] },
    defaults: { ...model.defaults, duration: 8 },
  }
  const settings = settingsForVideoModel(sparse)
  const control = videoDurationControl(sparse.capabilities, settings.duration)
  assert.equal(settings.duration, 8)
  assert.equal(control.kind, 'steps')
  if (control.kind === 'steps') {
    assert.equal(control.durations[control.index], settings.duration)
  }
  const contiguous: VideoModelOption = {
    ...model,
    capabilities: { ...model.capabilities, durations: [4, 5, 6] },
    defaults: { ...model.defaults, duration: 5 },
  }
  const continuous = videoDurationControl(contiguous.capabilities, settingsForVideoModel(contiguous).duration)
  assert.equal(continuous.kind, 'range')
  if (continuous.kind === 'range') {
    assert.equal(continuous.value, 5)
  }
})

test('input limits normalize max_inputs for the composer capacity copy', () => {
  assert.deepEqual(
    videoInputLimits({ max_inputs: { image: 9, video: 0, audio: 1, total: 10 } }),
    { image: 9, video: 0, audio: 1, total: 10 }
  )
  // total falls back to the per-kind sum, and negative values clamp to zero.
  assert.deepEqual(
    videoInputLimits({ max_inputs: { image: 2, audio: -1 } }),
    { image: 2, video: 0, audio: 0, total: 2 }
  )
  assert.deepEqual(videoInputLimits(undefined), { image: 0, video: 0, audio: 0, total: 0 })
})

test('changing a paid job payload after a lost response allocates a new request id', () => {
  const request = { current: 'lost-response-request' as string | null }
  assert.equal(ensureVideoSubmissionRequest(request, () => 'must-not-replace'), 'lost-response-request')
  invalidateVideoSubmissionRequest(request)
  assert.equal(ensureVideoSubmissionRequest(request, () => 'new-payload-request'), 'new-payload-request')
})

test('C4 chips branch: camera string enums chip out, unknown vocabulary falls back', () => {
  // Fully-known preset vocabulary renders as chips, order preserved from schema.
  assert.deepEqual(
    cameraChipValues({ type: 'string', enum: ['static', 'push', 'orbit'] }),
    ['static', 'push', 'orbit']
  )
  assert.deepEqual(
    cameraChipValues({ type: 'string', enum: ['none', 'simple', 'custom'] }),
    ['none', 'simple', 'custom']
  )
  // A single unlabeled value keeps the plain dropdown for the whole group.
  assert.equal(cameraChipValues({ type: 'string', enum: ['static', 'warp-speed'] }), null)
  // Non-string types and missing enums never chip out.
  assert.equal(cameraChipValues({ type: 'number', enum: [1, 2] }), null)
  assert.equal(cameraChipValues({ type: 'string' }), null)
  assert.equal(cameraChipValues(undefined), null)
  // Every label the chips can render exists in the i18n label map source.
  for (const label of Object.values(CAMERA_VALUE_LABELS)) {
    assert.equal(typeof label, 'string')
    assert.ok(label.length > 0)
  }
})

test('C4 submit path: stored motions resolve onto the model camera parameter only', () => {
  // The fixture model exposes camera_motion: ['static', 'dolly'].
  assert.deepEqual(cameraParameterForKey(model.capabilities, 'dolly'), {
    key: 'camera_motion',
    value: 'dolly',
  })
  assert.deepEqual(cameraParameterForKey(model.capabilities, ' static '), {
    key: 'camera_motion',
    value: 'static',
  })
  // Unknown vocabulary and missing intent submit nothing extra.
  assert.equal(cameraParameterForKey(model.capabilities, 'orbit'), null)
  assert.equal(cameraParameterForKey(model.capabilities, ''), null)
  assert.equal(cameraParameterForKey(model.capabilities, null), null)
  assert.equal(cameraParameterForKey(undefined, 'dolly'), null)
  // Non-camera enum parameters are never hijacked as the camera channel.
  const decoy = {
    ...model.capabilities,
    parameter_schema: {
      type: 'object' as const,
      properties: {
        style: { type: 'string' as const, enum: ['static', 'dolly'] },
      },
    },
  }
  assert.equal(cameraParameterForKey(decoy, 'dolly'), null)
  // The first matching camera* enum wins when several exist.
  const both = {
    ...model.capabilities,
    parameter_schema: {
      type: 'object' as const,
      properties: {
        camera_control: { type: 'string' as const, enum: ['none', 'simple'] },
        camera_motion: { type: 'string' as const, enum: ['push', 'pull'] },
      },
    },
  }
  assert.deepEqual(cameraParameterForKey(both, 'push'), { key: 'camera_motion', value: 'push' })
  assert.deepEqual(cameraParameterForKey(both, 'simple'), { key: 'camera_control', value: 'simple' })
})

test('C4 group labels and storyboard camera normalization', () => {
  assert.equal(cameraParameterLabel('camera_motion'), 'Camera movement')
  assert.equal(cameraParameterLabel('camera_control'), 'Camera control')
  assert.equal(cameraParameterLabel('camera_fixed'), 'Camera')
  // The storyboard shot keeps the planned motion: trimmed, capped, emptied.
  const long = 'pan-' + 'q'.repeat(80)
  const storyboard = normalizeVideoStoryboard({
    revision: 2,
    shots: [
      { id: 's1', order: 0, prompt: 'drone pushes in', camera: ' push ' },
      { id: 's2', order: 1, prompt: 'wide pan', camera: long },
      { id: 's3', order: 2, prompt: 'static wide', camera: '   ' },
      { id: 's4', order: 3, prompt: 'no camera field' },
    ],
  })
  assert.equal(storyboard.shots[0].camera, 'push')
  assert.equal(storyboard.shots[1].camera, long.slice(0, 64))
  assert.equal(storyboard.shots[2].camera, null)
  assert.equal(storyboard.shots[3].camera, null)
})

// ── §Phase C5 variants / reroll ─────────────────────────────────────

const variantJob = (id: string, createdAt: string | number, extra: Record<string, unknown> = {}) =>
  ({
    id,
    project_id: 'p1',
    operation: 'text_to_video',
    status: 'succeeded',
    progress: 1,
    prompt: 'a quiet lake',
    profile_id: 'profile',
    model_id: 'veo',
    parameters: {},
    input_asset_ids: [],
    output_asset_ids: [],
    created_at: createdAt,
    ...extra,
  }) as import('../lib/video-studio-api').VideoJob

test('C5 variant list sorts newest first with deterministic id tiebreak', () => {
  const jobs = [
    variantJob('job-a', '2026-08-16T10:00:00Z'),
    variantJob('job-c', '2026-08-16T12:00:00Z'),
    variantJob('job-b', '2026-08-16T11:00:00Z'),
  ]
  assert.deepEqual(
    sortVideoVariantJobs(jobs).map(job => job.id),
    ['job-c', 'job-b', 'job-a']
  )
  // Same timestamp → id DESC keeps the ordering stable.
  const tied = [
    variantJob('job-a', 1000),
    variantJob('job-c', 1000),
    variantJob('job-b', 1000),
  ]
  assert.deepEqual(
    sortVideoVariantJobs(tied).map(job => job.id),
    ['job-c', 'job-b', 'job-a']
  )
  // Sorting never mutates the caller's array and survives garbage timestamps.
  const original = [...jobs]
  sortVideoVariantJobs([variantJob('job-x', 'not-a-date'), ...jobs])
  assert.deepEqual(jobs, original)
})

test('C5 variant seed label shows the seed or a dash for seedless models', () => {
  assert.equal(variantJobSeedLabel({ parameters: { seed: 424242 } }), '424242')
  assert.equal(variantJobSeedLabel({ parameters: {} }), '—')
  assert.equal(variantJobSeedLabel({ parameters: { seed: 'nope' } }), '—')
})

test('C5 board variant count is scoped to one generate node', () => {
  const jobs = [
    { board_node_id: 'node-1' },
    { board_node_id: 'node-2' },
    { board_node_id: 'node-1' },
    { board_node_id: null },
    {},
  ]
  assert.equal(boardNodeVariantCount(jobs, 'node-1'), 2)
  assert.equal(boardNodeVariantCount(jobs, 'node-2'), 1)
  assert.equal(boardNodeVariantCount(jobs, 'node-3'), 0)
})

test('C5 reroll confirm state machine: arm → fire, stale key disarms, foreign id re-arms', () => {
  const key = 'rr:shot-1:job-9'
  // Idle click arms.
  const armed = nextArmedPaidAction(null, 'job-9', key)
  assert.deepEqual(armed, { fires: false, next: { id: 'job-9', key } })
  // Second click on the same id+key fires and disarms.
  assert.deepEqual(nextArmedPaidAction(armed.next, 'job-9', key), { fires: true, next: null })
  // A stale armed record under a different key (prompt/job changed) never fires.
  const stale = nextArmedPaidAction({ id: 'job-9', key: 'rr:shot-1:job-old' }, 'job-9', key)
  assert.deepEqual(stale, { fires: false, next: null })
  // A different target id just re-arms under the new id.
  const swapped = nextArmedPaidAction(armed.next, 'job-10', key)
  assert.deepEqual(swapped, { fires: false, next: { id: 'job-10', key } })
})

test('§F5 price hint parsing accepts sane ¥/s and rejects junk', () => {
  assert.equal(parsePriceHint('0.5'), 0.5)
  assert.equal(parsePriceHint(2), 2)
  assert.equal(parsePriceHint(' 1.25 '), 1.25)
  // Over-precise input rounds to 4 decimals.
  assert.equal(parsePriceHint(0.123456), 0.1235)
  assert.equal(parsePriceHint('0'), null)
  assert.equal(parsePriceHint('-1'), null)
  assert.equal(parsePriceHint('abc'), null)
  assert.equal(parsePriceHint('1001'), null)
})

test('§F5 cost estimate = ¥ hint × billed seconds, hidden when either side is missing', () => {
  assert.equal(estimateVideoCostYuan(0.5, 8), 4)
  assert.equal(estimateVideoCostYuan(0.333, 10), 3.33)
  assert.equal(estimateVideoCostYuan(null, 8), null)
  assert.equal(estimateVideoCostYuan(0.5, null), null)
  assert.equal(estimateVideoCostYuan(0.5, 0), null)
  assert.equal(formatYuan(4), '¥4.00')
})

test('§F5 saveVideoPriceHint sets, clears, and tolerates a blank map', () => {
  const first = saveVideoPriceHint({}, 'profile:veo', 0.5)
  assert.deepEqual(first, { 'profile:veo': 0.5 })
  const cleared = saveVideoPriceHint(first, 'profile:veo', null)
  assert.deepEqual(cleared, {})
  const kept = saveVideoPriceHint({ 'other:model': 1 }, 'profile:veo', null)
  assert.deepEqual(kept, { 'other:model': 1 })
})

test('§F5 billed seconds come from the job duration parameter only', () => {
  assert.equal(jobBilledSeconds({ parameters: { duration: 8 } }), 8)
  assert.equal(jobBilledSeconds({ parameters: { duration: '6' } }), 6)
  assert.equal(jobBilledSeconds({ parameters: {} }), null)
  assert.equal(jobBilledSeconds({ parameters: { duration: 'forever' } }), null)
  assert.equal(jobBilledSeconds({ parameters: { duration: 0 } }), null)
})

test('§F2 render seconds derive from created_at → finished_at; running takes stay null', () => {
  assert.equal(variantRenderSeconds({ created_at: 0, finished_at: 65_000 }), 65)
  assert.equal(variantRenderSeconds({ created_at: 1_000, finished_at: 1_000 }), 0)
  assert.equal(variantRenderSeconds({ created_at: 0, finished_at: null }), null)
})

test('§F2 variant diff lists changed keys alphabetically; equal takes diff nothing', () => {
  const current = { parameters: { duration: 8, resolution: '1080p', seed: 7 } }
  const same = variantParameterDiff(current, { parameters: { duration: 8, resolution: '1080p', seed: 7 } })
  assert.equal(same.length, 0)
  const diff = variantParameterDiff(current, {
    parameters: { duration: 6, resolution: '1080p', seed: 424242, camera_motion: 'dolly' },
  })
  assert.deepEqual(
    diff.map(item => item.key),
    ['camera_motion', 'duration', 'seed']
  )
  assert.deepEqual(diff[2], { key: 'seed', current: '7', other: '424242' })
  // A key only on the historical take shows the current side as absent.
  const added = variantParameterDiff(null, { parameters: { camera_control: 'static' } })
  assert.deepEqual(added, [{ key: 'camera_control', current: 'null', other: 'static' }])
})
