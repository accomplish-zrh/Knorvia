"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, FileText, Folder, Loader2, Maximize2, RefreshCw, X } from "lucide-react";
import { nativeTimestamp, type Artifact, type ArtifactContent, type ThreadSnapshot } from "@/lib/native-workbench-state";
import type { DirectoryPage } from "@/lib/native-project-context";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { Markdown } from "./TaskTimeline";
import { MediaOutputReader, parseMediaManifest } from "./MediaOutputReader";

export function OutputPreview({ artifact, back, expand }: { artifact: Artifact; back?: () => void; expand?: () => void }) {
  const { request, t } = useWorkbench();
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void request<ArtifactContent>("artifact/content", { id: artifact.id }).then(result => { if (!cancelled) setContent(result.content); }).catch(caught => { if (!cancelled) setError(errorText(caught)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [request, artifact.id]);
  const mediaManifest = parseMediaManifest(artifact.type, content);
  return <div className="nw-resource-preview">{back && <button className="nw-resource-back" onClick={back}><ArrowLeft size={14} />{t("返回资料与成果", "Back to resources")}</button>}{expand && <button className="nw-resource-expand" onClick={expand}><Maximize2 size={14} />{t("在工作面板中阅读", "Read in work panel")}</button>}<h3>{artifact.title}</h3>{loading ? <Loader2 size={17} className="nw-spin" /> : error ? <p className="nw-inline-error" role="alert">{error}</p> : mediaManifest ? <MediaOutputReader manifest={mediaManifest} /> : <Markdown text={content} />}</div>;
}

export function TaskResources({ thread, close, openFiles, openOutput }: { thread: ThreadSnapshot; close: () => void; openFiles: (path?: string, folder?: string) => void; openOutput: (artifact: Artifact) => void }) {
  const { request, t, notice } = useWorkbench();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [files, setFiles] = useState<DirectoryPage>();
  const [errors, setErrors] = useState({ artifacts: "", files: "" });
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      request<Artifact[]>("artifact/list", { workspaceId: thread.workspaceId }),
      request<DirectoryPage>("workspace/files/list", { threadId: thread.id, path: "", limit: 5 }),
    ]).then(([outputs, sources]) => {
      if (cancelled) return;
      if (outputs.status === "fulfilled") setArtifacts([...outputs.value].sort((a, b) => (nativeTimestamp(b.updatedAt) || 0) - (nativeTimestamp(a.updatedAt) || 0)));
      if (sources.status === "fulfilled") setFiles(sources.value);
      setErrors({ artifacts: outputs.status === "rejected" ? errorText(outputs.reason) : "", files: sources.status === "rejected" ? errorText(sources.reason) : "" });
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [request, thread.id, thread.workspaceId, notice, revision]);
  const failure = (message: string) => message && <div className="nw-resource-failure" role="alert"><p>{message}</p><button onClick={() => { setLoading(true); setRevision(value => value + 1); }}><RefreshCw size={13} />{t("重试", "Retry")}</button></div>;
  return <aside className="nw-resources-pane" aria-label={t("资料与成果", "Resources and outputs")}><div className="nw-resources-card"><div className="nw-detail-heading"><strong>{t("资料与成果", "Resources and outputs")}</strong><button className="nw-icon" onClick={close} aria-label={t("关闭资料与成果", "Close resources")}><X size={17} /></button></div>
    <>{loading && <Loader2 size={16} className="nw-spin" />}<section><div className="nw-resources-heading"><h2>{t("项目成果", "Project outputs")}</h2><Link href="/workbench/artifacts" aria-label={t("查看所有成果", "View all outputs")}><ArrowUpRight size={15} /></Link></div>{failure(errors.artifacts)}{artifacts.slice(0, 5).map(artifact => <button className="nw-resource-row" key={artifact.id} onClick={() => openOutput(artifact)}><FileText size={16} /><span>{artifact.title}</span></button>)}{!loading && !errors.artifacts && !artifacts.length && <p>{t("在回复下保存成果，就能在这里查看。", "Save a response as an output to find it here.")}</p>}</section><section><div className="nw-resources-heading"><h2>{t("项目资料", "Project sources")}</h2><button className="nw-icon" onClick={() => openFiles()} aria-label={t("浏览项目资料", "Browse project files")}><Folder size={16} /></button></div>{failure(errors.files)}{files?.entries.map(entry => <button className="nw-resource-row" key={entry.path} title={entry.path} onClick={() => openFiles(entry.kind === "file" ? entry.path : undefined, entry.kind === "directory" ? entry.path : undefined)}>{entry.kind === "directory" ? <Folder size={16} /> : <FileText size={16} />}<span>{entry.name}</span></button>)}{!loading && !errors.files && !files?.entries.length && <p>{t("项目文件会显示在这里。", "Project files will appear here.")}</p>}<button className="nw-resource-more" onClick={() => openFiles()}>{t("查看全部资料", "Browse all files")}<ArrowUpRight size={13} /></button></section></>
  </div></aside>;
}
