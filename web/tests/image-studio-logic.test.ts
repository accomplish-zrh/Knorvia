import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addReference,
  advertisedOperations,
  advertisedParameters,
  assignReferenceRole,
  buildJobParameters,
  buildStudioJobPayload,
  canvasToolAvailability,
  canSubmitStudioJob,
  collectInputAssetIds,
  collectMaskAssetId,
  fieldIsVisible,
  generateButtonAppearance,
  generateButtonState,
  hasStudioResults,
  jobFactStrip,
  parseStudioDensity,
  preferredStudioModel,
  resolveBackendOperation,
  resultActionIds,
  shouldExportPaintedMask,
  shouldShowFirstVisitEmpty,
  studioHeaderStatus,
  studioModelKey,
  takeMaskFile,
  visiblePromptFields,
  type BuildJobInput,
  type StudioModelCapabilities,
} from '../lib/image-studio/studio-logic'

test('model selection restores a valid choice and falls back safely', () => {
  const models = [
    { profile_id: 'google', model_id: 'image-2', is_active_default: false },
    { profile_id: 'openai', model_id: 'image', is_active_default: true },
  ]
  assert.equal(studioModelKey(models[0]), 'google:image-2')
  assert.equal(preferredStudioModel(models, 'google:image-2'), models[0])
  assert.equal(preferredStudioModel(models, 'removed:model'), models[1])
  assert.equal(preferredStudioModel([], 'removed:model'), undefined)
})

test('an explicit empty capability list never inherits legacy model features', () => {
  assert.deepEqual(advertisedOperations({ operations: [] }), [])
  assert.deepEqual(advertisedParameters({ parameters: [] }), [])
  assert.deepEqual(advertisedOperations(undefined), ['generate'])
})

const generateOnly: StudioModelCapabilities = {
  operations: ['generate'],
  parameters: ['n', 'size', 'quality', 'style', 'output_format'],
  max_inputs: 4,
}

const editReady: StudioModelCapabilities = {
  operations: ['generate', 'edit'],
  parameters: ['n', 'aspect_ratio', 'image_size'],
  max_inputs: 3,
}

const fullOpenAi: StudioModelCapabilities = {
  operations: ['generate', 'edit', 'inpaint'],
  parameters: ['n', 'size', 'quality', 'output_format', 'background', 'compression'],
  max_inputs: 4,
  supports_mask: true,
}

function baseInput(overrides: Partial<BuildJobInput> = {}): BuildJobInput {
  return {
    uiMode: 'create',
    prompt: 'a quiet studio still life',
    references: [],
    profileId: 'profile-1',
    modelId: 'model-1',
    capabilities: generateOnly,
    density: 'simple',
    resolution: 'native',
    count: 2,
    ...overrides,
  }
}

test('create mode without references maps to generate and never attaches inputs', () => {
  const payload = buildStudioJobPayload(baseInput())
  assert.equal(payload.operation, 'generate')
  assert.deepEqual(payload.input_asset_ids, [])
  assert.equal(payload.mask_asset_id, null)
})

test('create mode with role-tagged references uses edit instead of generate+inputs', () => {
  const payload = buildStudioJobPayload(
    baseInput({
      capabilities: editReady,
      references: [
        { assetId: 'a1', role: 'subject' },
        { assetId: 'a2', role: 'style' },
      ],
    })
  )
  assert.equal(payload.operation, 'edit')
  assert.deepEqual(payload.input_asset_ids, ['a1', 'a2'])
  assert.equal(resolveBackendOperation({ uiMode: 'create', references: payload.input_asset_ids.map(id => ({ assetId: id, role: 'subject' })), capabilities: generateOnly }), 'generate')
})

test('generate operation payload never includes input images even if refs sneak in', () => {
  const payload = buildStudioJobPayload(
    baseInput({
      capabilities: generateOnly,
      references: [{ assetId: 'a1', role: 'subject' }],
    })
  )
  assert.equal(payload.operation, 'generate')
  assert.deepEqual(payload.input_asset_ids, [])
})

test('edit and enhance attach the selected image as an edit reference', () => {
  const edit = buildStudioJobPayload(
    baseInput({
      uiMode: 'edit',
      capabilities: editReady,
      selectedAssetId: 'sel-1',
    })
  )
  assert.equal(edit.operation, 'edit')
  assert.deepEqual(edit.input_asset_ids, ['sel-1'])

  const enhance = buildStudioJobPayload(
    baseInput({
      uiMode: 'enhance',
      capabilities: editReady,
      selectedAssetId: 'sel-2',
      resolution: '2K',
    })
  )
  assert.equal(enhance.operation, 'edit')
  assert.equal(enhance.parameters.target_resolution, '2K')
  assert.equal(enhance.parameters.upscale_model, 'general')
})

test('canvas with a mask maps to inpaint and sends only the mask as mask_asset_id', () => {
  const payload = buildStudioJobPayload(
    baseInput({
      uiMode: 'canvas',
      capabilities: fullOpenAi,
      selectedAssetId: 'base-1',
      references: [
        { assetId: 'base-1', role: 'edit' },
        { assetId: 'mask-1', role: 'mask' },
      ],
    })
  )
  assert.equal(payload.operation, 'inpaint')
  assert.deepEqual(payload.input_asset_ids, ['base-1'])
  assert.equal(payload.mask_asset_id, 'mask-1')
})

test('edit or enhance with a mask prefers inpaint and always attaches mask_asset_id', () => {
  const refs = [
    { assetId: 'base-1', role: 'edit' as const },
    { assetId: 'mask-edit', role: 'mask' as const },
  ]
  assert.equal(
    resolveBackendOperation({ uiMode: 'edit', references: refs, capabilities: fullOpenAi }),
    'inpaint'
  )
  const edit = buildStudioJobPayload(
    baseInput({
      uiMode: 'edit',
      capabilities: fullOpenAi,
      selectedAssetId: 'base-1',
      references: refs,
    })
  )
  assert.equal(edit.operation, 'inpaint')
  assert.equal(edit.mask_asset_id, 'mask-edit')
  assert.deepEqual(edit.input_asset_ids, ['base-1'])

  const enhance = buildStudioJobPayload(
    baseInput({
      uiMode: 'enhance',
      capabilities: fullOpenAi,
      selectedAssetId: 'base-2',
      references: [
        { assetId: 'base-2', role: 'edit' },
        { assetId: 'mask-enh', role: 'mask' },
      ],
      resolution: '2K',
    })
  )
  assert.equal(enhance.operation, 'inpaint')
  assert.equal(enhance.mask_asset_id, 'mask-enh')
  assert.equal(enhance.parameters.target_resolution, '2K')
})

test('create with a mask and an inpaint-capable model still maps to inpaint', () => {
  const payload = buildStudioJobPayload(
    baseInput({
      uiMode: 'create',
      capabilities: fullOpenAi,
      references: [
        { assetId: 'subj', role: 'subject' },
        { assetId: 'mask-c', role: 'mask' },
      ],
    })
  )
  assert.equal(payload.operation, 'inpaint')
  assert.equal(payload.mask_asset_id, 'mask-c')
})

test('a mask does not become inpaint when the model does not advertise it', () => {
  const payload = buildStudioJobPayload(
    baseInput({
      uiMode: 'edit',
      capabilities: editReady,
      selectedAssetId: 'base-1',
      references: [
        { assetId: 'base-1', role: 'edit' },
        { assetId: 'mask-x', role: 'mask' },
      ],
    })
  )
  assert.equal(payload.operation, 'edit')
  assert.equal(payload.mask_asset_id, null)
})

test('generate prefers an explicit mask File over a held ref (no setState)', () => {
  const passed = { id: 'passed' }
  const held = { id: 'held' }
  assert.equal(takeMaskFile(passed, held), passed)
  assert.equal(takeMaskFile(null, held), held)
  assert.equal(takeMaskFile(undefined, held), held)
  assert.equal(takeMaskFile(undefined, null), null)
})

test('first canvas stroke exports via the painted ref, not stale React hasMask', () => {
  assert.equal(shouldExportPaintedMask(false), false)
  assert.equal(shouldExportPaintedMask(true), true)
})

test('simple mode field set is prompt, references, aspect, resolution, generate', () => {
  assert.deepEqual(visiblePromptFields('simple', fullOpenAi), [
    'prompt',
    'references',
    'aspect_ratio',
    'resolution',
    'generate',
  ])
  assert.equal(fieldIsVisible('service_model', 'simple', fullOpenAi), false)
  assert.equal(fieldIsVisible('count', 'simple', fullOpenAi), false)
  assert.equal(fieldIsVisible('negative_prompt', 'simple', fullOpenAi), false)
})

test('pro mode only reveals advertised backend fields and never invents strength or negative prompt', () => {
  const fields = visiblePromptFields('pro', fullOpenAi)
  assert.ok(fields.includes('service_model'))
  assert.ok(fields.includes('count'))
  assert.ok(fields.includes('background'))
  assert.ok(fields.includes('output_format'))
  assert.ok(fields.includes('upscale_model'))
  assert.ok(fields.includes('call_facts'))
  assert.equal(fields.includes('negative_prompt'), false)
  assert.equal(fields.includes('reference_strength'), false)
  assert.equal(fieldIsVisible('style', 'pro', fullOpenAi), false)

  const withNegative: StudioModelCapabilities = {
    ...fullOpenAi,
    parameters: [...(fullOpenAi.parameters || []), 'negative_prompt', 'reference_strength'],
  }
  assert.equal(fieldIsVisible('negative_prompt', 'pro', withNegative), false)
  assert.equal(fieldIsVisible('reference_strength', 'pro', withNegative), false)
})

test('payload allow-list drops unknown, unadvertised, and simple-mode-only-hidden fields', () => {
  const parameters = buildJobParameters(
    baseInput({
      density: 'simple',
      capabilities: fullOpenAi,
      count: 4,
      style: 'vivid',
      outputFormat: 'png',
      background: 'transparent',
      negativePrompt: 'text, watermark',
      referenceStrength: 0.8,
      resolution: '4K',
      aspectRatio: '16:9',
    })
  )
  assert.deepEqual(Object.keys(parameters).sort(), ['target_resolution', 'upscale_model'])
  assert.equal(parameters.n, undefined)
  assert.equal(parameters.negative_prompt, undefined)
  assert.equal(parameters.reference_strength, undefined)
  assert.equal(parameters.style, undefined)

  const pro = buildJobParameters(
    baseInput({
      density: 'pro',
      capabilities: fullOpenAi,
      count: 3,
      outputFormat: 'webp',
      background: 'transparent',
      compression: 80,
      style: 'vivid',
      resolution: '1K',
      upscaleModel: 'illustration',
    })
  )
  assert.equal(pro.n, 3)
  assert.equal(pro.output_format, 'webp')
  assert.equal(pro.background, 'transparent')
  assert.equal(pro.compression, 80)
  assert.equal(pro.style, undefined)
  assert.equal(pro.target_resolution, '1K')
  assert.equal(pro.upscale_model, 'illustration')
  assert.ok(!('negative_prompt' in pro))
  assert.ok(!('reference_strength' in pro))
})

test('native resolution omits target_resolution and upscale_model', () => {
  const parameters = buildJobParameters(
    baseInput({ density: 'pro', capabilities: fullOpenAi, resolution: 'native' })
  )
  assert.equal(parameters.target_resolution, undefined)
  assert.equal(parameters.upscale_model, undefined)
})

test('generate button states cover idle, queued, generating, and failed', () => {
  assert.equal(generateButtonState(undefined), 'idle')
  assert.equal(generateButtonState('succeeded'), 'idle')
  assert.equal(generateButtonState('queued'), 'queued')
  assert.equal(generateButtonState('running'), 'generating')
  assert.equal(generateButtonState('failed'), 'failed')
  assert.equal(generateButtonState(undefined, 'provider exploded'), 'failed')

  const idle = generateButtonAppearance({
    hasModel: true,
    hasPrompt: true,
    canSubmit: true,
  })
  assert.equal(idle.state, 'idle')
  assert.equal(idle.labelKey, 'Start creating')
  assert.equal(idle.disabled, false)

  const queued = generateButtonAppearance({
    status: 'queued',
    hasModel: true,
    hasPrompt: true,
    canSubmit: true,
    submitting: true,
  })
  assert.equal(queued.state, 'queued')
  assert.equal(queued.disabled, true)

  const generating = generateButtonAppearance({
    status: 'running',
    hasModel: true,
    hasPrompt: true,
    canSubmit: true,
    submitting: true,
  })
  assert.equal(generating.state, 'generating')
  assert.equal(generating.labelKey, 'Creating')

  const failed = generateButtonAppearance({
    status: 'failed',
    lastError: 'nope',
    hasModel: true,
    hasPrompt: true,
    canSubmit: true,
  })
  assert.equal(failed.state, 'failed')
  assert.equal(failed.labelKey, 'Retry generation')
})

test('reference roles can be assigned, remapped, and split into inputs vs mask', () => {
  let refs = addReference([], 'img-1', 'subject', 4)
  refs = addReference(refs, 'img-2', 'style', 4)
  refs = addReference(refs, 'img-3', 'mask', 4)
  refs = assignReferenceRole(refs, 'img-2', 'composition')
  assert.deepEqual(
    refs.map(item => `${item.assetId}:${item.role}`),
    ['img-1:subject', 'img-2:composition', 'img-3:mask']
  )
  assert.deepEqual(collectInputAssetIds(refs), ['img-1', 'img-2'])
  assert.equal(collectMaskAssetId(refs), 'img-3')

  const capped = addReference(refs.filter(item => item.role !== 'mask'), 'img-4', 'color', 2)
  assert.equal(capped.some(item => item.assetId === 'img-4'), false)
})

test('header chip never says ready when no image model is configured', () => {
  assert.equal(studioHeaderStatus({ loading: true, hasModel: false, runningCount: 0 }), 'hidden')
  assert.equal(
    studioHeaderStatus({ loading: false, hasModel: false, runningCount: 0 }),
    'unconfigured'
  )
  assert.equal(studioHeaderStatus({ loading: false, hasModel: true, runningCount: 0 }), 'hidden')
  assert.equal(studioHeaderStatus({ loading: false, hasModel: false, runningCount: 2 }), 'busy')
  assert.equal(studioHeaderStatus({ loading: false, hasModel: true, runningCount: 1 }), 'busy')
})

test('first-visit empty state disappears once any result exists', () => {
  assert.equal(shouldShowFirstVisitEmpty(false), true)
  assert.equal(shouldShowFirstVisitEmpty(true), false)
  assert.equal(hasStudioResults([], []), false)
  assert.equal(hasStudioResults([{ outputs: [{ asset_id: 'o1' }] }], []), true)
  assert.equal(hasStudioResults([], [{ id: 'a1', kind: 'output' }]), true)
  assert.equal(hasStudioResults([], [{ id: 'a1', kind: 'input' }]), false)
})

test('canvas tools mark outpaint and erase unavailable; inpaint follows backend ops', () => {
  assert.deepEqual(
    canvasToolAvailability('outpaint', {
      operations: ['generate', 'edit', 'inpaint'],
      hasSelection: true,
      hasMask: true,
    }),
    { available: false, reason: 'unsupported-backend' }
  )
  assert.equal(
    canvasToolAvailability('erase', {
      operations: ['inpaint'],
      hasSelection: true,
      hasMask: false,
    }).available,
    false
  )
  assert.equal(
    canvasToolAvailability('inpaint', {
      operations: ['generate'],
      hasSelection: true,
      hasMask: false,
    }).reason,
    'needs-inpaint'
  )
  assert.equal(
    canvasToolAvailability('inpaint', {
      operations: ['inpaint'],
      hasSelection: false,
      hasMask: false,
    }).reason,
    'needs-selection'
  )
  assert.equal(
    canvasToolAvailability('inpaint', {
      operations: ['inpaint'],
      hasSelection: true,
      hasMask: false,
    }).reason,
    'needs-mask'
  )
  assert.equal(
    canvasToolAvailability('brush', {
      operations: ['inpaint'],
      hasSelection: true,
      hasMask: false,
    }).available,
    true
  )
})

test('model limits cap output count and reject too many edit references', () => {
  assert.equal(
    buildJobParameters(
      baseInput({
        density: 'pro',
        count: 4,
        capabilities: { ...generateOnly, max_outputs: 2 },
      })
    ).n,
    2
  )
  assert.equal(
    canSubmitStudioJob({
      uiMode: 'edit',
      prompt: 'combine references',
      selectedAssetId: 'a1',
      references: [
        { assetId: 'a1', role: 'edit' },
        { assetId: 'a2', role: 'subject' },
      ],
      capabilities: { operations: ['edit'], max_inputs: 1 },
    }).reason,
    'too-many-inputs'
  )
})

test('submit guard blocks generate+inputs, inpaint without mask, and empty prompts', () => {
  assert.equal(
    canSubmitStudioJob({
      uiMode: 'create',
      prompt: '',
      references: [],
      capabilities: generateOnly,
    }).ok,
    false
  )
  assert.equal(
    canSubmitStudioJob({
      uiMode: 'create',
      prompt: 'hello',
      references: [],
      capabilities: generateOnly,
    }).ok,
    true
  )
  assert.equal(
    canSubmitStudioJob({
      uiMode: 'create',
      prompt: 'with a photo',
      references: [{ assetId: 'a1', role: 'subject' }],
      capabilities: generateOnly,
    }).reason,
    'generate-rejects-inputs'
  )
  assert.equal(
    canSubmitStudioJob({
      uiMode: 'edit',
      prompt: 'change the lighting',
      references: [],
      capabilities: editReady,
    }).reason,
    'needs-image'
  )
  assert.equal(
    canSubmitStudioJob({
      uiMode: 'canvas',
      prompt: 'redraw the sky',
      selectedAssetId: 'base',
      references: [{ assetId: 'base', role: 'edit' }],
      capabilities: { operations: ['inpaint'], max_inputs: 1 },
    }).reason,
    'needs-mask'
  )
  assert.equal(
    canSubmitStudioJob({
      uiMode: 'canvas',
      prompt: 'soften the light',
      selectedAssetId: 'base',
      references: [{ assetId: 'base', role: 'edit' }],
      capabilities: fullOpenAi,
    }).ok,
    true
  )
})

test('result hover actions stay the planned set and density parsing is strict', () => {
  assert.deepEqual(resultActionIds(), [
    'edit',
    'vary',
    'reference',
    'canvas',
    'enhance',
    'download',
    'favorite',
    'more',
  ])
  assert.equal(parseStudioDensity('pro'), 'pro')
  assert.equal(parseStudioDensity('simple'), 'simple')
  assert.equal(parseStudioDensity('nope'), 'simple')
})

test('job fact strip prefers native vs AI upscale without exposing raw API keys as the headline', () => {
  const native = jobFactStrip({
    model_id: 'imagen-4',
    actual_params: { size: '1024x1024', target_resolution: '' },
  })
  assert.equal(native.nativeOutput, true)
  assert.equal(native.aiUpscaled, false)

  const enhanced = jobFactStrip({
    model_id: 'imagen-4',
    actual_params: {
      target_resolution: '2K',
      upscale_model: 'general',
      warnings: ['Local AI upscaling was unavailable; used basic resizing instead.'],
      upscale: [
        {
          method: 'lanczos',
          width: 2048,
          height: 2048,
          device: 'cpu',
          duration_ms: 1800,
        },
      ],
    },
  })
  assert.equal(enhanced.nativeOutput, false)
  assert.equal(enhanced.aiUpscaled, false)
  assert.match(String(enhanced.fallbackReason), /resize|upscal/i)
  assert.equal(enhanced.outputSize, '2048 × 2048')

  const ai = jobFactStrip({
    actual_params: {
      upscale: [{ method: 'real-esrgan-ncnn-vulkan', model: 'realesrgan-x4plus', device: 'gpu', width: 4096, height: 4096 }],
    },
  })
  assert.equal(ai.aiUpscaled, true)
  assert.equal(ai.upscaleModel, 'realesrgan-x4plus')
})
