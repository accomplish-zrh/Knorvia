"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CornerDownLeft, FileCode2, Link2, Loader2, Plus, Search, Square, X } from "lucide-react";
import {
  appendSearchPage,
  searchCoversEverything,
  searchQueryChanged,
  type ProjectSearchCoverage,
  type ProjectSearchMatch,
  type ProjectSearchMode,
  type ProjectScope,
  type SearchQueryKey,
} from "@/lib/native-project-context";
import type { NativeWorkspaceSearchPage } from "@/lib/knorvia-native-types";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";

const DISPLAY_CAP = 300;
const PAGE_SIZE = 60;

type SearchState = {
  rows: ProjectSearchMatch[];
  dropped: number;
  total: number;
  searchId: string;
  cursor: string | null;
  done: boolean;
  limitReached: boolean;
  coverage?: ProjectSearchCoverage;
  cancelled: boolean;
  stopped: boolean;
};

const EMPTY_STATE: SearchState = {
  rows: [], dropped: 0, total: 0, searchId: "", cursor: null,
  done: false, limitReached: false, cancelled: false, stopped: false,
};

/**
 * Project-wide file and content search (P01). The backend serves one bounded
 * page per call, so the component chains pages until done or cancelled; a
 * query/project change invalidates the in-flight chain through a generation
 * counter, so late responses can never land in a newer search.
 */
export function ProjectSearch({ scope, onUseFile, onLocate, onClose }: {
  scope: ProjectScope;
  onUseFile: (path: string) => void;
  onLocate?: (path: string) => void;
  onClose?: () => void;
}) {
  const { t, request } = useWorkbench();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<ProjectSearchMode>("both");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [state, setState] = useState<SearchState>(EMPTY_STATE);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const runKey = useRef<SearchQueryKey | undefined>(undefined);
  const workspaceId = scope.workspaceId, threadId = scope.threadId;

  // A scope switch invalidates whatever is in flight and clears results.
  useEffect(() => {
    generation.current += 1;
    runKey.current = undefined;
    setState(EMPTY_STATE);
    setError("");
    setStarting(false);
  }, [workspaceId, threadId]);

  const stop = useCallback((markCancelled: boolean) => {
    generation.current += 1;
    setStarting(false);
    if (markCancelled) {
      setState(current => current.searchId && !current.done && !current.stopped
        ? { ...current, cancelled: true }
        : current);
    }
  }, []);

  const cancel = useCallback(() => {
    const searchId = state.searchId;
    const wasRunning = !state.done && !state.stopped && !state.cancelled;
    stop(true);
    if (searchId && wasRunning) {
      void request("workspace/files/search/cancel", { searchId }).catch(() => { /* the session also expires on its own */ });
    }
  }, [request, state]);

  const run = useCallback(async () => {
    const query = text.trim();
    if (!query) return;
    const key: SearchQueryKey = { workspaceId, threadId, text: query, mode, caseSensitive };
    const gen = ++generation.current;
    runKey.current = key;
    setError("");
    setState({ ...EMPTY_STATE });
    setStarting(true);
    let current: SearchState = { ...EMPTY_STATE };
    let cursor: string | null = null;
    try {
      // Chain bounded server pages until the traversal finishes, the user
      // replaces/cancels the search, or an error stops the chain.
      for (;;) {
        const params: Record<string, unknown> = { query, mode, caseSensitive, maxResults: PAGE_SIZE };
        if (workspaceId) params.workspaceId = workspaceId;
        if (threadId) params.threadId = threadId;
        if (current.searchId) {
          params.searchId = current.searchId;
          if (cursor !== null) params.cursor = cursor;
        }
        const page = await request<NativeWorkspaceSearchPage>("workspace/files/search", params as never);
        if (generation.current !== gen || searchQueryChanged(runKey.current, key)) return;
        const merged = appendSearchPage(current.rows, page, DISPLAY_CAP);
        current = {
          ...current,
          searchId: page.searchId,
          done: page.page.done,
          limitReached: page.matchedLimitReached,
          cursor: page.page.nextCursor ?? null,
          coverage: page.coverage,
          rows: merged.rows,
          dropped: current.dropped + merged.dropped,
          total: page.matchedTotal,
        };
        setState(current);
        setStarting(false);
        if (page.page.done || page.matchedLimitReached || !page.page.nextCursor) break;
        cursor = page.page.nextCursor;
      }
    } catch (requestError) {
      if (generation.current !== gen) return;
      setError(errorText(requestError));
      setState({ ...current, stopped: true });
    } finally {
      if (generation.current === gen) setStarting(false);
    }
  }, [caseSensitive, mode, text, threadId, workspaceId, request]);

  const running = starting || (!state.done && !state.stopped && !state.cancelled && !state.limitReached && (!!state.searchId || !!state.cursor) && !error);
  const complete = searchCoversEverything(state.done, state.limitReached);
  const scopeLine = t(
    "搜索整个项目 · 不跟随符号链接 · 跳过隐藏与依赖目录 · 遵循根 .gitignore · 大于 1 MiB 的文件只搜路径",
    "Searches the whole project · symlinks are not followed · hidden and dependency directories are skipped · root .gitignore applies · files above 1 MiB are path-only",
  );

  return <section className="nw-project-search" aria-label={t("全项目搜索", "Search the project")}>
    <form className="nw-project-search-bar" onSubmit={event => { event.preventDefault(); if (!running) void run(); }}>
      <Search size={13} />
      <input
        aria-label={t("搜索文件名与内容", "Search file names and content")}
        value={text}
        onChange={event => setText(event.target.value)}
        placeholder={t("在项目中查找文件或文本…", "Find files or text in the project…")}
      />
      <select aria-label={t("搜索范围", "Search scope")} value={mode} onChange={event => setMode(event.target.value as ProjectSearchMode)}>
        <option value="both">{t("路径和内容", "Paths and content")}</option>
        <option value="paths">{t("仅路径", "Paths only")}</option>
        <option value="content">{t("仅内容", "Content only")}</option>
      </select>
      {running
        ? <button type="button" className="nw-button nw-button-small" onClick={cancel}><Square size={12} />{t("停止", "Stop")}</button>
        : <button type="submit" className="nw-button nw-button-small" disabled={!text.trim()}><CornerDownLeft size={12} />{t("搜索", "Search")}</button>}
      {onClose && <button type="button" className="nw-icon" onClick={onClose} aria-label={t("关闭搜索", "Close search")}><X size={14} /></button>}
    </form>
    <p className="nw-project-search-scope">{scopeLine}</p>
    <label className="nw-project-search-case">
      <input type="checkbox" checked={caseSensitive} onChange={event => setCaseSensitive(event.target.checked)} />
      {t("区分大小写", "Case sensitive")}
    </label>
    {error && <div className="nw-project-error" role="alert"><p>{error}</p></div>}
    {state.rows.length > 0 && <div className="nw-project-search-results" role="list">
      {state.rows.map(match => <div key={`${match.path}:${match.line ?? 0}:${match.column ?? 0}`} className="nw-project-search-row" role="listitem">
        {match.kind === "symlink" ? <Link2 size={13} /> : <FileCode2 size={13} />}
        <span className="nw-project-search-path" title={match.path}>{match.path}{match.line ? <span className="nw-project-search-position">:{match.line}</span> : null}</span>
        {match.snippet && <span className="nw-project-search-snippet" title={match.snippet}>{match.snippet}</span>}
        <span className="nw-project-search-actions">
          {onLocate && <button className="nw-icon" onClick={() => onLocate(match.path)} aria-label={t("在文件列表中定位", "Locate in the file list")} title={t("定位", "Locate")}><Search size={13} /></button>}
          <button className="nw-icon" onClick={() => onUseFile(match.path)} aria-label={t("加入任务", "Add to task")} title={t("加入任务", "Add to task")}><Plus size={14} /></button>
        </span>
      </div>)}
    </div>}
    <div className="nw-project-search-status" aria-live="polite">
      {running && <span className="nw-project-search-running"><Loader2 size={12} className="nw-spin" />{t("正在扫描…", "Scanning…")}{state.coverage ? t(`已扫描 ${state.coverage.scannedFiles} 个文件`, `${state.coverage.scannedFiles} files scanned so far`) : ""}</span>}
      {!running && !complete && state.searchId && !error && <span>{t("已停止：以下结果只覆盖已扫描的部分。", "Stopped: these results only cover the scanned part.")}</span>}
      {state.cancelled && <span>{t("已取消：结果只覆盖已扫描的部分。", "Cancelled: results only cover the scanned part.")}</span>}
      {complete && !running && state.total === 0 && <span>{t("没有匹配的结果。", "No matches.")}</span>}
      {complete && state.total > 0 && <span>
        {t(`共 ${state.total} 个命中`, `${state.total} matches`)}
        {state.limitReached ? t("（结果过多，已停止在 2000 条）", " (stopped at the 2000-match limit)") : ""}
        {state.dropped > 0 ? t(`（界面保留前 ${DISPLAY_CAP} 条，其余 ${state.dropped} 条未显示）`, ` (showing the first ${DISPLAY_CAP}; ${state.dropped} more not rendered)`) : ""}
      </span>}
      {state.coverage && complete && state.coverage.unreadable + state.coverage.skippedBinary + state.coverage.skippedLarge > 0 && <span className="nw-project-search-coverage">
        {t(`未读 ${state.coverage.unreadable} · 二进制 ${state.coverage.skippedBinary} · 过大 ${state.coverage.skippedLarge}`, `${state.coverage.unreadable} unreadable · ${state.coverage.skippedBinary} binary · ${state.coverage.skippedLarge} too large`)}
      </span>}
    </div>
  </section>;
}
