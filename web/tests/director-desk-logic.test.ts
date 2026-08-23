import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DIRECTOR_DESK_REQUEST,
  DIRECTOR_DESK_RESPONSE,
  directorDeskTheme,
  directorDeskUrl,
} from '../lib/director-desk/protocol'
import { DirectorDeskClient, directorResultToFile } from '../lib/director-desk/client'
import {
  directorCameraLabel,
  directorCameraMotion,
} from '../lib/director-desk/camera-mapping'

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('§director-desk url pins the exact index.html path and optional params', () => {
  const url = new URL(directorDeskUrl({ instanceId: 'inst-1' }), 'http://localhost:3000')
  assert.equal(url.pathname, '/director-desk/index.html')
  assert.equal(url.searchParams.get('instanceId'), 'inst-1')
  assert.equal(url.searchParams.get('hostOrigin'), null)
  assert.equal(url.searchParams.get('theme'), null)

  const full = new URL(
    directorDeskUrl({ instanceId: 'inst-2', hostOrigin: 'http://host.test', theme: 'dark' }),
    'http://localhost:3000',
  )
  assert.equal(full.searchParams.get('hostOrigin'), 'http://host.test')
  assert.equal(full.searchParams.get('theme'), 'dark')
})

test('§director-desk theme maps the four app themes onto the desk binary', () => {
  assert.equal(directorDeskTheme('dark'), 'dark')

  assert.equal(directorDeskTheme('glass'), 'dark')
  assert.equal(directorDeskTheme('light'), 'light')
  assert.equal(directorDeskTheme('snow'), 'light')
})

test('§director-desk camera mapping is tolerant to evolving camera objects', () => {
  const camera = { id: 'cam-1', name: 'Push in on hero', motion: 'push-in' }
  assert.equal(directorCameraLabel(camera), 'Push in on hero')
  assert.equal(directorCameraMotion(camera), 'push')
  assert.equal(directorCameraMotion({ id: 'cam-2', label: 'Orbit left' }), 'orbit')
  assert.equal(directorCameraMotion({ id: 'cam-3' }), 'custom')
})

test('§director-desk result-to-file converts dataUrl, blob, and passthrough File', async () => {
  const fromDataUrl = directorResultToFile(
    { dataUrl: PNG_DATA_URL, fileName: 'frame.png' },
    'fallback.png',
    'image/png',
  )
  assert.equal(fromDataUrl.name, 'frame.png')
  assert.equal(fromDataUrl.type, 'image/png')
  assert.equal(fromDataUrl.size, 70)

  const fromBlob = directorResultToFile(
    { blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }), fileName: 'ref.mp4' },
    'fallback.mp4',
    'video/mp4',
  )
  assert.equal(fromBlob.name, 'ref.mp4')
  assert.equal(fromBlob.type, 'video/mp4')
  assert.equal(fromBlob.size, 3)

  const existing = new File([new Uint8Array([9])], 'kept.bin', { type: 'application/octet-stream' })
  const passthrough = directorResultToFile(
    { blob: existing, fileName: 'renamed.bin' },
    'fallback.bin',
    'application/octet-stream',
  )
  assert.equal(passthrough, existing)
  assert.equal(passthrough.name, 'kept.bin')

  assert.throws(
    () => directorResultToFile({ fileName: 'empty.png' }, 'fallback.png', 'image/png'),
    /empty export result/,
  )
})

type Shim = { restore(): void }

function shimWindow(origin: string): { shim: Shim; dispatch(event: unknown): void; posted: Array<{ data: unknown; origin: string }> } {
  const posted: Array<{ data: unknown; origin: string }> = []
  const listeners: Array<(event: unknown) => void> = []
  const fakeWindow = {
    location: { origin },
    addEventListener: (_type: string, handler: (event: unknown) => void) => listeners.push(handler),
    removeEventListener: (_type: string, handler: (event: unknown) => void) => {
      const index = listeners.indexOf(handler)
      if (index >= 0) listeners.splice(index, 1)
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  const previous = (globalThis as Record<string, unknown>).window
  ;(globalThis as Record<string, unknown>).window = fakeWindow
  return {
    shim: { restore: () => { (globalThis as Record<string, unknown>).window = previous } },
    dispatch: (event: unknown) => { for (const listener of [...listeners]) listener(event) },
    posted,
  }
}

function fakeIframe(posted: Array<{ data: unknown; origin: string }>) {
  const contentWindow = {
    postMessage: (data: unknown, origin: string) => posted.push({ data, origin }),
  }
  return { iframe: { contentWindow } as unknown as HTMLIFrameElement, contentWindow }
}

test('§director-desk client correlates responses and ignores foreign sources', async () => {
  const { shim, dispatch, posted } = shimWindow('http://knorvia.test')
  try {
    const { iframe, contentWindow } = fakeIframe(posted)
    const client = new DirectorDeskClient(iframe, { instanceId: 'inst-1', hostOrigin: 'http://knorvia.test' })
    client.attach()

    const pending = client.capabilities()
    await Promise.resolve()

    const envelope = posted.at(-1)
    assert.equal((envelope!.data as { type: string }).type, DIRECTOR_DESK_REQUEST)
    const payload = (envelope!.data as { payload: Record<string, unknown> }).payload
    assert.equal(typeof payload.requestId, 'string')
    assert.ok((payload.requestId as string).startsWith('knorvia-'))
    assert.equal(payload.action, 'capabilities.get')
    assert.equal(envelope!.origin, 'http://knorvia.test')

    const requestId = payload.requestId as string
    const respond = (ok: boolean, data?: unknown) =>
      dispatch({
        source: contentWindow,
        origin: 'http://knorvia.test',
        data: { type: DIRECTOR_DESK_RESPONSE, payload: { protocolVersion: 1, requestId, action: 'capabilities.get', ok, ...(ok ? { data } : { error: { message: 'boom' } }) } },
      })

    // Unknown request ids and messages from a different window are dropped silently.
    dispatch({
      source: { other: true },
      origin: 'http://knorvia.test',
      data: { type: DIRECTOR_DESK_RESPONSE, payload: { protocolVersion: 1, requestId, action: 'capabilities.get', ok: false, error: { message: 'hijack' } } },
    })
    dispatch({
      source: contentWindow,
      origin: 'http://evil.test',
      data: { type: DIRECTOR_DESK_RESPONSE, payload: { protocolVersion: 1, requestId, action: 'capabilities.get', ok: false, error: { message: 'hijack' } } },
    })
    dispatch({
      source: contentWindow,
      origin: 'http://knorvia.test',
      data: { type: DIRECTOR_DESK_RESPONSE, payload: { protocolVersion: 1, requestId: 'knorvia-999', action: 'capabilities.get', ok: false, error: { message: 'unknown' } } },
    })

    respond(true, { protocolVersion: 1, projectSchemaVersion: 1, actions: ['capabilities.get'], uiExports: [], protocolExports: [], assetPersistence: 'browser' })
    const caps = await pending
    assert.equal(caps.actions.length, 1)

    const failing = client.getProject()
    await Promise.resolve()
    const failId = ((posted.at(-1)!.data as { payload: { requestId: string } }).payload).requestId
    dispatch({
      source: contentWindow,
      origin: 'http://knorvia.test',
      data: { type: DIRECTOR_DESK_RESPONSE, payload: { protocolVersion: 1, requestId: failId, action: 'project.get', ok: false, error: { message: 'desk exploded' } } },
    })
    await assert.rejects(failing, /desk exploded/)

    client.dispose()
  } finally {
    shim.restore()
  }
})

test('§director-desk client rejects in-flight requests on dispose', async () => {
  const { shim } = shimWindow('http://knorvia.test')
  try {
    const { iframe } = fakeIframe([])
    const client = new DirectorDeskClient(iframe, { instanceId: 'inst-1', hostOrigin: 'http://knorvia.test' })
    client.attach()
    const pending = client.exportFrame({ position: 'current' })
    client.dispose()
    await assert.rejects(pending, /closed/)
  } finally {
    shim.restore()
  }
})

test('§director-desk ready recovers via probe when the ready handshake raced ahead', async () => {
  const { shim, dispatch, posted } = shimWindow('http://knorvia.test')
  try {
    const { iframe, contentWindow } = fakeIframe(posted)
    const client = new DirectorDeskClient(iframe, { instanceId: 'inst-1', hostOrigin: 'http://knorvia.test' })
    let ready = false
    client.onReady = () => { ready = true }
    client.attach()

    // The desk already loaded and missed us: no ready message will ever arrive.
    // The immediate probe's capabilities.get is the first posted envelope; its
    // response must flip ready on its own.
    const probe = posted[0]!.data as { payload: { requestId: string } }
    dispatch({
      source: contentWindow,
      origin: 'http://knorvia.test',
      data: { type: DIRECTOR_DESK_RESPONSE, payload: { protocolVersion: 1, requestId: probe.payload.requestId, action: 'capabilities.get', ok: true, data: { protocolVersion: 1, projectSchemaVersion: 1, actions: [], uiExports: [], protocolExports: [], assetPersistence: 'browser' } } },
    })

    assert.equal(ready, true)
    await client.ready()
    client.dispose()
  } finally {
    shim.restore()
  }
})
