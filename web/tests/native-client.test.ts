import assert from "node:assert/strict"
import test from "node:test"

import { createNativeClient } from "../lib/knorvia-native-client"
import type {
  NativeDesktopBridge,
  NativeNotification,
  NativeRpcRequest,
  NativeWebSocketLike,
} from "../lib/knorvia-native-types"

class MockSocket implements NativeWebSocketLike {
  readyState = 0
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<EventListener>>()

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket is closed")
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit("close")
  }

  addEventListener(type: "open" | "close" | "error" | "message", listener: EventListener): void {
    const group = this.listeners.get(type) ?? new Set<EventListener>()
    group.add(listener)
    this.listeners.set(type, group)
  }

  removeEventListener(type: "open" | "close" | "error" | "message", listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  open(): void {
    this.readyState = 1
    this.emit("open")
  }

  message(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) } as unknown as Event)
  }

  disconnect(): void {
    this.readyState = 3
    this.emit("close")
  }

  private emit(type: string, event: Event = {} as Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() > deadline) return reject(new Error("timed out"))
      setTimeout(tick, 2)
    }
    tick()
  })
}

test("native client uses the typed desktop JSON-RPC bridge and forwards notifications", async () => {
  const listeners = new Set<(notification: NativeNotification) => void>()
  const requests: NativeRpcRequest[] = []
  const bridge: NativeDesktopBridge = {
    request: async (request) => {
      requests.push(request)
      return { jsonrpc: "2.0", id: request.id, result: { id: "thread-1" } }
    },
    onNotification: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const client = createNativeClient({ desktopBridge: bridge })
  const states: string[] = []
  const events: NativeNotification[] = []
  const stopState = client.onStateChange((state) => states.push(state))
  const stopEvents = client.subscribe((event) => events.push(event))
  await client.connect()
  assert.equal(client.state, "connected")
  assert.deepEqual(await client.request<{ id: string }>("thread/read", { id: "thread-1" }), { id: "thread-1" })
  assert.equal(requests[0].jsonrpc, "2.0")
  assert.equal(requests[0].method, "thread/read")
  for (const listener of listeners) listener({
    jsonrpc: "2.0", method: "turn/event", params: { threadId: "thread-1", status: "running" },
  })
  assert.equal(events[0].method, "turn/event")
  assert.ok(states.includes("connected"))
  stopState()
  stopEvents()
  client.close()
  assert.equal(client.state, "closed")
})

test("native client reconnects after a WebSocket loss without replaying a mutation", async () => {
  const sockets: MockSocket[] = []
  const client = createNativeClient({
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 2,
    fetch: async () => new Response(JSON.stringify({
      token: `token-${sockets.length}`,
      expiresAt: Date.now() + 60_000,
      url: "ws://127.0.0.1:4318/knorvia/native",
    })) as Response,
    webSocketFactory: () => {
      const socket = new MockSocket()
      sockets.push(socket)
      queueMicrotask(() => socket.open())
      return socket
    },
  })
  await client.connect()
  const inFlight = client.request("turn/start", { threadId: "thread-1", input: "do not replay" })
  await waitFor(() => sockets[0].sent.length === 1)
  sockets[0].disconnect()
  await assert.rejects(inFlight, /connection closed/)
  await waitFor(() => client.state === "connected" && sockets.length === 2)
  assert.equal(sockets[0].sent.length, 1)
  assert.equal(sockets[1].sent.length, 0)
  client.close()
})

test("native client bounds an unanswered mutation without replaying its uncertain outcome", async () => {
  const sockets: MockSocket[] = []
  const client = createNativeClient({
    requestTimeoutMs: 15,
    fetch: async () => new Response(JSON.stringify({
      token: "timeout-token",
      expiresAt: Date.now() + 60_000,
      url: "ws://127.0.0.1:4318/knorvia/native",
    })) as Response,
    webSocketFactory: () => {
      const socket = new MockSocket()
      sockets.push(socket)
      queueMicrotask(() => socket.open())
      return socket
    },
  })
  await client.connect()
  const pending = client.request("turn/start", { threadId: "thread-1", input: "may have reached daemon" })
  await waitFor(() => sockets[0].sent.length === 1)
  await assert.rejects(pending, (error: unknown) => {
    assert.equal((error as { code?: string }).code, "REQUEST_TIMEOUT")
    assert.equal((error as { uncertain?: boolean }).uncertain, true)
    return true
  })
  assert.equal(client.state, "connected")
  assert.equal(sockets[0].sent.length, 1)
  sockets[0].message({ jsonrpc: "2.0", id: "native-1", result: { ignored: true } })
  assert.equal(sockets[0].sent.length, 1)
  client.close()
})

test("native client honors an explicit gateway address over a session default", async () => {
  let openedUrl = ""
  const client = createNativeClient({
    url: "ws://127.0.0.1:4999/explicit-native",
    fetch: async () => new Response(JSON.stringify({
      token: "override-token",
      expiresAt: Date.now() + 60_000,
      url: "ws://127.0.0.1:4318/session-native",
    })) as Response,
    webSocketFactory: (url) => {
      openedUrl = url
      const socket = new MockSocket()
      queueMicrotask(() => socket.open())
      return socket
    },
  })
  try {
    await client.connect()
    assert.equal(openedUrl, "ws://127.0.0.1:4999/explicit-native")
  } finally {
    client.close()
  }
})

test("native client applies a request deadline while connection bootstrap is still pending", async () => {
  const client = createNativeClient({
    requestTimeoutMs: 15,
    connectTimeoutMs: 20,
    fetch: () => new Promise<Response>(() => {}),
  })
  try {
    await assert.rejects(client.request("turn/start", { threadId: "thread-1", input: "bounded before send" }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CONNECTION_TIMEOUT")
      assert.equal((error as { uncertain?: boolean }).uncertain, undefined)
      return true
    })
  } finally {
    client.close()
  }
})

test("native client keeps exponential backoff when a proxy opens then immediately closes sockets", async () => {
  const sockets: MockSocket[] = []
  const client = createNativeClient({
    reconnectBaseDelayMs: 40,
    reconnectMaxDelayMs: 200,
    fetch: async () => new Response(JSON.stringify({
      token: `flap-${sockets.length}`,
      expiresAt: Date.now() + 60_000,
      url: "ws://127.0.0.1:4318/knorvia/native",
    })) as Response,
    webSocketFactory: () => {
      const socket = new MockSocket()
      sockets.push(socket)
      queueMicrotask(() => socket.open())
      return socket
    },
  })
  try {
    await client.connect()
    const firstClosedAt = Date.now()
    sockets[0].disconnect()
    await waitFor(() => sockets.length === 2 && client.state === "connected")
    const firstReconnectDelay = Date.now() - firstClosedAt

    const secondClosedAt = Date.now()
    sockets[1].disconnect()
    await waitFor(() => sockets.length === 3 && client.state === "connected")
    const secondReconnectDelay = Date.now() - secondClosedAt

    assert.ok(firstReconnectDelay >= 25, `first reconnect was ${firstReconnectDelay}ms`)
    assert.ok(secondReconnectDelay >= 65, `second reconnect was ${secondReconnectDelay}ms`)
  } finally {
    client.close()
  }
})

test("late events from a replaced socket cannot tear down its successor", async () => {
  const sockets: MockSocket[] = []
  const client = createNativeClient({
    reconnectBaseDelayMs: 45,
    reconnectMaxDelayMs: 100,
    fetch: async () => new Response(JSON.stringify({
      token: `stale-${sockets.length}`,
      expiresAt: Date.now() + 60_000,
      url: "ws://127.0.0.1:4318/knorvia/native",
    })) as Response,
    webSocketFactory: () => {
      const socket = new MockSocket()
      sockets.push(socket)
      queueMicrotask(() => socket.open())
      return socket
    },
  })
  try {
    await client.connect()
    sockets[0].disconnect()
    await waitFor(() => sockets.length === 2 && client.state === "connected")
    // Browser implementations may emit a delayed duplicate close/error from
    // a previous socket after its replacement is already open.
    sockets[0].disconnect()
    await new Promise(resolve => setTimeout(resolve, 70))
    assert.equal(client.state, "connected")
    assert.equal(sockets.length, 2)
  } finally {
    client.close()
  }
})
