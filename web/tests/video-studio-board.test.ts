import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BOARD_TEMPLATE_IDS,
  VIDEO_BOARD_EDGE_ROLES,
  VIDEO_BOARD_NODE_KINDS,
  addVideoBoardNode,
  applyVideoJobToBoard,
  bringVideoBoardNodesToFront,
  canConnectVideoNodes,
  centerViewportOn,
  collectVideoNodePrompt,
  connectVideoBoardNodes,
  createVideoBoardNode,
  deleteVideoBoardNodes,
  dragExceededThreshold,
  duplicateVideoBoardNodes,
  emptyVideoBoard,
  fitViewport,
  focusViewportOnNode,
  incomingVideoRefs,
  instantiateBoardTemplate,
  moveVideoBoardNodes,
  normalizeVideoBoard,
  seedVideoAssetOnBoard,
  toggleVideoBoardSelection,
  videoInputSpecs,
  zoomViewportAt,
} from '../lib/video-studio/board-logic'

test('empty board and template ids', () => {
  const board = emptyVideoBoard()
  assert.equal(board.version, 1)
  assert.equal(board.revision, 0)
  assert.deepEqual(board.nodes, [])
  assert.deepEqual(board.edges, [])
  assert.deepEqual(BOARD_TEMPLATE_IDS, [
    'shot-i2v',
    'first-last',
    'storyboard-6',
    'character-episode',
    'extend-chain',
    'character-card',
    'vertical-series',
    'product-triptych',
    'talking-head',
    'text-to-video',
    'compare-ab',
    'tutorial-steps',
    'grid-nine',
  ])
})

test('viewport zoom keeps the cursor world point stable', () => {
  const viewport = { x: 0, y: 0, scale: 1 }
  const zoomed = zoomViewportAt(viewport, { x: 200, y: 100 }, 2)
  assert.equal(zoomed.scale, 2)
  // World point under (200,100) before: (200,100). After zoom it must map back.
  const worldBefore = { x: (200 - viewport.x) / viewport.scale, y: (100 - viewport.y) / viewport.scale }
  const worldAfter = { x: (200 - zoomed.x) / zoomed.scale, y: (100 - zoomed.y) / zoomed.scale }
  assert.ok(Math.abs(worldBefore.x - worldAfter.x) < 1e-9)
  assert.ok(Math.abs(worldBefore.y - worldAfter.y) < 1e-9)
  assert.equal(zoomViewportAt(viewport, { x: 0, y: 0 }, 99).scale, 3)
  assert.equal(zoomViewportAt(viewport, { x: 0, y: 0 }, 0.01).scale, 0.15)
})

test('center and fit viewport cover content', () => {
  const centered = centerViewportOn({ x: 0, y: 0, width: 100, height: 100 }, { width: 1000, height: 600 }, 1)
  assert.equal(centered.x, 450)
  assert.equal(centered.y, 250)
  const fitted = fitViewport(
    [
      { x: 0, y: 0, width: 2000, height: 1000 },
      { x: 100, y: 100, width: 100, height: 100 },
    ],
    { width: 1000, height: 600 }
  )
  assert.ok(fitted.scale > 0.15 && fitted.scale < 1)
})

test('connections reject cycles, duplicates and invalid role kinds', () => {
  let board = emptyVideoBoard()
  const image = createVideoBoardNode('image', { x: 0, y: 0 }, board.nodes, { id: 'img', assetId: 'a1' })
  board = addVideoBoardNode(board, image)
  const last = createVideoBoardNode('image', { x: 0, y: 400 }, board.nodes, { id: 'last', assetId: 'a2' })
  board = addVideoBoardNode(board, last)
  const clip = createVideoBoardNode('video', { x: 0, y: 800 }, board.nodes, { id: 'clip', assetId: 'a3' })
  board = addVideoBoardNode(board, clip)
  const gen = createVideoBoardNode('generate', { x: 400, y: 0 }, board.nodes, { id: 'gen' })
  board = addVideoBoardNode(board, gen)

  board = connectVideoBoardNodes(board, 'img', 'gen', 'first-frame')
  board = connectVideoBoardNodes(board, 'last', 'gen', 'last-frame')
  board = connectVideoBoardNodes(board, 'clip', 'gen', 'continue-from')
  assert.equal(board.edges.length, 3)

  // Duplicate pair rejected.
  assert.equal(connectVideoBoardNodes(board, 'img', 'gen', 'reference').edges.length, 3)
  // Self loop rejected.
  assert.equal(canConnectVideoNodes(board, 'gen', 'gen'), false)
  // Frame roles require image sources.
  assert.equal(canConnectVideoNodes(board, 'clip', 'gen', 'first-frame'), false)
  // continue-from requires a video source.
  assert.equal(canConnectVideoNodes(board, 'img', 'gen', 'continue-from'), false)
  // audio role requires an audio node.
  assert.equal(canConnectVideoNodes(board, 'img', 'gen', 'audio'), false)
  // Text nodes cannot receive edges; generate→generate rejected.
  const note = createVideoBoardNode('text', { x: 800, y: 0 }, board.nodes, { id: 'note' })
  board = addVideoBoardNode(board, note)
  assert.equal(canConnectVideoNodes(board, 'gen', 'note'), false)
  assert.equal(canConnectVideoNodes(board, 'gen', 'gen'), false)
  // A cycle (gen feeding back into an upstream node) is rejected.
  assert.equal(canConnectVideoNodes(board, 'gen', 'img'), false)
})

test('videoInputSpecs preserve edge creation order with roles', () => {
  let board = emptyVideoBoard()
  const image = createVideoBoardNode('image', { x: 0, y: 0 }, [], { id: 'img', assetId: 'a1' })
  board = addVideoBoardNode(board, image)
  const note = createVideoBoardNode('text', { x: 0, y: 400 }, board.nodes, { id: 'note', text: 'hero in red coat' })
  board = addVideoBoardNode(board, note)
  const audio = createVideoBoardNode('audio', { x: 0, y: 600 }, board.nodes, { id: 'aud', assetId: 'a2' })
  board = addVideoBoardNode(board, audio)
  const gen = createVideoBoardNode('generate', { x: 400, y: 0 }, board.nodes, { id: 'gen', prompt: 'walks north' })
  board = addVideoBoardNode(board, gen)
  board = connectVideoBoardNodes(board, 'note', 'gen')
  board = connectVideoBoardNodes(board, 'img', 'gen', 'first-frame')
  board = connectVideoBoardNodes(board, 'aud', 'gen', 'audio')

  assert.deepEqual(videoInputSpecs(board, 'gen'), [
    { assetId: 'a1', role: 'first-frame' },
    { assetId: 'a2', role: 'audio' },
  ])
  assert.equal(collectVideoNodePrompt(board, 'gen'), 'walks north\nhero in red coat')
  assert.equal(incomingVideoRefs(board, 'gen').length, 3)
})

test('applyVideoJobToBoard fills the node and adopts orphan jobs', () => {
  let board = emptyVideoBoard()
  const gen = createVideoBoardNode('generate', { x: 0, y: 0 }, [], { id: 'gen', prompt: 'p' })
  board = addVideoBoardNode(board, gen)
  board = applyVideoJobToBoard(board, {
    nodeId: 'gen',
    jobId: 'job-1',
    status: 'succeeded',
    outputAssetId: 'out-1',
    duration: 8,
  })
  const node = board.nodes.find(item => item.id === 'gen')
  assert.equal(node?.status, 'succeeded')
  assert.equal(node?.outputAssetId, 'out-1')
  assert.equal(node?.duration, 8)

  const orphan = applyVideoJobToBoard(board, {
    jobId: 'job-2',
    status: 'succeeded',
    prompt: 'late',
    outputAssetId: 'out-2',
  })
  const attached = orphan.nodes.find(item => item.jobId === 'job-2')
  assert.equal(attached?.kind, 'generate')
  assert.equal(attached?.prompt, 'late')
})

test('seed dedupes by asset id and delete cascades edges', () => {
  let board = emptyVideoBoard()
  board = seedVideoAssetOnBoard(board, { id: 'a1', kind: 'image', filename: 'f.png' })
  board = seedVideoAssetOnBoard(board, { id: 'a1', kind: 'image', filename: 'f.png' })
  assert.equal(board.nodes.length, 1)
  const gen = createVideoBoardNode('generate', { x: 400, y: 0 }, board.nodes, { id: 'gen' })
  board = addVideoBoardNode(board, gen)
  board = connectVideoBoardNodes(board, board.nodes[0].id, 'gen')
  board = deleteVideoBoardNodes(board, [board.nodes[0].id])
  assert.equal(board.nodes.length, 1)
  assert.equal(board.edges.length, 0)
})

test('move, duplicate, z-order and selection toggles', () => {
  let board = emptyVideoBoard()
  const a = createVideoBoardNode('text', { x: 0, y: 0 }, [], { id: 'a' })
  board = addVideoBoardNode(board, a)
  const b = createVideoBoardNode('text', { x: 400, y: 0 }, board.nodes, { id: 'b' })
  board = addVideoBoardNode(board, b)
  board = moveVideoBoardNodes(board, ['a'], { x: 10, y: -5 })
  assert.equal(board.nodes[0].x, 10)
  assert.equal(board.nodes[0].y, -5)
  board = bringVideoBoardNodesToFront(board, ['a'])
  assert.equal(board.nodes[board.nodes.length - 1].id, 'a')
  const duplicated = duplicateVideoBoardNodes(board, ['a'])
  assert.equal(duplicated.nodes.length, 3)
  assert.deepEqual(toggleVideoBoardSelection(['a'], 'a', false), ['a'])
  assert.deepEqual(toggleVideoBoardSelection([], 'a', false), ['a'])
  assert.deepEqual(toggleVideoBoardSelection(['a'], 'b', true), ['a', 'b'])
})

test('normalizeVideoBoard drops unknown kinds, orphan edges and caps', () => {
  const board = normalizeVideoBoard({
    revision: 'x',
    viewport: { x: 1, y: 2, scale: 9 },
    nodes: [
      { id: 'n1', kind: 'text', x: 0, y: 0, text: 'hello' },
      { id: 'n2', kind: 'timetrack', x: 0, y: 0 },
      { id: 'n3', kind: 'image', x: 5, y: 5, assetId: 'a1' },
      { id: 'n1', kind: 'text', x: 9, y: 9 },
      { id: 'n4', kind: 'video', y: 1 },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n3' },
      { id: 'e2', from: 'n1', to: 'missing' },
      { id: 'e3', from: 'n3', to: 'n3' },
    ],
    groups: [{ id: 'g1', title: 'G' }],
  })
  assert.equal(board.revision, 0)
  assert.equal(board.viewport.scale, 3)
  assert.deepEqual(board.nodes.map(node => node.id), ['n1', 'n3'])
  assert.equal(board.nodes[1].assetId, 'a1')
  assert.equal(board.edges.length, 1)
  assert.deepEqual(board.groups, [])
})

test('C4 camera field survives normalize (trim, 64 cap) and duplication', () => {
  const long = 'pan-' + 'z'.repeat(80)
  const board = normalizeVideoBoard({
    nodes: [
      { id: 'g1', kind: 'generate', x: 0, y: 0, prompt: 'push in', camera: ' push ' },
      { id: 'g2', kind: 'generate', x: 400, y: 0, prompt: 'long', camera: long },
      { id: 'g3', kind: 'generate', x: 800, y: 0, prompt: 'bare', camera: '   ' },
      { id: 'g4', kind: 'generate', x: 1200, y: 0, prompt: 'none' },
      { id: 't1', kind: 'text', x: 0, y: 400, text: 'note', camera: 'inert on text' },
    ],
  })
  assert.equal(board.nodes[0].camera, 'push')
  assert.equal(board.nodes[1].camera, long.slice(0, 64))
  assert.equal(board.nodes[2].camera, undefined)
  assert.equal(board.nodes[3].camera, undefined)
  // Unrestricted like every other whitelisted string field; only the generate
  // card renders the badge.
  assert.equal(board.nodes[4].camera, 'inert on text')

  const duplicated = duplicateVideoBoardNodes(board, ['g1'])
  const clone = duplicated.nodes.find(node => node.id !== 'g1' && node.prompt === 'push in')
  assert.ok(clone)
  assert.equal(clone.camera, 'push')
})

test('storyboardShotId survives normalize so agent generate can refill the card', () => {
  const board = normalizeVideoBoard({
    nodes: [
      {
        id: 'g1',
        kind: 'generate',
        x: 0,
        y: 0,
        prompt: 'rooftop',
        storyboardShotId: ' shot_abc ',
      },
    ],
  })
  assert.equal(board.nodes[0].storyboardShotId, 'shot_abc')
})

test('focus viewport centers on the requested node', () => {
  let board = emptyVideoBoard()
  const node = createVideoBoardNode('generate', { x: 1000, y: 500 }, [], { id: 'gen' })
  board = addVideoBoardNode(board, node)
  const viewport = focusViewportOnNode(board, 'gen', { width: 1000, height: 600 })
  assert.ok(viewport)
  const centerX = (viewport as { x: number }).x + 1000 + 160
  assert.ok(Math.abs(centerX - 500) < 1)
  const centerY = (viewport as { y: number }).y + 500 + 146
  assert.ok(Math.abs(centerY - 300) < 1)
  assert.equal(focusViewportOnNode(board, 'missing', { width: 100, height: 100 }), null)
})

test('drag threshold guards accidental moves', () => {
  const start = { x: 0, y: 0 }
  assert.equal(dragExceededThreshold(start, { x: 3, y: 3 }), false)
  assert.equal(dragExceededThreshold(start, { x: 9, y: 9 }), true)
})

test('node kinds and edge roles are closed sets', () => {
  assert.deepEqual([...VIDEO_BOARD_NODE_KINDS], ['text', 'image', 'video', 'audio', 'generate'])
  assert.deepEqual([...VIDEO_BOARD_EDGE_ROLES], [
    'reference',
    'first-frame',
    'last-frame',
    'audio',
    'continue-from',
  ])
})

test('templates produce expected node and edge counts', () => {
  const shot = instantiateBoardTemplate('shot-i2v')
  assert.equal(shot.nodes.length, 2)
  assert.equal(shot.edges.length, 1)
  assert.equal(shot.edges[0].role, 'first-frame')
  assert.equal(shot.nodes[1].kind, 'generate')
  assert.equal(shot.nodes[1].operation, 'image_to_video')

  const firstLast = instantiateBoardTemplate('first-last')
  assert.equal(firstLast.nodes.length, 3)
  assert.equal(firstLast.edges.length, 2)
  assert.deepEqual(
    firstLast.edges.map(edge => edge.role).sort(),
    ['first-frame', 'last-frame']
  )

  const grid = instantiateBoardTemplate('storyboard-6')
  assert.equal(grid.nodes.length, 7)
  assert.equal(grid.edges.length, 6)
  assert.equal(grid.nodes[0].kind, 'text')
  assert.ok(grid.edges.every(edge => edge.role === 'reference'))
  assert.ok(grid.edges.every(edge => edge.from === grid.nodes[0].id))

  const episode = instantiateBoardTemplate('character-episode')
  assert.equal(episode.nodes.length, 6)
  assert.equal(episode.edges.length, 8)
  assert.deepEqual(
    episode.edges.map(edge => edge.role).sort(),
    ['first-frame', 'first-frame', 'first-frame', 'first-frame', 'reference', 'reference', 'reference', 'reference']
  )

  const chain = instantiateBoardTemplate('extend-chain')
  assert.equal(chain.nodes.length, 2)
  assert.equal(chain.edges.length, 1)
  assert.equal(chain.edges[0].role, 'continue-from')
  assert.equal(chain.nodes[1].operation, 'extend')

  // §Phase B1 character-card: name note + reference + three-view sheet feed
  // four generate cards sharing the three-view as reference.
  const characterCard = instantiateBoardTemplate('character-card')
  assert.equal(characterCard.nodes.length, 7)
  assert.equal(characterCard.edges.length, 4)
  assert.equal(characterCard.nodes[0].kind, 'text')
  assert.equal(characterCard.nodes[1].kind, 'image')
  assert.equal(characterCard.nodes[2].kind, 'image')
  assert.ok(characterCard.nodes.slice(3).every(node => node.kind === 'generate'))
  assert.ok(characterCard.edges.every(edge => edge.role === 'reference'))
  assert.ok(characterCard.edges.every(edge => edge.from === characterCard.nodes[2].id))
  assert.deepEqual(
    characterCard.edges.map(edge => edge.to).sort(),
    characterCard.nodes.slice(3).map(node => node.id).sort()
  )

  for (const template of [shot, firstLast, grid, episode, chain, characterCard]) {
    // Templates only place nodes — never job state.
    assert.ok(template.nodes.every(node => !node.jobId && !node.status && !node.modelKey))
    assert.ok(new Set(template.nodes.map(node => node.id)).size === template.nodes.length)
    assert.ok(new Set(template.edges.map(edge => edge.id)).size === template.edges.length)
  }

  // Layout parity with the backend table (origin-relative coordinates).
  assert.deepEqual(
    shot.nodes.map(node => [node.kind, node.x, node.y]),
    [['image', 0, 0], ['generate', 400, 0]]
  )
  assert.deepEqual(
    firstLast.nodes.map(node => [node.kind, node.x, node.y]),
    [['image', 0, 0], ['image', 0, 344], ['generate', 400, 0]]
  )
  assert.deepEqual(
    grid.nodes.map(node => [node.kind, node.x, node.y]),
    [
      ['text', 0, 0],
      ['generate', 304, 0],
      ['generate', 688, 0],
      ['generate', 1072, 0],
      ['generate', 1456, 0],
      ['generate', 1840, 0],
      ['generate', 2224, 0],
    ]
  )
  assert.deepEqual(
    episode.nodes.map(node => [node.kind, node.x, node.y]),
    [
      ['text', 0, 0],
      ['image', 0, 204],
      ['generate', 400, 0],
      ['generate', 784, 0],
      ['generate', 400, 356],
      ['generate', 784, 356],
    ]
  )
  assert.deepEqual(
    chain.nodes.map(node => [node.kind, node.x, node.y]),
    [['video', 0, 0], ['generate', 400, 0]]
  )
  assert.deepEqual(
    characterCard.nodes.map(node => [node.kind, node.x, node.y]),
    [
      ['text', 0, 0],
      ['image', 0, 204],
      ['image', 0, 548],
      ['generate', 400, 0],
      ['generate', 400, 356],
      ['generate', 400, 712],
      ['generate', 400, 1068],
    ]
  )

  // An explicit origin shifts every node by the same offset.
  const shifted = instantiateBoardTemplate('character-episode', { x: 100, y: 40 })
  assert.equal(shifted.nodes[0].x, 100)
  assert.equal(shifted.nodes[0].y, 40)
  assert.equal(shifted.nodes[4].x, 500)
  assert.equal(shifted.nodes[4].y, 396)

  // Every template id produces a fragment and ids stay unique across calls.
  const fragments = BOARD_TEMPLATE_IDS.map(id => instantiateBoardTemplate(id))
  const allIds = fragments.flatMap(fragment => [
    ...fragment.nodes.map(node => node.id),
    ...fragment.edges.map(edge => edge.id),
  ])
  assert.equal(new Set(allIds).size, allIds.length)
})

test('§Phase F3 template layout table mirrors the backend board.py', () => {
  const vertical = instantiateBoardTemplate('vertical-series')
  assert.deepEqual(
    vertical.nodes.map(node => [node.kind, node.x, node.y]),
    [
      ['text', 0, 0],
      ['generate', 304, 0],
      ['generate', 688, 0],
      ['generate', 1072, 0],
      ['generate', 1456, 0],
      ['generate', 1840, 0],
      ['generate', 2224, 0],
    ]
  )
  assert.ok(vertical.nodes.slice(1).every(node => node.ratio === '9:16'))
  assert.ok(vertical.edges.every(edge => edge.role === 'reference'))

  const product = instantiateBoardTemplate('product-triptych')
  assert.deepEqual(
    product.nodes.map(node => [node.kind, node.x, node.y]),
    [
      ['image', 0, 0],
      ['generate', 400, 0],
      ['generate', 400, 356],
      ['generate', 400, 712],
    ]
  )
  assert.ok(product.edges.every(edge => edge.role === 'first-frame'))
  assert.ok(product.edges.every(edge => edge.from === product.nodes[0].id))

  const talking = instantiateBoardTemplate('talking-head')
  assert.deepEqual(
    talking.nodes.map(node => [node.kind, node.x, node.y]),
    [
      ['image', 0, 0],
      ['text', 0, 344],
      ['generate', 400, 0],
    ]
  )
  assert.deepEqual(
    talking.edges.map(edge => edge.role).sort(),
    ['first-frame', 'reference']
  )

  const narration = instantiateBoardTemplate('text-to-video')
  assert.deepEqual(
    narration.nodes.map(node => [node.kind, node.x, node.y]),
    [
      ['text', 0, 0],
      ['generate', 304, 0],
      ['generate', 688, 0],
      ['generate', 1072, 0],
      ['generate', 1456, 0],
    ]
  )
  assert.equal(narration.edges.length, 4)

  const compare = instantiateBoardTemplate('compare-ab')
  assert.deepEqual(
    compare.nodes.map(node => [node.kind, node.x, node.y]),
    [
      ['image', 0, 0],
      ['generate', 400, 0],
      ['generate', 400, 356],
    ]
  )
  assert.ok(compare.edges.every(edge => edge.role === 'first-frame'))

  const tutorial = instantiateBoardTemplate('tutorial-steps')
  assert.deepEqual(
    tutorial.nodes.map(node => [node.kind, node.x, node.y]),
    [
      ['text', 0, 0],
      ['video', 0, 204],
      ['generate', 400, 0],
      ['generate', 400, 356],
    ]
  )
  assert.ok(tutorial.nodes.slice(2).every(node => node.operation === 'extend'))
  assert.deepEqual(
    tutorial.edges.map(edge => edge.role).sort(),
    ['continue-from', 'reference']
  )

  const grid = instantiateBoardTemplate('grid-nine')
  const generateNodes = grid.nodes.filter(node => node.kind === 'generate')
  assert.equal(generateNodes.length, 9)
  assert.equal(grid.edges.length, 9)
  assert.deepEqual(new Set(generateNodes.map(node => node.x)), new Set([304, 688, 1072]))
  assert.deepEqual(new Set(generateNodes.map(node => node.y)), new Set([0, 356, 712]))
})
