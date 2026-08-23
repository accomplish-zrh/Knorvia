'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  AlignHorizontalSpaceAround,
  AlignVerticalSpaceAround,
  Copy,
  Download,
  Hand,
  ImagePlus,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  Sparkles,
  Spline,
  Trash2,
  Type,
  Undo2,
  Redo2,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useClipboardImagePaste } from '@/lib/clipboard-image-paste'
import {
  addBoardNode,
  alignBoardNodes,
  applyBoardTemplate,
  BOARD_TEMPLATE_IDS,
  bringBoardNodesToFront,
  canConnectNodes,
  centerViewportOn,
  collectBoardPrompt,
  connectBoardNodes,
  connectionHandles,
  connectionPath,
  createBoardNode,
  deleteBoardEdge,
  deleteBoardNodes,
  dragExceededThreshold,
  duplicateBoardNodes,
  edgeAutoPan,
  exportBoardRecipe,
  fitViewport,
  gridSplitFromNode,
  groupBoardNodes,
  groupBounds,
  groupMemberIds,
  hitTestConnection,
  importBoardRecipe,
  incomingRefCount,
  insertNodeOnEdge,
  iterateFromImage,
  layoutVariantTree,
  moveBoardNodes,
  nodesInRect,
  normalizeRect,
  panViewport,
  screenToWorld,
  seedAssetOnBoard,
  selectedAssetIds,
  sendBoardNodesToBack,
  snapNodeMove,
  spawnConnectedNode,
  toggleBoardEdgeRole,
  toggleBoardSelection,
  ungroupBoardNodes,
  renameBoardGroup,
  worldToScreen,
  zoomViewportAt,
  type BoardDocument,
  type BoardEdgeRole,
  type BoardHandleSide,
  type BoardNode,
  type BoardPoint,
  type BoardTemplateId,
  type BoardTool,
  BOARD_ASSET_MIME,
  type SnapGuide,
} from '@/lib/image-studio/board-logic'
import { type ImageModelOption } from '@/lib/image-studio-api'
import { StudioBoardPanel } from './StudioBoardPanel'
import {
  StudioBoardNodeBody,
  StudioBoardNodeToolbar,
  StudioBoardPorts,
  boardNodeFrameClass,
  boardNodeFrameStyle,
} from './StudioBoardNode'

const TOOL_LABEL: Record<BoardTool, string> = {
  select: 'Select',
  pan: 'Move',
  connect: 'Connect nodes',
}

export function StudioInfiniteBoard({
  board,
  onChange,
  assetUrl,
  libraryIds = [],
  busyNodeIds,
  onGenerateNode,
  onOpenInpaint,
  onSelectAsset,
  onUploadFiles,
  onRetryNode,
  focusAssetId,
  models = [],
  modelKey = '',
  language = 'en',
  onDownloadAssets,
}: {
  board: BoardDocument
  onChange: (board: BoardDocument) => void
  assetUrl: (assetId: string) => string
  libraryIds?: string[]
  busyNodeIds?: Set<string>
  onGenerateNode: (node: BoardNode) => void
  onOpenInpaint?: (node: BoardNode) => void
  onSelectAsset?: (assetId: string) => void
  onUploadFiles?: (files: File[], origin: BoardPoint, nodeId?: string) => void
  onRetryNode?: (node: BoardNode) => void
  focusAssetId?: string | null
  models?: ImageModelOption[]
  modelKey?: string
  language?: string
  onDownloadAssets?: (assetIds: string[]) => void
}) {
  const { t } = useTranslation()
  const stageRef = useRef<HTMLDivElement>(null)
  const boardRef = useRef(board)
  const onChangeRef = useRef(onChange)
  const fileRef = useRef<HTMLInputElement>(null)
  const attachNodeId = useRef<string | null>(null)

  const handlePaste = useCallback(
    (files: File[]) => {
      if (!onUploadFiles) return
      const rect = stageRef.current?.getBoundingClientRect()
      const center = rect ? { x: rect.width / 2, y: rect.height / 2 } : { x: 0, y: 0 }
      onUploadFiles(files, screenToWorld(center, boardRef.current.viewport))
    },
    [onUploadFiles]
  )
  useClipboardImagePaste(handlePaste)

  const [tool, setTool] = useState<BoardTool>('select')
  const [selected, setSelected] = useState<string[]>([])
  const [spacePan, setSpacePan] = useState(false)
  const [marquee, setMarquee] = useState<{ start: BoardPoint; current: BoardPoint } | null>(null)
  const [connectFrom, setConnectFrom] = useState<{ id: string; side: BoardHandleSide } | null>(null)
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  const [guides, setGuides] = useState<SnapGuide[]>([])
  const [hoverEdge, setHoverEdge] = useState<string | null>(null)
  const [hoverNode, setHoverNode] = useState<string | null>(null)
  const previewPathRef = useRef<SVGPathElement | null>(null)
  const hoverFrame = useRef(0)
  const pendingHover = useRef<{ node: string | null; edge: string | null }>({ node: null, edge: null })
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  const [connectMenu, setConnectMenu] = useState<{
    x: number
    y: number
    fromId: string
    world: BoardPoint
    role: BoardEdgeRole
    side: BoardHandleSide
  } | null>(null)
  const [mentionFor, setMentionFor] = useState<string | null>(null)
  const connectRole = useRef<BoardEdgeRole>('reference')
  const recipeRef = useRef<HTMLInputElement>(null)
  const history = useRef<BoardDocument[]>([])
  const future = useRef<BoardDocument[]>([])
  const drag = useRef<{
    pointerId: number
    mode: 'pan' | 'node' | 'marquee' | 'connect' | 'minimap'
    start: BoardPoint
    last: BoardPoint
    ids: string[]
    from?: string
    side?: BoardHandleSide
    grab?: BoardPoint
    moved?: boolean
  } | null>(null)
  const [stageSize, setStageSize] = useState({ width: 960, height: 640 })

  useLayoutEffect(() => {
    boardRef.current = board
    onChangeRef.current = onChange
  }, [board, onChange])

  useEffect(() => {
    if (!focusAssetId || stageSize.width < 80) return
    const node = boardRef.current.nodes.find(item => item.assetId === focusAssetId)
    if (!node) return
    onChangeRef.current({
      ...boardRef.current,
      viewport: centerViewportOn(node, stageSize, Math.min(1.15, Math.max(boardRef.current.viewport.scale, 0.85))),
    })
    setSelected([node.id])
  }, [focusAssetId, stageSize])

  const nodesById = useMemo(
    () => new Map(board.nodes.map(node => [node.id, node])),
    [board.nodes]
  )
  const activeTool: BoardTool = spacePan ? 'pan' : tool

  const commit = useCallback(
    (next: BoardDocument, record = true) => {
      if (record) {
        history.current.push(boardRef.current)
        if (history.current.length > 50) history.current.shift()
        future.current = []
      }
      onChangeRef.current(next)
    },
    []
  )

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect
      if (box) setStageSize({ width: box.width, height: box.height })
    })
    observer.observe(stage)
    const onNativeWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, button, a, [contenteditable="true"]')) return
      event.preventDefault()
      const rect = stage.getBoundingClientRect()
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      const current = boardRef.current
      if (event.shiftKey) {
        onChangeRef.current({
          ...current,
          viewport: panViewport(current.viewport, { x: -event.deltaY, y: 0 }),
        })
        return
      }
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        onChangeRef.current({
          ...current,
          viewport: panViewport(current.viewport, { x: -event.deltaX, y: -event.deltaY }),
        })
        return
      }
      onChangeRef.current({
        ...current,
        viewport: zoomViewportAt(
          current.viewport,
          point,
          current.viewport.scale * (event.deltaY > 0 ? 0.92 : 1.08)
        ),
      })
    }
    stage.addEventListener('wheel', onNativeWheel, { passive: false })
    return () => {
      observer.disconnect()
      stage.removeEventListener('wheel', onNativeWheel)
    }
  }, [])

  useEffect(() => {
    if (!menu && !connectMenu) return
    const close = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest('[data-board-menu]')) return
      setMenu(null)
      setConnectMenu(null)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu, connectMenu])

  useEffect(() => {
    function typing(target: EventTarget | null) {
      return (
        target instanceof HTMLElement &&
        Boolean(
          target.closest(
            'input, textarea, select, button, a, [contenteditable="true"], [role="button"]'
          )
        )
      )
    }
    function onKeyDown(event: KeyboardEvent) {
      if (typing(event.target)) return
      if (event.code === 'Space') {
        event.preventDefault()
        setSpacePan(true)
      }
      if (event.key === 'v' || event.key === 'V') setTool('select')
      if (event.key === 'h' || event.key === 'H') setTool('pan')
      if (event.key === 'c' || event.key === 'C') setTool('connect')
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) {
          const next = future.current.pop()
          if (!next) return
          history.current.push(boardRef.current)
          onChangeRef.current(next)
        } else {
          const previous = history.current.pop()
          if (!previous) return
          future.current.push(boardRef.current)
          onChangeRef.current(previous)
        }
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selected.length) {
          event.preventDefault()
          commit(deleteBoardNodes(boardRef.current, selected))
          setSelected([])
          setMenu(null)
          return
        }
        if (hoverEdge) {
          event.preventDefault()
          commit(deleteBoardEdge(boardRef.current, hoverEdge))
          setHoverEdge(null)
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd' && selected.length) {
        event.preventDefault()
        commit(duplicateBoardNodes(boardRef.current, selected))
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setSelected(boardRef.current.nodes.map(node => node.id))
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'g' && selected.length > 1) {
        event.preventDefault()
        const grouped = groupBoardNodes(boardRef.current, selected)
        if (grouped) commit(grouped.board)
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        const next = future.current.pop()
        if (!next) return
        history.current.push(boardRef.current)
        onChangeRef.current(next)
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '0') {
        event.preventDefault()
        onChangeRef.current({
          ...boardRef.current,
          viewport: fitViewport(boardRef.current.nodes, stageSize),
        })
      }
      if ((event.metaKey || event.ctrlKey) && (event.key === '+' || event.key === '=')) {
        event.preventDefault()
        onChangeRef.current({
          ...boardRef.current,
          viewport: zoomViewportAt(
            boardRef.current.viewport,
            { x: stageSize.width / 2, y: stageSize.height / 2 },
            boardRef.current.viewport.scale * 1.15
          ),
        })
      }
      if ((event.metaKey || event.ctrlKey) && (event.key === '-' || event.key === '_')) {
        event.preventDefault()
        onChangeRef.current({
          ...boardRef.current,
          viewport: zoomViewportAt(
            boardRef.current.viewport,
            { x: stageSize.width / 2, y: stageSize.height / 2 },
            boardRef.current.viewport.scale * 0.85
          ),
        })
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) && selected.length) {
        event.preventDefault()
        const step = event.shiftKey ? 10 : 1
        const delta =
          event.key === 'ArrowUp'
            ? { x: 0, y: -step }
            : event.key === 'ArrowDown'
              ? { x: 0, y: step }
              : event.key === 'ArrowLeft'
                ? { x: -step, y: 0 }
                : { x: step, y: 0 }
        commit(moveBoardNodes(boardRef.current, selected, delta))
      }
      if (event.key === 'Escape') {
        setConnectFrom(null)
        setMarquee(null)
        setMenu(null)
        setConnectMenu(null)
        setMentionFor(null)
        setEditingNodeId(null)
        previewPathRef.current?.setAttribute('display', 'none')
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.code === 'Space') setSpacePan(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [commit, hoverEdge, selected, stageSize])

  const clientPoint = useCallback((event: { clientX: number; clientY: number }): BoardPoint => {
    const rect = stageRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left || 0), y: event.clientY - (rect?.top || 0) }
  }, [])

  function addNode(kind: BoardNode['kind']) {
    const origin = screenToWorld(
      { x: stageSize.width / 2 - 140, y: stageSize.height / 2 - 110 },
      board.viewport
    )
    const node = createBoardNode(kind, origin, board.nodes)
    commit(addBoardNode(board, node))
    setSelected([node.id])
  }

  function placeLibraryAsset(assetId: string, screen?: BoardPoint) {
    const origin = screenToWorld(
      screen || { x: stageSize.width / 2 - 140, y: stageSize.height / 2 - 140 },
      board.viewport
    )
    const next = seedAssetOnBoard(board, assetId, origin)
    const node = next.nodes.find(item => item.assetId === assetId)
    commit(
      node
        ? { ...next, viewport: centerViewportOn(node, stageSize, next.viewport.scale) }
        : next
    )
    if (node) setSelected([node.id])
    onSelectAsset?.(assetId)
  }

  function finishConnect(
    fromId: string,
    toId: string | null,
    world: BoardPoint,
    dragged: boolean,
    screen: BoardPoint,
    role: BoardEdgeRole,
    side: BoardHandleSide = 'out'
  ) {
    const sourceId = side === 'in' ? toId : fromId
    const targetId = side === 'in' ? fromId : toId
    const source = sourceId ? board.nodes.find(node => node.id === sourceId) : null
    const nextRole = role === 'mask' && source?.assetId ? 'mask' : 'reference'
    if (sourceId && targetId && canConnectNodes(board, sourceId, targetId, nextRole)) {
      commit(connectBoardNodes(board, sourceId, targetId, nextRole))
      return
    }
    if (!toId && dragged) {
      setConnectMenu({ x: screen.x, y: screen.y, fromId, world, role: nextRole, side })
    }
  }

  function spawnFromConnect(kind: BoardNode['kind'], role: BoardEdgeRole) {
    if (!connectMenu) return
    const spawned = spawnConnectedNode(
      board,
      connectMenu.fromId,
      kind,
      { x: connectMenu.world.x + 16, y: connectMenu.world.y - 40 },
      role,
      connectMenu.side
    )
    if (spawned) {
      commit(spawned.board)
      setSelected([spawned.node.id])
    }
    setConnectMenu(null)
  }

  function insertOnEdge(edgeId: string, kind: BoardNode['kind'] = 'generate') {
    const inserted = insertNodeOnEdge(board, edgeId, kind)
    if (!inserted) return
    commit(inserted.board)
    setSelected([inserted.node.id])
    if (kind === 'generate') setEditingNodeId(inserted.node.id)
  }

  function applyTemplate(id: BoardTemplateId) {
    const result = applyBoardTemplate(board, id, screenToWorld(
      { x: stageSize.width / 2 - 200, y: stageSize.height / 2 - 120 },
      board.viewport
    ))
    commit(result.board)
    setSelected(result.nodeIds)
  }

  function downloadSelected() {
    onDownloadAssets?.(selectedAssetIds(board, selected))
  }

  function exportSelectedRecipe() {
    const recipe = exportBoardRecipe(board, selected.length ? selected : board.nodes.map(node => node.id))
    const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'studio-recipe.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  function iterateSelected(nodeId: string) {
    const result = iterateFromImage(board, nodeId)
    if (!result) return
    commit(result.board)
    setSelected([result.node.id])
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button === 2) return
    const point = clientPoint(event)
    const target = event.target as HTMLElement
    if (target.closest('[data-board-minimap],[data-board-empty],[data-board-chrome]')) return
    const handleEl = target.closest('[data-board-handle]')
    const handleFrom = handleEl?.getAttribute('data-board-handle')
    const handleSide = (handleEl?.getAttribute('data-board-handle-side') as BoardHandleSide | null) || 'out'
    const nodeId = target.closest('[data-board-node-id]')?.getAttribute('data-board-node-id')
    const interactive = Boolean(target.closest('[data-board-node-interactive]'))
    setMenu(null)
    if (target.closest('[data-board-edge-insert]')) return

    if (handleFrom || (activeTool === 'connect' && nodeId)) {
      const from = handleFrom || nodeId
      const side = handleFrom ? handleSide : 'out'
      if (from) {
        connectRole.current = event.shiftKey ? 'mask' : 'reference'
        setConnectFrom({ id: from, side })
        paintConnectPreview(from, point, null, side)
        drag.current = { pointerId: event.pointerId, mode: 'connect', start: point, last: point, ids: [], from, side }
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      return
    }
    if (activeTool === 'pan' || event.button === 1) {
      drag.current = { pointerId: event.pointerId, mode: 'pan', start: point, last: point, ids: [] }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (nodeId) {
      const next = toggleBoardSelection(selected, nodeId, event.shiftKey)
      setSelected(next)
      commit(bringBoardNodesToFront(board, next), false)
      const node = nodesById.get(nodeId)
      if (node?.assetId) onSelectAsset?.(node.assetId)
      if (!interactive) {
        const world = screenToWorld(point, board.viewport)
        drag.current = {
          pointerId: event.pointerId,
          mode: 'node',
          start: point,
          last: point,
          ids: next,
          grab: node ? { x: world.x - node.x, y: world.y - node.y } : undefined,
          moved: false,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      return
    }
    const world = screenToWorld(point, board.viewport)
    const edge = [...board.edges].reverse().find(item => {
      const from = nodesById.get(item.from)
      const to = nodesById.get(item.to)
      return from && to && hitTestConnection(from, to, world, 10 / board.viewport.scale)
    })
    if (edge) {
      setHoverEdge(edge.id)
      return
    }
    if (!event.shiftKey) setSelected([])
    setConnectFrom(null)
    setMarquee({ start: point, current: point })
    drag.current = { pointerId: event.pointerId, mode: 'marquee', start: point, last: point, ids: [] }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function paintConnectPreview(
    fromId: string,
    point: BoardPoint,
    targetId: string | null,
    side: BoardHandleSide = 'out'
  ) {
    const path = previewPathRef.current
    const from = boardRef.current.nodes.find(node => node.id === fromId)
    if (!path || !from) return
    const target = targetId ? boardRef.current.nodes.find(node => node.id === targetId) : null
    const world = screenToWorld(point, boardRef.current.viewport)
    const cursor = target || { x: world.x, y: world.y, width: 1, height: 1 }
    path.setAttribute('d', side === 'in' ? connectionPath(cursor, from) : connectionPath(from, cursor))
    path.setAttribute('display', 'inline')
  }

  function hideConnectPreview() {
    previewPathRef.current?.setAttribute('display', 'none')
  }

  function scheduleHover(node: string | null, edge: string | null) {
    pendingHover.current = { node, edge }
    if (hoverFrame.current) return
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0
      const next = pendingHover.current
      setHoverNode(current => (current === next.node ? current : next.node))
      setHoverEdge(current => (current === next.edge ? current : next.edge))
    })
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const point = clientPoint(event)
    const session = drag.current
    if (!session || session.pointerId !== event.pointerId) {
      const world = screenToWorld(point, board.viewport)
      const edge = board.edges.find(item => {
        const from = nodesById.get(item.from)
        const to = nodesById.get(item.to)
        return from && to && hitTestConnection(from, to, world, 10 / board.viewport.scale)
      })
      scheduleHover(null, edge?.id || null)
      return
    }
    if (session.mode === 'pan') {
      onChange({
        ...board,
        viewport: panViewport(board.viewport, { x: point.x - session.last.x, y: point.y - session.last.y }),
      })
      session.last = point
      return
    }
    if (session.mode === 'minimap') {
      const rect = stageRef.current?.querySelector('[data-board-minimap]')?.getBoundingClientRect()
      if (rect) panMinimap(event.clientX, event.clientY, rect)
      return
    }
    if (session.mode === 'node') {
      if (!session.moved && dragExceededThreshold(session.start, point)) {
        history.current.push(board)
        if (history.current.length > 50) history.current.shift()
        future.current = []
        session.moved = true
      }
      const auto = edgeAutoPan(point, stageSize)
      let viewport = board.viewport
      if (auto.x || auto.y) viewport = panViewport(viewport, auto)
      const world = screenToWorld(point, viewport)
      const primary = board.nodes.find(node => node.id === session.ids[0])
      const others = board.nodes.filter(node => !session.ids.includes(node.id))
      const raw = session.grab
        ? { x: world.x - session.grab.x, y: world.y - session.grab.y }
        : { x: primary?.x || 0, y: primary?.y || 0 }
      const snapped = primary
        ? snapNodeMove(primary, raw, others, viewport.scale)
        : { point: raw, guides: [] }
      const delta = primary
        ? { x: snapped.point.x - primary.x, y: snapped.point.y - primary.y }
        : { x: 0, y: 0 }
      setGuides(snapped.guides)
      let next = moveBoardNodes(board, session.ids, delta)
      if (viewport !== board.viewport) next = { ...next, viewport }
      onChange(next)
      session.last = point
      return
    }
    if (session.mode === 'connect' && session.from) {
      session.moved = session.moved || dragExceededThreshold(session.start, point)
      const over = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest('[data-board-node-id]')
        ?.getAttribute('data-board-node-id')
      const target = over && over !== session.from ? over : null
      paintConnectPreview(session.from, point, target, session.side || 'out')
      scheduleHover(target, null)
    }
    if (session.mode === 'marquee') {
      setMarquee(current => (current ? { ...current, current: point } : current))
    }
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const session = drag.current
    const point = clientPoint(event)
    if (session?.mode === 'marquee' && marquee) {
      const start = screenToWorld(marquee.start, board.viewport)
      const end = screenToWorld(marquee.current, board.viewport)
      setSelected(
        nodesInRect(board.nodes, {
          x: start.x,
          y: start.y,
          width: end.x - start.x,
          height: end.y - start.y,
        })
      )
    }
    if (session?.mode === 'connect' && session.from) {
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest('[data-board-node-id]')
        ?.getAttribute('data-board-node-id')
      finishConnect(
        session.from,
        target && target !== session.from ? target : null,
        screenToWorld(point, board.viewport),
        Boolean(session.moved),
        point,
        event.shiftKey || connectRole.current === 'mask' ? 'mask' : 'reference',
        session.side || 'out'
      )
    }
    drag.current = null
    setMarquee(null)
    setConnectFrom(null)
    setHoverNode(null)
    setGuides([])
    hideConnectPreview()
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function panMinimap(clientX: number, clientY: number, rect: DOMRect) {
    const metrics = minimapMetrics(board, stageSize)
    const x = (clientX - rect.left) / metrics.scale + metrics.bounds.x
    const y = (clientY - rect.top) / metrics.scale + metrics.bounds.y
    onChange({
      ...board,
      viewport: {
        ...board.viewport,
        x: stageSize.width / 2 - x * board.viewport.scale,
        y: stageSize.height / 2 - y * board.viewport.scale,
      },
    })
  }

  const marqueeBox = marquee
    ? normalizeRect({
        x: marquee.start.x,
        y: marquee.start.y,
        width: marquee.current.x - marquee.start.x,
        height: marquee.current.y - marquee.start.y,
      })
    : null

  return (
    <div data-studio-infinite-board="" className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={stageRef}
        data-board-stage=""
        className={`relative min-h-0 flex-1 overflow-hidden ${
          activeTool === 'pan' ? 'cursor-grab' : activeTool === 'connect' || connectFrom ? 'cursor-crosshair' : 'cursor-default'
        }`}
        style={{
          backgroundColor: 'var(--background)',
          backgroundImage: [
            `radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--foreground) 9%, transparent) 1px, transparent 0)`,
            `linear-gradient(180deg, color-mix(in srgb, var(--muted) 28%, var(--background)), var(--background) 42%)`,
          ].join(','),
          backgroundSize: `${22 * board.viewport.scale}px ${22 * board.viewport.scale}px, 100% 100%`,
          backgroundPosition: `${board.viewport.x}px ${board.viewport.y}px, 0 0`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={event => {
          event.preventDefault()
          const nodeId = (event.target as HTMLElement).closest('[data-board-node-id]')?.getAttribute('data-board-node-id')
          if (!nodeId) return
          setSelected([nodeId])
          setMenu({ x: event.clientX, y: event.clientY, nodeId })
        }}
        onDragOver={event => {
          event.preventDefault()
        }}
        onDrop={event => {
          event.preventDefault()
          const assetId = event.dataTransfer.getData(BOARD_ASSET_MIME)
          const point = clientPoint(event)
          if (assetId) {
            placeLibraryAsset(assetId, point)
            return
          }
          const files = Array.from(event.dataTransfer.files).filter(file => file.type.startsWith('image/'))
          if (files.length) {
            const over = document
              .elementFromPoint(event.clientX, event.clientY)
              ?.closest('[data-board-node-id]')
              ?.getAttribute('data-board-node-id')
            onUploadFiles?.(files, screenToWorld(point, board.viewport), over || undefined)
          }
        }}
      >
        {!board.nodes.length ? (
          <div data-board-empty="" className="absolute inset-0 grid place-items-center px-6 text-center">
            <div className="max-w-sm">
              <p className="text-[15px] font-medium tracking-tight">{t('An infinite board for visual work')}</p>
              <p className="mt-2 text-[12.5px] leading-5 text-[var(--muted-foreground)]">
                {t('Add a generate card, drop an image, or connect results to keep iterating.')}
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                <button type="button" onClick={() => addNode('generate')} className="rounded-[10px] bg-[var(--foreground)] px-3 py-1.5 text-[12px] text-[var(--background)]">
                  {t('Start with a generate card')}
                </button>
                <button type="button" onClick={() => fileRef.current?.click()} className="rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-[12px]">
                  {t('Upload image')}
                </button>
                <button type="button" onClick={() => addNode('text')} className="rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-[12px]">
                  {t('Add text node')}
                </button>
              </div>
              <div className="mt-3 flex flex-wrap justify-center gap-1">
                {BOARD_TEMPLATE_IDS.map(id => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => applyTemplate(id)}
                    className="rounded-full border border-[var(--border)]/80 px-2.5 py-1 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  >
                    {t(templateLabel(id))}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            transform: `translate(${board.viewport.x}px, ${board.viewport.y}px) scale(${board.viewport.scale})`,
          }}
        >
          <svg className="absolute overflow-visible" width={1} height={1}>
            {board.edges.map(edge => {
              const from = nodesById.get(edge.from)
              const to = nodesById.get(edge.to)
              if (!from || !to) return null
              const active = hoverEdge === edge.id
              const mid = connectionHandles(from, to).mid
              return (
                <g key={edge.id}>
                  <path
                    d={connectionPath(from, to)}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14}
                    className="cursor-pointer"
                    onPointerEnter={() => setHoverEdge(edge.id)}
                    onPointerLeave={() => setHoverEdge(current => (current === edge.id ? null : current))}
                    onClick={event => {
                      event.stopPropagation()
                      commit(toggleBoardEdgeRole(board, edge.id))
                    }}
                  />
                  <path
                    d={connectionPath(from, to)}
                    fill="none"
                    stroke={edge.role === 'mask' ? 'rgb(239 68 68 / 0.65)' : 'color-mix(in srgb, var(--foreground) 28%, transparent)'}
                    strokeWidth={active ? 2.1 : 1.55}
                    strokeLinecap="round"
                    className="pointer-events-none"
                  />
                  <g
                    data-board-edge-insert={edge.id}
                    className="cursor-pointer"
                    onClick={event => {
                      event.stopPropagation()
                      insertOnEdge(edge.id)
                    }}
                    onContextMenu={event => {
                      event.preventDefault()
                      event.stopPropagation()
                      commit(deleteBoardEdge(board, edge.id))
                    }}
                  >
                    <title>{t('Insert node on connection')}</title>
                    <circle
                      cx={mid.x}
                      cy={mid.y}
                      r={9}
                      fill="var(--card)"
                      stroke={active ? '#2f80ff' : 'var(--border)'}
                    />
                    <path
                      d={`M ${mid.x - 3.4} ${mid.y} H ${mid.x + 3.4} M ${mid.x} ${mid.y - 3.4} V ${mid.y + 3.4}`}
                      stroke="#2f80ff"
                      strokeWidth={1.6}
                      strokeLinecap="round"
                    />
                  </g>
                </g>
              )
            })}
            <path
              ref={previewPathRef}
              d=""
              display="none"
              fill="none"
              stroke="var(--foreground)"
              strokeDasharray="7 6"
              strokeWidth={1.7}
              strokeLinecap="round"
              className="pointer-events-none"
            />
            {guides.map((guide, index) => (
              <line
                key={`${guide.axis}-${index}`}
                className="pointer-events-none"
                stroke="rgb(59 130 246 / 0.8)"
                strokeWidth={1}
                x1={guide.axis === 'vertical' ? guide.value : guide.from}
                y1={guide.axis === 'vertical' ? guide.from : guide.value}
                x2={guide.axis === 'vertical' ? guide.value : guide.to}
                y2={guide.axis === 'vertical' ? guide.to : guide.value}
              />
            ))}
          </svg>

          {(board.groups || []).map(group => {
            const bounds = groupBounds(board, group.id)
            if (!bounds) return null
            return (
              <div
                key={group.id}
                className="pointer-events-none absolute rounded-[22px] border border-dashed border-[var(--foreground)]/20 bg-[var(--foreground)]/[0.03]"
                style={{ left: bounds.x - 12, top: bounds.y - 28, width: bounds.width + 24, height: bounds.height + 40 }}
              >
                <span className="absolute top-1.5 left-3 text-[10px] tracking-wide text-[var(--muted-foreground)] uppercase">
                  {group.title}
                </span>
              </div>
            )
          })}

          {board.nodes.map(node => {
            const active = selected.includes(node.id)
            const busy = busyNodeIds?.has(node.id) || node.status === 'running'
            const dropTarget = Boolean(
              connectFrom &&
                hoverNode === node.id &&
                (connectFrom.side === 'out'
                  ? canConnectNodes(board, connectFrom.id, node.id)
                  : canConnectNodes(board, node.id, connectFrom.id))
            )
            const refs = incomingRefCount(board, node.id)
            return (
              <article
                key={node.id}
                data-board-node-id={node.id}
                data-board-node-kind={node.kind}
                className="group/node absolute overflow-visible"
                style={{ left: node.x, top: node.y, width: node.width, height: node.height, zIndex: node.z }}
                onDoubleClick={() => {
                  if (node.kind === 'image' && node.assetId) onOpenInpaint?.(node)
                  if (node.kind === 'generate') setEditingNodeId(node.id)
                }}
              >
                <div
                  className={`h-full rounded-[22px] border-2 bg-[var(--card)] ${
                    editingNodeId === node.id ? 'overflow-visible' : 'overflow-hidden'
                  } ${boardNodeFrameClass(node, active, dropTarget)}`}
                  style={boardNodeFrameStyle(node, active, dropTarget)}
                >
                  <StudioBoardNodeBody
                    node={node}
                    board={board}
                    busy={busy}
                    refs={refs}
                    editing={editingNodeId === node.id}
                    models={models}
                    modelKey={modelKey}
                    language={language}
                    assetUrl={assetUrl}
                    mentionFor={mentionFor}
                    onChange={onChange}
                    onGenerate={onGenerateNode}
                    onOpenInpaint={onOpenInpaint}
                    onRetry={onRetryNode}
                    onAttach={() => {
                      attachNodeId.current = node.id
                      fileRef.current?.click()
                    }}
                    onToggleEdit={() => setEditingNodeId(current => (current === node.id ? null : node.id))}
                    onMentionFor={setMentionFor}
                  />
                </div>
                <StudioBoardPorts
                  nodeId={node.id}
                  showIn={node.kind !== 'text'}
                  visible={active || connectFrom?.id === node.id}
                />
              </article>
            )
          })}
        </div>

        {selected.length === 1
          ? (() => {
              const node = nodesById.get(selected[0])
              if (!node) return null
              const screen = worldToScreen({ x: node.x + node.width / 2, y: node.y }, board.viewport)
              return (
                <div
                  className="pointer-events-none absolute z-20"
                  style={{ left: screen.x, top: screen.y - 10, transform: 'translate(-50%, -100%)' }}
                >
                  <StudioBoardNodeToolbar
                    node={node}
                    busy={busyNodeIds?.has(node.id) || node.status === 'running'}
                    onCopy={() => {
                      const text = node.kind === 'text' ? node.text || '' : collectBoardPrompt(board, node.id) || node.prompt || ''
                      void navigator.clipboard?.writeText(text)
                    }}
                    onAttach={
                      node.kind === 'text'
                        ? undefined
                        : () => {
                            attachNodeId.current = node.id
                            fileRef.current?.click()
                          }
                    }
                    onEdit={
                      node.kind === 'generate'
                        ? () => setEditingNodeId(current => (current === node.id ? null : node.id))
                        : node.kind === 'image' && node.assetId && onOpenInpaint
                          ? () => onOpenInpaint(node)
                          : node.kind === 'image'
                            ? () => {
                                attachNodeId.current = node.id
                                fileRef.current?.click()
                              }
                            : undefined
                    }
                    onDownload={node.assetId ? () => onDownloadAssets?.([node.assetId as string]) : undefined}
                    onDuplicate={() => commit(duplicateBoardNodes(board, [node.id]))}
                    onDelete={() => {
                      commit(deleteBoardNodes(board, [node.id]))
                      setSelected([])
                    }}
                  />
                </div>
              )
            })()
          : null}

        {marqueeBox ? (
          <div
            className="pointer-events-none absolute border border-[var(--foreground)]/50 bg-[var(--foreground)]/5"
            style={{ left: marqueeBox.x, top: marqueeBox.y, width: marqueeBox.width, height: marqueeBox.height }}
          />
        ) : null}

        <div data-board-chrome="" className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3">
          <div className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-[var(--border)]/60 bg-[var(--card)]/92 p-1 shadow-[0_10px_28px_-16px_rgba(0,0,0,0.35)] backdrop-blur-md">
            <div className="flex rounded-xl bg-[var(--muted)]/50 p-0.5">
              {(Object.keys(TOOL_LABEL) as BoardTool[]).map(item => (
                <BoardIconButton
                  key={item}
                  title={t(TOOL_LABEL[item])}
                  active={tool === item}
                  onClick={() => setTool(item)}
                >
                  {item === 'select' ? <MousePointer2 size={14} /> : null}
                  {item === 'pan' ? <Hand size={14} /> : null}
                  {item === 'connect' ? <Spline size={14} /> : null}
                </BoardIconButton>
              ))}
            </div>
            <BoardDivider />
            <BoardIconButton title={t('Undo')} onClick={() => {
              const previous = history.current.pop()
              if (!previous) return
              future.current.push(board)
              onChange(previous)
            }}>
              <Undo2 size={14} />
            </BoardIconButton>
            <BoardIconButton title={t('Redo')} onClick={() => {
              const next = future.current.pop()
              if (!next) return
              history.current.push(board)
              onChange(next)
            }}>
              <Redo2 size={14} />
            </BoardIconButton>
            <BoardDivider />
            <BoardIconButton title={t('Add generate node')} onClick={() => addNode('generate')}>
              <Sparkles size={14} />
            </BoardIconButton>
            <BoardIconButton title={t('Add image node')} onClick={() => addNode('image')}>
              <ImagePlus size={14} />
            </BoardIconButton>
            <BoardIconButton title={t('Add text node')} onClick={() => addNode('text')}>
              <Type size={14} />
            </BoardIconButton>
            <BoardDivider />
            <BoardIconButton title={t('Zoom out')} onClick={() => onChange({
              ...board,
              viewport: zoomViewportAt(board.viewport, { x: stageSize.width / 2, y: stageSize.height / 2 }, board.viewport.scale * 0.85),
            })}>
              <Minus size={14} />
            </BoardIconButton>
            <span className="min-w-10 text-center text-[11px] tabular-nums text-[var(--muted-foreground)]">
              {Math.round(board.viewport.scale * 100)}%
            </span>
            <BoardIconButton title={t('Zoom')} onClick={() => onChange({
              ...board,
              viewport: zoomViewportAt(board.viewport, { x: stageSize.width / 2, y: stageSize.height / 2 }, board.viewport.scale * 1.15),
            })}>
              <Plus size={14} />
            </BoardIconButton>
            <BoardIconButton title={t('Fit to canvas')} onClick={() => onChange({ ...board, viewport: fitViewport(board.nodes, stageSize) })}>
              <Maximize2 size={14} />
            </BoardIconButton>
            <BoardDivider />
            <button
              type="button"
              onClick={exportSelectedRecipe}
              className="rounded-[10px] px-2 text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]/60"
            >
              {t('Export recipe')}
            </button>
            <button
              type="button"
              onClick={() => recipeRef.current?.click()}
              className="rounded-[10px] px-2 text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]/60"
            >
              {t('Import recipe')}
            </button>
          </div>
        </div>

        {selected.length ? (
          <div data-board-chrome="" className="pointer-events-none absolute inset-x-0 bottom-24 z-10 flex justify-center px-3">
            <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-[var(--border)]/60 bg-[var(--card)]/94 px-2 py-1 shadow-[0_10px_28px_-16px_rgba(0,0,0,0.35)] backdrop-blur-md">
              <span className="px-2 text-[11px] text-[var(--muted-foreground)]">{t('{{count}} selected', { count: selected.length })}</span>
              {selected.length === 1 && nodesById.get(selected[0])?.assetId ? (
                <button type="button" onClick={() => iterateSelected(selected[0])} className="rounded-full px-2.5 py-1 text-[11.5px] hover:bg-[var(--muted)]/60">
                  {t('Iterate from this image')}
                </button>
              ) : null}
              {selected.length > 1 ? (
                <>
                  <BoardIconButton title={t('Align left')} onClick={() => commit(alignBoardNodes(board, selected, 'left'))}>
                    <span className="text-[11px]">L</span>
                  </BoardIconButton>
                  <BoardIconButton title={t('Align center')} onClick={() => commit(alignBoardNodes(board, selected, 'centerX'))}>
                    <AlignVerticalSpaceAround size={14} />
                  </BoardIconButton>
                  <BoardIconButton title={t('Align middle')} onClick={() => commit(alignBoardNodes(board, selected, 'centerY'))}>
                    <AlignHorizontalSpaceAround size={14} />
                  </BoardIconButton>
                  <BoardIconButton title={t('Group')} onClick={() => {
                    const grouped = groupBoardNodes(board, selected)
                    if (grouped) commit(grouped.board)
                  }}>
                    <span className="text-[11px]">G</span>
                  </BoardIconButton>
                </>
              ) : null}
              {selected.length === 1 ? (
                <button
                  type="button"
                  onClick={() => {
                    const result = gridSplitFromNode(board, selected[0], 2, 2)
                    if (result) {
                      commit(result.board)
                      setSelected(result.nodeIds)
                    }
                  }}
                  className="rounded-full px-2.5 py-1 text-[11.5px] hover:bg-[var(--muted)]/60"
                >
                  {t('Split 2×2')}
                </button>
              ) : null}
              {selected.length === 1 && board.nodes.some(node => node.parentNodeId === selected[0]) ? (
                <button
                  type="button"
                  onClick={() => commit(layoutVariantTree(board, selected[0]))}
                  className="rounded-full px-2.5 py-1 text-[11.5px] hover:bg-[var(--muted)]/60"
                >
                  {t('Arrange variants')}
                </button>
              ) : null}
              <BoardIconButton title={t('Download selected')} onClick={downloadSelected}>
                <Download size={14} />
              </BoardIconButton>
              <BoardIconButton title={t('Duplicate')} onClick={() => commit(duplicateBoardNodes(board, selected))}>
                <Copy size={14} />
              </BoardIconButton>
              <BoardIconButton title={t('Delete')} onClick={() => { commit(deleteBoardNodes(board, selected)); setSelected([]) }}>
                <Trash2 size={14} />
              </BoardIconButton>
            </div>
          </div>
        ) : null}

        {libraryIds.length ? (
          <div data-board-chrome="" className="absolute top-16 left-3 flex max-h-[62%] flex-col gap-1.5 overflow-y-auto rounded-2xl border border-[var(--border)]/60 bg-[var(--card)]/90 p-1.5 shadow-[0_10px_24px_-18px_rgba(0,0,0,0.4)] backdrop-blur-md">
            {libraryIds.slice(0, 16).map(id => (
              <button
                key={id}
                type="button"
                draggable
                title={t('Add to board')}
                onDragStart={event => event.dataTransfer.setData(BOARD_ASSET_MIME, id)}
                onClick={() => placeLibraryAsset(id)}
                className="h-11 w-11 shrink-0 overflow-hidden rounded-[10px] border border-[var(--border)]/80"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={assetUrl(id)} alt="" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        ) : null}

        <StudioBoardPanel
          board={board}
          selected={selected}
          libraryIds={libraryIds}
          assetUrl={assetUrl}
          onSelect={setSelected}
          onFocusNode={nodeId => {
            const node = nodesById.get(nodeId)
            if (!node) return
            onChange({
              ...board,
              viewport: centerViewportOn(node, stageSize, Math.max(board.viewport.scale, 0.85)),
            })
          }}
          onRenameGroup={(groupId, title) => commit(renameBoardGroup(board, groupId, title))}
          onUngroup={groupId => commit(ungroupBoardNodes(board, groupId))}
          onSelectGroup={groupId => setSelected(groupMemberIds(board, groupId))}
          onToggleEdge={edgeId => commit(toggleBoardEdgeRole(board, edgeId))}
          onDeleteEdge={edgeId => commit(deleteBoardEdge(board, edgeId))}
        />

        <BoardMinimap
          board={board}
          stageSize={stageSize}
          onPointerDown={event => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            drag.current = { pointerId: event.pointerId, mode: 'minimap', start: { x: event.clientX, y: event.clientY }, last: { x: event.clientX, y: event.clientY }, ids: [] }
            panMinimap(event.clientX, event.clientY, rect)
            stageRef.current?.setPointerCapture(event.pointerId)
          }}
        />
      </div>

      <input
        ref={recipeRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={async event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          try {
            const raw = JSON.parse(await file.text())
            const result = importBoardRecipe(
              board,
              raw,
              screenToWorld({ x: stageSize.width / 2 - 120, y: stageSize.height / 2 - 80 }, board.viewport)
            )
            commit(result.board)
            setSelected(result.nodeIds)
          } catch {
            /* invalid recipe */
          }
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={event => {
          const files = Array.from(event.target.files || [])
          event.target.value = ''
          if (!files.length) return
          const node = attachNodeId.current ? nodesById.get(attachNodeId.current) : null
          onUploadFiles?.(
            files,
            node ? { x: node.x, y: node.y } : screenToWorld({ x: stageSize.width / 2, y: stageSize.height / 2 }, board.viewport),
            attachNodeId.current || undefined
          )
          attachNodeId.current = null
        }}
      />

      {menu ? (
        <div
          data-board-menu=""
          className="fixed z-30 min-w-44 overflow-hidden rounded-2xl border border-[var(--border)]/70 bg-[var(--card)]/96 py-1 text-[12.5px] shadow-[0_16px_40px_-24px_rgba(0,0,0,0.45)] backdrop-blur-md"
          style={{ left: menu.x, top: menu.y }}
        >
          <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--muted)]/60" onClick={() => { commit(duplicateBoardNodes(board, [menu.nodeId])); setMenu(null) }}>
            {t('Duplicate')}
          </button>
          <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--muted)]/60" onClick={() => { commit(bringBoardNodesToFront(board, [menu.nodeId])); setMenu(null) }}>
            {t('Bring to front')}
          </button>
          <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--muted)]/60" onClick={() => { commit(sendBoardNodesToBack(board, [menu.nodeId])); setMenu(null) }}>
            {t('Send to back')}
          </button>
          {nodesById.get(menu.nodeId)?.kind === 'generate' ? (
            <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--muted)]/60" onClick={() => {
              const node = nodesById.get(menu.nodeId)
              if (node) onGenerateNode({ ...node, prompt: collectBoardPrompt(board, node.id) })
              setMenu(null)
            }}>
              {t('Start creating')}
            </button>
          ) : null}
          {nodesById.get(menu.nodeId)?.assetId ? (
            <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--muted)]/60" onClick={() => { iterateSelected(menu.nodeId); setMenu(null) }}>
              {t('Iterate from this image')}
            </button>
          ) : null}
          <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--destructive)] hover:bg-[var(--muted)]/60" onClick={() => { commit(deleteBoardNodes(board, [menu.nodeId])); setSelected([]); setMenu(null) }}>
            <X size={12} /> {t('Delete')}
          </button>
        </div>
      ) : null}

      {connectMenu ? (
        <div
          data-board-menu=""
          className="fixed z-30 min-w-44 overflow-hidden rounded-2xl border border-[var(--border)]/70 bg-[var(--card)]/96 py-1 text-[12.5px] shadow-[0_16px_40px_-24px_rgba(0,0,0,0.45)] backdrop-blur-md"
          style={{ left: connectMenu.x, top: connectMenu.y }}
        >
          <p className="px-3 py-1 text-[10px] tracking-wide text-[var(--muted-foreground)] uppercase">
            {connectMenu.role === 'mask' ? t('Connect as mask') : t('Connect as reference')}
          </p>
          <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--muted)]/60" onClick={() => spawnFromConnect('generate', connectMenu.role)}>
            {t('Add generate node')}
          </button>
          <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--muted)]/60" onClick={() => spawnFromConnect('image', connectMenu.role)}>
            {t('Add image node')}
          </button>
          <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--muted)]/60" onClick={() => spawnFromConnect('text', 'reference')}>
            {t('Add text node')}
          </button>
          {connectMenu.role !== 'mask' && nodesById.get(connectMenu.fromId)?.assetId ? (
            <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--muted)]/60" onClick={() => spawnFromConnect('generate', 'mask')}>
              {t('New generate card as mask')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function templateLabel(id: BoardTemplateId): string {
  if (id === 'three-view') return 'Three-view template'
  if (id === 'picture-book') return 'Picture-book template'
  return 'Product set template'
}

function BoardDivider() {
  return <span className="mx-0.5 h-4 w-px bg-[var(--border)]" />
}

function BoardIconButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-[10px] ${
        active
          ? 'bg-[var(--background)] text-[var(--foreground)] shadow-sm'
          : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)]'
      }`}
    >
      {children}
    </button>
  )
}

function minimapMetrics(board: BoardDocument, stageSize: { width: number; height: number }) {
  const size = { width: 156, height: 100 }
  const bounds = board.nodes.length
    ? {
        x: Math.min(...board.nodes.map(node => node.x)) - 80,
        y: Math.min(...board.nodes.map(node => node.y)) - 80,
        width: Math.max(400, Math.max(...board.nodes.map(node => node.x + node.width)) - Math.min(...board.nodes.map(node => node.x)) + 160),
        height: Math.max(260, Math.max(...board.nodes.map(node => node.y + node.height)) - Math.min(...board.nodes.map(node => node.y)) + 160),
      }
    : { x: 0, y: 0, width: 800, height: 500 }
  return { size, bounds, scale: Math.min(size.width / bounds.width, size.height / bounds.height) }
}

function BoardMinimap({
  board,
  stageSize,
  onPointerDown,
}: {
  board: BoardDocument
  stageSize: { width: number; height: number }
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
}) {
  const { t } = useTranslation()
  const { size, bounds, scale } = minimapMetrics(board, stageSize)
  const world = screenToWorld({ x: 0, y: 0 }, board.viewport)
  const view = {
    x: (world.x - bounds.x) * scale,
    y: (world.y - bounds.y) * scale,
    width: (stageSize.width / board.viewport.scale) * scale,
    height: (stageSize.height / board.viewport.scale) * scale,
  }

  return (
    <div
      data-board-minimap=""
      title={t('Minimap')}
      className="absolute right-3 bottom-24 cursor-pointer overflow-hidden rounded-2xl border border-[var(--border)]/60 bg-[var(--card)]/90 shadow-[0_10px_24px_-18px_rgba(0,0,0,0.4)] backdrop-blur-md"
      style={{ width: size.width, height: size.height }}
      onPointerDown={onPointerDown}
    >
      {board.nodes.map(node => (
        <span
          key={node.id}
          className="absolute rounded-[2px] bg-[var(--muted-foreground)]/40"
          style={{
            left: (node.x - bounds.x) * scale,
            top: (node.y - bounds.y) * scale,
            width: Math.max(3, node.width * scale),
            height: Math.max(3, node.height * scale),
          }}
        />
      ))}
      <span className="absolute border border-[var(--foreground)]/70" style={view} />
    </div>
  )
}
