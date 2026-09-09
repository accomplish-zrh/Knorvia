import {
  NativeClientError,
  type NativeClient,
  type NativeClientOptions,
  type NativeConnectionChange,
  type NativeConnectionListener,
  type NativeConnectionState,
  type NativeDesktopBridge,
  type NativeGatewaySession,
  type NativeNotification,
  type NativeNotificationListener,
  type NativeParams,
  type NativeRpcId,
  type NativeRpcRequest,
  type NativeRpcResponse,
  type NativeWebSocketLike,
} from "./knorvia-native-types"

export * from "./knorvia-native-types"

export const NATIVE_GATEWAY_PATH = "/api/knorvia/native"
export const NATIVE_GATEWAY_SESSION_PATH = "/api/knorvia/native/session"
export const NATIVE_SUBPROTOCOL = "knorvia.native.v1"
const TOKEN_PROTOCOL_PREFIX = "knorvia.native.token."
// A proxy may complete a WebSocket upgrade and immediately close because its
// loopback target is unavailable. Do not reset exponential retry state merely
// because `open` fired; wait for native traffic or a quiet stable interval.
const STABLE_CONNECTION_MS = 10_000

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: NativeClientError) => void
  timer: ReturnType<typeof setTimeout>
}

type EventWithData = Event & { data?: unknown }

function nativeRequestKey(id: NativeRpcId): string {
  return `${typeof id}:${String(id)}`
}

function desktopBridgeFromWindow(): NativeDesktopBridge | undefined {
  if (typeof window === "undefined") return undefined
  return (window as unknown as { knorviaDesktop?: { native?: NativeDesktopBridge } })
    .knorviaDesktop?.native
}

function asNativeError(error: unknown, fallback: string): NativeClientError {
  if (error instanceof NativeClientError) return error
  if (error instanceof Error) return new NativeClientError(error.message || fallback, { cause: error })
  return new NativeClientError(fallback, { cause: error })
}

function responseError(response: Extract<NativeRpcResponse, { error: unknown }>): NativeClientError {
  return new NativeClientError(response.error.message || "Native RPC request failed", {
    code: response.error.code,
    data: response.error.data,
  })
}

function isRpcResponse(value: unknown): value is NativeRpcResponse {
  return Boolean(value && typeof value === "object" && ("id" in value || "error" in value))
}

function isNotification(value: unknown): value is NativeNotification {
  if (!value || typeof value !== "object" || !("method" in value)) return false
  const candidate = value as { jsonrpc?: unknown; method?: unknown; params?: unknown }
  return candidate.jsonrpc === "2.0" && typeof candidate.method === "string"
}

function socketUrl(raw: string): string {
  if (/^wss?:\/\//i.test(raw)) return raw
  const base = typeof window !== "undefined" ? window.location.href : "http://127.0.0.1"
  const target = new URL(raw, base)
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:"
  return target.toString()
}

function browserOrigin(): string | undefined {
  return typeof window !== "undefined" && window.location?.origin
    ? window.location.origin
    : undefined
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
  return Math.max(1, Math.floor(value))
}

function requestTimeoutError(method: string): NativeClientError {
  return new NativeClientError(
    `Native ${method} request timed out; its outcome may be unknown. Refresh the thread or turn snapshot before retrying.`,
    { code: "REQUEST_TIMEOUT", uncertain: true },
  )
}

function connectTimeoutError(stage: string): NativeClientError {
  return new NativeClientError(`Native ${stage} timed out`, { code: "CONNECT_TIMEOUT" })
}

function withTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  timeoutError: NativeClientError,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { onTimeout?.() } catch {}
      reject(timeoutError)
    }, timeoutMs)
    Promise.resolve(operation).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

class KnorviaNativeClient implements NativeClient {
  private readonly options: Required<Pick<NativeClientOptions,
    "reconnectBaseDelayMs" | "reconnectMaxDelayMs" | "maxReconnectAttempts"
    | "requestTimeoutMs" | "connectTimeoutMs">> & NativeClientOptions
  private readonly notifications = new Set<NativeNotificationListener>()
  private readonly stateListeners = new Set<NativeConnectionListener>()
  private readonly pending = new Map<string, PendingRequest>()
  private stateValue: NativeConnectionState = "disconnected"
  private lastError: NativeClientError | undefined
  private requestSequence = 0
  private reconnectAttempt = 0
  private connectPromise: Promise<void> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null
  private socket: NativeWebSocketLike | null = null
  private socketHealthy = false
  private removeDesktopNotification: (() => void) | null = null
  private intentionallyClosed = false

  constructor(options: NativeClientOptions = {}) {
    this.options = {
      ...options,
      reconnectBaseDelayMs: options.reconnectBaseDelayMs ?? 250,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs ?? 5_000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY,
      requestTimeoutMs: boundedTimeout(options.requestTimeoutMs, 30_000),
      connectTimeoutMs: boundedTimeout(options.connectTimeoutMs, 10_000),
    }
  }

  get state(): NativeConnectionState {
    return this.stateValue
  }

  get error(): NativeClientError | undefined {
    return this.lastError
  }

  connect(): Promise<void> {
    if (this.stateValue === "connected") return Promise.resolve()
    this.intentionallyClosed = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    return this.beginConnect(this.stateValue === "reconnecting")
  }

  close(): void {
    this.intentionallyClosed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearStabilityTimer()
    this.socketHealthy = false
    this.removeDesktopNotification?.()
    this.removeDesktopNotification = null
    const socket = this.socket
    this.socket = null
    try { socket?.close(1000, "native client closed") } catch {}
    this.rejectPending(new NativeClientError("Native connection was closed", {
      code: "CONNECTION_CLOSED",
      uncertain: true,
    }))
    this.setState("closed")
  }

  async request<T = unknown>(method: string, params: NativeParams = {}): Promise<T> {
    const deadline = Date.now() + this.options.requestTimeoutMs
    await this.ensureTransportForRequest(method, deadline)
    const remainingTimeoutMs = Math.max(1, deadline - Date.now())
    const request: NativeRpcRequest = {
      jsonrpc: "2.0",
      id: `native-${++this.requestSequence}`,
      method,
      params,
    }
    const bridge = this.desktopBridge()
    if (bridge) {
      let response: NativeRpcResponse
      try {
        response = await withTimeout(
          bridge.request(request),
          remainingTimeoutMs,
          requestTimeoutError(method),
        )
      } catch (error) {
        const nativeError = asNativeError(error, "Native desktop request failed")
        // A timeout does not prove the IPC channel failed. The daemon may have
        // admitted a mutation, so leave the connection available for snapshot
        // reconciliation and never replay it here.
        if (nativeError.code !== "REQUEST_TIMEOUT") this.setState("disconnected", nativeError)
        throw nativeError
      }
      return this.unwrapResponse<T>(response, request.id)
    }
    const socket = this.socket
    if (!socket || socket.readyState !== 1) {
      const error = new NativeClientError("Native WebSocket is not connected")
      this.handleSocketLoss(error)
      throw error
    }
    return new Promise<T>((resolve, reject) => {
      const key = nativeRequestKey(request.id)
      const timer = setTimeout(() => {
        this.rejectPendingRequest(key, requestTimeoutError(method))
      }, remainingTimeoutMs)
      this.pending.set(key, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      try {
        socket.send(JSON.stringify(request))
      } catch (error) {
        const nativeError = asNativeError(error, "Native WebSocket send failed")
        const uncertainError = new NativeClientError(nativeError.message, {
          code: nativeError.code ?? "SEND_FAILED",
          data: nativeError.data,
          cause: nativeError,
          uncertain: true,
        })
        this.rejectPendingRequest(key, uncertainError)
        this.loseSocket(socket, uncertainError)
      }
    })
  }

  subscribe(listener: NativeNotificationListener): () => void {
    this.notifications.add(listener)
    return () => this.notifications.delete(listener)
  }

  onStateChange(listener: NativeConnectionListener): () => void {
    this.stateListeners.add(listener)
    try {
      listener(this.stateValue, {
        state: this.stateValue,
        error: this.lastError,
        reconnectAttempt: this.reconnectAttempt || undefined,
      })
    } catch {}
    return () => this.stateListeners.delete(listener)
  }

  private desktopBridge(): NativeDesktopBridge | undefined {
    return this.options.desktopBridge ?? desktopBridgeFromWindow()
  }

  private beginConnect(reconnecting: boolean): Promise<void> {
    if (this.connectPromise) return this.connectPromise
    this.setState(reconnecting ? "reconnecting" : "connecting", undefined, this.reconnectAttempt || undefined)
    const attempt = this.openTransport()
      .then(() => {
        this.setState("connected")
        this.armStabilityTimer()
      })
      .catch((error) => {
        const nativeError = asNativeError(error, "Unable to connect to the Knorvia native runtime")
        if (this.intentionallyClosed) {
          this.setState("closed", nativeError)
        } else if (this.desktopBridge()) {
          this.setState("disconnected", nativeError)
        } else {
          this.scheduleReconnect(nativeError)
        }
        throw nativeError
      })
    const connection = attempt.finally(() => {
      if (this.connectPromise === connection) this.connectPromise = null
    })
    this.connectPromise = connection
    return connection
  }

  private async openTransport(): Promise<void> {
    const bridge = this.desktopBridge()
    if (bridge) {
      if (!this.removeDesktopNotification) {
        this.removeDesktopNotification = bridge.onNotification((notification) => this.receiveNotification(notification))
      }
      return
    }
    const session = await this.fetchSession()
    if (session.expiresAt <= Date.now()) {
      throw new NativeClientError("Native session bootstrap returned an expired session", { code: "SESSION_EXPIRED" })
    }
    const factory = this.options.webSocketFactory ?? ((url: string, protocols: string[]) => {
      if (typeof WebSocket === "undefined") {
        throw new NativeClientError("WebSocket is unavailable in this environment")
      }
      return new WebSocket(url, protocols) as unknown as NativeWebSocketLike
    })
    // An explicit endpoint is useful for direct loopback development and
    // tests. The session normally supplies the same-origin proxy path, but it
    // must not silently override an address the caller deliberately selected.
    const url = socketUrl(this.options.url || session.url || NATIVE_GATEWAY_PATH)
    const socket = factory(url, [NATIVE_SUBPROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${session.token}`])
    this.socket = socket
    this.socketHealthy = false
    await new Promise<void>((resolve, reject) => {
      let opened = false
      let settled = false
      const failBeforeOpen = (error: NativeClientError) => {
        if (opened || settled) return
        settled = true
        clearTimeout(timer)
        socket.removeEventListener("open", onOpen)
        socket.removeEventListener("error", onError)
        socket.removeEventListener("close", onClose)
        socket.removeEventListener("message", onMessage)
        if (this.socket === socket) this.socket = null
        try { socket.close(1000, "native connection failed") } catch {}
        reject(error)
      }
      const onOpen: EventListener = () => {
        if (settled) return
        opened = true
        settled = true
        clearTimeout(timer)
        socket.removeEventListener("open", onOpen)
        resolve()
      }
      const onError: EventListener = () => {
        if (!opened) {
          failBeforeOpen(new NativeClientError("Native WebSocket connection failed"))
          return
        }
        this.loseSocket(socket, new NativeClientError("Native WebSocket connection failed", {
          code: "CONNECTION_LOST",
          uncertain: true,
        }))
      }
      const onClose: EventListener = () => {
        if (!opened) {
          failBeforeOpen(new NativeClientError("Native WebSocket closed before connecting"))
          return
        }
        this.loseSocket(socket, new NativeClientError("Native WebSocket connection closed", {
          code: "CONNECTION_LOST",
          uncertain: true,
        }))
      }
      const onMessage: EventListener = (event) => {
        // A delayed event from a socket already replaced during reconnect
        // must not alter the current connection's state or retry budget.
        if (this.socket !== socket) return
        this.receiveSocketMessage((event as EventWithData).data)
      }
      const timer = setTimeout(() => {
        failBeforeOpen(connectTimeoutError("WebSocket connection"))
      }, this.options.connectTimeoutMs)
      socket.addEventListener("open", onOpen)
      socket.addEventListener("error", onError)
      socket.addEventListener("close", onClose)
      socket.addEventListener("message", onMessage)
    })
  }

  private async fetchSession(): Promise<NativeGatewaySession> {
    const fetcher = this.options.fetch ?? globalThis.fetch
    if (typeof fetcher !== "function") throw new NativeClientError("fetch is unavailable in this environment")
    const origin = browserOrigin()
    const controller = typeof AbortController === "undefined" ? undefined : new AbortController()
    const response = await withTimeout(fetcher(this.options.sessionPath ?? NATIVE_GATEWAY_SESSION_PATH, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: origin ? { "x-knorvia-native-origin": origin } : undefined,
      signal: controller?.signal,
    }), this.options.connectTimeoutMs, connectTimeoutError("session bootstrap"), () => controller?.abort())
    if (!response.ok) throw new NativeClientError(`Native session bootstrap failed (${response.status})`)
    const session = await withTimeout(
      response.json() as Promise<Partial<NativeGatewaySession>>,
      this.options.connectTimeoutMs,
      connectTimeoutError("session bootstrap response"),
    )
    if (typeof session.token !== "string" || !session.token || typeof session.expiresAt !== "number") {
      throw new NativeClientError("Native session bootstrap returned an invalid session")
    }
    return {
      protocol: typeof session.protocol === "string" ? session.protocol : NATIVE_SUBPROTOCOL,
      url: typeof session.url === "string" ? session.url : undefined,
      token: session.token,
      expiresAt: session.expiresAt,
    }
  }

  private receiveSocketMessage(data: unknown): void {
    if (typeof data !== "string") return
    let message: unknown
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
    if (isNotification(message)) {
      this.markTransportHealthy()
      this.receiveNotification(message)
      return
    }
    if (!isRpcResponse(message)) return
    const response = message as NativeRpcResponse
    if (response.id === null || response.id === undefined) return
    const pending = this.pending.get(nativeRequestKey(response.id))
    if (!pending) return
    this.markTransportHealthy()
    this.pending.delete(nativeRequestKey(response.id))
    clearTimeout(pending.timer)
    if ("error" in response) pending.reject(responseError(response))
    else pending.resolve(response.result)
  }

  private receiveNotification(notification: NativeNotification): void {
    const normalized: NativeNotification = {
      jsonrpc: "2.0",
      method: notification.method,
      params: notification.params && typeof notification.params === "object" ? notification.params : {},
    }
    for (const listener of this.notifications) {
      try { listener(normalized) } catch {}
    }
  }

  private unwrapResponse<T>(response: NativeRpcResponse, expectedId: NativeRpcId): T {
    if (!isRpcResponse(response) || response.id !== expectedId) {
      throw new NativeClientError("Native desktop returned an invalid JSON-RPC response")
    }
    if ("error" in response) throw responseError(response)
    return response.result as T
  }

  private handleSocketLoss(error: NativeClientError): void {
    this.rejectPending(error)
    if (this.intentionallyClosed) return
    this.scheduleReconnect(error)
  }

  /**
   * Drop only the socket that actually failed. A stale close/error from a
   * previous WebSocket otherwise tears down a successfully reconnected one.
   */
  private loseSocket(socket: NativeWebSocketLike, error: NativeClientError): void {
    if (this.socket !== socket) return
    this.socket = null
    this.socketHealthy = false
    this.clearStabilityTimer()
    try { socket.close(1001, "native connection lost") } catch {}
    this.handleSocketLoss(error)
  }

  private markTransportHealthy(): void {
    if (!this.socket) return
    this.socketHealthy = true
    this.reconnectAttempt = 0
    this.clearStabilityTimer()
  }

  private armStabilityTimer(): void {
    this.clearStabilityTimer()
    const socket = this.socket
    if (!socket || this.socketHealthy) return
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null
      if (this.socket !== socket || this.stateValue !== "connected") return
      this.markTransportHealthy()
    }, STABLE_CONNECTION_MS)
  }

  private clearStabilityTimer(): void {
    if (!this.stabilityTimer) return
    clearTimeout(this.stabilityTimer)
    this.stabilityTimer = null
  }

  private async ensureTransportForRequest(method: string, deadline: number): Promise<void> {
    if (this.stateValue === "connected") return
    // Requests issued while an automatic reconnect is already scheduled must
    // wait for that bounded backoff rather than repeatedly cancelling it.
    if (this.stateValue === "reconnecting" && (this.reconnectTimer || this.connectPromise)) {
      await this.waitForConnected(method, deadline)
      return
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new NativeClientError(`Native ${method} could not connect before the request timeout`, {
        code: "CONNECTION_TIMEOUT",
      })
    }
    // `connect()` has its own longer handshake bound for callers that connect
    // proactively. A request needs a stricter total deadline so a mutation
    // never remains pending beyond its stated timeout before it is even sent.
    await withTimeout(
      this.connect(),
      remaining,
      new NativeClientError(`Native ${method} could not connect before the request timeout`, {
        code: "CONNECTION_TIMEOUT",
      }),
    )
  }

  private waitForConnected(method: string, deadline: number): Promise<void> {
    if (this.stateValue === "connected") return Promise.resolve()
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return Promise.reject(new NativeClientError(`Native ${method} could not connect before the request timeout`, {
        code: "CONNECTION_TIMEOUT",
      }))
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: NativeClientError) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.stateListeners.delete(listener)
        if (error) reject(error)
        else resolve()
      }
      const listener: NativeConnectionListener = (state, change) => {
        if (state === "connected") return finish()
        if (state === "closed") {
          return finish(change?.error ?? new NativeClientError("Native connection was closed", {
            code: "CONNECTION_CLOSED",
          }))
        }
        if (state === "disconnected" && !this.reconnectTimer && !this.connectPromise) {
          return finish(change?.error ?? new NativeClientError("Native connection is unavailable", {
            code: "CONNECTION_UNAVAILABLE",
          }))
        }
      }
      const timer = setTimeout(() => finish(new NativeClientError(
        `Native ${method} could not connect before the request timeout`,
        { code: "CONNECTION_TIMEOUT" },
      )), remaining)
      this.stateListeners.add(listener)
      listener(this.stateValue, {
        state: this.stateValue,
        error: this.lastError,
        reconnectAttempt: this.reconnectAttempt || undefined,
      })
    })
  }

  private scheduleReconnect(error: NativeClientError): void {
    if (this.intentionallyClosed || this.desktopBridge() || this.reconnectTimer) {
      if (!this.intentionallyClosed && this.desktopBridge()) this.setState("disconnected", error)
      return
    }
    if (this.reconnectAttempt >= this.options.maxReconnectAttempts) {
      this.setState("disconnected", error, this.reconnectAttempt || undefined)
      return
    }
    this.reconnectAttempt += 1
    this.setState("reconnecting", error, this.reconnectAttempt)
    const delay = Math.min(
      this.options.reconnectMaxDelayMs,
      this.options.reconnectBaseDelayMs * (2 ** Math.max(0, this.reconnectAttempt - 1)),
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.beginConnect(true).catch(() => {})
    }, delay)
  }

  private rejectPending(error: NativeClientError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private rejectPendingRequest(key: string, error: NativeClientError): void {
    const pending = this.pending.get(key)
    if (!pending) return
    this.pending.delete(key)
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  private setState(
    state: NativeConnectionState,
    error?: NativeClientError,
    reconnectAttempt?: number,
  ): void {
    this.stateValue = state
    this.lastError = error
    const change: NativeConnectionChange = { state, error, reconnectAttempt }
    for (const listener of this.stateListeners) {
      try { listener(state, change) } catch {}
    }
  }
}

/**
 * Connect a native workbench to Knorvia Protocol. In Electron it uses the
 * narrow preload bridge; in a browser it bootstraps a short-lived loopback
 * gateway session and communicates over JSON-RPC WebSocket messages.
 */
export function createNativeClient(options: NativeClientOptions = {}): NativeClient {
  return new KnorviaNativeClient(options)
}
