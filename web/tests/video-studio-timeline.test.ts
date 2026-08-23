import test from 'node:test'
import assert from 'node:assert/strict'

import type { VideoStoryboardShot } from '../lib/video-studio-api'
import {
  TIMELINE_PLACEHOLDER_MAX,
  TIMELINE_XFADE_SECONDS,
  blockPixelLeft,
  blockPixelWidth,
  fitPxPerSecond,
  overlapForTransition,
  reorderTarget,
  resolveTrimPatch,
  rulerTicks,
  shotSourceDuration,
  shotTrimWindow,
  thumbnailSampleSeconds,
  timelineLayout,
  trimFromDrag,
} from '../lib/video-studio/timeline-logic'

function shot(overrides: Partial<VideoStoryboardShot> = {}): VideoStoryboardShot {
  return {
    id: overrides.id || `shot-${Math.random().toString(36).slice(2, 8)}`,
    order: 0,
    title: '',
    prompt: '',
    input_asset_ids: [],
    job_id: null,
    output_asset_id: null,
    duration: null,
    notes: null,
    transition: null,
    camera: null,
    keyframe_asset_id: null,
    keyframe_prompt: null,
    voiceover_text: null,
    voiceover_asset_id: null,
    voiceover_voice: null,
    ...overrides,
  }
}

test('overlap mirrors post_production.overlap_for_transition', () => {
  assert.equal(overlapForTransition('crossfade', 5, 5), TIMELINE_XFADE_SECONDS)
  assert.equal(overlapForTransition('fade-black', 5, 5), TIMELINE_XFADE_SECONDS)
  assert.equal(overlapForTransition('wipe-left', 5, 5), TIMELINE_XFADE_SECONDS)
  // Hard cuts, custom free text and empty values never overlap.
  assert.equal(overlapForTransition('', 9, 9), 0)
  assert.equal(overlapForTransition('none', 9, 9), 0)
  assert.equal(overlapForTransition('my fancy wipe', 9, 9), 0)
  assert.equal(overlapForTransition(null, 9, 9), 0)
  // A neighbour shorter than the window downgrades to a hard cut.
  assert.equal(overlapForTransition('crossfade', 0.5, 8), 0)
  assert.equal(overlapForTransition('crossfade', 8, 0.5), 0)
})

test('placeholder shots use the engine clamps', () => {
  assert.equal(shotSourceDuration(shot({ keyframe_asset_id: 'k1' })), 5)
  assert.equal(shotSourceDuration(shot({ keyframe_asset_id: 'k1', duration: 2 })), 2)
  assert.equal(shotSourceDuration(shot({ keyframe_asset_id: 'k1', duration: 90 })), TIMELINE_PLACEHOLDER_MAX)
  // Video shots trust their generated duration; naked shots contribute nothing.
  assert.equal(shotSourceDuration(shot({ output_asset_id: 'v1', duration: 8 })), 8)
  assert.equal(shotSourceDuration(shot({ output_asset_id: 'v1' })), null)
  assert.equal(shotSourceDuration(shot({})), null)
})

test('trim windows clamp to the source (effective_trim parity)', () => {
  assert.deepEqual(shotTrimWindow(10, null, null), [0, 10])
  assert.deepEqual(shotTrimWindow(10, 2, 8), [2, 8])
  assert.deepEqual(shotTrimWindow(10, 2, null), [2, 10])
  assert.deepEqual(shotTrimWindow(10, null, 7), [0, 7])
  // Out beyond the source clamps; inverted windows fall back to the tail.
  assert.deepEqual(shotTrimWindow(10, 0, 99), [0, 10])
  assert.deepEqual(shotTrimWindow(10, 8, 2), [8, 10])
  assert.equal(shotTrimWindow(null, 0, 5), null)
})

test('timelineLayout accumulates starts minus transition overlaps', () => {
  const shots = [
    shot({ id: 'a', order: 0, output_asset_id: 'va', duration: 6, transition: 'crossfade' }),
    shot({ id: 'b', order: 1, output_asset_id: 'vb', duration: 4 }),
    shot({ id: 'c', order: 2, output_asset_id: 'vc', duration: 5, transition: 'wipe-left' }),
    shot({ id: 'd', order: 3, keyframe_asset_id: 'kd' }),
  ]
  const { blocks, total } = timelineLayout(shots)
  assert.deepEqual(
    blocks.map(block => [block.start, block.duration, block.overlap]),
    [
      [0, 6, 0.5],   // crossfade into b eats 0.5
      [5.5, 4, 0],   // b has no transition out
      [9.5, 5, 0.5], // wipe into d
      [14, 5, 0],    // keyframe placeholder defaults to 5s
    ]
  )
  // Σ durations − Σ overlaps = 6+4+5+5 − 1 = 19
  assert.equal(Math.round(total * 10) / 10, 19)
  assert.equal(blocks[3].isPlaceholder, true)
  assert.equal(blocks[0].hasVoiceover, false)
})

test('timelineLayout flags caption and voiceover bands', () => {
  const shots = [
    shot({
      id: 'a',
      order: 0,
      output_asset_id: 'va',
      duration: 3,
      voiceover_asset_id: 'vo',
      voiceover_text: 'hello',
    }),
    shot({ id: 'b', order: 1, output_asset_id: 'vb', duration: 3, notes: 'caption text' }),
    shot({ id: 'c', order: 2, output_asset_id: 'vc', duration: 3 }),
  ]
  const { blocks } = timelineLayout(shots)
  assert.deepEqual(
    blocks.map(block => [block.hasVoiceover, block.hasCaption]),
    [[true, true], [false, true], [false, false]]
  )
})

test('ruler ticks pick a step that keeps labels apart', () => {
  // 60s at 40px/s → step must be ≥ 48/40 = 1.2 → 2s ticks.
  const coarse = rulerTicks(60, 40)
  assert.ok(coarse.length >= 30)
  assert.equal(coarse[0].label, '0s')
  assert.equal(coarse[2].label, '4s')
  // Dense zoom widens the step: 60s at 8px/s → 10s ticks (5s would be 40px < 48).
  const wide = rulerTicks(60, 8)
  assert.deepEqual(wide.map(tick => tick.label), ['0s', '10s', '20s', '30s', '40s', '50s', '1:00'])
  assert.deepEqual(rulerTicks(0, 40), [])
})

test('geometry helpers map seconds to pixels', () => {
  const { blocks } = timelineLayout([
    shot({ id: 'a', order: 0, output_asset_id: 'va', duration: 4, trim_in: 1 }),
  ])
  const block = blocks[0]
  assert.equal(block.duration, 3)
  assert.equal(blockPixelLeft(block, 25), 0)
  assert.equal(blockPixelWidth(block, 25), 75)
  // Thumbnail samples the middle of the trimmed window (1 + 1.5).
  assert.equal(thumbnailSampleSeconds(block), 2.5)
  assert.equal(fitPxPerSecond(10, 424), 37.6)
})

test('trim drag resolves clamped patches', () => {
  // Dragging the in-handle 2s right on a 6s source with no prior trim.
  const drag = { kind: 'trim-in' as const, blockIndex: 0, startClientX: 100, startTrim: null }
  assert.equal(trimFromDrag(drag, 2, 6), 2)
  assert.equal(trimFromDrag(drag, -1, 6), 0)
  assert.equal(trimFromDrag(drag, 99, 6), 6)

  // Patch resolution honours the min window and nulls-out natural bounds.
  assert.deepEqual(resolveTrimPatch('trim-in', 2, null, null, 6), { trim_in: 2, trim_out: null })
  assert.deepEqual(resolveTrimPatch('trim-out', 5, 2, null, 6), { trim_in: 2, trim_out: 5 })
  // In cannot pass out − 0.2; out cannot drop under in + 0.2.
  assert.deepEqual(resolveTrimPatch('trim-in', 5.9, null, 4, 6), { trim_in: 3.8, trim_out: 4 })
  assert.deepEqual(resolveTrimPatch('trim-out', 2.5, 3, null, 6), { trim_in: 3, trim_out: 3.2 })
  // Values equal to the natural bounds collapse to unset.
  assert.deepEqual(resolveTrimPatch('trim-in', 0, 0, null, 6), null)
  assert.deepEqual(resolveTrimPatch('trim-out', 6, null, 6, 6), null)
})

test('reorderTarget maps pointer seconds onto a storyboard index', () => {
  const shots = [
    shot({ id: 'a', order: 0, output_asset_id: 'va', duration: 4 }),
    shot({ id: 'b', order: 1, output_asset_id: 'vb', duration: 4 }),
    shot({ id: 'c', order: 2, output_asset_id: 'vc', duration: 4 }),
  ]
  const { blocks } = timelineLayout(shots)
  // splice-remove semantics: `to` is the index after the dragged shot leaves.
  assert.equal(reorderTarget(blocks, 0, 7), 1)  // a past b's midpoint → after b
  assert.equal(reorderTarget(blocks, 2, 3), 1)  // c before b's midpoint → before b
  assert.equal(reorderTarget(blocks, 1, 2), 0)  // b before a's midpoint → first
  // Pointers inside the dragged shot's own span stay put.
  assert.equal(reorderTarget(blocks, 0, 1), null)
  assert.equal(reorderTarget(blocks, 2, 9), null)
  assert.equal(reorderTarget(blocks, 1, 5), null)
  assert.equal(reorderTarget(blocks, -1, 2), null)
})

test('layout skips shots that have neither clip nor keyframe', () => {
  const { blocks, total } = timelineLayout([
    shot({ id: 'a', order: 0, output_asset_id: 'va', duration: 4 }),
    shot({ id: 'pending', order: 1 }),
    shot({ id: 'b', order: 2, output_asset_id: 'vb', duration: 4 }),
  ])
  assert.deepEqual(blocks.map(block => block.shotId), ['a', 'b'])
  assert.equal(total, 8)
})
