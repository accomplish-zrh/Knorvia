'use client'

import { FilePlus2, Loader2, Plus, Save, Scissors, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  saveVideoSubtitleAsset,
  updateVideoSubtitleAsset,
  videoAssetUrl,
  type VideoAsset,
} from '@/lib/video-studio-api'
import {
  addCueAfter,
  adjustCueBound,
  cuesHaveIssues,
  cueIssue,
  draftCues,
  formatTimecode,
  parseSrt,
  parseTimecode,
  removeCue,
  sanitizeCues,
  serializeSrt,
  shiftCues,
  splitCue,
  type SubtitleCue,
} from '@/lib/video-studio/subtitle-logic'

/**
 * §Phase D2 subtitle editor: a table of SRT cues (timecode + text inline),
 * add/remove/split (自动断句) rows, global ±0.5 s fine-tuning, and saving the
 * document as a `subtitle` project asset (MIME application/x-subrip) that the
 * compose panel can burn via mode="from_asset".
 *
 * Editing model: `cues` (numeric seconds) is the source of truth; while a
 * timecode field is being typed its raw string lives in `timeDrafts` so
 * half-finished input is neither clobbered nor rejected. Structural edits
 * (add/remove/split/shift/nudge) run through the pure subtitle-logic helpers,
 * and Save serializes `sanitizeCues(cues)` — issues block the save instead of
 * silently dropping rows.
 */
export function SubtitleEditor({
  projectId,
  assets,
  onAssetSaved,
}: {
  projectId: string
  assets: VideoAsset[]
  onAssetSaved?: (asset: VideoAsset) => void
}) {
  const { t } = useTranslation()
  const [cues, setCues] = useState<SubtitleCue[]>(() => draftCues())
  const [timeDrafts, setTimeDrafts] = useState<Record<string, string>>({})
  const [loadedAssetId, setLoadedAssetId] = useState('')
  const [filename, setFilename] = useState('subtitles.srt')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const subtitleAssets = assets.filter(asset => asset.kind === 'subtitle')
  const loadedAsset = subtitleAssets.find(asset => asset.id === loadedAssetId) || null
  const hasIssues = cuesHaveIssues(cues)
  const canSave = !busy && !hasIssues && sanitizeCues(cues).length > 0

  const draftKey = (index: number, field: 'start' | 'end') => `${index}:${field}`
  const displayTime = (cue: SubtitleCue, index: number, field: 'start' | 'end') =>
    timeDrafts[draftKey(index, field)] ?? formatTimecode(cue[field])

  /** Typing keeps the raw string; a parsable value also updates the cue. */
  const editTime = (index: number, field: 'start' | 'end', value: string) => {
    setTimeDrafts(current => ({ ...current, [draftKey(index, field)]: value }))
    const seconds = parseTimecode(value)
    if (seconds === null) return
    setCues(current =>
      current.map((cue, position) => (position === index ? { ...cue, [field]: seconds } : cue))
    )
  }
  const commitTime = (index: number, field: 'start' | 'end') => {
    setTimeDrafts(current => {
      const next = { ...current }
      delete next[draftKey(index, field)]
      return next
    })
  }

  const nudge = (index: number, field: 'start' | 'end', delta: number) => {
    setTimeDrafts({})
    setCues(current => adjustCueBound(current, index, field, delta))
  }

  const startNewDocument = () => {
    setTimeDrafts({})
    setCues(draftCues())
    setLoadedAssetId('')
    setFilename('subtitles.srt')
    setNotice(null)
  }

  const loadAsset = async (assetId: string) => {
    if (!assetId) {
      startNewDocument()
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const response = await fetch(videoAssetUrl(assetId), { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const content = await response.text()
      const parsed = parseSrt(content)
      if (!parsed.length) throw new Error('empty')
      setTimeDrafts({})
      setCues(parsed)
      setLoadedAssetId(assetId)
      const asset = subtitleAssets.find(item => item.id === assetId)
      if (asset?.filename) setFilename(asset.filename)
    } catch {
      setNotice({ kind: 'error', text: t('Could not load the subtitle file.') })
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!canSave) {
      setNotice({ kind: 'error', text: t('Fix the highlighted cues before saving.') })
      return
    }
    setBusy(true)
    setNotice(null)
    const content = serializeSrt(sanitizeCues(cues))
    try {
      const asset = loadedAsset
        ? await updateVideoSubtitleAsset(loadedAsset.id, { content, filename })
        : await saveVideoSubtitleAsset(projectId, { content, filename: filename || 'subtitles.srt' })
      setLoadedAssetId(asset.id)
      onAssetSaved?.(asset)
      setNotice({ kind: 'ok', text: t('Subtitles saved as a project asset.') })
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : t('Could not save the subtitles.'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-[var(--border)]/60" data-subtitle-editor="">
      <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
        <span className="text-[10.5px] font-medium">{t('Subtitle editor')}</span>
        <span className="text-[9px] text-[var(--muted-foreground)]">
          {t('{{count}} cue(s)', { count: cues.length })}
          {loadedAsset ? ` · ${loadedAsset.filename}` : ''}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <select
            value={loadedAssetId}
            disabled={busy || !subtitleAssets.length}
            onChange={event => void loadAsset(event.target.value)}
            aria-label={t('Load saved subtitles')}
            className="h-7 max-w-40 rounded-lg border border-[var(--border)] bg-[var(--background)] px-1.5 text-[10px] text-[var(--foreground)] outline-none disabled:opacity-50"
          >
            <option value="">{t('New subtitle document')}</option>
            {subtitleAssets.map(asset => (
              <option key={asset.id} value={asset.id}>{asset.filename}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={startNewDocument}
            aria-label={t('New subtitle document')}
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-[var(--border)] px-2 text-[10px] hover:bg-[var(--muted)]/45 disabled:opacity-50"
          >
            <FilePlus2 size={11} /> {t('New')}
          </button>
          <button
            type="button"
            disabled={busy || !cues.length}
            onClick={() => {
              setTimeDrafts({})
              setCues(current => shiftCues(current, -0.5))
            }}
            aria-label={t('Shift all cues earlier')}
            className="h-7 rounded-lg border border-[var(--border)] px-2 text-[10px] hover:bg-[var(--muted)]/45 disabled:opacity-50"
          >
            {t('−0.5s')}
          </button>
          <button
            type="button"
            disabled={busy || !cues.length}
            onClick={() => {
              setTimeDrafts({})
              setCues(current => shiftCues(current, 0.5))
            }}
            aria-label={t('Shift all cues later')}
            className="h-7 rounded-lg border border-[var(--border)] px-2 text-[10px] hover:bg-[var(--muted)]/45 disabled:opacity-50"
          >
            {t('+0.5s')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setTimeDrafts({})
              setCues(current => addCueAfter(current, current.length - 1))
            }}
            aria-label={t('Add cue')}
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-[var(--border)] px-2 text-[10px] hover:bg-[var(--muted)]/45 disabled:opacity-50"
          >
            <Plus size={11} /> {t('Add cue')}
          </button>
        </div>
      </div>

      <div className="max-h-72 overflow-auto border-t border-[var(--border)]/50">
        <table className="w-full border-collapse text-[10px]">
          <thead className="sticky top-0 bg-[var(--card)] text-[9px] text-[var(--muted-foreground)]">
            <tr>
              <th scope="col" className="w-8 px-1.5 py-1.5 text-left font-medium">#</th>
              <th scope="col" className="w-[118px] px-1.5 py-1.5 text-left font-medium">{t('Start')}</th>
              <th scope="col" className="w-[118px] px-1.5 py-1.5 text-left font-medium">{t('End')}</th>
              <th scope="col" className="px-1.5 py-1.5 text-left font-medium">{t('Text')}</th>
              <th scope="col" className="w-[74px] px-1.5 py-1.5 text-right font-medium">{t('Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {cues.map((cue, index) => {
              const issue = cueIssue(cue)
              return (
                <tr key={index} data-cue-row={index} className="border-t border-[var(--border)]/40 align-top">
                  <td className="px-1.5 py-1.5 tabular-nums text-[var(--muted-foreground)]">{index + 1}</td>
                  <td className="px-1.5 py-1.5">
                    <div className="flex items-center gap-0.5">
                      <input
                        type="text"
                        value={displayTime(cue, index, 'start')}
                        onChange={event => editTime(index, 'start', event.target.value)}
                        onBlur={() => commitTime(index, 'start')}
                        aria-label={t('Cue start timecode')}
                        data-cue-field="start"
                        className={`h-7 w-full rounded-md border bg-[var(--background)] px-1.5 font-mono text-[9.5px] tabular-nums text-[var(--foreground)] outline-none ${
                          issue === 'timing' ? 'border-red-500/70' : 'border-[var(--border)]'
                        }`}
                      />
                      <span className="flex flex-col">
                        <button type="button" onClick={() => nudge(index, 'start', 0.1)} aria-label={t('Nudge cue start later')} className="h-3 px-0.5 text-[8px] leading-none text-[var(--muted-foreground)] hover:text-[var(--foreground)]">▲</button>
                        <button type="button" onClick={() => nudge(index, 'start', -0.1)} aria-label={t('Nudge cue start earlier')} className="h-3 px-0.5 text-[8px] leading-none text-[var(--muted-foreground)] hover:text-[var(--foreground)]">▼</button>
                      </span>
                    </div>
                  </td>
                  <td className="px-1.5 py-1.5">
                    <div className="flex items-center gap-0.5">
                      <input
                        type="text"
                        value={displayTime(cue, index, 'end')}
                        onChange={event => editTime(index, 'end', event.target.value)}
                        onBlur={() => commitTime(index, 'end')}
                        aria-label={t('Cue end timecode')}
                        data-cue-field="end"
                        className={`h-7 w-full rounded-md border bg-[var(--background)] px-1.5 font-mono text-[9.5px] tabular-nums text-[var(--foreground)] outline-none ${
                          issue === 'timing' ? 'border-red-500/70' : 'border-[var(--border)]'
                        }`}
                      />
                      <span className="flex flex-col">
                        <button type="button" onClick={() => nudge(index, 'end', 0.1)} aria-label={t('Nudge cue end later')} className="h-3 px-0.5 text-[8px] leading-none text-[var(--muted-foreground)] hover:text-[var(--foreground)]">▲</button>
                        <button type="button" onClick={() => nudge(index, 'end', -0.1)} aria-label={t('Nudge cue end earlier')} className="h-3 px-0.5 text-[8px] leading-none text-[var(--muted-foreground)] hover:text-[var(--foreground)]">▼</button>
                      </span>
                    </div>
                  </td>
                  <td className="px-1.5 py-1.5">
                    <input
                      type="text"
                      value={cue.text}
                      onChange={event =>
                        setCues(current =>
                          current.map((item, position) =>
                            position === index ? { ...item, text: event.target.value } : item
                          )
                        )
                      }
                      aria-label={t('Cue text')}
                      data-cue-field="text"
                      className={`h-7 w-full rounded-md border bg-[var(--background)] px-1.5 text-[10px] text-[var(--foreground)] outline-none ${
                        issue === 'text' ? 'border-red-500/70' : 'border-[var(--border)]'
                      }`}
                    />
                    {issue ? (
                      <p className="mt-0.5 text-[8.5px] text-red-500">
                        {issue === 'text' ? t('Cue text is empty.') : t('End must be after start.')}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-1.5 py-1.5">
                    <div className="flex items-center justify-end gap-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          setTimeDrafts({})
                          setCues(current => splitCue(current, index))
                        }}
                        aria-label={t('Split cue at sentence boundary')}
                        title={t('Split cue at sentence boundary')}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)]/50 hover:text-[var(--foreground)]"
                      >
                        <Scissors size={11} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setTimeDrafts({})
                          setCues(current => addCueAfter(current, index))
                        }}
                        aria-label={t('Add cue below')}
                        title={t('Add cue below')}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)]/50 hover:text-[var(--foreground)]"
                      >
                        <Plus size={11} />
                      </button>
                      <button
                        type="button"
                        disabled={cues.length <= 1}
                        onClick={() => {
                          setTimeDrafts({})
                          setCues(current => removeCue(current, index))
                        }}
                        aria-label={t('Remove cue')}
                        title={t('Remove cue')}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)]/50 hover:text-[var(--destructive)] disabled:opacity-40"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)]/50 px-2.5 py-2">
        <label className="flex items-center gap-1.5 text-[9px] text-[var(--muted-foreground)]">
          {t('Filename')}
          <input
            type="text"
            value={filename}
            onChange={event => setFilename(event.target.value)}
            aria-label={t('Filename')}
            className="h-7 w-40 rounded-lg border border-[var(--border)] bg-[var(--background)] px-1.5 text-[10px] text-[var(--foreground)] outline-none"
          />
        </label>
        <button
          type="button"
          disabled={!canSave}
          onClick={() => void save()}
          className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-2.5 text-[10.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
          {loadedAsset ? t('Update subtitles') : t('Save subtitles')}
        </button>
      </div>

      {notice ? (
        <p
          role="status"
          className={`border-t border-[var(--border)]/50 px-2.5 py-1.5 text-[9.5px] ${
            notice.kind === 'error' ? 'text-[var(--destructive)]' : 'text-[var(--muted-foreground)]'
          }`}
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  )
}
