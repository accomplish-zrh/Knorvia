/**
 * §Phase D5 (§2.1 dual-track strategy): audio-mode chip logic, UI-free.
 *
 * Track 1 = TTS narration tool chain (always available, word-for-word control);
 * Track 2 = native audio baked into the model output (`audio_mode=generate`).
 * The composer renders audio modes as chips with explicit dual-track copy so a
 * user can tell "the model performs the audio" apart from "reference an audio
 * clip I attached" before spending a paid generation.
 */

import type { VideoAudioMode, VideoModelCapabilities } from '@/lib/video-studio-api'

/** Chip display order (§2.1: none → native generate → reference input). */
export const AUDIO_MODE_CHIP_ORDER: VideoAudioMode[] = ['none', 'generate', 'input']

/** Chip labels — the "generate" one must read as the NATIVE track (§D5). */
export const AUDIO_MODE_CHIP_LABELS: Record<VideoAudioMode, string> = {
  none: 'No audio',
  generate: 'Native audio (model performs)',
  input: 'Reference input audio',
}

/** Advertised audio modes in chip order; unknown values keep their position at the end. */
export function audioModeChips(capabilities?: VideoModelCapabilities | null): VideoAudioMode[] {
  const modes = (capabilities?.audio_modes || []).filter(
    (mode): mode is VideoAudioMode => typeof mode === 'string' && mode.length > 0
  )
  const ordered = AUDIO_MODE_CHIP_ORDER.filter(mode => modes.includes(mode))
  for (const mode of modes) if (!ordered.includes(mode)) ordered.push(mode)
  return ordered
}

/** §D5: does this model declare the native (generate) audio track? */
export function supportsNativeAudio(capabilities?: VideoModelCapabilities | null): boolean {
  return audioModeChips(capabilities).includes('generate')
}

/** The dual-track caption shown under the chips (key into AUDIO_TRACK_CAPTIONS). */
export type AudioTrackCaptionKey = 'none' | 'generate' | 'input'

/**
 * Which §2.1 scenario caption belongs under the chips. The caption tracks the
 * *selected* mode (the user reads it right where they choose): the native
 * caption only ever appears when the model really advertises `generate`, and a
 * "generate" selection on a model that lost the capability falls back to the
 * neutral line instead of promising audio the provider will not render.
 */
export function audioTrackCaption(
  capabilities: VideoModelCapabilities | null | undefined,
  selected: VideoAudioMode | ''
): AudioTrackCaptionKey {
  if (selected === 'input') return 'input'
  if (selected === 'generate' && supportsNativeAudio(capabilities)) return 'generate'
  return 'none'
}

/** The caption copy per §2.1's scene-dispatch rules. */
export const AUDIO_TRACK_CAPTIONS: Record<AudioTrackCaptionKey, string> = {
  generate:
    'Track 2 — native audio: the model performs dialogue and effects itself. Keep TTS narration when you need word-for-word lines or a consistent voice.',
  input:
    'Reference audio: attach an audio clip below and the model follows it. Narration and music still compose separately at export.',
  none:
    'Silent video. Narration (TTS), background music and subtitles are layered at export — you control every word.',
}
