"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, PenLine } from "lucide-react";

import {
  createCoWriterDocument,
  getCoWriterDocument,
  updateCoWriterDocument,
} from "@/lib/co-writer-api";
import { notifyCoWriterChanged } from "@/lib/co-writer-events";
import {
  COWRITER_SPLIT_MAX,
  COWRITER_SPLIT_MIN,
  loadCoWriterSplitState,
  saveCoWriterSplitState,
  type CoWriterSplitState,
} from "@/lib/cowriter-split";

const AUTOSAVE_MS = 1400;

/**
 * Left = paper editor, right = existing chat. Persist split widths simply.
 * Does not unmount the chat tree.
 */
export default function CoWriterSplit({
  open,
  onStateChange,
  children,
}: {
  open: boolean;
  onStateChange?: (state: CoWriterSplitState) => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<CoWriterSplitState>(() =>
    loadCoWriterSplitState(),
  );
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [saving, setSaving] = useState(false);
  const dragging = useRef(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef("");

  const persist = useCallback(
    (partial: Partial<CoWriterSplitState>) => {
      setState((prev) => {
        const next = saveCoWriterSplitState({ ...prev, ...partial, open });
        onStateChange?.(next);
        return next;
      });
    },
    [onStateChange, open],
  );

  useEffect(() => {
    persist({ open });
  }, [open, persist]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const boot = async () => {
      const current = loadCoWriterSplitState();
      try {
        if (current.docId) {
          const doc = await getCoWriterDocument(current.docId);
          if (cancelled) return;
          setTitle(doc.title || "");
          setMarkdown(doc.content || "");
          lastSaved.current = doc.content || "";
          return;
        }
        const created = await createCoWriterDocument({
          title: t("Untitled Co-Writer Document"),
        });
        if (cancelled) return;
        notifyCoWriterChanged();
        persist({ docId: created.id });
        setTitle(created.title || "");
        setMarkdown(created.content || "");
        lastSaved.current = created.content || "";
      } catch {
        /* editor stays local until the API is reachable */
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, [open, persist, t]);

  const flush = useCallback(
    async (content: string, nextTitle: string) => {
      const docId = loadCoWriterSplitState().docId;
      if (!docId || content === lastSaved.current) return;
      setSaving(true);
      try {
        await updateCoWriterDocument(docId, {
          content,
          title: nextTitle || undefined,
        });
        lastSaved.current = content;
        notifyCoWriterChanged();
      } catch {
        /* keep local draft */
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void flush(markdown, title);
    }, AUTOSAVE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [flush, markdown, open, title]);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      if (!dragging.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      if (rect.width < 8) return;
      const ratio = (event.clientX - rect.left) / rect.width;
      persist({
        ratio: Math.min(COWRITER_SPLIT_MAX, Math.max(COWRITER_SPLIT_MIN, ratio)),
      });
    },
    [persist],
  );

  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", up);
    };
  }, [onPointerMove]);

  if (!open) {
    return <>{children}</>;
  }

  return (
    <div
      ref={splitRef}
      className="flex h-full min-h-0 w-full overflow-hidden"
      data-testid="cowriter-split"
    >
      <section
        className="flex min-h-0 min-w-0 flex-col border-r border-[var(--border)] bg-[var(--card)]/40"
        style={{ width: `${state.ratio * 100}%` }}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)]/70 px-3 py-2">
          <PenLine size={14} className="text-[var(--primary)]" />
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("Untitled Co-Writer Document")}
            className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-[var(--foreground)] outline-none"
          />
          {saving ? (
            <Loader2
              size={12}
              className="animate-spin text-[var(--muted-foreground)]"
            />
          ) : null}
        </div>
        <textarea
          value={markdown}
          onChange={(event) => setMarkdown(event.target.value)}
          placeholder={t("Write the paper on the left. Chat and citations stay on the right.")}
          className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[13px] leading-relaxed text-[var(--foreground)] outline-none"
        />
      </section>
      <button
        type="button"
        aria-label={t("Resize editor and chat")}
        title={t("Drag to resize, double-click to reset")}
        onPointerDown={(event) => {
          event.preventDefault();
          dragging.current = true;
        }}
        onDoubleClick={() => persist({ ratio: 0.42 })}
        className="w-1.5 shrink-0 cursor-col-resize bg-[var(--border)]/80 hover:bg-[var(--primary)]/50"
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
