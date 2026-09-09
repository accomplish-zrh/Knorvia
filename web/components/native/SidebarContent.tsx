"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowDown, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, Folder, FolderOpen, GitBranch, ListFilter, MoreHorizontal, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { organizeThread, sortSidebarThreads, type SidebarPreferences } from "@/lib/native-sidebar";
import { taskStatus, type Thread, type Workspace } from "@/lib/native-workbench-state";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { Modal, ProjectDialog, StatusDot } from "./WorkbenchShell";

type MenuState = { kind: "thread" | "project" | "section" | "organize"; id?: string; x: number; y: number };
export function SidebarContent({ selectedId, activeProjectId, preferences: prefs, update, newProject, navigate }: {
  selectedId: string; activeProjectId: string; preferences: SidebarPreferences;
  update: (change: (value: SidebarPreferences) => SidebarPreferences) => void;
  newProject: () => void; navigate: () => void;
}) {
  const { t, threads, workspaces, setWorkspaceId, threadIndexComplete, request, refresh, readThread, setError, setNotice } = useWorkbench();
  const router = useRouter();
  const [menu, setMenu] = useState<MenuState>();
  const [editingProject, setEditingProject] = useState<Workspace>();
  const [renaming, setRenaming] = useState<Thread>();
  const [sectionDialog, setSectionDialog] = useState<{ id?: string; threadId?: string }>();
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, number>>({});
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  // Streaming text and menu movement do not change the sidebar index.
  const { byId, pinned, available, projectThreads } = useMemo(() => {
    const sorted = sortSidebarThreads(threads, prefs.sort);
    const byId = new Map(sorted.map(thread => [thread.id, thread]));
    const pinned = prefs.pinned.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    const assigned = new Set([...prefs.pinned, ...prefs.sections.flatMap(section => section.threadIds)]);
    const available = sorted.filter(thread => !assigned.has(thread.id));
    const projectThreads = new Map<string, Thread[]>();
    for (const thread of available) {
      const list = projectThreads.get(thread.workspaceId) ?? [];
      list.push(thread); projectThreads.set(thread.workspaceId, list);
    }
    return { byId, pinned, available, projectThreads };
  }, [threads, prefs.sort, prefs.pinned, prefs.sections]);
  const recent = useMemo(() => {
    const shown = new Set(prefs.grouping === "project" ? workspaces.flatMap(project => (projectThreads.get(project.id) ?? []).slice(0, expanded[project.id] ?? 5).map(thread => thread.id)) : []);
    return available.filter(thread => !shown.has(thread.id));
  }, [available, projectThreads, prefs.grouping, workspaces, expanded]);
  const menuThread = threads.find(thread => thread.id === menu?.id);
  const menuProject = workspaces.find(project => project.id === menu?.id);
  const menuSection = prefs.sections.find(section => section.id === menu?.id);
  const closeMenu = () => { setMenu(undefined); returnFocus.current?.focus({ preventScroll: true }); };
  const openMenu = (kind: MenuState["kind"], id: string | undefined, target: HTMLElement, point?: { x: number; y: number }) => {
    const rect = target.getBoundingClientRect();
    returnFocus.current = target;
    setMenu({ kind, id, x: Math.max(8, Math.min(point?.x ?? rect.left, window.innerWidth - 248)), y: Math.max(8, Math.min(point?.y ?? rect.bottom + 4, window.innerHeight - Math.min(440, window.innerHeight - 16))) });
  };
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenu(undefined); returnFocus.current?.focus({ preventScroll: true }); } };
    const resize = () => setMenu(undefined);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", resize);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); window.removeEventListener("resize", resize); };
  }, [menu]);
  useEffect(() => { scroll.current?.querySelector(".nw-task-link.is-active")?.scrollIntoView({ block: "nearest" }); }, [selectedId, threads.length]);
  const toggleSection = (id: string) => update(current => ({ ...current, collapsedSections: current.collapsedSections.includes(id) ? current.collapsedSections.filter(value => value !== id) : [...current.collapsedSections, id] }));
  const move = (id: string, destination: string | null) => { update(current => organizeThread(current, id, destination)); closeMenu(); };
  const action = async (method: string, thread: Thread, params: Record<string, unknown>) => {
    if (pending) return;
    setPending(true); setMenu(undefined);
    try {
      const result = await request<Thread>(method, params);
      await refresh();
      if (method === "thread/fork") { navigate(); router.push(`/workbench/task/${encodeURIComponent(result.id)}`); }
      else if (selectedId === thread.id) await readThread(thread.id);
      setRenaming(undefined);
      if (method === "thread/archive") setNotice(t("任务已归档，可在对话记录中恢复。", "Task archived. Restore it from conversation history."));
    } catch (error) { setError(errorText(error)); } finally { setPending(false); }
  };
  const renderThread = (thread: Thread) => <div className="nw-sidebar-task" key={thread.id} data-thread-id={thread.id} onContextMenu={event => { event.preventDefault(); const target = event.currentTarget.querySelector<HTMLButtonElement>("button")!; openMenu("thread", thread.id, target, { x: event.clientX, y: event.clientY }); }}>
    <Link className={`nw-task-link ${selectedId === thread.id ? "is-active" : ""}`} href={`/workbench/task/${encodeURIComponent(thread.id)}`} aria-current={selectedId === thread.id ? "page" : undefined} title={thread.title} onClick={navigate}><span>{thread.title}</span>{["running", "approval", "input"].includes(taskStatus(thread)) && <StatusDot status={taskStatus(thread)} />}</Link>
    <button className="nw-icon nw-sidebar-more" aria-label={`${t("任务操作", "Task actions")}: ${thread.title}`} aria-haspopup="menu" aria-expanded={menu?.kind === "thread" && menu.id === thread.id} onClick={event => openMenu("thread", thread.id, event.currentTarget)}><MoreHorizontal size={15} /></button>
  </div>;
  const group = (id: string, name: string, tasks: Thread[], custom = false) => <section className="nw-sidebar-group" key={id} data-section-id={id} aria-label={name}>
    <div className="nw-section-heading"><button className="nw-group-toggle" onClick={() => toggleSection(id)} aria-expanded={!prefs.collapsedSections.includes(id)}>{prefs.collapsedSections.includes(id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<span>{name}</span>{id === "pinned" && <Pin size={12} />}</button>{custom && <button className="nw-icon" aria-label={`${t("分区操作", "Section actions")}: ${name}`} aria-haspopup="menu" onClick={event => openMenu("section", id, event.currentTarget)}><MoreHorizontal size={15} /></button>}</div>
    {!prefs.collapsedSections.includes(id) && <div>{tasks.slice(0, expanded[id] ?? 12).map(renderThread)}{!tasks.length && custom && <p className="nw-section-empty">{t("从任务菜单移入这个分区", "Move tasks here from their menu")}</p>}{tasks.length > (expanded[id] ?? 12) && <button className="nw-sidebar-show-more" onClick={() => setExpanded(value => ({ ...value, [id]: (value[id] ?? 12) + 20 }))}>{t("展开显示", "Show more")}</button>}</div>}
  </section>;

  return <><div className="nw-sidebar-scroll" ref={scroll}>
    {pinned.length > 0 && group("pinned", t("已置顶", "Pinned"), pinned)}
    {prefs.sections.map(section => group(section.id, section.title, section.threadIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []), true))}
    <section className="nw-sidebar-group" aria-label={t("项目", "Projects")}><div className="nw-section-heading"><button className="nw-group-toggle" aria-expanded={!prefs.collapsedSections.includes("projects")} onClick={() => toggleSection("projects")}>{prefs.collapsedSections.includes("projects") ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<span>{t("项目", "Projects")}</span></button><div className="nw-section-tools"><button className="nw-icon" aria-label={t("整理侧栏", "Organize sidebar")} aria-haspopup="menu" aria-expanded={menu?.kind === "organize"} onClick={event => openMenu("organize", undefined, event.currentTarget)}><ListFilter size={15} /></button><button className="nw-icon" onClick={newProject} aria-label={t("新建项目", "New project")}><Plus size={15} /></button></div></div>
      {!prefs.collapsedSections.includes("projects") && <div className="nw-project-list">{workspaces.map(project => {
        const tasks = projectThreads.get(project.id) ?? [], limit = expanded[project.id] ?? 5, collapsed = prefs.collapsedProjects.includes(project.id);
        return <div className="nw-project-group" key={project.id}><div className={`nw-project-heading ${activeProjectId === project.id ? "is-selected" : ""}`}>
          {prefs.grouping === "project" && <button className="nw-icon nw-project-collapse" aria-label={`${collapsed ? t("展开项目", "Expand project") : t("收起项目", "Collapse project")}: ${project.title}`} aria-expanded={!collapsed} onClick={() => update(current => ({ ...current, collapsedProjects: collapsed ? current.collapsedProjects.filter(id => id !== project.id) : [...current.collapsedProjects, project.id] }))}>{collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button>}
          <Link className="nw-project" href={`/workbench/project/${encodeURIComponent(project.id)}`} title={project.cwd ?? project.title} onClick={() => { setWorkspaceId(project.id); navigate(); }}><Folder size={15} /><span>{project.title}</span></Link><button className="nw-icon nw-sidebar-more" aria-label={`${t("项目操作", "Project actions")}: ${project.title}`} aria-haspopup="menu" onClick={event => openMenu("project", project.id, event.currentTarget)}><MoreHorizontal size={15} /></button>
        </div>{prefs.grouping === "project" && !collapsed && <div className="nw-project-conversations">{tasks.slice(0, limit).map(renderThread)}{tasks.length > limit && <button className="nw-sidebar-show-more" onClick={() => setExpanded(value => ({ ...value, [project.id]: limit + 10 }))}>{t("展开显示", "Show more")}</button>}{!tasks.length && <button className="nw-sidebar-show-more" onClick={() => { setWorkspaceId(project.id); navigate(); router.push("/workbench"); }}>{t("开始新对话", "Start a conversation")}</button>}</div>}</div>;
      })}{!workspaces.length && <p className="nw-section-empty">{t("连接后显示项目", "Projects appear when connected")}</p>}</div>}
    </section>
    {group("recent", prefs.grouping === "list" ? t("全部对话", "All conversations") : t("最近", "Recent"), recent)}
    {!threadIndexComplete && <p className="nw-section-empty" role="status">{t("正在读取更多任务…", "Loading more tasks…")}</p>}
    <Link className="nw-sidebar-history" href="/workbench/history" onClick={navigate}>{t("查看全部任务与归档", "All tasks and archives")}<ArrowUpRight size={13} /></Link>
  </div>
    {menu && <div className="nw-sidebar-menu" ref={menuRef} role="menu" aria-label={t("侧栏操作", "Sidebar actions")} style={{ left: menu.x, top: menu.y }} onKeyDown={event => {
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length; buttons[next]?.focus(); }
      if (event.key === "Tab") closeMenu();
    }}>
      {menu.kind === "organize" && <><p>{t("整理侧栏", "Organize sidebar")}</p>{(["project", "list"] as const).map(value => <button role="menuitemradio" aria-checked={prefs.grouping === value} key={value} onClick={() => { update(current => ({ ...current, grouping: value })); closeMenu(); }}><span>{value === "project" ? t("按项目分组", "Group by project") : t("在一个列表中", "Use one list")}</span>{prefs.grouping === value && <Check size={15} />}</button>)}<hr /><p>{t("对话排序", "Sort conversations")}</p>{(["updated", "created"] as const).map(value => <button role="menuitemradio" aria-checked={prefs.sort === value} key={value} onClick={() => { update(current => ({ ...current, sort: value })); closeMenu(); }}><span>{value === "updated" ? t("最近更新", "Last updated") : t("创建时间", "Date created")}</span>{prefs.sort === value && <Check size={15} />}</button>)}<hr /><button role="menuitem" onClick={() => { closeMenu(); setTitle(""); setSectionDialog({}); }}><Plus size={15} />{t("新建分区", "New section")}</button></>}
      {menu.kind === "thread" && menuThread && <><button role="menuitem" onClick={() => { setTitle(menuThread.title); setRenaming(menuThread); closeMenu(); }}><Pencil size={15} />{t("重命名", "Rename")}</button><button role="menuitem" onClick={() => move(menuThread.id, prefs.pinned.includes(menuThread.id) ? null : "pinned")}>{prefs.pinned.includes(menuThread.id) ? <PinOff size={15} /> : <Pin size={15} />}{prefs.pinned.includes(menuThread.id) ? t("取消置顶", "Unpin") : t("置顶任务", "Pin task")}</button><button role="menuitem" disabled={pending || Boolean(menuThread.activeTurn)} onClick={() => void action("thread/archive", menuThread, { id: menuThread.id })}><Archive size={15} />{t("归档任务", "Archive task")}</button><button role="menuitem" disabled={pending || Boolean(menuThread.activeTurn)} onClick={() => void action("thread/fork", menuThread, { threadId: menuThread.id, idempotencyKey: crypto.randomUUID() })}><GitBranch size={15} />{t("分叉任务", "Fork task")}</button><hr /><p>{t("移到分区", "Move to section")}</p><button role="menuitem" onClick={() => move(menuThread.id, null)}>{t("默认位置", "Default location")}</button>{prefs.sections.map(section => <button role="menuitemradio" aria-checked={section.threadIds.includes(menuThread.id)} key={section.id} onClick={() => move(menuThread.id, section.id)}><span>{section.title}</span>{section.threadIds.includes(menuThread.id) && <Check size={14} />}</button>)}<button role="menuitem" onClick={() => { setTitle(""); setSectionDialog({ threadId: menuThread.id }); closeMenu(); }}><Plus size={15} />{t("新建分区", "New section")}</button></>}
      {menu.kind === "project" && menuProject && <><button role="menuitem" onClick={() => { setWorkspaceId(menuProject.id); closeMenu(); navigate(); router.push("/workbench"); }}><Plus size={15} />{t("在项目中新建对话", "New conversation in project")}</button><button role="menuitem" onClick={() => { setWorkspaceId(menuProject.id); closeMenu(); navigate(); router.push(`/workbench/project/${encodeURIComponent(menuProject.id)}`); }}><FolderOpen size={15} />{t("查看项目文件", "Browse project files")}</button><button role="menuitem" onClick={() => { setEditingProject(menuProject); closeMenu(); }}><Pencil size={15} />{t("编辑项目", "Edit project")}</button></>}
      {menu.kind === "section" && menuSection && <><button role="menuitem" onClick={() => { setTitle(menuSection.title); setSectionDialog({ id: menuSection.id }); closeMenu(); }}><Pencil size={15} />{t("重命名分区", "Rename section")}</button>{([-1, 1] as const).map(direction => <button role="menuitem" key={direction} disabled={direction < 0 ? prefs.sections[0].id === menuSection.id : prefs.sections.at(-1)?.id === menuSection.id} onClick={() => { update(current => { const sections = [...current.sections], index = sections.findIndex(section => section.id === menuSection.id), next = index + direction; if (index < 0 || next < 0 || next >= sections.length) return current; [sections[index], sections[next]] = [sections[next], sections[index]]; return { ...current, sections }; }); closeMenu(); }}>{direction < 0 ? <ArrowUp size={15} /> : <ArrowDown size={15} />}{direction < 0 ? t("上移分区", "Move section up") : t("下移分区", "Move section down")}</button>)}<hr /><button role="menuitem" onClick={() => { update(current => ({ ...current, sections: current.sections.filter(section => section.id !== menuSection.id) })); setNotice(t("分区已移除，任务已回到默认位置。", "Section removed. Its tasks are back in their default location.")); closeMenu(); }}><Trash2 size={15} />{t("移除分区", "Remove section")}</button></>}
    </div>}
    {editingProject && <ProjectDialog project={editingProject} close={() => setEditingProject(undefined)} />}
    {renaming && <Modal title={t("重命名任务", "Rename task")} close={() => setRenaming(undefined)}><form onSubmit={event => { event.preventDefault(); if (title.trim()) void action("thread/update", renaming, { id: renaming.id, title: title.trim(), expectedRevision: renaming.revision }); }}><label className="nw-field">{t("任务名称", "Task name")}<input autoFocus required value={title} onChange={event => setTitle(event.target.value)} /></label><div className="nw-dialog-actions"><button className="nw-button" type="button" onClick={() => setRenaming(undefined)}>{t("取消", "Cancel")}</button><button className="nw-button nw-button-primary" disabled={pending || !title.trim()}>{t("保存", "Save")}</button></div></form></Modal>}
    {sectionDialog && <Modal title={sectionDialog.id ? t("重命名分区", "Rename section") : t("新建分区", "New section")} close={() => setSectionDialog(undefined)}><form onSubmit={event => { event.preventDefault(); if (!title.trim()) return; const id = sectionDialog.id ?? crypto.randomUUID(); update(current => { const next = { ...current, sections: sectionDialog.id ? current.sections.map(section => section.id === id ? { ...section, title: title.trim() } : section) : [...current.sections, { id, title: title.trim(), threadIds: [] }] }; return sectionDialog.threadId ? organizeThread(next, sectionDialog.threadId, id) : next; }); setSectionDialog(undefined); }}><label className="nw-field">{t("分区名称", "Section name")}<input autoFocus required maxLength={80} value={title} onChange={event => setTitle(event.target.value)} /></label><p className="nw-help">{t("在此设备上整理任务，任务所属项目保持不变。", "Organize tasks on this device while keeping their project association.")}</p><div className="nw-dialog-actions"><button className="nw-button" type="button" onClick={() => setSectionDialog(undefined)}>{t("取消", "Cancel")}</button><button className="nw-button nw-button-primary" disabled={!title.trim()}>{t("保存分区", "Save section")}</button></div></form></Modal>}
  </>;
}
