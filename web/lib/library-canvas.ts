export const LIBRARY_CANVAS_VERSION = 1
export const LIBRARY_CANVAS_NODE_KINDS = ['text', 'note', 'image', 'file'] as const

export type LibraryCanvasNodeKind = (typeof LIBRARY_CANVAS_NODE_KINDS)[number]

export type LibraryCanvasNode = {
  id: string
  kind: LibraryCanvasNodeKind
  x: number
  y: number
  width: number
  height: number
  title: string
  text: string
  entryId?: string
}

export type LibraryCanvasEdge = { id: string; from: string; to: string }

export type LibraryCanvasDocument = {
  version: typeof LIBRARY_CANVAS_VERSION
  revision: number
  viewport: { x: number; y: number; scale: number }
  nodes: LibraryCanvasNode[]
  edges: LibraryCanvasEdge[]
}

export function emptyLibraryCanvas(): LibraryCanvasDocument {
  return {
    version: LIBRARY_CANVAS_VERSION,
    revision: 0,
    viewport: { x: 0, y: 0, scale: 1 },
    nodes: [],
    edges: [],
  }
}

export function normalizeLibraryCanvas(raw: unknown): LibraryCanvasDocument {
  const document = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const revisionRaw = document.revision
  const revision =
    typeof revisionRaw === 'number' && Number.isInteger(revisionRaw) && revisionRaw >= 0
      ? revisionRaw
      : 0
  const viewportRaw =
    document.viewport && typeof document.viewport === 'object'
      ? (document.viewport as Record<string, unknown>)
      : {}
  const scaleRaw = Number(viewportRaw.scale ?? 1)
  const scale = Number.isFinite(scaleRaw) ? Math.min(2.5, Math.max(0.25, scaleRaw)) : 1
  const nodes: LibraryCanvasNode[] = []
  const seen = new Set<string>()
  const rawNodes = Array.isArray(document.nodes) ? document.nodes : []
  for (const item of rawNodes.slice(0, 80)) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = String(record.id || '').trim()
    const kind = String(record.kind || 'text')
    if (!id || seen.has(id) || !(LIBRARY_CANVAS_NODE_KINDS as readonly string[]).includes(kind)) continue
    const x = Number(record.x)
    const y = Number(record.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const node: LibraryCanvasNode = {
      id: id.slice(0, 80),
      kind: kind as LibraryCanvasNodeKind,
      x,
      y,
      width: Math.min(720, Math.max(120, Number(record.width) || 220)),
      height: Math.min(520, Math.max(72, Number(record.height) || 120)),
      title: String(record.title || '').slice(0, 160),
      text: String(record.text || '').slice(0, 8000),
    }
    const entryId = String(record.entryId || '').trim()
    if (entryId) node.entryId = entryId.slice(0, 80)
    nodes.push(node)
    seen.add(node.id)
  }
  return {
    version: LIBRARY_CANVAS_VERSION,
    revision,
    viewport: {
      x: Number.isFinite(Number(viewportRaw.x)) ? Number(viewportRaw.x) : 0,
      y: Number.isFinite(Number(viewportRaw.y)) ? Number(viewportRaw.y) : 0,
      scale,
    },
    nodes,
    edges: [],
  }
}

export function addLibraryCanvasNode(
  document: LibraryCanvasDocument,
  input: { kind?: LibraryCanvasNodeKind; title?: string; text?: string; entryId?: string; x?: number; y?: number }
): LibraryCanvasDocument {
  const next = normalizeLibraryCanvas(document)
  if (next.nodes.length >= 80) return next
  next.nodes.push({
    id: `lnode_${Math.random().toString(16).slice(2, 12)}`,
    kind: input.kind || 'text',
    x: input.x ?? 80 + next.nodes.length * 24,
    y: input.y ?? 80 + next.nodes.length * 16,
    width: input.kind === 'image' ? 220 : 240,
    height: input.kind === 'image' ? 180 : 140,
    title: (input.title || '').slice(0, 160),
    text: (input.text || '').slice(0, 8000),
    ...(input.entryId ? { entryId: input.entryId } : {}),
  })
  next.revision += 1
  return next
}

export function moveLibraryCanvasNode(
  document: LibraryCanvasDocument,
  nodeId: string,
  x: number,
  y: number
): LibraryCanvasDocument {
  const next = normalizeLibraryCanvas(document)
  next.nodes = next.nodes.map(node => (node.id === nodeId ? { ...node, x, y } : node))
  next.revision += 1
  return next
}

export function removeLibraryCanvasNode(
  document: LibraryCanvasDocument,
  nodeId: string
): LibraryCanvasDocument {
  const next = normalizeLibraryCanvas(document)
  next.nodes = next.nodes.filter(node => node.id !== nodeId)
  next.revision += 1
  return next
}
