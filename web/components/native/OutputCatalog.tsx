"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Film, FileText, Loader2, RotateCcw, Search } from "lucide-react";
import { displayTime, type Artifact, type Workspace } from "@/lib/native-workbench-state";
import { clampWindowStart } from "@/lib/output-catalog-window";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import './output-catalog.css';

const MEDIA_ARTIFACT_TYPE = "application/vnd.knorvia.media+json";
const PAGE_SIZE = 50;
// CODEX-0215-B01: the DOM stays bounded by rendering a WINDOW of the loaded
// rows, never by discarding results — every loaded row stays reachable
// through the window controls and the full result set stays loadable.
const RENDER_WINDOW = 400;

type CatalogResponse = {
  artifacts: Artifact[];
  nextCursor: string | null;
  skippedUnreadable: number;
  totalMatching: number;
};

type Attempt = {
  mode: "reset" | "next";
  appliedSearch: string;
  workspaceFilter: string;
  typeFilter: string;
  cursor: string | null;
};

export { clampWindowStart } from "@/lib/output-catalog-window";

/**
 * P02 global output catalog: one `artifact/catalog` RPC per page regardless
 * of workspace count, server-side filters, keyset pagination, and per-query
 * failure isolation. A failed page keeps healthy rows visible with an
 * explicit retry that replays the FAILED request's mode and arguments;
 * stale responses from superseded queries are discarded by generation.
 */
export function OutputCatalog({ workspaces, selectedId, pending, enabled, refreshSignal, onSelect, onCountChange }: {
  workspaces: Workspace[];
  selectedId?: string;
  pending: boolean;
  enabled: boolean;
  refreshSignal: number;
  onSelect: (artifact: Artifact) => void;
  onCountChange: (total: number) => void;
}) {
  const { t, locale, request } = useWorkbench();
  const [rows, setRows] = useState<Artifact[]>([]);
  const [windowStart, setWindowStart] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [totalMatching, setTotalMatching] = useState<number | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [initialLoading, setInitialLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [typeOptions, setTypeOptions] = useState<string[]>([]);
  const generationRef = useRef(0);
  const failedAttemptRef = useRef<Attempt | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setAppliedSearch(searchText.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    if (!enabled || workspaces.length === 0) {
      generationRef.current += 1;
      setRows([]); setWindowStart(0); setCursor(null); setTotalMatching(null); setSkipped(0);
      setInitialLoading(false); setPageError(null);
      onCountChange(0);
    }
  }, [enabled, workspaces.length, onCountChange]);

  const fetchPage = useCallback(async (mode: "reset" | "next", attemptCursor?: string | null) => {
    if (!enabled || workspaces.length === 0) return;
    const generation = ++generationRef.current;
    if (mode === "reset") setInitialLoading(true); else setPageLoading(true);
    setPageError(null);
    const useCursor = mode === "next" ? (attemptCursor !== undefined ? attemptCursor : cursor) : null;
    try {
      const previous = mode === "next" ? rows : [];
      const page = await request<CatalogResponse>("artifact/catalog", {
        limit: PAGE_SIZE,
        ...(mode === "next" && useCursor ? { cursor: useCursor } : {}),
        ...(workspaceFilter ? { workspaceId: workspaceFilter } : {}),
        ...(appliedSearch ? { query: appliedSearch } : {}),
        ...(typeFilter ? { type: typeFilter } : {}),
      });
      if (generation !== generationRef.current) return; // a newer query superseded this page
      failedAttemptRef.current = null;
      const merged = mode === "next" ? [...previous, ...page.artifacts] : page.artifacts;
      setRows(merged);
      setCursor(page.nextCursor);
      setTotalMatching(page.totalMatching);
      setSkipped(page.skippedUnreadable);
      onCountChange(page.totalMatching);
      if (mode === "next") {
        // Jump the window to the freshly loaded rows so "load more" always
        // visibly progresses through the whole result set.
        setWindowStart(clampWindowStart(Math.floor(previous.length / RENDER_WINDOW) * RENDER_WINDOW, merged.length, RENDER_WINDOW));
      } else {
        setWindowStart(0);
      }
      setTypeOptions(current => {
        const seen = new Set(current);
        for (const artifact of page.artifacts) seen.add(artifact.type);
        return [...seen].sort();
      });
    } catch (error) {
      if (generation === generationRef.current) {
        // Remember exactly what failed so Retry replays the same request.
        failedAttemptRef.current = { mode, appliedSearch, workspaceFilter, typeFilter, cursor: useCursor };
        setPageError(errorText(error));
      }
    } finally {
      if (generation === generationRef.current) {
        setInitialLoading(false);
        setPageLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, workspaces.length, request, cursor, workspaceFilter, appliedSearch, typeFilter, onCountChange]);

  // Query resets key off filter/signal identity only: a "next" page bumps
  // the cursor and re-creates fetchPage, which must not re-reset the list.
  const resetRef = useRef(fetchPage);
  resetRef.current = fetchPage;
  useEffect(() => {
    if (enabled && workspaces.length > 0) void resetRef.current("reset");
  }, [enabled, workspaces.length, appliedSearch, workspaceFilter, typeFilter, refreshSignal]);

  const retryFailed = () => {
    const attempt = failedAttemptRef.current;
    const sameQuery = attempt
      && attempt.appliedSearch === appliedSearch
      && attempt.workspaceFilter === workspaceFilter
      && attempt.typeFilter === typeFilter;
    if (attempt && sameQuery) {
      // Replay the failed request exactly (same mode, same cursor).
      void fetchPage(attempt.mode, attempt.cursor ?? undefined);
    } else {
      // The query changed since the failure: only a reset is meaningful.
      void fetchPage("reset");
    }
  };

  const windowRows = rows.slice(windowStart, windowStart + RENDER_WINDOW);
  const windowEnd = windowStart + windowRows.length;

  return <div>
    <div className="nw-output-catalog-toolbar">
      <label className="nw-output-catalog-search">
        <Search size={14} aria-hidden />
        <input
          type="search"
          value={searchText}
          onChange={event => setSearchText(event.target.value)}
          placeholder={t("搜索资料标题…", "Search library titles…")}
          aria-label={t("搜索资料标题", "Search library titles")}
        />
      </label>
      <select value={workspaceFilter} onChange={event => setWorkspaceFilter(event.target.value)} aria-label={t("按项目筛选", "Filter by project")}>
        <option value="">{t("全部项目", "All projects")}</option>
        {workspaces.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select>
      <select value={typeFilter} onChange={event => setTypeFilter(event.target.value)} aria-label={t("按类型筛选", "Filter by type")}>
        <option value="">{t("全部类型", "All types")}</option>
        {typeOptions.map(type => <option key={type} value={type}>{type === MEDIA_ARTIFACT_TYPE ? t("生成的图片/视频", "Generated media") : type}</option>)}
      </select>
    </div>
    {pageError && <div className="nw-output-catalog-error" role="alert">
      <AlertTriangle size={14} aria-hidden />
      <span>{t("目录加载失败", "Catalog failed to load")}: {pageError}</span>
      <button className="nw-button nw-button-small" disabled={pageLoading} onClick={retryFailed}><RotateCcw size={12} />{t("重试", "Retry")}</button>
    </div>}
    {!skipped ? null : <p className="nw-output-catalog-note" role="status">{t("有 ", "")}{skipped}{t(" 条成果元数据无法读取，已跳过；健康成果不受影响。", " output records were unreadable and skipped; healthy outputs are unaffected.")}</p>}
    {initialLoading ? <div className="nw-output-catalog-status"><Loader2 className="nw-spin" size={18} /></div>
      : rows.length === 0
        ? <div className="nw-empty-panel"><FileText size={28} /><h2>{appliedSearch || workspaceFilter || typeFilter ? t("没有匹配的资料", "No matching items") : t("还没有任务生成的资料", "No saved task content yet")}</h2><p>{appliedSearch || workspaceFilter || typeFilter ? t("换个关键词或清除筛选试试。", "Try another keyword or clear the filters.") : t("任务中保存的内容会出现在这里，也可以到“我的资料”上传文件。", "Content saved from your tasks appears here. You can also upload files in My files.")}</p></div>
        : <ul className="nw-output-list">
          {windowRows.map(artifact => <li key={artifact.id}>
            <button disabled={pending} onClick={() => onSelect(artifact)} className={`nw-output-row ${selectedId === artifact.id ? "is-active" : ""}`}>
              <span className="nw-file-icon">{artifact.type === MEDIA_ARTIFACT_TYPE ? <Film size={20} /> : <FileText size={20} />}</span>
              <span><strong>{artifact.title}</strong><small>{workspaces.find(project => project.id === artifact.workspaceId)?.title ?? artifact.workspaceId} · {artifact.type === MEDIA_ARTIFACT_TYPE ? t("生成的图片/视频", "Generated media") : artifact.type}</small></span>
              <time>{displayTime(artifact.updatedAt, locale)}</time>
            </button>
          </li>)}
        </ul>}
    <div className="nw-output-catalog-status">
      <button className="nw-button nw-button-small" disabled={pageLoading || pending || windowStart <= 0} onClick={() => setWindowStart(start => clampWindowStart(start - RENDER_WINDOW, rows.length, RENDER_WINDOW))} aria-label={t("上一窗口", "Previous window")}>
        <ChevronLeft size={13} />{t("上一页", "Previous")}
      </button>
      {cursor && !pageError && <button className="nw-button nw-button-small" disabled={pageLoading || pending} onClick={() => { void fetchPage("next"); }}>
        {pageLoading ? <Loader2 className="nw-spin" size={13} /> : null}{t("加载更多", "Load more")}
      </button>}
      <button className="nw-button nw-button-small" disabled={pageLoading || pending || windowEnd >= rows.length} onClick={() => setWindowStart(start => clampWindowStart(start + RENDER_WINDOW, rows.length, RENDER_WINDOW))} aria-label={t("下一窗口", "Next window")}>
        {t("下一页", "Next")}<ChevronRight size={13} />
      </button>
      {totalMatching !== null && <small className="nw-muted-label">
        {windowRows.length > 0
          ? <>{t("第", "Showing")} {windowStart + 1}–{windowEnd} {t("项 · 已加载", "of · loaded")} {rows.length} / {totalMatching}</>
          : <>{rows.length} / {totalMatching} {t("项资料", "items")}</>}
      </small>}
    </div>
  </div>;
}
