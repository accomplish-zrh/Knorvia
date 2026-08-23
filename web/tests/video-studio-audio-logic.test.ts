import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AUDIO_MODE_CHIP_LABELS,
  audioModeChips,
  audioTrackCaption,
  supportsNativeAudio,
} from '../lib/video-studio/audio-logic'
import {
  BGM_FADE_BOUNDS,
  BGM_VOLUME_BOUNDS,
  NEUTRAL_BGM_SLOT,
  bgmSlotDiff,
  bgmSlotFromProject,
  bgmSlotHasMusic,
  composeAudioPayload,
  normalizeBgmSlot,
} from '../lib/video-studio/bgm-logic'
import {
  EMPTY_VOICE_CATALOG,
  defaultVoiceId,
  isKnownVoice,
  normalizeVoiceCatalog,
  previewCacheKey,
} from '../lib/video-studio/voice-logic'

test('audio chips order native modes and keep unknowns at the end', () => {
  assert.deepEqual(audioModeChips({ audio_modes: ['generate', 'none', 'input'] }), [
    'none',
    'generate',
    'input',
  ])
  assert.deepEqual(audioModeChips({ audio_modes: ['generate'] }), ['generate'])
  assert.deepEqual(audioModeChips({ audio_modes: ['mystery', 'generate'] as never }), [
    'generate',
    'mystery',
  ])
  assert.deepEqual(audioModeChips(undefined), [])
  assert.deepEqual(audioModeChips({ audio_modes: ['', null] as never }), [])
})

test('supportsNativeAudio reflects the declared generate track', () => {
  assert.equal(supportsNativeAudio({ audio_modes: ['none', 'generate'] }), true)
  assert.equal(supportsNativeAudio({ audio_modes: ['none'] }), false)
  assert.equal(supportsNativeAudio(null), false)
})

test('track caption never promises native audio the model lacks', () => {
  assert.equal(audioTrackCaption({ audio_modes: ['generate'] }, 'generate'), 'generate')
  assert.equal(audioTrackCaption({ audio_modes: ['none'] }, 'generate'), 'none')
  assert.equal(audioTrackCaption({ audio_modes: ['none'] }, 'input'), 'input')
  assert.equal(audioTrackCaption(undefined, ''), 'none')
  assert.equal(audioTrackCaption(undefined, 'none'), 'none')
})

test('chip labels distinguish native generate from reference input (§2.1)', () => {
  assert.match(AUDIO_MODE_CHIP_LABELS.generate, /native/i)
  assert.match(AUDIO_MODE_CHIP_LABELS.input, /reference/i)
})

test('bgm bounds mirror the backend store ranges', () => {
  assert.deepEqual(BGM_VOLUME_BOUNDS, { min: 0, max: 2, step: 0.05, fallback: 0.6 })
  assert.deepEqual(BGM_FADE_BOUNDS, { min: 0, max: 10, step: 0.5, fallback: 1 })
  assert.deepEqual(NEUTRAL_BGM_SLOT, {
    bgm_asset_id: '',
    bgm_volume: 0.6,
    bgm_fade_in: 1,
    bgm_fade_out: 1,
  })
})

test('bgmSlotFromProject tolerates missing and clamps out-of-range values', () => {
  assert.deepEqual(bgmSlotFromProject(undefined), NEUTRAL_BGM_SLOT)
  assert.deepEqual(bgmSlotFromProject({ bgm_asset_id: null }), NEUTRAL_BGM_SLOT)
  const clamped = bgmSlotFromProject({
    bgm_asset_id: 'music-1',
    bgm_volume: 9,
    bgm_fade_in: -3,
    bgm_fade_out: 99,
  })
  assert.equal(clamped.bgm_volume, 2)
  assert.equal(clamped.bgm_fade_in, 0)
  assert.equal(clamped.bgm_fade_out, 10)
})

test('normalizeBgmSlot falls back on non-numeric input and clamps', () => {
  const slot = normalizeBgmSlot({ bgm_asset_id: 'x', bgm_volume: NaN, bgm_fade_in: 0.4 })
  assert.equal(slot.bgm_volume, 0.6)
  assert.equal(slot.bgm_fade_in, 0.4)
  assert.equal(slot.bgm_asset_id, 'x')
})

test('bgmSlotDiff emits only changed fields and drives the PATCH body', () => {
  assert.deepEqual(bgmSlotDiff(NEUTRAL_BGM_SLOT, NEUTRAL_BGM_SLOT), {})
  const after = { ...NEUTRAL_BGM_SLOT, bgm_volume: 0.9, bgm_fade_out: 2 }
  assert.deepEqual(bgmSlotDiff(NEUTRAL_BGM_SLOT, after), { bgm_volume: 0.9, bgm_fade_out: 2 })
})

test('bgm slot presence gates the music bed and compose payload stays lean', () => {
  assert.equal(bgmSlotHasMusic(NEUTRAL_BGM_SLOT), false)
  assert.equal(bgmSlotHasMusic({ ...NEUTRAL_BGM_SLOT, bgm_asset_id: 'a' }), true)
  assert.deepEqual(composeAudioPayload(true), { voiceovers: true })
  assert.deepEqual(composeAudioPayload(false), { voiceovers: false })
})

test('voice catalog normalizes, de-dupes case-insensitively and drops junk', () => {
  assert.deepEqual(normalizeVoiceCatalog(null), EMPTY_VOICE_CATALOG)
  const payload = {
    voices: [
      { id: 'nova', label: 'Nova', provider: 'openai' },
      { id: 'NOVA', label: 'dup', provider: 'openai' },
      { id: '  ', label: 'blank' },
      42,
      null,
      { id: 'echo' },
    ],
    active_voice: 'nova',
    model: 'tts-1',
    provider: 'openai',
  }
  const catalog = normalizeVoiceCatalog(payload)
  assert.deepEqual(catalog.voices, [
    { id: 'nova', label: 'Nova', provider: 'openai' },
    { id: 'echo', label: 'echo', provider: '' },
  ])
  assert.equal(catalog.active_voice, 'nova')
  assert.equal(catalog.model, 'tts-1')
})

test('default voice prefers last used, then active, then the first entry', () => {
  const catalog = normalizeVoiceCatalog({
    voices: [{ id: 'a' }, { id: 'b' }],
    active_voice: 'b',
  })
  assert.equal(defaultVoiceId(catalog, 'a'), 'a')
  assert.equal(defaultVoiceId(catalog, 'gone'), 'b')
  assert.equal(defaultVoiceId(normalizeVoiceCatalog({ voices: [{ id: 'x' }] }), ''), 'x')
  assert.equal(defaultVoiceId(EMPTY_VOICE_CATALOG, ''), '')
})

test('voice membership check and preview cache key', () => {
  const catalog = normalizeVoiceCatalog({ voices: [{ id: 'Nova' }] })
  assert.equal(isKnownVoice(catalog, 'nova'), true)
  assert.equal(isKnownVoice(catalog, 'echo'), false)
  assert.equal(isKnownVoice(EMPTY_VOICE_CATALOG, ''), false)
  assert.equal(previewCacheKey('  nova  '), 'voice-preview:nova')
})
