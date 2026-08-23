import test from 'node:test'
import assert from 'node:assert/strict'

import {
  composeVideoProject,
  followVideoJob,
  generateVideoShotKeyframe,
  generateVideoShotVoiceover,
  getVideoBoard,
  getVideoFfmpegStatus,
  installVideoFfmpeg,
  listVideoCompositions,
  normalizeVideoUploadMime,
  saveVideoBoard,
  saveVideoSubtitleAsset,
  saveVideoStoryboard,
  updateVideoSubtitleAsset,
  uploadVideoAsset,
  VideoBoardConflictError,
  videoAssetUrl,
  videoProjectExportUrl,
} from '../lib/video-studio-api'
import type { VideoBoardDocument } from '../lib/video-studio/board-logic'

function uploadFile(type = 'video/mp4') {
  return Object.assign(new Blob([new Uint8Array([1, 2, 3, 4])], { type }), {
    name: type.startsWith('audio/') ? 'sound.m4a' : 'clip.mp4',
  }) as File
}

function boardDocument(revision = 5): VideoBoardDocument {
  return {
    version: 1,
    revision,
    viewport: { x: 0, y: 0, scale: 1 },
    nodes: [
      { id: 'note-1', kind: 'text', x: 12, y: 24, width: 240, height: 140, z: 0, text: 'note' },
    ],
    edges: [],
    groups: [],
    updated_at: null,
  }
}

test('job following rejects before polling when already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    followVideoJob('job-1', () => undefined, undefined, 0, controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
  )
})

test('job following reconnects after a transient fetch failure and preserves connection state', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const states: boolean[] = []
  let requestCount = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { setTimeout, clearTimeout },
  })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestCount += 1
    if (requestCount === 1) throw new TypeError('temporary disconnect')
    const url = String(input)
    if (url.includes('/events?')) {
      return new Response(JSON.stringify({ events: [], next_seq: 7 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      id: 'job-reconnected',
      project_id: 'project-1',
      operation: 'text_to_video',
      status: 'succeeded',
      progress: 1,
      prompt: 'done',
      profile_id: 'profile',
      model_id: 'model',
      parameters: {},
      input_asset_ids: [],
      output_asset_ids: ['output-1'],
      created_at: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  try {
    const job = await followVideoJob(
      'job-reconnected',
      () => undefined,
      undefined,
      0,
      undefined,
      connected => states.push(connected)
    )
    assert.equal(job.status, 'succeeded')
    assert.deepEqual(states, [false, true])
    assert.equal(requestCount, 3)
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('asset playback uses a same-origin direct content URL', () => {
  assert.equal(videoAssetUrl('asset / 1'), '/api/v1/video-studio/assets/asset%20%2F%201/content')
})

test('project export is a direct same-origin ZIP endpoint', () => {
  assert.equal(videoProjectExportUrl('project / 1'), '/api/v1/video-studio/projects/project%20%2F%201/export')
})

test('storyboard save API remains callable with a revisioned document', () => {
  assert.equal(typeof saveVideoStoryboard, 'function')
})

test('browser M4A aliases are normalized to the server canonical media type', () => {
  assert.equal(normalizeVideoUploadMime('audio/x-m4a'), 'audio/mp4')
  assert.equal(normalizeVideoUploadMime('Audio/M4A; charset=binary'), 'audio/mp4')
  assert.equal(normalizeVideoUploadMime('video/mp4'), 'video/mp4')
})

test('failed upload chunks best-effort delete the server upload session', async () => {
  const previousFetch = globalThis.fetch
  const requests: Array<[string, string]> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method || 'GET'
    requests.push([method, url])
    if (method === 'POST' && url.endsWith('/uploads')) {
      return Response.json({ id: 'upload-cleanup', part_size: 4 })
    }
    if (method === 'PUT') return new Response(null, { status: 500 })
    if (method === 'DELETE') return new Response(null, { status: 204 })
    throw new Error(`Unexpected request: ${method} ${url}`)
  }) as typeof fetch
  try {
    await assert.rejects(uploadVideoAsset('project-1', uploadFile()), /Upload failed \(500\)/)
    assert.deepEqual(requests.map(([method]) => method), ['POST', 'PUT', 'DELETE'])
    assert.match(requests[2][1], /\/uploads\/upload-cleanup$/)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('abort after session creation uses a fresh cleanup request signal', async () => {
  const previousFetch = globalThis.fetch
  const controller = new AbortController()
  const requests: Array<{ method: string; aborted: boolean }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method || 'GET'
    requests.push({ method, aborted: Boolean(init?.signal?.aborted) })
    if (method === 'POST' && String(input).endsWith('/uploads')) {
      controller.abort()
      return Response.json({ id: 'upload-aborted', part_size: 4 })
    }
    if (method === 'DELETE') return new Response(null, { status: 204 })
    throw new Error(`Unexpected request: ${method}`)
  }) as typeof fetch
  try {
    await assert.rejects(
      uploadVideoAsset('project-1', uploadFile(), undefined, controller.signal),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
    )
    assert.deepEqual(requests, [
      { method: 'POST', aborted: false },
      { method: 'DELETE', aborted: false },
    ])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('successful completion does not delete its upload session', async () => {
  const previousFetch = globalThis.fetch
  const methods: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method || 'GET'
    methods.push(method)
    if (method === 'POST' && url.endsWith('/uploads')) {
      return Response.json({ id: 'upload-success', part_size: 4 })
    }
    if (method === 'PUT') return new Response(null, { status: 204 })
    if (method === 'POST' && url.endsWith('/complete')) {
      return Response.json({
        id: 'asset-1', project_id: 'project-1', kind: 'video', mime_type: 'video/mp4',
        filename: 'clip.mp4', size_bytes: 4, sha256: '0'.repeat(64), created_at: 1,
      })
    }
    if (method === 'DELETE') throw new Error('successful upload must not be deleted')
    throw new Error(`Unexpected request: ${method} ${url}`)
  }) as typeof fetch
  try {
    const asset = await uploadVideoAsset('project-1', uploadFile())
    assert.equal(asset.id, 'asset-1')
    assert.deepEqual(methods, ['POST', 'PUT', 'POST'])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('getVideoBoard normalizes the server board document', async () => {
  const previousFetch = globalThis.fetch
  let requestedUrl = ''
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input)
    return Response.json({
      version: 1,
      revision: 7,
      viewport: { x: 10, y: -20, scale: 2 },
      nodes: [
        { id: 'gen-1', kind: 'generate', x: 0, y: 0, z: 0, prompt: 'a slow push-in' },
        { id: 'bogus', kind: 'not-a-kind', x: 1, y: 1, z: 1 },
      ],
      edges: [
        { id: 'edge-1', from: 'gen-1', to: 'missing-node', role: 'reference' },
        { id: 'edge-2', from: 'gen-1', to: 'gen-1', role: 'audio' },
      ],
      groups: [],
      updated_at: 1234,
    })
  }) as typeof fetch
  try {
    const board = await getVideoBoard('project / 1')
    assert.match(requestedUrl, /\/api\/v1\/video-studio\/projects\/project%20%2F%201\/board$/)
    assert.equal(board.version, 1)
    assert.equal(board.revision, 7)
    assert.deepEqual(board.viewport, { x: 10, y: -20, scale: 2 })
    assert.deepEqual(board.nodes.map(node => node.id), ['gen-1'])
    assert.equal(board.nodes[0].prompt, 'a slow push-in')
    assert.equal(board.nodes[0].width, 320)
    assert.equal(board.nodes[0].height, 292)
    assert.deepEqual(board.edges, [])
    assert.equal(board.updated_at, 1234)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('saveVideoBoard sends the revision as If-Match and the whole document', async () => {
  const previousFetch = globalThis.fetch
  const document = boardDocument(5)
  let requestedUrl = ''
  let captured: { method?: string; headers?: Record<string, string>; body?: string } = {}
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input)
    captured = {
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    return Response.json({ ...document, revision: 6 })
  }) as typeof fetch
  try {
    const saved = await saveVideoBoard('project-1', document)
    assert.match(requestedUrl, /\/api\/v1\/video-studio\/projects\/project-1\/board$/)
    assert.equal(captured.method, 'PUT')
    assert.equal(captured.headers?.['Content-Type'], 'application/json')
    assert.equal(captured.headers?.['If-Match'], '"5"')
    assert.deepEqual(JSON.parse(captured.body ?? ''), document)
    assert.equal(saved.revision, 6)
    assert.deepEqual(saved.nodes, document.nodes)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('saveVideoBoard revision conflicts raise VideoBoardConflictError with the server revision', async () => {
  const previousFetch = globalThis.fetch
  try {
    for (const status of [409, 412]) {
      globalThis.fetch = (async () =>
        Response.json(
          {
            detail: {
              code: 'board_revision_conflict',
              message: 'board changed elsewhere',
              expected_revision: 5,
              current_revision: 9,
            },
          },
          { status }
        )) as typeof fetch
      await assert.rejects(
        saveVideoBoard('project-1', boardDocument(5)),
        (error: unknown) =>
          error instanceof VideoBoardConflictError &&
          error.name === 'VideoBoardConflictError' &&
          error.status === status &&
          error.serverRevision === 9 &&
          error.message === 'board changed elsewhere'
      )
    }
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('saveVideoBoard other failures keep the shared API error shape', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    Response.json(
      { detail: { code: 'board_invalid', message: 'board payload invalid' } },
      { status: 422 }
    )) as typeof fetch
  try {
    await assert.rejects(
      saveVideoBoard('project-1', boardDocument(5)),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof VideoBoardConflictError) &&
        error.name === 'VideoStudioApiError' &&
        error.message === 'board payload invalid'
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

const storyboardPayload = { version: 1, revision: 4, shots: [], updated_at: null }

test('shot keyframe API posts the paid confirmation and returns the updated storyboard', async () => {
  const previousFetch = globalThis.fetch
  let requestedUrl = ''
  let captured: { method?: string; body?: string } = {}
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input)
    captured = {
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    return Response.json({
      asset: {
        id: 'image-1', project_id: 'project-1', kind: 'image', mime_type: 'image/png',
        filename: 'kf.png', size_bytes: 4, sha256: '0'.repeat(64), created_at: 1,
      },
      image_job_id: 'job-kf-1',
      storyboard: storyboardPayload,
    })
  }) as typeof fetch
  try {
    const result = await generateVideoShotKeyframe('project-1', 'shot-9', {
      prompt: 'misty lake at dawn',
      confirmed_cost: true,
    })
    assert.match(requestedUrl, /\/api\/v1\/video-studio\/projects\/project-1\/storyboard\/shots\/shot-9\/keyframe$/)
    assert.equal(captured.method, 'POST')
    const body = JSON.parse(captured.body ?? '')
    assert.equal(body.confirmed_cost, true)
    assert.equal(body.prompt, 'misty lake at dawn')
    assert.equal(result.asset.id, 'image-1')
    assert.equal(result.image_job_id, 'job-kf-1')
    assert.equal(result.storyboard.revision, 4)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('shot voiceover API posts narration text with the paid confirmation', async () => {
  const previousFetch = globalThis.fetch
  let requestedUrl = ''
  let captured: { method?: string; body?: string } = {}
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input)
    captured = {
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    return Response.json({
      asset: {
        id: 'audio-1', project_id: 'project-1', kind: 'audio', mime_type: 'audio/mpeg',
        filename: 'vo.mp3', size_bytes: 8, sha256: '0'.repeat(64), created_at: 1, duration: 6.5,
      },
      duration: 6.5,
      storyboard: storyboardPayload,
    })
  }) as typeof fetch
  try {
    const result = await generateVideoShotVoiceover('project-1', 'shot-9', {
      text: 'the lake sleeps under mist',
      voice: 'narrator-female',
      confirmed_cost: true,
    })
    assert.match(requestedUrl, /\/api\/v1\/video-studio\/projects\/project-1\/storyboard\/shots\/shot-9\/voiceover$/)
    assert.equal(captured.method, 'POST')
    const body = JSON.parse(captured.body ?? '')
    assert.equal(body.confirmed_cost, true)
    assert.equal(body.text, 'the lake sleeps under mist')
    assert.equal(body.voice, 'narrator-female')
    assert.equal(result.asset.id, 'audio-1')
    assert.equal(result.duration, 6.5)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('compose API queues a free local job with subtitle, audio, and output config', async () => {
  const previousFetch = globalThis.fetch
  let requestedUrl = ''
  let captured: { method?: string; body?: string } = {}
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input)
    captured = {
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    return Response.json({
      id: 'job-compose-1', project_id: 'project-1', operation: 'compose' as never,
      status: 'queued', progress: 0, prompt: '', profile_id: 'local', model_id: 'ffmpeg',
      parameters: {}, input_asset_ids: [], output_asset_ids: [], created_at: 1,
    })
  }) as typeof fetch
  try {
    const job = await composeVideoProject('project-1', {
      subtitle: { mode: 'from_notes' },
      audio: { voiceovers: true, bgm_asset_id: 'audio-bgm' },
      output: { resolution: '720p' },
      client_request_id: 'compose-request-1',
    })
    assert.match(requestedUrl, /\/api\/v1\/video-studio\/projects\/project-1\/compose$/)
    assert.equal(captured.method, 'POST')
    const body = JSON.parse(captured.body ?? '')
    assert.deepEqual(body.subtitle, { mode: 'from_notes' })
    assert.deepEqual(body.audio, { voiceovers: true, bgm_asset_id: 'audio-bgm' })
    assert.deepEqual(body.output, { resolution: '720p' })
    assert.equal(body.client_request_id, 'compose-request-1')
    assert.equal(job.id, 'job-compose-1')
    assert.equal(job.status, 'queued')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('compose API carries the D2 from_asset subtitle document and burn style', async () => {
  const previousFetch = globalThis.fetch
  let captured: { url?: string; body?: string } = {}
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = {
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    return Response.json({
      id: 'job-compose-2', project_id: 'project-1', operation: 'compose' as never,
      status: 'queued', progress: 0, prompt: '', profile_id: 'local', model_id: 'ffmpeg',
      parameters: {}, input_asset_ids: [], output_asset_ids: [], created_at: 2,
    })
  }) as typeof fetch
  try {
    await composeVideoProject('project-1', {
      subtitle: { mode: 'from_asset', style: 'yellow_box', srt_asset_id: 'asset-srt-1' },
      output: { resolution: '1080p' },
      client_request_id: 'compose-request-2',
    })
    const body = JSON.parse(captured.body ?? '')
    assert.deepEqual(body.subtitle, { mode: 'from_asset', style: 'yellow_box', srt_asset_id: 'asset-srt-1' })
    assert.deepEqual(body.output, { resolution: '1080p' })
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('subtitle editor saves create project assets and update them in place', async () => {
  const previousFetch = globalThis.fetch
  const requests: Array<{ method: string; url: string; body?: string }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      method: init?.method || 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    const update = requests.length === 2
    return Response.json({
      asset: {
        id: update ? 'asset-srt-1' : 'asset-srt-2',
        project_id: 'project-1',
        kind: 'subtitle',
        mime_type: 'application/x-subrip',
        filename: update ? 'captions.srt' : 'subtitles.srt',
        size_bytes: 64,
        sha256: '0'.repeat(64),
        created_at: 9,
      },
    })
  }) as typeof fetch
  try {
    const created = await saveVideoSubtitleAsset('project-1', {
      content: '1\n00:00:01,000 --> 00:00:03,000\nHello\n',
      filename: 'subtitles.srt',
    })
    assert.match(requests[0].url, /\/api\/v1\/video-studio\/projects\/project-1\/subtitle-assets$/)
    assert.equal(requests[0].method, 'POST')
    assert.deepEqual(JSON.parse(requests[0].body ?? ''), {
      content: '1\n00:00:01,000 --> 00:00:03,000\nHello\n',
      filename: 'subtitles.srt',
    })
    assert.equal(created.kind, 'subtitle')
    assert.equal(created.mime_type, 'application/x-subrip')

    const updated = await updateVideoSubtitleAsset('asset-srt-1', {
      content: '1\n00:00:01,000 --> 00:00:04,000\nHello again\n',
    })
    assert.match(requests[1].url, /\/api\/v1\/video-studio\/assets\/asset-srt-1\/subtitle$/)
    assert.equal(requests[1].method, 'PUT')
    assert.deepEqual(JSON.parse(requests[1].body ?? ''), {
      content: '1\n00:00:01,000 --> 00:00:04,000\nHello again\n',
    })
    assert.equal(updated.id, 'asset-srt-1')
    assert.equal(updated.filename, 'captions.srt')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('compositions list unwraps the server payload per job', async () => {
  const previousFetch = globalThis.fetch
  let requestedUrl = ''
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input)
    assert.equal(init?.method ?? 'GET', 'GET')
    return Response.json({
      compositions: [
        {
          job: {
            id: 'job-compose-1', project_id: 'project-1', operation: 'compose' as never,
            status: 'succeeded', progress: 1, prompt: '', profile_id: 'local', model_id: 'ffmpeg',
            parameters: {}, input_asset_ids: [], output_asset_ids: ['video-final'], created_at: 42,
          },
          asset: {
            id: 'video-final', project_id: 'project-1', kind: 'video', mime_type: 'video/mp4',
            filename: 'final.mp4', size_bytes: 10, sha256: '0'.repeat(64), created_at: 42, duration: 31,
          },
        },
        { job: { id: 'job-compose-2', status: 'failed' as never }, asset: null },
      ],
    })
  }) as typeof fetch
  try {
    const items = await listVideoCompositions('project-1')
    assert.match(requestedUrl, /\/api\/v1\/video-studio\/projects\/project-1\/compositions$/)
    assert.equal(items.length, 2)
    assert.equal(items[0].job.id, 'job-compose-1')
    assert.equal(items[0].asset?.id, 'video-final')
    assert.equal(items[1].asset, null)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('ffmpeg status reads GET while install posts', async () => {
  const previousFetch = globalThis.fetch
  const requests: Array<{ method: string; url: string }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method || 'GET'
    requests.push({ method, url })
    return Response.json({ available: true, source: 'PATH', version: '7.1', install_supported: true, download_bytes: 84_000_000 })
  }) as typeof fetch
  try {
    const status = await getVideoFfmpegStatus()
    assert.match(requests[0].url, /\/api\/v1\/video-studio\/ffmpeg\/status$/)
    assert.equal(requests[0].method, 'GET')
    assert.equal(status.available, true)
    const installed = await installVideoFfmpeg()
    assert.match(requests[1].url, /\/api\/v1\/video-studio\/ffmpeg\/install$/)
    assert.equal(requests[1].method, 'POST')
    assert.equal(installed.install_supported, true)
  } finally {
    globalThis.fetch = previousFetch
  }
})
