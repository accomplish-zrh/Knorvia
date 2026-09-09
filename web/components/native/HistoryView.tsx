"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Loader2, Plus, Search, Target, X } from "lucide-react";
import { displayTime, taskStatus } from "@/lib/native-workbench-state";
import { useWorkbench } from "./NativeWorkbenchProvider";
import { StatusLabel } from "./WorkbenchShell";

export function HistoryView() {
  const { t, threads, threadIndexComplete, workspaces, locale } = useWorkbench();
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(50);
  const projectNames = new Map(workspaces.map(project => [project.id, project.title]));
  const awaiting = threads.filter(thread => thread.status !== "archived" && ["approval", "input"].includes(taskStatus(thread))).length;
  const filtered = threads.filter(thread =>
    (filter === "archived" ? thread.status === "archived" : thread.status !== "archived")
    && (filter !== "running" || ["running", "approval", "input"].includes(taskStatus(thread)))
    && (filter !== "attention" || ["approval", "input"].includes(taskStatus(thread)))
    && `${thread.title} ${projectNames.get(thread.workspaceId) ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const reset = () => { setQuery(""); setFilter("all"); setVisible(50); };
  return <div className="nw-page nw-history">
    <div className="nw-page-heading"><div><h1>{t("所有任务", "All tasks")}</h1>
      <p>{t("每件事都有上下文，随时回来继续。", "Every task keeps its context. Come back whenever you're ready.")}</p>
    </div><div className="nw-history-heading-actions"><Link href="/workbench/goals" className="nw-button"><Target size={15} />{t("目标记录", "Goal history")}</Link><Link href="/workbench" className="nw-button nw-button-primary"><Plus size={15} />{t("新任务", "New task")}</Link></div></div>
    <div className="nw-filter-bar">
      <div className="nw-tabs" aria-label={t("任务分类", "Task categories")}>{[["all", t("全部", "All")], ["running", t("进行中", "Active")], ["attention", t("需要处理", "Needs you")], ["archived", t("已归档", "Archived")]].map(([key, label]) =>
        <button key={key} aria-pressed={filter === key} className={filter === key ? "is-active" : ""} onClick={() => { setFilter(key); setVisible(50); }}>{label}{key === "attention" && awaiting > 0 && <span className="nw-count">{awaiting}</span>}</button>)}</div>
      <div className="nw-inline-search"><Search size={16} /><input aria-label={t("查找任务或项目", "Find a task or project")} value={query} onChange={event => { setQuery(event.target.value); setVisible(50); }} placeholder={t("查找任务或项目", "Find a task or project")} />{query && <button className="nw-icon" aria-label={t("清空搜索", "Clear search")} onClick={() => { setQuery(""); setVisible(50); }}><X size={14} /></button>}</div>
    </div>
    <div className="nw-results-caption" role="status"><span>{t(`${filtered.length}${threadIndexComplete ? "" : "+"} 个任务`, `${filtered.length}${threadIndexComplete ? "" : "+"} tasks`)}</span><span>{t("最近更新", "Recently updated")}</span></div>
    {!threadIndexComplete && <p className="nw-help" role="status"><Loader2 size={14} className="nw-spin" /> {t("正在读取更多任务，搜索结果还会继续补全…", "Loading more tasks; search results are still being completed…")}</p>}
    <div className="nw-task-rows">{filtered.slice(0, visible).map(thread =>
      <Link className="nw-task-row" key={thread.id} href={`/workbench/task/${encodeURIComponent(thread.id)}`}>
        <div><strong>{thread.title}</strong><span>{projectNames.get(thread.workspaceId)}</span></div>
        <StatusLabel status={taskStatus(thread)} /><time>{displayTime(thread.updatedAt, locale)}</time><ArrowRight size={15} />
      </Link>)}</div>
    {filtered.length > visible && <button className="nw-button nw-more-tasks" onClick={() => setVisible(count => count + 50)}>{t("显示更多任务", "Show more tasks")}<span>{Math.min(50, filtered.length - visible)}</span></button>}
    {filtered.length === 0 && threadIndexComplete && <div className="nw-empty-panel"><Search size={24} />
      <h2>{query.trim() ? t("没有匹配的任务", "No matching tasks") : filter === "attention" ? t("暂时没有需要你处理的事", "Nothing needs your attention") : filter === "running" ? t("暂时没有进行中的任务", "No active tasks right now") : filter === "archived" ? t("还没有归档任务", "No archived tasks yet") : t("从一件小事开始", "Start with something small")}</h2>
      <p>{query.trim() ? t("试试其他关键词，或切换任务分类。", "Try another search or task category.") : filter === "attention" ? t("任务需要确认或补充信息时，会出现在这里。", "Tasks appear here when they need your approval or input.") : t("过程、文件和结果会保留在任务里，随时回来继续。", "Your work, files, and results stay together, ready when you return.")}</p>
      {query.trim() || filter !== "all" ? <button className="nw-button" onClick={reset}>{t("查看全部任务", "View all tasks")}</button> : <Link href="/workbench" className="nw-button nw-button-primary"><Plus size={15} />{t("开始新任务", "Start a task")}</Link>}
    </div>}
  </div>;
}
