"use client";

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, Download, Upload } from "lucide-react";

import {
  downloadWorkspaceBundle,
  uploadWorkspaceBundle,
} from "@/lib/workspace-bundle";

/**
 * Fully local workspace zip. Conversations, notes, class outlines.
 * Secrets/.env/API keys are stripped by the backend.
 */
export default function WorkspaceBundleCard() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const onExport = async () => {
    setBusy("export");
    setError("");
    setMessage("");
    try {
      await downloadWorkspaceBundle();
      setMessage(t("Workspace zip downloaded"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    setBusy("import");
    setError("");
    setMessage("");
    try {
      const counts = await uploadWorkspaceBundle(file);
      setMessage(
        t("Restored conversations, notes, and outlines", {
          conversations: counts.conversations,
          notes: counts.notes,
          outlines: counts.outlines,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <section
      data-testid="workspace-bundle"
      className="rounded-2xl border border-[var(--border)] bg-[var(--card)]/60 p-4"
    >
      <div className="mb-2 flex items-center gap-2">
        <Archive size={16} className="text-[var(--primary)]" />
        <h2 className="text-[14px] font-medium text-[var(--foreground)]">
          {t("本机工作区")}
        </h2>
      </div>
      <p className="mb-3 text-[12.5px] leading-relaxed text-[var(--muted-foreground)]">
        {t(
          "Export conversations, notes, and class outlines as a zip. Import on another machine. No cloud, and secrets are not included.",
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void onExport()}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--primary-foreground)] disabled:opacity-50"
        >
          <Download size={14} />
          {t("Export workspace zip")}
        </button>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--foreground)] disabled:opacity-50"
        >
          <Upload size={14} />
          {t("Import workspace zip")}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(event) => void onImport(event.target.files?.[0])}
        />
      </div>
      {message ? (
        <p className="mt-2 text-[12px] text-[var(--foreground)]">{message}</p>
      ) : null}
      {error ? (
        <p className="mt-2 text-[12px] text-[var(--destructive)]">{error}</p>
      ) : null}
    </section>
  );
}
