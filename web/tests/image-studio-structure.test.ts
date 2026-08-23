import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const webRoot = process.cwd()
const page = readFileSync(
  join(webRoot, 'app', '(workspace)', 'image-studio', 'page.tsx'),
  'utf8'
)
const modeControl = readFileSync(
  join(webRoot, 'components', 'image-studio', 'StudioModeControl.tsx'),
  'utf8'
)
const promptBar = readFileSync(
  join(webRoot, 'components', 'image-studio', 'StudioPromptBar.tsx'),
  'utf8'
)
const modelPicker = readFileSync(
  join(webRoot, 'components', 'image-studio', 'StudioModelPicker.tsx'),
  'utf8'
)
const results = readFileSync(
  join(webRoot, 'components', 'image-studio', 'StudioResultGrid.tsx'),
  'utf8'
)
const canvas = readFileSync(
  join(webRoot, 'components', 'image-studio', 'StudioCanvas.tsx'),
  'utf8'
)
const logic = readFileSync(join(webRoot, 'lib', 'image-studio', 'studio-logic.ts'), 'utf8')

test('Image Studio ships the four-mode control and floating prompt bar', () => {
  assert.match(modeControl, /data-studio-mode-control/)
  assert.match(modeControl, /data-studio-mode=\{mode\}/)
  assert.match(logic, /export const STUDIO_UI_MODES = \['create', 'edit', 'canvas', 'enhance'\]/)
  assert.match(promptBar, /data-studio-prompt-bar/)
  assert.match(promptBar, /data-studio-prompt/)
  assert.match(promptBar, /data-studio-generate/)
  assert.match(page, /StudioModeControl/)
  assert.match(page, /StudioPromptBar/)
  assert.match(page, /flex-\[1_1_72%\]/)
})

test('the prompt bar exposes a provider-agnostic image model picker', () => {
  assert.match(promptBar, /StudioModelPicker/)
  assert.match(modelPicker, /data-studio-model-picker/)
  assert.match(modelPicker, /model\.profile_name/)
  assert.match(modelPicker, /model\.model_name/)
  assert.match(modelPicker, /advertisedOperations/)
  assert.doesNotMatch(modelPicker, /gpt-image|banana|imagen/i)
  assert.match(page, /STUDIO_MODEL_STORAGE_KEY/)
  assert.match(page, /onModelKey=\{selectModel\}/)
})

test('results are an image grid with hover-or-select actions, not a job-id table', () => {
  assert.match(results, /data-studio-result-grid/)
  assert.match(results, /data-studio-result-actions/)
  assert.doesNotMatch(results, /job\.id<\/td>/)
  assert.match(page, /StudioResultGrid/)
  assert.doesNotMatch(page, /Task history/)
})

test('references are role-tagged and canvas tools use localized user language', () => {
  assert.match(page, /StudioReferences|data-studio-references|onChangeRole/)
  assert.match(logic, /subject[\s\S]*style[\s\S]*composition[\s\S]*color/)
  assert.match(canvas, /Local redraw/)
  assert.match(canvas, /Expand canvas/)
  assert.match(canvas, /Remove objects/)
  assert.match(canvas, /Not available yet/)
  assert.doesNotMatch(canvas, /Inpainting/)
  assert.doesNotMatch(canvas, /Outpainting/)
  assert.doesNotMatch(canvas, /Upscale/)
})

test('局部重绘 passes the exported mask File into generate and exports on painted ref', () => {
  assert.match(page, /generate\(\{ uiMode: 'canvas' \}, file, boardMaskNode\.id\)/)
  assert.match(page, /takeMaskFile\(maskFile, pendingMaskRef\.current\)/)
  assert.match(canvas, /paintedRef/)
  assert.match(canvas, /shouldExportPaintedMask\(paintedRef\.current\)/)
  assert.match(canvas, /onInpaint\(file\)/)
  assert.match(logic, /if \(hasMask && operations\.includes\('inpaint'\)\)/)
})

test('canvas mode is an infinite board persisted on the studio project', () => {
  assert.match(page, /StudioInfiniteBoard/)
  assert.match(page, /getStudioBoard|saveStudioBoard/)
  assert.match(page, /data-studio-infinite-board|persistBoard/)
  const boardUi = readFileSync(
    join(webRoot, 'components', 'image-studio', 'StudioInfiniteBoard.tsx'),
    'utf8'
  )
  const boardPanel = readFileSync(
    join(webRoot, 'components', 'image-studio', 'StudioBoardPanel.tsx'),
    'utf8'
  )
  assert.match(boardUi, /data-board-chrome/)
  assert.match(boardUi, /StudioBoardPanel/)
  assert.match(boardPanel, /data-board-panel/)
  assert.match(boardUi, /backdrop-blur-md/)
  const board = readFileSync(
    join(webRoot, 'lib', 'image-studio', 'board-logic.ts'),
    'utf8'
  )
  assert.match(board, /export function connectBoardNodes/)
  assert.match(board, /export function applyJobToBoard/)
  assert.match(board, /export function insertNodeOnEdge/)
  assert.match(boardUi, /data-board-edge-insert/)
  assert.match(boardUi, /StudioBoardNode/)
  const boardNode = readFileSync(
    join(webRoot, 'components', 'image-studio', 'StudioBoardNode.tsx'),
    'utf8'
  )
  assert.match(boardNode, /data-board-handle-side/)
  assert.match(boardNode, /data-board-node-toolbar/)
  assert.match(boardNode, /Image placeholder/)
  assert.match(boardNode, /Generate copy/)
})
