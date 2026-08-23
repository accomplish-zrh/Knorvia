import test from 'node:test'
import assert from 'node:assert/strict'
import { hitTestWire, wireHandles, wirePath } from '../lib/canvas-wires'

test('horizontal neighbors keep a cubic cable through the mid line', () => {
  const from = { x: 0, y: 0, width: 100, height: 80 }
  const to = { x: 240, y: 0, width: 100, height: 80 }
  const path = wirePath(from, to)
  assert.match(path, /^M /)
  assert.match(path, / C /)
  const handles = wireHandles(from, to)
  assert.equal(handles.start.x, 100)
  assert.equal(handles.end.x, 240)
  assert.ok(Math.abs(handles.mid.y - 40) < 1)
  assert.equal(hitTestWire(from, to, { x: 170, y: 40 }, 12), true)
  assert.equal(hitTestWire(from, to, { x: 170, y: 200 }, 8), false)
})

test('stacked nodes pull the curve farther so the cable does not pinch', () => {
  const from = { x: 0, y: 0, width: 120, height: 80 }
  const beside = { x: 280, y: 0, width: 120, height: 80 }
  const below = { x: 0, y: 220, width: 120, height: 80 }
  const horizontal = wireHandles(from, beside)
  const vertical = wireHandles(from, below)
  assert.ok(vertical.bend > horizontal.bend)
  assert.ok(vertical.mid.y > 80)
  assert.ok(vertical.mid.y < 220)
})

test('reverse links keep a rounded loop instead of a kinked S', () => {
  const from = { x: 240, y: 0, width: 100, height: 80 }
  const to = { x: 0, y: 20, width: 100, height: 80 }
  const handles = wireHandles(from, to)
  assert.ok(handles.c1.x > handles.start.x)
  assert.ok(handles.c2.x < handles.end.x)
  assert.ok(handles.bend >= 80)
})
