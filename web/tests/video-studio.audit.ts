import { expect, test, type Page, type Route } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type {
  VideoAsset,
  VideoBoardDocument,
  VideoCharacter,
  VideoJob,
  VideoStoryboardDocument,
} from '../lib/video-studio-api'

const screenshotDir = path.join(process.cwd(), 'test-results', 'video-studio')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR4nO3PQQ0AIBDAsAP/nuGNAvZoFSzZOjNnyNiBfQW0AXQBdAF0AXQBdAF0AXQBdAF0AXQBdAF0AXQBdAF0AXQBdAF0AXQBdAF0AXQBdAF0AewB+f8Bf2vHKwAAAABJRU5ErkJggg==',
  'base64'
)

const baseModel = {
  profile_id: 'google-main',
  model_id: 'veo-3',
  profile_name: 'Studio account',
  model_name: 'Veo Cinematic',
  model: 'veo-3',
  provider: 'google',
  capabilities: {
    operations: ['text_to_video', 'image_to_video'],
    durations: [4, 8],
    aspect_ratios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p'],
    fps: [24, 30],
    audio_modes: ['none', 'generate', 'input'],
    reference_modes: ['first', 'last', 'multi'],
    max_inputs: { image: 2, video: 0, audio: 1, total: 3 },
    supports_cancel: true,
    supports_seed: true,
    max_prompt_length: 1200,
    parameter_schema: {
      type: 'object',
      properties: { camera_motion: { type: 'string', enum: ['static', 'dolly'] } },
    },
  },
  defaults: {
    duration: 8,
    aspect_ratio: '16:9',
    resolution: '1080p',
    fps: 24,
    audio_mode: 'generate',
    reference_mode: 'first',
  },
}

const fastModel = {
  ...baseModel,
  profile_id: 'fast-account',
  model_id: 'fast-video',
  model_name: 'Cinematic Fast',
  provider: 'openai-compatible',
  capabilities: {
    ...baseModel.capabilities,
    operations: ['text_to_video'],
    durations: [6],
    resolutions: ['720p'],
    fps: [24],
    audio_modes: ['none'],
    reference_modes: [],
    supports_seed: false,
  },
  defaults: { duration: 6, aspect_ratio: '16:9', resolution: '720p', fps: 24, audio_mode: 'none' },
  lifecycle: { status: 'deprecated', shutdown_date: '2026-09-24', message: null },
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

/**
 * §14 Playwright additions: an optional populated canvas (`canvas: true`) and
 * a job bound to a canvas node (`boardJob: true`) for the first-last connect
 * and `?job=` focus audits. Default (no options) keeps the empty board so the
 * legacy tests still land on the storyboard view.
 * Phase A adds `exportFlow` (rendered shot output, available ffmpeg, compose
 * round-trip) and `conflict: false` to skip the built-in CAS 409 rehearsal.
 * Phase B always mocks the character library CRUD + three-view endpoints;
 * they start empty and are driven by the character audit test.
 * Phase C5 always mocks the shot variant history / bind / reroll endpoints;
 * `variants: true` additionally seeds a finished historical take so the
 * variant audit has two versions to list and switch between.
 */
async function mockVideoStudio(
  page: Page,
  withModels: boolean,
  options: {
    canvas?: boolean
    boardJob?: boolean
    exportFlow?: boolean
    conflict?: boolean
    variants?: boolean
    timeline?: boolean
  } = {}) {
  const wantsConflict = options.conflict !== false
  let revision = 3
  let conflictSent = false
  let storyboard: VideoStoryboardDocument = {
    version: 1 as const,
    revision,
    updated_at: 1,
    shots: [
      {
        id: 'shot-opening',
        order: 0,
        title: 'Opening light',
        prompt: 'Morning light crosses a quiet reading room',
        input_asset_ids: ['asset-image'],
        job_id: 'job-running',
        output_asset_id: options.exportFlow ? 'asset-video-out' : null,
        duration: 8,
        notes: 'Slow dolly forward',
        transition: null,
      },
    ],
  }
  // §F1: a three-shot cut exercises the timeline (blocks, crossfade overlap,
  // reorder, trim) — every take renders the same 8 s clip so blocks are wide.
  if (options.timeline) {
    storyboard = {
      ...storyboard,
      shots: [
        {
          id: 'shot-opening',
          order: 0,
          title: 'Opening light',
          prompt: 'Morning light crosses a quiet reading room',
          input_asset_ids: ['asset-image'],
          job_id: 'job-running',
          output_asset_id: 'asset-video-out',
          duration: 8,
          notes: 'Slow dolly forward',
          transition: null,
        },
        {
          id: 'shot-city',
          order: 1,
          title: 'City waking',
          prompt: 'Rooftops catch the first sun',
          input_asset_ids: [],
          job_id: null,
          output_asset_id: 'asset-video-out',
          duration: 4,
          notes: null,
          transition: 'crossfade',
        },
        {
          id: 'shot-close',
          order: 2,
          title: 'Closing card',
          prompt: 'Title card over soft grain',
          input_asset_ids: [],
          job_id: null,
          output_asset_id: 'asset-video-out',
          duration: 4,
          notes: null,
          transition: null,
        },
      ],
    }
  }
  const jobs: VideoJob[] = [
    {
      id: 'job-running',
      project_id: 'project-1',
      operation: 'image_to_video',
      status: 'running',
      progress: 0.47,
      stage: 'Rendering motion',
      prompt: 'Morning light crosses a quiet reading room',
      profile_id: 'google-main',
      model_id: 'veo-3',
      parameters: { duration: 8, resolution: '1080p', fps: 24 },
      input_asset_ids: ['asset-image'],
      output_asset_ids: [],
      created_at: 1,
    },
    {
      id: 'job-failed',
      project_id: 'project-1',
      operation: 'text_to_video',
      status: 'failed',
      progress: 0.63,
      stage: 'Provider rejected request',
      prompt: '一段很长的中文失败任务，用来检查队列中的换行、错误恢复与窄屏可读性',
      profile_id: 'google-main',
      model_id: 'veo-3',
      parameters: { duration: 8 },
      input_asset_ids: [],
      output_asset_ids: [],
      error_code: 'provider_rejected',
      error_message: '供应商拒绝了这个视频任务，请检查额度或模型状态后重试；这段较长文本用于确认错误信息不会溢出任务卡片。',
      created_at: 0,
      finished_at: 1,
    },
  ]
  if (options.boardJob) {
    jobs.unshift({
      id: 'job-canvas',
      project_id: 'project-1',
      operation: 'image_to_video',
      status: 'running',
      progress: 0.42,
      stage: 'Rendering motion',
      prompt: 'Morning light crosses a quiet reading room',
      profile_id: 'google-main',
      model_id: 'veo-3',
      parameters: { duration: 8, resolution: '1080p', fps: 24 },
      input_asset_ids: ['asset-image'],
      output_asset_ids: [],
      board_node_id: 'node-generate',
      created_at: 5,
    })
  }
  // Phase C5: tag the shot-bound take and seed a finished historical version.
  if (options.variants) {
    const runningIndex = jobs.findIndex(job => job.id === 'job-running')
    if (runningIndex >= 0) {
      jobs[runningIndex] = {
        ...jobs[runningIndex],
        storyboard_shot_id: 'shot-opening',
        parameters: { ...jobs[runningIndex].parameters, seed: 7 },
      }
    }
    // The canvas take must be finished — a busy card replaces the reroll entry
    // with its live status button.
    const canvasIndex = jobs.findIndex(job => job.id === 'job-canvas')
    if (canvasIndex >= 0) {
      jobs[canvasIndex] = {
        ...jobs[canvasIndex],
        status: 'succeeded',
        progress: 1,
        stage: null,
        output_asset_ids: ['asset-video-out'],
        finished_at: 5,
      }
    }
    jobs.push({
      id: 'job-v1',
      project_id: 'project-1',
      operation: 'image_to_video',
      status: 'succeeded',
      progress: 1,
      stage: null,
      prompt: 'Morning light crosses a quiet reading room',
      profile_id: 'google-main',
      model_id: 'veo-3',
      parameters: {
        duration: 8,
        resolution: '1080p',
        fps: 24,
        seed: 424242,
        camera_motion: 'dolly',
      },
      input_asset_ids: ['asset-image'],
      output_asset_ids: ['asset-video-out'],
      storyboard_shot_id: 'shot-opening',
      created_at: 0.5,
      // §F2: 60 wall-clock seconds (ms epoch math) so the drawer's render
      // time line reads 1:00.
      finished_at: 60_000.5,
    })
  }
  const createdRequests: Array<Record<string, unknown>> = []
  const boardPuts: Array<Record<string, unknown>> = []
  let boardRevision = 4
  // Phase D2: the subtitle editor's save/update endpoints and the SRT content
  // they persist (served back for the editor's "load saved subtitles" flow).
  const subtitleSaves: Array<Record<string, unknown>> = []
  const subtitleUpdates: Array<Record<string, unknown>> = []
  let subtitleContent = ''
  let subtitleRevision = 0
  const subtitleAsset: VideoAsset = {
    id: 'asset-srt-1',
    project_id: 'project-1',
    kind: 'subtitle',
    mime_type: 'application/x-subrip',
    filename: 'subtitles.srt',
    size_bytes: 64,
    sha256: 'srt',
    created_at: 8,
  }
  let board: VideoBoardDocument | null = options.canvas
    ? {
        version: 1 as const,
        revision: boardRevision,
        updated_at: 4,
        viewport: { x: 60, y: 70, scale: 0.85 },
        groups: [],
        nodes: [
          {
            id: 'node-image-first',
            kind: 'image',
            x: 80,
            y: 140,
            width: 280,
            height: 280,
            z: 1,
            assetId: 'asset-image',
            title: 'reading-room.png',
          },
          {
            id: 'node-image-last',
            kind: 'image',
            x: 80,
            y: 480,
            width: 280,
            height: 280,
            z: 2,
            assetId: 'asset-image',
            title: 'reading-room.png',
          },
          {
            id: 'node-audio',
            kind: 'audio',
            x: 80,
            y: 840,
            width: 240,
            height: 96,
            z: 3,
            assetId: 'asset-audio',
            title: 'room-tone.mp3',
          },
          {
            id: 'node-generate',
            kind: 'generate',
            x: 480,
            y: 260,
            width: 320,
            height: 292,
            z: 4,
            prompt: 'Morning light crosses a quiet reading room',
            operation: 'image_to_video',
            ratio: '16:9',
            resolution: '1080p',
            seconds: 8,
          },
        ],
        edges: [],
      }
    : null
  const assets: VideoAsset[] = [
    {
      id: 'asset-image',
      project_id: 'project-1',
      kind: 'image',
      mime_type: 'image/png',
      filename: 'reading-room.png',
      size_bytes: 182400,
      sha256: 'abc',
      created_at: 1,
      width: 1280,
      height: 720,
    },
    {
      id: 'asset-audio',
      project_id: 'project-1',
      kind: 'audio',
      mime_type: 'audio/mpeg',
      filename: 'room-tone.mp3',
      size_bytes: 84000,
      sha256: 'def',
      created_at: 2,
      duration: 12,
    },
  ]
  if (options.exportFlow || options.timeline) {
    assets.push({
      id: 'asset-video-out',
      project_id: 'project-1',
      kind: 'video',
      mime_type: 'video/mp4',
      filename: 'opening-light.mp4',
      size_bytes: 1_204_800,
      sha256: 'vout',
      created_at: 3,
      width: 1920,
      height: 1080,
      duration: 8,
    })
  }
  if (options.variants && !assets.some(asset => asset.id === 'asset-video-out')) {
    assets.push({
      id: 'asset-video-out',
      project_id: 'project-1',
      kind: 'video',
      mime_type: 'video/mp4',
      filename: 'opening-light.mp4',
      size_bytes: 1_204_800,
      sha256: 'vout',
      created_at: 3,
      width: 1920,
      height: 1080,
      duration: 8,
    })
  }
  const keyframeAsset: VideoAsset = {
    id: 'asset-keyframe',
    project_id: 'project-1',
    kind: 'image',
    mime_type: 'image/png',
    filename: 'opening-light-first-frame.png',
    size_bytes: 96_400,
    sha256: 'kf',
    created_at: 4,
    width: 1280,
    height: 720,
  }
  const voiceoverAsset: VideoAsset = {
    id: 'asset-voiceover',
    project_id: 'project-1',
    kind: 'audio',
    mime_type: 'audio/mpeg',
    filename: 'opening-light-narration.mp3',
    size_bytes: 42_000,
    sha256: 'vo',
    created_at: 5,
    duration: 7.5,
  }
  const finalAsset: VideoAsset = {
    id: 'asset-final',
    project_id: 'project-1',
    kind: 'video',
    mime_type: 'video/mp4',
    filename: 'launch-film-final.mp4',
    size_bytes: 2_640_000,
    sha256: 'fin',
    created_at: 6,
    width: 1280,
    height: 720,
    duration: 8,
  }
  const keyframeRequests: Array<Record<string, unknown>> = []
  const voiceoverRequests: Array<Record<string, unknown>> = []
  const composeRequests: Array<Record<string, unknown>> = []
  const rerollRequests: Array<Record<string, unknown>> = []
  const bindRequests: Array<Record<string, unknown>> = []
  let composeJob: VideoJob | null = null
  let characters: VideoCharacter[] = []
  const characterCreates: Array<Record<string, unknown>> = []
  const characterPatches: Array<Record<string, unknown>> = []
  const characterDeletes: string[] = []
  const threeViewRequests: Array<Record<string, unknown>> = []
  const threeViewAsset: VideoAsset = {
    id: 'asset-three-view',
    project_id: 'project-1',
    kind: 'image',
    mime_type: 'image/png',
    filename: 'aya-three-view.png',
    size_bytes: 128_400,
    sha256: 'tv',
    created_at: 7,
    width: 1536,
    height: 512,
  }

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname
    const method = request.method()
    if (pathname === '/api/v1/settings') return json(route, { catalog: { models: [] } })
    if (pathname === '/api/v1/video-studio/models') {
      return json(route, { options: withModels ? [baseModel, fastModel] : [], selected: 'google-main:veo-3' })
    }
    if (pathname === '/api/v1/video-studio/projects' && method === 'GET') {
      return json(route, { projects: [
        { id: 'project-1', title: 'Launch Film', created_at: 1, updated_at: 2 },
        { id: 'project-2', title: 'Agent Opened Project', created_at: 2, updated_at: 3 },
      ] })
    }
    if (pathname === '/api/v1/video-studio/projects/project-2' && method === 'GET') {
      return json(route, { id: 'project-2', title: 'Agent Opened Project', created_at: 2, updated_at: 3 })
    }
    if (pathname === '/api/v1/video-studio/projects/project-2/assets') {
      return json(route, { assets: [], next_cursor: null })
    }
    if (pathname === '/api/v1/video-studio/projects/project-2/jobs' && method === 'GET') {
      return json(route, { jobs: [], next_cursor: null })
    }
    if (pathname === '/api/v1/video-studio/projects/project-2/storyboard' && method === 'GET') {
      return json(route, { version: 1, revision: 0, shots: [], updated_at: 3 })
    }
    if (pathname === '/api/v1/video-studio/projects/project-1' && method === 'GET') {
      return json(route, { id: 'project-1', title: 'Launch Film', created_at: 1, updated_at: 2 })
    }
    if (pathname === '/api/v1/video-studio/projects/project-1/assets') {
      return json(route, { assets, next_cursor: null })
    }
    if (pathname === '/api/v1/video-studio/projects/project-1/jobs' && method === 'GET') {
      return json(route, { jobs, next_cursor: null })
    }
    if (pathname === '/api/v1/video-studio/projects/project-1/storyboard' && method === 'GET') {
      if (conflictSent) {
        storyboard = {
          ...storyboard,
          revision,
          shots: [
            ...storyboard.shots.filter(shot => shot.id !== 'shot-local-conflict'),
            {
              id: 'shot-remote',
              order: storyboard.shots.length,
              title: 'Remote insert',
              prompt: 'A collaborator added this shot',
              input_asset_ids: [],
              job_id: null,
              output_asset_id: null,
              duration: 4,
              notes: null,
              transition: null,
            },
          ].map((shot, index) => ({ ...shot, order: index })),
        }
      }
      return json(route, storyboard)
    }
    if (pathname === '/api/v1/video-studio/projects/project-1/storyboard' && method === 'PUT') {
      const body = request.postDataJSON()
      if (!conflictSent && wantsConflict) {
        conflictSent = true
        revision += 1
        return json(
          route,
          {
            detail: {
              code: 'storyboard_revision_conflict',
              message: 'The storyboard changed since it was loaded.',
              expected_revision: body.revision,
              current_revision: revision,
            },
          },
          409
        )
      }
      revision += 1
      storyboard = { ...body, revision, updated_at: Date.now() }
      return json(route, storyboard)
    }
    if (pathname === '/api/v1/video-studio/projects/project-1/jobs' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      createdRequests.push(body)
      const created = {
        id: `job-created-${createdRequests.length}`,
        project_id: 'project-1',
        operation: body.operation,
        status: 'queued',
        progress: 0,
        stage: 'Queued',
        prompt: body.prompt,
        profile_id: body.profile_id,
        model_id: body.model_id,
        parameters: body.parameters,
        input_asset_ids: body.input_asset_ids,
        output_asset_ids: [],
        created_at: Date.now(),
      }
      jobs.unshift(created as VideoJob)
      return json(route, created, 202)
    }
    if (pathname === '/api/v1/video-studio/projects/project-1/board' && method === 'GET' && board) {
      return json(route, board)
    }
    if (pathname === '/api/v1/video-studio/projects/project-1/board' && method === 'PUT' && board) {
      const body = request.postDataJSON() as Record<string, unknown>
      boardPuts.push(body)
      boardRevision += 1
      board = { ...board, ...(body as object), revision: boardRevision, updated_at: Date.now() }
      return json(route, board)
    }
    if (pathname === '/api/v1/video-studio/ffmpeg/status') {
      return json(route, {
        available: Boolean(options.exportFlow),
        source: options.exportFlow ? 'BUNDLED' : null,
        version: '7.1.1',
        install_supported: true,
        download_bytes: 84_000_000,
      })
    }
    if (
      pathname === '/api/v1/video-studio/projects/project-1/storyboard/shots/shot-opening/keyframe' &&
      method === 'POST'
    ) {
      const body = request.postDataJSON() as Record<string, unknown>
      keyframeRequests.push(body)
      revision += 1
      storyboard = {
        ...storyboard,
        revision,
        updated_at: Date.now(),
        shots: storyboard.shots.map(shot =>
          shot.id === 'shot-opening'
            ? { ...shot, keyframe_asset_id: keyframeAsset.id, keyframe_prompt: String(body.prompt || '') }
            : shot
        ),
      }
      if (!assets.some(asset => asset.id === keyframeAsset.id)) assets.push(keyframeAsset)
      return json(route, { asset: keyframeAsset, image_job_id: 'job-kf-1', storyboard }, 201)
    }
    if (
      pathname === '/api/v1/video-studio/projects/project-1/storyboard/shots/shot-opening/voiceover' &&
      method === 'POST'
    ) {
      const body = request.postDataJSON() as Record<string, unknown>
      voiceoverRequests.push(body)
      revision += 1
      storyboard = {
        ...storyboard,
        revision,
        updated_at: Date.now(),
        shots: storyboard.shots.map(shot =>
          shot.id === 'shot-opening'
            ? {
                ...shot,
                voiceover_asset_id: voiceoverAsset.id,
                voiceover_text: String(body.text || ''),
                voiceover_voice: String(body.voice || ''),
              }
            : shot
        ),
      }
      if (!assets.some(asset => asset.id === voiceoverAsset.id)) assets.push(voiceoverAsset)
      return json(route, { asset: voiceoverAsset, duration: voiceoverAsset.duration, storyboard }, 201)
    }
    if (pathname === '/api/v1/video-studio/projects/project-1/compose' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      composeRequests.push(body)
      const queued: VideoJob = {
        id: 'job-compose-1',
        project_id: 'project-1',
        operation: 'compose' as VideoJob['operation'],
        status: 'queued',
        progress: 0,
        stage: 'Queued locally',
        prompt: '',
        profile_id: 'local',
        model_id: 'ffmpeg',
        parameters: {},
        input_asset_ids: [],
        output_asset_ids: [],
        created_at: Date.now(),
      }
      jobs.unshift(queued)
      // The follower's first job GET sees the finished compose so the flow
      // converges without a real ffmpeg behind the route mock.
      composeJob = {
        ...queued,
        status: 'succeeded',
        progress: 1,
        stage: null,
        finished_at: Date.now(),
        output_asset_ids: [finalAsset.id],
      }
      return json(route, queued, 202)
    }
    if (pathname === '/api/v1/video-studio/projects/project-1/compositions') {
      return json(route, {
        compositions: composeJob?.status === 'succeeded'
          ? [{ job: composeJob, asset: finalAsset }]
          : [],
      })
    }
    // Phase D2: subtitle editor saves the SRT document as a project asset.
    if (pathname === '/api/v1/video-studio/projects/project-1/subtitle-assets' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      subtitleSaves.push(body)
      subtitleRevision += 1
      subtitleContent = String(body.content || '')
      if (!assets.some(asset => asset.id === subtitleAsset.id)) {
        assets.push({ ...subtitleAsset, filename: String(body.filename || 'subtitles.srt') })
      }
      return json(route, { asset: { ...subtitleAsset, filename: String(body.filename || 'subtitles.srt') } }, 201)
    }
    const subtitleUpdateMatch = pathname.match(/^\/api\/v1\/video-studio\/assets\/([^/]+)\/subtitle$/)
    if (subtitleUpdateMatch && method === 'PUT') {
      const body = request.postDataJSON() as Record<string, unknown>
      subtitleUpdates.push(body)
      subtitleRevision += 1
      subtitleContent = String(body.content || '')
      return json(route, { asset: { ...subtitleAsset, filename: String(body.filename || 'subtitles.srt') } })
    }
    if (pathname === '/api/v1/video-studio/assets/asset-srt-1/content') {
      return route.fulfill({ status: 200, contentType: 'application/x-subrip', body: subtitleContent })
    }
    // Phase C5: read-only variant history for one shot, newest first.
    const shotJobsMatch = pathname.match(
      /^\/api\/v1\/video-studio\/projects\/([^/]+)\/storyboard\/shots\/([^/]+)\/jobs$/
    )
    if (shotJobsMatch && method === 'GET') {
      return json(route, {
        jobs: jobs
          .filter(job => job.storyboard_shot_id === shotJobsMatch[2])
          .sort((left, right) => (left.created_at < right.created_at ? 1 : -1)),
      })
    }
    // Phase C5: free switch — republish a historical take as the shot output.
    const bindJobMatch = pathname.match(
      /^\/api\/v1\/video-studio\/projects\/([^/]+)\/storyboard\/shots\/([^/]+)\/bind-job$/
    )
    if (bindJobMatch && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      bindRequests.push(body)
      const outputs = jobs.find(job => job.id === body.job_id)?.output_asset_ids || []
      revision += 1
      storyboard = {
        ...storyboard,
        revision,
        updated_at: Date.now(),
        shots: storyboard.shots.map(shot =>
          shot.id === bindJobMatch[2]
            ? { ...shot, job_id: String(body.job_id || ''), output_asset_id: outputs[0] ?? null }
            : shot
        ),
      }
      return json(route, { shot: storyboard.shots.find(shot => shot.id === bindJobMatch[2]) })
    }
    // Phase C5: paid reroll — same parameters (camera included), fresh seed.
    const rerollMatch = pathname.match(/^\/api\/v1\/video-studio\/jobs\/([^/]+)\/reroll$/)
    if (rerollMatch && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      rerollRequests.push(body)
      const old = jobs.find(job => job.id === rerollMatch[1])
      const rerolled: VideoJob = {
        id: `job-rerolled-${rerollRequests.length}`,
        project_id: 'project-1',
        operation: old?.operation ?? 'image_to_video',
        status: 'queued',
        progress: 0,
        stage: 'Queued',
        prompt: old?.prompt ?? '',
        profile_id: old?.profile_id ?? 'google-main',
        model_id: old?.model_id ?? 'veo-3',
        parameters: { ...(old?.parameters || {}), seed: 100 + rerollRequests.length },
        input_asset_ids: [],
        output_asset_ids: [],
        storyboard_shot_id: (body.storyboard_shot_id as string) || old?.storyboard_shot_id || null,
        board_node_id: (body.board_node_id as string) || old?.board_node_id || null,
        created_at: Date.now(),
      }
      jobs.unshift(rerolled)
      if (rerolled.storyboard_shot_id) {
        revision += 1
        storyboard = {
          ...storyboard,
          revision,
          updated_at: Date.now(),
          shots: storyboard.shots.map(shot =>
            shot.id === rerolled.storyboard_shot_id
              ? { ...shot, job_id: rerolled.id, output_asset_id: null }
              : shot
          ),
        }
      }
      return json(route, rerolled, 202)
    }
    const eventMatch = pathname.match(/^\/api\/v1\/video-studio\/jobs\/([^/]+)\/events$/)
    if (eventMatch) return json(route, { events: [], next_seq: Number(url.searchParams.get('after_seq') || 0) })
    const jobMatch = pathname.match(/^\/api\/v1\/video-studio\/jobs\/([^/]+)$/)
    if (jobMatch && method === 'GET') {
      if (jobMatch[1] === 'job-compose-1' && composeJob) return json(route, composeJob)
      return json(route, jobs.find(job => job.id === jobMatch[1]) || jobs[0])
    }
    if (pathname === '/api/v1/video-studio/assets/asset-final' && method === 'GET') {
      return json(route, finalAsset)
    }
    if (pathname === '/api/v1/video-studio/assets/asset-video-out/content') {
      return route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('mock-mp4-out') })
    }
    if (pathname === '/api/v1/video-studio/assets/asset-keyframe/content') {
      return route.fulfill({ status: 200, contentType: 'image/png', body: png })
    }
    if (pathname === '/api/v1/video-studio/assets/asset-voiceover/content') {
      return route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.from('mock-voiceover') })
    }
    if (pathname === '/api/v1/video-studio/assets/asset-final/content') {
      return route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('mock-mp4-final') })
    }
    if (pathname === '/api/v1/video-studio/assets/asset-image/content') {
      return route.fulfill({ status: 200, contentType: 'image/png', body: png })
    }
    if (pathname === '/api/v1/video-studio/assets/asset-three-view/content') {
      return route.fulfill({ status: 200, contentType: 'image/png', body: png })
    }
    // Phase B: character library CRUD + paid three-view generation.
    const characterListMatch = pathname.match(/^\/api\/v1\/video-studio\/projects\/([^/]+)\/characters$/)
    if (characterListMatch && method === 'GET') {
      return json(route, { characters: characterListMatch[1] === 'project-1' ? characters : [] })
    }
    if (characterListMatch && characterListMatch[1] === 'project-1' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      characterCreates.push(body)
      const created: VideoCharacter = {
        id: 'char-1',
        project_id: 'project-1',
        name: String(body.name || ''),
        description: String(body.description || ''),
        reference_asset_ids: Array.isArray(body.reference_asset_ids)
          ? (body.reference_asset_ids as string[])
          : [],
        three_view_asset_id: null,
        voice_hint: String(body.voice_hint || ''),
        created_at: 7,
        updated_at: 7,
      }
      characters = [...characters, created]
      return json(route, { character: created }, 201)
    }
    const characterItemMatch = pathname.match(
      /^\/api\/v1\/video-studio\/projects\/project-1\/characters\/([^/]+)$/
    )
    if (characterItemMatch && method === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>
      characterPatches.push(body)
      characters = characters.map(item =>
        item.id === characterItemMatch[1]
          ? { ...item, ...body, updated_at: 8 } as VideoCharacter
          : item
      )
      return json(route, { character: characters.find(item => item.id === characterItemMatch[1]) })
    }
    if (characterItemMatch && method === 'DELETE') {
      characterDeletes.push(characterItemMatch[1])
      characters = characters.filter(item => item.id !== characterItemMatch[1])
      return route.fulfill({ status: 204 })
    }
    const threeViewMatch = pathname.match(
      /^\/api\/v1\/video-studio\/projects\/project-1\/characters\/([^/]+)\/three-view$/
    )
    if (threeViewMatch && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      threeViewRequests.push(body)
      if (!assets.some(asset => asset.id === threeViewAsset.id)) assets.push(threeViewAsset)
      characters = characters.map(item =>
        item.id === threeViewMatch[1]
          ? { ...item, three_view_asset_id: threeViewAsset.id, updated_at: 9 }
          : item
      )
      return json(
        route,
        {
          asset: threeViewAsset,
          character: characters.find(item => item.id === threeViewMatch[1]),
          image_job_id: 'job-tv-1',
        },
        201
      )
    }
    return json(route, { sessions: [], items: [], options: [] })
  })
  return {
    get storyboard() { return storyboard },
    get characters() { return characters },
    get subtitleContent() { return subtitleContent },
    get subtitleRevision() { return subtitleRevision },
    createdRequests,
    boardPuts,
    keyframeRequests,
    voiceoverRequests,
    composeRequests,
    rerollRequests,
    bindRequests,
    characterCreates,
    characterPatches,
    characterDeletes,
    threeViewRequests,
    subtitleSaves,
    subtitleUpdates,
  }
}

/** Drag a board node's connect handle onto another node (§5.4 connect flow). */
async function dragConnect(page: Page, fromNodeId: string, toNodeId: string) {
  const handle = page.locator(`[data-video-handle="${fromNodeId}"]`)
  const target = page.locator(`[data-video-node-id="${toNodeId}"]`)
  await expect(handle).toBeVisible()
  const from = await handle.boundingBox()
  const to = await target.boundingBox()
  if (!from || !to) throw new Error(`connect drag boxes missing for ${fromNodeId} -> ${toNodeId}`)
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 16 })
  await page.mouse.up()
}

/** §5.6: the canvas stage fills its usable container and never widens the page. */
async function stageMetrics(page: Page) {
  return page.evaluate(() => {
    const stage = document.querySelector('[data-video-board-stage]')
    const parent = stage?.parentElement
    if (!stage || !parent) return null
    const rect = stage.getBoundingClientRect()
    return {
      fills: parent.getBoundingClientRect().width - rect.width < 1,
      noHScroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      width: Math.round(rect.width),
    }
  })
}

async function expectCanvasFills(page: Page) {
  await expect(async () => {
    const metrics = await stageMetrics(page)
    expect(metrics && metrics.fills, `stage width ${metrics?.width}`).toBe(true)
    expect(metrics && metrics.noHScroll).toBe(true)
  }).toPass({ timeout: 5000 })
}

test.beforeAll(async () => {
  await mkdir(screenshotDir, { recursive: true })
})

test('complete workbench handles model changes, CAS conflicts, confirmation, and responsive drawers', async ({ page }) => {
  const state = await mockVideoStudio(page, true)
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/video-studio')
  await expect(page.getByRole('heading', { name: 'Video Studio' })).toBeVisible()
  await expect(page.getByText('v1.0.0', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Video project', { exact: true })).toHaveValue('project-1')
  await expect(page.getByText('Generation queue')).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-1600-full-v1.0.0.png') })

  await page.locator('summary[aria-label="Select video model"]').click()
  await page.getByRole('button', { name: /Cinematic Fast/ }).click()
  await expect(page.getByLabel('Duration')).toHaveValue('6')
  // Scope to the prompt composer: the export panel adds a second "Resolution" combobox.
  await expect(
    page.getByRole('region', { name: 'Video prompt composer' }).getByLabel('Resolution')
  ).toHaveValue('720p')
  await expect(page.getByText(/scheduled to stop working/i)).toBeVisible()

  await page.getByRole('button', { name: 'Add shot' }).click()
  await expect(page.getByText(/latest version was loaded/i)).toBeVisible()

  await page.getByLabel('Video prompt', { exact: true }).fill('A paper bird rises through soft window light')
  const generate = page.getByRole('button', { name: 'Generate shot' })
  await expect(generate).toBeDisabled()
  await page.getByRole('checkbox', { name: /paid provider credits/ }).check()
  await expect(generate).toBeEnabled()
  await generate.evaluate(button => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await expect(page.getByText('A paper bird rises through soft window light').first()).toBeVisible()
  await expect.poll(() => state.createdRequests.length).toBe(1)
  expect(state.createdRequests[0].confirmed_cost).toBe(true)
  expect(state.createdRequests[0].client_request_id).toEqual(expect.any(String))
  expect(state.createdRequests[0].storyboard_shot_id).toEqual(expect.any(String))
  await expect.poll(() => state.storyboard.shots.filter(shot => shot.prompt === 'A paper bird rises through soft window light').length).toBe(1)

  await page.setViewportSize({ width: 1024, height: 820 })
  await page.getByRole('button', { name: 'Open project assets' }).click()
  await expect(page.getByRole('button', { name: 'Close project assets' })).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-1024-assets-drawer.png') })
  await page.getByRole('button', { name: 'Close project assets' }).click()
  await page.getByRole('button', { name: 'Open generation queue' }).click()
  await expect(page.getByRole('button', { name: 'Close generation queue' })).toBeVisible()
  await expect(page.getByText(/供应商拒绝了这个视频任务/).last()).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-1024-queue-drawer.png') })
})

test('agent deep links open the requested project only when it belongs to the list', async ({ page }) => {
  await mockVideoStudio(page, true)
  await page.goto('/video-studio?project=project-2')
  await expect(page.getByLabel('Video project', { exact: true })).toHaveValue('project-2')
  await expect(page.getByLabel('Project title')).toHaveValue('Agent Opened Project')
})

test('current production build renders the complete workbench in Chinese with the 1.0.0 badge', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('knorvia-language', 'zh')
  })
  await mockVideoStudio(page, true)
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/video-studio')
  await expect(page.getByRole('heading', { name: '视频创作' })).toBeVisible()
  await expect(page.getByText('v1.0.0', { exact: true })).toBeVisible()
  await expect(page.getByText('生成队列')).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-1600-zh-v1.0.0.png') })
})

test('no-model state stays useful at 1366px', async ({ page }) => {
  await mockVideoStudio(page, false)
  await page.setViewportSize({ width: 1366, height: 900 })
  await page.goto('/video-studio')
  await expect(page.getByText('No video model is configured yet.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Configure video model' }).first()).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-1366-no-model.png') })
})

test('canvas mode connects first and last frames and captures 1600px / 1024px screenshots', async ({ page }) => {
  const state = await mockVideoStudio(page, true, { canvas: true })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/video-studio')
  // A board with content opens on the canvas (§5.2); the view toggle still works.
  const stage = page.locator('[data-video-board-stage]')
  await expect(stage).toBeVisible()
  const generateCard = page.locator('[data-video-node-id="node-generate"]')
  await expect(page.locator('[data-video-node-id="node-image-first"]')).toBeVisible()
  await expect(page.locator('[data-video-node-id="node-image-last"]')).toBeVisible()
  await expect(generateCard).toBeVisible()
  await page.getByRole('tab', { name: 'Storyboard' }).click()
  await expect(page.getByLabel('Video prompt', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Canvas' }).click()
  await expect(stage).toBeVisible()

  // Image → generate connects as first-frame by default (§5.4).
  await dragConnect(page, 'node-image-first', 'node-generate')
  await expect(page.locator('svg text', { hasText: 'First frame' })).toHaveCount(1)

  // A second image also lands as first-frame; its edge badge cycles to last-frame.
  await dragConnect(page, 'node-image-last', 'node-generate')
  await expect(page.locator('svg text', { hasText: 'First frame' })).toHaveCount(2)
  await page.locator('svg text', { hasText: 'First frame' }).nth(1).click()
  await expect(page.locator('svg text', { hasText: 'Last frame' })).toHaveCount(1)
  await expect(page.locator('svg text', { hasText: 'First frame' })).toHaveCount(1)
  // The CAS save chain persists both roles.
  await expect.poll(() =>
    state.boardPuts.some(body => {
      const edges = Array.isArray(body.edges) ? (body.edges as Array<{ role?: unknown }>) : []
      return edges.some(edge => edge.role === 'first-frame') && edges.some(edge => edge.role === 'last-frame')
    })
  ).toBe(true)
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-canvas-1600.png') })

  await page.setViewportSize({ width: 1024, height: 820 })
  await expectCanvasFills(page)
  await page.getByRole('button', { name: 'Fit view' }).click()
  await expect(generateCard).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-canvas-1024.png') })

  // §5.6 mobile canvas: below md the workspace sidebar collapses, so the stage
  // spans the full viewport width and stays interactive.
  await page.setViewportSize({ width: 390, height: 844 })
  await expectCanvasFills(page)
  expect((await stageMetrics(page))?.width).toBe(390)
  await page.getByRole('button', { name: 'Fit view' }).click()
  await expect(generateCard).toBeVisible()
  await generateCard.click()
  await expect(page.getByRole('button', { name: 'Delete', exact: true }).first()).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-canvas-390.png') })
})

test('job deep link opens the canvas and centers the linked node', async ({ page }) => {
  await mockVideoStudio(page, true, { canvas: true, boardJob: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/video-studio?project=project-1&job=job-canvas')
  const stage = page.locator('[data-video-board-stage]')
  await expect(stage).toBeVisible()
  const node = page.locator('[data-video-node-id="node-generate"]')
  await expect(node).toBeVisible()
  // §5.8: the linked node is selected …
  await expect(node.locator('div.rounded-2xl')).toHaveClass(/ring-2 ring-\[var\(--primary\)\]/)
  // … centered in the viewport, with its running job mirrored onto the card.
  const stageBox = await stage.boundingBox()
  const nodeBox = await node.boundingBox()
  if (!stageBox || !nodeBox) throw new Error('job focus boxes missing')
  expect(Math.abs(stageBox.x + stageBox.width / 2 - (nodeBox.x + nodeBox.width / 2))).toBeLessThan(4)
  expect(Math.abs(stageBox.y + stageBox.height / 2 - (nodeBox.y + nodeBox.height / 2))).toBeLessThan(4)
  await expect(node.getByText('Running').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close generation queue' })).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-canvas-job-focus-1440.png') })
})

test('shot extras: two-step paid keyframe and narration land on the selected shot', async ({ page }) => {
  const state = await mockVideoStudio(page, true, { conflict: false })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/video-studio')
  // Select the shot so its detail editor opens.
  await page.getByRole('button', { name: /Opening light/ }).first().click()
  await expect(page.getByText('First-frame keyframe')).toBeVisible()

  // First click arms the paid guard, second click on the same button confirms.
  await page.getByRole('button', { name: 'Generate keyframe' }).click()
  const confirmKeyframe = page.getByRole('button', { name: 'Confirm — paid' }).first()
  await expect(confirmKeyframe).toBeVisible()
  await confirmKeyframe.click()
  await expect.poll(() => state.keyframeRequests.length).toBe(1)
  expect(state.keyframeRequests[0].confirmed_cost).toBe(true)
  // The bound keyframe renders as the shot thumbnail with its badges.
  await expect(page.locator('img[alt="Opening light"]')).toBeVisible()
  await expect(page.getByText('Bound as first-frame input')).toBeVisible()
  await expect(page.getByText('Keyframe', { exact: true })).toBeVisible()

  // Narration needs text, then the same two-step paid guard.
  await page.getByPlaceholder('Narration text for this shot').fill('Morning light answers the quiet room.')
  await page.getByPlaceholder('Voice').fill('narrator-female')
  await page.getByRole('button', { name: 'Generate narration' }).click()
  await expect(page.getByRole('button', { name: 'Confirm — paid' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Confirm — paid' }).first().click()
  await expect.poll(() => state.voiceoverRequests.length).toBe(1)
  expect(state.voiceoverRequests[0].confirmed_cost).toBe(true)
  expect(state.voiceoverRequests[0].text).toBe('Morning light answers the quiet room.')
  expect(state.voiceoverRequests[0].voice).toBe('narrator-female')
  // The bound narration plays inline and the strip card shows the badge.
  await expect(page.locator('audio')).toBeVisible()
  await expect(page.getByText('Voiced', { exact: true })).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-shot-extras-1600.png') })
})

test('variants: paid reroll needs the two-step guard, history lists takes, switching is free', async ({ page }) => {
  const state = await mockVideoStudio(page, true, {
    canvas: true,
    boardJob: true,
    variants: true,
    conflict: false,
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/video-studio')
  // The seeded board opens on the canvas: the generate card carries one take.
  const generateCard = page.locator('[data-video-node-id="node-generate"]')
  await expect(generateCard.getByText('×1')).toBeVisible()

  // Storyboard side: the shot editor lists both takes, newest first, with seeds.
  await page.getByRole('tab', { name: 'Storyboard' }).click()
  await page.getByRole('button', { name: /Opening light/ }).first().click()
  await expect(page.getByText('Variant history')).toBeVisible()
  await expect(page.getByText('2 version(s)')).toBeVisible()
  await expect(page.getByText('Current', { exact: true })).toBeVisible()
  await expect(page.getByText('Seed 7')).toBeVisible()
  const v1Row = page.locator('li', { hasText: 'Seed 424242' })
  await expect(v1Row).toBeVisible()

  // Paid reroll: arming alone never submits; confirming sends one paid task.
  await page.getByRole('checkbox', { name: /paid provider credits/ }).check()
  await page.getByRole('button', { name: 'Generate another version' }).first().click()
  await expect(page.getByRole('button', { name: 'Confirm — paid' })).toBeVisible()
  expect(state.rerollRequests.length).toBe(0)
  await page.getByRole('button', { name: 'Confirm — paid' }).click()
  await expect.poll(() => state.rerollRequests.length).toBe(1)
  expect(state.rerollRequests[0].confirmed_cost).toBe(true)
  expect(state.rerollRequests[0].storyboard_shot_id).toBe('shot-opening')
  expect(state.rerollRequests[0].client_request_id).toEqual(expect.any(String))
  // The fresh take heads the history with its new seed and becomes current.
  await expect(page.getByText('3 version(s)')).toBeVisible()
  await expect(page.getByText('Seed 101')).toBeVisible()

  // Switching back to the finished take is free — no confirm, one call, no reroll.
  await v1Row.getByRole('button', { name: 'Set as current' }).click()
  await expect.poll(() => state.bindRequests.length).toBe(1)
  expect(state.bindRequests[0].job_id).toBe('job-v1')
  expect(state.rerollRequests.length).toBe(1)
  await expect(v1Row.getByText('Current', { exact: true })).toBeVisible()

  // Canvas: the same two-step guard rerolls the card's take and bumps the badge.
  await page.getByRole('tab', { name: 'Canvas' }).click()
  await expect(generateCard).toBeVisible()
  await generateCard.getByRole('button', { name: 'Generate another version' }).click()
  await expect(generateCard.getByRole('button', { name: 'Confirm — paid' })).toBeVisible()
  await generateCard.getByRole('button', { name: 'Confirm — paid' }).click()
  await expect.poll(() => state.rerollRequests.length).toBe(2)
  expect(state.rerollRequests[1].board_node_id).toBe('node-generate')
  expect(state.rerollRequests[1].storyboard_shot_id).toBeUndefined()
  await expect(generateCard.getByText('×2')).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-variants-1600.png') })
})

test('export panel composes the free local MP4 with progress and finished playback', async ({ page }) => {
  const state = await mockVideoStudio(page, true, { conflict: false, exportFlow: true })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/video-studio')
  // The rendered shot makes the compose CTA live; ffmpeg is installed.
  await expect(page.getByRole('heading', { name: 'Export composition' })).toBeVisible()
  await expect(page.getByText('1 shot(s) ready')).toBeVisible()
  const compose = page.getByRole('button', { name: 'Compose MP4' })
  await expect(compose).toBeEnabled()
  await expect(page.getByText('Local composition engine is not installed')).toHaveCount(0)

  await compose.click()
  await expect.poll(() => state.composeRequests.length).toBe(1)
  const body = state.composeRequests[0] as {
    subtitle?: { mode?: string }
    audio?: { voiceovers?: boolean; bgm_asset_id?: string }
    output?: { resolution?: string }
    client_request_id?: string
  }
  expect(body.subtitle?.mode).toBe('from_notes')
  expect(body.audio?.voiceovers).toBe(true)
  expect(body.output?.resolution).toBe('720p')
  expect(body.client_request_id).toEqual(expect.any(String))

  // The finished composition lands in the panel with playback and download.
  await expect(page.getByText('Finished compositions')).toBeVisible()
  const player = page.locator('section[aria-label="Export composition"] video')
  await expect(player).toHaveCount(1)
  await expect(player).toHaveAttribute('src', /\/assets\/asset-final\/content$/)
  await expect(page.getByRole('link', { name: 'Download composition' })).toHaveAttribute(
    'href',
    /\/assets\/asset-final\/content$/
  )
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-export-1600.png') })
})

test('subtitle editor: cue table edits save an SRT asset and from_asset burns it with a style', async ({ page }) => {
  const state = await mockVideoStudio(page, true, { conflict: false, exportFlow: true })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/video-studio')
  const exportPanel = page.locator('section[aria-label="Export composition"]')

  // The editor starts collapsed inside the export panel; open it.
  await exportPanel.locator('summary', { hasText: 'Subtitle editor' }).click()
  const editor = exportPanel.locator('[data-subtitle-editor]')
  await expect(editor).toBeVisible()
  await expect(editor.getByText('1 cue(s)')).toBeVisible()

  // A fresh draft cue has empty text, so validation blocks the save.
  const save = editor.getByRole('button', { name: 'Save subtitles' })
  await expect(save).toBeDisabled()

  // Inline edits: timecode + text; the split (自动断句) turns one cue into two.
  await editor.locator('[data-cue-field="end"]').first().fill('00:00:04,000')
  await editor.locator('[data-cue-field="text"]').first().fill('Morning light crosses the room. The city wakes.')
  await editor.getByRole('button', { name: 'Split cue at sentence boundary' }).click()
  await expect(editor.getByText('2 cue(s)')).toBeVisible()
  await expect(save).toBeEnabled()

  // Remove the second cue again — add/remove keep the table coherent.
  await editor.getByRole('button', { name: 'Remove cue' }).nth(1).click()
  await expect(editor.getByText('1 cue(s)')).toBeVisible()

  // Saving adopts the SRT document as a subtitle project asset. The surviving
  // cue is the head of the split: the 4 s span divided by text weight
  // (31/46 ≈ 2.696 s) with the first sentence.
  await save.click()
  await expect.poll(() => state.subtitleSaves.length).toBe(1)
  expect(state.subtitleSaves[0].filename).toBe('subtitles.srt')
  expect(state.subtitleSaves[0].content).toBe(
    '1\n00:00:00,000 --> 00:00:02,696\nMorning light crosses the room.\n'
  )
  await expect(editor.getByText('Subtitles saved as a project asset.')).toBeVisible()
  // The save doubles as an in-place update once an asset is loaded.
  await expect(editor.getByRole('button', { name: 'Update subtitles' })).toBeVisible()

  // The saved file is selected for from_asset and burned with the chosen style.
  // (data-* scoping: label text includes the selects' option texts, so
  // getByLabel substring matches are ambiguous across the three selects.)
  const subtitleSource = exportPanel.locator('select[data-subtitle-mode]')
  await subtitleSource.selectOption('from_asset')
  const subtitleFile = exportPanel.locator('select[data-subtitle-asset]')
  await expect(subtitleFile).toBeVisible()
  await expect(subtitleFile).toHaveValue('asset-srt-1')
  await exportPanel.locator('select[data-subtitle-style]').selectOption('yellow_box')
  await exportPanel.getByRole('button', { name: 'Compose MP4' }).click()
  await expect.poll(() => state.composeRequests.length).toBe(1)
  const body = state.composeRequests[0] as {
    subtitle?: { mode?: string; style?: string; srt_asset_id?: string }
  }
  expect(body.subtitle).toEqual({ mode: 'from_asset', style: 'yellow_box', srt_asset_id: 'asset-srt-1' })
  await expect(exportPanel.getByText('Finished compositions')).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-subtitles-1600.png') })

  // from_asset without a picked file cannot fire a doomed composition.
  await subtitleFile.selectOption('')
  const compose = exportPanel.getByRole('button', { name: 'Compose MP4' })
  await expect(compose).toBeDisabled()
  await expect(exportPanel.getByText('Pick or save a subtitle file below, then compose.')).toBeVisible()
  // from_asr is advertised as the automatic (STT) caption source.
  await subtitleSource.selectOption('from_asr')
  await expect(compose).toBeEnabled()
  await compose.click()
  await expect.poll(() => state.composeRequests.length).toBe(2)
  expect((state.composeRequests[1] as { subtitle?: { mode?: string } }).subtitle?.mode).toBe('from_asr')
})

test('export options: §E2 burn-in size/colour and the §E5 experimental 1080p upscale ride along', async ({ page }) => {
  const state = await mockVideoStudio(page, true, { conflict: false, exportFlow: true })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/video-studio')
  const exportPanel = page.locator('section[aria-label="Export composition"]')
  await expect(exportPanel).toBeVisible()

  // The §E2 controls only exist while captions are on (from_notes default).
  const sizeInput = exportPanel.locator('input[data-subtitle-font-size]')
  const colourInput = exportPanel.locator('input[data-subtitle-colour]')
  await expect(sizeInput).toBeVisible()
  await expect(colourInput).toBeVisible()
  // Unset overrides show the preset-default affordance and nothing is sent.
  expect(await sizeInput.inputValue()).toBe('')
  await expect(exportPanel.getByText('Preset default').first()).toBeVisible()

  // Out-of-range sizes block the CTA with an inline explanation.
  await sizeInput.fill('99')
  const compose = exportPanel.getByRole('button', { name: 'Compose MP4' })
  await expect(compose).toBeDisabled()
  await expect(exportPanel.getByText('Subtitle size must be a whole number between 12 and 72.')).toBeVisible()
  await sizeInput.fill('48')
  await expect(compose).toBeEnabled()

  // The picker's #RRGGBB is shown as picked and converts on submit.
  await colourInput.fill('#ffe97f')
  await expect(exportPanel.getByText('#FFE97F')).toBeVisible()

  // The §E5 toggle is labelled experimental, locks the output to 1080p and warns.
  const upscale = exportPanel.locator('input[data-upscale-toggle]')
  await upscale.check()
  await expect(
    exportPanel.getByText(
      'Upscaling re-renders every sub-1080p shot frame by frame before stitching — much slower, output is locked to 1080p.'
    )
  ).toBeVisible()
  // Only the resolution select offers 480p; upscale pins it to 1080p and freezes it.
  const resolutionSelect = exportPanel.locator('select').filter({
    has: page.locator('option[value="480p"]'),
  })
  await expect(resolutionSelect).toBeDisabled()
  await expect(resolutionSelect).toHaveValue('1080p')

  await compose.click()
  await expect.poll(() => state.composeRequests.length).toBe(1)
  const body = state.composeRequests[0] as {
    subtitle?: { mode?: string; font_size?: number; primary_colour?: string }
    output?: { resolution?: string; upscale?: boolean }
  }
  expect(body.subtitle).toEqual({
    mode: 'from_notes',
    font_size: 48,
    primary_colour: '&H007FE9FF',
  })
  expect(body.output).toEqual({ resolution: '1080p', upscale: true })
  await expect(exportPanel.getByText('Finished compositions')).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-export-options-1600.png') })

  // Captions off removes the §E2 controls entirely — nothing leaks into a request.
  await exportPanel.locator('select[data-subtitle-mode]').selectOption('off')
  await expect(sizeInput).toHaveCount(0)
  await expect(colourInput).toHaveCount(0)
  await exportPanel.getByRole('button', { name: 'Compose MP4' }).click()
  await expect.poll(() => state.composeRequests.length).toBe(2)
  const bare = state.composeRequests[1] as {
    subtitle?: { mode?: string; font_size?: number; primary_colour?: string }
  }
  expect(bare.subtitle).toEqual({ mode: 'off' })
})

test('timeline: §F1 blocks mirror the cut, §E3 trim and reorder edit the storyboard, and the BGM band follows the compose panel', async ({ page }) => {
  const state = await mockVideoStudio(page, true, { conflict: false, timeline: true })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/video-studio')
  const timeline = page.locator('section[aria-label="Timeline"]')
  await expect(timeline).toBeVisible()

  // 8 s + (4 s − 0.5 s crossfade) + 4 s = 15.5 s cut: blocks and total agree.
  await expect(timeline.getByText('Total 16s')).toBeVisible()
  await expect(timeline.getByRole('button', { name: 'Shot 1 — 8s' })).toBeVisible()
  await expect(timeline.getByRole('button', { name: 'Shot 2 — 4s' })).toBeVisible()
  await expect(timeline.getByRole('button', { name: 'Shot 3 — 4s' })).toBeVisible()

  // The empty music bed advertises the lifted compose-panel selection.
  await expect(timeline.getByText('No music bed selected')).toBeVisible()
  const exportPanel = page.locator('section[aria-label="Export composition"]')
  const bgmSelect = exportPanel.locator('select').filter({ has: page.locator('option[value="asset-audio"]') })
  await bgmSelect.selectOption('asset-audio')
  await expect(timeline.getByText('Music bed')).toBeVisible()

  // §E3 keyboard trim: Shift+ArrowLeft on shot 1's out-handle eats one second.
  await timeline.getByRole('slider', { name: 'Trim end' }).first().focus()
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(timeline.getByRole('button', { name: 'Shot 1 — 7s' })).toBeVisible()
  // The storyboard PUT is debounced — poll until the patch lands.
  await expect.poll(() => state.storyboard.shots[0].trim_out).toBe(7)

  // Clicking a block selects its shot — the composer adopts its prompt.
  await timeline.getByRole('button', { name: 'Shot 2 — 4s' }).click()
  await expect(page.getByRole('textbox', { name: 'Video prompt' })).toHaveValue('Rooftops catch the first sun')

  // Drag block 1 past block 3: the storyboard reorders [city, close, opening].
  // Raw mouse events need the track scrolled into the viewport first.
  const firstBlock = timeline.getByRole('button', { name: 'Shot 1 — 7s' })
  await firstBlock.scrollIntoViewIfNeeded()
  const first = await firstBlock.boundingBox()
  const last = await timeline.getByRole('button', { name: 'Shot 3 — 4s' }).boundingBox()
  if (!first || !last) throw new Error('timeline block boxes missing for the reorder drag')
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 24 })
  await page.mouse.up()
  await expect(timeline.getByRole('button', { name: 'Shot 1 — 4s' }).first()).toBeVisible()
  await expect.poll(() => state.storyboard.shots.map(shot => shot.id)).toEqual(['shot-city', 'shot-close', 'shot-opening'])
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-timeline-1600.png') })
})

test('variants: §F2 drawer details diffs parameters, and §F5 unit prices drive cost estimates', async ({ page }) => {
  const state = await mockVideoStudio(page, true, {
    variants: true,
    exportFlow: true,
    conflict: false,
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/video-studio')

  // §F5: the user fills a ¥/s unit price on the active model in the picker.
  await page.getByLabel('Select video model').click()
  const priceInput = page.locator('[data-price-hint="google-main:veo-3"]')
  await priceInput.fill('0.5')
  await priceInput.blur()
  await expect(page.getByLabel('Select video model')).toContainText('¥0.5/s')

  // Estimates light up wherever the model billed seconds: the queue card and
  // the compose panel (8 s × ¥0.5 = ¥4.00) — composition itself stays free.
  await expect(page.locator('[data-job-cost]').first()).toContainText('Estimated ¥4.00 (at your unit price)')
  await expect(page.locator('[data-compose-cost]')).toContainText('Clip cost ¥4.00 (at your unit price)')

  // §F2: open the shot's variant drawer from the storyboard editor.
  await page.getByRole('button', { name: /Opening light/ }).first().click()
  await expect(page.getByText('Variant history')).toBeVisible()
  await page.getByRole('button', { name: 'Version details' }).click()
  const drawer = page.locator('[data-variant-drawer]')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('2 version(s)')).toBeVisible()

  // The current running take has no render time yet; the historical take
  // shows its wall-clock render, its parameter diff, and the §F5 estimate.
  await expect(drawer.getByText('Render time pending')).toBeVisible()
  const v1Row = drawer.locator('[data-variant-row="job-v1"]')
  await expect(v1Row.getByText('Rendered in 1:00')).toBeVisible()
  await expect(v1Row.getByText(/Seed: 7\s*→\s*424242/)).toBeVisible()
  await expect(v1Row.getByText(/Camera movement: —\s*→\s*dolly/)).toBeVisible()
  await expect(v1Row.locator('[data-variant-cost]')).toContainText('Estimated ¥4.00 (at your unit price)')

  // Binding from the drawer is free — one call, and the take becomes current.
  await v1Row.getByRole('button', { name: 'Set as current' }).click()
  await expect.poll(() => state.bindRequests.length).toBe(1)
  expect(state.bindRequests[0].job_id).toBe('job-v1')
  await expect(v1Row.getByText('Current', { exact: true })).toBeVisible()

  // Escape closes the overlay; the inline variant list keeps working.
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(page.getByText('2 version(s)')).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-variant-drawer-1600.png') })
})

test('character library: create, paid three-view guard, and canvas + composer injection', async ({ page }) => {
  const state = await mockVideoStudio(page, true, { canvas: true, conflict: false })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/video-studio')
  // The seeded board opens on the canvas; select the generate card so the
  // canvas injection wires a reference edge into it.
  await page.locator('[data-video-node-id="node-generate"]').click()

  // Left panel → Characters tab starts empty.
  await page.getByRole('tab', { name: 'Characters' }).click()
  await expect(page.getByText('No characters yet')).toBeVisible()

  // Create a character with one reference image.
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByLabel('Character name').fill('Aya')
  await page.getByLabel('Voice hint').fill('narrator-female')
  await page.getByRole('button', { name: 'Use reading-room.png as reference' }).click()
  await page.getByRole('button', { name: 'Create' }).click()
  await expect.poll(() => state.characterCreates.length).toBe(1)
  expect(state.characterCreates[0]).toMatchObject({
    name: 'Aya',
    voice_hint: 'narrator-female',
    reference_asset_ids: ['asset-image'],
  })
  await expect(page.getByText('Aya', { exact: true })).toBeVisible()
  await expect(page.getByText('Three-view pending')).toBeVisible()

  // Two-step paid guard: first click only arms, the confirm click fires.
  await page.getByRole('button', { name: 'Generate three-view' }).click()
  const confirm = page.getByRole('button', { name: 'Confirm paid generation?' })
  await expect(confirm).toBeVisible()
  expect(state.threeViewRequests).toHaveLength(0)
  await confirm.click()
  await expect.poll(() => state.threeViewRequests.length).toBe(1)
  expect(state.threeViewRequests[0].confirmed_cost).toBe(true)
  await expect(page.getByText('Three-view ready')).toBeVisible()

  // Injection ①: the three-view sheet lands on the canvas with a reference
  // edge into the selected generate card.
  await page.getByRole('button', { name: 'Add to canvas' }).click()
  await expect(page.locator('[data-video-board-stage]')).toBeVisible()
  await expect.poll(() =>
    state.boardPuts.some(body => {
      const nodes = Array.isArray(body.nodes)
        ? (body.nodes as Array<{ id?: unknown; kind?: unknown; assetId?: unknown }>)
        : []
      const edges = Array.isArray(body.edges)
        ? (body.edges as Array<{ from?: unknown; to?: unknown; role?: unknown }>)
        : []
      const seeded = nodes.find(node => node.kind === 'image' && node.assetId === 'asset-three-view')
      return Boolean(
        seeded &&
          edges.some(
            edge => edge.from === seeded.id && edge.to === 'node-generate' && edge.role === 'reference'
          )
      )
    })
  ).toBe(true)
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-character-canvas-1600.png') })

  // Injection ②: composer inputs pick up the character references under
  // image_to_video (text_to_video would sanitize image inputs away).
  await page.getByRole('tab', { name: 'Storyboard' }).click()
  await page
    .getByRole('region', { name: 'Video prompt composer' })
    .getByRole('button', { name: 'Image to video' })
    .click()
  await page.getByRole('button', { name: 'Add to composer' }).click()
  await expect(page.getByText('Character references added to the composer inputs.')).toBeVisible()
  await expect(page.getByLabel('Remove aya-three-view.png')).toBeVisible()
  await expect(page.getByLabel('Remove reading-room.png')).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-character-composer-1600.png') })

  // Deleting removes the character everywhere.
  await page.getByRole('button', { name: 'Delete Aya' }).click()
  await expect.poll(() => state.characterDeletes.length).toBe(1)
  expect(state.characterDeletes[0]).toBe('char-1')
  await expect(page.getByText('No characters yet')).toBeVisible()
})

/**
 * Same-origin protocol-playing stub that replaces the 73MB static director
 * desk bundle. It answers the host's postMessage RPCs (ready, capabilities,
 * timeline, project, export.frame) and records session/panorama pushes into
 * DOM markers the audit can read through the frame locator.
 */
const DIRECTOR_STUB_PNG = 'data:image/png;base64,' + png.toString('base64')

const DIRECTOR_STUB_HTML = [
  '<!doctype html><html><body><div id="sessions">none</div><div id="panorama">none</div><div id="rpc">none</div><script>',
  'var sessions = []; var panorama = []; var rpc = [];',
  'function post(type, payload) { parent.postMessage({ type: type, payload: payload }, "*") }',
  'function marker(id, value) { document.getElementById(id).textContent = JSON.stringify(value) }',
  'post("storyai:director-desk-ready", {});',
  'addEventListener("message", function (event) {',
  '  var data = event.data; if (!data || typeof data.type !== "string") return;',
  '  if (data.type === "storyai:director-desk-session") { sessions.push(data.payload); marker("sessions", sessions) }',
  '  if (data.type === "storyai:director-desk-panorama") { panorama.push({ fileName: data.payload.fileName, sourceNodeId: data.payload.sourceNodeId }); marker("panorama", panorama) }',
  '  if (data.type !== "storyai:director-desk:request") return;',
  '  var requestId = data.payload.requestId; var action = data.payload.action;',
  '  rpc.push(action); marker("rpc", rpc);',
  '  var data_ = null;',
  '  if (action === "capabilities.get") data_ = { protocolVersion: 1, projectSchemaVersion: 1, actions: ["capabilities.get", "project.get", "timeline.get", "export.frame", "export.video"], uiExports: [], protocolExports: [], assetPersistence: "browser" };',
  '  else if (action === "project.get") data_ = { protocolVersion: 1, projectSchemaVersion: 1, projectFingerprint: "stub-fp", project: { cameras: [], activeCameraId: null, assets: [] }, portability: { portable: true, browserLocalAssetIds: [], note: null } };',
  '  else if (action === "timeline.get") data_ = { protocolVersion: 1, progress: 0.5, timeSeconds: 4, durationSeconds: 8, playing: true, viewMode: "camera", activeCameraId: null };',
  '  else if (action === "export.frame") data_ = { dataUrl: STUB_PNG_PLACEHOLDER, fileName: "stub-frame.png", position: "current", width: 64, height: 64 };',
  '  if (data_ === null) { post("storyai:director-desk:response", { protocolVersion: 1, requestId: requestId, action: action, ok: false, error: { code: "unsupported", message: "stub does not implement " + action } }); return }',
  '  post("storyai:director-desk:response", { protocolVersion: 1, requestId: requestId, action: action, ok: true, data: data_ });',
  '});',
  '</script></body></html>',
].join('\n').replace('STUB_PNG_PLACEHOLDER', JSON.stringify(DIRECTOR_STUB_PNG))

test('director desk: third view mode wires the stubbed protocol iframe end to end', async ({ page }) => {
  await mockVideoStudio(page, true, { canvas: true, variants: true, conflict: false })
  await page.route('**/director-desk/index.html*', route =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: DIRECTOR_STUB_HTML }))
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/video-studio')
  await page.getByRole('tab', { name: 'Characters' }).click()
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByLabel('Character name').fill('Aya')
  await page.getByRole('button', { name: 'Use reading-room.png as reference' }).click()
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText('Aya', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Storyboard' }).click()
  await page.getByRole('button', { name: /Opening light/ }).first().click()

  // Third view mode mounts the desk iframe: project-scoped session id, no
  // camera/microphone capture grants, protocol-playing stub loads same-origin.
  await page.getByRole('tab', { name: 'White-model Previs' }).click()
  const toolbar = page.locator('[data-director-toolbar]')
  const iframe = page.locator('iframe[title="White-model Previs"]')
  const frame = page.frameLocator('iframe[title="White-model Previs"]')
  await expect(iframe).toBeVisible()
  await expect(iframe).toHaveAttribute('src', /instanceId=knorvia-video-project-1/)
  await expect(iframe).toHaveAttribute('allow', 'autoplay; fullscreen')

  // Stub ready → status flips, timeline pill lights up. Theme still follows
  // the app (Chrome audit is light → snow → desk theme is light) but lives
  // in the session handshake, not a second chrome row.
  await expect(toolbar.getByText('Ready', { exact: true })).toBeVisible()
  await expect(toolbar.getByText(/Playing/)).toBeVisible()
  await expect(page.getByLabel('Target shot')).toBeVisible()
  await expect(frame.locator('#sessions')).toContainText('"theme":"light"')

  // Export current frame: the stub answers export.frame, the PNG downloads,
  // and the frame becomes eligible for upload and keyframe handoff (upload
  // sessions stay unmocked here — handoff visibility only, no click).
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export current frame' }).click()
  expect((await download).suggestedFilename()).toBe('stub-frame.png')
  await expect(page.getByText('Current frame ready')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Upload as asset' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Set as shot keyframe' })).toBeVisible()

  // Character reference → panorama: the panel fetches the authenticated asset,
  // re-reads it as a data URL, and pushes it into the desk session.
  await page.getByText('More', { exact: true }).click()
  await page.getByLabel('Send a reference image to the white-model previs').selectOption('asset-image')
  await expect(
    frame.locator('#panorama')
  ).toContainText('character-ref-asset-image')
  await expect(frame.locator('#panorama')).toContainText('character-ref-asset-image.jpg')
  await page.screenshot({ path: path.join(screenshotDir, 'video-studio-director-desk-1600.png') })
})
