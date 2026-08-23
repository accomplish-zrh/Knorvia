'use client'

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  groupBounds,
  mentionLabel,
  type BoardDocument,
  type BoardEdge,
} from '@/lib/image-studio/board-logic'

type Tab = 'layers' | 'assets' | 'connections'

export function StudioBoardPanel({
  board,
  selected,
  libraryIds,
  assetUrl,
  onSelect,
  onFocusNode,
  onRenameGroup,
  onUngroup,
  onSelectGroup,
  onToggleEdge,
  onDeleteEdge,
}: {
  board: BoardDocument
  selected: string[]
  libraryIds: string[]
  assetUrl: (assetId: string) => string
  onSelect: (nodeIds: string[]) => void
  onFocusNode: (nodeId: string) => void
  onRenameGroup: (groupId: string, title: string) => void
  onUngroup: (groupId: string) => void
  onSelectGroup: (groupId: string) => void
  onToggleEdge: (edgeId: string) => void
  onDeleteEdge: (edgeId: string) => void
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('layers')
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const nodesById = useMemo(() => new Map(board.nodes.map(node => [node.id, node])), [board.nodes])
  const grouped = new Map<string | 'loose', typeof board.nodes>()
  for (const node of [...board.nodes].sort((a, b) => b.z - a.z)) {
    const key = node.groupId || 'loose'
    const list = grouped.get(key) || []
    list.push(node)
    grouped.set(key, list)
  }

  const layers = [...(board.groups || []), { id: 'loose', title: t('Ungrouped') }].flatMap(group => {
    const members = grouped.get(group.id === 'loose' ? 'loose' : group.id) || []
    return members.length || group.id !== 'loose' ? [{ group, members }] : []
  })

  const assets = libraryIds.filter(id => {
    if (!needle) return true
    const node = board.nodes.find(item => item.assetId === id)
    return !node || mentionLabel(node).toLowerCase().includes(needle)
  })

  const connections = board.edges.filter(edge => {
    if (!needle) return true
    const from = nodesById.get(edge.from)
    const to = nodesById.get(edge.to)
    return [from, to].some(node => node && mentionLabel(node).toLowerCase().includes(needle))
  })

  return (
    <aside
      data-board-chrome=""
      data-board-panel=""
      className="absolute top-16 right-3 z-10 flex max-h-[72%] w-[228px] flex-col overflow-hidden rounded-2xl border border-[var(--border)]/60 bg-[var(--card)]/94 shadow-[0_10px_24px_-18px_rgba(0,0,0,0.4)] backdrop-blur-md"
    >
      <div className="flex border-b border-[var(--border)]/50 p-1">
        {(['layers', 'assets', 'connections'] as Tab[]).map(item => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={`flex-1 rounded-[10px] px-1.5 py-1 text-[11px] ${
              tab === item ? 'bg-[var(--background)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)]'
            }`}
          >
            {item === 'layers' ? t('Layers') : item === 'assets' ? t('Assets') : t('Connections')}
          </button>
        ))}
      </div>
      <div className="px-2 pt-2">
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={t('Search board')}
          className="h-8 w-full rounded-[10px] border border-[var(--border)]/70 bg-[var(--background)]/70 px-2 text-[12px] outline-none"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        {tab === 'layers'
          ? layers.map(({ group, members }) => (
              <div key={group.id} className="mb-2">
                {group.id !== 'loose' ? (
                  <div className="mb-1 flex items-center gap-1 px-1">
                    <button
                      type="button"
                      onClick={() => onSelectGroup(group.id)}
                      className="truncate text-left text-[10px] tracking-wide text-[var(--muted-foreground)] uppercase"
                    >
                      {group.title}
                      {groupBounds(board, group.id) ? ` · ${members.length}` : ''}
                    </button>
                    <input
                      defaultValue={group.title}
                      onBlur={event => onRenameGroup(group.id, event.target.value)}
                      className="sr-only"
                    />
                    <button
                      type="button"
                      onClick={() => onUngroup(group.id)}
                      className="ml-auto text-[10px] text-[var(--muted-foreground)]"
                    >
                      {t('Ungroup')}
                    </button>
                  </div>
                ) : null}
                {members
                  .filter(node => !needle || mentionLabel(node).toLowerCase().includes(needle))
                  .map(node => (
                    <button
                      key={node.id}
                      type="button"
                      onClick={() => {
                        onSelect([node.id])
                        onFocusNode(node.id)
                      }}
                      className={`mb-0.5 flex w-full items-center gap-2 rounded-[10px] px-1.5 py-1 text-left text-[12px] ${
                        selected.includes(node.id) ? 'bg-[var(--muted)]/70' : 'hover:bg-[var(--muted)]/40'
                      }`}
                    >
                      <span className="h-7 w-7 shrink-0 overflow-hidden rounded-md bg-[var(--muted)]/70">
                        {node.assetId ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={assetUrl(node.assetId)} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="grid h-full place-items-center text-[9px] text-[var(--muted-foreground)]">
                            {node.kind === 'text' ? 'Aa' : node.kind === 'generate' ? '✦' : '□'}
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{mentionLabel(node)}</span>
                    </button>
                  ))}
              </div>
            ))
          : null}
        {tab === 'assets'
          ? assets.map(id => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  const node = board.nodes.find(item => item.assetId === id)
                  if (node) {
                    onSelect([node.id])
                    onFocusNode(node.id)
                  }
                }}
                className="mb-1 flex w-full items-center gap-2 rounded-[10px] px-1.5 py-1 text-left hover:bg-[var(--muted)]/40"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={assetUrl(id)} alt="" className="h-8 w-8 rounded-md object-cover" />
                <span className="truncate text-[12px]">
                  {mentionLabel(board.nodes.find(node => node.assetId === id) || { id, kind: 'image', x: 0, y: 0, width: 0, height: 0, z: 0 })}
                </span>
              </button>
            ))
          : null}
        {tab === 'connections'
          ? connections.map(edge => (
              <ConnectionRow
                key={edge.id}
                edge={edge}
                from={mentionLabel(nodesById.get(edge.from) || { id: edge.from, kind: 'image', x: 0, y: 0, width: 0, height: 0, z: 0 })}
                to={mentionLabel(nodesById.get(edge.to) || { id: edge.to, kind: 'image', x: 0, y: 0, width: 0, height: 0, z: 0 })}
                onToggle={() => onToggleEdge(edge.id)}
                onDelete={() => onDeleteEdge(edge.id)}
              />
            ))
          : null}
        {tab === 'layers' && !board.nodes.length ? (
          <p className="px-2 py-6 text-center text-[12px] text-[var(--muted-foreground)]">{t('No layers yet')}</p>
        ) : null}
        {tab === 'assets' && !assets.length ? (
          <p className="px-2 py-6 text-center text-[12px] text-[var(--muted-foreground)]">{t('No assets yet')}</p>
        ) : null}
        {tab === 'connections' && !connections.length ? (
          <p className="px-2 py-6 text-center text-[12px] text-[var(--muted-foreground)]">{t('No connections yet')}</p>
        ) : null}
      </div>
    </aside>
  )
}

function ConnectionRow({
  edge,
  from,
  to,
  onToggle,
  onDelete,
}: {
  edge: BoardEdge
  from: string
  to: string
  onToggle: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="mb-1 rounded-[10px] px-1.5 py-1 hover:bg-[var(--muted)]/40">
      <p className="truncate text-[12px]">
        {from} → {to}
      </p>
      <div className="mt-0.5 flex gap-2 text-[10px]">
        <button type="button" onClick={onToggle} className="text-[var(--muted-foreground)]">
          {edge.role === 'mask' ? t('Use as reference') : t('Use as mask')}
        </button>
        <button type="button" onClick={onDelete} className="text-[var(--destructive)]">
          {t('Delete')}
        </button>
      </div>
    </div>
  )
}
