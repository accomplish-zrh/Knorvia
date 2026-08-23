import { apiFetch, apiUrl } from '@/lib/api'

const BASE = '/api/v1/library'

export type LibraryAssetKind = 'text' | 'image' | 'video'
export type CreationMode = 'agent' | 'image' | 'video'

export type LibraryAsset = {
  id: string
  kind: LibraryAssetKind
  title: string
  tags: string[]
  source: string
  note: string
  mime: string
  size_bytes: number
  sha256: string
  content: string
  created_at: number
  updated_at: number
}

export type LibraryPrompt = {
  id: string
  origin: 'builtin' | 'user'
  title: string
  body: string
  category: string
  tags: string[]
  language: string
  created_at: number
  updated_at: number
}

export type LibraryPage<T> = {
  items: T[]
  total: number
  page: number
  page_size: number
}

export type CreateConversation = {
  id: string
  title: string
  created_at: number
  updated_at: number
}

export type CreateMessage = {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  mode: CreationMode | string
  prefs: Record<string, unknown>
  brief: Record<string, unknown>
  job: CreateJobRef
  created_at: number
}

export type CreateJobRef = {
  studio?: 'image' | 'video'
  project_id?: string
  job_id?: string
  status?: string
}

export type CanvasRun = {
  id: string
  studio: 'image' | 'video'
  project_id: string
  prompt: string
  status: string
  ops: Array<Record<string, unknown>>
  brief: Record<string, unknown>
  job_ids: string[]
  error_message: string
  created_at: number
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = response.statusText
    try {
      const payload = (await response.json()) as { detail?: unknown }
      if (typeof payload.detail === 'string') detail = payload.detail
      else if (payload.detail) detail = JSON.stringify(payload.detail)
    } catch {
      /* keep status text */
    }
    throw new Error(detail || `Library request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

export type LibraryEntryKind =
  | 'folder'
  | 'markdown'
  | 'csv'
  | 'html'
  | 'canvas'
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'word'
  | 'excel'
  | 'office'
  | 'file'

export type LibraryEntry = {
  id: string
  parent_id: string | null
  kind: LibraryEntryKind | string
  title: string
  mime: string
  size_bytes: number
  content?: string
  preview_scripts?: boolean
  children?: LibraryEntry[]
  created_at: number
  updated_at: number
}

export function libraryAssetUrl(assetId: string): string {
  return apiUrl(`${BASE}/assets/${encodeURIComponent(assetId)}/content`)
}

export function libraryEntryUrl(entryId: string): string {
  return apiUrl(`${BASE}/entries/${encodeURIComponent(entryId)}/content`)
}

export async function listLibraryTree(): Promise<{ items: LibraryEntry[]; total: number }> {
  return json(await apiFetch(apiUrl(`${BASE}/tree`), { cache: 'no-store' }))
}

export async function getLibraryEntry(entryId: string): Promise<LibraryEntry> {
  return json(await apiFetch(apiUrl(`${BASE}/entries/${encodeURIComponent(entryId)}`), { cache: 'no-store' }))
}

export async function createLibraryEntry(payload: {
  kind: string
  title?: string
  parent_id?: string | null
  content?: string
}): Promise<LibraryEntry> {
  return json(
    await apiFetch(apiUrl(`${BASE}/entries`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  )
}

export async function patchLibraryEntry(
  entryId: string,
  payload: { title?: string; content?: string; parent_id?: string | null }
): Promise<LibraryEntry> {
  return json(
    await apiFetch(apiUrl(`${BASE}/entries/${encodeURIComponent(entryId)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  )
}

export async function uploadLibraryEntry(file: File, parentId?: string | null, title = ''): Promise<LibraryEntry> {
  const body = new FormData()
  body.append('file', file)
  if (parentId) body.append('parent_id', parentId)
  if (title) body.append('title', title)
  return json(await apiFetch(apiUrl(`${BASE}/entries/upload`), { method: 'POST', body }))
}

export async function deleteLibraryEntry(entryId: string): Promise<void> {
  await json(await apiFetch(apiUrl(`${BASE}/entries/${encodeURIComponent(entryId)}`), { method: 'DELETE' }))
}

export async function listLibraryAssets(query: {
  kind?: string
  keyword?: string
  page?: number
  pageSize?: number
} = {}): Promise<LibraryPage<LibraryAsset>> {
  const search = new URLSearchParams()
  if (query.kind) search.set('kind', query.kind)
  if (query.keyword) search.set('keyword', query.keyword)
  if (query.page) search.set('page', String(query.page))
  if (query.pageSize) search.set('page_size', String(query.pageSize))
  return json(await apiFetch(apiUrl(`${BASE}/assets?${search}`), { cache: 'no-store' }))
}

export async function createLibraryTextAsset(payload: {
  title: string
  content: string
  tags?: string[]
  note?: string
}): Promise<LibraryAsset> {
  return json(
    await apiFetch(apiUrl(`${BASE}/assets`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  )
}

export async function uploadLibraryAsset(file: File, title = ''): Promise<LibraryAsset> {
  const body = new FormData()
  body.append('file', file)
  if (title) body.append('title', title)
  return json(await apiFetch(apiUrl(`${BASE}/assets/upload`), { method: 'POST', body }))
}

export async function deleteLibraryAsset(assetId: string): Promise<void> {
  await json(await apiFetch(apiUrl(`${BASE}/assets/${encodeURIComponent(assetId)}`), { method: 'DELETE' }))
}

export async function listLibraryPrompts(query: {
  origin?: string
  keyword?: string
  category?: string
  tag?: string
  page?: number
  pageSize?: number
} = {}): Promise<LibraryPage<LibraryPrompt>> {
  const search = new URLSearchParams()
  if (query.origin) search.set('origin', query.origin)
  if (query.keyword) search.set('keyword', query.keyword)
  if (query.category) search.set('category', query.category)
  if (query.tag) search.set('tag', query.tag)
  if (query.page) search.set('page', String(query.page))
  if (query.pageSize) search.set('page_size', String(query.pageSize))
  return json(await apiFetch(apiUrl(`${BASE}/prompts?${search}`), { cache: 'no-store' }))
}

export async function createLibraryPrompt(payload: {
  title: string
  body: string
  category?: string
  tags?: string[]
  language?: string
}): Promise<LibraryPrompt> {
  return json(
    await apiFetch(apiUrl(`${BASE}/prompts`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  )
}

export async function deleteLibraryPrompt(promptId: string): Promise<void> {
  await json(
    await apiFetch(apiUrl(`${BASE}/prompts/${encodeURIComponent(promptId)}`), { method: 'DELETE' })
  )
}

export async function listCreateConversations(): Promise<CreateConversation[]> {
  const payload = await json<{ items: CreateConversation[] }>(
    await apiFetch(apiUrl(`${BASE}/conversations`), { cache: 'no-store' })
  )
  return payload.items || []
}

export async function createCreateConversation(title = ''): Promise<CreateConversation> {
  return json(
    await apiFetch(apiUrl(`${BASE}/conversations`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  )
}

export async function getCreateConversation(id: string): Promise<CreateConversation & { messages: CreateMessage[] }> {
  return json(await apiFetch(apiUrl(`${BASE}/conversations/${encodeURIComponent(id)}`), { cache: 'no-store' }))
}

export async function deleteCreateConversation(id: string): Promise<void> {
  await json(
    await apiFetch(apiUrl(`${BASE}/conversations/${encodeURIComponent(id)}`), { method: 'DELETE' })
  )
}

export async function submitCreateGeneration(payload: {
  conversation_id?: string
  prompt: string
  mode: CreationMode
  language?: string
  model_key?: string
  smart_planning?: boolean
  library_asset_ids?: string[]
  first_frame_asset_id?: string
  last_frame_asset_id?: string
  preferences?: Record<string, unknown>
}): Promise<{
  conversation: CreateConversation
  user_message: CreateMessage
  assistant_message: CreateMessage
  job: CreateJobRef
}> {
  return json(
    await apiFetch(apiUrl(`${BASE}/create`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  )
}

export async function startCanvasRun(
  studio: 'image' | 'video',
  projectId: string,
  payload: {
    prompt: string
    language?: string
    selected_ids?: string[]
    model_key?: string
    smart_planning?: boolean
    preferences?: Record<string, unknown>
  }
): Promise<CanvasRun> {
  return json(
    await apiFetch(apiUrl(`${BASE}/canvas-runs/${studio}/${encodeURIComponent(projectId)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  )
}
