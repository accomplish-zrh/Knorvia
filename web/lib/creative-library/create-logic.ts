export const CREATION_MODES = ['agent', 'image', 'video'] as const
export type CreationMode = (typeof CREATION_MODES)[number]

export const LIBRARY_KINDS = ['all', 'text', 'image', 'video'] as const
export type LibraryKindFilter = (typeof LIBRARY_KINDS)[number]

const VIDEO_MARKERS = [
  'video',
  'clip',
  'animate',
  'animation',
  '视频',
  '短片',
  '动画',
  '镜头',
  '首帧',
  '尾帧',
]

export function inferCreateMode(
  prompt: string,
  requested: CreationMode,
  extras: { hasLastFrame?: boolean; hasVideoRef?: boolean } = {}
): CreationMode {
  if (requested === 'image' || requested === 'video') return requested
  const text = prompt || ''
  const lowered = text.toLowerCase()
  if (extras.hasLastFrame || extras.hasVideoRef) return 'video'
  if (VIDEO_MARKERS.some(marker => lowered.includes(marker) || text.includes(marker))) return 'video'
  return 'image'
}

export function canSubmitCreate(input: {
  prompt: string
  mode: CreationMode
  smartPlanning: boolean
  modelKey: string
  firstFrameId: string
  lastFrameId: string
  referenceMode?: string
}): { ok: true } | { ok: false; reason: string } {
  if (!input.prompt.trim()) return { ok: false, reason: 'Describe what you want to create.' }
  if (!input.smartPlanning && !input.modelKey) {
    return { ok: false, reason: 'Pick a model or turn smart planning back on.' }
  }
  const mode = inferCreateMode(input.prompt, input.mode)
  const frames = input.referenceMode || (input.lastFrameId ? 'first-last' : input.firstFrameId ? 'first-frame' : '')
  if (mode === 'video' && frames === 'first-frame' && !input.firstFrameId) {
    return { ok: false, reason: 'Add a first-frame image.' }
  }
  if (mode === 'video' && frames === 'first-last' && (!input.firstFrameId || !input.lastFrameId)) {
    return { ok: false, reason: 'Add both first-frame and last-frame images.' }
  }
  return { ok: true }
}

export function parseCustomPixels(value: string): { width: number; height: number } | null {
  const match = String(value || '').match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/i)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (width < 256 || height < 256 || width > 8192 || height > 8192) return null
  return { width, height }
}

export function mentionLibraryAsset(prompt: string, assetId: string): string {
  const token = `@[${assetId}]`
  if (prompt.includes(token)) return prompt
  const trimmed = prompt.replace(/@([^\s@[\]]*)$/, '')
  const prefix = trimmed && !trimmed.endsWith(' ') && !trimmed.endsWith('\n') ? `${trimmed} ` : trimmed
  return `${prefix}${token} `
}

export function extractLibraryMentions(prompt: string): string[] {
  const ids: string[] = []
  for (const match of prompt.matchAll(/@\[([^\]]+)\]/g)) {
    if (match[1] && !ids.includes(match[1])) ids.push(match[1])
  }
  return ids
}

export function chatHandoffHref(extras: { assetId?: string } = {}): string {
  const search = new URLSearchParams()
  if (extras.assetId) search.set('library', extras.assetId)
  const query = search.toString()
  return query ? `/home?${query}` : '/home'
}

export function studioHandoffHref(
  studio: 'image' | 'video',
  extras: { assetId?: string; prompt?: string; projectId?: string; jobId?: string } = {}
): string {
  const path = studio === 'video' ? '/video-studio' : '/image-studio'
  const search = new URLSearchParams()
  if (extras.assetId) search.set('libraryAsset', extras.assetId)
  if (extras.prompt) search.set('prompt', extras.prompt)
  if (extras.projectId) search.set('project', extras.projectId)
  if (extras.jobId) search.set('job', extras.jobId)
  const query = search.toString()
  return query ? `${path}?${query}` : path
}
