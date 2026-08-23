/**
 * Video Studio canvas (board) logic — pure functions, no React.
 *
 * Mirrors the Image Studio board engine (`lib/image-studio/board-logic.ts`)
 * with video-specific node kinds and edge roles. The server normalizer
 * (`knorvia/services/video_studio/board.py`) applies the same structural
 * rules; keep both in sync.
 */

import { hitTestWire, wireHandles, wirePath } from '@/lib/canvas-wires'

export const VIDEO_BOARD_DOCUMENT_VERSION = 1
export const VIDEO_BOARD_MIN_SCALE = 0.15
export const VIDEO_BOARD_MAX_SCALE = 3
export const VIDEO_BOARD_MAX_NODES = 200
export const VIDEO_BOARD_MAX_EDGES = 400

export const VIDEO_BOARD_NODE_KINDS = ['text', 'image', 'video', 'audio', 'generate'] as const
export const VIDEO_BOARD_EDGE_ROLES = [
  'reference',
  'first-frame',
  'last-frame',
  'audio',
  'continue-from',
] as const

export const BOARD_TEMPLATE_IDS = [
  'shot-i2v',
  'first-last',
  'storyboard-6',
  'character-episode',
  'extend-chain',
  'character-card',
  // §Phase F3: seven scaffolds for the mainstream workbench plays — vertical
  // episodic cuts, product showcases, talking heads, narration videos, A/B
  // takes, step-by-step tutorials and a 3×3 composition grid.
  'vertical-series',
  'product-triptych',
  'talking-head',
  'text-to-video',
  'compare-ab',
  'tutorial-steps',
  'grid-nine',
] as const

export type VideoBoardNodeKind = (typeof VIDEO_BOARD_NODE_KINDS)[number]
export type VideoBoardEdgeRole = (typeof VIDEO_BOARD_EDGE_ROLES)[number]
export type BoardTemplateId = (typeof BOARD_TEMPLATE_IDS)[number]

export type VideoBoardPoint = { x: number; y: number }
export type VideoBoardSize = { width: number; height: number }
export type VideoBoardRect = VideoBoardPoint & VideoBoardSize
export type VideoBoardViewport = VideoBoardPoint & { scale: number }
export type VideoBoardGroup = { id: string; title: string }

export type VideoBoardNode = VideoBoardRect & {
  id: string
  kind: VideoBoardNodeKind
  z: number
  title?: string
  text?: string
  prompt?: string
  assetId?: string
  jobId?: string
  status?: string
  groupId?: string
  modelKey?: string
  operation?: string
  ratio?: string
  resolution?: string
  seconds?: number
  referenceMode?: string
  outputAssetId?: string
  duration?: number
  /** C4 camera control: short motion label shown as the card's camera badge. */
  camera?: string
  /** Template provenance, mirroring the server normalizer's field list. */
  templateId?: string
  /** Storyboard strip shot this generate card was imported from. */
  storyboardShotId?: string
}

export type VideoBoardEdge = {
  id: string
  from: string
  to: string
  role: VideoBoardEdgeRole
}

export type VideoBoardDocument = {
  version: typeof VIDEO_BOARD_DOCUMENT_VERSION
  revision: number
  viewport: VideoBoardViewport
  nodes: VideoBoardNode[]
  edges: VideoBoardEdge[]
  groups: VideoBoardGroup[]
  updated_at?: number | null
}

export const VIDEO_NODE_SIZE: Record<VideoBoardNodeKind, VideoBoardSize> = {
  text: { width: 240, height: 140 },
  image: { width: 280, height: 280 },
  video: { width: 320, height: 240 },
  audio: { width: 240, height: 96 },
  generate: { width: 320, height: 292 },
}

export type VideoInputSpec = { assetId: string; role: VideoBoardEdgeRole }

// ── viewport math ─────────────────────────────────────────────────────

export function clampBoardScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(VIDEO_BOARD_MAX_SCALE, Math.max(VIDEO_BOARD_MIN_SCALE, scale))
}

export function screenToWorld(
  point: VideoBoardPoint,
  viewport: VideoBoardViewport
): VideoBoardPoint {
  return {
    x: (point.x - viewport.x) / viewport.scale,
    y: (point.y - viewport.y) / viewport.scale,
  }
}

export function worldToScreen(
  point: VideoBoardPoint,
  viewport: VideoBoardViewport
): VideoBoardPoint {
  return {
    x: point.x * viewport.scale + viewport.x,
    y: point.y * viewport.scale + viewport.y,
  }
}

export function panViewport(
  viewport: VideoBoardViewport,
  delta: VideoBoardPoint
): VideoBoardViewport {
  return { ...viewport, x: viewport.x + delta.x, y: viewport.y + delta.y }
}

export function zoomViewportAt(
  viewport: VideoBoardViewport,
  screenPoint: VideoBoardPoint,
  nextScale: number
): VideoBoardViewport {
  const scale = clampBoardScale(nextScale)
  const world = screenToWorld(screenPoint, viewport)
  return {
    scale,
    x: screenPoint.x - world.x * scale,
    y: screenPoint.y - world.y * scale,
  }
}

export function nodeRect(node: VideoBoardRect): VideoBoardRect {
  return { x: node.x, y: node.y, width: node.width, height: node.height }
}

export function rectsOverlap(a: VideoBoardRect, b: VideoBoardRect): boolean {
  return (
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  )
}

export function boardBounds(nodes: VideoBoardRect[]): VideoBoardRect | null {
  if (!nodes.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
    maxX = Math.max(maxX, node.x + node.width)
    maxY = Math.max(maxY, node.y + node.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function centerViewportOn(
  rect: VideoBoardRect,
  stage: VideoBoardSize,
  scale = 1
): VideoBoardViewport {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return {
    scale,
    x: stage.width / 2 - cx * scale,
    y: stage.height / 2 - cy * scale,
  }
}

export function fitViewport(
  nodes: VideoBoardRect[],
  stage: VideoBoardSize,
  padding = 64
): VideoBoardViewport {
  const bounds = boardBounds(nodes)
  if (!bounds) return { x: 0, y: 0, scale: 1 }
  const scale = clampBoardScale(
    Math.min(
      (stage.width - padding * 2) / Math.max(bounds.width, 1),
      (stage.height - padding * 2) / Math.max(bounds.height, 1)
    )
  )
  return centerViewportOn(bounds, stage, scale)
}

export function focusViewportOnNode(
  board: VideoBoardDocument,
  nodeId: string,
  stage: VideoBoardSize,
  scale = 1
): VideoBoardViewport | null {
  const node = board.nodes.find(item => item.id === nodeId)
  if (!node) return null
  return centerViewportOn(nodeRect(node), stage, scale)
}

export function placeAvoiding(
  rect: VideoBoardRect,
  existing: VideoBoardRect[]
): VideoBoardPoint {
  if (!existing.some(item => rectsOverlap(rect, item))) {
    return { x: rect.x, y: rect.y }
  }
  const step = 48
  for (let ring = 1; ring <= 12; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue
        const candidate = {
          x: rect.x + dx * step,
          y: rect.y + dy * step,
        }
        const candidateRect = { ...candidate, width: rect.width, height: rect.height }
        if (!existing.some(item => rectsOverlap(candidateRect, item))) {
          return candidate
        }
      }
    }
  }
  return { x: rect.x + 13 * step, y: rect.y + 13 * step }
}

// ── nodes ─────────────────────────────────────────────────────────────

let nodeCounter = 0

function nextNodeId(kind: VideoBoardNodeKind): string {
  nodeCounter += 1
  return `${kind}_${Date.now().toString(36)}_${nodeCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function nextEdgeId(): string {
  return `edge_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export function createVideoBoardNode(
  kind: VideoBoardNodeKind,
  origin: VideoBoardPoint,
  existing: VideoBoardRect[],
  extras: Partial<VideoBoardNode> = {}
): VideoBoardNode {
  const size = VIDEO_NODE_SIZE[kind]
  const id = extras.id || nextNodeId(kind)
  const point = placeAvoiding({ ...origin, ...size }, existing)
  return {
    id,
    kind,
    x: Math.round(point.x),
    y: Math.round(point.y),
    width: size.width,
    height: size.height,
    z: existing.length,
    ...extras,
  }
}

export function addVideoBoardNode(
  board: VideoBoardDocument,
  node: VideoBoardNode
): VideoBoardDocument {
  if (board.nodes.length >= VIDEO_BOARD_MAX_NODES) return board
  if (board.nodes.some(item => item.id === node.id)) return board
  return { ...board, nodes: [...board.nodes, node] }
}

export function updateVideoBoardNode(
  board: VideoBoardDocument,
  nodeId: string,
  patch: Partial<VideoBoardNode>
): VideoBoardDocument {
  return {
    ...board,
    nodes: board.nodes.map(node => (node.id === nodeId ? { ...node, ...patch } : node)),
  }
}

export function moveVideoBoardNodes(
  board: VideoBoardDocument,
  nodeIds: string[],
  delta: VideoBoardPoint
): VideoBoardDocument {
  const ids = new Set(nodeIds)
  return {
    ...board,
    nodes: board.nodes.map(node =>
      ids.has(node.id)
        ? { ...node, x: node.x + delta.x, y: node.y + delta.y }
        : node
    ),
  }
}

export function deleteVideoBoardNodes(
  board: VideoBoardDocument,
  nodeIds: string[]
): VideoBoardDocument {
  const ids = new Set(nodeIds)
  const nodes = board.nodes.filter(node => !ids.has(node.id))
  const edges = board.edges.filter(edge => !ids.has(edge.from) && !ids.has(edge.to))
  const referenced = new Set(
    nodes.map(node => node.groupId).filter((id): id is string => Boolean(id))
  )
  return { ...board, nodes, edges, groups: board.groups.filter(group => referenced.has(group.id)) }
}

export function duplicateVideoBoardNodes(
  board: VideoBoardDocument,
  nodeIds: string[]
): VideoBoardDocument {
  const ids = new Set(nodeIds)
  const clones: VideoBoardNode[] = []
  const rects = board.nodes.map(nodeRect)
  for (const node of board.nodes) {
    if (!ids.has(node.id)) continue
    const clone = createVideoBoardNode(
      node.kind,
      { x: node.x + 32, y: node.y + 32 },
      [...rects, ...clones.map(nodeRect)],
      {
        title: node.title,
        text: node.text,
        prompt: node.prompt,
        assetId: node.assetId,
        modelKey: node.modelKey,
        operation: node.operation,
        ratio: node.ratio,
        resolution: node.resolution,
        seconds: node.seconds,
        referenceMode: node.referenceMode,
        duration: node.duration,
        camera: node.camera,
        groupId: node.groupId,
      }
    )
    clones.push(clone)
  }
  if (!clones.length) return board
  return { ...board, nodes: [...board.nodes, ...clones] }
}

export function bringVideoBoardNodesToFront(
  board: VideoBoardDocument,
  nodeIds: string[]
): VideoBoardDocument {
  const ids = new Set(nodeIds)
  const selected = board.nodes.filter(node => ids.has(node.id))
  const rest = board.nodes.filter(node => !ids.has(node.id))
  return { ...board, nodes: [...rest, ...selected].map((node, index) => ({ ...node, z: index })) }
}

export function sendVideoBoardNodesToBack(
  board: VideoBoardDocument,
  nodeIds: string[]
): VideoBoardDocument {
  const ids = new Set(nodeIds)
  const selected = board.nodes.filter(node => ids.has(node.id))
  const rest = board.nodes.filter(node => !ids.has(node.id))
  return { ...board, nodes: [...selected, ...rest].map((node, index) => ({ ...node, z: index })) }
}

// ── edges ─────────────────────────────────────────────────────────────

function wouldCycle(board: VideoBoardDocument, fromId: string, toId: string): boolean {
  const outgoing = new Map<string, string[]>()
  for (const edge of board.edges) {
    const list = outgoing.get(edge.from) || []
    list.push(edge.to)
    outgoing.set(edge.from, list)
  }
  const stack = [toId]
  const seen = new Set<string>()
  while (stack.length) {
    const current = stack.pop() as string
    if (current === fromId) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const next of outgoing.get(current) || []) stack.push(next)
  }
  return false
}

export function canConnectVideoNodes(
  board: VideoBoardDocument,
  fromId: string,
  toId: string,
  role: VideoBoardEdgeRole = 'reference'
): boolean {
  if (!fromId || !toId || fromId === toId) return false
  const from = board.nodes.find(node => node.id === fromId)
  const to = board.nodes.find(node => node.id === toId)
  if (!from || !to) return false
  if (to.kind === 'text') return false
  if (from.kind === 'generate' && to.kind === 'generate') return false
  if ((role === 'first-frame' || role === 'last-frame') && from.kind !== 'image') return false
  if (role === 'audio' && from.kind !== 'audio') return false
  if (role === 'continue-from' && from.kind !== 'video') return false
  if (board.edges.some(edge => edge.from === fromId && edge.to === toId)) return false
  return !wouldCycle(board, fromId, toId)
}

export function connectVideoBoardNodes(
  board: VideoBoardDocument,
  fromId: string,
  toId: string,
  role: VideoBoardEdgeRole = 'reference'
): VideoBoardDocument {
  if (!canConnectVideoNodes(board, fromId, toId, role)) return board
  if (board.edges.length >= VIDEO_BOARD_MAX_EDGES) return board
  const edge: VideoBoardEdge = {
    id: nextEdgeId(),
    from: fromId,
    to: toId,
    role,
  }
  return { ...board, edges: [...board.edges, edge] }
}

export function deleteVideoBoardEdge(
  board: VideoBoardDocument,
  edgeId: string
): VideoBoardDocument {
  return { ...board, edges: board.edges.filter(edge => edge.id !== edgeId) }
}

const ROLE_CYCLE: VideoBoardEdgeRole[] = ['reference', 'first-frame', 'last-frame']

export function cycleVideoEdgeRole(role: VideoBoardEdgeRole): VideoBoardEdgeRole {
  if (role === 'audio' || role === 'continue-from') return role
  const index = ROLE_CYCLE.indexOf(role)
  return ROLE_CYCLE[(index + 1) % ROLE_CYCLE.length]
}

export function setVideoBoardEdgeRole(
  board: VideoBoardDocument,
  edgeId: string,
  role: VideoBoardEdgeRole
): VideoBoardDocument {
  return {
    ...board,
    edges: board.edges.map(edge => (edge.id === edgeId ? { ...edge, role } : edge)),
  }
}

export function incomingVideoRefs(
  board: VideoBoardDocument,
  nodeId: string
): Array<{ node: VideoBoardNode; role: VideoBoardEdgeRole }> {
  const refs: Array<{ node: VideoBoardNode; role: VideoBoardEdgeRole }> = []
  for (const edge of board.edges) {
    if (edge.to !== nodeId) continue
    const node = board.nodes.find(item => item.id === edge.from)
    if (node) refs.push({ node, role: edge.role })
  }
  return refs
}

/** Ordered job inputs for a generate node: edge creation order, deduped. */
export function videoInputSpecs(
  board: VideoBoardDocument,
  nodeId: string
): VideoInputSpec[] {
  const specs: VideoInputSpec[] = []
  const seen = new Set<string>()
  for (const ref of incomingVideoRefs(board, nodeId)) {
    if (!ref.node.assetId || seen.has(ref.node.assetId)) continue
    seen.add(ref.node.assetId)
    specs.push({ assetId: ref.node.assetId, role: ref.role })
  }
  return specs
}

/** Node prompt plus any incoming text notes (script / identity). */
export function collectVideoNodePrompt(
  board: VideoBoardDocument,
  nodeId: string
): string {
  const node = board.nodes.find(item => item.id === nodeId)
  const parts: string[] = []
  const own = (node?.prompt || '').trim()
  if (own) parts.push(own)
  for (const ref of incomingVideoRefs(board, nodeId)) {
    const text = (ref.node.text || '').trim()
    if (ref.node.kind === 'text' && text) parts.push(text)
  }
  return parts.join('\n')
}

// ── templates (server parity with board.py §5.5) ─────────────────────

/** Node spacing shared with the backend template layouts. */
export const BOARD_TEMPLATE_GAP = 64
/** Generate column sits this far right of the template origin. */
export const BOARD_TEMPLATE_GENERATE_COLUMN_X = 400

/**
 * Nodes+edges fragment for a §5.5 template. Coordinates mirror
 * `instantiate_template` in knorvia/services/video_studio/board.py exactly
 * (see place_template there for the backend placement flow). Templates only
 * place nodes — they never carry jobId/status and never fire jobs.
 */
export function instantiateBoardTemplate(
  templateId: BoardTemplateId,
  origin?: VideoBoardPoint
): { nodes: VideoBoardNode[]; edges: VideoBoardEdge[] } {
  const ox = origin?.x ?? 0
  const oy = origin?.y ?? 0
  const gap = BOARD_TEMPLATE_GAP
  const generateSize = VIDEO_NODE_SIZE.generate

  const nodes: VideoBoardNode[] = []
  const edges: VideoBoardEdge[] = []
  const addNode = (
    kind: VideoBoardNodeKind,
    dx: number,
    dy: number,
    extras: Partial<VideoBoardNode> = {}
  ): VideoBoardNode => {
    const size = VIDEO_NODE_SIZE[kind]
    const node: VideoBoardNode = {
      id: nextNodeId(kind),
      kind,
      x: Math.round(ox + dx),
      y: Math.round(oy + dy),
      width: size.width,
      height: size.height,
      z: nodes.length,
      ...extras,
    }
    nodes.push(node)
    return node
  }
  const addEdge = (from: string, to: string, role: VideoBoardEdgeRole) => {
    edges.push({ id: nextEdgeId(), from, to, role })
  }
  const addGenerate = (
    dx: number,
    dy: number,
    operation = 'image_to_video',
    extras: Partial<VideoBoardNode> = {}
  ) => addNode('generate', dx, dy, { operation, ...extras })

  if (templateId === 'shot-i2v') {
    const image = addNode('image', 0, 0)
    const generate = addGenerate(BOARD_TEMPLATE_GENERATE_COLUMN_X, 0)
    addEdge(image.id, generate.id, 'first-frame')
  } else if (templateId === 'first-last') {
    const first = addNode('image', 0, 0)
    const last = addNode('image', 0, VIDEO_NODE_SIZE.image.height + gap)
    const generate = addGenerate(BOARD_TEMPLATE_GENERATE_COLUMN_X, 0)
    addEdge(first.id, generate.id, 'first-frame')
    addEdge(last.id, generate.id, 'last-frame')
  } else if (templateId === 'storyboard-6') {
    const note = addNode('text', 0, 0)
    const startX = VIDEO_NODE_SIZE.text.width + gap
    const stepX = generateSize.width + gap
    for (let index = 0; index < 6; index += 1) {
      const generate = addGenerate(startX + index * stepX, 0)
      addEdge(note.id, generate.id, 'reference')
    }
  } else if (templateId === 'character-episode') {
    const note = addNode('text', 0, 0)
    const image = addNode('image', 0, VIDEO_NODE_SIZE.text.height + gap)
    const stepX = generateSize.width + gap
    const stepY = generateSize.height + gap
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 2; column += 1) {
        const generate = addGenerate(BOARD_TEMPLATE_GENERATE_COLUMN_X + column * stepX, row * stepY)
        addEdge(note.id, generate.id, 'reference')
        addEdge(image.id, generate.id, 'first-frame')
      }
    }
  } else if (templateId === 'character-card') {
    // Phase B1: name note + reference image + three-view sheet feeding a
    // column of four generate cards that all share the three-view reference.
    addNode('text', 0, 0)
    addNode('image', 0, VIDEO_NODE_SIZE.text.height + gap)
    const threeView = addNode(
      'image',
      0,
      VIDEO_NODE_SIZE.text.height + gap + VIDEO_NODE_SIZE.image.height + gap
    )
    const stepY = generateSize.height + gap
    for (let index = 0; index < 4; index += 1) {
      const generate = addGenerate(BOARD_TEMPLATE_GENERATE_COLUMN_X, index * stepY)
      addEdge(threeView.id, generate.id, 'reference')
    }
  } else if (templateId === 'vertical-series') {
    // §F3 vertical episodic cut: one story note driving a 9:16 six-shot row.
    const note = addNode('text', 0, 0)
    const startX = VIDEO_NODE_SIZE.text.width + gap
    const stepX = generateSize.width + gap
    for (let index = 0; index < 6; index += 1) {
      const generate = addGenerate(startX + index * stepX, 0, 'image_to_video', { ratio: '9:16' })
      addEdge(note.id, generate.id, 'reference')
    }
  } else if (templateId === 'product-triptych') {
    // §F3 product showcase: one product photo → front / detail / in-use takes.
    const image = addNode('image', 0, 0)
    const stepY = generateSize.height + gap
    for (let index = 0; index < 3; index += 1) {
      const generate = addGenerate(BOARD_TEMPLATE_GENERATE_COLUMN_X, index * stepY)
      addEdge(image.id, generate.id, 'first-frame')
    }
  } else if (templateId === 'talking-head') {
    // §F3 talking head: presenter keyframe + script note (the note doubles as
    // the caption/voiceover source at compose time).
    const image = addNode('image', 0, 0)
    const note = addNode('text', 0, VIDEO_NODE_SIZE.image.height + gap)
    const generate = addGenerate(BOARD_TEMPLATE_GENERATE_COLUMN_X, 0)
    addEdge(image.id, generate.id, 'first-frame')
    addEdge(note.id, generate.id, 'reference')
  } else if (templateId === 'text-to-video') {
    // §F3 narration video: one note driving four voiceover-first shots.
    const note = addNode('text', 0, 0)
    const startX = VIDEO_NODE_SIZE.text.width + gap
    const stepX = generateSize.width + gap
    for (let index = 0; index < 4; index += 1) {
      const generate = addGenerate(startX + index * stepX, 0)
      addEdge(note.id, generate.id, 'reference')
    }
  } else if (templateId === 'compare-ab') {
    // §F3 A/B take: same reference, two takes — keep the better cut.
    const image = addNode('image', 0, 0)
    const first = addGenerate(BOARD_TEMPLATE_GENERATE_COLUMN_X, 0)
    const second = addGenerate(BOARD_TEMPLATE_GENERATE_COLUMN_X, generateSize.height + gap)
    addEdge(image.id, first.id, 'first-frame')
    addEdge(image.id, second.id, 'first-frame')
  } else if (templateId === 'tutorial-steps') {
    // §F3 tutorial chain: extend the previous step's clip shot by shot.
    const note = addNode('text', 0, 0)
    const clip = addNode('video', 0, VIDEO_NODE_SIZE.text.height + gap)
    const first = addGenerate(BOARD_TEMPLATE_GENERATE_COLUMN_X, 0, 'extend')
    const second = addGenerate(
      BOARD_TEMPLATE_GENERATE_COLUMN_X,
      generateSize.height + gap,
      'extend'
    )
    addEdge(clip.id, first.id, 'continue-from')
    addEdge(note.id, second.id, 'reference')
  } else if (templateId === 'grid-nine') {
    // §F3 composition grid: 3×3 nine-frame planning scaffold.
    const note = addNode('text', 0, 0)
    const startX = VIDEO_NODE_SIZE.text.width + gap
    const stepX = generateSize.width + gap
    const stepY = generateSize.height + gap
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        const generate = addGenerate(startX + column * stepX, row * stepY)
        addEdge(note.id, generate.id, 'reference')
      }
    }
  } else {
    // extend-chain
    const clip = addNode('video', 0, 0)
    const generate = addGenerate(BOARD_TEMPLATE_GENERATE_COLUMN_X, 0, 'extend')
    addEdge(clip.id, generate.id, 'continue-from')
  }
  return { nodes, edges }
}

// ── geometry / interaction helpers ────────────────────────────────────

export function connectionHandles(from: VideoBoardRect, to: VideoBoardRect) {
  return wireHandles(from, to)
}

export function connectionPath(from: VideoBoardRect, to: VideoBoardRect): string {
  return wirePath(from, to)
}

function distanceToSegment(
  point: VideoBoardPoint,
  a: VideoBoardPoint,
  b: VideoBoardPoint
): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (!lengthSquared) return Math.hypot(point.x - a.x, point.y - a.y)
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

export function hitTestConnection(
  from: VideoBoardRect,
  to: VideoBoardRect,
  point: VideoBoardPoint,
  threshold: number
): boolean {
  return hitTestWire(from, to, point, threshold)
}

export function dragExceededThreshold(
  start: VideoBoardPoint,
  current: VideoBoardPoint,
  threshold = 8
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > threshold
}

export function nodesInRect(
  nodes: VideoBoardNode[],
  rect: VideoBoardRect
): string[] {
  return nodes.filter(node => rectsOverlap(nodeRect(node), rect)).map(node => node.id)
}

export function normalizeRect(rect: VideoBoardRect): VideoBoardRect {
  return {
    x: Math.min(rect.x, rect.x + rect.width),
    y: Math.min(rect.y, rect.y + rect.height),
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  }
}

export function toggleVideoBoardSelection(
  current: string[],
  nodeId: string,
  additive: boolean
): string[] {
  if (additive) {
    return current.includes(nodeId)
      ? current.filter(id => id !== nodeId)
      : [...current, nodeId]
  }
  return current.includes(nodeId) && current.length === 1 ? current : [nodeId]
}

// ── job + asset plumbing ──────────────────────────────────────────────

export function seedVideoAssetOnBoard(
  board: VideoBoardDocument,
  asset: { id: string; kind: 'image' | 'video' | 'audio'; filename?: string; duration?: number | null },
  origin?: VideoBoardPoint
): VideoBoardDocument {
  if (board.nodes.some(node => node.assetId === asset.id)) return board
  const point = origin || nextToContent(board)
  const node = createVideoBoardNode(asset.kind, point, board.nodes.map(nodeRect), {
    assetId: asset.id,
    title: asset.filename || '',
    duration: asset.kind === 'video' && asset.duration ? asset.duration : undefined,
  })
  return addVideoBoardNode(board, node)
}

export function nextToContent(board: VideoBoardDocument): VideoBoardPoint {
  if (!board.nodes.length) return { x: 0, y: 0 }
  const right = Math.max(...board.nodes.map(node => node.x + node.width))
  return { x: right + 64, y: 0 }
}

export function applyVideoJobToBoard(
  board: VideoBoardDocument,
  input: {
    nodeId?: string | null
    jobId: string
    status: string
    prompt?: string
    outputAssetId?: string | null
    duration?: number | null
  }
): VideoBoardDocument {
  let next = board
  const target = input.nodeId
    ? board.nodes.find(node => node.id === input.nodeId)
    : board.nodes.find(node => node.jobId === input.jobId && node.kind === 'generate')
  if (target) {
    next = updateVideoBoardNode(next, target.id, {
      jobId: input.jobId,
      status: input.status,
      outputAssetId: input.outputAssetId || undefined,
      duration: input.duration || target.duration,
      prompt: input.prompt || target.prompt,
    })
    return next
  }
  // Job finished with no node (e.g. board emptied mid-run): attach a card.
  const node = createVideoBoardNode('generate', nextToContent(board), board.nodes.map(nodeRect), {
    jobId: input.jobId,
    status: input.status,
    prompt: input.prompt || '',
    outputAssetId: input.outputAssetId || undefined,
    duration: input.duration || undefined,
  })
  return addVideoBoardNode(next, node)
}

// ── normalization (server parity) ─────────────────────────────────────

function finite(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function optionalString(value: unknown, limit: number): string | undefined {
  if (value == null) return undefined
  const text = String(value).trim()
  return text ? text.slice(0, limit) : undefined
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

export function normalizeVideoBoard(raw: unknown): VideoBoardDocument {
  const document = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const revisionRaw = document.revision
  const revision =
    typeof revisionRaw === 'number' && Number.isInteger(revisionRaw) && revisionRaw >= 0
      ? revisionRaw
      : 0

  const viewportRaw = (document.viewport && typeof document.viewport === 'object'
    ? document.viewport
    : {}) as Record<string, unknown>
  const viewport: VideoBoardViewport = {
    x: clamp(finite(viewportRaw.x) ?? 0, -1_000_000, 1_000_000),
    y: clamp(finite(viewportRaw.y) ?? 0, -1_000_000, 1_000_000),
    scale: clampBoardScale(finite(viewportRaw.scale) ?? 1),
  }

  const nodes: VideoBoardNode[] = []
  const seen = new Set<string>()
  const rawNodes = Array.isArray(document.nodes) ? document.nodes : []
  for (const item of rawNodes.slice(0, VIDEO_BOARD_MAX_NODES)) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = optionalString(record.id, 128)
    const kind = optionalString(record.kind, 32)
    if (!id || seen.has(id)) continue
    if (!kind || !(VIDEO_BOARD_NODE_KINDS as readonly string[]).includes(kind)) continue
    if (kind === 'timetrack') continue
    const x = finite(record.x)
    const y = finite(record.y)
    if (x == null || y == null) continue
    const defaults = VIDEO_NODE_SIZE[kind as VideoBoardNodeKind]
    const node: VideoBoardNode = {
      id,
      kind: kind as VideoBoardNodeKind,
      x: clamp(x, -1_000_000, 1_000_000),
      y: clamp(y, -1_000_000, 1_000_000),
      width: clamp(finite(record.width) || defaults.width, 80, 100_000),
      height: clamp(finite(record.height) || defaults.height, 80, 100_000),
      z: Number.isInteger(finite(record.z)) ? (finite(record.z) as number) : nodes.length,
    }
    const stringFields: Array<[keyof VideoBoardNode, number]> = [
      ['title', 160],
      ['text', 4000],
      ['prompt', 4000],
      ['jobId', 128],
      ['status', 64],
      ['groupId', 128],
      ['modelKey', 160],
      ['operation', 64],
      ['ratio', 32],
      ['resolution', 32],
      ['referenceMode', 32],
      ['camera', 64],
      ['templateId', 64],
      ['storyboardShotId', 128],
    ]
    for (const [field, limit] of stringFields) {
      const value = optionalString(record[field as string], limit)
      if (value !== undefined) (node as Record<string, unknown>)[field as string] = value
    }
    if (kind === 'image' || kind === 'video' || kind === 'audio') {
      const assetId = optionalString(record.assetId, 160)
      if (assetId) node.assetId = assetId
    }
    if (kind === 'generate') {
      const outputAssetId = optionalString(record.outputAssetId, 160)
      if (outputAssetId) node.outputAssetId = outputAssetId
      const seconds = finite(record.seconds)
      if (seconds && seconds > 0) node.seconds = Math.min(seconds, 3600)
    }
    if (kind === 'video' || kind === 'generate') {
      const duration = finite(record.duration)
      if (duration && duration > 0) node.duration = Math.min(duration, 3600)
    }
    nodes.push(node)
    seen.add(id)
  }

  const nodeIds = seen
  const edges: VideoBoardEdge[] = []
  const seenEdges = new Set<string>()
  const rawEdges = Array.isArray(document.edges) ? document.edges : []
  for (const item of rawEdges.slice(0, VIDEO_BOARD_MAX_EDGES)) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const from = optionalString(record.from, 128)
    const to = optionalString(record.to, 128)
    if (!from || !to || from === to) continue
    if (!nodeIds.has(from) || !nodeIds.has(to)) continue
    const key = `${from}:${to}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    const rawRole = optionalString(record.role, 32)
    const role = (VIDEO_BOARD_EDGE_ROLES as readonly string[]).includes(rawRole || '')
      ? (rawRole as VideoBoardEdgeRole)
      : 'reference'
    edges.push({
      id: optionalString(record.id, 128) || `edge_${key}_${edges.length}`,
      from,
      to,
      role,
    })
  }

  const referenced = new Set(nodes.map(node => node.groupId).filter(Boolean) as string[])
  const groups: VideoBoardGroup[] = []
  const seenGroups = new Set<string>()
  const rawGroups = Array.isArray(document.groups) ? document.groups : []
  for (const item of rawGroups) {
    if (groups.length >= 80) break
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = optionalString(record.id, 128)
    if (!id || seenGroups.has(id) || !referenced.has(id)) continue
    seenGroups.add(id)
    groups.push({ id, title: optionalString(record.title, 160) || 'Group' })
  }
  for (const node of nodes) {
    if (node.groupId && !seenGroups.has(node.groupId)) delete node.groupId
  }

  return {
    version: VIDEO_BOARD_DOCUMENT_VERSION,
    revision,
    viewport,
    nodes,
    edges,
    groups,
    updated_at: finite(document.updated_at),
  }
}

export function emptyVideoBoard(): VideoBoardDocument {
  return normalizeVideoBoard({
    version: VIDEO_BOARD_DOCUMENT_VERSION,
    revision: 0,
    viewport: { x: 0, y: 0, scale: 1 },
    nodes: [],
    edges: [],
    groups: [],
    updated_at: null,
  })
}

export function isVideoBoardEdgeRole(value: unknown): value is VideoBoardEdgeRole {
  return (VIDEO_BOARD_EDGE_ROLES as readonly string[]).includes(String(value))
}

export function isVideoBoardNodeKind(value: unknown): value is VideoBoardNodeKind {
  return (VIDEO_BOARD_NODE_KINDS as readonly string[]).includes(String(value))
}
