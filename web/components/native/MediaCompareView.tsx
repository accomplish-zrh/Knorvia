"use client";

/* eslint-disable @next/next/no-img-element -- Local Blob media must keep intrinsic dimensions without a network image proxy. */
import { Film, ImageIcon, Loader2, RotateCcw } from "lucide-react";
import { downloadAvailable, slotMetaLabel, type MediaSlot } from "@/lib/native-media-review";
import type { StudioOutput } from "@/lib/native-studio";
import { useWorkbench } from "./NativeWorkbenchProvider";

/**
 * One pane of the compare review (B20): image or video, fit/1:1 sizing,
 * independent video playback, and failure feedback that never masks the
 * other pane. The pane reports decode failures separately from read errors
 * and offers a retry that remounts the media element.
 */
export function MediaPane({ output, slot, zoom, onLoadedSize, onDecodeError, onRetry, onDownload, compact = false }: {
  output: StudioOutput;
  slot: MediaSlot | undefined;
  zoom: "fit" | "one" | "two";
  onLoadedSize: (name: string, url: string | undefined, size: { width?: number; height?: number; duration?: number }) => void;
  onDecodeError: (name: string, url: string | undefined) => void;
  onRetry: (name: string) => void;
  onDownload: (output: StudioOutput) => void;
  compact?: boolean;
}) {
  const { t } = useWorkbench();
  const isVideo = output.mime.startsWith("video/");
  const busy = !slot || slot.status === "loading" || slot.status === "idle";
  return <figure className={`nw-media-pane ${compact ? "is-compact" : ""}`} data-zoom={zoom} data-state={slot?.status ?? "idle"}>
    <figcaption className="nw-media-pane-head">
      <span title={output.name}>{isVideo ? <Film size={13} /> : <ImageIcon size={13} />}{output.name}</span>
      <span className="nw-media-pane-meta" title={output.sha256 ? `sha256 ${output.sha256}` : undefined}>{slotMetaLabel(slot, `${Math.max(1, Math.round(output.size / 1024))} KB`, t)}{output.sha256 ? ` · ${output.sha256.slice(0, 12)}…` : ""}</span>
    </figcaption>
    <div className="nw-media-pane-body" data-zoom={zoom}>
      {busy && <Loader2 className="nw-spin" size={20} aria-label={t("读取中", "Loading")} />}
      {!busy && slot?.status === "error" && <div className="nw-media-fault" role="alert"><p>{t("读取失败：", "Read failed: ")}{slot.error}</p><button className="nw-button nw-button-small" onClick={() => onRetry(output.name)}><RotateCcw size={12} />{t("重试", "Retry")}</button></div>}
      {!busy && slot?.decodeError && <div className="nw-media-fault" role="alert"><p>{t("媒体解码失败，字节已下载到本地缓存。", "The media failed to decode; the bytes are cached locally.")}</p><button className="nw-button nw-button-small" onClick={() => onRetry(output.name)}><RotateCcw size={12} />{t("重新解码", "Re-decode")}</button>{slot.url && <button className="nw-button nw-button-small" onClick={() => onDownload(output)}>{t("直接下载", "Download anyway")}</button>}</div>}
      {!busy && slot?.status === "ready" && slot.url && !slot.decodeError && (isVideo
        ? <video key={`${output.name}:${slot.url}`} src={slot.url} style={zoom === "two" && slot.width ? { width: slot.width * 2 } : undefined} controls preload="metadata" aria-label={output.name} onError={() => onDecodeError(output.name, slot.url)} onLoadedMetadata={event => onLoadedSize(output.name, slot.url, { width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight, duration: event.currentTarget.duration })} />
        : <img key={`${output.name}:${slot.url}`} src={slot.url} style={zoom === "two" && slot.width ? { width: slot.width * 2 } : undefined} alt={output.name} onError={() => onDecodeError(output.name, slot.url)} onLoad={event => onLoadedSize(output.name, slot.url, { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />)}
    </div>
    {!busy && !(slot?.status === "error") && !downloadAvailable(slot) && !slot?.decodeError && <p className="nw-media-pane-note" role="note">{t("这份输出尚未就绪，下载暂不可用。", "This output is not ready yet; download is unavailable.")}</p>}
    <button className="nw-button nw-button-small" disabled={!downloadAvailable(slot)} onClick={() => onDownload(output)}>{t("下载此输出", "Download this output")}</button>
  </figure>;
}
