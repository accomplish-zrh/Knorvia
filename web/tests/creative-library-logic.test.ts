import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canSubmitCreate,
  extractLibraryMentions,
  inferCreateMode,
  mentionLibraryAsset,
  parseCustomPixels,
  studioHandoffHref,
  chatHandoffHref,
} from '../lib/creative-library/create-logic'

test('inferCreateMode keeps an explicit image or video choice', () => {
  assert.equal(inferCreateMode('animate this later', 'image'), 'image')
  assert.equal(inferCreateMode('a still portrait', 'video'), 'video')
})

test('inferCreateMode treats last-frame and video words as video', () => {
  assert.equal(inferCreateMode('walk forward', 'agent', { hasLastFrame: true }), 'video')
  assert.equal(inferCreateMode('做一段首帧驱动的视频', 'agent'), 'video')
  assert.equal(inferCreateMode('a quiet product still', 'agent'), 'image')
})

test('create submission requires prompt, model, and frames', () => {
  assert.equal(canSubmitCreate({
    prompt: '',
    mode: 'agent',
    smartPlanning: true,
    modelKey: '',
    firstFrameId: '',
    lastFrameId: '',
  }).ok, false)
  assert.equal(canSubmitCreate({
    prompt: 'a mug',
    mode: 'image',
    smartPlanning: false,
    modelKey: '',
    firstFrameId: '',
    lastFrameId: '',
  }).ok, false)
  assert.deepEqual(
    canSubmitCreate({
      prompt: 'walk',
      mode: 'video',
      smartPlanning: true,
      modelKey: '',
      firstFrameId: '',
      lastFrameId: 'tail',
      referenceMode: 'first-last',
    }),
    { ok: false, reason: 'Add both first-frame and last-frame images.' }
  )
  assert.equal(canSubmitCreate({
    prompt: 'a mug',
    mode: 'image',
    smartPlanning: true,
    modelKey: '',
    firstFrameId: '',
    lastFrameId: '',
  }).ok, true)
})

test('library mentions and handoff urls stay local to Knorvia routes', () => {
  assert.equal(mentionLibraryAsset('', 'asset-1'), '@[asset-1] ')
  assert.deepEqual(extractLibraryMentions('use @[asset-1] and @[asset-2]'), ['asset-1', 'asset-2'])
  assert.equal(
    studioHandoffHref('image', { assetId: 'a1', prompt: 'hello' }),
    '/image-studio?libraryAsset=a1&prompt=hello'
  )
  assert.equal(chatHandoffHref({ assetId: 'a1' }), '/home?library=a1')
  assert.equal(chatHandoffHref({}), '/home')
  assert.equal(parseCustomPixels('1536x1024')?.width, 1536)
})
