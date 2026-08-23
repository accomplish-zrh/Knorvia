/**
 * Preview helpers for personal-library HTML documents.
 *
 * Library HTML is user-editable (the welcome pack is only the first example).
 * Scripts may run, but the iframe must stay on a unique opaque origin: never
 * combine `allow-scripts` with `allow-same-origin`. Markup-level rewriting plus
 * a tight CSP stop the document from navigating itself onto the network or
 * breaking out to the parent, instead of hoping the browser ignores a payload.
 */

import { sanitizeIframeHtml } from '@/lib/iframe-html'

/**
 * Opaque-origin sandbox for built-in welcome HTML that the backend attested
 * (`preview_scripts`). Scripts on, no parent cookies/DOM/storage.
 */
export const LIBRARY_HTML_SANDBOX_TRUSTED = 'allow-scripts'

/**
 * Opaque-origin sandbox for every other library HTML document. No scripts,
 * no same-origin, no network tokens. CSS, details, and form *display* still work.
 */
export const LIBRARY_HTML_SANDBOX_UNTRUSTED = ''

/** Empty Permissions-Policy: no camera, mic, geolocation, fullscreen, … */
export const LIBRARY_HTML_ALLOW = ''

export function libraryHtmlSandbox(previewScripts: boolean): string {
  return previewScripts ? LIBRARY_HTML_SANDBOX_TRUSTED : LIBRARY_HTML_SANDBOX_UNTRUSTED
}

/**
 * Scripts run only when the server set `preview_scripts` on this entry *and*
 * the iframe is still showing that attested body. Local edits drop scripts
 * without the client knowing builtin hashes.
 */
export function libraryHtmlPreviewScripts(
  entry: { preview_scripts?: boolean; content?: string } | null,
  draft: string,
): boolean {
  if (!entry || entry.preview_scripts !== true) return false
  if (typeof entry.content !== 'string') return false
  return draft === entry.content
}

export const LIBRARY_HTML_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; worker-src 'none'; child-src 'none'; manifest-src 'none'"

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${LIBRARY_HTML_CSP}">`
const REFERRER_META = '<meta name="referrer" content="no-referrer">'

const NAMED_ENTITIES: Record<string, string> = {
  colon: ':',
  tab: '\t',
  newline: '\n',
  nbsp: ' ',
}

function fromCodePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return ''
  try {
    return String.fromCodePoint(value)
  } catch {
    return ''
  }
}

/** Decode common HTML entities, including double-encoding used to hide javascript:. */
export function decodeHtmlEntities(input: string): string {
  let value = input
  for (let pass = 0; pass < 4; pass += 1) {
    const next = value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (_match, ent: string) => {
      const lower = ent.toLowerCase()
      if (lower in NAMED_ENTITIES) return NAMED_ENTITIES[lower]
      if (lower.startsWith('#x')) return fromCodePoint(Number.parseInt(lower.slice(2), 16))
      if (lower.startsWith('#')) return fromCodePoint(Number.parseInt(lower.slice(1), 10))
      return ''
    })
    if (next === value) break
    value = next
  }
  return value
}

function compactUrl(raw: string): string {
  return decodeHtmlEntities(raw)
    .replace(/[\s\u0000-\u001f\u007f]/g, '')
    .toLowerCase()
}

export function isAllowedLibraryPreviewUrl(raw: string, attr = 'href'): boolean {
  const decoded = decodeHtmlEntities(raw).trim()
  if (!decoded) return true
  if (decoded.startsWith('#')) return true
  const compact = compactUrl(raw)
  if (!compact || compact.startsWith('#')) return true
  const name = attr.toLowerCase()
  if ((name === 'src' || name === 'poster') && compact.startsWith('data:image/')) return true
  return false
}

function rewriteUrlAttribute(
  space: string,
  name: string,
  quote: string,
  raw: string,
): string {
  const attr = name.toLowerCase()
  if (attr === 'srcdoc' || isAllowedLibraryPreviewUrl(raw, attr)) {
    if (attr === 'srcdoc') {
      return quote ? `${space}${name}=${quote}${quote}` : ''
    }
    return quote ? `${space}${name}=${quote}${raw}${quote}` : `${space}${name}=${raw}`
  }
  if (attr === 'href' || attr === 'action' || attr === 'formaction' || attr === 'cite') {
    return quote ? `${space}${name}=${quote}#${quote}` : `${space}${name}=#`
  }
  return quote ? `${space}${name}=${quote}${quote}` : ''
}

function neutralizeNavigationUrls(html: string): string {
  return html.replace(
    /(\s)(href|src|srcdoc|action|formaction|xlink:href|poster|cite)\s*=\s*(?:"([\s\S]*?)"|'([\s\S]*?)'|([^\s>]+))/gi,
    (_full, space: string, name: string, dq?: string, sq?: string, uq?: string) => {
      const quote = dq != null ? '"' : sq != null ? "'" : ''
      const raw = dq ?? sq ?? uq ?? ''
      return rewriteUrlAttribute(space, name, quote, raw)
    },
  )
}

function stripNavigatingHeadTags(html: string): string {
  let next = html.replace(/<base\b[^>]*>/gi, '')
  next = next.replace(/<meta\b[^>]*>/gi, (tag) => {
    const decoded = decodeHtmlEntities(tag).replace(/[\s\u0000-\u001f]/g, ' ')
    if (/http-equiv\s*=\s*(['"]?)refresh\1/i.test(decoded)) return ''
    if (/http-equiv\s*=\s*refresh(?:[\s/>])/i.test(decoded)) return ''
    return tag
  })
  next = next.replace(/\s+ping\s*=\s*(?:"[\s\S]*?"|'[\s\S]*?'|[^\s>]+)/gi, '')
  return next
}

function injectPreviewGuard(html: string): string {
  const guard = `${CSP_META}\n${REFERRER_META}`
  if (/<head\b/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>\n${guard}`)
  }
  if (/<html\b/i.test(html)) {
    return html.replace(
      /(<html[^>]*>)/i,
      `$1\n<head>\n<meta charset="utf-8">\n${guard}\n</head>`,
    )
  }
  return `<!doctype html><html><head><meta charset="utf-8">\n${guard}\n</head><body>${html}</body></html>`
}

const NAV_GUARD_SCRIPT =
  `<script data-library-nav-guard>` +
  `(function(){` +
  `function hashOnly(href){href=String(href||"").trim();return!href||href.charAt(0)==="#";}` +
  `document.addEventListener("click",function(event){` +
  `var node=event.target;` +
  `if(node&&node.nodeType===3)node=node.parentElement;` +
  `while(node&&node!==document){` +
  `var tag=node.tagName;` +
  `if(tag==="A"||tag==="AREA"){` +
  `if(!hashOnly(node.getAttribute("href"))){event.preventDefault();event.stopPropagation();}` +
  `return;}` +
  `node=node.parentNode;}` +
  `},true);` +
  `window.addEventListener("submit",function(event){event.preventDefault();},true);` +
  `try{if(window.navigation&&typeof navigation.addEventListener==="function"){` +
  `navigation.addEventListener("navigate",function(event){` +
  `try{var dest=String((event.destination&&event.destination.url)||"");` +
  `if(dest.charAt(0)==="#"||dest.indexOf("about:srcdoc")===0)return;` +
  `var here=String(location.href||"");` +
  `if(dest===here||dest.indexOf(here.split("#")[0]+"#")===0)return;` +
  `event.preventDefault();}catch(err){}});` +
  `}}catch(err){}` +
  `})();` +
  `</` +
  `script>`

function injectNavGuard(html: string): string {
  if (html.includes('data-library-nav-guard')) return html
  if (/<body\b/i.test(html)) {
    return html.replace(/<body([^>]*)>/i, `<body$1>\n${NAV_GUARD_SCRIPT}`)
  }
  return html
}

function hardenLibraryHtml(html: string): string {
  return neutralizeNavigationUrls(stripNavigatingHeadTags(html))
}

/**
 * Defense in depth for `srcdoc` preview: strip navigation escapes (including
 * encoded javascript: URLs, meta refresh, and http(s) hrefs), then pin a
 * network-hostile CSP. Interactive inline scripts are kept.
 */
export function prepareLibraryHtmlPreview(html: string): string {
  const sanitized = sanitizeIframeHtml(html || '')
  return injectNavGuard(injectPreviewGuard(hardenLibraryHtml(sanitized)))
}
