/**
 * Public browser/Desktop contract for the Knorvia native workbench.
 *
 * These types intentionally describe durable Thread/Turn snapshots rather
 * than the retired StreamEvent chat protocol. New optional server fields stay
 * forward-compatible through the open records on every durable resource.
 */

export type NativeRpcId = string | number
export type NativeJsonPrimitive = string | number | boolean | null
export type NativeJsonValue = NativeJsonPrimitive | NativeJsonValue[] | { [key: string]: NativeJsonValue }
// Runtime validation happens at the native transport boundary. Keep the
// browser input record open so callers can pass forward-compatible daemon
// fields without needing a frontend release first.
export type NativeParams = Record<string, unknown>

export type NativeConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"

export type NativeRpcRequest = {
  jsonrpc: "2.0"
  id: NativeRpcId
  method: string
  params: NativeParams
}

export type NativeRpcFailure = {
  jsonrpc: "2.0"
  id: NativeRpcId | null
  error: {
    code: number | string
    message: string
    data?: NativeJsonValue
  }
}

export type NativeRpcSuccess<T = unknown> = {
  jsonrpc: "2.0"
  id: NativeRpcId
  result: T
}

export type NativeRpcResponse<T = unknown> = NativeRpcSuccess<T> | NativeRpcFailure

export type NativeNotification = {
  jsonrpc: "2.0"
  method: string
  params: Record<string, unknown>
}

export type NativeNotificationListener = (notification: NativeNotification) => void

export type NativeConnectionChange = {
  state: NativeConnectionState
  error?: NativeClientError
  reconnectAttempt?: number
}

export type NativeConnectionListener = (
  state: NativeConnectionState,
  change?: NativeConnectionChange,
) => void

export class NativeClientError extends Error {
  readonly code?: number | string
  readonly data?: unknown
  /** The daemon may have applied the request before the client lost its reply. */
  readonly uncertain?: boolean

  constructor(message: string, options: {
    code?: number | string
    data?: unknown
    cause?: unknown
    uncertain?: boolean
  } = {}) {
    super(message)
    this.name = "NativeClientError"
    this.code = options.code
    this.data = options.data
    this.uncertain = options.uncertain
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false })
    }
  }
}

export type NativeItem = {
  id: string
  threadId?: string
  turnId?: string
  kind: string
  status?: string
  seq?: number
  payload?: Record<string, unknown>
  createdAt?: string
  [field: string]: unknown
}

export type NativeApproval = {
  id: string
  threadId?: string
  turnId?: string
  status: string
  action?: string
  digest?: string
  createdAt?: string
  [field: string]: unknown
}

export type NativeUserInput = {
  id: string
  threadId?: string
  turnId?: string
  status?: string
  request?: Record<string, unknown>
  item?: NativeItem
  [field: string]: unknown
}

export type NativeTurnEventParams = {
  threadId: string
  turnId: string
  kind?: string
  payload?: Record<string, unknown>
  item?: NativeItem
  status?: string
  error?: unknown
  [field: string]: unknown
}

export type NativeApprovalRequestParams = {
  approvalId?: string
  threadId: string
  turnId: string
  approval?: NativeApproval
  [field: string]: unknown
}

export type NativeUserInputRequestParams = {
  id: string
  threadId: string
  turnId: string
  request: Record<string, unknown>
  item?: NativeItem
  [field: string]: unknown
}

export type NativeDaemonNotification =
  | (NativeNotification & { method: "turn/event"; params: NativeTurnEventParams })
  | (NativeNotification & { method: "approval/request"; params: NativeApprovalRequestParams })
  | (NativeNotification & { method: "userInput/request"; params: NativeUserInputRequestParams })
  | NativeConnectionStateNotification
  | NativeNotification

export type NativeTurn = {
  id: string
  threadId: string
  status: string
  createdAt?: string
  updatedAt?: string
  error?: unknown
  items?: NativeItem[]
  pendingApprovals?: NativeApproval[]
  [field: string]: unknown
}

export type NativeThread = {
  id: string
  workspaceId: string
  title: string
  status: string
  createdAt?: string
  updatedAt?: string
  revision?: number
  cwd?: string | null
  model?: string | null
  reasoningEffort?: string | null
  serviceTier?: string | null
  [field: string]: unknown
}

/** Durable reconnect snapshot returned by `thread/read`. */
export type NativeThreadSnapshot = NativeThread & {
  turns: NativeTurn[]
  items: NativeItem[]
  pendingApprovals: NativeApproval[]
  /** Product Items whose `payload.request` is a ToolRequestUserInputParams value. */
  pendingUserInputs: NativeItem[]
  activeTurn: NativeTurn | null
  lastTurn: NativeTurn | null
  /** Exclusive numeric cursor for the next older item page. */
  itemsNextCursor?: number | null
  hasMoreItems?: boolean
  /** Exclusive turn id cursor for the next older turn page. */
  turnsNextCursor?: string | null
  hasMoreTurns?: boolean
}

/**
 * Lightweight history entry returned by `thread/list`.
 *
 * It deliberately omits timeline `items` and `turns`; request `thread/read`
 * when a user opens a task or loads an older page.
 */
export type NativeThreadListEntry = NativeThread & {
  pendingApprovals: NativeApproval[]
  /** Product Items whose `payload.request` is a ToolRequestUserInputParams value. */
  pendingUserInputs: NativeItem[]
  activeTurn: NativeTurn | null
  lastTurn: NativeTurn | null
}

export type NativeWorkspace = {
  id: string
  title: string
  /** Canonical persistent workspace folder when the native daemon has one. */
  cwd?: string | null
  revision?: number
  createdAt?: string
  updatedAt?: string
  [field: string]: unknown
}

export type NativeModel = {
  id: string
  label?: string
  provider?: string
  reasoningEfforts?: string[]
  serviceTiers?: string[]
  [field: string]: unknown
}

export type NativeModelList = {
  data: NativeModel[]
  nextCursor?: string | null
  [field: string]: unknown
}

export type NativeSystemHealth = {
  ok: boolean
  product?: string
  server?: string
  [field: string]: unknown
}

/** Non-secret model connection metadata returned by `connection/read`. */
export type NativeProviderProtocol = "responses" | "chat-completions" | "anthropic-messages"
export type NativeConnectionConfig = {
  protocol?: NativeProviderProtocol
  activeProviderId: string
  secureStorageAvailable: boolean
  providers: NativeModelProvider[]
  configured: boolean
  model: string | null
  baseUrl: string | null
  /** Presence only. An API key is never returned through this transport. */
  apiKeyConfigured: boolean
  credentialStorage: "safeStorage" | "session" | "env" | "none" | "unavailable"
  persistent: boolean
  source: {
    model: "safeStorage" | "session" | "env" | "none"
    baseUrl: "safeStorage" | "session" | "env" | "none"
    apiKey: "safeStorage" | "session" | "env" | "none"
  }
  transport: "desktop" | "browser"
  engineState: "starting" | "ready" | "checking" | "restarting" | "stopping" | "unavailable"
  restartRequired: false
  capabilities: {
    selectFolder: boolean
    openPath: boolean
    revealPath: boolean
  }
}

export type NativeModelProvider = {
  protocol?: NativeProviderProtocol
  id: string
  name: string
  revision: number
  model: string | null
  baseUrl: string | null
  configured: boolean
  apiKeyConfigured: boolean
  credentialStorage: NativeConnectionConfig["credentialStorage"]
  persistent: boolean
}

export type NativeProviderSaveParams = NativeConnectionUpdateParams & {
  id?: string
  revision?: number
  name: string
}

/** Emitted while a saved model connection is checked or the daemon is replaced. */
export type NativeConnectionStateNotification = NativeNotification & {
  method: "connection/state"
  params: NativeConnectionConfig
}

/** Omit `apiKey` to keep it. `""` or `clearKey: true` deliberately clears it. */
export type NativeConnectionUpdateParams = NativeParams & {
  protocol?: NativeProviderProtocol
  model?: string
  baseUrl?: string | null
  apiKey?: string
  clearKey?: boolean
}

export type NativeConnectionTest = {
  ok: boolean
  message: string
  /** True only when the daemon successfully queried its real Kernel App Server. */
  kernelReady: boolean
  /** `false` for a catalog-only test because it does not spend a provider request. */
  providerVerified: boolean
  checked: "configuration" | "kernel-model-catalog" | "provider-probe"
  model?: string
  catalogCount?: number
  missing?: string[]
  status?: number
}

export type NativeWorkspacePath = {
  workspace: { id: string; cwd: string }
  /** A canonical path that has already been constrained to `workspace.cwd`. */
  absolutePath: string
  path: string
  kind?: "file" | "directory" | "symlink"
}

export type NativeWorkspaceFileEntry = {
  path: string
  name: string
  kind: "file" | "directory" | "symlink"
  size: number
  isBinary?: boolean | null
  [field: string]: unknown
}

export type NativeWorkspaceFileList = {
  workspace: { id: string; cwd: string }
  path: string
  entries: NativeWorkspaceFileEntry[]
  nextCursor?: string | null
  truncated: boolean
}

export type NativeWorkspaceSearchMatch = {
  path: string
  name: string
  kind: "file" | "symlink"
  line?: number
  column?: number
  snippet?: string
  matchCount?: number
}

export type NativeWorkspaceSearchCoverage = {
  scannedFiles: number
  scannedDirectories: number
  matchedFiles: number
  skippedBinary: number
  skippedLarge: number
  skippedSymlink: number
  ignoredEntries: number
  unreadable: number
  bytesScanned: number
  otherEntries: number
}

export type NativeWorkspaceSearchPage = {
  workspace: { id: string; cwd: string }
  searchId: string
  query: { text: string; mode: "paths" | "content" | "both"; caseSensitive: boolean }
  matches: NativeWorkspaceSearchMatch[]
  page: { index: number; nextCursor?: string | null; done: boolean }
  coverage: NativeWorkspaceSearchCoverage
  matchedTotal: number
  matchedLimitReached: boolean
  scope: {
    root?: string | null
    followsSymlinks: boolean
    skipsHiddenDirectories: boolean
    alwaysSkippedDirectories: string[]
    honoursRootGitignore: boolean
    maxContentFileBytes: number
  }
}

export type NativeWorkspaceFileRead = {
  workspace: { id: string; cwd: string }
  path: string
  kind: "text" | "binary"
  encoding?: "utf-8"
  size: number
  offset: number
  content?: string
  truncated: boolean
  nextOffset?: number | null
}

export type NativeGitFile = {
  path: string
  status: string
  oldPath?: string
}

export type NativeWorkspaceGitStatus = {
  workspace: { id: string; cwd: string }
  available: boolean
  root?: string | null
  branch?: string | null
  head?: string | null
  staged: NativeGitFile[]
  unstaged: NativeGitFile[]
  untracked: NativeGitFile[]
  conflicts: NativeGitFile[]
  clean: boolean
}

export type NativeWorkspaceGitDiff = {
  workspace: { id: string; cwd: string }
  available: boolean
  root?: string | null
  path: string
  staged: boolean
  untracked: boolean
  binary: boolean
  diff: string
  size: number
  truncated: boolean
}

export type NativeWorkspaceWorktree = NativeWorkspace & {
  sourceWorkspaceId: string
  worktree: {
    id: string
    cwd: string
    branch: string
    baseRef: string
    createdAt?: string
  }
}

export type NativeDesktopFolderSelection = {
  cancelled: boolean
  /** Present only after the user chose this folder in the native dialog. */
  path?: string
}

/** Durable automation projection returned by the native daemon. */
export type NativeAutomation = {
  id: string
  workspaceId: string
  title: string
  prompt: string
  status: "active" | "paused"
  revision: number
  schedule: { kind: "interval"; minutes: number } | { kind: "once"; at: number }
  allowWrites: boolean
  model?: string | null
  reasoningEffort?: string | null
  nextRunAt?: number | null
  lastThreadId?: string | null
  lastRunAt?: number | null
  lastError?: string | null
  recentRuns?: NativeAutomationRun[]
  [field: string]: unknown
}

export type NativeAutomationRun = {
  id: string
  automationId: string
  trigger: "scheduled" | "manual"
  status: string
  threadId?: string | null
  turnId?: string | null
  startedAt?: number | null
  finishedAt?: number | null
  error?: string | null
  [field: string]: unknown
}

/** Durable long-running goal projection returned by the native daemon. */
export type NativeGoal = {
  id: string
  workspaceId: string
  title: string
  status: "active" | "paused" | "blocked" | "completed" | "cancelled"
  revision: number
  successCriteria?: string | null
  constraints?: string | null
  nextAction?: string | null
  lastCheckpointAt?: string | null
  completionEvidence?: {
    criteria: string; summary: string; turnId: string; itemId: string; recordedAt: string
  } | null
  [field: string]: unknown
}

/** Task roll-up carried by `goal/read`, so progress is read from durable state. */
export type NativeGoalTaskSummary = {
  total: number
  closed: number
  items: Array<{ id: string; title: string; status: string; [field: string]: unknown }>
}

export type NativeGoalExecution = {
  total: number
  completed: number
  running: number
  readyToComplete: boolean
  completionBlockedReason?: string | null
  threads: Array<{ thread: NativeThread; lastTurn: NativeTurn | null }>
}

export type NativeThreadStartParams = NativeParams & {
  workspaceId: string
  title?: string
  cwd?: string
  model?: string
  reasoningEffort?: string | null
  serviceTier?: string
}

export type NativeTurnStartParams = NativeParams & {
  threadId: string
  input: string
  tools?: { write?: boolean; [field: string]: NativeJsonValue | undefined }
  cwd?: string
  model?: string
  reasoningEffort?: string | null
  serviceTier?: string
}

export type NativeThreadReadParams = NativeParams & {
  id: string
  /** Bounded newest item page size, from 1 through 500. */
  itemLimit?: number
  /** Bounded newest turn page size, from 1 through 500. */
  turnLimit?: number
  /** Exclusive item sequence cursor returned by `itemsNextCursor`. */
  beforeItemSeq?: number
  /** Exclusive turn id cursor returned by `turnsNextCursor`. */
  beforeTurnId?: string
}

export type NativeSoulRevision = {
  revision: number
  soul: string
  updatedAt: string
}

export type NativeBotProfile = {
  id: string
  name: string
  soul: string
  soulRevision: number
  soulHistory?: NativeSoulRevision[]
  backendKind: "kernel" | "cli" | string
  backendBindingId?: string | null
  isDefault: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

export type NativeRoomMember = {
  botId: string
  role: string
  addedAt: string
}

export type NativeRoom = {
  id: string
  kind: "group" | "dm" | string
  title: string
  members: NativeRoomMember[]
  createdAt: string
  updatedAt: string
  revision: number
  readSeq?: number
  checkpoints?: Array<{ version: number; throughSeq: number; summary: string; createdAt: string }>
  unreadCount?: number
  pendingAttention?: number
  lastMessage?: { content: string; createdAt: string; status: string; sender: string; botId?: string | null } | null
}

export type NativeRoomMessage = {
  id: string
  conversationId: string
  seq: number
  sender: "user" | "bot" | "system" | string
  botId?: string | null
  content: string
  createdAt: string
  messageId?: string | null
  correlationId?: string | null
  replyToMessageId?: string | null
  sourceRoomId?: string | null
  targetBotId?: string | null
  artifactRefs?: string[]
  hopCount?: number
  status: "appended" | "delivered" | "acked" | "failed" | string
  meta?: NativeJsonValue
}

export type NativeSessionBinding = {
  id: string
  botId: string
  conversationId: string
  backendBindingId: string
  bindingGeneration: number
  knorviaThreadId?: string | null
  externalSessionId?: string | null
  hostId?: string | null
  accountFingerprint?: string | null
  canonicalCwd?: string | null
  backendVersion?: string | null
  lastDeliveredSeq: number
  status: "active" | "orphaned" | "superseded" | string
  lostReason?: string | null
  createdAt: string
  updatedAt: string
  revision: number
}

export type NativeResolvedBinding = {
  binding: NativeSessionBinding
  action: "created" | "reused" | "regenerated"
}

export type NativeCliBackendStatus = {
  backendId: string
  label: string
  installed: boolean
  resolvedPath?: string | null
  version?: string | null
  authenticated?: boolean | "unknown"
  authState: "connected" | "needs-user" | "not-installed" | "unknown" | string
  capabilities: { installed: boolean; run?: boolean; resume: boolean | "unknown"; streaming: boolean | "unknown"; tools: boolean | "unknown"; cancellation: boolean | "unknown" }
  probeVerified: string
  docs?: string
  checkedAt: string
}

export type NativeMethodMap = {
  "system/health": { params: NativeParams; result: NativeSystemHealth }
  "system/version": { params: NativeParams; result: Record<string, unknown> }
  "connection/read": { params: NativeParams; result: NativeConnectionConfig }
  "connection/provider/save": { params: NativeProviderSaveParams; result: NativeConnectionConfig & { savedProviderId: string } }
  "connection/provider/delete": { params: NativeParams & { id: string; revision: number }; result: NativeConnectionConfig }
  "connection/provider/activate": { params: NativeParams & { id: string; revision?: number }; result: NativeConnectionConfig }
  "connection/update": { params: NativeConnectionUpdateParams; result: NativeConnectionConfig }
  "connection/test": { params: NativeParams & { probeProvider?: boolean }; result: NativeConnectionTest }
  "desktop/select-folder": { params: NativeParams & { defaultPath?: string }; result: NativeDesktopFolderSelection }
  "desktop/open-path": { params: NativeParams & { workspaceId?: string; threadId?: string; path: string }; result: { opened: true; kind: "file" | "directory" } }
  "desktop/reveal-path": { params: NativeParams & { workspaceId?: string; threadId?: string; path: string }; result: { revealed: true; kind: "file" | "directory" } }
  "workspace/create": { params: NativeParams & { title: string; cwd?: string }; result: NativeWorkspace }
  "workspace/read": { params: NativeParams & { id: string }; result: NativeWorkspace }
  "workspace/list": { params: NativeParams; result: NativeWorkspace[] }
  "workspace/update": { params: NativeParams & { id: string; title?: string; cwd?: string | null; expectedRevision?: number }; result: NativeWorkspace }
  "workspace/path/resolve": { params: NativeParams & { workspaceId?: string; threadId?: string; path?: string }; result: NativeWorkspacePath }
  "workspace/files/list": { params: NativeParams & { workspaceId?: string; threadId?: string; path?: string; cursor?: string; limit?: number }; result: NativeWorkspaceFileList }
  "workspace/files/read": { params: NativeParams & { workspaceId?: string; threadId?: string; path: string; offset?: number; maxBytes?: number }; result: NativeWorkspaceFileRead }
  "workspace/files/search": { params: NativeParams & { workspaceId?: string; threadId?: string; query: string; mode?: "paths" | "content" | "both"; maxResults?: number; caseSensitive?: boolean; searchId?: string; cursor?: string }; result: NativeWorkspaceSearchPage }
  "workspace/files/search/cancel": { params: NativeParams & { searchId: string }; result: { cancelled: boolean; searchId: string } }
  "workspace/git/status": { params: NativeParams & { workspaceId?: string; threadId?: string }; result: NativeWorkspaceGitStatus }
  "workspace/git/diff": { params: NativeParams & { workspaceId?: string; threadId?: string; path: string; staged?: boolean; maxBytes?: number }; result: NativeWorkspaceGitDiff }
  "workspace/worktree/create": { params: NativeParams & { workspaceId?: string; threadId?: string; branch: string; baseRef?: string; title?: string }; result: NativeWorkspaceWorktree }
  "thread/start": { params: NativeThreadStartParams; result: NativeThread }
  "thread/read": { params: NativeThreadReadParams; result: NativeThreadSnapshot }
  "thread/list": { params: NativeParams & { workspaceId: string; limit?: number; afterId?: string }; result: NativeThreadListEntry[] | { threads: NativeThreadListEntry[]; nextCursor: string | null } }
  "thread/resume": { params: NativeParams & { id: string }; result: NativeThreadSnapshot }
  "thread/fork": { params: NativeParams & { threadId: string; title?: string; cwd?: string; model?: string; reasoningEffort?: string; serviceTier?: string }; result: NativeThread }
  "thread/update": { params: NativeParams & { id: string; title?: string; cwd?: string; model?: string; reasoningEffort?: string; serviceTier?: string; expectedRevision?: number }; result: NativeThread }
  "thread/archive": { params: NativeParams & { id: string }; result: NativeThread }
  "thread/unarchive": { params: NativeParams & { id: string }; result: NativeThread }
  "turn/start": { params: NativeTurnStartParams; result: NativeTurn | { turn: NativeTurn; items?: NativeItem[]; pendingApprovalId?: string | null; [field: string]: unknown } }
  "turnQueue/read": { params: NativeParams & { threadId: string }; result: import("./native-message-queue").MessageQueue }
  "turnQueue/enqueue": { params: NativeParams & { threadId: string; requestId: string; idempotencyKey: string; input: string; options: NativeParams }; result: import("./native-message-queue").MessageQueue }
  "turnQueue/cancel": { params: NativeParams & { threadId: string; revision: number; messageId: string }; result: import("./native-message-queue").MessageQueue }
  "turnQueue/pause": { params: NativeParams & { threadId: string; revision: number }; result: import("./native-message-queue").MessageQueue }
  "turnQueue/resume": { params: NativeParams & { threadId: string; revision: number }; result: import("./native-message-queue").MessageQueue }
  "turn/read": { params: NativeParams & { id: string }; result: NativeTurn }
  "turn/steer": { params: NativeParams & { threadId: string; turnId: string; input: string; clientMessageId?: string }; result: { turnId: string; item: NativeItem } }
  "turn/interrupt": { params: NativeParams & { turnId: string }; result: NativeTurn }
  "approval/respond": { params: NativeParams & { id: string; decision: "allow" | "deny" }; result: NativeApproval }
  "userInput/respond": { params: NativeParams & { id: string; answers: Record<string, { answers: string[] }> }; result: { item: NativeItem } }
  "model/list": { params: NativeParams; result: NativeModelList }
  "skills/list": { params: NativeParams & { cwds?: string[]; forceReload?: boolean }; result: { data: Array<{ cwd: string; skills: Record<string, unknown>[] }> } }
  "capability/list": { params: NativeParams; result: unknown[] }
  "capability/invoke": { params: NativeParams; result: Record<string, unknown> }
  "capability/cancel": { params: NativeParams; result: Record<string, unknown> }
  "capability/resume": { params: NativeParams; result: Record<string, unknown> }
  "artifact/content": { params: NativeParams & { id: string; revisionId?: string }; result: { artifact: Record<string, unknown>; revision: Record<string, unknown>; content: string } }
  "artifact/create": { params: NativeParams; result: Record<string, unknown> }
  "artifact/read": { params: NativeParams & { id: string }; result: Record<string, unknown> }
  "artifact/list": { params: NativeParams; result: Record<string, unknown>[] }
  "artifact/stage": { params: NativeParams; result: Record<string, unknown> }
  "artifact/commit": { params: NativeParams; result: Record<string, unknown> }
  "automation/list": { params: NativeParams; result: { automations: NativeAutomation[] } }
  "automation/create": { params: NativeParams; result: { automation: NativeAutomation } }
  "automation/update": { params: NativeParams; result: { automation: NativeAutomation } }
  "automation/delete": { params: NativeParams; result: { deleted: true } }
  "automation/run": { params: NativeParams; result: { automation: NativeAutomation; runId: string; threadId: string } }
  "goal/create": { params: NativeParams & { workspaceId: string; title: string }; result: NativeGoal }
  "goal/read": { params: NativeParams & { id: string }; result: NativeGoal & { tasks?: NativeGoalTaskSummary; execution?: NativeGoalExecution } }
  "goal/run": { params: NativeParams & { id: string; revision: number; input?: string; threadId?: string }; result: { goalId: string; threadId: string; turn: NativeTurn } }
  "goal/evidence/add": { params: NativeParams & { id: string; revision: number; turnId: string; itemId: string; summary: string }; result: NativeGoal }
  "goal/list": { params: NativeParams & { workspaceId: string }; result: { goals: NativeGoal[] } }
  "goal/update": { params: NativeParams & {
    id: string
    title?: string
    status?: NativeGoal["status"]
    successCriteria?: string
    constraints?: string
    nextAction?: string
    checkpoint?: boolean
    revision?: number
  }; result: NativeGoal }
  "bot/ensureDefault": { params: NativeParams; result: NativeBotProfile }
  "bot/create": { params: NativeParams & { name: string; soul?: string; backendKind?: "kernel" | "cli"; backendBindingId?: string }; result: NativeBotProfile }
  "bot/read": { params: NativeParams & { botId: string }; result: NativeBotProfile }
  "bot/list": { params: NativeParams; result: NativeBotProfile[] }
  "bot/updateSoul": { params: NativeParams & { botId: string; soul: string; expectedRevision?: number }; result: NativeBotProfile }
  "bot/rename": { params: NativeParams & { botId: string; name: string; expectedRevision?: number }; result: NativeBotProfile }
  "room/create": { params: NativeParams & { kind: "group" | "dm"; title: string; botIds: string[] }; result: NativeRoom }
  "room/ensureDm": { params: NativeParams & { botId: string }; result: NativeRoom }
  "room/read": { params: NativeParams & { conversationId: string }; result: NativeRoom }
  "room/list": { params: NativeParams; result: NativeRoom[] }
  "room/rename": { params: NativeParams & { conversationId: string; title: string; expectedRevision?: number }; result: NativeRoom }
  "room/addMember": { params: NativeParams & { conversationId: string; botId: string; expectedRevision?: number }; result: NativeRoom }
  "room/removeMember": { params: NativeParams & { conversationId: string; botId: string; expectedRevision?: number }; result: NativeRoom }
  "room/send": { params: NativeParams & { conversationId: string; content: string; workspaceId?: string; accountFingerprint?: string; timeoutSecs?: number }; result: { userMessage: NativeRoomMessage; dispatched: Array<{ botId: string }> } }
  "room/messages": { params: NativeParams & { conversationId: string; fromSeq?: number; limit?: number; latest?: boolean }; result: { messages: NativeRoomMessage[]; head: number; attention?: NativeRoomMessage[] } }
  "room/checkpoint": { params: NativeParams & { conversationId: string; summary: string; throughSeq: number; expectedRevision: number }; result: NativeRoom }
  "room/markRead": { params: NativeParams & { conversationId: string; seq: number }; result: NativeRoom }
  "room/attention/resolve": { params: NativeParams & { conversationId: string; messageId: string }; result: NativeRoomMessage }
  "room/interrupt": { params: NativeParams & { conversationId: string }; result: { interrupted: boolean; reason?: string } }
  "sessionBinding/resolve": { params: NativeParams & { botId: string; conversationId: string; backendBindingId: string; hostId?: string; accountFingerprint?: string; canonicalCwd?: string; backendVersion?: string }; result: NativeResolvedBinding }
  "sessionBinding/attach": { params: NativeParams & { bindingId: string; knorviaThreadId?: string; createThread?: boolean; workspaceId?: string; externalSessionId?: string; expectedRevision?: number }; result: NativeSessionBinding & { threadId?: string } }
  "sessionBinding/markLost": { params: NativeParams & { bindingId: string; reason: string; expectedRevision?: number }; result: NativeSessionBinding }
  "sessionBinding/recordDelivery": { params: NativeParams & { bindingId: string; seq: number; expectedRevision?: number }; result: NativeSessionBinding }
  "sessionBinding/read": { params: NativeParams & { bindingId: string }; result: NativeSessionBinding }
  "sessionBinding/list": { params: NativeParams & { botId?: string; conversationId?: string }; result: NativeSessionBinding[] }
  "cliBackend/list": { params: NativeParams; result: { backends: NativeCliBackendStatus[] } }
  "cliBackend/status": { params: NativeParams & { backendId: string }; result: NativeCliBackendStatus }
  "cliBackend/runTurn": { params: NativeParams & { backendId: string; prompt: string; cwd?: string; sessionId?: string; resume?: boolean; timeoutMs?: number }; result: { runId: string; backendId: string; text: string | null; sessionId: string | null; exitCode: number; durationMs: number } }
  "cliBackend/cancel": { params: NativeParams & { runId?: string }; result: { canceled: boolean; reason?: string; runId?: string; pid?: number } }
  "studio/content": { params: NativeParams & { id: string; index?: number; offset?: number }; result: { name: string; mime: string; size: number; sha256: string; base64: string; nextOffset: number | null } }
  "studio/library": { params: NativeParams & { id: string; index?: number; path?: string }; result: Record<string, unknown> }
  // C19: scoped revocable media-preview capabilities. preview/read returns
  // a loopback stream URL (instead of base64) for video/audio/PDF and large
  // images when the media preview service is active; the renderer revokes
  // on panel close or scope switch.
  "preview/revoke": { params: NativeParams & { token: string }; result: { revoked: boolean } }
  "preview/revokeScope": { params: NativeParams & { workspaceId?: string; threadId?: string }; result: { revoked: number } }
}

export type NativeMethod = keyof NativeMethodMap
export type NativeMethodParams<M extends NativeMethod> = NativeMethodMap[M]["params"]
export type NativeMethodResult<M extends NativeMethod> = NativeMethodMap[M]["result"]

export type NativeDesktopBridge = {
  request(message: NativeRpcRequest): Promise<NativeRpcResponse>
  onNotification(listener: NativeNotificationListener): () => void
}

export type NativeWebSocketLike = {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: "open" | "close" | "error" | "message", listener: EventListener): void
  removeEventListener(type: "open" | "close" | "error" | "message", listener: EventListener): void
}

export type NativeGatewaySession = {
  protocol: string
  url?: string
  token: string
  expiresAt: number
}

export type NativeClientOptions = {
  /** WebSocket path used after session bootstrap; defaults to `/api/knorvia/native`. */
  url?: string
  /** Same-origin bootstrap endpoint; defaults to `/api/knorvia/native/session`. */
  sessionPath?: string
  reconnectBaseDelayMs?: number
  reconnectMaxDelayMs?: number
  maxReconnectAttempts?: number
  /** Bounds a request after it has been sent; defaults to 30 seconds. */
  requestTimeoutMs?: number
  /** Bounds session bootstrap and WebSocket opening; defaults to 10 seconds. */
  connectTimeoutMs?: number
  fetch?: typeof fetch
  webSocketFactory?: (url: string, protocols: string[]) => NativeWebSocketLike
  desktopBridge?: NativeDesktopBridge
}

export interface NativeClient {
  readonly state: NativeConnectionState
  readonly error?: NativeClientError
  connect(): Promise<void>
  close(): void
  request<T = unknown>(method: string, params?: NativeParams): Promise<T>
  subscribe(listener: NativeNotificationListener): () => void
  onStateChange(listener: NativeConnectionListener): () => void
}

export type DesktopOpenThreadListener = (threadId: string) => void

export interface DesktopNotificationsBridge {
  setPreferences?(prefs: { enabled: boolean; completed: boolean; failed: boolean; cancelled: boolean; interrupted: boolean }): void
  onOpenThread(callback: DesktopOpenThreadListener): () => void
}
