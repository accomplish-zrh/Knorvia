import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addBoardNode,
  applyJobToBoard,
  boardInputAssetIds,
  canConnectNodes,
  clampBoardScale,
  connectBoardNodes,
  createBoardNode,
  deleteBoardNodes,
  duplicateBoardNodes,
  emptyBoard,
  centerViewportOn,
  fitViewport,
  incomingBoardRefs,
  moveBoardNodes,
  normalizeBoard,
  nodesInRect,
  placeAvoiding,
  screenToWorld,
  seedAssetOnBoard,
  toggleBoardSelection,
  updateBoardNode,
  worldToScreen,
  collectBoardPrompt,
  deleteBoardEdge,
  dragExceededThreshold,
  edgeAutoPan,
  iterateFromImage,
  hitTestConnection,
  sendBoardNodesToBack,
  snapNodeMove,
  zoomViewportAt,
  alignBoardNodes,
  applyBoardTemplate,
  exportBoardRecipe,
  extractMentionIds,
  gridSplitFromNode,
  groupBoardNodes,
  importBoardRecipe,
  insertBoardMention,
  layoutVariantTree,
  polishBoardPrompt,
  selectedAssetIds,
  snapOutputSize,
  spawnConnectedNode,
  toggleBoardEdgeRole,
  insertNodeOnEdge,
} from '../lib/image-studio/board-logic'

test('viewport converts screen and world space and zooms around the cursor', () => {
  const viewport = { x: 100, y: 40, scale: 2 }
  const world = screenToWorld({ x: 140, y: 80 }, viewport)
  assert.deepEqual(world, { x: 20, y: 20 })
  assert.deepEqual(worldToScreen(world, viewport), { x: 140, y: 80 })
  const zoomed = zoomViewportAt(viewport, { x: 140, y: 80 }, 1)
  assert.equal(zoomed.scale, 1)
  assert.deepEqual(screenToWorld({ x: 140, y: 80 }, zoomed), world)
  assert.equal(clampBoardScale(0.01), 0.15)
  assert.equal(clampBoardScale(9), 3)
})

test('placement walks around overlapping nodes', () => {
  const first = { x: 0, y: 0, width: 100, height: 80 }
  const next = placeAvoiding(first, [first])
  assert.ok(next.x !== 0 || next.y !== 0)
})

test('connections become reference inputs and reject cycles', () => {
  let board = emptyBoard()
  board = addBoardNode(
    board,
    createBoardNode('image', { x: 0, y: 0 }, [], { id: 'src', assetId: 'asset-1' })
  )
  board = addBoardNode(
    board,
    createBoardNode('generate', { x: 400, y: 0 }, board.nodes, { id: 'gen', prompt: 'make it dusk' })
  )
  board = connectBoardNodes(board, 'src', 'gen')
  assert.deepEqual(boardInputAssetIds(board, 'gen'), ['asset-1'])
  assert.equal(incomingBoardRefs(board, 'gen')[0].role, 'reference')
  assert.equal(canConnectNodes(board, 'gen', 'src'), false)
  const cycled = connectBoardNodes(board, 'gen', 'src')
  assert.equal(cycled.edges.length, 1)
})

test('job results fill a generate node or land as new image cards', () => {
  let board = emptyBoard()
  board = addBoardNode(
    board,
    createBoardNode('generate', { x: 20, y: 20 }, [], { id: 'slot', prompt: 'a lantern' })
  )
  board = applyJobToBoard(board, {
    nodeId: 'slot',
    jobId: 'job-1',
    prompt: 'a lantern',
    status: 'succeeded',
    outputs: [{ assetId: 'out-1' }, { assetId: 'out-2' }],
  })
  const filled = board.nodes.find(node => node.id === 'slot')
  assert.equal(filled?.kind, 'image')
  assert.equal(filled?.assetId, 'out-1')
  assert.equal(board.nodes.filter(node => node.assetId === 'out-2').length, 1)
})

test('seeding an existing asset focuses it instead of duplicating', () => {
  let board = seedAssetOnBoard(emptyBoard(), 'asset-9', { x: 10, y: 10 })
  const again = seedAssetOnBoard(board, 'asset-9', { x: 400, y: 10 })
  assert.equal(again.nodes.filter(node => node.assetId === 'asset-9').length, 1)
})

test('selection, move, duplicate and delete keep the graph intact', () => {
  let board = emptyBoard()
  board = addBoardNode(board, createBoardNode('text', { x: 0, y: 0 }, [], { id: 'a', text: 'note' }))
  board = addBoardNode(board, createBoardNode('image', { x: 200, y: 0 }, board.nodes, { id: 'b' }))
  board = connectBoardNodes(board, 'a', 'b')
  board = moveBoardNodes(board, ['a'], { x: 12, y: 8 })
  assert.equal(board.nodes.find(node => node.id === 'a')?.x, 12)
  board = duplicateBoardNodes(board, ['a', 'b'])
  assert.equal(board.nodes.length, 4)
  assert.equal(board.edges.length, 2)
  board = deleteBoardNodes(board, ['a'])
  assert.equal(board.nodes.some(node => node.id === 'a'), false)
  assert.equal(board.edges.some(edge => edge.from === 'a' || edge.to === 'a'), false)
  assert.deepEqual(toggleBoardSelection(['a'], 'b', false), ['b'])
  assert.deepEqual(nodesInRect(board.nodes, { x: -10, y: -10, width: 80, height: 80 }).length >= 0, true)
})

test('normalize drops unknown kinds and broken edges', () => {
  const board = normalizeBoard({
    viewport: { x: 1, y: 2, scale: 99 },
    nodes: [
      { id: 'ok', kind: 'image', x: 0, y: 0, width: 100, height: 100, assetId: 'a' },
      { id: 'bad', kind: 'video', x: 0, y: 0, width: 10, height: 10 },
    ],
    edges: [
      { id: 'e1', from: 'ok', to: 'missing', role: 'reference' },
      { id: 'e2', from: 'ok', to: 'ok', role: 'reference' },
    ],
  })
  assert.equal(board.viewport.scale, 3)
  assert.equal(board.nodes.length, 1)
  assert.equal(board.edges.length, 0)
})

test('connected text nodes become part of the generate prompt', () => {
  let board = emptyBoard()
  board = addBoardNode(board, createBoardNode('text', { x: 0, y: 0 }, [], { id: 'note', text: 'keep the lantern' }))
  board = addBoardNode(
    board,
    createBoardNode('generate', { x: 300, y: 0 }, board.nodes, { id: 'gen', prompt: 'night street' })
  )
  board = connectBoardNodes(board, 'note', 'gen')
  assert.equal(collectBoardPrompt(board, 'gen'), 'night street\nkeep the lantern')
})

test('generate cards can chain when the link would not cycle', () => {
  let board = emptyBoard()
  board = addBoardNode(board, createBoardNode('generate', { x: 0, y: 0 }, [], { id: 'a', prompt: 'first' }))
  board = addBoardNode(board, createBoardNode('generate', { x: 360, y: 0 }, board.nodes, { id: 'b' }))
  assert.equal(canConnectNodes(board, 'a', 'b'), true)
  board = connectBoardNodes(board, 'a', 'b')
  assert.equal(board.edges.length, 1)
  assert.equal(canConnectNodes(board, 'b', 'a'), false)
})

test('inserting a node on an edge splits the wire and keeps upstream text', () => {
  let board = emptyBoard()
  board = addBoardNode(board, createBoardNode('text', { x: 0, y: 0 }, [], { id: 'note', text: 'summer cover' }))
  board = addBoardNode(board, createBoardNode('generate', { x: 420, y: 0 }, board.nodes, { id: 'slot' }))
  board = connectBoardNodes(board, 'note', 'slot')
  const edgeId = board.edges[0].id
  const inserted = insertNodeOnEdge(board, edgeId, 'generate', { id: 'mid' })
  assert.ok(inserted)
  board = inserted.board
  assert.equal(board.nodes.some(node => node.id === 'mid'), true)
  assert.equal(board.edges.some(edge => edge.from === 'note' && edge.to === 'slot'), false)
  assert.equal(board.edges.some(edge => edge.from === 'note' && edge.to === 'mid'), true)
  assert.equal(board.edges.some(edge => edge.from === 'mid' && edge.to === 'slot'), true)
  assert.match(collectBoardPrompt(board, 'slot'), /summer cover/)
  assert.equal(insertNodeOnEdge(board, 'missing', 'generate'), null)
})

test('incoming spawn and text insert keep the target connected', () => {
  let board = emptyBoard()
  board = addBoardNode(board, createBoardNode('generate', { x: 400, y: 0 }, [], { id: 'slot' }))
  const incoming = spawnConnectedNode(board, 'slot', 'text', { x: 0, y: 0 }, 'reference', 'in')
  assert.ok(incoming)
  assert.equal(incoming.board.edges.some(edge => edge.from === incoming.node.id && edge.to === 'slot'), true)
  board = incoming.board
  board = addBoardNode(board, createBoardNode('image', { x: 0, y: 200 }, board.nodes, { id: 'src', assetId: 'a1' }))
  board = connectBoardNodes(board, 'src', 'slot')
  const edgeId = board.edges.find(edge => edge.from === 'src' && edge.to === 'slot')?.id as string
  const note = insertNodeOnEdge(board, edgeId, 'text', { id: 'copy', text: 'keep the product' })
  assert.ok(note)
  assert.equal(note.board.edges.some(edge => edge.from === 'src' && edge.to === 'slot'), true)
  assert.equal(note.board.edges.some(edge => edge.from === 'copy' && edge.to === 'slot'), true)
})

test('alignment snap pulls a node onto a neighbor edge', () => {
  const snapped = snapNodeMove(
    { x: 0, y: 0, width: 100, height: 80 },
    { x: 203, y: 12 },
    [{ x: 200, y: 100, width: 80, height: 80 }],
    1
  )
  assert.equal(snapped.point.x, 200)
  assert.ok(snapped.guides.some(guide => guide.axis === 'vertical'))
})

test('edges can be deleted without removing nodes', () => {
  let board = emptyBoard()
  board = addBoardNode(board, createBoardNode('image', { x: 0, y: 0 }, [], { id: 'a', assetId: 'x' }))
  board = addBoardNode(board, createBoardNode('generate', { x: 300, y: 0 }, board.nodes, { id: 'b' }))
  board = connectBoardNodes(board, 'a', 'b')
  const edgeId = board.edges[0].id
  board = deleteBoardEdge(board, edgeId)
  assert.equal(board.edges.length, 0)
  assert.equal(board.nodes.length, 2)
})

test('connection hit testing and send-to-back change stacking', () => {
  const from = { x: 0, y: 0, width: 100, height: 80 }
  const to = { x: 240, y: 0, width: 100, height: 80 }
  assert.equal(hitTestConnection(from, to, { x: 170, y: 40 }, 12), true)
  assert.equal(hitTestConnection(from, to, { x: 170, y: 200 }, 8), false)
  let board = emptyBoard()
  board = addBoardNode(board, createBoardNode('image', { x: 0, y: 0 }, [], { id: 'front' }))
  board = addBoardNode(board, createBoardNode('image', { x: 40, y: 0 }, board.nodes, { id: 'back' }))
  board = sendBoardNodesToBack(board, ['back'])
  assert.equal(board.nodes[0].id, 'back')
})

test('iterate from an image creates a linked generate card', () => {
  let board = emptyBoard()
  board = addBoardNode(
    board,
    createBoardNode('image', { x: 0, y: 0 }, [], { id: 'src', assetId: 'a1', prompt: 'a lantern' })
  )
  const result = iterateFromImage(board, 'src')
  assert.ok(result)
  assert.equal(result.node.kind, 'generate')
  assert.equal(result.node.prompt, 'a lantern')
  assert.equal(result.board.edges[0].from, 'src')
  assert.equal(result.board.edges[0].to, result.node.id)
  assert.equal(iterateFromImage(board, 'missing'), null)
})

test('edge auto-pan and drag threshold keep gestures from misfiring', () => {
  assert.ok(edgeAutoPan({ x: 4, y: 200 }, { width: 800, height: 400 }).x > 0)
  assert.deepEqual(edgeAutoPan({ x: 400, y: 200 }, { width: 800, height: 400 }), { x: 0, y: 0 })
  assert.equal(dragExceededThreshold({ x: 0, y: 0 }, { x: 3, y: 2 }), false)
  assert.equal(dragExceededThreshold({ x: 0, y: 0 }, { x: 10, y: 0 }), true)
})

test('center viewport puts a node in the middle of the stage', () => {
  const viewport = centerViewportOn({ x: 100, y: 40, width: 200, height: 120 }, { width: 800, height: 600 }, 1)
  assert.equal(viewport.x, 200)
  assert.equal(viewport.y, 200)
})

test('fit viewport keeps the board inside the stage', () => {
  const viewport = fitViewport(
    [{ x: 0, y: 0, width: 400, height: 200 }],
    { width: 800, height: 600 },
    0
  )
  assert.ok(viewport.scale <= 2)
  assert.ok(viewport.scale >= 0.15)
})

test('groups, align and mask edges stay on the graph', () => {
  let board = emptyBoard()
  board = addBoardNode(board, createBoardNode('image', { x: 0, y: 40 }, [], { id: 'a', assetId: 'src' }))
  board = addBoardNode(board, createBoardNode('generate', { x: 300, y: 0 }, board.nodes, { id: 'b' }))
  board = addBoardNode(board, createBoardNode('generate', { x: 300, y: 260 }, board.nodes, { id: 'c' }))
  const grouped = groupBoardNodes(board, ['a', 'b', 'c'], 'Set')
  assert.ok(grouped)
  board = grouped.board
  assert.equal(board.groups.length, 1)
  board = alignBoardNodes(board, ['b', 'c'], 'left')
  assert.equal(board.nodes.find(node => node.id === 'b')?.x, board.nodes.find(node => node.id === 'c')?.x)
  board = connectBoardNodes(board, 'a', 'b', 'mask')
  assert.equal(board.edges[0].role, 'mask')
  board = toggleBoardEdgeRole(board, board.edges[0].id)
  assert.equal(board.edges[0].role, 'reference')
})

test('mentions, polish and recipes keep prompts portable', () => {
  let board = emptyBoard()
  board = addBoardNode(board, createBoardNode('image', { x: 0, y: 0 }, [], { id: 'face', assetId: 'a1', title: 'Hero' }))
  board = addBoardNode(
    board,
    createBoardNode('generate', { x: 320, y: 0 }, board.nodes, {
      id: 'gen',
      prompt: insertBoardMention('poster', 'face'),
    })
  )
  assert.deepEqual(extractMentionIds(board.nodes[1].prompt || ''), ['face'])
  assert.match(collectBoardPrompt(board, 'gen'), /Hero/)
  assert.ok(polishBoardPrompt('电商海报', 'zh').includes('主体清晰'))
  assert.ok(polishBoardPrompt('灯笼', 'zh', 'product').includes('商品主体完整'))
  assert.ok(polishBoardPrompt('灯笼', 'zh', 'poster', 'short').includes('主体清晰'))
  const recipe = exportBoardRecipe(board, ['face', 'gen'])
  assert.equal(recipe.nodes.find(node => node.id === 'face')?.assetId, undefined)
  const imported = importBoardRecipe(emptyBoard(), recipe, { x: 10, y: 10 })
  assert.equal(imported.nodeIds.length, 2)
  assert.equal(imported.board.edges.length, 0)
})

test('templates, grid split and variant layout create a usable set', () => {
  let board = applyBoardTemplate(emptyBoard(), 'product-set').board
  assert.ok(board.nodes.length >= 6)
  const product = board.nodes.find(node => node.kind === 'image')
  assert.ok(product)
  const split = gridSplitFromNode(board, product.id, 2, 2)
  assert.ok(split)
  assert.equal(split.nodeIds.length, 4)
  board = split.board
  board = layoutVariantTree(board, product.id)
  const child = board.nodes.find(node => node.id === split.nodeIds[0])
  assert.ok((child?.y || 0) > product.y)
  assert.deepEqual(snapOutputSize(1000, 500), { width: 1008, height: 496 })
  board = updateBoardNode(board, product.id, { assetId: 'product-1' })
  const spawned = spawnConnectedNode(board, product.id, 'generate', { x: 40, y: 40 }, 'mask')
  assert.ok(spawned)
  assert.equal(spawned.board.edges.some(edge => edge.role === 'mask'), true)
  assert.deepEqual(selectedAssetIds(board, [product.id]), ['product-1'])
})
