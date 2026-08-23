export const PRODUCTION_STAGES = [
  'script',
  'review',
  'cast',
  'storyboard',
  'shots',
  'voice',
  'compose',
] as const

export type ProductionStage = (typeof PRODUCTION_STAGES)[number]
export type ProductionReviewStatus = 'draft' | 'confirmed' | 'rejected'

export type ProductionNamedRow = {
  id: string
  name: string
  description: string
  setting?: string
  characters?: string[]
}

export type ProductionShotDraft = {
  id: string
  scene_id: string
  title: string
  prompt: string
  dialogue: string
  duration: number
  camera: string
  characters: string[]
}

export type VideoProduction = {
  version: 1
  stage: ProductionStage
  script: {
    title: string
    text: string
    language: 'en' | 'zh' | string
    source: string
  }
  analysis: {
    title: string
    logline: string
    scenes: ProductionNamedRow[]
    characters: ProductionNamedRow[]
    locations: ProductionNamedRow[]
    shots: ProductionShotDraft[]
  }
  review: {
    status: ProductionReviewStatus
    notes: string
    confirmed_at: number | null
    script_hash: string
  }
}

export type ProductionReadiness = {
  script: boolean
  analysis: boolean
  review: boolean
  cast: { needed: string[]; bound: string[]; ready: boolean }
  storyboard: { shots: number; ready: boolean }
  keyframes: { ready: number; total: number }
  videos: { ready: number; total: number }
  voice: { ready: number; total: number }
  compose: boolean
}

export const PRODUCTION_STAGE_LABELS: Record<ProductionStage, string> = {
  script: 'Script',
  review: 'Review',
  cast: 'Cast',
  storyboard: 'Storyboard',
  shots: 'Shots',
  voice: 'Voice',
  compose: 'Export',
}

export function emptyVideoProduction(): VideoProduction {
  return {
    version: 1,
    stage: 'script',
    script: { title: '', text: '', language: 'en', source: 'paste' },
    analysis: { title: '', logline: '', scenes: [], characters: [], locations: [], shots: [] },
    review: { status: 'draft', notes: '', confirmed_at: null, script_hash: '' },
  }
}

export function isProductionStage(value: unknown): value is ProductionStage {
  return PRODUCTION_STAGES.includes(value as ProductionStage)
}

export function stageWorkbenchView(
  stage: ProductionStage
): 'production' | 'storyboard' {
  return stage === 'script' || stage === 'review' ? 'production' : 'storyboard'
}

export function stageReady(
  stage: ProductionStage,
  readiness: ProductionReadiness | null
): boolean {
  if (!readiness) return false
  if (stage === 'script') return readiness.script
  if (stage === 'review') return readiness.review
  if (stage === 'cast') return readiness.cast.ready
  if (stage === 'storyboard') return readiness.storyboard.ready
  if (stage === 'shots') return readiness.videos.ready > 0
  if (stage === 'voice') return readiness.voice.ready > 0
  return readiness.compose
}

export function nextProductionAction(
  readiness: ProductionReadiness | null
): ProductionStage {
  if (!readiness) return 'script'
  if (!readiness.script) return 'script'
  if (!readiness.analysis) return 'script'
  if (!readiness.review) return 'review'
  if (!readiness.storyboard.ready) return 'review'
  if (!readiness.videos.ready) return 'shots'
  if (!readiness.compose) return 'compose'
  return 'compose'
}
