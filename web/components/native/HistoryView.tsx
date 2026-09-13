"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CheckSquare, Download, Loader2, Plus, Search, Square, Target, X } from "lucide-react";
import { displayTime, nativeTimestamp, taskStatus, type Thread } from "@/lib/native-workbench-state";
import { useWorkbench } from "./NativeWorkbenchProvider";
import { StatusLabel } from "./WorkbenchShell";
import { HistoryBulkModal } from "./HistoryBulkActions";
import { TaskExportDialog } from "./TaskExportDialog";
import type { BulkThreadAction } from "@/lib/native-history-actions";
import { HistorySavedViews } from "./HistorySavedViews";
import { useHistoryLocation } from "./useHistoryLocation";
import type { HistoryViewConfig, HistoryLocation } from "@/lib/native-history-views";
import "./history-actions.css";
import "./task-export.css";

const DAY_MS = 86_400_000;

function withinDateRange(thread: Thread, range: string): boolean {
  if (range === "anytime") return true;
  const days = range === "7d" ? 7 : 30;
  const updated = nativeTimestamp(thread.updatedAt);
  if (Number.isNaN(updated)) return false;
  return Date.now() - updated <= days * DAY_MS;
}

export function HistoryView() {
  const { t, threads, threadIndexComplete, workspaces, locale, refresh } = useWorkbench();
  const root = useRef<HTMLDivElement>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<BulkThreadAction | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [exporting, setExporting] = useState<Thread | null>(null);
  const navigation = useHistoryLocation(root, bulk !== null, threads);
  const { filter, projectId: projectFilter, dateRange, query, visible, viewId: activeViewId } = navigation.location;
  const urlNote = navigation.note;
  const setFilter = (value: string) => navigation.update({ filter: value as HistoryLocation['filter'] });
  const setProjectFilter = (value: string) => navigation.update({ projectId: value });
  const setDateRange = (value: string) => navigation.update({ dateRange: value as HistoryLocation['dateRange'] });
  const setQuery = (value: string) => navigation.update({ query: value });
  const setVisible = (value: number | ((previous: number) => number)) => navigation.update({ visible: typeof value === 'function' ? value(visible) : value });
  const projectNames = useMemo(() => new Map(workspaces.map(project => [project.id, project.title])), [workspaces]);
  const projectMissing = projectFilter !== 'all' && !workspaces.some(project => project.id === projectFilter);
  const applyView = (view: HistoryViewConfig) => navigation.apply(view);
  useEffect(() => { if (!bulkRunning) { setSelected(new Set()); setSelecting(false); } }, [filter, projectFilter, dateRange, query, activeViewId, bulkRunning]);
  const reset = () => navigation.update({ query: '', filter: 'all', projectId: 'all', dateRange: 'anytime', visible: 50, viewId: null });
  const awaiting = threads.filter(thread => thread.status !== "archived" && ["approval", "input"].includes(taskStatus(thread))).length;
  const filtered = useMemo(() => threads.filter(thread =>
    !projectMissing &&
    (filter === "archived" ? thread.status === "archived" : thread.status !== "archived")
    && (filter !== "running" || ["running", "approval", "input"].includes(taskStatus(thread)))
    && (filter !== "attention" || ["approval", "input"].includes(taskStatus(thread)))
    && (filter !== "failed" || taskStatus(thread) === "failed")
    && (projectFilter === "all" || thread.workspaceId === projectFilter)
    && withinDateRange(thread, dateRange)
    && `${thread.title} ${projectNames.get(thread.workspaceId) ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
    [threads, filter, projectFilter, dateRange, query, projectMissing, projectNames]);
  const toggleSelect = (id: string) => {
    if (bulkRunning) return;
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectFiltered = () => {
    if (bulkRunning) return;
    setSelected(new Set(filtered.map(thread => thread.id)));
  };
  const exitSelection = () => { if (bulkRunning) return; setSelecting(false); setSelected(new Set()); };
  return <div ref={root} className="nw-page nw-history">
    <div className="nw-page-heading"><div><h1>{t("所有任务", "All tasks")}</h1>
      <p>{t("每件事都有上下文，随时回来继续。", "Every task keeps its context. Come back whenever you're ready.")}</p>
    </div><div className="nw-history-heading-actions"><Link href="/workbench/goals" className="nw-button"><Target size={15} />{t("目标记录", "Goal history")}</Link>
      <button className="nw-button" aria-pressed={selecting} onClick={() => selecting ? exitSelection() : setSelecting(true)}>
        {selecting ? <Square size={15} /> : <CheckSquare size={15} />}{selecting ? t("退出批量整理", "Exit bulk mode") : t("批量整理", "Bulk organize")}</button>
      <Link href="/workbench" className="nw-button nw-button-primary"><Plus size={15} />{t("新任务", "New task")}</Link></div></div>
    <div className="nw-filter-bar">
      <div className="nw-tabs" aria-label={t("任务分类", "Task categories")}>{[["all", t("全部", "All")], ["running", t("进行中", "Active")], ["attention", t("需要处理", "Needs you")], ["failed", t("失败", "Failed")], ["archived", t("已归档", "Archived")]].map(([key, label]) =>
        <button key={key} disabled={bulk !== null} aria-pressed={filter === key} className={filter === key ? "is-active" : ""} onClick={() => { setFilter(key); setVisible(50); }}>{label}{key === "attention" && awaiting > 0 && <span className="nw-count">{awaiting}</span>}</button>)}</div>
      <select aria-label={t("按项目筛选", "Filter by project")} value={projectFilter} disabled={bulk !== null} onChange={event => { setProjectFilter(event.target.value); setVisible(50); }}>
        <option value="all">{t("全部项目", "All projects")}</option>
        {projectMissing && <option value={projectFilter} disabled>{t("项目已不可用", "Project unavailable")}</option>}
        {workspaces.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select>
      <select aria-label={t("按日期筛选", "Filter by date")} value={dateRange} disabled={bulk !== null} onChange={event => { setDateRange(event.target.value); setVisible(50); }}>
        <option value="anytime">{t("任何时间", "Anytime")}</option>
        <option value="7d">{t("最近 7 天", "Last 7 days")}</option>
        <option value="30d">{t("最近 30 天", "Last 30 days")}</option>
      </select>
      <HistorySavedViews activeViewId={activeViewId} onApply={applyView} onActiveDeleted={() => navigation.update({ viewId: null })} disabled={bulk !== null} filter={filter} projectId={projectFilter} dateRange={dateRange} query={query} visible={visible} />
      <div className="nw-inline-search"><Search size={16} /><input aria-label={t("查找任务或项目", "Find a task or project")} value={query} maxLength={200} disabled={bulk !== null} onChange={event => { setQuery(event.target.value); setVisible(50); }} placeholder={t("查找任务或项目", "Find a task or project")} />{query && <button className="nw-icon" aria-label={t("清空搜索", "Clear search")} disabled={bulk !== null} onClick={() => { setQuery(""); setVisible(50); }}><X size={14} /></button>}</div>
    </div>
    {urlNote === "url-missing" && <p className="nw-help" role="status">{t("链接里的视图不存在或已被删除，已显示最近的浏览状态。", "The view in this link no longer exists; showing your last browsing state instead.")}</p>}
    {urlNote === "url-invalid" && <p className="nw-help" role="status">{t("链接中的视图参数无效，已恢复最近的浏览状态。", "The view parameter is invalid; your last browsing state was restored.")}</p>}
    {urlNote === "bulk-deferred" && <p className="nw-help" role="status">{t("批量操作结束后再切换浏览位置。", "The requested history navigation will apply after the bulk operation closes.")}</p>}
    {projectMissing && <p className="nw-help" role="status">{t("该视图的项目已不可用，筛选范围已保留，请选择另一个项目。", "This view's project is unavailable. Its scope is kept; choose another project.")}</p>}
    {selecting && <div className="hw-bulk-toolbar" role="toolbar" aria-label={t("批量整理", "Bulk organize")}>
      <span className="hw-count-selected">{t(`已选 ${selected.size} 项`, `${selected.size} selected`)}</span>
      <button className="nw-button" disabled={bulkRunning || filtered.length === 0} onClick={selectFiltered}>{t("选择当前筛选结果", "Select filtered")}</button>
      <button className="nw-button" disabled={bulkRunning || selected.size === 0} onClick={() => setSelected(new Set())}>{t("清空选择", "Clear")}</button>
      <button className="nw-button" disabled={bulkRunning || selected.size === 0} onClick={() => setBulk("archive")}>{t("归档所选…", "Archive selected…")}</button>
      <button className="nw-button" disabled={bulkRunning || selected.size === 0} onClick={() => setBulk("restore")}>{t("恢复所选…", "Restore selected…")}</button>
      {bulkRunning && <span role="status"><Loader2 size={14} className="nw-spin" /> {t("批量操作进行中，选择已锁定", "Bulk run in progress; selection is locked")}</span>}
    </div>}
    <div className="nw-results-caption" role="status"><span>{t(`${filtered.length}${threadIndexComplete ? "" : "+"} 个任务`, `${filtered.length}${threadIndexComplete ? "" : "+"} tasks`)}</span><span>{t("最近更新", "Recently updated")}</span></div>
    {!threadIndexComplete && <p className="nw-help" role="status"><Loader2 size={14} className="nw-spin" /> {t("正在读取更多任务，搜索结果还会继续补全…", "Loading more tasks; search results are still being completed…")}</p>}
    <div className="nw-task-rows">{filtered.slice(0, visible).map(thread =>
      <div className="nw-task-row" data-history-thread={thread.id} key={thread.id}>
        {selecting && <label className="hw-bulk-check">
          <input type="checkbox" aria-label={t(`选择 ${thread.title}`, `Select ${thread.title}`)} checked={selected.has(thread.id)} disabled={bulkRunning} onChange={() => toggleSelect(thread.id)} />
        </label>}
        <Link className="nw-task-row-link" onClickCapture={navigation.savePosition} href={`/workbench/task/${encodeURIComponent(thread.id)}`}>
          <div><strong>{thread.title}</strong><span>{projectNames.get(thread.workspaceId)}</span></div>
          <StatusLabel status={taskStatus(thread)} /><time>{displayTime(thread.updatedAt, locale)}</time><ArrowRight size={15} />
        </Link>
        {!selecting && <button className="ht-export-open" aria-label={t(`导出 ${thread.title}`, `Export ${thread.title}`)} title={t("离线导出", "Offline export")} onClick={event => { event.preventDefault(); setExporting(thread); }}>
          <Download size={14} />
        </button>}
      </div>)}</div>
    {filtered.length > visible && <button className="nw-button nw-more-tasks" onClick={() => setVisible(count => count + 50)}>{t("显示更多任务", "Show more tasks")}<span>{Math.min(50, filtered.length - visible)}</span></button>}
    {filtered.length === 0 && threadIndexComplete && <div className="nw-empty-panel"><Search size={24} />
      <h2>{query.trim() ? t("没有匹配的任务", "No matching tasks") : filter === "attention" ? t("暂时没有需要你处理的事", "Nothing needs your attention") : filter === "running" ? t("暂时没有进行中的任务", "No active tasks right now") : filter === "archived" ? t("还没有归档任务", "No archived tasks yet") : t("从一件小事开始", "Start with something small")}</h2>
      <p>{query.trim() ? t("试试其他关键词，或切换任务分类。", "Try another search or task category.") : filter === "attention" ? t("任务需要确认或补充信息时，会出现在这里。", "Tasks appear here when they need your approval or input.") : t("过程、文件和结果会保留在任务里，随时回来继续。", "Your work, files, and results stay together, ready when you return.")}</p>
      {query.trim() || filter !== "all" ? <button className="nw-button" onClick={reset}>{t("查看全部任务", "View all tasks")}</button> : <Link href="/workbench" className="nw-button nw-button-primary"><Plus size={15} />{t("开始新任务", "Start a task")}</Link>}
    </div>}
    {bulk && <HistoryBulkModal threads={threads} selectedIds={selected} action={bulk}
      close={() => setBulk(null)} onChanged={() => void refresh().catch(() => {})} onRunningChange={setBulkRunning} />}
    {exporting && <TaskExportDialog thread={exporting} close={() => setExporting(null)} />}
  </div>;
}
