'use client'

import {
  Check,
  Clapperboard,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { videoAssetUrl, type VideoAsset, type VideoCharacter } from '@/lib/video-studio-api'

/**
 * Two-step paid-action guard shared with the storyboard cards: first click
 * arms, second click within the window fires. The guard key pins the armed
 * state to one character so a stale confirm can never authorize another
 * character's paid generation.
 */
function useArmedPaidAction(key: string) {
  const [armedState, setArmed] = useState<{ id: string; key: string } | null>(null)
  useEffect(() => {
    if (!armedState) return
    const timer = window.setTimeout(() => setArmed(null), 6000)
    return () => window.clearTimeout(timer)
  }, [armedState])
  const arm = (id: string) => setArmed(current => (current?.id === id ? null : { id, key }))
  const armed = (id: string) => armedState !== null && armedState.id === id && armedState.key === key
  const disarm = () => setArmed(null)
  return { arm, armed, disarm }
}

export type CharacterDraft = {
  name: string
  description: string
  voice_hint: string
  reference_asset_ids: string[]
}

export function CharacterLibrary({
  characters,
  assets,
  loading,
  busyCharacterId,
  creating,
  limit = 50,
  onCreate,
  onUpdate,
  onDelete,
  onGenerateThreeView,
  onAddToBoard,
  onAddToComposer,
}: {
  characters: VideoCharacter[]
  assets: VideoAsset[]
  loading?: boolean
  busyCharacterId?: string | null
  creating?: boolean
  limit?: number
  onCreate: (draft: CharacterDraft) => void
  onUpdate: (character: VideoCharacter, patch: { name?: string; description?: string; voice_hint?: string }) => void
  onDelete: (character: VideoCharacter) => void
  onGenerateThreeView: (character: VideoCharacter) => void
  onAddToBoard: (character: VideoCharacter) => void
  onAddToComposer: (character: VideoCharacter) => void
}) {
  const { t } = useTranslation()
  const [creating_, setCreating_] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [voiceHint, setVoiceHint] = useState('')
  const [referenceIds, setReferenceIds] = useState<string[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editVoice, setEditVoice] = useState('')
  const threeViewGuard = useArmedPaidAction('three-view')

  const imageAssets = assets.filter(asset => asset.kind === 'image')
  const atLimit = characters.length >= limit

  const submitCreate = () => {
    const trimmed = name.trim()
    if (!trimmed || creating) return
    onCreate({ name: trimmed, description: description.trim(), voice_hint: voiceHint.trim(), reference_asset_ids: referenceIds })
    setCreating_(false)
    setName('')
    setDescription('')
    setVoiceHint('')
    setReferenceIds([])
  }

  const startEdit = (character: VideoCharacter) => {
    if (editingId === character.id) {
      setEditingId(null)
      return
    }
    setEditingId(character.id)
    setEditName(character.name)
    setEditVoice(character.voice_hint || '')
  }

  const submitEdit = (character: VideoCharacter) => {
    if (editName.trim()) onUpdate(character, { name: editName.trim(), voice_hint: editVoice.trim() })
    setEditingId(null)
  }

  const referenceThumb = (character: VideoCharacter): string | null => {
    const primary = character.three_view_asset_id || character.reference_asset_ids?.[0]
    return primary && imageAssets.some(asset => asset.id === primary) ? videoAssetUrl(primary) : null
  }

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t('Character library')}>
      <div className="flex items-center justify-between px-3.5 py-3">
        <div>
          <h2 className="text-xs font-semibold">{t('Character library')}</h2>
          <p className="mt-0.5 text-[10.5px] text-[var(--muted-foreground)]">
            {t('{{count}} character(s)', { count: characters.length })}
          </p>
        </div>
        <button
          type="button"
          disabled={creating || atLimit}
          onClick={() => setCreating_(current => !current)}
          title={atLimit ? t('Max {{count}} characters per project.', { count: limit }) : undefined}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-2.5 text-[11.5px] font-medium text-[var(--primary-foreground)] disabled:opacity-50"
        >
          {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={14} />}
          {t('New')}
        </button>
      </div>

      {creating_ ? (
        <div className="mx-3 mb-3 flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-2.5">
          <input
            value={name}
            maxLength={160}
            onChange={event => setName(event.target.value)}
            placeholder={t('Character name')}
            aria-label={t('Character name')}
            className="h-8 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[11px] outline-none focus:border-[var(--primary)]"
          />
          <textarea
            value={description}
            maxLength={4000}
            rows={2}
            onChange={event => setDescription(event.target.value)}
            placeholder={t('Character description')}
            aria-label={t('Character description')}
            className="resize-none rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[11px] outline-none focus:border-[var(--primary)]"
          />
          <input
            value={voiceHint}
            maxLength={160}
            onChange={event => setVoiceHint(event.target.value)}
            placeholder={t('Voice hint')}
            aria-label={t('Voice hint')}
            className="h-8 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[11px] outline-none focus:border-[var(--primary)]"
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium text-[var(--muted-foreground)]">{t('Reference images')}</span>
            {imageAssets.length ? (
              <div className="grid max-h-36 grid-cols-3 gap-1.5 overflow-y-auto">
                {imageAssets.map(asset => {
                  const picked = referenceIds.includes(asset.id)
                  return (
                    <button
                      key={asset.id}
                      type="button"
                      aria-pressed={picked}
                      aria-label={t('Use {{name}} as reference', { name: asset.filename })}
                      onClick={() =>
                        setReferenceIds(current =>
                          picked ? current.filter(id => id !== asset.id) : [...current, asset.id].slice(0, 50)
                        )
                      }
                      className={`relative aspect-square overflow-hidden rounded-lg border ${
                        picked ? 'border-[var(--primary)] ring-2 ring-[var(--primary)]/15' : 'border-[var(--border)]'
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={videoAssetUrl(asset.id)} alt="" loading="lazy" className="h-full w-full object-cover" />
                      {picked ? (
                        <span className="absolute top-1 left-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)]">
                          <Check size={10} />
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-[var(--border)] px-2 py-2 text-center text-[10px] text-[var(--muted-foreground)]">
                {t('Upload an image first, then pick it as the character reference.')}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setCreating_(false)}
              className="h-8 rounded-lg border border-[var(--border)] px-2.5 text-[11px] hover:bg-[var(--muted)]/45"
            >
              {t('Cancel')}
            </button>
            <button
              type="button"
              disabled={!name.trim() || creating}
              onClick={submitCreate}
              className="h-8 rounded-lg bg-[var(--primary)] px-2.5 text-[11px] font-medium text-[var(--primary-foreground)] disabled:opacity-50"
            >
              {t('Create')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {loading ? (
          <div className="flex h-32 items-center justify-center text-[var(--muted-foreground)]">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : characters.length ? (
          <div className="flex flex-col gap-2">
            {characters.map(character => {
              const thumb = referenceThumb(character)
              const busy = busyCharacterId === character.id
              const armed = threeViewGuard.armed(character.id)
              return (
                <div
                  key={character.id}
                  className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-2"
                >
                  <div className="flex items-start gap-2">
                    <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-[var(--muted)]/45">
                      {thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center text-[var(--muted-foreground)]">
                          <UserRound size={20} strokeWidth={1.4} />
                        </span>
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      {editingId === character.id ? (
                        <div className="flex flex-col gap-1.5">
                          <input
                            value={editName}
                            maxLength={160}
                            onChange={event => setEditName(event.target.value)}
                            aria-label={t('Character name')}
                            className="h-7 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[11px] outline-none focus:border-[var(--primary)]"
                          />
                          <input
                            value={editVoice}
                            maxLength={160}
                            onChange={event => setEditVoice(event.target.value)}
                            placeholder={t('Voice hint')}
                            aria-label={t('Voice hint')}
                            className="h-7 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 text-[11px] outline-none focus:border-[var(--primary)]"
                          />
                          <div className="flex justify-end gap-1">
                            <button type="button" onClick={() => setEditingId(null)} className="rounded-md p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]" aria-label={t('Cancel')}>
                              <X size={12} />
                            </button>
                            <button type="button" onClick={() => submitEdit(character)} className="rounded-md bg-[var(--primary)] p-1 text-[var(--primary-foreground)]" aria-label={t('Save')}>
                              <Check size={12} />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="truncate text-[11.5px] font-medium">{character.name}</p>
                          <p className="mt-0.5 truncate text-[9.5px] text-[var(--muted-foreground)]">
                            {character.voice_hint
                              ? t('Voice: {{voice}}', { voice: character.voice_hint })
                              : t('No voice hint')}
                          </p>
                          <p
                            className={`mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                              character.three_view_asset_id
                                ? 'bg-emerald-500/10 text-emerald-700'
                                : 'bg-amber-500/10 text-amber-700'
                            }`}
                          >
                            {character.three_view_asset_id ? t('Three-view ready') : t('Three-view pending')}
                          </p>
                        </>
                      )}
                    </div>
                    {editingId !== character.id ? (
                      <div className="flex shrink-0 flex-col gap-1">
                        <button type="button" onClick={() => startEdit(character)} aria-label={t('Rename character')} className="rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]">
                          <Pencil size={12} />
                        </button>
                        <button type="button" onClick={() => onDelete(character)} aria-label={t('Delete {{name}}', { name: character.name })} className="rounded-md p-1 text-[var(--muted-foreground)] hover:bg-red-500/10 hover:text-red-600">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <button
                      type="button"
                      onClick={() => onAddToBoard(character)}
                      className="inline-flex h-7 items-center gap-1 rounded-lg border border-[var(--border)] px-2 text-[10px] hover:bg-[var(--muted)]/45"
                    >
                      <Clapperboard size={11} /> {t('Add to canvas')}
                    </button>
                    <button
                      type="button"
                      onClick={() => onAddToComposer(character)}
                      className="inline-flex h-7 items-center gap-1 rounded-lg border border-[var(--border)] px-2 text-[10px] hover:bg-[var(--muted)]/45"
                    >
                      <Plus size={11} /> {t('Add to composer')}
                    </button>
                    <button
                      type="button"
                      disabled={busy || !character.reference_asset_ids.length}
                      title={
                        !character.reference_asset_ids.length
                          ? t('Add a reference image before generating a three-view sheet.')
                          : undefined
                      }
                      onClick={() => {
                        if (armed) {
                          threeViewGuard.disarm()
                          onGenerateThreeView(character)
                          return
                        }
                        threeViewGuard.arm(character.id)
                      }}
                      className={`inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[10px] font-medium disabled:opacity-50 ${
                        armed
                          ? 'bg-amber-500 text-white'
                          : character.three_view_asset_id
                            ? 'border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--muted)]/45'
                            : 'bg-[var(--primary)]/[0.1] text-[var(--primary)]'
                      }`}
                    >
                      {busy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                      {armed
                        ? t('Confirm paid generation?')
                        : character.three_view_asset_id
                          ? t('Regenerate three-view')
                          : t('Generate three-view')}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex h-40 flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border)] text-center text-[var(--muted-foreground)]">
            <UserRound size={22} strokeWidth={1.4} />
            <p className="mt-2 text-[11px]">{t('No characters yet')}</p>
            <p className="mt-1 px-3 text-[9.5px] leading-4">{t('Characters keep faces consistent across shots.')}</p>
          </div>
        )}
      </div>
    </section>
  )
}
