/**
 * AIPAI「3D 导演台」二创接口协议 — TypeScript 定义。
 *
 * 导演台是一个自包含的 Three.js Web 应用，通过 `window.postMessage` 与宿主
 * （Knorvia 视频工作台）通信。本文件是逆向该协议后整理的、面向宿主的类型化
 * 契约，与导演台内置的 `storyai:director-desk:*` 消息一一对应。
 */

/** 导演台 → 宿主：就绪（挂载完成，可开始 RPC）。 */
export const DIRECTOR_DESK_READY = 'storyai:director-desk-ready' as const
/** 宿主 → 导演台：RPC 请求。 */
export const DIRECTOR_DESK_REQUEST = 'storyai:director-desk:request' as const
/** 导演台 → 宿主：RPC 响应。 */
export const DIRECTOR_DESK_RESPONSE = 'storyai:director-desk:response' as const
/** 导演台 → 宿主：多方位截图（四方位/十二方位）。 */
export const DIRECTOR_DESK_CAPTURES = 'storyai:director-desk-captures-sent' as const
/** 宿主 → 导演台：打开/切换作用域会话。 */
export const DIRECTOR_DESK_SESSION = 'storyai:director-desk-session' as const
/** 宿主 → 导演台：注入一张等距柱状（equirectangular）全景图作为场景背景。 */
export const DIRECTOR_DESK_PANORAMA = 'storyai:director-desk-panorama' as const
/** 宿主 → 白模预演：面板显示状态；隐藏时暂停 3D 连续渲染。 */
export const DIRECTOR_DESK_VISIBILITY = 'storyai:director-desk-visibility' as const

export type DirectorAction =
  | 'capabilities.get'
  | 'project.get'
  | 'timeline.get'
  | 'export.frame'
  | 'export.video'
  | 'plugin.result.submit'
  | 'plugin.results.list'

export type DirectorFramePosition = 'first' | 'current' | 'last'
export type DirectorExportQuality = '720p' | '1080p'
export type DirectorVideoFps = 24 | 30 | 60

export interface DirectorCapabilities {
  protocolVersion: number
  projectSchemaVersion: number
  /** 支持的二创 RPC 动作名。 */
  actions: string[]
  /** UI 层导出能力（如 project-json / reference-video / viewport-still）。 */
  uiExports: string[]
  /** 协议层导出能力（如 clean-frame / reference-video）。 */
  protocolExports: string[]
  assetPersistence: string
}

export interface DirectorTimeline {
  protocolVersion: number
  /** 0..1 镜头运镜进度。 */
  progress: number
  timeSeconds: number
  durationSeconds: number
  playing: boolean
  viewMode: string
  activeCameraId: string | null
}

export interface DirectorCamera {
  id?: string
  [key: string]: unknown
}

export interface DirectorAssetRef {
  id?: string
  storageKey?: string
  url?: string
  kind?: string
  [key: string]: unknown
}

/** 导演台工程文档（project.get 的 `project` 字段，schema 由导演台自行演进）。 */
export interface DirectorProject {
  cameras: DirectorCamera[]
  activeCameraId: string | null
  assets: DirectorAssetRef[]
  animationAssets?: DirectorAssetRef[]
  [key: string]: unknown
}

export interface DirectorProjectResponse {
  protocolVersion: number
  projectSchemaVersion: number
  /** FNV-1a-32 工程指纹，用于判断插件结果是否过期。 */
  projectFingerprint: string
  project: DirectorProject
  portability: {
    portable: boolean
    browserLocalAssetIds: string[]
    note: string | null
  }
}

export interface DirectorFrameOptions {
  fileName?: string
  position?: DirectorFramePosition
  quality?: DirectorExportQuality
}

export interface DirectorFrameResult {
  /** PNG data URL（`data:image/png;base64,...`）。 */
  dataUrl: string
  fileName?: string
  position?: DirectorFramePosition
  progress?: number
  width?: number
  height?: number
  [key: string]: unknown
}

export interface DirectorVideoOptions {
  fileName?: string
  fps?: DirectorVideoFps
  quality?: DirectorExportQuality
}

export interface DirectorVideoResult {
  /** 支持结构化克隆的 MP4 Blob（部分浏览器回退为 dataUrl）。 */
  blob?: Blob
  dataUrl?: string
  fileName?: string
  [key: string]: unknown
}

export interface DirectorCapture {
  dataUrl: string
  fileName: string
}

export interface DirectorPluginResult {
  id?: string
  basedOnProjectFingerprint: string
  data: unknown
  kind: string
  plugin: { id: string; name: string; version: string }
  status: 'success' | 'error'
  summary: string
  receivedAt?: string
  stale?: boolean
}

export interface DirectorError {
  code?: string
  message?: string
}

/** RPC 响应信封（所有动作共用）。 */
export interface DirectorResponse<T = unknown> {
  protocolVersion: number
  requestId: string
  action: string
  ok: boolean
  data?: T
  error?: DirectorError
}

/** hostOrigin / instanceId / theme 等 iframe 嵌入参数。 */
export interface DirectorDeskEmbedOptions {
  instanceId: string
  /** 允许回传消息的源；缺省为导演台自身 origin（同源部署时即宿主 origin）。 */
  hostOrigin?: string
  theme?: 'light' | 'dark'
}

/**
 * 应用四档主题（light/dark/glass/snow，见 `lib/theme.ts`）映射为导演台
 * 二值主题：dark 与以 dark 为底的 glass → 'dark'；light 与 snow → 'light'。
 */
export function directorDeskTheme(appTheme: 'light' | 'dark' | 'glass' | 'snow' | 'jade' | 'dusk'): 'light' | 'dark' {
  return appTheme === 'dark' || appTheme === 'glass' || appTheme === 'dusk' ? 'dark' : 'light'
}

export interface DirectorSessionMessage {
  instanceId: string
  theme?: 'light' | 'dark'
}

export interface DirectorPanoramaMessage {
  edgeId: string
  sourceNodeId: string
  imageUrl: string
  fileName: string
}

/** 依据 iframe 嵌入参数构建导演台 URL（含基准全景/性能档等可选参数）。 */
export function directorDeskUrl(options: DirectorDeskEmbedOptions): string {
  const params = new URLSearchParams()
  params.set('instanceId', options.instanceId)
  if (options.hostOrigin) params.set('hostOrigin', options.hostOrigin)
  if (options.theme) params.set('theme', options.theme)
  // 显式指向 index.html：Next.js 生产/standalone 服务器不会对 public 子目录
  // 做目录索引（`/director-desk/` 返回 404），只有精确文件路径可用。
  return `/director-desk/index.html?${params.toString()}`
}
