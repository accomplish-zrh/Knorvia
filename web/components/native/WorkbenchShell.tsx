"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { ArrowUpRight, BookOpen, Check, Clock3, Film, FolderOpen, Menu, PanelLeftClose, Plus, Search, Settings, Sparkles, X, Brain as BrainIcon } from "lucide-react";
import { displayTime, taskStatus, type Workspace } from "@/lib/native-workbench-state";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { WorkbenchMark } from "./WorkbenchMark";
import { SettingsLayout } from "./SettingsLayout";
import { SettingsView } from "./SettingsView";
import { PetOverlay } from "./PetOverlay";
import "./pet.css";
import "./integration.css";
import { SidebarContent } from "./SidebarContent";
import { BotSidebar } from "./BotSidebar";
import { TaskAttentionMenu } from "./TaskAttentionMenu";
import { useDrawerFocus } from "./useDrawerFocus";
import { useLocalPreference } from "./useLocalPreference";
import { parseSidebarPreferences } from "@/lib/native-sidebar";
import { SidebarResize, sidebarWidth } from "./SidebarResize";
import { READING_KEY, readingPreference } from '@/lib/native-reading';
import { WorkbenchStyleToggle } from './WorkbenchStyle';

export function Modal({ title, children, close, busy = false }: { title: string; children: React.ReactNode; close: () => void | false | Promise<void | false>; busy?: boolean }) {
  const { t } = useWorkbench();
  const ref = useRef<HTMLDialogElement>(null);
  const exitAnimation = useRef<Animation | null>(null);
  const heading = useId();
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      exitAnimation.current?.cancel();
      if (dialog) { dialog.inert = false; dialog.close(); }
      // React can remove the top-layer dialog before this cleanup runs. Restore
      // its trigger only if another dialog or control has not already taken focus.
      queueMicrotask(() => { if (trigger?.isConnected && document.activeElement === document.body) trigger.focus({ preventScroll: true }); });
    };
  }, []);
  const dismiss = () => {
    if (busy || exitAnimation.current) return;
    const dialog = ref.current;
    if (!dialog || window.matchMedia('(prefers-reduced-motion: reduce)').matches || dialog.closest('[data-reduce-motion="true"]')) { close(); return; }
    const current = getComputedStyle(dialog);
    const start = { opacity: current.opacity, translate: current.translate, scale: current.scale };
    dialog.dataset.closing = 'true';
    dialog.inert = true;
    const animation = dialog.animate([start, { opacity: 0, translate: '0 6px', scale: '.98' }], { duration: 130, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
    exitAnimation.current = animation;
    const restore = () => { animation.cancel(); exitAnimation.current = null; dialog.inert = false; delete dialog.dataset.closing; };
    animation.finished.then(async () => { if (await close() === false) restore(); }).catch(restore);
  };
  return <dialog ref={ref} className="nw-modal" aria-labelledby={heading} aria-busy={busy} onCancel={event => { event.preventDefault(); dismiss(); }} onClick={event => {
    if (event.target !== ref.current) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    // Native dialog retargets backdrop clicks to itself. Its own padding is
    // also that same target, so only clicks beyond the surface may dismiss it.
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismiss();
  }}>
    <div className="nw-modal-heading"><h2 id={heading}>{title}</h2><button type="button" className="nw-icon" disabled={busy} onClick={dismiss} aria-label={t("关闭对话框", "Close dialog")} title={t("关闭对话框", "Close dialog")}><X size={18} /></button></div>
    {children}
  </dialog>;
}

export function StatusDot({ status }: { status: string }) {
  return <span className={`nw-status-dot nw-status-${status}`} aria-hidden />;
}

export function StatusLabel({ status }: { status: string }) {
  const { t } = useWorkbench();
  const labels: Record<string, string> = { input: t("需要补充", "Needs input"), ready: t("未开始", "Ready"), running: t("进行中", "Working"), approval: t("需要确认", "Needs approval"), completed: t("已完成", "Completed"), failed: t("执行失败", "Failed"), cancelled: t("已停止", "Stopped"), interrupted: t("已中断", "Interrupted") };
  return <span className="nw-status-label" data-status={status}><StatusDot status={status} />{labels[status] ?? status}</span>;
}

function TaskSearch({ close }: { close: () => void }) {
  const { t, threads, workspaces, threadIndexComplete, locale } = useWorkbench();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const projectNames = new Map(workspaces.map(project => [project.id, project.title]));
  const matches = threads.filter(thread => `${thread.title} ${projectNames.get(thread.workspaceId) ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const results = matches.slice(0, 50);
  const selected = Math.min(active, results.length - 1);
  const openTask = (id: string) => { close(); router.push(`/workbench/task/${encodeURIComponent(id)}`); };
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [selected, query]);
  return <Modal title={t("搜索任务", "Search tasks")} close={close}>
    <div className="nw-search-field"><Search size={19} /><input autoFocus role="combobox" aria-label={t("按任务或项目名称搜索", "Search task or project names")} aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={selected >= 0 ? `${listId}-${selected}` : undefined} value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} placeholder={t("任务名称、项目名称…", "Task or project name…")} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && results.length) {
        event.preventDefault(); setActive((selected + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
      } else if (event.key === "Enter" && results[selected]) { event.preventDefault(); openTask(results[selected].id); }
    }} />{query && <button className="nw-icon" aria-label={t("清空搜索", "Clear search")} onClick={() => { setQuery(""); setActive(0); }}><X size={16} /></button>}</div>
    <div className="nw-search-caption"><span role="status">{query.trim() ? t(`${matches.length} 个匹配任务`, `${matches.length} matching tasks`) : t("最近的任务", "Recent tasks")}{!threadIndexComplete && t(" · 读取中…", " · Loading…")}</span><span>{t("包含已归档任务", "Includes archived tasks")}</span></div>
    <div className="nw-search-results" ref={list} id={listId} role="listbox" aria-label={t("搜索结果", "Search results")}>{results.map((thread, index) => <button key={thread.id} id={`${listId}-${index}`} role="option" aria-selected={selected === index} tabIndex={-1} onMouseMove={() => setActive(index)} onClick={() => openTask(thread.id)}><StatusDot status={taskStatus(thread)} /><span>{thread.title}<small>{projectNames.get(thread.workspaceId)} · {displayTime(thread.updatedAt, locale)}{thread.status === "archived" && t(" · 已归档", " · Archived")}</small></span><ArrowUpRight size={16} /></button>)}</div>
    {!results.length && <div className="nw-search-empty"><Search size={24} /><strong>{query.trim() ? t("没有找到相关任务", "No matching tasks") : t("从第一个任务开始", "Start with your first task")}</strong><p>{query.trim() ? t("换个关键词，或按项目名称试试。", "Try another keyword or search by project name.") : t("创建后的任务会保留在这里，随时可以继续。", "Your tasks will appear here whenever you want to return.")}</p></div>}
    <div className="nw-search-footer"><span><kbd>{"↑"}</kbd><kbd>{"↓"}</kbd> {t("选择", "Select")} <kbd>{"Enter"}</kbd> {t("打开", "Open")} <kbd>{"Esc"}</kbd> {t("关闭", "Close")}</span>{matches.length > 50 && <span>{t("显示前 50 项", "First 50 results")}</span>}</div>
  </Modal>;
}

export function ProjectDialog({ close, project }: { close: () => void; project?: Workspace }) {
  const { t, request, refresh, setWorkspaceId } = useWorkbench();
  const [title, setTitle] = useState(project?.title ?? "");
  const [cwd, setCwd] = useState(project?.cwd ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [canChooseFolder, setCanChooseFolder] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void request<{ capabilities?: { selectFolder?: boolean } }>("connection/read").then(value => { if (!cancelled) setCanChooseFolder(Boolean(value.capabilities?.selectFolder)); }).catch(() => {});
    return () => { cancelled = true; };
  }, [request]);
  return <Modal title={project ? t("编辑项目", "Edit project") : t("新建项目", "New project")} close={close} busy={pending}>
    <form onSubmit={async event => {
      event.preventDefault(); if (!title.trim() || pending) return;
      setPending(true); setError("");
      try {
        const workspace = await request<{ id: string }>(project ? "workspace/update" : "workspace/create", { ...(project ? { id: project.id, expectedRevision: project.revision } : {}), title: title.trim(), ...(cwd.trim() ? { cwd: cwd.trim() } : {}), idempotencyKey: crypto.randomUUID() });
        await refresh(); setWorkspaceId(workspace.id); close();
      } catch (error) { setError(errorText(error)); } finally { setPending(false); }
    }}>
      <label className="nw-field">{t("项目名称", "Project name")}<input autoFocus required value={title} onChange={event => setTitle(event.target.value)} placeholder={t("例如：产品发布", "e.g. Product launch")} /></label>
      <label className="nw-field">{t("本地文件夹（可选）", "Local folder (optional)")}<span className="nw-folder-field"><input value={cwd} onChange={event => setCwd(event.target.value)} placeholder={t("输入完整文件夹路径", "Enter an absolute folder path")} />{canChooseFolder && <button type="button" className="nw-button" aria-label={t("选择本地文件夹", "Choose local folder")} onClick={async () => { try { const result = await request<{ cancelled: boolean; path?: string }>("desktop/select-folder", { ...(cwd ? { defaultPath: cwd } : {}) }); if (!result.cancelled && result.path) setCwd(result.path); } catch (error) { setError(errorText(error)); } }}><FolderOpen size={16} /></button>}</span></label>
      <p className="nw-help">{project ? t("新任务使用此文件夹，已有任务保留原工作目录。留空会保留当前设置。", "New tasks use this folder; existing tasks keep their working directory. Leave blank to keep the current setting.") : t("任务将在这个文件夹中读取资料和开展工作。", "Tasks will use this folder for files and their working environment.")}</p>
      {error && <p role="alert" className="nw-inline-error">{error}</p>}
      <div className="nw-dialog-actions"><button type="button" className="nw-button" disabled={pending} onClick={close}>{t("取消", "Cancel")}</button><button className="nw-button nw-button-primary" disabled={!title.trim() || pending}>{pending ? t("正在保存…", "Saving…") : project ? t("保存项目", "Save project") : t("创建项目", "Create project")}</button></div>
    </form>
  </Modal>;
}

export function WorkbenchShell({ children }: { children: React.ReactNode }) {
  const { t, locale, toggleLocale, connection, error, errorKind, setError, notice, setNotice, reconnect, recovery, clearRecovery, threads, workspaceId, setWorkspaceId, readThread } = useWorkbench();
  const pathname = usePathname();
  const router = useRouter();
  const [preferences, updatePreferences] = useLocalPreference("knorvia-native-sidebar-v1", parseSidebarPreferences);
  const [narrow, setNarrow] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const [leftWidth, setLeftWidth] = useLocalPreference('knorvia-native-sidebar-width', sidebarWidth);
  const [reading] = useLocalPreference(READING_KEY, readingPreference);
  const readingStyle = { '--nw-reading-size': `${reading.size}px`, '--nw-reading-width': `${{ focused: 800, standard: 960, wide: 1120 }[reading.width]}px` } as CSSProperties;
  useDrawerFocus(mobileOpen && narrow, sidebarRef, () => setMobileOpen(false));
  // OS notification click-through: the main process owns banners and asks the
  // renderer to reveal the task. Only available inside the desktop shell.
  const notificationContext = useRef({ router, pathname, workspaceId, setWorkspaceId, readThread, setError, t });
  notificationContext.current = { router, pathname, workspaceId, setWorkspaceId, readThread, setError, t };
  useEffect(() => {
    let mounted = true;
    let generation = 0;
    const desktop = typeof window !== "undefined" ? window.knorviaDesktop : undefined;
    const unsubscribe = desktop?.notifications?.onOpenThread?.((threadId) => {
      const currentGeneration = ++generation;
      const context = notificationContext.current;
      const stillCurrent = () => mounted && generation === currentGeneration && notificationContext.current.pathname === context.pathname;
      const missing = () => {
        if (!stillCurrent()) return;
        const current = notificationContext.current;
        current.setError(current.t("未找到对应的任务或任务已失效。", "Task not found or has expired."));
      };
      if (typeof threadId !== "string" || !threadId.trim() || threadId.length > 200 || /[\u0000-\u001f\u007f<>"'\\]/.test(threadId)) {
        missing();
        return;
      }
      // Re-read even a cached task: a notification may outlive its deletion
      // or project move. readThread returns the flat authoritative snapshot.
      void context.readThread(threadId).then((snapshot) => {
        if (!stillCurrent()) return;
        if (snapshot?.id !== threadId || !snapshot.workspaceId) { missing(); return; }
        const current = notificationContext.current;
        if (snapshot.workspaceId !== current.workspaceId) current.setWorkspaceId(snapshot.workspaceId);
        current.router.push(`/workbench/task/${encodeURIComponent(threadId)}`);
      }).catch(missing);
    });
    return () => {
      mounted = false;
      generation += 1;
      try { unsubscribe?.(); } catch { /* optional bridge */ }
    };
  }, []);
  const [settingsBack, setSettingsBack] = useState("/workbench");
  const isSettings = pathname === "/workbench/settings" || pathname.startsWith("/workbench/settings/");
  const collapsed = narrow ? !mobileOpen : preferences.collapsed;
  const setCollapsed = (value: boolean) => { if (narrow) setMobileOpen(!value); else updatePreferences(current => ({ ...current, collapsed: value })); };
  if (!isSettings && settingsBack !== pathname) setSettingsBack(pathname);
  const [search, setSearch] = useState(false);
  const [projectDialog, setProjectDialog] = useState(false);
  const botsMode = pathname === "/workbench/bots";
  const selectedId = pathname.startsWith("/workbench/task/") ? decodeURIComponent(pathname.slice("/workbench/task/".length)) : "";
  const selected = threads.find(thread => thread.id === selectedId);
  const nav = [
    { href: "/workbench", label: t("新对话", "New conversation"), icon: Plus },
    { href: "/workbench/automations", label: t("自动化", "Automations"), icon: Clock3 },
    { href: "/workbench/studio", label: t("创作台", "Studio"), icon: Film },
    { href: "/workbench/library", label: t("资料库", "Library"), icon: BookOpen },
    { href: "/workbench/packs", label: t("扩展", "Extensions"), icon: Sparkles },
  ];
  const title = botsMode ? t("Bots", "Bots") : selected?.title ?? (nav.find(item => item.href === pathname)?.label ?? (pathname.includes("/memory") ? t("记忆", "Memory") : pathname.includes("/history") ? t("对话记录", "Conversation history") : pathname.includes("/artifacts") ? t("资料库", "Library") : pathname.includes("/goals") ? t("目标记录", "Goal history") : pathname.includes("/project") ? t("项目", "Projects") : pathname.includes("settings") ? t("设置", "Settings") : t("新任务", "New task")));
  const activeProjectId = selected?.workspaceId ?? workspaceId;
  const connectionLabel = connection === "connected" ? t("已连接", "Connected") : ["connecting", "reconnecting"].includes(connection) ? t("连接中", "Connecting") : t("连接已断开", "Disconnected");

  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 650px)");
    const resize = () => { setNarrow(narrow.matches); setMobileOpen(false); };
    resize();
    narrow.addEventListener("change", resize);
    return () => narrow.removeEventListener("change", resize);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('.xterm'))) return;
      if (event.isComposing || document.querySelector('dialog[open]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); router.push('/workbench/settings'); return; }
      if (!isSettings && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setMobileOpen(false); setSearch(value => !value); }
      if (!isSettings && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "b") { event.preventDefault(); if (window.matchMedia("(max-width: 650px)").matches) setMobileOpen(value => !value); else updatePreferences(value => ({ ...value, collapsed: !value.collapsed })); }
      if (event.key === "Escape" && !event.defaultPrevented) setMobileOpen(false);
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") { event.preventDefault(); router.push("/workbench"); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [router, isSettings, updatePreferences]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice, setNotice]);

  if (isSettings) return <div className="nw-root nw-settings-root" style={readingStyle} data-reduce-motion={reading.reducedMotion}><a className="nw-skip-link" href="#nw-content">{t("跳到主要内容", "Skip to content")}</a><SettingsLayout back={settingsBack}><SettingsView section={pathname.split("/")[3] || "general"} /></SettingsLayout>{notice && <div className="nw-toast" role="status"><Check size={16} />{notice}</div>}{error && <div className="nw-settings-error nw-banner" role="alert"><span>{error}</span><button className="nw-icon" onClick={() => setError("")} aria-label={t("关闭提示", "Dismiss")}><X size={15} /></button></div>}</div>;

  return <div className={`nw-root ${collapsed ? "nw-sidebar-collapsed" : ""}`} data-reduce-motion={reading.reducedMotion} style={{ ...readingStyle, '--nw-sidebar-width': `${leftWidth}px` } as CSSProperties}>
    <a className="nw-skip-link" href="#nw-content">{t("跳到主要内容", "Skip to content")}</a>
    {!collapsed && <button className="nw-sidebar-scrim" onClick={() => setCollapsed(true)} aria-label={t("关闭侧栏", "Close sidebar")} />}
    <aside ref={sidebarRef} className="nw-sidebar" inert={collapsed} aria-hidden={collapsed} onClick={event => { if (window.matchMedia("(max-width: 650px)").matches && (event.target as Element).closest("a, .nw-project")) setCollapsed(true); }}>
      <nav className="nw-sidebar-tabs" aria-label={t("侧栏模式", "Sidebar mode")}><Link href="/workbench" aria-current={!botsMode ? "page" : undefined}>{t("会话", "SESSIONS")}</Link><Link href="/workbench/bots" aria-current={botsMode ? "page" : undefined}>{t("BOTS", "BOTS")}</Link></nav>
      <div className="nw-brand" data-desktop-drag=""><Link href="/workbench" className="nw-wordmark"><WorkbenchMark />{"Knorvia"}</Link><div className="nw-brand-actions"><button className="nw-icon" onClick={() => { if (window.matchMedia("(max-width: 650px)").matches) setCollapsed(true); setSearch(true); }} aria-label={t("搜索任务", "Search tasks")} title={t("搜索任务 · Ctrl K", "Search tasks · Ctrl K")}><Search size={17} /></button><button className="nw-icon" onClick={() => setCollapsed(true)} aria-label={t("收起侧栏", "Collapse sidebar")}><PanelLeftClose size={17} /></button></div></div>
      {botsMode ? <Suspense fallback={null}><BotSidebar navigate={() => setMobileOpen(false)} /></Suspense> : <>
        <nav className="nw-nav" aria-label={t("工作台导航", "Workbench navigation")}>{nav.map(item => <Link key={item.href} href={item.href} aria-current={pathname === item.href ? "page" : undefined} className={pathname === item.href ? "nw-nav-item is-active" : "nw-nav-item"}><item.icon size={17} /><span>{item.label}</span></Link>)}</nav>
        <SidebarContent selectedId={selectedId} activeProjectId={activeProjectId} preferences={preferences} update={updatePreferences} newProject={() => { setMobileOpen(false); setProjectDialog(true); }} navigate={() => setMobileOpen(false)} />
      </>}
      <div className="nw-sidebar-bottom nw-settings-footer"><Link className={`nw-nav-item${pathname === "/workbench/memory" ? " is-active" : ""}`} aria-current={pathname === "/workbench/memory" ? "page" : undefined} href="/workbench/memory"><BrainIcon size={18} /><span>{t("记忆", "Memory")}</span></Link><Link className="nw-nav-item" href="/workbench/settings"><Settings size={18} /><span>{t("设置", "Settings")}</span></Link></div>
      {!narrow && <SidebarResize width={leftWidth} change={width => setLeftWidth(() => width)} />}
    </aside>
    <div className="nw-main" inert={mobileOpen && narrow}><header className="nw-topbar" data-desktop-drag=""><div className="nw-breadcrumb">{collapsed && <button className="nw-icon" onClick={() => setCollapsed(false)} aria-expanded={!collapsed} aria-label={t("展开侧栏", "Expand sidebar")}><Menu size={18} /></button>}{!selectedId && <span>{title}</span>}</div><div id="nw-task-header-tools" /><div className="nw-top-actions">{collapsed && <button className="nw-icon" onClick={() => setSearch(true)} aria-label={t("搜索任务", "Search tasks")}><Search size={17} /></button>}<WorkbenchStyleToggle /><TaskAttentionMenu /><button className="nw-locale" onClick={toggleLocale} aria-label={locale === "zh" ? "Switch to English" : "切换为中文"}>{locale === "zh" ? "EN" : "中文"}</button><span role="status" aria-label={connectionLabel} className={`nw-connection ${connection === "connected" ? "is-connected" : ""}`}><i />{connectionLabel}</span></div></header>
      {error && <div className="nw-banner" role="alert" data-error-kind={errorKind}><span>{errorKind === "conflict" ? `${t("操作未生效：", "The action did not take effect: ")}${error}` : error}</span>{errorKind === "connection" && <button onClick={() => { void reconnect().catch(error => setError(error)); }}>{t("重新连接", "Reconnect")}</button>}{errorKind === "generic" && connection !== "connected" && <button onClick={() => { void reconnect().catch(error => setError(error)); }}>{t("重新连接", "Reconnect")}</button>}<button className="nw-icon" onClick={() => setError("")} aria-label={t("关闭提示", "Dismiss")}><X size={15} /></button></div>}
      {recovery && <div className="nw-banner nw-recovery-banner" role="status"><div><strong>{t("任务状态待恢复", "Task state needs recovery")}</strong><span>{t("最近一次写入未能确认，正文与草稿已保留；恢复权威快照后此提示会自动消失。", "The last write could not be confirmed. Your text and drafts are kept; this notice clears once the authoritative snapshot returns.")}</span>{recovery.message && <small>{recovery.message}</small>}</div><button className="nw-icon" onClick={clearRecovery} aria-label={t("关闭提示", "Dismiss")}><X size={15} /></button></div>}
      <main className="nw-view" id="nw-content" tabIndex={-1}>{children}</main>
      {notice && <div className="nw-toast" role="status"><Check size={16} />{notice}</div>}
    </div>
    {search && <TaskSearch close={() => setSearch(false)} />}
    {projectDialog && <ProjectDialog close={() => setProjectDialog(false)} />}
  <PetOverlay t={t} state={(() => {
    const statuses = threads.map(taskStatus);
    if (statuses.includes("failed")) return "failed" as const;
    if (statuses.includes("approval") || statuses.includes("input")) return "waiting" as const;
    if (statuses.includes("running")) return "working" as const;
    return "idle" as const;
  })()} /></div>;
}
