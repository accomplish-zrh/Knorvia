/**
 * Native Image Studio infinite board.
 *
 * Capability model studied from an external visual workbench (viewport,
 * nodes, connections-as-references, collision placement, job results),
 * implemented against Knorvia assets/jobs — not their document format.
 */

import { hitTestWire, wireHandles, wirePath } from '@/lib/canvas-wires'

export const BOARD_DOCUMENT_VERSION = 1
export const BOARD_MIN_SCALE = 0.15
export const BOARD_MAX_SCALE = 3
export const BOARD_MAX_NODES = 200
export const BOARD_MAX_EDGES = 400
export const BOARD_ASSET_MIME = 'application/x-knorvia-studio-asset'

export const BOARD_TOOLS = ['select', 'pan', 'connect'] as const
export type BoardTool = (typeof BOARD_TOOLS)[number]

export const BOARD_NODE_KINDS = ['image', 'generate', 'text'] as const
export type BoardNodeKind = (typeof BOARD_NODE_KINDS)[number]

export const BOARD_EDGE_ROLES = ['reference', 'mask'] as const
export type BoardEdgeRole = (typeof BOARD_EDGE_ROLES)[number]

export const BOARD_ALIGN_MODES = [
  'left',
  'right',
  'top',
  'bottom',
  'centerX',
  'centerY',
  'distributeX',
  'distributeY',
] as const
export type BoardAlignMode = (typeof BOARD_ALIGN_MODES)[number]

export const BOARD_TEMPLATE_IDS = ['product-set', 'three-view', 'picture-book'] as const
export type BoardTemplateId = (typeof BOARD_TEMPLATE_IDS)[number]

export const BOARD_RECIPE_MIME = 'application/x-knorvia-studio-recipe'
export const BOARD_MENTION_PATTERN = /@\[([^\]]+)\]/g

export const BOARD_OUTPUT_QUALITIES = ['', 'low', 'medium', 'high', '1K', '2K', '4K'] as const

export type BoardPoint = { x: number; y: number }
export type BoardSize = { width: number; height: number }
export type BoardRect = BoardPoint & BoardSize

export type BoardViewport = BoardPoint & { scale: number }

export type BoardGroup = {
  id: string
  title: string
}

export type BoardNode = BoardRect & {
  id: string
  kind: BoardNodeKind
  z: number
  title?: string
  prompt?: string
  text?: string
  assetId?: string
  jobId?: string
  status?: string
  groupId?: string
  parentNodeId?: string
  modelKey?: string
  ratio?: string
  quality?: string
  customWidth?: number
  customHeight?: number
  copyStyle?: BoardCopyStyle
  copyLength?: BoardCopyLength
}

export type BoardEdge = {
  id: string
  from: string
  to: string
  role: BoardEdgeRole
}

export type BoardDocument = {
  version: typeof BOARD_DOCUMENT_VERSION
  /** Server CAS revision. Local reducers preserve it until a save succeeds. */
  revision: number
  viewport: BoardViewport
  nodes: BoardNode[]
  edges: BoardEdge[]
  groups: BoardGroup[]
}

export type BoardRecipe = {
  version: 1
  title?: string
  nodes: BoardNode[]
  edges: BoardEdge[]
  groups: BoardGroup[]
}

export const NODE_SIZE: Record<BoardNodeKind, BoardSize> = {
  image: { width: 280, height: 280 },
  generate: { width: 280, height: 280 },
  text: { width: 280, height: 248 },
}

export const BOARD_COPY_STYLES = ['poster', 'product', 'story', 'character'] as const
export type BoardCopyStyle = (typeof BOARD_COPY_STYLES)[number]

export const BOARD_COPY_LENGTHS = ['short', 'standard', 'long'] as const
export type BoardCopyLength = (typeof BOARD_COPY_LENGTHS)[number]

export type BoardHandleSide = 'in' | 'out'

export function isBoardCopyStyle(value: unknown): value is BoardCopyStyle {
  return BOARD_COPY_STYLES.includes(value as BoardCopyStyle)
}

export function isBoardCopyLength(value: unknown): value is BoardCopyLength {
  return BOARD_COPY_LENGTHS.includes(value as BoardCopyLength)
}

export function emptyBoard(): BoardDocument {
  return {
    version: BOARD_DOCUMENT_VERSION,
    revision: 0,
    viewport: { x: 0, y: 0, scale: 1 },
    nodes: [],
    edges: [],
    groups: [],
  }
}

export function isBoardAlignMode(value: unknown): value is BoardAlignMode {
  return BOARD_ALIGN_MODES.includes(value as BoardAlignMode)
}

export function isBoardTemplateId(value: unknown): value is BoardTemplateId {
  return BOARD_TEMPLATE_IDS.includes(value as BoardTemplateId)
}

export function isBoardTool(value: unknown): value is BoardTool {
  return BOARD_TOOLS.includes(value as BoardTool)
}

export function isBoardNodeKind(value: unknown): value is BoardNodeKind {
  return BOARD_NODE_KINDS.includes(value as BoardNodeKind)
}

export function isBoardEdgeRole(value: unknown): value is BoardEdgeRole {
  return BOARD_EDGE_ROLES.includes(value as BoardEdgeRole)
}

export function clampBoardScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(BOARD_MAX_SCALE, Math.max(BOARD_MIN_SCALE, scale))
}

export function screenToWorld(point: BoardPoint, viewport: BoardViewport): BoardPoint {
  return {
    x: (point.x - viewport.x) / viewport.scale,
    y: (point.y - viewport.y) / viewport.scale,
  }
}

export function worldToScreen(point: BoardPoint, viewport: BoardViewport): BoardPoint {
  return {
    x: point.x * viewport.scale + viewport.x,
    y: point.y * viewport.scale + viewport.y,
  }
}

export function panViewport(viewport: BoardViewport, delta: BoardPoint): BoardViewport {
  return { ...viewport, x: viewport.x + delta.x, y: viewport.y + delta.y }
}

export function zoomViewportAt(
  viewport: BoardViewport,
  screenPoint: BoardPoint,
  nextScale: number
): BoardViewport {
  const scale = clampBoardScale(nextScale)
  const world = screenToWorld(screenPoint, viewport)
  return {
    scale,
    x: screenPoint.x - world.x * scale,
    y: screenPoint.y - world.y * scale,
  }
}

export function nodeRect(node: BoardRect): BoardRect {
  return { x: node.x, y: node.y, width: node.width, height: node.height }
}

export function rectsOverlap(a: BoardRect, b: BoardRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

export function boardBounds(nodes: BoardRect[]): BoardRect | null {
  if (!nodes.length) return null
  const left = Math.min(...nodes.map(node => node.x))
  const top = Math.min(...nodes.map(node => node.y))
  const right = Math.max(...nodes.map(node => node.x + node.width))
  const bottom = Math.max(...nodes.map(node => node.y + node.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function centerViewportOn(
  rect: BoardRect,
  stage: BoardSize,
  scale = 1
): BoardViewport {
  const nextScale = clampBoardScale(scale)
  return {
    scale: nextScale,
    x: stage.width / 2 - (rect.x + rect.width / 2) * nextScale,
    y: stage.height / 2 - (rect.y + rect.height / 2) * nextScale,
  }
}

export function fitViewport(
  nodes: BoardRect[],
  stage: BoardSize,
  padding = 64
): BoardViewport {
  const bounds = boardBounds(nodes)
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    return { x: stage.width / 2, y: stage.height / 2, scale: 1 }
  }
  const scale = clampBoardScale(
    Math.min(
      (stage.width - padding * 2) / bounds.width,
      (stage.height - padding * 2) / bounds.height
    )
  )
  return {
    scale,
    x: (stage.width - bounds.width * scale) / 2 - bounds.x * scale,
    y: (stage.height - bounds.height * scale) / 2 - bounds.y * scale,
  }
}

export function placeAvoiding(rect: BoardRect, existing: BoardRect[]): BoardPoint {
  let x = rect.x
  let y = rect.y
  for (let step = 0; step < 32; step += 1) {
    const next = { ...rect, x, y }
    if (!existing.some(item => rectsOverlap(next, item))) return { x, y }
    x += rect.width + 40
    if (step % 4 === 3) {
      x = rect.x
      y += rect.height + 40
    }
  }
  return { x, y }
}

export function createBoardNode(
  kind: BoardNodeKind,
  origin: BoardPoint,
  existing: BoardRect[],
  extras: Partial<BoardNode> = {}
): BoardNode {
  const size = extras.width && extras.height ? { width: extras.width, height: extras.height } : NODE_SIZE[kind]
  const placed = placeAvoiding({ ...origin, ...size }, existing)
  const z = existing.length
  return {
    id: extras.id || `node_${Math.random().toString(36).slice(2, 10)}`,
    kind,
    x: placed.x,
    y: placed.y,
    width: size.width,
    height: size.height,
    z: extras.z ?? z,
    ...omitUndefined({
      title: extras.title,
      prompt: extras.prompt,
      text: extras.text,
      assetId: extras.assetId,
      jobId: extras.jobId,
      status: extras.status,
      groupId: extras.groupId,
      parentNodeId: extras.parentNodeId,
      modelKey: extras.modelKey,
      ratio: extras.ratio,
      quality: extras.quality,
      customWidth: extras.customWidth,
      customHeight: extras.customHeight,
      copyStyle: extras.copyStyle,
      copyLength: extras.copyLength,
    }),
  }
}

export function addBoardNode(board: BoardDocument, node: BoardNode): BoardDocument {
  if (board.nodes.length >= BOARD_MAX_NODES) return board
  if (board.nodes.some(item => item.id === node.id)) return board
  return { ...board, nodes: [...board.nodes, node] }
}

export function updateBoardNode(
  board: BoardDocument,
  nodeId: string,
  patch: Partial<BoardNode>
): BoardDocument {
  return {
    ...board,
    nodes: board.nodes.map(node => (node.id === nodeId ? { ...node, ...patch, id: node.id } : node)),
  }
}

export function moveBoardNodes(
  board: BoardDocument,
  nodeIds: string[],
  delta: BoardPoint
): BoardDocument {
  if (!delta.x && !delta.y) return board
  const selected = new Set(nodeIds)
  return {
    ...board,
    nodes: board.nodes.map(node =>
      selected.has(node.id) ? { ...node, x: node.x + delta.x, y: node.y + delta.y } : node
    ),
  }
}

export function deleteBoardNodes(board: BoardDocument, nodeIds: string[]): BoardDocument {
  const removed = new Set(nodeIds)
  const nodes = board.nodes.filter(node => !removed.has(node.id))
  const usedGroups = new Set(nodes.map(node => node.groupId).filter(Boolean))
  return {
    ...board,
    nodes,
    edges: board.edges.filter(edge => !removed.has(edge.from) && !removed.has(edge.to)),
    groups: (board.groups || []).filter(group => usedGroups.has(group.id)),
  }
}

export function duplicateBoardNodes(board: BoardDocument, nodeIds: string[]): BoardDocument {
  const selected = board.nodes.filter(node => nodeIds.includes(node.id))
  if (!selected.length) return board
  const map = new Map<string, string>()
  const copies = selected.map((node, index) => {
    const id = `node_${Math.random().toString(36).slice(2, 10)}`
    map.set(node.id, id)
    return {
      ...node,
      id,
      x: node.x + 48,
      y: node.y + 48,
      z: board.nodes.length + index,
    }
  })
  const edges = board.edges.flatMap(edge => {
    const from = map.get(edge.from)
    const to = map.get(edge.to)
    if (!from || !to) return []
    return [{ ...edge, id: `edge_${Math.random().toString(36).slice(2, 10)}`, from, to }]
  })
  return { ...board, nodes: [...board.nodes, ...copies], edges: [...board.edges, ...edges] }
}

export function bringBoardNodesToFront(board: BoardDocument, nodeIds: string[]): BoardDocument {
  const selected = new Set(nodeIds)
  const rest = board.nodes.filter(node => !selected.has(node.id))
  const moved = board.nodes.filter(node => selected.has(node.id))
  return { ...board, nodes: [...rest, ...moved].map((node, z) => ({ ...node, z })) }
}

export function sendBoardNodesToBack(board: BoardDocument, nodeIds: string[]): BoardDocument {
  const selected = new Set(nodeIds)
  const rest = board.nodes.filter(node => !selected.has(node.id))
  const moved = board.nodes.filter(node => selected.has(node.id))
  return { ...board, nodes: [...moved, ...rest].map((node, z) => ({ ...node, z })) }
}

export function deleteBoardEdge(board: BoardDocument, edgeId: string): BoardDocument {
  if (!board.edges.some(edge => edge.id === edgeId)) return board
  return { ...board, edges: board.edges.filter(edge => edge.id !== edgeId) }
}

export function iterateFromImage(
  board: BoardDocument,
  nodeId: string
): { board: BoardDocument; node: BoardNode } | null {
  const source = board.nodes.find(node => node.id === nodeId && node.assetId)
  if (!source) return null
  const node = createBoardNode(
    'generate',
    { x: source.x + source.width + 48, y: source.y },
    board.nodes,
    { prompt: source.prompt || '', parentNodeId: source.id, title: source.title }
  )
  return { board: connectBoardNodes(addBoardNode(board, node), source.id, node.id), node }
}

export function incomingRefCount(board: BoardDocument, nodeId: string): number {
  return incomingBoardRefs(board, nodeId).length
}

export function edgeAutoPan(
  point: BoardPoint,
  stage: BoardSize,
  margin = 56,
  speed = 16
): BoardPoint {
  const pull = (distance: number) => ((margin - Math.max(0, Math.min(margin, distance))) / margin) * speed
  return {
    x: point.x < margin ? pull(point.x) : point.x > stage.width - margin ? -pull(stage.width - point.x) : 0,
    y: point.y < margin ? pull(point.y) : point.y > stage.height - margin ? -pull(stage.height - point.y) : 0,
  }
}

export function dragExceededThreshold(start: BoardPoint, current: BoardPoint, threshold = 8): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold
}

export type SnapGuide = {
  axis: 'vertical' | 'horizontal'
  value: number
  from: number
  to: number
}

export function snapNodeMove(
  node: BoardRect,
  next: BoardPoint,
  others: BoardRect[],
  scale: number,
  screenThreshold = 6
): { point: BoardPoint; guides: SnapGuide[] } {
  const threshold = screenThreshold / Math.max(0.05, scale)
  const self = [
    { axis: 'vertical' as const, value: next.x, offset: 0 },
    { axis: 'vertical' as const, value: next.x + node.width / 2, offset: node.width / 2 },
    { axis: 'vertical' as const, value: next.x + node.width, offset: node.width },
    { axis: 'horizontal' as const, value: next.y, offset: 0 },
    { axis: 'horizontal' as const, value: next.y + node.height / 2, offset: node.height / 2 },
    { axis: 'horizontal' as const, value: next.y + node.height, offset: node.height },
  ]
  let x = next.x
  let y = next.y
  let bestV: { distance: number; value: number; offset: number; other: BoardRect } | null = null
  let bestH: { distance: number; value: number; offset: number; other: BoardRect } | null = null
  for (const other of others) {
    const lines = [
      { axis: 'vertical' as const, value: other.x },
      { axis: 'vertical' as const, value: other.x + other.width / 2 },
      { axis: 'vertical' as const, value: other.x + other.width },
      { axis: 'horizontal' as const, value: other.y },
      { axis: 'horizontal' as const, value: other.y + other.height / 2 },
      { axis: 'horizontal' as const, value: other.y + other.height },
    ]
    for (const mine of self) {
      for (const line of lines) {
        if (mine.axis !== line.axis) continue
        const distance = Math.abs(mine.value - line.value)
        if (distance > threshold) continue
        if (mine.axis === 'vertical' && (!bestV || distance < bestV.distance)) {
          bestV = { distance, value: line.value, offset: mine.offset, other }
        }
        if (mine.axis === 'horizontal' && (!bestH || distance < bestH.distance)) {
          bestH = { distance, value: line.value, offset: mine.offset, other }
        }
      }
    }
  }
  const guides: SnapGuide[] = []
  if (bestV) {
    x = bestV.value - bestV.offset
    guides.push({
      axis: 'vertical',
      value: bestV.value,
      from: Math.min(y, bestV.other.y),
      to: Math.max(y + node.height, bestV.other.y + bestV.other.height),
    })
  }
  if (bestH) {
    y = bestH.value - bestH.offset
    guides.push({
      axis: 'horizontal',
      value: bestH.value,
      from: Math.min(x, bestH.other.x),
      to: Math.max(x + node.width, bestH.other.x + bestH.other.width),
    })
  }
  return { point: { x, y }, guides }
}

export function extractMentionIds(text: string): string[] {
  const ids: string[] = []
  const pattern = new RegExp(BOARD_MENTION_PATTERN.source, 'g')
  for (const match of text.matchAll(pattern)) {
    if (match[1] && !ids.includes(match[1])) ids.push(match[1])
  }
  return ids
}

export function mentionLabel(node: BoardNode): string {
  if (node.title?.trim()) return node.title.trim()
  if (node.kind === 'text') return (node.text || '').trim().slice(0, 24) || 'Text'
  if (node.kind === 'generate') return (node.prompt || '').trim().slice(0, 24) || 'Generate'
  return (node.prompt || '').trim().slice(0, 24) || 'Image'
}

export function resolveMentionText(board: BoardDocument, text: string): string {
  return text.replace(BOARD_MENTION_PATTERN, (_full, id: string) => {
    const node = board.nodes.find(item => item.id === id)
    return node ? mentionLabel(node) : ''
  })
}

export function mentionedAssetIds(board: BoardDocument, text: string): string[] {
  const ids: string[] = []
  for (const id of extractMentionIds(text)) {
    const assetId = board.nodes.find(node => node.id === id)?.assetId
    if (assetId && !ids.includes(assetId)) ids.push(assetId)
  }
  return ids
}

export function insertBoardMention(text: string, nodeId: string): string {
  const token = `@[${nodeId}]`
  if (text.includes(token)) return text
  const trimmed = text.replace(/@([^\s@[\]]*)$/, '')
  const prefix = trimmed && !trimmed.endsWith(' ') && !trimmed.endsWith('\n') ? `${trimmed} ` : trimmed
  return `${prefix}${token} `
}

export function collectBoardPrompt(board: BoardDocument, nodeId: string): string {
  const node = board.nodes.find(item => item.id === nodeId)
  const own = resolveMentionText(board, node?.prompt?.trim() || '').trim()
  const texts: string[] = []
  const seen = new Set<string>([nodeId])
  const stack = incomingBoardRefs(board, nodeId).map(item => item.node.id)
  while (stack.length) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    const item = board.nodes.find(entry => entry.id === id)
    if (!item) continue
    if (item.kind === 'text') {
      const text = resolveMentionText(board, (item.text || '').trim()).trim()
      if (text) texts.push(text)
    }
    stack.push(...incomingBoardRefs(board, id).map(ref => ref.node.id))
  }
  return [own, ...texts].filter(Boolean).join('\n')
}

export function connectionHandles(from: BoardRect, to: BoardRect) {
  return wireHandles(from, to)
}

export function hitTestConnection(
  from: BoardRect,
  to: BoardRect,
  point: BoardPoint,
  threshold: number
): boolean {
  return hitTestWire(from, to, point, threshold)
}

export function canConnectNodes(
  board: BoardDocument,
  fromId: string,
  toId: string,
  role: BoardEdgeRole = 'reference'
): boolean {
  if (!fromId || !toId || fromId === toId) return false
  const from = board.nodes.find(node => node.id === fromId)
  const to = board.nodes.find(node => node.id === toId)
  if (!from || !to) return false
  if (to.kind === 'text') return false
  if (role === 'mask' && !from.assetId) return false
  if (board.edges.some(edge => edge.from === fromId && edge.to === toId)) return false
  return !wouldCycle(board, fromId, toId)
}

export function connectBoardNodes(
  board: BoardDocument,
  fromId: string,
  toId: string,
  role: BoardEdgeRole = 'reference'
): BoardDocument {
  if (!canConnectNodes(board, fromId, toId, role) || board.edges.length >= BOARD_MAX_EDGES) return board
  return {
    ...board,
    edges: [
      ...board.edges,
      {
        id: `edge_${Math.random().toString(36).slice(2, 10)}`,
        from: fromId,
        to: toId,
        role: isBoardEdgeRole(role) ? role : 'reference',
      },
    ],
  }
}

export function incomingBoardRefs(
  board: BoardDocument,
  nodeId: string
): Array<{ node: BoardNode; role: BoardEdgeRole }> {
  return board.edges
    .filter(edge => edge.to === nodeId)
    .map(edge => {
      const node = board.nodes.find(item => item.id === edge.from)
      return node ? { node, role: edge.role } : null
    })
    .filter((item): item is { node: BoardNode; role: BoardEdgeRole } => item !== null)
}

export function boardInputAssetIds(board: BoardDocument, nodeId: string): string[] {
  const ids: string[] = []
  const node = board.nodes.find(item => item.id === nodeId)
  for (const assetId of mentionedAssetIds(board, node?.prompt || '')) {
    if (!ids.includes(assetId)) ids.push(assetId)
  }
  const seen = new Set<string>([nodeId])
  const stack = [...incomingBoardRefs(board, nodeId)]
  while (stack.length && ids.length < 4) {
    const item = stack.shift()
    if (!item || seen.has(item.node.id)) continue
    seen.add(item.node.id)
    if (item.role === 'mask') continue
    if (item.node.assetId && !ids.includes(item.node.assetId)) ids.push(item.node.assetId)
    stack.push(...incomingBoardRefs(board, item.node.id))
  }
  return ids.slice(0, 4)
}

export function boardMaskAssetId(board: BoardDocument, nodeId: string): string | null {
  const seen = new Set<string>([nodeId])
  const stack = [...incomingBoardRefs(board, nodeId)]
  while (stack.length) {
    const item = stack.shift()
    if (!item || seen.has(item.node.id)) continue
    seen.add(item.node.id)
    if (item.role === 'mask' && item.node.assetId) return item.node.assetId
    stack.push(...incomingBoardRefs(board, item.node.id))
  }
  return null
}

export function applyJobToBoard(
  board: BoardDocument,
  input: {
    nodeId?: string
    jobId: string
    prompt: string
    outputs: Array<{ assetId: string }>
    status: string
    origin?: BoardPoint
  }
): BoardDocument {
  let next = board
  const origin = input.origin || nextToContent(board)
  if (input.nodeId) {
    const node = next.nodes.find(item => item.id === input.nodeId)
    if (node) {
      const first = input.outputs[0]
      next = updateBoardNode(next, node.id, {
        jobId: input.jobId,
        status: input.status,
        prompt: input.prompt || node.prompt,
        assetId: first?.assetId || node.assetId,
        kind: first?.assetId ? 'image' : node.kind,
      })
      input.outputs.slice(1).forEach((output, index) => {
        next = addBoardNode(
          next,
          createBoardNode(
            'image',
            { x: origin.x + (index + 1) * 320, y: origin.y },
            next.nodes,
            {
              assetId: output.assetId,
              jobId: input.jobId,
              status: input.status,
              prompt: input.prompt,
              parentNodeId: node.id,
            }
          )
        )
      })
      return next
    }
  }
  input.outputs.forEach((output, index) => {
    next = addBoardNode(
      next,
      createBoardNode(
        'image',
        { x: origin.x + index * 320, y: origin.y },
        next.nodes,
        { assetId: output.assetId, jobId: input.jobId, status: input.status, prompt: input.prompt }
      )
    )
  })
  if (!input.outputs.length) {
    next = addBoardNode(
      next,
      createBoardNode('generate', origin, next.nodes, {
        jobId: input.jobId,
        status: input.status,
        prompt: input.prompt,
      })
    )
  }
  return next
}

export function seedAssetOnBoard(
  board: BoardDocument,
  assetId: string,
  origin?: BoardPoint
): BoardDocument {
  if (board.nodes.some(node => node.assetId === assetId)) {
    return bringBoardNodesToFront(
      board,
      board.nodes.filter(node => node.assetId === assetId).map(node => node.id)
    )
  }
  return addBoardNode(
    board,
    createBoardNode('image', origin || nextToContent(board), board.nodes, { assetId })
  )
}

export function nextToContent(board: BoardDocument): BoardPoint {
  const bounds = boardBounds(board.nodes)
  if (!bounds) return { x: 80, y: 80 }
  return { x: bounds.x + bounds.width + 48, y: bounds.y }
}

export function nodesInRect(nodes: BoardNode[], rect: BoardRect): string[] {
  const box = normalizeRect(rect)
  return nodes.filter(node => rectsOverlap(node, box)).map(node => node.id)
}

export function normalizeRect(rect: BoardRect): BoardRect {
  return {
    x: Math.min(rect.x, rect.x + rect.width),
    y: Math.min(rect.y, rect.y + rect.height),
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  }
}

export function connectionPath(from: BoardRect, to: BoardRect): string {
  return wirePath(from, to)
}

export function toggleBoardSelection(
  current: string[],
  nodeId: string,
  additive: boolean
): string[] {
  if (additive) {
    return current.includes(nodeId) ? current.filter(id => id !== nodeId) : [...current, nodeId]
  }
  return current.length === 1 && current[0] === nodeId ? current : [nodeId]
}

export function normalizeBoard(raw: unknown): BoardDocument {
  const source = raw && typeof raw === 'object' ? (raw as Partial<BoardDocument>) : {}
  const viewport = source.viewport || { x: 0, y: 0, scale: 1 }
  const nodes = Array.isArray(source.nodes) ? source.nodes : []
  const edges = Array.isArray(source.edges) ? source.edges : []
  const cleanedNodes = nodes
    .filter(node => node && isBoardNodeKind(node.kind) && finiteRect(node) && typeof node.id === 'string')
    .slice(0, BOARD_MAX_NODES)
    .map((node, index) => ({
      id: String(node.id),
      kind: node.kind,
      x: node.x,
      y: node.y,
      width: Math.max(80, node.width),
      height: Math.max(80, node.height),
      z: Number.isFinite(node.z) ? Number(node.z) : index,
      ...omitUndefined({
        title: optionalString(node.title),
        prompt: optionalString(node.prompt),
        text: optionalString(node.text),
        assetId: optionalString(node.assetId),
        jobId: optionalString(node.jobId),
        status: optionalString(node.status),
        groupId: optionalString(node.groupId),
        parentNodeId: optionalString(node.parentNodeId),
        modelKey: optionalString(node.modelKey),
        ratio: optionalString(node.ratio),
        quality: optionalString(node.quality),
        customWidth: optionalPositive(node.customWidth),
        customHeight: optionalPositive(node.customHeight),
        copyStyle: isBoardCopyStyle(node.copyStyle) ? node.copyStyle : undefined,
        copyLength: isBoardCopyLength(node.copyLength) ? node.copyLength : undefined,
      }),
    }))
  const ids = new Set(cleanedNodes.map(node => node.id))
  const cleanedEdges = edges
    .filter(
      edge =>
        edge &&
        typeof edge.id === 'string' &&
        ids.has(String(edge.from)) &&
        ids.has(String(edge.to)) &&
        edge.from !== edge.to
    )
    .slice(0, BOARD_MAX_EDGES)
    .map(edge => ({
      id: String(edge.id),
      from: String(edge.from),
      to: String(edge.to),
      role: isBoardEdgeRole(edge.role) ? edge.role : 'reference',
    }))
  const rawGroups = Array.isArray(source.groups) ? source.groups : []
  const usedGroups = new Set(cleanedNodes.map(node => node.groupId).filter(Boolean))
  const cleanedGroups = rawGroups
    .filter(group => group && typeof group.id === 'string' && usedGroups.has(String(group.id)))
    .slice(0, 80)
    .map(group => ({
      id: String(group.id),
      title: optionalString(group.title) || 'Group',
    }))
  return {
    version: BOARD_DOCUMENT_VERSION,
    revision:
      Number.isInteger(source.revision) && Number(source.revision) >= 0
        ? Number(source.revision)
        : 0,
    viewport: {
      x: Number.isFinite(viewport.x) ? viewport.x : 0,
      y: Number.isFinite(viewport.y) ? viewport.y : 0,
      scale: clampBoardScale(Number(viewport.scale)),
    },
    nodes: cleanedNodes,
    edges: cleanedEdges,
    groups: cleanedGroups,
  }
}

function wouldCycle(board: BoardDocument, fromId: string, toId: string): boolean {
  const outgoing = new Map<string, string[]>()
  for (const edge of board.edges) {
    const list = outgoing.get(edge.from) || []
    list.push(edge.to)
    outgoing.set(edge.from, list)
  }
  const stack = [...(outgoing.get(toId) || [])]
  const seen = new Set<string>()
  while (stack.length) {
    const current = stack.pop() as string
    if (current === fromId) return true
    if (seen.has(current)) continue
    seen.add(current)
    stack.push(...(outgoing.get(current) || []))
  }
  return false
}

function finiteRect(value: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }): boolean {
  return [value.x, value.y, value.width, value.height].every(
    item => typeof item === 'number' && Number.isFinite(item)
  )
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function optionalPositive(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return Math.round(number)
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function cubicPoint(
  p0: BoardPoint,
  p1: BoardPoint,
  p2: BoardPoint,
  p3: BoardPoint,
  t: number
): BoardPoint {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

function distanceToSegment(point: BoardPoint, a: BoardPoint, b: BoardPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = dx * dx + dy * dy
  if (length <= 0) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length))
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t))
}

export function snapOutputSize(width: number, height: number): BoardSize {
  const clamp = (value: number) => Math.max(16, Math.min(4096, Math.round(value / 16) * 16))
  return { width: clamp(width), height: clamp(height) }
}

export function setBoardEdgeRole(
  board: BoardDocument,
  edgeId: string,
  role: BoardEdgeRole
): BoardDocument {
  if (!isBoardEdgeRole(role)) return board
  return {
    ...board,
    edges: board.edges.map(edge => {
      if (edge.id !== edgeId) return edge
      if (role === 'mask' && !canConnectNodes(board, edge.from, edge.to, 'mask')) return edge
      return { ...edge, role }
    }),
  }
}

export function toggleBoardEdgeRole(board: BoardDocument, edgeId: string): BoardDocument {
  const edge = board.edges.find(item => item.id === edgeId)
  if (!edge) return board
  return setBoardEdgeRole(board, edgeId, edge.role === 'mask' ? 'reference' : 'mask')
}

export function spawnConnectedNode(
  board: BoardDocument,
  fromId: string,
  kind: BoardNodeKind,
  origin: BoardPoint,
  role: BoardEdgeRole = 'reference',
  direction: BoardHandleSide = 'out'
): { board: BoardDocument; node: BoardNode } | null {
  const from = board.nodes.find(node => node.id === fromId)
  if (!from) return null
  const node = createBoardNode(
    kind,
    origin,
    board.nodes,
    kind === 'generate' ? { prompt: from.prompt || '', parentNodeId: from.id } : { parentNodeId: from.id }
  )
  const next = addBoardNode(board, node)
  const sourceId = direction === 'in' ? node.id : fromId
  const targetId = direction === 'in' ? fromId : node.id
  if (!canConnectNodes(next, sourceId, targetId, role)) return { board: next, node }
  return { board: connectBoardNodes(next, sourceId, targetId, role), node }
}

export function insertNodeOnEdge(
  board: BoardDocument,
  edgeId: string,
  kind: BoardNodeKind = 'generate',
  extras: Partial<BoardNode> = {}
): { board: BoardDocument; node: BoardNode } | null {
  const edge = board.edges.find(item => item.id === edgeId)
  if (!edge || board.nodes.length >= BOARD_MAX_NODES) return null
  const from = board.nodes.find(node => node.id === edge.from)
  const to = board.nodes.find(node => node.id === edge.to)
  if (!from || !to) return null
  const size =
    extras.width && extras.height ? { width: extras.width, height: extras.height } : NODE_SIZE[kind]
  const mid = wireHandles(from, to).mid
  const node = createBoardNode(
    kind,
    { x: mid.x - size.width / 2, y: mid.y - size.height / 2 },
    [],
    {
      ...extras,
      width: size.width,
      height: size.height,
      parentNodeId: extras.parentNodeId ?? from.id,
    }
  )
  node.x = mid.x - size.width / 2
  node.y = mid.y - size.height / 2
  if (kind === 'text') {
    const next = addBoardNode(board, node)
    if (!canConnectNodes(next, node.id, to.id, 'reference')) return { board: next, node }
    return { board: connectBoardNodes(next, node.id, to.id, 'reference'), node }
  }
  let next = deleteBoardEdge(board, edgeId)
  next = addBoardNode(next, node)
  if (canConnectNodes(next, from.id, node.id, edge.role)) {
    next = connectBoardNodes(next, from.id, node.id, edge.role)
  } else if (edge.role !== 'reference' && canConnectNodes(next, from.id, node.id, 'reference')) {
    next = connectBoardNodes(next, from.id, node.id, 'reference')
  }
  if (canConnectNodes(next, node.id, to.id, edge.role)) {
    next = connectBoardNodes(next, node.id, to.id, edge.role)
  } else if (edge.role !== 'reference' && canConnectNodes(next, node.id, to.id, 'reference')) {
    next = connectBoardNodes(next, node.id, to.id, 'reference')
  }
  return { board: next, node }
}

export function shiftBoardNodes(
  board: BoardDocument,
  nodeIds: string[],
  direction: 1 | -1
): BoardDocument {
  if (!nodeIds.length) return board
  const ordered = [...board.nodes].sort((a, b) => a.z - b.z)
  const selected = new Set(nodeIds)
  if (direction > 0) {
    for (let index = ordered.length - 2; index >= 0; index -= 1) {
      if (selected.has(ordered[index].id) && !selected.has(ordered[index + 1].id)) {
        ;[ordered[index], ordered[index + 1]] = [ordered[index + 1], ordered[index]]
      }
    }
  } else {
    for (let index = 1; index < ordered.length; index += 1) {
      if (selected.has(ordered[index].id) && !selected.has(ordered[index - 1].id)) {
        ;[ordered[index], ordered[index - 1]] = [ordered[index - 1], ordered[index]]
      }
    }
  }
  return { ...board, nodes: ordered.map((node, z) => ({ ...node, z })) }
}

export function alignBoardNodes(
  board: BoardDocument,
  nodeIds: string[],
  mode: BoardAlignMode
): BoardDocument {
  const selected = board.nodes.filter(node => nodeIds.includes(node.id))
  if (selected.length < 2 || !isBoardAlignMode(mode)) return board
  const left = Math.min(...selected.map(node => node.x))
  const top = Math.min(...selected.map(node => node.y))
  const right = Math.max(...selected.map(node => node.x + node.width))
  const bottom = Math.max(...selected.map(node => node.y + node.height))
  const centerX = (left + right) / 2
  const centerY = (top + bottom) / 2
  const byX = [...selected].sort((a, b) => a.x - b.x)
  const byY = [...selected].sort((a, b) => a.y - b.y)
  const spanX = right - left - byX.reduce((sum, node) => sum + node.width, 0)
  const spanY = bottom - top - byY.reduce((sum, node) => sum + node.height, 0)
  const gapX = selected.length > 2 ? spanX / (selected.length - 1) : 0
  const gapY = selected.length > 2 ? spanY / (selected.length - 1) : 0
  const nextX = new Map<string, number>()
  const nextY = new Map<string, number>()
  if (mode === 'distributeX' && selected.length > 2) {
    let cursor = left
    for (const node of byX) {
      nextX.set(node.id, cursor)
      cursor += node.width + gapX
    }
  } else if (mode === 'distributeY' && selected.length > 2) {
    let cursor = top
    for (const node of byY) {
      nextY.set(node.id, cursor)
      cursor += node.height + gapY
    }
  } else {
    for (const node of selected) {
      if (mode === 'left') nextX.set(node.id, left)
      if (mode === 'right') nextX.set(node.id, right - node.width)
      if (mode === 'top') nextY.set(node.id, top)
      if (mode === 'bottom') nextY.set(node.id, bottom - node.height)
      if (mode === 'centerX') nextX.set(node.id, centerX - node.width / 2)
      if (mode === 'centerY') nextY.set(node.id, centerY - node.height / 2)
    }
  }
  return {
    ...board,
    nodes: board.nodes.map(node => ({
      ...node,
      x: nextX.has(node.id) ? (nextX.get(node.id) as number) : node.x,
      y: nextY.has(node.id) ? (nextY.get(node.id) as number) : node.y,
    })),
  }
}

export function groupBoardNodes(
  board: BoardDocument,
  nodeIds: string[],
  title = 'Group'
): { board: BoardDocument; group: BoardGroup } | null {
  const unique = [...new Set(nodeIds)].filter(id => board.nodes.some(node => node.id === id))
  if (unique.length < 2) return null
  const group = { id: `group_${Math.random().toString(36).slice(2, 10)}`, title }
  const selected = new Set(unique)
  return {
    group,
    board: {
      ...board,
      groups: [...(board.groups || []), group],
      nodes: board.nodes.map(node => (selected.has(node.id) ? { ...node, groupId: group.id } : node)),
    },
  }
}

export function ungroupBoardNodes(board: BoardDocument, groupId: string): BoardDocument {
  return {
    ...board,
    groups: (board.groups || []).filter(group => group.id !== groupId),
    nodes: board.nodes.map(node => (node.groupId === groupId ? { ...node, groupId: undefined } : node)),
  }
}

export function renameBoardGroup(board: BoardDocument, groupId: string, title: string): BoardDocument {
  const next = title.trim()
  if (!next) return board
  return {
    ...board,
    groups: (board.groups || []).map(group => (group.id === groupId ? { ...group, title: next } : group)),
  }
}

export function moveNodesToGroup(
  board: BoardDocument,
  nodeIds: string[],
  groupId: string | null
): BoardDocument {
  const selected = new Set(nodeIds)
  const valid = !groupId || (board.groups || []).some(group => group.id === groupId)
  if (!valid) return board
  const nodes = board.nodes.map(node =>
    selected.has(node.id) ? { ...node, groupId: groupId || undefined } : node
  )
  const used = new Set(nodes.map(node => node.groupId).filter(Boolean))
  return {
    ...board,
    nodes,
    groups: (board.groups || []).filter(group => used.has(group.id)),
  }
}

export function groupMemberIds(board: BoardDocument, groupId: string): string[] {
  return board.nodes.filter(node => node.groupId === groupId).map(node => node.id)
}

export function groupBounds(board: BoardDocument, groupId: string): BoardRect | null {
  return boardBounds(board.nodes.filter(node => node.groupId === groupId))
}

export function selectedAssetIds(board: BoardDocument, nodeIds: string[]): string[] {
  const ids: string[] = []
  for (const id of nodeIds) {
    const assetId = board.nodes.find(node => node.id === id)?.assetId
    if (assetId && !ids.includes(assetId)) ids.push(assetId)
  }
  return ids
}

export function polishBoardPrompt(
  prompt: string,
  language = 'en',
  style: BoardCopyStyle | string = 'poster',
  length: BoardCopyLength | string = 'standard'
): string {
  const source = prompt.replace(/\s+/g, ' ').trim()
  if (!source) return ''
  const resolvedStyle = isBoardCopyStyle(style) ? style : 'poster'
  const resolvedLength = isBoardCopyLength(length) ? length : 'standard'
  if (source.length > 80 && resolvedLength !== 'long') return source
  const zh = language.toLowerCase().startsWith('zh')
  const suffix = copyPolishSuffix(zh, resolvedStyle, resolvedLength)
  if (!suffix || source.includes(suffix.slice(0, 8))) return source
  return `${source}${zh ? '，' : '. '}${suffix}`
}

function copyPolishSuffix(zh: boolean, style: BoardCopyStyle, length: BoardCopyLength): string {
  if (zh) {
    const styles: Record<BoardCopyStyle, string> = {
      poster: '主体清晰，光线自然，构图干净，细节清楚，适合直接出图。',
      product: '商品主体完整，卖点清楚，材质和光影真实，适合电商主图。',
      story: '叙事具体，情绪连贯，场景和人物关系清楚，适合分镜插画。',
      character: '同一角色的外貌、服装和气质保持一致，方便后续出图。',
    }
    if (length === 'short') return styles[style].split('，')[0] + '。'
    if (length === 'long') return `${styles[style]}补充环境、材质和光线，避免杂乱背景。`
    return styles[style]
  }
  const styles: Record<BoardCopyStyle, string> = {
    poster: 'Keep the subject clear, with natural light, a clean composition, and enough detail to generate directly.',
    product: 'Keep the product complete, with clear selling points and realistic materials for a commercial hero shot.',
    story: 'Keep the scene specific, the mood consistent, and the character relationships readable for a storyboard.',
    character: 'Keep the same face, clothing, and temperament so later images stay consistent.',
  }
  if (length === 'short') return styles[style].split(',')[0] + '.'
  if (length === 'long') return `${styles[style]} Add environment, materials, and lighting, and avoid a cluttered background.`
  return styles[style]
}

export function exportBoardRecipe(board: BoardDocument, nodeIds: string[]): BoardRecipe {
  const selected = new Set(nodeIds)
  const nodes = board.nodes
    .filter(node => selected.has(node.id))
    .map(node => ({
      ...node,
      assetId: undefined,
      jobId: undefined,
      status: undefined,
    }))
  const ids = new Set(nodes.map(node => node.id))
  const groups = (board.groups || []).filter(group => nodes.some(node => node.groupId === group.id))
  return {
    version: 1,
    nodes,
    edges: board.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)),
    groups,
  }
}

export function importBoardRecipe(
  board: BoardDocument,
  raw: unknown,
  origin?: BoardPoint
): { board: BoardDocument; nodeIds: string[] } {
  const recipe = normalizeBoard(raw)
  if (!recipe.nodes.length) return { board, nodeIds: [] }
  const bounds = boardBounds(recipe.nodes)
  const target = origin || nextToContent(board)
  const shift = bounds
    ? { x: target.x - bounds.x, y: target.y - bounds.y }
    : { x: target.x, y: target.y }
  const map = new Map<string, string>()
  const groupMap = new Map<string, string>()
  let next = board
  for (const group of recipe.groups || []) {
    const id = `group_${Math.random().toString(36).slice(2, 10)}`
    groupMap.set(group.id, id)
    next = { ...next, groups: [...(next.groups || []), { id, title: group.title || 'Group' }] }
  }
  const created: string[] = []
  for (const node of recipe.nodes) {
    const id = `node_${Math.random().toString(36).slice(2, 10)}`
    map.set(node.id, id)
    const copy: BoardNode = {
      ...node,
      id,
      x: node.x + shift.x,
      y: node.y + shift.y,
      z: next.nodes.length,
      groupId: node.groupId ? groupMap.get(node.groupId) : undefined,
      parentNodeId: node.parentNodeId,
    }
    delete copy.assetId
    delete copy.jobId
    delete copy.status
    next = addBoardNode(next, copy)
    created.push(id)
  }
  next = {
    ...next,
    nodes: next.nodes.map(node =>
      node.parentNodeId && map.has(node.parentNodeId)
        ? { ...node, parentNodeId: map.get(node.parentNodeId) }
        : node
    ),
  }
  for (const edge of recipe.edges) {
    const from = map.get(edge.from)
    const to = map.get(edge.to)
    if (from && to) next = connectBoardNodes(next, from, to, edge.role)
  }
  return { board: next, nodeIds: created }
}

export function applyBoardTemplate(
  board: BoardDocument,
  templateId: BoardTemplateId,
  origin?: BoardPoint
): { board: BoardDocument; nodeIds: string[] } {
  const start = origin || nextToContent(board)
  const recipe = boardTemplateRecipe(templateId)
  return importBoardRecipe(board, recipe, start)
}

export function boardTemplateRecipe(templateId: BoardTemplateId): BoardRecipe {
  if (templateId === 'three-view') {
    return recipeFromSpec([
      { id: 'ref', kind: 'image', title: 'Character reference', x: 0, y: 180 },
      { id: 'note', kind: 'text', title: 'Identity', text: 'Same character, clothing, and palette in every view.', x: 0, y: 0 },
      { id: 'front', kind: 'generate', title: 'Front', prompt: 'Front view of the same character, full body, even studio light.', x: 340, y: 0 },
      { id: 'side', kind: 'generate', title: 'Side', prompt: 'Side view of the same character, full body, matching the front view.', x: 340, y: 240 },
      { id: 'back', kind: 'generate', title: 'Back', prompt: 'Back view of the same character, full body, matching the front view.', x: 340, y: 480 },
    ], [
      ['note', 'front'],
      ['note', 'side'],
      ['note', 'back'],
      ['ref', 'front'],
      ['ref', 'side'],
      ['ref', 'back'],
    ])
  }
  if (templateId === 'picture-book') {
    const nodes: SpecNode[] = [{ id: 'style', kind: 'text', title: 'Book style', text: 'Same picture-book style, soft color, child-friendly.', x: 0, y: 160 }]
    const edges: Array<[string, string]> = []
    for (let page = 1; page <= 4; page += 1) {
      const textId = `page-${page}`
      const artId = `art-${page}`
      nodes.push({
        id: textId,
        kind: 'text',
        title: `Page ${page}`,
        text: `Page ${page} narration.`,
        x: 300,
        y: (page - 1) * 200,
      })
      nodes.push({
        id: artId,
        kind: 'generate',
        title: `Art ${page}`,
        prompt: `Illustration for page ${page}, matching the book style.`,
        x: 620,
        y: (page - 1) * 200,
      })
      edges.push([textId, artId], ['style', artId])
    }
    return recipeFromSpec(nodes, edges)
  }
  return recipeFromSpec([
    { id: 'product', kind: 'image', title: 'Product photo', x: 0, y: 200 },
    { id: 'brief', kind: 'text', title: 'Product brief', text: 'Keep the product identical. Clean commercial lighting.', x: 0, y: 0 },
    { id: 'hero', kind: 'generate', title: 'Hero', prompt: 'Hero product shot, centered, soft studio light, clean background.', x: 360, y: 0 },
    { id: 'detail', kind: 'generate', title: 'Detail', prompt: 'Close-up detail of the same product, sharp materials.', x: 360, y: 220 },
    { id: 'lifestyle', kind: 'generate', title: 'Lifestyle', prompt: 'Lifestyle scene with the same product in use.', x: 700, y: 0 },
    { id: 'social', kind: 'generate', title: 'Social', prompt: 'Vertical social cover featuring the same product.', x: 700, y: 220 },
  ], [
    ['brief', 'hero'],
    ['brief', 'detail'],
    ['brief', 'lifestyle'],
    ['brief', 'social'],
    ['product', 'hero'],
    ['product', 'detail'],
    ['product', 'lifestyle'],
    ['product', 'social'],
  ])
}

type SpecNode = Partial<BoardNode> & { id: string; kind: BoardNodeKind; x: number; y: number }

function recipeFromSpec(nodes: SpecNode[], links: Array<[string, string]>): BoardRecipe {
  const sized = nodes.map(node => ({
    ...createBoardNode(node.kind, { x: node.x, y: node.y }, [], node),
    x: node.x,
    y: node.y,
  }))
  return {
    version: 1,
    nodes: sized,
    edges: links.map(([from, to], index) => ({
      id: `edge_${index}`,
      from,
      to,
      role: 'reference' as const,
    })),
    groups: [],
  }
}

export function gridSplitFromNode(
  board: BoardDocument,
  nodeId: string,
  rows: number,
  cols: number
): { board: BoardDocument; nodeIds: string[] } | null {
  const source = board.nodes.find(node => node.id === nodeId)
  const rowCount = Math.max(1, Math.min(4, Math.round(rows)))
  const colCount = Math.max(1, Math.min(4, Math.round(cols)))
  if (!source || rowCount * colCount < 2) return null
  let next = board
  const created: string[] = []
  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < colCount; col += 1) {
      const index = row * colCount + col + 1
      const node = createBoardNode(
        'generate',
        { x: source.x + source.width + 48 + col * 340, y: source.y + row * 260 },
        next.nodes,
        {
          title: `${colCount}×${rowCount} · ${index}`,
          prompt: `Panel ${index} of a ${colCount} by ${rowCount} grid. Same subject as the reference. This tile is row ${row + 1}, column ${col + 1}.`,
          parentNodeId: source.id,
        }
      )
      next = addBoardNode(next, node)
      if (source.assetId || source.kind !== 'text') {
        next = connectBoardNodes(next, source.id, node.id)
      }
      created.push(node.id)
    }
  }
  return { board: next, nodeIds: created }
}

export function variantChildIds(board: BoardDocument, rootId: string): string[] {
  return board.nodes.filter(node => node.parentNodeId === rootId).map(node => node.id)
}

export function layoutVariantTree(board: BoardDocument, rootId: string): BoardDocument {
  const root = board.nodes.find(node => node.id === rootId)
  if (!root) return board
  const children = board.nodes.filter(node => node.parentNodeId === rootId)
  if (!children.length) return board
  const gap = 36
  const width = children.reduce((sum, node) => sum + node.width, 0) + gap * (children.length - 1)
  let x = root.x + root.width / 2 - width / 2
  const y = root.y + root.height + 72
  const placed = new Map<string, BoardPoint>()
  for (const child of children) {
    placed.set(child.id, { x, y })
    x += child.width + gap
  }
  return {
    ...board,
    nodes: board.nodes.map(node => {
      const point = placed.get(node.id)
      return point ? { ...node, x: point.x, y: point.y } : node
    }),
  }
}
