import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addLibraryCanvasNode,
  emptyLibraryCanvas,
  normalizeLibraryCanvas,
} from '../lib/library-canvas'
import {
  flattenLibraryTree,
  libraryDisplayName,
  defaultLibraryHtmlPage,
} from '../lib/library-tree'

const webRoot = process.cwd()
const pageSource = readFileSync(join(webRoot, 'app', '(workspace)', 'library', 'page.tsx'), 'utf8')

test('library page uses a side file list and a personal canvas, not team spaces', () => {
  assert.match(pageSource, /data-library-tree/)
  assert.match(pageSource, /data-library-page/)
  assert.match(pageSource, /data-library-search/)
  assert.match(pageSource, /data-library-preview/)
  assert.match(pageSource, /<LibraryCanvas/)
  assert.match(pageSource, /DocxPreview/)
  assert.match(pageSource, /XlsxPreview/)
  assert.match(pageSource, /LibraryExcelEditor/)
  assert.match(pageSource, /excelKind && editing/)
  assert.match(pageSource, /\['markdown', 'New markdown'\]/)
  assert.match(pageSource, /\['csv', 'New CSV'\]/)
  assert.match(pageSource, /\['html', 'New HTML'\]/)
  assert.match(pageSource, /\['word', 'New Word'\]/)
  assert.match(pageSource, /\['excel', 'New Excel'\]/)
  assert.match(pageSource, /\['canvas', 'New canvas'\]/)
  assert.match(pageSource, /My documents/)
  assert.doesNotMatch(pageSource, /team space|Team documents|团队文档/i)
  assert.doesNotMatch(pageSource, /#eef8f3/)
  assert.match(pageSource, /prepareLibraryHtmlPreview/)
  assert.match(pageSource, /libraryHtmlSandbox\(libraryHtmlPreviewScripts\(/)
  assert.doesNotMatch(pageSource, /sandbox="allow-scripts"/)
  assert.doesNotMatch(pageSource, /allow-same-origin/)
})

test('studio library picker lists the personal tree, not only legacy assets', () => {
  const picker = readFileSync(join(webRoot, 'components', 'library', 'StudioLibraryPicker.tsx'), 'utf8')
  assert.match(picker, /listLibraryTree/)
  assert.match(picker, /collectLibraryFiles/)
  assert.doesNotMatch(picker, /team space|团队文档/i)
})

test('library display names append the file suffix and flatten respects collapse', () => {
  assert.equal(libraryDisplayName({ kind: 'html', title: 'intro' }), 'intro.html')
  assert.equal(libraryDisplayName({ kind: 'html', title: 'intro.html' }), 'intro.html')
  const folder = {
    id: 'f',
    parent_id: null,
    kind: 'folder',
    title: 'Notes',
    mime: '',
    size_bytes: 0,
    created_at: 0,
    updated_at: 0,
    children: [
      {
        id: 'h',
        parent_id: 'f',
        kind: 'html',
        title: 'page',
        mime: '',
        size_bytes: 0,
        created_at: 0,
        updated_at: 0,
      },
    ],
  }
  assert.equal(flattenLibraryTree([folder], new Set()).length, 2)
  assert.equal(flattenLibraryTree([folder], new Set(['f'])).length, 1)
  assert.match(defaultLibraryHtmlPage('Hello', 'Body'), /<h1>Hello<\/h1>/)
})

test('library canvas normalize and add card go through the shipped helper', () => {
  const added = addLibraryCanvasNode(emptyLibraryCanvas(), { title: 'Card', text: 'hello' })
  const normalized = normalizeLibraryCanvas(added)
  assert.equal(normalized.nodes.length, 1)
  assert.equal(normalized.nodes[0].text, 'hello')
  assert.equal(normalized.revision, 1)
})
