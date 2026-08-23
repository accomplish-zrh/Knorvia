'use client'

import { Type, StickyNote, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  addLibraryCanvasNode,
  moveLibraryCanvasNode,
  normalizeLibraryCanvas,
  removeLibraryCanvasNode,
  type LibraryCanvasDocument,
} from '@/lib/library-canvas'
import { libraryEntryUrl } from '@/lib/creative-library-api'

export function LibraryCanvas({
  document,
  onChange,
}: {
  document: unknown
  onChange: (next: LibraryCanvasDocument) => void
}) {
  const { t } = useTranslation()
  const canvas = normalizeLibraryCanvas(document)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const dragOffset = useRef({ x: 0, y: 0 })

  return (
    <div data-library-canvas="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-3 py-2">
        <button
          type="button"
          onClick={() => onChange(addLibraryCanvasNode(canvas, { kind: 'text', title: t('Note') }))}
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 text-[12px]"
        >
          <Type size={13} /> {t('Add note')}
        </button>
        <button
          type="button"
          onClick={() => onChange(addLibraryCanvasNode(canvas, { kind: 'note', text: t('Untitled') }))}
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 text-[12px]"
        >
          <StickyNote size={13} /> {t('Add card')}
        </button>
        <span className="ml-auto text-[11px] text-[var(--muted-foreground)]">
          {t('{{count}} cards', { count: canvas.nodes.length })}
        </span>
      </div>
      <div
        ref={surfaceRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle_at_1px_1px,var(--border)_1px,transparent_0)] [background-size:22px_22px]"
        onPointerMove={event => {
          if (!dragId || !surfaceRef.current) return
          const rect = surfaceRef.current.getBoundingClientRect()
          onChange(
            moveLibraryCanvasNode(
              canvas,
              dragId,
              event.clientX - rect.left - dragOffset.current.x,
              event.clientY - rect.top - dragOffset.current.y
            )
          )
        }}
        onPointerUp={() => setDragId(null)}
      >
        {canvas.nodes.map(node => (
          <article
            key={node.id}
            className="absolute overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-sm"
            style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
          >
            <div
              className="flex cursor-grab items-center justify-between border-b border-[var(--border)] px-2 py-1 text-[11px]"
              onPointerDown={event => {
                const rect = event.currentTarget.parentElement?.getBoundingClientRect()
                dragOffset.current = {
                  x: event.clientX - (rect?.left || 0),
                  y: event.clientY - (rect?.top || 0),
                }
                setDragId(node.id)
              }}
            >
              <span className="truncate font-medium">{node.title || t('Untitled')}</span>
              <button type="button" aria-label={t('Delete')} onClick={() => onChange(removeLibraryCanvasNode(canvas, node.id))}>
                <Trash2 size={12} className="text-[var(--muted-foreground)]" />
              </button>
            </div>
            {node.kind === 'image' && node.entryId ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={libraryEntryUrl(node.entryId)} alt="" className="h-[calc(100%-28px)] w-full object-cover" />
            ) : (
              <textarea
                value={node.text}
                onChange={event => {
                  const next = normalizeLibraryCanvas(canvas)
                  next.nodes = next.nodes.map(item =>
                    item.id === node.id ? { ...item, text: event.target.value } : item
                  )
                  next.revision += 1
                  onChange(next)
                }}
                className="h-[calc(100%-28px)] w-full resize-none bg-transparent px-2 py-1 text-[12px] outline-none"
              />
            )}
          </article>
        ))}
      </div>
    </div>
  )
}
