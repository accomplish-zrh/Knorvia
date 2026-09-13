"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, BarChart3, Code2, FileText, FolderOpen, Pencil, Plus } from "lucide-react";
import { displayTime, taskStatus, type Workspace } from "@/lib/native-workbench-state";
import { useWorkbench } from "./NativeWorkbenchProvider";
import { TaskComposer } from "./TaskComposer";
import { TaskView } from "./TaskView";
import { ProjectDialog, StatusLabel } from "./WorkbenchShell";
import { UnifiedLibraryView } from "./UnifiedLibraryView";
import { ExtensionsView } from "./WorkspaceSettings";
import { ProjectView } from "./ProjectExplorer";
import { AutomationsView } from "./AutomationsView";
import { GoalsView } from "./GoalsView";
import { HistoryView } from "./HistoryView";
import { BotsView } from "./BotsView";
import { readCanvasHandoff, keepCanvasHandoff, type CanvasHandoff } from '@/lib/native-canvas-recovery';
import { saveTaskView } from '@/lib/native-task-view';
import { openPanelTab } from '@/lib/native-panel';
import { readProjectContextFiles, removeProjectContextFiles } from '@/lib/native-project-context';
import { MemoryView } from "./MemoryView";

function HomeView() {
  const { t, threads, workspaces, workspaceId, locale, newTask } = useWorkbench();
  const [suggestion, setSuggestion] = useState("");
  const [canvas, setCanvas] = useState<CanvasHandoff>();
  // B04: the new-task view shows the structured per-project file context the
  // project explorer collects. Same chips and cleanup rules as a task page.
  const [contextFiles, setContextFiles] = useState<string[]>([]);
  useEffect(() => { setContextFiles(readProjectContextFiles(workspaceId)); }, [workspaceId]);
  useEffect(() => { let disposed = false; void Promise.resolve().then(() => { if (!disposed) setCanvas(readCanvasHandoff()); }); return () => { disposed = true; }; }, []);
  const clearCanvas = (text: string) => { setCanvas(current => current?.text === text ? undefined : current); if (readCanvasHandoff()?.text === text) keepCanvasHandoff(); };
  const recent = threads.filter(thread => thread.workspaceId === workspaceId && thread.status !== "archived").slice(0, 4);
  const prompts = [
    { label: t("整理资料", "Explore files"), icon: FolderOpen, text: t("阅读这个项目的资料，整理关键结论、待解决的问题和下一步建议。", "Read the files in this project and organize the key findings, open questions, and next steps.") },
    { label: t("制作报告", "Write a report"), icon: FileText, text: t("帮我制作一份清晰、有依据的报告。先了解项目中的资料，再确定需要补充的信息。", "Help me write a clear, evidence-based report. Start by reading the project files and identifying any missing information.") },
    { label: t("构建应用", "Build something"), icon: Code2, text: t("检查这个项目，了解当前实现，找到最值得改进的功能并完成它。", "Inspect this project, understand the implementation, then find and complete a useful improvement.") },
    { label: t("分析数据", "Analyze data"), icon: BarChart3, text: t("分析项目里的数据，检查质量，找出重要趋势，并把结果整理成易读的结论。", "Analyze the data in this project, check its quality, identify important trends, and explain the findings clearly.") },
  ];
  return <div className="nw-home"><div className="nw-home-hero">
    <header className="nw-welcome-heading">
      <div className="nw-luminous-emblem" aria-hidden="true" />
      <h1><span className="nw-minimal-title">{t("今天，想做些什么？", "What would you like to do?")}</span><span className="nw-luminous-title">{t("把想象，变成你的作品。", "Make something of your ideas.")}</span></h1>
      <p className="nw-luminous-intro">{t("从一个想法开始，让 Knorvia 帮你推进。", "Start with an idea. Let Knorvia help you take it further.")}</p>
    </header>
    <TaskComposer canvasContext={canvas?.text} onCanvasContextUsed={clearCanvas} suggestion={suggestion} onSuggestionUsed={() => setSuggestion("")} contextFiles={contextFiles} onRemoveContextFile={path => { removeProjectContextFiles(workspaceId, [path]); setContextFiles(current => current.filter(value => value !== path)); }} onContextFilesUsed={paths => { removeProjectContextFiles(workspaceId, paths); setContextFiles(readProjectContextFiles(workspaceId)); }} onCreate={async (text, options) => { const id = await newTask(text, options); if (canvas) saveTaskView(id, { panel: { open: true, content: openPanelTab({ tabs: [], active: null }, { kind: 'canvas', id: canvas.id }) } }); return id; }} onThreadOpened={id => { if (canvas) saveTaskView(id, { panel: { open: true, content: openPanelTab({ tabs: [], active: null }, { kind: 'canvas', id: canvas.id }) } }); }} />
    <div className="nw-starters" role="group" aria-label={t("快速开始", "Quick start")}>{prompts.map(prompt => <button key={prompt.label} onClick={() => setSuggestion(prompt.text)}><prompt.icon size={16} strokeWidth={1.6} /><span>{prompt.label}</span></button>)}</div></div>
    {recent.length > 0 && <section className="nw-home-recents"><div className="nw-list-heading"><h2>{t("继续推进", "Pick up where you left off")}</h2><Link href="/workbench/history">{t("全部任务", "All tasks")}<ArrowRight size={13} /></Link></div><div className="nw-task-rows">{recent.map(thread => <Link className="nw-task-row" key={thread.id} href={`/workbench/task/${encodeURIComponent(thread.id)}`}><div><strong>{thread.title}</strong><span>{workspaces.find(project => project.id === thread.workspaceId)?.title}</span></div><StatusLabel status={taskStatus(thread)} /><time>{displayTime(thread.updatedAt, locale)}</time><ArrowRight size={15} /></Link>)}</div></section>}
  </div>;
}


function ProjectsView() {
  const { t, workspaces, threads, threadIndexComplete, setWorkspaceId } = useWorkbench();
  const [dialog, setDialog] = useState(false);
  const [editing, setEditing] = useState<Workspace>();
  return <div className="nw-page"><div className="nw-page-heading"><div><h1>{t("项目", "Projects")}</h1><p>{t("围绕一件长期的事，组织文件与任务。", "Keep the files and tasks for your ongoing work together.")}</p></div><button className="nw-button nw-button-primary" onClick={() => setDialog(true)}><Plus size={15} />{t("新建项目", "New project")}</button></div><div className="nw-project-cards">{workspaces.map(project => <div className="nw-project-card-wrap" key={project.id}><Link href={`/workbench/project/${encodeURIComponent(project.id)}`} onClick={() => setWorkspaceId(project.id)} className="nw-project-card"><FolderOpen size={23} /><h2>{project.title}</h2><p>{project.cwd || t("独立工作空间", "A dedicated workspace")}</p><footer><span>{threads.filter(thread => thread.workspaceId === project.id).length}{threadIndexComplete ? "" : "+"} {t("个任务", "tasks")}</span><ArrowRight size={15} /></footer></Link><button className="nw-icon nw-project-edit" aria-label={`${t("编辑项目", "Edit project")}: ${project.title}`} onClick={() => setEditing(project)}><Pencil size={14} /></button></div>)}</div>{dialog && <ProjectDialog close={() => setDialog(false)} />}{editing && <ProjectDialog project={editing} close={() => setEditing(undefined)} />}</div>;
}

export function WorkbenchView({ view = [] }: { view?: string[] }) {
  // Use the committed route's props. An optimistic pathname update can precede
  // the catch-all page transition and otherwise mount an empty composer twice.
  const pathname = `/workbench${view.length ? `/${view.map(encodeURIComponent).join("/")}` : ""}`;
  if (pathname.startsWith("/workbench/task/")) return <TaskView key={pathname} id={decodeURIComponent(pathname.slice("/workbench/task/".length))} />;
  if (pathname.startsWith("/workbench/project/")) return <ProjectView key={pathname} id={decodeURIComponent(pathname.slice("/workbench/project/".length))} />;
  if (pathname === "/workbench/bots") return <BotsView />;
  if (pathname === "/workbench/memory") return <MemoryView />;
  if (pathname === "/workbench/automations") return <AutomationsView />;
  if (pathname === "/workbench/goals") return <GoalsView />;
  if (["/workbench/history", "/workbench/activity"].includes(pathname)) return <HistoryView />;
  if (["/workbench/projects", "/workbench/workspaces"].includes(pathname)) return <ProjectsView />;
  if (pathname === "/workbench/artifacts") return <UnifiedLibraryView view="outputs" />;
  if (pathname === "/workbench/packs") return <ExtensionsView />;
  // The persistent layout owns settings so category navigation keeps unsaved fields.
  if (view[0] === "settings") return null;
  return <HomeView />;
}
