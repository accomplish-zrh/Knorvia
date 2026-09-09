"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Check, ChevronRight, File, FileCode2, Folder, FolderGit2, FolderOpen, GitBranch, GitCompareArrows, Link2, Loader2, Plus, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { appendFileReferences, fileSize, parseUnifiedDiff, type DirectoryPage, type GitDiff, type GitFile, type GitStatus, type ProjectFile, type ProjectScope } from "@/lib/native-project-context";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { WorktreeManager } from "./WorktreeManager";

type Mode = "files" | "changes";
type Selection = { path: string; staged: boolean };

function InlineFailure({ error, retry }: { error: string; retry?: () => void }) {
  const { t } = useWorkbench();
  return <div className="nw-project-error" role="alert"><p>{error}</p>{retry && <button className="nw-button nw-button-small" onClick={retry}><RefreshCw size={13} />{t("重试", "Retry")}</button>}</div>;
}

export function DiffPreview({ value }: { value: GitDiff }) {
  const { t } = useWorkbench();
  const lines = useMemo(() => parseUnifiedDiff(value.diff), [value.diff]);
  const adds = lines.filter(line => line.kind === "add").length;
  const removes = lines.filter(line => line.kind === "remove").length;
  if (value.binary) return <div className="nw-file-empty"><File size={25} /><strong>{t("二进制文件已更改", "Binary file changed")}</strong><p>{t("此文件无法显示文本差异。可在文件视图中定位原文件。", "A text diff is unavailable. Locate the file in the Files view.")}</p></div>;
  if (!value.diff) return <div className="nw-file-empty"><Check size={23} /><strong>{t("没有可显示的文本改动", "No text changes to display")}</strong></div>;
  return <><div className="nw-diff-summary"><span>{t("统一视图", "Unified view")}</span><span className="nw-diff-add-count">+{adds}</span><span className="nw-diff-remove-count">−{removes}</span></div><div className="nw-diff-code" aria-label={t("文件改动", "File diff")}>{lines.map((line, index) => <div key={index} className={`nw-diff-line nw-diff-${line.kind}`}><span className="nw-line-number">{line.before ?? ""}</span><span className="nw-line-number">{line.after ?? ""}</span><span className="nw-diff-sign">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}</span><code>{line.text || " "}</code></div>)}</div>{value.truncated && <p className="nw-file-limit">{t("改动较大，当前显示部分内容。请在本地查看完整文件。", "This diff is large. Open the local file to inspect it in full.")}</p>}</>;
}

export function ProjectExplorer({ scope, mode, onModeChange, onClose, onUseFile, compact = false, initialFile = "", initialFolder = "", selectionVersion = 0, onPreviewFile, onFolderChange }: {
  scope: ProjectScope; mode: Mode; onModeChange: (mode: Mode) => void; onClose?: () => void; onUseFile: (path: string) => void; compact?: boolean; initialFile?: string; initialFolder?: string; selectionVersion?: number; onPreviewFile?: (path: string) => void; onFolderChange?: (path: string) => void;
}) {
  const { t, request, connection, newTask, setError } = useWorkbench();
  const [directory, setDirectory] = useState<DirectoryPage>();
  const [folder, setFolder] = useState(initialFolder);
  const chooseFolder = (path: string) => { setFolder(path); onFolderChange?.(path); };
  const [file, setFile] = useState<ProjectFile>();
  const [selectedFile, setSelectedFile] = useState(initialFile);
  const [git, setGit] = useState<GitStatus>();
  const [diff, setDiff] = useState<GitDiff>();
  const [selection, setSelection] = useState<Selection>();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setLocalError] = useState("");
  const [readError, setReadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [capabilities, setCapabilities] = useState({ openPath: false, revealPath: false });
  const readGeneration = useRef(0);
  const workspaceId = scope.workspaceId, threadId = scope.threadId;
  const params = useMemo(() => ({ ...(workspaceId ? { workspaceId } : {}), ...(threadId ? { threadId } : {}) }), [workspaceId, threadId]);

  useEffect(() => { setSelectedFile(initialFile); setFolder(initialFolder); setQuery(""); }, [initialFile, initialFolder, selectionVersion]);

  useEffect(() => {
    if (connection !== "connected") return;
    let cancelled = false;
    void request<{ capabilities?: typeof capabilities }>("connection/read").then(value => { if (!cancelled && value.capabilities) setCapabilities(value.capabilities); }).catch(() => { /* older or browser runtimes can still read project files */ });
    return () => { cancelled = true; };
  }, [connection, request]);

  useEffect(() => {
    if (connection !== "connected") return;
    let cancelled = false;
    setLoading(true); setLocalError("");
    const load = mode === "files"
      ? request<DirectoryPage>("workspace/files/list", { ...params, path: folder, limit: 200 }).then(value => { if (!cancelled) setDirectory(value); })
      : request<GitStatus>("workspace/git/status", params).then(value => { if (!cancelled) setGit(value); });
    void load.catch(error => { if (!cancelled) setLocalError(errorText(error)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [connection, folder, mode, params, request, revision]);

  useEffect(() => {
    if (connection !== "connected" || (mode === "files" ? !selectedFile : !selection)) return;
    const generation = ++readGeneration.current;
    let cancelled = false;
    setReading(true); setReadError("");
    if (mode === "files") setFile(undefined); else setDiff(undefined);
    const operation = mode === "files"
      ? request<ProjectFile>("workspace/files/read", { ...params, path: selectedFile, maxBytes: 128 * 1024 }).then(value => { if (!cancelled && generation === readGeneration.current) setFile(value); })
      : request<GitDiff>("workspace/git/diff", { ...params, ...selection, maxBytes: 192 * 1024 }).then(value => { if (!cancelled && generation === readGeneration.current) setDiff(value); });
    void operation.catch(error => { if (!cancelled && generation === readGeneration.current) setReadError(errorText(error)); }).finally(() => { if (!cancelled && generation === readGeneration.current) setReading(false); });
    return () => { cancelled = true; };
  }, [connection, mode, params, request, selectedFile, selection, revision]);

  const loadMore = async () => {
    if (!directory?.nextCursor || more) return;
    setMore(true);
    try {
      const next = await request<DirectoryPage>("workspace/files/list", { ...params, path: folder, cursor: directory.nextCursor, limit: 200 });
      setDirectory(current => current?.path === next.path ? { ...next, entries: [...new Map([...current.entries, ...next.entries].map(entry => [entry.path, entry])).values()] } : current);
    } catch (error) { setLocalError(errorText(error)); } finally { setMore(false); }
  };
  const reveal = async (path: string, open: boolean) => {
    try { await request(open ? "desktop/open-path" : "desktop/reveal-path", { ...params, path }); }
    catch (error) { setReadError(errorText(error)); }
  };
  const review = async () => {
    if (reviewing || !git) return;
    setReviewing(true);
    try {
      await newTask(t("请审阅当前项目中尚未提交的改动。阅读相关文件和差异，重点检查真实缺陷、行为回归及缺少的验证，按严重程度给出有文件位置依据的结论。请保持只读。", "Review the uncommitted changes in this project. Read the related files and diffs, find concrete bugs, behavior regressions, and missing validation, and report findings by severity with file locations. Keep this review read-only."), { workspaceId: git.workspace.id, cwd: git.workspace.cwd, write: false });
    } catch (error) { setError(errorText(error)); } finally { setReviewing(false); }
  };
  const changeGroups: { label: string; entries: GitFile[]; staged: boolean }[] = git ? [
    { label: t("冲突", "Conflicts"), entries: git.conflicts, staged: false },
    { label: t("未暂存", "Unstaged"), entries: git.unstaged.filter(entry => !git.conflicts.some(conflict => conflict.path === entry.path)), staged: false },
    { label: t("已暂存", "Staged"), entries: git.staged.filter(entry => !git.conflicts.some(conflict => conflict.path === entry.path)), staged: true },
    { label: t("新文件", "Untracked"), entries: git.untracked, staged: false },
  ] : [];
  const currentPath = mode === "files" ? selectedFile : selection?.path;
  const crumbs = folder.split("/").filter(Boolean);
  const entries = directory?.entries.filter(entry => entry.name.toLowerCase().includes(query.toLowerCase())) ?? [];

  return <section className={`nw-explorer ${compact ? "is-compact" : ""} ${onPreviewFile && mode === "files" ? "is-picker" : ""}`} aria-label={t("项目文件与改动", "Project files and changes")}>
    <div className="nw-explorer-heading"><div className="nw-tabs"><button className={mode === "files" ? "is-active" : ""} onClick={() => onModeChange("files")}><FolderOpen size={14} />{t("文件", "Files")}</button><button className={mode === "changes" ? "is-active" : ""} onClick={() => onModeChange("changes")}><GitCompareArrows size={14} />{t("改动", "Changes")}</button></div><div><button className="nw-icon" onClick={() => setRevision(value => value + 1)} aria-label={t("刷新项目内容", "Refresh project contents")}><RefreshCw size={15} /></button>{onClose && <button className="nw-icon" onClick={onClose} aria-label={t("关闭项目面板", "Close project panel")}><X size={16} /></button>}</div></div>
    {error ? <InlineFailure error={error} retry={() => setRevision(value => value + 1)} /> : loading ? <div className="nw-file-empty"><Loader2 size={20} className="nw-spin" /><span>{t("正在读取项目…", "Reading project…")}</span></div> : mode === "changes" && !git?.available ? <div className="nw-file-empty"><FolderOpen size={26} /><strong>{t("这个文件夹未使用 Git", "This folder does not use Git")}</strong><p>{t("你仍然可以查看文件并在项目中开展任务。", "You can still explore its files and work on tasks.")}</p><button className="nw-button" onClick={() => onModeChange("files")}>{t("查看文件", "Browse files")}</button></div> : <div className={`nw-explorer-body ${currentPath ? "has-file" : ""}`}>
      <div className="nw-file-list">
        {mode === "files" ? <><div className="nw-file-breadcrumb"><button onClick={() => { chooseFolder(""); setQuery(""); }} aria-label={t("项目根目录", "Project root")}><Folder size={13} /></button>{crumbs.map((part, index) => <span key={index}><ChevronRight size={10} /><button onClick={() => { chooseFolder(crumbs.slice(0, index + 1).join("/")); setQuery(""); }}>{part}</button></span>)}</div><label className="nw-file-search"><Search size={13} /><input aria-label={t("筛选当前文件夹", "Filter this folder")} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("查找文件…", "Find a file…")} /></label>{folder && <button className="nw-file-row nw-file-up" onClick={() => { chooseFolder(crumbs.slice(0, -1).join("/")); setQuery(""); }}><ArrowLeft size={13} /><span>{t("上一级", "Parent folder")}</span></button>}{entries.map(entry => <button key={entry.path} className={`nw-file-row ${selectedFile === entry.path ? "is-active" : ""}`} title={entry.path} onClick={() => { if (entry.kind === "directory") { chooseFolder(entry.path); setQuery(""); } else if (onPreviewFile) onPreviewFile(entry.path); else setSelectedFile(entry.path); }}>{entry.kind === "directory" ? <Folder size={14} /> : entry.kind === "symlink" ? <Link2 size={14} /> : <FileCode2 size={14} />}<span>{entry.name}</span>{entry.kind === "directory" && <ChevronRight size={12} />}</button>)}{!entries.length && <p className="nw-empty-copy">{query ? t("没有匹配的文件", "No matching files") : t("文件夹为空", "This folder is empty")}</p>}{directory?.nextCursor && <button className="nw-load-more" disabled={more} onClick={() => void loadMore()}>{more ? <Loader2 size={13} className="nw-spin" /> : null}{t("加载更多文件", "Load more files")}</button>}</> : <><div className="nw-git-branch"><GitBranch size={14} /><span>{git?.branch || t("分离的 HEAD", "Detached HEAD")}</span></div>{changeGroups.map(group => group.entries.length > 0 && <div className="nw-change-group" key={group.label}><h3>{group.label}<span>{group.entries.length}</span></h3>{group.entries.map(entry => <button key={entry.path} title={entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path} className={`nw-file-row ${selection?.path === entry.path && selection?.staged === group.staged ? "is-active" : ""}`} onClick={() => setSelection({ path: entry.path, staged: group.staged })}><FileCode2 size={14} /><span>{entry.path}</span><code className={`nw-git-status ${entry.status.includes("?") || entry.status.includes("A") ? "is-new" : ""}`}>{entry.status.trim()}</code></button>)}</div>)}{git?.clean && <div className="nw-file-empty nw-clean-state"><Check size={20} /><p>{t("工作目录干净", "Working tree clean")}</p></div>}{git && !git.clean && <button className="nw-review-button" onClick={() => void review()} disabled={reviewing}>{reviewing ? <Loader2 className="nw-spin" size={14} /> : <Sparkles size={14} />}{t("让助手审阅", "Ask for a review")}</button>}</>}
      </div>
      <div className="nw-file-preview">{currentPath ? <><div className="nw-file-toolbar"><button className="nw-icon nw-file-back" onClick={() => mode === "files" ? setSelectedFile("") : setSelection(undefined)} aria-label={t("返回文件列表", "Back to file list")}><ArrowLeft size={14} /></button><span title={currentPath}>{currentPath}</span><div>{mode === "files" && <button className="nw-icon" onClick={() => onUseFile(currentPath)} aria-label={t("加入任务", "Add to task")} title={t("加入任务", "Add to task")}><Plus size={15} /></button>}{capabilities.revealPath && <button className="nw-icon" onClick={() => void reveal(currentPath, false)} aria-label={t("在文件夹中显示", "Show in folder")} title={t("在文件夹中显示", "Show in folder")}><FolderOpen size={15} /></button>}{capabilities.openPath && <button className="nw-icon" onClick={() => void reveal(currentPath, true)} aria-label={t("在本地打开文件", "Open local file")} title={t("在本地打开文件", "Open local file")}><ArrowUpRight size={15} /></button>}</div></div>{readError ? <InlineFailure error={readError} /> : reading ? <div className="nw-file-empty"><Loader2 className="nw-spin" size={20} /></div> : mode === "changes" && diff ? <div className="nw-file-scroll"><DiffPreview value={diff} /></div> : file?.kind === "binary" ? <div className="nw-file-empty"><File size={28} /><strong>{t("此文件需要专用查看器", "This file needs its own viewer")}</strong><p>{fileSize(file.size)} · {t("可把文件路径加入任务，让助手处理。", "Add its path to the task for the agent to work with it.")}</p><button className="nw-button" onClick={() => onUseFile(file.path)}><Plus size={14} />{t("加入任务", "Add to task")}</button></div> : file ? <><div className="nw-file-scroll"><div className="nw-source-code" aria-label={t("文件内容", "File contents")}>{(file.content ?? "").split("\n").map((line, index) => <div key={index}><span className="nw-line-number">{index + 1}</span><code>{line || " "}</code></div>)}</div></div><div className="nw-file-footer"><span>{fileSize(file.size)}</span><span>{file.truncated ? t("显示前一部分内容", "Showing the beginning of the file") : "UTF-8"}</span></div></> : null}</> : <div className="nw-file-empty"><span className="nw-file-empty-icon">{mode === "files" ? <FileCode2 size={25} /> : <GitCompareArrows size={25} />}</span><strong>{mode === "files" ? t("项目就在手边", "Your project, close at hand") : t("清楚看见每一处改动", "See what changed")}</strong><p>{mode === "files" ? t("选择文件查看内容，或把它加入任务上下文。", "Choose a file to read it or add it to the task.") : t("选择文件，查看新增、删除和修改的内容。", "Choose a file to inspect its additions, deletions, and edits.")}</p></div>}</div>
    </div>}
  </section>;
}

export function ProjectView({ id }: { id: string }) {
  const { t, workspaces, setWorkspaceId, setNotice } = useWorkbench();
  const router = useRouter();
  const workspace = workspaces.find(project => project.id === id);
  const [mode, setMode] = useState<Mode>("files");
  const [worktree, setWorktree] = useState(false);
  useEffect(() => { if (workspace) setWorkspaceId(workspace.id); }, [workspace, setWorkspaceId]);
  const useFile = useCallback((path: string) => {
    try { const key = "knorvia-native-draft:new"; localStorage.setItem(key, appendFileReferences(localStorage.getItem(key) ?? "", [path])); }
    catch { setNotice(t("无法保存文件引用，请手动添加文件路径。", "Could not save the file reference. Add the path manually.")); return; }
    router.push("/workbench");
  }, [router, setNotice, t]);
  if (!workspace) return <div className="nw-state-screen"><Loader2 size={20} className="nw-spin" /><p>{t("正在读取项目…", "Loading project…")}</p></div>;
  return <div className="nw-project-view"><div className="nw-project-page-heading"><div><h1><FolderGit2 size={23} />{workspace.title}</h1><p>{workspace.cwd || t("尚未选择本地文件夹", "No local folder selected")}</p></div><div><button className="nw-button" aria-pressed={worktree} onClick={() => setWorktree(value => !value)}><GitBranch size={15} />{t("独立工作目录", "Worktree")}</button><button className="nw-button nw-button-primary" onClick={() => router.push("/workbench")}><Plus size={15} />{t("新任务", "New task")}</button></div></div>{worktree ? <WorktreeManager key={id} workspaceId={id} /> : <ProjectExplorer key={id} scope={{ workspaceId: id }} mode={mode} onModeChange={setMode} onUseFile={useFile} />}</div>;
}
