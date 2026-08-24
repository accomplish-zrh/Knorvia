"use client";

/**
 * KB Retrieval Playground — try a query against a knowledge base and see
 * exactly which chunks the chat pipeline would retrieve (scores included).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FlaskConical, Loader2, Search } from "lucide-react";
import { apiFetch, apiUrl } from "@/lib/api";

interface TestSource {
  title?: string;
  source?: string;
  page?: number | string;
  chunk_id?: string;
  score?: number;
  preview?: string;
}

interface TestResult {
  query: string;
  answer: string;
  sources: TestSource[];
  took_ms: number;
}

export default function RetrievalPlayground({ kbName }: { kbName: string }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState<number | "">("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  const run = async () => {
    const keyword = query.trim();
    if (!keyword || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(
        apiUrl(`/api/v1/knowledge/${encodeURIComponent(kbName)}/retrieval-test`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: keyword,
            ...(typeof topK === "number" && topK > 0 ? { top_k: topK } : {}),
          }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { detail?: string }
          | null;
        throw new Error(body?.detail || `HTTP ${response.status}`);
      }
      setResult((await response.json()) as TestResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)]/70 p-3">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--foreground)]">
        <FlaskConical size={13} className="text-[var(--primary)]" />
        {t("Retrieval test")}
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-[var(--muted-foreground)]">
        {t(
          "Run a query through the same pipeline chat uses and see exactly which chunks come back.",
        )}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter") void run()
            }}
            placeholder={t("Test query…")}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] py-1.5 pl-8 pr-2 text-[12px] outline-none focus:border-[var(--primary)]/50"
          />
        </div>
        <input
          type="number"
          min={1}
          max={20}
          value={topK}
          onChange={event =>
            setTopK(event.target.value === "" ? "" : Number(event.target.value))
          }
          placeholder={t("top-k")}
          className="w-16 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--primary)]/50"
        />
        <button
          type="button"
          onClick={() => void run()}
          disabled={loading || !query.trim()}
          className="flex shrink-0 items-center gap-1 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-[12px] font-medium text-[var(--primary-foreground)] disabled:opacity-45"
        >
          {loading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            t("Run")
          )}
        </button>
      </div>

      {error && (
        <p className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11.5px] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-2 space-y-1.5">
          <p className="text-[10.5px] uppercase tracking-wide text-[var(--muted-foreground)]">
            {result.sources.length} {t("chunks")} · {result.took_ms} {t("ms")}
          </p>
          {result.sources.map((source, idx) => (
            <div
              key={`${source.chunk_id ?? idx}-${idx}`}
              className="rounded-lg border border-[var(--border)]/70 bg-[var(--background)] px-2.5 py-1.5"
            >
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate font-medium text-[var(--foreground)]">
                  [{idx + 1}] {source.title || source.source}
                  {source.page != null ? ` · ${t("page")} ${source.page}` : ""}
                </span>
                <span className="shrink-0 font-mono text-[10.5px] text-[var(--muted-foreground)]">
                  {typeof source.score === "number" ? source.score.toFixed(4) : ""}
                </span>
              </div>
              {source.preview && (
                <p className="mt-0.5 line-clamp-3 text-[11px] leading-snug text-[var(--muted-foreground)]">
                  {source.preview}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
