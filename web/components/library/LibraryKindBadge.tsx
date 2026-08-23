import { Folder, LayoutGrid } from 'lucide-react'

const LETTER: Record<string, { label: string; bg: string }> = {
  html: { label: 'H', bg: '#14b8a6' },
  markdown: { label: 'M', bg: '#22c55e' },
  csv: { label: 'C', bg: '#f59e0b' },
  word: { label: 'W', bg: '#3b82f6' },
  excel: { label: 'X', bg: '#16a34a' },
  text: { label: 'T', bg: '#64748b' },
  pdf: { label: 'P', bg: '#ef4444' },
  image: { label: 'I', bg: '#ec4899' },
  video: { label: 'V', bg: '#8b5cf6' },
  audio: { label: 'A', bg: '#06b6d4' },
  office: { label: 'O', bg: '#6366f1' },
  file: { label: 'F', bg: '#78716c' },
}

export function LibraryKindBadge({ kind }: { kind: string }) {
  if (kind === 'folder') {
    return <Folder size={14} className="shrink-0 text-[var(--muted-foreground)]" />
  }
  if (kind === 'canvas') {
    return <LayoutGrid size={13} className="shrink-0 text-[#8b5cf6]" />
  }
  const spec = LETTER[kind] || LETTER.file
  return (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-[9px] font-bold text-white"
      style={{ background: spec.bg }}
      aria-hidden
    >
      {spec.label}
    </span>
  )
}
