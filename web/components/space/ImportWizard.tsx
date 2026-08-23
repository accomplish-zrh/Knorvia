"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FolderInput,
  FolderOpen,
  Loader2,
  Radar,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import Modal from "@/components/common/Modal";
import Button from "@/components/ui/Button";
import ScopePicker from "@/components/space/ScopePicker";
import {
  importChatHistory,
  importDetectedHome,
  listImportHomes,
  type DetectedImportHome,
} from "@/lib/imports-api";
import { newAgentId, saveAgent } from "@/lib/chat-import/agent-store";
import { isKnorviaDesktop, isWindowsDesktop } from "@/lib/desktop-shell";
import {
  buildSelectGroups,
  ImportScanError,
  isFileSystemAccessSupported,
  parseSessions,
  pickAndScan,
  selectionUnit,
  SOURCE_LABEL,
  type AgentScope,
  type ImportScanErrorCode,
  type ImportSource,
  type ScanResult,
  type SelectGroup,
  type SelectionUnit,
} from "@/lib/chat-import";

type Phase = "intro" | "scanning" | "select" | "importing" | "done" | "error";

interface ImportWizardProps {
  onClose: () => void;
  onImported: () => void;
}

function buildScope(unit: SelectionUnit, keys: string[]): AgentScope {
  return unit === "dates"
    ? { kind: "dates", days: keys }
    : { kind: "projects", cwds: keys };
}

function homeFolderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export default function ImportWizard({
  onClose,
  onImported,
}: ImportWizardProps) {
  const { t, i18n } = useTranslation();
  const [phase, setPhase] = useState<Phase>("intro");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [name, setName] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [errorCode, setErrorCode] = useState<ImportScanErrorCode | "generic">(
    "generic",
  );
  const [progress, setProgress] = useState({
    stage: "parsing" as "parsing" | "saving",
    done: 0,
    total: 0,
  });
  const [result, setResult] = useState<{ imported: number; skipped: number }>({
    imported: 0,
    skipped: 0,
  });
  const [homes, setHomes] = useState<DetectedImportHome[] | null>(null);
  const [detectingHomes, setDetectingHomes] = useState(false);
  const [homeError, setHomeError] = useState("");
  const [importingSource, setImportingSource] = useState<string | null>(null);

  const groups = useMemo<SelectGroup[]>(
    () => (scan ? buildSelectGroups(scan) : []),
    [scan],
  );
  const unit = scan ? selectionUnit(scan.source) : "projects";
  const selectedRefs = useMemo(
    () =>
      groups.filter((g) => selectedKeys.has(g.key)).flatMap((g) => g.sessions),
    [groups, selectedKeys],
  );

  const runDetectHomes = useCallback(async () => {
    setDetectingHomes(true);
    setHomeError("");
    try {
      setHomes(await listImportHomes());
    } catch (err) {
      setHomes([]);
      setHomeError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetectingHomes(false);
    }
  }, []);

  const runImportHome = useCallback(async (home: DetectedImportHome) => {
    setImportingSource(home.source);
    setPhase("importing");
    setProgress({ stage: "saving", done: 0, total: home.session_count });
    try {
      const agentId = newAgentId(home.source);
      const agentName = home.label;
      const res = await importDetectedHome(home.source, {
        id: agentId,
        name: agentName,
      });
      try {
        await saveAgent({
          id: agentId,
          name: agentName,
          source: home.source,
          folderName: homeFolderName(home.path),
          scope: { kind: "all" },
          createdAt: Date.now(),
          lastSyncAt: Date.now(),
          detectedHome: true,
        });
      } catch {
        // registry is best-effort
      }
      setResult({ imported: res.imported, skipped: res.skipped });
      setPhase("done");
    } catch {
      setErrorCode("generic");
      setPhase("error");
    } finally {
      setImportingSource(null);
    }
  }, []);

  const runScan = useCallback(async () => {
    setPhase("scanning");
    try {
      const next = await pickAndScan();
      const nextGroups = buildSelectGroups(next);
      setScan(next);
      // Default to "bring everything in" — one click for the common case, with
      // every unit pre-checked so narrowing is just deselecting.
      setSelectedKeys(new Set(nextGroups.map((g) => g.key)));
      setName(SOURCE_LABEL[next.source]);
      setPhase("select");
    } catch (err) {
      if (err instanceof ImportScanError && err.code === "aborted") {
        setPhase("intro");
        return;
      }
      setErrorCode(err instanceof ImportScanError ? err.code : "generic");
      setPhase("error");
    }
  }, []);

  const toggleKey = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAll = useCallback(
    () => setSelectedKeys(new Set(groups.map((g) => g.key))),
    [groups],
  );
  const clearAll = useCallback(() => setSelectedKeys(new Set()), []);

  const runImport = useCallback(async () => {
    if (!scan || selectedRefs.length === 0) return;
    setPhase("importing");
    setProgress({ stage: "parsing", done: 0, total: selectedRefs.length });
    try {
      const normalized = await parseSessions(
        scan.source,
        selectedRefs,
        (done, total) => setProgress({ stage: "parsing", done, total }),
      );
      setProgress({ stage: "saving", done: 0, total: normalized.length });
      const scope = buildScope(unit, [...selectedKeys]);
      const agentId = newAgentId(scan.source);
      const agentName = name.trim() || SOURCE_LABEL[scan.source];
      const res = await importChatHistory(scan.source, normalized, {
        id: agentId,
        name: agentName,
      });
      // Register the named, scoped agent so it can be re-synced later without
      // re-picking. Never block the success state on the registry write.
      try {
        await saveAgent({
          id: agentId,
          name: agentName,
          source: scan.source,
          folderName: scan.handle.name,
          handle: scan.handle,
          scope,
          createdAt: Date.now(),
          lastSyncAt: Date.now(),
        });
      } catch {
        // registry is best-effort
      }
      setResult({ imported: res.imported, skipped: res.skipped });
      setPhase("done");
    } catch {
      setErrorCode("generic");
      setPhase("error");
    }
  }, [scan, selectedRefs, selectedKeys, unit, name]);

  const titleIcon = <FolderInput className="h-[18px] w-[18px]" />;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t("Add agent")}
      titleIcon={titleIcon}
      width="xl"
      closeOnBackdrop={phase !== "importing"}
      closeOnEscape={phase !== "importing"}
      showCloseButton={phase !== "importing"}
      footer={
        <WizardFooter
          phase={phase}
          source={scan?.source ?? null}
          selectedCount={selectedRefs.length}
          canImport={selectedRefs.length > 0}
          onCancel={onClose}
          onPick={runScan}
          onDetect={runDetectHomes}
          detecting={detectingHomes}
          onImport={runImport}
          onDone={onImported}
          onRetry={() => setPhase("intro")}
        />
      }
    >
      <div className="px-5 py-5">
        {phase === "intro" && (
          <IntroView
            homes={homes}
            detecting={detectingHomes}
            error={homeError}
            importingSource={importingSource}
            onImportHome={(home) => void runImportHome(home)}
          />
        )}
        {phase === "scanning" && (
          <CenteredStatus
            icon={<Loader2 className="h-5 w-5 animate-spin" />}
            title={t("Reading your folder…")}
            subtitle={t("Finding projects and conversations.")}
          />
        )}
        {phase === "select" &&
          scan &&
          (groups.length === 0 ? (
            <CenteredStatus
              icon={<FolderOpen className="h-5 w-5" />}
              title={t("No conversations found")}
              subtitle={t(
                "This folder has no readable chat history. Pick your .claude or .codex folder.",
              )}
            />
          ) : (
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="agent-name"
                  className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)]"
                >
                  {t("Agent name")}
                </label>
                <input
                  id="agent-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={SOURCE_LABEL[scan.source]}
                  className="w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--foreground)] outline-none transition focus:border-[var(--primary)]/50 focus:ring-2 focus:ring-[var(--primary)]/15"
                />
                <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                  {unit === "dates"
                    ? t(
                        "Pick the days to bring in. Refreshing later re-syncs these days and pulls in new conversations on them.",
                      )
                    : t(
                        "Pick the projects to bring in. Refreshing later re-syncs these projects and pulls in their new conversations.",
                      )}
                </p>
              </div>
              <ScopePicker
                groups={groups}
                unit={unit}
                selected={selectedKeys}
                onToggle={toggleKey}
                onSelectAll={selectAll}
                onClearAll={clearAll}
                lang={i18n.language}
              />
            </div>
          ))}
        {phase === "importing" && <ImportingView progress={progress} />}
        {phase === "done" && <DoneView result={result} />}
        {phase === "error" && <ErrorView code={errorCode} />}
      </div>
    </Modal>
  );
}

/* ----------------------------- sub-views ----------------------------- */

function IntroView({
  homes,
  detecting,
  error,
  importingSource,
  onImportHome,
}: {
  homes: DetectedImportHome[] | null;
  detecting: boolean;
  error: string;
  importingSource: string | null;
  onImportHome: (home: DetectedImportHome) => void;
}) {
  const { t } = useTranslation();
  const supported = isFileSystemAccessSupported();
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3.5">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--border)]/60 bg-[var(--card)] text-[var(--foreground)] shadow-sm">
          <Radar size={16} strokeWidth={1.6} />
        </span>
        <div className="min-w-0 space-y-1">
          <p className="text-[13px] leading-relaxed text-[var(--foreground)]">
            {t(
              "Click detect and Knorvia will look for the usual Claude Code and Codex folders on this computer. You don't have to type a hidden path.",
            )}
          </p>
          <p className="text-[12px] leading-relaxed text-[var(--muted-foreground)]">
            {t(
              "Nothing is imported until you click Import. You can still pick a folder yourself if the default home is somewhere else.",
            )}
          </p>
        </div>
      </div>

      {detecting ? (
        <div className="flex items-center gap-2 rounded-xl border border-dashed border-[var(--border)] px-3.5 py-3 text-[12.5px] text-[var(--muted-foreground)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("Detecting local agent homes…")}
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-3 text-[12px] leading-relaxed text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300">
          <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {homes && homes.length > 0 ? (
        <div className="space-y-2">
          {homes.map((home) => (
            <div
              key={home.source}
              className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--muted)]/30 px-3.5 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-[var(--foreground)]">
                  {home.label}
                </div>
                <div className="truncate text-[11.5px] text-[var(--muted-foreground)]">
                  {t("{{count}} conversations · {{path}}", {
                    count: home.session_count,
                    path: home.path,
                  })}
                </div>
              </div>
              <Button
                variant="primary"
                size="sm"
                disabled={!home.available || importingSource === home.source}
                onClick={() => onImportHome(home)}
              >
                {importingSource === home.source ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                {home.available
                  ? t("Import this home")
                  : t("No conversations found")}
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {homes && homes.length === 0 && !detecting ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] px-3.5 py-3 text-[12px] leading-relaxed text-[var(--muted-foreground)]">
          {t(
            "No default Claude Code or Codex folder was found. You can still pick a folder.",
          )}
        </div>
      ) : null}

      {!supported ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-3 text-[12px] leading-relaxed text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300">
          <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
          <span>
            {t(
              isKnorviaDesktop()
                ? "This app can't open a folder picker here. Restart Knorvia or pick the folder from File Explorer."
                : "Your browser doesn't support folder access. Please use a Chromium-based browser (Chrome, Edge, Arc).",
            )}
          </span>
        </div>
      ) : homes === null ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--muted)]/40 px-3.5 py-3 text-[12px] leading-relaxed text-[var(--foreground)]/85">
          <Eye className="mt-px h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
          <span>
            {t(
              isWindowsDesktop()
                ? "If you pick a folder instead, hidden folders like .claude may be hidden. On Windows, turn on hidden items or type .claude in the path box."
                : "If you pick a folder instead, hidden folders like .claude won't show by default — press ⌘⇧. (Command-Shift-Period) in the picker to reveal them.",
            )}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function ImportingView({
  progress,
}: {
  progress: { stage: "parsing" | "saving"; done: number; total: number };
}) {
  const { t } = useTranslation();
  const pct =
    progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : progress.stage === "saving"
        ? 90
        : 0;
  return (
    <div className="space-y-4 py-6">
      <CenteredStatus
        icon={<Loader2 className="h-5 w-5 animate-spin" />}
        title={
          progress.stage === "parsing"
            ? t("Reading conversations…")
            : t("Saving to your space…")
        }
        subtitle={
          progress.stage === "parsing"
            ? t("{{done}} / {{total}}", {
                done: progress.done,
                total: progress.total,
              })
            : t("Almost there.")
        }
      />
      <div className="mx-auto h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-[var(--muted)]/60">
        <div
          className="h-full rounded-full bg-[var(--primary)] transition-[width] duration-200"
          style={{ width: `${Math.max(6, pct)}%` }}
        />
      </div>
    </div>
  );
}

function DoneView({
  result,
}: {
  result: { imported: number; skipped: number };
}) {
  const { t } = useTranslation();
  return (
    <CenteredStatus
      icon={
        <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
      }
      title={t("Imported {{count}} conversations", { count: result.imported })}
      subtitle={
        result.skipped > 0
          ? t("{{count}} skipped (already imported or empty).", {
              count: result.skipped,
            })
          : t("They're ready in your space — open one to keep chatting.")
      }
    />
  );
}

function ErrorView({ code }: { code: ImportScanErrorCode | "generic" }) {
  const { t } = useTranslation();
  const message =
    code === "not_recognized"
      ? t(
          "This folder doesn't look like a .claude or .codex home. Please select the right folder.",
        )
      : code === "unsupported_browser"
        ? t(
            isKnorviaDesktop()
              ? "This app couldn't open a folder picker. Try again, or restart Knorvia."
              : "Your browser doesn't support folder access. Please use a Chromium-based browser.",
          )
        : t("Something went wrong while importing. Please try again.");
  return (
    <CenteredStatus
      icon={
        <AlertTriangle className="h-6 w-6 text-amber-600 dark:text-amber-400" />
      }
      title={t("Couldn't import")}
      subtitle={message}
    />
  );
}

function CenteredStatus({
  icon,
  title,
  subtitle,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--border)]/60 bg-[var(--card)] text-[var(--muted-foreground)] shadow-sm">
        {icon}
      </span>
      <div className="space-y-1">
        <p className="text-[14px] font-medium text-[var(--foreground)]">
          {title}
        </p>
        <p className="mx-auto max-w-sm text-[12px] leading-relaxed text-[var(--muted-foreground)]">
          {subtitle}
        </p>
      </div>
    </div>
  );
}

/* ----------------------------- footer ----------------------------- */

function WizardFooter({
  phase,
  source,
  selectedCount,
  canImport,
  onCancel,
  onPick,
  onDetect,
  detecting,
  onImport,
  onDone,
  onRetry,
}: {
  phase: Phase;
  source: ImportSource | null;
  selectedCount: number;
  canImport: boolean;
  onCancel: () => void;
  onPick: () => void;
  onDetect: () => void;
  detecting: boolean;
  onImport: () => void;
  onDone: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();

  if (phase === "intro") {
    return (
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("Cancel")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<FolderInput className="h-4 w-4" />}
          onClick={onPick}
          disabled={!isFileSystemAccessSupported()}
        >
          {t("Select folder")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={
            detecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Radar className="h-4 w-4" />
            )
          }
          onClick={onDetect}
          disabled={detecting}
        >
          {t("Detect on this computer")}
        </Button>
      </div>
    );
  }

  if (phase === "select") {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-[var(--muted-foreground)]">
          {source ? SOURCE_LABEL[source] : ""}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("Cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onImport}
            disabled={!canImport}
          >
            {selectedCount > 0
              ? t("Import {{count}} conversations", { count: selectedCount })
              : t("Import")}
          </Button>
        </div>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="flex items-center justify-end">
        <Button variant="primary" size="sm" onClick={onDone}>
          {t("Done")}
        </Button>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("Close")}
        </Button>
        <Button variant="primary" size="sm" onClick={onRetry}>
          {t("Try again")}
        </Button>
      </div>
    );
  }

  // scanning / importing: no actions
  return (
    <div className="flex items-center justify-end">
      <span className="text-[12px] text-[var(--muted-foreground)]">
        {t("Working…")}
      </span>
    </div>
  );
}
