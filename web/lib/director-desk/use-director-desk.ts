/**
 * useDirectorDesk — 在 React 组件中管理内嵌导演台 iframe 与桥接客户端生命周期。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { DirectorDeskClient } from './client'
import { directorDeskTheme, directorDeskUrl, type DirectorCapture } from './protocol'
import {
  getStoredTheme,
  getSystemTheme,
  subscribeToThemeChanges,
  type Theme,
} from '../theme'

export interface UseDirectorDeskOptions {
  instanceId: string
  hostOrigin?: string
}

export interface UseDirectorDeskResult {
  iframeRef: (node: HTMLIFrameElement | null) => void
  client: DirectorDeskClient | null
  ready: boolean
  src: string
  /** 当前映射到导演台的应用主题（light | dark）。 */
  theme: 'light' | 'dark'
  /** 导演台主动推送的多方位截图（四方位/十二方位）。 */
  captures: DirectorCapture[]
  /** 强制 iframe 重新加载（例如握手超时后的恢复）。 */
  reload: () => void
  /** 重新向导演台声明作用域会话（切换工程后用于刷新场景）。 */
  reset: () => void
}

export function useDirectorDesk(options: UseDirectorDeskOptions): UseDirectorDeskResult {
  const { instanceId, hostOrigin } = options
  const [node, setNode] = useState<HTMLIFrameElement | null>(null)
  const [client, setClient] = useState<DirectorDeskClient | null>(null)
  const [ready, setReady] = useState(false)
    const [captures, setCaptures] = useState<DirectorCapture[]>([])
    const [reloadNonce, setReloadNonce] = useState(0)
  const [appTheme, setAppTheme] = useState<Theme>(() => getStoredTheme() ?? getSystemTheme())

  const src = useMemo(
    () => {
      const url = directorDeskUrl({ instanceId, hostOrigin })
      return reloadNonce > 0 ? `${url}&knorviaReload=${reloadNonce}` : url
    }
      ,
    [instanceId, hostOrigin, reloadNonce],
  )

  // src 变化会触发 iframe 重新加载（新 instanceId → 新场景），同步复位就绪态。
  useEffect(() => {
    // The iframe URL is the external system boundary; reset its handshake
    // state in the same lifecycle that changes that boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(false)
    setCaptures([])
  }, [src])

  // 跟随应用主题（含初始化兜底系统偏好）；主题切换通过 openSession 热更新，
  // 不进 src，避免整帧重载 3D 场景。
  useEffect(() => {
    const unsubscribe = subscribeToThemeChanges(setAppTheme)
    return unsubscribe
  }, [])

  const theme = directorDeskTheme(appTheme)

  // 客户端必须在 effect 中创建：StrictMode/并发重挂载会先走 cleanup（dispose），
  // useMemo 不会重算，一旦被 dispose 监听器就永久丢失、ready 握手再也收不到。
  useEffect(() => {
    if (!node) return
    const instance = new DirectorDeskClient(node, { instanceId, hostOrigin })
    instance.onReady = () => setReady(true)
    instance.onCaptures = capturesFromDesk => setCaptures(capturesFromDesk)
    instance.attach()
    // The bridge is an imperative external resource created by this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClient(instance)
    return () => {
      instance.dispose()
      setClient(null)
    }
  }, [node, src, instanceId, hostOrigin])

  // 就绪后同步一次主题；之后应用主题每次变化都热更新会话主题。
  useEffect(() => {
    if (!client || !ready) return
    client.openSession(theme)
  }, [client, ready, theme])

  const iframeRef = useCallback((iframeNode: HTMLIFrameElement | null) => {
    setNode(iframeNode)
  }, [])

    const reload = useCallback(() => {
      setReloadNonce(value => value + 1)
    }, [])

  const reset = useCallback(() => {
    setReady(false)
    client?.openSession(theme)
  }, [client, theme])

  return { iframeRef, client, ready, src, theme, captures, reload, reset }
}
