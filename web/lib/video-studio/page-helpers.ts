/**
 * Pure constants and helpers extracted from the video studio page component
 * (staged decomposition per scripts/architecture_guard.py). No React, no
 * hooks — safe to unit-test in isolation.
 */

import type { VideoJob } from "@/lib/video-studio-api";
import type { BoardTemplateId } from "@/lib/video-studio/board-logic";
import type { VideoSettings } from "@/lib/video-studio/studio-logic";

/** Persisted `storyboard | board` workbench view (§5.2). */
export const VIDEO_VIEW_STORAGE_KEY = 'knorvia.video-studio.view'
/** §5.5 template menu — values are i18n keys, placement is server-side. */
export const BOARD_TEMPLATE_LABELS: Record<BoardTemplateId, string> = {
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

export const EMPTY_SETTINGS: VideoSettings = {
  duration: '',
  aspectRatio: '',
  resolution: '',
  fps: '',
  audioMode: 'none',
  seed: '',
  referenceMode: '',
  extra: {},
}

export function replaceJob(items: VideoJob[], job: VideoJob) {
  const found = items.some(item => item.id === job.id)
  return found ? items.map(item => (item.id === job.id ? job : item)) : [job, ...items]
}

export function validationLabel(reason: string | undefined, t: (key: string) => string) {
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

export function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}
