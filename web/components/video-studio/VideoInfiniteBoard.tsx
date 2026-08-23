'use client'

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { Clapperboard, Maximize2, Minus, Plus, Trash2, Type } from 'lucide-react'
import {
  addVideoBoardNode,
  canConnectVideoNodes,
  clampBoardScale,
  connectVideoBoardNodes,
  connectionHandles,
  connectionPath,
  createVideoBoardNode,
  cycleVideoEdgeRole,
  deleteVideoBoardEdge,
  deleteVideoBoardNodes,
  dragExceededThreshold,
  fitViewport,
  focusViewportOnNode,
  hitTestConnection,
  moveVideoBoardNodes,
  nodeRect,
  nodesInRect,
  normalizeRect,
  panViewport,
  screenToWorld,
  setVideoBoardEdgeRole,
  toggleVideoBoardSelection,
  updateVideoBoardNode,
  VIDEO_NODE_SIZE,
  zoomViewportAt,
  type VideoBoardDocument,
  type VideoBoardEdge,
  type VideoBoardEdgeRole,
  type VideoBoardNode as VideoBoardNodeModel,
  type VideoBoardPoint,
  type VideoBoardSize,
  type VideoBoardViewport,
} from '@/lib/video-studio/board-logic'
import { VIDEO_ROLE_STROKE, VideoBoardNode, videoBoardRoleLabel, type VideoBoardJobState } from './VideoBoardNode'

/** Drag-and-drop MIME the page should set when dragging assets onto the board. */
export const VIDEO_ASSET_DRAG_MIME = 'application/x-knorvia-video-asset'

export type VideoBoardLabels = {
  canvas: string
  addText: string
  addImage: string
  addVideo: string
  addAudio: string
  addGenerate: string
  generate: string
  delete: string
  zoomIn: string
  zoomOut: string
  fitView: string
  firstFrame: string
  lastFrame: string
  reference: string
  audioRole: string
  continueFrom: string
  emptyCanvas: string
  running: string
  queued: string
  failed: string
  succeeded: string
  unknown: string
  /** C4 camera badge: group label plus localized motion labels (raw fallback). */
  camera: string
  cameraMotions: Record<string, string>
  /** §Phase C5 reroll button on generate cards (two-step paid confirm). */
  reroll: string
  rerollArmed: string
  rerollHint: string
  variants: string
}

export type VideoInfiniteBoardProps = {
  board: VideoBoardDocument
  labels: VideoBoardLabels
  assetUrl: (assetId: string) => string
  selectedIds: string[]
  jobsById?: Record<string, VideoBoardJobState>
  readOnly?: boolean
  className?: string
  onSelectionChange: (ids: string[]) => void
  onBoardChange: (next: VideoBoardDocument) => void
  onViewportChange: (viewport: VideoBoardViewport) => void
  onGenerateRequest: (nodeId: string) => void
  onNodeOpen: (nodeId: string) => void
  /** §Phase C5: paid reroll of a generate card's latest take. */
  onRerollRequest?: (nodeId: string) => void
  /** §Phase C5: takes already run per generate node id (lightweight badge). */
  variantCounts?: Record<string, number>
  focusNodeRef?: RefObject<{ focus: (nodeId: string) => void } | null>
  onDropAsset?: (assetId: string, kind: 'image' | 'video' | 'audio', worldPoint: VideoBoardPoint) => void
}

type PointerSession =
  | { mode: 'pan'; pointerId: number; start: VideoBoardPoint; last: VideoBoardPoint; moved: boolean }
  | {
      mode: 'node'
      pointerId: number
      start: VideoBoardPoint
      ids: string[]
      primaryId: string
      grab: VideoBoardPoint
      moved: boolean
    }
  | { mode: 'marquee'; pointerId: number; start: VideoBoardPoint; base: string[]; moved: boolean }
  | { mode: 'connect'; pointerId: number; from: string; start: VideoBoardPoint; moved: boolean }

function defaultConnectRole(fromKind: VideoBoardNodeModel['kind'], toKind: VideoBoardNodeModel['kind']): VideoBoardEdgeRole {
  if (fromKind === 'audio') return 'audio'
  if (toKind === 'generate') {
    if (fromKind === 'image') return 'first-frame'
    if (fromKind === 'video') return 'continue-from'
  }
  return 'reference'
}

function nodeAtClient(clientX: number, clientY: number): string | null {
  const element = document.elementFromPoint(clientX, clientY)
  const id = element?.closest('[data-video-node-id]')?.getAttribute('data-video-node-id')
  return id || null
}

export function VideoInfiniteBoard({
  board,
  labels,
  assetUrl,
  selectedIds,
  jobsById,
  readOnly = false,
  className,
  onSelectionChange,
  onBoardChange,
  onViewportChange,
  onGenerateRequest,
  onNodeOpen,
  onRerollRequest,
  variantCounts,
  focusNodeRef,
  onDropAsset,
}: VideoInfiniteBoardProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const boardRef = useRef(board)
  const onBoardChangeRef = useRef(onBoardChange)
  const onViewportChangeRef = useRef(onViewportChange)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onGenerateRequestRef = useRef(onGenerateRequest)
  const onNodeOpenRef = useRef(onNodeOpen)
  const onDropAssetRef = useRef(onDropAsset)
  const selectedRef = useRef(selectedIds)
  const readOnlyRef = useRef(readOnly)
  const stageSizeRef = useRef<VideoBoardSize>({ width: 960, height: 640 })
  const drag = useRef<PointerSession | null>(null)
  const touches = useRef(new Map<number, VideoBoardPoint>())
  const pinch = useRef<{ startViewport: VideoBoardViewport; startDist: number; startMid: VideoBoardPoint } | null>(null)

  const [marquee, setMarquee] = useState<{ start: VideoBoardPoint; current: VideoBoardPoint } | null>(null)
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
  const [connectTargetId, setConnectTargetId] = useState<string | null>(null)
  const previewPathRef = useRef<SVGPathElement | null>(null)
  const connectHoverFrame = useRef(0)
  const pendingConnectTarget = useRef<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [spacePan, setSpacePan] = useState(false)
  const spacePanRef = useRef(false)
  const selectedEdgeIdRef = useRef<string | null>(null)

  const deferredJobsById = useDeferredValue(jobsById)

  useLayoutEffect(() => {
    boardRef.current = board
    onBoardChangeRef.current = onBoardChange
    onViewportChangeRef.current = onViewportChange
    onSelectionChangeRef.current = onSelectionChange
    onGenerateRequestRef.current = onGenerateRequest
    onNodeOpenRef.current = onNodeOpen
    onDropAssetRef.current = onDropAsset
    selectedRef.current = selectedIds
    readOnlyRef.current = readOnly
    spacePanRef.current = spacePan
    selectedEdgeIdRef.current = selectedEdgeId
  })

  const emitBoard = useCallback((next: VideoBoardDocument) => {
    boardRef.current = next
    onBoardChangeRef.current(next)
  }, [])

  const emitViewport = useCallback((viewport: VideoBoardViewport) => {
    boardRef.current = { ...boardRef.current, viewport }
    onViewportChangeRef.current(viewport)
  }, [])

  const clientPoint = useCallback((event: { clientX: number; clientY: number }): VideoBoardPoint => {
    const rect = stageRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left || 0), y: event.clientY - (rect?.top || 0) }
  }, [])

  // Stage size tracking (fit view + focus need real dimensions).
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect
      if (box && box.width > 0 && box.height > 0) {
        stageSizeRef.current = { width: box.width, height: box.height }
      }
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  // Wheel: zoom at cursor (plain wheel), pan on shift / horizontal deltas.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onNativeWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, button, a, video, audio, [contenteditable="true"]')) return
      event.preventDefault()
      const rect = stage.getBoundingClientRect()
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      const viewport = boardRef.current.viewport
      if (event.shiftKey) {
        emitViewport(panViewport(viewport, { x: -event.deltaY, y: 0 }))
        return
      }
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        emitViewport(panViewport(viewport, { x: -event.deltaX, y: -event.deltaY }))
        return
      }
      emitViewport(zoomViewportAt(viewport, point, viewport.scale * (event.deltaY > 0 ? 0.92 : 1.08)))
    }
    stage.addEventListener('wheel', onNativeWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onNativeWheel)
  }, [emitViewport])

  // Keyboard: delete selection / edges, escape cancels interactions.
  useEffect(() => {
    function typing(target: EventTarget | null) {
      return (
        target instanceof HTMLElement &&
        Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
      )
    }
    function onKeyDown(event: KeyboardEvent) {
      if (typing(event.target)) return
      if (event.code === 'Space') {
        event.preventDefault()
        setSpacePan(true)
      }
      if (event.key === 'Escape') {
        drag.current = null
        setMarquee(null)
        setConnectFrom(null)
        setConnectTargetId(null)
        setSelectedEdgeId(null)
        return
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      if (readOnlyRef.current) return
      if (selectedEdgeIdRef.current) {
        event.preventDefault()
        emitBoard(deleteVideoBoardEdge(boardRef.current, selectedEdgeIdRef.current))
        setSelectedEdgeId(null)
        return
      }
      const ids = selectedRef.current
      if (!ids.length) return
      event.preventDefault()
      emitBoard(deleteVideoBoardNodes(boardRef.current, ids))
      onSelectionChangeRef.current([])
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
  }, [emitBoard])

  // focusNodeRef: let the page command the canvas to center + select a node.
  useEffect(() => {
    if (!focusNodeRef) return
    focusNodeRef.current = {
      focus: (nodeId: string) => {
        const stage = stageRef.current
        const size = stage ? { width: stage.clientWidth, height: stage.clientHeight } : stageSizeRef.current
        const next = focusViewportOnNode(
          boardRef.current,
          nodeId,
          size,
          Math.max(boardRef.current.viewport.scale, 0.9)
        )
        if (!next) return
        emitViewport(next)
        onSelectionChangeRef.current([nodeId])
      },
    }
    return () => {
      focusNodeRef.current = null
    }
  }, [focusNodeRef, emitViewport])

  const nodesById = useMemo(() => new Map(board.nodes.map(node => [node.id, node])), [board.nodes])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const incomingRolesById = useMemo(() => {
    const map = new Map<string, VideoBoardEdgeRole[]>()
    for (const edge of board.edges) {
      const list = map.get(edge.to)
      if (list) list.push(edge.role)
      else map.set(edge.to, [edge.role])
    }
    return map
  }, [board.edges])

  const findEdgeAt = useCallback((worldPoint: VideoBoardPoint): VideoBoardEdge | null => {
    const current = boardRef.current
    const threshold = 10 / current.viewport.scale
    for (let index = current.edges.length - 1; index >= 0; index -= 1) {
      const edge = current.edges[index]
      const from = current.nodes.find(node => node.id === edge.from)
      const to = current.nodes.find(node => node.id === edge.to)
      if (from && to && hitTestConnection(nodeRect(from), nodeRect(to), worldPoint, threshold)) return edge
    }
    return null
  }, [])

  function paintConnectPreview(fromId: string, point: VideoBoardPoint, targetId: string | null) {
    const path = previewPathRef.current
    const from = boardRef.current.nodes.find(node => node.id === fromId)
    if (!path || !from) return
    const target = targetId ? boardRef.current.nodes.find(node => node.id === targetId) : null
    const world = screenToWorld(point, boardRef.current.viewport)
    path.setAttribute(
      'd',
      connectionPath(nodeRect(from), target ? nodeRect(target) : { x: world.x, y: world.y, width: 1, height: 1 })
    )
    path.setAttribute('display', 'inline')
  }

  function hideConnectPreview() {
    previewPathRef.current?.setAttribute('display', 'none')
  }

  function scheduleConnectTarget(id: string | null) {
    pendingConnectTarget.current = id
    if (connectHoverFrame.current) return
    connectHoverFrame.current = requestAnimationFrame(() => {
      connectHoverFrame.current = 0
      const next = pendingConnectTarget.current
      setConnectTargetId(current => (current === next ? current : next))
    })
  }

  // ── node callbacks (stable identity for memoized VideoBoardNode) ──────

  const handleNodePointerDown = useCallback(
    (event: ReactPointerEvent, nodeId: string) => {
      if (event.button === 2) return
      const target = event.target as HTMLElement
      const interactive = Boolean(target.closest('[data-video-interactive]'))
      const next = toggleVideoBoardSelection(selectedRef.current, nodeId, event.shiftKey)
      onSelectionChangeRef.current(next)
      setSelectedEdgeId(null)
      if (readOnlyRef.current || interactive) return
      const point = clientPoint(event)
      const current = boardRef.current
      const node = current.nodes.find(item => item.id === nodeId)
      if (!node) return
      const world = screenToWorld(point, current.viewport)
      drag.current = {
        mode: 'node',
        pointerId: event.pointerId,
        start: point,
        ids: next,
        primaryId: nodeId,
        grab: { x: world.x - node.x, y: world.y - node.y },
        moved: false,
      }
      stageRef.current?.setPointerCapture(event.pointerId)
    },
    [clientPoint]
  )

  const handleConnectStart = useCallback(
    (event: ReactPointerEvent, nodeId: string) => {
      if (readOnlyRef.current) return
      const point = clientPoint(event)
      setSelectedEdgeId(null)
      setConnectFrom(nodeId)
      paintConnectPreview(nodeId, point, null)
      drag.current = { mode: 'connect', pointerId: event.pointerId, from: nodeId, start: point, moved: false }
      stageRef.current?.setPointerCapture(event.pointerId)
    },
    [clientPoint]
  )

  const handleNodeOpen = useCallback((nodeId: string) => {
    onNodeOpenRef.current(nodeId)
  }, [])

  const handleTextChange = useCallback(
    (nodeId: string, text: string) => {
      const current = boardRef.current
      const node = current.nodes.find(item => item.id === nodeId)
      if (!node || (node.text || '') === text) return
      emitBoard(updateVideoBoardNode(current, nodeId, { text }))
    },
    [emitBoard]
  )

  const handleGenerateNode = useCallback((nodeId: string) => {
    onGenerateRequestRef.current(nodeId)
  }, [])

  const addNode = useCallback(
    (kind: 'text' | 'generate') => {
      if (readOnlyRef.current) return
      const size = stageSizeRef.current
      const nodeSize = VIDEO_NODE_SIZE[kind]
      const origin = screenToWorld(
        { x: (size.width - nodeSize.width) / 2, y: (size.height - nodeSize.height) / 2 },
        boardRef.current.viewport
      )
      const node = createVideoBoardNode(kind, origin, boardRef.current.nodes.map(nodeRect))
      emitBoard(addVideoBoardNode(boardRef.current, node))
      onSelectionChangeRef.current([node.id])
    },
    [emitBoard]
  )

  const deleteSelection = useCallback(() => {
    if (readOnlyRef.current) return
    const ids = selectedRef.current
    if (!ids.length) return
    emitBoard(deleteVideoBoardNodes(boardRef.current, ids))
    onSelectionChangeRef.current([])
  }, [emitBoard])

  const zoomBy = useCallback(
    (factor: number) => {
      const size = stageSizeRef.current
      const viewport = boardRef.current.viewport
      emitViewport(
        zoomViewportAt(viewport, { x: size.width / 2, y: size.height / 2 }, viewport.scale * factor)
      )
    },
    [emitViewport]
  )

  const fitView = useCallback(() => {
    emitViewport(fitViewport(boardRef.current.nodes.map(nodeRect), stageSizeRef.current))
  }, [emitViewport])

  // ── pinch zoom (two touch pointers) ───────────────────────────────────

  function beginPinch() {
    const points = [...touches.current.values()]
    if (points.length < 2) return
    const [a, b] = points
    pinch.current = {
      startViewport: boardRef.current.viewport,
      startDist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    }
  }

  function updatePinch() {
    const state = pinch.current
    if (!state) return
    const points = [...touches.current.values()]
    if (points.length < 2) return
    const [a, b] = points
    const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const scale = clampBoardScale(state.startViewport.scale * (dist / state.startDist))
    const anchor = screenToWorld(state.startMid, state.startViewport)
    const panned: VideoBoardViewport = {
      scale: state.startViewport.scale,
      x: mid.x - anchor.x * state.startViewport.scale,
      y: mid.y - anchor.y * state.startViewport.scale,
    }
    emitViewport(zoomViewportAt(panned, mid, scale))
  }

  // ── stage pointer flow ────────────────────────────────────────────────

  function onStagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button === 2) return
    const target = event.target as HTMLElement
    if (target.closest('[data-board-chrome],[data-board-empty]')) return
    const point = clientPoint(event)
    if (event.pointerType === 'touch') {
      touches.current.set(event.pointerId, point)
      stageRef.current?.setPointerCapture(event.pointerId)
      if (touches.current.size >= 2) {
        drag.current = null
        setMarquee(null)
        setConnectFrom(null)
        setConnectTargetId(null)
        hideConnectPreview()
        beginPinch()
        return
      }
    }
    if (target.closest('[data-video-node-id]')) return
    if (spacePanRef.current || event.button === 1) {
      if (event.button === 1) event.preventDefault()
      drag.current = { mode: 'pan', pointerId: event.pointerId, start: point, last: point, moved: false }
      stageRef.current?.setPointerCapture(event.pointerId)
      return
    }
    const world = screenToWorld(point, boardRef.current.viewport)
    const edge = findEdgeAt(world)
    if (edge) {
      setSelectedEdgeId(edge.id)
      return
    }
    setSelectedEdgeId(null)
    if (event.pointerType === 'touch') {
      drag.current = { mode: 'pan', pointerId: event.pointerId, start: point, last: point, moved: false }
      return
    }
    const base = event.shiftKey ? selectedRef.current : []
    if (!event.shiftKey) onSelectionChangeRef.current([])
    setMarquee({ start: point, current: point })
    drag.current = { mode: 'marquee', pointerId: event.pointerId, start: point, base, moved: false }
    stageRef.current?.setPointerCapture(event.pointerId)
  }

  function onStagePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const point = clientPoint(event)
    if (event.pointerType === 'touch' && touches.current.has(event.pointerId)) {
      touches.current.set(event.pointerId, point)
    }
    if (pinch.current) {
      updatePinch()
      return
    }
    const session = drag.current
    if (!session || session.pointerId !== event.pointerId) return

    if (session.mode === 'pan') {
      session.moved = session.moved || dragExceededThreshold(session.start, point, 4)
      emitViewport(
        panViewport(boardRef.current.viewport, { x: point.x - session.last.x, y: point.y - session.last.y })
      )
      session.last = point
      return
    }

    if (session.mode === 'node') {
      if (!session.moved) {
        if (!dragExceededThreshold(session.start, point, 6)) return
        session.moved = true
      }
      const current = boardRef.current
      const world = screenToWorld(point, current.viewport)
      const primary = current.nodes.find(node => node.id === session.primaryId)
      if (!primary) return
      const delta = {
        x: world.x - session.grab.x - primary.x,
        y: world.y - session.grab.y - primary.y,
      }
      if (!delta.x && !delta.y) return
      emitBoard(moveVideoBoardNodes(current, session.ids, delta))
      return
    }

    if (session.mode === 'connect') {
      session.moved = session.moved || dragExceededThreshold(session.start, point, 4)
      const over = nodeAtClient(event.clientX, event.clientY)
      const target = over && over !== session.from ? over : null
      paintConnectPreview(session.from, point, target)
      scheduleConnectTarget(target)
      return
    }

    if (session.mode === 'marquee') {
      session.moved = session.moved || dragExceededThreshold(session.start, point, 4)
      setMarquee(current => (current ? { ...current, current: point } : current))
    }
  }

  function onStagePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'touch') touches.current.delete(event.pointerId)
    if (pinch.current) {
      if (touches.current.size < 2) {
        pinch.current = null
        const remaining = [...touches.current.entries()][0]
        if (remaining) {
          drag.current = {
            mode: 'pan',
            pointerId: remaining[0],
            start: remaining[1],
            last: remaining[1],
            moved: true,
          }
        }
      }
      releaseCapture(event.pointerId)
      return
    }
    const session = drag.current
    if (session?.mode === 'pan' && !session.moved && event.pointerType === 'touch') {
      onSelectionChangeRef.current([])
      setSelectedEdgeId(null)
    }
    if (session?.mode === 'marquee' && marquee && session.moved) {
      const viewport = boardRef.current.viewport
      const a = screenToWorld(marquee.start, viewport)
      const b = screenToWorld(marquee.current, viewport)
      const rect = normalizeRect({ x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y })
      const hits = nodesInRect(boardRef.current.nodes, rect)
      const merged = session.base.length ? Array.from(new Set([...session.base, ...hits])) : hits
      onSelectionChangeRef.current(merged)
    }
    if (session?.mode === 'connect' && session.moved) {
      finishConnect(session.from, event)
    }
    drag.current = null
    setMarquee(null)
    setConnectFrom(null)
    setConnectTargetId(null)
    hideConnectPreview()
    releaseCapture(event.pointerId)
  }

  function releaseCapture(pointerId: number) {
    const stage = stageRef.current
    if (stage?.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId)
  }

  function finishConnect(fromId: string, event: ReactPointerEvent<HTMLDivElement>) {
    const over = nodeAtClient(event.clientX, event.clientY)
    if (!over || over === fromId) return
    const current = boardRef.current
    const from = current.nodes.find(node => node.id === fromId)
    const to = current.nodes.find(node => node.id === over)
    if (!from || !to) return
    const role = defaultConnectRole(from.kind, to.kind)
    if (canConnectVideoNodes(current, fromId, over, role)) {
      emitBoard(connectVideoBoardNodes(current, fromId, over, role))
      return
    }
    if (role !== 'reference' && canConnectVideoNodes(current, fromId, over, 'reference')) {
      emitBoard(connectVideoBoardNodes(current, fromId, over, 'reference'))
    }
  }

  // ── derived render state ──────────────────────────────────────────────

  const marqueeBox = marquee
    ? normalizeRect({
        x: marquee.start.x,
        y: marquee.start.y,
        width: marquee.current.x - marquee.start.x,
        height: marquee.current.y - marquee.start.y,
      })
    : null

  const connectTargetValid = useMemo(() => {
    if (!connectFrom || !connectTargetId) return null
    const from = board.nodes.find(node => node.id === connectFrom)
    const to = board.nodes.find(node => node.id === connectTargetId)
    if (!from || !to) return null
    const role = defaultConnectRole(from.kind, to.kind)
    if (canConnectVideoNodes(board, connectFrom, connectTargetId, role)) return role
    if (role !== 'reference' && canConnectVideoNodes(board, connectFrom, connectTargetId, 'reference')) {
      return 'reference'
    }
    return null
  }, [board, connectFrom, connectTargetId])

  function cycleEdgeRole(edgeId: string) {
    if (readOnlyRef.current) return
    const current = boardRef.current
    const edge = current.edges.find(item => item.id === edgeId)
    if (!edge) return
    emitBoard(setVideoBoardEdgeRole(current, edgeId, cycleVideoEdgeRole(edge.role)))
  }

  function removeEdge(edgeId: string) {
    if (readOnlyRef.current) return
    emitBoard(deleteVideoBoardEdge(boardRef.current, edgeId))
    setSelectedEdgeId(null)
  }

  return (
    <div className={`relative flex min-h-0 flex-1 flex-col ${className || ''}`}>
      <div
        ref={stageRef}
        data-video-board-stage=""
        className={`relative min-h-0 flex-1 overflow-hidden ${
          connectFrom ? 'cursor-crosshair' : spacePan ? 'cursor-grab' : 'cursor-default'
        }`}
        style={{
          touchAction: 'none',
          backgroundColor: 'var(--background)',
          backgroundImage: [
            'radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--foreground) 9%, transparent) 1px, transparent 0)',
            'linear-gradient(180deg, color-mix(in srgb, var(--muted) 28%, var(--background)), var(--background) 42%)',
          ].join(','),
          backgroundSize: `${22 * board.viewport.scale}px ${22 * board.viewport.scale}px, 100% 100%`,
          backgroundPosition: `${board.viewport.x}px ${board.viewport.y}px, 0 0`,
        }}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
        onDragOver={event => event.preventDefault()}
        onDrop={event => {
          event.preventDefault()
          if (readOnlyRef.current || !onDropAssetRef.current) return
          const payload =
            event.dataTransfer.getData(VIDEO_ASSET_DRAG_MIME) || event.dataTransfer.getData('text/plain')
          if (!payload) return
          let assetId = payload
          let kind: 'image' | 'video' | 'audio' = 'image'
          try {
            const parsed = JSON.parse(payload) as { assetId?: unknown; kind?: unknown }
            if (parsed && typeof parsed === 'object' && typeof parsed.assetId === 'string') {
              assetId = parsed.assetId
              if (parsed.kind === 'video' || parsed.kind === 'audio' || parsed.kind === 'image') {
                kind = parsed.kind
              }
            }
          } catch {
            /* plain assetId payload */
          }
          if (!assetId) return
          const world = screenToWorld(clientPoint(event), boardRef.current.viewport)
          onDropAssetRef.current(assetId, kind, world)
        }}
      >
        {!board.nodes.length ? (
          <div data-board-empty="" className="absolute inset-0 z-10 grid place-items-center px-6 text-center">
            <div data-board-chrome="" className="max-w-sm">
              <p className="text-[14px] font-medium tracking-tight">{labels.emptyCanvas}</p>
              {!readOnly ? (
                <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => addNode('generate')}
                    className="rounded-[10px] bg-[var(--foreground)] px-3 py-1.5 text-[12px] text-[var(--background)]"
                  >
                    {labels.addGenerate}
                  </button>
                  <button
                    type="button"
                    onClick={() => addNode('text')}
                    className="rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-[12px]"
                  >
                    {labels.addText}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            transform: `translate(${board.viewport.x}px, ${board.viewport.y}px) scale(${board.viewport.scale})`,
          }}
        >
          <svg className="absolute overflow-visible" width={1} height={1}>
            {board.edges.map(edge => {
              const from = nodesById.get(edge.from)
              const to = nodesById.get(edge.to)
              if (!from || !to) return null
              const handles = connectionHandles(nodeRect(from), nodeRect(to))
              const mid = handles.mid
              const active = selectedEdgeId === edge.id
              const roleLabel = videoBoardRoleLabel(edge.role, labels)
              const badgeWidth = roleLabel.length * 5.4 + 14
              return (
                <g key={edge.id}>
                  <path
                    d={connectionPath(nodeRect(from), nodeRect(to))}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={16}
                    className="cursor-pointer"
                    onPointerDown={downEvent => {
                      downEvent.stopPropagation()
                      setSelectedEdgeId(edge.id)
                    }}
                  />
                  <path
                    d={connectionPath(nodeRect(from), nodeRect(to))}
                    fill="none"
                    stroke={VIDEO_ROLE_STROKE[edge.role]}
                    strokeWidth={active ? 2.4 : 1.7}
                    strokeLinecap="round"
                    className="pointer-events-none"
                  />
                  <g
                    className="cursor-pointer"
                    onPointerDown={downEvent => downEvent.stopPropagation()}
                    onClick={clickEvent => {
                      clickEvent.stopPropagation()
                      cycleEdgeRole(edge.id)
                    }}
                  >
                    <rect
                      x={mid.x - badgeWidth / 2}
                      y={mid.y - 8}
                      width={badgeWidth}
                      height={16}
                      rx={8}
                      fill="var(--card)"
                      stroke={VIDEO_ROLE_STROKE[edge.role]}
                      strokeWidth={1}
                    />
                    <text
                      x={mid.x}
                      y={mid.y + 3.5}
                      textAnchor="middle"
                      fontSize={9.5}
                      fill="var(--foreground)"
                      className="select-none"
                    >
                      {roleLabel}
                    </text>
                  </g>
                  {active && !readOnly ? (
                    <g
                      className="cursor-pointer"
                      onPointerDown={downEvent => downEvent.stopPropagation()}
                      onClick={clickEvent => {
                        clickEvent.stopPropagation()
                        removeEdge(edge.id)
                      }}
                    >
                      <circle cx={mid.x} cy={mid.y - 22} r={9} fill="var(--card)" stroke="rgb(248 113 113 / 0.85)" />
                      <text x={mid.x} y={mid.y - 18.2} textAnchor="middle" fontSize={11} fill="rgb(248 113 113)">
                        ×
                      </text>
                    </g>
                  ) : null}
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
          </svg>

          {board.nodes.map(node => (
            <article
              key={node.id}
              data-video-node-id={node.id}
              className="absolute overflow-visible"
              style={{ left: node.x, top: node.y, width: node.width, height: node.height, zIndex: node.z }}
            >
              <VideoBoardNode
                node={node}
                selected={selectedSet.has(node.id)}
                connecting={connectFrom === node.id}
                connectTarget={connectTargetId === node.id && connectTargetValid != null}
                labels={labels}
                assetUrl={assetUrl}
                job={node.jobId ? deferredJobsById?.[node.jobId] : undefined}
                incomingRoles={incomingRolesById.get(node.id)}
                readOnly={readOnly}
                onPointerDown={handleNodePointerDown}
                onConnectStart={handleConnectStart}
                onOpen={handleNodeOpen}
                onTextChange={handleTextChange}
                onGenerate={handleGenerateNode}
                onReroll={onRerollRequest}
                variantCount={variantCounts?.[node.id] || 0}
              />
            </article>
          ))}
        </div>

        {marqueeBox ? (
          <div
            className="pointer-events-none absolute border border-[var(--foreground)]/50 bg-[var(--foreground)]/5"
            style={{
              left: marqueeBox.x,
              top: marqueeBox.y,
              width: marqueeBox.width,
              height: marqueeBox.height,
            }}
          />
        ) : null}

        <div
          data-board-chrome=""
          className="pointer-events-none absolute top-3 left-3 z-20"
          aria-label={labels.canvas}
        >
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-2xl border border-[var(--border)]/60 bg-[var(--card)]/92 p-1 shadow-[0_10px_28px_-16px_rgba(0,0,0,0.35)] backdrop-blur-md">
            {!readOnly ? (
              <>
                <BoardIconButton title={labels.addText} onClick={() => addNode('text')}>
                  <Type size={14} />
                </BoardIconButton>
                <BoardIconButton title={labels.addGenerate} onClick={() => addNode('generate')}>
                  <Clapperboard size={14} />
                </BoardIconButton>
                <BoardDivider />
              </>
            ) : null}
            <BoardIconButton title={labels.zoomOut} onClick={() => zoomBy(0.85)}>
              <Minus size={14} />
            </BoardIconButton>
            <span className="min-w-10 text-center text-[11px] tabular-nums text-[var(--muted-foreground)]">
              {Math.round(board.viewport.scale * 100)}%
            </span>
            <BoardIconButton title={labels.zoomIn} onClick={() => zoomBy(1.15)}>
              <Plus size={14} />
            </BoardIconButton>
            <BoardIconButton title={labels.fitView} onClick={fitView}>
              <Maximize2 size={14} />
            </BoardIconButton>
            {!readOnly && selectedIds.length ? (
              <>
                <BoardDivider />
                <BoardIconButton title={labels.delete} onClick={deleteSelection}>
                  <Trash2 size={14} />
                </BoardIconButton>
              </>
            ) : null}
          </div>
        </div>

        {!readOnly && selectedIds.length ? (
          <div
            data-board-chrome=""
            className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3"
          >
            <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-[var(--border)]/60 bg-[var(--card)]/94 px-3 py-1.5 text-[11px] shadow-[0_10px_28px_-16px_rgba(0,0,0,0.35)] backdrop-blur-md">
              <span className="text-[var(--muted-foreground)] tabular-nums">{selectedIds.length}</span>
              <button
                type="button"
                onClick={deleteSelection}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-red-400 hover:bg-[var(--muted)]/60"
              >
                <Trash2 size={12} /> {labels.delete}
              </button>
            </div>
          </div>
        ) : null}

      </div>
    </div>
  )
}

function BoardDivider() {
  return <span className="mx-0.5 h-4 w-px bg-[var(--border)]" />
}

function BoardIconButton({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)]"
    >
      {children}
    </button>
  )
}
