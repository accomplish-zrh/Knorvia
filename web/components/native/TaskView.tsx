"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Activity, Archive, ArrowDown, FolderOpen, GitBranch, GitCompareArrows, Loader2, MoreHorizontal, PanelRight, ListTree, Pencil, RefreshCw, RotateCcw, Search } from "lucide-react";
import { taskStatus, type Thread } from "@/lib/native-workbench-state";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { TaskComposer } from "./TaskComposer";
import { TaskTimeline } from "./TaskTimeline";
import { Modal, StatusLabel } from "./WorkbenchShell";
import { TaskPanel, type PanelMode } from "./TaskPanel";
import { PanelContext } from "./PanelContext";
import { openPanelTab, type PanelState, type PanelTarget } from "@/lib/native-panel";
import { ConversationGoal } from "./ConversationGoal";
import { TaskResources } from "./TaskResources";
import type { TerminalSession } from "@/lib/native-terminal";
import { readTaskView, saveTaskView } from "@/lib/native-task-view";
import { useTaskReading } from "./useTaskReading";
import { ConversationNavigation } from "./ConversationNavigation";

const subscribeHeader = () => () => {};
const getHeader = () => document.getElementById("nw-task-header-tools");
const noHeader = () => null;

const clientReady = () => true;
const serverReady = () => false;
export function TaskView({ id }: { id: string }) {
  const ready = useSyncExternalStore(subscribeHeader, clientReady, serverReady);
  return ready ? <TaskContent key={id} id={id} /> : <div className="nw-state-screen"><Loader2 size={20} className="nw-spin" /></div>;
}

function TaskContent({ id }: { id: string }) {
  const { t, snapshots, readThread, request, refresh, setError, live, connection } = useWorkbench();
  const router = useRouter();
  const header = useSyncExternalStore(subscribeHeader, getHeader, noHeader);
  const thread = snapshots[id];
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [detail, setDetail] = useState<"resources" | null>(null);
  const [panel, setPanel] = useState<{ open: boolean; content: PanelState }>(() => readTaskView(id).panel);
  const openContent = (target: PanelTarget) => { setDetail(null); setPanel(current => ({ open: true, content: openPanelTab(current.content, target!) })); };
  const openPanel = (mode: PanelMode) => openContent({ kind: mode });
  const closePanel = () => setPanel(current => ({ ...current, open: false }));
  const [contextFiles, setContextFiles] = useState<string[]>(() => readTaskView(id).contextFiles);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [searching, setSearching] = useState(false);
  const { scroll, nearBottom, jump, pauseFollowing } = useTaskReading(id, thread ? `${thread.items.length}:${live.filter(item => item.threadId === id).map(item => item.text.length).join(',')}:${thread.pendingApprovals.length}` : undefined);
  const menuAnchor = useRef<HTMLDivElement>(null);

  useEffect(() => { saveTaskView(id, { panel, contextFiles }); }, [id, panel, contextFiles]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f' && !(event.target instanceof Element && event.target.closest('.nw-task-panel, dialog'))) { event.preventDefault(); setSearching(true); return; }
      const terminalFocus = event.target instanceof Element && event.target.closest('.xterm');
      if (terminalFocus && !(event.ctrlKey && (event.code === 'Backquote' || (event.altKey && event.key.toLowerCase() === 'b')))) return;
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
        let target: PanelTarget | undefined;
        if (!event.altKey && event.key.toLowerCase() === "p") target = { kind: "files" };
        else if (event.altKey && event.key.toLowerCase() === "s") target = { kind: "chat", id: crypto.randomUUID() };
        else if (!event.altKey && event.key.toLowerCase() === "t") target = { kind: "browser" };
        else if (!event.altKey && event.code === 'Backquote') target = { kind: 'terminal', id: crypto.randomUUID() };
        if (target) { event.preventDefault(); setDetail(null); setPanel(current => ({ open: true, content: openPanelTab(current.content, target!) })); }
      }
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault(); setDetail(null); setPanel(current => ({ ...current, open: !current.open }));
      }
      if (event.key === "Escape" && !event.defaultPrevented && !menu && !document.querySelector("dialog[open]")) setDetail(null);
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [menu]);

  useEffect(() => {
    if (connection !== 'connected') return;
    let cancelled = false;
    void request<TerminalSession[]>('terminal/list', { threadId: id }).then(sessions => {
      if (cancelled || !sessions.length) return;
      setPanel(current => {
        let content = current.content;
        for (const session of sessions) if (!content.tabs.some(tab => tab.id === `terminal:${session.sessionId}`)) content = openPanelTab(content, { kind: 'terminal', id: session.sessionId, restore: true });
        return { ...current, content: { ...content, active: current.content.active } };
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [id, connection, request]);

  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuAnchor.current?.contains(event.target as Node)) setMenu(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMenu(false); menuAnchor.current?.querySelector("button")?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [menu]);

  useEffect(() => {
    if (connection !== "connected") return;
    let cancelled = false;
    setLoading(true); setLoadError("");
    void readThread(id).catch(error => { if (!cancelled) setLoadError(errorText(error)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, connection, readThread]);

  const action = async (method: string, params: Record<string, unknown>) => {
    if (pending) return;
    setPending(true); setMenu(false);
    try {
      const result = await request<Thread>(method, params);
      await refresh();
      if (method === "thread/fork") router.push(`/workbench/task/${encodeURIComponent(result.id)}`);
      else await readThread(id);
      setRenaming(false);
    } catch (error) { setError(errorText(error)); } finally { setPending(false); }
  };

  if (!thread) return <div className="nw-state-screen">{loadError ? <><p role="alert">{loadError}</p><button className="nw-button" onClick={() => void readThread(id).catch(error => setLoadError(errorText(error)))}><RefreshCw size={15} />{t("重新读取任务", "Reload task")}</button></> : <><Loader2 className="nw-spin" size={20} /><p>{loading ? t("正在读取任务…", "Loading task…") : t("等待连接…", "Waiting for connection…")}</p></>}</div>;

  const tools = <div className="nw-task-header-content"><div className="nw-task-heading"><FolderOpen size={17} /><h1 title={thread.title}>{thread.title}</h1><StatusLabel status={taskStatus(thread)} /></div><div className="nw-task-tools"><button className="nw-icon" aria-label={t("在对话中查找", "Find in conversation")} title={t("在对话中查找 · Ctrl F", "Find in conversation · Ctrl F")} aria-pressed={searching} onClick={() => setSearching(value => !value)}><Search size={17} /></button><button className="nw-icon" aria-label={t("资料与成果", "Resources and outputs")} title={t("资料与成果", "Resources and outputs")} aria-pressed={detail === "resources"} onClick={() => { closePanel(); setDetail(detail === "resources" ? null : "resources"); }}><ListTree size={18} /></button><button className="nw-icon" aria-label={t("右侧工作面板", "Right work panel")} title={t("右侧工作面板 · Ctrl Alt B", "Right work panel · Ctrl Alt B")} aria-pressed={panel?.open ?? false} onClick={() => { setDetail(null); setPanel(current => ({ ...current, open: !current.open })); }}><PanelRight size={18} /></button><div className="nw-menu-anchor" ref={menuAnchor}><button className="nw-icon" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-controls="nw-task-actions" aria-label={t("任务操作", "Task actions")}><MoreHorizontal size={18} /></button>{menu && <div className="nw-popover" id="nw-task-actions"><button onClick={() => { openPanel("files"); setMenu(false); }}><FolderOpen size={14} />{t("文件", "Files")}</button><button onClick={() => { openPanel("changes"); setMenu(false); }}><GitCompareArrows size={14} />{t("改动", "Changes")}</button><button onClick={() => { openPanel("activity"); setMenu(false); }}><Activity size={14} />{t("任务活动", "Task activity")}</button><button onClick={() => { setTitle(thread.title); setRenaming(true); setMenu(false); }}><Pencil size={14} />{t("重命名", "Rename")}</button><button disabled={pending || Boolean(thread.activeTurn)} onClick={() => void action("thread/fork", { threadId: id, idempotencyKey: crypto.randomUUID() })}><GitBranch size={14} />{t("分叉任务", "Fork task")}</button><button disabled={pending || Boolean(thread.activeTurn)} onClick={() => void action(thread.status === "archived" ? "thread/unarchive" : "thread/archive", { id })}>{thread.status === "archived" ? <RotateCcw size={14} /> : <Archive size={14} />}{thread.status === "archived" ? t("恢复到任务列表", "Unarchive task") : t("归档任务", "Archive task")}</button></div>}</div></div></div>;
  return <PanelContext.Provider value={{ open: openContent, cwd: thread.cwd ?? "" }}><div className={`nw-task-view ${detail || panel?.open ? "has-detail" : ""}`}>
    {header && createPortal(tools, header)}
    <div className="nw-task-center">
      <ConversationNavigation thread={thread} scroll={scroll} searching={searching} setSearching={setSearching} navigate={pauseFollowing} /><div ref={scroll} className="nw-task-scroll"><div className="nw-task-content"><TaskTimeline thread={thread} /></div></div>

      <div className="nw-task-composer">{!nearBottom && <button className="nw-jump" onClick={jump}><ArrowDown size={15} />{t("回到最新", "Jump to latest")}</button>}{thread.status === "archived" ? <div className="nw-archived-notice"><Archive size={19} /><div><strong>{t("这个任务已归档", "This task is archived")}</strong><p>{t("历史记录仍可查看，恢复后可以继续。", "Your history is available. Unarchive to continue working.")}</p></div><button className="nw-button" disabled={pending} onClick={() => void action("thread/unarchive", { id })}><RotateCcw size={14} />{t("恢复任务", "Unarchive")}</button></div> : thread.goalId ? <ConversationGoal thread={thread}>{goal => <TaskComposer thread={thread} goal={goal} contextFiles={contextFiles} onRemoveContextFile={path => setContextFiles(current => current.filter(value => value !== path))} onContextFilesUsed={paths => setContextFiles(current => current.filter(value => !paths.includes(value)))} />}</ConversationGoal> : <TaskComposer thread={thread} contextFiles={contextFiles} onRemoveContextFile={path => setContextFiles(current => current.filter(value => value !== path))} onContextFilesUsed={paths => setContextFiles(current => current.filter(value => !paths.includes(value)))} />}</div>
    </div>{detail === "resources" && <TaskResources thread={thread} close={() => setDetail(null)} openFiles={(path, folder) => openContent(path ? { kind: "file", path } : { kind: "files", folder })} openOutput={artifact => openContent({ kind: "artifact", artifact })} />}
    <TaskPanel thread={thread} open={panel.open} state={panel.content} setState={update => setPanel(current => ({ ...current, content: typeof update === "function" ? update(current.content) : update }))} openContent={openContent} close={closePanel} onUseFile={path => setContextFiles(current => current.includes(path) ? current : [...current, path].slice(-20))} />
      {renaming && <Modal title={t("重命名任务", "Rename task")} close={() => setRenaming(false)}><form onSubmit={event => { event.preventDefault(); if (title.trim()) void action("thread/update", { id, title: title.trim(), expectedRevision: thread.revision }); }}><label className="nw-field">{t("任务名称", "Task name")}<input autoFocus value={title} onChange={event => setTitle(event.target.value)} required /></label><div className="nw-dialog-actions"><button type="button" className="nw-button" onClick={() => setRenaming(false)}>{t("取消", "Cancel")}</button><button className="nw-button nw-button-primary" disabled={pending || !title.trim()}>{t("保存", "Save")}</button></div></form></Modal>}
    </div></PanelContext.Provider>;
}
