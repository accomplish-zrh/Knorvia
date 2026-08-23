/**
 * §Phase D4: voice enumeration + audition logic (pure functions, UI-free).
 *
 * GET /api/v1/voice/voices is a free configuration read (whitelist + gateway
 * customs); POST /api/v1/voice/preview is one paid TTS call per click, so the
 * UI caches the audition clip per voice and never auto-fires.
 */

export type VoiceOption = {
  id: string
  label: string
  provider: string
}

export type VoiceCatalog = {
  voices: VoiceOption[]
  active_voice: string
  model: string
  provider: string
}

export const EMPTY_VOICE_CATALOG: VoiceCatalog = {
  voices: [],
  active_voice: '',
  model: '',
  provider: '',
}

function toVoiceOption(entry: unknown): VoiceOption | null {
  if (typeof entry !== 'object' || entry === null) return null
  const record = entry as Record<string, unknown>
  const id = String(record.id || '').trim()
  if (!id) return null
  return {
    id,
    label: String(record.label || id),
    provider: String(record.provider || ''),
  }
}

/** Tolerate any malformed enumeration payload: de-duped ids, stable order. */
export function normalizeVoiceCatalog(payload: unknown): VoiceCatalog {
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >
  const seen = new Set<string>()
  const voices: VoiceOption[] = []
  for (const entry of Array.isArray(record.voices) ? record.voices : []) {
    const option = toVoiceOption(entry)
    if (option && !seen.has(option.id.toLowerCase())) {
      seen.add(option.id.toLowerCase())
      voices.push(option)
    }
  }
  return {
    voices,
    active_voice: String(record.active_voice || ''),
    model: String(record.model || ''),
    provider: String(record.provider || ''),
  }
}

/** The default voice a shot should offer: the last used one, else the active. */
export function defaultVoiceId(catalog: VoiceCatalog, lastUsed: string): string {
  const trimmed = lastUsed.trim()
  if (trimmed && catalog.voices.some(voice => voice.id === trimmed)) return trimmed
  if (catalog.active_voice && catalog.voices.some(voice => voice.id === catalog.active_voice)) {
    return catalog.active_voice
  }
  return catalog.voices[0]?.id || ''
}

/** A voice id is a free-form provider string — always allow manual override. */
export function isKnownVoice(catalog: VoiceCatalog, voiceId: string): boolean {
  const trimmed = voiceId.trim().toLowerCase()
  if (!trimmed) return false
  return catalog.voices.some(voice => voice.id.toLowerCase() === trimmed)
}

/** Audition cache key: one clip per voice id (the sample text is fixed). */
export function previewCacheKey(voiceId: string): string {
  return `voice-preview:${voiceId.trim()}`
}
