import {
  addVideoBoardNode,
  connectVideoBoardNodes,
  createVideoBoardNode,
  nodeRect,
  type VideoBoardDocument,
  type VideoBoardNode,
} from './board-logic'
import type { VideoCharacter } from '../video-studio-api'

/**
 * §Phase B canvas injection: seed the character's primary asset (three-view
 * sheet first, else the first reference upload) as an image node and wire a
 * `reference` edge from it into every selected generate card. With no
 * generate card selected the node still lands on the board — wiring can
 * happen later by hand.
 */
export function injectCharacterOnBoard(
  board: VideoBoardDocument,
  character: VideoCharacter,
  targetNodeIds: string[] = []
): { board: VideoBoardDocument; nodeId: string | null } {
  const primaryAssetId = character.three_view_asset_id || character.reference_asset_ids?.[0] || ''
  if (!primaryAssetId) return { board, nodeId: null }

  const existing = board.nodes.find(node => node.assetId === primaryAssetId)
  let next = board
  let node: VideoBoardNode
  if (existing) {
    node = existing
  } else {
    const point = boardRightOfContent(board)
    node = createVideoBoardNode('image', point, board.nodes.map(nodeRect), {
      assetId: primaryAssetId,
      title: character.name || '',
    })
    next = addVideoBoardNode(board, node)
    if (next === board) return { board, nodeId: null }
  }

  const targets = targetNodeIds
    .map(id => next.nodes.find(item => item.id === id))
    .filter((item): item is VideoBoardNode => item !== undefined && item.kind === 'generate')
  for (const target of targets) {
    next = connectVideoBoardNodes(next, node.id, target.id, 'reference')
  }
  return { board: next, nodeId: node.id }
}

function boardRightOfContent(board: VideoBoardDocument): { x: number; y: number } {
  if (!board.nodes.length) return { x: 0, y: 0 }
  const right = Math.max(...board.nodes.map(node => node.x + node.width))
  return { x: right + 64, y: 0 }
}
