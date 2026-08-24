"use client";

/**
 * ImmersiveReader — DeepTutor v1.5.14-style "document beside the thread".
 *
 * A resizable side panel on the chat workspace that previews a knowledge-base
 * file while the conversation continues in the remaining space. Citation
 * cards can open a file here (jump-to-page wiring lands with the citation
 * source map). The seam drags; the panel collapses to nothing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelRightClose, X } from "lucide-react";
import KbFilePreview from "@/components/knowledge/KbFilePreview";
import type { FilePreviewSource } from "@/components/chat/preview/previewerFor";

const MIN_WIDTH = 320;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 560;

export default function ImmersiveReader({
  source,
  onClose,
}: {
  source: FilePreviewSource | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const draggingRef = useRef(false);

  const startDrag = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    if (!source) return;
    const onMove = (event: MouseEvent) => {
      if (!draggingRef.current) return;
      const next = window.innerWidth - event.clientX;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [source]);

  // Escape closes when not fullscreen inside the preview.
  useEffect(() => {
    if (!source) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !draggingRef.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [source, onClose]);

  if (!source) return null;

  return (
    <div
      data-immersive-reader=""
      className="relative flex min-h-0 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--background)]"
      style={{ width }}
    >
      {/* Drag seam */}
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={startDrag}
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-[var(--primary)]/40"
      />
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          {t("Immersive reading")}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title={t("Close")}
            onClick={onClose}
            className="rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]"
          >
            <X size={14} />
          </button>
          <button
            type="button"
            title={t("Collapse panel")}
            onClick={onClose}
            className="rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]"
          >
            <PanelRightClose size={14} />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <KbFilePreview source={source} />
      </div>
    </div>
  );
}
