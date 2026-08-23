'use client'

import { Loader2, Volume2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { previewVoice } from '@/lib/voice-api'
import { previewCacheKey, type VoiceOption } from '@/lib/video-studio/voice-logic'
import { useArmedPaidAction } from './useArmedPaidAction'

/**
 * §Phase D4: voice id input + audition. The input stays free-form (a voice id
 * is a provider string like "FunAudioLLM/CosyVoice2-0.5B:alex") but the
 * enumerated catalog feeds a datalist so configured voices are one keystroke
 * away. Auditioning is ONE paid TTS call per click: two-step armed confirm,
 * then the clip is cached per voice id and replays for free.
 */

/** Module-level audition cache: voice id → blob URL (the sample text is fixed). */
const previewUrlCache = new Map<string, string>()

export function VoicePicker({
  value,
  onChange,
  voices,
  disabled,
}: {
  value: string
  onChange: (voice: string) => void
  voices: VoiceOption[]
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const [previewing, setPreviewing] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')
  const [previewError, setPreviewError] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const trimmed = value.trim()
  const auditionGuard = useArmedPaidAction(`voice-preview:${trimmed}`)

  // The hidden player follows the latest cached clip; a cached clip replays
  // without touching the provider again.
  useEffect(() => {
    if (!trimmed) {
      setPreviewUrl('')
      return
    }
    setPreviewUrl(previewUrlCache.get(previewCacheKey(trimmed)) || '')
  }, [trimmed])

  const playPreview = async (voice: string) => {
    const key = previewCacheKey(voice)
    const cached = previewUrlCache.get(key)
    if (cached) {
      const element = audioRef.current
      if (element) {
        element.src = cached
        void element.play().catch(() => undefined)
      }
      return
    }
    setPreviewing(true)
    setPreviewError('')
    try {
      const blob = await previewVoice(voice)
      const url = URL.createObjectURL(blob)
      previewUrlCache.set(key, url)
      setPreviewUrl(url)
      const element = audioRef.current
      if (element) {
        element.src = url
        void element.play().catch(() => undefined)
      }
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : t('Could not play the voice preview.'))
    } finally {
      setPreviewing(false)
    }
  }

  const armed = auditionGuard.armed(trimmed || 'empty')
  return (
    <span
      data-voice-picker=""
      className="flex min-w-0 shrink-0 items-center gap-1"
    >
      <input
        value={value}
        maxLength={160}
        list="video-voice-options"
        placeholder={t('Voice')}
        aria-label={t('Voice')}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
        className="h-7 w-24 min-w-0 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[10px] text-[var(--foreground)] outline-none"
      />
      {voices.length ? (
        <datalist id="video-voice-options">
          {voices.map(voice => (
            <option key={voice.id} value={voice.id}>{voice.label}</option>
          ))}
        </datalist>
      ) : null}
      <button
        type="button"
        disabled={disabled || previewing || !trimmed}
        title={t('Audition this voice — one paid synthesis of the sample line.')}
        onClick={() => {
          if (armed) {
            auditionGuard.disarm()
            void playPreview(trimmed)
          } else {
            auditionGuard.arm(trimmed || 'empty')
          }
        }}
        className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[10px] font-medium transition-colors ${
          armed
            ? 'bg-[var(--primary)] text-white'
            : 'border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--muted)]/45'
        } disabled:opacity-50`}
      >
        {previewing ? <Loader2 size={11} className="animate-spin" /> : <Volume2 size={11} />}
        {armed ? t('Confirm — paid') : t('Audition')}
      </button>
      <audio
        ref={audioRef}
        data-voice-preview=""
        controls={Boolean(previewUrl)}
        preload="none"
        className={previewUrl ? 'h-7 w-28' : 'pointer-events-none absolute h-0 w-0 opacity-0'}
      />
      {previewError ? (
        <span className="max-w-32 truncate text-[8.5px] text-[var(--destructive)]" role="status">
          {previewError}
        </span>
      ) : null}
    </span>
  )
}
