"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDownToLine, ChevronLeft, FileText, Film, Layers, Loader2, Pencil, RotateCcw, Save, X } from "lucide-react";
import { displayTime, type Artifact, type ArtifactContent } from "@/lib/native-workbench-state";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { Markdown } from "./TaskTimeline";
import { SaveToLibrary } from "./SaveToLibrary";
import { MediaOutputReader, parseMediaManifest } from "./MediaOutputReader";

const MEDIA_ARTIFACT_TYPE = "application/vnd.knorvia.media+json";

export function OutputsView({ embedded = false }: { embedded?: boolean }) {
  const { t, locale, request, workspaces, connection, setError, setNotice } = useWorkbench();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [contentError, setContentError] = useState("");
  const selectedId = selected?.id;
  const mediaManifest = parseMediaManifest(selected?.type, content?.content);
  const dirty = Boolean(content && !mediaManifest && !revisionId && draft !== content.content);
  const canLeave = () => !pending && (!dirty || window.confirm(t("成果尚未保存，放弃这些修改吗？", "Discard unsaved changes to this output?")));
  useEffect(() => {
    if (!dirty && !pending) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target.closest('a[href]');
      if (!anchor || anchor.getAttribute('target') === '_blank' || anchor.hasAttribute('download')) return;
      if (pending || !window.confirm(t("成果尚未保存，放弃这些修改吗？", "Discard unsaved changes to this output?"))) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener('beforeunload', unload); document.addEventListener('click', navigate, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', navigate, true); };
  }, [dirty, pending, t]);
  const refresh = useCallback(async () => {
    if (!workspaces.length) return;
    const lists = await Promise.all(workspaces.map(project => request<Artifact[]>("artifact/list", { workspaceId: project.id })));
    setArtifacts(lists.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }, [request, workspaces]);
  useEffect(() => {
    if (connection !== "connected") return;
    let cancelled = false;
    void refresh().catch(error => { if (!cancelled) setError(errorText(error)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [connection, refresh, setError]);
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setContent(null); setEditing(false); setContentError("");
    void request<ArtifactContent>("artifact/content", { id: selectedId, ...(revisionId ? { revisionId } : {}) }).then(value => { if (!cancelled) { setContent(value); setDraft(value.content); } }).catch(error => { if (!cancelled) setContentError(errorText(error)); });
    return () => { cancelled = true; };
  }, [selectedId, revisionId, request]);
  return <div className={`nw-outputs-view ${selected ? "is-reading" : ""}`}><div className="nw-page"><div className="nw-page-heading"><div><h1>{embedded ? t("本地产物", "Local outputs") : t("成果", "Outputs")}</h1><p>{t("留下有用的结果，再继续打磨。", "Keep useful results, then make them better.")}</p></div><span className="nw-muted-label">{artifacts.length} {t("份成果", "outputs")}</span></div>{loading ? <Loader2 className="nw-spin" size={20} /> : artifacts.length ? <div className="nw-output-list">{artifacts.map(artifact => <button key={artifact.id} disabled={pending} onClick={() => { if (selected?.id === artifact.id && !revisionId || !canLeave()) return; setRevisionId(null); setSelected(artifact); }} className={`nw-output-row ${selected?.id === artifact.id ? "is-active" : ""}`}><span className="nw-file-icon">{artifact.type === MEDIA_ARTIFACT_TYPE ? <Film size={20} /> : <FileText size={20} />}</span><span><strong>{artifact.title}</strong><small>{workspaces.find(project => project.id === artifact.workspaceId)?.title} · {artifact.type === MEDIA_ARTIFACT_TYPE ? t("生成的图片/视频", "Generated media") : artifact.type}</small></span><time>{displayTime(artifact.updatedAt, locale)}</time></button>)}</div> : <div className="nw-empty-panel"><Layers size={28} /><h2>{t("让成果留在这里", "A home for your outputs")}</h2><p>{t("在任务回复下选择“保存为成果”，即可查看内容、下载和保存新版本。", "Choose “Save as output” below a task response to keep, download, and revise it here.")}</p></div>}</div>
    {selected && <aside className="nw-output-reader"><div className="nw-detail-heading"><strong>{selected.title}</strong><button className="nw-icon" disabled={pending} onClick={() => { if (canLeave()) setSelected(null); }} aria-label={t("关闭成果", "Close output")}><X size={17} /></button></div>{contentError ? <p role="alert" className="nw-inline-error">{contentError}</p> : !content ? <Loader2 className="nw-spin" size={20} /> : mediaManifest ? <MediaOutputReader manifest={mediaManifest} /> : <><div className="nw-output-actions"><button className="nw-button nw-button-small" disabled={revisionId !== null || pending} onClick={() => setEditing(!editing)}><Pencil size={13} />{editing ? t("预览", "Preview") : t("编辑", "Edit")}</button><button className="nw-button nw-button-small" onClick={() => {
      const blob = new Blob([draft], { type: selected.type || "text/plain" });
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${selected.title.replace(/[<>:"/\\|?*]/g, "-")}.md`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}><ArrowDownToLine size={13} />{t("下载", "Download")}</button><SaveToLibrary name={selected.title} text={draft} />{!revisionId && <button className="nw-button nw-button-primary nw-button-small" disabled={pending || !dirty || connection !== 'connected'} onClick={async () => {
      setPending(true);
      try {
        await request("artifact/stage", { id: selected.id, content: draft, idempotencyKey: crypto.randomUUID() });
        const updated = await request<Artifact>("artifact/commit", { id: selected.id, idempotencyKey: crypto.randomUUID() });
        setContent({ content: draft, artifact: updated }); setEditing(false); setRevisionId(null); setSelected(updated); setNotice(t("新版本已保存", "New revision saved"));
        try { setContent(await request<ArtifactContent>("artifact/content", { id: updated.id })); } catch (error) { setError(errorText(error)); }
        void refresh().catch(error => setError(errorText(error)));
      } catch (error) { setError(errorText(error)); } finally { setPending(false); }
    }}>{pending ? <Loader2 size={13} className="nw-spin" /> : <Save size={13} />}{t("保存新版本", "Save revision")}</button>}</div>{dirty && <p className="nw-output-unsaved" role="status">{t("预览包含未保存的修改", "Preview includes unsaved changes")}</p>}<div className="nw-output-body">{editing ? <textarea className="nw-output-editor" disabled={pending} aria-label={t("成果内容", "Output content")} value={draft} onChange={event => setDraft(event.target.value)} /> : <Markdown text={draft} />}</div><footer className="nw-output-footer"><span><Layers size={13} />{revisionId ? t("历史版本", "Previous revision") : t("当前版本", "Current revision")}{content.revision?.createdAt && <time>{displayTime(content.revision.createdAt, locale)}</time>}</span><div>{content.revision?.parentIds?.[0] && <button className="nw-button nw-button-small" disabled={pending} onClick={() => { if (canLeave()) setRevisionId(content.revision!.parentIds![0]); }}><ChevronLeft size={13} />{t("上一版本", "Previous revision")}</button>}{revisionId && <button className="nw-button nw-button-small" disabled={pending} onClick={() => setRevisionId(null)}><RotateCcw size={13} />{t("回到当前", "Back to current")}</button>}</div></footer></> }</aside>}
  </div>;
}
