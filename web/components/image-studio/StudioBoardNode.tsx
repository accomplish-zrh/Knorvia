'use client'

import type { ReactNode } from 'react'
import {
  Copy,
  Download,
  ImageIcon,
  ImagePlus,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Type,
  WandSparkles,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  BOARD_COPY_LENGTHS,
  BOARD_COPY_STYLES,
  BOARD_OUTPUT_QUALITIES,
  collectBoardPrompt,
  insertBoardMention,
  mentionLabel,
  polishBoardPrompt,
  snapOutputSize,
  type BoardDocument,
  type BoardHandleSide,
  type BoardNode,
} from '@/lib/image-studio/board-logic'
import { ASPECT_PRESETS } from '@/lib/image-studio/studio-logic'
import { type ImageModelOption } from '@/lib/image-studio-api'

const SELECTION_BLUE = '#2f80ff'

export function isEmptyVisualNode(node: BoardNode): boolean {
  return (node.kind === 'generate' || node.kind === 'image') && !node.assetId
}

export function boardNodeToolbarTitle(node: BoardNode, t: (key: string) => string): string {
  if (node.title?.trim()) return node.title.trim()
  if (node.kind === 'text') return t('Copy card')
  if (isEmptyVisualNode(node)) return t('Image placeholder')
  if (node.kind === 'generate') return t('Generate')
  return t('Image')
}

export function StudioBoardPorts({
  nodeId,
  showIn,
  visible,
}: {
  nodeId: string
  showIn: boolean
  visible: boolean
}) {
  const { t } = useTranslation()
  return (
    <>
      {showIn ? <BoardPort nodeId={nodeId} side="in" visible={visible} label={t('Connect input')} /> : null}
      <BoardPort nodeId={nodeId} side="out" visible={visible} label={t('Connect output')} />
    </>
  )
}

function BoardPort({
  nodeId,
  side,
  visible,
  label,
}: {
  nodeId: string
  side: BoardHandleSide
  visible: boolean
  label: string
}) {
  return (
    <button
      type="button"
      data-board-handle={nodeId}
      data-board-handle-side={side}
      title={label}
      aria-label={label}
      className={`absolute top-1/2 z-20 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)] text-[#2f80ff] shadow-sm transition-opacity ${
        side === 'in' ? '-left-3.5' : '-right-3.5'
      } ${visible ? 'opacity-100' : 'pointer-events-none opacity-0 group-hover/node:pointer-events-auto group-hover/node:opacity-100'}`}
    >
      <Plus size={12} strokeWidth={2.4} />
    </button>
  )
}

export function StudioBoardNodeToolbar({
  node,
  busy,
  onCopy,
  onAttach,
  onEdit,
  onDownload,
  onDuplicate,
  onDelete,
}: {
  node: BoardNode
  busy?: boolean
  onCopy: () => void
  onAttach?: () => void
  onEdit?: () => void
  onDownload?: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const title = boardNodeToolbarTitle(node, t)
  return (
    <div
      data-board-chrome=""
      data-board-node-toolbar=""
      className="pointer-events-auto flex items-center gap-1 rounded-[14px] border border-[var(--border)]/70 bg-[var(--card)]/96 px-1.5 py-1 shadow-[0_12px_28px_-18px_rgba(0,0,0,0.55)] backdrop-blur-md"
    >
      <span className="inline-flex items-center gap-1.5 rounded-[10px] bg-[var(--muted)]/55 px-2 py-1 text-[11.5px] font-medium">
        {node.kind === 'text' ? <Type size={13} /> : <ImageIcon size={13} />}
        <span className="max-w-[7.5rem] truncate">{title}</span>
      </span>
      <ToolbarIcon title={t('Copy prompt')} onClick={onCopy}>
        <Copy size={13} />
      </ToolbarIcon>
      {onAttach ? (
        <ToolbarIcon title={t('Attach image')} onClick={onAttach}>
          <ImagePlus size={13} />
        </ToolbarIcon>
      ) : null}
      {onEdit ? (
        <ToolbarIcon title={t('Edit node')} onClick={onEdit}>
          <Pencil size={13} />
        </ToolbarIcon>
      ) : null}
      <ToolbarIcon title={t('Download selected')} onClick={onDownload} disabled={!onDownload || busy}>
        <Download size={13} />
      </ToolbarIcon>
      <ToolbarIcon title={t('Duplicate')} onClick={onDuplicate}>
        <Copy size={13} className="opacity-80" />
      </ToolbarIcon>
      <ToolbarIcon title={t('Delete')} onClick={onDelete} danger>
        <Trash2 size={13} />
      </ToolbarIcon>
    </div>
  )
}

function ToolbarIcon({
  title,
  onClick,
  disabled,
  danger,
  children,
}: {
  title: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-[9px] ${
        danger
          ? 'text-[var(--destructive)] hover:bg-[var(--destructive)]/10'
          : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)]/70 hover:text-[var(--foreground)]'
      } disabled:opacity-35`}
    >
      {children}
    </button>
  )
}

export function StudioBoardNodeBody({
  node,
  board,
  busy,
  refs,
  editing,
  models,
  modelKey,
  language,
  assetUrl,
  mentionFor,
  onChange,
  onGenerate,
  onOpenInpaint,
  onRetry,
  onAttach,
  onToggleEdit,
  onMentionFor,
}: {
  node: BoardNode
  board: BoardDocument
  busy: boolean
  refs: number
  editing: boolean
  models: ImageModelOption[]
  modelKey: string
  language: string
  assetUrl: (assetId: string) => string
  mentionFor: string | null
  onChange: (board: BoardDocument) => void
  onGenerate: (node: BoardNode) => void
  onOpenInpaint?: (node: BoardNode) => void
  onRetry?: (node: BoardNode) => void
  onAttach: () => void
  onToggleEdit?: () => void
  onMentionFor: (nodeId: string | null) => void
}) {
  const { t } = useTranslation()

  if (node.kind === 'text') {
    return (
      <TextCopyCard
        node={node}
        board={board}
        language={language}
        onChange={onChange}
      />
    )
  }

  if (node.kind === 'image' && node.assetId) {
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={assetUrl(node.assetId)}
          alt={node.prompt || t('Image preview')}
          className="pointer-events-none h-full w-full object-cover"
          draggable={false}
        />
        {node.prompt ? (
          <p className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-[var(--background)]/90 via-[var(--background)]/55 to-transparent px-2.5 pt-6 pb-2 text-[11px] text-[var(--foreground)]">
            {node.prompt}
          </p>
        ) : null}
        {onOpenInpaint ? (
          <button
            type="button"
            data-board-node-interactive=""
            onClick={event => {
              event.stopPropagation()
              onOpenInpaint(node)
            }}
            className="absolute top-2 right-2 rounded-full bg-[var(--card)]/92 px-2.5 py-1 text-[11px] opacity-0 shadow-sm backdrop-blur-sm transition group-hover/node:opacity-100"
          >
            {t('Local redraw')}
          </button>
        ) : null}
      </>
    )
  }

  return (
    <>
      <EmptyImagePlaceholder
        busy={busy}
        canGenerate={Boolean(collectBoardPrompt(board, node.id) || node.prompt)}
        onGenerate={() => onGenerate({ ...node, prompt: collectBoardPrompt(board, node.id) })}
        onAttach={node.kind === 'image' ? onAttach : undefined}
        onEdit={node.kind === 'generate' ? onToggleEdit : undefined}
      />
      {editing && node.kind === 'generate' ? (
        <GenerateParams
          node={node}
          board={board}
          busy={busy}
          refs={refs}
          models={models}
          modelKey={modelKey}
          language={language}
          mentionFor={mentionFor}
          onChange={onChange}
          onGenerate={onGenerate}
          onMentionFor={onMentionFor}
        />
      ) : null}
      {node.status === 'failed' && !busy ? (
        <button
          type="button"
          data-board-node-interactive=""
          onClick={event => {
            event.stopPropagation()
            if (onRetry) onRetry(node)
            else onGenerate(node)
          }}
          className="absolute inset-x-3 bottom-3 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-[11px]"
        >
          {t('Retry')}
        </button>
      ) : null}
    </>
  )
}

function EmptyImagePlaceholder({
  busy,
  canGenerate,
  onGenerate,
  onAttach,
  onEdit,
}: {
  busy: boolean
  canGenerate: boolean
  onGenerate: () => void
  onAttach?: () => void
  onEdit?: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      data-board-node-interactive=""
      disabled={busy}
      onClick={event => {
        event.stopPropagation()
        if (canGenerate) onGenerate()
        else if (onEdit) onEdit()
        else onAttach?.()
      }}
      className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center"
    >
      {busy ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--card)]/90 px-2.5 py-1 text-[12px] shadow-sm">
          <Loader2 size={13} className="animate-spin" />
          {t('Creating')}
        </span>
      ) : (
        <>
          <span className="grid h-11 w-11 place-items-center rounded-2xl text-[#2f80ff]">
            <ImageIcon size={26} strokeWidth={1.6} />
          </span>
          <span className="text-[15px] font-medium tracking-tight text-[#6ea4ff]">{t('Generate image')}</span>
          <span className="max-w-[12rem] text-[11px] leading-4 text-[var(--muted-foreground)]">
            {t('Enter a prompt and adjust parameters to generate.')}
          </span>
        </>
      )}
    </button>
  )
}

function TextCopyCard({
  node,
  board,
  language,
  onChange,
}: {
  node: BoardNode
  board: BoardDocument
  language: string
  onChange: (board: BoardDocument) => void
}) {
  const { t } = useTranslation()
  const update = (patch: Partial<BoardNode>) => onChange(updateNode(board, node.id, patch))
  return (
    <div className="flex h-full flex-col px-3.5 pt-3.5 pb-3">
      <textarea
        data-board-node-interactive=""
        value={node.text || ''}
        onChange={event => update({ text: event.target.value })}
        placeholder={t('Write a note or prompt')}
        className="min-h-0 flex-1 resize-none bg-transparent text-[13px] leading-5 text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
      />
      <div data-board-node-interactive="" className="mt-2 flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <select
            value={node.copyStyle || 'poster'}
            onChange={event => update({ copyStyle: event.target.value as BoardNode['copyStyle'] })}
            className="h-7 min-w-0 flex-1 truncate rounded-lg border border-[var(--border)]/70 bg-[var(--background)]/70 px-1.5 text-[10.5px]"
          >
            {BOARD_COPY_STYLES.map(style => (
              <option key={style} value={style}>
                {t(copyStyleLabel(style))}
              </option>
            ))}
          </select>
          <select
            value={node.copyLength || 'standard'}
            onChange={event => update({ copyLength: event.target.value as BoardNode['copyLength'] })}
            className="h-7 min-w-0 flex-1 truncate rounded-lg border border-[var(--border)]/70 bg-[var(--background)]/70 px-1.5 text-[10.5px]"
          >
            {BOARD_COPY_LENGTHS.map(item => (
              <option key={item} value={item}>
                {t(copyLengthLabel(item))}
              </option>
            ))}
          </select>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!(node.text || '').trim()}
            onClick={event => {
              event.stopPropagation()
              update({
                text: polishBoardPrompt(node.text || '', language, node.copyStyle, node.copyLength),
              })
            }}
            className="inline-flex h-7 items-center gap-1 rounded-lg bg-[var(--muted)] px-2.5 text-[11px] font-medium disabled:opacity-40"
          >
            <WandSparkles size={11} />
            {t('Generate copy')}
          </button>
        </div>
      </div>
    </div>
  )
}

function GenerateParams({
  node,
  board,
  busy,
  refs,
  models,
  modelKey,
  language,
  mentionFor,
  onChange,
  onGenerate,
  onMentionFor,
}: {
  node: BoardNode
  board: BoardDocument
  busy: boolean
  refs: number
  models: ImageModelOption[]
  modelKey: string
  language: string
  mentionFor: string | null
  onChange: (board: BoardDocument) => void
  onGenerate: (node: BoardNode) => void
  onMentionFor: (nodeId: string | null) => void
}) {
  const { t } = useTranslation()
  const update = (patch: Partial<BoardNode>) => onChange(updateNode(board, node.id, patch))
  return (
    <div
      data-board-node-interactive=""
      className="absolute top-[calc(100%+10px)] right-0 left-0 z-20 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-3 shadow-[0_16px_36px_-22px_rgba(0,0,0,0.45)]"
    >
      <div className="mb-1 flex items-center justify-between text-[10px] tracking-wide text-[var(--muted-foreground)] uppercase">
        <span>{t('Generate')}</span>
        {refs ? <span>{t('{{count}} references', { count: refs })}</span> : null}
      </div>
      <textarea
        value={node.prompt || ''}
        onChange={event => {
          const value = event.target.value
          update({ prompt: value })
          onMentionFor(/@([^\s@[\]]*)$/.test(value) ? node.id : null)
        }}
        placeholder={t('Describe what to create')}
        className="mb-1.5 h-16 w-full resize-none bg-transparent text-[13px] leading-5 outline-none"
      />
      {mentionFor === node.id ? (
        <div className="mb-1 max-h-24 overflow-auto rounded-md border border-[var(--border)] bg-[var(--card)]">
          {board.nodes
            .filter(item => item.id !== node.id)
            .slice(0, 8)
            .map(item => (
              <button
                key={item.id}
                type="button"
                className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-[var(--muted)]/50"
                onClick={() => {
                  update({ prompt: insertBoardMention(node.prompt || '', item.id) })
                  onMentionFor(null)
                }}
              >
                {mentionLabel(item)}
              </button>
            ))}
        </div>
      ) : null}
      <div className="mb-1.5 grid grid-cols-3 gap-1">
        <select
          value={node.modelKey || modelKey}
          onChange={event => update({ modelKey: event.target.value })}
          className="col-span-3 h-6 rounded-md border border-[var(--border)]/70 bg-transparent px-1 text-[10px]"
        >
          {models.map(model => (
            <option key={`${model.profile_id}:${model.model_id}`} value={`${model.profile_id}:${model.model_id}`}>
              {model.profile_name} · {model.model_name}
            </option>
          ))}
        </select>
        <select
          value={node.ratio || ''}
          onChange={event => update({ ratio: event.target.value || undefined })}
          className="h-6 rounded-md border border-[var(--border)]/70 bg-transparent px-1 text-[10px]"
        >
          <option value="">{t('Ratio')}</option>
          {ASPECT_PRESETS.map(ratio => (
            <option key={ratio} value={ratio}>
              {ratio}
            </option>
          ))}
        </select>
        <select
          value={node.quality || ''}
          onChange={event => update({ quality: event.target.value || undefined })}
          className="h-6 rounded-md border border-[var(--border)]/70 bg-transparent px-1 text-[10px]"
        >
          {BOARD_OUTPUT_QUALITIES.map(item => (
            <option key={item || 'default'} value={item}>
              {item || t('Quality')}
            </option>
          ))}
        </select>
        <button
          type="button"
          title={t('Polish prompt')}
          onClick={() =>
            update({
              prompt: polishBoardPrompt(node.prompt || '', language),
            })
          }
          className="inline-flex h-6 items-center justify-center rounded-md border border-[var(--border)]/70"
        >
          <WandSparkles size={11} />
        </button>
      </div>
      <div className="mb-1.5 flex items-center gap-1 text-[10px] text-[var(--muted-foreground)]">
        <input
          type="number"
          min={16}
          step={16}
          placeholder={t('W')}
          value={node.customWidth || ''}
          onChange={event => {
            const snapped = snapOutputSize(Number(event.target.value) || 1024, node.customHeight || 1024)
            update({ customWidth: event.target.value ? snapped.width : undefined })
          }}
          className="h-6 w-14 rounded-md border border-[var(--border)]/70 bg-transparent px-1"
        />
        <span>×</span>
        <input
          type="number"
          min={16}
          step={16}
          placeholder={t('H')}
          value={node.customHeight || ''}
          onChange={event => {
            const snapped = snapOutputSize(node.customWidth || 1024, Number(event.target.value) || 1024)
            update({ customHeight: event.target.value ? snapped.height : undefined })
          }}
          className="h-6 w-14 rounded-md border border-[var(--border)]/70 bg-transparent px-1"
        />
      </div>
      <button
        type="button"
        disabled={busy || !collectBoardPrompt(board, node.id)}
        onClick={event => {
          event.stopPropagation()
          onGenerate({ ...node, prompt: collectBoardPrompt(board, node.id) })
        }}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-[var(--primary)] px-3 py-1.5 text-[12px] text-[var(--primary-foreground)] disabled:opacity-40"
      >
        <Sparkles size={12} />
        {busy ? t('Creating') : t('Start creating')}
      </button>
    </div>
  )
}

export function boardNodeFrameClass(node: BoardNode, active: boolean, dropTarget: boolean): string {
  if (dropTarget) return 'border-solid border-sky-500 shadow-[0_10px_28px_-16px_rgba(14,165,233,0.55)]'
  if (active && isEmptyVisualNode(node)) return 'border-dashed shadow-[0_0_0_1px_rgba(47,128,255,0.28)]'
  if (active) return 'border-solid border-[var(--ring)] shadow-[0_16px_36px_-22px_rgba(0,0,0,0.35)]'
  return 'border-solid border-[var(--border)] shadow-[0_10px_24px_-20px_rgba(0,0,0,0.35)]'
}

export function boardNodeFrameStyle(node: BoardNode, active: boolean, dropTarget: boolean): { borderColor?: string } {
  if (dropTarget) return { borderColor: SELECTION_BLUE }
  if (active && isEmptyVisualNode(node)) return { borderColor: SELECTION_BLUE }
  return {}
}

function copyStyleLabel(style: string): string {
  if (style === 'product') return 'Product copy'
  if (style === 'story') return 'Story copy'
  if (style === 'character') return 'Character copy'
  return 'Poster copy'
}

function copyLengthLabel(length: string): string {
  if (length === 'short') return 'Short copy'
  if (length === 'long') return 'Long copy'
  return 'Standard copy'
}

function updateNode(board: BoardDocument, nodeId: string, patch: Partial<BoardNode>): BoardDocument {
  return {
    ...board,
    nodes: board.nodes.map(node => (node.id === nodeId ? { ...node, ...patch, id: node.id } : node)),
  }
}
