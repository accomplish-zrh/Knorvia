/**
 * DirectorDeskClient — 视频工作台与内嵌 3D 导演台之间的宿主侧桥接器。
 *
 * 职责：管理与 iframe 的 postMessage 通道、requestId↔Promise 关联、ready 检测、
 * 多方位截图订阅，以及导演台「二创接口」的类型化调用。
 */

import {
  DIRECTOR_DESK_CAPTURES,
  DIRECTOR_DESK_PANORAMA,
  DIRECTOR_DESK_READY,
  DIRECTOR_DESK_REQUEST,
  DIRECTOR_DESK_RESPONSE,
  DIRECTOR_DESK_SESSION,
  type DirectorAction,
  type DirectorCapabilities,
  type DirectorCapture,
  type DirectorFrameOptions,
  type DirectorFrameResult,
  type DirectorPanoramaMessage,
    type DirectorPluginResult,
  type DirectorProjectResponse,
  type DirectorResponse,
  type DirectorSessionMessage,
  type DirectorTimeline,
  type DirectorVideoOptions,
  type DirectorVideoResult,
} from './protocol'

const DEFAULT_TIMEOUT_MS = 60_000
const READY_PROBE_INTERVAL_MS = 750
const READY_PROBE_TIMEOUT_MS = 2_000

type Pending = {
  resolve: (value: DirectorResponse<never>) => void
  reject: (reason: Error) => void
  timer: number
}

type MessageEventLike = MessageEvent

/**
 * 从 dataUrl 或 Blob 构造可上传/下载的 File。导演台帧导出返回 PNG dataUrl，
 * 视频导出可能返回 Blob（结构化克隆）或 dataUrl 回退。
 */
export function directorResultToFile(
  data: DirectorFrameResult | DirectorVideoResult | DirectorCapture,
  fallbackName: string,
  fallbackType: string,
): File {
  const blob = 'blob' in data ? (data as DirectorVideoResult).blob : undefined
  if (blob) {
    const name = data.fileName || fallbackName
    if (blob instanceof File) return blob
    return new File([blob], name, { type: blob.type || fallbackType })
  }
  if (data.dataUrl) {
    const [header, body] = data.dataUrl.split(',', 2)
    const mime = /^data:([^;]+)/.exec(header)?.[1] || fallbackType
    const binary = atob(body || '')
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new File([bytes], data.fileName || fallbackName, { type: mime })
  }
  throw new Error('The director desk returned an empty export result')
}

export class DirectorDeskClient {
  private readonly iframe: HTMLIFrameElement
  private readonly instanceId: string
  private readonly hostOrigin: string
  private seq = 0
  private pending = new Map<string, Pending>()
  private disposed = false
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private messageHandler: ((event: MessageEventLike) => void) | null = null
  private probeTimer: number | null = null

  onReady?: () => void
  onCaptures?: (captures: DirectorCapture[]) => void

  constructor(
    iframe: HTMLIFrameElement,
    options: { instanceId: string; hostOrigin?: string },
  ) {
    this.iframe = iframe
    this.instanceId = options.instanceId
    this.hostOrigin = options.hostOrigin ?? window.location.origin
    this.readyPromise = new Promise<void>(resolve => {
      this.readyResolve = resolve
    })
  }

  /** 附加 message 监听并开始就绪探活（在 iframe 挂载后调用一次）。 */
  attach(): void {
    if (this.messageHandler) return
    this.messageHandler = event => this.handleMessage(event)
    window.addEventListener('message', this.messageHandler)
    this.startReadyProbe()
  }

  /** 移除监听并拒绝所有在途请求。 */
  dispose(): void {
    this.disposed = true
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler)
      this.messageHandler = null
    }
    this.stopReadyProbe()
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new Error('The director desk was closed'))
    }
    this.pending.clear()
  }

  /** 等待导演台就绪（挂载完成，可开始 RPC）。 */
  ready(): Promise<void> {
    return this.readyPromise ?? Promise.resolve()
  }

  /** 打开/切换作用域会话（可选；导演台挂载时已按 URL instanceId 自动就绪）。 */
  openSession(theme?: 'light' | 'dark'): void {
    const message: DirectorSessionMessage = { instanceId: this.instanceId }
    if (theme) message.theme = theme
    this.post(DIRECTOR_DESK_SESSION, message)
  }

  /** 注入一张等距柱状全景图作为场景背景。 */
  injectPanorama(payload: DirectorPanoramaMessage): void {
    this.post(DIRECTOR_DESK_PANORAMA, payload)
  }

  /** 低层 RPC：发送请求并等待对应响应。 */
  request<T>(action: DirectorAction, options?: unknown, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('导演台已关闭'))
    const requestId = `knorvia-${++this.seq}-${Date.now().toString(36)}`
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Director desk request timed out: ${action}`))
      }, timeoutMs)
      this.pending.set(requestId, {
        resolve: response => {
          if (!response.ok) {
            reject(new Error(response.error?.message || `Director desk request failed: ${action}`))
          } else {
            resolve(response.data as T)
          }
        },
        reject,
        timer,
      } as Pending)
      this.post(DIRECTOR_DESK_REQUEST, { requestId, action, ...(options ? { options } : {}) })
    })
  }

  // ---- 类型化动作 ----

  capabilities(): Promise<DirectorCapabilities> {
    return this.request<DirectorCapabilities>('capabilities.get')
  }

  getProject(): Promise<DirectorProjectResponse> {
    return this.request<DirectorProjectResponse>('project.get')
  }

  getTimeline(): Promise<DirectorTimeline> {
    return this.request<DirectorTimeline>('timeline.get')
  }

  exportFrame(options: DirectorFrameOptions = {}): Promise<DirectorFrameResult> {
    return this.request<DirectorFrameResult>('export.frame', options)
  }

  exportVideo(options: DirectorVideoOptions = {}): Promise<DirectorVideoResult> {
    return this.request<DirectorVideoResult>('export.video', options)
  }

  /** 保存宿主生成的镜头/运镜建议，供导演台插件面板读取。 */
  submitPluginResult(result: DirectorPluginResult): Promise<DirectorPluginResult> {
    return this.request<DirectorPluginResult>('plugin.result.submit', { result })
  }

  listPluginResults(): Promise<DirectorPluginResult[]> {
    return this.request<DirectorPluginResult[]>('plugin.results.list')
  }


  // ---- 内部 ----

  /**
   * 就绪探活：导演台可能在宿主挂上监听器之前就已加载并发过 ready（本地缓存
   * 或测试桩里没有网络延迟）。宿主侧用周期 capabilities.get 兜底——任何一条
   * 通过校验的回包都证明通道已就绪。
   */
  private startReadyProbe(): void {
    const probe = () => {
      if (this.disposed || this.readyResolve === null) {
        this.stopReadyProbe()
        return
      }
      this.request<DirectorCapabilities>('capabilities.get', undefined, READY_PROBE_TIMEOUT_MS)
        .catch(() => {})
    }
    probe()
    this.probeTimer = window.setInterval(probe, READY_PROBE_INTERVAL_MS)
  }

  private stopReadyProbe(): void {
    if (this.probeTimer !== null) {
      window.clearInterval(this.probeTimer)
      this.probeTimer = null
    }
  }

  /** 首次确认通道就绪（幂等）：解决 readyPromise、触发 onReady 并停止探活。 */
  private markReady(): void {
    if (this.readyResolve === null) return
    this.readyResolve()
    this.readyResolve = null
    this.stopReadyProbe()
    this.onReady?.()
  }

  private post(type: string, payload: unknown): void {
    const targetOrigin = this.hostOrigin === 'null' ? '*' : this.hostOrigin
    this.iframe.contentWindow?.postMessage({ type, payload }, targetOrigin)
  }

  /** 面板隐藏时暂停 iframe 的连续 3D 渲染，重新显示后恢复。 */
  setVisibility(active: boolean): void {
    this.post('storyai:director-desk-visibility', { active })
  }

  private handleMessage(event: MessageEventLike): void {
    // 只接受来自本 iframe 且同源的消息。
    if (event.source !== this.iframe.contentWindow) return
    if (event.origin !== window.location.origin) return
    const data = event.data as { type?: string; payload?: unknown } | null
    if (!data || typeof data.type !== 'string') return

    // 任何通过校验的消息都证明导演台已可达（探针回包也走这里）。
    this.markReady()

    if (data.type === DIRECTOR_DESK_READY) {
      return
    }

    if (data.type === DIRECTOR_DESK_CAPTURES) {
      const captures = (data.payload as { captures?: DirectorCapture[] } | null)?.captures
      if (Array.isArray(captures)) this.onCaptures?.(captures)
      return
    }

    if (data.type === DIRECTOR_DESK_RESPONSE) {
      const response = data.payload as DirectorResponse
      if (!response || typeof response.requestId !== 'string') return
      const pending = this.pending.get(response.requestId)
      if (!pending) return
      this.pending.delete(response.requestId)
      window.clearTimeout(pending.timer)
      pending.resolve(response as DirectorResponse<never>)
    }
  }
}
