import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  emptyVideoProduction,
  nextProductionAction,
  stageReady,
  stageWorkbenchView,
} from '../lib/video-studio/production-logic'

const webRoot = process.cwd()
const pageSource = readFileSync(join(webRoot, 'app', '(workspace)', 'video-studio', 'page.tsx'), 'utf8')
const panelSource = readFileSync(join(webRoot, 'components', 'video-studio', 'ProductionPanel.tsx'), 'utf8')
const apiSource = readFileSync(join(webRoot, 'lib', 'video-studio-api.ts'), 'utf8')

test('production stages stay on Video Studio views', () => {
  assert.equal(stageWorkbenchView('script'), 'production')
  assert.equal(stageWorkbenchView('review'), 'production')
  assert.equal(stageWorkbenchView('cast'), 'storyboard')
  assert.equal(stageWorkbenchView('compose'), 'storyboard')
})

test('readiness drives the next free action', () => {
  const empty = {
    script: false,
    analysis: false,
    review: false,
    cast: { needed: [], bound: [], ready: false },
    storyboard: { shots: 0, ready: false },
    keyframes: { ready: 0, total: 0 },
    videos: { ready: 0, total: 0 },
    voice: { ready: 0, total: 0 },
    compose: false,
  }
  assert.equal(nextProductionAction(empty), 'script')
  assert.equal(nextProductionAction({ ...empty, script: true, analysis: true }), 'review')
  assert.ok(!stageReady('review', empty))
  assert.equal(emptyVideoProduction().stage, 'script')
})

test('episode production is a studio tab, not a separate product', () => {
  assert.match(pageSource, /changeViewMode\('production'\)/)
  assert.match(pageSource, /ProductionPanel/)
  assert.match(pageSource, /ProductionStageRail/)
  assert.match(pageSource, /applyVideoProduction/)
  assert.match(pageSource, /changeViewMode\('storyboard'\)/)
  assert.match(panelSource, /data-production-panel/)
  assert.match(panelSource, /data-production-script/)
  assert.match(panelSource, /Apply to storyboard/)
  assert.match(apiSource, /production\/analyze/)
  assert.match(apiSource, /production\/confirm/)
  assert.match(apiSource, /production\/apply/)
  assert.doesNotMatch(pageSource, /\/drama/)
})
