import { apiFetch, apiUrl, wsUrl } from '@/lib/api'

const BASE = '/api/v1/image-studio'

export type ImageModelOption = {
  profile_id: string
  model_id: string
  profile_name: string
  model_name: string
  model: string
  provider: string
  capabilities: {
    operations?: Array<'generate' | 'edit' | 'inpaint'>
    max_inputs?: number
    max_outputs?: number
    supports_mask?: boolean
    parameters?: string[]
  }
  defaults: Record<string, string>
  is_active_default: boolean
}

export type StudioProject = {
  id: string
  title: string
  created_at: number
  updated_at: number
}

export type StudioAsset = {
  id: string
  project_id: string
  kind: string
  mime: string
  size_bytes: number
  width: number
  height: number
  favorite: number
  created_at: number
}

export type StudioJob = {
  id: string
  project_id: string
  operation: 'generate' | 'edit' | 'inpaint'
  status: string
  prompt: string
  profile_id: string
  model_id: string
  error_message?: string | null
  created_at: number
  requested_params?: Record<string, unknown>
  actual_params?: {
    n?: number
    size?: string
    quality?: string
    style?: string
    output_format?: string
    aspect_ratio?: string
    image_size?: string
    target_resolution?: string
    upscale_model?: string
    background?: string
    compression?: number
    warnings?: string[]
    upscale?: Array<{
      position: number
      method: string
      source_width: number
      source_height: number
      width: number
      height: number
      target: string
      duration_ms?: number
      device?: string
      model?: string
    }>
  }
  outputs: Array<{ asset_id: string; position: number }>
}

export type StudioJobEvent = {
  job_id: string
  seq: number
  type: string
  payload: {
    status?: string
    asset_id?: string
    position?: number
    message?: string | null
  }
  created_at: number
}

export type StudioUpscalerStatus = {
  supported: boolean
  installed: boolean
  version: string
  engine: string
  download_bytes: number
  models: string[]
  path?: string | null
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const detail = payload?.detail
    const message =
      (typeof detail === 'string' ? detail : detail?.message) ||
      payload?.error?.message ||
      `Request failed (${response.status})`
    throw new ImageStudioApiError(message, response.status, detail)
  }
  return response.json() as Promise<T>
}

export class ImageStudioApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown
  ) {
    super(message)
    this.name = 'ImageStudioApiError'
  }
}

export async function listImageModels(): Promise<ImageModelOption[]> {
  const payload = await json<{ options: ImageModelOption[] }>(
    await apiFetch(apiUrl(`${BASE}/models`), { cache: 'no-store' })
  )
  return payload.options || []
}

export async function getStudioUpscalerStatus(): Promise<StudioUpscalerStatus> {
  return json(await apiFetch(apiUrl(`${BASE}/upscaler`), { cache: 'no-store' }))
}

export async function installStudioUpscaler(): Promise<StudioUpscalerStatus> {
  return json(await apiFetch(apiUrl(`${BASE}/upscaler/install`), { method: 'POST' }))
}

export async function listStudioProjects(): Promise<StudioProject[]> {
  const payload = await json<{ projects: StudioProject[] }>(
    await apiFetch(apiUrl(`${BASE}/projects`), { cache: 'no-store' })
  )
  return payload.projects || []
}

export async function createStudioProject(title = 'Untitled Project'): Promise<StudioProject> {
  return json(
    await apiFetch(apiUrl(`${BASE}/projects`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  )
}

export async function updateStudioProject(id: string, title: string): Promise<StudioProject> {
  return json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(id)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  )
}

export async function deleteStudioProject(id: string): Promise<void> {
  await json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(id)}`), { method: 'DELETE' })
  )
}

export async function restoreStudioProject(id: string): Promise<StudioProject> {
  return json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(id)}/restore`), {
      method: 'POST',
    })
  )
}

export async function getStudioProject(
  id: string,
  signal?: AbortSignal
): Promise<StudioProject & { jobs: StudioJob[]; assets: StudioAsset[] }> {
  return json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(id)}`), {
      cache: 'no-store',
      signal,
    })
  )
}

export async function listStudioJobs(
  projectId: string,
  cursor?: number,
  signal?: AbortSignal
): Promise<{ jobs: StudioJob[]; next_cursor: number | null }> {
  const search = new URLSearchParams({ limit: '50' })
  if (cursor != null) search.set('cursor', String(cursor))
  return json(
    await apiFetch(
      apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/jobs?${search.toString()}`),
      { cache: 'no-store', signal }
    )
  )
}

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function uploadStudioAsset(projectId: string, file: File): Promise<StudioAsset> {
  const init = await json<{ upload_id: string; chunk_size: number }>(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/uploads`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        mime: file.type,
        size: file.size,
        sha256: await sha256(file),
      }),
    })
  )
  for (let offset = 0, index = 0; offset < file.size; offset += init.chunk_size, index += 1) {
    const response = await apiFetch(apiUrl(`${BASE}/uploads/${init.upload_id}/parts/${index}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file.slice(offset, offset + init.chunk_size),
    })
    if (!response.ok) throw new Error(`Upload failed (${response.status})`)
  }
  return json(
    await apiFetch(apiUrl(`${BASE}/uploads/${init.upload_id}/complete`), { method: 'POST' })
  )
}

export async function createStudioJob(
  projectId: string,
  payload: {
    operation: 'generate' | 'edit' | 'inpaint'
    image_profile_id: string
    model_id: string
    prompt: string
    input_asset_ids: string[]
    mask_asset_id?: string | null
    parent_job_id?: string | null
    parameters: Record<string, unknown>
  }
): Promise<StudioJob> {
  return json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/jobs`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  )
}

export async function getStudioJob(id: string, signal?: AbortSignal): Promise<StudioJob> {
  return json(
    await apiFetch(apiUrl(`${BASE}/jobs/${encodeURIComponent(id)}`), { cache: 'no-store', signal })
  )
}

export function followStudioJob(
  id: string,
  onEvent: (event: StudioJobEvent) => void,
  afterSeq = 0,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortError = () => new DOMException('Image job follow cancelled', 'AbortError')
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const desktop = typeof window !== 'undefined' ? window.knorviaDesktop : undefined
    if (desktop) {
      const socketId = crypto.randomUUID()
      let settled = false
      let remove: () => void = () => undefined
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        try {
          remove()
        } catch {
          // The desktop bridge may already have removed a one-shot listener.
        }
        try {
          desktop.wsClose(socketId)
        } catch {
          // A failed/never-opened socket is already closed for our purposes.
        }
        callback()
      }
      const onAbort = () => finish(() => reject(abortError()))
      try {
        remove = desktop.onWsEvent(socketId, event => {
          if (settled) return
          if (event.type === 'open') {
            desktop.wsSend(
              socketId,
              JSON.stringify({ type: 'subscribe_job', job_id: id, after_seq: afterSeq })
            )
            return
          }
          if (event.type === 'message' && event.data) {
            try {
              const payload = JSON.parse(event.data)
              if (payload.type === 'subscription.complete') {
                finish(resolve)
              } else if (payload.type === 'error') {
                finish(() => reject(new Error(payload.message || 'Image job stream failed')))
              } else onEvent(payload as StudioJobEvent)
            } catch {
              finish(() => reject(new Error('Image job stream returned invalid data')))
            }
            return
          }
          if (event.type === 'close' || event.type === 'error') {
            finish(() => reject(new Error(event.error || 'Image job stream disconnected')))
          }
        })
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })
        if (!settled) desktop.wsOpen(socketId, `${BASE}/ws`)
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error('Image job stream failed')))
      }
      return
    }
    const socket = new WebSocket(wsUrl(`${BASE}/ws`))
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      try {
        socket.close()
      } catch {
        // A constructor/open failure means there is no live socket to keep.
      }
      callback()
    }
    const onAbort = () => finish(() => reject(abortError()))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: 'subscribe_job', job_id: id, after_seq: afterSeq }))
    socket.onmessage = message => {
      try {
        const event = JSON.parse(String(message.data))
        if (event.type === 'subscription.complete') {
          finish(resolve)
          return
        }
        if (event.type === 'error') {
          finish(() => reject(new Error(event.message || 'Image job stream failed')))
          return
        }
        onEvent(event as StudioJobEvent)
      } catch {
        finish(() => reject(new Error('Image job stream returned invalid data')))
      }
    }
    socket.onerror = () => finish(() => reject(new Error('Image job stream disconnected')))
    socket.onclose = () => {
      if (!settled) finish(() => reject(new Error('Image job stream closed early')))
    }
  })
}

export async function cancelStudioJob(id: string): Promise<boolean> {
  const payload = await json<{ cancelled: boolean }>(
    await apiFetch(apiUrl(`${BASE}/jobs/${encodeURIComponent(id)}/cancel`), { method: 'POST' })
  )
  return payload.cancelled
}

export async function retryStudioJob(id: string): Promise<StudioJob> {
  return json(
    await apiFetch(apiUrl(`${BASE}/jobs/${encodeURIComponent(id)}/retry`), { method: 'POST' })
  )
}

export async function setStudioAssetFavorite(id: string, favorite: boolean): Promise<StudioAsset> {
  return json(
    await apiFetch(apiUrl(`${BASE}/assets/${encodeURIComponent(id)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorite }),
    })
  )
}

export async function deleteStudioAsset(id: string): Promise<void> {
  await json(
    await apiFetch(apiUrl(`${BASE}/assets/${encodeURIComponent(id)}`), { method: 'DELETE' })
  )
}

export async function restoreStudioAsset(id: string): Promise<StudioAsset> {
  return json(
    await apiFetch(apiUrl(`${BASE}/assets/${encodeURIComponent(id)}/restore`), {
      method: 'POST',
    })
  )
}

export function studioProjectExportUrl(id: string): string {
  return apiUrl(`${BASE}/projects/${encodeURIComponent(id)}/export`)
}

export function studioAssetUrl(id: string): string {
  return apiUrl(`${BASE}/assets/${encodeURIComponent(id)}/content`)
}

export async function getStudioBoard(projectId: string, signal?: AbortSignal) {
  return json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/board`), {
      cache: 'no-store',
      signal,
    })
  )
}

export async function saveStudioBoard(
  projectId: string,
  document: unknown,
  signal?: AbortSignal
) {
  const revision =
    document && typeof document === 'object' && 'revision' in document
      ? Number((document as { revision?: unknown }).revision)
      : 0
  return json(
    await apiFetch(apiUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/board`), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': `"${Number.isInteger(revision) && revision >= 0 ? revision : 0}"`,
      },
      body: JSON.stringify(document),
      signal,
    })
  )
}
