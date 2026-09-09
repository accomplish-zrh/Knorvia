"use client";

// Reader for committed media-generation artifacts. The artifact manifest is
// the single durable fact (Rust Artifact); media bytes stream from the same
// studio/content handler the creation studio uses, so the outputs page never
// keeps a second copy of job or byte state.
/* eslint-disable @next/next/no-img-element -- Local Blob media must keep intrinsic dimensions without a network image proxy. */
import { useEffect, useState } from "react";
import { ArrowDownToLine, BookPlus, Film, Image as ImageIcon, Loader2 } from "lucide-react";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { readStudioOutput, type StudioOutput, type StudioJob } from "@/lib/native-studio";

export type MediaManifest = {
  studioJobId: string;
  kind: "image" | "video";
  outputs: StudioOutput[];
  source?: {
    prompt?: string;
    provider?: { name?: string; model?: string };
    input?: { size?: string; aspect?: string; count?: number; seconds?: number; quality?: string };
    references?: { id: string; version?: string }[];
    via?: string;
  };
};

export function parseMediaManifest(type: string | undefined, content: string | null | undefined): MediaManifest | null {
  if (type !== "application/vnd.knorvia.media+json" || !content) return null;
  try {
    const value = JSON.parse(content) as MediaManifest;
    if (!value || typeof value.studioJobId !== "string" || !Array.isArray(value.outputs) || !value.outputs.length) return null;
    if (!value.outputs.every(output => output && typeof output.name === "string" && typeof output.mime === "string" && typeof output.size === "number")) return null;
    return value;
  } catch { return null; }
}

function formatBytes(size: number) {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
}

export function MediaOutputReader({ manifest }: { manifest: MediaManifest }) {
  const { t, request, setNotice, setError } = useWorkbench();
  const [index, setIndex] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setErrorText] = useState("");
  const [saving, setSaving] = useState(false);
  const output = manifest.outputs[Math.min(index, manifest.outputs.length - 1)];

  useEffect(() => {
    if (!output) return;
    let cancelled = false; let created: string | null = null;
    setLoading(true); setErrorText("");
    void readStudioOutput(request as never, { id: manifest.studioJobId, outputs: manifest.outputs } as StudioJob, manifest.outputs.indexOf(output))
      .then(blob => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch(cause => { if (!cancelled) setErrorText(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; if (created) URL.revokeObjectURL(created); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest.studioJobId, output?.name]);

  if (!output) return <p role="alert" className="nw-inline-error">{t("这份成果没有可显示的输出", "This output has no readable media")}</p>;
  const isVideo = output.mime.startsWith("video/");
  return <div className="nw-media-reader">
    <div className="nw-media-frame" data-busy={loading || undefined}>
      {loading && <Loader2 className="nw-spin" size={22} aria-label={t("读取中", "Loading")} />}
      {!loading && error && <p role="alert" className="nw-inline-error">{error}</p>}
      {!loading && !error && url && (isVideo
        ? <video key={url} src={url} controls preload="metadata" aria-label={output.name} />
        : <img key={url} src={url} alt={output.name} />)}
    </div>
    {manifest.outputs.length > 1 && <div className="nw-media-variants" role="tablist" aria-label={t("输出列表", "Outputs")}>
      {manifest.outputs.map((item, itemIndex) => <button key={item.name} role="tab" aria-selected={itemIndex === manifest.outputs.indexOf(output)} className={`nw-media-variant ${itemIndex === manifest.outputs.indexOf(output) ? "is-active" : ""}`} onClick={() => setIndex(itemIndex)}>
        {item.mime.startsWith("video/") ? <Film size={13} /> : <ImageIcon size={13} />}{item.name}
      </button>)}
    </div>}
    <div className="nw-media-actions">
      <button className="nw-button nw-button-small" disabled={!url} onClick={() => {
        if (!url) return;
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = output.name; anchor.click();
      }}><ArrowDownToLine size={13} />{t("下载", "Download")}</button>
      <button className="nw-button nw-button-small" disabled={saving} onClick={async () => {
        setSaving(true);
        try { await request("studio/library", { id: manifest.studioJobId, index: manifest.outputs.indexOf(output) }); setNotice(t("已存入个人资料库", "Saved to your personal library")); }
        catch (cause) { setError(errorText(cause)); }
        finally { setSaving(false); }
      }}><BookPlus size={13} />{t("存入资料库", "Save to library")}</button>
    </div>
    <p className="nw-media-meta">{output.name} · {formatBytes(output.size)} · {t("sha256 摘要", "sha256")} {output.sha256 ? `${output.sha256.slice(0, 12)}…` : t("缺失", "missing")}</p>
    {manifest.source && <p className="nw-media-meta">{t("来源", "Source")}: {manifest.source.provider?.name ?? t("未指定模型", "No model")}{manifest.source.provider?.model ? ` · ${manifest.source.provider.model}` : ""}{manifest.source.input?.size ? ` · ${manifest.source.input.size}` : ""}{manifest.source.via === "agent" ? ` · ${t("Agent", "Agent")}` : ""}{manifest.source.references?.length ? ` · ${t(`${manifest.source.references.length} 张参考图`, `${manifest.source.references.length} reference(s)`)}` : ""}</p>}
  </div>;
}
