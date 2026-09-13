"use client";

// Reader for committed media-generation artifacts. The artifact manifest is
// the single durable fact (Rust Artifact); media bytes stream from the same
// studio/content handler the creation studio uses, so the outputs page never
// keeps a second copy of job or byte state.
// B20: up to two outputs can be reviewed side by side; object URLs are bound
// to one output identity each, so a download can never mix old bytes with a
// new output's name, and at most two URLs stay alive at once.
/* eslint-disable @next/next/no-img-element -- Local Blob media must keep intrinsic dimensions without a network image proxy. */
import { useState } from "react";
import { BookPlus, Columns2, Square } from "lucide-react";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { type StudioOutput } from "@/lib/native-studio";
import { downloadAvailable, sanitizeDownloadName } from "@/lib/native-media-review";
import { MediaPane } from "./MediaCompareView";
import { useMediaOutputs } from "./useMediaOutputs";
import "./media-review.css";

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
  if (type !== "application/vnd.knorvia.media+json" || !content || content.length > 1024 * 1024) return null;
  try {
    const value = JSON.parse(content) as MediaManifest;
    if (!value || typeof value.studioJobId !== "string" || !value.studioJobId || !["image", "video"].includes(value.kind) || !Array.isArray(value.outputs) || !value.outputs.length || value.outputs.length > 256) return null;
    if (!value.outputs.every(output => output && typeof output.name === "string" && output.name.length > 0 && output.name.length <= 512 && typeof output.mime === "string" && /^(image|video)\/[a-z0-9.+-]+$/i.test(output.mime) && Number.isSafeInteger(output.size) && output.size >= 0 && output.size <= 256 * 1024 * 1024 && (!output.sha256 || typeof output.sha256 === "string" && /^[a-f0-9]{64}$/i.test(output.sha256)))) return null;
    if (new Set(value.outputs.map(output => output.name)).size !== value.outputs.length) return null;
    if (value.source) {
      const source = value.source;
      if (typeof source !== "object" || (source.provider?.name !== undefined && typeof source.provider.name !== "string") || (source.provider?.model !== undefined && typeof source.provider.model !== "string") || (source.input?.size !== undefined && typeof source.input.size !== "string") || (source.references !== undefined && !Array.isArray(source.references))) return null;
    }
    return value;
  } catch { return null; }
}

export function MediaOutputReader({ manifest }: { manifest: MediaManifest }) {
  const identity = JSON.stringify([manifest.studioJobId, manifest.outputs.map(output => [output.name, output.mime, output.size, output.sha256])]);
  return <MediaOutputContent key={identity} manifest={manifest} />;
}

function MediaOutputContent({ manifest }: { manifest: MediaManifest }) {
  const { t, request, setNotice, setError } = useWorkbench();
  const [selection, setSelection] = useState<{ primary: number; secondary: number | null }>({ primary: 0, secondary: null });
  const [compare, setCompare] = useState(false);
  const [zoom, setZoom] = useState<"fit" | "one" | "two">("fit");
  const primary = manifest.outputs[selection.primary];
  const secondary = compare && selection.secondary !== null && selection.secondary !== selection.primary ? manifest.outputs[selection.secondary] : null;
  const { slots, retry, patch } = useMediaOutputs(request as never, { id: manifest.studioJobId, outputs: manifest.outputs }, secondary ? [primary, secondary] : [primary]);
  const download = (output: StudioOutput) => {
    const slot = slots[output.name];
    if (!downloadAvailable(slot)) return;
    const anchor = document.createElement("a");
    anchor.href = slot.url!;
    anchor.download = sanitizeDownloadName(output.name);
    anchor.click();
  };
  const onLoadedSize = (name: string, url: string | undefined, size: { width?: number; height?: number; duration?: number }) => patch(name, url, size);
  const onDecodeError = (name: string, url: string | undefined) => patch(name, url, { decodeError: true });

  const otherOutputs = manifest.outputs.filter(output => output.name !== primary.name);
  return <div className="nw-media-reader">
    <div className={`nw-media-compare ${compare ? "is-comparing" : ""}`} data-count={compare && secondary ? 2 : 1}>
      <MediaPane output={primary} slot={slots[primary.name]} zoom={zoom} onLoadedSize={onLoadedSize} onDecodeError={onDecodeError} onRetry={retry} onDownload={download} />
      {compare && secondary && <MediaPane output={secondary} slot={slots[secondary.name]} zoom={zoom} onLoadedSize={onLoadedSize} onDecodeError={onDecodeError} onRetry={retry} onDownload={download} compact />}
      {compare && !secondary && <p className="nw-media-pane-note" role="note">{t("在下方选择另一份输出进行对照。", "Pick another output below to compare against.")}</p>}
    </div>
    {manifest.outputs.length > 1 && <div className="nw-media-variants" role="tablist" aria-label={t("输出列表", "Outputs")}>
      {manifest.outputs.map((item, itemIndex) => <button key={item.name} role="tab" aria-selected={itemIndex === selection.primary} className={`nw-media-variant ${itemIndex === selection.primary ? "is-active" : ""}`} onClick={() => setSelection(current => ({ primary: itemIndex, secondary: current.secondary === itemIndex ? current.primary : current.secondary }))}>
        {t("主位", "Main")}: {item.name}
      </button>)}
    </div>}
    <div className="nw-media-actions">
      {manifest.outputs.length > 1 && <button className="nw-button nw-button-small" aria-pressed={compare} onClick={() => setCompare(value => !value)}><Columns2 size={13} />{compare ? t("退出对照", "Exit compare") : t("对照审片", "Compare two")}</button>}
      {compare && <label className="nw-media-secondary-select"><span>{t("对比输出", "Against")}</span><select aria-label={t("选择对比输出", "Choose comparison output")} value={selection.secondary ?? ""} onChange={event => setSelection(current => ({ ...current, secondary: event.target.value === "" ? null : Number(event.target.value) }))}>
        <option value="">{t("（无）", "(none)")}</option>
        {otherOutputs.map(output => <option key={output.name} value={manifest.outputs.indexOf(output)}>{output.name}</option>)}
      </select></label>}
      <span className="nw-media-zoom" role="group" aria-label={t("缩放", "Zoom")}>
        <button className="nw-button nw-button-small" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")}>{t("适应", "Fit")}</button>
        <button className="nw-button nw-button-small" aria-pressed={zoom === "one"} onClick={() => setZoom("one")}><Square size={11} />1:1</button>
        <button className="nw-button nw-button-small" aria-pressed={zoom === "two"} onClick={() => setZoom("two")}>200%</button>
      </span>
      <button className="nw-button nw-button-small" onClick={async () => {
        try { await request("studio/library", { id: manifest.studioJobId, index: manifest.outputs.indexOf(primary) }); setNotice(t("已存入个人资料库", "Saved to your personal library")); }
        catch (cause) { setError(errorText(cause)); }
      }}><BookPlus size={13} />{t("存入资料库", "Save to library")}</button>
    </div>
    <p className="nw-media-meta">{primary.name} · {t("sha256 摘要", "sha256")} {primary.sha256 ? `${primary.sha256.slice(0, 12)}…` : t("缺失", "missing")}</p>
    {manifest.source && <p className="nw-media-meta">{t("来源", "Source")}: {manifest.source.provider?.name ?? t("未指定模型", "No model")}{manifest.source.provider?.model ? ` · ${manifest.source.provider.model}` : ""}{manifest.source.input?.size ? ` · ${manifest.source.input.size}` : ""}{manifest.source.via === "agent" ? ` · ${t("Agent", "Agent")}` : ""}{manifest.source.references?.length ? ` · ${t(`${manifest.source.references.length} 张参考图`, `${manifest.source.references.length} reference(s)`)}` : ""}</p>}
  </div>;
}
