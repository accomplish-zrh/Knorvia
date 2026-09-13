"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type AnchorHTMLAttributes, type ClassAttributes, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import { usePanel } from "./PanelContext";
import { previewUrl, workspaceLinkTarget } from "@/lib/native-panel";
import remarkGfm from "remark-gfm";
import { Bookmark, Check, ChevronRight, Copy, FileText, Loader2, Save, ShieldCheck } from "lucide-react";
import { itemText, taskStatus, type Approval, type Item, type ThreadSnapshot } from "@/lib/native-workbench-state";
import { readTaskView } from "@/lib/native-task-view";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { goalConversationInput } from "@/lib/native-goals";
import { UserInputCard } from "./UserInputCard";
import { SaveToLibrary } from "./SaveToLibrary";
import { ToolIcon, ToolStatus } from "./ToolVisual";
import { toolPresentation } from "@/lib/native-tool-presentation";
import { SubAgentActivity } from "./SubAgentActivity";
import { hasMathSignal, MarkdownContent, type LinkClick } from "./NativeMathMarkdown";
import { addBookmark, loadBookmarks, saveBookmarks } from "@/lib/native-conversation-bookmarks";

// P07: rendering cost of long conversations is bounded by memoisation
// boundaries (unchanged rows skip their subtree), lazy heavy detail bodies
// (collapsed tools only build their <pre> when first opened) and
// content-visibility CSS (see workspace-tools.css). Scroll reading position
// stays with useTaskReading; ConversationNavigation keeps working because
// every row stays mounted.

export function Markdown({ text }: { text: string }) {
  const panel = usePanel();
  const { t, setNotice } = useWorkbench();
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const noticeRef = useRef({ t, setNotice });
  noticeRef.current = { t, setNotice };
  // The handler is built once; the panel is read through a ref so markdown
  // bodies do not re-parse when panel state (or any panel consumer) changes.
  const onLink = useCallback<LinkClick>((href, event) => {
    const current = panelRef.current;
    if (!current || !href) return;
    const url = previewUrl(href);
    if (url) {
      // Web links keep native modifier-click behavior (new browser tab).
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); current.open({ kind: "browser", url });
      return;
    }
    if (href.startsWith("#")) return;
    // A file reference: the urlTransform only lets bounded shapes through,
    // and modifier keys must not bypass the project boundary.
    event.preventDefault();
    const target = workspaceLinkTarget(href, current.cwd ?? "", current.folder);
    if (target) {
      current.open({ kind: "file", path: target.path, ...(target.line ? { line: target.line } : {}), ...(target.column ? { column: target.column } : {}) });
      return;
    }
    noticeRef.current.setNotice(noticeRef.current.t("这个文件引用无法定位到当前项目内，已保持原样未打开。", "This file reference could not be located inside the current project; nothing was opened."));
  }, []);
  return <div className="nw-markdown"><MarkdownContent text={text} onLink={onLink} math={hasMathSignal(text)} /></div>;
}

// A collapsed detail renders only its summary; the body (often a large <pre>)
// is mounted while the row is open and unmounted again on close, so closed
// history never keeps heavy DOM around.
function LazyDetails({ className, summary, children, open = false }: { className?: string; summary: ReactNode; children: ReactNode; open?: boolean }) {
  const [revealed, setRevealed] = useState(open);
  return <details className={className} open={open} onToggle={event => setRevealed((event.target as HTMLDetailsElement).open)}>
    <summary>{summary}</summary>
    {revealed ? children : null}
  </details>;
}

export function ItemDetail({ item }: { item: Item }) {
  const { t } = useWorkbench();
  return <ItemDetailView item={item} t={t} />;
}

function ItemDetailView({ item, t }: { item: Item; t: (zh: string, en: string) => string }) {
  const p = item.payload;
  if (item.kind === "userInput") {
    if (item.status === "waiting_input") return null;
    const message = item.status === "answered" || item.status === "completed"
      ? t("补充信息已提交", "Additional input submitted")
      : item.status === "timed_out" ? t("补充信息请求已超时", "Input request timed out")
        : item.status === "interrupted" ? t("补充信息请求已中断", "Input request interrupted")
          : t("补充信息未送达，请在后续任务中重新提供", "Input was not delivered. Please provide it in a follow-up.");
    return <p className="nw-event-note"><FileText size={13} />{message}</p>;
  }
  if (item.kind === "commandExecution") return <LazyDetails className="nw-tool" summary={<><ToolIcon item={item} /><span>{String(p.command ?? t("执行命令", "Run command"))}</span>{p.exitCode !== null && p.exitCode !== undefined && <small>{`${t("退出码", "Exit")} ${p.exitCode}`}</small>}<ToolStatus item={item} /><ChevronRight size={14} /></>}><pre>{String(p.aggregatedOutput ?? t("命令未返回文本输出", "No text output"))}</pre></LazyDetails>;
  if (item.kind === "fileChange") {
    const changes = Array.isArray(p.changes) ? p.changes as { path?: string; diff?: string; kind?: unknown }[] : [];
    return <div className="nw-file-changes">{changes.map((change, index) => <LazyDetails className="nw-tool" key={index} summary={<><ToolIcon item={item} /><span>{change.path ?? t("文件变更", "File change")}</span><ToolStatus item={item} /><ChevronRight size={14} /></>}><pre>{change.diff ?? t("文件已更新", "File updated")}</pre></LazyDetails>)}</div>;
  }
  if (item.kind === "reasoning") {
    const summary = itemText(item);
    return summary ? <LazyDetails className="nw-tool nw-thought" summary={<><ToolIcon item={item} /><span>{t("工作思路", "Approach")}</span><ChevronRight size={14} /></>}><p>{summary}</p></LazyDetails> : null;
  }
  if (item.kind === "approvalDecision") return <p className="nw-event-note"><ShieldCheck size={13} />{p.decision === "allowed" ? t("已记录：允许此操作", "Recorded your approval") : t("已记录：拒绝此操作", "Recorded your refusal")}</p>;
  if (item.kind === "approvalResolution" && p.source === "system") {
    const reason = p.resolution === "timed_out" ? t("等待确认超时", "confirmation timed out")
      : p.resolution === "cancelled" ? t("任务已停止", "the task was stopped")
        : p.resolution === "owner_lost" ? t("原执行进程已结束", "the original worker ended")
          : t("原审批已失效", "the approval is no longer active");
    return <p className="nw-event-note" data-approval-resolution={String(p.resolution ?? "unknown")}><ShieldCheck size={13} />{t("系统已关闭审批：", "System closed the approval: ")}{reason}</p>;
  }
  if (item.kind === "approvalDelivery" && (item.status === "failed" || p.delivered === false)) return <div role="alert" className="nw-task-error">{t("审批选择未送达，请检查任务状态后再继续。", "Your approval decision was not delivered. Check the task state before continuing.")}</div>;
  if (item.kind === "tool.write") return null;
  if (item.kind === "tokenUsage") return <LazyDetails className="nw-tool" summary={<><ToolIcon item={item} /><span>{t("本轮用量", "Run usage")}</span><ChevronRight size={14} /></>}><pre>{JSON.stringify(p, null, 2)}</pre></LazyDetails>;
  if (item.kind === "error") return <div role="alert" className="nw-task-error">{itemText(item) || t("执行遇到问题。你可以补充要求后重试。", "The task encountered a problem. You can send a follow-up to retry.")}</div>;
  const presentation = toolPresentation(item);
  const label = presentation.identity || (typeof p.query === "string" ? p.query : t(presentation.zh, presentation.en));
  return <LazyDetails className="nw-tool" summary={<><ToolIcon item={item} /><span title={label}>{label}{presentation.category === "tool" && !presentation.identity && <small className="nw-tool-method">{item.kind}</small>}</span><ToolStatus item={item} /><ChevronRight size={14} /></>}><pre>{JSON.stringify(p, null, 2)}</pre></LazyDetails>;
}

// Memoised on item identity: snapshot merges keep unchanged items referentially
// stable, so a live update re-renders only the rows whose item objects changed.
const ToolRow = memo(function ToolRow({ item, t }: { item: Item; t: (zh: string, en: string) => string }) {
  return <div data-item-id={item.id}><ItemDetailView item={item} t={t} /></div>;
}, (before, after) => before.item === after.item && before.t === after.t);

function selectedBookmarkText(button: HTMLButtonElement, fallback: string): string {
  const row = button.closest("[data-item-id]");
  const selection = window.getSelection();
  if (!row || !selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode
    || !row.contains(selection.anchorNode) || !row.contains(selection.focusNode)) return fallback;
  return selection.toString().trim() || fallback;
}

const UserMessageRow = memo(function UserMessageRow({ item, goalId, t, onBookmark }: { item: Item; goalId?: string | null; t: (zh: string, en: string) => string; onBookmark?: (item: Item, text: string) => void }) {
  const text = itemText(item);
  const goalInput = goalConversationInput(text, goalId ?? undefined);
  const libraryBoundary = text.indexOf("\n\n[个人资料库上下文]\n");
  const displayText = libraryBoundary >= 0 ? text.slice(0, libraryBoundary) : text;
  return <div className="nw-user-message" data-item-id={item.id}><p>{goalInput?.input ?? displayText}</p>{libraryBoundary >= 0 && <LazyDetails className="nw-message-goal-context" summary={t("随资料发送的上下文", "Included library context")}><pre>{text.slice(libraryBoundary).trim()}</pre></LazyDetails>}{goalInput && <LazyDetails className="nw-message-goal-context" summary={t("随目标发送的说明", "Included goal instructions")}><pre>{goalInput.context}</pre></LazyDetails>}{onBookmark && item.status === "completed" && <div className="nw-message-actions"><button className="nw-icon" aria-label={t("添加书签", "Add bookmark")} title={t("保存选中文字；未选择时保存整条消息", "Bookmark selected text, or the whole message")} onMouseDown={event => event.preventDefault()} onClick={event => onBookmark(item, selectedBookmarkText(event.currentTarget, text))}><Bookmark size={14} /></button></div>}</div>;
}, (before, after) => before.item === after.item && before.t === after.t && before.goalId === after.goalId && before.onBookmark === after.onBookmark);

const AgentMessageRow = memo(function AgentMessageRow({ item, title, saving, t, onCopy, onSave, onBookmark }: {
  item: Item; title: string; saving: boolean; t: (zh: string, en: string) => string;
  onCopy: (text: string) => void; onSave: (itemId: string, text: string) => void; onBookmark?: (item: Item, text: string) => void;
}) {
  const text = itemText(item);
  return <article className="nw-agent-message" data-item-id={item.id}><Markdown text={text} />
    <div className="nw-message-actions"><SaveToLibrary name={title} text={text} /><button className="nw-icon" aria-label={t("复制回复", "Copy response")} title={t("复制回复", "Copy response")} onClick={() => onCopy(text)}><Copy size={14} /></button><button className="nw-save-result" disabled={saving} onClick={() => onSave(item.id, text)}>{saving ? <Loader2 size={14} className="nw-spin" /> : <Save size={14} />}{t("保存为成果", "Save as output")}</button>{onBookmark && item.status === "completed" && <button className="nw-icon" aria-label={t("添加书签", "Add bookmark")} title={t("保存选中文字；未选择时保存整条消息", "Bookmark selected text, or the whole message")} onMouseDown={event => event.preventDefault()} onClick={event => onBookmark(item, selectedBookmarkText(event.currentTarget, text))}><Bookmark size={14} /></button>}</div>
  </article>;
}, (before, after) => before.item === after.item && before.saving === after.saving && before.t === after.t && before.onCopy === after.onCopy && before.onSave === after.onSave && before.onBookmark === after.onBookmark);

export function ApprovalCard({ approval, thread }: { approval: Approval; thread: ThreadSnapshot }) {
  const { t, request, readThread, setError } = useWorkbench();
  const [pending, setPending] = useState(false);
  const related = thread.items.find(item => item.payload.approvalId === approval.id);
  const target = (approval.target ?? related?.payload.target ?? {}) as Record<string, unknown>;
  const act = async (decision: "allow" | "deny") => {
    setPending(true);
    try { await request("approval/respond", { id: approval.id, decision }); await readThread(thread.id); }
    catch (error) { setError(errorText(error)); } finally { setPending(false); }
  };
  const description = target.command ?? target.reason ?? target.reasoning ?? target.message;
  return <div className="nw-approval" role="group" aria-label={t("操作确认", "Operation approval")}><div className="nw-approval-title"><ShieldCheck size={17} /><strong>{t("这一步需要你确认", "This step needs your approval")}</strong></div><p>{approval.action === "kernel.commandExecution" ? t("Knorvia 请求执行以下命令。", "Knorvia is requesting permission to run this command.") : approval.action === "kernel.fileChange" ? t("Knorvia 请求修改文件。", "Knorvia is requesting permission to edit files.") : t("Knorvia 请求额外权限。", "Knorvia is requesting additional permissions.")}</p>
    {description ? <pre>{typeof description === "string" ? description : JSON.stringify(description, null, 2)}</pre> : <pre>{JSON.stringify(target, null, 2)}</pre>}
    {typeof target.cwd === "string" && <small>{target.cwd}</small>}
    <div className="nw-approval-actions"><button className="nw-button" disabled={pending} onClick={() => void act("deny")}>{t("拒绝", "Decline")}</button><button className="nw-button nw-button-primary" disabled={pending} onClick={() => void act("allow")}>{pending ? <Loader2 size={14} className="nw-spin" /> : <Check size={14} />}{t("允许这次操作", "Allow this operation")}</button></div>
  </div>;
}

// P07: bounded rendering for long conversations. Rows are memoised on item
// identity (live updates re-render only their own row), collapsed details
// defer and UNMOUNT their heavy bodies with open state, and history is
// presented as a sliding window of fixed-size chunks: DOM only ever holds
// WINDOW_CHUNKS chunks no matter how long the conversation is. Every item
// stays locatable — the timeline listens for "knorvia:locate-timeline-item"
// (dispatched by ConversationNavigation when an id is not mounted), mounts
// the chunk that contains it, and slides the window there.

const CHUNK_SIZE = 300;
const WINDOW_CHUNKS = 3;
const LOCATE_EVENT = "knorvia:locate-timeline-item";

export function TaskTimeline({ thread }: { thread: ThreadSnapshot }) {
  const { t, live, saveResult, readThread, setNotice, setError, recovery } = useWorkbench();
  const timelineRoot = useRef<HTMLDivElement>(null);
  const [locateTarget, setLocateTarget] = useState<{ id: string; threadId: string } | null>(null);
  const [saving, setSaving] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const liveText = useMemo(() => live.filter(item => item.threadId === thread.id), [live, thread.id]);
  const visibleItems = useMemo(() => thread.items.filter(item => item.kind !== "tool.write"), [thread.items]);
  // Fixed-size chunks in natural (oldest-first) order. Server-side prepends
  // ("加载更早的记录") shift earlier chunk boundaries by at most one page, but
  // chunk membership of already-mounted rows is stable, and the newest chunk
  // is always chunks[lastChunk].
  const chunks = useMemo(() => {
    const list: Item[][] = [];
    for (let start = 0; start < visibleItems.length; start += CHUNK_SIZE) {
      list.push(visibleItems.slice(start, start + CHUNK_SIZE));
    }
    return list;
  }, [visibleItems]);
  const lastChunk = chunks.length - 1;
  const [windowRange, setWindowRange] = useState<{ start: number; end: number } | null>(null);
  // Default window: the newest side. A saved/detached range is clamped so a
  // switch to a shorter thread can never produce an empty or out-of-bounds page.
  const range = useMemo(() => {
    if (lastChunk < 0) return { start: 0, end: -1 };
    if (!windowRange) return { start: Math.max(0, lastChunk - WINDOW_CHUNKS + 1), end: lastChunk };
    const end = Math.max(0, Math.min(windowRange.end, lastChunk));
    const start = Math.max(0, Math.min(windowRange.start, end));
    return { start: Math.max(0, Math.min(start, end - WINDOW_CHUNKS + 1)), end };
  }, [windowRange, lastChunk]);
  const clamp = useCallback((start: number) => {
    const clampedStart = Math.max(0, Math.min(start, Math.max(0, lastChunk - WINDOW_CHUNKS + 1)));
    return { start: clampedStart, end: Math.min(lastChunk, clampedStart + WINDOW_CHUNKS - 1) };
  }, [lastChunk]);
  // Returning to a task restores the saved reading anchor even when it lives
  // in an unmounted chunk; otherwise the default window is the newest side.
  const anchorApplied = useRef(false);
  const reanchorEpoch = useRef(0);
  useEffect(() => {
    // Switching threads invalidates everything: a pending prepend anchor from
    // the old thread must never land in the new one (late server response),
    // and in-flight compensation rAF loops die with the epoch bump.
    reanchorEpoch.current += 1;
    anchorApplied.current = false;
    pendingAnchor.current = null;
    setWindowRange(null);
  }, [thread.id]);
  useEffect(() => {
    if (anchorApplied.current || !chunks.length) return;
    anchorApplied.current = true;
    let anchor: string | undefined;
    try { anchor = readTaskView(thread.id).reading?.anchor; } catch { anchor = undefined; }
    if (!anchor) return;
    const index = chunks.findIndex(chunk => chunk.some(item => item.id === anchor));
    if (index >= 0) setWindowRange(clamp(index));
  }, [chunks, clamp, thread.id]);
  // Locate an unmounted item: mount the chunk containing it (minimal
  // interface used by ConversationNavigation).
  useEffect(() => {
    const onLocate = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; threadId?: string; scroll?: boolean }>).detail;
      if (detail?.threadId && detail.threadId !== thread.id) return;
      const id = detail?.id;
      if (!id) return;
      const index = chunks.findIndex(chunk => chunk.some(item => item.id === id));
      if (index < 0) return;
      setWindowRange(clamp(index));
      if (detail.scroll) setLocateTarget({ id, threadId: thread.id });
    };
    window.addEventListener(LOCATE_EVENT, onLocate);
    return () => window.removeEventListener(LOCATE_EVENT, onLocate);
  }, [chunks, clamp, thread.id]);
  useEffect(() => {
    if (!locateTarget || locateTarget.threadId !== thread.id) return;
    const frame = requestAnimationFrame(() => {
      const item = timelineRoot.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(locateTarget.id)}"]`);
      const scroller = item?.closest<HTMLElement>(".nw-task-scroll, .nw-side-chat-history");
      if (item && scroller) scroller.scrollTo({ top: scroller.scrollTop + item.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 70, behavior: "instant" });
      else item?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [locateTarget, range, thread.id]);
  const mountOlder = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const scroller = event.currentTarget.closest(".nw-task-scroll, .nw-side-chat-history");
    const anchor = scroller?.querySelector<HTMLElement>("[data-item-id]");
    const before = anchor?.getBoundingClientRect().top;
    setWindowRange(clamp(range.start - 1));
    requestAnimationFrame(() => { if (scroller && anchor?.isConnected && before !== undefined) scroller.scrollTop += anchor.getBoundingClientRect().top - before; });
  };
  // Server-side prepends shift every chunk's membership, so the window is
  // re-anchored on the reader's first visible message id (not DOM refs, which
  // do not survive a chunk remount) before pixel compensation runs.
  const pendingAnchor = useRef<{ id: string; top: number; scroller: HTMLElement } | null>(null);
  const subAgentsByTurn = useMemo(() => {
    const groups = new Map<string, Item[]>();
    for (const item of thread.items) if (item.kind === 'subAgent') {
      const items = groups.get(item.turnId) ?? []; items.push(item); groups.set(item.turnId, items);
    }
    return groups;
  }, [thread.items]);
  // Stable row callbacks: identity is kept across live updates so memoised
  // rows skip re-rendering; the live thread is read through a ref.
  const onCopy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => setNotice(t("已复制", "Copied"))).catch(error => setError(errorText(error)));
  }, [setNotice, setError, t]);
  const onBookmark = useCallback((item: Item, excerpt: string) => {
    // Persisted rows only: streaming text becomes citable once it is a durable Item.
    if (item.status !== "completed" || item.seq <= 0) return;
    const { list, bookmark } = addBookmark(loadBookmarks(), { threadId: item.threadId, itemId: item.id, turnId: item.turnId, seq: item.seq, kind: item.kind, text: itemText(item), excerpt });
    if (!saveBookmarks(list)) { setError(t("书签未保存，本地存储不可用。请复制原文保留。", "Bookmark not saved: local storage is unavailable. Copy the source to keep it.")); return; }
    setNotice(t("已添加书签", "Bookmarked at seq " + bookmark.seq));
  }, [setNotice, setError, t]);
  const onSave = useCallback((itemId: string, text: string) => {
    setSaving(itemId);
    void saveResult(threadRef.current, text).catch(error => setError(errorText(error))).finally(() => setSaving(""));
  }, [saveResult, setError]);
  const renderItem = (item: Item) => {
    if (item.kind === 'subAgent') {
      const children = subAgentsByTurn.get(item.turnId)!;
      // A turn's sub-agent rows may span chunk boundaries: anchor the group at
      // the first child that is actually mounted so the group never vanishes
      // just because its earliest member sits in an unmounted chunk.
      if (item.id !== mountedIds.get(item.turnId)) return null;
      return <SubAgentActivity key={`agents-${item.turnId}`} items={children} scope={{ threadId: thread.id, turnId: item.turnId, active: thread.activeTurn?.id === item.turnId }} />;
    }
    if (item.kind === "userMessage") return <UserMessageRow key={item.id} item={item} goalId={thread.goalId} t={t} onBookmark={onBookmark} />;
    if (item.kind !== "agentMessage") return <ToolRow key={item.id} item={item} t={t} />;
    return <AgentMessageRow key={item.id} item={item} title={thread.title} saving={saving === item.id} t={t} onCopy={onCopy} onSave={onSave} onBookmark={onBookmark} />;
  };
  // After a server prepend, re-anchor the window on the reader's message and
  // compensate the scroll position once the (possibly remounted) row exists.
  const settleStable = useRef(0);
  // While correcting, the window renders at full fidelity (scoped class): the
  // content-visibility estimates would otherwise shift the layout under the
  // correction. After the class comes off, a bounded settle loop absorbs the
  // estimate-restore residual (target ≤2px, finite frames).
  useEffect(() => {
    const pending = pendingAnchor.current;
    if (!pending || !chunks.length) return;
    const index = chunks.findIndex(chunk => chunk.some(item => item.id === pending.id));
    if (index < 0) { pendingAnchor.current = null; return; }
    const desired = clamp(index);
    if (desired.start !== range.start || desired.end !== range.end) {
      setWindowRange(desired);
      return; // keep the pending anchor; the next pass compensates pixels
    }
    pendingAnchor.current = null;
    settleStable.current = 0;
    const epoch = reanchorEpoch.current;
    const alive = () => reanchorEpoch.current === epoch;
    pending.scroller.classList.add("nw-reanchoring");
    const anchorEl = () => pending.scroller.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(pending.id)}"]`);
    const settle = (attempt: number) => {
      if (!alive()) { pending.scroller.classList.remove("nw-reanchoring"); return; }
      // Estimates come back the moment the class is off; every settle pass
      // runs with them active and corrects the residual they introduce. The
      // position must read stable (≤2px) on consecutive frames before the
      // loop stops — a single mid-transition reading proves nothing.
      pending.scroller.classList.remove("nw-reanchoring");
      const el = anchorEl();
      if (!el || attempt >= 14) { pending.scroller.classList.remove("nw-reanchoring"); return; }
      const delta = el.getBoundingClientRect().top - pending.top;
      if (Math.abs(delta) <= 2) {
        settleStable.current += 1;
        if (settleStable.current >= 3) { pending.scroller.classList.remove("nw-reanchoring"); return; }
      } else {
        settleStable.current = 0;
        pending.scroller.scrollTop += delta;
      }
      requestAnimationFrame(() => settle(attempt + 1));
    };
    const compensate = (attempt: number) => {
      if (!alive()) { pending.scroller.classList.remove("nw-reanchoring"); return; }
      const el = anchorEl();
      if (!el) { pending.scroller.classList.remove("nw-reanchoring"); return; }
      const delta = el.getBoundingClientRect().top - pending.top;
      pending.scroller.scrollTop += delta;
      if (Math.abs(delta) > 2 && attempt < 24) requestAnimationFrame(() => compensate(attempt + 1));
      else requestAnimationFrame(() => settle(0));
    };
    requestAnimationFrame(() => compensate(0));
  }, [chunks, range, clamp]);
  const mountedChunks = chunks.slice(range.start, range.end + 1);
  const mountedRows = mountedChunks.reduce((total, chunk) => total + chunk.length, 0);
  const mountedIds = useMemo(() => {
    const ids = new Map<string, string>();
    for (const item of thread.items) {
      if (item.kind !== 'subAgent' || ids.has(item.turnId)) continue;
      if (mountedChunks.some(chunk => chunk.includes(item))) ids.set(item.turnId, item.id);
    }
    return ids;
  }, [thread.items, mountedChunks]);
  return <div ref={timelineRoot} className="nw-timeline" aria-label={t("任务内容", "Task conversation")}>
    {thread.hasMoreItems && typeof thread.itemsNextCursor === "number" && <button className="nw-load-older" disabled={loadingOlder} onClick={async event => { const scroller = event.currentTarget.closest<HTMLElement>(".nw-task-scroll, .nw-side-chat-history"); const bounds = scroller?.getBoundingClientRect(); const anchor = scroller && bounds ? [...scroller.querySelectorAll<HTMLElement>("[data-item-id]")].find(node => node.getBoundingClientRect().bottom > bounds.top + 1) : undefined; const anchorId = anchor?.getAttribute("data-item-id") ?? ""; pendingAnchor.current = anchor && anchorId && scroller ? { id: anchorId, top: anchor.getBoundingClientRect().top, scroller } : null; setLoadingOlder(true); try { await readThread(thread.id, thread.itemsNextCursor ?? undefined); } catch (error) { pendingAnchor.current = null; setError(errorText(error)); } finally { setLoadingOlder(false); } }}>{loadingOlder ? t("正在读取…", "Loading…") : t("加载更早的记录", "Load earlier history")}</button>}
    {range.start > 0 && <button className="nw-load-older" onClick={mountOlder}>{t(`显示更早的消息（还有 ${range.start * CHUNK_SIZE} 条）`, `Show earlier messages (${range.start * CHUNK_SIZE} more)`)}</button>}
    {mountedChunks.map(chunk => chunk.map(renderItem))}
    {range.end < lastChunk && <button className="nw-load-older" onClick={() => setWindowRange(clamp(range.end + 1))}>{t("显示较新的消息", "Show later messages")}</button>}
    {visibleItems.length > mountedRows && <p className="nw-event-note">{t(`共 ${visibleItems.length} 条记录，当前显示其中 ${mountedRows} 条；其余消息可随时查看或搜索。`, `${visibleItems.length} messages in total, showing ${mountedRows}; the rest stay available to browse or search.`)}</p>}
    {liveText.map(item => <article className="nw-agent-message nw-streaming-message" key={`${item.turnId}:${item.itemId}`}><Markdown text={item.text} /><span className="nw-stream-caret" /></article>)}
    {thread.pendingApprovals.filter(approval => approval.status === "pending").map(approval => <ApprovalCard key={approval.id} approval={approval} thread={thread} />)}
    {(thread.pendingUserInputs ?? []).map(item => <UserInputCard key={item.id} item={item} />)}
    {thread.activeTurn && <div className="nw-working" role="status" data-recovering={recovery?.threadId === thread.id || undefined}>{recovery?.threadId === thread.id ? <ShieldCheck size={15} /> : thread.pendingApprovals.length || thread.pendingUserInputs?.length ? <ShieldCheck size={15} /> : <Loader2 size={15} className="nw-spin" />}{recovery?.threadId === thread.id ? t("正在恢复任务状态 · 最近一次写入未确认，内容已保留", "Recovering task state · The last write is unconfirmed; your content is kept") : thread.pendingApprovals.length ? t("等待你的确认 · 可以在上方允许或拒绝", "Waiting for you · Approve or decline above") : thread.pendingUserInputs?.length ? t("等待补充信息 · 请回答上方问题", "Waiting for you · Answer the questions above") : t("正在处理任务", "Working on your task")}</div>}
    {!thread.activeTurn && thread.turns.length > 0 && <div className="nw-turn-end" data-status={taskStatus(thread)}><span /><FileText size={13} />{taskStatus(thread) === "failed" ? t("本轮执行失败 · 可以补充要求后重试", "This run failed · Send a follow-up to retry") : taskStatus(thread) === "cancelled" || taskStatus(thread) === "interrupted" ? t("本轮已停止 · 可以继续发送要求", "This run stopped · Send a follow-up to continue") : t("本轮已完成 · 记录已保存", "This run is complete · History saved")}<span /></div>}
  </div>;
}
