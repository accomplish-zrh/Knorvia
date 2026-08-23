/**
 * §Phase D4: voice (TTS) client for enumeration + audition.
 *
 * GET /voices is a free configuration read; POST /preview is one paid TTS call
 * per request and always carries `confirmed_cost: true` — the click itself is
 * the user's explicit confirmation of that single paid action.
 */

import { apiFetch, apiUrl } from '@/lib/api'
import type { VoiceCatalog } from '@/lib/video-studio/voice-logic'

const BASE = '/api/v1/voice'

export class VoiceApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'VoiceApiError'
    this.status = status
  }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const detail = payload?.detail
    const message =
      (typeof detail === 'string' ? detail : detail?.message) ||
      `Request failed (${response.status})`
    throw new VoiceApiError(message, response.status)
  }
  return response.json() as Promise<T>
}

/** §Phase D4: enumerate the active provider's voices (free, zero provider calls). */
export async function listVoices(signal?: AbortSignal): Promise<unknown> {
  return json(await apiFetch(apiUrl(`${BASE}/voices`), { cache: 'no-store', signal }))
}

/** §Phase D4: audition one voice with the fixed sample sentence (paid, one call). */
export async function previewVoice(voice: string, signal?: AbortSignal): Promise<Blob> {
  const response = await apiFetch(apiUrl(`${BASE}/preview`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice, confirmed_cost: true }),
    signal,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const detail = payload?.detail
    const message =
      (typeof detail === 'string' ? detail : detail?.message) ||
      `Voice preview failed (${response.status})`
    throw new VoiceApiError(message, response.status)
  }
  return response.blob()
}

export type { VoiceCatalog }
