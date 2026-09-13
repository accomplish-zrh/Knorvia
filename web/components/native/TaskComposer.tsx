"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, ChevronDown, Copy, FileText, History, Library, Loader2, Paperclip, Plus, ShieldCheck, Square, Target, X } from "lucide-react";
import { TaskRecipeMenu } from "./TaskRecipeMenu";
import type { ThreadSnapshot } from "@/lib/native-workbench-state";
import type { NativeGoal } from "@/lib/knorvia-native-types";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { appendFileReferences } from "@/lib/native-project-context";
import { clearSubmission, markSubmissionFailed, readStoredSubmission, submissionAttempt } from "@/lib/native-submission";
import { locateSteerReceipt, steerTurnStillRunning, type SteerAttempt, type SteerReceiptStatus } from "@/lib/native-steer-recovery";
import { clearSubmittedDraft, draftFingerprint, loadStoredDraft, restoreDraft, saveDraft, type DraftAttachment, type DraftGoal, type DraftHistoryEntry } from "@/lib/native-composer-draft";
import { clearQueueAttempt, queueAttempt, queueHasPending, useMessageQueue } from "@/lib/native-message-queue";
import { TaskMessageQueue } from "./TaskMessageQueue";
import { ComposerDraftRecovery } from "./ComposerDraftRecovery";
import { providerError, providerLabel } from "@/lib/native-providers";
import { WorkspacePicker } from "./WorkspacePicker";

type Attachment = { name: string; content: string };
type GoalDraft = { criteria: string; constraints: string };
const safeStorage = (): Storage | undefined => { try { return localStorage; } catch { return undefined; } };
type SteerRecoveryView =
  | { phase: "checking"; attemptId: string }
  | { phase: "received"; attemptId: string }
  | { phase: "absent"; attemptId: string }
  | { phase: "unknown"; attemptId: string; reason: string };
export function TaskComposer({ canvasContext = "", onCanvasContextUsed, thread, goal, suggestion, onSuggestionUsed, contextFiles = [], onRemoveContextFile, onContextFilesUsed, onCreate, onThreadOpened, draftScope, projectId, allowGoal = true }: { canvasContext?: string; onCanvasContextUsed?: (text: string) => void; thread?: ThreadSnapshot; goal?: NativeGoal; suggestion?: string; onSuggestionUsed?: () => void; contextFiles?: string[]; onRemoveContextFile?: (path: string) => void; onContextFilesUsed?: (paths: string[]) => void; onCreate?: (text: string, options: { workspaceId: string; model?: string; reasoningEffort?: string; cwd?: string; write: boolean; submissionId?: string }) => Promise<string>; onThreadOpened?: (threadId: string) => void; draftScope?: string; projectId?: string; allowGoal?: boolean }) {
  const { t, connection, connectionInfo, models, workspaces, workspaceId, newTask, sendTurn, readThread, request, setError, setNotice } = useWorkbench();
  const router = useRouter();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const submitting = useRef(false);
  const lastAttempt = useRef<Awaited<ReturnType<typeof submissionAttempt>> | undefined>(undefined);
  const [steerRecovery, setSteerRecovery] = useState<SteerRecoveryView | null>(null);
  const steerRecoveryGeneration = useRef(0);
  const steerChecked = useRef(new Set<string>());
  const forceNewTurn = useRef(false);
  // B09: versioned draft state — immutable per-writer slots, bounded recovery
  // history, cross-window conflict notes, and honest storage-failure reporting.
  const draftVersion = useRef(0);
  // The slot this window last wrote; a send tombstones exactly this slot.
  const draftSlot = useRef<string | undefined>(undefined);
  const [sendMode, setSendMode] = useState<"queue" | "steer">("queue");
  const { queue, queueError, refreshQueue } = useMessageQueue(thread?.id, connection === "connected", request);
  const [draftHistory, setDraftHistory] = useState<DraftHistoryEntry[]>([]);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [conflictNote, setConflictNote] = useState("");
  const [storageIssue, setStorageIssue] = useState<"unavailable" | "quota" | null>(null);
  // Enumeration of the version slots was denied: the history list may be
  // incomplete and the panel must say so instead of implying completeness.
  const [historyIncomplete, setHistoryIncomplete] = useState(false);
  const [pendingSuggestion, setPendingSuggestion] = useState("");
  const [recipeOpen, setRecipeOpen] = useState(false);
  const inputSnapshot = useRef(input); inputSnapshot.current = input;
  const [model, setModel] = useState("");
  const [switchingProvider, setSwitchingProvider] = useState(false);
  const [effort, setEffort] = useState("");
  const [write, setWrite] = useState(true);
  const [pending, setPending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const [goalDraft, setGoalDraft] = useState<GoalDraft | null>(null);
  const goalAttempt = useRef<{ fingerprint: string; createKey: string; runKey: string; goal?: NativeGoal } | null>(null);
  const addAnchor = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const draftKey = `knorvia-native-draft:${draftScope ?? thread?.id ?? "new"}`;
  const currentDraftKey = useRef(draftKey); currentDraftKey.current = draftKey;
  const workspace = workspaces.find(project => project.id === (thread?.workspaceId ?? projectId ?? workspaceId));
  const running = thread?.activeTurn?.status === "running";
  const useQueue = Boolean(thread && (running ? sendMode === "queue" : queueHasPending(queue)));
  useEffect(() => { setSendMode("queue"); }, [thread?.id]);
  const needsDecision = Boolean(thread?.pendingApprovals.some(approval => approval.status === "pending") || thread?.pendingUserInputs?.length);
  const effectiveModel = model || connectionInfo?.model || "";
  const currentProvider = connectionInfo?.providers.find(p => p.id === connectionInfo.activeProviderId);
  const selectedModel = effectiveModel ? models.find(entry => (entry.model ?? entry.id) === effectiveModel) : models.find(entry => entry.isDefault);
  const efforts = useMemo(() => selectedModel?.supportedReasoningEfforts ?? [], [selectedModel]);
  const effectiveEffort = efforts.some(entry => entry.reasoningEffort === effort) ? effort : "";
  // C15: switching to a model that does not support the previously chosen
  // effort clears the stale selection instead of sending an unsupported field.
  useEffect(() => {
    if (selectedModel && effort && !efforts.some(entry => entry.reasoningEffort === effort)) setEffort("");
  }, [effort, efforts, selectedModel]);
  useEffect(() => { setModel(""); setEffort(""); }, [connectionInfo?.activeProviderId]);

  useEffect(() => {
    const storage = safeStorage();
    const stored = loadStoredDraft(storage, draftKey);
    const base = stored.current;
    setInput(base?.text ?? "");
    setAttachments(base?.attachments ?? []);
    setGoalDraft(allowGoal && !thread?.id && base?.goal ? base.goal : null);
    setRecipeOpen(false);
    draftVersion.current = base?.version ?? 0;
    draftSlot.current = base?.slot;
    setDraftHistory(stored.history);
    setLoadingFiles(false);
  }, [draftKey, thread?.id, allowGoal]);

  useEffect(() => {
    if (!addMenu) return;
    const outside = (event: PointerEvent) => { if (!addAnchor.current?.contains(event.target as Node)) setAddMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setAddMenu(false); addAnchor.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [addMenu]);

  // B09: every draft mutation saves the composite record atomically. A save
  // failure surfaces as a storage warning (copy/download fallback) instead of
  // silently pretending the draft was kept.
  const refreshHistory = () => {
    const stored = loadStoredDraft(safeStorage(), draftKey);
    setDraftHistory(stored.history);
    setHistoryIncomplete(!stored.enumerable);
  };
  const persistDraft = (next: { text: string; attachments: Attachment[]; goal: GoalDraft | null }, options: { source?: string } = {}) => {
    const outcome = saveDraft(safeStorage(), draftKey, next, { expectedVersion: draftVersion.current, source: options.source });
    if (outcome.ok) {
      draftVersion.current = outcome.version;
      draftSlot.current = outcome.slotKey;
      setStorageIssue(null);
      if (outcome.conflict && outcome.otherDraft) setConflictNote(t("检测到另一个窗口写入了不同草稿；那份内容已保留在恢复历史中。", "Another window saved a different draft; its content is kept in the recovery history."));
    } else setStorageIssue(outcome.reason);
    refreshHistory();
    return outcome;
  };

  const updateGoalDraft = (next: GoalDraft | null) => {
    setGoalDraft(next);
    persistDraft({ text: inputSnapshot.current, attachments, goal: next });
  };

  useEffect(() => {
    setModel(thread?.model ?? "");
    setEffort(thread?.reasoningEffort ?? "");
  }, [thread?.id, thread?.model, thread?.reasoningEffort]);

  useEffect(() => {
    if (!suggestion) return;
    onSuggestionUsed?.();
    // An empty draft takes the suggestion directly; an existing draft first
    // asks whether to append, replace (original kept in recovery), or keep.
    if (!inputSnapshot.current.trim()) applySuggestion(suggestion, "replace");
    else setPendingSuggestion(suggestion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion, onSuggestionUsed, draftKey]);

  const applySuggestion = (text: string, mode: "append" | "replace") => {
    setPendingSuggestion("");
    const current = inputSnapshot.current;
    if (mode === "append") {
      updateInput(current.trim() ? `${current}\n\n${text}` : text);
    } else {
      // The pre-replacement draft is pushed into the bounded history first.
      persistDraft({ text: current, attachments, goal: goalDraft }, { source: t("建议替换前", "Before suggestion") });
      updateInput(text);
    }
    textarea.current?.focus();
  };

  useEffect(() => {
    const field = textarea.current;
    if (!field) return;
    const resize = () => { field.style.height = "0px"; field.style.height = `${Math.min(field.scrollHeight, 220)}px`; };
    resize();
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width !== lastWidth) { lastWidth = width; resize(); }
    });
    let lastWidth = field.getBoundingClientRect().width;
    observer.observe(field);
    return () => observer.disconnect();
  }, [input, expanded, needsDecision]);

  const updateInput = (value: string) => {
    inputSnapshot.current = value;
    setInput(value);
    persistDraft({ text: value, attachments, goal: goalDraft });
  };

  const keepAttachments = (next: Attachment[]) => {
    setAttachments(next);
    persistDraft({ text: inputSnapshot.current, attachments: next, goal: goalDraft });
  };

  // B06: a steer whose RPC response was lost must be checked against the
  // durable userMessage receipt (payload.clientId) before anything is resent.
  const beginSteerRecovery = useCallback(async (attempt: SteerAttempt) => {
    if (!thread || submitting.current) return;
    const generation = ++steerRecoveryGeneration.current;
    steerChecked.current.add(attempt.id);
    setSteerRecovery({ phase: "checking", attemptId: attempt.id });
    let storage: Storage | undefined; try { storage = localStorage; } catch { /* the attempt stays in memory */ }
    const receipt: SteerReceiptStatus = await locateSteerReceipt(async beforeItemSeq => {
      const page = await request<ThreadSnapshot>("thread/read", { id: thread.id, itemLimit: 200, ...(beforeItemSeq === undefined ? {} : { beforeItemSeq }) });
      return { items: page.items ?? [], itemsNextCursor: page.itemsNextCursor ?? null, hasMoreItems: page.hasMoreItems === true };
    }, attempt.id);
    if (steerRecoveryGeneration.current !== generation) return;
    if (receipt.state === "received") {
      // Delivered. Close the attempt so nothing can execute it a second time;
      // the persisted userMessage already carries the content.
      clearSubmission(storage, draftKey, attempt.id);
      if (lastAttempt.current?.id === attempt.id) lastAttempt.current = undefined;
      setNotice(t("补充信息已送达原任务，没有重复发送。", "The instructions reached the task; nothing was sent twice."));
      setSteerRecovery({ phase: "received", attemptId: attempt.id });
    } else if (receipt.state === "absent") {
      // Definitively not delivered: only a complete bounded scan may conclude
      // this. Sending as a new turn stays an explicit user action.
      setSteerRecovery({ phase: "absent", attemptId: attempt.id });
    } else {
      setSteerRecovery({ phase: "unknown", attemptId: attempt.id, reason: receipt.reason });
    }
  }, [thread, draftKey, request, t, setNotice]);

  useEffect(() => {
    if (!thread || connection !== "connected" || pending || submitting.current) return;
    let storage: Storage | undefined; try { storage = localStorage; } catch { return; }
    const stored = readStoredSubmission(storage, draftKey);
    if (!stored || steerChecked.current.has(stored.id)) return;
    const attempt: SteerAttempt = { id: stored.id, action: stored.action };
    if (!steerTurnStillRunning(thread, attempt)) void beginSteerRecovery(attempt);
  }, [draftKey, thread, connection, pending, beginSteerRecovery]);

  const dismissSteerRecovery = (forget: boolean) => {
    const view = steerRecovery;
    if (!view) return;
    steerRecoveryGeneration.current += 1;
    setSteerRecovery(null);
    let storage: Storage | undefined; try { storage = localStorage; } catch { /* optional draft storage */ }
    if (forget && view.phase !== "checking") {
      clearSubmission(storage, draftKey, view.attemptId);
      if (lastAttempt.current?.id === view.attemptId) lastAttempt.current = undefined;
    }
    steerChecked.current.add(view.attemptId);
  };

  const resendAsNewTurn = () => {
    const view = steerRecovery;
    if (!view || view.phase !== "absent") return;
    steerRecoveryGeneration.current += 1;
    setSteerRecovery(null);
    steerChecked.current.add(view.attemptId);
    forceNewTurn.current = true;
    void submit();
  };

  // B09: restore a bounded history entry as the current draft (whole record).
  const restoreEntry = (entry: DraftHistoryEntry) => {
    const outcome = restoreDraft(safeStorage(), draftKey, entry);
    if (outcome.ok) {
      draftVersion.current = outcome.version;
      draftSlot.current = outcome.slotKey;
      setConflictNote("");
      setStorageIssue(null);
      setInput(entry.text);
      setAttachments(entry.attachments);
      if (allowGoal && !thread?.id) setGoalDraft(entry.goal);
    }
    refreshHistory();
  };
  const downloadDraft = () => {
    try {
      const blob = new Blob([JSON.stringify({ text: input, attachments, goal: goalDraft }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = "knorvia-draft.json"; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { /* download is a best-effort fallback */ }
  };
  const copyDraft = async () => {
    try { await navigator.clipboard.writeText(input); setNotice(t("草稿正文已复制", "Draft text copied")); }
    catch { downloadDraft(); }
  };

  const submit = async () => {
    // A retry's identity includes its provider/model. Do not admit it while a
    // reload is still resolving those values, or it could acquire a new key.
    if ((!input.trim() && attachments.length === 0 && contextFiles.length === 0) || submitting.current || pending || switchingProvider || loadingFiles || connection !== "connected" || !connectionInfo || !workspace || (goalDraft && (!input.trim() || !goalDraft.criteria.trim()))) return;
      const text = [appendFileReferences(input.trim(), contextFiles), canvasContext, ...attachments.map(file => `\n<attached_text_file name=${JSON.stringify(file.name)}>\n${file.content}\n</attached_text_file>`)].filter(Boolean).join("\n");
      const submittedInput = input;
      const submittedAttachments = attachments;
      const submittedContextFiles = contextFiles;
      const submittedGoal = goalDraft;
      // Identity of the draft version this submission clears, captured BEFORE
      // the request: the tombstone/pointer cleanup below targets exactly this
      // content, never whatever is current when the response arrives.
      const submittedFingerprint = draftFingerprint({ text: submittedInput, attachments: submittedAttachments, goal: submittedGoal });
      let submittedSlot = draftSlot.current;
    submitting.current = true; setPending(true); setError("");
    try {
      let storage: Storage | undefined; try { storage = localStorage; } catch { /* current attempt remains in memory */ }
      // A legacy draft loaded without editing has no immutable version yet.
      // Give that exact submission a slot before it can be acknowledged.
      if (!submittedSlot && storage) {
        const saved = saveDraft(storage, draftKey, { text: submittedInput, attachments: submittedAttachments, goal: submittedGoal });
        if (saved.ok) { submittedSlot = saved.slotKey; draftSlot.current = saved.slotKey; draftVersion.current = saved.version; }
        else setStorageIssue(saved.reason);
      }
      if (thread && useQueue) {
        if (!queue) throw new Error(queueError || t("正在核对待发消息，请稍后再试。", "Checking the queue. Your draft is kept; try again shortly."));
        const body = { threadId: thread.id, input: text, options: { model: effectiveModel || null, reasoningEffort: effectiveEffort || null, cwd: thread.cwd ?? workspace.cwd ?? null, write, providerId: connectionInfo.activeProviderId } };
        const attemptScope = `${draftKey}:${submittedSlot ?? "context"}`;
        const queued = queueAttempt(storage, attemptScope, body);
        await request("turnQueue/enqueue", { ...queued.body, requestId: queued.id, idempotencyKey: `${queued.id}-enqueue` });
        // Native acknowledgement is durable QUEUED, never model delivery.
        const sameDraft = currentDraftKey.current === draftKey && draftSlot.current === submittedSlot;
        clearSubmittedDraft(storage, draftKey, submittedSlot, submittedFingerprint);
        clearQueueAttempt(storage, attemptScope, queued.id);
        if (sameDraft) {
          setInput(current => current === submittedInput ? "" : current);
          setAttachments(current => current === submittedAttachments ? [] : current);
          draftVersion.current = 0; draftSlot.current = undefined;
          onContextFilesUsed?.(submittedContextFiles);
          if (canvasContext) onCanvasContextUsed?.(canvasContext);
        }
        setNotice(t("消息已排队，尚未发送给任务。", "Message queued; it has not been sent to the task yet."));
        void refreshQueue();
        return;
      }
      const candidate = await submissionAttempt(storage, draftKey, [workspace.id, thread?.id, text, goalDraft, connectionInfo?.activeProviderId, effectiveModel, effectiveEffort, write], running ? { kind: 'steer', turnId: thread.activeTurn!.id } : { kind: 'start' });
      let attempt = lastAttempt.current?.fingerprint === candidate.fingerprint ? lastAttempt.current : candidate;
      if (forceNewTurn.current) {
        // Explicit recovery action: the old steer attempt was proven undelivered
        // and cleared. A fresh admission identity starts the new turn; the old
        // id must never be reused for it.
        forceNewTurn.current = false;
        lastAttempt.current = undefined;
        attempt = { id: crypto.randomUUID(), fingerprint: candidate.fingerprint, action: { kind: 'start' } };
        try { storage?.setItem(`${draftKey}:submission`, JSON.stringify(attempt)); } catch { /* current attempt remains in memory */ }
      }
      lastAttempt.current = attempt;
      if (thread && attempt.action.kind === 'steer' && attempt.action.turnId) {
        if (!steerTurnStillRunning(thread, attempt)) {
          // Retrying turn/steer against a finished turn would fail forever.
          // Route the retained attempt into bounded receipt recovery instead.
          markSubmissionFailed(storage, draftKey, attempt.id);
          void beginSteerRecovery(attempt);
          return;
        }
        await request("turn/steer", { threadId: thread.id, turnId: attempt.action.turnId, input: text, clientMessageId: attempt.id, idempotencyKey: `${attempt.id}-steer` });
        void readThread(thread.id).catch(error => setError(error));
      } else if (thread?.goalId) {
        const latest = await request<NativeGoal>("goal/read", { id: thread.goalId });
        await request("goal/run", { id: latest.id, revision: latest.revision, threadId: thread.id, input: text, tools: { write }, ...(effectiveModel ? { model: effectiveModel } : {}), reasoningEffort: effectiveEffort || null, idempotencyKey: `${attempt.id}-goal-run` });
        void readThread(thread.id).catch(error => setError(error));
      } else if (thread) {
        await sendTurn(thread.id, text, { model: effectiveModel, reasoningEffort: effectiveEffort, write, cwd: thread.cwd ?? workspace.cwd ?? undefined, submissionId: attempt.id });
      } else if (goalDraft) {
        const fingerprint = JSON.stringify([workspace.id, text, goalDraft, connectionInfo?.activeProviderId, effectiveModel, effectiveEffort, write]);
        if (goalAttempt.current?.fingerprint !== fingerprint) goalAttempt.current = { fingerprint, createKey: `${attempt.id}-goal-create`, runKey: `${attempt.id}-goal-run` };
        const goalSubmission = goalAttempt.current!;
        goalSubmission.goal ??= await request<NativeGoal>("goal/create", { workspaceId: workspace.id, title: input.trim().split("\n")[0].slice(0, 200), successCriteria: goalDraft.criteria.trim(), constraints: goalDraft.constraints.trim(), nextAction: text, idempotencyKey: goalSubmission.createKey });
        const started = await request<{ threadId: string }>("goal/run", { id: goalSubmission.goal.id, revision: goalSubmission.goal.revision, input: text, tools: { write }, ...(effectiveModel ? { model: effectiveModel } : {}), reasoningEffort: effectiveEffort || null, ...(workspace.cwd ? { cwd: workspace.cwd } : {}), idempotencyKey: goalSubmission.runKey });
        setGoalDraft(current => current === goalDraft ? null : current);
        // Keep the canvas handoff working on the goal path as well.
        onThreadOpened?.(started.threadId);
        router.push(`/workbench/task/${encodeURIComponent(started.threadId)}`);
        // Admission succeeded. A later refresh must not turn it into a second send.
        void readThread(started.threadId).catch(error => setError(error));
      } else {
        await (onCreate ?? newTask)(text, { workspaceId: workspace.id, model: effectiveModel, reasoningEffort: effectiveEffort, write, cwd: workspace.cwd ?? undefined, submissionId: attempt.id });
      }
      // A completed send may belong to a composer the user already left.
      // Never clear a newer draft written while that request was pending.
      const sameDraft = currentDraftKey.current === draftKey && draftSlot.current === submittedSlot;
      if (sameDraft) {
        setInput(current => current === submittedInput ? "" : current);
        setAttachments(current => current === submittedAttachments ? [] : current);
        if (submittedGoal) setGoalDraft(current => current === submittedGoal ? null : current);
      }
      // Only the exact sent version is cleared: its own slot is tombstoned,
      // and the pointer is removed only when it still holds exactly this
      // submission from this window. A concurrent draft from another window —
      // identical text included — survives with its own slot.
      const cleared = clearSubmittedDraft(storage, draftKey, submittedSlot, submittedFingerprint);
      if (cleared && sameDraft) { draftVersion.current = 0; draftSlot.current = undefined; }
      clearSubmission(storage, draftKey, attempt.id); lastAttempt.current = undefined;
      if (sameDraft) {
        onContextFilesUsed?.(submittedContextFiles);
        if (canvasContext) onCanvasContextUsed?.(canvasContext);
      }
    } catch (error) {
      // Pass the thrown value: an RPC conflict must reach the banner as a
      // conflict, not as a generic "reconnect" suggestion.
      setError(error);
      const failed = lastAttempt.current;
      if (failed?.action.kind === "steer") { try { markSubmissionFailed(localStorage, draftKey, failed.id); } catch { /* optional draft storage */ } }
    } finally { submitting.current = false; setPending(false); }
  };

  const stop = async () => {
    if (!thread?.activeTurn || stopping) return;
    setStopping(true);
    try { await request("turn/interrupt", { turnId: thread.activeTurn.id }); await readThread(thread.id); await refreshQueue(); }
    catch (error) { setError(error); }
    finally { setStopping(false); }
  };

  const queuePanel = thread ? <TaskMessageQueue key={thread.id} queue={queue} error={queueError} refresh={refreshQueue} goal={Boolean(thread.goalId)} /> : null;

  if (goal && goal.status !== "active" && !running) return <>{queuePanel}<p className="nw-goal-composer-state">{["paused", "blocked"].includes(goal.status) ? t("目标已暂停，继续后可在这段对话里推进。", "Resume this goal to continue in this conversation.") : t("这个目标已结束，对话和结果已保留。", "This goal has ended. The conversation and results are saved.")}</p></>;

  if (needsDecision && !expanded) return <>{queuePanel}<div className="nw-decision-prompt"><div><ShieldCheck size={17} /><span>{thread?.pendingUserInputs?.length ? t("请先回答上方问题", "Answer the questions above") : t("请先确认上方操作", "Review the operation above")}</span></div><div><button className="nw-button nw-button-small" onClick={() => { setExpanded(true); requestAnimationFrame(() => textarea.current?.focus()); }}>{t("补充任务要求", "Add instructions")}</button><button className="nw-stop" onClick={() => void stop()} disabled={stopping} aria-label={t("停止任务", "Stop task")} title={t("停止任务", "Stop task")}>{stopping ? <Loader2 size={15} className="nw-spin" /> : <Square size={12} fill="currentColor" />}</button></div></div></>;

  return <div className="nw-composer-wrap">
    {queuePanel}
    {running && <label className="nw-queue-mode">{t("发送方式", "Send mode")}<select aria-label={t("发送方式", "Send mode")} value={sendMode} disabled={pending} onChange={event => setSendMode(event.target.value as "queue" | "steer")}><option value="queue">{thread?.goalId ? t("本次目标运行结束后发送", "Queue after this Goal run") : t("本轮结束后发送", "Queue after this turn")}</option><option value="steer">{t("立即补充要求", "Send instructions now")}</option></select></label>}
    {steerRecovery && <div className="nw-steer-recovery" data-phase={steerRecovery.phase} role="status">
      {steerRecovery.phase === "checking" && <span><Loader2 size={14} className="nw-spin" />{t("正在核对补充信息是否已送达…", "Checking whether the instructions were delivered…")}</span>}
      {steerRecovery.phase === "received" && <><span>{t("补充信息已送达原任务，没有重复发送。", "The instructions reached the task; nothing was sent twice.")}</span><button className="nw-button nw-button-small" onClick={() => dismissSteerRecovery(false)}>{t("知道了", "Got it")}</button></>}
      {steerRecovery.phase === "absent" && <><span>{t("原任务已结束，这条补充信息没有送达。", "The task has ended; these instructions were never delivered.")}</span><button className="nw-button nw-button-small" onClick={resendAsNewTurn}>{t("作为新回合发送", "Send as a new turn")}</button><button className="nw-button nw-button-small" onClick={() => dismissSteerRecovery(true)}>{t("放弃", "Discard")}</button></>}
      {steerRecovery.phase === "unknown" && <><span title={steerRecovery.reason}>{t("暂时无法确认补充信息是否送达；原文与发送记录已保留。", "Delivery cannot be confirmed yet; the text and its attempt are kept.")}</span><button className="nw-button nw-button-small" onClick={() => { steerChecked.current.delete(steerRecovery.attemptId); const stored = readStoredSubmission(localStorage, draftKey); if (stored) void beginSteerRecovery({ id: stored.id, action: stored.action }); }}>{t("再次核对", "Check again")}</button><button className="nw-button nw-button-small" onClick={() => dismissSteerRecovery(false)}>{t("知道了", "Got it")}</button></>}
    </div>}
    {needsDecision && <button className="nw-compose-collapse" onClick={() => setExpanded(false)}><ChevronDown size={14} />{t("收起输入，查看待处理事项", "Collapse to review the pending request")}</button>}
    <div className="nw-composer">
      {pendingSuggestion && <div className="nw-suggestion-choice" role="dialog" aria-label={t("如何使用这条建议？", "How should this suggestion be used?")}><span>{t("已有一份草稿。", "You already have a draft.")}</span><button className="nw-button nw-button-small" onClick={() => applySuggestion(pendingSuggestion, "append")}>{t("追加到原稿", "Append to draft")}</button><button className="nw-button nw-button-small" onClick={() => applySuggestion(pendingSuggestion, "replace")}>{t("替换原稿（可恢复）", "Replace (recoverable)")}</button><button className="nw-button nw-button-small" onClick={() => setPendingSuggestion("")}>{t("返回原稿", "Keep my draft")}</button></div>}
      {(storageIssue || conflictNote || recoveryOpen) && <ComposerDraftRecovery entries={draftHistory} conflict={conflictNote} storageIssue={storageIssue} historyIncomplete={historyIncomplete} onRestore={restoreEntry} onDownload={downloadDraft} onClose={() => { setRecoveryOpen(false); setConflictNote(""); setStorageIssue(null); }} />}
      {goalDraft && <div className="nw-goal-mode-label"><Target size={15} /><strong>{t("目标模式", "Goal mode")}</strong><span>{t("记录目标，按完成条件推进", "Work toward a defined outcome")}</span><button className="nw-icon" disabled={pending} onClick={() => updateGoalDraft(null)} aria-label={t("退出目标模式", "Exit goal mode")}><X size={14} /></button></div>}
      {canvasContext && <div className="nw-context-files"><span>{t("已引用画布 · 可补充修改要求", "Canvas attached · Add your instructions")}<button type="button" className="nw-icon" aria-label={t("移除画布引用", "Remove canvas reference")} onClick={() => onCanvasContextUsed?.(canvasContext)}><X size={13} /></button></span></div>}{contextFiles.length > 0 && <div className="nw-attachments nw-context-files">{contextFiles.map(path => <span key={path} title={path}><FileText size={14} /><span>{path}</span><button className="nw-icon" onClick={() => onRemoveContextFile?.(path)} aria-label={`${t("移除文件引用", "Remove file reference")}: ${path}`}><X size={12} /></button></span>)}</div>}
      {attachments.length > 0 && <div className="nw-attachments">{attachments.map((file, index) => <span key={`${file.name}-${index}`}><FileText size={14} />{file.name}<button className="nw-icon" onClick={() => keepAttachments(attachments.filter((_, i) => i !== index))} aria-label={t("移除附件", "Remove attachment")}><X size={12} /></button></span>)}</div>}
      <textarea ref={textarea} aria-describedby={hintId} aria-label={running ? t("补充任务要求", "Add instructions") : t("任务描述", "Task description")} value={input} onChange={event => updateInput(event.target.value)} placeholder={thread ? (useQueue ? t("继续写，消息会排队发送…", "Keep writing; your message will be queued…") : running ? t("补充要求，调整正在进行的工作…", "Add context or steer the work in progress…") : t("继续这个任务…", "Continue this task…")) : t("描述你想完成的事，或添加资料…", "Describe what you want to do, or add your files…")} rows={thread ? 2 : 3} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
      }} />
      {goalDraft && <div className="nw-goal-mode-fields"><label>{t("完成条件", "Completion criteria")}<textarea aria-label={t("完成条件", "Completion criteria")} value={goalDraft.criteria} rows={2} maxLength={4000} disabled={pending} placeholder={t("怎样才算完成？写下可以核对的结果。", "What should be true when this is done?")} onChange={event => updateGoalDraft({ ...goalDraft, criteria: event.target.value })} /></label><details><summary>{t("约束（可选）", "Constraints (optional)")}</summary><textarea aria-label={t("目标约束", "Goal constraints")} rows={2} maxLength={4000} disabled={pending} value={goalDraft.constraints} onChange={event => updateGoalDraft({ ...goalDraft, constraints: event.target.value })} placeholder={t("工作范围、需要保留的内容…", "Scope, what to preserve…")} /></details></div>}
      <div className="nw-composer-toolbar"><div className="nw-composer-options">
        <div className="nw-composer-add" ref={addAnchor}><button className="nw-icon" onClick={() => setAddMenu(!addMenu)} aria-expanded={addMenu} aria-label={t("添加内容或模式", "Add content or mode")}><Plus size={19} /></button>{addMenu && <div className="nw-popover nw-add-popover"><button onClick={() => { setAddMenu(false); fileInput.current?.click(); }}><Paperclip size={16} />{t("附加文本文件", "Attach text files")}</button><button disabled={pending} onClick={() => { setAddMenu(false); setRecipeOpen(true); }}><Library size={16} /><span>{t("工作方案", "Work plans")}<small>{t("保存并复用任务说明", "Save and reuse task plans")}</small></span></button>{!thread && allowGoal && <button aria-label={goalDraft ? t("普通对话", "Regular conversation") : t("目标", "Goal")} disabled={pending} onClick={() => { updateGoalDraft(goalDraft ? null : { criteria: "", constraints: "" }); setAddMenu(false); textarea.current?.focus(); }}><Target size={16} /><span>{goalDraft ? t("普通对话", "Regular conversation") : t("目标", "Goal")}<small>{goalDraft ? t("退出目标模式", "Exit goal mode") : t("设置要推进的目标", "Set an outcome to work toward")}</small></span></button>}</div>}</div>
        <input ref={fileInput} disabled={loadingFiles || pending} hidden type="file" multiple accept=".txt,.md,.json,.csv,.tsv,.log,.py,.js,.ts,.tsx,.html,.css,.yaml,.yml,.toml,.xml,.sql" onChange={async event => {
          const files = [...(event.target.files ?? [])]; event.target.value = "";
          if (files.length + attachments.length > 4 || files.reduce((sum, file) => sum + file.size, 0) + attachments.reduce((sum, file) => sum + new Blob([file.content]).size, 0) > 48 * 1024) { setError(t("每次最多附加 4 个文本文件，总计 48 KB。较大文件请放入项目文件夹。", "Attach up to 4 text files, 48 KB total. Place larger files in the project folder.")); return; }
          setLoadingFiles(true);
          try {
            const loaded = await Promise.all(files.map(async file => ({ name: file.name, content: await file.text() })));
            if (currentDraftKey.current !== draftKey) return;
            if (loaded.some(file => file.content.includes("\0"))) throw new Error(t("请选择可读的文本文件。", "Please choose readable text files."));
            keepAttachments([...attachments, ...loaded]);
          } catch (error) { setError(errorText(error)); } finally { if (currentDraftKey.current === draftKey) setLoadingFiles(false); }
        }} />
        <label className="nw-select-label nw-permission-select"><ShieldCheck size={13} /><span>{write ? t("项目内可编辑", "Project edits allowed") : t("只读", "Read only")}</span><ChevronDown size={12} /><select aria-label={t("任务权限", "Task permissions")} value={write ? "write" : "read"} disabled={running} onChange={event => setWrite(event.target.value === "write")}><option value="write">{t("项目内可编辑", "Project edits allowed")}</option><option value="read">{t("只读", "Read only")}</option></select></label>
        {connectionInfo && connectionInfo.providers.length > 1 && <label className="nw-select-label nw-provider-select" title={t("切换工作台当前提供商", "Switch the workspace provider")}><span>{providerLabel(currentProvider, t)}</span>{switchingProvider ? <Loader2 size={12} className="nw-spin" /> : <ChevronDown size={12} />}<select aria-label={t("选择提供商", "Choose provider")} value={connectionInfo.activeProviderId} disabled={running || pending || switchingProvider || connection !== "connected"} onChange={async event => {
          const provider = connectionInfo.providers.find(p => p.id === event.target.value);
          if (!provider) return;
          setSwitchingProvider(true); setError("");
          try { await request("connection/provider/activate", { id: provider.id, revision: provider.revision }); }
          catch (error) { setError(providerError(error, t)); } finally { setSwitchingProvider(false); }
        }}>{connectionInfo.providers.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.configured && provider.id !== connectionInfo.activeProviderId}>{providerLabel(provider, t)}</option>)}</select></label>}
        <label className="nw-select-label nw-model-select"><span>{selectedModel?.displayName ?? (effectiveModel || t("默认模型", "Default model"))}</span><ChevronDown size={12} /><select aria-label={t("选择模型", "Choose model")} disabled={running || switchingProvider || connection !== "connected"} value={model} onChange={event => { setModel(event.target.value); setEffort(""); }}><option value="">{t("默认模型", "Default model")}{connectionInfo?.model ? ` · ${connectionInfo.model}` : ""}</option>{models.map(entry => <option key={entry.id} value={entry.model ?? entry.id}>{entry.displayName ?? entry.model ?? entry.id}</option>)}</select></label>
        {efforts.length > 0 && <label className="nw-select-label nw-effort-select"><span>{effort || t("默认推理", "Default effort")}</span><ChevronDown size={12} /><select aria-label={t("推理强度", "Reasoning effort")} value={effort} disabled={running} onChange={event => setEffort(event.target.value)}><option value="">{t("默认推理", "Default effort")}</option>{efforts.map(entry => <option key={entry.reasoningEffort} value={entry.reasoningEffort}>{entry.reasoningEffort}</option>)}</select></label>}
      </div><div className="nw-send-actions">{running && <button className="nw-stop" onClick={() => void stop()} disabled={stopping} aria-label={t("停止任务", "Stop task")} title={t("停止任务", "Stop task")}>{stopping ? <Loader2 size={15} className="nw-spin" /> : <Square size={12} fill="currentColor" />}</button>}<button className="nw-send" onClick={() => void submit()} disabled={pending || switchingProvider || !connectionInfo || connection !== "connected" || (!input.trim() && attachments.length === 0 && contextFiles.length === 0) || !workspace || Boolean(goalDraft && (!input.trim() || !goalDraft.criteria.trim()))} aria-label={useQueue ? t("排队发送", "Queue message") : running ? t("发送补充要求", "Send additional instructions") : t("发送任务", "Send task")}>{pending ? <Loader2 size={18} className="nw-spin" /> : <ArrowUp size={19} />}</button></div></div>
    </div>
    {recipeOpen && <TaskRecipeMenu key={draftKey} allowGoal={allowGoal && !thread} currentText={inputSnapshot.current} currentGoal={goalDraft} close={() => setRecipeOpen(false)} onApply={(resolved, mode) => {
      const current = inputSnapshot.current;
      if (mode === "append") updateInput(current.trim() ? `${current}

${resolved.text}` : resolved.text);
      else {
        // The replaced draft is preserved in recovery history first.
        persistDraft({ text: current, attachments, goal: goalDraft }, { source: t("方案替换前", "Before recipe") });
        updateInput(resolved.text);
      }
      if (resolved.goal && allowGoal && !thread?.id) updateGoalDraft(resolved.goal);
    }} />}
    <div className="nw-composer-foot"><WorkspacePicker workspace={workspace} cwd={thread?.cwd} locked={Boolean(thread || projectId)} disabled={pending} />
      <span className="nw-composer-foot-tools">{(draftHistory.length > 0 || storageIssue) && <button className="nw-icon" onClick={() => setRecoveryOpen(value => !value)} aria-expanded={recoveryOpen} aria-label={t("草稿恢复历史", "Draft recovery history")} title={t("草稿恢复历史", "Draft recovery history")}><History size={13} /></button>}{input && <button className="nw-icon" onClick={() => void copyDraft()} aria-label={t("复制草稿正文", "Copy draft text")} title={t("复制草稿正文", "Copy draft text")}><Copy size={13} /></button>}</span>
      <span id={hintId} className="nw-enter-hint">{connection !== "connected" ? t("连接后可发送，文字草稿自动保留", "Connect to send; your text draft is saved") : !workspace ? t("先选择或新建一个项目", "Choose or create a project to begin") : useQueue ? t("Enter 加入队列 · 正常结束后发送", "Enter to queue · sends after normal completion") : running ? t("补充信息会送入当前任务", "Instructions join the current task") : t("Enter 发送 · Shift Enter 换行", "Enter to send · Shift Enter for a new line")}</span>
    </div>
  </div>;
}
