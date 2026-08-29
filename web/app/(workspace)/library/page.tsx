'use client'

import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronRight,
  Clock,
  HardDrive,
  Loader2,
  Download,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  createLibraryEntry,
  deleteLibraryEntry,
  getLibraryEntry,
  libraryEntryUrl,
  listLibraryTree,
  patchLibraryEntry,
  uploadLibraryEntry,
  type LibraryEntry,
} from '@/lib/creative-library-api'
import { LibraryCanvas } from '@/components/library/LibraryCanvas'
import { LibraryKindBadge } from '@/components/library/LibraryKindBadge'
import { chatHandoffHref, studioHandoffHref } from '@/lib/creative-library/create-logic'
import DocxPreview from '@/components/chat/preview/previewers/DocxPreview'
import XlsxPreview from '@/components/chat/preview/previewers/XlsxPreview'
import MarkdownRenderer from '@/components/common/MarkdownRenderer'
import {
  collectLibraryFiles,
  defaultLibraryHtmlPage,
  flattenLibraryTree,
  formatLibraryBytes,
  libraryBreadcrumb,
  libraryDisplayName,
  LOCAL_FILE_KINDS,
} from '@/lib/library-tree'
import {
  LIBRARY_HTML_ALLOW,
  libraryHtmlPreviewScripts,
  libraryHtmlSandbox,
  prepareLibraryHtmlPreview,
} from '@/lib/library-html-preview'

type Section = 'docs' | 'recents' | 'local'

const CREATE_KINDS = [
  ['folder', 'New folder'],
  ['markdown', 'New markdown'],
  ['html', 'New HTML'],
  ['csv', 'New CSV'],
  ['word', 'New Word'],
  ['excel', 'New Excel'],
  ['canvas', 'New canvas'],
] as const

const LibraryExcelEditor = dynamic(() => import('@/components/library/LibraryExcelEditor'), {
  ssr: false,
})

export default function LibraryPage() {
  const { t } = useTranslation()
  const fileRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [tree, setTree] = useState<LibraryEntry[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [entry, setEntry] = useState<LibraryEntry | null>(null)
  const [draft, setDraft] = useState('')
  const [title, setTitle] = useState('')
  const [parentId, setParentId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [section, setSection] = useState<Section>('docs')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const excelSaveRef = useRef<(() => Promise<void>) | null>(null)

  const reload = useCallback(async () => {
    const payload = await listLibraryTree()
    setTree(payload.items || [])
  }, [])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!cancelled) setLoading(false)
    }, 6000)
    void reload()
      .catch(caught => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : t('Failed to load library'))
      })
      .finally(() => {
        if (!cancelled) {
          window.clearTimeout(timer)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [reload, t])

  useEffect(() => {
    if (!menuOpen) return
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [menuOpen])

  const openEntry = useCallback(async (id: string, nextEditing = false) => {
    setError('')
    const next = await getLibraryEntry(id)
    setSelectedId(id)
    setEntry(next)
    setTitle(next.title)
    setDraft(next.content || '')
    setParentId(next.kind === 'folder' ? next.id : next.parent_id)
    setEditing(nextEditing)
    setSection('docs')
  }, [])

  const files = useMemo(() => collectLibraryFiles(tree), [tree])
  const recents = useMemo(
    () => [...files].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)).slice(0, 12),
    [files]
  )
  const locals = useMemo(() => files.filter(item => LOCAL_FILE_KINDS.has(item.kind)), [files])
  const crumbs = useMemo(() => libraryBreadcrumb(tree, entry), [tree, entry])
  const storage = useMemo(() => {
    const bytes = files.reduce((sum, item) => sum + (item.size_bytes || 0), 0)
    return { count: files.length, bytes }
  }, [files])

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (section === 'recents') {
      return recents
        .filter(item => !needle || libraryDisplayName(item).toLowerCase().includes(needle))
        .map(item => ({ ...item, depth: 0 }))
    }
    if (section === 'local') {
      return locals
        .filter(item => !needle || libraryDisplayName(item).toLowerCase().includes(needle))
        .map(item => ({ ...item, depth: 0 }))
    }
    const flat = flattenLibraryTree(tree, collapsed)
    if (!needle) return flat
    return flattenLibraryTree(tree, new Set()).filter(item =>
      libraryDisplayName(item).toLowerCase().includes(needle)
    )
  }, [collapsed, locals, query, recents, section, tree])

  async function create(kind: string) {
    setError('')
    setMenuOpen(false)
    try {
      const created = await createLibraryEntry({
        kind,
        title:
          kind === 'folder'
            ? t('Untitled folder')
            : kind === 'canvas'
              ? t('Untitled canvas')
              : kind === 'word'
                ? t('Untitled Word')
                : kind === 'excel'
                  ? t('Untitled Excel')
                  : t('Untitled'),
        parent_id: parentId,
        content:
          kind === 'html'
            ? defaultLibraryHtmlPage(t('Untitled page'), t('Write on this page. You and the agent share this file.'))
            : undefined,
      })
      await reload()
      await openEntry(created.id, kind !== 'folder')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Save failed'))
    }
  }

  async function save() {
    if (!entry || entry.kind === 'folder') return
    setSaving(true)
    try {
      if (entry.kind === 'excel') {
        const saveExcel = excelSaveRef.current
        if (!saveExcel) throw new Error(t("Couldn't save this spreadsheet."))
        await saveExcel()
        const updated = await getLibraryEntry(entry.id)
        setEntry(updated)
        await reload()
      } else {
        const updated = await patchLibraryEntry(entry.id, { title, content: draft })
        setEntry(updated)
        await reload()
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Save failed'))
    } finally {
      setSaving(false)
    }
  }

  const textKind = Boolean(entry && ['markdown', 'csv', 'html', 'text', 'word'].includes(entry.kind))
  const excelKind = entry?.kind === 'excel'
  const previewable = textKind || excelKind || entry?.kind === 'canvas'

  return (
    <main data-library-page="" className="flex h-full min-h-0 overflow-hidden bg-[var(--background)]">
      {sidebarOpen ? (
        <aside
          data-library-tree=""
          className="flex w-[248px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--secondary)]"
        >
          <div className="flex h-12 shrink-0 items-center px-4">
            <h1 className="text-[16px] font-semibold tracking-[-0.03em]">{t('Library')}</h1>
          </div>

          <div className="px-3">
            <label className="flex h-8 items-center gap-2 rounded-lg bg-[var(--background)] px-2 text-[var(--muted-foreground)]">
              <Search size={13} />
              <input
                data-library-search=""
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={t('Search')}
                className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
              />
            </label>
          </div>

          <nav className="mt-2 space-y-0.5 px-2">
            <SidebarLink
              active={section === 'recents'}
              onClick={() => setSection('recents')}
              icon={<Clock size={14} />}
              label={t('Recents')}
            />
            <SidebarLink
              active={section === 'local'}
              onClick={() => setSection('local')}
              icon={<HardDrive size={14} />}
              label={t('Local files')}
            />
          </nav>

          <div className="mt-3 flex items-center justify-between px-4">
            <button
              type="button"
              onClick={() => setSection('docs')}
              className={`text-[11px] font-medium ${section === 'docs' ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)]'}`}
            >
              {t('My documents')}
            </button>
            <div ref={menuRef} className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen(open => !open)}
                className="rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                title={t('New')}
              >
                <Plus size={14} />
              </button>
              {menuOpen ? (
                <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg">
                  {CREATE_KINDS.map(([kind, key]) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => void create(kind)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[var(--muted)]"
                    >
                      <LibraryKindBadge kind={kind} />
                      {t(key)}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      fileRef.current?.click()
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[var(--muted)]"
                  >
                    <Upload size={13} />
                    {t('Upload')}
                  </button>
                </div>
              ) : null}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".md,.markdown,.csv,.html,.htm,.txt,.docx,.xlsx,.doc,.xls,.pdf,.png,.jpg,.jpeg,.webp,.mp4,.webm,.mp3,.wav"
              className="hidden"
              onChange={event => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (!file) return
                void uploadLibraryEntry(file, parentId)
                  .then(async created => {
                    await reload()
                    await openEntry(created.id)
                  })
                  .catch(caught => setError(caught instanceof Error ? caught.message : t('Upload failed')))
              }}
            />
          </div>

          <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {loading ? (
              <div className="flex items-center gap-2 px-2 py-4 text-[12px] text-[var(--muted-foreground)]">
                <Loader2 size={13} className="animate-spin" /> {t('Loading')}
              </div>
            ) : rows.length ? (
              rows.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    if (item.kind === 'folder') {
                      setCollapsed(prev => {
                        const next = new Set(prev)
                        if (next.has(item.id)) next.delete(item.id)
                        else next.add(item.id)
                        return next
                      })
                    }
                    void openEntry(item.id)
                  }}
                  className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-[5px] text-left text-[12.5px] ${
                    selectedId === item.id
                      ? 'bg-[var(--muted)] text-[var(--foreground)]'
                      : 'text-[var(--foreground)]/90 hover:bg-[var(--muted)]/60'
                  }`}
                  style={{ paddingLeft: 8 + item.depth * 14 }}
                >
                  {item.kind === 'folder' ? (
                    collapsed.has(item.id) ? (
                      <ChevronRight size={12} className="shrink-0 text-[var(--muted-foreground)]" />
                    ) : (
                      <ChevronDown size={12} className="shrink-0 text-[var(--muted-foreground)]" />
                    )
                  ) : (
                    <LibraryKindBadge kind={item.kind} />
                  )}
                  <span className="truncate">{libraryDisplayName(item)}</span>
                </button>
              ))
            ) : (
              <p className="px-2 py-4 text-[12px] text-[var(--muted-foreground)]">{t('The library is empty.')}</p>
            )}
          </div>

          <div className="flex h-10 shrink-0 items-center gap-2 border-t border-[var(--border)] px-4 text-[11px] text-[var(--muted-foreground)]">
            <HardDrive size={13} />
            <span>
              {t('Storage')} · {storage.count} · {formatLibraryBytes(storage.bytes)}
            </span>
          </div>
        </aside>
      ) : null}

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
          <button
            type="button"
            onClick={() => setSidebarOpen(open => !open)}
            className="rounded-md p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
            aria-label={t('Library')}
          >
            <PanelLeft size={15} />
          </button>
          {entry ? (
            <>
              <div className="flex min-w-0 flex-1 items-center gap-1 text-[12.5px] text-[var(--muted-foreground)]">
                <span className="shrink-0">{t('My documents')}</span>
                {crumbs.map(item => (
                  <span key={item.id} className="flex min-w-0 items-center gap-1">
                    <span>/</span>
                    {item.id === entry.id ? (
                      <input
                        value={title}
                        onChange={event => setTitle(event.target.value)}
                        onBlur={() => {
                          if (title !== entry.title) {
                            void patchLibraryEntry(entry.id, { title }).then(updated => {
                              setEntry(updated)
                              void reload()
                            })
                          }
                        }}
                        className="min-w-0 truncate rounded-md border border-transparent bg-transparent px-1 text-[12.5px] text-[var(--foreground)] outline-none hover:border-[var(--border)]"
                      />
                    ) : (
                      <button type="button" className="truncate hover:text-[var(--foreground)]" onClick={() => void openEntry(item.id)}>
                        {libraryDisplayName(item)}
                      </button>
                    )}
                  </span>
                ))}
              </div>
              {previewable ? (
                <button
                  type="button"
                  onClick={() => setEditing(value => !value)}
                  className={`rounded-md p-1.5 ${editing ? 'bg-[var(--muted)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)]'}`}
                  title={editing ? t('Preview') : t('Edit')}
                >
                  <Pencil size={14} />
                </button>
              ) : null}
              {textKind || entry.kind === 'canvas' || (excelKind && editing) ? (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void save()}
                  className="inline-flex h-8 items-center rounded-full bg-[var(--primary)] px-3 text-[12px] text-[var(--primary-foreground)]"
                >
                  {saving ? <Loader2 size={12} className="animate-spin" /> : t('Save')}
                </button>
              ) : null}
              {entry.kind !== 'folder' && entry.kind !== 'canvas' ? (
                <a href={libraryEntryUrl(entry.id)} download className="rounded-md p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]" title={t('Download')} aria-label={t('Download')}>
                  <Download size={14} />
                </a>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  if (!window.confirm(t('Delete this file?'))) return
                  void deleteLibraryEntry(entry.id).then(() => {
                    setEntry(null)
                    setSelectedId('')
                    return reload()
                  })
                }}
                className="rounded-md p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)]"
                aria-label={t('Delete')}
              >
                <Trash2 size={14} />
              </button>
            </>
          ) : (
            <span className="text-[12.5px] text-[var(--muted-foreground)]">{t('My documents')}</span>
          )}
        </header>
        {error ? (
          <p className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--destructive)]">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => {
                setError('')
                setLoading(true)
                void reload()
                  .catch(caught => setError(caught instanceof Error ? caught.message : t('Failed to load library')))
                  .finally(() => setLoading(false))
              }}
              className="rounded-md border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--foreground)]"
            >
              {t('Retry')}
            </button>
          </p>
        ) : null}

        {entry?.kind === 'folder' ? (
          <div className="flex flex-1 items-center justify-center bg-[var(--background)] text-[13px] text-[var(--muted-foreground)]">
            {t('This folder is selected. New files will be created inside it.')}
          </div>
        ) : entry?.kind === 'canvas' ? (
          <LibraryCanvas
            document={(() => {
              try {
                return JSON.parse(draft || '{}')
              } catch {
                return {}
              }
            })()}
            onChange={next => setDraft(JSON.stringify(next))}
          />
        ) : excelKind && entry ? (
          editing ? (
            <LibraryExcelEditor
              entryId={entry.id}
              url={`${libraryEntryUrl(entry.id)}?v=${entry.updated_at}`}
              onRegisterSave={saveFn => {
                excelSaveRef.current = saveFn
              }}
            />
          ) : (
            <div
              data-library-preview=""
              className="min-h-0 flex-1 overflow-auto bg-[var(--background)]"
            >
              <div className="h-full min-h-0">
                <XlsxPreview url={`${libraryEntryUrl(entry.id)}?v=${entry.updated_at}`} />
              </div>
            </div>
          )
        ) : textKind && entry ? (
          editing ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {entry.kind === 'word' ? (
                <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--muted-foreground)]">
                  <span>{t('Editing extracted Word text. Save writes a real .docx.')}</span>
                </div>
              ) : null}
              <textarea
                value={draft}
                onChange={event => setDraft(event.target.value)}
                className="min-h-0 flex-1 resize-none bg-transparent p-5 font-mono text-[13px] leading-6 outline-none"
              />
            </div>
          ) : (
            <div
              data-library-preview=""
              className="min-h-0 flex-1 overflow-auto bg-[var(--background)]"
            >
              {entry.kind === 'html' ? (
                <iframe
                  title={entry.title}
                  sandbox={libraryHtmlSandbox(libraryHtmlPreviewScripts(entry, draft))}
                  allow={LIBRARY_HTML_ALLOW}
                  referrerPolicy="no-referrer"
                  srcDoc={prepareLibraryHtmlPreview(draft)}
                  className="h-full min-h-full w-full border-0 bg-transparent"
                />
              ) : entry.kind === 'word' ? (
                <div className="mx-auto max-w-4xl p-6">
                  <DocxPreview url={`${libraryEntryUrl(entry.id)}?v=${entry.updated_at}`} />
                </div>
              ) : entry.kind === 'csv' ? (
                <pre className="mx-auto max-w-4xl whitespace-pre-wrap p-8 font-mono text-[12px]">{draft}</pre>
              ) : (
                <div className="mx-auto max-w-3xl px-8 py-12">
                  <MarkdownRenderer content={draft} variant="prose" />
                </div>
              )}
            </div>
          )
        ) : entry ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-[var(--background)] p-6">
            {entry.kind === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={libraryEntryUrl(entry.id)} alt={entry.title} className="max-h-[70vh] max-w-full rounded-xl object-contain" />
            ) : entry.kind === 'video' ? (
              <video src={libraryEntryUrl(entry.id)} controls className="max-h-[70vh] max-w-full rounded-xl" />
            ) : entry.kind === 'audio' ? (
              <audio src={libraryEntryUrl(entry.id)} controls />
            ) : entry.kind === 'pdf' ? (
              <iframe title={entry.title} src={libraryEntryUrl(entry.id)} className="h-full min-h-[420px] w-full bg-[var(--card)]" />
            ) : entry.kind === 'office' ? (
              <p className="text-[13px] text-[var(--muted-foreground)]">
                {t('Legacy .doc / .xls can be downloaded. Create and edit Word and Excel as .docx and .xlsx.')}
              </p>
            ) : (
              <p className="text-[13px] text-[var(--muted-foreground)]">{t('Download, send this to a studio, or ask the agent.')}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <a href={libraryEntryUrl(entry.id)} download className="rounded-full border border-[var(--border)] bg-[var(--card)] px-2.5 py-1 text-[11px]">
                {t('Download')}
              </a>
              <Link href={chatHandoffHref({ assetId: entry.id })} className="rounded-full border border-[var(--border)] bg-[var(--card)] px-2.5 py-1 text-[11px]">
                {t('Ask the agent')}
              </Link>
              {entry.kind === 'image' ? (
                <Link href={studioHandoffHref('image', { assetId: entry.id })} className="rounded-full border border-[var(--border)] bg-[var(--card)] px-2.5 py-1 text-[11px]">
                  {t('Use in Image Studio')}
                </Link>
              ) : null}
              {entry.kind === 'image' || entry.kind === 'video' ? (
                <Link href={studioHandoffHref('video', { assetId: entry.id })} className="rounded-full border border-[var(--border)] bg-[var(--card)] px-2.5 py-1 text-[11px]">
                  {t('Use in Video Studio')}
                </Link>
              ) : null}
            </div>
          </div>
        ) : (
          <Welcome onCreate={create} />
        )}
      </section>
    </main>
  )
}

function SidebarLink({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-[6px] text-left text-[12.5px] ${
        active ? 'bg-[var(--muted)]' : 'hover:bg-[var(--muted)]/60'
      }`}
    >
      <span className="text-[var(--muted-foreground)]">{icon}</span>
      {label}
    </button>
  )
}

function Welcome({ onCreate }: { onCreate: (kind: string) => void }) {
  const { t } = useTranslation()
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--background)]">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <span className="inline-flex items-center rounded-full bg-[var(--card)] px-3 py-1 text-[12px] text-[var(--primary)] shadow-sm">
          {t('Personal library')}
        </span>
        <h2 className="mt-6 text-[36px] font-semibold leading-[1.15] tracking-[-0.04em]">
          {t('Your files, your pages, one tree')}
        </h2>
        <p className="mt-3 max-w-xl text-[15px] leading-7 text-[var(--muted-foreground)]">
          {t('Markdown for writing, CSV for data, HTML for pages, Word and Excel for office files, and a canvas for cards. Agent can list, read, and write this tree.')}
        </p>
        <div className="mt-8 rounded-[20px] border border-[var(--border)] bg-[var(--card)] px-6 py-5">
          <p className="text-center text-[14px] font-medium text-[var(--primary)]">
            {t('Create → keep it here → open it as a page')}
          </p>
        </div>
        <div className="mt-4 space-y-3">
          <WelcomeCard
            step="1"
            title={t('Start with a page or a note')}
            body={t('Make an HTML page, a markdown note, Word, Excel, or a canvas. New files land in the selected folder.')}
            action={t('New HTML')}
            onAction={() => onCreate('html')}
          />
          <WelcomeCard
            step="2"
            title={t('Let the agent use the same tree')}
            body={t('Chat can list, read, and write these files. This library is personal only.')}
          />
          <WelcomeCard
            step="3"
            title={t('Preview first, edit when you need to')}
            body={t('Pages open as a full preview. The pencil switches to source. Save writes the real file.')}
          />
        </div>
      </div>
    </div>
  )
}

function WelcomeCard({
  step,
  title,
  body,
  action,
  onAction,
}: {
  step: string
  title: string
  body: string
  action?: string
  onAction?: () => void
}) {
  const { t } = useTranslation()
  return (
    <article className="rounded-[20px] border border-[var(--border)] bg-[var(--card)] px-5 py-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-6 items-center rounded-full bg-[var(--muted)] px-2 text-[11px] font-medium text-[var(--primary)]">
          {t('Step {{n}}', { n: step })}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold">{title}</h3>
          <p className="mt-1 text-[13px] leading-6 text-[var(--muted-foreground)]">{body}</p>
          {action && onAction ? (
            <button
              type="button"
              onClick={onAction}
              className="mt-3 inline-flex h-8 items-center rounded-full bg-[var(--primary)] px-3 text-[12px] text-[var(--primary-foreground)]"
            >
              {action}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  )
}
