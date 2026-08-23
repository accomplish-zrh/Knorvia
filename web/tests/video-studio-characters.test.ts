import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendCharacterToVideoInputs,
  characterReferenceAssetIds,
} from '../lib/video-studio/studio-logic'
import { injectCharacterOnBoard } from '../lib/video-studio/character-logic'
import {
  createVideoBoardNode,
  addVideoBoardNode,
  emptyVideoBoard,
} from '../lib/video-studio/board-logic'
import type { VideoAsset, VideoCharacter } from '../lib/video-studio-api'

function character(overrides: Partial<VideoCharacter> = {}): VideoCharacter {
  return {
    id: 'char-1',
    project_id: 'project-1',
    name: '阿澈',
    description: '蓝发少年侦探',
    reference_asset_ids: ['a-ref-1', 'a-ref-2'],
    three_view_asset_id: null,
    voice_hint: 'bright young male',
    created_at: 0,
    updated_at: 0,
    ...overrides,
  }
}

const ASSETS: VideoAsset[] = [
  { id: 'a-ref-1', project_id: 'project-1', kind: 'image', mime_type: 'image/png', filename: 'ref1.png', size_bytes: 10, sha256: 'x', created_at: 0 },
  { id: 'a-ref-2', project_id: 'project-1', kind: 'image', mime_type: 'image/png', filename: 'ref2.png', size_bytes: 10, sha256: 'x', created_at: 0 },
  { id: 'a-three', project_id: 'project-1', kind: 'image', mime_type: 'image/png', filename: 'three.png', size_bytes: 10, sha256: 'x', created_at: 0 },
]

test('characterReferenceAssetIds puts the three-view sheet first and dedupes', () => {
  assert.deepEqual(
    characterReferenceAssetIds(character({ three_view_asset_id: 'a-three' })),
    ['a-three', 'a-ref-1', 'a-ref-2']
  )
  // A reference duplicated with the three-view id collapses.
  assert.deepEqual(
    characterReferenceAssetIds(character({ three_view_asset_id: 'a-ref-1' })),
    ['a-ref-1', 'a-ref-2']
  )
  // No three-view yet: reference order is preserved.
  assert.deepEqual(characterReferenceAssetIds(character()), ['a-ref-1', 'a-ref-2'])
  assert.deepEqual(characterReferenceAssetIds(character({ reference_asset_ids: [] })), [])
})

test('appendCharacterToVideoInputs merges character references and sanitizes', () => {
  const result = appendCharacterToVideoInputs(
    [],
    character({ three_view_asset_id: 'a-three' }),
    ASSETS,
    'image_to_video',
    { operations: ['image_to_video'], max_inputs: { image: 2 } },
    'none'
  )
  // Two-image cap keeps the three-view plus the first reference only.
  assert.deepEqual(result, ['a-three', 'a-ref-1'])

  const all = appendCharacterToVideoInputs(
    ['a-ref-1'],
    character({ three_view_asset_id: 'a-three' }),
    ASSETS,
    'image_to_video',
    { operations: ['image_to_video'], max_inputs: { image: 3 } },
    'none'
  )
  assert.deepEqual(all, ['a-ref-1', 'a-three', 'a-ref-2'])
})

test('injectCharacterOnBoard seeds an image node and wires selected generate cards', () => {
  let board = emptyVideoBoard()
  const generate = createVideoBoardNode('generate', { x: 0, y: 0 }, board.nodes, { id: 'gen-1' })
  board = addVideoBoardNode(board, generate)
  const text = createVideoBoardNode('text', { x: 400, y: 0 }, board.nodes, { id: 'note-1' })
  board = addVideoBoardNode(board, text)

  const { board: next, nodeId } = injectCharacterOnBoard(board, character({ three_view_asset_id: 'a-three' }), ['gen-1', 'note-1'])
  assert.notEqual(next, board)
  assert.ok(nodeId)
  const seeded = next.nodes.find(node => node.id === nodeId)
  assert.ok(seeded)
  assert.equal(seeded.kind, 'image')
  assert.equal(seeded.assetId, 'a-three')
  assert.equal(seeded.title, '阿澈')
  // Only the generate target gets the reference edge — the text note cannot.
  assert.equal(next.edges.length, 1)
  assert.equal(next.edges[0].from, nodeId)
  assert.equal(next.edges[0].to, 'gen-1')
  assert.equal(next.edges[0].role, 'reference')
})

test('injectCharacterOnBoard falls back to the first reference and reuses an existing node', () => {
  let board = emptyVideoBoard()
  const existing = createVideoBoardNode('image', { x: 0, y: 0 }, board.nodes, { id: 'img-1', assetId: 'a-ref-1' })
  board = addVideoBoardNode(board, existing)
  const generate = createVideoBoardNode('generate', { x: 400, y: 0 }, board.nodes, { id: 'gen-1' })
  board = addVideoBoardNode(board, generate)

  const { board: next, nodeId } = injectCharacterOnBoard(board, character(), ['gen-1'])
  assert.equal(nodeId, 'img-1')
  assert.equal(next.nodes.length, board.nodes.length)
  assert.equal(next.edges.length, 1)
  assert.equal(next.edges[0].from, 'img-1')

  // Same call again: the duplicate edge is rejected, board is unchanged.
  const again = injectCharacterOnBoard(next, character(), ['gen-1'])
  assert.equal(again.board, next)
  assert.equal(again.nodeId, 'img-1')
})

test('injectCharacterOnBoard without any asset is a no-op', () => {
  const board = emptyVideoBoard()
  const { board: next, nodeId } = injectCharacterOnBoard(board, character({ reference_asset_ids: [] }), [])
  assert.equal(next, board)
  assert.equal(nodeId, null)
})
