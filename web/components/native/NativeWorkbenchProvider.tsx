"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createNativeClient } from "@/lib/knorvia-native-client";
import type { NativeConnectionConfig } from "@/lib/knorvia-native-types";
import { I18nProvider } from "@/i18n/I18nProvider";
import DesktopChrome from "@/components/layout/DesktopChrome";
import { WorkbenchBackground } from './WorkbenchBackground';
import { WorkbenchArrival } from './WorkbenchArrival';
import { mergeThreadIndex, readPagedThreadIndex } from "@/lib/native-thread-index";
import { setTheme, getStoredTheme, getSystemTheme, applyThemeToDocument, isDarkTheme, subscribeToThemeChanges, THEME_STORAGE_KEY, type Theme } from "@/lib/theme";
import { applyWindowFrostToDocument, readStoredWindowFrost, subscribeToWindowFrost, saveWindowFrost, type WindowFrostState, DEFAULT_FROST_CLARITY, DEFAULT_FROST_PLATES } from "@/lib/window-frost";
import { addDelta, itemHistory, mergeSnapshot, needsHistoryBridge, reconcileLive, withItemHistory, type Artifact, type LiveText, type Model, type NativeEvent, type SnapshotMergeOptions, type Thread, type ThreadSnapshot, type Workspace } from "@/lib/native-workbench-state";
import { lightThread, readThreadsBounded, ThreadCache } from "@/lib/native-thread-cache";
import { recoveryKindOf, recoveryKindOfMessage, type PersistenceRecovery, type RecoveryErrorKind } from "@/lib/native-recovery-error";

type StartOptions = { workspaceId: string; model?: string; reasoningEffort?: string; cwd?: string; write: boolean; submissionId?: string };
type WorkbenchContext = {
  locale: "zh" | "en"; t: (zh: string, en: string) => string; toggleLocale: () => void;
  theme: Theme; toggleTheme: () => void; chooseTheme: (theme: Theme) => void;
  frost: WindowFrostState; setFrost: (state: WindowFrostState) => void;
  connection: string; error: string; errorKind: RecoveryErrorKind; notice: string;
  recovery: PersistenceRecovery | null; clearRecovery: () => void;
  connectionInfo: NativeConnectionConfig | null;
  setError: (error: string | unknown) => void; setNotice: (message: string) => void;
  workspaces: Workspace[]; threads: Thread[]; threadIndexComplete: boolean; models: Model[]; modelError: string;
  workspaceId: string; setWorkspaceId: (id: string) => void; snapshots: Record<string, ThreadSnapshot>; live: LiveText[];
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  refresh: () => Promise<void>; readThread: (id: string, beforeItemSeq?: number) => Promise<ThreadSnapshot>;
  newTask: (input: string, options: StartOptions) => Promise<string>;
  sendTurn: (id: string, input: string, options: Omit<StartOptions, "workspaceId">) => Promise<void>;
  saveResult: (thread: Thread, content: string) => Promise<Artifact>;
  reconnect: () => Promise<void>;
  /** Keep a thread's full session in the bounded cache (side chat, exports). */
  pinThread: (id: string) => () => void;
};
const Context = createContext<WorkbenchContext | null>(null);
export function useWorkbench() {
  const value = useContext(Context);
  if (!value) throw new Error("Native workbench provider missing");
  return value;
}
export function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

export function NativeWorkbenchProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const activeThreadIdRef = useRef<string | null>(null);
  const clientRef = useRef<ReturnType<typeof createNativeClient> | null>(null);
  const [connection, setConnection] = useState("connecting");
  const [connectionInfo, setConnectionInfo] = useState<NativeConnectionConfig | null>(null);
  const [locale, setLocale] = useState<"zh" | "en">("en");
  const [theme, setThemeState] = useState<Theme>("snow");
  const [frost, setFrostState] = useState<WindowFrostState>({ enabled: false, clarity: DEFAULT_FROST_CLARITY, plates: DEFAULT_FROST_PLATES });
  useEffect(() => {
    const readAppearance = () => {
      const selected = getStoredTheme() ?? getSystemTheme();
      applyThemeToDocument(selected);
      setThemeState(selected);
      const effect = readStoredWindowFrost();
      applyWindowFrostToDocument(effect);
      setFrostState(effect);
    };
    readAppearance();
    const stopTheme = subscribeToThemeChanges(setThemeState);
    const stopFrost = subscribeToWindowFrost(setFrostState);
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === THEME_STORAGE_KEY || event.key?.startsWith("knorvia-frost-") || event.key === "knorvia-window-frost") readAppearance();
    };
    window.addEventListener("storage", storage);
    return () => { stopTheme(); stopFrost(); window.removeEventListener("storage", storage); };
  }, []);
  const [error, setErrorState] = useState("");
  const [errorKind, setErrorKind] = useState<RecoveryErrorKind>("generic");
  const [recovery, setRecovery] = useState<PersistenceRecovery | null>(null);
  const clearRecovery = useCallback(() => setRecovery(null), []);
  // B07: the banner keeps the error's structured category so its action can
  // match the cause instead of always offering a reconnect.
  const setError = useCallback((input: string | unknown) => {
    if (typeof input === "string") { setErrorState(input); setErrorKind(recoveryKindOfMessage(input)); return; }
    setErrorState(errorText(input));
    setErrorKind(recoveryKindOf(input));
  }, []);
  const [notice, setNotice] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadIndexComplete, setThreadIndexComplete] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [modelError, setModelError] = useState("");
  const [workspaceId, setWorkspaceIdState] = useState("");
  const workspaceRef = useRef("");
  const [snapshots, setSnapshots] = useState<Record<string, ThreadSnapshot>>({});
  const snapshotsRef = useRef(snapshots);
  // B12: full session snapshots live in a bounded cache; the threads index
  // keeps light rows only, so an entry's history is reclaimable and recovery
  // after reconnect is budgeted instead of a Promise.all over every task.
  const snapshotsCache = useRef(new ThreadCache({ maxEntries: 30, maxItems: 6000 }));
  const pinnedThreads = useRef(new Set<string>());
  const [live, setLive] = useState<LiveText[]>([]);
  const activeThreadId = pathname?.startsWith("/workbench/task/") ? decodeURIComponent(pathname.slice("/workbench/task/".length)) : null;
  activeThreadIdRef.current = activeThreadId;
  const readGeneration = useRef(new Map<string, number>());
  const itemNotificationGeneration = useRef(new Map<string, number>());
  const refreshGeneration = useRef(0);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const threadSnapshotGeneration = useRef(new Map<string, number>());
  const t = useCallback((zh: string, en: string) => locale === "zh" ? zh : en, [locale]);

  const setWorkspaceId = useCallback((id: string) => {
    workspaceRef.current = id;
    setWorkspaceIdState(id);
    try { localStorage.setItem("knorvia-native-workspace", id); } catch { /* optional UI preference */ }
  }, []);

  const request = useCallback(async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (!clientRef.current) throw new Error("Knorvia is connecting");
    const result = await clientRef.current.request<T>(method, params);
    if (method === "connection/read" || method === "connection/update" || method.startsWith("connection/provider/")) {
      setConnectionInfo(result as NativeConnectionConfig);
    }
    return result;
  }, []);

  const applySnapshot = useCallback((snapshot: ThreadSnapshot, options: SnapshotMergeOptions = {}) => {
    threadSnapshotGeneration.current.set(snapshot.id, (threadSnapshotGeneration.current.get(snapshot.id) ?? 0) + 1);
    const merged = mergeSnapshot(snapshotsRef.current[snapshot.id], snapshot, options);
    const cache = snapshotsCache.current;
    cache.set(snapshot.id, merged);
    // Tasks waiting for the user are never evicted; everything else yields to
    // the entry/item budgets, oldest touch first.
    const evicted = cache.evict((id, entry) => id === activeThreadIdRef.current
      || pinnedThreads.current.has(id)
      || Boolean(entry.snapshot.pendingApprovals?.some(approval => approval.status === "pending"))
      || Boolean(entry.snapshot.pendingUserInputs?.length));
    const next = cache.record();
    snapshotsRef.current = next;
    setSnapshots(next);
    setLive(current => reconcileLive(current, merged));
    // An authoritative snapshot for the thread ends its persistence recovery:
    // durable state is confirmed again, so the transient hint must disappear
    // instead of pretending the task is still unconfirmed.
    setRecovery(current => current?.threadId === snapshot.id ? null : current);
    if (evicted.includes(snapshot.id)) return;
    const row = lightThread(merged);
    setThreads(current => current.some(thread => thread.id === row.id)
      ? current.map(thread => thread.id === row.id ? { ...thread, ...row } : thread)
      : [row, ...current]);
  }, []);

  const pinThread = useCallback((id: string) => {
    pinnedThreads.current.add(id);
    snapshotsCache.current.pin(id, true);
    return () => {
      pinnedThreads.current.delete(id);
      snapshotsCache.current.pin(id, false);
    };
  }, []);

  const readThread = useCallback(async (id: string, beforeItemSeq?: number) => {
    const generation = (readGeneration.current.get(id) ?? 0) + 1;
    readGeneration.current.set(id, generation);
    const previous = snapshotsRef.current[id];
    const knownHistory = itemHistory(previous);
    const notificationsAtStart = itemNotificationGeneration.current.get(id) ?? 0;
    let snapshot = await request<ThreadSnapshot>("thread/read", { id, ...(beforeItemSeq === undefined ? {} : { beforeItemSeq }) });
    if (beforeItemSeq === undefined && knownHistory?.latestPageSeq !== undefined) {
      // A notification may precede reconnect reconciliation. Bridge from the
      // newest page to the *previous server-page ceiling*, not to its newest
      // live Item, so intermediate history cannot be skipped.
      const newestPageSeq = itemHistory(snapshot)?.latestPageSeq;
      let lastPage = snapshot;
      const cursors = new Set<number>();
      while (needsHistoryBridge(lastPage, knownHistory)) {
        if (readGeneration.current.get(id) !== generation) return snapshot;
        const cursor = lastPage.itemsNextCursor!;
        if (cursors.has(cursor)) throw new Error("Task history cursor did not advance");
        cursors.add(cursor);
        const page = await request<ThreadSnapshot>("thread/read", { id, beforeItemSeq: cursor });
        snapshot = mergeSnapshot(snapshot, page, { source: "older" });
        lastPage = page;
      }
      const reachedKnownHistory = lastPage.hasMoreItems === false
        || lastPage.items.some(item => item.seq <= knownHistory.latestPageSeq!);
      if (reachedKnownHistory) {
        const complete = lastPage.hasMoreItems === false ? true : knownHistory.complete;
        snapshot = withItemHistory(snapshot, {
          latestPageSeq: newestPageSeq ?? knownHistory.latestPageSeq,
          nextCursor: complete ? null : knownHistory.nextCursor,
          complete,
        });
      }
    } else if (beforeItemSeq !== undefined && knownHistory?.nextCursor === beforeItemSeq) {
      // A user-requested older page extends the same chain. Its cursor is the
      // only cursor allowed to advance; a stale duplicate cannot rewind it.
      const pageHistory = itemHistory(snapshot);
      if (pageHistory) {
        snapshot = withItemHistory(snapshot, {
          latestPageSeq: knownHistory.latestPageSeq ?? pageHistory.latestPageSeq,
          nextCursor: pageHistory.nextCursor,
          complete: pageHistory.complete,
        });
      }
    }
    if (readGeneration.current.get(id) === generation) {
      applySnapshot(snapshot, { preserveCurrent: (itemNotificationGeneration.current.get(id) ?? 0) !== notificationsAtStart });
    }
    return snapshot;
  }, [request, applySnapshot]);

  // B12: reconnect recovery re-reads cached tasks with a small worker pool,
  // visible task first; one failing task never blocks the others.
  const readBackCached = useCallback(async () => {
    const cache = snapshotsCache.current;
    const priority = (id: string) => (id === activeThreadIdRef.current ? 0 : pinnedThreads.current.has(id) ? 1 : 2);
    const ordered = cache.keys().sort((a, b) => priority(a) - priority(b) || (cache.get(b)?.updatedAt ?? "").localeCompare(cache.get(a)?.updatedAt ?? ""));
    const { failed } = await readThreadsBounded(ordered, id => readThread(id), { concurrency: 3 });
    if (Object.keys(failed).length > 0) setError(Object.values(failed)[0]);
  }, [readThread, setError]);

  const refresh = useCallback((): Promise<void> => {
    // Poll/reconnect/manual refresh share one walk. Starting a new walk every
    // six seconds could otherwise prevent a large catalog from ever finishing.
    if (refreshInFlight.current) return refreshInFlight.current;
    const generation = ++refreshGeneration.current;
    const snapshotsAtStart = new Map(threadSnapshotGeneration.current);
    const changedSnapshots = () => new Set([...threadSnapshotGeneration.current].filter(([id, version]) => snapshotsAtStart.get(id) !== version).map(([id]) => id));
    const run = (async () => {
      let projects = await request<Workspace[]>("workspace/list");
      if (generation !== refreshGeneration.current) return;
      if (projects.length === 0) {
        const workspace = await request<Workspace>("workspace/create", { title: "Workspace", idempotencyKey: "native-default-workspace" });
        projects = [workspace];
      }
      if (generation !== refreshGeneration.current) return;
      setWorkspaces(projects);
      if (!projects.some(project => project.id === workspaceRef.current)) setWorkspaceId(projects[0].id);
      const rows = await readPagedThreadIndex(request, projects.map(project => project.id), {
        isCurrent: () => generation === refreshGeneration.current,
        onPage: partial => setThreads(current => mergeThreadIndex(current, partial, changedSnapshots())),
      });
      if (rows === null || generation !== refreshGeneration.current) return;
      setThreads(current => {
        const changed = changedSnapshots();
        // A snapshot obtained during this walk owns volatile Turn state even
        // when a list response has the same Thread metadata revision.
        const present = new Set(rows.map(row => row.id));
        return mergeThreadIndex(current.filter(row => present.has(row.id) || changed.has(row.id)), rows, changed);
      });
      setThreadIndexComplete(true);
    })();
    const pending = run.finally(() => { if (refreshInFlight.current === pending) refreshInFlight.current = null; });
    refreshInFlight.current = pending;
    return pending;
  }, [request, setWorkspaceId]);

  useEffect(() => {
    try {
      const language = localStorage.getItem("knorvia-language");
      // Hydrate the existing browser preference after the SSR-safe first render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocale(language === "zh" || (!language && navigator.language.startsWith("zh")) ? "zh" : "en");
      setThemeState(getStoredTheme() ?? "snow");
      const workspace = localStorage.getItem("knorvia-native-workspace");
      if (workspace) setWorkspaceId(workspace);
    } catch { /* storage is optional */ }
    const client = createNativeClient();
    clientRef.current = client;
    let disposed = false;
    let engineReady = true;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const reconcile = (id: string) => {
      if (timers.has(id)) return;
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        if (!disposed) void readThread(id).catch(error => setError(errorText(error)));
      }, 100));
    };
    const connected = async () => {
      try {
        await refresh();
        if (disposed) return;
        setError("");
        await readBackCached();
      } catch (error) { if (!disposed) setError(errorText(error)); }
      try {
        await request<NativeConnectionConfig>("connection/read");
        const response = await request<Model[] | { data: Model[] }>("model/list");
        if (!disposed) { setModels(Array.isArray(response) ? response : response.data ?? []); setModelError(""); }
      } catch (error) { if (!disposed) setModelError(errorText(error)); }
    };
    const stopState = client.onStateChange(state => {
      if (disposed) return;
      setConnection(state);
      if (state === "connected") void connected();
    });
    const stopEvents = client.subscribe((event: NativeEvent) => {
      if (disposed) return;
      const p = event.params;
      if ((event.method === "connection/state" || event.method === "connection/providers") && p && Array.isArray(p.providers)) {
        setConnectionInfo(p as unknown as NativeConnectionConfig);
        if (event.method === "connection/providers") return;
      }
      if (event.method === "connection/state" && p && typeof p.engineState === "string") {
        engineReady = p.engineState === "ready";
        if (!engineReady) setModels([]);
        setConnection(engineReady ? "connected" : ["unavailable", "failed"].includes(p.engineState) ? "disconnected" : "reconnecting");
        if (engineReady) void connected();
        return;
      }
      if (typeof p?.threadId !== "string") return;
      const id = p.threadId;
      if (p.kind === "agentMessage.delta") {
        setLive(current => addDelta(current, event, snapshotsRef.current[id]));
        return;
      }
      if (p.item && snapshotsRef.current[id]) {
        const item = p.item as ThreadSnapshot["items"][number];
        itemNotificationGeneration.current.set(id, (itemNotificationGeneration.current.get(id) ?? 0) + 1);
        applySnapshot({ ...snapshotsRef.current[id], items: [item] }, { source: "notification" });
      }
      if (event.method === "turn/persistenceError") {
        // A persistence error is not a connection problem: reconnecting cannot
        // fix it and the turn's durable outcome is unconfirmed. Surface it as
        // its own recovery state; the next authoritative snapshot clears it.
        setRecovery({ threadId: typeof p.threadId === "string" ? p.threadId : undefined, message: String(p.message ?? "Task state needs recovery") });
      }
      reconcile(id);
    });
    void client.connect().catch(error => { if (!disposed) setError(errorText(error)); });
    const interval = setInterval(() => {
      if (disposed || client.state !== "connected" || !engineReady) return;
      void refresh().catch(error => setError(errorText(error)));
      for (const snapshot of Object.values(snapshotsRef.current)) {
        if (snapshot.activeTurn) reconcile(snapshot.id);
      }
    }, 6000);
    return () => {
      disposed = true;
      refreshGeneration.current += 1;
      refreshInFlight.current = null;
      stopState(); stopEvents();
      clearInterval(interval);
      for (const timer of timers.values()) clearTimeout(timer);
      client.close();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [request, refresh, readThread, readBackCached, applySnapshot, setWorkspaceId]);

  const sendTurn = useCallback(async (id: string, input: string, options: Omit<StartOptions, "workspaceId">) => {
    setError("");
    await request("turn/start", {
      threadId: id, input, tools: { write: options.write },
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort || null } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      idempotencyKey: options.submissionId ? `${options.submissionId}-turn` : crypto.randomUUID(),
    });
    // Admission has succeeded. Snapshot refresh errors must never turn this
    // into a failed send or encourage the user to repeat an accepted operation.
    void readThread(id).catch(error => setError(errorText(error)));
  }, [request, readThread]);

  const newTask = useCallback(async (input: string, options: StartOptions) => {
    const origin = window.location.pathname;
    const title = input.trim().split("\n")[0].slice(0, 80);
    const thread = await request<Thread>("thread/start", {
      workspaceId: options.workspaceId, title,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      idempotencyKey: options.submissionId ? `${options.submissionId}-thread` : crypto.randomUUID(),
    });
    applySnapshot({ ...thread, items: [], turns: [], pendingApprovals: [], activeTurn: null });
    await sendTurn(thread.id, input, options);
    if (window.location.pathname === origin) router.push(`/workbench/task/${encodeURIComponent(thread.id)}`);
    return thread.id;
  }, [request, applySnapshot, router, sendTurn]);

  const saveResult = useCallback(async (thread: Thread, content: string) => {
    const artifact = await request<Artifact>("artifact/create", { workspaceId: thread.workspaceId, title: thread.title, type: "text/markdown", idempotencyKey: crypto.randomUUID() });
    await request("artifact/stage", { id: artifact.id, content, idempotencyKey: crypto.randomUUID() });
    const committed = await request<Artifact>("artifact/commit", { id: artifact.id, idempotencyKey: crypto.randomUUID() });
    setNotice(t("已保存到成果", "Saved to outputs"));
    return committed;
  }, [request, t]);

  const reconnect = useCallback(async () => {
    const wasConnected = clientRef.current?.state === "connected";
    await clientRef.current?.connect();
    if (wasConnected) {
      await refresh();
      await readBackCached();
      setError("");
      const response = await request<Model[] | { data: Model[] }>("model/list");
      setModels(Array.isArray(response) ? response : response.data ?? []);
      setModelError("");
    }
  }, [refresh, readBackCached, request]);
  const toggleLocale = () => {
    const next = locale === "zh" ? "en" : "zh";
    setLocale(next);
    try { localStorage.setItem("knorvia-language", next); } catch { /* optional UI preference */ }
  };
  const toggleTheme = () => setTheme(isDarkTheme(theme) ? "snow" : "dark");

  return <Context.Provider value={{ locale, t, toggleLocale, theme, toggleTheme, chooseTheme: setTheme, frost, setFrost: saveWindowFrost, connection, connectionInfo, error, errorKind, notice, recovery, clearRecovery, setError, setNotice, workspaces, threads, threadIndexComplete, models, modelError, workspaceId, setWorkspaceId, snapshots, live, request, refresh, readThread, newTask, sendTurn, saveResult, reconnect, pinThread }}>
    <I18nProvider language={locale}><WorkbenchBackground><DesktopChrome /><WorkbenchArrival />{children}</WorkbenchBackground></I18nProvider>
  </Context.Provider>;
}
