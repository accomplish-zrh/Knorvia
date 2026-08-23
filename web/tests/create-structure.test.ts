import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const webRoot = process.cwd()
const createPage = readFileSync(join(webRoot, 'app', '(workspace)', 'create', 'page.tsx'), 'utf8')
const libraryPage = readFileSync(join(webRoot, 'app', '(workspace)', 'library', 'page.tsx'), 'utf8')
const sidebar = readFileSync(join(webRoot, 'components', 'sidebar', 'SidebarShell.tsx'), 'utf8')
const imagePage = readFileSync(join(webRoot, 'app', '(workspace)', 'image-studio', 'page.tsx'), 'utf8')
const videoPage = readFileSync(join(webRoot, 'app', '(workspace)', 'video-studio', 'page.tsx'), 'utf8')

test('Create is not a product surface; it opens the agent chat', () => {
  assert.match(createPage, /redirect/)
  assert.match(createPage, /\/home/)
  assert.doesNotMatch(createPage, /data-create-page/)
  assert.doesNotMatch(createPage, /submitCreateGeneration/)
  assert.doesNotMatch(createPage, /from ['"]antd['"]/)
  assert.doesNotMatch(createPage, /vozeb/i)
})

test('Library page hands assets into chat and both studios', () => {
  assert.match(libraryPage, /data-library-page/)
  assert.match(libraryPage, /Ask the agent/)
  assert.match(libraryPage, /chatHandoffHref/)
  assert.match(libraryPage, /Use in Image Studio/)
  assert.match(libraryPage, /Use in Video Studio/)
  assert.doesNotMatch(libraryPage, /Use in Create/)
  assert.doesNotMatch(libraryPage, /href=\{\`\/create/)
})

test('sidebar exposes Library without cloning SaaS billing', () => {
  assert.match(sidebar, /href: "\/library"/)
  assert.doesNotMatch(sidebar, /billing|credits|gallery/i)
})

test('sidebar nests Co-Writer, Image Studio, and Video Studio under Creation desk', () => {
  assert.match(sidebar, /CREATION_DESK_CHILDREN/)
  assert.match(sidebar, /data-creation-desk/)
  assert.match(sidebar, /href: "\/co-writer"/)
  assert.match(sidebar, /href: "\/image-studio"/)
  assert.match(sidebar, /href: "\/video-studio"/)
  assert.match(sidebar, /PenLine/)
  assert.match(sidebar, /Images/)
  assert.match(sidebar, /Clapperboard/)
  assert.match(sidebar, /Creation desk/)
  assert.match(sidebar, /grid-rows-\[1fr\]/)
  assert.doesNotMatch(sidebar, /left-\[calc\(100%/)
  assert.doesNotMatch(sidebar, /href: "\/create"/)
  const leading = sidebar.slice(sidebar.indexOf('const PRIMARY_LEADING'), sidebar.indexOf('const CREATION_DESK_CHILDREN'))
  const trailing = sidebar.slice(sidebar.indexOf('const PRIMARY_TRAILING'), sidebar.indexOf('const SECONDARY_NAV'))
  assert.doesNotMatch(leading, /href: "\/co-writer"/)
  assert.doesNotMatch(leading, /href: "\/image-studio"/)
  assert.doesNotMatch(leading, /href: "\/video-studio"/)
  assert.doesNotMatch(trailing, /href: "\/co-writer"/)
  assert.doesNotMatch(trailing, /href: "\/image-studio"/)
  assert.doesNotMatch(trailing, /href: "\/video-studio"/)
})

test('both studios host library insert and canvas agent run', () => {
  assert.match(imagePage, /StudioLibraryPicker/)
  assert.match(imagePage, /StudioAgentPanel/)
  assert.match(imagePage, /studio="image"/)
  assert.match(videoPage, /StudioLibraryPicker/)
  assert.match(videoPage, /StudioAgentPanel/)
  assert.match(videoPage, /studio="video"/)
})
