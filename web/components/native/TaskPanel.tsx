"use client";

import { useEffect, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import { Activity, FileText, FolderOpen, GitCompareArrows, Globe, Maximize2, MessageCirclePlus, Minimize2, PanelRightClose, Plus, TerminalSquare, X } from "lucide-react";
import { itemText, type Artifact, type ThreadSnapshot } from "@/lib/native-workbench-state";
import { closePanelTab, previewUrl, type PanelTab, type PanelTabView, type PanelState, type PanelTarget } from "@/lib/native-panel";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { ItemDetail } from "./TaskTimeline";
import { ProjectExplorer } from "./ProjectExplorer";
import { BrowserPanel, FilePanelPreview } from "./PanelPreview";
import { SideChatPanel } from "./SideChatPanel";
import { TerminalPanel } from "./TerminalPanel";
import { useLocalPreference } from "./useLocalPreference";
import { RemoteWorkspace } from "./RemoteWorkspace";

export type PanelMode = "files" | "changes" | "activity";
function parseWidth(raw: string) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 360 ? Math.min(880, value) : 480;
}
const iconFor = (target: PanelTarget) => target.kind === "ssh" ? TerminalSquare : target.kind === "terminal" ? TerminalSquare : target.kind === "files" ? FolderOpen : target.kind === "browser" ? Globe : target.kind === "chat" ? MessageCirclePlus : target.kind === "changes" ? GitCompareArrows : target.kind === "activity" ? Activity : FileText;

export function TaskPanel({ thread, open, state, setState, close, onUseFile, openContent }: {
  thread: ThreadSnapshot; open: boolean; state: PanelState; setState: Dispatch<SetStateAction<PanelState>>; close: () => void; onUseFile: (path: string) => void; openContent: (target: PanelTarget) => void;
}) {
  const { t, request, setError } = useWorkbench();
  const updateView = (id: string, view: Partial<PanelTabView>) => setState(current => ({ ...current, tabs: current.tabs.map(tab => tab.id === id ? { ...tab, view: { ...tab.view, ...view } } : tab) }));
  const updateTarget = (id: string, target: PanelTarget) => setState(current => ({ ...current, tabs: current.tabs.map(tab => tab.id === id ? { ...tab, target } : tab) }));
  const closing = useRef(new Set<string>());
  const closeTab = async (tab: PanelTab) => {
    if (closing.current.has(tab.id)) return;
    closing.current.add(tab.id);
    try {
      if (tab.target.kind === 'terminal') await request('terminal/close', { threadId: thread.id, sessionId: tab.target.id });
      setState(current => closePanelTab(current, tab.id));
    } catch (error) { setError(errorText(error)); }
    finally { closing.current.delete(tab.id); }
  };
  const [outputs, setOutputs] = useState<Artifact[]>([]);
  const [width, saveWidth] = useLocalPreference("knorvia-native-panel-width", parseWidth);
  const [dragWidth, setDragWidth] = useState<number>();
  const [expanded, setExpanded] = useState(false);
  const pane = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number; current: number } | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onClose = useRef(close);
  const expandedRef = useRef(expanded);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);
  useEffect(() => { onClose.current = close; }, [close]);
  useEffect(() => {
    if (!open) return;
    const timer = requestAnimationFrame(() => {
      const tab = pane.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
      tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      // A tab-strip interaction owns its focus. Moving it into the newly opened
      // content here breaks repeated arrow-key navigation and Delete-to-close.
      const focused = document.activeElement;
      if (focused instanceof Element && pane.current?.contains(focused) && focused.closest('[role="tablist"]')) return;
      const field = [...(pane.current?.querySelectorAll<HTMLElement>('.nw-panel-browser input, .nw-panel-chat textarea, .nw-panel-terminal textarea') ?? [])]
        .find(element => element.getClientRects().length > 0 && !element.closest('[hidden], [inert]'));
      (field ?? tab ?? pane.current?.querySelector<HTMLElement>('.nw-panel-launcher button'))?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(timer);
  }, [open, state.active]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void request<Artifact[]>("artifact/list", { workspaceId: thread.workspaceId }).then(values => { if (!cancelled) setOutputs(values.slice(-5).reverse()); }).catch(() => {});
    return () => { cancelled = true; };
  }, [open, request, thread.workspaceId, thread.items.length]);
  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement;
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector("dialog[open]") || (event.target instanceof Element && event.target.closest(".xterm"))) return;
      if (event.key === "Escape") { event.preventDefault(); onClose.current(); }
      if (event.key === "Tab" && (expandedRef.current || window.matchMedia("(max-width: 1150px)").matches)) {
        const items = Array.from(pane.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, textarea, select, iframe, [tabindex="0"]') ?? []).filter(element => element.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && (document.activeElement === first || !pane.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("keydown", keyboard); if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true }); };
  }, [open]);
  useEffect(() => {
    const center = pane.current?.closest(".nw-task-view")?.querySelector<HTMLElement>(".nw-task-center");
    const narrow = window.matchMedia("(max-width: 1150px)");
    const sync = () => { if (center) center.inert = open && (narrow.matches || expanded); };
    sync(); narrow.addEventListener("change", sync);
    return () => { narrow.removeEventListener("change", sync); if (center) center.inert = false; };
  }, [open, expanded]);
  const label = (target: PanelTarget) => target.kind === "ssh" ? t("远程连接", "Remote connection") : target.kind === "terminal" ? `${t("终端", "Terminal")} ${state.tabs.filter(tab => tab.target.kind === "terminal").findIndex(tab => tab.target.kind === "terminal" && tab.target.id === target.id) + 1}` : target.kind === "file" ? target.path.split(/[\\/]/).at(-1)! : target.kind === "artifact" ? target.artifact.title : target.kind === "browser" ? (target.url ? new URL(target.url).host : t("浏览器", "Browser")) : target.kind === "chat" ? t("侧边聊天", "Side chat") : target.kind === "files" ? t("文件", "Files") : target.kind === "changes" ? t("改动", "Changes") : t("任务活动", "Activity");
  const links = [...new Set(thread.items.filter(item => item.kind === "agentMessage").flatMap(item => itemText(item).match(/https?:\/\/[^\s<>"\])]+/g) ?? []).map(url => previewUrl(url.replace(/[.,，。；;]+$/, ""))).filter((url): url is string => Boolean(url)))].slice(-5);
  const clamp = (value: number) => Math.max(360, Math.min(880, value));
  return <>
    {open && <button className={`nw-panel-scrim ${expanded ? "is-expanded" : ""}`} onClick={close} aria-label={t("关闭右侧遮罩", "Dismiss right panel overlay")} />}
    <aside ref={pane} hidden={!open} inert={!open} data-resizing={dragWidth !== undefined || undefined} className={`nw-task-panel ${expanded ? "is-expanded" : ""}`} aria-label={t("右侧工作面板", "Right work panel")} style={{ "--nw-panel-width": `${dragWidth ?? width}px` } as CSSProperties}>
      <div className="nw-panel-resize" role="separator" tabIndex={0} aria-label={t("调整右侧面板宽度", "Resize right panel")} aria-orientation="vertical" aria-valuemin={360} aria-valuemax={880} aria-valuenow={dragWidth ?? width} onDoubleClick={() => saveWidth(() => 480)} onKeyDown={event => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); saveWidth(current => event.key === "Home" ? 360 : event.key === "End" ? 880 : clamp(current + (event.key === "ArrowLeft" ? 32 : -32))); }
      }} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, width: pane.current?.clientWidth ?? width, current: width }; }} onPointerMove={event => { if (drag.current) { drag.current.current = clamp(drag.current.width + drag.current.x - event.clientX); setDragWidth(drag.current.current); } }} onPointerUp={event => { if (drag.current) { const next = drag.current.current; saveWidth(() => next); drag.current = null; setDragWidth(undefined); event.currentTarget.releasePointerCapture(event.pointerId); } }} onPointerCancel={() => { drag.current = null; setDragWidth(undefined); }} />
      <header className={`nw-panel-header ${state.tabs.length ? "has-tabs" : "is-empty"}`}>
        <div role="tablist" aria-label={t("已打开的内容", "Open content")} onKeyDown={event => {
          const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
          const index = tabs.indexOf(event.target as HTMLButtonElement);
          if (index >= 0 && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length; setState(current => ({ ...current, active: current.tabs[next].id })); tabs[next]?.focus(); }
          if (index >= 0 && event.key === "Delete") { event.preventDefault(); void closeTab(state.tabs[index]); tabs[index === tabs.length - 1 ? index - 1 : index + 1]?.focus(); }
        }}>{state.tabs.map((tab, index) => { const Icon = iconFor(tab.target); return <div className={`nw-content-tab ${state.active === tab.id ? "is-active" : ""}`} key={tab.id}><button role="tab" id={`nw-content-tab-${index}`} aria-controls={`nw-content-pane-${index}`} aria-selected={state.active === tab.id} tabIndex={state.active === tab.id || (!state.active && index === 0) ? 0 : -1} title={label(tab.target)} onClick={() => setState(current => ({ ...current, active: tab.id }))}><Icon size={14} /><span>{label(tab.target)}</span></button><button className="nw-tab-close" aria-label={`${t("关闭标签", "Close tab")}: ${label(tab.target)}`} onClick={() => void closeTab(tab)}><X size={12} /></button></div>; })}</div>
        {state.tabs.length > 0 && <button className="nw-icon nw-panel-add" aria-label={t("打开工作区入口", "Open workspace launcher")} title={t("打开工作区入口", "Open workspace launcher")} onClick={() => setState(current => ({ ...current, active: null }))}><Plus size={17} /></button>}
        <div className="nw-panel-actions"><button className="nw-icon" aria-label={expanded ? t("还原面板宽度", "Restore panel width") : t("扩大面板", "Expand panel")} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button><button className="nw-icon" onClick={close} aria-label={t("关闭工作面板", "Close work panel")}><PanelRightClose size={17} /></button></div>
      </header>
      <div className="nw-panel-launcher" hidden={state.active !== null}><div className="nw-panel-launcher-inner"><div className="nw-panel-launch-actions">
        <button onClick={() => openContent({ kind: "files" })}><FolderOpen size={17} /><span>{t("文件", "Files")}</span><kbd>{t("Ctrl+P", "Ctrl+P")}</kbd></button>
        <button onClick={() => openContent({ kind: "chat", id: crypto.randomUUID() })}><MessageCirclePlus size={17} /><span>{t("侧边聊天", "Side chat")}</span><kbd>{t("Ctrl+Alt+S", "Ctrl+Alt+S")}</kbd></button>
        <button onClick={() => openContent({ kind: "browser" })}><Globe size={17} /><span>{t("浏览器", "Browser")}</span><kbd>{t("Ctrl+T", "Ctrl+T")}</kbd></button>
        <button onClick={() => openContent({ kind: "terminal", id: crypto.randomUUID() })}><TerminalSquare size={17} /><span>{t("终端", "Terminal")}</span><kbd>{t("Ctrl+`", "Ctrl+`")}</kbd></button>
        <button onClick={() => openContent({ kind: "ssh" })}><TerminalSquare size={17} /><span>{t("远程连接", "Remote connection")}</span></button>
      </div>{(links.length > 0 || outputs.length > 0) && <section className="nw-panel-recommendations"><h2>{t("推荐", "Suggested")}</h2>{links.map(url => <button key={url} title={url} onClick={() => openContent({ kind: "browser", url })}><Globe size={16} /><span>{url.replace(/^https?:\/\//, '')}</span></button>)}{outputs.map(artifact => <button key={artifact.id} title={artifact.title} onClick={() => openContent({ kind: "artifact", artifact })}><FileText size={16} /><span>{artifact.title}</span></button>)}</section>}<div className="nw-panel-secondary"><button onClick={() => openContent({ kind: "changes" })}><GitCompareArrows size={14} />{t("项目改动", "Project changes")}</button><button onClick={() => openContent({ kind: "activity" })}><Activity size={14} />{t("任务活动", "Task activity")}</button></div></div></div>
      {state.tabs.map((tab, index) => <div role="tabpanel" key={tab.id} id={`nw-content-pane-${index}`} aria-labelledby={`nw-content-tab-${index}`} hidden={state.active !== tab.id} className={`nw-panel-content nw-panel-${tab.target.kind}`}>
        {tab.target.kind === "ssh" ? <RemoteWorkspace active={open && state.active === tab.id} threadId={thread.id} initialSessionId={tab.target.id} /> : tab.target.kind === "terminal" ? <TerminalPanel threadId={thread.id} sessionId={tab.target.id} restore={tab.target.restore} active={open && state.active === tab.id} onClose={() => void closeTab(tab)} onNew={() => openContent({ kind: "terminal", id: crypto.randomUUID() })} /> : tab.target.kind === "files" || tab.target.kind === "changes" ? <ProjectExplorer scope={{ threadId: thread.id }} mode={tab.target.kind} onModeChange={kind => openContent({ kind })} onUseFile={onUseFile} compact onFolderChange={folder => updateTarget(tab.id, { kind: "files", folder })} initialFolder={tab.target.kind === "files" ? tab.target.folder : undefined} onPreviewFile={tab.target.kind === "files" ? path => openContent({ kind: "file", path }) : undefined} /> : tab.target.kind === "file" ? <FilePanelPreview threadId={thread.id} path={tab.target.path} onUseFile={onUseFile} view={tab.view} updateView={value => updateView(tab.id, value)} /> : tab.target.kind === "artifact" ? <FilePanelPreview threadId={thread.id} artifact={tab.target.artifact} onUseFile={onUseFile} view={tab.view} updateView={value => updateView(tab.id, value)} /> : tab.target.kind === "browser" ? <BrowserPanel initialUrl={tab.target.url} view={tab.view} updateView={value => updateView(tab.id, value)} /> : tab.target.kind === "chat" ? <SideChatPanel parent={thread} tabId={tab.target.id} existingThreadId={tab.target.threadId} onThreadCreated={threadId => updateTarget(tab.id, { kind: "chat", id: tab.target.kind === "chat" ? tab.target.id : "", threadId })} /> : <div className="nw-panel-activity-body"><h2>{t("任务活动", "Task activity")}</h2>{thread.items.filter(item => !["userMessage", "agentMessage", "reasoning"].includes(item.kind)).map(item => <ItemDetail key={item.id} item={item} />)}</div>}
      </div>)}
    </aside>
  </>;
}
