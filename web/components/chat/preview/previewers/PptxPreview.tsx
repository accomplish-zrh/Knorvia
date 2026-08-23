"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { parsePptxBuffer, type PptxSlide } from "@/lib/pptx-preview";
import { useBinarySource } from "./useBinarySource";
import FallbackPreview from "./FallbackPreview";

export default function PptxPreview({
  url,
  filename,
}: {
  url: string;
  filename: string;
}) {
  const { t } = useTranslation();
  const src = useBinarySource(url);
  const [slides, setSlides] = useState<PptxSlide[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (src.kind !== "ready") return;
    let cancelled = false;
    void parsePptxBuffer(src.buffer)
      .then((next) => {
        if (!cancelled) setSlides(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (src.kind === "loading" || (src.kind === "ready" && !slides && !failed)) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-[var(--muted-foreground)]">
        <Loader2 size={14} className="animate-spin" />
        <span>{t("Loading preview…")}</span>
      </div>
    );
  }

  if (src.kind === "error" || failed || !slides || slides.length === 0) {
    return <FallbackPreview filename={filename} url={url} />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--muted)]/40 px-5 py-2 text-[11px] text-[var(--muted-foreground)]">
        <AlertCircle size={13} strokeWidth={1.6} className="shrink-0" />
        <p>
          {t("{{count}} slides — layout is simplified; download the original for full formatting.", {
            count: slides.length,
          })}
        </p>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {slides.map((slide) => (
          <article
            key={slide.index}
            className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4 shadow-sm"
          >
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
              {t("Slide {{n}}", { n: slide.index })}
            </div>
            <h3 className="text-[14px] font-medium text-[var(--foreground)]">
              {slide.title}
            </h3>
            {slide.lines.length > 0 ? (
              <ul className="mt-2 space-y-1 text-[12.5px] leading-relaxed text-[var(--muted-foreground)]">
                {slide.lines.map((line, index) => (
                  <li key={`${slide.index}-${index}`}>{line}</li>
                ))}
              </ul>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
