import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CANVAS_HISTORY_BYTE_BUDGET,
  canvasHistoryBytes,
  trimCanvasHistory,
} from '../lib/image-studio/canvas-history'

function frame(bytes: number) {
  return { data: { byteLength: bytes } }
}

test('mask history enforces a shared byte budget across undo and redo', () => {
  const undo = [frame(40), frame(40)]
  const redo = [frame(30)]
  trimCanvasHistory([undo, redo], 70)
  assert.ok(canvasHistoryBytes([undo, redo]) <= 70)
})

test('the production mask history ceiling is bounded to one 4K RGBA frame', () => {
  assert.equal(CANVAS_HISTORY_BYTE_BUDGET, 64 * 1024 * 1024)
  const frames = Array.from({ length: 20 }, () => frame(4096 * 4096 * 4))
  trimCanvasHistory([frames])
  assert.equal(frames.length, 1)
})
