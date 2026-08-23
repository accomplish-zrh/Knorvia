import test from 'node:test'
import assert from 'node:assert/strict'

import { followStudioJob } from '../lib/image-studio-api'
import { emptyBoard, normalizeBoard } from '../lib/image-studio/board-logic'

test('board revision survives normalization and defaults to zero', () => {
  assert.equal(emptyBoard().revision, 0)
  assert.equal(normalizeBoard({ ...emptyBoard(), revision: 7 }).revision, 7)
  assert.equal(normalizeBoard({ ...emptyBoard(), revision: -1 }).revision, 0)
})

test('job following rejects immediately when its abort signal is already cancelled', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    followStudioJob('job-1', () => undefined, 0, controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
  )
})
