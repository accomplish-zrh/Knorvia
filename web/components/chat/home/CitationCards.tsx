"use client";

/**
 * Inline citations for knowledge-base grounded answers.
 *
 * The backend's `rag` tool already attaches structured provenance to every
 * retrieval (`{title, content, source, page, chunk_id, score, kb_name}`) —
 * these cards surface it under the assistant bubble instead of burying it
 * in the trace panel (parity with AnythingLLM / Open WebUI citation chips).
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, ChevronDown, FileText } from "lucide-react";
import type { StreamEvent } from "@/lib/unified-ws";

export interface RagCitation {
  title?: string;
  content?: string;
  source?: string;
  page?: number | string;
  chunk_id?: string;
  score?: number;
  kb_name?: string;
}

const MAX_CARDS = 8;
const PREVIEW_CHARS = 180;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Pull rag citations out of a turn's tool_result / observation events. */
export function extractRagCitations(events: StreamEvent[] | undefined): RagCitation[] {
  if (!events?.length) return [];
  const seen = new Set<string>();
  const out: RagCitation[] = [];
  for (const event of events) {
    const meta = asRecord(event.metadata);
    const candidates: unknown[] = [
      ...(Array.isArray(meta?.sources) ? meta.sources : []),
    ];
    // Some pipelines stash sources on the payload itself.
    const data = asRecord((event as { data?: unknown }).data);
    if (data && Array.isArray(data.sources)) candidates.push(...data.sources);
    for (const raw of candidates) {
      const item = asRecord(raw);
      if (!item || item.type !== "rag") continue;
      const title = String(item.title ?? item.source ?? item.kb_name ?? "").trim();
      const key = `${title}|${String(item.chunk_id ?? "")}|${String(item.page ?? "")}`;
      if (!title || seen.has(key)) continue;
      seen.add(key);
      out.push({
        title,
        content: typeof item.content === "string" ? item.content : "",
        source: typeof item.source === "string" ? item.source : undefined,
        page: typeof item.page === "number" || typeof item.page === "string" ? item.page : undefined,
        chunk_id: typeof item.chunk_id === "string" ? item.chunk_id : undefined,
        score: typeof item.score === "number" ? item.score : undefined,
        kb_name: typeof item.kb_name === "string" ? item.kb_name : undefined,
      });
    }
  }
  return out.slice(0, MAX_CARDS);
}

export default function CitationCards({ citations }: { citations: RagCitation[] }) {
  const { t } = useTranslation();
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  const label = useMemo(() => {
    const kbs = Array.from(new Set(citations.map(c => c.kb_name).filter(Boolean))) as string[];
    return t("Sources")
      + (kbs.length ? ` · ${kbs.join(", ")}` : "");
  }, [citations, t]);

  if (!citations.length) return null;

  return (
    <div className="mt-2 rounded-xl border border-[var(--border)]/80 bg-[var(--card)]/60">
      <div className="flex items-center gap-1.5 px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
        <BookOpen size={11} strokeWidth={1.8} />
        <span className="truncate">{label}</span>
        <span className="ml-auto shrink-0 opacity-70">{citations.length}</span>
      </div>
      <div className="flex flex-col gap-1 p-2">
        {citations.map((cite, idx) => {
          const open = openIdx === idx;
          const preview = (cite.content ?? "").slice(0, PREVIEW_CHARS);
          const truncated = (cite.content ?? "").length > PREVIEW_CHARS;
          const heading = cite.source || cite.title;
          const metaBits = [
            cite.page != null ? `${t("page")} ${cite.page}` : "",
            cite.chunk_id ? `#${cite.chunk_id}` : "",
            cite.score != null ? cite.score.toFixed(3) : "",
          ].filter(Boolean);
          return (
            <div key={`${cite.title}-${idx}`} className="rounded-lg border border-[var(--border)]/60 bg-[var(--background)]">
              <button
                type="button"
                onClick={() => setOpenIdx(open ? null : idx)}
                aria-expanded={open}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
              >
                <FileText size={12} className="shrink-0 text-[var(--primary)]" />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--foreground)]">
                  [{idx + 1}] {heading}
                </span>
                {metaBits.length > 0 && (
                  <span className="hidden shrink-0 text-[10.5px] text-[var(--muted-foreground)] sm:inline">
                    {metaBits.join(" · ")}
                  </span>
                )}
                <ChevronDown
                  size={12}
                  className={`shrink-0 text-[var(--muted-foreground)] transition-transform ${open ? "rotate-180" : ""}`}
                />
              </button>
              {open && (
                <div className="border-t border-[var(--border)]/50 px-2.5 py-2">
                  <p className="whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-[var(--muted-foreground)]">
                    {truncated ? `${preview}…` : preview}
                  </p>
                  {truncated && (
                    <p className="mt-1 text-[10.5px] italic text-[var(--muted-foreground)]/70">
                      {t("Full chunk stored in the knowledge base.")}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
