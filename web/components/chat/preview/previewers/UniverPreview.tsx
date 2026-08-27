"use client";

/**
 * Tabbed preview for ``.univer`` multi-unit containers.
 *
 * Fetches the manifest from the backend unpack proxy, then routes each unit
 * URL to the existing Xlsx / Docx / Pptx previewers. No client-side ZIP.
 */

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiFetch } from "@/lib/api";
import {
  containerUnitUrl,
  fetchUniverManifest,
  previewKindForUnitType,
  unitLabel,
  type UniverManifest,
  type UniverUnit,
} from "@/lib/univer-container";

const XlsxPreview = dynamic(() => import("./XlsxPreview"), { ssr: false });
const DocxPreview = dynamic(() => import("./DocxPreview"), { ssr: false });
const PptxPreview = dynamic(() => import("./PptxPreview"), { ssr: false });

function UnitBody({
  containerUrl,
  unit,
}: {
  containerUrl: string;
  unit: UniverUnit;
}) {
  const kind = previewKindForUnitType(unit.type);
  const unitUrl = containerUnitUrl(containerUrl, unit.id);
  if (!unitUrl || !kind) return null;
  if (kind === "xlsx") return <XlsxPreview url={unitUrl} />;
  if (kind === "docx") return <DocxPreview url={unitUrl} />;
  return <PptxPreview url={unitUrl} filename={unit.file || `${unit.id}.pptx`} />;
}

export default function UniverPreview({
  url,
  filename,
}: {
  url: string;
  filename?: string;
}) {
  const { t } = useTranslation();
  const [manifest, setManifest] = useState<UniverManifest | null>(null);
  const [activeId, setActiveId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Async IIFE keeps setState out of the synchronous effect body
    // (react-hooks/set-state-in-effect house pattern).
    void (async () => {
      try {
        const next = await fetchUniverManifest(url, (input, init) =>
          apiFetch(String(input), {
            ...(init || {}),
            skipAuthRedirect: true,
          }),
        );
        if (cancelled) return;
        setManifest(next);
        setActiveId(next.units[0]?.id || "");
        setError("");
      } catch (err: unknown) {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : t("Failed to load .univer container"),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, t]);

  const activeUnit = useMemo(() => {
    if (!manifest) return null;
    return (
      manifest.units.find((unit) => unit.id === activeId) ||
      manifest.units[0] ||
      null
    );
  }, [manifest, activeId]);

  if (loading) {
    return (
      <div className="flex h-full min-h-[12rem] items-center justify-center gap-2 text-[12px] text-[var(--muted-foreground)]">
        <Loader2 size={14} className="animate-spin" />
        <span>{t("Loading container units")}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full min-h-[12rem] items-center justify-center px-4 text-center text-[12px] text-[var(--destructive)]">
        {error}
      </div>
    );
  }

  if (!manifest || !manifest.units.length || !activeUnit) {
    return (
      <div className="flex h-full min-h-[12rem] items-center justify-center px-4 text-center text-[12px] text-[var(--muted-foreground)]">
        {t("This .univer container has no units")}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] px-2 py-1.5">
        <span className="mr-1 truncate text-[11px] text-[var(--muted-foreground)]">
          {filename || t("Univer container")}
        </span>
        {manifest.units.map((unit) => {
          const selected = unit.id === activeUnit.id;
          return (
            <button
              key={unit.id}
              type="button"
              onClick={() => setActiveId(unit.id)}
              className={
                selected
                  ? "rounded-md bg-[var(--foreground)] px-2 py-0.5 text-[11px] text-[var(--background)]"
                  : "rounded-md px-2 py-0.5 text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
              }
            >
              {unitLabel(unit)}
              <span className="ml-1 opacity-70">({unit.type})</span>
            </button>
          );
        })}
      </div>
      {manifest.refs && manifest.refs.length > 0 ? (
        <div className="border-b border-[var(--border)] px-3 py-1 text-[10.5px] text-[var(--muted-foreground)]">
          {t("Data refs")}:{" "}
          {manifest.refs
            .map((ref) => `${ref.from}→${ref.to}!${ref.range}`)
            .join(" · ")}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <UnitBody containerUrl={url} unit={activeUnit} />
      </div>
    </div>
  );
}
