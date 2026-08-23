'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Search, X } from 'lucide-react'
import {
  listLibraryAssets,
  listLibraryPrompts,
  listLibraryTree,
  libraryAssetUrl,
  libraryEntryUrl,
  type LibraryAsset,
  type LibraryEntry,
  type LibraryPrompt,
} from '@/lib/creative-library-api'
import { collectLibraryFiles } from '@/lib/library-tree'

function entryAsAsset(entry: LibraryEntry): LibraryAsset {
  const textKind = ['markdown', 'html', 'csv', 'text', 'word', 'excel'].includes(entry.kind)
  return {
    id: entry.id,
    kind: textKind ? 'text' : (entry.kind as LibraryAsset['kind']),
    title: entry.title,
    tags: [],
    source: 'tree',
    note: '',
    mime: entry.mime,
    size_bytes: entry.size_bytes,
    sha256: '',
    content: entry.content || '',
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  }
}

export function StudioLibraryPicker({
  open,
  onClose,
  onPickAsset,
  onPickPrompt,
  kinds = ['image', 'text'],
}: {
  open: boolean
  onClose: () => void
  onPickAsset?: (asset: LibraryAsset) => void
  onPickPrompt?: (prompt: LibraryPrompt) => void
  kinds?: Array<LibraryAsset['kind'] | 'text'>
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'assets' | 'prompts'>('assets')
  const [keyword, setKeyword] = useState('')
  const [assets, setAssets] = useState<LibraryAsset[]>([])
  const [prompts, setPrompts] = useState<LibraryPrompt[]>([])
  const [loading, setLoading] = useState(false)
  const kindFilter = kinds.join(',')

  useEffect(() => {
    if (!open) return
    let active = true
    // Loading is intentionally reset when the external library query changes.
    // This effect owns the request lifecycle rather than derived render state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    const allowed = new Set(kindFilter.split(','))
    void Promise.all([
      listLibraryTree(),
      listLibraryAssets({ keyword, pageSize: 24 }),
      listLibraryPrompts({ keyword, pageSize: 24 }),
    ])
      .then(([tree, assetPage, promptPage]) => {
        if (!active) return
        const needle = keyword.trim().toLowerCase()
        const fromTree = collectLibraryFiles(tree.items || [])
          .filter(item => {
            const mapped = entryAsAsset(item)
            if (!allowed.has(mapped.kind) && !allowed.has(item.kind)) return false
            return !needle || item.title.toLowerCase().includes(needle)
          })
          .map(entryAsAsset)
        const seen = new Set(fromTree.map(item => item.id))
        const fromLegacy = assetPage.items.filter(item => allowed.has(item.kind) && !seen.has(item.id))
        setAssets([...fromTree, ...fromLegacy])
        setPrompts(promptPage.items)
      })
      .catch(() => {
        if (!active) return
        setAssets([])
        setPrompts([])
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [keyword, kindFilter, open])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/30 p-3 sm:items-center">
      <div
        data-library-picker=""
        className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
          <Search size={14} className="text-[var(--muted-foreground)]" />
          <input
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
            placeholder={t('Search library')}
            className="h-8 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
          />
          <button type="button" onClick={onClose} aria-label={t('Close')} className="rounded-lg p-1 hover:bg-[var(--muted)]">
            <X size={14} />
          </button>
        </div>
        <div className="flex gap-1 px-3 pt-2">
          <button
            type="button"
            onClick={() => setTab('assets')}
            className={`rounded-full px-2.5 py-1 text-[12px] ${tab === 'assets' ? 'bg-[var(--muted)] font-medium' : 'text-[var(--muted-foreground)]'}`}
          >
            {t('Assets')}
          </button>
          <button
            type="button"
            onClick={() => setTab('prompts')}
            className={`rounded-full px-2.5 py-1 text-[12px] ${tab === 'prompts' ? 'bg-[var(--muted)] font-medium' : 'text-[var(--muted-foreground)]'}`}
          >
            {t('Prompts')}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--muted-foreground)]">
              <Loader2 size={14} className="animate-spin" />
              {t('Loading')}
            </div>
          ) : tab === 'assets' ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {assets.map(asset => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => {
                    onPickAsset?.(asset)
                    onClose()
                  }}
                  className="overflow-hidden rounded-xl border border-[var(--border)] text-left hover:border-[var(--primary)]"
                >
                  {asset.kind === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={asset.source === 'tree' ? libraryEntryUrl(asset.id) : libraryAssetUrl(asset.id)}
                      alt=""
                      className="h-24 w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-24 items-center px-2 text-[12px] text-[var(--muted-foreground)]">
                      {asset.content.slice(0, 80) || asset.kind}
                    </div>
                  )}
                  <div className="truncate px-2 py-1.5 text-[11px]">{asset.title}</div>
                </button>
              ))}
              {!assets.length ? (
                <p className="col-span-full py-8 text-center text-[12px] text-[var(--muted-foreground)]">
                  {t('No library assets yet.')}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {prompts.map(prompt => (
                <button
                  key={prompt.id}
                  type="button"
                  onClick={() => {
                    onPickPrompt?.(prompt)
                    onClose()
                  }}
                  className="rounded-xl border border-[var(--border)] px-3 py-2 text-left hover:border-[var(--primary)]"
                >
                  <div className="text-[12.5px] font-medium">{prompt.title}</div>
                  <div className="mt-1 line-clamp-2 text-[11px] text-[var(--muted-foreground)]">{prompt.body}</div>
                </button>
              ))}
              {!prompts.length ? (
                <p className="py-8 text-center text-[12px] text-[var(--muted-foreground)]">{t('No prompts yet.')}</p>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
