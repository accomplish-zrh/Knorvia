'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Sparkles, X } from 'lucide-react'
import { startCanvasRun } from '@/lib/creative-library-api'

export function StudioAgentPanel({
  open,
  onClose,
  studio,
  projectId,
  prompt,
  modelKey,
  selectedIds,
  language,
  onStarted,
}: {
  open: boolean
  onClose: () => void
  studio: 'image' | 'video'
  projectId: string
  prompt: string
  modelKey?: string
  selectedIds?: string[]
  language?: string
  onStarted?: (jobIds: string[]) => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [smartPlanning, setSmartPlanning] = useState(true)

  if (!open) return null

  async function run() {
    if (!projectId || !prompt.trim()) {
      setError(t('Describe what you want to create.'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const run = await startCanvasRun(studio, projectId, {
        prompt: prompt.trim(),
        language,
        selected_ids: selectedIds,
        model_key: modelKey,
        smart_planning: smartPlanning,
      })
      onStarted?.(run.job_ids || [])
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Canvas agent run failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-studio-agent-panel=""
      className="absolute right-3 bottom-36 z-20 w-[min(360px,calc(100%-24px))] rounded-2xl border border-[var(--border)] bg-[var(--card)] p-3 shadow-lg"
    >
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="text-[var(--primary)]" />
        <div className="text-[13px] font-medium">{t('Canvas Agent')}</div>
        <button type="button" onClick={onClose} className="ml-auto rounded-lg p-1 hover:bg-[var(--muted)]" aria-label={t('Close')}>
          <X size={14} />
        </button>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-[var(--muted-foreground)]">
        {t('The agent reads this board, adds a brief and a generate card, then starts the job through the studio.')}
      </p>
      <label className="mt-3 flex items-center gap-2 text-[12px]">
        <input
          type="checkbox"
          checked={smartPlanning}
          onChange={event => setSmartPlanning(event.target.checked)}
        />
        {t('Smart planning')}
      </label>
      {error ? <p className="mt-2 text-[12px] text-[var(--destructive)]">{error}</p> : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--primary)] px-3 text-[12px] font-medium text-[var(--primary-foreground)] disabled:opacity-50"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
        {t('Run on canvas')}
      </button>
    </div>
  )
}
