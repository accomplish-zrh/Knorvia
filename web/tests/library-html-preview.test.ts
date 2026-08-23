import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  LIBRARY_HTML_ALLOW,
  LIBRARY_HTML_CSP,
  LIBRARY_HTML_SANDBOX_TRUSTED,
  LIBRARY_HTML_SANDBOX_UNTRUSTED,
  isAllowedLibraryPreviewUrl,
  libraryHtmlPreviewScripts,
  libraryHtmlSandbox,
  prepareLibraryHtmlPreview,
} from '../lib/library-html-preview'

const pageSource = readFileSync(
  join(process.cwd(), 'app', '(workspace)', 'library', 'page.tsx'),
  'utf8'
)

test('library HTML sandbox is opaque-origin: scripts without same-origin', () => {
  assert.equal(LIBRARY_HTML_SANDBOX_TRUSTED, 'allow-scripts')
  assert.equal(LIBRARY_HTML_SANDBOX_UNTRUSTED, '')
  assert.doesNotMatch(LIBRARY_HTML_SANDBOX_TRUSTED, /allow-same-origin/)
  assert.doesNotMatch(LIBRARY_HTML_SANDBOX_TRUSTED, /allow-popups/)
  assert.doesNotMatch(LIBRARY_HTML_SANDBOX_TRUSTED, /allow-forms/)
  assert.doesNotMatch(LIBRARY_HTML_SANDBOX_TRUSTED, /allow-top-navigation/)
  assert.equal(libraryHtmlSandbox(true), LIBRARY_HTML_SANDBOX_TRUSTED)
  assert.equal(libraryHtmlSandbox(false), LIBRARY_HTML_SANDBOX_UNTRUSTED)
  assert.equal(LIBRARY_HTML_ALLOW, '')
  assert.match(LIBRARY_HTML_CSP, /connect-src 'none'/)
  assert.match(LIBRARY_HTML_CSP, /default-src 'none'/)
  assert.match(LIBRARY_HTML_CSP, /script-src 'unsafe-inline'/)
})

test('library page preview gates scripts on the server preview_scripts flag', () => {
  assert.match(pageSource, /prepareLibraryHtmlPreview/)
  assert.match(pageSource, /libraryHtmlSandbox/)
  assert.match(pageSource, /libraryHtmlPreviewScripts/)
  assert.match(pageSource, /referrerPolicy="no-referrer"/)
  assert.doesNotMatch(pageSource, /sandbox="allow-scripts"/)
  assert.doesNotMatch(pageSource, /sandbox=\{LIBRARY_HTML_SANDBOX_TRUSTED\}/)
  assert.doesNotMatch(pageSource, /sandbox="allow-same-origin"/)
  assert.doesNotMatch(pageSource, /allow-scripts allow-same-origin/)
  assert.doesNotMatch(pageSource, /allow-same-origin allow-scripts/)
  assert.doesNotMatch(pageSource, /welcome_html_digests|sha256.*welcome/)
})

test('libraryHtmlPreviewScripts requires attested content, not a client marker', () => {
  const original = '<html data-welcome-pack="v1">ok</html>'
  assert.equal(
    libraryHtmlPreviewScripts({ preview_scripts: true, content: original }, original),
    true,
  )
  assert.equal(
    libraryHtmlPreviewScripts({ preview_scripts: true, content: original }, `${original} `),
    false,
  )
  assert.equal(
    libraryHtmlPreviewScripts({ preview_scripts: false, content: original }, original),
    false,
  )
  assert.equal(
    libraryHtmlPreviewScripts(
      { preview_scripts: true },
      original,
    ),
    false,
  )
  assert.equal(libraryHtmlPreviewScripts(null, original), false)
})

test('prepareLibraryHtmlPreview injects CSP and strips parent navigation', () => {
  const prepared = prepareLibraryHtmlPreview(
    '<!doctype html><html><head></head><body><a href="javascript:alert(1)" target="_parent">x</a></body></html>'
  )
  assert.match(prepared, /Content-Security-Policy/)
  assert.match(prepared, /connect-src 'none'/)
  assert.match(prepared, /referrer" content="no-referrer"/)
  assert.doesNotMatch(prepared, /javascript:/i)
  assert.doesNotMatch(prepared, /target="_parent"/)
  assert.doesNotMatch(prepared, /katex/)
  assert.doesNotMatch(prepared, /cdn\.jsdelivr/)
})

test('isAllowedLibraryPreviewUrl allows fragments and data images only', () => {
  assert.equal(isAllowedLibraryPreviewUrl('#main'), true)
  assert.equal(isAllowedLibraryPreviewUrl(''), true)
  assert.equal(isAllowedLibraryPreviewUrl('javascript:alert(1)'), false)
  assert.equal(isAllowedLibraryPreviewUrl('javascript&colon;alert(1)'), false)
  assert.equal(isAllowedLibraryPreviewUrl('https://evil.example'), false)
  assert.equal(isAllowedLibraryPreviewUrl('//evil.example'), false)
  assert.equal(isAllowedLibraryPreviewUrl('data:image/png;base64,aa', 'src'), true)
  assert.equal(isAllowedLibraryPreviewUrl('data:text/html,x', 'href'), false)
})

test('prepareLibraryHtmlPreview wraps fragments so CSP still applies', () => {
  const prepared = prepareLibraryHtmlPreview('<p>hello</p>')
  assert.match(prepared, /<head>/)
  assert.match(prepared, /Content-Security-Policy/)
  assert.match(prepared, /<p>hello<\/p>/)
})

test('prepareLibraryHtmlPreview keeps in-page hashes, data images, and inline scripts', () => {
  const prepared = prepareLibraryHtmlPreview(
    '<!doctype html><html><head></head><body>' +
      '<a href="#main">skip</a>' +
      '<img src="data:image/png;base64,aaaa">' +
      '<script>window.__knorviaPreviewAlive=1</script>' +
      '</body></html>',
  )
  assert.match(prepared, /href="#main"/)
  assert.match(prepared, /src="data:image\/png;base64,aaaa"/)
  assert.match(prepared, /window\.__knorviaPreviewAlive=1/)
  assert.match(prepared, /data-library-nav-guard/)
})

test('prepareLibraryHtmlPreview rewrites encoded javascript URLs instead of leaving them', () => {
  const payloads = [
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JAVASCRIPT:alert(1)">x</a>',
    '<a href="javascript&colon;alert(1)">x</a>',
    '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>',
    '<a href="java&#115;cript:alert(1)">x</a>',
    '<a href="java&#10;script:alert(1)">x</a>',
    '<a href=javascript:alert(1)>x</a>',
  ]
  for (const html of payloads) {
    const prepared = prepareLibraryHtmlPreview(html)
    assert.doesNotMatch(prepared, /javascript/i, html)
    assert.doesNotMatch(prepared, /alert\(1\)/i, html)
  }
})

test('prepareLibraryHtmlPreview blocks markup navigation to the network and the parent', () => {
  const prepared = prepareLibraryHtmlPreview(
    '<!doctype html><html><head>' +
      '<base href="https://evil.example/">' +
      '<meta http-equiv="refresh" content="0;url=https://evil.example/">' +
      '<meta content="0;url=javascript:alert(1)" http-equiv=refresh>' +
      '</head><body>' +
      '<a href="https://evil.example/" target="_parent">out</a>' +
      '<a href="//evil.example/path" ping="https://evil.example/p">proto</a>' +
      '<form action="https://evil.example/go"><button>go</button></form>' +
      '<iframe src="https://evil.example/frame"></iframe>' +
      '</body></html>',
  )
  assert.doesNotMatch(prepared, /<base\b/i)
  assert.doesNotMatch(prepared, /http-equiv=["']?refresh/i)
  assert.doesNotMatch(prepared, /url=https:\/\/evil\.example/i)
  assert.doesNotMatch(prepared, /href="https:\/\/evil\.example/i)
  assert.doesNotMatch(prepared, /href="\/\/evil\.example/i)
  assert.doesNotMatch(prepared, /action="https:\/\/evil\.example/i)
  assert.doesNotMatch(prepared, /src="https:\/\/evil\.example/i)
  assert.doesNotMatch(prepared, /\sping=/i)
  assert.doesNotMatch(prepared, /target="_parent"/)
  assert.match(prepared, /href="#"/)
  assert.match(prepared, /data-library-nav-guard/)
})
