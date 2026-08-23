import type { LibraryEntry } from '@/lib/creative-library-api'

export const LOCAL_FILE_KINDS = new Set(['image', 'video', 'audio', 'pdf', 'file', 'office'])

const EXTENSION: Record<string, string> = {
  markdown: '.md',
  html: '.html',
  csv: '.csv',
  word: '.docx',
  excel: '.xlsx',
  text: '.txt',
}

export function libraryDisplayName(entry: Pick<LibraryEntry, 'kind' | 'title'>): string {
  const ext = EXTENSION[entry.kind]
  if (!ext) return entry.title
  const title = entry.title || ''
  return title.toLowerCase().endsWith(ext) ? title : `${title}${ext}`
}

export function flattenLibraryTree(
  items: LibraryEntry[],
  collapsed: Set<string>,
  depth = 0
): Array<LibraryEntry & { depth: number }> {
  const rows: Array<LibraryEntry & { depth: number }> = []
  for (const item of items) {
    rows.push({ ...item, depth })
    if (item.kind === 'folder' && item.children?.length && !collapsed.has(item.id)) {
      rows.push(...flattenLibraryTree(item.children, collapsed, depth + 1))
    }
  }
  return rows
}

export function indexLibraryTree(items: LibraryEntry[]): Map<string, LibraryEntry> {
  const map = new Map<string, LibraryEntry>()
  const walk = (nodes: LibraryEntry[]) => {
    for (const node of nodes) {
      map.set(node.id, node)
      if (node.children?.length) walk(node.children)
    }
  }
  walk(items)
  return map
}

export function libraryBreadcrumb(items: LibraryEntry[], entry: LibraryEntry | null): LibraryEntry[] {
  if (!entry) return []
  const byId = indexLibraryTree(items)
  const path: LibraryEntry[] = []
  let current: LibraryEntry | undefined = entry
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    path.unshift(current)
    seen.add(current.id)
    current = current.parent_id ? byId.get(current.parent_id) : undefined
  }
  return path
}

export function collectLibraryFiles(items: LibraryEntry[]): LibraryEntry[] {
  const files: LibraryEntry[] = []
  const walk = (nodes: LibraryEntry[]) => {
    for (const node of nodes) {
      if (node.kind !== 'folder') files.push(node)
      if (node.children?.length) walk(node.children)
    }
  }
  walk(items)
  return files
}

export function formatLibraryBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function defaultLibraryHtmlPage(title: string, intro: string): string {
  const safeTitle = escapeHtml(title)
  const safeIntro = escapeHtml(intro)
  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    :root { color-scheme: light; }
    html, body { margin: 0; min-height: 100%; }
    body {
      font-family: "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif;
      color: #1c2430;
      background: linear-gradient(180deg, #eef8f3 0%, #f4f1fa 55%, #f7f6fb 100%);
    }
    main { max-width: 720px; margin: 0 auto; padding: 88px 28px 72px; }
    .badge {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 6px 12px; border-radius: 999px; background: #fff;
      font-size: 13px; color: #0f9f6e; box-shadow: 0 8px 24px rgba(20,40,30,.06);
    }
    h1 { margin: 28px 0 12px; font-size: 40px; line-height: 1.15; letter-spacing: -0.04em; }
    p { margin: 0; font-size: 16px; line-height: 1.7; color: #4b5563; }
  </style>
</head>
<body>
  <main>
    <span class="badge">Library</span>
    <h1>${safeTitle}</h1>
    <p>${safeIntro}</p>
  </main>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
